use crate::failure;
use serde_json::{Value,json};
use windows::{core::PCWSTR,Win32::Graphics::Gdi::{GetMonitorInfoW,MONITORINFOEXW,EnumDisplaySettingsW,DEVMODEW,ENUM_CURRENT_SETTINGS,DM_DISPLAYORIENTATION}};

pub fn read(id:Option<u64>)->Result<Value,Value>{unsafe{
    let monitors=crate::capture_windows::monitors()?;
    if monitors.len()>crate::contract_generated::DESKTOP_DISPLAY_MAX_COUNT{return Err(failure("resource_limit","native monitor count exceeds its bound"));}
    let mut records=Vec::new();
    for monitor in monitors{
        let native_id=monitor.0 as usize as u64;
        if id.is_some_and(|id|id!=native_id){continue;}
        if native_id==0||native_id>9007199254740991{return Err(failure("unsupported_target","native monitor ID exceeds the shared safe integer bound"));}
        let mut info=MONITORINFOEXW::default();info.monitorInfo.cbSize=std::mem::size_of::<MONITORINFOEXW>()as u32;
        if !GetMonitorInfoW(monitor,&mut info.monitorInfo).as_bool(){return Err(failure("target_gone","display disappeared during metadata read"));}
        let rect=info.monitorInfo.rcMonitor;
        let width=i64::from(rect.right)-i64::from(rect.left);let height=i64::from(rect.bottom)-i64::from(rect.top);
        if width<=0||height<=0{return Err(failure("unsupported_target","display has no active native bounds"));}
        let mut data=json!({"id":native_id,"width":width,"height":height,"isMain":info.monitorInfo.dwFlags&1!=0,"unknownFields":["isBuiltin"]});
        if id.is_some(){
            let mut mode=DEVMODEW::default();mode.dmSize=std::mem::size_of::<DEVMODEW>()as u16;
            if !EnumDisplaySettingsW(PCWSTR(info.szDevice.as_ptr()),ENUM_CURRENT_SETTINGS,&mut mode).as_bool()||mode.dmPelsWidth==0||mode.dmPelsHeight==0{return Err(failure("provider_failed","current display pixel mode is unavailable"));}
            data["pixelWidth"]=json!(mode.dmPelsWidth);data["pixelHeight"]=json!(mode.dmPelsHeight);
            if mode.dmDisplayFrequency>1{data["refreshRate"]=json!(mode.dmDisplayFrequency);}else{data["unknownFields"].as_array_mut().unwrap().push(json!("refreshRate"));}
            if mode.dmFields.contains(DM_DISPLAYORIENTATION)&&mode.Anonymous1.Anonymous2.dmDisplayOrientation.0<=3{
                data["rotation"]=json!(mode.Anonymous1.Anonymous2.dmDisplayOrientation.0*90);
            }else{data["unknownFields"].as_array_mut().unwrap().push(json!("rotation"));}
        }else{data["x"]=json!(rect.left);data["y"]=json!(rect.top);data["isVirtual"]=json!(false);}
        records.push(data);
    }
    if id.is_some(){records.into_iter().next().ok_or_else(||failure("unsupported_target","requested native display is not active"))}else{Ok(json!(records))}
}}
