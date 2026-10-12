use crate::{contract_generated::*,failure,success};
use serde_json::{json,Value};
use std::{collections::{HashMap,VecDeque},io,sync::{Arc,Mutex,OnceLock,mpsc,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
pub(crate) type Result<T>=std::result::Result<T,Value>;
pub(crate) fn coordinates(value:&Value,region:bool)->Option<Vec<f64>>{
    let text=value.as_str()?;if text.len()>128||!text.bytes().all(|b|b.is_ascii_digit()||b"+eE.,- \t\r\n".contains(&b)){return None;}
    let parts=text.split(',').map(|s|s.trim().parse::<f64>().ok()).collect::<Option<Vec<_>>>()?;
    if parts.len()!=if region{3}else{2}||parts.iter().any(|n|!n.is_finite())||parts[0].abs()>90.0||parts[1].abs()>180.0||region&&(parts[2]<=0.0||parts[2]>10_000_000.0){return None;}Some(parts)
}
fn bounded(v:&Value,max:usize)->bool{v.as_str().is_some_and(|s|!s.trim().is_empty()&&s.len()<=max&&!s.contains('\0'))}
fn validate(a:&Value)->Result<()>{
    if let Some(e)=desktop_location_shape_error(a){return Err(failure("invalid_request",e));}
    let sub=a["sub"].as_str().unwrap();let owned:&[&str]=match sub{"request"=>&["level"],"request-temporary-accuracy"=>&["purpose"],"monitor_start"=>&["accuracy"],"geocode"=>&["address","locale","region"],"reverse"=>&["coords","locale"],"distance"=>&["from","to"],"postal-geocode"=>&["postal","locale"],_=>&[]};
    for key in ["level","purpose","accuracy","address","coords","postal","region","locale","from","to"]{if a.get(key).is_some()&&!owned.contains(&key){return Err(failure("invalid_request","location field does not belong to this selector"));}}
    for key in ["group","groupColor"]{if a.get(key).is_some_and(|v|!bounded(v,256)){return Err(failure("invalid_request","invalid location group text"));}}
    if sub=="geocode"&&!bounded(&a["address"],4096)||sub=="request-temporary-accuracy"&&!bounded(&a["purpose"],128){return Err(failure("invalid_request","location requires a bounded address or purpose"));}
    if a.get("locale").is_some_and(|v|!bounded(v,128)||v.as_str().unwrap_or("").split(['-','_']).any(|part|part.is_empty()||!part.bytes().all(|c|c.is_ascii_alphanumeric()))){return Err(failure("invalid_request","invalid location locale"));}
    for key in match sub{"reverse"=>&["coords"][..],"distance"=>&["from","to"][..],_=>&[][..]}{if coordinates(&a[key],false).is_none(){return Err(failure("invalid_request","invalid finite latitude/longitude"));}}
    if a.get("region").is_some()&&coordinates(&a["region"],true).is_none(){return Err(failure("invalid_request","invalid bounded location region"));}
    if sub=="postal-geocode"{if !bounded(&a["postal"],8192){return Err(failure("invalid_request","bounded postal JSON required"));}let postal:Value=serde_json::from_str(a["postal"].as_str().unwrap()).map_err(|_|failure("invalid_request","malformed postal JSON"))?;if postal.as_object().is_none_or(|p|p.is_empty()||p.iter().any(|(k,v)|!["street","city","state","postalCode","country","isoCountryCode"].contains(&k.as_str())||!bounded(v,1024))){return Err(failure("invalid_request","invalid postal address fields"));}}
    Ok(())
}
pub(crate) fn timestamp(nanos:i128)->Result<String>{
    let time=time::OffsetDateTime::from_unix_timestamp_nanos(nanos).map_err(|_|failure("provider_failed","native location timestamp is out of range"))?;
    time.format(&time::format_description::well_known::Rfc3339).map_err(|_|failure("provider_failed","native location timestamp could not be formatted"))
}
pub(crate) fn point_valid(point:&Value)->bool{
    serde_json::from_value::<DesktopLocationPoint>(point.clone()).is_ok()&&point["coordinate"].as_array().is_some_and(|p|p.len()==2&&p[0].as_f64().is_some_and(|n|n.is_finite()&&n.abs()<=90.0)&&p[1].as_f64().is_some_and(|n|n.is_finite()&&n.abs()<=180.0))&&point["horizontalAccuracy"].as_f64().is_some_and(|n|n>=0.0)&&time::OffsetDateTime::parse(point["timestamp"].as_str().unwrap_or(""),&time::format_description::well_known::Rfc3339).is_ok()&&point["floor"].as_f64().is_none_or(|n|n.fract()==0.0&&n.abs()<=9007199254740991.0)
}
struct Job{cancelled:AtomicBool,active:AtomicBool,helper:Mutex<Option<crate::thumbnail::OwnedHelper>>}
impl Job{fn stop(&self){self.cancelled.store(true,Ordering::Release);self.active.store(false,Ordering::Release);drop(self.helper.lock().unwrap().take());}}
#[derive(Default)]struct State{jobs:HashMap<String,Arc<Job>>,locations:VecDeque<Value>,error:Option<String>}
static STATE:OnceLock<Mutex<State>>=OnceLock::new();fn state()->&'static Mutex<State>{STATE.get_or_init(||Mutex::new(State::default()))}
fn release(kind:&str,job:&Arc<Job>){job.stop();let mut s=state().lock().unwrap();if s.jobs.get(kind).is_some_and(|j|Arc::ptr_eq(j,job)){s.jobs.remove(kind);}}
fn monitor(kind:String,job:Arc<Job>,action:Value,ready:mpsc::SyncSender<Value>){
    let mut sender=Some(ready);let result=(||->io::Result<()>{
        let mut helper=crate::thumbnail::OwnedHelper::spawn("--location-engine")?;
        let mut input=helper.child.0.stdin.take().ok_or_else(||io::Error::other("location helper input missing"))?;
        let mut output=helper.child.0.stdout.take().ok_or_else(||io::Error::other("location helper output missing"))?;
        {let mut owned=job.helper.lock().unwrap();if job.cancelled.load(Ordering::Acquire){return Err(io::ErrorKind::ConnectionAborted.into());}*owned=Some(helper);}
        crate::write_frame(&mut input,&serde_json::to_vec(&action)?)?;drop(input);
        let mut last=None;loop{
            let deadline=Instant::now()+Duration::from_secs(if sender.is_some(){30}else{5});
            let bytes=crate::auth::bounded_child_result(|bytes|{if job.cancelled.load(Ordering::Acquire){return Err(io::ErrorKind::ConnectionAborted.into());}crate::auth::ready_read(&mut output,bytes)},deadline,65536)?;
            let reply:Value=serde_json::from_slice(&bytes)?;
            if reply["success"]!=true{
                let error=if reply["success"]==false&&reply["error"].is_string(){reply}else{failure("provider_failed","malformed location helper receipt")};
                state().lock().unwrap().error=Some(error["error"].as_str().unwrap_or("native location failed").chars().take(1000).collect());
                if let Some(sender)=sender.take(){let _=sender.send(error);}return Err(io::Error::other("native location failed"));
            }
            let data=&reply["data"];
            if data.get("coordinate").is_some(){
                if !point_valid(data){return Err(io::Error::other("native location returned an invalid fix"));}
                if last.as_ref()!=Some(data){let mut s=state().lock().unwrap();if job.cancelled.load(Ordering::Acquire){return Err(io::ErrorKind::ConnectionAborted.into());}if s.locations.len()==200{s.locations.pop_front();}s.locations.push_back(data.clone());last=Some(data.clone());}
            }else if data!="heartbeat"&&data!=&json!({"ok":true}){return Err(io::Error::other("native monitor receipt is invalid"));}
            if sender.is_some()&&kind!="visits"&&data.get("coordinate").is_none(){continue;}
            if let Some(sender)=sender.take(){
                if job.cancelled.load(Ordering::Acquire){return Err(io::ErrorKind::ConnectionAborted.into());}
                job.active.store(true,Ordering::Release);
                let _=sender.send(success(if kind=="monitor"{json!({"monitoring":true,"accuracy":action["accuracy"].as_str().unwrap_or("best")})}else{json!({"ok":true})}));
            }
        }
    })();
    if let Err(ref e)=result{if !job.cancelled.load(Ordering::Acquire){let mut s=state().lock().unwrap();if s.error.is_none(){s.error=Some(e.to_string().chars().take(1000).collect());}}}
    release(&kind,&job);if let Some(sender)=sender{let _=sender.send(failure("provider_failed","native location monitor ended before a complete start receipt"));}
}
fn start(kind:&str,a:&Value)->Value{
    let job=Arc::new(Job{cancelled:AtomicBool::new(false),active:AtomicBool::new(false),helper:Mutex::new(None)});
    {let mut s=state().lock().unwrap();if s.jobs.contains_key(kind){return failure("resource_limit","this location monitor or its cleanup is active; no work queued");}s.jobs.insert(kind.into(),job.clone());s.error=None;}
    let(sender,receiver)=mpsc::sync_channel(1);let owned=job.clone();let action=a.clone();let name=kind.to_owned();
    if let Err(e)=std::thread::Builder::new().name(format!("location-{kind}")).spawn(move||monitor(name,owned,action,sender)){release(kind,&job);return failure("resource_limit",e);}
    match receiver.recv_timeout(Duration::from_secs(32)){Ok(v)=>v,Err(_)=>{job.stop();failure("timeout_unknown_outcome","location monitor start exceeded its deadline; inspect tail before retrying")}}
}
fn stop(kind:&str)->Value{
    let job=state().lock().unwrap().jobs.get(kind).cloned();if let Some(job)=job{job.stop();let deadline=Instant::now()+Duration::from_secs(3);while state().lock().unwrap().jobs.get(kind).is_some_and(|j|Arc::ptr_eq(j,&job)){if Instant::now()>=deadline{return failure("timeout_unknown_outcome","location monitor cleanup remains owned; no stop receipt issued");}std::thread::sleep(Duration::from_millis(5));}}
    success(if kind=="monitor"{json!({"monitoring":false})}else{json!({"ok":true})})
}
pub(crate) fn shutdown()->Value{for kind in ["monitor","significant","visits"]{let r=stop(kind);if r["success"]!=true{return r;}}success(json!({"ok":true}))}
pub fn dispatch(a:&Value)->Value{
    if let Err(e)=validate(a){return e;}
    let sub=a["sub"].as_str().unwrap();
    if sub=="distance"{use geographiclib_rs::{Geodesic,InverseGeodesic};let f=coordinates(&a["from"],false).unwrap();let t=coordinates(&a["to"],false).unwrap();let meters:f64=Geodesic::wgs84().inverse(f[0],f[1],t[0],t[1]);return if meters.is_finite()&&meters>=0.0{success(json!({"meters":meters}))}else{failure("provider_failed","WGS84 distance computation failed")};}
    if ["geocode","reverse","postal-geocode"].contains(&sub){return match geocode(a,Instant::now()+Duration::from_secs(25)){Ok(data)=>success(data),Err(e)=>e};}
    if sub=="monitor_tail"{let mut s=state().lock().unwrap();let data=json!({"locations":s.locations.drain(..).collect::<Vec<_>>(),"monitoring":s.jobs.get("monitor").is_some_and(|j|j.active.load(Ordering::Acquire)),"lastError":s.error});let mut data=data;if data["lastError"].is_null(){data.as_object_mut().unwrap().remove("lastError");}return success(data);}
    for kind in ["monitor","significant","visits"]{if sub==format!("{kind}_start"){return start(kind,a);}if sub==format!("{kind}_stop"){return stop(kind);}}
    if sub=="heading_start"{return success(json!({"ok":false,"note":"The macOS baseline has no heading updates; portable location fixes may expose an actual measured course."}));}
    if sub=="heading_stop"{return success(json!({"ok":true,"note":"No heading monitor is active."}));}
    if sub=="request-temporary-accuracy"{return failure("unsupported_operation","This provider has no Apple purpose-key temporary-accuracy authorization API; native per-app location permission is required.");}
    let _current=if sub=="current"||sub=="request"{match CURRENT_WORK.try_lock(){Ok(guard)=>Some(guard),Err(_)=>return failure("resource_limit","another current location/permission request is active; no work queued")}}else{None};
    match crate::thumbnail::image_helper("--location-engine",a,Instant::now()+Duration::from_secs(32)){Ok(data)=>{
        if sub=="current"&&!point_valid(&data){failure("provider_failed","native location returned an invalid fix")}else{success(data)}
    },Err(mut e)=>{if e["code"]=="resource_limit"{e["code"]=json!("timeout_unknown_outcome");}e}}
}
pub(crate) fn helper(parent:u32)->io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    #[cfg(unix)]{let bound=libc::rlimit{rlim_cur:512*1024*1024,rlim_max:512*1024*1024};if unsafe{libc::setrlimit(libc::RLIMIT_AS,&bound)}!=0{return Err(io::Error::other("location helper memory limit failed"));}}
    let bytes=crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("location helper requires one request"))?;let a:Value=serde_json::from_slice(&bytes)?;
    if let Err(e)=validate(&a){return crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(&e)?);}
    #[cfg(windows)]let result=crate::location_windows::run(&a);
    #[cfg(target_os="linux")]let result=crate::location_linux::run(&a);
    #[cfg(not(any(windows,target_os="linux")))]let result:Result<()>=Err(failure("unsupported_operation","macOS uses CoreLocation"));
    if let Err(e)=result{crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(&e)?)?;}Ok(())
}
pub(crate) fn emit(data:Value)->Result<()>{crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(&success(data)).map_err(|_|failure("provider_failed","location JSON serialization failed"))?).map_err(|_|failure("cancelled","location client disconnected"))}
pub(crate) fn geocode(a:&Value,deadline:Instant)->Result<Value>{
    use std::io::Read;
    let raw=std::env::var("INTERCEPTOR_GEOCODER_URL").map_err(|_|failure("not_installed","portable geocoding requires configured INTERCEPTOR_GEOCODER_URL for a local Nominatim service; no address was sent"))?;
    let mut url=crate::http::local_origin(&raw,true)?;
    let reverse=a["sub"]=="reverse";url.set_path(if reverse{"/reverse"}else{"/search"});
    {let mut q=url.query_pairs_mut();q.append_pair("format","jsonv2").append_pair("addressdetails","1");
    if let Some(locale)=a["locale"].as_str(){q.append_pair("accept-language",locale);}
    if reverse{let p=coordinates(&a["coords"],false).unwrap();q.append_pair("lat",&p[0].to_string()).append_pair("lon",&p[1].to_string());}else{
        q.append_pair("limit","32");if a["sub"]=="geocode"{q.append_pair("q",a["address"].as_str().unwrap());}else{let postal:Value=serde_json::from_str(a["postal"].as_str().unwrap()).unwrap();for(from,to)in[("street","street"),("city","city"),("state","state"),("postalCode","postalcode"),("country","country"),("isoCountryCode","countrycodes")]{if let Some(v)=postal[from].as_str(){q.append_pair(to,v);}}}
        if let Some(p)=coordinates(&a["region"],true){use geographiclib_rs::{Geodesic,DirectGeodesic};let g=Geodesic::wgs84();let(north,_,_):(f64,f64,f64)=g.direct(p[0],p[1],0.0,p[2]);let(south,_,_):(f64,f64,f64)=g.direct(p[0],p[1],180.0,p[2]);let(_,east,_):(f64,f64,f64)=g.direct(p[0],p[1],90.0,p[2]);let(_,west,_):(f64,f64,f64)=g.direct(p[0],p[1],270.0,p[2]);q.append_pair("viewbox",&format!("{west},{south},{east},{north}"));}
    }}
    let _work=GEOCODE_WORK.try_lock().map_err(|_|failure("resource_limit","another portable geocode request is active; no work queued"))?;
    let budget=deadline.checked_duration_since(Instant::now()).filter(|n|!n.is_zero()).ok_or_else(||failure("timeout_unknown_outcome","local geocoding deadline expired before dispatch"))?.min(Duration::from_secs(25));
    let client=reqwest::blocking::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never()).connect_timeout(budget.min(Duration::from_secs(3))).timeout(budget).build().map_err(|_|failure("provider_failed","local geocoder HTTP initialization failed"))?;
    let mut response=client.get(url).header("User-Agent",concat!("Interceptor/",env!("CARGO_PKG_VERSION"))).send().map_err(|_|failure("timeout_unknown_outcome","local geocode request failed after dispatch; no replay"))?;
    if response.status()!=reqwest::StatusCode::OK{return Err(failure("provider_failed",format!("local geocoder returned HTTP{}; body withheld",response.status().as_u16())));}
    let mut bytes=Vec::new();response.by_ref().take(1_048_577).read_to_end(&mut bytes).map_err(|_|failure("provider_failed","local geocoder response interrupted"))?;if bytes.len()>1_048_576{return Err(failure("resource_limit","local geocoder response exceeds 1MiB"));}
    let raw:Value=serde_json::from_slice(&bytes).map_err(|_|failure("provider_failed","local geocoder returned malformed JSON"))?;
    normalize_geocoded(a,&raw)
}
static GEOCODE_WORK:Mutex<()>=Mutex::new(());
static CURRENT_WORK:Mutex<()>=Mutex::new(());
fn normalize_geocoded(a:&Value,raw:&Value)->Result<Value>{
    let rows:Vec<&Value>=if a["sub"]=="reverse"{if raw.get("error").is_some(){return Err(failure("provider_failed","local geocoder reported no usable reverse address"));}vec![raw]}else{raw.as_array().filter(|rows|rows.len()<=32).ok_or_else(||failure("resource_limit","local geocoder result array is invalid or exceeds 32 placemarks"))?.iter().collect()};
    let mut marks=Vec::new();for row in rows{
        let lat=row["lat"].as_str().and_then(|s|s.parse::<f64>().ok()).filter(|n|n.is_finite()&&n.abs()<=90.0);let lon=row["lon"].as_str().and_then(|s|s.parse::<f64>().ok()).filter(|n|n.is_finite()&&n.abs()<=180.0);
        let (Some(lat),Some(lon))=(lat,lon)else{return Err(failure("provider_failed","local geocoder omitted valid WGS84 coordinates"));};
        let name=row["name"].as_str().or_else(||row["display_name"].as_str());let mut mark=json!({"name":name,"coordinate":[lat,lon]});
        for(from,to)in[("road","thoroughfare"),("house_number","subThoroughfare"),("city","locality"),("suburb","subLocality"),("state","administrativeArea"),("county","subAdministrativeArea"),("postcode","postalCode"),("country_code","isoCountryCode"),("country","country")]{if let Some(value)=row["address"][from].as_str(){mark[to]=json!(if from=="country_code"{value.to_ascii_uppercase()}else{value.to_owned()});}}
        if row.get("licence").is_some(){mark["attribution"]=row["licence"].clone();}
        if mark.as_object().unwrap().iter().any(|(k,v)|k!="coordinate"&&!v.is_null()&&!v.as_str().is_some_and(|s|s.len()<=4096&&!s.contains('\0'))){return Err(failure("provider_failed","local geocoder returned invalid bounded address fields"));}
        marks.push(mark);
    }
    let mut result=json!({"placemarks":marks});if a["sub"]=="reverse"{result["coordinate"]=json!(coordinates(&a["coords"],false).unwrap());}
    if serde_json::to_vec(&result).map_or(true,|v|v.len()>65536){return Err(failure("resource_limit","normalized geocoder output exceeds 64KiB"));}Ok(result)
}
pub fn capability(session:&str)->Value{json!({"operation":"location","compiled":true,"present":true,"effective":false,"permission":"unknown","session":session,"background":"semantic","provider":if cfg!(windows){"Windows Geolocator / owned native helper"}else{"GeoClue2 / owned GLib helper"},"versions":{"contract":"1","geodesic":"geographiclib-rs0.2.7","geocoder":"Nominatim JSONv2"},"limits":["Current fixes use actual native coordinates, accuracy and measurement timestamps; unavailable fields remain null","Bounded reaped native helper; three separately owned monitor kinds, 200 retained fixes, 30s startup budget and one-second native heartbeat","Portable geocoding requires configured numeric-loopback INTERCEPTOR_GEOCODER_URL; no public endpoint or invented addresses; no proxies, redirects, replay or cookies; 25s HTTP budget, 1MiB response and 64KiB normalized output","Geocoder placemarks preserve service attribution and native WGS84 coordinates; locale, structured postal fields and geocode region bias are sent to the actual configured service","Apple temporary-purpose accuracy and the baseline iOS-only heading API have no portable equivalent; native authorization is never fabricated","Native permissions, actual sensors, GeoClue dependencies/desktop identity, local geocoder data/licenses and installed qualification remain open"]})}
#[cfg(test)]mod tests{use super::*;
    #[test]fn strict_coordinates_and_geodesic_cover_antipodes(){
        for s in["91,0","0,181","NaN,0","1,,2","0x1,0","1e999,0"]{assert!(coordinates(&json!(s),false).is_none());}
        assert_eq!(coordinates(&json!(" 1, -2 "),false),Some(vec![1.0,-2.0]));
        let r=dispatch(&json!({"type":"desktop_location","sub":"distance","from":"0,0","to":"0,180"}));assert_eq!(r["success"],true);assert!((r["data"]["meters"].as_f64().unwrap()-20003931.458625447).abs()<0.001);
    }
    #[test]fn real_geocoder_fields_are_normalized_without_invented_accuracy(){
        let a=json!({"type":"desktop_location","sub":"reverse","coords":"1,2"});let raw=json!({"lat":"1.1","lon":"2.1","display_name":"actual service address","address":{"city":"native city","country_code":"us"},"licence":"Data © OpenStreetMap contributors, ODbL1.0"});
        let r=normalize_geocoded(&a,&raw).unwrap();assert_eq!(r["coordinate"],json!([1.0,2.0]));assert_eq!(r["placemarks"][0]["coordinate"],json!([1.1,2.1]));assert_eq!(r["placemarks"][0]["isoCountryCode"],"US");assert!(r["placemarks"][0].get("horizontalAccuracy").is_none());assert!(r["placemarks"][0]["attribution"].is_string());
        assert!(normalize_geocoded(&a,&json!({"lat":"nan","lon":"0"})).is_err());assert!(serde_json::from_value::<DesktopCapability>(capability("fixture")).is_ok());
    }
}
