use crate::{failure,location::{Result,emit,point_valid,timestamp},native_library::Library};
use serde_json::{json,Value};
use std::{ffi::{c_char,c_void,CStr},path::Path,sync::Arc,time::Duration};
type Raw=*mut c_void;
#[repr(C)]struct GError{domain:u32,code:i32,message:*mut c_char}
struct Native{library:Library,unref:unsafe extern "C" fn(Raw),error_free:unsafe extern "C" fn(*mut GError)}
struct Object{raw:Raw,native:Arc<Native>}
impl Drop for Object{fn drop(&mut self){unsafe{(self.native.unref)(self.raw);}}}
impl Native{
    fn load()->Result<Arc<Self>>{
        let arch=if cfg!(target_arch="aarch64"){"aarch64-linux-gnu"}else{"x86_64-linux-gnu"};
        let candidates=[format!("/usr/lib/{arch}/libgeoclue-2.so.0"),"/usr/lib/libgeoclue-2.so.0".into(),"/usr/lib64/libgeoclue-2.so.0".into()];
        let path=candidates.iter().find(|p|Path::new(p).is_file()).ok_or_else(||failure("not_installed","GeoClue2 convenience library is not installed; no location provider was started"))?;
        let library=Library::load(Path::new(path))?;
        let unref=unsafe{std::mem::transmute::<Raw,unsafe extern "C" fn(Raw)>(library.symbol(c"g_object_unref")?)};
        let error_free=unsafe{std::mem::transmute::<Raw,unsafe extern "C" fn(*mut GError)>(library.symbol(c"g_error_free")?)};
        Ok(Arc::new(Self{library,unref,error_free}))
    }
    unsafe fn function<T:Copy>(&self,name:&CStr)->Result<T>{let raw=unsafe{self.library.symbol(name)?};if std::mem::size_of::<T>()!=std::mem::size_of::<Raw>(){return Err(failure("provider_failed","invalid GeoClue function-pointer ABI"));}Ok(unsafe{std::mem::transmute_copy(&raw)})}
    fn error(&self,error:*mut GError)->Value{if error.is_null(){return failure("provider_failed","GeoClue native operation returned no object or error");}unsafe{let message=if(*error).message.is_null(){"GeoClue native operation failed".into()}else{CStr::from_ptr((*error).message).to_string_lossy().chars().take(1000).collect::<String>()};(self.error_free)(error);failure("provider_failed",message)}}
    unsafe fn fix(&self,simple:Raw)->Result<Value>{unsafe{
        let location_get:unsafe extern "C" fn(Raw)->Raw=self.function(c"gclue_simple_get_location")?;
        let location=location_get(simple);if location.is_null(){return Err(failure("provider_failed","GeoClue did not retain a native location fix"));}
        let mut number=|name:&CStr|->Result<f64>{let get:unsafe extern "C" fn(Raw)->f64=self.function(name)?;let value=get(location);if !value.is_finite(){return Err(failure("provider_failed","GeoClue returned a non-finite measurement"));}Ok(value)};
        let altitude=number(c"gclue_location_get_altitude")?;let speed=number(c"gclue_location_get_speed")?;let heading=number(c"gclue_location_get_heading")?;
        let get_time:unsafe extern "C" fn(Raw)->Raw=self.function(c"gclue_location_get_timestamp")?;let time=get_time(location);
        let children:unsafe extern "C" fn(Raw)->usize=self.function(c"g_variant_n_children")?;
        let child:unsafe extern "C" fn(Raw,usize)->Raw=self.function(c"g_variant_get_child_value")?;
        let uint:unsafe extern "C" fn(Raw)->u64=self.function(c"g_variant_get_uint64")?;
        let unref:unsafe extern "C" fn(Raw)=self.function(c"g_variant_unref")?;
        if time.is_null()||children(time)!=2{return Err(failure("provider_failed","GeoClue timestamp is not the native seconds/microseconds tuple"));}
        let seconds=child(time,0);let micros=child(time,1);if seconds.is_null()||micros.is_null(){if !seconds.is_null(){unref(seconds);}if !micros.is_null(){unref(micros);}return Err(failure("provider_failed","GeoClue timestamp components are missing"));}
        let seconds_value=uint(seconds);let micros_value=uint(micros);unref(seconds);unref(micros);if micros_value>=1000000{return Err(failure("provider_failed","GeoClue timestamp microseconds are invalid"));}
        let point=json!({"coordinate":[number(c"gclue_location_get_latitude")?,number(c"gclue_location_get_longitude")?],"altitude":(altitude> -1e300).then_some(altitude),"ellipsoidalAltitude":null,"horizontalAccuracy":number(c"gclue_location_get_accuracy")?,"verticalAccuracy":null,"course":(heading>=0.0).then_some(heading),"courseAccuracy":null,"speed":(speed>=0.0).then_some(speed),"speedAccuracy":null,"floor":null,"timestamp":timestamp(seconds_value as i128*1_000_000_000+micros_value as i128*1000)?});
        if !point_valid(&point){return Err(failure("provider_failed","GeoClue returned an invalid observed location fix"));}Ok(point)
    }}
}
// This is a portable dwell detector over actual native fixes. It is named and
// qualified separately from Apple's CLVisit classifier and never invents fixes.
struct Dwell{anchor:Option<Value>,reported:bool}
impl Dwell{fn observe(&mut self,point:&Value)->bool{
    use geographiclib_rs::{Geodesic,InverseGeodesic};
    let Some(anchor)=&self.anchor else{self.anchor=Some(point.clone());return false;};
    let p=&point["coordinate"];let a=&anchor["coordinate"];let distance:f64=Geodesic::wgs84().inverse(a[0].as_f64().unwrap(),a[1].as_f64().unwrap(),p[0].as_f64().unwrap(),p[1].as_f64().unwrap());
    let parse=|p:&Value|time::OffsetDateTime::parse(p["timestamp"].as_str().unwrap(),&time::format_description::well_known::Rfc3339).unwrap();
    let elapsed=parse(point)-parse(anchor);
    if distance>100.0||elapsed.is_negative(){self.anchor=Some(point.clone());self.reported=false;return false;}
    if elapsed.whole_seconds()>=600&&!self.reported{self.reported=true;return true;}false
}}
pub(crate) fn run(a:&Value)->Result<()>{
    let sub=a["sub"].as_str().unwrap();
    let native=Native::load();
    if sub=="status"{return emit(json!({"locationServicesEnabled":null,"status":"unknown","accuracyAuthorization":"unknown","providerPresent":native.is_ok()}));}
    let native=native?;
    let login=crate::linux::login_identity(0).filter(crate::linux_peer::graphical).ok_or_else(||failure("no_interactive_session","GeoClue requires the retained graphical login"))?;
    if sub=="request"&&a["level"]=="always"{return Err(failure("unsupported_operation","GeoClue does not grant Apple's separate always-authorization level"));}
    if !["request","current","monitor_start","significant_start","visits_start"].contains(&sub){return Err(failure("unsupported_operation","unsupported native GeoClue helper selector"));}
    let accuracy=match a["accuracy"].as_str().unwrap_or("best"){"kilometer"|"threekilometers"=>4,"hundredmeters"=>6,_=>8};
    let create:unsafe extern "C" fn(*const c_char,i32,u32,u32,Raw,*mut *mut GError)->Raw=unsafe{native.function(c"gclue_simple_new_with_thresholds_sync")?};
    let mut error=std::ptr::null_mut();let raw=unsafe{create(c"com.interceptor.desktop".as_ptr(),accuracy,1,if sub=="significant_start"{500}else{0},std::ptr::null_mut(),&mut error)};
    if raw.is_null(){return Err(native.error(error));}
    if !error.is_null(){unsafe{(native.error_free)(error);}}
    let simple=Object{raw,native:native.clone()};
    if crate::linux::login_identity(0)!=Some(login.clone()){return Err(failure("permission_denied","graphical login changed while GeoClue permission/fix was pending"));}
    let first=unsafe{native.fix(simple.raw)?};
    if sub=="request"{return emit(json!({"requested":"whenInUse","status":"authorized","pendingUserAction":false}));}
    if sub=="current"{return emit(first);}
    let get_client:unsafe extern "C" fn(Raw)->Raw=unsafe{native.function(c"gclue_simple_get_client")?};let client=unsafe{get_client(simple.raw)};
    if client.is_null(){return Err(failure("unsupported_operation","this sandboxed GeoClue portal session has no observable native Client.Active lifecycle; continuous monitoring is unavailable in this backend"));}
    let active:unsafe extern "C" fn(Raw)->i32=unsafe{native.function(c"gclue_client_get_active")?};
    let iteration:unsafe extern "C" fn(Raw,i32)->i32=unsafe{native.function(c"g_main_context_iteration")?};
    let visits=sub=="visits_start";let mut dwell=Dwell{anchor:Some(first.clone()),reported:false};let mut last=first.clone();
    if visits{emit(json!({"ok":true}))?;}else{emit(first)?;}
    loop{
        std::thread::sleep(Duration::from_secs(1));
        if crate::linux::login_identity(0)!=Some(login.clone()){return Err(failure("permission_denied","GeoClue graphical login ended or changed"));}
        for _ in 0..64{if unsafe{iteration(std::ptr::null_mut(),0)}==0{break;}}
        if unsafe{active(client)}==0{return Err(failure("permission_denied","GeoClue native client became inactive; no retained fix was replayed"));}
        let point=unsafe{native.fix(simple.raw)?};let changed=point!=last;
        let observed=changed&&(!visits||dwell.observe(&point));last=point.clone();emit(if observed{point}else{json!("heartbeat")})?;
    }
}
#[cfg(test)]mod tests{use super::*;
    fn fix(lat:f64,time:&str)->Value{json!({"coordinate":[lat,0.0],"timestamp":time})}
    #[test]fn dwell_uses_actual_measurement_times_and_resets_on_movement_or_clock_reversal(){
        let mut d=Dwell{anchor:None,reported:false};assert!(!d.observe(&fix(0.0,"2026-10-08T00:00:00Z")));assert!(!d.observe(&fix(0.0,"2026-10-08T00:09:59Z")));assert!(d.observe(&fix(0.0,"2026-10-08T00:10:00Z")));assert!(!d.observe(&fix(0.0,"2026-10-08T00:11:00Z")));
        assert!(!d.observe(&fix(1.0,"2026-10-08T00:12:00Z")));assert!(!d.observe(&fix(1.0,"2026-10-08T00:11:00Z")));assert!(!d.observe(&fix(1.0,"2026-10-08T00:20:59Z")));assert!(d.observe(&fix(1.0,"2026-10-08T00:21:00Z")));
    }
}
