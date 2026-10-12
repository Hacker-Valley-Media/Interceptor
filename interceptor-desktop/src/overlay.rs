use crate::{failure, success, overlay_validation as validation};
use serde_json::{Value, json};
use std::{collections::HashMap, io, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, AtomicU64, Ordering}, mpsc}, time::{Duration, Instant}};

struct Command { action: Value, response: mpsc::SyncSender<Value> }
struct Session {
    id: String, generation: String, mode: String,
    commands: mpsc::SyncSender<Command>, busy: AtomicBool, retired: AtomicBool,
    metadata: Mutex<Value>, reserved_pixels:AtomicU64,
}
static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> { SESSIONS.get_or_init(|| Mutex::new(HashMap::new())) }
fn exact(id: &str) -> Result<Arc<Session>, Value> {
    sessions().lock().unwrap().get(id).cloned().ok_or_else(|| failure("target_gone", "overlay ID has no retained native generation"))
}
fn release(session: &Arc<Session>) {
    session.retired.store(true, Ordering::Release);
    let mut owners = sessions().lock().unwrap();
    if owners.get(&session.id).is_some_and(|s| Arc::ptr_eq(s,session)) { owners.remove(&session.id); }
}
fn receive(output: &mut std::process::ChildStdout, deadline: Instant, session: &Session) -> io::Result<Value> {
    let bytes = crate::auth::bounded_child_result(|bytes| {
        if session.retired.load(Ordering::Acquire) { return Err(io::ErrorKind::ConnectionAborted.into()); }
        crate::auth::ready_read(output,bytes)
    },deadline,validation::RESULT_BYTES+8192)?;
    let reply: Value = serde_json::from_slice(&bytes)?;
    if !validation::bounded(&reply,validation::RESULT_BYTES+8192) { return Err(io::Error::other("overlay helper reply is oversized or malformed")); }
    Ok(reply)
}
fn worker(session: Arc<Session>, action: Value, commands: mpsc::Receiver<Command>, ready: mpsc::SyncSender<Value>) {
    let mut ready = Some(ready);
    let result = (|| -> io::Result<()> {
        let mut helper = crate::thumbnail::OwnedHelper::spawn("--overlay-engine")?;
        let mut input = helper.child.0.stdin.take().ok_or_else(|| io::Error::other("overlay helper input missing"))?;
        let mut output = helper.child.0.stdout.take().ok_or_else(|| io::Error::other("overlay helper output missing"))?;
        crate::write_frame(&mut input,&serde_json::to_vec(&json!({"generation":session.generation,"action":action}))?)?;
        let deadline=Instant::now()+Duration::from_secs(35);
        let admission=receive(&mut output,deadline,&session)?;
        if admission["generation"]!=session.generation{return Err(io::Error::other("overlay admission generation differs"));}
        if admission["ticket"]=="start"&&admission["result"]["success"]==false{if let Some(ready)=ready.take(){let _=ready.send(admission["result"].clone());}return Err(io::Error::other("native overlay preflight failed"));}
        if admission["ticket"]!="admission"||admission["result"]["success"]!=true{return Err(io::Error::other("overlay preflight receipt is invalid"));}
        let pixels=admission["result"]["data"]["pixels"].as_u64().filter(|n|*n>0&&*n<=67108864).ok_or_else(||io::Error::other("native overlay backing pixel admission is invalid"))?;
        {
            let owners=sessions().lock().unwrap();
            let total=owners.values().map(|s|s.reserved_pixels.load(Ordering::Acquire)).sum::<u64>();
            if session.retired.load(Ordering::Acquire)||total.checked_add(pixels).is_none_or(|n|n>67108864){if let Some(ready)=ready.take(){let _=ready.send(failure("resource_limit","aggregate overlay backing-pixel admission exceeds 64Mi pixels; no native window created"));}return Err(io::Error::other("aggregate overlay pixel admission failed"));}
            session.reserved_pixels.store(pixels,Ordering::Release);
        }
        crate::write_frame(&mut input,&serde_json::to_vec(&json!({"generation":session.generation,"ticket":"admission","allow":true}))?)?;
        let response = receive(&mut output,deadline,&session)?;
        if response["generation"] != session.generation || response["ticket"] != "start" { return Err(io::Error::other("overlay start receipt identity differs")); }
        let result = response["result"].clone();
        if result["success"] != true {
            if let Some(ready) = ready.take() { let _ = ready.send(result); }
            return Err(io::Error::other("native overlay start failed"));
        }
        *session.metadata.lock().unwrap() = result["data"].clone();
        session.busy.store(false,Ordering::Release);
        if let Some(ready) = ready.take() { let _ = ready.send(result); }
        loop {
            if session.retired.load(Ordering::Acquire) || helper.exited()?.is_some() { break; }
            let command = match commands.recv_timeout(Duration::from_millis(100)) {
                Ok(c) => c, Err(mpsc::RecvTimeoutError::Timeout) => continue, Err(_) => break,
            };
            if session.retired.load(Ordering::Acquire) { let _=command.response.send(failure("target_gone","overlay retired before command delivery")); break; }
            let ticket = crate::secret_target::random_token().map_err(io::Error::other)?;
            let deadline = Instant::now()+Duration::from_secs_f64(if command.action["sub"] == "eval" {command.action["timeout_seconds"].as_f64().unwrap_or(10.0)} else {10.0});
            let reply = (|| -> io::Result<Value> {
                crate::write_frame(&mut input,&serde_json::to_vec(&json!({"generation":session.generation,"ticket":ticket,"action":command.action}))?)?;
                let response = receive(&mut output,deadline,&session)?;
                if response["generation"] != session.generation || response["ticket"] != ticket { return Err(io::Error::other("overlay command receipt identity differs")); }
                if response["result"]["success"] != true && response["result"]["success"] != false { return Err(io::Error::other("overlay command omitted its result")); }
                Ok(response["result"].clone())
            })();
            match reply {
                Ok(result) => {
                    if command.action["sub"] == "status" && result["success"] == true { *session.metadata.lock().unwrap()=result["data"].clone(); }
                    session.busy.store(false,Ordering::Release);
                    let _=command.response.send(result);
                }
                Err(_) => {
                    session.retired.store(true,Ordering::Release);
                    // Revoke the whole private helper rather than replaying an
                    // evaluation whose native callback has not been observed.
                    drop(helper);
                    let _=command.response.send(failure("timeout_unknown_outcome","native overlay command ended without a complete receipt; its helper was terminated and reaped; observe external effects before retrying"));
                    return Ok(());
                }
            }
        }
        drop(helper); Ok(())
    })();
    // Every path above drops the helper (including its process group/job)
    // before releasing this generation's ID admission.
    release(&session);
    if let Some(ready)=ready { let _=ready.send(failure(if result.is_err(){"provider_failed"}else{"target_gone"},"overlay ended before a complete native start receipt; its helper was reaped")); }
}
fn mode(a: &Value) -> &'static str {
    if a.get("particles").is_some() { "particles" } else if a.get("scene").is_some() { "scene" }
    else if a.get("scene_script").is_some() || a.get("scene_script_file").is_some() { "scene-script" } else { "html" }
}
fn start(a: &Value) -> Value {
    let mut action = match validation::prepare(a) { Ok(a)=>a,Err(e)=>return e };
    let generation = match crate::secret_target::random_token() { Ok(s)=>s,Err(e)=>return failure("provider_failed",e) };
    let id=action["id"].as_str().map(str::to_owned).unwrap_or_else(||generation[..16].to_owned()); action["id"]=json!(id);
    let (sender,receiver)=mpsc::sync_channel(1); let (ready,result)=mpsc::sync_channel(1);
    let session=Arc::new(Session{id:id.clone(),generation,mode:mode(&action).into(),commands:sender,busy:AtomicBool::new(true),retired:AtomicBool::new(false),metadata:Mutex::new(json!({"id":id,"lifecycle":"starting"})),reserved_pixels:AtomicU64::new(0)});
    { let mut owners=sessions().lock().unwrap(); if owners.contains_key(&id){return failure("resource_limit","overlay ID is already owned; no native work queued");} if owners.len()>=16{return failure("resource_limit","overlay ownership limit is 16 generations");} owners.insert(id,session.clone()); }
    let owned=session.clone();
    if std::thread::Builder::new().name("overlay-owner".into()).spawn(move||worker(owned,action,receiver,ready)).is_err(){release(&session);return failure("resource_limit","overlay owner thread admission failed");}
    match result.recv_timeout(Duration::from_secs(37)) { Ok(v)=>v,Err(_)=>{session.retired.store(true,Ordering::Release);failure("timeout_unknown_outcome","overlay start deadline expired; cleanup remains generation-owned; inspect list before retrying")} }
}
fn send(session: &Arc<Session>, action: Value) -> Value {
    if session.retired.load(Ordering::Acquire) { return failure("target_gone","overlay generation is retiring"); }
    if session.busy.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_err(){return failure("resource_limit","this overlay already has unresolved native work; no command queued");}
    let (sender,receiver)=mpsc::sync_channel(1);
    let wait=Duration::from_secs_f64(if action["sub"]=="eval"{action["timeout_seconds"].as_f64().unwrap_or(10.0)+2.0}else{12.0});
    match session.commands.try_send(Command{action,response:sender}) {
        Ok(())=>match receiver.recv_timeout(wait){Ok(v)=>v,Err(_)=>failure("timeout_unknown_outcome","overlay reply deadline expired; native work remains owned; inspect before retrying")},
        Err(_)=>{session.busy.store(false,Ordering::Release);failure("target_gone","overlay owner is unavailable; nothing queued")}
    }
}
fn stop(id: Option<&str>) -> Value {
    let owners=sessions().lock().unwrap().values().filter(|s|id.is_none_or(|id|s.id==id)).cloned().collect::<Vec<_>>();
    if id.is_some() && owners.is_empty(){return failure("target_gone","overlay ID has no retained generation");}
    for s in &owners{s.retired.store(true,Ordering::Release);}
    let deadline=Instant::now()+Duration::from_secs(5);
    loop {
        let pending=owners.iter().filter(|s|sessions().lock().unwrap().get(&s.id).is_some_and(|current|Arc::ptr_eq(current,s))).map(|s|json!({"id":s.id,"generation":s.generation})).collect::<Vec<_>>();
        if pending.is_empty(){return success(json!({"stopped":owners.iter().map(|s|s.id.clone()).collect::<Vec<_>>(),"nativeCleanupPending":[]}));}
        if Instant::now()>=deadline{let mut result=failure("timeout_unknown_outcome","overlay cleanup remains generation-owned; no clean stop acknowledgement issued");result["details"]=json!({"pending":pending});return result;}
        std::thread::sleep(Duration::from_millis(10));
    }
}
pub(crate) fn shutdown() -> Value { stop(None) }
pub(crate) fn dispatch(a: &Value) -> Value {
    let sub=match validation::validate(a){Ok(s)=>s,Err(e)=>return e};
    if sub=="start"{return start(a);} if sub=="stop"{return stop(a["id"].as_str());}
    if sub=="list" {
        let owners=sessions().lock().unwrap().values().cloned().collect::<Vec<_>>();
        let mut rows=Vec::new();for owner in owners {
            let mut row=owner.metadata.lock().unwrap().clone();
            // Inventory never queues native work. A status call explicitly
            // requests a fresh observation for exactly one retained owner.
            row["observation"]=json!("last completed native start/status receipt");
            row["generation"]=json!(owner.generation);row["nativePending"]=json!(owner.busy.load(Ordering::Acquire));row["lifecycle"]=json!(if owner.retired.load(Ordering::Acquire){"retiring"}else if row["lifecycle"]=="starting"{"starting"}else{"active"});rows.push(row);
        }
        rows.sort_by(|a,b|a["id"].as_str().cmp(&b["id"].as_str()));return success(json!(rows));
    }
    let owner=if let Some(id)=a["id"].as_str(){match exact(id){Ok(s)=>s,Err(e)=>return e}}else{
        let owners=sessions().lock().unwrap();if owners.len()!=1{return failure("target_ambiguous","overlay selector requires an ID unless exactly one generation is retained");}owners.values().next().unwrap().clone()
    };
    if sub=="verbs"{return success(json!({"id":owner.id,"mode":owner.mode,"verbs":validation::spec()["controls"][&owner.mode].as_object().map(|o|o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default()}));}
    let mut a=a.clone();a["id"]=json!(owner.id);
    if sub=="ctl" { let args=match validation::control(&owner.mode,a["verb"].as_str().unwrap(),a.get("args").unwrap_or(&Value::Null)){Ok(v)=>v,Err(e)=>return e};a["args"]=args; }
    send(&owner,a)
}
pub(crate) fn helper(parent: u32) -> io::Result<()> {
    crate::thumbnail::retain_provider(parent)?;
    #[cfg(target_os="linux")] {
        // WebKitWebProcess inherits this. It idles at ~510 MB VmData (150 MB resident) on Omarchy, so
        // 512 MiB made JSC GC thread creation abort the renderer; 2 GiB still bounds a runaway page.
        let limit=libc::rlimit{rlim_cur:2048*1024*1024,rlim_max:2048*1024*1024};
        if unsafe{libc::setrlimit(libc::RLIMIT_DATA,&limit)}!=0{return Err(io::Error::other("overlay helper data-memory admission failed"));}
    }
    let frame=crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("overlay helper requires its first request"))?;
    if frame.len()>validation::REQUEST_BYTES+8192{return Err(io::Error::other("overlay helper start exceeds its bound"));}
    let request:Value=serde_json::from_slice(&frame)?;
    let generation=request["generation"].as_str().filter(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit())).ok_or_else(||io::Error::other("overlay helper generation is invalid"))?.to_owned();
    let action=request["action"].clone();
    if validation::validate(&action).is_err()||action["sub"]!="start"{return Err(io::Error::other("overlay helper requires a validated start"));}
    #[cfg(all(any(windows,target_os="linux"),feature="overlay"))]return crate::overlay_native::run(action,generation);
    #[cfg(not(all(any(windows,target_os="linux"),feature="overlay")))]{let _=(action,generation);Err(io::Error::other("this build has no overlay engine; the overlay helper (interceptor-overlay) renders overlays"))}
}
/// Whether this host can run the overlay engine, and why not. Linux checks the sibling
/// helper and that its WebKitGTK/gtk-layer-shell libraries resolve (cached for a minute,
/// because every hello asks).
fn readiness() -> (bool, bool, Option<String>) {
    #[cfg(windows)] { return (true, true, None); }
    #[cfg(target_os = "linux")] {
        static CACHE: OnceLock<Mutex<Option<(Instant, (bool, bool, Option<String>))>>> = OnceLock::new();
        let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap();
        if let Some((at, value)) = cache.as_ref() && at.elapsed() < Duration::from_secs(60) { return value.clone(); }
        let engine = if cfg!(feature = "overlay") { std::env::current_exe().ok() } else { std::env::current_exe().ok().map(|e| e.with_file_name("interceptor-overlay")) };
        let value = match engine.filter(|e| e.is_file()) {
            None => (false, false, Some("the overlay helper interceptor-overlay is not installed beside the provider".to_owned())),
            Some(engine) => {
                let missing = std::process::Command::new("ldd").arg(&engine).output().map(|o| String::from_utf8_lossy(&o.stdout).lines()
                    .filter(|l| l.contains("not found")).map(|l| l.trim().split(' ').next().unwrap_or("").to_owned()).collect::<Vec<_>>()).unwrap_or_default();
                if missing.is_empty() { (true, true, None) } else {
                    (true, false, Some(format!("overlay libraries are missing: {} (install webkit2gtk-4.1 and gtk-layer-shell)", missing.join(", "))))
                }
            }
        };
        *cache = Some((Instant::now(), value.clone()));
        return value;
    }
    #[allow(unreachable_code)] (false, false, Some("macOS uses the Swift overlay provider".to_owned()))
}
pub(crate) fn capability(session: &str) -> Value {
    let (present, effective, reason) = readiness();
    let mut row = capability_row(session, present, effective);
    if let Some(reason) = reason { row["reason"] = json!(reason); }
    row
}
fn capability_row(session: &str, present: bool, effective: bool) -> Value {
    json!({"operation":"overlay","compiled":cfg!(any(windows,target_os="linux")),"present":present,"effective":effective,"permission":"unknown","session":session,"background":"semantic","provider":if cfg!(windows){"WebView2 / retained native window"}else{"GTK3 / WebKitGTK / layer-shell"},"versions":{"contract":"1","wry":"0.57.0","tao":"0.37.1","gtk-layer-shell":"0.8.2"},"limits":["Source candidate; build, runtime prerequisites and installed qualification remain open","16 generation-owned overlays; 256KiB request; 128KiB result; one unresolved native action per owner; no command replay","Windows requires WebView2; Linux requires WebKitGTK 4.1 and GTK3; Wayland additionally requires actual layer-shell support","GNOME Shell backend, exact Wayland tracking, face landmarks/expressions and platform level/workspace parity remain open; Windows/X11 face bounds have an unqualified pinned CPU source path"]})
}
