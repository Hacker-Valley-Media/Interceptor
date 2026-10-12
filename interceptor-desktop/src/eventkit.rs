use crate::{failure,success,contract_generated::*,contacts::integer};
use serde_json::{Value,json};
use std::{io,sync::Mutex,time::{Duration,Instant}};
use time::{OffsetDateTime,format_description::well_known::Rfc3339};
static ACTIVE:Mutex<()>=Mutex::new(());
const EVENT_FIELDS:[&str;13]=["title","start","end","all_day","location","notes","url","alarms","attendees","recurrence_frequency","recurrence_interval","recurrence_end","calendar"];
const REMINDER_FIELDS:[&str;6]=["title","due","start","priority","notes","url"];
pub(crate) fn date(raw:&str)->Result<OffsetDateTime,Value>{
    if raw.len()<20||raw.len()>35||raw.as_bytes().get(10)!=Some(&b'T')||!raw.ends_with('Z')&&raw.as_bytes().get(raw.len()-6).is_none_or(|b|!matches!(*b,b'+'|b'-'))||raw.get(17..19).and_then(|v|v.parse::<u8>().ok()).is_none_or(|n|n>59){return Err(failure("invalid_request","an actual ISO8601 instant with seconds and explicit offset is required"));}
    let d=OffsetDateTime::parse(raw,&Rfc3339).map_err(|_|failure("invalid_request","invalid actual ISO8601 instant"))?;
    if d.year()<1||d.year()>9999{return Err(failure("invalid_request","instant year must be from 1 to 9999"));}Ok(d)
}
pub(crate) fn iso(date:OffsetDateTime)->Result<String,Value>{date.to_offset(time::UtcOffset::UTC).format(&Rfc3339).map_err(|_|failure("provider_failed","native date cannot be represented as ISO8601"))}
pub(crate) fn page(a:&Value)->(usize,usize){(integer(&a["limit"]).unwrap_or(100)as usize,integer(&a["offset"]).unwrap_or(0)as usize)}
/// An occurrence of a recurring event is "<series id>@<unix seconds of its original start>" on hosts
/// whose native occurrences share the series id (Windows). A plain id is the series.
#[cfg_attr(not(windows),allow(dead_code))]
pub(crate) fn split_occurrence(id:&str)->(&str,Option<i64>){
    match id.rsplit_once('@'){
        Some((series,seconds))if !series.is_empty()=>match seconds.parse::<i64>(){Ok(value)if value.to_string()==seconds=>(series,Some(value)),_=>(id,None)},
        _=>(id,None),
    }
}
pub(crate) fn relative_alarm(raw:&str)->Option<f64>{
    let value=raw.strip_prefix(['+','-']).unwrap_or(raw);let mut parts=value.split('.');let whole=parts.next()?;let fraction=parts.next();
    if parts.next().is_some()||!whole.bytes().all(|b|b.is_ascii_digit())||fraction.is_some_and(|s|s.is_empty()||!s.bytes().all(|b|b.is_ascii_digit()))||whole.is_empty()&&fraction.is_none(){return None;}
    raw.parse::<f64>().ok().filter(|n|n.is_finite()&&n.abs()<=315576000.0)
}
pub(crate) fn validate(a:&Value)->Result<(),Value>{
    let calendar=a["type"]=="desktop_calendar";
    if !calendar&&a["type"]!="desktop_reminders"{return Err(failure("invalid_request","unknown Calendar/Reminders operation"));}
    if let Some(error)=if calendar{desktop_calendar_shape_error(a)}else{desktop_reminders_shape_error(a)}{return Err(failure("invalid_request",error));}
    let sub=a["sub"].as_str().unwrap();
    let mut fields=if calendar{match sub{
        "status"|"list"|"default"|"sources"|"refresh-sources"|"reset"|"tail"=>vec![],"request"=>vec!["level"],"create-calendar"=>vec!["title","color","cal_type","source"],"delete-calendar"|"event"=>vec!["id"],"events"=>vec!["start","end","calendar","calendars","limit","offset"],"event-by-external"=>vec!["id","limit","offset"],"create"=>EVENT_FIELDS.to_vec(),"update"=>EVENT_FIELDS.iter().copied().filter(|k|*k!="calendar").chain(["id","span"]).collect(),"delete"=>vec!["id","span"],"move"=>vec!["id","to"],_=>return Err(failure("invalid_request","unknown Calendar selector"))}
    }else{match sub{"status"|"request"|"lists"|"default"=>vec![],"all"=>vec!["list","limit","offset"],"incomplete"=>vec!["list","due_start","due_end","limit","offset"],"completed"=>vec!["list","since","until","limit","offset"],"create"=>REMINDER_FIELDS.into_iter().chain(["list"]).collect(),"update"=>REMINDER_FIELDS.into_iter().chain(["id"]).collect(),"complete"|"uncomplete"|"delete"=>vec!["id"],_=>return Err(failure("invalid_request","unknown Reminders selector"))}};
    fields.extend(["type","sub"]);
    for(key,value)in a.as_object().unwrap(){if !fields.contains(&key.as_str()){return Err(failure("invalid_request","field does not belong to Calendar/Reminders selector"));}if let Some(text)=value.as_str(){if text.len()>if key=="notes"{65536}else{4096}||text.contains('\0')||!matches!(key.as_str(),"notes"|"location"|"url")&&text.trim().is_empty(){return Err(failure("invalid_request","invalid bounded Calendar/Reminders text"));}}}
    for key in ["limit","offset","recurrence_interval"]{if a.get(key).is_some()&&integer(&a[key]).is_none_or(|n|n<if key=="offset"{0}else{1}||n>if key=="limit"{1000}else{10000}){return Err(failure("invalid_request","invalid Calendar/Reminders integer"));}}
    let required=if calendar{match sub{"delete-calendar"|"event"|"event-by-external"|"update"|"delete"=>vec!["id"],"move"=>vec!["id","to"],"create"=>vec!["title","start","end"],"events"=>vec!["start","end"],"create-calendar"=>vec!["title"],_=>vec![]}}else{match sub{"update"|"complete"|"uncomplete"|"delete"=>vec!["id"],"create"=>vec!["title"],"completed"=>vec!["since","until"],_=>vec![]}};
    if required.iter().any(|k|a.get(*k).is_none()){return Err(failure("invalid_request","Calendar/Reminders selector requires exact fields"));}
    if sub=="update"&&!if calendar{EVENT_FIELDS.iter().filter(|k|**k!="calendar").any(|k|a.get(*k).is_some())}else{REMINDER_FIELDS.iter().any(|k|a.get(*k).is_some())}{return Err(failure("invalid_request","Calendar/Reminders update requires mutable fields"));}
    for key in ["start","end","due","due_start","due_end","since","until"]{if let Some(raw)=a[key].as_str(){date(raw)?;}}
    if !calendar&&let(Some(start),Some(due))=(a["start"].as_str(),a["due"].as_str())&&date(due)?<date(start)?{return Err(failure("invalid_request","the due date is before the start date"));}
    for (lo,hi)in[("start","end"),("due_start","due_end"),("since","until")]{if let(Some(x),Some(y))=(a[lo].as_str(),a[hi].as_str()){let(x,y)=(date(x)?,date(y)?);if y<=x||y-x>time::Duration::days(1461){return Err(failure("invalid_request","the end must be after the start, within 1461 days"));}}}
    for(key,values)in[("level",&["full","write"][..]),("span",&["this","future"][..]),("cal_type",&["local","calDAV","exchange","subscribed"][..]),("priority",&["none","high","medium","low"][..]),("recurrence_frequency",&["daily","weekly","monthly","yearly"][..])]{if a[key].as_str().is_some_and(|text|!values.contains(&text)){return Err(failure("invalid_request","unknown Calendar/Reminders enum"));}}
    if let Some(text)=a["color"].as_str(){if text.len()!=7||!text.starts_with('#')||!text.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit){return Err(failure("invalid_request","Calendar color requires #RRGGBB"));}}
    if a.get("calendar").is_some()&&a.get("calendars").is_some(){return Err(failure("invalid_request","one exact calendar scope required"));}
    if let Some(raw)=a["calendars"].as_str(){let ids=raw.split(',').collect::<Vec<_>>();if ids.len()>128||ids.iter().collect::<std::collections::HashSet<_>>().len()!=ids.len()||ids.iter().any(|id|id.is_empty()||id.trim()!=*id){return Err(failure("invalid_request","invalid exact Calendar identities"));}}
    if let Some(url)=a["url"].as_str(){if !url.is_empty()&&reqwest::Url::parse(url).is_err(){return Err(failure("invalid_request","absolute URL required"));}}
    if a["attendees"].as_array().is_some_and(|rows|!rows.is_empty()){return Err(failure("invalid_request","attendees are read-only; no change was made"));}
    if let Some(rows)=a["alarms"].as_array(){if rows.len()>32{return Err(failure("resource_limit","calendar alarms exceed 32"));}for row in rows{let raw=row.as_str().unwrap();if date(raw).is_err()&&relative_alarm(raw).is_none(){return Err(failure("invalid_request","invalid bounded Calendar alarm"));}}}
    if (a.get("recurrence_interval").is_some()||a.get("recurrence_end").is_some())&&a.get("recurrence_frequency").is_none(){return Err(failure("invalid_request","recurrence fields require frequency"));}
    if let Some(raw)=a["recurrence_end"].as_str(){if date(raw).is_err()&&(raw.starts_with('0')||!raw.bytes().all(|b|b.is_ascii_digit())||raw.parse::<u32>().ok().is_none_or(|n|n==0||n>100000)){return Err(failure("invalid_request","recurrence end requires an instant or an occurrence count from 1 to 100000"));}}
    if serde_json::to_vec(a).map_or(true,|bytes|bytes.len()>262144){return Err(failure("resource_limit","calendar/reminders request exceeds 256 KiB"));}Ok(())
}
pub(crate) fn reply_error(a:&Value,data:&Value)->Option<String>{
    if serde_json::to_vec(data).map_or(true,|bytes|bytes.len()>1048576){return Some("calendar/reminders reply exceeds 1 MiB".into());}
    macro_rules! shape{($type:ty)=>{serde_json::from_value::<$type>(data.clone()).map(|_|())}}
    let sub=a["sub"].as_str().unwrap();let calendar=a["type"]=="desktop_calendar";
    let result=if calendar{match sub{"status"=>shape!(DesktopCalendarStatus),"request"=>shape!(DesktopCalendarRequested),"list"=>shape!(DesktopCalendarList),"sources"=>shape!(DesktopCalendarSources),"default" if data.get("calendar")==Some(&Value::Null)=>shape!(DesktopCalendarNoDefault),"default"|"create-calendar"=>shape!(DesktopCalendarRow),"events"|"event-by-external"=>shape!(DesktopCalendarEvents),"delete"|"delete-calendar"=>shape!(DesktopCalendarDeleted),"refresh-sources"|"reset"=>shape!(DesktopCalendarOK),"tail"=>shape!(DesktopCalendarTail),_=>shape!(DesktopCalendarEvent)}}else{match sub{"status"=>shape!(DesktopRemindersStatus),"request"=>shape!(DesktopRemindersRequested),"lists"=>shape!(DesktopRemindersLists),"default" if data.get("list")==Some(&Value::Null)=>shape!(DesktopRemindersNoDefault),"default"=>shape!(DesktopRemindersList),"all"|"incomplete"|"completed"=>shape!(DesktopRemindersRows),"delete"=>shape!(DesktopCalendarDeleted),_=>shape!(DesktopRemindersRow)}};
    if result.is_err(){return Some("Calendar/Reminders reply violates exact selector contract".into());}
    fn bounded(value:&Value,depth:usize)->bool{depth<=8&&match value{Value::String(s)=>s.len()<=65536&&!s.contains('\0'),Value::Array(rows)=>rows.len()<=1000&&rows.iter().all(|r|bounded(r,depth+1)),Value::Object(rows)=>rows.values().all(|r|bounded(r,depth+1)),_=>true}}
    if !bounded(data,0){return Some("Calendar/Reminders native reply exceeds nested bounds".into());}
    let identity=|v:&Value|v.as_str().is_some_and(|id|!id.trim().is_empty()&&id.len()<=4096);
    if data.get("ok").is_some()&&data["ok"]!=true||matches!(sub,"delete"|"delete-calendar")&&data["id"]!=a["id"]{return Some("Calendar/Reminders native effect receipt differs".into());}
    if data.get("id").is_some()&&!identity(&data["id"]){return Some("missing actual native identity".into());}
    if calendar&&sub=="event"&&data["id"]!=a["id"]{return Some("native event read differs from the exact requested identity".into());}
    if !calendar&&matches!(sub,"update"|"complete"|"uncomplete")&&data["id"]!=a["id"]{return Some("native reminder mutation differs from the exact requested identity".into());}
    for key in ["calendars","lists","sources","events","reminders"]{if data[key].as_array().is_some_and(|rows|rows.iter().any(|row|!identity(&row["id"]))){return Some("missing actual native identity".into());}}
    if data.get("limit").is_some(){let(limit,offset)=page(a);if integer(&data["limit"])!=Some(limit as u64)||integer(&data["offset"])!=Some(offset as u64)||data[if calendar{"events"}else{"reminders"}].as_array().unwrap().len()>limit{return Some("native page differs from requested bounds".into());}}
    let rows=if let Some(rows)=data[if calendar{"events"}else{"reminders"}].as_array(){rows.iter().collect::<Vec<_>>()}else if data.get(if calendar{"calendarId"}else{"listId"}).is_some(){vec![data]}else{vec![]};
    for row in &rows{if calendar{
        if !identity(&row["calendarId"])||row["startDate"].as_str().and_then(|s|date(s).ok()).zip(row["endDate"].as_str().and_then(|s|date(s).ok())).is_none_or(|(start,end)|end<start){return Some("invalid native Calendar interval or identity".into());}
        if a.get("calendar").is_some()&&row["calendarId"]!=a["calendar"]||a["calendars"].as_str().is_some_and(|ids|!ids.split(',').any(|id|row["calendarId"]==id))||sub=="move"&&row["calendarId"]!=a["to"]{return Some("native Calendar differs from exact requested scope".into());}
    }else{if !identity(&row["listId"])||!matches!(row["priority"].as_str(),Some("none"|"high"|"medium"|"low")){return Some("invalid native Reminders list or priority".into());}if a.get("list").is_some()&&row["listId"]!=a["list"]||matches!(sub,"complete"|"completed")&&row["isCompleted"]!=true||matches!(sub,"uncomplete"|"incomplete")&&row["isCompleted"]!=false{return Some("native Reminders differs from requested state or list".into());}}}
    if !calendar&&rows.iter().any(|row|row.get("completionDate").is_some()&&row["completionDate"].as_str().and_then(|s|date(s).ok()).is_none()){return Some("invalid native reminder completion instant".into());}
    if calendar&&sub=="tail"&&(integer(&data["changeCount"]).is_none_or(|n|n>9007199254740991)||data["tailing"]!=true||!data["lastChange"].is_null()&&data["lastChange"].as_str().and_then(|s|date(s).ok()).is_none()){return Some("invalid native calendar change counter".into());}
    None
}
pub fn dispatch(a:&Value)->Value{
    if let Err(error)=validate(a){return error;}let Ok(_active)=ACTIVE.try_lock()else{return failure("resource_limit","another Calendar/Reminders helper remains active; no work queued");};
    match crate::thumbnail::image_helper("--eventkit-engine",a,Instant::now()+Duration::from_secs(55)){Ok(data)=>match reply_error(a,&data){Some(error)=>failure("partial_result",error),None=>success(data)},Err(error)if error["code"]=="resource_limit"||error["code"]=="provider_failed"&&error["error"].as_str().is_some_and(|s|s.starts_with("native helper failed"))=>failure("timeout_unknown_outcome","Calendar/Reminders helper did not return a complete receipt; owned helper was reaped, outcome remains unknown and no mutation replayed"),Err(error)=>error}
}
pub(crate) fn helper(parent:u32)->io::Result<()>{
    #[cfg(target_os="linux")]unsafe{
        let memory=libc::rlimit{rlim_cur:512*1024*1024,rlim_max:512*1024*1024};let cores=libc::rlimit{rlim_cur:0,rlim_max:0};
        if libc::setrlimit(libc::RLIMIT_AS,&memory)!=0||libc::setrlimit(libc::RLIMIT_CORE,&cores)!=0{return Err(io::Error::last_os_error());}
    }
    crate::thumbnail::retain_provider(parent)?;let bytes=crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("Calendar/Reminders helper requires one request"))?;let action:Value=serde_json::from_slice(&bytes)?;
    let result=match validate(&action){Err(error)=>error,Ok(())=>{
        #[cfg(windows)]{match crate::eventkit_windows::native(&action){Ok(data)=>success(data),Err(error)=>error}}
        #[cfg(target_os="linux")]{match crate::eventkit_linux::native(&action){Ok(data)=>success(data),Err(error)=>error}}
        #[cfg(not(any(windows,target_os="linux")))]{failure("unsupported_operation","Calendar/Reminders native helper requires Windows or Linux")}
    }};
    let result=if result["success"]==true{match reply_error(&action,&result["data"]){Some(error)=>failure("partial_result",error),None=>result}}else{result};let bytes=serde_json::to_vec(&result)?;let bytes=if bytes.len()>1048576{serde_json::to_vec(&failure("partial_result","calendar/reminders native receipt exceeds 1 MiB after a possible effect"))?}else{bytes};crate::write_frame(&mut io::stdout().lock(),&bytes)
}
pub fn capabilities(session:&str)->Vec<Value>{["calendar","reminders"].into_iter().map(|operation|json!({"operation":operation,"compiled":cfg!(any(windows,target_os="linux")),"present":cfg!(any(windows,target_os="linux")),"effective":false,"permission":"unknown","session":session,"background":"semantic","provider":"Windows appointment/task stores / Evolution Data Server owned helper","versions":{"contract":"1"},"limits":["Strict 17 Calendar and 12 Reminders selectors; actual native stores and authorized fixture identities required.","One 55-second owned helper across both families; 1 MiB replies, pages 1..1000 and offsets 0..10000; no mutation replay.","Complete portable store/default/recurrence/alarm/history equivalence, native UI/package/dependency delivery and current installed qualification remain open."]})).collect()}
#[cfg(test)]mod tests{use super::*;#[test]fn occurrence_ids_split_only_on_a_trailing_instant(){assert_eq!(split_occurrence("c,e,4e@1904396400"),("c,e,4e",Some(1904396400)));assert_eq!(split_occurrence("c,e,4e@-60"),("c,e,4e",Some(-60)));for plain in["c,e,4e","a@b","x@","@5","x@05","x@+5"]{assert_eq!(split_occurrence(plain),(plain,None));}}#[test]fn reject_lost_scope_and_invalid_mutations(){for a in[json!({"type":"desktop_calendar","sub":"events","start":"2026-02-30T00:00:00Z","end":"2026-03-01T00:00:00Z"}),json!({"type":"desktop_calendar","sub":"update","id":"actual","attendees":["someone@example.test"]}),json!({"type":"desktop_reminders","sub":"update","id":"actual","priority":"urgent"})]{assert!(validate(&a).is_err());}assert!(validate(&json!({"type":"desktop_calendar","sub":"update","id":"actual","alarms":[]})).is_ok());}}
