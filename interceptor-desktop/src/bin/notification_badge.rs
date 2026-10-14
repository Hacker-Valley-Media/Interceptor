//! Package identity is isolated here. The provider retains its toast identity.
#![cfg_attr(windows, windows_subsystem = "windows")]
#[cfg(windows)]
fn main() {
    use std::{io::Write,path::PathBuf};
    use serde_json::json;
    use windows::{core::{HSTRING,PWSTR},Data::Xml::Dom::XmlDocument,UI::Notifications::{BadgeUpdateManager,BadgeNotification},
        Win32::{System::{Com::{CoInitializeEx,CoUninitialize,COINIT_MULTITHREADED},RemoteDesktop::ProcessIdToSessionId},
        Storage::Packaging::Appx::{GetCurrentApplicationUserModelId,GetCurrentPackagePath2,PackagePathType_EffectiveExternal},
        UI::WindowsAndMessaging::{GetShellWindow,GetWindowThreadProcessId}}};
    let result=(||->Result<serde_json::Value,String>{
        let args=std::env::args().skip(1).collect::<Vec<_>>();
        if args.len()!=1{return Err("badge helper requires one count or check".into());}
        let count=if args[0]=="check"{None}else{
            let n=args[0].parse::<u32>().map_err(|_|"badge requires an integer 0..9999")?;
            if n>9999||args[0]!=n.to_string(){return Err("badge requires an integer 0..9999".into());}
            Some(n)
        };
        unsafe{
            let mut session=0;ProcessIdToSessionId(std::process::id(),&mut session).map_err(|e|e.to_string())?;
            let shell=GetShellWindow();let mut shell_pid=0;GetWindowThreadProcessId(shell,Some(&mut shell_pid));
            let mut shell_session=0;ProcessIdToSessionId(shell_pid,&mut shell_session).map_err(|e|e.to_string())?;
            if session==0||shell.is_invalid()||session!=shell_session{return Err("badge requires this user's graphical login".into());}
            let mut id=[0u16;256];let mut length=id.len()as u32;
            GetCurrentApplicationUserModelId(&mut length,Some(PWSTR(id.as_mut_ptr()))).ok().map_err(|e|format!("installed badge package identity is required: {e}"))?;
            let aumid="HackerValleyMedia.Interceptor.Desktop_4xfsjzhwq8rce!Desktop";
            if length==0||length as usize>id.len()||id[length as usize-1]!=0||String::from_utf16(&id[..length as usize-1]).map_err(|e|e.to_string())?!=aumid{return Err("badge package AUMID differs".into());}
            let mut external=vec![0u16;32768];let mut length=external.len()as u32;
            GetCurrentPackagePath2(PackagePathType_EffectiveExternal,&mut length,Some(PWSTR(external.as_mut_ptr()))).ok().map_err(|e|e.to_string())?;
            if length==0||length as usize>external.len()||external[length as usize-1]!=0{return Err("badge external location is invalid".into());}
            let external=PathBuf::from(String::from_utf16(&external[..length as usize-1]).map_err(|e|e.to_string())?);
            let exe=std::env::current_exe().map_err(|e|e.to_string())?;
            if std::fs::canonicalize(&external).map_err(|e|e.to_string())?!=std::fs::canonicalize(exe.parent().ok_or("badge helper has no root")?).map_err(|e|e.to_string())?{
                return Err("badge package is registered outside this helper".into());
            }
            CoInitializeEx(None,COINIT_MULTITHREADED).ok().map_err(|e|e.to_string())?;
            let update=(||->windows::core::Result<()>{
                if let Some(count)=count{
                    let updater=BadgeUpdateManager::CreateBadgeUpdaterForApplication()?;
                    if count==0{updater.Clear()?;}else{
                        let xml=XmlDocument::new()?;xml.LoadXml(&HSTRING::from(format!("<badge value='{count}'/>")))?;
                        updater.Update(&BadgeNotification::CreateBadgeNotification(&xml)?)?;
                    }
                }Ok(())
            })();
            CoUninitialize();update.map_err(|e|e.to_string())?;
            Ok(json!({"success":true,"count":count,"aumid":aumid}))
        }
    })();
    let passed=result.is_ok();let reply=result.unwrap_or_else(|error|json!({"success":false,"error":error}));
    let bytes=serde_json::to_vec(&reply).unwrap();let mut out=std::io::stdout().lock();
    if out.write_all(&(bytes.len()as u32).to_le_bytes()).and_then(|_|out.write_all(&bytes)).is_err(){std::process::exit(1);}
    if !passed{std::process::exit(1);}
}
#[cfg(not(windows))]
fn main(){eprintln!("badge package helper requires Windows");std::process::exit(1);}
