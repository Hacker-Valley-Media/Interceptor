use crate::failure;
use serde_json::Value;
use std::{ffi::{CStr,CString,c_void},path::Path};
pub(crate) fn pinned_spec(variable:&str)->Result<(std::path::PathBuf,String),Value>{
    let hash_variable=if variable=="INTERCEPTOR_PDFIUM_LIBRARY"{"INTERCEPTOR_PDFIUM_SHA256".to_owned()}else{format!("{variable}_SHA256")};
    match std::env::var(variable){
        Ok(path)=>{
            let path=crate::filesystem::absolute(&path)?;
            let expected=std::env::var(&hash_variable).unwrap_or_default();
            if expected.len()!=64||!expected.bytes().all(|b|b.is_ascii_hexdigit()){return Err(failure("invalid_request",format!("{variable} requires its explicit pinned SHA256")));}
            Ok((path,expected.to_ascii_lowercase()))
        },
        Err(std::env::VarError::NotUnicode(_))=>Err(failure("invalid_request","configured engine path is not Unicode")),
        Err(std::env::VarError::NotPresent)=>{
            if std::env::var_os(&hash_variable).is_some(){return Err(failure("invalid_request","an explicit engine hash requires its explicit path; bundled pins are never replaced"));}
            crate::engine_bundle::resolve(variable)
        }
    }
}
/// Whether a pinned engine resolves, decided once per provider process. Hello reports every
/// capability on every daemon command, and resolving a bundled engine hashes its whole file
/// closure; an upgrade restarts the provider. Actual use still verifies through pinned_spec.
pub(crate) fn engine_ready(variable:&str)->Result<(),Value>{
    static CACHE:std::sync::Mutex<std::collections::BTreeMap<String,Result<(),Value>>>=std::sync::Mutex::new(std::collections::BTreeMap::new());
    if let Some(known)=CACHE.lock().unwrap().get(variable){return known.clone();}
    let result=pinned_spec(variable).map(|_|());CACHE.lock().unwrap().insert(variable.to_owned(),result.clone());result
}
/// A pinned engine file streamed through its SHA256 before use, explicit override or bundled.
pub(crate) fn pinned_file(variable:&str,limit:u64)->Result<std::path::PathBuf,Value>{
    use sha2::{Digest,Sha256};use std::io::Read;
    let (path,expected)=pinned_spec(variable)?;
    #[cfg(unix)]let mut file={use std::os::unix::fs::OpenOptionsExt;std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK|libc::O_NOFOLLOW|libc::O_CLOEXEC).open(&path)}.map_err(|e|failure("not_installed",e))?;
    #[cfg(not(unix))]let mut file=std::fs::File::open(&path).map_err(|e|failure("not_installed",e))?;
    let metadata=file.metadata().map_err(|e|failure("provider_failed",e))?;if !metadata.is_file()||metadata.len()==0||metadata.len()>limit{return Err(failure("resource_limit",format!("{variable} must be a nonempty bounded regular file")));}
    let mut digest=Sha256::new();let mut buffer=[0u8;65536];let mut bytes=0u64;
    loop{let n=file.read(&mut buffer).map_err(|e|failure("provider_failed",e))?;if n==0{break;}bytes+=n as u64;if bytes>limit{return Err(failure("resource_limit",format!("{variable} grew beyond its bound")));}digest.update(&buffer[..n]);}
    if bytes!=metadata.len()||digest.finalize().iter().map(|b|format!("{b:02x}")).collect::<String>()!=expected.to_ascii_lowercase(){return Err(failure("version_mismatch",format!("{variable} bytes differ from the pinned SHA256")));}Ok(path)
}
pub(crate) fn pinned_bytes(variable:&str,limit:usize)->Result<(std::path::PathBuf,Vec<u8>),Value>{
    use sha2::{Digest,Sha256};
    let (path,expected)=pinned_spec(variable)?;
    let bytes=crate::thumbnail::source_bytes(&path)?;
    if bytes.len()>limit{return Err(failure("resource_limit","CPU backend input exceeds its byte bound"));}
    let actual=Sha256::digest(&bytes).iter().map(|b|format!("{b:02x}")).collect::<String>();
    if actual!=expected.to_ascii_lowercase(){return Err(failure("version_mismatch",format!("{variable} bytes differ from their pinned SHA256")));}
    Ok((path,bytes))
}
pub(crate) struct Library(*mut c_void);
impl Drop for Library{fn drop(&mut self){unsafe{
    #[cfg(unix)]{libc::dlclose(self.0);}
    #[cfg(windows)]{let _=windows::Win32::Foundation::FreeLibrary(windows::Win32::Foundation::HMODULE(self.0));}
}}}
impl Library{
    pub(crate) fn load(path:&Path)->Result<Self,Value>{
        if !path.is_absolute(){return Err(failure("invalid_request","native library requires an absolute path"));}
        #[cfg(unix)]unsafe{
            use std::os::unix::ffi::OsStrExt;
            let path=CString::new(path.as_os_str().as_bytes()).map_err(|_|failure("invalid_request","invalid native library path"))?;
            // NODELETE: GObject libraries (EDS, GeoClue) register types and keep D-Bus worker
            // threads; unmapping them at dlclose crashed helpers on exit after a complete reply.
            let raw=libc::dlopen(path.as_ptr(),libc::RTLD_NOW|libc::RTLD_LOCAL|libc::RTLD_NODELETE);
            if raw.is_null(){return Err(failure("not_installed","configured native library could not be loaded"));}Ok(Self(raw))
        }
        #[cfg(windows)]unsafe{
            use std::os::windows::ffi::OsStrExt;
            use windows::Win32::System::LibraryLoader::{LoadLibraryExW,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,LOAD_LIBRARY_SEARCH_DEFAULT_DIRS};
            let wide=path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
            LoadLibraryExW(windows::core::PCWSTR(wide.as_ptr()),None,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS).map(|h|Self(h.0)).map_err(|_|failure("not_installed","configured native library or its dependencies could not be loaded"))
        }
    }
    pub(crate) unsafe fn symbol(&self,name:&CStr)->Result<*mut c_void,Value>{
        #[cfg(unix)]let raw=unsafe{libc::dlsym(self.0,name.as_ptr())};
        #[cfg(windows)]let raw=unsafe{windows::Win32::System::LibraryLoader::GetProcAddress(windows::Win32::Foundation::HMODULE(self.0),windows::core::PCSTR(name.as_ptr().cast()))}.map_or(std::ptr::null_mut(),|p|p as *const () as *mut c_void);
        if raw.is_null(){Err(failure("version_mismatch",format!("native library is missing {}",name.to_string_lossy())))}else{Ok(raw)}
    }
}
/// A system library: the explicit absolute path in `variable`, or else the newest
/// `<stem>.so.<N>` in the distribution's library folders. Callers still check the ABI.
#[cfg(target_os="linux")]
pub(crate) fn system_library(variable:&str,stem:&str,package:&str)->Result<std::path::PathBuf,Value>{
    if let Ok(path)=std::env::var(variable){return crate::filesystem::absolute(&path);}
    let prefix=format!("{stem}.so.");
    for dir in ["/usr/lib","/usr/lib64","/usr/lib/aarch64-linux-gnu","/usr/lib/x86_64-linux-gnu","/lib/aarch64-linux-gnu","/lib/x86_64-linux-gnu"]{
        let Ok(entries)=std::fs::read_dir(dir)else{continue};
        let mut found=entries.flatten().filter_map(|e|{let name=e.file_name().to_string_lossy().into_owned();name.strip_prefix(&prefix).and_then(|v|v.parse::<u32>().ok()).map(|major|(major,e.path()))}).collect::<Vec<_>>();
        found.sort();if let Some((_,path))=found.pop(){return Ok(path);}
    }
    Err(failure("not_installed",format!("{stem} was not found; install {package} (or set {variable} to its absolute path)")))
}
