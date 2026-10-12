use crate::{contract_generated::*,failure,success};
use serde_json::{json,Value};
use std::{io::Read,sync::Mutex,time::Duration};
const FEED:&str="https://api.github.com/repos/Hacker-Valley-Media/Interceptor/releases/latest";
static STATE:Mutex<Option<Value>>=Mutex::new(None);
static WORK:Mutex<()>=Mutex::new(());
type Result<T>=std::result::Result<T,Value>;
fn initial()->Value{json!({"phase":"idle","outcome":"none","concluded":true,"feed":FEED,"automaticChecks":false,"checkInterval":0,"canCheckForUpdates":true,"sessionInProgress":false,"currentVersion":env!("CARGO_PKG_VERSION")})}
fn snapshot()->Value{STATE.lock().unwrap().clone().unwrap_or_else(initial)}
fn timestamp()->Result<String>{time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).map_err(|_|failure("provider_failed","update observation clock could not be formatted"))}
fn version(input:&str)->Option<[u64;3]>{
    let input=input.strip_prefix('v').unwrap_or(input);if input.len()>32{return None;}
    let parts=input.split('.').collect::<Vec<_>>();if parts.len()!=3{return None;}let mut result=[0;3];
    for(i,p)in parts.iter().enumerate(){if p.is_empty()||p.len()>6||p.len()>1&&p.starts_with('0')||!p.bytes().all(|b|b.is_ascii_digit()){return None;}result[i]=p.parse().ok()?;}Some(result)
}
fn eligible(release:&Value,current:&str,host:&str,arch:&str)->Result<Value>{
    let tag=release["tag_name"].as_str().ok_or_else(||failure("provider_failed","stable release omitted its tag"))?;
    let latest=version(tag).ok_or_else(||failure("provider_failed","stable release tag is not a supported semantic version"))?;
    let installed=version(current).ok_or_else(||failure("version_mismatch","compiled product version is not a supported semantic version"))?;
    if release["draft"]!=false||release["prerelease"]!=false{return Err(failure("provider_failed","latest stable release endpoint returned a draft or prerelease"));}
    let latest_text=tag.strip_prefix('v').unwrap_or(tag);let mut state=json!({"latestFeedVersion":latest_text});
    if latest<=installed{state["phase"]=json!("idle");state["outcome"]=json!("up_to_date");state["noUpdateReason"]=json!("No newer stable release is published in this feed.");return Ok(state);}
    let name=format!("Interceptor-Full-{latest_text}-{}-{arch}.{}",if host=="win32"{"windows"}else{"linux"},if host=="win32"{"exe"}else{"tar.gz"});
    let url=format!("https://github.com/Hacker-Valley-Media/Interceptor/releases/download/{tag}/{name}");
    let assets=release["assets"].as_array().filter(|a|a.len()<=256).ok_or_else(||failure("resource_limit","release asset inventory is malformed or exceeds 256 entries"))?;
    let matches=assets.iter().filter(|a|a["name"]==name).collect::<Vec<_>>();
    if matches.len()>1{return Err(failure("provider_failed","stable release contains ambiguous native package identities"));}
    if let Some(asset)=matches.first(){
        if asset["state"]!="uploaded"||asset["size"].as_u64().is_none_or(|n|n==0||n>8*1024*1024*1024)||asset["browser_download_url"]!=url{return Err(failure("provider_failed","native release asset identity/size/state is invalid"));}
        if host=="linux"&&["SHA256SUMS","SHA256SUMS.cms","SIGNATURE.json"].iter().any(|name|!assets.iter().any(|a|a["name"]==*name&&a["state"]=="uploaded"&&a["size"].as_u64().is_some_and(|n|n>0&&n<=1_048_576))){state["phase"]=json!("idle");state["outcome"]=json!("no_eligible_update");state["noUpdateReason"]=json!("Newer Linux release lacks its required signature/checksum sidecars.");return Ok(state);}
        state["phase"]=json!("update_available");state["outcome"]=json!("update_available");state["selectedVersion"]=json!(latest_text);state["selectedDisplayVersion"]=json!(latest_text);
        state["artifactName"]=json!(name);state["artifactURL"]=json!(url);state["signatureVerified"]=json!(false);state["updateStage"]=json!("release_metadata");
        state["message"]=json!("A matching Full package is published. Metadata is not signature verification; verify downloaded package bytes before installation.");
    }else{state["phase"]=json!("idle");state["outcome"]=json!("no_eligible_update");state["noUpdateReason"]=json!("Newer stable release has no Full package matching this provider architecture.");}
    Ok(state)
}
fn fetch()->Result<Value>{
    let client=reqwest::blocking::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never()).connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(10)).build().map_err(|_|failure("provider_failed","update HTTP client initialization failed"))?;
    let mut response=client.get(FEED).header("Accept","application/vnd.github+json").header("X-GitHub-Api-Version","2026-03-10").header("User-Agent",concat!("Interceptor/",env!("CARGO_PKG_VERSION"))).send().map_err(|_|failure("timeout_unknown_outcome","stable release check failed after dispatch; no request replayed"))?;
    if response.status()!=reqwest::StatusCode::OK{return Err(failure("provider_failed",format!("stable release endpoint returned HTTP{}; response body withheld",response.status().as_u16())));}
    let mut bytes=Vec::new();response.by_ref().take(1_048_577).read_to_end(&mut bytes).map_err(|_|failure("provider_failed","stable release response was interrupted"))?;
    if bytes.len()>1_048_576{return Err(failure("resource_limit","stable release metadata exceeds 1MiB"));}serde_json::from_slice(&bytes).map_err(|_|failure("provider_failed","stable release metadata is malformed JSON"))
}
pub fn dispatch(a:&Value)->Value{
    if let Some(e)=desktop_update_shape_error(a){return failure("invalid_request",e);}
    if ["group","groupColor"].iter().any(|key|a.get(key).is_some_and(|v|v.as_str().is_none_or(|s|s.trim().is_empty()||s.len()>256||s.contains('\0')))){return failure("invalid_request","invalid update group metadata");}
    if a["sub"]=="status"{return success(snapshot());}
    let Ok(_work)=WORK.try_lock()else{let mut s=snapshot();s["started"]=json!(false);s["message"]=json!("An update metadata check is already in progress.");return success(s);};
    let now=match timestamp(){Ok(time)=>time,Err(e)=>return e};let mut s=initial();s["phase"]=json!("checking");s["outcome"]=json!("checking");s["concluded"]=json!(false);s["sessionInProgress"]=json!(true);s["checkStartedAt"]=json!(now);s["updatedAt"]=json!(now);*STATE.lock().unwrap()=Some(s.clone());
    let result=fetch().and_then(|release|eligible(&release,env!("CARGO_PKG_VERSION"),if cfg!(windows){"win32"}else{"linux"},if cfg!(target_arch="aarch64"){"arm64"}else{"x64"}));
    match result{Ok(data)=>{for(k,v)in data.as_object().unwrap(){s[k]=v.clone();}},Err(e)=>{s["phase"]=json!("error");s["outcome"]=json!("error");s["lastError"]=json!(e["error"].as_str().unwrap_or("Stable release check failed."));}}
    match timestamp(){Ok(ended)=>{s["updatedAt"]=json!(ended);s["cycleFinishedAt"]=json!(ended);},Err(e)=>{s["phase"]=json!("error");s["outcome"]=json!("error");s["lastError"]=e["error"].clone();}}
    s["concluded"]=json!(true);s["sessionInProgress"]=json!(false);s["lastCheck"]=json!(now);*STATE.lock().unwrap()=Some(s.clone());s["started"]=json!(true);success(s)
}
pub fn capability(session:&str)->Value{json!({"operation":"update","compiled":true,"present":true,"effective":false,"permission":"not_applicable","session":session,"background":"semantic","provider":"bounded stable GitHub release metadata","versions":{"contract":"1","product":env!("CARGO_PKG_VERSION"),"api":"2026-03-10"},"limits":["Check/status only, manual checks; ten-second HTTP budget, 1MiB metadata, 256 assets, no cookies/proxy/redirect/replay","Selects newer stable Full package matching this native provider architecture; Linux requires checksum/signature sidecar metadata","Metadata never proves signatures. No download, install, automatic update or focus change occurs; downloaded Windows Authenticode and Linux CMS verification remain required","Current source/native/release eligibility and signed installed qualification remain open"]})}
#[cfg(test)]mod tests{use super::*;
    fn release(host:&str,sidecars:bool)->Value{let name=format!("Interceptor-Full-1.0.27-{host}-arm64.{}",if host=="windows"{"exe"}else{"tar.gz"});let mut assets=vec![json!({"name":name,"state":"uploaded","size":1024,"browser_download_url":format!("https://github.com/Hacker-Valley-Media/Interceptor/releases/download/v1.0.27/{name}")})];if sidecars{assets.extend(["SHA256SUMS","SHA256SUMS.cms","SIGNATURE.json"].map(|name|json!({"name":name,"state":"uploaded","size":100})));}json!({"tag_name":"v1.0.27","draft":false,"prerelease":false,"assets":assets})}
    #[test]fn release_eligibility_never_treats_metadata_as_signatures(){
        assert_eq!(version("v1.0.27"),Some([1,0,27]));for v in ["1.0","01.0.1","1.0.1-pre","1.0.1/other","1.0.1000000"]{assert_eq!(version(v),None);}
        let win=eligible(&release("windows",false),"1.0.26","win32","arm64").unwrap();assert_eq!(win["outcome"],"update_available");assert_eq!(win["signatureVerified"],false);
        assert_eq!(eligible(&release("windows",false),"1.0.27","win32","arm64").unwrap()["outcome"],"up_to_date");
        assert_eq!(eligible(&release("windows",false),"1.0.26","win32","x64").unwrap()["outcome"],"no_eligible_update");
        assert_eq!(eligible(&release("linux",false),"1.0.26","linux","arm64").unwrap()["outcome"],"no_eligible_update");
        assert_eq!(eligible(&release("linux",true),"1.0.26","linux","arm64").unwrap()["outcome"],"update_available");
        let mut bad=release("windows",false);bad["assets"][0]["browser_download_url"]=json!("https://untrusted.invalid/setup.exe");assert!(eligible(&bad,"1.0.26","win32","arm64").is_err());bad["prerelease"]=json!(true);assert!(eligible(&bad,"1.0.26","win32","arm64").is_err());
        assert!(serde_json::from_value::<DesktopCapability>(capability("fixture")).is_ok());
    }
}
