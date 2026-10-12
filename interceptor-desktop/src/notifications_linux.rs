//! Freedesktop delivery in the retained graphical login. Scheduling is owned
//! state, not a notification-server queue or an exhaustive native history.
use crate::{contract_generated::*,failure,success,notifications_validation as validate};
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use std::{collections::{BTreeMap,BTreeSet},ffi::{CStr,CString,c_char,c_int,c_void},fs::{File,OpenOptions},io::{Read,Write,Seek,SeekFrom},os::{fd::AsRawFd,unix::fs::{MetadataExt,OpenOptionsExt}},path::PathBuf,ptr,sync::{OnceLock,Mutex,mpsc::{self,SyncSender},Arc,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};

type Raw=*mut c_void;
const STATE_BYTES:usize=4*1024*1024;
const CLOSED:&str="org.freedesktop.Notifications.NotificationClosed";
const INVOKED:&str="org.freedesktop.Notifications.ActionInvoked";
#[repr(C,align(8))]struct BusId{bytes:[u8;16]}
#[link(name="systemd")]unsafe extern "C"{
    fn sd_bus_open_user(out:*mut Raw)->c_int;
    fn sd_bus_unref(bus:Raw)->Raw;
    fn sd_bus_get_bus_id(bus:Raw,out:*mut BusId)->c_int;
    fn sd_bus_set_method_call_timeout(bus:Raw,usec:u64)->c_int;
    fn sd_bus_call_method(bus:Raw,destination:*const c_char,path:*const c_char,interface:*const c_char,member:*const c_char,error:Raw,reply:*mut Raw,types:*const c_char,...)->c_int;
    fn sd_bus_call(bus:Raw,message:Raw,usec:u64,error:Raw,reply:*mut Raw)->c_int;
    fn sd_bus_message_new_method_call(bus:Raw,out:*mut Raw,destination:*const c_char,path:*const c_char,interface:*const c_char,member:*const c_char)->c_int;
    fn sd_bus_message_unref(message:Raw)->Raw;
    fn sd_bus_message_append(message:Raw,types:*const c_char,...)->c_int;
    fn sd_bus_message_open_container(message:Raw,kind:c_char,contents:*const c_char)->c_int;
    fn sd_bus_message_close_container(message:Raw)->c_int;
    fn sd_bus_message_enter_container(message:Raw,kind:c_char,contents:*const c_char)->c_int;
    fn sd_bus_message_exit_container(message:Raw)->c_int;
    fn sd_bus_message_read(message:Raw,types:*const c_char,...)->c_int;
    fn sd_bus_add_match(bus:Raw,slot:*mut Raw,rule:*const c_char,callback:unsafe extern "C" fn(Raw,Raw,Raw)->c_int,userdata:Raw)->c_int;
    fn sd_bus_slot_unref(slot:Raw)->Raw;
    fn sd_bus_process(bus:Raw,out:*mut Raw)->c_int;
}
struct Bus(Raw);impl Drop for Bus{fn drop(&mut self){unsafe{sd_bus_unref(self.0);}}}
struct Message(Raw);impl Drop for Message{fn drop(&mut self){unsafe{sd_bus_message_unref(self.0);}}}
struct Slot(Raw);impl Drop for Slot{fn drop(&mut self){unsafe{sd_bus_slot_unref(self.0);}}}
fn check(code:c_int)->Result<c_int,String>{if code<0{Err(std::io::Error::from_raw_os_error(-code).to_string())}else{Ok(code)}}
fn text(value:&str)->CString{CString::new(value).expect("validated native notification string")}
fn stamp()->String{time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap()}
fn now()->i64{(time::OffsetDateTime::now_utc().unix_timestamp_nanos()/1_000_000)as i64}
fn date(milliseconds:i64)->String{time::OffsetDateTime::from_unix_timestamp_nanos(milliseconds as i128*1_000_000).unwrap().format(&time::format_description::well_known::Rfc3339).unwrap()}
fn namespace(action:&Value)->&str{action["namespace"].as_str().unwrap_or("default")}
fn key(namespace:&str,id:&str)->String{format!("{namespace}\0{id}")}
fn schedule_id(namespace:&str,id:&str)->String{format!("interceptor.notifications.schedule.v1.{namespace}.{id}")}
fn bounded(data:Value)->Value{let result=success(data);if serde_json::to_vec(&result).is_ok_and(|b|b.len()<=DESKTOP_NOTIFICATION_MAX_RESULT_BYTES){result}else{failure("resource_limit","notification result exceeds 1MiB")}}

#[derive(Clone,Serialize,Deserialize)]#[serde(deny_unknown_fields)]struct Scheduled{action:Value,entry:Value,next:i64}
#[derive(Clone,Serialize,Deserialize)]#[serde(deny_unknown_fields)]struct Accepted{namespace:String,entry:Value,id:u32,generation:String,active:bool,actions:BTreeSet<String>}
#[derive(Clone,Serialize,Deserialize)]#[serde(deny_unknown_fields)]struct State{
    version:u8,login:String,scheduled:BTreeMap<String,Scheduled>,accepted:BTreeMap<String,Accepted>,
    categories:BTreeMap<String,Value>,inflight:BTreeMap<String,Scheduled>,
}
impl State{fn empty(login:String)->Self{Self{version:2,login,scheduled:BTreeMap::new(),accepted:BTreeMap::new(),categories:BTreeMap::new(),inflight:BTreeMap::new()}}}
struct Storage{path:PathBuf,_lock:File,events:File}
fn private_file(path:&std::path::Path,create:bool)->std::io::Result<File>{
    let file=OpenOptions::new().read(true).write(create).create(create).mode(0o600).custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC).open(path)?;
    let meta=file.metadata()?;
    if !meta.is_file()||meta.uid()!=unsafe{libc::geteuid()}||meta.mode()&0o777!=0o600||meta.nlink()!=1{return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied,"notification state must be an owned private regular file"));}
    Ok(file)
}
impl Storage{
    fn open(login:String)->Result<(Self,State),String>{
        let(events,event_path)=crate::clipboard::event_file("notifications").map_err(|e|e.to_string())?;
        let path=event_path.with_extension("state.json");let lock=private_file(&event_path.with_extension("lock"),true).map_err(|e|e.to_string())?;
        if unsafe{libc::flock(lock.as_raw_fd(),libc::LOCK_EX|libc::LOCK_NB)}!=0{return Err("another provider owns the current login's notification queue".into());}
        let state=match private_file(&path,false){
            Ok(file)=>{if file.metadata().map_err(|e|e.to_string())?.len()>STATE_BYTES as u64{return Err("notification state exceeds 4MiB".into());}
                let mut bytes=Vec::new();file.take(STATE_BYTES as u64+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
                let mut state:State=serde_json::from_slice(&bytes).map_err(|_|"notification state is malformed; it was preserved")?;
                // Only the empty unreleased prototype state can migrate. Its
                // second-based schedules must never be read as milliseconds.
                if state.version==1&&state.scheduled.is_empty()&&state.accepted.is_empty()&&state.categories.is_empty()&&state.inflight.is_empty(){state.version=2;}
                validate_state(&state,&login)?;state},
            Err(e)if e.kind()==std::io::ErrorKind::NotFound=>State::empty(login),Err(e)=>return Err(e.to_string()),
        };Ok((Self{path,_lock:lock,events},state))
    }
    fn save(&self,state:&State)->Result<(),String>{
        let bytes=serde_json::to_vec(state).map_err(|e|e.to_string())?;
        if bytes.len()>STATE_BYTES{return Err("notification state exceeds 4MiB; no new effect was sent".into());}
        let temporary=self.path.with_extension("next");
        // Existing paths are checked before writing, including a leftover from
        // an interrupted atomic replacement. No symlinks or hard links.
        let mut file=private_file(&temporary,true).map_err(|e|e.to_string())?;
        file.set_len(0).map_err(|e|e.to_string())?;file.write_all(&bytes).map_err(|e|e.to_string())?;file.sync_all().map_err(|e|e.to_string())?;
        match std::fs::symlink_metadata(&self.path){Ok(_)=>{private_file(&self.path,false).map_err(|e|e.to_string())?;},Err(e)if e.kind()==std::io::ErrorKind::NotFound=>(),Err(e)=>return Err(e.to_string())}
        std::fs::rename(&temporary,&self.path).map_err(|e|e.to_string())?;
        File::open(self.path.parent().unwrap()).and_then(|dir|dir.sync_all()).map_err(|e|e.to_string())
    }
    fn event(&mut self,namespace:&str,event:&Value)->Result<(),String>{
        let mut bytes=serde_json::to_vec(&json!({"namespace":namespace,"event":event})).map_err(|e|e.to_string())?;bytes.push(b'\n');
        if self.events.metadata().map_err(|e|e.to_string())?.len()+bytes.len()as u64>STATE_BYTES as u64{self.events.set_len(0).map_err(|e|e.to_string())?;}
        self.events.seek(SeekFrom::End(0)).and_then(|_|self.events.write_all(&bytes)).map_err(|e|e.to_string())
    }
}
fn validate_state(state:&State,login:&str)->Result<(),String>{
    if state.version!=2||state.login!=login||state.scheduled.len()>1000||state.accepted.len()>1000||state.categories.len()>64||state.inflight.len()>1{return Err("notification state version/login/count is invalid; state was preserved".into());}
    for(k,s)in state.scheduled.iter().chain(&state.inflight){
        if desktop_notifications_shape_error(&s.action).is_some(){return Err("stored notification request shape is invalid".into());}
        let id=s.action["id"].as_str().ok_or("notification schedule identity is missing")?;
        if !validate::namespace(namespace(&s.action))||!validate::identifier(id)||k!=&key(namespace(&s.action),id)||time::OffsetDateTime::from_unix_timestamp_nanos(s.next as i128*1_000_000).is_err(){return Err("notification schedule identity/date is invalid".into());}
        let timing=match s.action["sub"].as_str(){Some("schedule-after")=>"seconds",Some("schedule-at")=>"date",Some("schedule-cron")=>"components",_=>return Err("stored notification operation is not a schedule".into())};
        let mut content=s.action.clone();content["sub"]=json!("post");for field in [timing,"repeats"]{content.as_object_mut().ok_or("notification schedule is not an object")?.remove(field);}
        validate::validate(&content).map_err(|_|"notification scheduled content is invalid")?;
        match s.action["sub"].as_str(){
            Some("schedule-after")=>{let seconds=s.action["seconds"].as_f64().ok_or("stored notification interval is missing")?;if seconds.fract()!=0.0||!(1.0..=DESKTOP_NOTIFICATION_MAX_SECONDS as f64).contains(&seconds)||s.action["repeats"]==true&&seconds<60.0{return Err("stored notification interval is invalid".into());}},
            Some("schedule-at")=>{let instant=s.action["date"].as_str().and_then(crate::log::timestamp).ok_or("stored notification instant is invalid")?;if s.action["repeats"]==true||instant.unix_timestamp_nanos()/1_000_000!=s.next as i128{return Err("stored one-time notification instant differs from its queue".into());}},
            Some("schedule-cron")=>{validate::components(s.action["components"].as_str().ok_or("stored notification calendar is missing")?)?;},
            _=>return Err("stored notification operation is not a schedule".into()),
        }
        let entry:DesktopNotificationEntry=serde_json::from_value(s.entry.clone()).map_err(|_|"notification scheduled receipt is malformed")?;
        if entry.identifier!=id||entry.nativeIdentifier!=schedule_id(namespace(&s.action),id)||entry.trigger.as_ref().is_none_or(|_|s.entry["trigger"]["type"]=="immediate")||s.entry["trigger"]["repeats"]!=json!(s.action["repeats"].as_bool().unwrap_or(s.action["sub"]=="schedule-cron"))||s.entry["trigger"]["nextTriggerDate"]!=date(s.next){return Err("notification scheduled receipt identity/trigger is invalid".into());}
        let trigger=&s.entry["trigger"];
        if timing=="seconds"&&(trigger["type"]!="timeInterval"||trigger["seconds"]!=s.action["seconds"]||trigger.get("components").is_some())||timing!="seconds"&&(trigger["type"]!="calendar"||trigger.get("seconds").is_some())||timing=="date"&&trigger.get("components").is_some()||timing=="components"&&trigger["components"]!=json!(validate::components(s.action["components"].as_str().unwrap())?){return Err("notification scheduled trigger differs from its validated request".into());}
        for(field,default)in [("title",""),("subtitle",""),("body",""),("categoryIdentifier",""),("userInfoJSON","{}")]{let source=match field{"categoryIdentifier"=>"category","userInfoJSON"=>"user_info",_=>field};if s.entry[field]!=s.action[source].as_str().unwrap_or(default){return Err("stored notification content differs from its validated request".into());}}
    }
    for(k,a)in &state.accepted{
        let entry:DesktopNotificationEntry=serde_json::from_value(a.entry.clone()).map_err(|_|"notification acceptance receipt is malformed")?;
        if !validate::namespace(&a.namespace)||!validate::identifier(&entry.identifier)||k!=&key(&a.namespace,&entry.identifier)||a.id==0||a.generation.len()>128||!a.generation.starts_with("fdo:")||entry.nativeIdentifier!=format!("{}:{}",a.generation,a.id)||a.actions.len()>8||a.actions.iter().any(|s|!validate::identifier(s)){return Err("notification acceptance identity is invalid".into());}
    }
    for(k,c)in &state.categories{
        let(ns,id)=k.split_once('\0').ok_or("notification category key is malformed")?;
        let row:DesktopNotificationCategory=serde_json::from_value(c.clone()).map_err(|_|"notification category is malformed")?;
        if !validate::namespace(ns)||!validate::identifier(id)||row.identifier!=id||row.options!=0.0||!row.intentIdentifiers.is_empty()||row.summaryFormat.is_some()||row.hiddenPlaceholder.is_some(){return Err("notification category identity/options are invalid".into());}
        let actions=validate::actions(&c["actions"].to_string())?;if actions.iter().any(|a|a.options.as_ref().is_some_and(|o|!o.is_empty())){return Err("stored notification actions request unsupported native options".into());}
    }
    Ok(())
}

// Native systemd calendar evaluation handles sparse dates, weekdays and DST.
// The child is owned, its output bounded, and its two-second deadline is fixed.
fn calendar(components:&BTreeMap<String,u16>,base:i64)->Result<i64,String>{
    let zone=std::fs::read_link("/etc/localtime").ok().and_then(|p|p.to_str().and_then(|s|s.split_once("zoneinfo/").map(|(_,s)|s.to_owned()))).ok_or("calendar scheduling requires an installed IANA timezone link")?;
    if zone.len()>128||!zone.bytes().all(|b|b.is_ascii_alphanumeric()||b"/_+-".contains(&b)){return Err("calendar timezone is invalid".into());}
    let executable=std::fs::metadata("/usr/bin/systemd-analyze").map_err(|e|e.to_string())?;
    if !executable.is_file()||executable.uid()!=0||executable.mode()&0o022!=0{return Err("systemd calendar executable must be root-owned and not writable by other users".into());}
    let part=|key:&str|components.get(key).map(u16::to_string).unwrap_or_else(||"*".into());
    let weekdays=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    let weekday=components.get("weekday").map(|n|format!("{} ",weekdays[*n as usize-1])).unwrap_or_default();
    let spec=format!("{weekday}{}-{}-{} {}:{}:{} {zone}",part("year"),part("month"),part("day"),part("hour"),part("minute"),part("second"));
    use std::process::{Command,Stdio};
    let mut child=crate::auth::AuthChild(Command::new("/usr/bin/systemd-analyze").args(["calendar","--iterations=1",&format!("--base-time=@{base}"),&spec]).env("LC_ALL","C").env("TZ","UTC").env("SYSTEMD_PAGER","cat").stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e|e.to_string())?);
    let deadline=Instant::now()+Duration::from_secs(2);let mut output=child.0.stdout.take().ok_or("calendar output unavailable")?;let mut bytes=Vec::new();
    loop{
        if Instant::now()>=deadline{return Err("calendar evaluation exceeded 2 seconds".into());}
        let mut block=[0u8;4096];match crate::auth::ready_read(&mut output,&mut block){
            Ok(0)=>break,Ok(count)=>{if bytes.len()+count>16384{return Err("calendar output exceeds 16384 bytes".into());}bytes.extend_from_slice(&block[..count]);},
            Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(10)),Err(e)=>return Err(e.to_string()),
        }
    }
    loop{match child.0.try_wait().map_err(|e|e.to_string())?{Some(status)if status.success()=>break,Some(_)=>return Err("native calendar expression was refused".into()),None if Instant::now()<deadline=>std::thread::sleep(Duration::from_millis(10)),_=>return Err("calendar helper did not exit within 2 seconds".into())}}
    let text=std::str::from_utf8(&bytes).map_err(|_|"calendar output is not UTF-8")?;
    let fields=text.lines().find_map(|line|line.trim().strip_prefix("Next elapse: ")).ok_or("calendar has no future occurrence")?.split_whitespace().collect::<Vec<_>>();
    if fields.len()!=4||fields[3]!="UTC"{return Err("calendar output has no exact UTC instant".into());}
    let next=crate::log::timestamp(&format!("{}T{}Z",fields[1],fields[2])).ok_or("calendar output date is invalid")?.unix_timestamp();
    if next<=base{return Err("calendar next occurrence is not in the future".into());}Ok(next)
}

#[derive(Default)]struct Signals{rows:Vec<(u32,String,Value)>,overflow:bool}
unsafe extern "C" fn closed(message:Raw,userdata:Raw,_error:Raw)->c_int{
    let(mut id,mut reason)=(0u32,0u32);if unsafe{sd_bus_message_read(message,c"uu".as_ptr(),&mut id,&mut reason)}<0{return 0;}
    let state=unsafe{&mut *userdata.cast::<Signals>()};if state.rows.len()==128{state.overflow=true;}else if id!=0&&(1..=4).contains(&reason){state.rows.push((id,CLOSED.into(),json!({"kind":"closed","reason":reason})));}1
}
unsafe extern "C" fn invoked(message:Raw,userdata:Raw,_error:Raw)->c_int{
    let(mut id,mut action)=(0u32,ptr::null::<c_char>());if unsafe{sd_bus_message_read(message,c"us".as_ptr(),&mut id,&mut action)}<0||action.is_null(){return 0;}
    let state=unsafe{&mut *userdata.cast::<Signals>()};if state.rows.len()==128{state.overflow=true;}else if let Ok(action)=unsafe{CStr::from_ptr(action)}.to_str(){if id!=0&&validate::identifier(action){state.rows.push((id,INVOKED.into(),json!({"kind":"activated","actionIdentifier":action})));}}1
}
struct Native{bus:Bus,owner:CString,generation:String,identity:crate::linux::CaptureIdentity,caps:BTreeSet<String>,signals:Box<Signals>,_slots:Vec<Slot>}
impl Drop for Native{fn drop(&mut self){self._slots.clear();}}
impl Native{
    fn owner(bus:Raw)->Result<CString,String>{unsafe{
        let mut reply=ptr::null_mut();check(sd_bus_call_method(bus,c"org.freedesktop.DBus".as_ptr(),c"/org/freedesktop/DBus".as_ptr(),c"org.freedesktop.DBus".as_ptr(),c"GetNameOwner".as_ptr(),ptr::null_mut(),&mut reply,c"s".as_ptr(),c"org.freedesktop.Notifications".as_ptr()))?;
        let reply=Message(reply);let mut name=ptr::null::<c_char>();check(sd_bus_message_read(reply.0,c"s".as_ptr(),&mut name))?;
        if name.is_null(){return Err("notification service owner is missing".into());}let name=CStr::from_ptr(name);
        if !name.to_bytes().starts_with(b":")||name.to_bytes().len()>64{return Err("notification service owner is not a bounded unique name".into());}Ok(name.to_owned())
    }}
    fn open()->Result<Self,String>{unsafe{
        let mut raw=ptr::null_mut();check(sd_bus_open_user(&mut raw))?;let bus=Bus(raw);check(sd_bus_set_method_call_timeout(bus.0,1_000_000))?;
        let owner=Self::owner(bus.0)?;let mut bus_id=BusId{bytes:[0;16]};check(sd_bus_get_bus_id(bus.0,&mut bus_id))?;
        let generation=format!("fdo:{}:{}",bus_id.bytes.iter().map(|b|format!("{b:02x}")).collect::<String>(),owner.to_str().map_err(|_|"invalid native owner")?);
        let mut reply=ptr::null_mut();check(sd_bus_call_method(bus.0,c"org.freedesktop.DBus".as_ptr(),c"/org/freedesktop/DBus".as_ptr(),c"org.freedesktop.DBus".as_ptr(),c"GetConnectionUnixProcessID".as_ptr(),ptr::null_mut(),&mut reply,c"s".as_ptr(),owner.as_ptr()))?;
        let reply=Message(reply);let mut pid=0u32;check(sd_bus_message_read(reply.0,c"u".as_ptr(),&mut pid))?;
        let identity=crate::linux::capture_identity(pid).map_err(|_|"notification server must belong to the retained graphical login")?;
        let mut reply=ptr::null_mut();check(sd_bus_call_method(bus.0,owner.as_ptr(),c"/org/freedesktop/Notifications".as_ptr(),c"org.freedesktop.Notifications".as_ptr(),c"GetCapabilities".as_ptr(),ptr::null_mut(),&mut reply,c"".as_ptr()))?;
        let reply=Message(reply);check(sd_bus_message_enter_container(reply.0,b'a' as c_char,c"s".as_ptr()))?;let mut caps=BTreeSet::new();
        loop{let mut item=ptr::null::<c_char>();if check(sd_bus_message_read(reply.0,c"s".as_ptr(),&mut item))?==0{break;}if item.is_null()||caps.len()>=64{return Err("native capability inventory exceeds its bound".into());}
            let value=CStr::from_ptr(item).to_str().map_err(|_|"native capability is not UTF-8")?;if value.len()>128{return Err("native capability exceeds 128 bytes".into());}caps.insert(value.into());}
        check(sd_bus_message_exit_container(reply.0))?;
        let mut signals=Box::<Signals>::default();let mut slots=Vec::new();
        for(member,callback)in [("NotificationClosed",closed as unsafe extern "C" fn(Raw,Raw,Raw)->c_int),("ActionInvoked",invoked)]{
            let rule=text(&format!("type='signal',sender='{}',path='/org/freedesktop/Notifications',interface='org.freedesktop.Notifications',member='{member}'",owner.to_str().unwrap()));let mut slot=ptr::null_mut();
            check(sd_bus_add_match(bus.0,&mut slot,rule.as_ptr(),callback,(&mut *signals as *mut Signals).cast()))?;slots.push(Slot(slot));
        }
        Ok(Self{bus,owner,generation,identity,caps,signals,_slots:slots})
    }}
    fn current(&self)->Result<(),String>{if !self.identity.alive()||Self::owner(self.bus.0)?!=self.owner{Err("notification server generation changed; restart the provider before sending or closing notifications".into())}else{Ok(())}}
    fn poll(&mut self)->Result<Vec<(u32,String,Value)>,String>{
        for _ in 0..64{if check(unsafe{sd_bus_process(self.bus.0,ptr::null_mut())})?==0{break;}}
        if self.signals.overflow{return Err("notification signal queue overflowed; acceptance history is incomplete; restart the provider".into());}
        Ok(std::mem::take(&mut self.signals.rows))
    }
    fn close(&self,id:u32)->Result<(),String>{self.current()?;unsafe{
        let mut reply=ptr::null_mut();let result=sd_bus_call_method(self.bus.0,self.owner.as_ptr(),c"/org/freedesktop/Notifications".as_ptr(),c"org.freedesktop.Notifications".as_ptr(),c"CloseNotification".as_ptr(),ptr::null_mut(),&mut reply,c"u".as_ptr(),id);let _reply=Message(reply);check(result)?;Ok(())
    }}
    fn notify(&self,entry:&Value,actions:&[Value],replace:u32)->Result<u32,String>{self.current()?;unsafe{
        let mut raw=ptr::null_mut();check(sd_bus_message_new_method_call(self.bus.0,&mut raw,self.owner.as_ptr(),c"/org/freedesktop/Notifications".as_ptr(),c"org.freedesktop.Notifications".as_ptr(),c"Notify".as_ptr()))?;let message=Message(raw);
        let title=text(entry["title"].as_str().unwrap());let mut body=entry["body"].as_str().unwrap().to_owned();let subtitle=entry["subtitle"].as_str().unwrap();if !subtitle.is_empty(){body=format!("{subtitle}\n{body}");}
        if self.caps.contains("body-markup"){body=body.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;");}let body=text(&body);
        let icon=text(entry["attachments"].as_array().unwrap().first().and_then(|a|a["url"].as_str()).unwrap_or(""));
        check(sd_bus_message_append(message.0,c"susss".as_ptr(),c"Interceptor".as_ptr(),replace,icon.as_ptr(),title.as_ptr(),body.as_ptr()))?;
        check(sd_bus_message_open_container(message.0,b'a' as c_char,c"s".as_ptr()))?;
        for action in actions{let id=text(action["identifier"].as_str().unwrap());let title=text(action["title"].as_str().unwrap());check(sd_bus_message_append(message.0,c"ss".as_ptr(),id.as_ptr(),title.as_ptr()))?;}
        check(sd_bus_message_close_container(message.0))?;check(sd_bus_message_open_container(message.0,b'a' as c_char,c"{sv}".as_ptr()))?;
        for(key,value)in [("category",entry["categoryIdentifier"].as_str().unwrap_or("")),("sound-name",entry["sound"].as_str().unwrap_or(""))]{if !value.is_empty(){let key=text(key);let value=text(value);check(sd_bus_message_open_container(message.0,b'e' as c_char,c"sv".as_ptr()))?;check(sd_bus_message_append(message.0,c"s".as_ptr(),key.as_ptr()))?;check(sd_bus_message_open_container(message.0,b'v' as c_char,c"s".as_ptr()))?;check(sd_bus_message_append(message.0,c"s".as_ptr(),value.as_ptr()))?;check(sd_bus_message_close_container(message.0))?;check(sd_bus_message_close_container(message.0))?;}}
        if self.caps.contains("persistence"){check(sd_bus_message_open_container(message.0,b'e' as c_char,c"sv".as_ptr()))?;check(sd_bus_message_append(message.0,c"s".as_ptr(),c"resident".as_ptr()))?;check(sd_bus_message_open_container(message.0,b'v' as c_char,c"b".as_ptr()))?;check(sd_bus_message_append(message.0,c"b".as_ptr(),1i32))?;check(sd_bus_message_close_container(message.0))?;check(sd_bus_message_close_container(message.0))?;}
        check(sd_bus_message_close_container(message.0))?;check(sd_bus_message_append(message.0,c"i".as_ptr(),0i32))?;
        let mut reply=ptr::null_mut();let called=sd_bus_call(self.bus.0,message.0,1_000_000,ptr::null_mut(),&mut reply);let reply=Message(reply);check(called)?;let mut id=0u32;check(sd_bus_message_read(reply.0,c"u".as_ptr(),&mut id))?;
        if id==0||replace!=0&&id!=replace{return Err("native Notify returned an invalid/reassigned ID; acceptance outcome is unknown".into());}Ok(id)
    }}
}

fn content(action:&Value,native:&Native,state:&State)->Result<(Value,Vec<Value>),Value>{
    for field in ["badge","thread","interruption"]{if action.get(field).is_some(){return Err(failure("unsupported_operation",format!("Freedesktop notifications do not support the requested {field} contract")));}}
    if action["sound"].is_string()&&!native.caps.contains("sound"){return Err(failure("unsupported_operation","notification server does not advertise sound"));}
    if (!action["body"].as_str().unwrap_or("").is_empty()||!action["subtitle"].as_str().unwrap_or("").is_empty())&&!native.caps.contains("body"){return Err(failure("unsupported_operation","notification server does not advertise body text"));}
    let category=action["category"].as_str().unwrap_or("");let actions=if category.is_empty(){Vec::new()}else{state.categories.get(&key(namespace(action),category)).ok_or_else(||failure("target_gone","notification category is not registered in the selected namespace"))?["actions"].as_array().unwrap().clone()};
    if !actions.is_empty()&&!native.caps.contains("actions"){return Err(failure("unsupported_operation","notification server does not advertise actions"));}
    let mut attachments=Vec::new();
    if let Some(raw)=action["attachment"].as_str(){
        let parts=raw.split(',').collect::<Vec<_>>();if parts.len()!=1||!native.caps.contains("icon-static"){return Err(failure("unsupported_operation","this native server supports one static notification image only"));}
        let parts=parts[0].split('=').collect::<Vec<_>>();let path=parts.last().unwrap();let id=if parts.len()==2{parts[0]}else{"image"};
        let file=OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC).open(path).map_err(|_|failure("target_gone","notification image requires an accessible regular file without a symlink"))?;
        let meta=file.metadata().map_err(|_|failure("provider_failed","notification image metadata is unavailable"))?;
        if !meta.is_file()||meta.len()>16*1024*1024{return Err(failure("invalid_request","notification image requires a regular file of at most 16MiB"));}
        let mut bytes=Vec::new();file.take(16*1024*1024+1).read_to_end(&mut bytes).map_err(|_|failure("provider_failed","notification image could not be read"))?;
        if bytes.len()>16*1024*1024{return Err(failure("resource_limit","notification image grew beyond 16MiB"));}
        let image=image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format().map_err(|_|failure("invalid_request","notification attachment is not a supported image"))?;
        let(width,height)=image.into_dimensions().map_err(|_|failure("invalid_request","notification attachment has no valid image dimensions"))?;
        crate::capture::pixel_size(width,height)?;
        let mut image=image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format().map_err(|_|failure("invalid_request","notification attachment is not a supported image"))?;
        let mut limits=image::Limits::default();limits.max_image_width=Some(width);limits.max_image_height=Some(height);limits.max_alloc=Some(160*1024*1024);image.limits(limits);
        image.decode().map_err(|_|failure("invalid_request","notification image is invalid or exceeds decoder limits"))?;
        let url=format!("file://{}",path.bytes().map(|b|if b.is_ascii_alphanumeric()||b"/-._~".contains(&b){(b as char).to_string()}else{format!("%{b:02X}")}).collect::<String>());
        attachments.push(json!({"identifier":id,"url":url,"type":null}));
    }
    let id=action["id"].as_str().map(str::to_owned).unwrap_or_else(||format!("{}-{}",std::process::id(),time::OffsetDateTime::now_utc().unix_timestamp_nanos()));
    let entry=json!({"identifier":id,"nativeIdentifier":schedule_id(namespace(action),&id),"title":action["title"].as_str().unwrap_or(""),"subtitle":action["subtitle"].as_str().unwrap_or(""),"body":action["body"].as_str().unwrap_or(""),"categoryIdentifier":category,"threadIdentifier":"","userInfoJSON":action["user_info"].as_str().unwrap_or("{}"),"sound":action["sound"].as_str(),"attachments":attachments});
    Ok((entry,actions))
}
struct Worker{native:Native,storage:Storage,state:State,login:crate::linux_peer::SessionIdentity,subscriptions:BTreeSet<String>,history:Vec<(String,Value)>,retired:BTreeMap<u32,Accepted>,error:Option<String>}
impl Worker{
    fn event(&mut self,ns:&str,mut event:Value){event["timestamp"]=json!(stamp());event["truncated"]=json!(false);if let Err(error)=self.storage.event(ns,&event){self.error=Some(error);}self.history.push((ns.into(),event));while self.history.len()>1000||serde_json::to_vec(&self.history).is_ok_and(|b|b.len()>DESKTOP_NOTIFICATION_MAX_RESULT_BYTES){self.history.remove(0);}}
    fn commit(&mut self,state:State)->Result<(),Value>{self.storage.save(&state).map_err(|e|failure("provider_failed",e))?;self.state=state;Ok(())}
    fn receipt(entry:&Value)->Value{json!({"ok":true,"identifier":entry["identifier"],"nativeIdentifier":entry["nativeIdentifier"],"trigger":entry["trigger"],"categoryIdentifier":entry["categoryIdentifier"]})}
    fn ready(&self)->Result<(),Value>{if crate::linux::login_identity(0).as_ref()!=Some(&self.login)||!crate::linux::graphical_login(){return Err(failure("permission_denied","notification graphical login changed; no action was sent"));}if let Some(e)=&self.error{return Err(failure("provider_failed",e));}self.native.current().map_err(|e|failure("target_gone",e))}
    fn accept(&mut self,ns:&str,mut entry:Value,actions:&[Value])->Result<Value,Value>{
        self.ready()?;let id=entry["identifier"].as_str().unwrap().to_owned();let k=key(ns,&id);let prior=self.state.accepted.get(&k);
        if prior.is_some_and(|a|a.active&&a.generation!=self.native.generation){return Err(failure("target_gone","owned notification ID belongs to an older native server generation"));}
        if prior.is_none()&&self.state.accepted.len()>=1000{return Err(failure("resource_limit","owned notification acceptance inventory has 1000 entries; dismiss owned entries first"));}
        let replace=prior.filter(|a|a.active).map(|a|a.id).unwrap_or(0);
        // Reserve the serialized receipt budget before the native effect.
        let mut proposed=self.state.clone();let mut reservation=entry.clone();reservation["nativeIdentifier"]=json!(format!("{}:{}",self.native.generation,u32::MAX));reservation["deliveryDate"]=json!(stamp());
        let action_ids=actions.iter().map(|a|a["identifier"].as_str().unwrap().to_owned()).collect();
        proposed.accepted.insert(k.clone(),Accepted{namespace:ns.into(),entry:reservation,id:u32::MAX,generation:self.native.generation.clone(),active:true,actions:action_ids});
        if !serde_json::to_vec(&proposed).is_ok_and(|b|b.len()<=STATE_BYTES){return Err(failure("resource_limit","notification state has no receipt capacity; no effect was sent"));}
        let native_id=self.native.notify(&entry,actions,replace).map_err(|e|failure("provider_failed",format!("native acceptance outcome may be unknown: {e}; inspect before retrying")))?;
        if self.state.accepted.iter().any(|(other,a)|other!=&k&&a.active&&a.generation==self.native.generation&&a.id==native_id){return Err(failure("provider_failed","native notification ID collided with another owned notification; receipt was not rebound"));}
        entry["nativeIdentifier"]=json!(format!("{}:{native_id}",self.native.generation));entry["deliveryDate"]=json!(stamp());
        let accepted=proposed.accepted.get_mut(&k).unwrap();accepted.id=native_id;accepted.entry=entry.clone();
        if let Err(e)=self.commit(proposed){self.error=Some("native notification was accepted but its receipt could not be persisted; restart and inspect before retrying".into());return Err(e);}
        self.event(ns,json!({"kind":"accepted","identifier":id}));Ok(entry)
    }
    fn dispatch(&mut self,action:&Value)->Value{
        if let Err(e)=self.ready(){return e;}let ns=namespace(action);let sub=action["sub"].as_str().unwrap();
        let result=(||->Result<Value,Value>{match sub{
            "status"|"settings"=>Ok(json!({"status":"unknown","settings":{"alert":"unknown","sound":if self.native.caps.contains("sound"){"unknown"}else{"notSupported"},"badge":"notSupported","lockScreen":"unknown","notificationCenter":"unknown","criticalAlert":"notSupported"},"provider":"freedesktop-session-bus","scope":"application","namespace":ns,"nativeSetting":"The native protocol exposes capabilities, not authorization settings"})),
            // Freedesktop servers never prompt; a running server (ready() above) is the permission.
            "request"=>Ok(json!({"granted":true,"authorizationStatus":"authorized","perFeatureSettingsEnabled":false,"options":action["options"].as_str().unwrap_or("alert,sound,badge").split(',').map(str::trim).filter(|s|!s.is_empty()).collect::<Vec<_>>(),"error":Value::Null})),
            "badge"=>Err(failure("unsupported_operation","the Freedesktop notification protocol has no application badge API")),
            "tail"|"untail"=>{let name=action["name"].as_str().unwrap();if ![CLOSED,INVOKED].contains(&name){return Err(failure("unsupported_operation","Linux observes the exact org.freedesktop.Notifications.NotificationClosed or ActionInvoked name, for owned IDs only"));}
                let k=key(ns,name);if sub=="tail"{if !self.subscriptions.contains(&k)&&self.subscriptions.len()>=32{return Err(failure("resource_limit","notification subscriptions reached 32"));}self.subscriptions.insert(k);Ok(json!({"tailing":true,"name":name}))}else{Ok(json!({"tailing":false,"name":name,"removed":self.subscriptions.remove(&k)}))}},
            "log"=>{if action.get("app").is_some(){return Err(failure("unsupported_operation","Linux owned notification events have no native application-name filter"));}let limit=action["limit"].as_f64().unwrap_or(50.0)as usize;let rows=self.history.iter().filter(|(owner,_)|owner==ns).map(|(_,event)|event).collect::<Vec<_>>();Ok(json!({"entries":rows.iter().skip(rows.len().saturating_sub(limit)).collect::<Vec<_>>(),"namespace":ns,"coverage":"owned-events"}))},
            "pending"|"delivered"=>{let limit=action["limit"].as_f64().unwrap_or(100.0)as usize;let rows=if sub=="pending"{self.state.scheduled.values().filter(|s|namespace(&s.action)==ns).map(|s|s.entry.clone()).take(limit).collect::<Vec<_>>()}else{self.state.accepted.values().filter(|a|a.namespace==ns).map(|a|a.entry.clone()).take(limit).collect::<Vec<_>>()};Ok(json!({"entries":rows,"namespace":ns,"coverage":if sub=="pending"{"owned-scheduled"}else{"owned-accepted"},"partial":true}))},
            "categories"=>{let verb=action["verb"].as_str().unwrap_or("list");let mut proposed=self.state.clone();if verb=="list"{return Ok(json!({"categories":proposed.categories.iter().filter(|(k,_)|k.starts_with(&format!("{ns}\0"))).map(|(_,c)|c).collect::<Vec<_>>(),"namespace":ns}));}
                if verb=="clear"{proposed.categories.retain(|k,_|!k.starts_with(&format!("{ns}\0")));self.commit(proposed)?;return Ok(json!({"ok":true,"remaining":0}));}
                for field in ["intent_identifiers","summary_format","hidden_placeholder"]{if action.get(field).is_some(){return Err(failure("unsupported_operation",format!("Linux notification categories have no native {field} equivalent")));}}
                let id=action["identifier"].as_str().unwrap();let actions=validate::actions(action["actions"].as_str().unwrap()).unwrap();
                if actions.iter().any(|a|a.options.as_ref().is_some_and(|o|!o.is_empty())){return Err(failure("unsupported_operation","Linux action buttons cannot enforce foreground, destructive or authenticationRequired options"));}
                if !actions.is_empty()&&!self.native.caps.contains("actions"){return Err(failure("unsupported_operation","native server does not advertise action buttons"));}
                let k=key(ns,id);if !proposed.categories.contains_key(&k)&&proposed.categories.len()>=64{return Err(failure("resource_limit","notification categories reached 64"));}
                proposed.categories.insert(k,json!({"identifier":id,"actions":actions,"intentIdentifiers":[],"options":0}));let remaining=proposed.categories.keys().filter(|k|k.starts_with(&format!("{ns}\0"))).count();self.commit(proposed)?;Ok(json!({"ok":true,"identifier":id,"remaining":remaining}))},
            "post"|"schedule-after"|"schedule-at"|"schedule-cron"=>{
                let(mut entry,actions)=content(action,&self.native,&self.state)?;let id=entry["identifier"].as_str().unwrap().to_owned();
                if sub=="post"{entry["trigger"]=json!({"type":"immediate","repeats":false});let accepted=self.accept(ns,entry,&actions)?;return Ok(Self::receipt(&accepted));}
                let base=now();let repeats=action["repeats"].as_bool().unwrap_or(sub=="schedule-cron");
                let(next,trigger)=match sub{
                    "schedule-after"=>{let seconds=action["seconds"].as_f64().unwrap()as i64;let next=base+seconds*1000+1;(next,json!({"type":"timeInterval","repeats":repeats,"seconds":seconds,"nextTriggerDate":date(next)}))},
                    "schedule-at"=>{let instant=crate::log::timestamp(action["date"].as_str().unwrap()).unwrap();if instant.nanosecond()%1_000_000!=0{return Err(failure("unsupported_operation","Linux notification schedules require RFC3339 instants with at most millisecond precision"));}let next=(instant.unix_timestamp_nanos()/1_000_000)as i64;(next,json!({"type":"calendar","repeats":false,"nextTriggerDate":date(next)}))},
                    _=>{let parts=validate::components(action["components"].as_str().unwrap()).unwrap();let next=calendar(&parts,base/1000).map_err(|e|failure("invalid_request",e))?*1000;(next,json!({"type":"calendar","repeats":repeats,"components":parts,"nextTriggerDate":date(next)}))},
                };
                if next>base+DESKTOP_NOTIFICATION_MAX_SECONDS as i64*1000+1{return Err(failure("invalid_request","next notification occurrence exceeds 365 days"));}
                let mut proposed=self.state.clone();let k=key(ns,&id);if !proposed.scheduled.contains_key(&k)&&proposed.scheduled.len()>=1000{return Err(failure("resource_limit","notification schedules reached 1000"));}
                entry["trigger"]=trigger;let mut stored=action.clone();stored["id"]=json!(id);proposed.scheduled.insert(k,Scheduled{action:stored,entry:entry.clone(),next});self.commit(proposed)?;self.event(ns,json!({"kind":"scheduled","identifier":id}));Ok(Self::receipt(&entry))},
            "cancel"|"cancel-all"=>{let id=action["id"].as_str();let mut proposed=self.state.clone();let removed=proposed.scheduled.iter().filter(|(_,s)|namespace(&s.action)==ns&&id.is_none_or(|id|s.entry["identifier"]==id)).map(|(k,s)|(k.clone(),s.entry["identifier"].as_str().unwrap().to_owned())).collect::<Vec<_>>();for(k,_)in &removed{proposed.scheduled.remove(k);}let remaining=proposed.scheduled.values().filter(|s|namespace(&s.action)==ns).count();self.commit(proposed)?;for(_,id)in &removed{self.event(ns,json!({"kind":"cancelled","identifier":id}));}let mut result=json!({"ok":true,"removed":removed.iter().map(|(_,id)|id).collect::<Vec<_>>(),"remaining":remaining});if let Some(id)=id{result["id"]=json!(id);}Ok(result)},
            "dismiss"|"dismiss-all"=>{let id=action["id"].as_str();let selected=self.state.accepted.iter().filter(|(_,a)|a.namespace==ns&&id.is_none_or(|id|a.entry["identifier"]==id)).map(|(k,a)|(k.clone(),a.clone())).collect::<Vec<_>>();
                if selected.iter().any(|(_,a)|a.active&&a.generation!=self.native.generation){return Err(failure("target_gone","selected notification IDs belong to an older server generation; no close was sent"));}
                let started=Instant::now();let mut removed=Vec::new();for(k,a)in selected{if started.elapsed()>Duration::from_secs(6){return Err(failure("partial_result",format!("dismissal deadline expired after{} owned removals; inspect before retrying",removed.len())));}
                    if a.active{if self.retired.len()>=1000{return Err(failure("resource_limit","native closure observation queue reached 1000; inspect before retrying"));}self.native.close(a.id).map_err(|e|failure("partial_result",format!("native close failed after{} owned removals: {e}",removed.len())))?;self.retired.insert(a.id,a.clone());}
                    let public=a.entry["identifier"].as_str().unwrap();let mut proposed=self.state.clone();proposed.accepted.remove(&k);self.commit(proposed)?;removed.push(public.to_owned());self.event(ns,json!({"kind":"dismissed","identifier":public}));}
                let remaining=self.state.accepted.values().filter(|a|a.namespace==ns).count();let mut result=json!({"ok":true,"removed":removed,"remaining":remaining});if let Some(id)=id{result["id"]=json!(id);}Ok(result)},
            _=>Err(failure("unsupported_operation","unknown notification operation")),
        }})();match result{Ok(data)=>bounded(data),Err(error)=>error}
    }
    fn signals(&mut self)->Result<(),String>{
        for(id,name,mut event)in self.native.poll()?{
            let Some((k,a))=self.state.accepted.iter().find(|(_,a)|a.active&&a.generation==self.native.generation&&a.id==id).map(|(k,a)|(k.clone(),a.clone())).or_else(||self.retired.get(&id).filter(|a|a.generation==self.native.generation).map(|a|(key(&a.namespace,a.entry["identifier"].as_str().unwrap()),a.clone())))else{continue;};
            if name==INVOKED&&!a.actions.contains(event["actionIdentifier"].as_str().unwrap())&&event["actionIdentifier"]!="default"{continue;}
            event["identifier"]=a.entry["identifier"].clone();event["name"]=json!(name);
            if name==CLOSED{self.retired.remove(&id);if self.state.accepted.get(&k).is_some_and(|a|a.id==id){let mut proposed=self.state.clone();proposed.accepted.get_mut(&k).unwrap().active=false;self.commit(proposed).map_err(|e|e["error"].to_string())?;}}
            if self.subscriptions.contains(&key(&a.namespace,&name)){self.event(&a.namespace,event);}
        }Ok(())
    }
    fn fire(&mut self){
        let base=now();let Some((k,s))=self.state.scheduled.iter().find(|(_,s)|s.next<=base).map(|(k,s)|(k.clone(),s.clone()))else{return;};if self.ready().is_err(){return;}
        let ns=namespace(&s.action);let id=s.entry["identifier"].as_str().unwrap();let mut proposed=self.state.clone();proposed.scheduled.remove(&k);
        if s.entry["trigger"]["repeats"]==true{
            let next=if s.action["sub"]=="schedule-after"{Ok(base+s.action["seconds"].as_f64().unwrap()as i64*1000+1)}else{calendar(&validate::components(s.action["components"].as_str().unwrap()).unwrap(),base/1000).map(|n|n*1000)};
            match next{Ok(next)=>{let mut repeat=s.clone();repeat.next=next;repeat.entry["trigger"]["nextTriggerDate"]=json!(date(next));proposed.scheduled.insert(k.clone(),repeat);},Err(error)=>self.event(ns,json!({"kind":"failed","identifier":id,"object":error}))}
        }
        // At-most-once delivery: durable intent precedes Notify. A crash in
        // between may miss delivery; restart reports uncertainty, never replay.
        proposed.inflight.insert(k.clone(),s.clone());if let Err(e)=self.commit(proposed){self.error=Some(e["error"].to_string());return;}
        let result=content(&s.action,&self.native,&self.state).and_then(|(_,actions)|self.accept(ns,s.entry.clone(),&actions));
        if let Err(ref error)=result{let message=error["error"].as_str().unwrap_or("native notification failed");self.event(ns,json!({"kind":"failed","identifier":id,"object":message.chars().take(512).collect::<String>()}));}
        let mut proposed=self.state.clone();proposed.inflight.remove(&k);
        // A successful interval starts again after native acceptance, including
        // the time spent posting and persisting its receipt. Keep the earlier
        // durable recovery intent until this final state replacement succeeds.
        if result.is_ok()&&s.action["sub"]=="schedule-after"&&s.entry["trigger"]["repeats"]==true{
            if let Some(repeat)=proposed.scheduled.get_mut(&k){repeat.next=now()+s.action["seconds"].as_f64().unwrap()as i64*1000+1;repeat.entry["trigger"]["nextTriggerDate"]=json!(date(repeat.next));}
        }
        if let Err(e)=self.commit(proposed){self.error=Some(e["error"].to_string());}
    }
}
struct Request{action:Value,reply:SyncSender<Value>,pending:Arc<AtomicBool>,deadline:Instant}
struct Service{requests:SyncSender<Request>,caps:Vec<String>}
static SERVICE:OnceLock<Service>=OnceLock::new();
static START:Mutex<()>=Mutex::new(());
pub fn initialize(){let _=service();}
fn service()->Result<&'static Service,String>{
    if let Some(service)=SERVICE.get(){return Ok(service);}
    let _start=START.lock().map_err(|_|"notification initialization lock is poisoned".to_owned())?;
    if let Some(service)=SERVICE.get(){return Ok(service);}
    if !crate::linux::graphical_login(){return Err("notifications require the retained graphical Linux login".into());}
    let(requests,inbox)=mpsc::sync_channel::<Request>(8);let(initialized,ready)=mpsc::sync_channel(1);
    std::thread::spawn(move||{
        let setup=(||->Result<Worker,String>{let login=crate::linux::login_identity(0).ok_or("notification graphical login is unavailable")?;
            let native=Native::open()?;let(storage,state)=Storage::open(format!("{}:{}",login.id,login.start_usec))?;
            Ok(Worker{native,storage,state,login,subscriptions:BTreeSet::new(),history:Vec::new(),retired:BTreeMap::new(),error:None})})();
        let mut worker=match setup{Ok(worker)=>worker,Err(error)=>{let _=initialized.send(Err(error));return;}};
        let interrupted=std::mem::take(&mut worker.state.inflight);for s in interrupted.values(){worker.event(namespace(&s.action),json!({"kind":"failed","identifier":s.entry["identifier"],"object":"delivery interrupted; native acceptance is unknown and will not be replayed"}));}
        if let Err(error)=worker.storage.save(&worker.state){let _=initialized.send(Err(error));return;}
        if initialized.send(Ok(worker.native.caps.iter().cloned().collect::<Vec<_>>())).is_err(){return;}
        loop{
            if crate::linux::login_identity(0).as_ref()!=Some(&worker.login){return;}
            if let Err(error)=worker.signals(){worker.error=Some(error);}
            match inbox.recv_timeout(Duration::from_millis(100)){
                Ok(request)=>{if request.pending.load(Ordering::Acquire)&&Instant::now()<request.deadline{let result=worker.dispatch(&request.action);let _=request.reply.send(result);}},
                Err(mpsc::RecvTimeoutError::Disconnected)=>return,Err(mpsc::RecvTimeoutError::Timeout)=>(),
            }
            worker.fire();
        }
    });
    let caps=ready.recv_timeout(Duration::from_secs(8)).map_err(|_|"notification service initialization exceeded 8 seconds".to_owned())??;
    Ok(SERVICE.get_or_init(||Service{requests,caps}))
}
pub fn dispatch(action:&Value)->Value{
    if let Err(error)=validate::validate(action){return error;}
    if !crate::linux::graphical_login(){return failure("no_interactive_session","notifications require the current graphical Linux login; no action was sent");}
    let service=match service(){Ok(service)=>service,Err(error)=>return failure("background_unavailable",error)};
    let(reply,result)=mpsc::sync_channel(1);let pending=Arc::new(AtomicBool::new(true));let deadline=Instant::now()+Duration::from_secs(12);
    let request=Request{action:action.clone(),reply,pending:pending.clone(),deadline};
    if service.requests.try_send(request).is_err(){return failure("resource_limit","notification worker is unavailable or its eight-request queue is full");}
    match result.recv_timeout(deadline.saturating_duration_since(Instant::now())){Ok(value)=>value,Err(_)=>{pending.store(false,Ordering::Release);failure("provider_failed","notification request deadline expired; native outcome may be unknown; inspect before retrying")}}
}
pub fn capability(session:&str)->Value{
    let service=service();let effective=service.is_ok();let mut result=json!({"operation":"notifications","compiled":true,"present":effective,"permission":"not_applicable","session":session,"effective":effective,"background":if effective{"semantic"}else{"unavailable"},"provider":"freedesktop-session-bus","versions":{"contract":"1","nativeCapabilities":service.as_ref().map(|s|s.caps.join(",")).unwrap_or_default()},"limits":["same retained graphical login and native server generation","owned-scheduled queue and owned-accepted receipts, not native scheduling or exhaustive server history","1000 schedules/acceptance receipts, 64 categories, 32 owned-signal subscriptions, 4MiB private state/event files","at-most-once scheduling; interrupted native effects are reported and not replayed; restart only within the same login","one static image; body/actions/sound require actual native capabilities; no native authorization, badge or Apple-only category options"]});if let Err(error)=service{result["reason"]=json!(error);}result
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn owned_state_refuses_foreign_identity_unknown_fields_and_unbounded_counts(){
        let state=State::empty("1:42".into());assert!(validate_state(&state,"1:42").is_ok());assert!(validate_state(&state,"2:42").is_err());
        let mut serialized=serde_json::to_value(&state).unwrap();serialized["unexpected"]=json!(true);assert!(serde_json::from_value::<State>(serialized).is_err());
        assert_ne!(key("one","same"),key("two","same"));assert_ne!(schedule_id("one","same"),schedule_id("two","same"));
        let next=1000;
        let scheduled=Scheduled{action:json!({"type":"desktop_notifications","sub":"schedule-after","namespace":"owned","id":"same","seconds":60,"repeats":false}),entry:json!({"identifier":"same","nativeIdentifier":schedule_id("owned","same"),"title":"","subtitle":"","body":"","categoryIdentifier":"","threadIdentifier":"","userInfoJSON":"{}","sound":null,"attachments":[],"trigger":{"type":"timeInterval","repeats":false,"seconds":60,"nextTriggerDate":date(next)}}),next};
        let mut restored=state.clone();restored.scheduled.insert(key("owned","same"),scheduled.clone());assert!(validate_state(&restored,"1:42").is_ok());
        for(field,value)in [("repeats",Value::Null),("type",json!("unrelated")),("components",json!("hour=12")),("seconds",json!(true))]{let mut malformed=restored.clone();malformed.scheduled.get_mut(&key("owned","same")).unwrap().action[field]=value;assert!(validate_state(&malformed,"1:42").is_err(),"{field}");}
        let mut malformed=restored.clone();malformed.scheduled.get_mut(&key("owned","same")).unwrap().entry["trigger"]["seconds"]=json!(61);assert!(validate_state(&malformed,"1:42").is_err());
    }
    #[test]fn native_calendar_uses_timezone_weekday_and_sparse_dates(){
        let base=crate::log::timestamp("2026-10-06T00:00:00Z").unwrap().unix_timestamp();
        let next=calendar(&validate::components("weekday=1,hour=23,minute=0,second=0").unwrap(),base).unwrap();
        assert!(next>base);let mut local=unsafe{std::mem::zeroed::<libc::tm>()};assert!(!unsafe{libc::localtime_r(&next,&mut local)}.is_null());assert_eq!(local.tm_wday,0);assert_eq!(local.tm_hour,23);
        assert!(calendar(&validate::components("year=2025,month=1,day=1,hour=0,minute=0,second=0").unwrap(),base).is_err());
    }
}
