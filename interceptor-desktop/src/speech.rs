//! Owned local whisper.cpp CPU recognition over actual native microphone PCM.
use crate::{contract_generated::*,failure,success};
use serde_json::{json,Value};
use std::{fs,io::{self,Read},path::PathBuf,sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};

struct Capture{media:Option<crate::audio::AudioSession>,scratch:PathBuf}
impl Drop for Capture{fn drop(&mut self){drop(self.media.take());let _=fs::remove_dir_all(&self.scratch);}}
struct State{capture:Option<Capture>,transcript:String,vocabulary:Vec<String>}
static STATE:Mutex<State>=Mutex::new(State{capture:None,transcript:String::new(),vocabulary:Vec::new()});
const MAX_PCM:usize=1_048_576;
fn bounded(s:&str,limit:usize)->bool{!s.trim().is_empty()&&!s.contains('\0')&&s.len()<=limit}
fn validate(a:&Value)->Result<(),Value>{
    if let Some(error)=desktop_speech_shape_error(a){return Err(failure("invalid_request",error));}
    if a.get("device").is_some()&&(a["sub"]!="start"||!a["device"].as_str().is_some_and(|s|bounded(s,4096))){return Err(failure("invalid_request","speech device requires start and a bounded exact native identity"));}
    if a["sub"]!="vocab"&&(a.get("op").is_some()||a.get("word").is_some()){return Err(failure("invalid_request","vocabulary fields require vocab"));}
    if a["sub"]=="vocab"{let add=a["op"]=="add";if add&&!a["word"].as_str().is_some_and(|s|bounded(s,4096))||!add&&a.get("word").is_some(){return Err(failure("invalid_request","vocab add requires one bounded word; list/clear accept none"));}}
    for key in ["group","groupColor"]{if a.get(key).is_some_and(|v|v.as_str().is_none_or(|s|!bounded(s,256))){return Err(failure("invalid_request","invalid speech group text"));}}
    Ok(())
}
pub fn dispatch(a:&Value)->Value{
    if let Err(e)=validate(a){return e;}
    let deadline=Instant::now()+Duration::from_secs(3);
    let mut state=loop{match STATE.try_lock(){Ok(state)=>break state,Err(_)if Instant::now()<deadline=>std::thread::sleep(Duration::from_millis(20)),Err(_)=>return failure("resource_limit","speech lifecycle busy; no work queued")}};
    if a["sub"]=="vocab"{return match a["op"].as_str().unwrap_or("list"){
        "list"=>success(json!(state.vocabulary)),"clear"=>{state.vocabulary.clear();success(json!("vocabulary cleared"))},
        _=>{let word=a["word"].as_str().unwrap();if state.vocabulary.len()>=DESKTOP_SPEECH_MAX_VOCABULARY_WORDS||state.vocabulary.iter().map(String::len).sum::<usize>()+word.len()>32768{return failure("resource_limit","speech vocabulary exceeds 100 entries or 32KiB");}state.vocabulary.push(word.into());success(json!({"added":word,"total":state.vocabulary.len()}))}
    };}
    if a["sub"]=="start"{
        if state.capture.is_some(){return failure("invalid_request","speech capture already active; stop it before restarting");}
        let scratch=match crate::filesystem::temp_dir(){Ok(root)=>root.join(format!("interceptor-speech-{}",crate::monitor::identifier())),Err(e)=>return failure("provider_failed",e)};
        if let Err(e)=crate::monitor::private_directory(&scratch,true,false){return failure("provider_failed",e);}
        let mut capture=Capture{media:None,scratch};
        let initial=json!({"action":a,"vocabulary":state.vocabulary,"scratch":capture.scratch});
        match crate::audio::AudioSession::start_owned(&initial,"--speech-engine"){
            Ok((media,result))=>{capture.media=Some(media);state.capture=Some(capture);state.transcript.clear();return result;},Err(e)=>return e,
        }
    }
    if a["sub"]=="stop"{
        let Some(mut capture)=state.capture.take()else{return success(json!({"listening":false,"transcript":state.transcript}));};
        let result=capture.media.take().unwrap().stop_with(&json!({"type":"desktop_listen","sub":"stop"}));
        if let Some(text)=result["data"]["transcript"].as_str().filter(|s|s.len()<=DESKTOP_SPEECH_MAX_TRANSCRIPT_BYTES&&!s.contains('\0')){state.transcript=text.into();}
        return result;
    }
    if let Some(capture)=state.capture.as_mut(){
        if let Some(terminal)=capture.media.as_ref().unwrap().terminal.clone(){
            if let Some(text)=terminal["data"]["transcript"].as_str().filter(|s|s.len()<=DESKTOP_SPEECH_MAX_TRANSCRIPT_BYTES&&!s.contains('\0')){state.transcript=text.into();}
            return match a["sub"].as_str().unwrap(){"transcript"=>success(json!(state.transcript)),"tail"=>success(json!({"listening":false,"transcript":state.transcript})),_=>terminal};
        }
        let result=match capture.media.as_mut().unwrap().request(&json!({"type":"desktop_listen","sub":a["sub"]}),Duration::from_secs(2)){Ok(r)=>r,Err(e)=>{state.capture.take();return e;}};
        if result["success"]!=true{capture.media.as_mut().unwrap().terminal=Some(result.clone());}
        let transcript=if a["sub"]=="transcript"{result["data"].as_str()}else{result["data"]["transcript"].as_str()};
        if let Some(text)=transcript.filter(|s|s.len()<=DESKTOP_SPEECH_MAX_TRANSCRIPT_BYTES&&!s.contains('\0')){state.transcript=text.into();}
        return result;
    }
    match a["sub"].as_str().unwrap(){"transcript"=>success(json!(state.transcript)),"tail"=>success(json!({"listening":false,"transcript":state.transcript})),_=>success(json!({"listening":false}))}
}
pub(crate) fn poll_exits(){
    if let Ok(mut state)=STATE.try_lock(){if let Some(capture)=state.capture.as_mut(){
        let media=capture.media.as_mut().unwrap();media.poll_exit();
        if media.terminal.is_none(){match media.request(&json!({"type":"desktop_listen","sub":"status"}),Duration::from_secs(2)){Ok(result)if result["success"]!=true=>media.retire(result),Err(e)=>media.retire(e),_=>()}}
        if let Some(text)=media.terminal.as_ref().and_then(|r|r["data"]["transcript"].as_str()).filter(|s|s.len()<=DESKTOP_SPEECH_MAX_TRANSCRIPT_BYTES&&!s.contains('\0')){state.transcript=text.into();}
    }}
}
pub(crate) fn shutdown()->Value{dispatch(&json!({"type":"desktop_listen","sub":"stop"}))}

fn transcription(bytes:&[u8])->Result<String,Value>{
    if bytes.len()>1_048_576{return Err(failure("resource_limit","speech engine JSON exceeds 1MiB"));}
    let result:Value=serde_json::from_slice(bytes).map_err(|_|failure("provider_failed","speech engine returned malformed JSON"))?;
    let rows=result["transcription"].as_array().filter(|r|r.len()<=1024).ok_or_else(||failure("provider_failed","speech engine omitted bounded transcription segments"))?;
    let mut text=String::new();for row in rows{let value=row["text"].as_str().filter(|s|!s.contains('\0')&&s.len()<=DESKTOP_SPEECH_MAX_TRANSCRIPT_BYTES).ok_or_else(||failure("provider_failed","invalid speech segment text"))?;
        // whisper marks a window without speech with a tag such as [BLANK_AUDIO] or (silence); that is not something said.
        let tag=value.trim();if tag.len()>=2&&(tag.starts_with('[')&&tag.ends_with(']')||tag.starts_with('(')&&tag.ends_with(')'))&&!tag[1..tag.len()-1].contains(['[',']','(',')']){continue;}
        if text.len()+value.len()>DESKTOP_SPEECH_MAX_TRANSCRIPT_BYTES{return Err(failure("resource_limit","speech transcription exceeds 64KiB"));}text.push_str(value);}Ok(text)
}
#[derive(Default)]struct Snapshot{listening:bool,transcript:String,error:Option<String>,finished:bool}
fn window_pcm(receiver:std::sync::mpsc::Receiver<Vec<f32>>,windows:std::sync::mpsc::SyncSender<Vec<f32>>,count:usize,state:&Mutex<Snapshot>,cancelled:&AtomicBool){
    if let Err(error)=crate::audio::pcm_windows(receiver,windows,count,cancelled){let mut s=state.lock().unwrap();s.error=Some(error);s.listening=false;}
}
#[cfg(any(windows,target_os="linux"))]
fn recognize(binary:&std::path::Path,model:&std::path::Path,root:&std::path::Path,pcm:&[f32],channels:u16,rate:u32,vocabulary:&[String])->Result<String,Value>{
    let wav=root.join(format!("{}.wav",crate::monitor::identifier()));let output=wav.with_extension("result");
    let mut file=crate::audio::WaveFile::create_at(&wav,channels,rate).map_err(|e|failure("provider_failed",e))?;file.append(pcm).and_then(|_|file.finish()).map_err(|e|failure("provider_failed",e))?;
    let args=vec!["--model".into(),model.to_string_lossy().into_owned(),"--file".into(),wav.to_string_lossy().into_owned(),"--output-json".into(),"--output-file".into(),output.to_string_lossy().into_owned(),"--no-prints".into(),"--no-gpu".into(),"--language".into(),"auto".into(),"--threads".into(),std::thread::available_parallelism().map(|n|n.get().min(4)).unwrap_or(1).to_string(),"--prompt".into(),vocabulary.join(", ")];
    let result=(||{let (status,_,_)=crate::container::capture(binary,&args,Instant::now()+Duration::from_secs(120),1_048_576)?;if !status.success(){return Err(failure("provider_failed","local speech engine failed; diagnostic output withheld"));}
        let json=output.with_extension("result.json");let mut file=crate::monitor::private_file(&json,false).map_err(|e|failure("provider_failed",e))?;let mut bytes=Vec::new();file.by_ref().take(1_048_577).read_to_end(&mut bytes).map_err(|e|failure("provider_failed",e))?;transcription(&bytes)})();
    let _=fs::remove_file(&wav);let _=fs::remove_file(output.with_extension("result.json"));result
}
#[cfg(windows)]fn os_recognize(root:&std::path::Path,pcm:&[f32],channels:u16,rate:u32)->Result<String,Value>{crate::speech_windows::recognize(root,pcm,channels,rate)}
#[cfg(target_os="linux")]fn os_recognize(_:&std::path::Path,_:&[f32],_:u16,_:u32)->Result<String,Value>{Err(failure("not_installed","Linux has no OS speech recognizer; configure the whisper.cpp engine (INTERCEPTOR_WHISPER_CLI)"))}
#[cfg(any(windows,target_os="linux"))]
pub(crate) fn helper(parent:u32)->io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    // whisper-cli inherits this limit. It needs about 1 GiB of address space with the tiny model
    // (measured: aborts at 768 MiB, runs at 1024 MiB), so the speech helper gets 2 GiB.
    #[cfg(unix)]unsafe{libc::umask(0o077);let limit=libc::rlimit{rlim_cur:2048*1024*1024,rlim_max:2048*1024*1024};if libc::setrlimit(libc::RLIMIT_AS,&limit)!=0{return Err(io::Error::other("speech helper memory limit failed"));}}
    let bytes=crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("speech helper requires initialization"))?;let initial:Value=serde_json::from_slice(&bytes)?;
    let reply=|result:&Value|crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(result)?);
    let initialized=(||->Result<_,Value>{
        if initial.as_object().is_none_or(|o|o.len()!=3)||initial["action"]["sub"]!="start"{return Err(failure("invalid_request","speech helper requires one initialization envelope"));}validate(&initial["action"])?;
        let vocabulary:Vec<String>=serde_json::from_value(initial["vocabulary"].clone()).map_err(|_|failure("invalid_request","invalid initial vocabulary"))?;
        if vocabulary.len()>DESKTOP_SPEECH_MAX_VOCABULARY_WORDS||vocabulary.iter().any(|s|!bounded(s,4096))||vocabulary.iter().map(String::len).sum::<usize>()>32768{return Err(failure("invalid_request","speech vocabulary exceeds its bounds"));}
        let root=crate::filesystem::absolute(initial["scratch"].as_str().unwrap_or(""))?;crate::monitor::private_directory(&root,false,false).map_err(|e|failure("permission_denied",e))?;
        // Windows without a configured whisper.cpp uses the OS recognizer (crate::speech_windows).
        let whisper=if cfg!(windows)&&std::env::var_os("INTERCEPTOR_WHISPER_CLI").is_none(){
            #[cfg(windows)]crate::speech_windows::installed().map_err(|e|failure("not_installed",e))?;None
        }else{
            let binary=crate::native_library::pinned_file("INTERCEPTOR_WHISPER_CLI",128*1024*1024)?;let model=crate::native_library::pinned_file("INTERCEPTOR_WHISPER_MODEL",1024*1024*1024)?;
            let (version,bytes,_)=crate::container::capture(&binary,&["--version".into()],Instant::now()+Duration::from_secs(2),4096)?;
            if !version.success()||String::from_utf8_lossy(&bytes).trim()!="whisper.cpp version: 1.9.5"{return Err(failure("version_mismatch","speech backend requires whisper.cpp 1.9.5"));}
            Some((binary,model))
        };
        let pcm=Arc::new(Mutex::new(crate::audio::PcmState::default()));let (sender,receiver)=std::sync::mpsc::sync_channel(256);
        let mut action=json!({"type":"desktop_audio","sub":"input","op":"start"});if let Some(device)=initial["action"].get("device"){action["device"]=device.clone();}
        let mut engine=crate::audio::Engine::open(&action,&pcm,Some(sender))?;
        let (channels,rate)={let state=pcm.lock().unwrap();(state.channels,state.rate)};
        // ponytail: fixed five-second windows match the bounded snapshot API; replace with
        // streaming inference if per-token callbacks are required. Five, not three: on the
        // same recording the tiny model got every word with five-second windows and broke
        // sentences apart with three.
        let count=usize::try_from(u64::from(channels)*u64::from(rate)*5).ok().filter(|n|*n>0&&*n<=MAX_PCM).ok_or_else(||failure("unsupported_target","native speech format exceeds a bounded five-second PCM window"))?;
        let snapshot=Arc::new(Mutex::new(Snapshot{listening:true,..Default::default()}));let stopped=Arc::new(AtomicBool::new(false));
        let (windows,windows_ready)=std::sync::mpsc::sync_channel(2);
        let collector=snapshot.clone();let cancelled=stopped.clone();std::thread::spawn(move||window_pcm(receiver,windows,count,&collector,&cancelled));
        let worker=snapshot.clone();let cancelled=stopped.clone();std::thread::spawn(move||{
            while let Ok(samples)=windows_ready.recv(){if cancelled.load(Ordering::Acquire){break;}let result=match &whisper{Some((binary,model))=>recognize(binary,model,&root,&samples,channels,rate,&vocabulary),None=>os_recognize(&root,&samples,channels,rate)};
                let mut state=worker.lock().unwrap();if cancelled.load(Ordering::Acquire){return;}match result{Ok(text)if state.transcript.len()+text.len()<=DESKTOP_SPEECH_MAX_TRANSCRIPT_BYTES=>state.transcript.push_str(&text),Ok(_)=>{state.error=Some("speech transcript exceeds 64KiB; capture retired".into());state.listening=false;return;},Err(e)=>{state.error=Some(format!("local speech inference failed: {}",e["error"]));state.listening=false;return;}}
            }
            worker.lock().unwrap().finished=true;
        });
        pcm.lock().unwrap().active=true;if let Err(e)=engine.play(){stopped.store(true,Ordering::Release);pcm.lock().unwrap().active=false;return Err(e);}Ok((engine,pcm,snapshot,stopped))
    })();
    let (engine,pcm,snapshot,stopped)=match initialized{Ok(v)=>v,Err(e)=>return reply(&e)};
    reply(&success(json!({"listening":true})))?;
    let (sender,receiver)=std::sync::mpsc::sync_channel(2);std::thread::spawn(move||{let mut input=io::stdin().lock();loop{let r=crate::read_frame(&mut input);let end=!matches!(&r,Ok(Some(_)));if sender.send(r).is_err()||end{break;}}});
    let mut engine=Some(engine);
    loop{
        if let Some(error)=pcm.lock().unwrap().error.clone(){let mut state=snapshot.lock().unwrap();state.error=Some(error);state.listening=false;}
        if snapshot.lock().unwrap().error.is_some(){
            stopped.store(true,Ordering::Release);pcm.lock().unwrap().active=false;
            let result={let state=snapshot.lock().unwrap();let mut result=failure("provider_failed",state.error.as_deref().unwrap());result["data"]=json!({"listening":false,"transcript":state.transcript});result};
            reply(&result)?;drop(engine.take());return Ok(());
        }
        match receiver.recv_timeout(Duration::from_millis(50)){
            Ok(Ok(Some(bytes)))=>{let action:Value=serde_json::from_slice(&bytes)?;
                if action.as_object().is_none_or(|o|o.len()!=2)||action["type"]!="desktop_listen"||!matches!(action["sub"].as_str(),Some("status"|"transcript"|"tail"|"stop")){reply(&failure("invalid_request","speech helper control requires one exact read/stop operation"))?;continue;}
                let stop=action["sub"]=="stop";if stop{
                    pcm.lock().unwrap().active=false;
                    if let Some(engine)=engine.take(){if let Err(e)=engine.stop(){stopped.store(true,Ordering::Release);reply(&e)?;return Ok(());}}
                    let deadline=Instant::now()+Duration::from_secs(10);
                    loop{
                        {let state=snapshot.lock().unwrap();if state.finished||state.error.is_some(){break;}}
                        if Instant::now()>=deadline{snapshot.lock().unwrap().error=Some("speech stop exceeded its final-inference deadline; only the returned transcript is complete".into());break;}
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    stopped.store(true,Ordering::Release);
                    let mut state=snapshot.lock().unwrap();state.listening=false;
                    if let Some(error)=&state.error{let mut result=failure("partial_result",error);result["data"]=json!({"listening":false,"transcript":state.transcript});reply(&result)?;return Ok(());}
                }
                let state=snapshot.lock().unwrap();let result=match action["sub"].as_str().unwrap(){"transcript"=>success(json!(state.transcript)),"tail"|"stop"=>success(json!({"listening":state.listening,"transcript":state.transcript})),_=>match &state.error{Some(error)=>failure("provider_failed",error),None=>success(json!({"listening":state.listening}))}};reply(&result)?;if stop{return Ok(());}
            },Ok(Err(e))=>return Err(e),Ok(Ok(None))|Err(std::sync::mpsc::RecvTimeoutError::Disconnected)=>{stopped.store(true,Ordering::Release);pcm.lock().unwrap().active=false;drop(engine.take());return Ok(());},Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>(),
        }
    }
}
#[cfg(not(any(windows,target_os="linux")))]pub(crate) fn helper(_:u32)->io::Result<()>{Err(io::Error::other("portable speech requires Windows or Linux"))}
pub fn capability(session:&str)->Value{json!({"operation":"listen","compiled":cfg!(any(windows,target_os="linux")),"present":cfg!(any(windows,target_os="linux")),"effective":false,"background":"semantic","permission":"unknown","session":session,"provider":if cfg!(windows){"whisper.cpp CPU when configured, else the Windows SAPI in-process recognizer / native microphone PCM"}else{"whisper.cpp CPU / native microphone PCM"},"versions":{"contract":"1","whisper.cpp":"1.9.5"},"limits":["Actual native microphone capture; the pinned CPU engine and model come from the engine bundle. Discovery does not probe hardware or establish permission","Five-second windows, bounded native PCM queue, 64KiB transcript, 100 vocabulary entries/32KiB; slow inference retires capture instead of silently dropping audio","Vocabulary is an initial model prompt, applied on the next start. Snapshots are completed window hypotheses, not per-token live speech callbacks","Owned process-group/Windows job, retained provider/login lifetime and bounded native startup/control"],"reason":if cfg!(windows){"Uses the speech recognizer Windows ships (offline dictation in its language) unless a pinned whisper.cpp engine is configured."}else{"Uses the bundled whisper.cpp 1.9.5 engine and multilingual tiny model; an engine you configure takes precedence."}})}

#[cfg(test)]mod tests{use super::*;
    #[test]fn strict_speech_bounds_and_real_engine_json(){
        assert!(validate(&json!({"type":"desktop_listen","sub":"vocab","op":"add","word":"café"})).is_ok());
        for a in [json!({"type":"desktop_listen","sub":"status","device":"x"}),json!({"type":"desktop_listen","sub":"start","word":"x"}),json!({"type":"desktop_listen","sub":"vocab","op":"clear","word":"x"}),json!({"type":"desktop_listen","sub":"vocab","op":"add","word":"\0"})]{assert!(validate(&a).is_err());}
        assert_eq!(transcription(br#"{"transcription":[{"text":" hello"},{"text":" world"}]}"#).unwrap()," hello world");
        assert_eq!(transcription(br#"{"transcription":[{"text":" for your country."},{"text":" [BLANK_AUDIO]"},{"text":" (silence)"},{"text":" [a] and [b]"}]}"#).unwrap()," for your country. [a] and [b]");assert!(transcription(br#"{"transcription":[{"text":1}]}"#).is_err());assert!(transcription(br#"{"transcription":[{"text":"\0"}]}"#).is_err());assert!(transcription(br#"{"transcription":[{"text":"x"}],"model":{}}"#).is_ok());assert!(serde_json::from_value::<DesktopCapability>(capability("fixture")).is_ok());
        let (sender,receiver)=std::sync::mpsc::channel();let (windows,ready)=std::sync::mpsc::sync_channel(2);
        sender.send(vec![0.25,0.5,-0.5]).unwrap();sender.send(vec![0.0,0.75]).unwrap();drop(sender);
        let snapshot=Mutex::new(Snapshot::default());window_pcm(receiver,windows,4,&snapshot,&AtomicBool::new(false));
        assert_eq!(ready.recv().unwrap(),vec![0.25,0.5,-0.5,0.0]);assert_eq!(ready.recv().unwrap(),vec![0.75]);assert!(ready.recv().is_err());assert!(snapshot.lock().unwrap().error.is_none());
        let (sender,receiver)=std::sync::mpsc::channel();let (windows,_ready)=std::sync::mpsc::sync_channel(1);
        sender.send(vec![0.0;8]).unwrap();drop(sender);window_pcm(receiver,windows,4,&snapshot,&AtomicBool::new(false));assert!(snapshot.lock().unwrap().error.is_some());
    }
}
