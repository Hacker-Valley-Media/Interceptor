use crate::{contract_generated::*,failure,success};
use base64::{Engine as _,engine::general_purpose::STANDARD};
use serde_json::{json,Value};
use std::{io,sync::{Arc,Mutex,atomic::{AtomicBool,Ordering},mpsc},time::{Duration,Instant,SystemTime,UNIX_EPOCH}};
type Result<T>=std::result::Result<T,Value>;
struct Job{cancelled:AtomicBool,helper:Mutex<Option<crate::thumbnail::OwnedHelper>>}
impl Job{fn cancel(&self){self.cancelled.store(true,Ordering::Release);drop(self.helper.lock().unwrap().take());}}
struct State{job:Option<Arc<Job>>,monitoring:bool,latest:Option<Value>,checks:u64,error:Option<String>}
// ponytail: one check or monitor owns inference; add queues only after measured demand.
static STATE:Mutex<State>=Mutex::new(State{job:None,monitoring:false,latest:None,checks:0,error:None});
fn validate(a:&Value)->Result<()>{
    if let Some(e)=desktop_sensitive_shape_error(a){return Err(failure("invalid_request",e));}
    if let Some(path)=a.get("imagePath"){crate::filesystem::absolute(path.as_str().unwrap_or(""))?;}
    let bounded=|v:&Value,max:usize|v.as_str().is_some_and(|s|!s.trim().is_empty()&&!s.contains('\0')&&s.len()<=max);
    if a.get("app").is_some_and(|v|!bounded(v,512))||a.get("app").is_some()&&a.get("imagePath").is_some(){return Err(failure("invalid_request","sensitive requires one app or image file"));}
    if ["group","groupColor"].iter().any(|key|a.get(key).is_some_and(|v|!bounded(v,256))){return Err(failure("invalid_request","invalid sensitive request group"));}
    if a["sub"]=="check"&&a.get("op").is_some(){return Err(failure("invalid_request","sensitive check has no monitor operation"));}
    if a["sub"]=="monitor"{
        let op=a["op"].as_str().unwrap_or("status");
        if a.get("imagePath").is_some()||op=="start"&&a.get("app").is_none()||op!="start"&&a.get("app").is_some(){return Err(failure("invalid_request","sensitive monitor start requires an explicit app; status/stop have no source"));}
    }
    Ok(())
}
fn snapshot()->Value{let s=STATE.lock().unwrap();json!({"monitoring":s.monitoring,"latest":s.latest,"checks":s.checks,"lastError":s.error,"cleanupPending":s.job.as_ref().is_some_and(|j|!s.monitoring||j.cancelled.load(Ordering::Acquire))})}
fn reserve(monitor:bool)->Result<Arc<Job>>{
    let mut s=STATE.lock().unwrap();
    if s.job.is_some(){return Err(failure("resource_limit","sensitive analysis or cleanup is active; no work queued"));}
    let job=Arc::new(Job{cancelled:AtomicBool::new(false),helper:Mutex::new(None)});
    if monitor{s.monitoring=false;s.latest=None;s.checks=0;s.error=None;}s.job=Some(job.clone());Ok(job)
}
fn release(job:&Arc<Job>){drop(job.helper.lock().unwrap().take());let mut s=STATE.lock().unwrap();if s.job.as_ref().is_some_and(|active|Arc::ptr_eq(active,job)){s.job=None;s.monitoring=false;}}
fn cancelled(job:&Job)->Result<()>{if job.cancelled.load(Ordering::Acquire){Err(failure("cancelled","sensitive client helper stopped; no request replayed"))}else{Ok(())}}
fn analyze(job:&Job,request:&Value,deadline:Instant)->Result<Value>{
    cancelled(job)?;
    let result=(||->io::Result<Value>{
        let mut helper=crate::thumbnail::OwnedHelper::spawn("--sensitive-engine")?;
        let mut input=helper.child.0.stdin.take().ok_or_else(||io::Error::other("sensitive helper input missing"))?;
        let mut output=helper.child.0.stdout.take().ok_or_else(||io::Error::other("sensitive helper output missing"))?;
        {let mut owned=job.helper.lock().unwrap();if job.cancelled.load(Ordering::Acquire){return Err(io::ErrorKind::ConnectionAborted.into());}*owned=Some(helper);}
        crate::write_frame(&mut input,&serde_json::to_vec(request)?)?;drop(input);
        let bytes=crate::auth::bounded_child_result(|bytes|{if job.cancelled.load(Ordering::Acquire){return Err(io::ErrorKind::ConnectionAborted.into());}crate::auth::ready_read(&mut output,bytes)},deadline,16384)?;
        let reply:Value=serde_json::from_slice(&bytes)?;
        loop{
            if job.cancelled.load(Ordering::Acquire){return Err(io::ErrorKind::ConnectionAborted.into());}
            let done=job.helper.lock().unwrap().as_mut().ok_or(io::ErrorKind::ConnectionAborted)?.exited()?;
            if let Some(ok)=done{if !ok{return Err(io::Error::other("sensitive helper exit failed"));}break;}
            if Instant::now()>=deadline{return Err(io::ErrorKind::TimedOut.into());}std::thread::sleep(Duration::from_millis(5));
        }
        Ok(reply)
    })();
    drop(job.helper.lock().unwrap().take());cancelled(job)?;
    let reply=result.map_err(|e|failure(if e.kind()==io::ErrorKind::TimedOut{"timeout_unknown_outcome"}else{"provider_failed"},format!("sensitive helper failed or exceeded its deadline and was reaped: {e}; local server cancellation is server-owned")))?;
    if reply["success"]==false&&reply["error"].is_string(){return Err(reply);}
    if reply["success"]!=true{return Err(failure("provider_failed","sensitive helper reply is malformed"));}
    let data=reply.get("data").ok_or_else(||failure("provider_failed","sensitive helper omitted its result"))?;
    let _:DesktopSensitiveCheck=serde_json::from_value(data.clone()).map_err(|_|failure("provider_failed","sensitive helper violated its check schema"))?;
    if data["policyEnabled"]!=true||data["policy"]!="local-vision-model"||data["timestamp"].as_f64().is_none_or(|n|!n.is_finite()||n<0.0){return Err(failure("provider_failed","sensitive helper returned invalid observation provenance"));}
    Ok(data.clone())
}
fn source(a:&Value)->Result<Value>{
    if let Some(path)=a.get("imagePath"){return Ok(json!({"imagePath":path}));}
    let mut capture=json!({"type":"desktop_screenshot","format":"png"});if let Some(app)=a.get("app"){capture["app"]=app.clone();}
    let reply=crate::capture::dispatch("screenshot",&capture);
    if reply["success"]!=true{return Err(reply);}Ok(json!({"dataUrl":reply["data"]["dataUrl"]}))
}
fn frame(sid:&str,job:&Job,deadline:Instant,wait_first:bool)->Result<Value>{
    loop{
        cancelled(job)?;
        let reply=crate::stream::dispatch(&json!({"type":"desktop_stream","op":"frame","sid":sid}));
        if reply["success"]==true{return Ok(json!({"dataUrl":reply["data"]["dataUrl"]}));}
        if !wait_first||reply["error"]!="native stream has not delivered a frame yet"{return Err(reply);}
        if Instant::now()>=deadline{return Err(failure("timeout_unknown_outcome","sensitive stream did not deliver its first frame before the deadline"));}
        std::thread::sleep(Duration::from_millis(50));
    }
}
fn monitor(job:Arc<Job>,app:String,ready:mpsc::SyncSender<Value>){
    let mut sid=None;let mut ready=Some(ready);
    let result=(||->Result<()>{
        cancelled(&job)?;
        let started=crate::stream::dispatch(&json!({"type":"desktop_stream","op":"start","app":app}));
        if started["success"]!=true{return Err(started);}
        let id=started["data"]["sid"].as_str().filter(|s|!s.is_empty()).ok_or_else(||failure("provider_failed","sensitive stream omitted its session"))?.to_owned();sid=Some(id.clone());
        loop{
            let deadline=Instant::now()+Duration::from_millis((DESKTOP_SENSITIVE_DEADLINE_MS-5000)as u64);
            let request=frame(&id,&job,deadline,ready.is_some())?;let observed=analyze(&job,&request,deadline)?;
            // Revalidate the retained native stream after inference, before publishing.
            frame(&id,&job,deadline,false)?;
            {let mut s=STATE.lock().unwrap();cancelled(&job)?;if s.checks>=9007199254740991{return Err(failure("resource_limit","sensitive observation counter exhausted"));}s.latest=Some(observed);s.checks+=1;s.monitoring=true;}
            if let Some(sender)=ready.take(){let _=sender.send(success(snapshot()));}
            let wake=Instant::now()+Duration::from_secs(5);while Instant::now()<wake{cancelled(&job)?;std::thread::sleep(Duration::from_millis(50));}
        }
    })();
    {let mut s=STATE.lock().unwrap();s.monitoring=false;if let Err(ref e)=result{if !job.cancelled.load(Ordering::Acquire){s.error=Some(e["error"].as_str().unwrap_or("sensitive native analysis failed").chars().take(1000).collect());}}}
    drop(job.helper.lock().unwrap().take());
    if let Some(id)=sid{let stopped=crate::stream::dispatch(&json!({"type":"desktop_stream","op":"stop","sid":id}));if stopped["success"]!=true&&stopped["code"]!="target_gone"{STATE.lock().unwrap().error=Some("sensitive stream cleanup failed; inspect stream inventory".into());}}
    release(&job);
    if let Some(sender)=ready{let _=sender.send(result.err().unwrap_or_else(||failure("provider_failed","sensitive monitor ended before first observation")));}
}
pub fn dispatch(a:&Value)->Value{
    if let Err(e)=validate(a){return e;}
    if a["sub"]=="monitor"{
        match a["op"].as_str().unwrap_or("status"){
            "status"=>return success(snapshot()),"stop"=>{let job={let mut s=STATE.lock().unwrap();s.monitoring=false;s.job.clone()};if let Some(job)=job{job.cancel();}return success(snapshot());},_=>()
        }
        // Name the missing model server before resolving the app, so a target error never hides it.
        if std::env::var_os("INTERCEPTOR_LLAMA_VISION_URL").is_none(){return failure("not_installed","this build has no image model for sensitive-content checks; a local multimodal llama.cpp server can be configured with INTERCEPTOR_LLAMA_VISION_URL, _MODEL and _KEY");}
        let job=match reserve(true){Ok(job)=>job,Err(e)=>return e};let (sender,receiver)=mpsc::sync_channel(1);let worker=job.clone();let app=a["app"].as_str().unwrap().to_owned();
        if let Err(e)=std::thread::Builder::new().name("sensitive-monitor".into()).spawn(move||monitor(worker,app,sender)){release(&job);return failure("resource_limit",format!("sensitive worker could not start: {e}"));}
        return match receiver.recv_timeout(Duration::from_millis((DESKTOP_SENSITIVE_DEADLINE_MS-1000)as u64)){Ok(reply)=>reply,Err(_)=>{job.cancel();failure("timeout_unknown_outcome","sensitive monitor start exceeded its deadline; cleanup remains owned; inspect status before retrying")}};
    }
    let job=match reserve(false){Ok(job)=>job,Err(e)=>return e};let deadline=Instant::now()+Duration::from_millis((DESKTOP_SENSITIVE_DEADLINE_MS-5000)as u64);
    let result=source(a).and_then(|request|analyze(&job,&request,deadline));release(&job);
    match result{Ok(data)=>success(data),Err(e)=>e}
}
pub(crate) fn shutdown()->Value{
    let _=dispatch(&json!({"type":"desktop_sensitive","sub":"monitor","op":"stop"}));
    let deadline=Instant::now()+Duration::from_secs(15);
    while STATE.lock().unwrap().job.is_some(){if Instant::now()>=deadline{return failure("timeout_unknown_outcome","sensitive shutdown still owns capture cleanup; provider shutdown was not acknowledged");}std::thread::sleep(Duration::from_millis(10));}
    success(snapshot())
}
pub(crate) fn helper(parent:u32)->io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    #[cfg(unix)]{let limit=libc::rlimit{rlim_cur:512*1024*1024,rlim_max:512*1024*1024};if unsafe{libc::setrlimit(libc::RLIMIT_AS,&limit)}!=0{return Err(io::Error::other("sensitive helper memory limit failed"));}}
    let bytes=crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("sensitive helper requires one image"))?;let request:Value=serde_json::from_slice(&bytes)?;
    let result=(||->Result<Value>{
        if request.as_object().map(|o|o.len())!=Some(1){return Err(failure("invalid_request","sensitive helper requires exactly one file or encoded image"));}
        let bytes=if let Some(path)=request["imagePath"].as_str(){crate::thumbnail::source_bytes(&crate::filesystem::absolute(path)?)?}else{
            let data=request["dataUrl"].as_str().filter(|s|s.len()<=DESKTOP_MAX_RESULT_BYTES).ok_or_else(||failure("invalid_request","invalid sensitive encoded image"))?;
            let encoded=data.strip_prefix("data:image/jpeg;base64,").or_else(||data.strip_prefix("data:image/png;base64,")).ok_or_else(||failure("invalid_request","sensitive capture requires a JPEG/PNG data URL"))?;
            let decoded=STANDARD.decode(encoded).map_err(|_|failure("invalid_request","sensitive image base64 is invalid"))?;if decoded.len()>DESKTOP_MAX_RESULT_BYTES{return Err(failure("resource_limit","sensitive capture exceeds its byte bound"));}decoded
        };
        let pixels=crate::thumbnail::decode_raster(&bytes)?;let pixels=image::DynamicImage::ImageRgba8(pixels).thumbnail(1600,1600).to_rgba8();
        let mut visible=image::RgbaImage::from_pixel(pixels.width(),pixels.height(),image::Rgba([255,255,255,255]));image::imageops::overlay(&mut visible,&pixels,0,0);
        let jpeg=crate::capture::encode(&visible,"jpeg",85)?;let url=format!("data:image/jpeg;base64,{}",STANDARD.encode(jpeg));
        let sensitive=crate::language::sensitive_image(&url,Instant::now()+Duration::from_secs(30))?;
        let timestamp=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_|failure("provider_failed","system clock predates the observation epoch"))?.as_secs_f64();
        Ok(json!({"policyEnabled":true,"policy":"local-vision-model","isSensitive":sensitive,"timestamp":timestamp}))
    })();let reply=match result{Ok(data)=>success(data),Err(e)=>e};crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(&reply)?)
}
pub fn capability(session:&str)->Value{json!({"operation":"sensitive","compiled":true,"present":true,"effective":false,"permission":"unknown","background":"semantic","session":session,"provider":"owned image helper / authenticated local llama.cpp multimodal model","versions":{"contract":"1"},"limits":["One check or one monitor; image preprocessing is EXIF-aware and bounded to 1600px; 512MiB owned reaped client helper; 30s observation budget","Requires separately configured INTERCEPTOR_LLAMA_VISION_URL, _MODEL and _KEY on numeric loopback; no remote image URL, proxy, redirects or replay","Monitor requires one explicit native app; owns an existing stream slot and session, appears in stream inventory, samples every 5s after each completed result, and revalidates the stream before publication","Stop revokes publication and reaps only the owned client helper; cleanup remains pending until capture worker exits. Separate model-server work is server-owned","Portable policy is local-vision-model, not Apple policy. Gemma4E4B is a source-selected candidate; actual weights, CPU runtime/accuracy, licenses, package and installed qualification remain open"],"reason":"Sensitive detection is model output, not a calibrated safety guarantee; native/model/installed qualification has not run."})}
#[cfg(test)]mod tests{use super::*;
    #[test]fn sensitive_selector_ownership_and_admission_survive_stop(){
        for a in [json!({"type":"desktop_sensitive","sub":"check","imagePath":"relative"}),json!({"type":"desktop_sensitive","sub":"check","op":"start"}),json!({"type":"desktop_sensitive","sub":"monitor","op":"start"}),json!({"type":"desktop_sensitive","sub":"monitor","op":"stop","app":"x"}),json!({"type":"desktop_sensitive","sub":"check","app":"x","imagePath":"/tmp/x"})]{assert!(validate(&a).is_err());}
        assert!(validate(&json!({"type":"desktop_sensitive","sub":"monitor","op":"start","app":"owned"})).is_ok());
        let job=reserve(true).unwrap();job.cancel();assert!(snapshot()["cleanupPending"]==true);assert!(reserve(false).is_err());release(&job);assert_eq!(snapshot()["cleanupPending"],false);
        assert!(serde_json::from_value::<DesktopCapability>(capability("fixture")).is_ok());
    }
}
