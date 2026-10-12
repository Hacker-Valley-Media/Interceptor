//! Local sound classification over actual owned native microphone PCM, with the bundled
//! CED-tiny model run inside the provider (audio_models.rs).
use crate::{contract_generated::*,failure,success,native_library::pinned_bytes};
use serde_json::{json,Value};
use std::{io,sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::{Duration,Instant,SystemTime,UNIX_EPOCH}};
type Result<T>=std::result::Result<T,Value>;
/// Two seconds at 16 kHz: long enough for the model to tell sounds apart, short enough to feel live.
const SAMPLES:usize=32000;
#[derive(Default)]struct State{capture:Option<crate::audio::AudioSession>,history:Vec<Value>,error:Option<Value>}
static STATE:Mutex<State>=Mutex::new(State{capture:None,history:Vec::new(),error:None});
fn validate(a:&Value)->Result<()>{
    if let Some(error)=desktop_sound_shape_error(a){return Err(failure("invalid_request",error));}
    if a.get("filter").is_some()&&a["sub"]!="log"{return Err(failure("invalid_request","sound filter requires log"));}
    for key in ["filter","group","groupColor"]{if a.get(key).is_some_and(|v|v.as_str().is_none_or(|s|s.trim().is_empty()||s.contains('\0')||s.len()>if key=="filter"{4096}else{256})){return Err(failure("invalid_request","invalid bounded sound filter/group"));}}
    Ok(())
}
fn view(a:&Value,active:bool,history:&[Value])->Value{match a["sub"].as_str().unwrap(){
    "status"=>json!({"classifying":active,"latest":history.last()}),
    "tail"=>json!({"classifying":active,"classifications":history}),
    "stop"=>json!({"classifying":false,"totalClassifications":history.len()}),
    _=>json!(history.iter().filter(|r|a["filter"].as_str().is_none_or(|f|r["label"].as_str().is_some_and(|s|s.contains(f)))).collect::<Vec<_>>())
}}
pub fn dispatch(a:&Value)->Value{
    if let Err(e)=validate(a){return e;}let Ok(mut state)=STATE.try_lock()else{return failure("invalid_request","sound lifecycle busy; no work was queued");};
    if a["sub"]=="start"{
        if state.capture.is_some(){return failure("invalid_request","sound classification is already active");}
        return match crate::audio::AudioSession::start_owned(a,"--sound-engine"){Ok((capture,reply))=>{state.capture=Some(capture);state.history.clear();state.error=None;reply},Err(e)=>e};
    }
    if let Some(capture)=state.capture.as_mut(){
        let mut reply=if a["sub"]=="stop"{state.capture.take().unwrap().stop_with(a)}else{match capture.request(a,Duration::from_secs(2)){Ok(v)=>v,Err(e)=>e}};
        if let Some(rows)=reply["_history"].as_array(){state.history=rows.clone();}
        if let Some(object)=reply.as_object_mut(){object.remove("_history");}
        if reply["success"]!=true{state.capture.take();state.error=Some(reply.clone());return reply;}
        if a["sub"]=="tail"{state.history=match serde_json::from_value(reply["data"]["classifications"].clone()){Ok(v)=>v,Err(_)=>{state.capture.take();return failure("provider_failed","sound helper history is malformed");}};}
        return reply;
    }
    if let Some(error)=&state.error{if a["sub"]=="status"||a["sub"]=="stop"{return error.clone();}}
    success(view(a,false,&state.history))
}
pub(crate) fn shutdown()->Value{dispatch(&json!({"type":"desktop_sounds","sub":"stop"}))}
pub(crate) fn poll_exits(){if let Ok(mut state)=STATE.try_lock(){if let Some(capture)=state.capture.as_mut(){capture.poll_exit();}}}

struct Classifier(crate::audio_models::SoundClassifier);
impl Classifier{
    fn load()->Result<Self>{
        let(_,model)=pinned_bytes("INTERCEPTOR_SOUND_MODEL",32*1024*1024)?;let(_,labels)=pinned_bytes("INTERCEPTOR_SOUND_LABELS",1024*1024)?;
        Ok(Self(crate::audio_models::SoundClassifier::new(&model,&labels,SAMPLES)?))
    }
    fn classify(&mut self,samples:&[f32],channels:u16,rate:u32)->Result<Vec<Value>>{
        if channels==0||channels>64||rate==0||rate>1_000_000||samples.is_empty()||samples.len()>2_097_152||samples.len()%usize::from(channels)!=0||samples.iter().any(|n|!n.is_finite()){return Err(failure("provider_failed","sound model received invalid bounded native PCM"));}
        let mono=samples.chunks_exact(usize::from(channels)).map(|frame|frame.iter().map(|n|f64::from(*n)).sum::<f64>()/f64::from(channels)).map(|n|n.clamp(-1.0,1.0)as f32).collect::<Vec<_>>();
        let mut waveform=crate::audio_models::resample(&mono,rate);waveform.truncate(SAMPLES);for n in &mut waveform{*n=n.clamp(-1.0,1.0);}
        let scores=self.0.scores(&waveform)?;
        top_results(self.0.labels(),&scores,SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_|failure("provider_failed","sound timestamp precedes the Unix epoch"))?.as_secs_f64())
    }
}
fn top_results(labels:&[String],scores:&[f32],timestamp:f64)->Result<Vec<Value>>{
    if labels.is_empty()||scores.len()!=labels.len()||scores.iter().any(|n|!n.is_finite()||!(0.0..=1.0).contains(n))||!timestamp.is_finite()||timestamp<0.0{return Err(failure("provider_failed","native sound classifier returned invalid probabilities/timestamp"));}
    let mut ranked=scores.iter().enumerate().filter(|(_,p)|**p>0.3).collect::<Vec<_>>();ranked.sort_by(|a,b|b.1.total_cmp(a.1));
    Ok(ranked.into_iter().take(5).map(|(i,p)|json!({"label":labels[i],"confidence":p,"timestamp":timestamp})).collect())
}

#[derive(Default)]struct Snapshot{classifying:bool,history:Vec<Value>,error:Option<String>,finished:bool}
#[cfg(any(windows,target_os="linux"))]
pub(crate) fn helper(parent:u32)->io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    #[cfg(unix)]unsafe{libc::umask(0o077);let limit=libc::rlimit{rlim_cur:512*1024*1024,rlim_max:512*1024*1024};if libc::setrlimit(libc::RLIMIT_AS,&limit)!=0{return Err(io::Error::other("sound helper memory limit failed"));}}
    let bytes=crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("sound helper requires initialization"))?;let action:Value=serde_json::from_slice(&bytes)?;
    let reply=|result:&Value|crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(result)?);
    let initialized=(||->Result<_>{
        validate(&action)?;if action["sub"]!="start"{return Err(failure("invalid_request","sound helper requires start"));}
        let pcm=Arc::new(Mutex::new(crate::audio::PcmState::default()));let snapshot=Arc::new(Mutex::new(Snapshot::default()));let stopped=Arc::new(AtomicBool::new(false));
        let(windows,ready)=std::sync::mpsc::sync_channel::<Vec<f32>>(2);let(model_ready,model_initialized)=std::sync::mpsc::sync_channel::<Result<()>>(1);
        let worker=snapshot.clone();let cancelled=stopped.clone();let format=pcm.clone();
        std::thread::spawn(move||{
            let mut classifier=match Classifier::load(){Ok(v)=>{if model_ready.send(Ok(())).is_err(){return;}v},Err(e)=>{let _=model_ready.send(Err(e));return;}};
            while let Ok(samples)=ready.recv(){
                if cancelled.load(Ordering::Acquire){return;}let(channels,rate)={let p=format.lock().unwrap();(p.channels,p.rate)};
                let result=classifier.classify(&samples,channels,rate);let mut state=worker.lock().unwrap();if cancelled.load(Ordering::Acquire){return;}
                match result{Ok(rows)=>{state.history.extend(rows);let excess=state.history.len().saturating_sub(DESKTOP_SOUND_MAX_HISTORY);state.history.drain(..excess);},Err(e)=>{state.error=Some(format!("native sound classification failed: {}",e["error"]));state.classifying=false;state.finished=true;return;}}
            }
            worker.lock().unwrap().finished=true;
        });
        model_initialized.recv_timeout(Duration::from_secs(9)).map_err(|_|failure("resource_limit","sound CPU model initialization exceeded its deadline"))??;
        let(sender,receiver)=std::sync::mpsc::sync_channel(256);
        let mut engine=crate::audio::Engine::open(&json!({"type":"desktop_audio","sub":"input","op":"start"}),&pcm,Some(sender))?;
        let(channels,rate)={let p=pcm.lock().unwrap();(p.channels,p.rate)};
        let count=(u64::from(rate)*SAMPLES as u64).div_ceil(16000)*u64::from(channels);
        let count=usize::try_from(count).ok().filter(|n|*n>0&&*n<=2_097_152).ok_or_else(||failure("unsupported_target","native sound format exceeds a bounded model window"))?;
        // ponytail: nonoverlapping two-second windows; add overlap if events are missed between windows.
        let collector=snapshot.clone();let cancelled=stopped.clone();std::thread::spawn(move||{if let Err(error)=crate::audio::pcm_windows(receiver,windows,count,&cancelled){let mut s=collector.lock().unwrap();s.error=Some(error);s.classifying=false;}});
        pcm.lock().unwrap().active=true;engine.play()?;snapshot.lock().unwrap().classifying=true;Ok((engine,pcm,snapshot,stopped))
    })();
    let(engine,pcm,snapshot,stopped)=match initialized{Ok(v)=>v,Err(e)=>return reply(&e)};
    reply(&success(json!({"classifying":true})))?;
    let(sender,receiver)=std::sync::mpsc::sync_channel(2);std::thread::spawn(move||{let mut input=io::stdin().lock();loop{let value=crate::read_frame(&mut input);let end=!matches!(&value,Ok(Some(_)));if sender.send(value).is_err()||end{break;}}});
    let mut engine=Some(engine);
    loop{
        if let Some(error)=pcm.lock().unwrap().error.clone(){let mut s=snapshot.lock().unwrap();s.error=Some(error);s.classifying=false;}
        let inference_error=snapshot.lock().unwrap().error.clone();
        if let Some(error)=inference_error{
            stopped.store(true,Ordering::Release);pcm.lock().unwrap().active=false;drop(engine.take());
            let mut result=failure("provider_failed",error);result["_history"]=json!(snapshot.lock().unwrap().history);reply(&result)?;return Ok(());
        }
        match receiver.recv_timeout(Duration::from_millis(50)){
            Ok(Ok(Some(bytes)))=>{
                let a:Value=serde_json::from_slice(&bytes)?;if let Err(e)=validate(&a){reply(&e)?;continue;}if a["sub"]=="start"{reply(&failure("invalid_request","sound helper is already active"))?;continue;}
                let stop=a["sub"]=="stop";
                if stop{
                    pcm.lock().unwrap().active=false;if let Some(engine)=engine.take(){if let Err(e)=engine.stop(){stopped.store(true,Ordering::Release);reply(&e)?;return Ok(());}}
                    let deadline=Instant::now()+Duration::from_secs(10);
                    loop{let done={let s=snapshot.lock().unwrap();s.finished||s.error.is_some()};if done{break;}if Instant::now()>=deadline{snapshot.lock().unwrap().error=Some("sound final inference exceeded its stop deadline".into());break;}std::thread::sleep(Duration::from_millis(10));}
                    stopped.store(true,Ordering::Release);snapshot.lock().unwrap().classifying=false;
                }
                let s=snapshot.lock().unwrap();let mut result=match &s.error{Some(e)=>failure("partial_result",e),None=>success(view(&a,s.classifying,&s.history))};
                if stop||s.error.is_some(){result["_history"]=json!(s.history);}reply(&result)?;if stop{return Ok(());}
            },Ok(Err(e))=>return Err(e),Ok(Ok(None))|Err(std::sync::mpsc::RecvTimeoutError::Disconnected)=>{stopped.store(true,Ordering::Release);pcm.lock().unwrap().active=false;drop(engine.take());return Ok(());},Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>()
        }
    }
}
#[cfg(not(any(windows,target_os="linux")))]pub(crate) fn helper(_:u32)->io::Result<()>{Err(io::Error::other("portable sounds requires Windows or Linux"))}
pub fn capability(session:&str)->Value{json!({"operation":"sounds","compiled":cfg!(any(windows,target_os="linux")),"present":cfg!(any(windows,target_os="linux")),"effective":false,"permission":"unknown","session":session,"background":"semantic","provider":"native microphone / bundled CED-tiny sound classifier on tract","versions":{"contract":"1","tract":"0.23.8","model":"ced-tiny 2024-04-19"},"limits":["Actual native microphone PCM, mixed to mono and resampled to 16 kHz in the provider; 527 AudioSet classes","The model runs inside the provider; no vendor library is loaded and nothing leaves the machine","Two-second windows, two bounded inference windows, 512MiB owned helper, 500 actual history records, top 5 confidence>0.3; a final short window is zero-padded","Discovery does not probe the microphone or establish permission"]})}
#[cfg(test)]mod tests{use super::*;
    #[test]fn actual_scores_are_bounded_ranked_and_filtered(){
        let labels=(0..527).map(|i|format!("native class{i}")).collect::<Vec<_>>();let mut scores=vec![0.0;527];scores[7]=0.9;scores[2]=0.8;scores[1]=0.3;
        let rows=top_results(&labels,&scores,123.0).unwrap();assert_eq!(rows.len(),2);assert_eq!(rows[0]["label"],labels[7]);assert_eq!(rows[1]["label"],labels[2]);assert_eq!(rows[0]["timestamp"],123.0);
        assert_eq!(view(&json!({"sub":"log","filter":"class7"}),false,&rows).as_array().unwrap().len(),1);
        assert!(top_results(&labels[..3],&scores,123.0).is_err());
        scores[0]=f32::NAN;assert!(top_results(&labels,&scores,123.0).is_err());
        for a in [json!({"type":"desktop_sounds","sub":"status","filter":"x"}),json!({"type":"desktop_sounds","sub":"start","unexpected":true}),json!({"type":"desktop_sounds","sub":"log","filter":"\0"})]{assert!(validate(&a).is_err());}
        assert!(serde_json::from_value::<DesktopCapability>(capability("fixture")).is_ok());
    }
}
