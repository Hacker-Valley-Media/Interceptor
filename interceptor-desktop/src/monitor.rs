//! Owned recording archives and lifecycle. Native subscriptions use the
//! existing COM/GLib workers; file watches retain independent kernel handles.
use crate::{contract_generated::*,failure,success};
use serde_json::{Value,json};
use base64::Engine;
use std::{collections::{BTreeMap,BTreeSet,VecDeque},fs::{self,File},io::{self,Read,Write,BufRead,BufReader},path::{Path,PathBuf},sync::{Arc,OnceLock,mpsc,atomic::{AtomicBool,AtomicU64,Ordering}},time::{Duration,Instant}};

pub fn safe_sid(value:&str)->bool{!value.is_empty()&&value.len()<=128&&value.bytes().enumerate().all(|(i,b)|b.is_ascii_alphanumeric()||(i>0&&[b'_',b'-'].contains(&b)))}
pub fn validate(action:&Value)->Result<(),Value>{
    if let Some(error)=desktop_monitor_shape_error(action){return Err(failure("invalid_request",error));}
    let invalid=|text:&str|Err(failure("invalid_request",text));
    if action.get("sid").is_some_and(|v|!v.as_str().is_some_and(safe_sid)){return invalid("monitor --sid requires a safe archive identifier");}
    let sub=action["sub"].as_str().unwrap();
    if sub=="export"&&action.get("sid").is_none(){return invalid("monitor export requires --sid");}
    if sub=="start"&&action.get("sid").is_some(){return invalid("monitor start creates its own session identifier");}
    if action.get("limit").is_some()&&!matches!(sub,"tail"|"list"){return invalid("monitor --limit requires tail or list");}
    if usize::from(action.get("app").is_some())+usize::from(action.get("apps").is_some())+usize::from(action["allApps"]==true)>1{return invalid("monitor app, apps and all-apps scopes are mutually exclusive");}
    for(key,min,max)in[("limit",0.,1000.),("frames",0.,60.),("frameQuality",0.,100.),("frameMaxLongEdge",0.,16384.),("video",1.,60.),("videoMaxBytes",0.,10737418240.),("frameBudget",0.,1000000.),("frameDiskCap",0.,10737418240.),("framePixelScale",1.,16.),("scrollCoalesceMs",0.,60000.),("axCoalesceMs",0.,60000.)]{
        if action.get(key).is_some_and(|v|v.as_f64().is_none_or(|n|!n.is_finite()||n.fract()!=0.||n<min||n>max)){return invalid(&format!("monitor {key} requires a bounded integer"));}
    }
    for key in["app","instruction","watchPath","logPredicate","taskId","taskRef","retentionPolicyId","guardPolicyId","verifierPolicyId"]{if action.get(key).and_then(Value::as_str).is_some_and(|v|v.trim().is_empty()||v.contains('\0')||v.len()>32768){return invalid(&format!("monitor {key} requires bounded nonempty text without NUL"));}}
    for key in["apps","include","exclude","watchPaths","excludeApps"]{if let Some(values)=action[key].as_array(){let unique=values.iter().filter_map(Value::as_str).collect::<BTreeSet<_>>();if values.is_empty()||values.len()>64||unique.len()!=values.len()||unique.iter().any(|v|v.trim().is_empty()||v.contains('\0')||v.len()>32768){return invalid(&format!("monitor {key} requires 1..64 unique bounded nonempty values"));}}}
    let start_keys=["instruction","app","apps","allApps","include","exclude","frames","visionText","frameFormat","frameQuality","frameMaxLongEdge","tap","watchPath","watchPaths","logPredicate","speechMode","video","videoMaxBytes","frameBudget","frameDiskCap","framePixelScale","scrollCoalesceMs","axCoalesceMs","includeSystemApps","excludeApps","taskId","taskMode","retentionPolicyId","guardPolicyId","verifierPolicyId"];
    if sub!="start"&&start_keys.iter().any(|key|action.get(key).is_some()){return invalid("monitor recording options require start");}
    Ok(())
}
fn now()->i64{(time::OffsetDateTime::now_utc().unix_timestamp_nanos()/1_000_000)as i64}
fn event_payload(event:&Value)->io::Result<()>{
    let kind=event["event"].as_str().unwrap_or("");
    let payload=Value::Object(event.as_object().ok_or_else(||io::Error::other("monitor event must be an object"))?.iter().filter(|(key,_)|!["sid","s","t","event","timestamp","taskId"].contains(&key.as_str())).map(|(key,value)|(key.clone(),value.clone())).collect());
    macro_rules! shape{($model:ty)=>{{let _: $model=serde_json::from_value(payload)?;}}}
    let observation=matches!(kind,"input"|"focus"|"selection"|"menu_open"|"menu_close"|"title_change"|"layout_change"|"ax_other"|"frontmost"|"app_deactivate"|"window_min"|"window_demin"|"window_create"|"window_destroy");
    match kind{
        "mon_start"=>shape!(DesktopMonitorNativeStartPayload),"mon_stop"=>shape!(DesktopMonitorNativeStopPayload),
        "mon_pause"|"mon_resume"=>shape!(DesktopMonitorNativeEmptyPayload),"file_change"=>shape!(DesktopMonitorNativeFilePayload),
        "clipboard_change"=>shape!(DesktopMonitorNativeClipboardPayload),"source_error"=>shape!(DesktopMonitorNativeErrorPayload),
        "frame"=>shape!(DesktopMonitorMacFramePayload),"frame_error"=>shape!(DesktopMonitorMacErrorPayload),"frame_budget_reached"=>shape!(DesktopMonitorMacBudgetPayload),
        _ if observation=>shape!(DesktopMonitorNativeObservationPayload),_=>return Ok(()),
    }
    let counter=|value:&Value|value.as_f64().is_some_and(|n|n.is_finite()&&n.fract()==0.0&&(0.0..=9007199254740991.0).contains(&n));
    let invalid=match kind{
        "frame"|"frame_budget_reached"=>["w","h","bytes","quality","frames","frameBudget","diskCapBytes"].iter().any(|key|event.get(key).is_some_and(|value|!counter(value)||["w","h"].contains(key)&&value.as_f64()==Some(0.0)))||event["quality"].as_f64().is_some_and(|value|value>100.0)||event["path"].as_str().is_some_and(|path|path.trim().is_empty()||path.contains('\0'))||
            kind=="frame"&&(event["bytes"].as_f64()==Some(0.0)||event["bytes"].as_f64().unwrap_or(0.)>DESKTOP_MAX_RESULT_BYTES as f64||event["w"].as_f64().unwrap_or(0.)*event["h"].as_f64().unwrap_or(0.)>DESKTOP_CAPTURE_MAX_PIXELS as f64)||
            kind=="frame_budget_reached"&&(event["frameBudget"].as_f64().unwrap_or(0.)<1.||event["frameBudget"].as_f64().unwrap_or(0.)>1000000.||event["frames"].as_f64()>event["frameBudget"].as_f64()||event["diskCapBytes"].as_f64().unwrap_or(0.)<1.||event["diskCapBytes"].as_f64().unwrap_or(0.)>DESKTOP_MONITOR_MAX_ARCHIVE_BYTES as f64||event["bytes"].as_f64()>event["diskCapBytes"].as_f64()),
        "mon_start"=>{let coverage=event["coverage"].as_array().unwrap();coverage.is_empty()||coverage.len()>64||event["partial"].as_bool()!=Some(coverage.iter().any(|row|row["available"]==false))||event["scope"]["mode"]=="apps"&&event["scope"]["apps"].as_array().is_none_or(Vec::is_empty)},
        "file_change"=>{let path=event["path"].as_str().unwrap();path.trim().is_empty()||path.contains('\0')},
        "clipboard_change"=>!counter(&event["changeCount"]),
        "source_error"=>if event["source"]=="native_observation"{!counter(&event["dropped"])||event["dropped"].as_f64()==Some(0.0)}else{event["error"]["success"]!=false},
        _ if observation=>{
            let ax=matches!(kind,"input"|"focus"|"selection"|"menu_open"|"menu_close"|"title_change"|"layout_change"|"ax_other");
            event["source"]!=if ax{"ax"}else{"workspace"}||!counter(&event["pid"])||event["pid"].as_f64().unwrap_or(0.0)<=0.0||event["pid"].as_f64().unwrap_or(0.0)>u32::MAX as f64||event["r"].as_str().unwrap().is_empty()||(kind=="input")!=event.get("v").is_some()||event["secure"]==true&&(event["n"]!="***SECURE***"||kind=="input"&&event["v"]!="***SECURE***")||event.get("frame").is_some_and(|frame|frame["width"].as_f64().is_none_or(|n|!n.is_finite()||n<0.0)||frame["height"].as_f64().is_none_or(|n|!n.is_finite()||n<0.0)||["x","y"].iter().any(|key|frame[key].as_f64().is_none_or(|n|!n.is_finite())))||event.get("windowId").is_some_and(|id|if let Some(text)=id.as_str(){text.is_empty()}else{!counter(id)||id.as_f64()==Some(0.0)})
        },_=>false,
    };
    if invalid{return Err(io::Error::other("monitor source payload is invalid; original was preserved"));}Ok(())
}
fn host()->&'static str{if cfg!(windows){"win32"}else if cfg!(target_os="linux"){"linux"}else{"darwin"}}
fn login()->Option<String>{
    #[cfg(windows)]{let session=crate::windows::session();return(session!="0").then_some(session);}
    #[cfg(target_os="linux")]{return crate::linux::login_identity(0).filter(crate::linux_peer::graphical).map(|v|format!("{}:{}",v.id,v.start_usec));}
    #[cfg(not(any(windows,target_os="linux")))]{None}
}
fn root()->io::Result<PathBuf>{
    let directory=std::env::var_os("INTERCEPTOR_MONITOR_SESSIONS_DIR").map(PathBuf::from).unwrap_or_else(||{
        let temp=std::env::var_os("INTERCEPTOR_TEMP").or_else(||std::env::var_os(if cfg!(windows){"TEMP"}else{"TMPDIR"})).or_else(||if cfg!(target_os="linux"){std::env::var_os("XDG_RUNTIME_DIR")}else{None});
        temp.map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("interceptor-monitor-sessions")
    });
    if !directory.is_absolute(){return Err(io::Error::other("monitor root must be absolute"));}Ok(directory)
}
pub(crate) fn private_directory(path:&Path,create:bool,shared_root:bool)->io::Result<()>{
    #[cfg(windows)]{if !create&&!path.exists(){return Err(io::Error::from(io::ErrorKind::NotFound));}crate::windows::private_directory(path)}
    #[cfg(unix)]{
        use std::os::unix::fs::{DirBuilderExt,MetadataExt};
        if create{match fs::DirBuilder::new().mode(0o700).create(path){Ok(())=>(),Err(e)if e.kind()==io::ErrorKind::AlreadyExists=>(),Err(e)=>return Err(e)}}
        let meta=fs::symlink_metadata(path)?;
        if !meta.is_dir()||meta.uid()!=unsafe{libc::geteuid()}||meta.mode()&0o022!=0||!shared_root&&meta.mode()&0o777!=0o700{return Err(io::Error::new(io::ErrorKind::PermissionDenied,"monitor directories must be owned, without symlinks or foreign write access; archives require 0700"));}Ok(())
    }
}
pub(crate) fn private_file(path:&Path,create:bool)->io::Result<File>{
    #[cfg(windows)]{if create{crate::windows::private_output(path)}else{crate::windows::private_input_sharing(path,path.file_name()==Some(std::ffi::OsStr::new("events.jsonl")))}}
    #[cfg(unix)]{
        use std::os::unix::fs::{OpenOptionsExt,MetadataExt};
        let file=fs::OpenOptions::new().read(!create).write(create).create_new(create).mode(0o600).custom_flags(libc::O_NOFOLLOW|libc::O_NONBLOCK|libc::O_CLOEXEC).open(path)?;
        let meta=file.metadata()?;if !meta.is_file()||meta.uid()!=unsafe{libc::geteuid()}||meta.mode()&0o777!=0o600||meta.nlink()!=1{return Err(io::Error::new(io::ErrorKind::PermissionDenied,"monitor file must be owned and private (0600), without symlinks or other links"));}Ok(file)
    }
}
// Compare actual retained native files, not names, lengths or creation times.
// Callers keep their exclusive writer alive until matching readback finishes.
pub(crate) fn same_private_file(first:&File,second:&File)->io::Result<bool>{
    #[cfg(unix)]{
        use std::os::unix::fs::MetadataExt;
        let a=first.metadata()?;let b=second.metadata()?;
        let private=|m:&fs::Metadata|m.is_file()&&m.nlink()==1&&m.uid()==unsafe{libc::geteuid()}&&m.mode()&0o777==0o600;
        Ok(private(&a)&&private(&b)&&a.dev()==b.dev()&&a.ino()==b.ino())
    }
    #[cfg(windows)]{
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::HANDLE,Storage::FileSystem::{GetFileInformationByHandle,BY_HANDLE_FILE_INFORMATION}};
        let mut a=BY_HANDLE_FILE_INFORMATION::default();let mut b=BY_HANDLE_FILE_INFORMATION::default();
        unsafe{GetFileInformationByHandle(HANDLE(first.as_raw_handle()),&mut a).map_err(io::Error::other)?;GetFileInformationByHandle(HANDLE(second.as_raw_handle()),&mut b).map_err(io::Error::other)?;}
        Ok(a.nNumberOfLinks==1&&b.nNumberOfLinks==1&&a.dwFileAttributes&0x410==0&&b.dwFileAttributes&0x410==0&&a.dwVolumeSerialNumber==b.dwVolumeSerialNumber&&a.nFileIndexHigh==b.nFileIndexHigh&&a.nFileIndexLow==b.nFileIndexLow)
    }
    #[cfg(not(any(unix,windows)))]{let _=(first,second);Err(io::Error::new(io::ErrorKind::Unsupported,"native retained file identity is unavailable"))}
}
pub(crate) fn retained_private_reader(writer:&File,path:&Path)->io::Result<File>{
    #[cfg(target_os="linux")]let reader={use std::os::fd::AsRawFd;File::open(format!("/proc/self/fd/{}",writer.as_raw_fd()))?};
    #[cfg(windows)]let reader=crate::windows::private_input_sharing(path,true)?;
    #[cfg(all(unix,not(target_os="linux")))]let reader=private_file(path,false)?;
    #[cfg(not(any(unix,windows)))]let reader:File={let _=(writer,path);return Err(io::Error::new(io::ErrorKind::Unsupported,"native retained file access is unavailable"));};
    if !same_private_file(writer,&reader)?{return Err(io::Error::new(io::ErrorKind::PermissionDenied,"read handle differs from the exclusively created private file"));}
    Ok(reader)
}
pub(crate) fn private_path_matches(file:&File,path:&Path)->io::Result<bool>{
    #[cfg(windows)]let current=crate::windows::private_input_sharing(path,true)?;
    #[cfg(not(windows))]let current=private_file(path,false)?;
    same_private_file(file,&current)
}
static SERIAL:AtomicU64=AtomicU64::new(0);
pub(crate) fn identifier()->String{
    // IDs select owner-private artifacts. They are not authorization tokens.
    format!("{:016x}{:08x}{:08x}",time::OffsetDateTime::now_utc().unix_timestamp_nanos()as u64,std::process::id(),SERIAL.fetch_add(1,Ordering::Relaxed))
}
fn io_error(error:io::Error)->Value{failure(if error.kind()==io::ErrorKind::PermissionDenied{"permission_denied"}else if error.kind()==io::ErrorKind::NotFound{"target_gone"}else if error.kind()==io::ErrorKind::FileTooLarge{"resource_limit"}else{"provider_failed"},error)}
fn bounded(data:Value)->Value{let result=success(data);if serde_json::to_vec(&result).is_ok_and(|v|v.len()<=DESKTOP_MONITOR_MAX_RESULT_BYTES){result}else{failure("resource_limit","monitor reply exceeds 1MiB; request a smaller tail or use the owned archive")}}
fn save_meta(directory:&Path,meta:&Value)->io::Result<()>{
    let bytes=serde_json::to_vec(meta)?;if bytes.len()>DESKTOP_MONITOR_MAX_RESULT_BYTES{return Err(io::Error::other("monitor metadata exceeds 1MiB"));}
    let temporary=directory.join(format!("session-{}.next",identifier()));let mut file=private_file(&temporary,true)?;
    file.write_all(&bytes)?;file.sync_all()?;drop(file);fs::rename(temporary,directory.join("session.json"))?;
    #[cfg(target_os="linux")]File::open(directory)?.sync_all()?;
    Ok(())
}
fn strings(action:&Value,key:&str)->BTreeSet<String>{action[key].as_array().map(|v|v.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()}
fn replay_plan(events:&[Value],meta:&Value,windows:bool)->String{
    let comment=|value:&str|value.replace(['\r','\n','\0','\u{85}','\u{2028}','\u{2029}']," ");
    // PowerShell also ends a single-quoted string at U+2018..U+201B; doubling each quote keeps it literal.
    let quote=|value:&str|format!("'{}'",if windows{value.chars().fold(String::new(),|mut s,c|{if matches!(c,'\''|'\u{2018}'..='\u{201B}'){s.push(c);}s.push(c);s})}else{value.replace('\'',"'\\''")});
    let mut lines=vec!["# Replay plan for native desktop recording".to_owned(),format!("# Session: {}",comment(meta["sessionId"].as_str().unwrap_or(""))),format!("# Partial source coverage: {}",meta["partial"]==true)];
    if let Some(instruction)=meta["instruction"].as_str(){lines.push(format!("# Instruction: {}",comment(instruction)));}
    lines.push("# Re-read exact name/role in the recorded app; refuse ambiguous, secure or expired targets. No activation or automatic retry.".into());
    lines.push(if windows{"#requires -Version 7.3\n$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version Latest\n$PSNativeCommandArgumentPassing = 'Standard'"}else{"set -eu\ncommand -v jq >/dev/null 2>&1 || { printf '%s\\n' 'Native replay requires jq for exact JSON target selection' >&2; exit 1; }"}.into());
    for event in events{
        let kind=event["event"].as_str().unwrap_or("");
        if kind.starts_with("mon_"){continue;}
        if !matches!(kind,"input"|"change"){lines.push(format!("# Observation only: {}",comment(kind)));continue;}
        let app=event["app"].as_str().unwrap_or("");let name=event["n"].as_str().unwrap_or("");let role=crate::accessibility::display_role(event["r"].as_str().unwrap_or(""));
        let Some(value)=event["v"].as_str()else{lines.push("# Input omitted: no complete text value was recorded".into());continue;};
        if event["secure"]==true||value.starts_with("***")&&value.ends_with("***"){lines.push("# Input omitted: secure value is masked".into());continue;}
        if app.is_empty()||name.is_empty()||role.is_empty()||name.chars().count()>=256||value.chars().count()>=256||[app,name,role.as_str(),value].iter().any(|text|text.contains('\0')||text.starts_with("--")){
            lines.push("# Input omitted: missing, bounded or CLI-reserved target/value requires a fresh operator decision".into());continue;
        }
        let app=quote(app);let name=quote(name);let role=quote(&role);let value=quote(value);
        if windows{
            lines.push(format!("$recordingTargets = @(interceptor --json desktop find {name} --app {app} --role {role} | ConvertFrom-Json | Where-Object {{ $_.name -ceq {name} -and $_.role -ceq {role} -and $_.secure -eq $false }})"));
            lines.push("if ($LASTEXITCODE -ne 0 -or $recordingTargets.Count -ne 1) { throw 'Native replay target is missing or ambiguous' }".into());
            lines.push(format!("interceptor desktop type ($recordingTargets[0].ref) {value} --pid ($recordingTargets[0].pid) --background-only"));
            lines.push("if ($LASTEXITCODE -ne 0) { throw 'Native replay failed; observe the target before retrying' }".into());
        }else{
            lines.push(format!("recording_matches=$(interceptor --json desktop find {name} --app {app} --role {role})"));
            lines.push(format!("recording_target=$(printf '%s\\n' \"$recording_matches\" | jq -er --arg name {name} --arg role {role} 'map(select(.name == $name and .role == $role and .secure == false)) | if length == 1 then .[0] | [.ref, .pid] | @tsv else error(\"Native replay target is missing or ambiguous\") end')"));
            lines.push("set -f\nset -- $recording_target\n[ \"$#\" -eq 2 ] || exit 1".into());
            lines.push(format!("interceptor desktop type \"$1\" {value} --pid \"$2\" --background-only"));
        }
    }
    lines.join("\n")
}
pub(crate) struct NativeEvent{generation:u64,event:&'static str,data:Value}
pub(crate) struct Observer{
    pub sid:String,pub scope:Value,pub excludes:BTreeSet<String>,exclude_apps:BTreeSet<String>,include_system_apps:bool,
    pub generation:AtomicU64,pub dropped:AtomicU64,pub detached:AtomicBool,events:mpsc::SyncSender<NativeEvent>,
}
impl Observer{
    pub(crate) fn new(sid:String,scope:Value,action:&Value)->(Arc<Self>,mpsc::Receiver<NativeEvent>){
        let(events,receiver)=mpsc::sync_channel(256);
        // MAX means installed but not started; zero means revoked. Native
        // callback owners must not infer liveness from their own Arc count.
        (Arc::new(Self{sid,scope,excludes:strings(action,"exclude"),exclude_apps:strings(action,"excludeApps"),include_system_apps:action["includeSystemApps"]==true,generation:AtomicU64::new(u64::MAX),dropped:AtomicU64::new(0),detached:AtomicBool::new(false),events}),receiver)
    }
    pub fn epoch(&self)->Option<u64>{let epoch=self.generation.load(Ordering::Acquire);(epoch>0&&epoch<u64::MAX&&epoch%2==1).then_some(epoch)}
    pub fn accepts(&self,pid:u32,app:&str,frontmost:bool)->bool{
        let matches=|name:&str|name.eq_ignore_ascii_case(app)||cfg!(windows)&&name.eq_ignore_ascii_case(&format!("{app}.exe"));
        if pid==0||pid==std::process::id()||self.exclude_apps.iter().any(|n|matches(n)){return false;}
        let system_apps:&[&str]=if cfg!(windows){&["winlogon","dwm","TextInputHost","ShellExperienceHost","StartMenuExperienceHost","SearchHost","SearchApp","LockApp"]}else{&["gnome-shell","GNOME Shell","plasmashell","kwin_wayland","kwin_x11","Hyprland","sway","waybar","swaybg","mako","dunst","hyprlock"]};
        if !self.include_system_apps&&system_apps.iter().any(|name|matches(name)){return false;}
        match self.scope["mode"].as_str(){
            Some("all")=>true,Some("frontmost")=>frontmost,
            Some("apps")=>self.scope["apps"].as_array().is_some_and(|apps|apps.iter().filter_map(Value::as_str).any(matches)),_=>false,
        }
    }
    pub fn emit(&self,generation:u64,event:&'static str,source:&str,app:&str,description:Value,notification:&str){
        if self.epoch()!=Some(generation)||self.excludes.contains(source)||self.excludes.contains(event){return;}
        let secure=description["secure"]==true;
        let preview=|key:&str|description[key].as_str().unwrap_or("").chars().take(256).collect::<String>();
        let mut data=json!({"source":source,"app":app,"pid":description["pid"],"r":description["role"],"n":if secure{"***SECURE***".to_owned()}else{preview("name")},"secure":secure,"notification":notification});
        if event=="input"{data["v"]=json!(if secure{"***SECURE***".to_owned()}else{preview("value")});}
        if description["frame"].is_object(){data["frame"]=description["frame"].clone();}
        if description["windowId"].is_number()||description["windowId"].is_string(){data["windowId"]=description["windowId"].clone();}
        if self.events.try_send(NativeEvent{generation,event,data}).is_err(){self.dropped.fetch_add(1,Ordering::Relaxed);}
    }
}
fn observe(observer:Arc<Observer>)->Value{
    #[cfg(windows)]{return crate::windows::observe(observer);}
    #[cfg(target_os="linux")]{return crate::linux::observe(observer);}
    #[cfg(not(any(windows,target_os="linux")))]{let _=observer;failure("unsupported_operation","native observation requires Windows or Linux")}
}
fn observation_control(sub:&str,sid:&str)->Value{
    #[cfg(windows)]{return crate::windows::dispatch(sub,&json!({"sid":sid}));}
    #[cfg(target_os="linux")]{return crate::linux::dispatch(sub,&json!({"sid":sid}));}
    #[cfg(not(any(windows,target_os="linux")))]{let _=(sub,sid);success(json!({}))}
}
fn start_frames(action:&Value,owner:Arc<Observer>)->Value{
    #[cfg(windows)]{return crate::windows::record_frames(action,owner);}
    #[cfg(target_os="linux")]{return crate::linux::record_frames(action,owner);}
    #[cfg(not(any(windows,target_os="linux")))]{let _=(action,owner);failure("unsupported_operation","native recording frames require Windows or X11")}
}
fn frame_control(action:&Value)->Value{
    #[cfg(windows)]{return crate::windows::dispatch("__monitor_frames",action);}
    #[cfg(target_os="linux")]{return crate::linux::dispatch("__monitor_frames",action);}
    #[cfg(not(any(windows,target_os="linux")))]{let _=action;success(json!({}))}
}
struct Frames{owner:Arc<Observer>,action:Value,enabled:bool,attached:bool,interval:Duration,last_poll:Instant,opened:Instant,pending:bool,count:u64,bytes:u64,budget:u64,cap:u64}
impl Drop for Frames{fn drop(&mut self){self.owner.generation.store(0,Ordering::Release);}}
impl Frames{
    fn new(owner:Arc<Observer>,options:&Value)->Self{
        let action=json!({"app":owner.scope["apps"][0],"sid":owner.sid,"format":options["frameFormat"].as_str().unwrap_or("jpeg"),"quality":options["frameQuality"].as_f64().unwrap_or(80.),"target_max_long_edge":options["frameMaxLongEdge"].as_f64().unwrap_or(1600.)});
        let budget=options["frameBudget"].as_f64().unwrap_or(7200.)as u64;
        let cap=options["frameDiskCap"].as_f64().unwrap_or(0.)as u64;
        Self{owner,action,enabled:true,attached:false,interval:Duration::from_secs_f64(1./options["frames"].as_f64().unwrap_or(1.).max(1.)),last_poll:Instant::now()-Duration::from_secs(1),opened:Instant::now(),pending:true,count:0,bytes:0,budget:if budget==0{7200}else{budget},cap:if cap==0{DESKTOP_MONITOR_MAX_ARCHIVE_BYTES as u64}else{cap.min(DESKTOP_MONITOR_MAX_ARCHIVE_BYTES as u64)}}
    }
    fn close(&mut self)->bool{self.enabled=false;self.owner.generation.store(0,Ordering::Release);if !self.attached{return true;}let stopped=frame_control(&json!({"sid":self.owner.sid,"sub":"stop"}))["success"]==true;if stopped{self.attached=false;}stopped}
    fn budget_event(&self)->Value{json!({"frames":self.count,"bytes":self.bytes,"frameBudget":self.budget,"diskCapBytes":self.cap})}
}
struct Recording{meta:Value,directory:PathBuf,events:File,bytes:u64,seq:u64,paused:bool,started:Instant,watches:Vec<(PathBuf,crate::files::native::Watch)>,clipboard:Option<u64>,excludes:BTreeSet<String>,observer:Option<(Arc<Observer>,mpsc::Receiver<NativeEvent>)>,frames:Option<Frames>,save_frames:bool,vision_text:bool,video:Option<crate::stream_media::Recording>}
impl Drop for Recording{fn drop(&mut self){if let Some((observer,_))=&self.observer{observer.generation.store(0,Ordering::Release);}}}
impl Recording{
    fn frame(&mut self,data:&Value)->io::Result<()>{
        if self.paused||!self.frames.as_ref().is_some_and(|frames|frames.enabled){return Ok(());}
        let invalid=||io::Error::other("native frame result is invalid; no artifact was written");
        let(w,h,bytes)=(data["width"].as_u64().ok_or_else(invalid)?,data["height"].as_u64().ok_or_else(invalid)?,data["bytes"].as_u64().ok_or_else(invalid)?);
        let want_format=self.frames.as_ref().unwrap().action["format"].clone();
        if w>u32::MAX as u64||h>u32::MAX as u64||crate::capture::pixel_size(w as u32,h as u32).is_err()||bytes>DESKTOP_MAX_RESULT_BYTES as u64||data["format"]!=want_format{return Err(invalid());}
        let format=data["format"].as_str().ok_or_else(invalid)?.to_owned();
        let prefix=match format.as_str(){"jpeg"=>"data:image/jpeg;base64,","png"=>"data:image/png;base64,","webp"=>"data:image/webp;base64,",_=>return Err(invalid())};
        let encoded=data["dataUrl"].as_str().and_then(|url|url.strip_prefix(prefix)).ok_or_else(invalid)?;
        if encoded.len()>DESKTOP_MAX_RESULT_BYTES*2{return Err(invalid());}
        let encoded=base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_|invalid())?;
        if encoded.len()as u64!=bytes||bytes==0{return Err(invalid());}
        // The frame counts against the budget only once it is stored (a refused write leaves no slot used).
        let index={let frames=self.frames.as_mut().unwrap();frames.pending=false;frames.count};
        // Video: feed the JPEG into the Matroska recording; its own 100MiB / 1h bound governs.
        if self.video.is_some(){
            if format!="jpeg"{return Err(invalid());}
            let video=self.video.as_mut().unwrap();video.observe(encoded.clone(),w as u32,h as u32,Instant::now());
            if let Some(problem)=video.problem(){
                let path=video.path().to_path_buf();let reason=problem["error"].as_str().unwrap_or("video recording failed").chars().take(4096).collect::<String>();
                self.video=None;if let Some(frames)=self.frames.as_mut(){let _=frames.close();}
                return self.event("video_error",json!({"path":path,"error":reason}));
            }
        }
        // Saved frames (explicit --frames, and the images --vision-text runs OCR on).
        let mut frame_path=None;
        if self.save_frames{
            let(cap,budget,fbytes)={let f=self.frames.as_ref().unwrap();(f.cap,f.budget,f.bytes)};
            if index>=budget||fbytes+bytes>cap||self.bytes+fbytes+bytes>(DESKTOP_MONITOR_MAX_ARCHIVE_BYTES-2*DESKTOP_MONITOR_MAX_RESULT_BYTES)as u64{
                let event=self.frames.as_ref().unwrap().budget_event();if !self.frames.as_mut().unwrap().close(){return Err(io::Error::other("frame budget reached but source teardown was not acknowledged"));}return self.event("frame_budget_reached",event);
            }
            let media=self.directory.join("media");private_directory(&media,true,false)?;
            let path=media.join(format!("{index:06}.{format}"));
            let mut file=private_file(&path,true)?;file.write_all(&encoded)?;file.sync_all()?;drop(file);
            #[cfg(target_os="linux")]File::open(&media)?.sync_all()?;
            let quality={let f=self.frames.as_mut().unwrap();f.bytes+=bytes;f.count+=1;f.action["quality"].clone()};
            self.event("frame",json!({"path":path.clone(),"w":w,"h":h,"bytes":bytes,"format":format,"quality":quality}))?;
            frame_path=Some(path);
        }else{self.frames.as_mut().unwrap().count+=1;}
        // OCR each saved frame through the same native engine as `vision text`.
        if self.vision_text{if let Some(path)=&frame_path{
            let deadline=Instant::now()+std::time::Duration::from_secs(10);
            match crate::thumbnail::image_helper("--vision-ocr",&json!({"action":{"type":"desktop_vision","sub":"text","imagePath":path}}),deadline){
                Ok(result)=>{let blocks:Vec<Value>=result["regions"].as_array().map(|rows|rows.iter().take(64).map(|r|json!({"text":r["text"],"confidence":r["confidence"],"rect":{"x":r["x"],"y":r["y"],"w":r["width"],"h":r["height"]}})).collect()).unwrap_or_default();self.event("ocr_text",json!({"frame":path,"blocks":blocks}))?;}
                Err(error)=>{let reason=error["error"].as_str().unwrap_or("native OCR failed").chars().take(4096).collect::<String>();self.event("frame_error",json!({"error":reason}))?;}
            }
        }}
        // Close the saved-frame source once it reaches its budget.
        if self.save_frames{let(count,budget,fbytes,cap)={let f=self.frames.as_ref().unwrap();(f.count,f.budget,f.bytes,f.cap)};if count>=budget||fbytes>=cap{let event=self.frames.as_ref().unwrap().budget_event();if !self.frames.as_mut().unwrap().close(){return Err(io::Error::other("frame source teardown was not acknowledged"));}return self.event("frame_budget_reached",event);}}
        Ok(())
    }
    fn frame_failed(&mut self,error:&Value)->io::Result<()>{
        if let Some(frames)=self.frames.as_mut(){let _=frames.close();}
        let reason=format!("{}: {}",error["code"].as_str().unwrap_or("provider_failed"),error["error"].as_str().unwrap_or("native frame source failed")).chars().take(4096).collect::<String>();
        let coverage=self.meta["coverage"].as_array_mut().ok_or_else(||io::Error::other("frame coverage is invalid"))?;
        let source=coverage.iter_mut().find(|entry|entry["source"]=="frames").ok_or_else(||io::Error::other("frame coverage is missing"))?;
        source["available"]=json!(false);source["reason"]=json!(reason);self.meta["partial"]=json!(true);
        self.event("frame_error",json!({"error":reason}))?;save_meta(&self.directory,&self.meta)
    }
    fn event(&mut self,event:&str,data:Value)->io::Result<()>{
        if(self.paused||self.excludes.contains(event))&&!event.starts_with("mon_"){return Ok(());}
        let mut entry=data.as_object().cloned().unwrap_or_default();entry.insert("event".into(),json!(event));entry.insert("sid".into(),self.meta["sessionId"].clone());entry.insert("s".into(),json!(self.seq));entry.insert("t".into(),json!(now()));
        if self.meta.get("taskId").is_some(){entry.insert("taskId".into(),self.meta["taskId"].clone());}
        let mut bytes=serde_json::to_vec(&entry)?;bytes.push(b'\n');
        let cap=DESKTOP_MONITOR_MAX_ARCHIVE_BYTES-if event=="mon_stop"{0}else{DESKTOP_MONITOR_MAX_RESULT_BYTES};
        if bytes.len()>DESKTOP_MONITOR_MAX_RESULT_BYTES||self.bytes+self.frames.as_ref().map_or(0,|frames|frames.bytes)+bytes.len()as u64>cap as u64{return Err(io::Error::other("recording event/archive byte bound reached"));}
        self.events.write_all(&bytes)?;self.events.sync_data()?;self.bytes+=bytes.len()as u64;self.seq+=1;
        self.meta["counts"]["evt"]=json!(self.seq);
        if entry.get("source").is_some_and(|v|v=="ax"){self.meta["counts"]["ax"]=json!(self.meta["counts"]["ax"].as_u64().unwrap_or(0)+1);}Ok(())
    }
    fn status(&self)->Value{json!({"sid":self.meta["sessionId"],"surface":"desktop","host":host(),"status":if self.paused{"paused"}else{"recording"},"duration":self.started.elapsed().as_secs_f64(),"counts":self.meta["counts"],"scope":self.meta["scope"],"includes":self.meta["includes"],"coverage":self.meta["coverage"],"partial":self.meta["partial"]})}
    fn stop(&mut self,reason:&str)->io::Result<Value>{
        if let Some(mut video)=self.video.take(){let path=video.path().to_path_buf();match video.finish(){
            Ok(())=>{let _=self.event("video_finished",json!({"path":path,"bytes":video.bytes(),"durationSec":video.duration()}));}
            Err(error)=>{let _=self.event("video_error",json!({"path":path,"error":error["error"].as_str().unwrap_or("video finalization failed").chars().take(4096).collect::<String>()}));}
        }}
        let frame_teardown=self.frames.as_mut().map(Frames::close);
        let teardown=self.observer.as_ref().map(|(observer,_)|{observer.generation.store(0,Ordering::Release);let result=observation_control("__monitor_stop",&observer.sid);result["success"]==true&&observer.detached.load(Ordering::Acquire)});
        if reason!="user_stop"||teardown==Some(false)||frame_teardown==Some(false){
            let source=match reason{"file_source_failed"=>"files","clipboard_source_failed"=>"clipboard","native_source_overflow"=>"native_observation",_ if frame_teardown==Some(false)=>"frames",_ if teardown==Some(false)=>"native_observation",_=>"recording"};
            let reason=if teardown==Some(false)||frame_teardown==Some(false){"subscription_teardown_unacknowledged"}else{reason};
            let coverage=self.meta["coverage"].as_array_mut().ok_or_else(||io::Error::other("recording coverage is invalid"))?;
            if let Some(entry)=coverage.iter_mut().find(|entry|entry["source"]==source){entry["available"]=json!(false);entry["reason"]=json!(reason);}else{coverage.push(json!({"source":source,"available":false,"reason":reason}));}
            self.meta["partial"]=json!(true);
        }
        self.paused=true;self.meta["paused"]=json!(true);self.meta["status"]=json!("stopped");self.meta["endedAt"]=json!(now());self.meta["stopReason"]=json!(reason);
        let event_result=self.event("mon_stop",json!({"reason":reason}));save_meta(&self.directory,&self.meta)?;event_result?;
        if teardown==Some(false)||frame_teardown==Some(false){return Err(io::Error::other("recording stopped, but native subscription teardown was not acknowledged"));}
        Ok(json!({"sid":self.meta["sessionId"],"duration":self.started.elapsed().as_secs_f64(),"evt":self.seq,"mut":0,"net":0,"nav":0,"ax":self.meta["counts"]["ax"],"reason":reason}))
    }
}
struct Runtime{root:PathBuf,login:String,sessions:BTreeMap<String,Recording>,_lock:File}
impl Runtime{
    fn open(root:PathBuf,login:String)->io::Result<Self>{
        private_directory(&root,true,true)?;
        let path=root.join(".native-monitor.lock");
        #[cfg(windows)]let _lock=crate::windows::private_lock(&path)?;
        #[cfg(unix)]let _lock={
            use std::os::{unix::fs::{OpenOptionsExt,MetadataExt},fd::AsRawFd};
            let file=fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).mode(0o600).custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC).open(&path)?;
            let meta=file.metadata()?;
            // A sibling thread's fork shares a just-released lock until exec, so retry EWOULDBLOCK briefly.
            let locked=||{let deadline=Instant::now()+Duration::from_millis(500);loop{
                if unsafe{libc::flock(file.as_raw_fd(),libc::LOCK_EX|libc::LOCK_NB)}==0{return true;}
                if io::Error::last_os_error().raw_os_error()!=Some(libc::EWOULDBLOCK)||Instant::now()>=deadline{return false;}
                std::thread::sleep(Duration::from_millis(10));
            }};
            if !meta.is_file()||meta.uid()!=unsafe{libc::geteuid()}||meta.mode()&0o777!=0o600||meta.nlink()!=1||!locked(){return Err(io::Error::other("native recording root is already owned or its lock is unsafe"));}file
        };
        let runtime=Self{root,login,sessions:BTreeMap::new(),_lock};runtime.recover()?;Ok(runtime)
    }
    fn archive(&self,sid:&str)->io::Result<PathBuf>{if !safe_sid(sid){return Err(io::Error::other("unsafe archive identifier"));}private_directory(&self.root,false,true)?;let path=self.root.join(sid);private_directory(&path,false,false)?;Ok(path)}
    fn recover(&self)->io::Result<()>{
        for sid in self.names()?{
            let Some(mut meta)=self.owned_meta(&sid)? else{continue;};
            if meta["status"]!="active"{continue;}
            let directory=self.archive(&sid)?;
            let mut prior=private_file(&directory.join(format!("interrupted-session-{}.json",identifier())),true)?;
            let mut original=private_file(&directory.join("session.json"),false)?;
            io::copy(&mut original,&mut prior)?;prior.sync_all()?;drop(original);drop(prior);
            meta["status"]=json!("stopped");meta["paused"]=json!(true);meta["endedAt"]=json!(now());meta["stopReason"]=json!("provider_interrupted");meta["partial"]=json!(true);
            let coverage=meta.as_object_mut().unwrap().entry("coverage").or_insert(json!([]));
            coverage.as_array_mut().ok_or_else(||io::Error::other("interrupted archive coverage is invalid"))?.push(json!({"source":"recovery","available":false,"reason":"provider ended without an acknowledged stop; original metadata and events were preserved"}));
            save_meta(&directory,&meta)?;
        }Ok(())
    }
    // Browser archives share this root, so its size is not ours to cap. Keep the newest
    // 1000 names (identifiers sort by start time); older originals stay on disk untouched.
    fn names(&self)->io::Result<Vec<String>>{
        let mut names=vec![];
        for entry in fs::read_dir(&self.root)?{let name=entry?.file_name().to_string_lossy().into_owned();if name!=".native-monitor.lock"&&safe_sid(&name){names.push(name);}}
        names.sort();names.drain(..names.len().saturating_sub(DESKTOP_MONITOR_MAX_ENTRIES));Ok(names)
    }
    fn owned_meta(&self,sid:&str)->io::Result<Option<Value>>{
        // Browser archives share the owned parent on every OS. Inspect only their
        // selector first; all native metadata is then checked through the private reader.
        let directory=self.root.join(sid);let info=fs::symlink_metadata(&directory)?;
        #[cfg(unix)]let file={
            use std::os::unix::fs::{MetadataExt,OpenOptionsExt};
            if !info.is_dir()||info.uid()!=unsafe{libc::geteuid()}||info.mode()&0o022!=0{return Err(io::Error::new(io::ErrorKind::PermissionDenied,"unsafe recording history entry"));}
            let file=match fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW|libc::O_NONBLOCK|libc::O_CLOEXEC).open(directory.join("session.json")){Ok(f)=>f,Err(e)if e.kind()==io::ErrorKind::NotFound=>return Ok(None),Err(e)=>return Err(e)};
            let info=file.metadata()?;if !info.is_file()||info.uid()!=unsafe{libc::geteuid()}||info.mode()&0o022!=0||info.nlink()!=1{return Err(io::Error::new(io::ErrorKind::PermissionDenied,"unsafe recording history metadata"));}file
        };
        #[cfg(windows)]let file={
            use std::os::windows::fs::{MetadataExt,OpenOptionsExt};
            if !info.is_dir()||info.file_attributes()&0x400!=0{return Err(io::Error::new(io::ErrorKind::PermissionDenied,"unsafe recording history entry"));}
            let file=match fs::OpenOptions::new().read(true).custom_flags(0x0020_0000).open(directory.join("session.json")){Ok(f)=>f,Err(e)if e.kind()==io::ErrorKind::NotFound=>return Ok(None),Err(e)=>return Err(e)};
            let info=file.metadata()?;if !info.is_file()||info.file_attributes()&0x400!=0{return Err(io::Error::new(io::ErrorKind::PermissionDenied,"unsafe recording history metadata"));}file
        };
        if file.metadata()?.len()>DESKTOP_MONITOR_MAX_RESULT_BYTES as u64{return Err(io::Error::new(io::ErrorKind::FileTooLarge,"recording history metadata exceeds 1MiB"));}
        let mut bytes=vec![];file.take(DESKTOP_MONITOR_MAX_RESULT_BYTES as u64+1).read_to_end(&mut bytes)?;
        if bytes.len()>DESKTOP_MONITOR_MAX_RESULT_BYTES{return Err(io::Error::new(io::ErrorKind::FileTooLarge,"recording history metadata grew beyond 1MiB"));}
        let meta:Value=serde_json::from_slice(&bytes)?;
        if matches!(meta["surface"].as_str(),Some("browser"|"macos")){return Ok(None);}
        self.meta(sid).map(Some)
    }
    fn meta(&self,sid:&str)->io::Result<Value>{
        let directory=self.archive(sid)?;let file=private_file(&directory.join("session.json"),false)?;let mut bytes=vec![];
        file.take(DESKTOP_MONITOR_MAX_RESULT_BYTES as u64+1).read_to_end(&mut bytes)?;
        if bytes.len()>DESKTOP_MONITOR_MAX_RESULT_BYTES{return Err(io::Error::new(io::ErrorKind::FileTooLarge,"monitor metadata exceeds 1MiB"));}
        let value:Value=serde_json::from_slice(&bytes)?;
        if value["sessionId"]!=sid||value["surface"]!="desktop"||value["host"]!=host(){return Err(io::Error::other("archive identity does not match the requested desktop recording"));}
        let refused=||io::Error::new(io::ErrorKind::PermissionDenied,"monitor archive metadata is invalid; original was preserved");
        let mut public=value.clone();let fields=public.as_object_mut().ok_or_else(refused)?;
        if fields.get("sid").is_some_and(|v|v!=sid){return Err(refused());}fields.remove("options");fields.insert("sid".into(),json!(sid));
        let _:DesktopMonitorArchiveData=serde_json::from_value(public).map_err(|_|refused())?;
        if let Some(options)=value.get("options"){if options["sub"]!="start"||validate(options).is_err(){return Err(refused());}}
        let counter=|v:&Value|v.as_f64().is_some_and(|n|n.is_finite()&&n.fract()==0.0&&(0.0..=9007199254740991.0).contains(&n));
        let text=|v:&Value|v.as_str().is_some_and(|s|!s.trim().is_empty()&&!s.contains('\0')&&s.len()<=32768);
        let names=|v:&Value|v.as_array().is_some_and(|rows|rows.len()<=64&&rows.iter().all(text)&&rows.iter().filter_map(Value::as_str).collect::<BTreeSet<_>>().len()==rows.len());
        let pid=|v:&Value|counter(v)&&v.as_f64().is_some_and(|n|n>=1.0&&n<=u32::MAX as f64);
        if value["artifactVersion"].as_f64()!=Some(1.0)||!counter(&value["startedAt"])||value.get("endedAt").is_some_and(|v|!counter(v)||v.as_f64()<value["startedAt"].as_f64())||value["status"]=="active"&&(value.get("endedAt").is_some()||value.get("stopReason").is_some())||value["status"]=="stopped"&&value.get("endedAt").is_none(){return Err(refused());}
        if value["counts"].as_object().unwrap().values().any(|v|!counter(v)||v.as_f64()>value["counts"]["evt"].as_f64()){return Err(refused());}
        let apps=value["scope"].get("apps").cloned().unwrap_or(json!([]));
        if !names(&apps)||value["scope"]["mode"]=="apps"&&apps.as_array().unwrap().is_empty()||value["scope"]["mode"]!="apps"&&!apps.as_array().unwrap().is_empty()||!names(&value["includes"])||!names(&value["excludes"]){return Err(refused());}
        let coverage=value["coverage"].as_array().ok_or_else(refused)?;
        if coverage.is_empty()||coverage.len()>64||value["partial"].as_bool()!=Some(coverage.iter().any(|v|v["available"]==false))||coverage.iter().any(|v|!text(&v["source"]))||coverage.iter().filter_map(|v|v["source"].as_str()).collect::<BTreeSet<_>>().len()!=coverage.len(){return Err(refused());}
        if value["status"]=="active"&&(coverage.len()>63||coverage.iter().any(|v|v["source"]=="recovery")){return Err(refused());}
        if value["provider"]!="interceptor-desktop-rust"||!pid(&value["providerPid"])||!text(&value["login"])||value.get("rootPid").is_some_and(|v|!pid(v)){return Err(refused());}
        let attachments=value["attachments"].as_array().unwrap();
        if attachments.len()>DESKTOP_MONITOR_MAX_ENTRIES||attachments.iter().any(|v|!pid(&v["pid"])||v["key"]!=format!("pid:{}",v["pid"].as_f64().unwrap()as u32)||!counter(&v["attachedAt"])||v.get("detachedAt").is_some_and(|t|!counter(t)||t.as_f64()<v["attachedAt"].as_f64())||!names(&v["axNotifications"])){return Err(refused());}
        for key in["instruction","taskId","taskActorAtAttach","taskSourceSnapshotRoot","stopReason"]{if value.get(key).is_some_and(|v|!text(v)){return Err(refused());}}
        if value.get("taskAttachedAt").is_some_and(|v|!counter(v))||value.get("taskDetachedAt").is_some_and(|v|!counter(v)||value.get("taskAttachedAt").is_none()||v.as_f64()<value["taskAttachedAt"].as_f64()){return Err(refused());}
        Ok(value)
    }
    fn events(&self,sid:&str,limit:usize,complete:bool)->io::Result<Vec<Value>>{
        self.meta(sid)?;let directory=self.archive(sid)?;let file=private_file(&directory.join("events.jsonl"),false)?;
        if file.metadata()?.len()>DESKTOP_MONITOR_MAX_ARCHIVE_BYTES as u64{return Err(io::Error::new(io::ErrorKind::FileTooLarge,"monitor archive exceeds 100MiB"));}
        let mut reader=BufReader::new(file.take(DESKTOP_MONITOR_MAX_ARCHIVE_BYTES as u64+1));let mut rows=VecDeque::new();let mut expected=0;let mut previous_time=0.0;
        loop{let mut line=vec![];let count=reader.by_ref().take(DESKTOP_MONITOR_MAX_RESULT_BYTES as u64+1).read_until(b'\n',&mut line)?;if count==0{break;}
            if count>DESKTOP_MONITOR_MAX_RESULT_BYTES||line.last()!=Some(&b'\n'){return Err(io::Error::other("monitor archive contains an oversized or interrupted event; original was preserved"));}
            let event:Value=serde_json::from_slice(&line)?;
            // Decode the existing header while retaining flat source payloads.
            let header=event.as_object().ok_or_else(||io::Error::other("monitor event must be an object"))?.iter().filter(|(key,_)|["sid","s","t","event","timestamp","taskId"].contains(&key.as_str())).map(|(key,value)|(key.clone(),value.clone())).collect::<serde_json::Map<String,Value>>();
            let header:DesktopMonitorEventHeader=serde_json::from_value(Value::Object(header))?;
            if header.sid!=sid||header.s!=expected as f64||[header.s,header.t].iter().any(|n|!n.is_finite()||n.fract()!=0.0||*n<0.0||*n>9007199254740991.0)||header.t<previous_time||header.event.is_empty()||header.event.encode_utf16().count()>128{return Err(io::Error::other("monitor archive event identity/order is invalid"));}
            event_payload(&event)?;
            previous_time=header.t;expected+=1;rows.push_back(event);if rows.len()>limit{if complete{return Err(io::Error::new(io::ErrorKind::FileTooLarge,"export exceeds its event bound; use the owned archive"));}rows.pop_front();}
        }Ok(rows.into_iter().collect())
    }
    fn start(&mut self,action:&Value)->Value{
        if self.sessions.len()>=DESKTOP_MONITOR_MAX_SESSIONS{return failure("resource_limit","at most 16 native recordings may be active");}
        let includes=strings(action,"include");let excludes=strings(action,"exclude");
        let explicit_frames=action["frames"].as_f64().unwrap_or(0.)>0.;
        let vision_text=action["visionText"]==true;
        let video_fps=action["video"].as_f64().filter(|n|n.is_finite()&&*n>0.);
        let frames_requested=explicit_frames||vision_text||video_fps.is_some();
        let save_frames=explicit_frames||vision_text;
        // One frame pipeline feeds saved frames, OCR and the video: sample at the fastest rate asked for.
        let effective_fps=[action["frames"].as_f64().unwrap_or(0.),video_fps.unwrap_or(0.),if vision_text{1.}else{0.}].into_iter().fold(0f64,f64::max).max(1.);
        let sources=["lifecycle","ax","workspace","input"].into_iter().chain(includes.iter().map(String::as_str)).chain(frames_requested.then_some("frames")).filter(|source|*source=="lifecycle"||!excludes.contains(*source)).collect::<BTreeSet<_>>();
        if sources.len()>63{return failure("resource_limit","recording source coverage exceeds 63 entries (one recovery entry is reserved); no recording was created");}
        if matches!(action["speechMode"].as_str(),Some("live"|"offline"))||includes.contains("speech"){
            return failure("unsupported_operation","this build has no offline speech recognizer; configure the whisper.cpp engine or use the browser live-transcription path");
        }
        // --tap wants passive global input. Wayland exposes no such protocol, and this build ships no
        // global input hook; scope to an app's accessibility input events (include "input") instead.
        if action["tap"]==true{return failure("unsupported_operation","passive global input capture (--tap) is unavailable on this host; record an app's accessibility input events instead (the default scope includes them)");}
        let scope=if action["allApps"]==true{json!({"mode":"all"})}else if let Some(app)=action["app"].as_str(){json!({"mode":"apps","apps":[app]})}else if action.get("apps").is_some(){json!({"mode":"apps","apps":action["apps"]})}else{json!({"mode":"frontmost"})};
        if frames_requested{
            if scope["mode"]!="apps"||scope["apps"].as_array().is_none_or(|apps|apps.len()!=1){return failure("unsupported_operation","native recording frames require one explicit application; broader scopes are not qualified and no display fallback was used");}
            if action["framePixelScale"].as_f64().is_some_and(|scale|scale!=1.){return failure("unsupported_operation","native recording uses physical pixels; only explicit frame-pixel-scale 1 is supported");}
            if excludes.contains("frames")||excludes.contains("frame"){return failure("invalid_request","requested frames conflict with excluded frame source/events");}
            if self.sessions.values().filter(|recording|recording.frames.as_ref().is_some_and(|frames|frames.enabled)).count()>=4{return failure("resource_limit","at most four independent recording frame streams may be active");}
        }
        let mut watches=vec![];
        if includes.contains("files")&&!excludes.contains("files"){
            let mut paths=strings(action,"watchPaths");if let Some(path)=action["watchPath"].as_str(){paths.insert(path.into());}
            if paths.is_empty(){return failure("invalid_request","file recording requires explicit watch-path/watch-paths; no implicit home-directory collection");}
            if paths.len()>64{return failure("invalid_request","recording supports at most 64 combined watch paths");}
            for path in paths{let path=PathBuf::from(path);if !path.is_absolute(){return failure("invalid_request","recording watch paths must be absolute");}
                match crate::files::native::Watch::new(&path){Ok(watch)=>watches.push((path,watch)),Err(error)=>return error}
            }
        }
        let clipboard=if includes.contains("clipboard")&&!excludes.contains("clipboard"){
            let result=crate::clipboard::snapshot();if result["success"]!=true{return result;}
            match result["data"]["changeCount"].as_u64(){Some(count)=>Some(count),None=>return failure("provider_failed","native clipboard snapshot omitted its change identity")}
        }else{None};
        let sid=identifier();let directory=self.root.join(&sid);
        let frames=if frames_requested{
            let mut frame_options=action.clone();frame_options["frames"]=json!(effective_fps);if video_fps.is_some(){frame_options["frameFormat"]=json!("jpeg");}
            let(owner,_)=Observer::new(sid.clone(),scope.clone(),action);let mut frames=Frames::new(owner,&frame_options);
            let result=start_frames(&frames.action,frames.owner.clone());if result["success"]!=true{return result;}frames.attached=true;Some(frames)
        }else{None};
        if directory.exists(){return failure("resource_limit","recording identifier collision; no existing archive was changed");}
        if let Err(e)=private_directory(&directory,true,false){return io_error(e);}
        let events=match private_file(&directory.join("events.jsonl"),true){Ok(file)=>file,Err(e)=>return io_error(e)};
        let video=if video_fps.is_some(){match crate::stream_media::Recording::start_in(directory.join("video"),&sid,json!({"recording":"monitor","app":scope["apps"][0],"fps":effective_fps})){Ok(r)=>Some(r),Err(e)=>return e}}else{None};
        let mut coverage=vec![json!({"source":"lifecycle","available":true,"provider":"native-recording-worker"})];
        if video.is_some(){coverage.push(json!({"source":"video","available":true,"provider":"native-frame-capture/MJPEG-Matroska","limits":["one selected window; monotonic capture-arrival timing; 100MiB / 1h bound; no audio track"]}));}
        if vision_text{coverage.push(json!({"source":"ocr_text","available":true,"provider":if cfg!(windows){"Windows.Media.Ocr"}else{"Tesseract CPU"},"limits":["OCR runs on each saved frame; requires frame capture","no confidence score on Windows OCR (null)"]}));}
        if frames.is_some(){coverage.push(json!({"source":"frames","available":true,"provider":if cfg!(windows){"Windows.Graphics.Capture/D3D11"}else{"X11.Composite/XRes"},"limits":["one selected window in the explicit application; retained target identity; no display fallback","requested FPS is an upper sampling bound; native physical pixels; no upscaling","default 7200 frames; default/maximum 100MiB media; four independent streams; PNG/JPEG/lossless WebP","opt-in images retain visible application pixels; secure text redaction covers AX values, not arbitrary images","Windows capture indicator remains visible; HDR/Wayland qualification is separate"]}));}
        if !watches.is_empty(){coverage.push(json!({"source":"files","available":true,"provider":if cfg!(windows){"retained-Win32-file-watches"}else{"retained-inotify-watches"},"limits":["nonrecursive; native events may coalesce"]}));}
        if clipboard.is_some(){coverage.push(json!({"source":"clipboard","available":true,"provider":"native-clipboard-snapshot","limits":["250ms polling; intermediate changes may coalesce; previews only"]}));}
        let mut observer=None;
        if !excludes.contains("ax")||!excludes.contains("workspace"){
            let(sink,receiver)=Observer::new(sid.clone(),scope.clone(),action);
            let result=observe(sink.clone());
            if result["success"]==true{
                if let Some(sources)=result["data"]["coverage"].as_array(){coverage.extend(sources.iter().cloned());}
                observer=Some((sink,receiver));
            }else{
                sink.generation.store(0,Ordering::Release);
                for source in ["ax","workspace"].into_iter().filter(|source|!excludes.contains(*source)){
                    coverage.push(json!({"source":source,"available":false,"reason":format!("native subscription refused: {}",result["code"].as_str().unwrap_or("provider_failed"))}));
                }
            }
        }
        for source in sources.into_iter().filter(|source|!matches!(*source,"lifecycle"|"files"|"clipboard"|"ax"|"workspace")&&!(*source=="frames"&&frames_requested)){
            coverage.push(json!({"source":source,"available":false,"reason":"native recording subscription is not implemented in this build"}));
        }
        let partial=coverage.iter().any(|source|source["available"]==false);
        let mut meta=json!({"artifactVersion":1,"surface":"desktop","host":host(),"provider":"interceptor-desktop-rust","providerPid":std::process::id(),"login":self.login,"sessionId":sid,"startedAt":now(),"status":"active","paused":false,"counts":{"evt":0,"mut":0,"net":0,"nav":0,"ax":0},"attachments":[],"scope":scope,"includes":includes,"excludes":excludes,"coverage":coverage,"partial":partial});
        for key in ["instruction","taskId"]{if action.get(key).is_some(){meta[key]=action[key].clone();}}
        meta["options"]=action.clone();
        let mut recording=Recording{meta,directory,events,bytes:0,seq:0,paused:false,started:Instant::now(),watches,clipboard,excludes,observer,frames,save_frames,vision_text,video};
        if let Err(e)=recording.event("mon_start",json!({"scope":scope,"coverage":coverage,"partial":partial})).and_then(|_|save_meta(&recording.directory,&recording.meta)){return io_error(e);}
        if recording.video.is_some(){let path=recording.video.as_ref().unwrap().path().to_path_buf();if let Err(e)=recording.event("video_start",json!({"path":path,"fps":effective_fps})){return io_error(e);}}
        if let Some((observer,_))=&recording.observer{observer.generation.store(1,Ordering::Release);}
        if let Some(frames)=&recording.frames{frames.owner.generation.store(1,Ordering::Release);}
        let mut data=recording.status();data["sessionDir"]=json!(recording.directory);data["activeCount"]=json!(self.sessions.len()+1);
        if action.get("taskId").is_some(){data["taskId"]=action["taskId"].clone();}
        self.sessions.insert(sid,recording);bounded(data)
    }
    fn dispatch(&mut self,action:&Value)->Value{
        let sub=action["sub"].as_str().unwrap();if sub=="start"{return self.start(action);}
        if sub=="list"{
            let limit=action["limit"].as_f64().unwrap_or(1000.)as usize;let names=match self.names(){Ok(v)=>v,Err(e)=>return io_error(e)};
            let mut rows=vec![];for sid in names.into_iter().rev(){if rows.len()==limit{break;}match self.owned_meta(&sid){Ok(Some(mut meta))=>{meta.as_object_mut().unwrap().remove("options");meta["sid"]=json!(sid);rows.push(meta)},Ok(None)=>(),Err(e)=>return io_error(e)}}return bounded(json!(rows));
        }
        let sid=action["sid"].as_str().map(str::to_owned).or_else(||if self.sessions.len()==1{self.sessions.keys().next().cloned()}else{None});
        if sub=="status"&&action.get("sid").is_none(){return bounded(if self.sessions.is_empty(){json!({"status":"idle"})}else{json!({"sessions":self.sessions.values().map(Recording::status).collect::<Vec<_>>(),"activeCount":self.sessions.len()})});}
        let Some(sid)=sid else{return failure("target_ambiguous","monitor requires an exact sid unless exactly one recording is active");};
        if matches!(sub,"tail"|"export"){
            let complete=sub=="export";let limit=if complete{DESKTOP_MONITOR_MAX_ENTRIES}else{action["limit"].as_f64().unwrap_or(50.)as usize};
            let events=match self.events(&sid,limit,complete){Ok(v)=>v,Err(e)=>return io_error(e)};
            if sub=="tail"||action["format"]=="json"{return bounded(json!(events));}
            if action["format"]=="plan"{let meta=match self.meta(&sid){Ok(meta)=>meta,Err(error)=>return io_error(error)};return bounded(json!(replay_plan(&events,&meta,cfg!(windows))));}
            let lines=events.iter().map(|event|format!("{} {} {}",event["t"],event["event"].as_str().unwrap_or(""),serde_json::to_string(event).unwrap())).collect::<Vec<_>>();return bounded(json!(lines.join("\n")));
        }
        let Some(recording)=self.sessions.get_mut(&sid)else{return failure("target_gone","no active recording matches the requested sid");};
        if sub=="status"{return bounded(recording.status());}
        if matches!(sub,"pause"|"resume"){
            if let Some(frames)=recording.frames.as_mut().filter(|frames|frames.enabled){
                if sub=="pause"{
                    frames.owner.generation.store(2,Ordering::Release);
                    let result=frame_control(&json!({"sid":sid,"sub":"stop"}));if result["success"]!=true{return result;}
                    frames.attached=false;
                }
            }
            if let Some((observer,receiver))=&recording.observer{
                if sub=="pause"{if let Some(epoch)=observer.epoch(){observer.generation.store(epoch+1,Ordering::Release);}}
                if sub=="resume"&&recording.paused{
                    let result=observation_control("__monitor_flush",&observer.sid);if result["success"]!=true{return result;}
                    while receiver.try_recv().is_ok(){}
                }
            }
            if sub=="resume"{
                // Drain changes collected during the pause before reopening the
                // write gate. A short pause must not leak its pending changes.
                for(_,watch)in &mut recording.watches{if let Err(error)=watch.poll(){return error;}}
                if recording.clipboard.is_some(){let snapshot=crate::clipboard::snapshot();if snapshot["success"]!=true{return snapshot;}recording.clipboard=snapshot["data"]["changeCount"].as_u64();}
                if recording.paused{if let Some(frames)=recording.frames.as_mut().filter(|frames|frames.enabled){
                    let result=start_frames(&frames.action,frames.owner.clone());if result["success"]!=true{return result;}
                    frames.attached=true;
                    frames.opened=Instant::now();frames.pending=true;frames.last_poll=Instant::now()-Duration::from_secs(1);
                }}
            }
            recording.paused=sub=="pause";recording.meta["paused"]=json!(recording.paused);
            if sub=="resume"{if let Some((observer,_))=&recording.observer{let epoch=observer.generation.load(Ordering::Acquire);if epoch>0&&epoch%2==0{observer.generation.store(epoch+1,Ordering::Release);}}}
            if sub=="resume"{if let Some(frames)=recording.frames.as_ref().filter(|frames|frames.enabled){frames.owner.generation.store(3,Ordering::Release);}}
            if let Err(e)=recording.event(if recording.paused{"mon_pause"}else{"mon_resume"},json!({})).and_then(|_|save_meta(&recording.directory,&recording.meta)){return io_error(e);}
            return bounded(json!({"sid":sid,"status":if recording.paused{"paused"}else{"recording"}}));
        }
        if sub=="stop"{let result=recording.stop("user_stop");self.sessions.remove(&sid);return match result{Ok(v)=>bounded(v),Err(e)=>io_error(e)};}
        failure("unsupported_operation","unknown native recording operation")
    }
    fn frames_tick(&mut self){
        let mut failed=vec![];
        for(sid,recording)in &mut self.sessions{
            if recording.paused{continue;}
            let Some(frames)=recording.frames.as_mut().filter(|frames|frames.enabled&&frames.last_poll.elapsed()>=frames.interval)else{continue;};
            frames.last_poll=Instant::now();
            let result=frame_control(&frames.action);
            let error=if result["success"]!=true{Some(result.clone())}else if result["data"].is_null()&&frames.pending&&frames.opened.elapsed()>=Duration::from_secs(10){Some(failure("provider_failed","recording source delivered no initial frame within 10 seconds"))}else{None};
            let recorded=if let Some(error)=error{recording.frame_failed(&error)}else if !result["data"].is_null(){recording.frame(&result["data"]).and_then(|_|save_meta(&recording.directory,&recording.meta))}else{Ok(())};
            if recorded.is_err(){failed.push(sid.clone());}
        }
        for sid in failed{if let Some(mut recording)=self.sessions.remove(&sid){let _=recording.stop("frame_recording_write_failed");}}
    }
    fn tick(&mut self){
        let mut failed=vec![];
        // Read the clipboard only when its change number moved.
        let sequence=crate::clipboard::sequence();
        let clipboard_snapshot=self.sessions.values().any(|r|r.clipboard.is_some_and(|last|sequence!=Some(last))).then(crate::clipboard::snapshot);
        for(sid,r)in &mut self.sessions{
            let mut observations=vec![];
            if let Some((observer,receiver))=&r.observer{
                for _ in 0..256{let Ok(event)=receiver.try_recv()else{break;};if observer.epoch()==Some(event.generation){observations.push((event.event,event.data));}}
                let dropped=observer.dropped.swap(0,Ordering::AcqRel);
                if dropped>0{observations.push(("source_error",json!({"source":"native_observation","dropped":dropped})));failed.push((sid.clone(),"native_source_overflow"));}
            }
            // Drain native watch queues while paused, without recording them.
            for(path,watch)in &mut r.watches{match watch.poll(){Ok(true)=>observations.push(("file_change",json!({"path":path}))),Ok(false)=>(),Err(error)=>{observations.push(("source_error",json!({"source":"files","error":error})));failed.push((sid.clone(),"file_source_failed"));}}}
            if let Some(last)=r.clipboard.filter(|last|sequence!=Some(*last)){
                let snapshot=clipboard_snapshot.as_ref().unwrap();if snapshot["success"]==true{if let Some(count)=snapshot["data"]["changeCount"].as_u64(){if count!=last{r.clipboard=Some(count);observations.push(("clipboard_change",snapshot["data"].clone()));}}}
                else{observations.push(("source_error",json!({"source":"clipboard","error":snapshot})));failed.push((sid.clone(),"clipboard_source_failed"));}
            }
            let changed=!observations.is_empty();
            for(event,data)in observations{if r.event(event,data).is_err(){failed.push((sid.clone(),"recording_write_failed"));break;}}
            if changed&&save_meta(&r.directory,&r.meta).is_err(){failed.push((sid.clone(),"recording_metadata_failed"));}
            if r.started.elapsed()>=Duration::from_secs(86400){failed.push((sid.clone(),"max_duration"));}
        }
        for(sid,reason)in failed{if let Some(mut recording)=self.sessions.remove(&sid){let _=recording.stop(reason);}}
    }
}
pub fn dispatch(action:&Value)->Value{
    if let Err(error)=validate(action){return error;}
    let Some(current)=login()else{return failure("no_interactive_session","native recording requires the authenticated graphical login; no recording was created");};
    type Request=(Value,Instant,mpsc::Sender<Value>);
    static WORKER:OnceLock<Result<mpsc::SyncSender<Request>,String>>=OnceLock::new();
    let worker=WORKER.get_or_init(||{
        let mut runtime=Runtime::open(root().map_err(|e|e.to_string())?,current.clone()).map_err(|e|e.to_string())?;let(tx,rx)=mpsc::sync_channel::<Request>(32);
        std::thread::spawn(move||{let mut last=Instant::now();loop{
            if login().as_deref()!=Some(runtime.login.as_str()){for(_,mut recording)in std::mem::take(&mut runtime.sessions){let _=recording.stop("login_revoked");}break;}
            if last.elapsed()>=Duration::from_millis(250){runtime.tick();last=Instant::now();}
            runtime.frames_tick();
            match rx.recv_timeout(Duration::from_millis(20)){
                Ok((action,deadline,reply))=>{let result=if Instant::now()>=deadline{failure("cancelled","recording request expired before execution; no new effect was sent")}else{runtime.dispatch(&action)};let _=reply.send(result);},
                Err(mpsc::RecvTimeoutError::Timeout)=>(),Err(mpsc::RecvTimeoutError::Disconnected)=>break,
            }
        }});Ok(tx)
    });
    let worker=match worker{Ok(v)=>v,Err(e)=>return failure("permission_denied",e)};let(tx,rx)=mpsc::channel();
    if worker.try_send((action.clone(),Instant::now()+Duration::from_secs(10),tx)).is_err(){return failure("resource_limit","recording worker queue is full or revoked");}
    rx.recv_timeout(Duration::from_secs(10)).unwrap_or_else(|_|failure("timeout_unknown_outcome","recording request exceeded its deadline; observe before retrying"))
}
pub fn capability(session:&str)->Value{json!({"operation":"monitor","compiled":true,"present":true,"effective":false,"background":"semantic","permission":"not_applicable","session":session,"provider":"interceptor-desktop-rust","versions":{"contract":"1"},"limits":["Scoped UIAutomation/AT-SPI accessibility and window lifecycle events; private ordered archives; independent file watches; opt-in clipboard previews","Secure AX values masked; system helpers excluded by native application name unless requested; no global device input","16 sessions; 1000 tail/history entries; 100MiB journal; 1MiB replies; 63 source entries plus recovery; 24-hour automatic stop","Explicit single-app Windows/X11 still frames use independent streams; default 7200 frames; maximum 100MiB private media; four streams; no display fallback or pixel upscaling","Plans resolve fresh exact app/name/role before typing; Windows pwsh 7.3+ or POSIX shell with jq; masked/bounded/CLI-reserved values and other observations are explicit comments","Raw device input, video/OCR/speech and optional log/network/notification recording are not yet implemented"],"reason":"Inspect each recording's explicit source coverage; this build does not establish full native recording parity."})}

#[cfg(test)]mod tests{
    #[cfg(any(unix,windows))]#[test]fn private_retained_reader_compares_native_identity_and_actual_written_bytes(){
        use std::io::{Seek,SeekFrom};
        let root=std::env::temp_dir().join(format!("interceptor-retained-file-{}",identifier()));private_directory(&root,true,false).unwrap();
        let path=root.join("owned.bin");let other=root.join("other.bin");
        let mut writer=private_file(&path,true).unwrap();let mut reader=retained_private_reader(&writer,&path).unwrap();
        let mut foreign=private_file(&other,true).unwrap();foreign.write_all(b"foreign").unwrap();foreign.sync_all().unwrap();
        assert!(!same_private_file(&writer,&foreign).unwrap());
        writer.write_all(b"actual bytes").unwrap();writer.sync_all().unwrap();reader.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes=vec![];reader.read_to_end(&mut bytes).unwrap();assert_eq!(bytes,b"actual bytes");assert!(same_private_file(&writer,&reader).unwrap());assert!(private_path_matches(&writer,&path).unwrap());
        #[cfg(windows)]{assert!(fs::rename(&path,root.join("moved.bin")).is_err());assert!(fs::remove_file(&path).is_err());}
        #[cfg(target_os="linux")]{
            let moved=root.join("moved.bin");fs::rename(&path,&moved).unwrap();let mut replacement=private_file(&path,true).unwrap();replacement.write_all(b"replacement").unwrap();drop(replacement);
            assert!(!private_path_matches(&writer,&path).unwrap());reader.seek(SeekFrom::Start(0)).unwrap();bytes.clear();reader.read_to_end(&mut bytes).unwrap();assert_eq!(bytes,b"actual bytes");assert_eq!(fs::read(&path).unwrap(),b"replacement");
        }
        drop(reader);drop(writer);drop(foreign);fs::remove_dir_all(root).unwrap();
    }
    use super::*;
    fn metadata_fixture(sid:&str,active:bool)->Value{
        let mut meta=json!({"artifactVersion":1,"surface":"desktop","host":host(),"provider":"interceptor-desktop-rust","providerPid":std::process::id(),"login":"owned-metadata-login","sessionId":sid,"startedAt":1000,"status":if active{"active"}else{"stopped"},"paused":false,"counts":{"evt":1,"mut":0,"net":0,"nav":0,"ax":0},"attachments":[],"scope":{"mode":"all"},"includes":[],"excludes":[],"coverage":[{"source":"lifecycle","available":true}],"partial":false,"options":{"type":"desktop_monitor","sub":"start","allApps":true}});
        if !active{meta["endedAt"]=json!(2000);}meta
    }
    #[test]fn replay_plans_resolve_fresh_exact_targets_preserve_literals_and_refuse_incomplete_or_secure_values(){
        let payload="$(printf EXPANDED)`printf EXPANDED`$INTERCEPTOR_TEST_PLAN_VAR \"quote\" \\ apostrophe' \u{2018}\u{2019}\u{201A}\u{201B} 文件\nsecond line";
        let meta=json!({"sessionId":"owned123","partial":true,"instruction":"caption\nprintf HEADER_EXECUTED\r\ntrailer"});
        let events=vec![json!({"event":"mon_start"}),json!({"event":"input","app":"owned-app","r":"AXTextField","n":"Owned input","v":payload,"ref":"e999","pid":777,"secure":false}),
            json!({"event":"input","app":"owned-app","r":"AXTextField","n":"SECURE-NAME","v":"SECURE-VALUE-CANARY","secure":true}),
            json!({"event":"input","app":"owned-app","r":"AXTextField","n":"Owned input","v":"x".repeat(256)}),
            json!({"event":"input","app":"owned-app","r":"AXTextField","n":"Owned input","v":"--pid"}),json!({"event":"file_change"})];
        for windows in [false,true]{let plan=replay_plan(&events,&meta,windows);assert_eq!(plan.matches("interceptor desktop type").count(),1);assert!(plan.contains("--background-only"));assert!(!plan.contains("SECURE-VALUE-CANARY")&&!plan.contains("SECURE-NAME")&&!plan.contains("e999")&&!plan.contains("777")&&!plan.contains("app activate")&&!plan.contains("--activate"));assert!(plan.contains("# Observation only: file_change")&&plan.contains("# Input omitted: secure")&&plan.contains("# Instruction: caption printf HEADER_EXECUTED  trailer"));
            if windows{assert!(plan.contains("#requires -Version 7.3")&&plan.contains("$PSNativeCommandArgumentPassing = 'Standard'")&&plan.contains("apostrophe''")&&plan.contains("\u{2018}\u{2018}\u{2019}\u{2019}\u{201A}\u{201A}\u{201B}\u{201B}")&&plan.contains("ConvertFrom-Json")&&plan.contains(".Count -ne 1"));}
        }
        #[cfg(unix)]{
            let plan=replay_plan(&events,&meta,false);
            let entry=json!({"ref":"e321","pid":42,"name":"Owned input","role":"textfield","secure":false});
            let mut secure_entry=entry.clone();secure_entry["secure"]=json!(true);
            let script=format!("interceptor() {{ if [ \"$1\" = --json ]; then printf '%s\\n' \"$INTERCEPTOR_TEST_PLAN_FIND\"; else printf '%s\\0' \"$@\"; fi; }}\n{plan}");
            for matches in [json!([entry.clone()]),json!([]),json!([entry.clone(),entry.clone()]),json!([secure_entry])]{
                let output=std::process::Command::new("/bin/sh").args(["-c",&script]).env("INTERCEPTOR_TEST_PLAN_FIND",matches.to_string()).env("INTERCEPTOR_TEST_PLAN_VAR","EXPANDED").output().unwrap();
                if matches.as_array().unwrap().len()==1&&matches[0]["secure"]==false{assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));assert_eq!(String::from_utf8(output.stdout).unwrap().split('\0').collect::<Vec<_>>(),vec!["desktop","type","e321",payload,"--pid","42","--background-only",""]);}
                else{assert!(!output.status.success());assert!(output.stdout.is_empty(),"no mutation after ambiguous/missing/secure match");}
            }
        }
    }
    #[test]fn native_observation_gates_scope_secure_payloads_late_callbacks_and_overflow(){
        let(observer,receiver)=Observer::new("owned123".into(),json!({"mode":"apps","apps":["owned-app"]}),&json!({"excludeApps":["excluded-app"]}));
        assert!(observer.accepts(42,"OWNED-APP",false));assert!(!observer.accepts(42,"other-app",true));assert!(!observer.accepts(std::process::id(),"owned-app",true));
        let secure=json!({"pid":42,"role":"AXTextField","name":"PASSWORD-NAME-CANARY","value":"PASSWORD-VALUE-CANARY","secure":true});
        observer.emit(1,"input","ax","owned-app",secure.clone(),"value-change");assert!(receiver.try_recv().is_err());
        observer.generation.store(1,Ordering::Release);
        observer.emit(1,"input","ax","owned-app",secure.clone(),"value-change");let event=receiver.try_recv().unwrap();assert_eq!(event.data["v"],"***SECURE***");assert_eq!(event.data["n"],"***SECURE***");assert!(!event.data.to_string().contains("CANARY"));
        observer.generation.store(2,Ordering::Release);observer.emit(1,"input","ax","owned-app",secure.clone(),"late-before-pause");assert!(receiver.try_recv().is_err());
        observer.generation.store(3,Ordering::Release);observer.emit(1,"input","ax","owned-app",secure.clone(),"late-after-resume");assert!(receiver.try_recv().is_err());
        observer.emit(3,"focus","ax","owned-app",secure.clone(),"focus");assert!(receiver.try_recv().unwrap().data.get("v").is_none());
        for _ in 0..257{observer.emit(3,"input","ax","owned-app",secure.clone(),"queue-bound");}assert_eq!(observer.dropped.load(Ordering::Acquire),1);assert_eq!(receiver.try_iter().count(),256);
        observer.generation.store(0,Ordering::Release);observer.emit(3,"input","ax","owned-app",secure,"late-after-stop");assert!(receiver.try_recv().is_err());
        let(frontmost,_)=Observer::new("owned456".into(),json!({"mode":"frontmost"}),&json!({}));assert!(frontmost.accepts(42,"app",true));assert!(!frontmost.accepts(42,"app",false));
        let(all,_)=Observer::new("owned789".into(),json!({"mode":"all"}),&json!({"excludeApps":["excluded-app"]}));assert!(!all.accepts(42,"EXCLUDED-APP",true));assert!(all.accepts(42,"other-app",false));
        let system=if cfg!(windows){"TextInputHost"}else{"waybar"};assert!(!all.accepts(42,system,true));
        let(opt_in,_)=Observer::new("owned-system".into(),json!({"mode":"all"}),&json!({"includeSystemApps":true,"excludeApps":[system]}));assert!(!opt_in.accepts(42,system,true));
        let(opt_in,_)=Observer::new("owned-system2".into(),json!({"mode":"all"}),&json!({"includeSystemApps":true}));assert!(opt_in.accepts(42,system,true));
        #[cfg(windows)]{let(excluded,_)=Observer::new("owned-alias".into(),json!({"mode":"all"}),&json!({"excludeApps":["OWNED-APP.EXE"]}));assert!(!excluded.accepts(42,"owned-app",true));}
    }
    #[test]fn recording_boundary_and_owned_archive_preserve_identity_order_pause_and_privacy(){
        for fields in[json!({"sid":"../owned"}),json!({"sid":"owned/child"}),json!({"sid":null}),json!({"limit":-1}),json!({"limit":1001}),json!({"limit":1.5}),json!({"unexpected":true})]{let mut a=json!({"type":"desktop_monitor","sub":"tail"});a.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());assert_eq!(validate(&a).unwrap_err()["code"],"invalid_request");}
        let root=std::env::temp_dir().join(format!("interceptor-monitor-unit-{}",identifier()));let mut runtime=Runtime::open(root.clone(),"owned-unit-login".into()).unwrap();
        assert!(Runtime::open(root.clone(),"other-unit-login".into()).is_err(),"one retained lock owns native recording recovery");
        let sid="aaa11111";let directory=root.join(sid);private_directory(&directory,true,false).unwrap();let events=private_file(&directory.join("events.jsonl"),true).unwrap();
        let mut meta=metadata_fixture(sid,true);meta["counts"]["evt"]=json!(0);meta["scope"]=json!({"mode":"apps","apps":["owned-fixture"]});meta["options"]=json!({"type":"desktop_monitor","sub":"start","app":"owned-fixture"});
        let mut r=Recording{meta,directory:directory.clone(),events,bytes:0,seq:0,paused:false,started:Instant::now(),watches:vec![],clipboard:None,excludes:BTreeSet::new(),observer:None,frames:None,save_frames:false,vision_text:false,video:None};
        r.event("mon_start",json!({"scope":{"mode":"all"},"coverage":[{"source":"lifecycle","available":true}],"partial":false})).unwrap();save_meta(&directory,&r.meta).unwrap();assert_eq!(runtime.events(sid,10,true).unwrap().len(),1,"an active archive remains readable while its writer is retained");r.paused=true;r.event("input",json!({"v":"MUST-NOT-BE-WRITTEN"})).unwrap();r.event("mon_pause",json!({})).unwrap();r.paused=false;r.event("input",json!({"source":"ax","app":"Owned fixture","pid":1,"r":"AXTextField","n":"***SECURE***","secure":true,"notification":"Owned change","v":"***SECURE***"})).unwrap();r.stop("user_stop").unwrap();drop(r);
        let rows=runtime.events(sid,10,true).unwrap();assert_eq!(rows.len(),4);assert_eq!(rows.iter().map(|v|v["s"].as_u64().unwrap()).collect::<Vec<_>>(),vec![0,1,2,3]);assert!(!fs::read_to_string(directory.join("events.jsonl")).unwrap().contains("MUST-NOT-BE-WRITTEN"));assert_eq!(runtime.events(sid,0,false).unwrap().len(),0);assert!(runtime.archive("../owned").is_err());
        let history=runtime.dispatch(&json!({"type":"desktop_monitor","sub":"list"}));assert!(history["data"][0].get("options").is_none(),"private recording options are not public archive fields");assert_eq!(runtime.meta(sid).unwrap()["options"]["app"],"owned-fixture","list preserves the original stored options");
        #[cfg(unix)]{use std::os::unix::fs::{symlink,PermissionsExt};let link=root.join("linked");symlink(&directory,&link).unwrap();assert!(runtime.archive("linked").is_err());fs::remove_file(link).unwrap();let hard=root.join("event-copy");fs::hard_link(directory.join("events.jsonl"),&hard).unwrap();assert!(runtime.events(sid,10,true).is_err());fs::remove_file(hard).unwrap();fs::set_permissions(directory.join("events.jsonl"),fs::Permissions::from_mode(0o644)).unwrap();assert!(runtime.events(sid,10,true).is_err());fs::set_permissions(directory.join("events.jsonl"),fs::Permissions::from_mode(0o600)).unwrap();
            // A browser-owned parent can be searchable while each native
            // archive and file remains private. No existing mode is changed.
            fs::set_permissions(&root,fs::Permissions::from_mode(0o755)).unwrap();
            let browser=root.join("browser123");fs::create_dir(&browser).unwrap();fs::write(browser.join("session.json"),br#"{"surface":"browser","sessionId":"browser123"}"#).unwrap();assert!(runtime.owned_meta("browser123").unwrap().is_none());
        }
        let crash_sid="interrupted123";let crash_dir=root.join(crash_sid);private_directory(&crash_dir,true,false).unwrap();
        let mut event_file=private_file(&crash_dir.join("events.jsonl"),true).unwrap();event_file.write_all(b"interrupted original event bytes\n{partial").unwrap();drop(event_file);
        let prior=metadata_fixture(crash_sid,true);save_meta(&crash_dir,&prior).unwrap();
        let prior_bytes=fs::read(crash_dir.join("session.json")).unwrap();drop(runtime);
        let recovered=Runtime::open(root.clone(),"next-owned-unit-login".into()).unwrap();
        let meta=recovered.meta(crash_sid).unwrap();assert_eq!(meta["status"],"stopped");assert_eq!(meta["stopReason"],"provider_interrupted");assert_eq!(meta["partial"],true);
        let preserved=fs::read_dir(&crash_dir).unwrap().map(|e|e.unwrap().path()).find(|path|path.file_name().unwrap().to_string_lossy().starts_with("interrupted-session-")).unwrap();
        assert_eq!(fs::read(preserved).unwrap(),prior_bytes);assert_eq!(fs::read(crash_dir.join("events.jsonl")).unwrap(),b"interrupted original event bytes\n{partial");assert!(recovered.events(crash_sid,10,true).is_err());
        drop(recovered);fs::remove_dir_all(root).unwrap();
    }
    #[test]fn archive_metadata_rejects_malformed_shapes_semantics_and_private_options_before_reads(){
        let root=std::env::temp_dir().join(format!("interceptor-monitor-metadata-{}",identifier()));let mut runtime=Runtime::open(root.clone(),"owned-metadata-login".into()).unwrap();
        let sid="ownedmetadata123";let directory=root.join(sid);private_directory(&directory,true,false).unwrap();
        let original=metadata_fixture(sid,false);
        let events=format!("{}\n",json!({"sid":sid,"s":0,"t":0,"event":"owned_extension"}));let mut file=private_file(&directory.join("events.jsonl"),true).unwrap();file.write_all(events.as_bytes()).unwrap();drop(file);
        let mut accepted=vec![];
        for(label,fields)in[("wrong version",json!({"artifactVersion":2})),("counter exceeds total",json!({"counts":{"evt":1,"mut":0,"net":0,"nav":0,"ax":2}})),("end before start",json!({"endedAt":999})),("active with end",json!({"status":"active"})),("empty apps scope",json!({"scope":{"mode":"apps","apps":[]}})),("invalid private options",json!({"options":{"type":"desktop_monitor","sub":"start","frames":true}})),
            ("unknown field",json!({"unexpected":true})),("null pause",json!({"paused":null})),("unsafe timestamp",json!({"startedAt":9007199254740992_u64})),("fractional counter",json!({"counts":{"evt":1,"mut":0.5,"net":0,"nav":0,"ax":0}})),("all scope with apps",json!({"scope":{"mode":"all","apps":["owned"]}})),("duplicate include",json!({"includes":["files","files"]})),("empty coverage",json!({"coverage":[]})),("duplicate coverage",json!({"coverage":[{"source":"lifecycle","available":true},{"source":"lifecycle","available":true}]})),("false partial",json!({"partial":true})),("invalid provider",json!({"provider":"other"})),("zero provider pid",json!({"providerPid":0})),("empty login",json!({"login":""})),("zero root pid",json!({"rootPid":0})),("empty instruction",json!({"instruction":""})),("missing task attach",json!({"taskDetachedAt":1})),("invalid attachment",json!({"attachments":[{"key":"pid:2","pid":1,"attachedAt":1,"axNotifications":[]}]})),("private non-start options",json!({"options":{"type":"desktop_monitor","sub":"tail"}}))]{
            let mut meta=original.clone();meta.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());save_meta(&directory,&meta).unwrap();let bytes=fs::read(directory.join("session.json")).unwrap();
            if runtime.meta(sid).is_ok(){accepted.push(format!("{label}: metadata reader"));}
            for action in[json!({"sub":"tail","sid":sid,"limit":5}),json!({"sub":"tail","sid":sid,"limit":0}),json!({"sub":"export","sid":sid,"format":"json"}),json!({"sub":"export","sid":sid,"format":"timeline"}),json!({"sub":"export","sid":sid,"format":"plan"}),json!({"sub":"list"})]{if runtime.dispatch(&action)["success"]==true{accepted.push(format!("{label}: {action}"));}}
            assert!(runtime.recover().is_err(),"recovery accepted {label}");assert_eq!(fs::read_dir(&directory).unwrap().count(),2,"refusal creates no recovery copy");
            assert_eq!(fs::read(directory.join("session.json")).unwrap(),bytes);assert_eq!(fs::read_to_string(directory.join("events.jsonl")).unwrap(),events);
        }
        save_meta(&directory,&original).unwrap();assert_eq!(runtime.meta(sid).unwrap(),original);assert_eq!(runtime.events(sid,5,true).unwrap().len(),1);
        for fields in[json!({"artifactVersion":1.0}),json!({"paused":true}),json!({"taskId":"owned-task","taskAttachedAt":1000,"taskDetachedAt":2000}),json!({"coverage":[{"source":"lifecycle","available":true},{"source":"input","available":false,"reason":"unqualified"}],"partial":true})]{let mut valid=original.clone();valid.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());save_meta(&directory,&valid).unwrap();assert_eq!(runtime.meta(sid).unwrap(),valid);assert_eq!(runtime.events(sid,5,true).unwrap().len(),1);}
        let mut active=metadata_fixture(sid,true);active["coverage"]=json!([{"source":"recovery","available":true}]);save_meta(&directory,&active).unwrap();assert!(runtime.recover().is_err());
        active["coverage"]=json!((0..64).map(|i|json!({"source":format!("owned-{i}"),"available":true})).collect::<Vec<_>>());save_meta(&directory,&active).unwrap();assert!(runtime.recover().is_err());assert_eq!(fs::read_dir(&directory).unwrap().count(),2);
        active["coverage"]=json!((0..63).map(|i|json!({"source":format!("owned-{i}"),"available":true})).collect::<Vec<_>>());save_meta(&directory,&active).unwrap();let prior=fs::read(directory.join("session.json")).unwrap();runtime.recover().unwrap();let recovered=runtime.meta(sid).unwrap();assert_eq!(recovered["coverage"].as_array().unwrap().len(),64);assert_eq!(recovered["status"],"stopped");assert_eq!(fs::read_to_string(directory.join("events.jsonl")).unwrap(),events);let copy=fs::read_dir(&directory).unwrap().map(|e|e.unwrap().path()).find(|p|p.file_name().unwrap().to_string_lossy().starts_with("interrupted-session-")).unwrap();assert_eq!(fs::read(copy).unwrap(),prior);
        drop(runtime);fs::remove_dir_all(root).unwrap();assert!(accepted.is_empty(),"accepted malformed metadata: {accepted:?}");
    }
    #[test]fn archive_headers_reject_invalid_types_safe_integers_names_and_time_order(){
        let root=std::env::temp_dir().join(format!("interceptor-monitor-headers-{}",identifier()));let runtime=Runtime::open(root.clone(),"owned-header-login".into()).unwrap();
        let sid="ownedheaders123";let directory=root.join(sid);private_directory(&directory,true,false).unwrap();
        save_meta(&directory,&metadata_fixture(sid,false)).unwrap();
        let path=directory.join("events.jsonl");drop(private_file(&path,true).unwrap());
        let valid=json!({"sid":sid,"s":0,"t":1,"event":"owned_header_fixture","sourcePayload":{"owned":true}});let mut accepted=vec![];
        for (label,fields) in [("negative timestamp",json!({"t":-1})),("unsafe timestamp",json!({"t":9007199254740992_u64})),("empty event",json!({"event":""})),("long event",json!({"event":"x".repeat(129)})),("UTF16 long event",json!({"event":"🙂".repeat(65)})),("null timestamp text",json!({"timestamp":null})),("numeric timestamp text",json!({"timestamp":17})),("nonstring task ID",json!({"taskId":true}))]{
            let mut row=valid.clone();row.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());let bytes=format!("{row}\n");fs::write(&path,&bytes).unwrap();
            if runtime.events(sid,10,true).is_ok(){accepted.push(label);}assert_eq!(fs::read_to_string(&path).unwrap(),bytes,"refusal preserves original bytes");
        }
        let bytes=format!("{}\n{}\n",json!({"sid":sid,"s":0,"t":3,"event":"owned_header_fixture"}),json!({"sid":sid,"s":1,"t":2,"event":"owned_header_fixture"}));fs::write(&path,&bytes).unwrap();if runtime.events(sid,10,true).is_ok(){accepted.push("regressing timestamp");}assert_eq!(fs::read_to_string(&path).unwrap(),bytes);
        fs::write(&path,format!("{valid}\n")).unwrap();assert_eq!(runtime.events(sid,10,true).unwrap(),vec![valid]);
        drop(runtime);fs::remove_dir_all(root).unwrap();assert!(accepted.is_empty(),"accepted malformed archive headers: {accepted:?}");
    }
    #[test]fn archive_source_payloads_validate_shared_shapes_identity_privacy_and_preserve_bytes(){
        let root=std::env::temp_dir().join(format!("interceptor-monitor-payloads-{}",identifier()));let runtime=Runtime::open(root.clone(),"owned-payload-login".into()).unwrap();
        let sid="ownedpayloads123";let directory=root.join(sid);private_directory(&directory,true,false).unwrap();save_meta(&directory,&metadata_fixture(sid,false)).unwrap();
        let path=directory.join("events.jsonl");drop(private_file(&path,true).unwrap());
        let fixtures:Value=serde_json::from_str(include_str!("../../shared/desktop-monitor-payload-fixtures.json")).unwrap();let header=json!({"sid":sid,"s":0,"t":1,"timestamp":"","taskId":"owned"});
        let input=fixtures["valid"].as_array().unwrap().iter().find(|row|row["event"]=="input").unwrap();
        let mut bad=fixtures["invalid"].as_array().unwrap().clone();
        for fields in[json!({"v":17}),json!({"v":null}),json!({"pid":0}),json!({"pid":1.5}),json!({"pid":4294967296_u64}),json!({"source":"workspace"}),json!({"secure":true}),json!({"frame":{"x":0,"y":0,"width":-1,"height":1}}),json!({"windowId":0}),json!({"windowId":1.5}),json!({"unexpected":true})]{let mut row=input.clone();row.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());bad.push(row);}
        let mut missing=input.clone();missing.as_object_mut().unwrap().remove("v");bad.push(missing.clone());
        let mut good=fixtures["valid"].as_array().unwrap().clone();
        for event in["focus","selection","menu_open","menu_close","title_change","layout_change","ax_other","frontmost","app_deactivate","window_min","window_demin","window_create","window_destroy"]{let mut row=missing.clone();row["event"]=json!(event);if ["frontmost","app_deactivate","window_min","window_demin","window_create","window_destroy"].contains(&event){row["source"]=json!("workspace");}good.push(row);}
        let mut accepted=vec![];
        for(expected,payload)in good.into_iter().map(|row|(true,row)).chain(bad.into_iter().map(|row|(false,row))){let mut row=header.clone();row.as_object_mut().unwrap().extend(payload.as_object().unwrap().clone());let bytes=format!("{row}\n");fs::write(&path,&bytes).unwrap();
            let result=runtime.events(sid,10,true);if result.is_ok()!=expected{accepted.push(format!("{expected}: {row}: {result:?}"));}
            assert_eq!(fs::read_to_string(&path).unwrap(),bytes,"payload reads preserve original bytes");if let Ok(rows)=result{assert_eq!(rows,vec![row]);}
        }
        drop(runtime);fs::remove_dir_all(root).unwrap();assert!(accepted.is_empty(),"source payload mismatches: {accepted:?}");
    }
    #[cfg(unix)]#[test]fn archive_fifo_is_refused_without_waiting_for_a_writer(){
        use std::os::unix::fs::OpenOptionsExt;
        let root=std::env::temp_dir().join(format!("interceptor-monitor-fifo-{}",identifier()));private_directory(&root,true,false).unwrap();let path=root.join("events.jsonl");
        let native=std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();assert_eq!(unsafe{libc::mkfifo(native.as_ptr(),0o600)},0);
        let(tx,rx)=mpsc::channel();let reader_path=path.clone();let reader=std::thread::spawn(move||{tx.send(private_file(&reader_path,false).map(|_|())).unwrap();});
        let first=rx.recv_timeout(Duration::from_secs(1));let refused_without_writer=first.is_ok();
        // Release a regressed blocking reader before failing, so the check
        // cannot leave a blocked test thread or owned FIFO behind.
        let result=match first{Ok(result)=>result,Err(_)=>{let _writer=fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK|libc::O_NOFOLLOW).open(&path).unwrap();rx.recv_timeout(Duration::from_secs(1)).unwrap()}};
        reader.join().unwrap();fs::remove_dir_all(root).unwrap();assert!(refused_without_writer,"archive open waited for a FIFO writer");assert_eq!(result.unwrap_err().kind(),io::ErrorKind::PermissionDenied);
    }
    #[test]fn failed_recording_marks_saved_coverage_partial_without_exceeding_its_bound(){
        let root=std::env::temp_dir().join(format!("interceptor-monitor-failure-{}",identifier()));private_directory(&root,true,false).unwrap();
        for(reason,source)in[("file_source_failed","files"),("clipboard_source_failed","clipboard"),("native_source_overflow","native_observation"),("recording_write_failed","recording"),("recording_metadata_failed","recording"),("login_revoked","recording")]{
            let directory=root.join(reason);private_directory(&directory,true,false).unwrap();let events=private_file(&directory.join("events.jsonl"),true).unwrap();
            let mut coverage=(0..62).map(|n|json!({"source":format!("source{n}"),"available":true})).collect::<Vec<_>>();coverage.push(json!({"source":"files","available":true}));
            let meta=json!({"sessionId":reason,"counts":{"evt":0},"coverage":coverage,"partial":false});
            let mut recording=Recording{meta,directory:directory.clone(),events,bytes:0,seq:0,paused:false,started:Instant::now(),watches:vec![],clipboard:None,excludes:BTreeSet::new(),observer:None,frames:None,save_frames:false,vision_text:false,video:None};
            recording.stop(reason).unwrap();drop(recording);
            let stored:Value=serde_json::from_slice(&fs::read(directory.join("session.json")).unwrap()).unwrap();assert_eq!(stored["status"],"stopped");assert_eq!(stored["partial"],true);assert_eq!(stored["stopReason"],reason);
            let rows=stored["coverage"].as_array().unwrap();assert_eq!(rows.len(),if source=="files"{63}else{64});assert_eq!(rows.iter().filter(|row|row["source"]==source).count(),1);
            let failed=rows.iter().find(|row|row["source"]==source).unwrap();assert_eq!(failed["available"],false);assert_eq!(failed["reason"],reason);assert_eq!(stored["counts"]["evt"],1);
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]fn frames_preserve_real_pixels_pause_limits_private_outputs_and_source_failures(){
        let root=std::env::temp_dir().join(format!("interceptor-monitor-frames-{}",identifier()));private_directory(&root,true,false).unwrap();
        let pixels=image::RgbaImage::from_fn(8,4,|x,_|image::Rgba(if x<4{[255,0,0,255]}else{[0,0,255,255]}));
        let encoded=crate::capture::encode(&pixels,"png",80).unwrap();
        let data=json!({"format":"png","width":8,"height":4,"bytes":encoded.len(),"dataUrl":format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(&encoded))});
        for mode in ["ordinary","count","disk","combined","collision","failure"]{
            let directory=root.join(mode);private_directory(&directory,true,false).unwrap();
            let mut meta=metadata_fixture(mode,true);meta["counts"]=json!({"evt":0,"mut":0,"net":0,"nav":0,"ax":0});meta["coverage"]=json!([{"source":"lifecycle","available":true},{"source":"frames","available":true}]);
            let(owner,_)=Observer::new(mode.into(),json!({"mode":"apps","apps":["Owned fixture"]}),&json!({}));owner.generation.store(1,Ordering::Release);
            let mut frames=Frames::new(owner.clone(),&json!({"frames":1,"frameFormat":"png","frameBudget":10}));
            if mode=="count"{frames.budget=1;}if mode=="disk"{frames.cap=encoded.len()as u64-1;}
            let events=private_file(&directory.join("events.jsonl"),true).unwrap();
            let mut recording=Recording{meta,directory:directory.clone(),events,bytes:0,seq:0,paused:false,started:Instant::now(),watches:vec![],clipboard:None,excludes:BTreeSet::new(),observer:None,frames:Some(frames),save_frames:true,vision_text:false,video:None};
            let media=directory.join("media");let path=media.join("000000.png");
            if mode=="combined"{recording.bytes=(DESKTOP_MONITOR_MAX_ARCHIVE_BYTES-2*DESKTOP_MONITOR_MAX_RESULT_BYTES)as u64;recording.frame(&data).unwrap();assert!(!media.exists());assert!(!recording.frames.as_ref().unwrap().enabled);assert_eq!(recording.seq,1);}
            else if mode=="disk"{recording.frame(&data).unwrap();assert!(!media.exists());assert_eq!(recording.frames.as_ref().unwrap().bytes,0);assert_eq!(recording.seq,1);assert!(!recording.frames.as_ref().unwrap().enabled);}
            else if mode=="collision"{
                private_directory(&media,true,false).unwrap();let mut existing=private_file(&path,true).unwrap();existing.write_all(b"owned original collision").unwrap();drop(existing);
                assert!(recording.frame(&data).is_err());assert_eq!(fs::read(&path).unwrap(),b"owned original collision");assert_eq!(recording.frames.as_ref().unwrap().count,0);assert_eq!(recording.seq,0);
            }else if mode=="failure"{
                let mut malformed=data.clone();malformed["bytes"]=json!(encoded.len()+1);assert!(recording.frame(&malformed).is_err());assert!(!media.exists());
                recording.frame_failed(&failure("target_gone","Owned target exited")).unwrap();assert_eq!(recording.meta["coverage"][1]["available"],false);assert_eq!(recording.meta["partial"],true);assert!(!recording.frames.as_ref().unwrap().enabled);
            }else{
                recording.frame(&data).unwrap();assert_eq!(fs::read(&path).unwrap(),encoded);let decoded=image::load_from_memory(&fs::read(&path).unwrap()).unwrap().to_rgba8();assert_eq!(decoded.dimensions(),(8,4));assert_eq!(decoded.get_pixel(1,1),pixels.get_pixel(1,1));assert_eq!(decoded.get_pixel(6,1),pixels.get_pixel(6,1));
                #[cfg(unix)]{use std::os::unix::fs::MetadataExt;assert_eq!(fs::metadata(&path).unwrap().mode()&0o777,0o600);assert_eq!(fs::metadata(&media).unwrap().mode()&0o777,0o700);}
                let before=recording.seq;recording.paused=true;recording.frame(&data).unwrap();assert_eq!(recording.seq,before);assert_eq!(fs::read_dir(&media).unwrap().count(),1);recording.paused=false;
                if mode=="count"{assert_eq!(before,2);assert!(!recording.frames.as_ref().unwrap().enabled);recording.frame(&data).unwrap();assert_eq!(recording.seq,before);assert_eq!(owner.generation.load(Ordering::Acquire),0);}
                else{
                    assert_eq!(before,1);recording.frames.as_mut().unwrap().bytes=DESKTOP_MONITOR_MAX_ARCHIVE_BYTES as u64;assert!(recording.event("owned_extension",json!({})).is_err());recording.frames.as_mut().unwrap().bytes=encoded.len()as u64;
                    #[cfg(unix)]{let next=media.join("000001.png");std::os::unix::fs::symlink(&path,&next).unwrap();assert!(recording.frame(&data).is_err());assert_eq!(fs::read(&path).unwrap(),encoded);assert_eq!(recording.seq,before);}
                }
            }
            drop(recording);assert_eq!(owner.generation.load(Ordering::Acquire),0);
            for line in fs::read_to_string(directory.join("events.jsonl")).unwrap().lines(){event_payload(&serde_json::from_str(line).unwrap()).unwrap();}
        }
        fs::remove_dir_all(root).unwrap();
    }
}
