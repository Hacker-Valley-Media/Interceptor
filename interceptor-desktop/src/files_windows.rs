use crate::{contract_generated::*,failure,windows::{OwnedHandle,sid}};
use serde_json::{Value,json};
use std::{collections::BTreeSet,os::windows::ffi::OsStrExt,path::Path,time::Instant};
use windows::{core::PCWSTR,Win32::{Foundation::*,Storage::FileSystem::*,System::{Threading::*,IO::{OVERLAPPED,CancelIoEx,GetOverlappedResult},ProcessStatus::EnumProcesses,RemoteDesktop::ProcessIdToSessionId,Diagnostics::ProcessSnapshotting::*}}};

fn error(e:windows::core::Error)->Value{failure(if e.code()==ERROR_FILE_NOT_FOUND.to_hresult()||e.code()==ERROR_PATH_NOT_FOUND.to_hresult(){"target_gone"}else{"permission_denied"},format!("native file API refused (HRESULT {:08x})",e.code().0))}
fn held(path:&Path)->Result<OwnedHandle,Value>{
    let wide=path.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
    let handle=OwnedHandle(unsafe{CreateFileW(PCWSTR(wide.as_ptr()),FILE_READ_ATTRIBUTES.0,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,None,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,None)}.map_err(error)?);
    let info=information(handle.0)?;
    if info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT.0!=0{return Err(failure("unsupported_target","file watches do not follow Windows reparse points"));}
    Ok(handle)
}
fn information(handle:HANDLE)->Result<BY_HANDLE_FILE_INFORMATION,Value>{let mut info=BY_HANDLE_FILE_INFORMATION::default();unsafe{GetFileInformationByHandle(handle,&mut info)}.map_err(error)?;Ok(info)}
fn signature(handle:HANDLE,binding:bool)->Result<(u64,u64,u64,bool,bool),Value>{unsafe{
    let info=information(handle)?;let mut standard=FILE_STANDARD_INFO::default();let mut basic=FILE_BASIC_INFO::default();
    GetFileInformationByHandleEx(handle,FileStandardInfo,(&raw mut standard).cast(),std::mem::size_of::<FILE_STANDARD_INFO>()as u32).map_err(error)?;
    GetFileInformationByHandleEx(handle,FileBasicInfo,(&raw mut basic).cast(),std::mem::size_of::<FILE_BASIC_INFO>()as u32).map_err(error)?;
    Ok((basic.LastWriteTime as u64,basic.ChangeTime as u64,(info.nFileSizeHigh as u64)<<32|info.nFileSizeLow as u64,standard.DeletePending,binding))
}}
fn same(a:&BY_HANDLE_FILE_INFORMATION,b:&BY_HANDLE_FILE_INFORMATION)->bool{a.dwVolumeSerialNumber==b.dwVolumeSerialNumber&&a.nFileIndexHigh==b.nFileIndexHigh&&a.nFileIndexLow==b.nFileIndexLow}
struct Change(HANDLE);impl Drop for Change{fn drop(&mut self){unsafe{let _=FindCloseChangeNotification(self.0);}}}
struct FileChanges{directory:OwnedHandle,event:OwnedHandle,overlap:Box<OVERLAPPED>,buffer:Box<[u64;8192]>}
impl FileChanges{
    fn new(path:&Path)->Result<Self,Value>{unsafe{
        let wide=path.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
        let directory=OwnedHandle(CreateFileW(PCWSTR(wide.as_ptr()),FILE_LIST_DIRECTORY.0,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,None,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OVERLAPPED,None).map_err(error)?);
        let event=OwnedHandle(CreateEventW(None,true,false,None).map_err(error)?);
        let mut source=Self{directory,event,overlap:Box::new(OVERLAPPED::default()),buffer:Box::new([0;8192])};source.arm()?;Ok(source)
    }}
    fn arm(&mut self)->Result<(),Value>{unsafe{
        ResetEvent(self.event.0).map_err(error)?;*self.overlap=OVERLAPPED{hEvent:self.event.0,..Default::default()};
        ReadDirectoryChangesExW(self.directory.0,self.buffer.as_mut_ptr().cast(),65536,false,FILE_NOTIFY_CHANGE_FILE_NAME|FILE_NOTIFY_CHANGE_DIR_NAME|FILE_NOTIFY_CHANGE_SIZE|FILE_NOTIFY_CHANGE_LAST_WRITE,None,Some(&raw mut *self.overlap),None,ReadDirectoryNotifyExtendedInformation)
            .or_else(|e|if e.code()==ERROR_IO_PENDING.to_hresult(){Ok(())}else{Err(e)}).map_err(|e|if e.code()==ERROR_INVALID_FUNCTION.to_hresult(){failure("unsupported_target","this local filesystem does not support file-identity change records")}else{error(e)})
    }}
    fn poll(&mut self,file_id:u64)->Result<(bool,bool),Value>{unsafe{
        let ready=WaitForSingleObject(self.event.0,0);if ready==WAIT_FAILED{return Err(error(windows::core::Error::from_thread()));}if ready!=WAIT_OBJECT_0{return Ok((false,false));}
        let mut count=0;GetOverlappedResult(self.directory.0,&raw const *self.overlap,&mut count,false).map_err(error)?;
        if count==0||count>65536{return Err(failure("resource_limit","file notification buffer overflowed; watch cannot claim complete changes"));}
        let bytes=std::slice::from_raw_parts(self.buffer.as_ptr().cast::<u8>(),count as usize);
        let header=std::mem::offset_of!(FILE_NOTIFY_EXTENDED_INFORMATION,FileName);let id_offset=std::mem::offset_of!(FILE_NOTIFY_EXTENDED_INFORMATION,FileId);let name_offset=std::mem::offset_of!(FILE_NOTIFY_EXTENDED_INFORMATION,FileNameLength);
        let(mut offset,mut matching)=(0,false);
        loop{
            if bytes.len()-offset<header{return Err(failure("provider_failed","native file notification header is incomplete"));}
            let record=&bytes[offset..];let next=u32::from_le_bytes(record[..4].try_into().unwrap())as usize;
            let name=u32::from_le_bytes(record[name_offset..name_offset+4].try_into().unwrap())as usize;
            if name%2!=0||header+name>record.len(){return Err(failure("provider_failed","native file notification name is incomplete"));}
            matching|=u64::from_le_bytes(record[id_offset..id_offset+8].try_into().unwrap())==file_id;
            if next==0{break;}if next<header+name||next%4!=0||next>record.len(){return Err(failure("provider_failed","native file notification offset is invalid"));}offset+=next;
        }
        self.arm()?;Ok((true,matching))
    }}
}
impl Drop for FileChanges{fn drop(&mut self){unsafe{
    // Reuse the native pipe cancellation rule: owned buffer and OVERLAPPED
    // stay alive until the kernel acknowledges this exact request.
    let _=CancelIoEx(self.directory.0,Some(&raw const *self.overlap));let mut count=0;let _=GetOverlappedResult(self.directory.0,&raw const *self.overlap,&mut count,true);
}}}
enum Observation{Directory(Change),File(FileChanges)}
pub struct Watch{change:Observation,held:OwnedHandle,path:std::path::PathBuf,directory:bool,identity:BY_HANDLE_FILE_INFORMATION,last:(u64,u64,u64,bool,bool)}
// Only directory/file kernel handles cross threads, under the file-service
// mutex. No COM, window, or UI-thread object is shared by this watcher.
unsafe impl Send for Watch{}
impl Watch{
    pub fn new(path:&Path)->Result<Self,Value>{
        if path.to_string_lossy().starts_with("\\\\"){return Err(failure("unsupported_target","Windows watches require a local drive path"));}
        let target=held(path)?;let info=information(target.0)?;let directory=info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY.0!=0;
        let parent=if directory{path}else{path.parent().ok_or_else(||failure("invalid_request","watch target has no parent"))?};
        let change=if directory{
            let wide=parent.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
            Observation::Directory(Change(unsafe{FindFirstChangeNotificationW(PCWSTR(wide.as_ptr()),false,FILE_NOTIFY_CHANGE_FILE_NAME|FILE_NOTIFY_CHANGE_DIR_NAME|FILE_NOTIFY_CHANGE_SIZE|FILE_NOTIFY_CHANGE_LAST_WRITE)}.map_err(error)?))
        }else{Observation::File(FileChanges::new(parent)?)};
        let last=signature(target.0,true)?;
        Ok(Self{change,held:target,path:path.to_owned(),directory,identity:info,last})
    }
    pub fn poll(&mut self)->Result<bool,Value>{unsafe{
        let(signalled,notified)=match &mut self.change{
            Observation::Directory(change)=>{let ready=WaitForSingleObject(change.0,0);if ready==WAIT_FAILED{return Err(error(windows::core::Error::from_thread()));}let signalled=ready==WAIT_OBJECT_0;if signalled{FindNextChangeNotification(change.0).map_err(error)?;}(signalled,signalled)},
            Observation::File(change)=>change.poll((self.identity.nFileIndexHigh as u64)<<32|self.identity.nFileIndexLow as u64)?,
        };
        if self.directory{return Ok(signalled);}
        let binding=if signalled{held(&self.path).and_then(|handle|information(handle.0)).is_ok_and(|info|same(&info,&self.identity))}else{self.last.4};
        let current=signature(self.held.0,binding)?;let changed=notified||current!=self.last;self.last=current;Ok(changed)
    }}
}

struct Snapshot(HPSS);impl Drop for Snapshot{fn drop(&mut self){unsafe{PssFreeSnapshot(GetCurrentProcess(),self.0);}}}
struct Marker(HPSSWALK);impl Drop for Marker{fn drop(&mut self){unsafe{PssWalkMarkerFree(self.0);}}}
fn process(pid:u32)->Result<OwnedHandle,Value>{unsafe{
    let process=OwnedHandle(OpenProcess(PROCESS_QUERY_INFORMATION|PROCESS_DUP_HANDLE|PROCESS_SYNCHRONIZE,false,pid).map_err(|e|if e.code()==ERROR_INVALID_PARAMETER.to_hresult(){failure("target_gone","open file process is gone")}else{error(e)})?);
    let mut session=0;ProcessIdToSessionId(pid,&mut session).map_err(error)?;
    if sid(process.0).map_err(error)?!=sid(GetCurrentProcess()).map_err(error)?||session.to_string()!=crate::windows::session(){return Err(failure("permission_denied","open file target requires the current user and graphical login"));}
    if WaitForSingleObject(process.0,0)!=WAIT_TIMEOUT{return Err(failure("target_gone","open file process exited"));}Ok(process)
}}
pub fn inventory(action:&Value,deadline:Instant)->Result<Value,Value>{unsafe{
    if crate::windows::session()=="0"{return Err(failure("no_interactive_session","file inventory requires the current graphical Windows login"));}
    let exact=action["pid"].as_f64().map(|n|n as u32);let limit=action["limit"].as_f64().unwrap_or(DESKTOP_FILES_MAX_OPEN as f64)as usize;
    let mut pids=vec![0;DESKTOP_FILES_MAX_PROCESSES];let mut needed=0;
    if let Some(pid)=exact{pids=vec![pid];}else{EnumProcesses(pids.as_mut_ptr(),(pids.len()*4)as u32,&mut needed).map_err(error)?;pids.truncate((needed as usize/4).min(pids.len()));}
    let(mut processes,mut handles,mut skipped)=(0,0,0);let mut files=BTreeSet::new();
    for pid in pids{
        if pid==0{continue;}
        if Instant::now()>=deadline{return Err(failure("resource_limit","file inventory exceeded its deadline"));}
        let process=match process(pid){Ok(process)=>process,Err(error)=>{if exact.is_some(){return Err(error);}skipped+=1;continue;}};
        if limit==0{break;}
        let mut snapshot=HPSS::default();let code=PssCaptureSnapshot(process.0,PSS_CAPTURE_HANDLES|PSS_CAPTURE_HANDLE_NAME_INFORMATION|PSS_CAPTURE_HANDLE_BASIC_INFORMATION,None,&mut snapshot);
        if code!=0{if exact.is_some(){return Err(failure("permission_denied",format!("process handle snapshot refused (Win32 {code})")));}skipped+=1;continue;}
        let snapshot=Snapshot(snapshot);let mut marker=HPSSWALK::default();let code=PssWalkMarkerCreate(None,&mut marker);
        if code!=0{return Err(failure("provider_failed",format!("snapshot walk marker failed (Win32 {code})")));}let marker=Marker(marker);processes+=1;
        loop{
            if Instant::now()>=deadline{return Err(failure("resource_limit","file handle inventory exceeded its deadline"));}
            if handles==DESKTOP_FILES_MAX_HANDLES{break;}
            let mut entry=PSS_HANDLE_ENTRY::default();let bytes=std::slice::from_raw_parts_mut((&raw mut entry).cast(),std::mem::size_of::<PSS_HANDLE_ENTRY>());
            let code=PssWalkSnapshot(snapshot.0,PSS_WALK_HANDLES,marker.0,Some(bytes));if code==ERROR_NO_MORE_ITEMS.0{break;}if code!=0{return Err(failure("provider_failed",format!("snapshot handle walk failed (Win32 {code})")));}handles+=1;
            if entry.TypeName.is_null()||entry.TypeNameLength%2!=0{continue;}
            let kind=String::from_utf16_lossy(std::slice::from_raw_parts(entry.TypeName.0,entry.TypeNameLength as usize/2));if kind.trim_end_matches('\0')!="File"{continue;}
            let mut duplicate=HANDLE::default();if DuplicateHandle(process.0,entry.Handle,GetCurrentProcess(),&mut duplicate,0,false,DUPLICATE_SAME_ACCESS).is_err(){continue;}let duplicate=OwnedHandle(duplicate);
            if GetFileType(duplicate.0)!=FILE_TYPE_DISK{continue;}
            let mut buffer=vec![0;32768];let length=GetFinalPathNameByHandleW(duplicate.0,&mut buffer,GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0|VOLUME_NAME_DOS.0));
            if length==0||length as usize>=buffer.len(){continue;}let path=String::from_utf16_lossy(&buffer[..length as usize]);
            let path=path.strip_prefix("\\\\?\\").unwrap_or(&path);if Path::new(path).is_absolute()&&path.len()<=32768&&!path.contains('\0'){files.insert(path.to_owned());}
            if files.len()>=limit{break;}
        }
        if WaitForSingleObject(process.0,0)!=WAIT_TIMEOUT{return Err(failure("target_gone","file process creation exited during inventory; result discarded"));}
        if handles==DESKTOP_FILES_MAX_HANDLES||files.len()>=limit{break;}
    }
    let files=files.into_iter().take(limit).collect::<Vec<_>>();
    Ok(json!({"count":files.len(),"files":files,"partial":true,"scope":"current-user-login","processesInspected":processes,"handlesInspected":handles,"skippedProcesses":skipped,
        "reason":"PSS walks accessible current-login handles only; unnamed/non-disk handles, inaccessible processes and entries beyond requested limits are omitted"}))
}}
