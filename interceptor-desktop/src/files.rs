use crate::{contract_generated::*,failure,success};
use serde_json::{Value,json};
use std::{collections::{BTreeMap,VecDeque},fs::File,io::{self,Write,Seek,SeekFrom},path::{Path,PathBuf},process::{Command,Stdio},sync::{Mutex,OnceLock},time::{Duration,Instant}};
#[cfg(windows)]#[path="files_windows.rs"]pub(crate) mod native;
#[cfg(target_os="linux")]#[path="files_linux.rs"]pub(crate) mod native;
#[cfg(not(any(windows,target_os="linux")))]pub(crate) mod native{
    use super::*;
    pub struct Watch;
    impl Watch{pub fn new(_: &Path)->Result<Self,Value>{Err(failure("unsupported_operation","macOS uses the Swift file provider"))}pub fn poll(&mut self)->Result<bool,Value>{Ok(false)}}
    pub fn inventory(_: &Value,_:Instant)->Result<Value,Value>{Err(failure("unsupported_operation","no native file inventory on this test host"))}
}

pub fn validate(action:&Value)->Result<(),Value>{
    if let Some(error)=desktop_files_shape_error(action){return Err(failure("invalid_request",error));}
    if matches!(action["sub"].as_str(),Some("watch"|"unwatch")){
        let valid=action["path"].as_str().is_some_and(|p|Path::new(p).is_absolute()&&crate::filesystem::absolute(p).is_ok()&&!(cfg!(windows)&&(p.starts_with("\\\\.\\")||p.starts_with("\\\\?\\"))));
        if !valid||action.get("limit").is_some()||action.get("pid").is_some(){return Err(failure("invalid_request","files watch/unwatch require one bounded absolute path and no inventory selectors"));}
    }else{
        if action.get("path").is_some(){return Err(failure("invalid_request","files recent/open accept no path"));}
        let maximum=if action["sub"]=="recent"{DESKTOP_FILES_MAX_RECENT}else{DESKTOP_FILES_MAX_OPEN};
        if action.get("limit").is_some_and(|v|v.as_f64().is_none_or(|n|!n.is_finite()||n.fract()!=0.0||!(0.0..=maximum as f64).contains(&n))){return Err(failure("invalid_request","file inventory/history limit is not a bounded integer"));}
        let pid_max=if cfg!(windows){u32::MAX as f64}else{i32::MAX as f64};
        if action.get("pid").is_some_and(|v|action["sub"]!="open"||v.as_f64().is_none_or(|n|!n.is_finite()||n.fract()!=0.0||!(1.0..=pid_max).contains(&n))){return Err(failure("invalid_request","files pid requires an exact positive process id on open"));}
    }
    Ok(())
}

struct Monitoring{watches:BTreeMap<PathBuf,native::Watch>,history:VecDeque<(Value,usize)>,history_bytes:usize,file:File,path:PathBuf,error:Option<Value>}
static MONITOR:OnceLock<Mutex<Monitoring>>=OnceLock::new();
static START:Mutex<()>=Mutex::new(());
static INVENTORY:Mutex<()>=Mutex::new(());

fn monitor()->Result<&'static Mutex<Monitoring>,Value>{
    let _start=START.lock().unwrap();
    if let Some(state)=MONITOR.get(){return Ok(state);}
    let(file,path)=crate::clipboard::event_file("files").map_err(|e|failure("permission_denied",format!("private file event log unavailable: {e}")))?;
    let _=MONITOR.set(Mutex::new(Monitoring{watches:BTreeMap::new(),history:VecDeque::new(),history_bytes:0,file,path,error:None}));
    std::thread::Builder::new().name("files-events".into()).spawn(||loop{
        std::thread::sleep(Duration::from_millis(25));
        let mut state=MONITOR.get().unwrap().lock().unwrap();if state.error.is_some(){continue;}
        let mut changed=Vec::new();let mut error=None;
        for(path,watch)in &mut state.watches{match watch.poll(){Ok(true)=>changed.push(path.clone()),Ok(false)=>(),Err(e)=>{error=Some(e);break;}}}
        if let Some(error)=error{state.error=Some(error);continue;}
        for path in changed{
            let timestamp=time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default();
            let event=json!({"path":path,"timestamp":timestamp,"event":"change"});
            let written=(||->io::Result<Vec<u8>>{
                let mut bytes=serde_json::to_vec(&event)?;bytes.push(b'\n');
                if state.file.metadata()?.len()+bytes.len()as u64>DESKTOP_FILES_MAX_EVENT_BYTES as u64{state.file.set_len(0)?;}
                state.file.seek(SeekFrom::End(0))?;state.file.write_all(&bytes)?;Ok(bytes)
            })();
            match written{Err(e)=>{state.error=Some(failure("provider_failed",format!("file event recording failed: {e}")));break;},Ok(bytes)=>{
                state.history_bytes+=bytes.len();state.history.push_back((event,bytes.len()));
                while state.history.len()>DESKTOP_FILES_MAX_RECENT||state.history_bytes+2>DESKTOP_FILES_MAX_HISTORY_BYTES{state.history_bytes-=state.history.pop_front().unwrap().1;}
            }}
        }
    }).map_err(|e|{let error=failure("provider_failed",e);MONITOR.get().unwrap().lock().unwrap().error=Some(error.clone());error})?;
    Ok(MONITOR.get().unwrap())
}

fn open(action:&Value)->Value{
    let _inventory=match INVENTORY.try_lock(){Ok(guard)=>guard,Err(_)=>return failure("resource_limit","another bounded file inventory is pending")};
    let result=(||->io::Result<Value>{
        let mut command=Command::new(std::env::current_exe()?);command.arg("--files-open").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
        let mut child=crate::auth::AuthChild(command.spawn()?);let deadline=Instant::now()+Duration::from_millis(DESKTOP_FILES_DEADLINE_MS as u64);
        if let Some(mut input)=child.0.stdin.take(){crate::write_frame(&mut input,&serde_json::to_vec(action)?)?;}
        let mut output=child.0.stdout.take().ok_or_else(||io::Error::other("file inventory helper output unavailable"))?;
        let bytes=crate::auth::bounded_child_result(|bytes|crate::auth::ready_read(&mut output,bytes),deadline,DESKTOP_FILES_MAX_HISTORY_BYTES)?;
        loop{if let Some(status)=child.0.try_wait()?{if !status.success(){return Err(io::Error::other("file inventory helper failed"));}break;}if Instant::now()>=deadline{return Err(io::ErrorKind::TimedOut.into());}std::thread::sleep(Duration::from_millis(5));}
        Ok(serde_json::from_slice(&bytes)?)
    })();
    result.unwrap_or_else(|e|failure(if e.kind()==io::ErrorKind::TimedOut{"resource_limit"}else{"provider_failed"},if e.kind()==io::ErrorKind::TimedOut{"file inventory helper exceeded five seconds; its process was killed and reaped"}else{"file inventory helper failed before a complete result; its process was reaped"}))
}

pub fn inventory_helper()->io::Result<()>{
    let bytes=crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("file inventory helper requires a request"))?;
    let action:Value=serde_json::from_slice(&bytes)?;
    let result=match validate(&action){Err(error)=>error,Ok(())=>if action["sub"]!="open"{failure("invalid_request","file inventory helper requires open")}else{
        match native::inventory(&action,Instant::now()+Duration::from_millis(DESKTOP_FILES_DEADLINE_MS as u64)){Ok(data)=>success(data),Err(error)=>error}
    }};
    let mut bytes=serde_json::to_vec(&result)?;if bytes.len()>DESKTOP_FILES_MAX_HISTORY_BYTES{bytes=serde_json::to_vec(&failure("resource_limit","file inventory result exceeds 1MiB"))?;}
    crate::write_frame(&mut io::stdout().lock(),&bytes)
}

pub fn dispatch(action:&Value)->Value{
    if let Err(error)=validate(action){return error;}
    #[cfg(windows)]if crate::windows::session()=="0"{return failure("no_interactive_session","files requires the current graphical Windows login");}
    #[cfg(target_os="linux")]if !crate::linux::graphical_login(){return failure("no_interactive_session","files requires the current graphical Linux login");}
    if action["sub"]=="open"{return open(action);}
    if action["sub"]=="recent"{
        let limit=action["limit"].as_f64().unwrap_or(20.0)as usize;
        let Some(state)=MONITOR.get()else{return success(json!([]));};let state=state.lock().unwrap();if let Some(error)=&state.error{return error.clone();}
        return success(json!(state.history.iter().skip(state.history.len().saturating_sub(limit)).map(|(event,_)|event).collect::<Vec<_>>()));
    }
    let path=match crate::filesystem::absolute(action["path"].as_str().unwrap()){Ok(path)=>path,Err(error)=>return error};
    if action["sub"]=="unwatch"{
        let removed=MONITOR.get().is_some_and(|state|state.lock().unwrap().watches.remove(&path).is_some());
        return success(json!({"path":path,"removed":removed}));
    }
    let state=match monitor(){Ok(state)=>state,Err(error)=>return error};let mut state=state.lock().unwrap();
    if let Some(error)=&state.error{return error.clone();}
    if !state.watches.contains_key(&path)&&state.watches.len()>=DESKTOP_FILES_MAX_WATCHES{return failure("resource_limit","file watch limit 64 reached");}
    let watch=match native::Watch::new(&path){Ok(watch)=>watch,Err(error)=>return error};
    state.watches.insert(path.clone(),watch);
    success(json!({"watching":path,"eventPath":state.path}))
}

pub fn capability(session:&str)->Value{
    #[cfg(windows)]let effective=session!="0";
    #[cfg(target_os="linux")]let effective=crate::linux::graphical_login();
    #[cfg(not(any(windows,target_os="linux")))]let effective=false;
    json!({"operation":"files","compiled":true,"present":true,"permission":"not_applicable","session":session,"effective":effective,"background":if effective{"semantic"}else{"unavailable"},
        "provider":if cfg!(windows){"Win32 change notifications/PSS disk handles"}else{"Linux inotify/proc descriptors"},"versions":{"contract":"1"},
        "limits":["watch/recent/open/unwatch in the current user and graphical login","64 original-object nonrecursive watches; events may coalesce; no new records after cancellation","1000 history entries/1MiB; private 4MiB rolling event log; history ends with provider exit","25ms observation interval; output names only accessible local disk paths","512 processes/16384 handles/100 paths; one inventory helper; five-second deadline; explicit partial coverage"]})
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn malformed_files_requests_refuse_before_native_calls(){
        for action in [json!({"type":"desktop_files","sub":"recent","limit":-1}),json!({"type":"desktop_files","sub":"watch","path":"relative"}),json!({"type":"desktop_files","sub":"recent","pid":1}),json!({"type":"desktop_files","sub":"open","pid":0}),json!({"type":"desktop_files","sub":"watch","path":"/tmp","limit":1}),json!({"type":"desktop_files","sub":"open","filter":"x"}),json!({"type":"desktop_files","sub":"recent","limit":null})]{assert_eq!(dispatch(&action)["code"],"invalid_request");}
        for sub in ["recent","open"]{assert!(validate(&json!({"type":"desktop_files","sub":sub,"limit":0})).is_ok());}
    }
}

#[cfg(all(test,any(windows,target_os="linux")))]
#[path="files_native_tests.rs"]mod native_tests;
