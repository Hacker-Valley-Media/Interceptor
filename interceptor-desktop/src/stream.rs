use crate::{contract_generated::*,failure,success};
use serde_json::{json,Value};
use std::time::{Duration,Instant};

fn validate(a:&Value)->Result<(),Value>{
    if let Some(e)=desktop_stream_shape_error(a){return Err(failure("invalid_request",e));}
    let bounded=|v:&Value,max:usize|v.as_str().is_some_and(|s|!s.trim().is_empty()&&!s.contains('\0')&&s.len()<=max);
    if a.get("sid").is_some_and(|v|!bounded(v,64)||!v.as_str().unwrap().bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')){return Err(failure("invalid_request","invalid stream session identity"));}
    if a.get("sid").is_some()&&matches!(a["op"].as_str(),Some("start"|"status"|"list")){return Err(failure("invalid_request","stream admission/inventory accepts no session identifier"));}
    if ["app","window","display","virtual","format"].iter().any(|key|a.get(key).is_some())&&a["op"]!="start"{return Err(failure("invalid_request","stream target/format requires start"));}
    if a.get("app").is_some_and(|v|!bounded(v,512))||["window","display"].iter().any(|key|a.get(key).is_some_and(|v|v.as_f64().is_none_or(|n|!n.is_finite()||n.fract()!=0.0||!(1.0..=9007199254740991.0).contains(&n)))){return Err(failure("invalid_request","invalid stream native target"));}
    if ["app","window","display","virtual"].iter().filter(|key|a.get(key).is_some()).count()>1{return Err(failure("invalid_request","stream requires one target selector"));}
    if a.get("virtual").is_some_and(|v|!bounded(v,64))||a.get("format").is_some_and(|v|!matches!(v.as_str(),Some("jpeg"|"jpg"))){return Err(failure("invalid_request","invalid stream virtual target or frame format"));}
    let inputs=["inputType","ref","x","y","text","combo","direction","amount"];
    if a["op"]!="inject"&&inputs.iter().any(|key|a.get(key).is_some()){return Err(failure("invalid_request","stream input fields require inject"));}
    if a["op"]=="inject"{
        let kind=a["inputType"].as_str().unwrap_or("click");let owned:&[&str]=match kind{"click"=>&["x","y"],"type"=>&["text","ref"],"keys"=>&["combo"],_=>&["direction","amount"]};
        if inputs.iter().any(|key|*key!="inputType"&&a.get(key).is_some()&&!owned.contains(key)){return Err(failure("invalid_request","stream input fields contradict its type"));}
        if kind=="click"&&["x","y"].iter().any(|key|a[key].as_f64().is_none_or(|n|!n.is_finite()||n.fract()!=0.0||n.abs()>1_000_000.0))||kind=="type"&&!bounded(&a["text"],1048576)||kind=="keys"&&!bounded(&a["combo"],4096)||a.get("ref").is_some_and(|v|!bounded(v,256)){return Err(failure("invalid_request","invalid bounded stream input"));}
        if kind=="scroll"&&(a.get("direction").is_none()||a["amount"].as_f64().is_none_or(|n|n.fract()!=0.0||!(1.0..=10000.0).contains(&n))){return Err(failure("invalid_request","stream scroll requires direction and an integer amount 1..10000"));}
    }
    if a.get("recordOp").is_some()&&a["op"]!="record"{return Err(failure("invalid_request","record selector requires stream record"));}
    if (a.get("media").is_some()||a.get("recordAudio").is_some())&&(a["op"]!="record"||a["recordOp"]!="start"){return Err(failure("invalid_request","media and recording audio require stream record start"));}
    if a.get("recordAudio").is_some()&&a["media"]!=true{return Err(failure("invalid_request","recording audio requires explicit media recording"));}
    for key in ["group","groupColor"]{if a.get(key).is_some_and(|v|!bounded(v,256)){return Err(failure("invalid_request","invalid stream group text"));}}
    Ok(())
}
pub fn dispatch(a:&Value)->Value{
    if let Err(e)=validate(a){return e;}
    if a.get("virtual").is_some(){return failure("unsupported_operation","virtual-output stream selection awaits the qualified virtual-display backend; no display fallback was captured");}
    let mut action=a.clone();crate::accessibility::normalize_integer_fields(&mut action);
    #[cfg(windows)]return crate::windows::dispatch("stream",&action);
    #[cfg(target_os="linux")]return crate::linux::dispatch("stream",&action);
    #[cfg(not(any(windows,target_os="linux")))]{let _=action;failure("unsupported_operation","macOS uses its native StreamDomain")}
}
#[cfg(any(windows,target_os="linux"))]struct Session{
    source:Option<crate::capture::Source>,started:Instant,last_poll:Instant,latest:Option<Value>,error:Option<Value>,frames:u64,width:u32,height:u32,
    fps:f64,interval:Instant,interval_frames:u64,recorded:Option<(Instant,u64)>,record_duration:f64,record_frames:u64,
    media:Option<crate::stream_media::Recording>,
}
#[cfg(any(windows,target_os="linux"))]impl Session{
    fn poll(&mut self){
        if let Some(media)=self.media.as_mut(){media.expire();}
        if self.last_poll.elapsed()<Duration::from_millis(100){return;}self.last_poll=Instant::now();
        let Some(source)=self.source.as_mut()else{return;};
        let(frame,observed)=match source.next_frame(){Ok(None)=>return,Ok(Some(pixels))=>{
            let observed=Instant::now();self.width=pixels.width();self.height=pixels.height();(crate::capture::image_result(pixels,&json!({}),true),observed)
        },Err(e)=>(e,Instant::now())};
        if frame["success"]!=true{if let Some(media)=self.media.as_mut(){media.abort("native capture failed");}self.latest=None;self.error=Some(frame);self.source=None;return;}
        if self.frames>=9007199254740991{self.latest=None;self.error=Some(failure("resource_limit","stream frame counter reached its exact wire limit"));self.source=None;return;}
        self.frames+=1;self.interval_frames+=1;self.latest=Some(frame["data"]["dataUrl"].clone());
        if let Some(media)=self.media.as_mut(){
            use base64::Engine;
            match frame["data"]["dataUrl"].as_str().and_then(|text|text.strip_prefix("data:image/jpeg;base64,")).and_then(|text|base64::engine::general_purpose::STANDARD.decode(text).ok()){
                Some(jpeg)=>media.observe(jpeg,self.width,self.height,observed),None=>media.abort("native JPEG frame could not be retained")
            }
        }
        let elapsed=self.interval.elapsed().as_secs_f64();if elapsed>=1.0{self.fps=self.interval_frames as f64/elapsed;self.interval_frames=0;self.interval=Instant::now();}
        if let Some((_,frames))=self.recorded.as_mut(){*frames+=1;}
    }
    fn recording(&self)->(bool,u64,f64){match self.recorded{Some((at,frames))=>(true,frames,at.elapsed().as_secs_f64()),None=>(false,self.record_frames,self.record_duration)}}
    fn finish_recording(&mut self)->Result<(),Value>{
        let result=if let Some(media)=self.media.as_mut(){if self.error.is_some(){media.abort("native stream failed before recording stop");}media.finish()}else{Ok(())};
        if let Some((at,frames))=self.recorded.take(){self.record_duration=at.elapsed().as_secs_f64();self.record_frames=frames;}result
    }
}
#[cfg(any(windows,target_os="linux"))]thread_local!{static SESSIONS:std::cell::RefCell<std::collections::BTreeMap<String,Session>>=const{std::cell::RefCell::new(std::collections::BTreeMap::new())};}
pub(crate) fn tick(){#[cfg(any(windows,target_os="linux"))]SESSIONS.with(|slot|{for session in slot.borrow_mut().values_mut(){session.poll();}});}
pub(crate) fn execute(a:&Value,mut input:impl FnMut(&str,&Value)->Value)->Value{
    #[cfg(any(windows,target_os="linux"))]return SESSIONS.with(|slot|{
        let mut sessions=slot.borrow_mut();let op=a["op"].as_str().unwrap();
        if op=="start"{
            if sessions.len()>=DESKTOP_STREAM_MAX_SESSIONS{return failure("resource_limit","at most four independent native streams may be active");}
            let id=crate::monitor::identifier();if sessions.contains_key(&id){return failure("resource_limit","new stream identity collided; no capture was admitted");}
            let source=match crate::capture::Source::open(a,true){Ok(v)=>v,Err(e)=>return e};let now=Instant::now();
            sessions.insert(id.clone(),Session{source:Some(source),started:now,last_poll:now-Duration::from_secs(1),latest:None,error:None,frames:0,width:0,height:0,fps:0.0,interval:now,interval_frames:0,recorded:None,record_duration:0.0,record_frames:0,media:None});
            return success(json!({"sid":id,"status":"streaming"}));
        }
        if op=="stop"&&a.get("sid").is_none(){let errors=sessions.values_mut().filter_map(|s|s.finish_recording().err()).collect::<Vec<_>>();sessions.clear();return errors.into_iter().next().unwrap_or_else(||success(json!("ok")));}
        if matches!(op,"status"|"list"){
            for s in sessions.values_mut(){s.poll();}
            if let Some(error)=sessions.values().find_map(|s|s.error.clone()){return error;}
            return success(json!(sessions.iter().map(|(sid,s)|if op=="status"{json!({"sid":sid,"frameCount":s.frames,"fps":s.fps,"duration":s.started.elapsed().as_secs_f64()})}else{json!({"sid":sid,"frameCount":s.frames,"currentFPS":s.fps,"width":s.width,"height":s.height,"recording":s.recorded.is_some()&&s.media.as_ref().is_none_or(|m|m.active())})}).collect::<Vec<_>>()));
        }
        let sid=match a["sid"].as_str(){Some(s)=>s.to_owned(),None if sessions.len()==1=>sessions.keys().next().unwrap().clone(),None=>return failure("invalid_request","name one active stream; no default stream exists or the selection is ambiguous")};
        if op=="stop"{return if let Some(mut s)=sessions.remove(&sid){s.finish_recording().err().unwrap_or_else(||success(json!("ok")))}else{failure("target_gone","stream session is not active")};}
        let Some(s)=sessions.get_mut(&sid)else{return failure("target_gone","stream session is not active");};s.poll();if let Some(error)=&s.error{return error.clone();}
        match op{
            "frame"=>match &s.latest{Some(data)=>success(json!({"dataUrl":data,"frameCount":s.frames})),None=>failure("provider_failed","native stream has not delivered a frame yet")},
            "fps"=>success(json!({"fps":s.fps})),"resolution"=>success(json!({"width":s.width,"height":s.height})),
            "record"=>{
                match a["recordOp"].as_str().unwrap_or("status"){
                    "start"=>{
                        if s.recorded.is_some(){return failure("invalid_request","stream recording is already active");}
                        if a["recordAudio"]=="system"{return failure("unsupported_operation","portable stream audio clock/source synchronization is not qualified; no audio or media file was admitted");}
                        let media=if a["media"]==true{
                            let source=s.source.as_ref().unwrap();
                            let identity=match source.owner().zip(source.window_id()){Some((pid,window))=>json!({"kind":"window","pid":pid,"window":window}),None=>json!({"kind":if cfg!(target_os="linux")&&std::env::var_os("WAYLAND_DISPLAY").is_some(){"portal-monitor"}else{"display"}})};
                            match crate::stream_media::Recording::start(&sid,identity){Ok(media)=>Some(media),Err(error)=>return error}
                        }else{None};
                        s.media=media;s.recorded=Some((Instant::now(),0));
                        return success(s.media.as_ref().map(|media|media.snapshot(&sid)).unwrap_or_else(||json!({"recording":true,"sid":sid})));
                    },
                    "stop"=>{if let Err(error)=s.finish_recording(){return error;}},_=>()
                }
                if let Some(media)=s.media.as_ref(){if let Some(error)=media.problem(){return error;}return success(media.snapshot(&sid));}
                let(recording,frames,duration)=s.recording();success(json!({"recording":recording,"frames":frames,"duration":duration}))
            },
            "inject"=>{
                let Some((pid,window))=s.source.as_ref().and_then(|source|source.owner().zip(source.window_id()))else{return failure("unsupported_target","background stream input requires an owned app/window capture, not a display stream");};
                let kind=a["inputType"].as_str().unwrap_or("click");let mut child=json!({"type":format!("desktop_{kind}"),"pid":pid,"window":window,"backgroundOnly":true});
                match kind{
                    "click"=>child["coords"]=json!(format!("{},{}",a["x"],a["y"])),
                    "type"=>{child["text"]=a["text"].clone();if let Some(r)=a.get("ref"){child["ref"]=r.clone();}},
                    "keys"=>child["keys"]=a["combo"].clone(),_=>{child["direction"]=a["direction"].clone();child["amount"]=a["amount"].clone();}
                }
                if let Err(error)=crate::accessibility::validate(kind,&child){return error;}input(kind,&child)
            },_=>failure("invalid_request","unknown stream operation")
        }
    });
    #[cfg(not(any(windows,target_os="linux")))]{let _=(a,&mut input);failure("unsupported_operation","no portable native stream on this host")}
}
pub fn capability(session:&str)->Value{json!({"operation":"stream","compiled":true,"present":true,"effective":false,"permission":"unknown","session":session,"background":"window","provider":"owned native capture / existing background input worker","versions":{"contract":"1"},"limits":["Four independent streams, 32 megapixel frames, bounded JPEG wire bytes; latest frame cache samples at most 10Hz","Input requires the captured native process/window and explicit background-only delivery; portal/display streams expose no inferred app or window identity and cannot receive global input","Explicit media recording writes at most 100MiB/100000 frames/one hour of actual MJPEG in Matroska using measured monotonic arrival times; no compositor PTS, CFR duplication or audio synchronization is claimed","Portable audio synchronization and virtual outputs remain open; default record retains legacy frame counts only","Wayland monitor source is a portal/PipeWire/GStreamer source candidate only; native permission/lifecycle/hotplug/focus, grouped builds/tests and installed qualification remain open"]})}
#[cfg(test)]mod tests{use super::*;
    #[test]fn strict_stream_selectors_and_real_input_fields(){
        for a in [json!({"type":"desktop_stream","op":"start","window":123}),json!({"type":"desktop_stream","op":"inject","inputType":"keys","combo":"ctrl+a"}),json!({"type":"desktop_stream","op":"record","recordOp":"stop","sid":"owned_123"})]{assert!(validate(&a).is_ok());}
        for a in [json!({"type":"desktop_stream","op":"start","window":0}),json!({"type":"desktop_stream","op":"start","app":"x","display":1}),json!({"type":"desktop_stream","op":"frame","sid":"../outside"}),json!({"type":"desktop_stream","op":"inject","inputType":"keys"}),json!({"type":"desktop_stream","op":"inject","inputType":"keys","combo":"ctrl+a","text":"unexpected"}),json!({"type":"desktop_stream","op":"record","recordOp":"invalid"})]{assert!(validate(&a).is_err());}
        assert!(serde_json::from_value::<DesktopCapability>(capability("fixture")).is_ok());
    }
}
