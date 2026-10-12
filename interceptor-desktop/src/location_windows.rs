use crate::{failure,location::{Result,emit,point_valid,timestamp}};
use serde_json::{json,Value};
use std::{sync::{Arc,Mutex},time::Duration};
use windows::{core::{Interface,w},Devices::{Enumeration::{DeviceAccessInformation,DeviceClass,DeviceAccessStatus},Geolocation::*},Foundation::{PropertyValue,TimeSpan,TypedEventHandler,IReference},Win32::{Foundation::HWND,System::WinRT::{RoInitialize,RoUninitialize,RO_INIT_MULTITHREADED},UI::Shell::ShellExecuteW}};
fn error(e:windows::core::Error)->Value{
    if e.code().0==0x80070005u32 as i32{return failure("permission_denied","Windows location access is off for desktop apps; turn on Location and \"Let desktop apps access your location\" in Settings > Privacy & security > Location (`location request` opens it)");}
    failure("provider_failed",format!("Windows location operation failed: HRESULT 0x{:08X}",e.code().0 as u32))
}
fn status()->Result<Value>{
    let native=DeviceAccessInformation::CreateFromDeviceClass(DeviceClass::Location).and_then(|d|d.CurrentStatus()).map_err(error)?;
    let value=if native==DeviceAccessStatus::Allowed{"authorized"}else if native==DeviceAccessStatus::DeniedByUser{"denied"}else if native==DeviceAccessStatus::DeniedBySystem{"restricted"}else{"unknown"};
    Ok(json!({"locationServicesEnabled":null,"status":value,"accuracyAuthorization":"unknown","providerPresent":true}))
}
fn optional(value:windows::core::Result<IReference<f64>>,nonnegative:bool)->Option<f64>{value.ok().and_then(|v|v.Value().ok()).filter(|n|n.is_finite()&&(!nonnegative||*n>=0.0))}
fn fix(position:&Geoposition)->Result<Value>{
    let coordinate=position.Coordinate().map_err(error)?;
    let ticks=coordinate.Timestamp().map_err(error)?.UniversalTime;
    let point=json!({"coordinate":[coordinate.Latitude().map_err(error)?,coordinate.Longitude().map_err(error)?],"altitude":optional(coordinate.Altitude(),false),"ellipsoidalAltitude":null,"horizontalAccuracy":coordinate.Accuracy().map_err(error)?,"verticalAccuracy":optional(coordinate.AltitudeAccuracy(),true),"course":optional(coordinate.Heading(),true),"courseAccuracy":null,"speed":optional(coordinate.Speed(),true),"speedAccuracy":null,"timestamp":timestamp((ticks as i128-116444736000000000)*100)?,"floor":null});
    if !point_valid(&point){return Err(failure("provider_failed","Windows returned an invalid location fix"));}Ok(point)
}
pub(crate) fn run(a:&Value)->Result<()>{
    unsafe{RoInitialize(RO_INIT_MULTITHREADED)}.map_err(error)?;
    struct Apartment;impl Drop for Apartment{fn drop(&mut self){unsafe{RoUninitialize();}}}let _apartment=Apartment;
    if crate::windows::session()=="0"{return Err(failure("no_interactive_session","location requires the retained interactive Windows login"));}
    let sub=a["sub"].as_str().unwrap();
    if sub=="status"{return emit(status()?);}
    if sub=="request"{
        let level=a["level"].as_str().unwrap_or("whenInUse");if level=="always"{return Err(failure("unsupported_operation","Windows location settings do not grant Apple's distinct always-authorization level"));}
        let observed=status()?;let granted=observed["status"]=="authorized";
        if !granted{
            let opened=unsafe{ShellExecuteW(Some(HWND(std::ptr::null_mut())),w!("open"),w!("ms-settings:privacy-location"),None,None,windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL)};
            if opened.0 as isize<=32{return Err(failure("provider_failed","Windows location privacy Settings could not be opened"));}
        }
        return emit(json!({"requested":level,"status":observed["status"],"pendingUserAction":!granted}));
    }
    if sub=="visits_start"{
        let monitor=GeovisitMonitor::new().map_err(error)?;let latest:Arc<Mutex<Option<Result<Value>>>>=Arc::new(Mutex::new(None));let observed=latest.clone();
        let handler=TypedEventHandler::<GeovisitMonitor,GeovisitStateChangedEventArgs>::new(move|_,args|{
            if let Some(args)=args.as_ref(){let result=args.Visit().and_then(|v|v.Position()).map_err(error).and_then(|p|fix(&p));*observed.lock().unwrap()=Some(result);}Ok(())
        });
        let token=monitor.VisitStateChanged(&handler).map_err(error)?;
        monitor.Start(VisitMonitoringScope::City).map_err(error)?;
        let result=(||{emit(json!({"ok":true}))?;loop{std::thread::sleep(Duration::from_secs(1));match latest.lock().unwrap().take(){Some(Ok(point))=>emit(point)?,Some(Err(e))=>return Err(e),None=>emit(json!("heartbeat"))?}}})();
        let _=monitor.Stop();let _=monitor.RemoveVisitStateChanged(token);return result;
    }
    if !["current","monitor_start","significant_start"].contains(&sub){return Err(failure("unsupported_operation","unsupported native Windows location helper selector"));}
    let locator=Geolocator::new().map_err(error)?;
    let meters=match a["accuracy"].as_str().unwrap_or("best"){"nearest"|"tenmeters"=>10,"hundredmeters"=>100,"kilometer"=>1000,"threekilometers"=>3000,_=>1};
    let accuracy=PropertyValue::CreateUInt32(meters).and_then(|v|v.cast::<IReference<u32>>()).map_err(error)?;
    locator.SetDesiredAccuracyInMeters(&accuracy).map_err(error)?;
    locator.SetReportInterval(1000).map_err(error)?;
    if sub=="significant_start"{locator.SetMovementThreshold(500.0).map_err(error)?;}
    let latest:Arc<Mutex<Option<Result<Value>>>>=Arc::new(Mutex::new(None));let observed=latest.clone();
    let handler=TypedEventHandler::<Geolocator,PositionChangedEventArgs>::new(move|_,args|{
        if let Some(args)=args.as_ref(){*observed.lock().unwrap()=Some(args.Position().map_err(error).and_then(|p|fix(&p)));}Ok(())
    });
    let token=if sub!="current"{Some(locator.PositionChanged(&handler).map_err(error)?)}else{None};
    let result=(||{
        let first=locator.GetGeopositionAsyncWithAgeAndTimeout(TimeSpan{Duration:0},TimeSpan{Duration:200000000}).map_err(error)?.join().map_err(error)?;
        emit(fix(&first)?)?;if sub=="current"{return Ok(());}
        loop{std::thread::sleep(Duration::from_secs(1));let native=locator.LocationStatus().map_err(error)?;
            if native==PositionStatus::Disabled{return Err(failure("permission_denied","Windows location access was disabled during monitoring"));}
            if native==PositionStatus::NotAvailable||native==PositionStatus::NotInitialized{return Err(failure("provider_failed","Windows location provider became unavailable during monitoring"));}
            match latest.lock().unwrap().take(){Some(Ok(point))=>emit(point)?,Some(Err(e))=>return Err(e),None=>emit(json!("heartbeat"))?}
        }
    })();
    if let Some(token)=token{let _=locator.RemovePositionChanged(token);}result
}
