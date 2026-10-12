use crate::{failure,success};
use serde_json::{json,Value};
use std::time::Instant;

pub(crate) fn check_deadline(deadline:Instant)->Result<(),Value>{
    if Instant::now()>=deadline{Err(failure("timeout","authentication request deadline expired; no further mutation was sent"))}else{Ok(())}
}
pub(crate) fn validate(a:&Value)->Result<(),Value>{
    if let Some(error)=crate::contract_generated::desktop_authdialog_shape_error(a){return Err(failure("invalid_request",error));}
    for key in ["app","group","groupColor"]{if a.get(key).is_some_and(|v|v.as_str().is_none_or(|v|v.is_empty()||v.len()>(if key=="app"{4096}else{256})||v.contains('\0'))){return Err(failure("invalid_request","invalid authentication scope text"));}}
    for (key,max)in[("pid",i32::MAX as f64),("window",9_007_199_254_740_991_f64)]{if a.get(key).is_some_and(|v|v.as_f64().is_none_or(|n|!n.is_finite()||n<1.0||n>max||n.fract()!=0.0)){return Err(failure("invalid_request","authentication scope requires a positive bounded integer"));}}
    for key in["ref","dialogRef"]{if a.get(key).is_some_and(|v|v.as_str().is_none_or(|s|s.len()<2||s.len()>64||!s.starts_with('e')||!s.as_bytes()[1..].iter().all(u8::is_ascii_digit))){return Err(failure("invalid_request","invalid authentication native reference"));}}
    if a["sub"]=="status"{
        if["text","secret","submit","sensitive","backgroundOnly","secretBindingName","secretLease","expectedIdentity"].iter().any(|key|a.get(*key).is_some()){return Err(failure("invalid_request","authentication status accepts only native target scope"));}
    }else{
        let valid_name=|v:&Value|v.as_str().is_some_and(|s|!s.is_empty()&&s.len()<=64&&s.as_bytes()[0].is_ascii_alphanumeric()&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'.'||b==b'_'||b==b'-'));
        let token=a["secretLease"].as_str();
        if a["ref"].as_str().is_none()||a["dialogRef"].as_str().is_none()||token.is_none_or(|s|s.len()!=64||!s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))){return Err(failure("permission_denied","authentication fill requires exact window/secure-field references and a direct graphical grant"));}
        if a.get("secret").is_some()||a["sensitive"]!=true||a["backgroundOnly"]!=true||!valid_name(&a["secretBindingName"])||!crate::secret_target::valid(&a["expectedIdentity"]){return Err(failure("permission_denied","authentication provider accepts only resolved retained vault delivery"));}
        if a["text"].as_str().is_none_or(|s|s.is_empty()||s.len()>8192||s.chars().count()>512||s.encode_utf16().count()>1024||s.contains(['\0','\r','\n'])){return Err(failure("invalid_request","invalid bounded authentication value"));}
    }
    Ok(())
}
pub fn dispatch(a:&Value)->Value{
    if let Err(e)=validate(a){return e;}
    #[cfg(windows)]return crate::windows::dispatch("authdialog",a);
    #[cfg(target_os="linux")]return crate::linux::dispatch("authdialog",a);
    #[cfg(not(any(windows,target_os="linux")))]failure("unsupported_operation","macOS uses its native authentication dialog domain")
}
pub(crate) fn confirmation(titles:&[String])->Result<usize,Value>{
    let allowed=["OK","Install","Install Software","Install Helper","Unlock","Allow","Modify Settings","Continue","Update Settings","Authorize","Authenticate","Yes"];
    let one_time=titles.iter().enumerate().filter(|(_,title)|title.as_str()=="Allow").map(|(i,_)|i).collect::<Vec<_>>();
    let choices=if one_time.is_empty(){titles.iter().enumerate().filter(|(_,title)|allowed.contains(&title.as_str())).map(|(i,_)|i).collect::<Vec<_>>()}else{one_time};
    if choices.len()!=1{return Err(failure(if choices.is_empty(){"unsupported_target"}else{"target_ambiguous"},"authentication confirmation is not a unique supported one-time button"));}Ok(choices[0])
}
pub(crate) fn typed_action(a:&Value)->Value{
    let mut action=json!({"type":"desktop_type","ref":a["ref"],"text":a["text"],"sensitive":true,"backgroundOnly":true,"secretBindingName":a["secretBindingName"],"secretLease":a["secretLease"],"expectedIdentity":a["expectedIdentity"]});
    for key in["app","pid","window"]{if let Some(value)=a.get(key){action[key]=value.clone();}}action
}
pub(crate) fn filled(a:&Value,provider:&str,identity:Value,submitted:Option<String>,closed:bool,closure_error:Option<String>,generation:String)->Value{
    let mut data=json!({"filled":true,"chars":a["text"].as_str().unwrap().chars().count(),"shape":"password","provider":provider,"delivery":"native-value-set","valueAccepted":null,"pressedUsePassword":false,"usernameFixed":false,"routing":format!("pid={}",identity["pid"]),"submitted":submitted,"dialogClosed":closed,"generation":generation,"targetIdentity":identity});
    if let Some(error)=closure_error{data["closureObservationError"]=json!(error);}success(data)
}
pub fn capability(session:&str)->Value{
    json!({"operation":"authdialog","compiled":true,"present":true,"permission":"unknown","session":session,"effective":false,"background":"semantic","provider":"interceptor-desktop-rust","versions":{"contract":"1","qualification":"source-only"},"limits":["Current graphical login, retained exact native process/window/password field and existing direct graphical secret grant are required.","Windows requires an eligible signed ordinary-desktop system broker. Protected desktops are refused.","Linux requires an eligible root-owned standalone Polkit agent with a supported AT-SPI secure control.","Account selection, native acceptance, background focus, deadlines and installed qualification remain open."],"reason":"Native dialog implementation is present but unqualified; no effective authentication capability is claimed."})
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn authentication_discovery_uses_the_common_handshake_without_qualification(){
        let capability=capability("owned-login");
        assert!(serde_json::from_value::<crate::contract_generated::DesktopCapability>(capability.clone()).is_ok());
        assert_eq!(capability["operation"],"authdialog");
        assert_eq!(capability["session"],"owned-login");
        assert_eq!(capability["compiled"],true);
        assert_eq!(capability["present"],true);
        assert_eq!(capability["effective"],false);
        assert_eq!(capability["permission"],"unknown");
        assert_eq!(capability["versions"]["qualification"],"source-only");
        assert!(capability["limits"].as_array().is_some_and(|limits|!limits.is_empty()));
    }
}

#[cfg(target_os="linux")]
pub(crate) fn trusted_agent(identity:&Value,deadline:Instant)->Result<(),Value>{
    use std::os::unix::fs::MetadataExt;
    check_deadline(deadline)?;
    let executable=identity["executable"].as_str().ok_or_else(||failure("permission_denied","authentication agent path is unavailable"))?;
    let path=std::fs::canonicalize(executable).map_err(|_|failure("target_gone","authentication agent image path changed"))?;
    let names=["polkit-gnome-authentication-agent-1","polkit-kde-authentication-agent-1","lxqt-policykit-agent","mate-polkit","xfce-polkit","hyprpolkitagent"];
    if !path.starts_with("/usr")||!path.file_name().and_then(|v|v.to_str()).is_some_and(|v|names.contains(&v)){
        return Err(failure("unsupported_target","authentication requires an eligible native Polkit agent; integrated shell and screen-lock dialogs are not interchangeable"));
    }
    for ancestor in path.ancestors(){let meta=std::fs::symlink_metadata(ancestor).map_err(|_|failure("permission_denied","authentication agent filesystem authority is unavailable"))?;if meta.uid()!=0||meta.mode()&0o022!=0||meta.file_type().is_symlink(){return Err(failure("permission_denied","authentication agent and parents must be root-owned and not writable by group or others"));}}
    let meta=std::fs::metadata(&path).map_err(|_|failure("target_gone","authentication agent image disappeared"))?;
    if !meta.is_file()||meta.mode()&0o111==0{return Err(failure("permission_denied","authentication agent is not a native executable"));}
    let image=format!("{}:{}:{}:{}:{}",meta.dev(),meta.ino(),meta.ctime(),meta.ctime_nsec(),meta.len());
    if identity["image"].as_str()!=Some(image.as_str()){
        return Err(failure("stale_reference","running authentication image differs from its current root-owned executable"));
    }
    check_deadline(deadline)
}

#[cfg(windows)]
pub(crate) fn ordinary_desktop()->Result<(),Value>{unsafe{
    use windows::Win32::{Foundation::HANDLE,System::StationsAndDesktops::*};
    let desktop=OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0),false,DESKTOP_READOBJECTS).map_err(|_|failure("restricted_by_os","the input desktop cannot be read; protected credential prompts require direct human approval"))?;
    struct Desktop(HDESK);impl Drop for Desktop{fn drop(&mut self){unsafe{let _=CloseDesktop(self.0);}}}let _owner=Desktop(desktop);
    let mut bytes=[0_u16;256];let mut required=0;
    GetUserObjectInformationW(HANDLE(desktop.0),UOI_NAME,Some(bytes.as_mut_ptr().cast()),(bytes.len()*2)as u32,Some(&mut required)).map_err(|_|failure("restricted_by_os","input desktop identity is unavailable"))?;
    if required<2||required as usize>bytes.len()*2||required%2!=0{return Err(failure("provider_failed","input desktop name exceeded its native bound"));}
    let name=String::from_utf16(&bytes[..required as usize/2-1]).map_err(|_|failure("provider_failed","input desktop name is invalid"))?;
    if name!="Default"{return Err(failure("restricted_by_os","protected or non-default input desktop credential delivery is refused"));}Ok(())
}}

#[cfg(windows)]
pub(crate) fn trusted_agent(identity:&Value,deadline:Instant)->Result<(),Value>{unsafe{
    use windows::{core::{BOOL,PCWSTR},Win32::{Foundation::{HANDLE,HWND,INVALID_HANDLE_VALUE},System::SystemInformation::GetSystemDirectoryW,Security::{WinTrust::*,Cryptography::{CertGetNameStringW,CERT_NAME_SIMPLE_DISPLAY_TYPE}}}};
    check_deadline(deadline)?;ordinary_desktop()?;
    let executable=identity["executable"].as_str().ok_or_else(||failure("permission_denied","authentication agent path is unavailable"))?;
    let mut system=[0_u16;32768];let length=GetSystemDirectoryW(Some(&mut system))as usize;
    if length==0||length>=system.len(){return Err(failure("provider_failed","native Windows system directory is unavailable"));}
    let system=String::from_utf16(&system[..length]).map_err(|_|failure("provider_failed","native system directory is invalid"))?;
    if !["CredentialUIBroker.exe","consent.exe"].iter().any(|name|executable.eq_ignore_ascii_case(&format!("{system}\\{name}"))){return Err(failure("unsupported_target","authentication requires an exact Windows system credential broker"));}
    // The provider helpers have no stable import-library contract. Retain the
    // actual system DLL until after WINTRUST_DATA state has been closed.
    let library=crate::native_library::Library::load(&std::path::PathBuf::from(&system).join("wintrust.dll"))?;
    type ProviderData=unsafe extern "system" fn(HANDLE)->*mut CRYPT_PROVIDER_DATA;
    type ProviderSigner=unsafe extern "system" fn(*mut CRYPT_PROVIDER_DATA,u32,BOOL,u32)->*mut CRYPT_PROVIDER_SGNR;
    let provider_data:ProviderData=std::mem::transmute(library.symbol(c"WTHelperProvDataFromStateData")?);
    let provider_signer:ProviderSigner=std::mem::transmute(library.symbol(c"WTHelperGetProvSignerFromChain")?);
    use std::{io::{Seek,SeekFrom},os::windows::{fs::{OpenOptionsExt,MetadataExt},io::AsRawHandle}};
    use windows::Win32::{Security::Cryptography::{Catalog::CATALOG_INFO,CERT_STRONG_SIGN_PARA,CertVerifyCertificateChainPolicy,CERT_CHAIN_POLICY_MICROSOFT_ROOT,CERT_CHAIN_POLICY_PARA,CERT_CHAIN_POLICY_STATUS},Storage::FileSystem::{FILE_SHARE_READ,FILE_FLAG_OPEN_REPARSE_POINT,FILE_ATTRIBUTE_REPARSE_POINT}};
    let mut image=std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ.0).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0).open(executable).map_err(|_|failure("permission_denied","credential image could not be retained without concurrent write/delete sharing"))?;
    let metadata=image.metadata().map_err(|_|failure("target_gone","credential image metadata is unavailable"))?;
    if !metadata.is_file()||metadata.file_attributes()&FILE_ATTRIBUTE_REPARSE_POINT.0!=0||metadata.len()==0||metadata.len()>64*1024*1024{return Err(failure("permission_denied","credential image is not a bounded regular non-reparse file"));}
    let image_handle=HANDLE(image.as_raw_handle());
    type Acquire=unsafe extern "system" fn(*mut isize,*const windows::core::GUID,PCWSTR,*const CERT_STRONG_SIGN_PARA,u32)->BOOL;
    type Hash=unsafe extern "system" fn(isize,HANDLE,*mut u32,*mut u8,u32)->BOOL;
    type Enumerate=unsafe extern "system" fn(isize,*const u8,u32,u32,*mut isize)->isize;
    type CatalogInfo=unsafe extern "system" fn(isize,*mut CATALOG_INFO,u32)->BOOL;
    type ReleaseCatalog=unsafe extern "system" fn(isize,isize,u32)->BOOL;
    type ReleaseAdmin=unsafe extern "system" fn(isize,u32)->BOOL;
    struct Catalog{admin:isize,info:isize,release_info:ReleaseCatalog,release_admin:ReleaseAdmin,path:Box<CATALOG_INFO>,hash:Vec<u8>,tag:Vec<u16>,native:Box<WINTRUST_CATALOG_INFO>}
    impl Drop for Catalog{fn drop(&mut self){unsafe{if self.info!=0{let _=(self.release_info)(self.admin,self.info,0);}if self.admin!=0{let _=(self.release_admin)(self.admin,0);}}}}
    // Declared before the verification owner: native state closes before its
    // catalog buffers/admin, then the image handle and DLL are released.
    let mut catalog:Option<Catalog>=None;
    let path=executable.encode_utf16().chain([0]).collect::<Vec<_>>();
    let mut file=WINTRUST_FILE_INFO{cbStruct:std::mem::size_of::<WINTRUST_FILE_INFO>()as u32,pcwszFilePath:PCWSTR(path.as_ptr()),hFile:image_handle,..Default::default()};
    let mut trust=WINTRUST_DATA{cbStruct:std::mem::size_of::<WINTRUST_DATA>()as u32,dwUIChoice:WTD_UI_NONE,fdwRevocationChecks:WTD_REVOKE_NONE,dwUnionChoice:WTD_CHOICE_FILE,Anonymous:WINTRUST_DATA_0{pFile:&mut file},dwStateAction:WTD_STATEACTION_VERIFY,dwProvFlags:WTD_CACHE_ONLY_URL_RETRIEVAL,..Default::default()};
    struct Trust(*mut WINTRUST_DATA);impl Trust{unsafe fn close(&self)->i32{unsafe{(*self.0).dwStateAction=WTD_STATEACTION_CLOSE;let mut action=WINTRUST_ACTION_GENERIC_VERIFY_V2;WinVerifyTrust(HWND(INVALID_HANDLE_VALUE.0),&mut action,self.0.cast())}}}impl Drop for Trust{fn drop(&mut self){unsafe{let _=self.close();}}}let owner=Trust(&mut trust);
    let mut action=WINTRUST_ACTION_GENERIC_VERIFY_V2;
    if WinVerifyTrust(HWND(INVALID_HANDLE_VALUE.0),&mut action,(&raw mut trust).cast())!=0{
        if owner.close()!=0{return Err(failure("provider_failed","native embedded verification state did not close; no catalog fallback was attempted"));}
        trust.hWVTStateData=HANDLE::default();check_deadline(deadline)?;
        let acquire:Acquire=std::mem::transmute(library.symbol(c"CryptCATAdminAcquireContext2")?);
        let hash:Hash=std::mem::transmute(library.symbol(c"CryptCATAdminCalcHashFromFileHandle2")?);
        let enumerate:Enumerate=std::mem::transmute(library.symbol(c"CryptCATAdminEnumCatalogFromHash")?);
        let info:CatalogInfo=std::mem::transmute(library.symbol(c"CryptCATCatalogInfoFromContext")?);
        let release_info:ReleaseCatalog=std::mem::transmute(library.symbol(c"CryptCATAdminReleaseCatalogContext")?);
        let release_admin:ReleaseAdmin=std::mem::transmute(library.symbol(c"CryptCATAdminReleaseContext")?);
        catalog=Some(Catalog{admin:0,info:0,release_info,release_admin,path:Box::new(CATALOG_INFO{cbStruct:std::mem::size_of::<CATALOG_INFO>()as u32,..Default::default()}),hash:Vec::new(),tag:Vec::new(),native:Box::default()});
        let catalog=catalog.as_mut().unwrap();
        if !acquire(&mut catalog.admin,&DRIVER_ACTION_VERIFY,windows::core::w!("SHA256"),std::ptr::null(),0).as_bool()||catalog.admin==0{return Err(failure("permission_denied","native SHA256 catalog authority is unavailable"));}
        check_deadline(deadline)?;
        let mut size=0;
        image.seek(SeekFrom::Start(0)).map_err(|_|failure("provider_failed","credential image could not be positioned for native hashing"))?;
        let sized=hash(catalog.admin,image_handle,&mut size,std::ptr::null_mut(),0).as_bool();
        if size!=32||!sized&&windows::Win32::Foundation::GetLastError()!=windows::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER{return Err(failure("permission_denied","native SHA256 catalog hash size is unavailable"));}
        check_deadline(deadline)?;catalog.hash.resize(size as usize,0);
        image.seek(SeekFrom::Start(0)).map_err(|_|failure("provider_failed","credential image could not be positioned for native hashing"))?;
        if !hash(catalog.admin,image_handle,&mut size,catalog.hash.as_mut_ptr(),0).as_bool()||size!=32{return Err(failure("permission_denied","native credential catalog hash failed"));}
        check_deadline(deadline)?;
        // One actual matching catalog is admitted. Multiple-catalog selection
        // is not inferred or replayed after native verification failure.
        catalog.info=enumerate(catalog.admin,catalog.hash.as_ptr(),size,0,std::ptr::null_mut());
        if catalog.info==0||!info(catalog.info,&mut *catalog.path,0).as_bool(){return Err(failure("permission_denied","native credential image has no readable matching catalog"));}
        if catalog.path.wszCatalogFile[0]==0||!catalog.path.wszCatalogFile.contains(&0){return Err(failure("resource_limit","native catalog path exceeds its bound"));}
        catalog.tag=catalog.hash.iter().map(|byte|format!("{byte:02X}")).collect::<String>().encode_utf16().chain([0]).collect();
        *catalog.native=WINTRUST_CATALOG_INFO{cbStruct:std::mem::size_of::<WINTRUST_CATALOG_INFO>()as u32,pcwszCatalogFilePath:PCWSTR(catalog.path.wszCatalogFile.as_ptr()),pcwszMemberTag:PCWSTR(catalog.tag.as_ptr()),pcwszMemberFilePath:PCWSTR(path.as_ptr()),hMemberFile:image_handle,pbCalculatedFileHash:catalog.hash.as_mut_ptr(),cbCalculatedFileHash:size,hCatAdmin:catalog.admin,..Default::default()};
        trust.dwUnionChoice=WTD_CHOICE_CATALOG;trust.Anonymous=WINTRUST_DATA_0{pCatalog:&mut *catalog.native};trust.dwStateAction=WTD_STATEACTION_VERIFY;
        check_deadline(deadline)?;
        if WinVerifyTrust(HWND(INVALID_HANDLE_VALUE.0),&mut action,(&raw mut trust).cast())!=0{return Err(failure("permission_denied","native matching catalog did not verify the credential member"));}
    }
    check_deadline(deadline)?;
    let provider=provider_data(trust.hWVTStateData);
    if provider.is_null(){return Err(failure("permission_denied","native credential signer proof is unavailable"));}
    let signer=provider_signer(provider,0,false.into(),0);
    if signer.is_null()||(*signer).csCertChain==0||(*signer).pasCertChain.is_null()||(*signer).dwError!=0{return Err(failure("permission_denied","native credential signer chain is unavailable"));}
    if (*signer).pChainContext.is_null(){return Err(failure("permission_denied","native credential root chain is unavailable"));}
    let policy=CERT_CHAIN_POLICY_PARA{cbSize:std::mem::size_of::<CERT_CHAIN_POLICY_PARA>()as u32,..Default::default()};
    let mut policy_status=CERT_CHAIN_POLICY_STATUS{cbSize:std::mem::size_of::<CERT_CHAIN_POLICY_STATUS>()as u32,..Default::default()};
    if !CertVerifyCertificateChainPolicy(CERT_CHAIN_POLICY_MICROSOFT_ROOT,(*signer).pChainContext,&policy,&mut policy_status).as_bool()||policy_status.dwError!=0{return Err(failure("permission_denied","native credential signer does not chain to an actual Microsoft root public key"));}
    check_deadline(deadline)?;
    let certificate=(*(*signer).pasCertChain).pCert;if certificate.is_null(){return Err(failure("permission_denied","native credential signer certificate is unavailable"));}
    let mut name=[0_u16;512];let count=CertGetNameStringW(certificate,CERT_NAME_SIMPLE_DISPLAY_TYPE,0,None,Some(&mut name))as usize;
    if count<2||count>name.len(){return Err(failure("permission_denied","native credential publisher is unavailable"));}
    let publisher=String::from_utf16(&name[..count-1]).map_err(|_|failure("permission_denied","native credential publisher is invalid"))?;
    if publisher!="Microsoft Windows"&&publisher!="Microsoft Corporation"{return Err(failure("permission_denied","native credential broker is not signed by the expected Microsoft publisher"));}
    check_deadline(deadline)?;ordinary_desktop()
}}
