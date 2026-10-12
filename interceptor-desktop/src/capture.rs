use crate::{failure,success,contract_generated::*};
use serde_json::{Value,json};
use base64::Engine;
use image::{RgbaImage,ImageEncoder};
use std::{cell::RefCell,io::Write,path::PathBuf,time::{Duration,Instant}};

pub fn validate(action:&Value)->Result<(),Value>{
    if let Some(error)=desktop_capture_shape_error(action){return Err(failure("invalid_request",error));}
    for name in ["app","element","cwd"] {if action.get(name).is_some_and(|v|v.as_str().is_none_or(|s|s.is_empty()||s.contains('\0'))){return Err(failure("invalid_request",format!("{name} requires nonempty text without NUL")));}}
    for (name,min,max) in [("window",1.0,9007199254740991.0),("display",1.0,9007199254740991.0),("quality",0.0,100.0),("target_max_long_edge",0.0,16384.0),("timeoutMs",0.0,DESKTOP_CAPTURE_MAX_TIMEOUT_MS as f64)] {
        if action.get(name).is_some_and(|v|v.as_f64().is_none_or(|n|!n.is_finite()||n.fract()!=0.0||n<min||n>max)){return Err(failure("invalid_request",format!("{name} requires an integer from {min}{} to {max}",if name=="target_max_long_edge"{" (no limit)"}else{""})));}
    }
    if action.get("element").is_some(){return Err(failure("unsupported_operation","native element screenshot is not implemented by the macOS baseline"));}
    Ok(())
}
pub fn dispatch(verb:&str,action:&Value)->Value{
    if let Err(error)=validate(action){return error;}
    #[cfg(windows)]{return crate::windows::dispatch(verb,action);}
    #[cfg(target_os="linux")]{return crate::linux::dispatch(verb,action);}
    #[cfg(not(any(windows,target_os="linux")))]{let _=verb;failure("unsupported_operation","macOS uses its Swift capture provider")}
}
pub fn pixel_size(width:u32,height:u32)->Result<usize,Value>{
    let count=(width as usize).checked_mul(height as usize).filter(|n|*n>0&&*n<=DESKTOP_CAPTURE_MAX_PIXELS)
        .ok_or_else(||failure("resource_limit","capture dimensions exceed the 32 megapixel bound"))?;
    count.checked_mul(4).ok_or_else(||failure("resource_limit","capture byte size overflow"))
}
pub(crate) fn encode(pixels:&RgbaImage,format:&str,quality:u8)->Result<Vec<u8>,Value>{
    pixel_size(pixels.width(),pixels.height())?;
    let mut bytes=Vec::new();
    let encoded=match format {
        "png"=>image::codecs::png::PngEncoder::new(&mut bytes).write_image(pixels.as_raw(),pixels.width(),pixels.height(),image::ExtendedColorType::Rgba8),
        "webp"=>image::codecs::webp::WebPEncoder::new_lossless(&mut bytes).write_image(pixels.as_raw(),pixels.width(),pixels.height(),image::ExtendedColorType::Rgba8),
        _=>image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes,quality).encode_image(&image::DynamicImage::ImageRgba8(pixels.clone()).to_rgb8()),
    };
    encoded.map_err(|e|failure("provider_failed",format!("image encoding failed: {e}")))?;
    if bytes.len()>DESKTOP_MAX_RESULT_BYTES{return Err(failure("resource_limit","encoded capture exceeds the desktop result bound"));}
    Ok(bytes)
}
fn bounded(data:Value)->Value{
    let result=success(data);
    if serde_json::to_vec(&result).is_ok_and(|v|v.len()<=DESKTOP_MAX_RESULT_BYTES){result}else{failure("resource_limit","capture result exceeds the desktop frame budget")}
}
pub(crate) fn image_result(mut pixels:RgbaImage,action:&Value,frame:bool)->Value{
    let (original_width,original_height)=pixels.dimensions();
    let edge=if frame{0}else{action["target_max_long_edge"].as_f64().unwrap_or(DESKTOP_CAPTURE_DEFAULT_LONG_EDGE as f64)as u32};
    let long=original_width.max(original_height);
    if edge>0&&long>edge {
        let width=((original_width as u64*edge as u64)/long as u64).max(1)as u32;
        let height=((original_height as u64*edge as u64)/long as u64).max(1)as u32;
        pixels=image::imageops::resize(&pixels,width,height,image::imageops::FilterType::Triangle);
    }
    let format=if frame{"jpeg"}else{action["format"].as_str().unwrap_or("jpeg")};
    let quality=if frame{80}else{action["quality"].as_f64().unwrap_or(DESKTOP_CAPTURE_DEFAULT_QUALITY as f64)as u8};
    let bytes=match encode(&pixels,format,quality){Ok(v)=>v,Err(error)=>return error};
    let mut data=json!({"format":format,"bytes":bytes.len(),"width":pixels.width(),"height":pixels.height()});
    if !frame{data["originalWidth"]=json!(original_width);data["originalHeight"]=json!(original_height);}
    if !frame&&action["save"]==true {
        let extension=if format=="jpeg"{"jpg"}else{format};
        let filename=format!("interceptor-desktop-screenshot-{}.{extension}",time::OffsetDateTime::now_utc().unix_timestamp_nanos());
        let home=std::env::var_os(if cfg!(windows){"USERPROFILE"}else{"HOME"}).map(PathBuf::from);
        let candidates=[action["cwd"].as_str().map(PathBuf::from),home.as_ref().map(|p|p.join("Downloads")),home,Some(std::env::temp_dir())];
        for directory in candidates.into_iter().flatten().filter(|d|d.is_absolute()&&d.is_dir()){
            let path=directory.join(&filename);
            let mut options=std::fs::OpenOptions::new();options.write(true).create_new(true);
            #[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;options.mode(0o600).custom_flags(libc::O_NOFOLLOW);}
            match options.open(&path){Ok(mut file)=>{
                if let Err(error)=file.write_all(&bytes){return failure("partial_result",format!("capture file write failed: {error}"));}
                data["filePath"]=json!(path);return bounded(data);
            },Err(error)if error.kind()==std::io::ErrorKind::PermissionDenied=>continue,Err(error)=>return failure("provider_failed",error)}
        }
        return failure("permission_denied","no writable capture destination");
    }
    let mime=if format=="jpeg"{"image/jpeg"}else if format=="png"{"image/png"}else{"image/webp"};
    data["dataUrl"]=json!(format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes)));
    bounded(data)
}

#[cfg(windows)]pub(crate) type Source=crate::capture_windows::Source;
#[cfg(target_os="linux")]pub(crate) type Source=crate::capture_linux::Source;
#[cfg(any(windows,target_os="linux"))]
struct State{source:Option<Source>,latest:Option<Value>,timestamp:Option<Instant>,last_poll:Instant,error:Option<Value>}
#[cfg(any(windows,target_os="linux"))]
thread_local!{static STATE:RefCell<Option<State>>=const{RefCell::new(None)};}

#[cfg(any(windows,target_os="linux"))]
thread_local!{static RECORDINGS:RefCell<std::collections::BTreeMap<String,(Source,std::sync::Arc<crate::monitor::Observer>)>>=const{RefCell::new(std::collections::BTreeMap::new())};}

// Recording owns separate native streams. The public capture cache is never
// replaced, sampled or stopped by a recording.
pub(crate) fn record_start(action:&Value,owner:std::sync::Arc<crate::monitor::Observer>)->Value{
    #[cfg(any(windows,target_os="linux"))]{
        let full=RECORDINGS.with(|slot|{let mut sources=slot.borrow_mut();sources.retain(|_,(_,owner)|owner.generation.load(std::sync::atomic::Ordering::Acquire)!=0);sources.len()>=4||sources.contains_key(&owner.sid)});
        if full{return failure("resource_limit","at most four independent recording frame streams may be active");}
        let app=action["app"].as_str().unwrap_or("");let app=if cfg!(windows){app.trim_end_matches(".exe")}else{app};
        let mut target=action.clone();
        #[cfg(windows)]{
            let(window,pid)=match crate::windows::capture_window(action){Ok(target)=>target,Err(error)=>return error};
            if !owner.accepts(pid,app,false){return failure("permission_denied","recording frame target is outside the explicit application scope or excluded");}
            target["window"]=json!(window.0 as usize);target["pid"]=json!(pid);
        }
        #[cfg(target_os="linux")]{
            let Some(pid)=action["_capture_pid"].as_u64().filter(|pid|*pid>0&&*pid<=u32::MAX as u64)else{return failure("permission_denied","recording frames require an authenticated application process");};
            if !owner.accepts(pid as u32,app,false){return failure("permission_denied","recording frame target is outside the explicit application scope or excluded");}
        }
        let source=match Source::open(&target,true){Ok(source)=>source,Err(error)=>return error};
        if source.owner().is_none_or(|pid|!owner.accepts(pid,app,false)){return failure("permission_denied","recording frame target is outside the explicit application scope or excluded");}
        RECORDINGS.with(|slot|{slot.borrow_mut().insert(owner.sid.clone(),(source,owner));});success(json!({}))
    }
    #[cfg(not(any(windows,target_os="linux")))]{let _=(action,owner);failure("unsupported_operation","recording frames require a Windows or X11 capture source")}
}
pub(crate) fn record_control(action:&Value)->Value{
    #[cfg(any(windows,target_os="linux"))]{
        RECORDINGS.with(|slot|{
            let mut sources=slot.borrow_mut();let sid=action["sid"].as_str().unwrap_or("");
            if action["sub"]=="stop"{sources.remove(sid);return success(json!({}));}
            let Some((source,owner))=sources.get_mut(sid)else{return failure("target_gone","recording frame stream is not active");};
            if owner.epoch().is_none(){return success(Value::Null);}
            match source.next_frame(){Ok(Some(pixels))=>image_result(pixels,action,false),Ok(None)=>success(Value::Null),Err(error)=>error}
        })
    }
    #[cfg(not(any(windows,target_os="linux")))]{let _=action;failure("unsupported_operation","no native recording frame source")}
}

// Called on the existing platform worker. No new Xlib/COM thread, input event,
// foreground change, or automatic retry is introduced.
pub fn tick(){
    #[cfg(any(windows,target_os="linux"))]RECORDINGS.with(|slot|slot.borrow_mut().retain(|_,(_,owner)|owner.generation.load(std::sync::atomic::Ordering::Acquire)!=0));
    #[cfg(any(windows,target_os="linux"))]STATE.with(|slot|{
        let mut slot=slot.borrow_mut();let Some(state)=slot.as_mut()else{return;};
        if state.last_poll.elapsed()<Duration::from_millis(100){return;}state.last_poll=Instant::now();
        let Some(source)=state.source.as_mut()else{return;};
        match source.next_frame(){
            Ok(Some(pixels))=>{
                let result=image_result(pixels,&json!({}),true);
                if result["success"]==true{state.latest=Some(result);state.timestamp=Some(Instant::now());state.error=None;}
                else{state.source=None;state.latest=None;state.timestamp=None;state.error=Some(result);}
            },
            Ok(None)=>(),
            Err(error)=>{state.source=None;state.latest=None;state.timestamp=None;state.error=Some(error);}
        }
    });
    crate::stream::tick();
}
pub fn execute(verb:&str,action:&Value)->Value{
    #[cfg(any(windows,target_os="linux"))]{
        if verb=="screenshot" {
            let mut source=match Source::open(action,false){Ok(v)=>v,Err(error)=>return error};
            let start=Instant::now();loop{match source.next_frame(){Ok(Some(pixels))=>return image_result(pixels,action,false),Err(error)=>return error,Ok(None)=>()};
                if start.elapsed()>=Duration::from_millis(DESKTOP_CAPTURE_DEFAULT_TIMEOUT_MS as u64){return failure("provider_failed","capture source delivered no frame within 3000ms");}std::thread::sleep(Duration::from_millis(10));}
        }
        let sub=action["sub"].as_str().unwrap_or("frame");
        if sub=="stop"{STATE.with(|s|*s.borrow_mut()=None);return success(json!("capture stopped"));}
        if sub=="start" {
            if STATE.with(|s|s.borrow().is_some()){return failure("invalid_request","capture has an existing session or retained failure; stop it before selecting another target");}
            let source=match Source::open(action,true){Ok(v)=>v,Err(error)=>return error};
            STATE.with(|s|*s.borrow_mut()=Some(State{source:Some(source),latest:None,timestamp:None,last_poll:Instant::now()-Duration::from_secs(1),error:None}));
            return success(json!("continuous capture started"));
        }
        tick();
        if sub=="status" {return STATE.with(|s|match s.borrow().as_ref(){None=>success(json!({"active":false,"hasFrame":false})),Some(state)=>{
            let mut data=json!({"active":state.source.is_some(),"hasFrame":state.latest.is_some()});if let Some(ts)=state.timestamp{data["frameAgeMs"]=json!(ts.elapsed().as_millis());}success(data)}});}
        let start=Instant::now();let wait=Duration::from_millis(action["timeoutMs"].as_f64().unwrap_or(DESKTOP_CAPTURE_DEFAULT_TIMEOUT_MS as f64)as u64);
        loop {
            tick();
            if let Some(result)=STATE.with(|s|match s.borrow().as_ref(){None=>Some(failure("invalid_request","capture not started; call desktop capture start first")),Some(state)=>state.error.clone().or_else(||state.latest.clone())}){return result;}
            if start.elapsed()>=wait{return failure("provider_failed","capture stream active but no frame within the requested timeout");}std::thread::sleep(Duration::from_millis(10));
        }
    }
    #[cfg(not(any(windows,target_os="linux")))]{let _=(verb,action);failure("unsupported_operation","no capture backend on this host")}
}
pub fn capabilities(host:&str,session:&str,effective:bool)->Vec<Value>{
    // On Hyprland the direct toplevel-export/screencopy backend replaces the portal picker.
    #[cfg(target_os="linux")]let hyprland=crate::capture_linux::hyprland_available();
    #[cfg(not(target_os="linux"))]let hyprland=false;
    let wayland=host=="linux"&&std::env::var_os("WAYLAND_DISPLAY").is_some()&&!hyprland;
    ["screenshot","capture"].map(|operation|json!({"operation":operation,"compiled":true,"present":true,"permission":if wayland{"unknown"}else{"not_applicable"},"session":session,"effective":effective&&!wayland,
        "background":if effective&&!wayland{"window"}else{"unavailable"},"provider":if host=="win32"{"Windows.Graphics.Capture/D3D11"}else if hyprland{"Hyprland.toplevel-export/wlr-screencopy"}else if wayland{"ScreenCast/PipeWire/GStreamer CPU"}else{"X11.Composite/XRes"},
        "versions":if wayland{json!({"contract":"1","image":"0.25.9","gstreamerBindings":"0.25.2","requiredScreenCast":"6","requiredPipeWirePlugin":"1.4.2"})}else{json!({"contract":"1","image":"0.25.9"})},
        "limits":["same interactive session","32 megapixels","continuous frame cache refreshes at most 10 Hz","WebP encoding is lossless; quality applies to JPEG","Windows capture indicator remains visible","Wayland source requires native portal consent, a non-reused stream serial and CPU-mappable video; no exact app/window/display selector or input ownership is inferred","Current Wayland grouped builds, dependency packaging, permission/lifecycle/focus and installed qualification remain open"]})).to_vec()
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn request_bounds_precede_native_capture(){
        for action in [json!({"type":"desktop_screenshot","quality":0,"target_max_long_edge":0}),json!({"type":"desktop_capture","sub":"frame","timeoutMs":0})]{assert!(validate(&action).is_ok());}
        for action in [json!({"type":"desktop_screenshot","window":0}),json!({"type":"desktop_screenshot","quality":101}),json!({"type":"desktop_screenshot","quality":1.5}),json!({"type":"desktop_capture","timeoutMs":10001}),json!({"type":"desktop_capture","app":null}),json!({"type":"desktop_screenshot","cwd":"a\u{0000}b"}),json!({"type":"desktop_capture","sub":"missing"})]{assert_eq!(validate(&action).unwrap_err()["code"],"invalid_request");}
    }
    #[test]fn real_encoders_preserve_dimensions_and_resize_bounds(){
        let pixels=RgbaImage::from_fn(64,32,|x,_|image::Rgba(if x<32{[0,0,255,255]}else{[255,0,0,255]}));
        for format in ["png","jpeg","webp"]{let result=image_result(pixels.clone(),&json!({"format":format,"target_max_long_edge":16}),false);assert_eq!(result["success"],true);assert_eq!(result["data"]["width"],16);assert_eq!(result["data"]["height"],8);
            let bytes=base64::engine::general_purpose::STANDARD.decode(result["data"]["dataUrl"].as_str().unwrap().split(',').nth(1).unwrap()).unwrap();let decoded=image::load_from_memory(&bytes).unwrap().to_rgba8();assert_eq!(decoded.dimensions(),(16,8));assert_eq!(bytes.len(),result["data"]["bytes"].as_u64().unwrap()as usize);assert!(decoded.get_pixel(2,2)[2]>200);assert!(decoded.get_pixel(13,2)[0]>200);}
        assert!(pixel_size(0,10).is_err());assert!(pixel_size(100000,100000).is_err());
    }
}
