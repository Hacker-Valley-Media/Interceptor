use crate::{contract_generated::*,failure};
use serde_json::{Value,json};
use std::{collections::BTreeSet,ffi::CString,fs::{self,File},os::{fd::{AsRawFd,FromRawFd},unix::fs::MetadataExt},path::Path,time::Instant};

fn io_error(error:std::io::Error)->Value{failure(match error.kind(){std::io::ErrorKind::NotFound=>"target_gone",std::io::ErrorKind::PermissionDenied=>"permission_denied",_=>"provider_failed"},error)}
pub struct Watch{notify:File,_target:File}
impl Watch{
    pub fn new(path:&Path)->Result<Self,Value>{
        let text=CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_|failure("invalid_request","watch path contains NUL"))?;
        let fd=unsafe{libc::open(text.as_ptr(),libc::O_PATH|libc::O_CLOEXEC)};if fd<0{return Err(io_error(std::io::Error::last_os_error()));}
        let target=unsafe{File::from_raw_fd(fd)};let meta=target.metadata().map_err(io_error)?;
        if !meta.is_file()&&!meta.is_dir(){return Err(failure("unsupported_target","watch requires a regular file or directory"));}
        let fd=unsafe{libc::inotify_init1(libc::IN_CLOEXEC|libc::IN_NONBLOCK)};if fd<0{return Err(io_error(std::io::Error::last_os_error()));}
        let notify=unsafe{File::from_raw_fd(fd)};
        // /proc/self/fd binds the already retained inode, even if its pathname
        // changes between opening it and installing the inotify watch.
        let retained=CString::new(format!("/proc/self/fd/{}",target.as_raw_fd())).unwrap();
        let mask=libc::IN_MODIFY|libc::IN_ATTRIB|libc::IN_CLOSE_WRITE|libc::IN_CREATE|libc::IN_DELETE|libc::IN_MOVED_FROM|libc::IN_MOVED_TO|libc::IN_MOVE_SELF|libc::IN_DELETE_SELF;
        if unsafe{libc::inotify_add_watch(notify.as_raw_fd(),retained.as_ptr(),mask)}<0{return Err(io_error(std::io::Error::last_os_error()));}
        Ok(Self{notify,_target:target})
    }
    pub fn poll(&mut self)->Result<bool,Value>{
        let mut buffer=[0u8;16384];let count=unsafe{libc::read(self.notify.as_raw_fd(),buffer.as_mut_ptr().cast(),buffer.len())};
        if count<0{let error=std::io::Error::last_os_error();return if matches!(error.kind(),std::io::ErrorKind::WouldBlock|std::io::ErrorKind::Interrupted){Ok(false)}else{Err(io_error(error))};}
        let(mut offset,mut changed)=(0,false);
        while offset+std::mem::size_of::<libc::inotify_event>()<=count as usize{
            let entry=unsafe{std::ptr::read_unaligned(buffer.as_ptr().add(offset).cast::<libc::inotify_event>())};
            offset+=std::mem::size_of::<libc::inotify_event>()+entry.len as usize;
            if offset>count as usize{return Err(failure("provider_failed","inotify event exceeded its native buffer"));}
            if entry.mask&libc::IN_Q_OVERFLOW!=0{return Err(failure("partial_result","inotify queue overflowed; some changes were not observed; restart this provider"));}
            changed|=entry.mask&!libc::IN_IGNORED!=0;
        }
        if offset!=count as usize{return Err(failure("provider_failed","inotify returned a partial native event"));}
        Ok(changed)
    }
}

pub fn inventory(action:&Value,deadline:Instant)->Result<Value,Value>{
    if !crate::linux::graphical_login(){return Err(failure("no_interactive_session","file inventory requires the current graphical Linux login"));}
    let exact=action["pid"].as_f64().map(|n|n as u32);let limit=action["limit"].as_f64().unwrap_or(DESKTOP_FILES_MAX_OPEN as f64)as usize;
    let mut pids=Vec::new();let mut enumeration_cut=false;
    if let Some(pid)=exact{pids.push(pid);}else{
        for entry in fs::read_dir("/proc").map_err(io_error)?{
            if Instant::now()>=deadline{return Err(failure("resource_limit","file process enumeration exceeded its deadline"));}
            if let Ok(entry)=entry{if let Some(pid)=entry.file_name().to_str().and_then(|s|s.parse::<u32>().ok()){
                if pids.len()==DESKTOP_FILES_MAX_PROCESSES{enumeration_cut=true;break;}pids.push(pid);
            }}
        }
    }
    let(mut processes,mut handles,mut skipped)=(0,0,0);let mut files=BTreeSet::new();
    for pid in pids{
        if Instant::now()>=deadline{return Err(failure("resource_limit","file inventory exceeded its deadline"));}
        let identity=match crate::linux::capture_identity(pid){Ok(identity)=>identity,Err(error)=>{if exact.is_some(){return Err(error);}skipped+=1;continue;}};
        if !fs::metadata(format!("/proc/{pid}")).is_ok_and(|meta|meta.uid()==unsafe{libc::geteuid()}){
            if exact.is_some(){return Err(failure("permission_denied","open file target requires the current user"));}skipped+=1;continue;
        }
        if limit==0{break;}
        let entries=match fs::read_dir(format!("/proc/{pid}/fd")){Ok(entries)=>entries,Err(error)=>{if exact.is_some(){return Err(io_error(error));}skipped+=1;continue;}};
        if !identity.alive(){if exact.is_some(){return Err(failure("target_gone","file target exited before enumeration"));}skipped+=1;continue;}
        processes+=1;
        for entry in entries{
            if Instant::now()>=deadline{return Err(failure("resource_limit","file handle enumeration exceeded its deadline"));}
            if handles==DESKTOP_FILES_MAX_HANDLES{enumeration_cut=true;break;}
            handles+=1;
            if let Ok(entry)=entry{if let Ok(path)=fs::read_link(entry.path()){
                if let Some(text)=path.to_str(){if path.is_absolute()&&!text.ends_with(" (deleted)")&&!path.starts_with("/proc")&&!path.starts_with("/sys")&&!path.starts_with("/dev")&&text.len()<=32768&&!text.contains('\0'){files.insert(text.to_owned());}}
            }}
            if files.len()>=limit{enumeration_cut=true;break;}
        }
        if !identity.alive(){return Err(failure("target_gone","file process creation exited during enumeration; result discarded"));}
        if handles==DESKTOP_FILES_MAX_HANDLES||files.len()>=limit{break;}
    }
    let files=files.into_iter().take(limit).collect::<Vec<_>>();
    Ok(json!({"count":files.len(),"files":files,"partial":true,"scope":"current-user-login","processesInspected":processes,"handlesInspected":handles,"skippedProcesses":skipped,
        "reason":if enumeration_cut{"proc descriptor inventory reached its requested count or process/handle bound; mappings and inaccessible processes are omitted"}else{"proc reports accessible descriptors only; memory mappings and inaccessible processes are omitted"}}))
}
