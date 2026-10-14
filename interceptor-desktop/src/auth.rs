use crate::{contract_generated::*,failure};
use serde_json::{Value,json};
use std::{io::{self,Read},process::{Child,Command,Stdio},sync::Mutex,time::{Duration,Instant}};

static PROMPT:Mutex<()>=Mutex::new(());

// Reap only our helper on every error path. Never join a blocking pipe reader:
// a descendant can retain stdout after the helper exits or is killed.
pub(crate) struct AuthChild(pub Child);
impl Drop for AuthChild{fn drop(&mut self){if self.0.try_wait().ok().flatten().is_none(){let _=self.0.kill();}let _=self.0.wait();}}

#[cfg(unix)]pub(crate) fn ready_read<T:Read+std::os::fd::AsRawFd>(output:&mut T,bytes:&mut [u8])->io::Result<usize>{
        let fd=output.as_raw_fd();let flags=unsafe{libc::fcntl(fd,libc::F_GETFL)};
        if flags<0||unsafe{libc::fcntl(fd,libc::F_SETFL,flags|libc::O_NONBLOCK)}<0{return Err(io::Error::last_os_error());}
        output.read(bytes)
}
#[cfg(windows)]pub(crate) fn ready_read<T:Read+std::os::windows::io::AsRawHandle>(output:&mut T,bytes:&mut [u8])->io::Result<usize>{
        use windows::Win32::{Foundation::{ERROR_BROKEN_PIPE,HANDLE},System::Pipes::PeekNamedPipe};
        let mut available=0;
        if let Err(error)=unsafe{PeekNamedPipe(HANDLE(output.as_raw_handle()),None,0,None,Some(&mut available),None)}{
            if error.code()==ERROR_BROKEN_PIPE.to_hresult(){return Ok(0);}return Err(io::Error::other(error));
        }
        if available==0{return Err(io::ErrorKind::WouldBlock.into());}
        let size=bytes.len().min(available as usize);output.read(&mut bytes[..size])
}

fn bounded_result(read:impl FnMut(&mut [u8])->io::Result<usize>,deadline:Instant)->io::Result<Vec<u8>>{
    bounded_child_result(read,deadline,16384)
}
pub(crate) fn bounded_child_result(mut read:impl FnMut(&mut [u8])->io::Result<usize>,deadline:Instant,limit:usize)->io::Result<Vec<u8>>{
    let mut bytes=vec![0u8;4];let mut offset=0;let mut framed=false;
    loop{
        if Instant::now()>=deadline{return Err(io::ErrorKind::TimedOut.into());}
        match read(&mut bytes[offset..]){
            Ok(0)=>return Err(io::Error::new(io::ErrorKind::UnexpectedEof,"authentication helper closed without a complete result")),
            Ok(count)=>{offset+=count;if offset==bytes.len(){
                if framed{return Ok(bytes.split_off(4));}
                let size=u32::from_le_bytes(bytes[..4].try_into().unwrap())as usize;
                if size==0||size>limit{return Err(io::Error::new(io::ErrorKind::InvalidData,"native helper result exceeds its limit"));}
                bytes.resize(size+4,0);framed=true;
            }},
            Err(error)if error.kind()==io::ErrorKind::Interrupted=>(),
            Err(error)if error.kind()==io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(10).min(deadline.saturating_duration_since(Instant::now()))),
            Err(error)=>return Err(error),
        }
    }
}

pub fn validate(action:&Value)->Result<(),Value>{
    if let Some(error)=desktop_auth_shape_error(action){return Err(failure("invalid_request",error));}
    let confirm=action["sub"]=="confirm";
    if !confirm&&["reason","reuse_seconds","fallback_title","cancel_title"].iter().any(|key|action.get(key).is_some()){
        return Err(failure("invalid_request","authentication prompt fields require confirm"));
    }
    if !confirm&&action["sub"]!="status"&&action.get("policy").is_some(){return Err(failure("invalid_request","authentication policy requires status or confirm"));}
    if confirm&&action["reason"].as_str().is_none_or(|s|s.trim().is_empty()){return Err(failure("invalid_request","authentication confirm requires a reason"));}
    for (key,cap) in [("reason",DESKTOP_AUTH_MAX_REASON_BYTES),("fallback_title",DESKTOP_AUTH_MAX_TITLE_BYTES),("cancel_title",DESKTOP_AUTH_MAX_TITLE_BYTES)]{
        if action[key].as_str().is_some_and(|s|s.len()>cap||s.contains('\0')){return Err(failure("invalid_request","authentication text exceeds its limit or contains NUL"));}
    }
    if action.get("reuse_seconds").is_some_and(|v|v.as_f64().is_none_or(|n|n.fract()!=0.0||!(0.0..=300.0).contains(&n))){return Err(failure("invalid_request","authentication reuse requires an integer 0..300 seconds"));}
    Ok(())
}

pub fn dispatch(action:&Value)->Value{
    if let Err(error)=validate(action){return error;}
    // One helper process owns each GUI/COM/PAM conversation. The provider's
    // accessibility and capture workers stay available while approval waits.
    let _prompt=if action["sub"]=="confirm"{match PROMPT.try_lock(){Ok(guard)=>Some(guard),Err(_)=>return failure("resource_limit","another native authentication prompt is pending")}}else{None};
    let identity=match identity(){Ok(identity)=>identity,Err(error)=>return error};
    let result=(||->std::io::Result<Value>{
        let mut child=AuthChild(Command::new(std::env::current_exe()?).arg("--auth-ui").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?);
        let deadline=Instant::now()+Duration::from_millis(DESKTOP_AUTH_DEADLINE_MS as u64);
        let bytes=serde_json::to_vec(action)?;
        if let Some(mut input)=child.0.stdin.take(){crate::write_frame(&mut input,&bytes)?;}
        let mut output=child.0.stdout.take().ok_or_else(||std::io::Error::other("authentication helper output unavailable"))?;
        let bytes=bounded_result(|bytes|ready_read(&mut output,bytes),deadline)?;
        let status=loop{
            if let Some(status)=child.0.try_wait()?{break status;}
            if Instant::now()>=deadline{return Err(io::ErrorKind::TimedOut.into());}
            std::thread::sleep(Duration::from_millis(20));
        };
        if !status.success(){return Err(std::io::Error::other("authentication helper failed"));}
        Ok(serde_json::from_slice(&bytes)?)
    })();
    if self::identity().ok().as_ref()!=Some(&identity){return failure("permission_denied","the native authentication login changed; approval was discarded");}
    result.unwrap_or_else(|error|if error.kind()==io::ErrorKind::TimedOut{failure("cancelled","native authentication deadline expired; no approval was granted")}else{failure("provider_failed","native authentication helper failed; no approval was granted")})
}

pub fn helper()->std::io::Result<()>{
    let bytes=crate::read_frame(&mut std::io::stdin().lock())?.ok_or_else(||std::io::Error::other("authentication helper requires a request on stdin"))?;
    let action:Value=serde_json::from_slice(&bytes)?;
    let result=match validate(&action){Err(error)=>error,Ok(())=>match identity(){
        Err(error)=>error,
        Ok(before)=>{
            #[cfg(windows)]let result=crate::auth_windows::execute(&action,&before);
            #[cfg(target_os="linux")]let result=crate::auth_linux::execute(&action,&before);
            #[cfg(not(any(windows,target_os="linux")))]let result=failure("unsupported_operation","macOS uses LocalAuthentication in the Swift bridge");
            if identity().ok().as_ref()==Some(&before){result}else{failure("permission_denied","the authentication login changed; approval was discarded")}
        }
    }};
    crate::write_frame(&mut std::io::stdout().lock(),&serde_json::to_vec(&result)?)
}

pub(crate) fn identity()->Result<Value,Value>{
    #[cfg(windows)]{
        if crate::windows::session()=="0"{return Err(failure("no_interactive_session","native authentication requires a graphical login"));}
        return crate::windows::identity().map_err(|_|failure("permission_denied","native authentication user identity is unavailable"));
    }
    #[cfg(target_os="linux")]return crate::linux::login_identity(0).map(|identity|json!({"uid":unsafe{libc::getuid()},"session":identity.id,"started":identity.start_usec})).ok_or_else(||failure("no_interactive_session","native authentication requires the retained graphical login"));
    #[cfg(not(any(windows,target_os="linux")))]Err(failure("unsupported_operation","macOS uses the signed Swift bridge"))
}

pub fn capability(session:&str)->Value{
    #[cfg(windows)]let provider="windows-hello";
    #[cfg(target_os="linux")]let provider="linux-pam";
    #[cfg(not(any(windows,target_os="linux")))]let provider="local-authentication";
    json!({"operation":"auth","compiled":true,"present":true,"permission":"not_applicable","session":session,"effective":false,"background":"unavailable","provider":provider,"versions":{},"limits":["Availability is checked by auth status; approval requires the current user's native authentication UI.","Each Windows/Linux approval is fresh. Biometric-only and watch policies are refused unless a matching native backend is implemented."],"reason":"Native prompts require user interaction; discovery is not authentication evidence."})
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn framed_result_is_bounded_before_allocating_payload(){
        let mut valid=io::Cursor::new([3u32.to_le_bytes().as_slice(),b"yes"].concat());
        assert_eq!(bounded_result(|out|valid.read(&mut out[..1]),Instant::now()+Duration::from_secs(1)).unwrap(),b"yes");
        for length in [0u32,16385,u32::MAX]{let mut input=io::Cursor::new(length.to_le_bytes());assert_eq!(bounded_result(|out|input.read(out),Instant::now()+Duration::from_secs(1)).unwrap_err().kind(),io::ErrorKind::InvalidData);}
        let mut partial=io::Cursor::new([5u32.to_le_bytes().as_slice(),b"no"].concat());
        assert_eq!(bounded_result(|out|partial.read(out),Instant::now()+Duration::from_secs(1)).unwrap_err().kind(),io::ErrorKind::UnexpectedEof);
        let payload=vec![b'x';DESKTOP_MAX_RESULT_BYTES];
        let mut image=io::Cursor::new([(payload.len()as u32).to_le_bytes().as_slice(),&payload].concat());
        assert_eq!(bounded_child_result(|out|image.read(out),Instant::now()+Duration::from_secs(1),DESKTOP_MAX_RESULT_BYTES).unwrap(),payload);
        for length in [0u32,DESKTOP_MAX_RESULT_BYTES as u32+1,u32::MAX]{
            let mut input=io::Cursor::new(length.to_le_bytes());
            assert_eq!(bounded_child_result(|out|input.read(out),Instant::now()+Duration::from_secs(1),DESKTOP_MAX_RESULT_BYTES).unwrap_err().kind(),io::ErrorKind::InvalidData);
        }
    }
    #[test]fn pending_stdout_cannot_extend_the_authentication_deadline(){
        let started=Instant::now();let error=bounded_result(|_|Err(io::ErrorKind::WouldBlock.into()),started+Duration::from_millis(30)).unwrap_err();
        assert_eq!(error.kind(),io::ErrorKind::TimedOut);assert!(started.elapsed()<Duration::from_secs(1));
    }
    #[cfg(unix)]#[test]fn owned_helper_is_reaped_on_timeout(){
        let mut child=AuthChild(Command::new("/bin/sleep").arg("5").stdout(Stdio::piped()).spawn().unwrap());let pid=child.0.id();
        let mut output=child.0.stdout.take().unwrap();assert_eq!(bounded_result(|out|ready_read(&mut output,out),Instant::now()+Duration::from_millis(30)).unwrap_err().kind(),io::ErrorKind::TimedOut);
        drop(child);assert_eq!(unsafe{libc::kill(pid as i32,0)},-1);assert_eq!(io::Error::last_os_error().raw_os_error(),Some(libc::ESRCH));
    }
    #[test]fn request_validation_precedes_native_initialization(){
        for fields in [json!({"sub":"unknown"}),json!({"sub":"status","reason":"x"}),json!({"sub":"confirm"}),json!({"sub":"confirm","reason":" "}),json!({"sub":"confirm","reason":"x\u{0000}"}),json!({"sub":"confirm","reason":"x","reuse_seconds":0.5}),json!({"sub":"confirm","reason":"x","reuse_seconds":301}),json!({"sub":"confirm","reason":"界".repeat(683)}),json!({"sub":"status","extra":true}),json!({"sub":"status","policy":null})]{
            let mut action=json!({"type":"desktop_auth"});action.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());assert_eq!(dispatch(&action)["code"],"invalid_request","{action}");
        }
        for sub in ["status","confirm","invalidate","domain-state"]{let mut action=json!({"type":"desktop_auth","sub":sub});if sub=="confirm"{action["reason"]=json!("Owned Unicode 验证");action["reuse_seconds"]=json!(300);}assert!(validate(&action).is_ok());}
    }
}
