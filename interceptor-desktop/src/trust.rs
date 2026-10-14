use crate::{contract_generated::*,failure,success};
use serde_json::{json,Value};
use std::{io,time::{Duration,Instant}};

fn validate(a:&Value)->Result<(),Value>{
    if let Some(error)=desktop_trust_shape_error(a){return Err(failure("invalid_request",error));}
    for key in ["group","groupColor"]{if a.get(key).is_some_and(|v|v.as_str().is_none_or(|s|s.trim().is_empty()||s.len()>256||s.contains('\0'))){return Err(failure("invalid_request","invalid trust group text"));}}
    Ok(())
}
fn prompting(a:&Value)->bool{a["noPrompt"]!=true&&["prompt","walkthrough","accessibilityPrompt","screenPrompt","microphonePrompt","speechPrompt"].iter().any(|key|a[key]==true)}
fn diagnostics(path:&str,scope:&str,microphone:(&str,&str))->Value{
    let mut permissions=Vec::new();
    for (name,required,status,reason) in [
        ("Accessibility",true,"unknown","Native UI access is checked against the actual target and its session, integrity and exposed interfaces."),
        ("Microphone",false,microphone.0,"Native microphone capture is required for speech recognition and VAD."),
        ("Screen Recording",false,"unknown","Capture access depends on the actual window, compositor, portal and protected-content policy."),
        ("Speech Recognition",false,"unknown","Local recognition requires actual microphone access and the pinned licensed CPU model/runtime.")
    ]{
        let mut row=json!({"name":name,"status":status,"granted":status=="granted","required":required,"path":if name=="Microphone"&&cfg!(windows){"ms-settings:privacy-microphone"}else{"Inspect the requested operation and target permission error"},"reason":reason,"limitation":scope});
        if name=="Microphone"{row["nativeStatus"]=json!(microphone.1);}permissions.push(row);
    }
    json!({"accessibility":"unknown","microphone":microphone.0,"screenRecording":"unknown","speechRecognition":"unknown","permissions":permissions,"bundlePath":path,"displayName":"Interceptor","warnings":[scope]})
}
pub fn dispatch(a:&Value)->Value{
    if let Err(e)=validate(a){return e;}
    #[cfg(windows)]return match crate::thumbnail::image_helper("--trust-state",a,Instant::now()+Duration::from_secs(5)){
        Ok(data)=>success(data),Err(e)if prompting(a)&&matches!(e["code"].as_str(),Some("provider_failed"|"resource_limit"))=>failure("timeout_unknown_outcome","native permission workflow did not return a complete receipt; observe Windows Settings before retrying"),Err(e)=>e
    };
    #[cfg(target_os="linux")]{
        let Some(login)=crate::linux::login_identity(0).filter(crate::linux_peer::graphical)else{return failure("no_interactive_session","trust requires the current retained graphical login");};
        if prompting(a){return failure("unsupported_operation","This Linux provider has no general accessibility/microphone/speech approval workflow; use the actual operation permission workflow. No permission was changed.");}
        let path=match std::env::current_exe(){Ok(p)=>p,Err(e)=>return failure("provider_failed",e)};
        let scope=format!("Current logind login {} at {} via {}; target and compositor authorization is operation-specific. No global permission grant or microphone access is inferred.",login.id,login.start_usec,login.source);
        return success(diagnostics(&path.to_string_lossy(),&scope,("unknown","No global native permission state for the unpackaged provider")));
    }
    #[cfg(not(any(windows,target_os="linux")))]{let _=a;failure("unsupported_operation","macOS uses its native TrustDomain")}
}
#[cfg(windows)]fn native(a:&Value)->Result<Value,Value>{
    use windows::{Devices::Enumeration::{DeviceAccessInformation,DeviceClass,DeviceAccessStatus},Win32::{Foundation::HWND,System::WinRT::{RoInitialize,RoUninitialize,RO_INIT_MULTITHREADED},UI::Shell::ShellExecuteW},core::w};
    unsafe{RoInitialize(RO_INIT_MULTITHREADED)}.map_err(|e|failure("provider_failed",e))?;
    struct Apartment;impl Drop for Apartment{fn drop(&mut self){unsafe{RoUninitialize();}}}let _apartment=Apartment;
    if crate::windows::session()=="0"{return Err(failure("no_interactive_session","trust requires the interactive Windows login"));}
    if prompting(a)&&(a["prompt"]==true&&a["walkthrough"]!=true||["accessibilityPrompt","screenPrompt","speechPrompt"].iter().any(|key|a[key]==true)){return Err(failure("unsupported_operation","Windows provider general UIA/screen/local-speech prompt variants are not implemented. No permission was changed; microphonePrompt or walkthrough can open the native microphone privacy page."));}
    let (status,raw)=match DeviceAccessInformation::CreateFromDeviceClass(DeviceClass::AudioCapture).and_then(|info|info.CurrentStatus()){
        Ok(value)if value==DeviceAccessStatus::Allowed=>("granted","Allowed".to_owned()),
        Ok(value)if value==DeviceAccessStatus::DeniedByUser=>("denied","DeniedByUser".to_owned()),
        Ok(value)if value==DeviceAccessStatus::DeniedBySystem=>("restricted","DeniedBySystem".to_owned()),
        Ok(value)=>("unknown",format!("Unspecified or unknown native status {}",value.0)),
        Err(e)=>("unknown",format!("DeviceAccessInformation unavailable: {}",e.code().0)),
    };
    let path=std::env::current_exe().map_err(|e|failure("provider_failed",e))?;
    let scope="DeviceAccessInformation reports device-class policy only. Actual Win32 microphone access, target UIA integrity and capture permission are checked by each operation; no global trust grant is inferred.";
    let mut data=diagnostics(&path.to_string_lossy(),scope,(status,&raw));
    if prompting(a){
        let result=unsafe{ShellExecuteW(Some(HWND::default()),w!("open"),w!("ms-settings:privacy-microphone"),None,None,windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL)};
        if result.0 as isize<=32{return Err(failure("provider_failed","native microphone privacy page failed to open; no grant is claimed"));}
        data["opened"]=json!(["Microphone"]);data["pending_user_action"]=json!(["Microphone"]);
    }
    Ok(data)
}
pub(crate) fn helper(parent:u32)->io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    let bytes=crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("trust helper requires one request"))?;
    let action:Value=serde_json::from_slice(&bytes)?;
    let result=match validate(&action){Err(e)=>e,Ok(())=>{
        #[cfg(windows)]{match native(&action){Ok(data)=>success(data),Err(e)=>e}}
        #[cfg(not(windows))]{failure("unsupported_operation","this helper requires Windows")}
    }};
    crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(&result)?)
}
pub fn capability(session:&str)->Value{json!({"operation":"trust","compiled":true,"present":true,"effective":false,"background":"semantic","permission":"not_applicable","session":session,"provider":"native device-class policy / retained GUI-login diagnostics","versions":{"contract":"1"},"limits":["Unknown target-specific permission states remain unknown; discovery does not open a microphone or grant authorization","noPrompt overrides every prompt flag; Windows microphone workflow opens native Settings only on explicit request","Linux/global UIA/screen/local-speech prompt equivalents remain unavailable; status is diagnostic only","Current native API behavior, prompt/focus and installed CLI/MCP qualification remain open"]})}

#[cfg(test)]mod tests{use super::*;
    #[test]fn strict_no_prompt_and_truthful_permission_states(){
        assert!(validate(&json!({"type":"desktop_trust","noPrompt":true,"prompt":true})).is_ok());assert!(!prompting(&json!({"noPrompt":true,"prompt":true,"walkthrough":true})));assert!(prompting(&json!({"microphonePrompt":true})));
        for a in [json!({"type":"desktop_trust","prompt":1}),json!({"type":"desktop_trust","extra":true}),json!({"type":"desktop_trust","group":"\0"})]{assert!(validate(&a).is_err());}
        for status in ["unknown","granted","denied","restricted"]{let data=diagnostics("/owned/provider","native fixture scope",(status,"actual fixture state"));assert_eq!(data["permissions"][1]["granted"],status=="granted");assert_eq!(data["accessibility"],"unknown");assert!(serde_json::from_value::<DesktopTrustData>(data).is_ok());}
        assert!(serde_json::from_value::<DesktopCapability>(capability("fixture")).is_ok());
    }
}
