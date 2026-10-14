use crate::{failure,share::Payload};
use serde_json::{Value,json};
use std::{fs,os::windows::fs::{OpenOptionsExt,MetadataExt}};
use windows::{core::{PCWSTR,PWSTR,HSTRING},Foundation::Uri,System::{Launcher,LaunchQuerySupportType,LaunchQuerySupportStatus},Win32::{System::{Com::{CoCreateInstance,CoTaskMemFree,CLSCTX_ALL},WinRT::{RoInitialize,RoUninitialize,RO_INIT_SINGLETHREADED},Mapi::*,SystemInformation::GetSystemDirectoryW},UI::Shell::{DesktopWallpaper,IDesktopWallpaper}}};
struct Apartment;impl Drop for Apartment{fn drop(&mut self){unsafe{RoUninitialize();}}}
fn wide(value:&str)->Vec<u16>{value.encode_utf16().chain(Some(0)).collect()}
/// The protocol's default app (an AppUserModelID or an executable), or None when Windows would ask.
fn default_handler(scheme:&str)->Option<String>{
    use windows::Win32::UI::Shell::{AssocQueryStringW,ASSOCF_IS_PROTOCOL,ASSOCSTR_APPID,ASSOCSTR_EXECUTABLE};
    let scheme=wide(scheme);
    [ASSOCSTR_APPID,ASSOCSTR_EXECUTABLE].into_iter().find_map(|kind|{let mut out=[0u16;1024];let mut len=out.len()as u32;unsafe{AssocQueryStringW(ASSOCF_IS_PROTOCOL,kind,PCWSTR(scheme.as_ptr()),PCWSTR::null(),Some(PWSTR(out.as_mut_ptr())),&mut len)}.is_ok().then(||String::from_utf16_lossy(&out[..(len as usize).saturating_sub(1)]))})
        // With no default app, the association can resolve to the "Pick an app" helper itself.
        .filter(|handler|!handler.to_ascii_lowercase().ends_with("openwith.exe"))
}
/// Launches a URI handler, waiting at most 15 s. With no default app Windows shows "Pick an app" and
/// the launch stays pending, so that refuses first. Windows also routed mailto: to "Pick an app" when
/// its default was a packaged app (Outlook (new) on the test VM) yet reported success; naming the
/// default's package launches it directly.
pub(crate) fn launch(uri:&Uri,what:&str)->Result<bool,Value>{
    let scheme=uri.SchemeName().map_err(|_|failure("provider_failed",format!("native {what} URI has no scheme")))?.to_string();
    let Some(handler)=default_handler(&scheme) else{return Err(failure("not_installed",format!("no default app is set for {scheme}: links on this Windows account, so Windows would ask which app to use; nothing was sent")));};
    let options=windows::System::LauncherOptions::new().map_err(|_|failure("provider_failed","native launcher options failed"))?;
    if let Some((family,_))=handler.split_once('!'){options.SetTargetApplicationPackageFamilyName(&HSTRING::from(family)).map_err(|_|failure("provider_failed","native launcher target failed"))?;}
    let op=Launcher::LaunchUriWithOptionsAsync(uri,&options).map_err(|_|failure("provider_failed",format!("native {what} handler launch failed")))?;
    let deadline=std::time::Instant::now()+std::time::Duration::from_secs(15);
    loop{
        use windows_future::AsyncStatus;
        match op.Status(){
            Ok(AsyncStatus::Completed)=>return op.GetResults().map_err(|_|failure("timeout_unknown_outcome",format!("native {what} dispatch failed after invocation; no operation was replayed"))),
            Ok(AsyncStatus::Started) if std::time::Instant::now()<deadline=>std::thread::sleep(std::time::Duration::from_millis(100)),
            Ok(AsyncStatus::Started)=>{let _=op.Cancel();return Err(failure("timeout_unknown_outcome",format!("the {what} handler did not finish opening within 15 s; Windows may be asking which app to use")));}
            _=>return Err(failure("timeout_unknown_outcome",format!("native {what} dispatch failed after invocation; no operation was replayed"))),
        }
    }
}
fn library()->Result<crate::native_library::Library,Value>{
    let mut path=vec![0u16;32768];let count=unsafe{GetSystemDirectoryW(Some(&mut path))}as usize;
    if count==0||count>=path.len(){return Err(failure("provider_failed","native system directory discovery failed"));}
    let path=String::from_utf16(&path[..count]).map_err(|_|failure("provider_failed","native system directory is not valid Unicode"))?;
    crate::native_library::Library::load(&std::path::PathBuf::from(path).join("MAPI32.dll"))
}
fn simple_mapi_client()->bool{
    let mut name=[0u16;512];
    [windows::Win32::System::Registry::HKEY_CURRENT_USER,windows::Win32::System::Registry::HKEY_LOCAL_MACHINE].into_iter().any(|root|{let mut bytes=std::mem::size_of_val(&name) as u32;
        unsafe{windows::Win32::System::Registry::RegGetValueW(root,windows::core::w!("Software\\Clients\\Mail"),PCWSTR::null(),windows::Win32::System::Registry::RRF_RT_REG_SZ,None,Some(name.as_mut_ptr().cast()),Some(&mut bytes))}.is_ok()&&bytes>2})
}
pub(crate) fn native(a:&Value)->Result<Value,Value>{
    unsafe{RoInitialize(RO_INIT_SINGLETHREADED)}.map_err(|_|failure("provider_failed","native Share apartment/runtime initialization failed"))?;let _apartment=Apartment;
    if a["sub"]=="services"{
        if let Some(path)=a["for_item"].as_str(){let metadata=fs::metadata(path).map_err(|_|failure("permission_denied","native Share service probe file is inaccessible"))?;if !metadata.is_file(){return Err(failure("unsupported_target","native Share service probe requires a regular file"));}}
        let uri=Uri::CreateUri(&HSTRING::from("mailto:")).map_err(|_|failure("provider_failed","native mail URI construction failed"))?;
        let configured=default_handler("mailto").is_some()&&Launcher::QueryUriSupportAsync(&uri,LaunchQuerySupportType::Uri).and_then(|op|op.join()).map_err(|_|failure("provider_failed","native mail handler discovery failed"))?==LaunchQuerySupportStatus::Available;
        let mail=configured&&(a["for_item"].is_null()||library().and_then(|lib|unsafe{lib.symbol(c"MAPISendMailW")}).is_ok()&&simple_mapi_client());
        let wallpaper:windows::core::Result<IDesktopWallpaper>=unsafe{CoCreateInstance(&DesktopWallpaper,None,CLSCTX_ALL)};
        let sms=default_handler("sms").is_some()&&Uri::CreateUri(&HSTRING::from("sms:")).and_then(|uri|Launcher::QueryUriSupportAsync(&uri,LaunchQuerySupportType::Uri)).and_then(|op|op.join()).is_ok_and(|status|status==LaunchQuerySupportStatus::Available);
        return Ok(json!({"services":[{"id":"email","title":"Email","menuItemTitle":"Compose email","canPerform":mail},{"id":"message","title":"Message","menuItemTitle":"Compose telephone message","canPerform":sms},{"id":"desktop-picture","title":"Desktop Picture","menuItemTitle":"Set desktop picture","canPerform":wallpaper.is_ok()}]}));
    }
    let service=crate::share::selected(a)?;let payload=Payload::resolve(a)?;
    if service=="message"{
        let uri=Uri::CreateUri(&HSTRING::from(crate::share::message_uri(&payload)?)).map_err(|_|failure("provider_failed","native messaging URI construction failed"))?;
        let status=Launcher::QueryUriSupportAsync(&uri,LaunchQuerySupportType::Uri).and_then(|op|op.join()).map_err(|_|failure("provider_failed","native messaging handler discovery failed"))?;
        if status!=LaunchQuerySupportStatus::Available{return Err(failure("not_installed","a native SMS URI handler is required; no content was sent"));}
        let accepted=launch(&uri,"messaging")?;
        if !accepted{return Err(failure("unsupported_target","native SMS handler refused the requested message"));}
        return Ok(json!({"ok":true,"service":"message","recipients":payload.recipients,"items":payload.originals,"outcome":"handler-accepted","note":"Native SMS handler accepted the URI; no send or delivery receipt is available."}));
    }
    let mut files=Vec::new();let mut total=0u64;
    for path in &payload.files{
        let file=fs::OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000).open(path).map_err(|_|failure("permission_denied","native Share attachment cannot be retained for read-only access"))?;
        let metadata=file.metadata().map_err(|_|failure("provider_failed","native Share file metadata failed"))?;
        if metadata.file_attributes()&0x400!=0{return Err(failure("unsupported_target","native Share attachments do not follow Windows reparse points"));}
        if !metadata.is_file()||metadata.len()>64*1024*1024{return Err(failure("resource_limit","native Share attachment is not a bounded regular file"));}total+=metadata.len();if total>256*1024*1024{return Err(failure("resource_limit","native Share attachments exceed 256MiB"));}files.push(file);
    }
    if service=="desktop-picture"{
        if payload.files.len()!=1||!payload.body.is_empty()||!payload.recipients.is_empty()||payload.subject.is_some(){return Err(failure("invalid_request","desktop-picture requires exactly one local image without compose fields"));}
        let path=&payload.files[0];let bytes=crate::thumbnail::source_bytes(path)?;let _image=crate::thumbnail::decode_raster(&bytes)?;
        let wallpaper:IDesktopWallpaper=unsafe{CoCreateInstance(&DesktopWallpaper,None,CLSCTX_ALL)}.map_err(|_|failure("not_installed","native desktop wallpaper interface is unavailable"))?;
        let count=unsafe{wallpaper.GetMonitorDevicePathCount()}.map_err(|_|failure("provider_failed","native wallpaper monitor inventory failed"))?;
        if count==0||count>64{return Err(failure("unsupported_target","native wallpaper monitor inventory is empty or exceeds 64"));}
        let target=wide(&path.to_string_lossy());unsafe{wallpaper.SetWallpaper(PCWSTR::null(),PCWSTR(target.as_ptr()))}.map_err(|_|failure("provider_failed","native desktop picture request failed; no completion receipt"))?;
        // Explorer applies SetWallpaper asynchronously, so an immediate GetWallpaper can still
        // return the previous picture; poll the attached monitors until they report this one.
        let selected=fs::canonicalize(path).map_err(|_|failure("partial_result","selected desktop picture path cannot be resolved after effect"))?;
        let readback=||->Result<(usize,bool),Value>{let mut attached_count=0;let mut all=true;
        for index in 0..count{unsafe{
            let monitor=wallpaper.GetMonitorDevicePathAt(index).map_err(|_|failure("partial_result","desktop picture changed but native monitor identity could not be read"))?;
            // The count includes detached monitors that keep an old image; GetMonitorRECT answers S_FALSE for them.
            let mut rect=windows::Win32::Foundation::RECT::default();
            let attached=(windows::core::Interface::vtable(&wallpaper).GetMonitorRECT)(windows::core::Interface::as_raw(&wallpaper),PCWSTR(monitor.0),&mut rect);
            if attached!=windows::Win32::Foundation::S_OK{CoTaskMemFree(Some(monitor.0.cast()));continue;}attached_count+=1;
            let observed=wallpaper.GetWallpaper(PCWSTR(monitor.0));CoTaskMemFree(Some(monitor.0.cast()));
            let observed=observed.map_err(|_|failure("partial_result","desktop picture changed but native readback failed"))?;
            let value=observed.to_string();CoTaskMemFree(Some(observed.0.cast()));
            let value=value.map_err(|_|failure("partial_result","desktop picture readback is invalid Unicode"))?;
            all&=fs::canonicalize(value).is_ok_and(|observed|observed==selected);
        }}Ok((attached_count,all))};
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(5);
        loop{
            let(attached_count,all)=readback()?;
            if attached_count==0{return Err(failure("partial_result","desktop picture was set but no attached monitor could be read back"));}
            if all{break;}
            if std::time::Instant::now()>=deadline{return Err(failure("partial_result","native desktop picture did not retain the selected path on every monitor within 5s"));}
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        return Ok(json!({"ok":true,"service":service,"items":payload.originals,"outcome":"wallpaper-set"}));
    }
    // With no default mail client, MAPI opens a modal "no email program" dialog and blocks;
    // refuse first, the same check the services list uses.
    {
        use windows::{Foundation::Uri,System::{Launcher,LaunchQuerySupportStatus,LaunchQuerySupportType}};use windows::core::HSTRING;
        let uri=Uri::CreateUri(&HSTRING::from("mailto:")).map_err(|_|failure("provider_failed","native mail URI construction failed"))?;
        let status=Launcher::QueryUriSupportAsync(&uri,LaunchQuerySupportType::Uri).and_then(|op|op.join()).map_err(|_|failure("provider_failed","native mail handler discovery failed"))?;
        if status!=LaunchQuerySupportStatus::Available{return Err(failure("not_installed","no default email client is configured; nothing was composed"));}
        // Without attachments the default mail app composes from a mailto: URI and the call
        // returns once it accepts; Simple MAPI's compose dialog blocks until the person acts.
        if payload.files.is_empty(){
            let uri=Uri::CreateUri(&HSTRING::from(crate::share::mailto_uri(&payload)?)).map_err(|_|failure("provider_failed","native mail URI construction failed"))?;
            let accepted=launch(&uri,"mail")?;
            if !accepted{return Err(failure("unsupported_target","the default mail app refused the compose request"));}
            return Ok(json!({"ok":true,"service":"email","items":payload.originals,"recipients":payload.recipients,"subject":payload.subject,"outcome":"handler-accepted","note":"The default mail app accepted the compose request; no send receipt is available."}));
        }
        // Attachments need a Simple MAPI mail program; with none, MAPI32 shows a blocking dialog.
        if !simple_mapi_client(){return Err(failure("not_installed","attaching files needs a Simple MAPI mail program (such as classic Outlook or Thunderbird) as the default mail client; nothing was composed"));}
    }
    let library=library()?;let send:LPMAPISENDMAILW=Some(unsafe{std::mem::transmute(library.symbol(c"MAPISendMailW")?)});
    let mut subject=payload.subject.as_deref().map(wide).unwrap_or_default();let mut body=wide(&payload.body);
    let mut addresses=payload.recipients.iter().map(|v|wide(&if v.contains('@'){format!("SMTP:{v}")}else{v.clone()})).collect::<Vec<_>>();
    let mut names=payload.recipients.iter().map(|v|wide(v)).collect::<Vec<_>>();
    let mut recipients=addresses.iter_mut().zip(names.iter_mut()).map(|(address,name)|MapiRecipDescW{ulRecipClass:MAPI_TO,lpszName:PWSTR(name.as_mut_ptr()),lpszAddress:PWSTR(address.as_mut_ptr()),..Default::default()}).collect::<Vec<_>>();
    let mut paths=payload.files.iter().map(|v|wide(&v.to_string_lossy())).collect::<Vec<_>>();
    let mut attachments=paths.iter_mut().map(|path|MapiFileDescW{nPosition:u32::MAX,lpszPathName:PWSTR(path.as_mut_ptr()),..Default::default()}).collect::<Vec<_>>();
    let message=MapiMessageW{lpszSubject:if subject.is_empty(){PWSTR::null()}else{PWSTR(subject.as_mut_ptr())},lpszNoteText:PWSTR(body.as_mut_ptr()),nRecipCount:recipients.len()as u32,lpRecips:recipients.as_mut_ptr(),nFileCount:attachments.len()as u32,lpFiles:attachments.as_mut_ptr(),..Default::default()};
    // A modal native compose dialog lets the user decide whether to send.
    // SUCCESS_SUCCESS is a send receipt, not a promise made before dispatch.
    let code=unsafe{send.unwrap()(0,0,&message,MAPI_DIALOG|MAPI_FORCE_UNICODE,0)};
    match code{SUCCESS_SUCCESS=>Ok(json!({"ok":true,"service":"email","items":payload.originals,"recipients":payload.recipients,"subject":payload.subject,"outcome":"shared"})),MAPI_E_USER_ABORT=>Err(failure("cancelled","native email compose was cancelled; no message was sent")),MAPI_E_NOT_SUPPORTED=>Err(failure("unsupported_operation","configured native email provider does not support Simple MAPI Unicode compose")),_=>Err(failure("provider_failed",format!("native email compose failed with Simple MAPI code{code}; no send receipt issued")))}
}
