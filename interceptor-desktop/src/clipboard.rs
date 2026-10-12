use crate::{failure,success};
use serde_json::{Value,json};
use std::{fs::File,io::{Write,Seek,SeekFrom},path::PathBuf,sync::{Mutex,OnceLock},time::Duration};
use unicode_segmentation::UnicodeSegmentation;

pub fn preview(text:&str)->String {
    text.graphemes(true).take(crate::contract_generated::DESKTOP_CLIPBOARD_PREVIEW_CHARACTERS).collect()
}

pub fn validate(action:&Value)->Result<(),Value> {
    if let Some(error)=crate::contract_generated::desktop_clipboard_shape_error(action) {return Err(failure("invalid_request",error));}
    if action["sub"]=="write" && !action["text"].is_string() {return Err(failure("invalid_request","clipboard write requires text"));}
    if action.get("text").is_some_and(|v|v.as_str().is_none_or(|s|s.contains('\0'))) {return Err(failure("invalid_request","clipboard text cannot contain NUL"));}
    if action.get("limit").is_some_and(|v|v.as_f64().is_none_or(|n|!n.is_finite()||n.fract()!=0.0||!(0.0..=500.0).contains(&n))) {return Err(failure("invalid_request","clipboard history limit must be an integer in 0..500"));}
    Ok(())
}
pub fn bounded(data:Value)->Value {
    let result=success(data);
    if serde_json::to_vec(&result).is_ok_and(|b|b.len()<=crate::contract_generated::DESKTOP_MAX_RESULT_BYTES) {result}
    else {failure("resource_limit","clipboard result exceeds the desktop frame budget")}
}
struct Monitoring {last:u64,history:Vec<Value>,file:File,path:PathBuf,error:Option<String>}
static MONITOR:OnceLock<Mutex<Monitoring>>=OnceLock::new();
static START:Mutex<()>=Mutex::new(());

fn native(action:&Value)->Value {
    #[cfg(windows)] {crate::windows::dispatch("clipboard",action)}
    #[cfg(target_os="linux")] {crate::linux::dispatch("clipboard",action)}
    #[cfg(not(any(windows,target_os="linux")))] {let _=action;failure("unsupported_operation","macOS uses the Swift clipboard provider")}
}
/// The clipboard's change number without opening it or reading any data; None where the host has no
/// such counter. Pollers read the clipboard only when it changes: a full read waits for the owner to
/// render delayed formats (UTM's vdagent: 3 s, then nothing), holding the clipboard and the shared UI
/// Automation worker the whole time, so a 250 ms poll made every other verb wait.
pub(crate) fn sequence()->Option<u64> {
    #[cfg(windows)] {Some(crate::clipboard_windows::sequence())}
    #[cfg(not(windows))] {None}
}
pub(crate) fn snapshot()->Value {
    // On the caller's thread (its own hidden clipboard window), not the UI Automation worker, so a slow
    // clipboard owner never holds up other verbs.
    #[cfg(windows)] {crate::clipboard_windows::execute("__clipboard_snapshot",&json!({}))}
    #[cfg(target_os="linux")] {crate::linux::dispatch("__clipboard_snapshot",&json!({}))}
    #[cfg(not(any(windows,target_os="linux")))] {failure("unsupported_operation","no native clipboard snapshot")}
}
pub(crate) fn event_file(kind:&str)->std::io::Result<(File,PathBuf)> {
    if !["clipboard","files","notifications"].contains(&kind){return Err(std::io::Error::other("unknown native event log kind"));}
    #[cfg(windows)] {return crate::windows::clipboard_event_file(kind);}
    #[cfg(target_os="linux")] {
        use std::os::unix::fs::{MetadataExt,OpenOptionsExt};
        let identity=crate::linux::identity()?;
        let endpoint=PathBuf::from(identity["endpoint"].as_str().ok_or_else(||std::io::Error::other("missing native endpoint"))?);
        let parent=endpoint.parent().ok_or_else(||std::io::Error::other("missing native runtime directory"))?;
        let meta=std::fs::symlink_metadata(parent)?;
        if !meta.is_dir()||meta.uid()!=unsafe{libc::geteuid()}||meta.mode()&0o777!=0o700 {return Err(std::io::Error::other("event directory must be owned and private"));}
        let path=endpoint.with_extension(format!("{kind}-events.jsonl"));
        let file=std::fs::OpenOptions::new().create(true).append(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&path)?;
        let meta=file.metadata()?;
        if !meta.is_file()||meta.uid()!=unsafe{libc::geteuid()}||meta.mode()&0o777!=0o600||meta.nlink()!=1 {return Err(std::io::Error::other("event file must be owned, private and unlinked elsewhere"));}
        return Ok((file,path));
    }
    #[cfg(not(any(windows,target_os="linux")))] {Err(std::io::Error::other("no native event file"))}
}
pub fn dispatch(action:&Value)->Value {
    if let Err(error)=validate(action) {return error;}
    #[cfg(windows)]
    if !crate::capabilities_clipboard_session() {return failure("no_interactive_session","clipboard requires the user's interactive Windows login session; no clipboard action was delivered");}
    #[cfg(target_os="linux")]
    if !crate::capabilities_clipboard_session() && !crate::clipboard_wayland::available() {return failure("background_unavailable","clipboard requires a qualified X11 or Wayland data-control backend in the current login session; no clipboard action was delivered");}
    if action["sub"]=="history" {
        let limit=action["limit"].as_f64().unwrap_or(50.0) as usize;
        if let Some(m)=MONITOR.get(){if let Some(error)=&m.lock().unwrap().error{return failure("provider_failed",error);}}
        let history=MONITOR.get().map(|m|{let m=m.lock().unwrap();m.history.iter().skip(m.history.len().saturating_sub(limit)).cloned().collect::<Vec<_>>()}).unwrap_or_default();
        return bounded(json!(history));
    }
    if action["sub"]!="tail" {return native(action);}
    let _start=START.lock().unwrap();
    if let Some(m)=MONITOR.get() {let m=m.lock().unwrap();if let Some(error)=&m.error{return failure("provider_failed",error);}return success(json!({"tailing":true,"note":"already monitoring","eventPath":m.path}));}
    let initial=snapshot();if initial["success"]!=true {return initial;}
    let (file,path)=match event_file("clipboard"){Ok(v)=>v,Err(e)=>return failure("permission_denied",format!("private clipboard event file unavailable: {e}"))};
    let last=initial["data"]["changeCount"].as_u64().unwrap_or(0);
    let _=MONITOR.set(Mutex::new(Monitoring{last,history:Vec::new(),file,path:path.clone(),error:None}));
    std::thread::spawn(||loop {
        std::thread::sleep(Duration::from_millis(250));
        if sequence().is_some_and(|count|count==MONITOR.get().unwrap().lock().unwrap().last){continue;}
        let result=snapshot();if result["success"]!=true {continue;}
        let data=&result["data"];let Some(count)=data["changeCount"].as_u64() else{continue;};
        let mut m=MONITOR.get().unwrap().lock().unwrap();if count==m.last {continue;}m.last=count;
        let timestamp=time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default();
        let entry=json!({"timestamp":timestamp,"changeCount":count,"types":data["types"],"preview":data["preview"]});
        m.history.push(entry.clone());if m.history.len()>500 {m.history.drain(..250);}
        let mut event=entry;event["event"]=json!("clipboard_change");
        if let Ok(mut bytes)=serde_json::to_vec(&event) {
            bytes.push(b'\n');
            // A bounded rolling file complements the bounded in-memory history.
            let written=(||->std::io::Result<()>{
                if m.file.metadata()?.len()+bytes.len() as u64>4*1024*1024 {m.file.set_len(0)?;}
                m.file.seek(SeekFrom::End(0))?;m.file.write_all(&bytes)
            })();
            if let Err(error)=written{m.error=Some(format!("clipboard event recording failed: {error}"));}
        }
    });
    success(json!({"tailing":true,"eventPath":path}))
}
pub fn capability(host:&str,session:&str,effective:bool)->Value {
    #[cfg(target_os="linux")] let wayland=std::env::var_os("WAYLAND_DISPLAY").is_some();
    #[cfg(not(target_os="linux"))] let wayland=false;
    #[cfg(target_os="linux")] let effective=effective||crate::clipboard_wayland::available();
    let mut result=json!({"operation":"clipboard","compiled":true,"present":true,"permission":"not_applicable","session":session,"effective":effective,
      "background":if effective{"semantic"}else{"unavailable"},"provider":if host=="win32"{"Win32 clipboard/WIC"}else{"GTK3/GDK session clipboard"},
      "versions":{"contract":"1"},"limits":["same interactive session","tail observes changes at 250 ms intervals","500 history entries","4 MiB rolling event file","Linux compositor-specific clipboard qualification remains separate"]});
    if wayland{result["provider"]=json!("Hyprland/wlr-data-control-v1");result["versions"]=json!({"contract":"1","Hyprland":"0.56.1","dataControl":"2"});result["limits"]=json!(["same user/login through retained PIDfd identity or unique logind graphical-display association","Linux 6.5 peer PIDfd and libsystemd 254 session identity APIs required","qualified Hyprland 0.56.1 commit; one Wayland seat; native data-control version 2 required","text write/read, UTF-8 RTF, local URI-list, PNG/JPEG/WebP reads, MIME inventory, clear and native change observation","2 second transfer deadline; desktop result byte budget; eight concurrent outgoing transfers; 4096 files; 32 megapixel image bound","500 history entries; 4 MiB rolling event file; tail polls at 250ms; compositor disconnect requires provider restart"]);}
    result
}

#[cfg(test)]mod tests {
    use super::*;
    #[test]fn previews_match_shared_extended_grapheme_fixtures(){
        let fixtures:Value=serde_json::from_str(include_str!("../../shared/desktop-clipboard-fixtures.json")).unwrap();
        for case in fixtures["previewCases"].as_array().unwrap(){assert_eq!(preview(case["text"].as_str().unwrap()),case["expected"].as_str().unwrap(),"{}",case["name"]);}
    }
    #[test]fn shape_and_semantic_validation_precede_native_calls(){
        for a in [json!({"type":"desktop_clipboard","sub":"write","text":"Unicode 🙂"}),json!({"type":"desktop_clipboard","sub":"history","limit":0}),json!({"type":"desktop_clipboard","sub":"read","contentType":"image"})] {assert!(validate(&a).is_ok());}
        for a in [json!({"type":"desktop_clipboard","sub":"write"}),json!({"type":"desktop_clipboard","sub":"write","text":"a\u{0000}b"}),json!({"type":"desktop_clipboard","sub":"history","limit":-1}),json!({"type":"desktop_clipboard","sub":"history","limit":0.5}),json!({"type":"desktop_clipboard","sub":"read","contentType":null}),json!({"type":"desktop_clipboard","sub":"clear","pid":42})] {assert_eq!(validate(&a).unwrap_err()["code"],"invalid_request");}
    }
}
