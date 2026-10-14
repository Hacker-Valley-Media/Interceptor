use crate::{contract_generated::*,failure,success};
use serde_json::{json,Value};
use std::{sync::Mutex,time::Duration};
static SESSION:Mutex<Option<(crate::audio::AudioSession,f64)>>=Mutex::new(None);
fn status(level:&Value,threshold:f64)->Result<Value,Value>{
    if !level["active"].is_boolean(){return Err(failure("provider_failed","native VAD audio status is malformed"));}
    if level["active"]==false{return Err(failure("provider_failed","native VAD microphone capture ended unexpectedly"));}
    let value=if level["frames"]==0&&level["level"].is_null(){0.0}else{level["level"].as_f64().filter(|n|n.is_finite()&&*n>=0.0).ok_or_else(||failure("provider_failed","native VAD PCM level is invalid"))?};
    Ok(json!({"active":true,"speaking":value>threshold,"level":value}))
}
pub fn dispatch(action:&Value)->Value{
    if let Some(error)=desktop_vad_shape_error(action){return failure("invalid_request",error);}
    if action.get("threshold").is_some_and(|n|action["sub"]!="start"||n.as_f64().is_none_or(|n|!n.is_finite()||!(0.0..=1.0).contains(&n))){return failure("invalid_request","VAD threshold requires start and a finite value 0..1");}
    for key in ["group","groupColor"]{if action.get(key).is_some_and(|v|v.as_str().is_none_or(|s|s.trim().is_empty()||s.len()>256||s.contains('\0'))){return failure("invalid_request","invalid VAD group text");}}
    let Ok(mut session)=SESSION.try_lock()else{return failure("invalid_request","VAD lifecycle busy; no work queued");};
    match action["sub"].as_str().unwrap(){
        "start"=>{
            if session.is_some(){return failure("invalid_request","VAD already active");}
            match crate::audio::AudioSession::start(&json!({"type":"desktop_audio","sub":"input","op":"start"})){
                Ok((capture,_))=>{*session=Some((capture,action["threshold"].as_f64().unwrap_or(0.02)));success(json!({"active":true}))},Err(error)=>error,
            }
        },
        "stop"=>stop(&mut session),
        _=>{
            let Some((capture,threshold))=session.as_mut()else{return success(json!({"active":false,"speaking":false,"level":0}));};
            let result=capture.request(&json!({"type":"desktop_audio","sub":"input","op":"level"}),Duration::from_secs(2));
            let result=match result{Ok(r)if r["success"]==true=>status(&r["data"],*threshold).map(success),Ok(error)=>Err(error),Err(error)=>Err(error)};
            match result{Ok(result)=>result,Err(error)=>{session.take();error}}
        }
    }
}
fn stop(session:&mut Option<(crate::audio::AudioSession,f64)>)->Value{
    if let Some((capture,_))=session.take(){let result=capture.stop("input");if result["success"]!=true{return result;}}
    success(json!({"active":false}))
}
pub fn shutdown()->Value{dispatch(&json!({"type":"desktop_vad","sub":"stop"}))}
pub(crate) fn poll_exits(){if let Ok(mut session)=SESSION.try_lock(){if let Some((capture,_))=session.as_mut(){capture.poll_exit();}}}
pub fn capability(session:&str)->Value{json!({"operation":"vad","compiled":cfg!(any(windows,target_os="linux")),"present":cfg!(any(windows,target_os="linux")),"effective":false,"background":"semantic","permission":"unknown","session":session,"provider":"native PCM RMS gate","versions":{"contract":"1"},"limits":["Matches Mac baseline energy threshold semantics; this is not a trained speech classifier.","One independently owned native microphone capture; default RMS threshold 0.02, explicit calibrated start threshold 0..1; no queued lifecycle work.","Actual hardware availability, capture permission and installed behavior require native qualification."]})}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn actual_pcm_status_and_threshold_boundaries(){
        assert_eq!(status(&json!({"active":true,"frames":0,"level":null}),0.02).unwrap(),json!({"active":true,"speaking":false,"level":0.0}));
        assert_eq!(status(&json!({"active":true,"frames":4,"level":0.02}),0.02).unwrap()["speaking"],false);
        assert_eq!(status(&json!({"active":true,"frames":4,"level":0.03}),0.02).unwrap()["speaking"],true);
        for row in [json!({"active":false,"frames":0,"level":null}),json!({"active":true,"frames":4,"level":-1}),json!({"active":true,"frames":4,"level":null})]{assert!(status(&row,0.02).is_err());}
        for action in [json!({"type":"desktop_vad","sub":"start","threshold":-1}),json!({"type":"desktop_vad","sub":"status","threshold":0.02}),json!({"type":"desktop_vad","sub":"start","unknown":1})]{assert_eq!(dispatch(&action)["code"],"invalid_request");}
        assert!(serde_json::from_value::<DesktopCapability>(capability("fixture")).is_ok());
    }
}
