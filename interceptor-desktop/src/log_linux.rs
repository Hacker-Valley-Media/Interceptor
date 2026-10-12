use crate::{failure,log::{Output,Query},contract_generated::DESKTOP_LOG_MAX_RESULT_BYTES};
use serde_json::{Value,json};
use std::{ffi::{c_char,c_int,c_void,CString},ptr};
use time::{OffsetDateTime,format_description::well_known::Rfc3339};

#[link(name="systemd")]
unsafe extern "C"{
    fn sd_journal_open(out:*mut *mut c_void,flags:c_int)->c_int;
    fn sd_journal_close(journal:*mut c_void);
    fn sd_journal_seek_realtime_usec(journal:*mut c_void,usec:u64)->c_int;
    fn sd_journal_next(journal:*mut c_void)->c_int;
    fn sd_journal_get_realtime_usec(journal:*mut c_void,out:*mut u64)->c_int;
    fn sd_journal_set_data_threshold(journal:*mut c_void,size:usize)->c_int;
    fn sd_journal_get_data(journal:*mut c_void,field:*const c_char,out:*mut *const c_void,size:*mut usize)->c_int;
}
struct Journal(*mut c_void);
impl Drop for Journal{fn drop(&mut self){unsafe{sd_journal_close(self.0)}}}
fn native_error(status:c_int)->Value{
    failure(if [-libc::EACCES,-libc::EPERM].contains(&status){"permission_denied"}else{"provider_failed"},format!("sd-journal read failed: {}",std::io::Error::from_raw_os_error(-status)))
}
fn open()->Result<Journal,Value>{
    let mut raw=ptr::null_mut();let status=unsafe{sd_journal_open(&mut raw,1)};
    if status<0{return Err(native_error(status));}if raw.is_null(){return Err(failure("provider_failed","sd-journal returned no store"));}
    let journal=Journal(raw);
    // Zero disables libsystemd's otherwise silent field truncation. Enforce the
    // returned length before copying, and never return a shortened message.
    let status=unsafe{sd_journal_set_data_threshold(raw,0)};
    if status<0{return Err(native_error(status));}Ok(journal)
}
fn field(journal:&Journal,name:&str)->Result<Option<String>,Value>{
    let name=CString::new(name).unwrap();let mut raw=ptr::null();let mut size=0;
    let status=unsafe{sd_journal_get_data(journal.0,name.as_ptr(),&mut raw,&mut size)};
    if status == -libc::ENOENT{return Ok(None);}if status<0{return Err(native_error(status));}
    let prefix=name.as_bytes().len()+1;
    if size>DESKTOP_LOG_MAX_RESULT_BYTES||size<prefix||raw.is_null(){return Err(failure("resource_limit","journal field exceeds 1 MiB or has an invalid size"));}
    let bytes=unsafe{std::slice::from_raw_parts(raw.cast::<u8>(),size)};
    if bytes.get(..prefix-1)!=Some(name.as_bytes())||bytes[prefix-1]!=b'='{return Err(failure("provider_failed","journal returned a mismatched field"));}
    // One binary or non-UTF-8 field must not fail the whole query; invalid bytes read as U+FFFD.
    Ok(Some(String::from_utf8_lossy(&bytes[prefix..]).into_owned()))
}
pub fn availability()->(&'static str,bool,&'static str,Option<&'static str>){
    match open(){Ok(_)=>("libsystemd/sd-journal",true,"granted",None),Err(error)if error["code"]=="permission_denied"=>("libsystemd/sd-journal",true,"denied",Some("current user cannot open the local journal")),Err(_)=>("libsystemd/sd-journal",false,"not_applicable",Some("local journal store unavailable"))}
}
pub fn query(query:&Query)->Result<Value,Value>{
    let journal=open()?;let usec=query.since.unix_timestamp_nanos()/1000;
    if usec<0{return Err(failure("invalid_request","journal since must be at or after the Unix epoch"));}
    let status=unsafe{sd_journal_seek_realtime_usec(journal.0,u64::try_from(usec).map_err(|_|failure("invalid_request","journal since is outside the native range"))?)};
    if status<0{return Err(native_error(status));}
    let mut output=Output::new();let mut scanned=0;
    loop{
        query.check_budget(scanned)?;let status=unsafe{sd_journal_next(journal.0)};
        if status<0{return Err(native_error(status));}if status==0{break;}scanned+=1;
        let mut realtime=0;let status=unsafe{sd_journal_get_realtime_usec(journal.0,&mut realtime)};
        if status<0{return Err(native_error(status));}
        let date=OffsetDateTime::from_unix_timestamp_nanos(i128::from(realtime)*1000).map_err(|_|failure("provider_failed","invalid journal timestamp"))?;
        if date<query.since{continue;}
        let priority=field(&journal,"PRIORITY")?.and_then(|value|value.parse::<u8>().ok());
        let level=match priority{Some(0..=2)=>"fault",Some(3)=>"error",Some(4..=5)=>"default",Some(6)=>"info",Some(7)=>"debug",_=>"undefined"};
        if level=="info"&&!query.request.includeInfo.unwrap_or(false)||level=="debug"&&!query.request.includeDebug.unwrap_or(false){continue;}
        let Some(message)=field(&journal,"MESSAGE")?else{continue;};
        let subsystem=field(&journal,"SYSLOG_IDENTIFIER")?.or(field(&journal,"_SYSTEMD_UNIT")?).unwrap_or_default();
        let category=field(&journal,"SYSLOG_FACILITY")?.unwrap_or_default();
        let process=field(&journal,"_COMM")?.unwrap_or_default();
        if [&subsystem,&category,&process].iter().any(|value|value.len()>4096){return Err(failure("resource_limit","journal metadata exceeds 4096 bytes"));}
        let entry=json!({"timestamp":date.format(&Rfc3339).map_err(|_|failure("provider_failed","cannot encode journal timestamp"))?,"message":message,"subsystem":subsystem,"category":category,"process":process,"level":level});
        if output.push(entry,query)?{break;}
    }
    Ok(output.finish())
}
