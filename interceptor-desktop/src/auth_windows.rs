use crate::{failure,success};
use serde_json::{Value,json};
use std::time::{Duration,Instant};
use windows::{core::{w,HSTRING,PCWSTR,PWSTR},Security::Credentials::UI::{UserConsentVerifier,UserConsentVerifierAvailability,UserConsentVerificationResult},Win32::{Foundation::{HWND,HANDLE,CloseHandle},Security::{Credentials::*,LogonUserW,LOGON32_LOGON_INTERACTIVE,LOGON32_PROVIDER_DEFAULT},System::{Com::{CoInitializeEx,CoUninitialize,CoTaskMemFree,COINIT_MULTITHREADED},WinRT::IUserConsentVerifierInterop},UI::WindowsAndMessaging::*}};
use windows_future::{IAsyncOperation,IAsyncAction,IAsyncInfo,AsyncStatus};
use windows::core::Interface;

struct Apartment;impl Drop for Apartment{fn drop(&mut self){unsafe{CoUninitialize();}}}
struct Window(HWND);impl Drop for Window{fn drop(&mut self){unsafe{let _=DestroyWindow(self.0);}}}
struct Token(HANDLE);impl Drop for Token{fn drop(&mut self){unsafe{let _=CloseHandle(self.0);}}}
struct Credentials{pointer:*mut std::ffi::c_void,bytes:u32}
impl Drop for Credentials{fn drop(&mut self){unsafe{
    if !self.pointer.is_null(){for i in 0..self.bytes as usize{std::ptr::write_volatile(self.pointer.cast::<u8>().add(i),0);}CoTaskMemFree(Some(self.pointer));}
}}}
struct SecretWide(Vec<u16>);
impl Drop for SecretWide{fn drop(&mut self){for unit in &mut self.0{unsafe{std::ptr::write_volatile(unit,0);}}}}

fn password_approval(action:&Value,identity:&Value,owner:HWND)->Result<(),(i64,&'static str)>{unsafe{
    let reason:Vec<u16>=action["reason"].as_str().unwrap().encode_utf16().chain([0]).collect();
    if reason.len()>1025{return Err((87,"Windows credential dialog reason exceeds 1024 UTF-16 units"));}
    let info=CREDUI_INFOW{cbSize:std::mem::size_of::<CREDUI_INFOW>()as u32,hwndParent:owner,pszMessageText:PCWSTR(reason.as_ptr()),pszCaptionText:w!("Authenticate for Interceptor"),..Default::default()};
    let mut package=0;let mut credentials=Credentials{pointer:std::ptr::null_mut(),bytes:0};
    let code=CredUIPromptForWindowsCredentialsW(Some(&info),0,&mut package,None,0,&mut credentials.pointer,&mut credentials.bytes,None,CREDUIWIN_ENUMERATE_CURRENT_USER);
    if code!=0{return Err((code as i64,if code==1223{"authentication cancelled"}else{"native Windows credential dialog failed"}));}
    if credentials.pointer.is_null()||credentials.bytes==0||credentials.bytes>65536{return Err((87,"native credential buffer is unavailable or exceeds its limit"));}
    let mut user=SecretWide(vec![0;513]);let mut domain=SecretWide(vec![0;256]);let mut password=SecretWide(vec![0;513]);
    let(mut user_size,mut domain_size,mut password_size)=(user.0.len()as u32,domain.0.len()as u32,password.0.len()as u32);
    CredUnPackAuthenticationBufferW(CRED_PACK_PROTECTED_CREDENTIALS,credentials.pointer,credentials.bytes,Some(PWSTR(user.0.as_mut_ptr())),&mut user_size,Some(PWSTR(domain.0.as_mut_ptr())),Some(&mut domain_size),Some(PWSTR(password.0.as_mut_ptr())),&mut password_size)
        .map_err(|error|(error.code().0 as i64,"native credentials could not be unpacked within their limits"))?;
    if user.0[0]==0||password.0[0]==0||![&user.0,&domain.0,&password.0].iter().all(|value|value.contains(&0)){return Err((1326,"empty or invalid native credentials cannot approve authentication"));}
    let mut token=HANDLE::default();
    LogonUserW(PCWSTR(user.0.as_ptr()),if domain.0[0]==0{PCWSTR::null()}else{PCWSTR(domain.0.as_ptr())},PCWSTR(password.0.as_ptr()),LOGON32_LOGON_INTERACTIVE,LOGON32_PROVIDER_DEFAULT,&mut token)
        .map_err(|error|(error.code().0 as i64,"native logon refused the supplied credentials"))?;
    let token=Token(token);
    let sid=crate::windows::token_sid(token.0).map_err(|error|(error.code().0 as i64,"native authenticated user identity is unavailable"))?;
    if identity["sid"]!=sid{return Err((5,"native credentials authenticated a different user; approval was discarded"));}
    Ok(())
}}
fn await_info(info:&IAsyncInfo,deadline:Instant,owner:Option<HWND>)->windows::core::Result<()>{
    loop{
        if info.Status()?!=AsyncStatus::Started{return Ok(());}
        if Instant::now()>=deadline||owner.is_some_and(|window|unsafe{!IsWindow(Some(window)).as_bool()}){
            let _=info.Cancel();return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x800704c7_u32 as i32)));
        }
        unsafe{let mut message=MSG::default();while PeekMessageW(&mut message,None,0,0,PM_REMOVE).as_bool(){let _=TranslateMessage(&message);DispatchMessageW(&message);}}
        std::thread::sleep(Duration::from_millis(10));
    }
}
pub(crate) fn await_result<T:windows::core::RuntimeType>(operation:&IAsyncOperation<T>,deadline:Instant,owner:Option<HWND>)->windows::core::Result<T>{
    await_info(&operation.cast::<IAsyncInfo>()?,deadline,owner)?;
    operation.GetResults()
}
pub(crate) fn await_action(operation:&IAsyncAction,deadline:Instant,owner:Option<HWND>)->windows::core::Result<()>{
    await_info(&operation.cast::<IAsyncInfo>()?,deadline,owner)?;
    operation.GetResults()
}
pub fn execute(action:&Value,identity:&Value)->Value{
    let policy=action["policy"].as_str().unwrap_or("any");let provider="windows-native-auth";
    if action["sub"]=="invalidate"{return success(json!({"invalidated":true,"provider":provider}));}
    if action["sub"]=="domain-state"{return success(json!({"available":false,"provider":provider,"reason":"Windows Hello consent does not expose a biometric enrollment domain state"}));}
    if action.get("fallback_title").is_some()||action.get("cancel_title").is_some(){return failure("unsupported_operation","Windows controls its native authentication prompt button titles");}
    let init=unsafe{CoInitializeEx(None,COINIT_MULTITHREADED)};
    if init.is_err(){return failure("provider_failed","Windows authentication COM initialization failed");}let _apartment=Apartment;
    let available=match UserConsentVerifier::CheckAvailabilityAsync().and_then(|operation|await_result(&operation,Instant::now()+Duration::from_secs(10),None)){
        Ok(value)=>value,Err(error)=>return failure("provider_failed",format!("Windows Hello availability failed (HRESULT {:08x})",error.code().0)),
    };
    // Hello permits PIN/password fallback. It cannot satisfy a biometric-only
    // policy, so never reinterpret Verified as biometric evidence.
    let provider=if available==UserConsentVerifierAvailability::Available{"windows-hello"}else{"windows-credentials"};
    let policies=vec!["any"];
    if action["sub"]=="status"{
        let mut data=json!({"canEvaluate":policies.contains(&policy),"policy":policy,"provider":provider,"user":identity["sid"],"biometryType":"unspecified","availablePolicies":policies});
        if !policies.contains(&policy){data["error"]=json!("this policy requires a dedicated biometric or watch authentication backend");data["errorCode"]=json!(available.0);}
        return success(data);
    }
    if policy!="any"{return failure("unsupported_operation","biometric-only and watch authentication require a matching native backend; Windows Hello PIN approval is insufficient");}
    let started=Instant::now();
    if available!=UserConsentVerifierAvailability::Available{
        // CredUI is synchronous. A caller-owned window on this blocked thread
        // cannot answer accessibility messages. The documented NULL parent
        // lets the credential broker own and service its native dialog.
        let result=password_approval(action,identity,HWND::default());
        let mut data=json!({"ok":result.is_ok(),"policy":policy,"provider":provider,"user":identity["sid"],"reason":action["reason"],"elapsedMs":started.elapsed().as_millis()as u64,"biometryType":"unspecified"});
        if let Err((code,error))=result{data["errorCode"]=json!(code);data["error"]=json!(error);}
        return success(data);
    }
    let result=(||->windows::core::Result<UserConsentVerificationResult>{unsafe{
        let owner=Window(CreateWindowExW(WS_EX_TOOLWINDOW,w!("STATIC"),w!("Interceptor authentication"),WS_OVERLAPPEDWINDOW|WS_VISIBLE,CW_USEDEFAULT,CW_USEDEFAULT,440,150,None,None,None,None)?);
        let interop:IUserConsentVerifierInterop=windows::core::factory::<UserConsentVerifier,IUserConsentVerifierInterop>()?;
        let operation:IAsyncOperation<UserConsentVerificationResult>=interop.RequestVerificationForWindowAsync(owner.0,&HSTRING::from(action["reason"].as_str().unwrap()))?;
        await_result(&operation,started+Duration::from_secs(165),Some(owner.0))
    }})();
    let mut data=json!({"ok":false,"policy":policy,"provider":provider,"user":identity["sid"],"reason":action["reason"],"elapsedMs":started.elapsed().as_millis()as u64,"biometryType":"unspecified"});
    match result{
        Ok(UserConsentVerificationResult::Verified)=>data["ok"]=json!(true),
        Ok(value)=>{data["errorCode"]=json!(value.0);data["error"]=json!(match value{UserConsentVerificationResult::Canceled=>"authentication cancelled",UserConsentVerificationResult::DeviceBusy=>"authentication device is busy",UserConsentVerificationResult::DeviceNotPresent=>"authentication device not present",UserConsentVerificationResult::DisabledByPolicy=>"authentication disabled by policy",UserConsentVerificationResult::NotConfiguredForUser=>"authentication is not configured for this user",UserConsentVerificationResult::RetriesExhausted=>"authentication retry limit reached",_=>"authentication was not approved"});},
        Err(error)=>{data["errorCode"]=json!(error.code().0);data["error"]=json!("native authentication failed or was cancelled");},
    }
    success(data)
}

unsafe extern "system" fn registration_window(window:HWND,message:u32,wparam:windows::Win32::Foundation::WPARAM,lparam:windows::Win32::Foundation::LPARAM)->windows::Win32::Foundation::LRESULT{unsafe{
    if message==WM_COMMAND&&wparam.0>>16==0{let _=PostMessageW(Some(window),WM_APP+1,wparam,lparam);return windows::Win32::Foundation::LRESULT(0);}
    DefWindowProcW(window,message,wparam,lparam)
}}
pub fn register(request:&crate::secret_registration::Registration)->Value{
    let result=(||->windows::core::Result<Value>{unsafe{
        use windows::Win32::{Foundation::{HINSTANCE,HMODULE,WPARAM},System::LibraryLoader::GetModuleHandleW,UI::{Controls::EM_SETLIMITTEXT,Input::KeyboardAndMouse::SetFocus}};
        let module:HMODULE=GetModuleHandleW(None)?;let instance=HINSTANCE(module.0);
        let class=WNDCLASSW{lpfnWndProc:Some(registration_window),hInstance:instance,lpszClassName:w!("InterceptorSecretRegistration"),..Default::default()};
        if RegisterClassW(&class)==0{return Err(windows::core::Error::from_thread());}
        let owner=Window(CreateWindowExW(WS_EX_TOOLWINDOW,w!("InterceptorSecretRegistration"),w!("Store a secret for Interceptor"),WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,CW_USEDEFAULT,CW_USEDEFAULT,600,470,None,None,Some(instance),None)?);
        let control=|class:PCWSTR,text:PCWSTR,style:WINDOW_STYLE,x,y,width,height,id|CreateWindowExW(WINDOW_EX_STYLE(0),class,text,WS_CHILD|WS_VISIBLE|style,x,y,width,height,Some(owner.0),Some(HMENU(id as *mut _)),Some(instance),None);
        let policy:Vec<u16>=request.policy_text().replace('\n',"\r\n").encode_utf16().chain([0]).collect();
        // Read-only multiline policy remains scrollable when a target list is long.
        control(w!("EDIT"),PCWSTR(policy.as_ptr()),WINDOW_STYLE(ES_MULTILINE as u32|ES_READONLY as u32|ES_AUTOVSCROLL as u32)|WS_VSCROLL,16,12,552,120,10)?;
        control(w!("STATIC"),w!("Stored in your native credential vault. Maximum 8192 UTF-8 bytes."),WINDOW_STYLE(0),16,138,552,35,11)?;
        control(w!("STATIC"),w!("Value"),WINDOW_STYLE(0),16,184,120,22,12)?;
        let value=control(w!("EDIT"),w!(""),WS_BORDER|WS_TABSTOP|WINDOW_STYLE(ES_PASSWORD as u32|ES_AUTOHSCROLL as u32),140,180,420,28,20)?;
        control(w!("STATIC"),w!("Confirm value"),WINDOW_STYLE(0),16,225,120,22,13)?;
        let confirm=control(w!("EDIT"),w!(""),WS_BORDER|WS_TABSTOP|WINDOW_STYLE(ES_PASSWORD as u32|ES_AUTOHSCROLL as u32),140,221,420,28,21)?;
        for field in [value,confirm]{SendMessageW(field,EM_SETLIMITTEXT,Some(WPARAM(8192)),None);}
        let status=control(w!("STATIC"),w!(""),WINDOW_STYLE(0),16,267,552,54,14)?;
        control(w!("BUTTON"),w!("Cancel"),WS_TABSTOP,320,347,112,32,2)?;control(w!("BUTTON"),w!("Save"),WS_TABSTOP,448,347,112,32,1)?;
        let _=SetFocus(Some(value));let deadline=Instant::now()+Duration::from_secs(590);
        let result=loop{
            if !IsWindow(Some(owner.0)).as_bool()||Instant::now()>=deadline{break crate::secret_registration::cancelled();}
            let mut message=MSG::default();if !PeekMessageW(&mut message,None,0,0,PM_REMOVE).as_bool(){MsgWaitForMultipleObjects(None,false,50,QS_ALLINPUT);continue;}
            if message.message==WM_APP+1&&message.hwnd==owner.0{
                if message.wParam.0&0xffff==2{break crate::secret_registration::cancelled();}
                if message.wParam.0&0xffff==1{
                    let mut entered=SecretWide(vec![0u16;8193]);let mut repeated=SecretWide(vec![0u16;8193]);
                    let count=GetWindowTextW(value,&mut entered.0).max(0)as usize;let repeated_count=GetWindowTextW(confirm,&mut repeated.0).max(0)as usize;
                    let mut first=String::from_utf16(&entered.0[..count]).unwrap_or_default();let mut second=String::from_utf16(&repeated.0[..repeated_count]).unwrap_or_default();
                    let matches=crate::secret_registration::value_matches(&first,&second);
                    for byte in second.as_bytes_mut(){std::ptr::write_volatile(byte,0);}
                    if matches{break crate::secret_registration::registered(first);}
                    for byte in first.as_bytes_mut(){std::ptr::write_volatile(byte,0);}
                    SetWindowTextW(confirm,w!(""))?;SetWindowTextW(status,w!("Enter matching nonempty values within 8192 UTF-8 bytes."))?;
                }
                continue;
            }
            if message.message==WM_KEYDOWN&&message.wParam.0==27{break crate::secret_registration::cancelled();}
            // Modeless dialog handling supplies Tab navigation and native button keys.
            if !IsDialogMessageW(owner.0,&message).as_bool(){let _=TranslateMessage(&message);DispatchMessageW(&message);}
        };
        let _=SetWindowTextW(value,w!(""));let _=SetWindowTextW(confirm,w!(""));Ok(result)
    }})();
    result.unwrap_or_else(|_|failure("provider_failed","native secure registration failed; no value was stored"))
}
