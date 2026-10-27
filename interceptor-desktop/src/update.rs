//! Updates for the Windows and Linux Full provider, the way Sparkle updates the Mac bridge.
//! Once a day (Sparkle's SUScheduledCheckInterval) the provider reads a feed on the update host that
//! also serves Sparkle's appcast. Sparkle's Ed25519 key signs the feed, which names the Full installer
//! and pins its SHA-256 and length. A newer release opens Interceptor's update window (update_ui.rs);
//! nothing downloads or installs until the user clicks Install Update, and nothing installs until
//! Install and Relaunch. Windows also requires the installer's Authenticode signature. The installer
//! stops and replaces this provider, so a detached copy of this binary runs it (`--update-apply`).
use crate::{contract_generated::*,failure,success};
use base64::Engine;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{io::{Read,Write},path::{Path,PathBuf},process::{Command,Stdio},sync::{Condvar,Mutex,mpsc,atomic::{AtomicBool,AtomicU64,Ordering}},time::{Duration,Instant,SystemTime,UNIX_EPOCH}};
type Result<T>=std::result::Result<T,Value>;

const HOST:&str="https://updates.hackervalley.media";
/// Sparkle's SUPublicEDKey (scripts/build-bridge.sh): one key signs the appcast and these feeds.
const FEED_KEY:&str="dnUnuHGCO4obHb44Khlf2TZQFUMmFGGpm2c6j+EqmdU=";
/// SUScheduledCheckInterval in scripts/build-bridge.sh.
const CHECK_INTERVAL:Duration=Duration::from_secs(86_400);
const FIRST_CHECK:Duration=Duration::from_secs(120);
/// UpdateDomain.swift waits this long for Sparkle's answer to `interceptor update`.
const CHECK_WAIT:Duration=Duration::from_secs(10);
const INSTALL_DEADLINE:Duration=Duration::from_secs(1800);
const MAX_FEED:u64=64*1024;
const MAX_NOTES:u64=1<<20;
const MAX_ARTIFACT:u64=1<<30;
#[cfg(windows)]const OS:&str="windows";
#[cfg(not(windows))]const OS:&str="linux";
const ARCH:&str=if cfg!(target_arch="aarch64"){"arm64"}else{"x64"};
const VERSION:&str=env!("CARGO_PKG_VERSION");

static STATE:Mutex<Option<Value>>=Mutex::new(None);
static WORK:Mutex<()>=Mutex::new(());
static WAKE:Mutex<bool>=Mutex::new(false);
static SIGNAL:Condvar=Condvar::new();
static WORKER:AtomicBool=AtomicBool::new(false);
static SESSION:AtomicBool=AtomicBool::new(false);
static STARTED_MS:AtomicU64=AtomicU64::new(0);
static CHECKS:AtomicU64=AtomicU64::new(0);
/// This process's last feed check; the schedule never counts from an older time than this.
static LAST_CHECK_MS:AtomicU64=AtomicU64::new(0);

fn now_ms()->u64{SystemTime::now().duration_since(UNIX_EPOCH).map_or(0,|d|d.as_millis() as u64)}
fn timestamp()->String{time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_else(|_|"1970-01-01T00:00:00Z".to_owned())}
fn version(input:&str)->Option<[u64;3]>{
    let input=input.strip_prefix('v').unwrap_or(input);if input.len()>32{return None;}
    let parts=input.split('.').collect::<Vec<_>>();if parts.len()!=3{return None;}let mut result=[0;3];
    for(i,p)in parts.iter().enumerate(){if p.is_empty()||p.len()>6||p.len()>1&&p.starts_with('0')||!p.bytes().all(|b|b.is_ascii_digit()){return None;}result[i]=p.parse().ok()?;}Some(result)
}
fn hex(bytes:&[u8])->String{bytes.iter().map(|b|format!("{b:02x}")).collect()}
fn off()->bool{std::env::var("INTERCEPTOR_AUTO_UPDATE").is_ok_and(|v|matches!(v.trim().to_ascii_lowercase().as_str(),"off"|"0"|"false"|"no"))}
/// The feed this provider reads, and whether it is an operator's lab override.
fn feed()->(String,bool){
    match std::env::var("INTERCEPTOR_UPDATE_FEED").ok().filter(|v|!v.trim().is_empty()){Some(url)=>(url.trim().to_owned(),true),None=>(format!("{HOST}/{OS}/latest.json"),false)}
}
/// HTTPS everywhere; plain HTTP only to a loopback or private lab address named by the operator.
/// Integrity never depends on the transport: the feed is signed and pins every artifact digest.
fn allowed(url:&url::Url,lab:bool)->bool{
    url.username().is_empty()&&url.password().is_none()&&match url.scheme(){
        "https"=>url.host().is_some(),
        "http"=>lab&&match url.host(){Some(url::Host::Ipv4(ip))=>ip.is_loopback()||ip.is_private()||ip.is_link_local(),Some(url::Host::Ipv6(ip))=>ip.is_loopback(),Some(url::Host::Domain(d))=>d=="localhost",None=>false},
        _=>false}
}

/// Only the installed Full provider updates itself; development and parity builds never do.
#[cfg(windows)]
fn installed()->std::result::Result<PathBuf,String>{
    use windows::{core::HSTRING,Win32::System::Registry::{HKEY_CURRENT_USER,RRF_RT_REG_SZ,RegGetValueW}};
    // The installer's ownership record (scripts/installer/interceptor.iss CommitState).
    let read=|name:&str|->Option<String>{
        let mut buffer=vec![0_u16;4096];let mut bytes=(buffer.len()*2)as u32;
        if unsafe{RegGetValueW(HKEY_CURRENT_USER,&HSTRING::from(r"Software\Hacker Valley Media\Interceptor\Installer\State"),&HSTRING::from(name),RRF_RT_REG_SZ,None,Some(buffer.as_mut_ptr().cast()),Some(&mut bytes))}.is_err(){return None;}
        let length=(bytes as usize/2).saturating_sub(1);Some(String::from_utf16_lossy(&buffer[..length.min(buffer.len())]))
    };
    let exe=std::env::current_exe().map_err(|e|format!("this provider's path is unavailable: {e}"))?;
    if read("DesktopMode").as_deref()!=Some("full"){return Err("the Full installer has not recorded an install for this user".into());}
    let root=read("InstallRoot").ok_or("the Full installer recorded no install folder")?;
    if !same_file(&Path::new(&root).join("interceptor-desktop.exe"),&exe){return Err("this provider is not the installed one (a development build)".into());}
    Ok(exe)
}
#[cfg(not(windows))]
fn installed()->std::result::Result<PathBuf,String>{
    let exe=std::env::current_exe().map_err(|e|format!("this provider's path is unavailable: {e}"))?;
    let home=std::env::var_os("HOME").map(PathBuf::from).filter(|p|p.is_absolute()).ok_or("HOME is not an absolute path")?;
    let dest=home.join(".local/share/interceptor");
    if !dest.join("desktop-install.sha256").is_file(){return Err("the Linux installer has not recorded an install for this user".into());}
    if !same_file(&dest.join("interceptor-desktop"),&exe){return Err("this provider is not the installed one (a development build)".into());}
    Ok(exe)
}
fn same_file(a:&Path,b:&Path)->bool{
    match(std::fs::canonicalize(a),std::fs::canonicalize(b)){(Ok(a),Ok(b))=>if cfg!(windows){a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())}else{a==b},_=>false}
}
fn automatic()->std::result::Result<PathBuf,String>{if off(){Err("automatic updates are off (INTERCEPTOR_AUTO_UPDATE=off)".into())}else{installed()}}

/// The folder for downloads, the watcher copy, logs and `state.json`; private to this user.
fn directory()->std::result::Result<PathBuf,String>{
    #[cfg(windows)]let dir=std::env::var_os("LOCALAPPDATA").map(PathBuf::from).filter(|p|p.is_absolute()).ok_or("LOCALAPPDATA is not an absolute path")?.join(r"Interceptor\Updates");
    #[cfg(not(windows))]let dir={
        let base=std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from).filter(|p|p.is_absolute())
            .or_else(||std::env::var_os("HOME").map(|h|PathBuf::from(h).join(".cache"))).filter(|p|p.is_absolute()).ok_or("no absolute cache folder (XDG_CACHE_HOME or HOME)")?;
        base.join("interceptor/updates")
    };
    std::fs::create_dir_all(&dir).map_err(|e|format!("update folder {} could not be created: {e}",dir.display()))?;
    #[cfg(unix)]{
        use std::os::unix::fs::{MetadataExt,PermissionsExt};
        let meta=std::fs::symlink_metadata(&dir).map_err(|e|e.to_string())?;
        if !meta.is_dir()||meta.uid()!=unsafe{libc::geteuid()}{return Err(format!("update folder {} is linked or not owned by this user",dir.display()));}
        std::fs::set_permissions(&dir,std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?;
    }
    Ok(dir)
}


// --- status ---------------------------------------------------------------------------------
fn rfc3339(ms:u64)->Option<String>{
    time::OffsetDateTime::from_unix_timestamp_nanos(ms as i128*1_000_000).ok()?.format(&time::format_description::well_known::Rfc3339).ok()
}
fn initial()->Value{
    let (feed,_)=feed();let automatic=automatic();
    let mut state=json!({"phase":"idle","outcome":"none","concluded":true,"feed":feed,"automaticChecks":automatic.is_ok(),
        "checkInterval":CHECK_INTERVAL.as_secs(),"canCheckForUpdates":true,"sessionInProgress":false,"currentVersion":VERSION});
    if let Err(reason)=automatic{state["message"]=json!(format!("Scheduled update checks are not running: {reason}."));}
    state
}
fn snapshot()->Value{
    let mut state=STATE.lock().unwrap().clone().unwrap_or_else(initial);
    if installed().is_ok()&&let Ok(dir)=directory(){
        let saved=read_state(&dir);
        if state.get("lastCheck").is_none()&&let Some(at)=saved["lastCheckMs"].as_u64().and_then(rfc3339){state["lastCheck"]=json!(at);}
        for(field,key)in[("lastInstallVersion","version"),("lastInstallOutcome","outcome"),("lastInstallAt","at")]{
            if let Some(value)=saved["last"][key].as_str().filter(|v|!v.is_empty()){state[field]=json!(value);}
        }
    }
    state
}
fn set(change:impl FnOnce(&mut Value)){
    let mut guard=STATE.lock().unwrap();let state=guard.get_or_insert_with(initial);
    change(state);state["updatedAt"]=json!(timestamp());
    // An active session is never also concluded (shared/desktop-update-validation.ts).
    if state["sessionInProgress"]==true{state["concluded"]=json!(false);}
}
fn phase(state:&mut Value,phase:&str,outcome:&str,active:bool){
    state["phase"]=json!(phase);state["outcome"]=json!(outcome);state["sessionInProgress"]=json!(active);state["concluded"]=json!(!active);
    // Verified describes downloaded bytes, which only these phases hold (shared/desktop-update-validation.ts).
    if state["signatureVerified"]==true&&!matches!(phase,"downloaded"|"ready_to_install"|"installing"){state["signatureVerified"]=json!(false);}
}
/// The user's answer in the update window, in SparkleUpdateState's vocabulary.
fn choice(state:&mut Value,choice:&str,stage:&str){
    state["userChoice"]=json!(choice);state["updateStage"]=json!(stage);
    match choice{
        "install"=>phase(state,if stage=="downloaded"{"ready_to_install"}else{"downloading"},"install_chosen",true),
        "skip"=>phase(state,"idle","skipped",false),
        _=>phase(state,"deferred","deferred",false),
    }
}
fn fail(error:&Value){
    let message=error["error"].as_str().unwrap_or("update failed").to_owned();
    set(|s|{phase(s,"error","error",false);s["lastError"]=json!(message);s["cycleFinishedAt"]=json!(timestamp());});
}

// --- feed --------------------------------------------------------------------------------------
fn client(timeout:Duration,lab:bool,follow:bool)->Result<reqwest::blocking::Client>{
    let policy=if follow{reqwest::redirect::Policy::custom(move|attempt|{
        if attempt.previous().len()>=10{attempt.error("too many redirects")}else if allowed(attempt.url(),lab){attempt.follow()}else{attempt.error("the update host redirected off HTTPS")}
    })}else{reqwest::redirect::Policy::none()};
    reqwest::blocking::Client::builder().no_proxy().redirect(policy).retry(reqwest::retry::never()).connect_timeout(Duration::from_secs(10)).timeout(timeout)
        .user_agent(concat!("Interceptor/",env!("CARGO_PKG_VERSION"))).build().map_err(|_|failure("provider_failed","update HTTP client initialization failed"))
}
/// The feed is `{"schema":"interceptor.update.envelope/1","payload":<base64>,"signature":<base64>}`;
/// the Ed25519 signature covers the exact payload bytes.
fn verify_envelope(bytes:&[u8],key:&[u8])->Result<Value>{
    let malformed=||failure("provider_failed","update feed is not a signed Interceptor envelope");
    let envelope=serde_json::from_slice::<serde_json::Map<String,Value>>(bytes).map_err(|_|malformed())?;
    if envelope.len()!=3||envelope.get("schema").and_then(Value::as_str)!=Some("interceptor.update.envelope/1"){return Err(malformed());}
    let decode=|field:&str|envelope.get(field).and_then(Value::as_str).and_then(|text|base64::engine::general_purpose::STANDARD.decode(text).ok()).ok_or_else(malformed);
    let (payload,signature)=(decode("payload")?,decode("signature")?);
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519,key).verify(&payload,&signature)
        .map_err(|_|failure("permission_denied","update feed signature does not verify against the pinned Interceptor update key"))?;
    serde_json::from_slice::<Value>(&payload).ok().filter(Value::is_object).ok_or_else(||failure("provider_failed","signed update payload is not a JSON object"))
}
fn fetch_feed(url:&str,lab:bool)->Result<Value>{
    let url=url::Url::parse(url).ok().filter(|u|allowed(u,lab)).ok_or_else(||failure("invalid_request","update feed must be https (plain http only to a loopback or private lab address)"))?;
    let mut response=client(Duration::from_secs(10),lab,false)?.get(url).header("Accept","application/json").send()
        .map_err(|_|failure("timeout_unknown_outcome","update feed request failed; no request was replayed"))?;
    if response.status()!=reqwest::StatusCode::OK{return Err(failure("provider_failed",format!("update feed returned HTTP {}",response.status().as_u16())));}
    let mut bytes=Vec::new();response.by_ref().take(MAX_FEED+1).read_to_end(&mut bytes).map_err(|_|failure("provider_failed","update feed response was interrupted"))?;
    if bytes.len() as u64>MAX_FEED{return Err(failure("resource_limit","update feed exceeds 64 KiB"));}
    let key=base64::engine::general_purpose::STANDARD.decode(FEED_KEY).map_err(|_|failure("provider_failed","pinned update key is malformed"))?;
    verify_envelope(&bytes,&key)
}
#[derive(Clone,Debug,PartialEq)]
struct Release{version:String,file:String,url:String,sha256:String,length:u64,notes:Option<(String,String)>}
#[derive(Debug,PartialEq)]
enum Decision{Current(String),Missing(String,String),Update(Release),Skipped(String)}
fn sha256_hex(text:&str)->bool{text.len()==64&&text.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn select(payload:&Value,os:&str,arch:&str,current:&str,lab:bool)->Result<Decision>{
    let refuse=|reason:&str|failure("provider_failed",format!("signed update feed refused: {reason}"));
    if payload["schema"]!="interceptor.update.latest/1"{return Err(refuse("unknown schema"));}
    if payload["os"]!=os{return Err(refuse("the feed is for another operating system"));}
    let text=payload["version"].as_str().filter(|v|v.starts_with(|c:char|c.is_ascii_digit())).ok_or_else(||refuse("version missing"))?;
    let latest=version(text).ok_or_else(||refuse("version is not X.Y.Z"))?;
    let installed=version(current).ok_or_else(||failure("version_mismatch","this provider's version is not X.Y.Z"))?;
    if latest<=installed{return Ok(Decision::Current(text.to_owned()));}
    let artifact=&payload["artifacts"][arch];
    if !artifact.is_object(){return Ok(Decision::Missing(text.to_owned(),format!("{text} has no {os} {arch} installer")));}
    let file=format!("Interceptor-Full-{text}-{os}-{arch}.{}",if os=="windows"{"exe"}else{"tar.gz"});
    if artifact["file"]!=file.as_str(){return Err(refuse("the artifact name does not match its version, OS and architecture"));}
    let url=artifact["url"].as_str().and_then(|u|url::Url::parse(u).ok()).filter(|u|allowed(u,lab)&&u.query().is_none()&&u.fragment().is_none()&&u.path().ends_with(&format!("/{file}")))
        .ok_or_else(||refuse("the artifact URL is not an https URL for that file"))?;
    let sha256=artifact["sha256"].as_str().filter(|s|sha256_hex(s)).ok_or_else(||refuse("the artifact digest is not lowercase SHA-256 hex"))?;
    let length=artifact["length"].as_u64().filter(|n|*n>0&&*n<=MAX_ARTIFACT).ok_or_else(||refuse("the artifact length is outside 1 byte to 1 GiB"))?;
    // Release notes are signed the way Sparkle signs releaseNotesLink: the feed pins their SHA-256.
    let notes=match(payload["notes"].as_str().and_then(|u|url::Url::parse(u).ok()).filter(|u|allowed(u,lab)),payload["notesSha256"].as_str().filter(|s|sha256_hex(s))){
        (Some(url),Some(sha))=>Some((url.to_string(),sha.to_owned())),_=>None};
    Ok(Decision::Update(Release{version:text.to_owned(),file,url:url.to_string(),sha256:sha256.to_owned(),length,notes}))
}
/// A version the user skipped in the update window is not offered again (Sparkle's skipped
/// version); a newer one is.
fn offered(decision:Decision,skipped:Option<&str>)->Decision{
    match decision{Decision::Update(release) if skipped==Some(release.version.as_str())=>Decision::Skipped(release.version),other=>other}
}
fn skipped_version()->Option<String>{
    installed().ok().and_then(|_|directory().ok()).and_then(|dir|read_state(&dir)["skippedVersion"].as_str().map(str::to_owned))
}
/// Check the feed and record what it offers this provider.
fn check_now()->Result<Decision>{
    let (url,lab)=feed();
    set(|s|{phase(s,"checking","checking",true);s["feed"]=json!(url);s["checkStartedAt"]=json!(timestamp());
        for key in["lastError","noUpdateReason","selectedVersion","selectedDisplayVersion","artifactName","artifactURL","signatureVerified","message","userChoice","updateStage","latestFeedVersion"]{if let Some(o)=s.as_object_mut(){o.remove(key);}}});
    let decision=fetch_feed(&url,lab).and_then(|payload|select(&payload,OS,ARCH,VERSION,lab)).map(|d|offered(d,skipped_version().as_deref()));
    let now=now_ms();let at=rfc3339(now).unwrap_or_else(timestamp);LAST_CHECK_MS.store(now,Ordering::SeqCst);
    // Sparkle records the time of every check, scheduled or not; the next scheduled check counts from it.
    if installed().is_ok()&&let Ok(dir)=directory(){let mut saved=read_state(&dir);saved["lastCheckMs"]=json!(now);let _=write_state(&dir,&saved);}
    match &decision{
        Ok(Decision::Current(latest))=>set(|s|{phase(s,"idle","up_to_date",false);s["latestFeedVersion"]=json!(latest);
            s["noUpdateReason"]=json!(if version(latest)==version(VERSION){"on_latest_version"}else{"on_newer_than_latest_version"});}),
        Ok(Decision::Missing(latest,reason))=>set(|s|{phase(s,"idle","no_eligible_update",false);s["latestFeedVersion"]=json!(latest);s["noUpdateReason"]=json!(reason);}),
        Ok(Decision::Skipped(latest))=>set(|s|{phase(s,"idle","skipped",false);s["latestFeedVersion"]=json!(latest);s["noUpdateReason"]=json!("skipped_version");
            s["message"]=json!(format!("Interceptor {latest} was skipped in the update window; a newer release will be offered."));}),
        Ok(Decision::Update(r))=>set(|s|{phase(s,"update_available","update_available",false);s["latestFeedVersion"]=json!(r.version);s["selectedVersion"]=json!(r.version);s["selectedDisplayVersion"]=json!(r.version);
            s["artifactName"]=json!(r.file);s["artifactURL"]=json!(r.url);s["signatureVerified"]=json!(false);s["updateStage"]=json!("not_downloaded");}),
        Err(error)=>{fail(error);}
    }
    set(|s|{s["lastCheck"]=json!(at);if s["sessionInProgress"]!=true{s["cycleFinishedAt"]=json!(timestamp());}});
    CHECKS.fetch_add(1,Ordering::SeqCst);
    decision
}
/// The cumulative release notes Sparkle shows: the signed page with the installed release and every
/// older one hidden by the page's own `sparkle-installed-version` rule.
fn release_notes(release:&Release,lab:bool)->Option<String>{
    let (url,sha)=release.notes.as_ref()?;
    let mut response=client(Duration::from_secs(15),lab,true).ok()?.get(url).send().ok()?;
    if response.status()!=reqwest::StatusCode::OK{return None;}
    let mut bytes=Vec::new();response.by_ref().take(MAX_NOTES+1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64>MAX_NOTES||hex(&Sha256::digest(&bytes))!=*sha{return None;}
    Some(mark_installed(&String::from_utf8(bytes).ok()?,VERSION))
}
fn mark_installed(notes:&str,current:&str)->String{
    notes.replacen(&format!("<section data-sparkle-version=\"{current}\""),&format!("<section class=\"sparkle-installed-version\" data-sparkle-version=\"{current}\""),1)
}

// --- download -------------------------------------------------------------------------------------
fn digest_file(path:&Path)->Option<String>{
    let mut file=std::fs::File::open(path).ok()?;let mut hash=Sha256::new();let mut buffer=vec![0;1<<16];
    loop{let n=file.read(&mut buffer).ok()?;if n==0{break;}hash.update(&buffer[..n]);}
    Some(hex(&hash.finalize()))
}
/// Stream the installer to `<file>.partial`, never past the signed length, and publish it only
/// when the signed SHA-256 and length match (and, on Windows, its Authenticode signature).
/// Stream the installer to `<file>.partial`, never past the signed length, and publish it only
/// when the signed SHA-256 and length match (and, on Windows, its Authenticode signature).
/// `progress` sees the bytes received so far and returns false to cancel.
fn download(release:&Release,dir:&Path,lab:bool,progress:&mut dyn FnMut(u64)->bool)->Result<PathBuf>{
    let target=dir.join(&release.file);
    if std::fs::metadata(&target).is_ok_and(|m|m.len()==release.length)&&digest_file(&target).as_deref()==Some(release.sha256.as_str()){
        if let Err(error)=platform_check(&target){let _=std::fs::remove_file(&target);return Err(error);}
        return Ok(target);
    }
    let partial=dir.join(format!("{}.partial",release.file));let _=std::fs::remove_file(&partial);
    let result=(||->Result<()>{
        let mut response=client(INSTALL_DEADLINE,lab,true)?.get(&release.url).send().map_err(|e|failure("provider_failed",format!("installer download failed: {e}")))?;
        if response.status()!=reqwest::StatusCode::OK{return Err(failure("provider_failed",format!("installer download returned HTTP {}",response.status().as_u16())));}
        let mut out=std::fs::File::create(&partial).map_err(|e|failure("provider_failed",format!("installer file could not be created: {e}")))?;
        let (mut hash,mut total,mut buffer)=(Sha256::new(),0_u64,vec![0;1<<16]);
        loop{
            let n=response.read(&mut buffer).map_err(|e|failure("provider_failed",format!("installer download was interrupted: {e}")))?;if n==0{break;}
            total+=n as u64;if total>release.length{return Err(failure("permission_denied","the download is longer than the signed feed's length"));}
            hash.update(&buffer[..n]);out.write_all(&buffer[..n]).map_err(|e|failure("provider_failed",format!("installer file write failed: {e}")))?;
            if !progress(total){return Err(failure("cancelled","the download was cancelled"));}
        }
        out.sync_all().map_err(|e|failure("provider_failed",e))?;
        if total!=release.length{return Err(failure("permission_denied",format!("the download is {total} bytes, not the signed {}",release.length)));}
        if hex(&hash.finalize())!=release.sha256{return Err(failure("permission_denied","the downloaded installer does not match the signed SHA-256"));}
        std::fs::rename(&partial,&target).map_err(|e|failure("provider_failed",e))
    })();
    if let Err(error)=result{let _=std::fs::remove_file(&partial);return Err(error);}
    if let Err(error)=platform_check(&target){let _=std::fs::remove_file(&target);return Err(error);}
    Ok(target)
}
#[cfg(windows)]fn platform_check(path:&Path)->Result<()>{authenticode(path)}
#[cfg(not(windows))]fn platform_check(_:&Path)->Result<()>{Ok(())}

/// Recursift's Windows pins with Interceptor's values (osslsigncode on the signed 2.0.0 installer):
/// Artifact Signing renews the leaf every few days, so the durable identity is the certificate
/// profile EKU, the organization and the Microsoft root key, never a leaf thumbprint.
#[cfg(windows)]const ROOT_SPKI_SHA256:&str="dedb13bcde2375995a1c37bd68a7c4a82af5cbb9c4df821b62d5733009028f07";
#[cfg(windows)]const PROFILE_EKU:&str="1.3.6.1.4.1.311.97.529279241.564128540.577692418.16918348";
#[cfg(windows)]const CODE_SIGNING_EKU:&str="1.3.6.1.5.5.7.3.3";
#[cfg(windows)]const PUBLISHER:&str="Hacker Valley Media LLC";
#[cfg(windows)]
pub(crate) fn authenticode(path:&Path)->Result<()>{unsafe{
    use std::os::windows::ffi::OsStrExt;
    use windows::{core::{BOOL,PCWSTR},Win32::{Foundation::{HANDLE,HWND,INVALID_HANDLE_VALUE},System::SystemInformation::GetSystemDirectoryW,Security::{WinTrust::*,Cryptography::*}}};
    let refuse=|reason:String|failure("permission_denied",format!("the downloaded installer failed Authenticode verification: {reason}"));
    let wide=path.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
    let mut file=WINTRUST_FILE_INFO{cbStruct:std::mem::size_of::<WINTRUST_FILE_INFO>()as u32,pcwszFilePath:PCWSTR(wide.as_ptr()),..Default::default()};
    let mut trust=WINTRUST_DATA{cbStruct:std::mem::size_of::<WINTRUST_DATA>()as u32,dwUIChoice:WTD_UI_NONE,fdwRevocationChecks:WTD_REVOKE_WHOLECHAIN,dwUnionChoice:WTD_CHOICE_FILE,
        Anonymous:WINTRUST_DATA_0{pFile:&mut file},dwStateAction:WTD_STATEACTION_VERIFY,dwProvFlags:WTD_REVOCATION_CHECK_CHAIN,..Default::default()};
    struct Close(*mut WINTRUST_DATA);
    impl Drop for Close{fn drop(&mut self){unsafe{(*self.0).dwStateAction=WTD_STATEACTION_CLOSE;let mut action=WINTRUST_ACTION_GENERIC_VERIFY_V2;let _=WinVerifyTrust(HWND(INVALID_HANDLE_VALUE.0),&mut action,self.0.cast());}}}
    let mut action=WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let code=WinVerifyTrust(HWND(INVALID_HANDLE_VALUE.0),&mut action,(&raw mut trust).cast());
    let _close=Close(&mut trust);
    if code!=0{return Err(refuse(format!("WinVerifyTrust returned 0x{:08x}",code as u32)));}
    // The helpers have no stable import-library contract (authdialog.rs); keep the DLL loaded until the state closes.
    let mut system=[0_u16;32768];let length=GetSystemDirectoryW(Some(&mut system))as usize;
    if length==0||length>=system.len(){return Err(failure("provider_failed","Windows system directory is unavailable"));}
    let library=crate::native_library::Library::load(&PathBuf::from(String::from_utf16_lossy(&system[..length])).join("wintrust.dll"))?;
    type ProviderData=unsafe extern "system" fn(HANDLE)->*mut CRYPT_PROVIDER_DATA;
    type ProviderSigner=unsafe extern "system" fn(*mut CRYPT_PROVIDER_DATA,u32,BOOL,u32)->*mut CRYPT_PROVIDER_SGNR;
    let provider_data:ProviderData=std::mem::transmute(library.symbol(c"WTHelperProvDataFromStateData")?);
    let provider_signer:ProviderSigner=std::mem::transmute(library.symbol(c"WTHelperGetProvSignerFromChain")?);
    let provider=provider_data(trust.hWVTStateData);
    if provider.is_null(){return Err(refuse("no verified signer state".into()));}
    let signer=provider_signer(provider,0,false.into(),0);
    if signer.is_null()||(*signer).pasCertChain.is_null()||!(2..=64).contains(&(*signer).csCertChain){return Err(refuse("no verified certificate chain".into()));}
    let chain=std::slice::from_raw_parts((*signer).pasCertChain,(*signer).csCertChain as usize);
    let (leaf,root)=(chain[0].pCert,chain[chain.len()-1].pCert);
    if leaf.is_null()||root.is_null()||(*root).pCertInfo.is_null(){return Err(refuse("the chain is missing its leaf or root".into()));}
    let info=&(*(*root).pCertInfo).SubjectPublicKeyInfo;let mut size=0_u32;
    CryptEncodeObjectEx(X509_ASN_ENCODING,X509_PUBLIC_KEY_INFO,(info as *const CERT_PUBLIC_KEY_INFO).cast(),CRYPT_ENCODE_OBJECT_FLAGS(0),None,None,&mut size).map_err(|_|refuse("the root key could not be encoded".into()))?;
    let mut spki=vec![0_u8;size as usize];
    CryptEncodeObjectEx(X509_ASN_ENCODING,X509_PUBLIC_KEY_INFO,(info as *const CERT_PUBLIC_KEY_INFO).cast(),CRYPT_ENCODE_OBJECT_FLAGS(0),None,Some(spki.as_mut_ptr().cast()),&mut size).map_err(|_|refuse("the root key could not be encoded".into()))?;
    if hex(&Sha256::digest(&spki[..size as usize]))!=ROOT_SPKI_SHA256{return Err(refuse("the chain does not end at the Microsoft Identity Verification root".into()));}
    let mut size=0_u32;
    CertGetEnhancedKeyUsage(leaf,0,None,&mut size).map_err(|_|refuse("the signer has no key usage".into()))?;
    let mut storage=vec![0_u64;(size as usize).div_ceil(8)];let usage=storage.as_mut_ptr().cast::<CTL_USAGE>();
    CertGetEnhancedKeyUsage(leaf,0,Some(usage),&mut size).map_err(|_|refuse("the signer has no key usage".into()))?;
    let usages=std::slice::from_raw_parts((*usage).rgpszUsageIdentifier,(*usage).cUsageIdentifier as usize).iter().filter_map(|oid:&windows::core::PSTR|oid.to_string().ok()).collect::<Vec<_>>();
    if !usages.iter().any(|u|u==CODE_SIGNING_EKU)||!usages.iter().any(|u|u==PROFILE_EKU){return Err(refuse("the signer is not the Hacker Valley Media signing profile".into()));}
    let mut name=[0_u16;512];
    let count=CertGetNameStringW(leaf,CERT_NAME_ATTR_TYPE,0,Some(szOID_ORGANIZATION_NAME.0 as *const _),Some(&mut name))as usize;
    if count<2||String::from_utf16_lossy(&name[..count-1])!=PUBLISHER{return Err(refuse("the signer organization is not Hacker Valley Media LLC".into()));}
    Ok(())
}}


// --- state shared with the watcher -----------------------------------------------------------------
fn read_state(dir:&Path)->Value{
    std::fs::read(dir.join("state.json")).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok()).filter(Value::is_object)
        .unwrap_or_else(||json!({"schema":"interceptor.update.state/1"}))
}
fn write_state(dir:&Path,state:&Value)->std::io::Result<()>{
    let temporary=dir.join(format!("state.json.{}.tmp",std::process::id()));
    let mut file=std::fs::File::create(&temporary)?;file.write_all(&serde_json::to_vec_pretty(state)?)?;file.sync_all()?;drop(file);
    std::fs::rename(&temporary,dir.join("state.json"))
}
/// Record a finished install; a failed version joins `failedVersions` (newest 16) so the
/// background updater does not try it again (Recursift's canary rule).
/// Record a finished install for the provider that starts next; a failure is shown to the user once.
fn record(state:&mut Value,last:Value){
    state["last"]=last;if let Some(o)=state.as_object_mut(){o.remove("pending");}
}
fn pending(state:&Value)->bool{
    state["pending"]["startedMs"].as_u64().is_some_and(|started|now_ms().saturating_sub(started)<(INSTALL_DEADLINE.as_millis() as u64)+900_000)
}


// --- background worker ---------------------------------------------------------------------------------
/// Start the updater in the provider that owns the session endpoint (windows.rs run, unix_server).
pub(crate) fn start(){
    STARTED_MS.store(now_ms(),Ordering::SeqCst);
    if WORKER.swap(true,Ordering::SeqCst){return;}
    if std::thread::Builder::new().name("interceptor-update".into()).spawn(worker).is_err(){WORKER.store(false,Ordering::SeqCst);}
}
/// Sparkle's schedule: one day after the last check, and never sooner than two minutes after start.
/// A clock that moved backwards never postpones a check by more than a day.
fn next_check(last:Option<u64>,started:u64,now:u64)->u64{
    let interval=CHECK_INTERVAL.as_millis() as u64;let first=started+FIRST_CHECK.as_millis() as u64;
    match last{Some(last)=>(last+interval).min(now+interval).max(first),None=>first}
}
/// The later of the saved check time and this process's own. A state file that cannot be written
/// (a full disk, a locked file) left the saved time old, so every pass looked overdue and 2.1.5
/// fetched the feed back to back.
fn last_check(saved:Option<u64>)->Option<u64>{saved.max(Some(LAST_CHECK_MS.load(Ordering::SeqCst)).filter(|&ms|ms>0))}
fn wake(){*WAKE.lock().unwrap()=true;SIGNAL.notify_all();}
/// Wait until `deadline` (milliseconds since the epoch; None waits for a wake). True when woken.
fn wait_until(deadline:Option<u64>)->bool{
    let mut woken=WAKE.lock().unwrap();
    loop{
        if *woken{*woken=false;return true;}
        let left=match deadline{Some(at)=>Duration::from_millis(at.saturating_sub(now_ms())),None=>Duration::from_secs(3600)};
        if deadline.is_some()&&left.is_zero(){return false;}
        woken=SIGNAL.wait_timeout(woken,left).unwrap().0;
    }
}
fn worker(){
    // A fresh Windows install starts the provider before Setup records the install, so wait for
    // the record; a development build never gets one and stops here.
    let deadline=Instant::now()+Duration::from_secs(600);
    while installed().is_err(){if Instant::now()>=deadline{WORKER.store(false,Ordering::SeqCst);return;}std::thread::sleep(Duration::from_secs(5));}
    let Ok(dir)=directory()else{WORKER.store(false,Ordering::SeqCst);return;};
    cleanup(&dir);
    report_failed_install(&dir);
    loop{
        let due=automatic().is_ok().then(||next_check(last_check(read_state(&dir)["lastCheckMs"].as_u64()),STARTED_MS.load(Ordering::SeqCst),now_ms()));
        set(|s|{match due.and_then(rfc3339){Some(at)=>s["nextCheckAt"]=json!(at),None=>{if let Some(o)=s.as_object_mut(){o.remove("nextCheckAt");}}}});
        let woken=wait_until(due);
        if woken||automatic().is_ok(){cycle();}
    }
}
/// One check; a newer release that was not skipped opens the update window.
fn cycle(){
    let (provider,dir)=match installed().and_then(|p|directory().map(|d|(p,d))){Ok(v)=>v,Err(reason)=>{fail(&failure("unsupported_operation",reason));return;}};
    cleanup(&dir);
    let release={
        let Ok(_work)=WORK.lock()else{return;};
        match check_now(){Ok(Decision::Update(release))=>release,_=>return}
    };
    if pending(&read_state(&dir)){set(|s|{phase(s,"installing","installing",true);s["message"]=json!("An install started earlier is still running.");});return;}
    SESSION.store(true,Ordering::SeqCst);
    session(&release,&dir,&provider);
    SESSION.store(false,Ordering::SeqCst);
}

/// The update window (update_ui.rs), run as an owned helper: it dies with this provider.
struct Window{_helper:crate::thumbnail::OwnedHelper,input:std::process::ChildStdin,choices:mpsc::Receiver<(String,String)>}
impl Window{
    fn open(view:&Value)->std::result::Result<Self,String>{
        let mut helper=crate::thumbnail::OwnedHelper::spawn("--update-ui").map_err(|e|format!("the update window could not start: {e}"))?;
        let mut input=helper.child.0.stdin.take().ok_or("the update window has no input")?;
        let mut output=helper.child.0.stdout.take().ok_or("the update window has no output")?;
        crate::write_frame(&mut input,&serde_json::to_vec(view).map_err(|e|e.to_string())?).map_err(|e|format!("the update window could not start: {e}"))?;
        let(tx,rx)=mpsc::channel();
        std::thread::spawn(move||{
            while let Ok(Some(frame))=crate::read_frame(&mut output){
                let message=serde_json::from_slice::<Value>(&frame).unwrap_or(Value::Null);
                if let (Some(choice),Some(view))=(message["choice"].as_str(),message["view"].as_str()){if tx.send((choice.to_owned(),view.to_owned())).is_err(){return;}}
            }
        });
        // The helper answers "shown" once its window exists; a missing WebView ends it first.
        match rx.recv_timeout(Duration::from_secs(30)){
            Ok((shown,_)) if shown=="shown"=>Ok(Self{_helper:helper,input,choices:rx}),
            _=>Err("the update window could not open (WebView2 on Windows; WebKitGTK 4.1 and the interceptor-overlay helper on Linux)".into()),
        }
    }
    fn show(&mut self,view:&Value)->bool{serde_json::to_vec(view).is_ok_and(|bytes|crate::write_frame(&mut self.input,&bytes).is_ok())}
    /// The user's next click in `view`; None when the window is gone (closing it answers "later" in any
    /// view). A click made in an earlier view, such as a double click on Install Update, never answers
    /// a later one, so Install and Relaunch always takes its own click.
    fn choice(&self,view:&str)->Option<String>{next_choice(&self.choices,view)}
}
fn next_choice(choices:&mpsc::Receiver<(String,String)>,view:&str)->Option<String>{
    loop{let (choice,made_in)=choices.recv().ok()?;if made_in=="*"||made_in==view{return Some(choice);}}
}
/// Linux without the overlay helper's WebKitGTK: say an update is available, where to get it.
fn fallback(release:&Release){
    #[cfg(target_os="linux")]{
        let notice=json!({"type":"desktop_notifications","sub":"post","title":format!("Interceptor {} is available",release.version),
            "body":format!("Download it from https://github.com/Hacker-Valley-Media/Interceptor/releases/tag/v{}. Install webkit2gtk-4.1 to update from Interceptor's update window.",release.version)});
        if crate::notifications_validation::validate(&notice).is_ok(){let _=crate::notifications_linux::dispatch(&notice);}
    }
    #[cfg(not(target_os="linux"))]let _=release;
}
fn end(change:impl FnOnce(&mut Value)){set(|s|{change(s);s["cycleFinishedAt"]=json!(timestamp());});}
/// Sparkle's update session: the window offers the release; nothing is downloaded until Install
/// Update and nothing installs until Install and Relaunch.
fn session(release:&Release,dir:&Path,provider:&Path){
    let (_,lab)=feed();
    set(|s|{phase(s,"update_available","update_available",true);s["message"]=json!(format!("Interceptor {} is available; the update window is open.",release.version));});
    let notes=release_notes(release,lab);
    let mut window=match Window::open(&json!({"view":"available","version":release.version,"current":VERSION,"notes":notes})){
        Ok(window)=>window,
        Err(reason)=>{fallback(release);end(|s|{phase(s,"update_available","update_available",false);s["message"]=json!(format!("Interceptor {} is available, but {reason}.",release.version));});return;}
    };
    match window.choice("available").as_deref(){
        Some("skip")=>{
            let mut saved=read_state(dir);saved["skippedVersion"]=json!(release.version);let _=write_state(dir,&saved);
            end(|s|choice(s,"skip","not_downloaded"));
        }
        Some("install")=>install(release,dir,provider,lab,&mut window),
        _=>end(|s|choice(s,"dismiss","not_downloaded")),
    }
}
fn install(release:&Release,dir:&Path,provider:&Path,lab:bool,window:&mut Window){
    set(|s|choice(s,"install","not_downloaded"));
    window.show(&json!({"view":"downloading","received":0,"total":release.length}));
    let mut shown=Instant::now();let mut cancelled=false;
    let downloaded=download(release,dir,lab,&mut |received|{
        while let Ok((choice,view))=window.choices.try_recv(){if choice=="later"&&(view=="downloading"||view=="*"){cancelled=true;return false;}}
        if shown.elapsed()>=Duration::from_millis(200){shown=Instant::now();window.show(&json!({"view":"downloading","received":received,"total":release.length}));}
        true
    });
    let installer=match downloaded{
        Ok(path)=>path,
        Err(_) if cancelled=>{end(|s|choice(s,"dismiss","not_downloaded"));return;}
        Err(error)=>{
            window.show(&json!({"view":"error","message":format!("An error occurred while downloading the update. Please try again later. ({})",error["error"].as_str().unwrap_or("download failed"))}));
            window.choice("error");fail(&error);return;
        }
    };
    set(|s|{phase(s,"ready_to_install","install_chosen",true);s["updateStage"]=json!("downloaded");s["signatureVerified"]=json!(true);
        s["message"]=json!(if cfg!(windows){"The installer matches the signed feed and its Authenticode signature."}else{"The archive matches the signed feed."});});
    window.show(&json!({"view":"ready","version":release.version}));
    if window.choice("ready").as_deref()!=Some("install"){end(|s|choice(s,"dismiss","downloaded"));return;}
    set(|s|{phase(s,"installing","installing",true);s["updateStage"]=json!("installing");s["message"]=json!(format!("Installing {}; Interceptor restarts when it finishes.",release.version));});
    window.show(&json!({"view":"installing"}));
    if let Err(error)=spawn_watcher(dir,provider,release,&installer){
        window.show(&json!({"view":"error","message":format!("An error occurred while installing the update. Please try again later. ({})",error["error"].as_str().unwrap_or("install failed"))}));
        window.choice("error");fail(&error);return;
    }
    // The installer stops this provider, and with it this window. When it refuses before that
    // (a newer version is already installed), the watcher's result arrives here instead.
    let deadline=Instant::now()+INSTALL_DEADLINE+Duration::from_secs(60);
    while Instant::now()<deadline{
        std::thread::sleep(Duration::from_secs(2));
        let mut saved=read_state(dir);
        if pending(&saved)||saved["last"]["version"]!=release.version.as_str(){continue;}
        if saved["last"]["outcome"]=="installed"{end(|s|phase(s,"idle","none",false));return;}
        saved["last"]["reported"]=json!(true);let _=write_state(dir,&saved);
        let error=saved["last"]["error"].as_str().unwrap_or("the installer did not complete").to_owned();
        window.show(&json!({"view":"error","message":format!("An error occurred while installing the update. Please try again later. ({error})")}));
        window.choice("error");fail(&failure("provider_failed",format!("installing {} failed: {error}",release.version)));return;
    }
}
/// After an install that failed and stopped this provider, the provider that starts next shows
/// Sparkle's error once.
fn report_failed_install(dir:&Path){
    // A watcher may still be finishing the install that restarted this provider.
    let deadline=Instant::now()+Duration::from_secs(120);
    let mut saved=read_state(dir);
    while pending(&saved)&&Instant::now()<deadline{std::thread::sleep(Duration::from_secs(2));saved=read_state(dir);}
    if saved["last"]["outcome"]!="failed"||saved["last"]["reported"]==true{return;}
    saved["last"]["reported"]=json!(true);let _=write_state(dir,&saved);
    let target=saved["last"]["version"].as_str().unwrap_or("the update").to_owned();
    let error=saved["last"]["error"].as_str().unwrap_or("the installer did not complete").to_owned();
    fail(&failure("provider_failed",format!("installing {target} failed: {error}")));
    if let Ok(window)=Window::open(&json!({"view":"error","message":format!("An error occurred while installing Interceptor {target}. Please try again later. ({error})")})){window.choice("error");}
}
fn watcher_path(dir:&Path)->PathBuf{dir.join(if cfg!(windows){"interceptor-update.exe"}else{"interceptor-update"})}
/// The installer stops and replaces this provider, so a copy of this binary outside the install
/// folder runs it, records the result and starts the provider again if the install left none.
fn spawn_watcher(dir:&Path,provider:&Path,release:&Release,installer:&Path)->Result<()>{
    let mut state=read_state(dir);
    state["pending"]=json!({"version":release.version,"installer":installer,"provider":provider,"startedMs":now_ms(),"startedAt":timestamp()});
    write_state(dir,&state).map_err(|e|failure("provider_failed",format!("update state could not be written: {e}")))?;
    let clear=|error:Value|{let mut state=read_state(dir);if let Some(o)=state.as_object_mut(){o.remove("pending");}let _=write_state(dir,&state);error};
    let copy=watcher_path(dir);
    let source=std::env::current_exe().map_err(|e|clear(failure("provider_failed",e)))?;
    std::fs::copy(&source,&copy).map_err(|e|clear(failure("provider_failed",format!("the update watcher could not be staged (another may still be running): {e}"))))?;
    #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;let _=std::fs::set_permissions(&copy,std::fs::Permissions::from_mode(0o700));}
    detach(&copy,dir).map_err(|e|clear(failure("provider_failed",format!("the update watcher could not start: {e}"))))
}
#[cfg(windows)]
fn detach(copy:&Path,dir:&Path)->std::io::Result<()>{
    use std::os::windows::process::CommandExt;
    const DETACHED:u32=0x0000_0008|0x0000_0200;const BREAKAWAY:u32=0x0100_0000;
    let spawn=|flags:u32|Command::new(copy).arg("--update-apply").arg(dir).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(flags).spawn();
    // A job that forbids breakaway refuses the flag; the watcher then stays in it, which only matters if that job kills on close.
    spawn(DETACHED|BREAKAWAY).or_else(|_|spawn(DETACHED)).map(|_|())
}
#[cfg(unix)]
fn detach(copy:&Path,dir:&Path)->std::io::Result<()>{
    use std::os::unix::process::CommandExt;
    // The provider's autostart unit stops with KillMode=control-group, so under systemd the watcher
    // must leave that cgroup in a transient user scope, or the installer's `systemctl --user stop`
    // would kill it mid-install. A scope that cannot be created exits at once.
    if std::env::var_os("INVOCATION_ID").is_some(){
        let mut child=Command::new("systemd-run").args(["--user","--scope","--quiet","--collect"]).arg(format!("--unit=interceptor-update-{}",now_ms()))
            .arg(copy).arg("--update-apply").arg(dir).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn()?;
        for _ in 0..20{
            match child.try_wait()?{None=>std::thread::sleep(Duration::from_millis(100)),Some(status)if status.success()=>return Ok(()),Some(status)=>return Err(std::io::Error::other(format!("systemd-run could not create the update scope ({status})")))}
        }
        return Ok(());
    }
    Command::new(copy).arg("--update-apply").arg(dir).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn().map(|_|())
}
/// Remove what an earlier cycle left: the watcher copy, extraction folders, partial downloads
/// and installers for versions this provider already runs.
fn cleanup(dir:&Path){
    // The provider an install starts can come up before the watcher finishes; leave that install alone.
    if pending(&read_state(dir)){return;}
    let _=std::fs::remove_file(watcher_path(dir));
    let current=version(VERSION);
    let Ok(entries)=std::fs::read_dir(dir)else{return;};
    for entry in entries.flatten(){
        let name=entry.file_name().to_string_lossy().into_owned();
        let old=name.strip_prefix("Interceptor-Full-").and_then(|rest|rest.split('-').next()).and_then(version).is_some_and(|v|Some(v)<=current);
        if name.starts_with("stage-"){let _=std::fs::remove_dir_all(entry.path());}
        else if name.ends_with(".partial")||old{let _=std::fs::remove_file(entry.path());}
    }
}

// --- watcher -------------------------------------------------------------------------------------------
fn log_line(dir:&Path,line:&str){
    if let Ok(mut file)=std::fs::OpenOptions::new().create(true).append(true).open(dir.join("update.log")){let _=writeln!(file,"{} {line}",timestamp());}
}
/// `--update-apply <dir>`: run the pending installer, then make sure a provider runs and record
/// the outcome in `state.json`.
pub(crate) fn apply(dir:Option<&str>)->std::io::Result<()>{
    let dir=PathBuf::from(dir.ok_or_else(||std::io::Error::other("usage: --update-apply <update-folder>"))?);
    let state=read_state(&dir);let pending=&state["pending"];
    let (Some(target),Some(installer),Some(provider))=(pending["version"].as_str(),pending["installer"].as_str(),pending["provider"].as_str())else{
        return Err(std::io::Error::other("no pending update in this folder"));
    };
    let (target,installer,provider)=(target.to_owned(),PathBuf::from(installer),PathBuf::from(provider));
    log_line(&dir,&format!("installing {target} from {}",installer.display()));
    let ran=run_installer(&dir,&target,&installer);
    if let Err(error)=&ran{log_line(&dir,&format!("installer: {error}"));}
    let installed=Command::new(&provider).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()
        .map(|o|String::from_utf8_lossy(&o.stdout).trim().to_owned()).unwrap_or_default();
    let exit=ran.as_ref().ok().copied().flatten();
    let outcome=if exit==Some(0)&&installed==target{"installed"}else{"failed"};
    let error=match(&ran,exit){(Err(e),_)=>Some(e.clone()),(Ok(_),Some(0))if installed!=target=>Some(format!("the installer finished but the provider reports {installed}")),(Ok(_),Some(code))if code!=0=>Some(format!("the installer exited with code {code}; see install-{target}.log")),(Ok(_),None)=>Some("the installer did not finish within 30 minutes".to_owned()),_=>None};
    // Record the outcome before any provider starts: the one that starts next reads it to show the error.
    let mut state=read_state(&dir);
    record(&mut state,json!({"version":target,"outcome":outcome,"exitCode":exit,"installedVersion":installed,"at":timestamp(),"error":error,"reported":false}));
    write_state(&dir,&state)?;
    let mut running=wait_alive(&provider,Duration::from_secs(30));
    if !running{log_line(&dir,"no provider answered after the install; starting it");restart(&provider);running=wait_alive(&provider,Duration::from_secs(30));}
    let mut state=read_state(&dir);state["last"]["providerRunning"]=json!(running);let _=write_state(&dir,&state);
    log_line(&dir,&format!("{outcome}: installed version {installed}, provider running {running}{}",error.as_deref().map(|e|format!(", {e}")).unwrap_or_default()));
    if outcome=="installed"{let _=std::fs::remove_file(&installer);}
    let _=std::fs::remove_dir_all(dir.join(format!("stage-{target}")));
    Ok(())
}
/// The installer's exit code, or `None` when it outlived the deadline (it is left to finish).
fn wait_child(mut child:std::process::Child)->std::result::Result<Option<i32>,String>{
    let deadline=Instant::now()+INSTALL_DEADLINE;
    while Instant::now()<deadline{
        match child.try_wait(){Ok(Some(status))=>return Ok(Some(status.code().unwrap_or(-1))),Ok(None)=>std::thread::sleep(Duration::from_secs(1)),Err(e)=>return Err(e.to_string())}
    }
    Ok(None)
}
#[cfg(windows)]
fn run_installer(dir:&Path,target:&str,installer:&Path)->std::result::Result<Option<i32>,String>{
    // The user chose Install and Relaunch, so Inno Setup shows its progress (/SILENT): no wizard pages,
    // no message boxes, no reboot, and a log beside the download.
    let child=Command::new(installer).args(["/SILENT","/SUPPRESSMSGBOXES","/NORESTART","/SP-"]).arg(format!("/LOG={}",dir.join(format!("install-{target}.log")).display()))
        .current_dir(dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e|format!("the installer could not start: {e}"))?;
    wait_child(child)
}
#[cfg(not(windows))]
fn run_installer(dir:&Path,target:&str,installer:&Path)->std::result::Result<Option<i32>,String>{
    let stage=dir.join(format!("stage-{target}"));let _=std::fs::remove_dir_all(&stage);
    std::fs::create_dir(&stage).map_err(|e|format!("extraction folder: {e}"))?;
    let extracted=Command::new("tar").arg("-xzf").arg(installer).arg("-C").arg(&stage).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|e|format!("tar could not start: {e}"))?;
    if !extracted.success(){return Err("the archive did not extract".into());}
    let top=stage.join(format!("Interceptor-Full-{target}-linux-{ARCH}"));let script=top.join("scripts/install-desktop-linux.sh");
    if !script.is_file(){return Err("the archive has no scripts/install-desktop-linux.sh".into());}
    let reported=Command::new(top.join("dist/interceptor-desktop")).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output().map(|o|String::from_utf8_lossy(&o.stdout).trim().to_owned()).unwrap_or_default();
    if reported!=target{return Err(format!("the archive's provider reports {reported}, not {target}"));}
    let log=std::fs::File::create(dir.join(format!("install-{target}.log"))).map_err(|e|e.to_string())?;
    let mut command=Command::new("bash");command.arg(&script).current_dir(&top).stdin(Stdio::null()).stdout(log.try_clone().map_err(|e|e.to_string())?).stderr(log);
    // Hyprland pointer maintenance needs the compositor instance; the login environment normally carries it.
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none()&&std::env::var_os("WAYLAND_DISPLAY").is_some()&&let Some(runtime)=std::env::var_os("XDG_RUNTIME_DIR"){
        let newest=std::fs::read_dir(PathBuf::from(runtime).join("hypr")).ok().and_then(|entries|entries.flatten().max_by_key(|e|e.metadata().and_then(|m|m.modified()).ok()));
        if let Some(entry)=newest{command.env("HYPRLAND_INSTANCE_SIGNATURE",entry.file_name());}
    }
    wait_child(command.spawn().map_err(|e|format!("the install script could not start: {e}"))?)
}
/// An authenticated hello through the installed provider's own client mode.
fn alive(provider:&Path)->bool{
    let request=br#"{"id":"update","action":{"type":"desktop_hello"}}"#;
    let mut command=Command::new(provider);command.arg("--client").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x0800_0000);}
    let Ok(mut child)=command.spawn()else{return false;};
    if let Some(mut stdin)=child.stdin.take(){let _=stdin.write_all(&(request.len()as u32).to_le_bytes());let _=stdin.write_all(request);}
    child.wait_with_output().is_ok_and(|o|String::from_utf8_lossy(&o.stdout).contains("\"success\":true"))
}
fn wait_alive(provider:&Path,limit:Duration)->bool{
    let deadline=Instant::now()+limit;
    loop{if alive(provider){return true;}if Instant::now()>=deadline{return false;}std::thread::sleep(Duration::from_secs(2));}
}
fn restart(provider:&Path){
    let directory=provider.parent().unwrap_or(Path::new("."));
    #[cfg(windows)]{
        use std::os::windows::process::CommandExt;
        let spawn=|flags:u32|Command::new(provider).current_dir(directory).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(flags).spawn();
        let _=spawn(0x0000_0008|0x0000_0200|0x0100_0000).or_else(|_|spawn(0x0000_0008|0x0000_0200));
    }
    #[cfg(unix)]{
        use std::os::unix::process::CommandExt;
        // The installer's own startup path: the XDG autostart unit when systemd generated one.
        if Command::new("systemctl").args(["--user","start","app-com.interceptor.desktop@autostart.service"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s|s.success()){return;}
        let log=std::fs::OpenOptions::new().create(true).append(true).open(directory.join("desktop-provider.log")).ok();
        let mut command=Command::new(provider);command.current_dir(directory).stdin(Stdio::null()).process_group(0);
        if let Some(log)=log{if let Ok(copy)=log.try_clone(){command.stdout(copy);}command.stderr(log);}
        let _=command.spawn();
    }
}


// --- verbs ---------------------------------------------------------------------------------------------
/// `interceptor update` says what UpdateDomain.swift says for the same outcome.
fn message(state:&Value)->String{
    match state["outcome"].as_str(){
        Some("update_available")=>format!("Interceptor {} is available; the update window is open",state["selectedVersion"].as_str().unwrap_or("update")),
        Some("up_to_date")=>"Interceptor is up to date".into(),
        Some("no_eligible_update")=>"found no eligible update".into(),
        Some("skipped")=>state["message"].as_str().unwrap_or("this version was skipped").into(),
        Some("error")=>"update check failed".into(),
        Some("checking")=>"update check is still running; use `interceptor update status` for the result".into(),
        _=>"update check concluded".into(),
    }
}
pub fn dispatch(a:&Value)->Value{
    if let Some(e)=desktop_update_shape_error(a){return failure("invalid_request",e);}
    if ["group","groupColor"].iter().any(|key|a.get(key).is_some_and(|v|v.as_str().is_none_or(|s|s.trim().is_empty()||s.len()>256||s.contains('\0')))){return failure("invalid_request","invalid update group metadata");}
    if a["sub"]!="check"{return success(snapshot());}
    if SESSION.load(Ordering::SeqCst){let mut s=snapshot();s["started"]=json!(false);s["message"]=json!("an update session is already in progress");return success(s);}
    if WORKER.load(Ordering::SeqCst){
        // The worker checks and, for a newer release, opens the update window, as Sparkle does.
        let before=CHECKS.load(Ordering::SeqCst);wake();
        let deadline=Instant::now()+CHECK_WAIT;
        while CHECKS.load(Ordering::SeqCst)==before&&Instant::now()<deadline{std::thread::sleep(Duration::from_millis(50));}
    }else{
        let Some(_work)=WORK.try_lock().ok()else{let mut s=snapshot();s["started"]=json!(false);s["message"]=json!("an update session is already in progress");return success(s);};
        if let Ok(Decision::Update(release))=check_now(){
            let mut s=snapshot();s["started"]=json!(true);
            s["message"]=json!(format!("Interceptor {} is available; the update window opens only in the installed Full provider",release.version));
            return success(s);
        }
    }
    let mut s=snapshot();s["started"]=json!(true);
    if s.get("message").is_none()||s["outcome"]!="skipped"{s["message"]=json!(message(&s));}
    success(s)
}
pub fn capability(session:&str)->Value{json!({"operation":"update","compiled":true,"present":true,"effective":false,"permission":"not_applicable","session":session,"background":"semantic","provider":"signed update feed on the Sparkle update host","versions":{"contract":"1","product":env!("CARGO_PKG_VERSION"),"api":"interceptor.update.latest/1"},"limits":[
    "The installed Full provider checks updates.hackervalley.media once a day, like Sparkle on the Mac; INTERCEPTOR_AUTO_UPDATE=off stops the scheduled checks",
    "A newer release opens Interceptor's update window (Skip This Version, Remind Me Later, Install Update); nothing downloads or installs until the user clicks, and nothing installs until Install and Relaunch",
    "The feed is signed with Interceptor's Sparkle Ed25519 key and pins the installer's SHA-256 and length; Windows installers must also pass Authenticode for Hacker Valley Media LLC",
    "The window needs WebView2 on Windows, and on Linux WebKitGTK 4.1 with the interceptor-overlay helper; without them Linux posts a notification with the download link"]})}

#[cfg(test)] mod tests{
    use super::*;
    use ring::signature::KeyPair;
    fn keys()->ring::signature::Ed25519KeyPair{
        let rng=ring::rand::SystemRandom::new();let pkcs8=ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap()
    }
    fn envelope(payload:&[u8],pair:&ring::signature::Ed25519KeyPair)->Vec<u8>{
        let b64=|b:&[u8]|base64::engine::general_purpose::STANDARD.encode(b);
        serde_json::to_vec(&json!({"schema":"interceptor.update.envelope/1","payload":b64(payload),"signature":b64(pair.sign(payload).as_ref())})).unwrap()
    }
    fn payload(version:&str,url:&str)->Value{
        json!({"schema":"interceptor.update.latest/1","os":"windows","version":version,"issuedAt":"2026-10-12T00:00:00Z",
            "notes":"https://updates.hackervalley.media/release-notes-2.1.1.html","notesSha256":"b".repeat(64),
            "artifacts":{"arm64":{"file":format!("Interceptor-Full-{version}-windows-arm64.exe"),"url":url,"sha256":"a".repeat(64),"length":42}}})
    }
    const URL:&str="https://updates.hackervalley.media/windows/Interceptor-Full-2.1.0-windows-arm64.exe";
    #[test] fn feed_signature_is_checked_over_exact_payload_bytes(){
        let pair=keys();let bytes=serde_json::to_vec(&payload("2.1.0",URL)).unwrap();
        assert_eq!(verify_envelope(&envelope(&bytes,&pair),pair.public_key().as_ref()).unwrap()["version"],"2.1.0");
        let other=keys();
        assert_eq!(verify_envelope(&envelope(&bytes,&pair),other.public_key().as_ref()).unwrap_err()["code"],"permission_denied");
        let mut tampered:Value=serde_json::from_slice(&envelope(&bytes,&pair)).unwrap();
        tampered["payload"]=json!(base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&payload("9.9.9",URL)).unwrap()));
        assert_eq!(verify_envelope(&serde_json::to_vec(&tampered).unwrap(),pair.public_key().as_ref()).unwrap_err()["code"],"permission_denied");
        let mut extra:Value=serde_json::from_slice(&envelope(&bytes,&pair)).unwrap();extra["note"]=json!("x");
        assert!(verify_envelope(&serde_json::to_vec(&extra).unwrap(),pair.public_key().as_ref()).is_err());
        assert!(verify_envelope(b"{\"schema\":\"other\"}",pair.public_key().as_ref()).is_err());
        assert!(base64::engine::general_purpose::STANDARD.decode(FEED_KEY).is_ok_and(|k|k.len()==32));
    }
    /// Written by scripts/publish-desktop-updates.ts and signed with the real Sparkle key by sign_update:
    /// the publisher, Sparkle and this verifier agree on the format. Version 0.0.1 is never an update.
    #[test] fn a_feed_signed_by_the_release_publisher_verifies_with_the_pinned_key(){
        let key=base64::engine::general_purpose::STANDARD.decode(FEED_KEY).unwrap();
        let payload=verify_envelope(include_bytes!("update-fixture.json"),&key).unwrap();
        assert_eq!(select(&payload,"windows","arm64","2.0.0",false).unwrap(),Decision::Current("0.0.1".into()));
        assert!(select(&payload,"windows","arm64","0.0.0",false).is_ok_and(|d|matches!(d,Decision::Update(r) if r.url=="https://updates.hackervalley.media/windows/Interceptor-Full-0.0.1-windows-arm64.exe")));
    }
    #[test] fn selection_refuses_everything_but_a_newer_matching_https_installer(){
        let update=select(&payload("2.1.0",URL),"windows","arm64","2.0.0",false).unwrap();
        assert!(matches!(&update,Decision::Update(r) if r.file=="Interceptor-Full-2.1.0-windows-arm64.exe"&&r.length==42&&r.notes.as_ref().is_some_and(|(u,_)|u.ends_with("release-notes-2.1.1.html"))));
        assert_eq!(select(&payload("2.0.0",URL),"windows","arm64","2.0.0",false).unwrap(),Decision::Current("2.0.0".into()));
        assert_eq!(select(&payload("1.9.9",URL),"windows","arm64","2.0.0",false).unwrap(),Decision::Current("1.9.9".into()));
        assert!(matches!(select(&payload("2.1.0",URL),"windows","x64","2.0.0",false).unwrap(),Decision::Missing(..)));
        assert!(select(&payload("2.1.0",URL),"linux","arm64","2.0.0",false).is_err());
        let mut p=payload("2.1.0",URL);p["artifacts"]["arm64"]["file"]=json!("setup.exe");assert!(select(&p,"windows","arm64","2.0.0",false).is_err());
        // Notes without a pinned digest are not shown.
        let mut p=payload("2.1.0",URL);p["notesSha256"]=json!("short");assert!(matches!(select(&p,"windows","arm64","2.0.0",false).unwrap(),Decision::Update(r) if r.notes.is_none()));
        for url in ["http://updates.hackervalley.media/windows/Interceptor-Full-2.1.0-windows-arm64.exe","https://updates.hackervalley.media/windows/other.exe","https://u:p@updates.hackervalley.media/windows/Interceptor-Full-2.1.0-windows-arm64.exe",URL]{
            assert_eq!(select(&payload("2.1.0",url),"windows","arm64","2.0.0",false).is_ok(),url==URL,"{url}");
        }
        let lab="http://192.168.64.1:8099/windows/Interceptor-Full-2.1.0-windows-arm64.exe";
        assert!(select(&payload("2.1.0",lab),"windows","arm64","2.0.0",true).is_ok());
        assert!(select(&payload("2.1.0",lab),"windows","arm64","2.0.0",false).is_err());
        assert!(select(&payload("2.1.0","http://8.8.8.8/windows/Interceptor-Full-2.1.0-windows-arm64.exe"),"windows","arm64","2.0.0",true).is_err());
        for (key,value) in [("sha256",json!("A".repeat(64))),("sha256",json!("a".repeat(63))),("length",json!(0)),("length",json!(MAX_ARTIFACT+1))]{
            let mut p=payload("2.1.0",URL);p["artifacts"]["arm64"][key]=value;assert!(select(&p,"windows","arm64","2.0.0",false).is_err(),"{key}");
        }
        for version in ["v2.1.0","2.1","02.1.0","2.1.0-beta"]{assert!(select(&payload(version,URL),"windows","arm64","2.0.0",false).is_err(),"{version}");}
    }
    #[test] fn a_skipped_version_is_not_offered_but_a_newer_one_is(){
        let url=URL.replace("2.1.0","2.1.1");let Decision::Update(release)=select(&payload("2.1.1",&url),"windows","arm64","2.1.0",false).unwrap()else{panic!()};
        assert_eq!(offered(Decision::Update(release.clone()),Some("2.1.1")),Decision::Skipped("2.1.1".into()));
        assert_eq!(offered(Decision::Update(release.clone()),Some("2.1.0")),Decision::Update(release.clone()));
        assert_eq!(offered(Decision::Update(release.clone()),None),Decision::Update(release));
        assert_eq!(offered(Decision::Current("2.1.1".into()),Some("2.1.1")),Decision::Current("2.1.1".into()));
    }
    #[test] fn a_double_click_on_install_update_never_answers_install_and_relaunch(){
        let (tx,rx)=mpsc::channel();
        for _ in 0..2{tx.send(("install".to_owned(),"available".to_owned())).unwrap();}
        tx.send(("later".to_owned(),"ready".to_owned())).unwrap();
        assert_eq!(next_choice(&rx,"ready").as_deref(),Some("later"));
        tx.send(("install".to_owned(),"available".to_owned())).unwrap();tx.send(("later".to_owned(),"*".to_owned())).unwrap();
        assert_eq!(next_choice(&rx,"ready").as_deref(),Some("later"));
        tx.send(("install".to_owned(),"available".to_owned())).unwrap();drop(tx);
        assert_eq!(next_choice(&rx,"ready"),None);
    }
    #[test] fn checks_follow_sparkles_daily_schedule(){
        let (day,start)=(86_400_000_u64,1_000_000_000_000_u64);
        assert_eq!(next_check(None,start,start),start+120_000);
        assert_eq!(next_check(Some(start-3_600_000),start,start),start-3_600_000+day);
        assert_eq!(next_check(Some(start-2*day),start,start),start+120_000);
        assert_eq!(next_check(Some(start+5*day),start,start),start+day);
    }
    #[test] fn a_check_that_could_not_be_saved_still_waits_a_day(){
        let (day,start)=(86_400_000_u64,1_000_000_000_000_u64);
        assert_eq!(last_check(None),None);
        LAST_CHECK_MS.store(start+120_000,Ordering::SeqCst);
        assert_eq!(last_check(Some(start-2*day)),Some(start+120_000));
        assert_eq!(next_check(last_check(Some(start-2*day)),start,start+120_001),start+120_000+day);
        assert_eq!(last_check(Some(start+day)),Some(start+day));
    }
    #[test] fn release_notes_hide_the_installed_release_the_way_sparkle_marks_it(){
        let notes="<main><section data-sparkle-version=\"2.1.1\">a</section><section data-sparkle-version=\"2.1.0\">b</section></main>";
        let marked=mark_installed(notes,"2.1.0");
        assert!(marked.contains("<section class=\"sparkle-installed-version\" data-sparkle-version=\"2.1.0\">"));
        assert!(marked.contains("<section data-sparkle-version=\"2.1.1\">"));
        assert_eq!(mark_installed(notes,"2.0.98"),notes);
    }
    #[test] fn download_publishes_only_matching_bytes_and_stops_when_cancelled(){
        use std::net::TcpListener;
        let serve=|body:Vec<u8>|{
            let listener=TcpListener::bind("127.0.0.1:0").unwrap();let port=listener.local_addr().unwrap().port();
            std::thread::spawn(move||{if let Ok((mut stream,_))=listener.accept(){let mut request=[0;4096];let _=stream.read(&mut request);
                let _=stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes());let _=stream.write_all(&body);}});
            port
        };
        let dir=std::env::temp_dir().join(format!("interceptor-update-test-{}",std::process::id()));let _=std::fs::remove_dir_all(&dir);std::fs::create_dir_all(&dir).unwrap();
        let body=b"signed installer bytes".to_vec();let sha=hex(&Sha256::digest(&body));
        let release=|port:u16,sha:&str,length:u64|Release{version:"2.1.0".into(),file:"Interceptor-Full-2.1.0-linux-arm64.tar.gz".into(),url:format!("http://127.0.0.1:{port}/linux/Interceptor-Full-2.1.0-linux-arm64.tar.gz"),sha256:sha.into(),length,notes:None};
        let mut any=|_:u64|true;
        let wrong=release(serve(body.clone()),&"0".repeat(64),body.len() as u64);
        assert_eq!(download(&wrong,&dir,true,&mut any).unwrap_err()["code"],"permission_denied");
        assert!(!dir.join(&wrong.file).exists()&&!dir.join(format!("{}.partial",wrong.file)).exists());
        let short=release(serve(body.clone()),&sha,body.len() as u64-1);
        assert_eq!(download(&short,&dir,true,&mut any).unwrap_err()["code"],"permission_denied");
        let cancelled=release(serve(body.clone()),&sha,body.len() as u64);
        assert_eq!(download(&cancelled,&dir,true,&mut |_|false).unwrap_err()["code"],"cancelled");
        assert!(!dir.join(&cancelled.file).exists());
        let good=release(serve(body.clone()),&sha,body.len() as u64);let mut seen=0;
        assert_eq!(std::fs::read(download(&good,&dir,true,&mut |n|{seen=n;true}).unwrap()).unwrap(),body);assert_eq!(seen,body.len() as u64);
        // A verified file already present is reused without a request (no server is listening).
        let reused=release(1,&sha,body.len() as u64);assert!(download(&reused,&dir,true,&mut any).is_ok());
        let _=std::fs::remove_dir_all(&dir);
    }
    #[test] fn a_finished_install_replaces_the_pending_record(){
        let mut state=json!({"pending":{"version":"2.1.1"},"skippedVersion":"2.1.2","lastCheckMs":5});
        record(&mut state,json!({"version":"2.1.1","outcome":"failed","reported":false}));
        assert!(state.get("pending").is_none()&&state["last"]["outcome"]=="failed"&&state["skippedVersion"]=="2.1.2"&&state["lastCheckMs"]==5);
        assert!(!pending(&json!({})));assert!(pending(&json!({"pending":{"startedMs":now_ms()}})));
        assert!(!pending(&json!({"pending":{"startedMs":now_ms()-4*3_600_000}})));
    }
    #[test] fn status_uses_sparkles_vocabulary_and_matches_the_contract(){
        let mut s=initial();assert!(serde_json::from_value::<DesktopUpdateData>(s.clone()).is_ok(),"{s}");assert_eq!(s["checkInterval"],86_400);
        choice(&mut s,"install","not_downloaded");assert_eq!((s["phase"].as_str(),s["outcome"].as_str()),(Some("downloading"),Some("install_chosen")));
        choice(&mut s,"install","downloaded");assert_eq!(s["phase"],"ready_to_install");
        choice(&mut s,"dismiss","downloaded");assert_eq!((s["phase"].as_str(),s["outcome"].as_str(),s["sessionInProgress"].as_bool()),(Some("deferred"),Some("deferred"),Some(false)));
        choice(&mut s,"skip","not_downloaded");assert_eq!((s["phase"].as_str(),s["outcome"].as_str()),(Some("idle"),Some("skipped")));
        s["signatureVerified"]=json!(true);phase(&mut s,"ready_to_install","install_chosen",true);assert_eq!(s["signatureVerified"],true);
        phase(&mut s,"deferred","deferred",false);assert_eq!(s["signatureVerified"],false);
        s["lastInstallOutcome"]=json!("installed");s["nextCheckAt"]=json!("2026-10-13T00:00:00Z");
        assert!(serde_json::from_value::<DesktopUpdateData>(s.clone()).is_ok(),"{s}");
        assert_eq!(dispatch(&json!({"type":"desktop_update","sub":"status"}))["success"],true);
        assert_eq!(dispatch(&json!({"type":"desktop_update","sub":"status","url":"https://other.invalid"}))["code"],"invalid_request");
        // Like the Mac, there is no install verb: the user clicks in the update window.
        assert_eq!(dispatch(&json!({"type":"desktop_update","sub":"install"}))["code"],"invalid_request");
        assert!(installed().is_err());
        assert_eq!(rfc3339(0).as_deref(),Some("1970-01-01T00:00:00Z"));
    }
}
