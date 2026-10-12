use crate::{failure, success};
use serde_json::{Value, json};
use std::{cell::RefCell,collections::{HashMap,VecDeque}, rc::Rc, sync::{Arc,OnceLock, mpsc,atomic::Ordering}, time::{Duration, Instant}};
#[path = "windows_input.rs"] mod input;
use windows::{core::{Interface, PCWSTR, PWSTR}, Win32::{
    Foundation::{CloseHandle, HANDLE, HWND, LPARAM, WPARAM, RECT, LocalFree, HLOCAL, ERROR_PIPE_CONNECTED, ERROR_IO_PENDING, ERROR_BROKEN_PIPE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
    Security::{GetTokenInformation, TOKEN_QUERY, TokenUser, TOKEN_USER, SECURITY_ATTRIBUTES, PSECURITY_DESCRIPTOR,
        Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW}},
    System::{Com::{CoCreateInstance, CoInitializeEx, COINIT_MULTITHREADED, CLSCTX_INPROC_SERVER},
        Threading::{GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, CreateEventW, WaitForSingleObject},
        IO::{OVERLAPPED, CancelIoEx, GetOverlappedResult},
        RemoteDesktop::ProcessIdToSessionId,
        Pipes::{CreateNamedPipeW, ConnectNamedPipe, GetNamedPipeClientSessionId, GetNamedPipeServerProcessId, PIPE_TYPE_BYTE, PIPE_READMODE_BYTE, PIPE_WAIT, PIPE_REJECT_REMOTE_CLIENTS},
    },
    Storage::FileSystem::{PIPE_ACCESS_DUPLEX, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, ReadFile, WriteFile},
    UI::{Accessibility::*, WindowsAndMessaging::*},
}};

pub(crate) struct OwnedHandle(pub(crate) HANDLE);
impl Drop for OwnedHandle { fn drop(&mut self) { unsafe { let _ = CloseHandle(self.0); } } }

fn private(path:&std::path::Path,user:&str)->std::io::Result<()> {
        use std::os::windows::{ffi::OsStrExt,fs::MetadataExt};
        use windows::Win32::Security::{ACL,PSID,GetAce,EqualSid,ACCESS_ALLOWED_ACE,OWNER_SECURITY_INFORMATION,DACL_SECURITY_INFORMATION,
            Authorization::{GetNamedSecurityInfoW,SE_FILE_OBJECT}};
        let meta=std::fs::symlink_metadata(path)?;
        if meta.file_attributes()&0x400!=0 {return Err(std::io::Error::other("event paths cannot be reparse points"));}
        let wide:Vec<u16>=path.as_os_str().encode_wide().chain([0]).collect();
        unsafe {
            let mut owner=PSID::default();let mut dacl:*mut ACL=std::ptr::null_mut();let mut descriptor=PSECURITY_DESCRIPTOR::default();
            GetNamedSecurityInfoW(PCWSTR(wide.as_ptr()),SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,Some(&mut owner),None,Some(&mut dacl),None,&mut descriptor).ok().map_err(std::io::Error::other)?;
            let result=(||{
                let mut text=PWSTR::null();ConvertSidToStringSidW(owner,&mut text).map_err(std::io::Error::other)?;
                let actual=text.to_string().map_err(std::io::Error::other);let _=LocalFree(Some(HLOCAL(text.0.cast())));
                if actual?!=user||dacl.is_null()||(*dacl).AceCount!=1 {return Err(std::io::Error::other("event path owner or private ACL mismatch"));}
                let mut raw=std::ptr::null_mut();GetAce(dacl,0,&mut raw).map_err(std::io::Error::other)?;
                let ace=raw.cast::<ACCESS_ALLOWED_ACE>();
                if (*ace).Header.AceType!=0||(*ace).Mask!=0x001f01ff {return Err(std::io::Error::other("event path ACL is not private full access"));}
                EqualSid(owner,PSID((&raw mut (*ace).SidStart).cast())).map_err(std::io::Error::other)
            })();
            let _=LocalFree(Some(HLOCAL(descriptor.0)));result
        }
}
fn private_security<T>(operation:impl FnOnce(&SECURITY_ATTRIBUTES,&str)->std::io::Result<T>)->std::io::Result<T>{
    let user=unsafe{sid(GetCurrentProcess())}.map_err(std::io::Error::other)?;
    let sddl:Vec<u16>=format!("O:{user}D:P(A;;FA;;;{user})").encode_utf16().chain([0]).collect();
    unsafe{
        let mut descriptor=PSECURITY_DESCRIPTOR::default();ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(sddl.as_ptr()),1,&mut descriptor,None).map_err(std::io::Error::other)?;
        let security=SECURITY_ATTRIBUTES{nLength:std::mem::size_of::<SECURITY_ATTRIBUTES>()as u32,lpSecurityDescriptor:descriptor.0,bInheritHandle:false.into()};
        let result=operation(&security,&user);let _=LocalFree(Some(HLOCAL(descriptor.0)));result
    }
}
pub fn private_directory(path:&std::path::Path)->std::io::Result<()>{
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::CreateDirectoryW;
    private_security(|security,user|unsafe{
        let wide:Vec<u16>=path.as_os_str().encode_wide().chain([0]).collect();
        if let Err(error)=CreateDirectoryW(PCWSTR(wide.as_ptr()),Some(security)){if !path.is_dir(){return Err(std::io::Error::other(error));}}
        private(path,user)
    })
}
pub fn private_output(path:&std::path::Path)->std::io::Result<std::fs::File>{
    use std::os::windows::{ffi::OsStrExt,io::FromRawHandle};
    use windows::Win32::{Foundation::GENERIC_WRITE,Storage::FileSystem::{CreateFileW,GetFileInformationByHandle,BY_HANDLE_FILE_INFORMATION,
        FILE_SHARE_READ,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,FILE_FLAG_OPEN_REPARSE_POINT}};
    private_security(|security,user|unsafe{
        let wide:Vec<u16>=path.as_os_str().encode_wide().chain([0]).collect();
        let handle=OwnedHandle(CreateFileW(PCWSTR(wide.as_ptr()),GENERIC_WRITE.0,FILE_SHARE_READ,Some(security),CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,None).map_err(std::io::Error::other)?);
        private(path,user)?;let mut info=BY_HANDLE_FILE_INFORMATION::default();GetFileInformationByHandle(handle.0,&mut info).map_err(std::io::Error::other)?;
        if info.nNumberOfLinks!=1||info.dwFileAttributes&0x400!=0{return Err(std::io::Error::other("private output must be a regular, unlinked, owned file"));}
        let file=std::fs::File::from_raw_handle(handle.0.0);std::mem::forget(handle);Ok(file)
    })
}
// Deny write/delete sharing while checking the path ACL, so it cannot be
// rebound between opening this handle and inspecting its ownership.
pub fn private_input(path:&std::path::Path)->std::io::Result<std::fs::File>{
    private_input_sharing(path,false)
}
pub(crate) fn private_input_sharing(path:&std::path::Path,allow_writer:bool)->std::io::Result<std::fs::File>{
    use std::os::windows::{ffi::OsStrExt,io::FromRawHandle};
    use windows::Win32::{Foundation::GENERIC_READ,Storage::FileSystem::{CreateFileW,GetFileInformationByHandle,BY_HANDLE_FILE_INFORMATION,FILE_SHARE_READ,FILE_SHARE_WRITE,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT}};
    private_security(|_,user|unsafe{
        let wide:Vec<u16>=path.as_os_str().encode_wide().chain([0]).collect();
        // Active monitor archives have a retained writer. Delete sharing is
        // still denied, and the same private ACL/link checks apply.
        let sharing=if allow_writer{FILE_SHARE_READ|FILE_SHARE_WRITE}else{FILE_SHARE_READ};
        let handle=OwnedHandle(CreateFileW(PCWSTR(wide.as_ptr()),GENERIC_READ.0,sharing,None,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,None).map_err(|e|std::io::Error::from_raw_os_error(e.code().0&0xffff))?);
        private(path,user)?;let mut info=BY_HANDLE_FILE_INFORMATION::default();GetFileInformationByHandle(handle.0,&mut info).map_err(std::io::Error::other)?;
        if info.nNumberOfLinks!=1||info.dwFileAttributes&0x410!=0{return Err(std::io::Error::other("private input must be a regular, unlinked, owned file"));}
        let file=std::fs::File::from_raw_handle(handle.0.0);std::mem::forget(handle);Ok(file)
    })
}
pub fn private_lock(path:&std::path::Path)->std::io::Result<std::fs::File>{
    use std::os::windows::{ffi::OsStrExt,io::FromRawHandle};
    use windows::Win32::{Foundation::{GENERIC_READ,GENERIC_WRITE},Storage::FileSystem::{CreateFileW,GetFileInformationByHandle,BY_HANDLE_FILE_INFORMATION,OPEN_ALWAYS,FILE_FLAG_OPEN_REPARSE_POINT}};
    private_security(|security,user|unsafe{
        let wide:Vec<u16>=path.as_os_str().encode_wide().chain([0]).collect();
        let handle=OwnedHandle(CreateFileW(PCWSTR(wide.as_ptr()),GENERIC_READ.0|GENERIC_WRITE.0,Default::default(),Some(security),OPEN_ALWAYS,FILE_FLAG_OPEN_REPARSE_POINT,None).map_err(std::io::Error::other)?);
        private(path,user)?;let mut info=BY_HANDLE_FILE_INFORMATION::default();GetFileInformationByHandle(handle.0,&mut info).map_err(std::io::Error::other)?;
        if info.nNumberOfLinks!=1||info.dwFileAttributes&0x410!=0{return Err(std::io::Error::other("private lock must be a regular, unlinked, owned file"));}
        let file=std::fs::File::from_raw_handle(handle.0.0);std::mem::forget(handle);Ok(file)
    })
}
pub fn clipboard_event_file(kind:&str) -> std::io::Result<(std::fs::File,std::path::PathBuf)> {
    if !["clipboard","files","notifications"].contains(&kind){return Err(std::io::Error::other("unknown native event log kind"));}
    use std::os::windows::{ffi::OsStrExt,io::FromRawHandle};
    use windows::Win32::{Foundation::GENERIC_WRITE,Storage::FileSystem::{CreateDirectoryW,CreateFileW,GetFileInformationByHandle,BY_HANDLE_FILE_INFORMATION,
        FILE_SHARE_READ,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,FILE_FLAG_OPEN_REPARSE_POINT}};
    let root=std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).filter(|p|p.is_absolute()).ok_or_else(||std::io::Error::other("missing absolute LOCALAPPDATA"))?;
    let base=root.join("Interceptor-Desktop-Events");let parent=base.join(format!("session-{}",session()));let path=parent.join(format!("{kind}-events.jsonl"));
    private_security(|security,user|unsafe{
            for directory in [&base,&parent]{let wide:Vec<u16>=directory.as_os_str().encode_wide().chain([0]).collect();
                if let Err(e)=CreateDirectoryW(PCWSTR(wide.as_ptr()),Some(security)){if !directory.is_dir(){return Err(std::io::Error::other(e));}}
                private(directory,user)?;
            }
            let wide:Vec<u16>=path.as_os_str().encode_wide().chain([0]).collect();
            let handle=OwnedHandle(CreateFileW(PCWSTR(wide.as_ptr()),GENERIC_WRITE.0,FILE_SHARE_READ,Some(security),OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,None).map_err(std::io::Error::other)?);
            private(&path,user)?;let mut info=BY_HANDLE_FILE_INFORMATION::default();GetFileInformationByHandle(handle.0,&mut info).map_err(std::io::Error::other)?;
            if info.nNumberOfLinks!=1||info.dwFileAttributes&0x400!=0{return Err(std::io::Error::other("event file must be a regular, unlinked, owned file"));}
            let file=std::fs::File::from_raw_handle(handle.0.0);std::mem::forget(handle);Ok((file,path))
    })
}
// A retained kernel handle identifies this process creation even if its PID
// is later recycled. Share one handle between all references to that process.
struct Process { pid: u32, handle: OwnedHandle }
pub(crate) struct CaptureIdentity { process: Process, identity: Value }
impl CaptureIdentity {
    pub(crate) fn alive(&self)->bool { self.process.secret_identity().is_ok_and(|current|current==self.identity) }
}
pub(crate) fn capture_identity(pid:u32)->Result<CaptureIdentity,Value> {
    let process=Process::open(pid).map_err(|_|failure("target_gone","audio target exited before process retention"))?;
    let identity=process.secret_identity()?;
    Ok(CaptureIdentity{process,identity})
}
impl Process {
    fn secret_identity(&self)->Result<Value,Value>{
        use windows::Win32::{Foundation::FILETIME,System::Threading::GetProcessTimes};
        let inspect=||->windows::core::Result<Value>{unsafe{
            if !self.alive(){return Err(windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL));}
            let user=sid(self.handle.0)?;
            let mut target_session=0;ProcessIdToSessionId(self.pid,&mut target_session)?;
            if user!=sid(GetCurrentProcess())?||target_session.to_string()!=session(){return Err(windows::core::Error::from_hresult(windows::Win32::Foundation::E_ACCESSDENIED));}
            let mut image=vec![0_u16;32768];let mut length=image.len()as u32;
            QueryFullProcessImageNameW(self.handle.0,PROCESS_NAME_WIN32,PWSTR(image.as_mut_ptr()),&mut length)?;
            let executable=String::from_utf16(&image[..length as usize]).map_err(|_|windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))?;
            let(mut creation,mut exit,mut kernel,mut cpu)=(FILETIME::default(),FILETIME::default(),FILETIME::default(),FILETIME::default());
            GetProcessTimes(self.handle.0,&mut creation,&mut exit,&mut kernel,&mut cpu)?;
            if !self.alive(){return Err(windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL));}
            Ok(json!({"host":"windows","pid":self.pid,"executable":executable,"user":user,"session":target_session.to_string(),"creation":format!("{:08x}{:08x}",creation.dwHighDateTime,creation.dwLowDateTime),"image":executable.to_lowercase()}))
        }};
        inspect().map_err(|_|failure("permission_denied","native secret target requires a live process owned by the current graphical user"))
    }
    fn open(pid: u32) -> windows::core::Result<Self> {
        let process = Self { pid, handle: OwnedHandle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid)? }) };
        if !process.alive() { return Err(windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL)); }
        Ok(process)
    }
    fn alive(&self) -> bool { unsafe { WaitForSingleObject(self.handle.0, 0) == WAIT_TIMEOUT } }
}
struct PipeIo(HANDLE, u32);
// Guest channels reuse the provider's cancellable overlapped I/O. A File
// opened with FILE_FLAG_OVERLAPPED must never use std::fs::File::read/write.
pub(crate) fn deadline_pipe_write(file: &std::fs::File, buffer: &[u8], wait_ms: u32) -> std::io::Result<usize> {
    use std::os::windows::io::AsRawHandle;
    unsafe {
        let pipe = HANDLE(file.as_raw_handle());
        let event = OwnedHandle(CreateEventW(None, true, false, PCWSTR::null()).map_err(std::io::Error::other)?);
        let mut overlap = OVERLAPPED { hEvent: event.0, ..Default::default() };
        let result = WriteFile(pipe, Some(buffer), None, Some(&mut overlap));
        pending(pipe, result, &mut overlap, wait_ms)
    }
}
pub(crate) fn available_pipe_read(file: &std::fs::File, buffer: &mut [u8]) -> std::io::Result<usize> {
    use std::{io::Read, os::windows::io::AsRawHandle};
    unsafe {
        let pipe = HANDLE(file.as_raw_handle());
        let mut available = 0;
        if let Err(e) = windows::Win32::System::Pipes::PeekNamedPipe(pipe, None, 0, None, Some(&mut available), None) {
            if e.code() == ERROR_BROKEN_PIPE.to_hresult() { return Ok(0); }
            return Err(std::io::Error::other(e));
        }
        if available == 0 { return Err(std::io::ErrorKind::WouldBlock.into()); }
        let length = buffer.len().min(available as usize);
        PipeIo(pipe, 1000).read(&mut buffer[..length])
    }
}
fn pending(pipe: HANDLE, result: windows::core::Result<()>, overlap: &mut OVERLAPPED, wait_ms: u32) -> std::io::Result<usize> {
    if let Err(e) = result { if e.code() != ERROR_IO_PENDING.to_hresult() { return Err(std::io::Error::other(e)); } }
    unsafe {
        if WaitForSingleObject(overlap.hEvent, wait_ms) != WAIT_OBJECT_0 {
            let _ = CancelIoEx(pipe, Some(overlap));
            let mut bytes = 0;
            // Cancellation is asynchronous. Keep the OVERLAPPED and its
            // buffer alive until the kernel acknowledges completion.
            let _ = GetOverlappedResult(pipe, overlap, &mut bytes, true);
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "native pipe I/O deadline"));
        }
        let mut bytes = 0;
        GetOverlappedResult(pipe, overlap, &mut bytes, false).map_err(std::io::Error::other)?;
        Ok(bytes as usize)
    }
}
impl std::io::Read for PipeIo {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        unsafe {
            let event = OwnedHandle(CreateEventW(None, true, false, PCWSTR::null()).map_err(std::io::Error::other)?);
            let mut overlap = OVERLAPPED { hEvent: event.0, ..Default::default() };
            let result = ReadFile(self.0, Some(buffer), None, Some(&mut overlap));
            pending(self.0, result, &mut overlap, self.1)
        }
    }
}
impl std::io::Write for PipeIo {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        unsafe {
            let event = OwnedHandle(CreateEventW(None, true, false, PCWSTR::null()).map_err(std::io::Error::other)?);
            let mut overlap = OVERLAPPED { hEvent: event.0, ..Default::default() };
            let result = WriteFile(self.0, Some(buffer), None, Some(&mut overlap));
            pending(self.0, result, &mut overlap, 15000)
        }
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

/// A WinRT call returned null. windows-rs 0.62 reports that as `Error::empty()` (HRESULT 0); older
/// releases used E_POINTER, so both mean "no item", not a failure.
pub(crate) fn null_result(code:i32)->bool{code==0||code==0x80004003_u32 as i32}
pub fn session() -> String {
    let mut id = 0;
    unsafe { let _ = ProcessIdToSessionId(GetCurrentProcessId(), &mut id); }
    id.to_string()
}
pub fn identity() -> std::io::Result<Value> {
    let user = sid(unsafe { GetCurrentProcess() }).map_err(std::io::Error::other)?;
    let session = session();
    Ok(json!({"sid":user,"session":session,"endpoint":format!(r"\\.\pipe\interceptor-desktop-{user}-{session}")}))
}
pub(crate) fn sid(process: HANDLE) -> windows::core::Result<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token)?;
        let token = OwnedHandle(token);
        token_sid(token.0)
    }
}
pub(crate) fn token_sid(token: HANDLE) -> windows::core::Result<String> {
    unsafe {
        let mut bytes = 0;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut bytes);
        if bytes < std::mem::size_of::<TOKEN_USER>() as u32 || bytes > 65536 {
            return Err(windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL));
        }
        let mut storage = vec![0_u64; (bytes as usize).div_ceil(8)];
        GetTokenInformation(token, TokenUser, Some(storage.as_mut_ptr().cast()), bytes, &mut bytes)?;
        let user = &*(storage.as_ptr().cast::<TOKEN_USER>());
        let mut string = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut string)?;
        let result = string.to_string();
        LocalFree(Some(HLOCAL(string.0.cast())));
        Ok(result?)
    }
}

pub fn client(endpoint: Option<&str>, stop: bool, timeout_ms: u32) -> std::io::Result<()> {
    use std::os::windows::{fs::OpenOptionsExt, io::IntoRawHandle, ffi::OsStringExt};
    let identity = identity()?;
    let endpoint = endpoint.unwrap_or(identity["endpoint"].as_str().unwrap_or(""));
    if !endpoint.starts_with(r"\\.\pipe\interceptor-desktop-") || endpoint.contains('\0') {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "invalid native pipe endpoint"));
    }
    // Identification-level QoS: the server can check who connected but never impersonate this user.
    // Every instance busy: wait for one, inside the same deadline as the session's reads.
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.into());
    let file = loop {
        match std::fs::OpenOptions::new().read(true).write(true).custom_flags(FILE_FLAG_OVERLAPPED.0)
            .security_qos_flags(windows::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION.0).open(endpoint) {
            Err(error) if error.raw_os_error() == Some(windows::Win32::Foundation::ERROR_PIPE_BUSY.0 as i32) => {
                let left = deadline.saturating_duration_since(Instant::now()).as_millis() as u32;
                if left == 0 { return Err(error); }
                let wide: Vec<u16> = endpoint.encode_utf16().chain(Some(0)).collect();
                let _ = unsafe { windows::Win32::System::Pipes::WaitNamedPipeW(PCWSTR(wide.as_ptr()), left) };
            }
            result => break result?,
        }
    };
    let pipe = OwnedHandle(HANDLE(file.into_raw_handle()));
    unsafe {
        let mut pid = 0; GetNamedPipeServerProcessId(pipe.0, &mut pid).map_err(std::io::Error::other)?;
        let process = OwnedHandle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(std::io::Error::other)?);
        let mut server_session = 0;
        ProcessIdToSessionId(pid, &mut server_session).map_err(std::io::Error::other)?;
        let mut image = [0_u16; 32768]; let mut length = image.len() as u32;
        QueryFullProcessImageNameW(process.0, PROCESS_NAME_WIN32, PWSTR(image.as_mut_ptr()), &mut length).map_err(std::io::Error::other)?;
        let server_exe = std::path::PathBuf::from(std::ffi::OsString::from_wide(&image[..length as usize]));
        if server_session.to_string() != session() || sid(process.0).map_err(std::io::Error::other)? != identity["sid"] ||
            std::fs::canonicalize(server_exe)? != std::fs::canonicalize(std::env::current_exe()?)? {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "native pipe server identity does not match this user, session and provider binary"));
        }
    }
    crate::client_session(&mut PipeIo(pipe.0, timeout_ms), &mut PipeIo(pipe.0, 15_000), stop)
}

pub fn run() -> std::io::Result<()> {
    let user = sid(unsafe { GetCurrentProcess() }).map_err(std::io::Error::other)?;
    let my_session = session().parse::<u32>().map_err(std::io::Error::other)?;
    if my_session == 0 { return Err(std::io::Error::other("native provider must run in the interactive user's session, not Session 0")); }
    input::start_focus_tracker();
    let name: Vec<u16> = format!(r"\\.\pipe\interceptor-desktop-{user}-{my_session}").encode_utf16().chain(Some(0)).collect();
    let sddl: Vec<u16> = format!("D:P(A;;GA;;;{user})").encode_utf16().chain(Some(0)).collect();
    unsafe {
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(sddl.as_ptr()), 1, &mut descriptor, None).map_err(std::io::Error::other)?;
        let security = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0, bInheritHandle: false.into() };
        // First instance protects against pipe-name impersonation. The DACL
        // grants only this SID; session matching also rejects other logons.
        // 32 instances match the Linux socket's 32 concurrent connections.
        let mut pipes = Vec::new();
        for i in 0..32 {
            let flags = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED |
                if i == 0 { FILE_FLAG_FIRST_PIPE_INSTANCE } else { Default::default() };
            let pipe = CreateNamedPipeW(PCWSTR(name.as_ptr()), flags,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 32, 65536, 65536, 5000, Some(&security));
            if pipe.is_invalid() { LocalFree(Some(HLOCAL(descriptor.0))); return Err(std::io::Error::last_os_error()); }
            pipes.push(OwnedHandle(pipe));
        }
        LocalFree(Some(HLOCAL(descriptor.0)));
        let workers: Vec<_> = pipes.into_iter().map(|pipe| {
            let handle = pipe.0.0 as usize;
            std::mem::forget(pipe);
            std::thread::spawn(move || -> std::io::Result<()> {
                let pipe = OwnedHandle(HANDLE(handle as *mut _));
                loop {
                    let event = OwnedHandle(CreateEventW(None, true, false, PCWSTR::null()).map_err(std::io::Error::other)?);
                    let mut overlap = OVERLAPPED { hEvent: event.0, ..Default::default() };
                    let connected = ConnectNamedPipe(pipe.0, Some(&mut overlap));
                    if !connected.as_ref().is_err_and(|e| e.code() == ERROR_PIPE_CONNECTED.to_hresult()) {
                        pending(pipe.0, connected, &mut overlap, u32::MAX)?;
                    }
                    let mut client_session = 0;
                    let authorized = GetNamedPipeClientSessionId(pipe.0, &mut client_session).is_ok() && client_session == my_session;
                    let _ = crate::serve(&mut PipeIo(pipe.0, 15_000), &mut PipeIo(pipe.0, 15_000), authorized);
                    windows::Win32::System::Pipes::DisconnectNamedPipe(pipe.0).map_err(std::io::Error::other)?;
                }
            })
        }).collect();
        for worker in workers { worker.join().map_err(|_| std::io::Error::other("native pipe worker failed"))??; }
        Ok(())
    }
}

#[derive(Clone)] struct Window { handle: HWND, pid: u32, title: String, name: String, rect: RECT }
unsafe extern "system" fn collect_window(hwnd: HWND, param: LPARAM) -> windows::core::BOOL {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() { return true.into(); }
        let mut cloaked = 0_u32;
        if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), std::mem::size_of_val(&cloaked) as u32).is_err() || cloaked != 0 { return true.into(); }
        let mut title = [0_u16; 2048];
        let n = GetWindowTextW(hwnd, &mut title);
        let mut pid = 0; GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut rect = RECT::default(); if GetWindowRect(hwnd, &mut rect).is_err() { return true.into(); }
        let mut image = [0_u16; 32768]; let mut length = image.len() as u32;
        let name = if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            let read = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(image.as_mut_ptr()), &mut length);
            let _ = CloseHandle(process);
            if read.is_ok() { String::from_utf16_lossy(&image[..length as usize]).rsplit('\\').next().unwrap_or("").trim_end_matches(".exe").to_owned() } else { String::new() }
        } else { String::new() };
        (*(param.0 as *mut Vec<Window>)).push(Window { handle: hwnd, pid, title: String::from_utf16_lossy(&title[..n as usize]), name, rect });
        true.into()
    }
}
/// The window Windows treats as foreground, for refusals that depend on it (no title: it can be private).
fn foreground_details() -> Value {
    let mut found: Vec<Window> = Vec::new();
    unsafe { let window = GetForegroundWindow(); if !window.is_invalid() { let _ = collect_window(window, LPARAM((&mut found as *mut Vec<Window>) as isize)); } }
    json!({"foreground": found.first().map(|w| json!({"pid": w.pid, "name": w.name}))})
}
fn windows_for(a: &Value) -> windows::core::Result<Vec<Window>> {
    let mut windows: Vec<Window> = Vec::new();
    unsafe {
        EnumWindows(Some(collect_window), LPARAM((&mut windows as *mut Vec<Window>) as isize))?;
        // EnumWindows omits modern apps on Windows 8+. Walk desktop children
        // too, retaining the same visibility, process and selector checks.
        let mut previous = None;
        let mut seen = std::collections::HashSet::new();
        let mut complete = false;
        for _ in 0..2000 {
            windows::Win32::Foundation::SetLastError(windows::Win32::Foundation::WIN32_ERROR(0));
            let hwnd = match FindWindowExW(Some(GetDesktopWindow()), previous, PCWSTR::null(), PCWSTR::null()) {
                Ok(hwnd) => hwnd,
                Err(_) if windows::Win32::Foundation::GetLastError().0 == 0 => { complete = true; break; },
                Err(error) => return Err(error),
            };
            if !seen.insert(hwnd.0 as usize) { return Err(windows::core::Error::new(windows::Win32::Foundation::E_FAIL, "desktop window inventory changed during enumeration; read again")); }
            previous = Some(hwnd);
            if !windows.iter().any(|w| w.handle == hwnd) {
                let _ = collect_window(hwnd, LPARAM((&mut windows as *mut Vec<Window>) as isize));
            }
        }
        if !complete { return Err(windows::core::Error::new(windows::Win32::Foundation::E_BOUNDS, "desktop window inventory exceeds 2000 handles; no partial inventory returned")); }
        let foreground = GetForegroundWindow();
        if !foreground.is_invalid() && !windows.iter().any(|w| w.handle == foreground) {
            let _ = collect_window(foreground, LPARAM((&mut windows as *mut Vec<Window>) as isize));
        }
    }
    windows.retain(|w| a["pid"].as_u64().is_none_or(|pid| pid == w.pid as u64)
        && a["window"].as_u64().is_none_or(|id| id == w.handle.0 as u64)
        && a["app"].as_str().is_none_or(|name| name.trim_end_matches(".exe").eq_ignore_ascii_case(&w.name))
        && a["windowTitle"].as_str().is_none_or(|title| title == w.title)
        && a.get("windowBounds").is_none_or(|b| b["left"].as_f64()==Some(w.rect.left as f64)
            && b["top"].as_f64()==Some(w.rect.top as f64)
            && b["width"].as_f64()==Some((w.rect.right-w.rect.left)as f64)
            && b["height"].as_f64()==Some((w.rect.bottom-w.rect.top)as f64)));
    Ok(windows)
}
fn window_json(w: &Window) -> Value {
    json!({"windowId":(w.handle.0 as usize).to_string(),"title":w.title,"pid":w.pid,"name":w.name,
        "frame":{"x":w.rect.left,"y":w.rect.top,"width":w.rect.right-w.rect.left,"height":w.rect.bottom-w.rect.top}})
}
pub fn capture_window(action:&Value)->Result<(HWND,u32),Value>{
    let mut windows=windows_for(action).map_err(|e|failure("provider_failed",e))?;
    if action["type"]=="desktop_stream"&&action["app"].is_string()&&windows.len()>1{return Err(failure("target_ambiguous","stream application has multiple capturable windows; select one exact window"));}
    if action["window"].is_number()||action["app"].is_string(){
        windows.sort_by_key(|w|-((w.rect.right as i64-w.rect.left as i64).max(0)*(w.rect.bottom as i64-w.rect.top as i64).max(0)));
        windows.first().map(|w|(w.handle,w.pid)).ok_or_else(||failure("unsupported_target","requested application/window has no capturable window"))
    }else{
        let front=unsafe{GetForegroundWindow()};
        windows.iter().find(|w|w.handle==front).map(|w|(w.handle,w.pid)).ok_or_else(||failure("unsupported_target","foreground window is not capturable; select a display explicitly"))
    }
}
struct ObservedWindow{generation:u64,kind:u32,hwnd:HWND,object:i32,child:i32,process:Rc<Process>}
struct ObservationQueue{observer:Arc<crate::monitor::Observer>,events:RefCell<VecDeque<ObservedWindow>>,windows:RefCell<HashMap<isize,Rc<Process>>>}
struct ObservedElement{generation:u64,kind:&'static str,notification:String,element:windows_core::AgileReference<IUIAutomationElement>,pid:u32,process:std::os::windows::io::OwnedHandle}
// UIA owns this by-value VARIANT. windows0.62.2's generated implementation
// drops its copied argument (VariantClear), freeing UIA's BSTR/SAFEARRAY twice.
// Keep the exact COM IID/ABI, but do not take ownership of the callback value.
#[windows_core::interface("40cd37d4-c756-4b0c-8c6f-bddfeeb13b50")]
unsafe trait BorrowedPropertyHandler:windows_core::IUnknown{
    fn HandlePropertyChangedEvent(&self,sender:windows_core::Ref<IUIAutomationElement>,property:UIA_PROPERTY_ID,new_value:std::mem::ManuallyDrop<windows::Win32::System::Variant::VARIANT>)->windows_core::HRESULT;
}
#[windows_core::implement(IUIAutomationFocusChangedEventHandler,BorrowedPropertyHandler,IUIAutomationEventHandler)]
struct ObservationHandler{observer:Arc<crate::monitor::Observer>,events:mpsc::SyncSender<ObservedElement>}
impl ObservationHandler_Impl{
    fn enqueue(&self,sender:windows_core::Ref<IUIAutomationElement>,kind:&'static str,notification:String)->windows::core::Result<()>{
        use std::os::windows::io::FromRawHandle;
        let Some(generation)=self.observer.epoch()else{return Ok(());};let Some(element)=sender.as_ref()else{return Ok(());};
        if self.observer.excludes.contains(kind){return Ok(());}
        // Only identity and an agile interface token cross the callback
        // boundary. Property newValue is never copied, even for passwords.
        let pid=unsafe{element.CurrentProcessId()?}as u32;
        let process=Process::open(pid)?;
        let Ok(identity)=process.secret_identity()else{return Ok(());};
        let app=identity["executable"].as_str().unwrap_or("").rsplit('\\').next().unwrap_or("").trim_end_matches(".exe");
        let mut foreground=0;unsafe{GetWindowThreadProcessId(GetForegroundWindow(),Some(&mut foreground));}
        if !self.observer.accepts(pid,app,pid==foreground){return Ok(());}
        let native=process.handle;
        let process=unsafe{std::os::windows::io::OwnedHandle::from_raw_handle(native.0.0)};std::mem::forget(native);
        let reference=windows_core::AgileReference::new(element);
        if let Ok(element)=reference{
            if self.events.try_send(ObservedElement{generation,kind,notification,element,pid,process}).is_err(){self.observer.dropped.fetch_add(1,Ordering::Relaxed);}
        }else{self.observer.dropped.fetch_add(1,Ordering::Relaxed);}
        Ok(())
    }
}
impl IUIAutomationFocusChangedEventHandler_Impl for ObservationHandler_Impl{
    fn HandleFocusChangedEvent(&self,sender:windows_core::Ref<IUIAutomationElement>)->windows::core::Result<()>{self.enqueue(sender,"focus","UIA:focus".into())}
}
impl BorrowedPropertyHandler_Impl for ObservationHandler_Impl{
    unsafe fn HandlePropertyChangedEvent(&self,sender:windows_core::Ref<IUIAutomationElement>,property:UIA_PROPERTY_ID,_new_value:std::mem::ManuallyDrop<windows::Win32::System::Variant::VARIANT>)->windows_core::HRESULT{
        self.enqueue(sender,match property{UIA_ValueValuePropertyId=>"input",UIA_NamePropertyId=>"title_change",UIA_BoundingRectanglePropertyId=>"layout_change",_=>"ax_other"},format!("UIA:property:{}",property.0)).into()
    }
}
impl IUIAutomationEventHandler_Impl for ObservationHandler_Impl{
    fn HandleAutomationEvent(&self,sender:windows_core::Ref<IUIAutomationElement>,event:UIA_EVENT_ID)->windows::core::Result<()>{
        self.enqueue(sender,match event{UIA_Text_TextChangedEventId=>"input",UIA_Text_TextSelectionChangedEventId=>"selection",UIA_MenuOpenedEventId=>"menu_open",UIA_MenuClosedEventId=>"menu_close",_=>"ax_other"},format!("UIA:event:{}",event.0))
    }
}
struct UiaObservation{api:IUIAutomation,root:IUIAutomationElement,focus:IUIAutomationFocusChangedEventHandler,property:IUIAutomationPropertyChangedEventHandler,event:IUIAutomationEventHandler,focus_added:bool,property_added:bool,events_added:Vec<UIA_EVENT_ID>,receiver:mpsc::Receiver<ObservedElement>}
impl UiaObservation{
    fn new(api:&IUIAutomation,observer:Arc<crate::monitor::Observer>)->windows::core::Result<Self>{unsafe{
        let(events,receiver)=mpsc::sync_channel(256);
        let focus:IUIAutomationFocusChangedEventHandler=ObservationHandler{observer:observer.clone(),events}.into();
        let property=focus.cast()?;let event=focus.cast()?;
        let mut source=Self{api:api.clone(),root:api.GetRootElement()?,focus,property,event,focus_added:false,property_added:false,events_added:vec![],receiver};
        api.AddFocusChangedEventHandler(None,&source.focus)?;source.focus_added=true;
        api.AddPropertyChangedEventHandlerNativeArray(&source.root,TreeScope_Subtree,None,&source.property,&[UIA_ValueValuePropertyId,UIA_NamePropertyId,UIA_BoundingRectanglePropertyId])?;source.property_added=true;
        for event in [UIA_Text_TextChangedEventId,UIA_Text_TextSelectionChangedEventId,UIA_MenuOpenedEventId,UIA_MenuClosedEventId]{api.AddAutomationEventHandler(event,&source.root,TreeScope_Subtree,None,&source.event)?;source.events_added.push(event);}
        // Existing WPF controls can lack peers and emit no value events until
        // visited. Initialize scoped peers without reading values or making refs.
        let started=Instant::now();let walker=api.ControlViewWalker()?;let mut stack=Vec::new();let mut visited=0;
        let mut foreground=0;GetWindowThreadProcessId(GetForegroundWindow(),Some(&mut foreground));
        for window in windows_for(&json!({}))?{
            if !observer.accepts(window.pid,&window.name,window.pid==foreground){continue;}
            let process=Process::open(window.pid)?;
            if process.secret_identity().is_err(){return Err(windows::core::Error::from_hresult(windows::Win32::Foundation::E_ACCESSDENIED));}
            let root=api.ElementFromHandle(window.handle)?;
            if root.CurrentProcessId()? as u32!=window.pid||!process.alive(){return Err(windows::core::Error::from_hresult(windows::Win32::Foundation::E_ACCESSDENIED));}
            stack.push(root);
        }
        while let Some(element)=stack.pop(){
            if visited>=4096||started.elapsed()>=Duration::from_secs(2){return Err(windows::core::Error::new(windows::Win32::Foundation::E_BOUNDS,"existing accessibility peer initialization exceeded 4096 nodes or its two-second traversal budget"));}
            visited+=1;
            let mut child=match walker.GetFirstChildElement(&element){Ok(child)=>Some(child),Err(error)if error.code().0==0=>None,Err(error)=>return Err(error)};
            while let Some(element)=child{
                if visited+stack.len()>=4096||started.elapsed()>=Duration::from_secs(2){return Err(windows::core::Error::new(windows::Win32::Foundation::E_BOUNDS,"existing accessibility peer initialization exceeded 4096 nodes or its two-second traversal budget"));}
                child=match walker.GetNextSiblingElement(&element){Ok(next)=>Some(next),Err(error)if error.code().0==0=>None,Err(error)=>return Err(error)};
                stack.push(element);
            }
        }
        Ok(source)
    }}
    fn detach(&mut self)->windows::core::Result<()>{unsafe{
        if self.focus_added{self.api.RemoveFocusChangedEventHandler(&self.focus)?;self.focus_added=false;}
        if self.property_added{self.api.RemovePropertyChangedEventHandler(&self.root,&self.property)?;self.property_added=false;}
        while let Some(event)=self.events_added.last().copied(){self.api.RemoveAutomationEventHandler(event,&self.root,&self.event)?;self.events_added.pop();}
        while self.receiver.try_recv().is_ok(){}Ok(())
    }}
}
impl Drop for UiaObservation{fn drop(&mut self){let _=self.detach();}}
thread_local!{static OBSERVATION_HOOKS:RefCell<HashMap<isize,Rc<ObservationQueue>>>=RefCell::new(HashMap::new());}
unsafe extern "system" fn observation_callback(hook:HWINEVENTHOOK,kind:u32,hwnd:HWND,object:i32,child:i32,_thread:u32,_time:u32){
    let state=OBSERVATION_HOOKS.with(|hooks|hooks.borrow().get(&(hook.0 as isize)).cloned());
    let Some(state)=state else{return;};let Some(generation)=state.observer.epoch()else{return;};
    if hwnd.is_invalid()||object!=OBJID_WINDOW.0||child!=0{return;}
    let process=if kind==EVENT_OBJECT_DESTROY{
        // Destroy notifications can arrive after HWND identity queries stop
        // working. The ordered create/initial inventory retains its owner.
        let Some(process)=state.windows.borrow_mut().remove(&(hwnd.0 as isize))else{return;};process
    }else{
        let mut pid=0;unsafe{GetWindowThreadProcessId(hwnd,Some(&mut pid));}
        let Ok(process)=Process::open(pid)else{return;};let process=Rc::new(process);
        let Ok(identity)=process.secret_identity()else{return;};
        let app=identity["executable"].as_str().unwrap_or("").rsplit('\\').next().unwrap_or("").trim_end_matches(".exe");
        if !state.observer.accepts(pid,app,true){return;}
        let mut windows=state.windows.borrow_mut();
        if !windows.contains_key(&(hwnd.0 as isize))&&windows.len()>=512{state.observer.dropped.fetch_add(1,Ordering::Relaxed);return;}
        windows.insert(hwnd.0 as isize,process.clone());process
    };
    let mut events=state.events.borrow_mut();
    if events.len()<256{events.push_back(ObservedWindow{generation,kind,hwnd,object,child,process});}
    else{state.observer.dropped.fetch_add(1,Ordering::Relaxed);}
}
struct Observation{hooks:Vec<HWINEVENTHOOK>,state:Rc<ObservationQueue>,uia:Option<UiaObservation>}
impl Observation{
    fn new(observer:Arc<crate::monitor::Observer>,api:&IUIAutomation)->Result<Self,Value>{
        let state=Rc::new(ObservationQueue{observer,events:RefCell::new(VecDeque::new()),windows:RefCell::new(HashMap::new())});
        let mut result=Self{hooks:vec![],state,uia:None};
        let mut kinds=vec![];
        if !result.state.observer.excludes.contains("ax"){result.uia=Some(UiaObservation::new(api,result.state.observer.clone()).map_err(|e|failure("provider_failed",e))?);}
        if !result.state.observer.excludes.contains("workspace"){
            for window in windows_for(&json!({})).map_err(|e|failure("provider_failed",e))?{
                if !result.state.observer.accepts(window.pid,&window.name,true){continue;}
                if result.state.windows.borrow().len()>=512{return Err(failure("resource_limit","workspace recording retains at most 512 window identities"));}
                if let Ok(process)=Process::open(window.pid){if process.secret_identity().is_ok(){result.state.windows.borrow_mut().insert(window.handle.0 as isize,Rc::new(process));}}
            }
            kinds.extend([EVENT_SYSTEM_FOREGROUND,EVENT_OBJECT_CREATE,EVENT_OBJECT_DESTROY,EVENT_SYSTEM_MINIMIZESTART,EVENT_SYSTEM_MINIMIZEEND]);
        }
        for kind in kinds{
            let hook=unsafe{SetWinEventHook(kind,kind,None,Some(observation_callback),0,0,WINEVENT_OUTOFCONTEXT|WINEVENT_SKIPOWNPROCESS)};
            if hook.0.is_null(){return Err(failure("provider_failed","WinEvent subscription was refused"));}
            OBSERVATION_HOOKS.with(|hooks|hooks.borrow_mut().insert(hook.0 as isize,result.state.clone()));result.hooks.push(hook);
        }Ok(result)
    }
    fn coverage(&self)->Value{json!(["ax","workspace"].iter().filter(|source|!self.state.observer.excludes.contains(**source)).map(|source|json!({"source":source,"available":true,"provider":if *source=="ax"{"UIAutomation-events"}else{"WinEvent-window-lifecycle"},"limits":["accessible targets in the retained graphical user session","initial scoped peer traversal: 4096 nodes, two-second budget; failure marks subscription unavailable","focus, value/name/bounds/selection/menu and window lifecycle events; no raw device events","bounded 256-event queues; secure values masked; current snapshot may differ from notification time"]})).collect::<Vec<_>>())}
    fn detach(&mut self)->Result<(),Value>{
        if let Some(source)=&mut self.uia{source.detach().map_err(|e|failure("timeout_unknown_outcome",format!("UIA handler removal was not acknowledged: {e}")))?;}
        while let Some(hook)=self.hooks.last().copied(){
            OBSERVATION_HOOKS.with(|hooks|hooks.borrow_mut().remove(&(hook.0 as isize)));
            if !unsafe{UnhookWinEvent(hook)}.as_bool(){return Err(failure("timeout_unknown_outcome","WinEvent hook removal was not acknowledged"));}self.hooks.pop();
        }self.state.events.borrow_mut().clear();self.state.windows.borrow_mut().clear();self.state.observer.detached.store(true,Ordering::Release);Ok(())
    }
}
impl Drop for Observation{fn drop(&mut self){let _=self.detach();}}
type Work = (String, Value, Instant, mpsc::Sender<Value>,Option<Arc<crate::monitor::Observer>>);
unsafe fn secret_control_ready(element:&IUIAutomationElement)->bool{
    unsafe{
        if !element.CurrentIsEnabled().is_ok_and(|enabled|enabled.as_bool()){return false;}
        let Ok(pattern)=element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)else{return false;};
        if !pattern.CurrentIsReadOnly().is_ok_and(|read_only|!read_only.as_bool()){return false;}
        let Ok(hwnd)=element.CurrentNativeWindowHandle()else{return false;};
        let mut owner=0;GetWindowThreadProcessId(hwnd,Some(&mut owner));
        if owner==0||!element.CurrentProcessId().is_ok_and(|pid|pid as u32==owner){return false;}
        let mut class=[0_u16;256];let n=GetClassNameW(hwnd,&mut class);
        let class=String::from_utf16_lossy(&class[..n as usize]).to_lowercase();
        class=="edit"||class.starts_with("windowsforms10.edit.")||class.starts_with("richedit")
    }
}
static WORKER: OnceLock<mpsc::SyncSender<Work>> = OnceLock::new();
struct Uia { api: IUIAutomation, refs: HashMap<String, (IUIAutomationElement, Instant, Rc<Process>)>, processes: HashMap<u32, Rc<Process>>, serial: u64, grants:crate::secret_target::Grants, auth_deadline:Option<Instant>, auth_window:Option<IUIAutomationElement> }
struct CredentialDialog { window:IUIAutomationElement, secure:IUIAutomationElement, username:Option<IUIAutomationElement>, user:String, title:String, message:String, buttons:Vec<(String,IUIAutomationElement)>, process:Rc<Process>, identity:Value }

fn decode_edit_selection(packed: u32, text: &[u16]) -> Result<String, Value> {
    if packed == u32::MAX { return Err(failure("resource_limit", "native edit selection exceeds 16-bit offsets")); }
    let start = (packed & 0xffff) as usize;
    let end = (packed >> 16) as usize;
    if end < start || end > text.len() { return Err(failure("provider_failed", "native edit selection changed or has invalid bounds")); }
    String::from_utf16(&text[start..end]).map_err(|_| failure("provider_failed", "native edit selection splits an invalid UTF-16 sequence"))
}

fn edit_selection(hwnd: HWND, expected_pid: u32) -> Result<String, Value> {
    edit_text(hwnd, expected_pid, true)
}

fn edit_text(hwnd: HWND, expected_pid: u32, selected: bool) -> Result<String, Value> {
    unsafe {
        let owned = || {
            let mut owner = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut owner));
            owner != 0 && owner == expected_pid && IsWindow(Some(hwnd)).as_bool()
        };
        if !owned() { return Err(failure("stale_reference", "native edit window identity is unavailable or changed")); }
        let mut class = [0_u16; 256];
        let length = GetClassNameW(hwnd, &mut class);
        let class = String::from_utf16_lossy(&class[..length.max(0) as usize]).to_lowercase();
        if !(class == "edit" || class.starts_with("windowsforms10.edit.") ||
             class.starts_with("richedit") || class.starts_with("windowsforms10.richedit")) {
            return Err(failure("unsupported_target", "target is not a qualified native edit control"));
        }
        if GetWindowLongW(hwnd, GWL_STYLE) as u32 & 0x20 != 0 { return Ok("•••".to_owned()); }
        let read = |message, wparam, lparam| {
            let mut result = 0;
            if !owned() { return Err(failure("stale_reference", "native edit window identity changed before reading")); }
            if SendMessageTimeoutW(hwnd, message, wparam, lparam, SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT, 1000, Some(&mut result)).0 == 0 {
                let error = windows::Win32::Foundation::GetLastError();
                return Err(failure(if error.0 == 5 { "permission_denied" } else { "provider_failed" }, "native edit text read was refused or exceeded its deadline"));
            }
            if !owned() { return Err(failure("stale_reference", "native edit window identity changed during reading")); }
            Ok(result)
        };
        // EM_GETSEL is a system message below WM_USER. Null pointer arguments
        // use its packed return value; no target-process memory is allocated.
        let selection = if selected { read(0x00b0, WPARAM(0), LPARAM(0))? as u32 } else { 0 };
        if selected && selection == u32::MAX { return Err(failure("resource_limit", "native edit selection exceeds 16-bit offsets")); }
        let length = read(WM_GETTEXTLENGTH, WPARAM(0), LPARAM(0))?;
        if length > 65535 { return Err(failure("resource_limit", "native edit text exceeds the bounded read limit")); }
        let mut text = vec![0_u16; length + 1];
        let copied = read(WM_GETTEXT, WPARAM(text.len()), LPARAM(text.as_mut_ptr() as isize))?;
        if copied > length { return Err(failure("provider_failed", "native edit text returned invalid bounds")); }
        if selected && read(0x00b0, WPARAM(0), LPARAM(0))? as u32 != selection {
            return Err(failure("provider_failed", "native edit selection changed during reading"));
        }
        if selected { decode_edit_selection(selection, &text[..copied]) }
        else { String::from_utf16(&text[..copied]).map_err(|_| failure("provider_failed", "native edit text contains invalid UTF-16")) }
    }
}

// The visible part of a plain Win32 EDIT as UTF-16 offsets: from the first visible line through the
// line at the client area's bottom edge. Its UIA proxy answered --visible with the whole document.
// Pointer-free messages only, so RichEdit (whose EM_CHARFROMPOS takes a pointer)
// and password fields are left to the existing paths.
fn edit_visible_range(hwnd: HWND) -> Option<(usize, usize)> {
    unsafe {
        let mut class = [0_u16; 256];
        let length = GetClassNameW(hwnd, &mut class);
        let class = String::from_utf16_lossy(&class[..length.max(0) as usize]).to_lowercase();
        if !(class == "edit" || class.starts_with("windowsforms10.edit.")) || GetWindowLongW(hwnd, GWL_STYLE) as u32 & 0x20 != 0 { return None; }
        let send = |message: u32, wparam: usize, lparam: isize| { let mut result = 0; (SendMessageTimeoutW(hwnd, message, WPARAM(wparam), LPARAM(lparam), SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT, 1000, Some(&mut result)).0 != 0).then_some(result) };
        let first = send(0x00CE, 0, 0)?; // EM_GETFIRSTVISIBLELINE
        let mut rect = RECT::default(); GetClientRect(hwnd, &mut rect).ok()?;
        let at = send(0x00D7, 0, (((rect.bottom - 1).max(0) as isize) << 16) | 1)?; // EM_CHARFROMPOS: HIWORD is the line
        let last = if at as isize == -1 { send(0x00BA, 0, 0)?.saturating_sub(1) } else { (at >> 16) & 0xffff }; // EM_GETLINECOUNT
        let start = send(0x00BB, first, 0)?; // EM_LINEINDEX
        let end = send(0x00BB, last + 1, 0).filter(|end| *end as isize >= 0).unwrap_or(usize::MAX);
        (start as isize >= 0).then_some((start, end))
    }
}

fn uia_text_range(range: &IUIAutomationTextRange) -> Result<String, Value> {
    let text = unsafe { range.GetText(65537) }.map_err(|e| failure("provider_failed", e))?;
    if text.len() > 65536 { return Err(failure("resource_limit", "native text range exceeds the read limit")); }
    String::from_utf16(&text).map_err(|_| failure("provider_failed", "native text range contains invalid UTF-16"))
}

fn uia_text_ranges(ranges: &IUIAutomationTextRangeArray) -> Result<String, Value> {
    unsafe {
        let count = ranges.Length().map_err(|e| failure("provider_failed", e))?;
        if !(0..=64).contains(&count) { return Err(failure("resource_limit", "too many native text ranges")); }
        let mut result = String::new();
        for index in 0..count {
            let range = ranges.GetElement(index).map_err(|e| failure("provider_failed", e))?;
            let text = uia_text_range(&range)?;
            if index > 0 { result.push('\n'); }
            result.push_str(&text);
            if result.len() > 262144 { return Err(failure("resource_limit", "native text ranges exceed the read limit")); }
        }
        Ok(result)
    }
}

pub fn dispatch(verb: &str, action: &Value) -> Value {
    dispatch_work(verb,action,None)
}
pub(crate) fn observe(observer:Arc<crate::monitor::Observer>)->Value{dispatch_work("__monitor_observe",&json!({}),Some(observer))}
pub(crate) fn record_frames(action:&Value,owner:Arc<crate::monitor::Observer>)->Value{dispatch_work("__monitor_frames_start",action,Some(owner))}
fn dispatch_work(verb:&str,action:&Value,observer:Option<Arc<crate::monitor::Observer>>)->Value{
    if session() == "0" { return failure("no_interactive_session", "Windows native control requires the logged-in user's session"); }
    let worker = WORKER.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel::<Work>(32);
        std::thread::spawn(move || unsafe {
            use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext,DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,DPI_AWARENESS_CONTEXT};
            // UIA bounds are physical pixels. Keep the dedicated worker's
            // window metrics, hit testing and cursor coordinates in that space.
            let previous=SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            if previous.0.is_null(){for (_,_,_,reply,_) in rx{let _=reply.send(failure("provider_failed","per-monitor DPI awareness could not be established"));}return;}
            struct ThreadDpi(DPI_AWARENESS_CONTEXT);
            impl Drop for ThreadDpi{fn drop(&mut self){unsafe{SetThreadDpiAwarenessContext(self.0);}}}
            let _dpi=ThreadDpi(previous);
            let init = CoInitializeEx(None, COINIT_MULTITHREADED).ok()
                .and_then(|_| CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER));
            match init {
                Ok(api) => {
                    if let Ok(v2) = api.cast::<IUIAutomation2>() { let _ = v2.SetConnectionTimeout(500); let _ = v2.SetTransactionTimeout(500); }
                    let mut state = Uia { api, refs: HashMap::new(), processes: HashMap::new(), serial: 0, grants:Default::default(), auth_deadline:None, auth_window:None };
                    let mut observations:HashMap<String,Observation>=HashMap::new();
                    let mut observation_turn=0_usize;
                    loop {
                        crate::capture::tick();
                        let mut message=MSG::default();
                        for _ in 0..64{if !PeekMessageW(&mut message,None,0,0,PM_REMOVE).as_bool(){break;}let _=TranslateMessage(&message);DispatchMessageW(&message);}
                        observations.retain(|_,source|source.state.observer.generation.load(Ordering::Acquire)!=0);
                        let observation_deadline=Instant::now()+Duration::from_millis(20);let count=observations.len();
                        for source in observations.values().cycle().skip(observation_turn%count.max(1)).take(count){if Instant::now()>=observation_deadline{break;}state.observe_events(source,observation_deadline);}
                        observation_turn=observation_turn.wrapping_add(1);
                        match rx.recv_timeout(Duration::from_millis(20)) {
                            Ok((verb, action, deadline, reply,observer)) => {
                                let result = if Instant::now() >= deadline { failure("cancelled", "request expired before execution; nothing was delivered") }
                                    else if verb=="__monitor_frames_start"{
                                        match observer{Some(owner)=>crate::capture::record_start(&action,owner),None=>failure("invalid_request","internal frame stream omitted its owner")}
                                    }else if verb=="__monitor_frames"{crate::capture::record_control(&action)}
                                    else if verb=="__monitor_observe"{
                                        match observer.ok_or_else(||failure("invalid_request","internal subscription omitted its owner")).and_then(|observer|Observation::new(observer,&state.api)){Ok(source)=>{let coverage=source.coverage();observations.insert(source.state.observer.sid.clone(),source);success(json!({"coverage":coverage}))},Err(error)=>error}
                                    }else if verb=="__monitor_stop"{match observations.remove(action["sid"].as_str().unwrap_or("")){Some(mut source)=>match source.detach(){Ok(())=>success(json!({"detached":true})),Err(error)=>error},None=>success(json!({"detached":true}))}}
                                    else if verb=="__monitor_flush"{
                                        let mut drained=false;for _ in 0..256{if !PeekMessageW(&mut message,None,0,0,PM_REMOVE).as_bool(){drained=true;break;}let _=TranslateMessage(&message);DispatchMessageW(&message);}
                                        if let Some(source)=observations.get(action["sid"].as_str().unwrap_or("")){source.state.events.borrow_mut().clear();if let Some(uia)=&source.uia{while uia.receiver.try_recv().is_ok(){}}}
                                        if drained{success(json!({}))}else{failure("resource_limit","WinEvent callback queue remains pending; recording remains paused")}
                                    }
                                    else {
                                        state.auth_deadline=if verb=="authdialog"{Some(deadline)}else{None};
                                        let result=state.execute(&verb, &action);
                                        state.auth_deadline=None;
                                        result
                                    };
                                let _ = reply.send(result);
                            },
                            Err(mpsc::RecvTimeoutError::Timeout) => (),
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                },
                Err(e) => for (_, _, _, reply,_) in rx { let _ = reply.send(failure("provider_failed", &e)); },
            }
        });
        tx
    });
    let (tx, rx) = mpsc::channel();
    if worker.try_send((verb.to_owned(), action.clone(), Instant::now() + Duration::from_secs(10), tx,observer)).is_err() { return failure("resource_limit", "UIA worker queue is full or unavailable"); }
    rx.recv_timeout(Duration::from_secs(10)).unwrap_or_else(|_| failure("timeout_unknown_outcome", "UIA worker exceeded its deadline; observe the target before retrying"))
}

impl Uia {
    unsafe fn credential_dialog(&mut self,a:&Value,deadline:Instant)->Result<Option<CredentialDialog>,Value>{unsafe{
        use windows::Win32::Foundation::E_POINTER;
        crate::authdialog::check_deadline(deadline)?;crate::authdialog::ordinary_desktop()?;
        let target=if a.get("ref").is_some(){Some(self.element(a).ok_or_else(||failure("stale_reference","authentication secure-field reference expired"))?)}else{None};
        let windows=if let Some(target)=&target{vec![self.input_target(a,Some(target))?]}else{windows_for(a).map_err(|e|failure("provider_failed",e))?};
        if windows.len()>128{return Err(failure("resource_limit","authentication window inventory exceeds 128 visible roots"));}
        let walker=self.api.ControlViewWalker().map_err(|e|failure("provider_failed",e))?;
        let optional=|result:windows::core::Result<IUIAutomationElement>|->Result<Option<IUIAutomationElement>,Value>{match result{Ok(element)=>Ok(Some(element)),Err(error)if error.code()==E_POINTER=>Ok(None),Err(error)=>Err(failure("provider_failed",format!("authentication native child observation failed ({:08x})",error.code().0)))}};
        let mut found=None;let mut trusted=0;
        for window in windows{
            crate::authdialog::check_deadline(deadline)?;
            if target.is_none()&&!window.name.eq_ignore_ascii_case("CredentialUIBroker")&&!window.name.eq_ignore_ascii_case("consent"){continue;}
            trusted+=1;if trusted>16{return Err(failure("resource_limit","authentication agent roots exceed 16"));}
            let process=if let Some(reference)=a["ref"].as_str(){self.refs.get(reference).map(|(_,_,process)|process.clone()).ok_or_else(||failure("stale_reference","authentication process reference expired"))?}
                else{Rc::new(Process::open(window.pid).map_err(|_|failure("permission_denied","authentication process cannot be retained in the current login"))?)};
            let identity=process.secret_identity()?;crate::authdialog::trusted_agent(&identity,deadline)?;
            if a.get("expectedIdentity").is_some()&&!crate::secret_target::matches(&a["expectedIdentity"],&identity){return Err(failure("stale_reference","authentication process differs from its retained vault target"));}
            let root=self.api.ElementFromHandle(window.handle).map_err(|_|failure("provider_failed","authentication root is not exposed by native UI Automation"))?;
            if let Some(reference)=a["dialogRef"].as_str(){
                let expected=self.element(&json!({"ref":reference})).ok_or_else(||failure("stale_reference","authentication window reference expired"))?;
                if !self.api.CompareElements(&expected,&root).map_err(|_|failure("target_gone","authentication retained window identity is unavailable"))?.as_bool(){return Err(failure("target_gone","authentication secure field moved to a different window"));}
            }
            let mut stack=vec![(root.clone(),0_usize)];let mut visited:Vec<IUIAutomationElement>=Vec::new();let mut bytes=0_usize;
            let(mut secure,mut username,mut user,mut message,mut buttons)=(None,None,String::new(),Vec::new(),Vec::new());
            while let Some((element,depth))=stack.pop(){
                crate::authdialog::check_deadline(deadline)?;
                if depth>12||visited.len()>=512{return Err(failure("resource_limit","authentication tree exceeds its depth or node bound"));}
                for prior in &visited{if self.api.CompareElements(prior,&element).map_err(|_|failure("provider_failed","authentication element identity is unavailable"))?.as_bool(){return Err(failure("provider_failed","authentication native tree contains a repeated element"));}}
                visited.push(element.clone());
                if element.CurrentProcessId().map_err(|_|failure("target_gone","authentication element process disappeared"))?as u32!=process.pid{return Err(failure("target_gone","authentication element belongs to another process"));}
                let control=element.CurrentControlType().map_err(|_|failure("provider_failed","authentication control type is unavailable"))?;
                let password=element.CurrentIsPassword().map_err(|_|failure("provider_failed","authentication secure-field classification is unavailable"))?.as_bool();
                if password{
                    if control!=UIA_EditControlTypeId||secure.is_some(){return Err(failure("target_ambiguous","authentication requires one native secure edit control"));}secure=Some(element.clone());
                }else if control==UIA_ButtonControlTypeId||control==UIA_TextControlTypeId{
                    let title=element.CurrentName().map_err(|_|failure("provider_failed","authentication control label is unavailable"))?.to_string();
                    if title.len()>8192||bytes>32768-title.len(){return Err(failure("resource_limit","authentication observation text exceeds its bound"));}bytes+=title.len();
                    if control==UIA_ButtonControlTypeId{if buttons.len()>=64{return Err(failure("resource_limit","authentication buttons exceed 64"));}buttons.push((title,element.clone()));}else if !title.is_empty(){message.push(title);}
                }else if control==UIA_EditControlTypeId{
                    if username.is_some(){return Err(failure("target_ambiguous","authentication has multiple ordinary edit fields"));}
                    let pattern=element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).map_err(|_|failure("unsupported_target","authentication user field has no native value interface"))?;
                    let value=pattern.CurrentValue().map_err(|_|failure("provider_failed","authentication user identity is unavailable"))?;
                    if value.len()>256{return Err(failure("resource_limit","authentication user field exceeds 256 UTF16 units"));}user=String::from_utf16(&value).map_err(|_|failure("provider_failed","authentication user field contains invalid UTF16"))?;username=Some(element.clone());
                }
                let mut child=optional(walker.GetFirstChildElement(&element))?;let mut count=0;
                while let Some(current)=child{
                    crate::authdialog::check_deadline(deadline)?;count+=1;
                    if count>256||stack.len()+visited.len()>=512{return Err(failure("resource_limit","authentication child inventory exceeds its bound"));}
                    child=optional(walker.GetNextSiblingElement(&current))?;stack.push((current,depth+1));
                }
            }
            let Some(secure)=secure else{if target.is_some(){return Err(failure("unsupported_target","retained native authentication root has no secure edit control"));}continue;};
            if let Some(target)=&target{if !self.api.CompareElements(target,&secure).map_err(|_|failure("target_gone","authentication secure-field identity changed"))?.as_bool(){return Err(failure("unsupported_target","authentication reference is not the unique password field"));}}
            if !process.secret_identity().is_ok_and(|current|crate::secret_target::matches(&identity,&current)){return Err(failure("target_gone","authentication process changed during traversal"));}
            if found.is_some(){return Err(failure("target_ambiguous","multiple eligible native authentication dialogs are present"));}
            found=Some(CredentialDialog{window:root,secure,username,user,title:window.title,message:message.join(" "),buttons,process,identity});
        }
        crate::authdialog::check_deadline(deadline)?;Ok(found)
    }}
    fn authdialog(&mut self,a:&Value)->Value{
        let result=(||->Result<Value,Value>{unsafe{
            let deadline=self.auth_deadline.ok_or_else(||failure("provider_failed","authentication worker omitted its retained deadline"))?;
            let provider="windows-credential-dialog";
            let Some(dialog)=self.credential_dialog(a,deadline)?else{
                return if a["sub"]=="status"&&a.get("ref").is_none(){Ok(success(json!({"present":false,"shape":"none","provider":provider})))}else{Err(failure("target_gone","retained authentication dialog is unavailable"))};
            };
            if a["sub"]=="status"{
                let secure_ref=if let Some(reference)=a["ref"].as_str(){reference.to_owned()}else{self.reference(dialog.secure.clone()).map_err(|_|failure("target_gone","authentication secure field could not be retained"))?};
                let dialog_ref=if let Some(reference)=a["dialogRef"].as_str(){reference.to_owned()}else{self.reference(dialog.window.clone()).map_err(|_|failure("target_gone","authentication window could not be retained"))?};
                let mut data=json!({"present":true,"shape":"password","provider":provider,"pid":dialog.process.pid,"title":dialog.title,"message":dialog.message,"buttons":dialog.buttons.iter().map(|(title,_)|title).collect::<Vec<_>>(),"username":dialog.user,"hasSecureField":true,"dialogRef":dialog_ref,"secureRef":secure_ref,"targetIdentity":dialog.identity});
                if let Some(username)=dialog.username{data["usernameRef"]=json!(self.reference(username).map_err(|_|failure("target_gone","authentication user field could not be retained"))?);}return Ok(success(data));
            }
            if dialog.username.is_some(){return Err(failure("unsupported_target","Windows authentication account selection requires a qualified native account binding; no password was delivered"));}
            if !secret_control_ready(&dialog.secure){return Err(failure("background_unavailable","native authentication password field does not support the retained background value path"));}
            crate::authdialog::check_deadline(deadline)?;
            let generation=crate::secret_target::random_token().map_err(|_|failure("provider_failed","authentication request randomness is unavailable"))?;
            crate::authdialog::ordinary_desktop()?;
            self.auth_window=Some(dialog.window.clone());
            let delivery=self.execute("type",&crate::authdialog::typed_action(a));
            self.auth_window=None;
            if delivery["success"]!=true{return Err(if matches!(delivery["code"].as_str(),Some("permission_denied"|"stale_reference"|"background_unavailable")){delivery}else{failure("timeout_unknown_outcome","authentication native value delivery failed; partial effect is possible, observe before another action")});}
            crate::authdialog::check_deadline(deadline).map_err(|_|failure("timeout_unknown_outcome","authentication delivery completed after its deadline; no confirmation was sent"))?;
            let mut submitted=None;let mut closed=false;let mut closure_error=None;
            if a["submit"]==true{
                let current=self.credential_dialog(a,deadline)?.ok_or_else(||failure("target_gone","authentication dialog disappeared after value delivery"))?;
                if !self.api.CompareElements(&dialog.window,&current.window).map_err(|_|failure("target_gone","authentication window identity is unavailable"))?.as_bool()||!self.api.CompareElements(&dialog.secure,&current.secure).map_err(|_|failure("target_gone","authentication secure-field identity is unavailable"))?.as_bool(){return Err(failure("target_gone","authentication dialog changed after filling; no confirmation was sent"));}
                let titles=current.buttons.iter().map(|(title,_)|title.clone()).collect::<Vec<_>>();let selected=crate::authdialog::confirmation(&titles)?;let(title,button)=&current.buttons[selected];
                let invoke=button.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId).map_err(|_|failure("unsupported_target","authentication confirmation has no native invocation interface"))?;
                if !button.CurrentIsEnabled().is_ok_and(|enabled|enabled.as_bool())||!current.process.secret_identity().is_ok_and(|identity|crate::secret_target::matches(&current.identity,&identity)){return Err(failure("target_gone","authentication confirmation owner or enabled state changed"));}
                crate::authdialog::check_deadline(deadline)?;crate::authdialog::ordinary_desktop()?;
                invoke.Invoke().map_err(|_|failure("timeout_unknown_outcome","authentication confirmation outcome is unknown; no fallback or replay was sent"))?;submitted=Some(title.clone());
                let observe_until=deadline.min(Instant::now()+Duration::from_secs(2));let hwnd=dialog.window.CurrentNativeWindowHandle().map_err(|_|failure("provider_failed","retained authentication native window is unavailable"))?;
                while Instant::now()<observe_until{
                    if !dialog.process.alive()||!IsWindow(Some(hwnd)).as_bool(){closed=true;break;}
                    match self.api.ElementFromHandle(hwnd).and_then(|window|self.api.CompareElements(&window,&dialog.window)){Ok(same)if !same.as_bool()=>{closed=true;break;},Ok(_)=>(),Err(_)=>{closure_error=Some("provider_failed".to_owned());break;}}
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            Ok(crate::authdialog::filled(a,provider,dialog.identity,submitted,closed,closure_error,generation))
        }})();result.unwrap_or_else(|error|error)
    }
    unsafe fn observe_events(&mut self,source:&Observation,deadline:Instant){
        unsafe{
            use std::os::windows::io::IntoRawHandle;
            if let Some(uia)=&source.uia{for _ in 0..256{
                if Instant::now()>=deadline{break;}
                let Ok(event)=uia.receiver.try_recv()else{break;};let observer=&source.state.observer;
                if observer.epoch()!=Some(event.generation){continue;}
                let process=Process{pid:event.pid,handle:OwnedHandle(HANDLE(event.process.into_raw_handle()))};
                let Ok(identity)=process.secret_identity()else{continue;};
                let app=identity["executable"].as_str().unwrap_or("").rsplit('\\').next().unwrap_or("").trim_end_matches(".exe");
                let mut foreground=0;GetWindowThreadProcessId(GetForegroundWindow(),Some(&mut foreground));
                if !observer.accepts(process.pid,app,process.pid==foreground){continue;}
                let Ok(element)=event.element.resolve()else{continue;};
                if element.CurrentProcessId().ok()!=Some(process.pid as i32){continue;}
                let Ok(description)=self.describe_fields(element,event.kind=="input",true)else{continue;};
                if process.alive(){observer.emit(event.generation,event.kind,"ax",app,description,&event.notification);}
            }}
            for _ in 0..256{
                if Instant::now()>=deadline{break;}
                let event=source.state.events.borrow_mut().pop_front();let Some(event)=event else{break;};
                let observer=&source.state.observer;if observer.epoch()!=Some(event.generation)||!event.process.alive(){continue;}
                let pid=event.process.pid;
                if event.kind!=EVENT_OBJECT_DESTROY{let mut current=0;GetWindowThreadProcessId(event.hwnd,Some(&mut current));if current!=pid{continue;}}
                let mut target_session=0;
                if ProcessIdToSessionId(pid,&mut target_session).is_err()||target_session.to_string()!=session(){continue;}
                if !matches!((sid(event.process.handle.0),sid(GetCurrentProcess())),(Ok(target),Ok(current))if target==current){continue;}
                let mut image=vec![0_u16;32768];let mut length=image.len()as u32;
                if QueryFullProcessImageNameW(event.process.handle.0,PROCESS_NAME_WIN32,PWSTR(image.as_mut_ptr()),&mut length).is_err(){continue;}
                let app=String::from_utf16_lossy(&image[..length as usize]).rsplit('\\').next().unwrap_or("").trim_end_matches(".exe").to_owned();
                let mut foreground=0;GetWindowThreadProcessId(GetForegroundWindow(),Some(&mut foreground));
                if !observer.accepts(pid,&app,pid==foreground){continue;}
                let(kind,source_name)=match event.kind{
                    EVENT_SYSTEM_FOREGROUND=>("frontmost","workspace"),EVENT_SYSTEM_MINIMIZESTART=>("window_min","workspace"),EVENT_SYSTEM_MINIMIZEEND=>("window_demin","workspace"),
                    EVENT_OBJECT_CREATE|EVENT_OBJECT_DESTROY if event.object==OBJID_WINDOW.0&&event.child==0=>(if event.kind==EVENT_OBJECT_CREATE{"window_create"}else{"window_destroy"},"workspace"),
                    _=>continue,
                };
                if observer.excludes.contains(source_name)||observer.excludes.contains(kind){continue;}
                let mut description=if event.kind==EVENT_OBJECT_DESTROY{json!({"pid":pid,"role":"AXWindow","name":"","secure":false})}else{
                    let Ok(element)=self.api.ElementFromHandle(event.hwnd)else{continue;};
                    if element.CurrentProcessId().ok()!=Some(pid as i32){continue;}
                    let Ok(description)=self.describe_fields(element,kind=="input",true)else{continue;};description
                };
                if !event.process.alive(){continue;}description["windowId"]=json!(event.hwnd.0 as usize);
                observer.emit(event.generation,kind,source_name,&app,description,&format!("WinEvent:{}",event.kind));
            }
        }
    }
    fn launch(&mut self, action:&Value)->Value{
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::System::Threading::{CreateProcessW,STARTUPINFOW,PROCESS_INFORMATION,STARTF_USESHOWWINDOW};
        let path=std::path::Path::new(action["app"].as_str().unwrap_or(""));
        if !path.is_absolute() || !path.extension().is_some_and(|ext|ext.eq_ignore_ascii_case("exe")){
            return failure("unsupported_target","new Windows application launch requires an absolute .exe path without arguments");
        }
        let path=match path.canonicalize(){Ok(path) if path.is_file()=>path,_=>return failure("target_gone","requested launch executable is unavailable")};
        let existing=match windows_for(&json!({})){Ok(windows)=>windows,Err(error)=>return failure("provider_failed",error)};
        let mut matching=Vec::new();
        for window in existing{
            if matching.contains(&window.pid){continue;}
            let Ok(process)=Process::open(window.pid)else{continue;};
            let mut image=vec![0_u16;32768];let mut length=image.len()as u32;
            if unsafe{QueryFullProcessImageNameW(process.handle.0,PROCESS_NAME_WIN32,PWSTR(image.as_mut_ptr()),&mut length)}.is_ok(){
                let image=std::path::PathBuf::from(String::from_utf16_lossy(&image[..length as usize]));
                if image.canonicalize().is_ok_and(|image|image.as_os_str().eq_ignore_ascii_case(path.as_os_str())){matching.push(window.pid);}
            }
        }
        if matching.len()>1{return failure("target_ambiguous","more than one running application uses this executable");}
        if let Some(pid)=matching.first(){return success(json!({"pid":pid,"launched":false}));}
        let wide:Vec<u16>=path.as_os_str().encode_wide().chain([0]).collect();
        let startup=STARTUPINFOW{cb:std::mem::size_of::<STARTUPINFOW>()as u32,dwFlags:STARTF_USESHOWWINDOW,wShowWindow:if action["activate"]==true{SW_SHOWNORMAL.0 as u16}else{SW_SHOWNOACTIVATE.0 as u16},..Default::default()};
        let mut info=PROCESS_INFORMATION::default();
        if let Err(error)=unsafe{CreateProcessW(PCWSTR(wide.as_ptr()),None,None,None,false,Default::default(),None,PCWSTR::null(),&startup,&mut info)}{
            return failure(if error.code()==windows::Win32::Foundation::ERROR_ELEVATION_REQUIRED.to_hresult(){"human_required"}else{"provider_failed"},error);
        }
        let _thread=OwnedHandle(info.hThread);
        let process=Rc::new(Process{pid:info.dwProcessId,handle:OwnedHandle(info.hProcess)});
        self.processes.insert(info.dwProcessId,process);
        success(json!({"pid":info.dwProcessId,"launched":true}))
    }
    fn reference(&mut self, element: IUIAutomationElement) -> windows::core::Result<String> {
        let pid = unsafe { element.CurrentProcessId()? } as u32;
        self.reference_for(element, pid)
    }
    fn reference_for(&mut self, element: IUIAutomationElement, pid: u32) -> windows::core::Result<String> {
        if self.refs.len() >= 20000 { self.refs.clear(); self.processes.clear(); }
        let process = match self.processes.get(&pid).filter(|process| process.alive()) {
            Some(process) => process.clone(),
            None => { let process = Rc::new(Process::open(pid)?); self.processes.insert(pid, process.clone()); process },
        };
        self.serial = self.serial.checked_add(1).expect("native reference counter exhausted"); let key = crate::accessibility::reference(self.serial);
        self.refs.insert(key.clone(), (element, Instant::now(), process)); Ok(key)
    }
    fn element(&self, a: &Value) -> Option<IUIAutomationElement> {
        let key = a["ref"].as_str()?;
        self.refs.get(key).filter(|(element, at, process)| at.elapsed() < Duration::from_secs(300) && process.alive() &&
            unsafe { element.CurrentProcessId().is_ok_and(|pid| pid as u32 == process.pid) }).map(|(element, _, _)| element.clone())
    }
    unsafe fn describe(&mut self, element: IUIAutomationElement) -> windows::core::Result<Value> {
        unsafe{self.describe_fields(element,true,false)}
    }
    /// Element actions through UIA patterns, which run in the target without synthesizing
    /// input. `press` tries Invoke, then Toggle, Select and Expand/Collapse, the way a
    /// click would act on that control. Returns the method used.
    unsafe fn pattern_action(&self, element: &IUIAutomationElement, requested: &str) -> Result<&'static str, Value> {
        unsafe {
            let call = |result: windows::core::Result<()>| result.map_err(|e| failure("timeout_unknown_outcome", format!("UIA pattern call failed; observe before retrying: {e}")));
            let invoke = || element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId).ok();
            let toggle = || element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId).ok();
            let select = || element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId).ok();
            let expand = || element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId).ok();
            let missing = |what: &str| failure("unsupported_target", format!("target exposes no {what} pattern"));
            match requested {
                "press" | "invoke" => {
                    if let Some(p) = invoke() { call(p.Invoke())?; return Ok("UIA.InvokePattern"); }
                    if let Some(p) = toggle() { call(p.Toggle())?; return Ok("UIA.TogglePattern"); }
                    if let Some(p) = select() { call(p.Select())?; return Ok("UIA.SelectionItemPattern"); }
                    if let Some(p) = expand() {
                        let open = p.CurrentExpandCollapseState().is_ok_and(|s| s == ExpandCollapseState_Expanded);
                        call(if open { p.Collapse() } else { p.Expand() })?; return Ok("UIA.ExpandCollapsePattern");
                    }
                    Err(missing("invoke, toggle, selection or expand/collapse"))
                }
                "toggle" => { let p = toggle().ok_or_else(|| missing("toggle"))?; call(p.Toggle())?; Ok("UIA.TogglePattern") }
                "select" => { let p = select().ok_or_else(|| missing("selection item"))?; call(p.Select())?; Ok("UIA.SelectionItemPattern") }
                "expand" | "collapse" => {
                    let p = expand().ok_or_else(|| missing("expand/collapse"))?;
                    call(if requested == "expand" { p.Expand() } else { p.Collapse() })?; Ok("UIA.ExpandCollapsePattern")
                }
                _ => {
                    let p = element.GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId).map_err(|_| missing("range value"))?;
                    let step = p.CurrentSmallChange().ok().filter(|s| *s > 0.0).unwrap_or(1.0);
                    let (value, min, max) = (p.CurrentValue().map_err(|e| failure("target_gone", e))?, p.CurrentMinimum().unwrap_or(f64::MIN), p.CurrentMaximum().unwrap_or(f64::MAX));
                    call(p.SetValue((if requested == "increment" { value + step } else { value - step }).clamp(min, max)))?; Ok("UIA.RangeValuePattern")
                }
            }
        }
    }
    /// One cache request for the traversal properties, so a walker step returns them in the
    /// same cross-process call instead of one call per property (uiauto-cachingforclients).
    unsafe fn read_cache(&self) -> windows::core::Result<IUIAutomationCacheRequest> {
        unsafe {
            let cache = self.api.CreateCacheRequest()?;
            for id in [UIA_NamePropertyId, UIA_IsPasswordPropertyId, UIA_ProcessIdPropertyId, UIA_ControlTypePropertyId, UIA_BoundingRectanglePropertyId, UIA_ValueValuePropertyId] { cache.AddProperty(id)?; }
            Ok(cache)
        }
    }
    /// describe() from properties cached by read_cache(); falls back to live reads when the
    /// element was obtained without the cache.
    unsafe fn describe_cached(&mut self, element: IUIAutomationElement) -> windows::core::Result<Value> {
        unsafe {
            let Ok(name) = element.CachedName() else { return self.describe(element) };
            let secure = element.CachedIsPassword()?.as_bool();
            let pid = element.CachedProcessId()?; let native_role = element.CachedControlType()?.0;
            let frame = element.CachedBoundingRectangle()?;
            let value = if secure { "•••".to_owned() } else {
                element.GetCachedPropertyValue(UIA_ValueValuePropertyId).ok().and_then(|v| windows::core::BSTR::try_from(&v).ok()).map(|s| s.to_string()).unwrap_or_default()
            };
            let reference = self.reference_for(element, pid as u32)?;
            Ok(Self::node(reference, Self::role_name(native_role).to_owned(), native_role, name.to_string(), value, pid, secure, frame, false))
        }
    }
    fn role_name(native_role: i32) -> &'static str {
        match native_role {
            50000 => "AXButton", 50001 => "AXCalendar", 50002 => "AXCheckBox", 50003 => "AXPopUpButton",
            50004 => "AXTextField", 50005 => "AXLink", 50006 => "AXImage", 50007 => "AXRow",
            50008 => "AXList", 50009 => "AXMenu", 50010 => "AXMenuBar", 50011 => "AXMenuItem",
            50012 => "AXProgressIndicator", 50013 => "AXRadioButton", 50014 => "AXScrollBar",
            50015 => "AXSlider", 50016 => "AXIncrementor", 50018 => "AXTabGroup", 50019 => "AXRadioButton",
            50020 => "AXStaticText", 50023 => "AXOutline", 50024 => "AXRow", 50028 => "AXTable",
            50030 => "AXTextArea", 50032 => "AXWindow", 50033 | 50026 => "AXGroup", _ => "AXUnknown",
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn node(reference: String, role: String, native_role: i32, name: String, value: String, pid: i32, secure: bool, frame: RECT, recording: bool) -> Value {
        json!({"ref":reference,"role":if recording{role}else{crate::accessibility::display_role(&role)},"nativeRole":native_role,"name":name,"title":name,"value":value,"pid":pid,"secure":secure,
            "frame":{"x":frame.left,"y":frame.top,"width":frame.right-frame.left,"height":frame.bottom-frame.top}})
    }
    unsafe fn describe_fields(&mut self,element:IUIAutomationElement,read_value:bool,recording:bool)->windows::core::Result<Value>{
        unsafe {
            let name = element.CurrentName()?.to_string();
            let secure = element.CurrentIsPassword()?.as_bool();
            let pid = element.CurrentProcessId()?; let native_role = element.CurrentControlType()?.0;
            let role = match native_role {
                50000 => "AXButton", 50001 => "AXCalendar", 50002 => "AXCheckBox", 50003 => "AXPopUpButton",
                50004 => "AXTextField", 50005 => "AXLink", 50006 => "AXImage", 50007 => "AXRow",
                50008 => "AXList", 50009 => "AXMenu", 50010 => "AXMenuBar", 50011 => "AXMenuItem",
                50012 => "AXProgressIndicator", 50013 => "AXRadioButton", 50014 => "AXScrollBar",
                50015 => "AXSlider", 50016 => "AXIncrementor", 50018 => "AXTabGroup", 50019 => "AXRadioButton",
                50020 => "AXStaticText", 50023 => "AXOutline", 50024 => "AXRow", 50028 => "AXTable",
                50030 => "AXTextArea", 50032 => "AXWindow", 50033 | 50026 => "AXGroup", _ => "AXUnknown",
            };
            let frame = element.CurrentBoundingRectangle()?;
            let value = if secure { "•••".to_owned() } else if !read_value{String::new()}else { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .and_then(|p| p.CurrentValue()).map(|s| s.to_string()).unwrap_or_default() };
            let reference = if recording{String::new()}else{self.reference(element)?};
            Ok(json!({"ref":reference,"role":if recording{role.to_owned()}else{crate::accessibility::display_role(role)},"nativeRole":native_role,"name":name,"title":name,"value":value,"pid":pid,"secure":secure,
                "frame":{"x":frame.left,"y":frame.top,"width":frame.right-frame.left,"height":frame.bottom-frame.top}}))
        }
    }
    fn input_target(&self, a: &Value, element: Option<&IUIAutomationElement>) -> Result<Window, Value> {
        let mut candidates=windows_for(a).map_err(|e|failure("provider_failed",e))?;
        if let Some(element)=element {
            unsafe {
                let pid=element.CurrentProcessId().map_err(|e|failure("target_gone",e))? as u32;
                let mut node=element.clone();let walker=self.api.ControlViewWalker().map_err(|e|failure("provider_failed",e))?;
                let mut root=None;
                for _ in 0..32 {
                    if let Ok(hwnd)=node.CurrentNativeWindowHandle(){if !hwnd.is_invalid(){root=Some(GetAncestor(hwnd,GA_ROOT));break;}}
                    node=match walker.GetParentElement(&node){Ok(node)=>node,Err(_)=>break};
                }
                candidates.retain(|w|w.pid==pid && root.is_some_and(|hwnd|w.handle==hwnd));
            }
        } else if ["app","pid","window","windowTitle","windowBounds"].iter().all(|key|a.get(*key).is_none()) {
            candidates.retain(|w|w.handle==unsafe{GetForegroundWindow()});
        }
        // Several windows of one app: a coordinate picks the topmost one under that point (window
        // enumeration is in z-order), as macOS does.
        if candidates.len()>1 && let Some(p)=input::point(&a["coords"]).or_else(||input::point(&a["fromCoords"])) {
            if let Some(index)=candidates.iter().position(|w|p.x>=w.rect.left&&p.x<w.rect.right&&p.y>=w.rect.top&&p.y<w.rect.bottom){candidates=vec![candidates.swap_remove(index)];}
        }
        if candidates.len()!=1{return Err(failure(if candidates.is_empty(){"target_gone"}else{"target_ambiguous"},"input requires one matching window; pass --window when an app has several"));}
        Ok(candidates.remove(0))
    }
    fn foreground_input(&self, verb:&str, a:&Value)->Value {
        let element=if a["ref"].is_string(){match self.element(a){Some(e)=>Some(e),None=>return failure("stale_reference","read the target again for a fresh reference")}}else{None};
        let from=if a["from"].is_string(){match self.element(&json!({"ref":a["from"]})){Some(e)=>Some(e),None=>return failure("stale_reference","drag source is stale")}}else{None};
        let to=if a["to"].is_string(){match self.element(&json!({"ref":a["to"]})){Some(e)=>Some(e),None=>return failure("stale_reference","drag destination is stale")}}else{None};
        let window=match self.input_target(a,element.as_ref().or(from.as_ref())){Ok(w)=>w,Err(e)=>return e};
        if let Some(to)=&to {match self.input_target(a,Some(to)){Ok(w)if w.handle==window.handle=>(),_=>return failure("unsupported_target","drag endpoints must belong to the selected window")}}
        unsafe {
            for element in [element.as_ref(),from.as_ref(),to.as_ref()].into_iter().flatten(){
                if !element.CurrentIsEnabled().is_ok_and(|enabled|enabled.as_bool()){return failure("permission_denied","input target is disabled or unavailable");}
            }
            let center=|element:&IUIAutomationElement|element.CurrentBoundingRectangle().ok().filter(|r|r.right>r.left&&r.bottom>r.top).map(|r|windows::Win32::Foundation::POINT{x:((i64::from(r.left)+i64::from(r.right))/2)as i32,y:((i64::from(r.top)+i64::from(r.bottom))/2)as i32});
            let start=input::point(&a["coords"]).or_else(||input::point(&a["fromCoords"]))
                .or_else(||element.as_ref().or(from.as_ref()).and_then(center))
                .or_else(||Some(windows::Win32::Foundation::POINT{x:((i64::from(window.rect.left)+i64::from(window.rect.right))/2)as i32,y:((i64::from(window.rect.top)+i64::from(window.rect.bottom))/2)as i32}));
            let end=input::point(&a["toCoords"]).or_else(||to.as_ref().and_then(center));
            let pointer=["click","scroll","drag"].contains(&verb);
            input::deliver(window.handle,window.pid,a,verb,if pointer{start}else{None},if pointer{end}else{None},element.as_ref(),&self.api)
        }
    }
    fn execute(&mut self, verb: &str, a: &Value) -> Value {
        if verb=="authdialog"{return self.authdialog(a);}
        if ["read","act","inspect_app","open"].contains(&verb){return crate::compound::execute(verb,a,|operation,action|self.execute(operation,action));}
        if verb=="__launch"{return self.launch(a);}
        if verb=="__launch_alive"{return success(json!(a["pid"].as_u64().is_some_and(|pid|self.processes.get(&(pid as u32)).is_some_and(|process|process.alive()))));}
        if verb=="__activate"{
            let windows=match windows_for(a){Ok(windows)=>windows,Err(error)=>return failure("provider_failed",error)};
            // Same path as `app activate`: the largest window, restored, through the qualified
            // same-desktop foreground helper (a bare SetForegroundWindow meets the foreground lock).
            let Some(window)=windows.iter().max_by_key(|w|(w.rect.right-w.rect.left).max(0) as i64*(w.rect.bottom-w.rect.top).max(0) as i64)else{return failure("target_gone","application has no activatable window");};
            if unsafe{IsIconic(window.handle).as_bool()}{let _=unsafe{ShowWindow(window.handle,SW_RESTORE)};}
            return if input::activate(window.handle)&&unsafe{GetForegroundWindow()}==window.handle{success(json!({"activated":true}))}else{let mut refused=failure("restricted_by_os","Windows foreground lock refused activation");refused["details"]=foreground_details();refused};
        }
        if ["display_list","display_info"].contains(&verb){return crate::display::execute(verb,a);}
        if verb=="stream"{return crate::stream::execute(a,|operation,action|self.execute(operation,action));}
        if ["screenshot","capture"].contains(&verb) { return crate::capture::execute(verb,a); }
        if verb == "clipboard" || verb == "__clipboard_snapshot" { return crate::clipboard_windows::execute(verb,a); }
        if ["keys","scroll","drag"].contains(&verb) || (verb=="click" && (a["coords"].is_string() || a["right"]==true || a["double"]==true)) || (verb=="type" && a["ref"].is_null()) {
            return self.foreground_input(verb,a);
        }
        if verb=="menu" {
            // Windows menus belong to windows, not apps: when an app has several windows and exactly
            // one has a menu bar, that is the app's menu (the macOS menu bar is per app).
            let window=match self.input_target(a,None){
                Ok(w)=>w,
                Err(e)if e["code"]=="target_ambiguous"=>match windows_for(a).map(|all|all.into_iter().filter(|w|!unsafe{GetMenu(w.handle)}.is_invalid()).collect::<Vec<_>>()){
                    Ok(mut menus)if menus.len()==1=>menus.remove(0),
                    _=>return e,
                },
                Err(e)=>return e,
            };
            return input::menu(window.handle,window.pid,a);
        }
        unsafe {
            let result: windows::core::Result<Value> = (|| {
                match verb {
                    "windows" => {
                        let mut data = Vec::new();
                        for window in windows_for(a)? {
                            let reference = self.api.ElementFromHandle(window.handle).and_then(|element| {
                                if element.CurrentProcessId()? as u32 != window.pid { Ok(None) }
                                else { self.reference(element).map(Some) }
                            });
                            let mut owner = 0;
                            GetWindowThreadProcessId(window.handle, Some(&mut owner));
                            if owner == 0 || owner != window.pid { continue; }
                            let mut entry = window_json(&window);
                            match reference {
                                Ok(Some(reference)) => entry["ref"] = json!(reference),
                                Ok(None) => entry["refUnavailable"] = failure("stale_reference", "UIA and native window process identities differ; no mutation reference issued"),
                                Err(error) => entry["refUnavailable"] = failure("unsupported_target", error),
                            }
                            data.push(entry);
                        }
                        Ok(json!(data))
                    },
                    "apps" => {
                        let mut apps = HashMap::new(); for w in windows_for(a)? { apps.insert(w.pid, json!({"name":w.name,"pid":w.pid})); }
                        Ok(json!(apps.into_values().collect::<Vec<_>>()))
                    },
                    "frontmost" => {
                        let hwnd = GetForegroundWindow(); let all = windows_for(a)?;
                        Ok(all.iter().find(|w| w.handle == hwnd).map(window_json).unwrap_or(Value::Null))
                    },
                    "focused" => {
                        let element = self.api.GetFocusedElement()?;
                        let pid = element.CurrentProcessId()?;
                        if (a["pid"].is_number() || a["app"].is_string() || a["window"].is_number()) && !windows_for(a)?.iter().any(|w| w.pid == pid as u32 &&
                            (a["window"].is_null() || element.CurrentNativeWindowHandle().is_ok_and(|h| GetAncestor(h, GA_ROOT) == w.handle))) { return Ok(Value::Null); }
                        self.describe(element)
                    },
                    "tree" | "find" => {
                        let max_ms = a["maxMs"].as_u64().unwrap_or(5000).clamp(1, 10000);
                        let started = Instant::now();
                        // Reacquire a changing native inventory within the same
                        // read deadline. Input and other mutations never retry.
                        // Earlier refs stay valid across reads, as on Linux.
                        for read_attempt in 0..4 {
                            let all = windows_for(a)?;
                            if all.is_empty() { return Ok(failure("target_gone", "no matching application window")); }
                            let focused = GetForegroundWindow();
                            let selected: Vec<_> = if a["app"].is_null() && a["pid"].is_null() && a["window"].is_null() {
                                all.iter().filter(|w| w.handle == focused).collect()
                            } else { all.iter().collect() };
                            let walker = self.api.ControlViewWalker()?;
                            let cache = self.read_cache()?;
                            let mut stack = Vec::new();
                            let mut foreign = 0;
                            let mut read_handles = Vec::new();
                            for w in selected.iter().rev() {
                                // A closing WPF popup can disappear between native
                                // window enumeration and UIA root acquisition. Only
                                // retry this read, never an input or other mutation.
                                for attempt in 0..4 {
                                    if started.elapsed().as_millis() >= max_ms as u128 {
                                        return Ok(failure("partial_result", "accessibility root acquisition reached its traversal deadline; scope the read to a window or increase --max-ms"));
                                    }
                                    let mut owner = 0;
                                    GetWindowThreadProcessId(w.handle, Some(&mut owner));
                                    if !IsWindow(Some(w.handle)).as_bool() || !IsWindowVisible(w.handle).as_bool() || owner != w.pid { break; }
                                    match self.api.ElementFromHandleBuildCache(w.handle, &cache) {
                                        Ok(root) => {
                                            // A console host window is attributed to the shell by Win32 but to the console host by
                                            // UIA; it is not this app's UI, so skip it instead of failing the whole read.
                                            if root.CurrentProcessId()? as u32 != w.pid { foreign += 1; break; }
                                            self.reference(root.clone())?;
                                            read_handles.push(w.handle);
                                            stack.push((root, 0)); break;
                                        },
                                        Err(error) if attempt == 3 => return Err(error),
                                        Err(_) => std::thread::sleep(Duration::from_millis(25)),
                                    }
                                }
                            }
                            if stack.is_empty() { return Ok(failure("target_gone", if foreign > 0 { "the matching windows belong to another process in UI Automation (such as a console host); target the app window by --window" } else { "matching windows closed before their accessibility roots were read" })); }
                            let max_nodes = a["maxNodes"].as_u64().unwrap_or(2500).clamp(1, 20000) as usize;
                            let max_depth = a["depth"].as_u64().unwrap_or(if verb == "find" { 15 } else { 10 }).clamp(1, 100);
                            let max_chars = a["maxChars"].as_u64().unwrap_or(50000).clamp(1, 1000000) as usize;
                            let mut text = String::new(); let mut matches = Vec::new(); let mut count = 0;
                            // Find's limit bounds the UTF-8 encoded JSON data
                            // array, including brackets, commas and escaped text.
                            let mut find_bytes = 2;
                            if verb == "find" && max_chars < find_bytes {
                                return Ok(failure("partial_result", "accessibility search character limit cannot contain its result array; increase maxChars"));
                            }
                            let mut cutoff = false;
                            let mut unavailable = false;
                            while let Some((element, depth)) = stack.pop() {
                                if count >= max_nodes || started.elapsed().as_millis() >= max_ms as u128 || text.len() >= max_chars { cutoff = true; text.push_str("… (stopped: traversal budget)\n"); break; }
                                count += 1;
                                if depth + 1 < max_depth {
                                    let mut children = Vec::new(); let first = walker.GetFirstChildElementBuildCache(&element, &cache);
                                    if let Err(error) = &first {
                                        match error.code().0 as u32 {
                                            0 => (), // The binding uses Error::empty for a null child.
                                            0x80040201 | 0x80131505 => unavailable = true,
                                            _ => return Err(error.clone()),
                                        }
                                    }
                                    let mut child = first.ok();
                                    while let Some(e) = child {
                                        if children.len() >= max_nodes || started.elapsed().as_millis() >= max_ms as u128 { cutoff = true; break; }
                                        let next=walker.GetNextSiblingElementBuildCache(&e, &cache);
                                        if let Err(error) = &next {
                                            match error.code().0 as u32 {
                                                0 => (),
                                                0x80040201 | 0x80131505 => unavailable = true,
                                                _ => return Err(error.clone()),
                                            }
                                        }
                                        child = next.ok(); children.push(e);
                                    }
                                    stack.extend(children.into_iter().rev().map(|e| (e, depth+1)));
                                }
                                let described=self.describe_cached(element);
                                if let Err(error) = &described {
                                    match error.code().0 as u32 {
                                        0x80040201 | 0x80131505 => unavailable = true,
                                        _ => return Err(error.clone()),
                                    }
                                }
                                if let Ok(node) = described {
                                    if verb == "find" {
                                        if crate::accessibility::matches(&node, a) {
                                            let bytes = node.to_string().len() + usize::from(!matches.is_empty());
                                            if bytes > max_chars.saturating_sub(find_bytes) { cutoff = true; break; }
                                            find_bytes += bytes;
                                            matches.push(node); if matches.len() >= 25 { break; }
                                        }
                                    } else if let Some(line) = crate::accessibility::tree_line(&node, depth as usize, a["filter"].as_str().unwrap_or("interactive")) { text.push_str(&line); }
                                }
                            }
                            let stable = selected.iter().filter(|w| read_handles.contains(&w.handle)).all(|w| {
                                let mut owner = 0; GetWindowThreadProcessId(w.handle, Some(&mut owner));
                                IsWindow(Some(w.handle)).as_bool() && IsWindowVisible(w.handle).as_bool() && owner == w.pid &&
                                    self.processes.get(&w.pid).is_some_and(|process| process.alive())
                            });
                            // As on macOS, matches found within the budget are the result; only an empty, cut-short search refuses.
                            if verb == "find" && matches.is_empty() && (cutoff || started.elapsed().as_millis() >= max_ms as u128) {
                                return Ok(failure("partial_result", "accessibility search reached its traversal budget; scope the read or increase its limits"));
                            }
                            if !stable || unavailable {
                                if read_attempt == 3 || started.elapsed().as_millis() + 25 >= max_ms as u128 {
                                    return Ok(failure("partial_result", "accessibility windows changed or became unavailable during the bounded read; read the target again"));
                                }
                                std::thread::sleep(Duration::from_millis(25));
                                continue;
                            }
                            return Ok(if verb == "find" { json!(matches) } else { json!(text) });
                        }
                        unreachable!("bounded accessibility read always returns")
                    },
                    "inspect" | "value" | "text" | "click" | "type" | "action" | "resize" | "move" => {
                        let Some(element) = self.element(a) else { return Ok(failure("stale_reference", "read the target again for a fresh reference")); };
                        if a["pid"].as_i64().is_some_and(|pid| element.CurrentProcessId().is_ok_and(|actual| actual as i64 != pid)) {
                            return Ok(failure("unsupported_target", "reference belongs to a different target process"));
                        }
                        if ["app","window","windowTitle","windowBounds"].iter().any(|key|a.get(*key).is_some()) && self.input_target(a,Some(&element)).is_err() {
                            return Ok(failure("unsupported_target", "reference does not belong to the requested application/window"));
                        }
                        let process=self.refs.get(a["ref"].as_str().unwrap()).map(|(_,_,process)|process.clone()).unwrap();
                        if verb == "inspect" {
                            let mut data=self.describe(element.clone())?;
                            if let Ok(identity)=process.secret_identity(){
                                if let Some(name)=a["secretBindingName"].as_str(){
                                    if !secret_control_ready(&element){return Ok(failure("background_unavailable","native credential target requires an enabled editable background text control"));}
                                    let reference=a["ref"].as_str().unwrap();
                                    let token=if let Some(token)=a["secretLease"].as_str(){if !self.grants.check(name,reference,token,&identity){return Ok(failure("permission_denied","native credential grant is unavailable, expired or changed"));}token.to_owned()}
                                        else{match self.grants.bind(name,reference,identity.clone()){Ok(token)=>token,Err(_)=>return Ok(failure("resource_limit","native credential grant could not be issued"))}};
                                    data["secretLease"]=json!(token);
                                }
                                data["targetIdentity"]=identity;
                            }else if a.get("secretBindingName").is_some(){return Ok(failure("permission_denied","native credential target identity is unavailable"));}
                            return Ok(data);
                        }
                        if a.get("expectedIdentity").is_some()&&!process.secret_identity().is_ok_and(|identity|crate::secret_target::matches(&a["expectedIdentity"],&identity)){
                            return Ok(failure("stale_reference","native secret target changed before delivery"));
                        }
                        if verb == "resize" || verb == "move" {
                            let hwnd = element.CurrentNativeWindowHandle()?;
                            if element.CurrentControlType()? != UIA_WindowControlTypeId || GetAncestor(hwnd, GA_ROOT) != hwnd ||
                                !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() || IsZoomed(hwnd).as_bool() {
                                return Ok(failure("unsupported_target", "geometry requires a visible, restored top-level window ref"));
                            }
                            if !element.CurrentIsEnabled()?.as_bool() { return Ok(failure("permission_denied", "target window is disabled")); }
                            let permitted = element.GetCurrentPatternAs::<IUIAutomationTransformPattern>(UIA_TransformPatternId)
                                .and_then(|pattern| if verb == "resize" { pattern.CurrentCanResize() } else { pattern.CurrentCanMove() });
                            if !permitted.is_ok_and(|allowed| allowed.as_bool()) {
                                return Ok(failure("unsupported_target", "UIA transform capability does not permit the requested geometry action"));
                            }
                            let mut owner = 0; GetWindowThreadProcessId(hwnd, Some(&mut owner));
                            if self.element(a).is_none() || owner == 0 || owner != element.CurrentProcessId()? as u32 {
                                return Ok(failure("stale_reference", "window process identity changed before geometry delivery"));
                            }
                            let mut before = RECT::default(); GetWindowRect(hwnd, &mut before)?;
                            let requested = if verb == "resize" { ["width", "height"] } else { ["x", "y"] };
                            let mut frame = json!({"x":before.left,"y":before.top,"width":i64::from(before.right)-i64::from(before.left),"height":i64::from(before.bottom)-i64::from(before.top)});
                            if requested.iter().all(|key| frame[*key] == a[*key]) {
                                return Ok(crate::accessibility::geometry_response(frame, verb, a));
                            }
                            let flags = SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS |
                                if verb == "resize" { SWP_NOMOVE } else { SWP_NOSIZE };
                            // A size past the monitor's work area is clamped to it and reported, as macOS clamps to
                            // the visible frame. Windows itself stopped at its larger maximum tracking size
                            // (screen plus borders) and the reply did not say so (seen on the 800x600 VM).
                            let mut width = a["width"].as_i64().unwrap_or(0); let mut height = a["height"].as_i64().unwrap_or(0); let mut clamped_to = None;
                            if verb == "resize" {
                                let mut info = windows::Win32::Graphics::Gdi::MONITORINFO { cbSize: std::mem::size_of::<windows::Win32::Graphics::Gdi::MONITORINFO>() as u32, ..Default::default() };
                                if windows::Win32::Graphics::Gdi::GetMonitorInfoW(windows::Win32::Graphics::Gdi::MonitorFromWindow(hwnd, windows::Win32::Graphics::Gdi::MONITOR_DEFAULTTONEAREST), &mut info).as_bool() {
                                    let work = info.rcWork; let (room_w, room_h) = (i64::from(work.right) - i64::from(before.left), i64::from(work.bottom) - i64::from(before.top));
                                    if width > room_w || height > room_h { width = width.min(room_w); height = height.min(room_h); clamped_to = Some(json!({"x":work.left,"y":work.top,"width":work.right-work.left,"height":work.bottom-work.top})); }
                                }
                            }
                            let target = json!({"x":a["x"],"y":a["y"],"width":width,"height":height});
                            SetWindowPos(hwnd, None, a["x"].as_i64().unwrap_or(0) as i32, a["y"].as_i64().unwrap_or(0) as i32, width as i32, height as i32, flags)?;
                            let respond = |frame: Value| { let mut data = crate::accessibility::geometry_response(frame, verb, a); if let Some(work) = &clamped_to { data["clamped"] = json!(true); data["clampedTo"] = work.clone(); } data };
                            // ASYNCWINDOWPOS avoids blocking on a hung application.
                            // Observe delivery once; never replay an uncertain mutation.
                            let deadline = Instant::now() + Duration::from_secs(1);
                            let mut previous = frame.clone(); let mut changed = false; let mut stable = 0;
                            while Instant::now() < deadline {
                                std::thread::sleep(Duration::from_millis(25));
                                let mut owner = 0; GetWindowThreadProcessId(hwnd, Some(&mut owner));
                                if self.element(a).is_none() || owner == 0 || owner != element.CurrentProcessId()? as u32 {
                                    return Ok(failure("timeout_unknown_outcome", "window identity changed after geometry delivery; observe before retrying"));
                                }
                                let mut rect = RECT::default();
                                if GetWindowRect(hwnd, &mut rect).is_err() { return Ok(failure("timeout_unknown_outcome", "window frame is unavailable after geometry delivery")); }
                                frame = json!({"x":rect.left,"y":rect.top,"width":i64::from(rect.right)-i64::from(rect.left),"height":i64::from(rect.bottom)-i64::from(rect.top)});
                                changed |= frame != previous;
                                stable = if frame == previous { stable + 1 } else { 0 };
                                if requested.iter().all(|key| frame[*key] == target[*key]) || (changed && stable >= 4) {
                                    return Ok(respond(frame));
                                }
                                previous = frame.clone();
                            }
                            return Ok(failure("timeout_unknown_outcome", "geometry delivery was not observed before its deadline; observe before retrying"));
                        }
                        if (verb == "click" || verb == "action" || verb == "type" || (verb == "value" && a["value"].is_string())) && !element.CurrentIsEnabled()?.as_bool() {
                            return Ok(failure("permission_denied", "target is disabled"));
                        }
                        if verb == "click" || verb == "action" {
                            if a["double"].as_bool() == Some(true) || a["right"].as_bool() == Some(true) || !a["coords"].is_null() {
                                return Ok(failure("unsupported_operation", "coordinate, right and double clicks require a separately qualified input path"));
                            }
                            let requested = a["action"].as_str().unwrap_or("press").trim_start_matches("AX").to_ascii_lowercase();
                            if !["press", "invoke", "toggle", "select", "expand", "collapse", "increment", "decrement"].contains(&requested.as_str()) { return Ok(failure("unsupported_operation", "requested UIA action has no qualified mapping")); }
                            // WinForms' InvokePattern activates its owner. A native
                            // button notification invokes the same parent handler
                            // without synthesizing pointer input or taking focus.
                            let hwnd = element.CurrentNativeWindowHandle()?;
                            let mut class = [0_u16; 256];
                            let n = if hwnd.is_invalid() { 0 } else { GetClassNameW(hwnd, &mut class) };
                            let class = String::from_utf16_lossy(&class[..n as usize]).to_lowercase();
                            let control_type = element.CurrentControlType()?;
                            let win32_button = (class == "button" || class.starts_with("windowsforms10.button.")) &&
                                [UIA_ButtonControlTypeId, UIA_CheckBoxControlTypeId, UIA_RadioButtonControlTypeId].contains(&control_type);
                            if !win32_button || !["press", "invoke", "toggle"].contains(&requested.as_str()) {
                                // Other frameworks implement UIA patterns in the target process without
                                // activating it. WinForms non-button controls only expose MSAA proxies
                                // that may activate the owner, so they keep the refusal.
                                if class.starts_with("windowsforms10.") && !["select", "expand", "collapse", "increment", "decrement"].contains(&requested.as_str()) {
                                    return Ok(failure("background_unavailable", "this WinForms target's InvokePattern may activate its owner; background delivery is not qualified"));
                                }
                                if self.element(a).is_none() { return Ok(failure("stale_reference", "target identity changed before delivery")); }
                                return Ok(match self.pattern_action(&element, &requested) {
                                    Ok(method) => json!({"method":method,"background":true}),
                                    Err(error) => error,
                                });
                            }
                            let parent = GetParent(hwnd)?;
                            let control = GetDlgCtrlID(hwnd);
                            let mut owner = 0; GetWindowThreadProcessId(hwnd, Some(&mut owner));
                            let mut parent_owner = 0; GetWindowThreadProcessId(parent, Some(&mut parent_owner));
                            if self.element(a).is_none() || owner == 0 || parent_owner != owner || element.CurrentProcessId()? as u32 != owner {
                                return Ok(failure("stale_reference", "target process or window identity changed before delivery"));
                            }
                            let toggle = [UIA_CheckBoxControlTypeId, UIA_RadioButtonControlTypeId].contains(&control_type);
                            if toggle && class.starts_with("windowsforms10.") {
                                // WinForms check boxes and radio buttons ignore a reflected BN_CLICKED.
                                // Their MSAA default action is an in-process click (ButtonBase.OnClick):
                                // no hit test, no activation, so it works while another window covers it.
                                if let Ok(legacy) = element.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
                                    if legacy.DoDefaultAction().is_ok() { return Ok(json!({"method":"UIA.LegacyIAccessible.DoDefaultAction","background":true})); }
                                }
                                // Fallback: a posted press/release at the control's center reaches only its
                                // thread (no cursor or focus move), but WinForms counts it only when the
                                // control is the window under that point.
                                let mut client = RECT::default();
                                GetClientRect(hwnd, &mut client)?;
                                let point = LPARAM((((client.bottom / 2) as u32 & 0xffff) << 16 | ((client.right / 2) as u32 & 0xffff)) as isize);
                                PostMessageW(Some(hwnd), WM_LBUTTONDOWN, WPARAM(0x0001), point)?;
                                PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0), point)?;
                                return Ok(json!({"method":"Win32.PostMessage.WM_LBUTTON","background":true}));
                            }
                            if toggle {
                                // A native check box toggles itself on a real click; set the next state,
                                // then send the same notification the click would.
                                let state = SendMessageW(hwnd, BM_GETCHECK, None, None).0;
                                let next = if control_type == UIA_RadioButtonControlTypeId { 1 } else if state == 1 { 0 } else { 1 };
                                SendMessageW(hwnd, BM_SETCHECK, Some(WPARAM(next)), None);
                            }
                            if SendMessageTimeoutW(parent, WM_COMMAND, WPARAM(control as usize & 0xffff),
                                LPARAM(hwnd.0 as isize), SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, None).0 == 0 {
                                return Ok(failure("timeout_unknown_outcome", "button notification timed out; observe before retrying"));
                            }
                            Ok(json!({"method":"Win32.WM_COMMAND.BN_CLICKED","background":true}))
                        } else {
                            if element.CurrentIsPassword()?.as_bool() && (verb == "text" || (verb == "value" && a["value"].is_null())) { return Ok(json!("•••")); }
                            if verb == "text" && a["mode"] == "selection" {
                                let pattern = match element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
                                    Ok(pattern) => pattern,
                                    Err(_) => {
                                        let selected = edit_selection(element.CurrentNativeWindowHandle()?, element.CurrentProcessId()? as u32);
                                        if self.element(a).is_none() { return Ok(failure("stale_reference", "target identity changed during selection read")); }
                                        return Ok(match selected { Ok(text) => json!(text), Err(error) => error });
                                    },
                                };
                                if pattern.SupportedTextSelection()? == SupportedTextSelection_None {
                                    return Ok(failure("unsupported_target", "target does not expose text selection"));
                                }
                                let ranges = pattern.GetSelection()?;
                                let selected = uia_text_ranges(&ranges);
                                if self.element(a).is_none() { return Ok(failure("stale_reference", "target identity changed during selection read")); }
                                return Ok(match selected { Ok(text) => json!(text), Err(error) => error });
                            }
                            if verb == "text" && a["mode"] == "visible" {
                                if let Some((start, end)) = element.CurrentNativeWindowHandle().ok().and_then(edit_visible_range) {
                                    let value = edit_text(element.CurrentNativeWindowHandle()?, element.CurrentProcessId()? as u32, false);
                                    if self.element(a).is_none() { return Ok(failure("stale_reference", "target identity changed during visible text read")); }
                                    return Ok(match value {
                                        Ok(text) => { let units: Vec<u16> = text.encode_utf16().collect(); let end = end.min(units.len()); let slice = String::from_utf16_lossy(&units[start.min(end)..end]); json!(slice.strip_suffix("\r\n").unwrap_or(&slice)) },
                                        Err(error) => error,
                                    });
                                }
                                // Match Mac AX visible mode: unavailable native ranges
                                // fall back to the full value. An actual empty range
                                // stays empty; resource limits never become fallback.
                                if let Ok(pattern) = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
                                    if let Ok(ranges) = pattern.GetVisibleRanges() {
                                        let visible = uia_text_ranges(&ranges);
                                        if self.element(a).is_none() { return Ok(failure("stale_reference", "target identity changed during visible text read")); }
                                        match visible {
                                            Ok(text) => return Ok(json!(text)),
                                            Err(error) if error["code"] == "resource_limit" => return Ok(error),
                                            Err(_) => {},
                                        }
                                    }
                                }
                                // Legacy edit ValuePattern can return a shortened
                                // string. Reuse the bounded native edit read so a
                                // full-value fallback cannot silently truncate.
                                let value = edit_text(element.CurrentNativeWindowHandle()?, element.CurrentProcessId()? as u32, false);
                                if self.element(a).is_none() { return Ok(failure("stale_reference", "target identity changed during visible text fallback")); }
                                match value {
                                    Ok(text) => return Ok(json!(text)),
                                    Err(error) if error["code"] == "unsupported_target" => {},
                                    Err(error) => return Ok(error),
                                }
                            }
                            let pattern = match element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                                Ok(pattern) => pattern,
                                Err(_) => {
                                    // WPF RichTextBox supplies TextPattern without
                                    // ValuePattern. Read its document only for the
                                    // full-text operation, never as a mutation.
                                    if verb == "text" && (a["mode"].is_null() || a["mode"] == "full") {
                                        if let Ok(text) = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
                                            let range = text.DocumentRange()?;
                                            let value = uia_text_range(&range);
                                            if self.element(a).is_none() { return Ok(failure("stale_reference", "target identity changed during full text read")); }
                                            return Ok(match value { Ok(text) => json!(text), Err(error) => error });
                                        }
                                    }
                                    // A missing pattern comes back as an empty error that reads "The operation
                                    // completed successfully"; say what the control lacks.
                                    let setting = verb == "type" || a["value"].is_string();
                                    return Ok(failure("unsupported_target", if setting { "this control has no settable text value; use action or act to press, toggle or select it; nothing was changed" } else { "this control has no text value" }));
                                },
                            };
                            let new_value = if verb == "type" { a["text"].as_str() } else { a["value"].as_str() };
                            if let Some(value) = new_value {
                                if value.contains('\0') { return Ok(failure("invalid_request", "embedded NUL is not supported by native text messages")); }
                                // UIA's WinForms ValuePattern focuses the Edit. Use
                                // the control's native text message instead; never
                                // silently fall back to a focus-changing pattern.
                                if pattern.CurrentIsReadOnly()?.as_bool() { return Ok(failure("permission_denied", "target is read-only")); }
                                let hwnd = element.CurrentNativeWindowHandle()?;
                                if !secret_control_ready(&element) {
                                    return Ok(failure("background_unavailable", "this target's ValuePattern may focus its owner; background text delivery is not qualified"));
                                }
                                let text: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
                                let mut owner = 0; GetWindowThreadProcessId(hwnd, Some(&mut owner));
                                if self.element(a).is_none() || owner == 0 || element.CurrentProcessId()? as u32 != owner {
                                    return Ok(failure("stale_reference", "target process or window identity changed before delivery"));
                                }
                                if a.get("expectedIdentity").is_some()&&!process.secret_identity().is_ok_and(|identity|crate::secret_target::matches(&a["expectedIdentity"],&identity)){
                                    return Ok(failure("stale_reference","native secret target changed immediately before delivery"));
                                }
                                if let Some(deadline)=self.auth_deadline{
                                    if let Err(error)=crate::authdialog::check_deadline(deadline){return Ok(error);}if let Err(error)=crate::authdialog::ordinary_desktop(){return Ok(error);}
                                    if !element.CurrentIsPassword().is_ok_and(|password|password.as_bool()){return Ok(failure("target_gone","authentication control is no longer a secure password field"));}
                                    let current=self.api.ElementFromHandle(GetAncestor(hwnd,GA_ROOT));
                                    if !matches!((&self.auth_window,current),(Some(expected),Ok(current))if self.api.CompareElements(expected,&current).is_ok_and(|same|same.as_bool())){return Ok(failure("target_gone","authentication field no longer belongs to its retained window"));}
                                    if let Err(error)=crate::authdialog::check_deadline(deadline){return Ok(error);}
                                }
                                if a.get("expectedIdentity").is_some()&&!self.grants.consume(a["secretBindingName"].as_str().unwrap(),a["ref"].as_str().unwrap(),a["secretLease"].as_str().unwrap(),&a["expectedIdentity"]){return Ok(failure("permission_denied","native credential grant was consumed, expired or changed"));}
                                if SendMessageTimeoutW(hwnd, WM_SETTEXT, WPARAM(0), LPARAM(text.as_ptr() as isize),
                                    SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, None).0 == 0 {
                                    return Ok(failure("timeout_unknown_outcome", "text notification timed out; observe before retrying"));
                                }
                                Ok(json!({"method":"Win32.WM_SETTEXT","background":true}))
                            }
                            else {
                                let value = pattern.CurrentValue()?;
                                if verb == "text" && a["mode"] == "visible" {
                                    if value.len() > 65536 { return Ok(failure("resource_limit", "full-value visible text fallback exceeds the read limit")); }
                                    let text = match String::from_utf16(&value) { Ok(text) => text, Err(_) => return Ok(failure("provider_failed", "full-value text fallback contains invalid UTF-16")) };
                                    if self.element(a).is_none() { return Ok(failure("stale_reference", "target identity changed during visible text fallback")); }
                                    Ok(json!(text))
                                } else { Ok(json!(value.to_string())) }
                            }
                        }
                    },
                    _ => Ok(failure("unsupported_operation", format!("Windows operation {verb} has not passed parity qualification"))),
                }
            })();
            let result=match result { Ok(v) if v.get("success").is_some() => v, Ok(v) => success(v), Err(e) if e.code().is_ok() => failure("unsupported_target", "the control does not support this operation (it exposes no matching UI Automation pattern)"), Err(e) => failure("unsupported_target", e) };
            if a.get("expectedIdentity").is_none() && ["click","type","action"].contains(&verb) && ["background_unavailable","unsupported_target"].iter().any(|code|result["code"]==*code) {
                if verb=="action" && a["action"].as_str().is_some_and(|name|!["press","AXPress","invoke"].contains(&name)){return result;}
                self.foreground_input(if verb=="action"{"click"}else{verb},a)
            }else{result}
        }
    }
}

#[cfg(test)] mod tests {
    #[test] fn property_callback_borrows_native_variant_without_freeing_caller_bstr(){
        let(observer,receiver)=crate::monitor::Observer::new("owned-variant".into(),json!({"mode":"all"}),&json!({}));
        let(events,_)=mpsc::sync_channel(1);
        let focus:IUIAutomationFocusChangedEventHandler=ObservationHandler{observer,events}.into();
        let callback:IUIAutomationPropertyChangedEventHandler=focus.cast().unwrap();
        for _ in 0..256{
            let value=windows::Win32::System::Variant::VARIANT::from("BORROWED-VARIANT-CANARY 🙂 文件");
            unsafe{callback.HandlePropertyChangedEvent(None,UIA_NamePropertyId,&value).unwrap();}
            assert_eq!(windows_core::BSTR::try_from(&value).unwrap().to_string(),"BORROWED-VARIANT-CANARY 🙂 文件");
            // Only the caller drops the value. The SDK's former callback
            // freed this BSTR first, then UIA freed its original again.
        }
        assert!(receiver.try_recv().is_err());
    }
    #[test] fn window_inventory_includes_visible_native_uia_roots() {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap(); }
        let result = (|| -> windows::core::Result<()> { unsafe {
            let api: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let children = api.GetRootElement()?.FindAll(TreeScope_Children, &api.CreateTrueCondition()?)?;
            let handles = (0..children.Length()?).filter_map(|i| children.GetElement(i).ok()?.CurrentNativeWindowHandle().ok()).collect::<Vec<_>>();
            let inventory = windows_for(&json!({}))?;
            let mut checked = 0;
            for hwnd in handles.into_iter().filter(|hwnd| !hwnd.is_invalid() && IsWindow(Some(*hwnd)).as_bool() && IsWindowVisible(*hwnd).as_bool()) {
                let mut cloaked = 0_u32;
                DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), std::mem::size_of_val(&cloaked) as u32)?;
                if cloaked != 0 {
                    assert!(!inventory.iter().any(|w| w.handle == hwnd), "cloaked native UIA desktop root {:?} must not be reported visible", hwnd);
                    continue;
                }
                checked += 1;
                assert!(inventory.iter().any(|w| w.handle == hwnd), "visible native UIA desktop root {:?} is absent", hwnd);
            }
            assert!(checked > 0, "native GUI test must observe a visible desktop root");
            Ok(())
        }})();
        unsafe { windows::Win32::System::Com::CoUninitialize(); }
        result.unwrap();
    }
    use super::*;
    #[test] fn native_edit_selection_checks_utf16_and_untrusted_offsets() {
        let text: Vec<u16> = "Before Selected 🙂 文件 After".encode_utf16().collect();
        assert_eq!(decode_edit_selection(7 | (21 << 16), &text).unwrap(), "Selected 🙂 文件");
        assert_eq!(decode_edit_selection(3 | (3 << 16), &text).unwrap(), "");
        for (packed, code) in [(u32::MAX, "resource_limit"), (7 | (40 << 16), "provider_failed"), (7 | (6 << 16), "provider_failed"), (16 | (17 << 16), "provider_failed")] {
            assert_eq!(decode_edit_selection(packed, &text).unwrap_err()["code"], code);
        }
    }
    #[test] fn retained_process_identity_rejects_exit() {
        let mut child = std::process::Command::new("powershell.exe").args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]).spawn().unwrap();
        let identity = Process::open(child.id());
        let was_alive = identity.as_ref().is_ok_and(Process::alive);
        child.kill().unwrap(); child.wait().unwrap();
        assert!(was_alive);
        assert!(!identity.unwrap().alive());
    }
}

// App lifecycle (activate/hide/unhide/quit) uses only window handles and the
// owning process, so it runs outside the UIA/COM worker. Launching a new app
// is `desktop open`, not here.
pub fn app_command(action: &Value) -> Value {
    if session() == "0" { return failure("no_interactive_session", "Windows native control requires the logged-in user's interactive session"); }
    let sub = action["subcommand"].as_str().unwrap_or("activate");
    if sub == "launch" { return launch_app_id(action); }
    if !matches!(sub, "activate" | "hide" | "unhide" | "quit") {
        return failure("invalid_request", format!("unsupported app subcommand: {}", sub.chars().take(64).collect::<String>()));
    }
    if action["app"].as_str().is_none_or(str::is_empty) && action["pid"].as_u64().is_none() {
        return failure("invalid_request", "app requires --app or --pid");
    }
    let windows = match windows_for(action) { Ok(w) => w, Err(e) => return failure("provider_failed", e) };
    let mut pids: Vec<u32> = Vec::new();
    for w in &windows { if !pids.contains(&w.pid) { pids.push(w.pid); } }
    if pids.is_empty() { return failure("unsupported_target", "no visible window matches the requested application"); }
    if pids.len() > 1 { return failure("target_ambiguous", "more than one application matches; pass --pid to disambiguate"); }
    let target = pids[0];
    let targeted: Vec<&Window> = windows.iter().filter(|w| w.pid == target).collect();
    unsafe { match sub {
        "activate" => {
            let primary = targeted.iter().max_by_key(|w| (w.rect.right - w.rect.left).max(0) as i64 * (w.rect.bottom - w.rect.top).max(0) as i64).unwrap();
            if IsIconic(primary.handle).as_bool() { let _ = ShowWindow(primary.handle, SW_RESTORE); }
            if !input::activate(primary.handle) {
                let mut refused = failure("restricted_by_os", "Windows refused app activation through the qualified same-desktop foreground path");
                refused["details"] = foreground_details();
                return refused;
            }
            success(json!({"subcommand":"activate","pid":target,"window":(primary.handle.0 as usize).to_string(),"accepted":true,"method":"SetForegroundWindow/bounded-thread-attachment"}))
        }
        "hide" => {
            let mut minimized = 0; for w in &targeted { if ShowWindow(w.handle, SW_MINIMIZE).as_bool() { minimized += 1; } }
            success(json!({"subcommand":"hide","pid":target,"windows":targeted.len(),"minimized":minimized,"method":"SW_MINIMIZE","note":"Windows has no app-level hide; top-level windows are minimized"}))
        }
        "unhide" => {
            let mut placements = Vec::with_capacity(targeted.len());
            for w in &targeted {
                let mut placement = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
                if let Err(error) = GetWindowPlacement(w.handle, &mut placement) { return failure("provider_failed", format!("Windows placement read failed: {error}")); }
                placement.showCmd = SW_SHOWNOACTIVATE.0 as u32;
                placements.push((w.handle, placement));
            }
            // SW_SHOWNOACTIVATE restores without activation (a plain window keeps the foreground where it was),
            // but some apps activate themselves when restored (Character Map does, on every restore). Only the
            // foreground process can block that (LockSetForegroundWindow), so the prior window is put back as
            // soon as it is seen, and the reply says it happened.
            let prior = GetForegroundWindow(); let started = Instant::now();
            for (window, placement) in &placements {
                if let Err(error) = SetWindowPlacement(*window, placement) { return failure("provider_failed", format!("Windows placement restore failed; observe before retrying: {error}")); }
            }
            let ours = |hwnd: HWND| { let mut owner = 0; GetWindowThreadProcessId(hwnd, Some(&mut owner)); owner == target };
            let mut restored_foreground = false; let mut held: Option<Duration> = None;
            if !prior.is_invalid() && !ours(prior) {
                let deadline = started + Duration::from_millis(600);
                while Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(5));
                    if ours(GetForegroundWindow()) {
                        // The hand-back passes through a moment with no foreground window; wait for it to land
                        // before calling it refused (refused was reported, then the window came back).
                        let back = IsWindow(Some(prior)).as_bool() && { let _ = input::activate(prior); let until = Instant::now() + Duration::from_millis(250);
                            loop { if GetForegroundWindow() == prior { break true; } if Instant::now() >= until { break false; } std::thread::sleep(Duration::from_millis(5)); } };
                        if !back {
                            let mut refused = failure("restricted_by_os", "the windows were restored, but the app took the foreground and Windows refused to give it back to the previous window");
                            refused["details"] = foreground_details(); refused["details"]["restored"] = json!(placements.len());
                            return refused;
                        }
                        restored_foreground = true; held = Some(started.elapsed());
                    }
                }
            }
            let mut reply = json!({"subcommand":"unhide","pid":target,"windows":targeted.len(),"restored":placements.len(),"method":"SetWindowPlacement/SW_SHOWNOACTIVATE","foregroundRestored":restored_foreground,"focusUnchanged":!restored_foreground});
            // An upper bound: the take happened somewhere between the restore and the moment it was seen.
            if let Some(held) = held { reply["note"] = json!(format!("the app activated itself when its window was restored; the previous window was put back {} ms after the restore, so the app held the foreground for at most that long. Windows lets only the foreground app block that", held.as_millis().max(1))); }
            success(reply)
        }
        "quit" => {
            for w in &targeted { let _ = PostMessageW(Some(w.handle), WM_CLOSE, WPARAM(0), LPARAM(0)); }
            let exited = match Process::open(target) {
                Ok(process) => { let deadline = Instant::now() + Duration::from_secs(5);
                    loop { if !process.alive() { break true; } if Instant::now() >= deadline { break false; } std::thread::sleep(Duration::from_millis(100)); } }
                Err(_) => true,
            };
            success(json!({"subcommand":"quit","pid":target,"windows":targeted.len(),"method":"WM_CLOSE","exited":exited,
                "note":if exited {"process exited"} else {"WM_CLOSE delivered; the application may be prompting before it closes"}}))
        }
        _ => unreachable!(),
    } }
}

/// The Windows meaning of a bundle id is the app id the Start menu uses (shell:AppsFolder):
/// a packaged AUMID such as `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`, or a desktop
/// app such as `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\charmap.exe`. Desktop apps open through
/// the background launch (`SW_SHOWNOACTIVATE`); packaged apps go through the activation manager,
/// which brings a newly started app forward the way a first launch on macOS can.
fn launch_app_id(action: &Value) -> Value {
    use windows::Win32::{System::Com::{CoTaskMemFree, COINIT_APARTMENTTHREADED, CLSCTX_LOCAL_SERVER}, Foundation::PROPERTYKEY, UI::Shell::*};
    let Some(id) = action["bundleId"].as_str().filter(|s| !s.trim().is_empty() && s.len() <= 1024 && !s.contains('\0')) else { return failure("invalid_request", "app launch requires an app id"); };
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    // A desktop app resolves to its executable; a packaged one stays an AUMID.
    let exe = (|| -> Option<std::path::PathBuf> {
        let path = std::path::Path::new(id);
        if path.is_absolute() { return Some(path.to_path_buf()); }
        if let Some(rest) = id.strip_prefix('{').and_then(|r| r.split_once("}\\")) {
            let guid = windows::core::GUID::try_from(rest.0).ok()?;
            let folder = unsafe { SHGetKnownFolderPath(&guid, KNOWN_FOLDER_FLAG(0), None) }.ok()?;
            let base = unsafe { folder.to_string() }.ok(); unsafe { CoTaskMemFree(Some(folder.0.cast())) };
            return Some(std::path::Path::new(&base?).join(rest.1));
        }
        // PKEY_Link_TargetParsingPath: the target of a Start-menu shortcut.
        const TARGET: PROPERTYKEY = PROPERTYKEY { fmtid: windows::core::GUID::from_u128(0xB9B4B3FC_2B51_4A42_B5D8_324146AFCF25), pid: 2 };
        let wide: Vec<u16> = format!("shell:AppsFolder\\{id}").encode_utf16().chain([0]).collect();
        let item: IShellItem2 = unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None) }.ok()?;
        let target = unsafe { item.GetString(&TARGET) }.ok()?;
        let text = unsafe { target.to_string() }.ok(); unsafe { CoTaskMemFree(Some(target.0.cast())) };
        text.map(std::path::PathBuf::from).filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")))
    })();
    if let Some(exe) = exe {
        if !exe.is_file() { return failure("target_gone", format!("app id {id} names an executable that is not installed")); }
        let mut result = dispatch("__launch", &json!({"type":"desktop_open","app":exe.to_string_lossy()}));
        if result["success"] == true { let d = &mut result["data"]; d["subcommand"] = json!("launch"); d["method"] = json!("CreateProcess/SW_SHOWNOACTIVATE"); d["appId"] = json!(id); d["path"] = json!(exe.to_string_lossy()); }
        return result;
    }
    if !id.contains('!') {
        let wide: Vec<u16> = format!("shell:AppsFolder\\{id}").encode_utf16().chain([0]).collect();
        return if unsafe { SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(wide.as_ptr()), None) }.is_ok() { failure("unsupported_target", format!("app id {id} has no executable or package target to launch")) }
            else { failure("target_gone", format!("no installed app uses the app id {id}")) };
    }
    // Already running: report it without activating (macOS answers "already running").
    if let Some(pid) = running_aumid(id) { return success(json!({"pid":pid,"subcommand":"launch","method":"ActivateApplication","launched":false,"appId":id})); }
    let manager: IApplicationActivationManager = match unsafe { CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER) } { Ok(m) => m, Err(e) => return failure("provider_failed", format!("Windows activation manager is unavailable: {e}")) };
    let wide: Vec<u16> = id.encode_utf16().chain([0]).collect();
    match unsafe { manager.ActivateApplication(PCWSTR(wide.as_ptr()), PCWSTR::null(), AO_NONE) } {
        Ok(pid) => success(json!({"pid":pid,"subcommand":"launch","method":"ActivateApplication","launched":true,"appId":id,"activated":true})),
        Err(e) if e.code().0 as u32 == 0x80270254 || e.code() == windows::Win32::Foundation::E_INVALIDARG => failure("target_gone", format!("no installed app uses the app id {id}")),
        Err(e) => failure("provider_failed", format!("Windows refused to activate {id}: {e}")),
    }
}
fn running_aumid(id: &str) -> Option<u32> {
    use windows::Win32::{Storage::Packaging::Appx::GetApplicationUserModelId, System::Diagnostics::ToolHelp::*};
    let snapshot = OwnedHandle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?);
    let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_ok();
    while more {
        if let Ok(process) = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.th32ProcessID) } {
            let process = OwnedHandle(process);
            let mut buffer = [0u16; 512]; let mut length = buffer.len() as u32;
            if unsafe { GetApplicationUserModelId(process.0, &mut length, Some(PWSTR(buffer.as_mut_ptr()))) }.is_ok()
                && String::from_utf16_lossy(&buffer[..length.saturating_sub(1) as usize]).eq_ignore_ascii_case(id) { return Some(entry.th32ProcessID); }
        }
        more = unsafe { Process32NextW(snapshot.0, &mut entry) }.is_ok();
    }
    None
}

pub fn capabilities() -> Value {
    let interactive = session() != "0";
    json!(["apps", "windows", "frontmost", "focused", "tree", "find", "inspect", "value", "text", "click", "type", "action", "resize", "move", "keys", "scroll", "drag", "menu", "app"].map(|operation|
        json!({"operation":operation,"compiled":true,"present":true,"permission":"not_applicable","session":session(),
            "effective":interactive,"background":if ["keys","scroll","drag"].contains(&operation){"window"}else if operation=="app"{"window"}else{"semantic"},"provider":"Windows.UIAutomation+Win32","versions":{"windows-crate":"0.62.2"},
            "limits":["UIA patterns must be exposed by the target", "same interactive session", "UIPI and protected desktops apply", "backgroundOnly selects an exact retained window-message route; no activation, HID input or keyboard-state mutation", "message acknowledgment requires separate observation of the app/page effect; Chromium shortcuts, mixed-DPI geometry and native focus/cursor behavior remain unqualified", "unresolved message sequence refuses background input for its retained process until confirmed native exit"],
            "reason":if interactive { "target pattern qualification required" } else { "no interactive session" }})))
}
