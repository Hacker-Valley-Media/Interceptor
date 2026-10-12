use crate::{failure,eventkit::{date,iso,page},contacts::integer};
use serde_json::{Value,json};
use std::time::{Instant,Duration};
use windows::{core::{HSTRING,Interface,RuntimeType},ApplicationModel::{Appointments::*,UserDataAccounts::*,UserDataTasks::*},Foundation::{DateTime,TimeSpan,IReference,PropertyValue,Uri},Security::Authorization::AppCapabilityAccess::{AppCapability,AppCapabilityAccessStatus},Win32::{Foundation::SYSTEMTIME,System::{Time::{SystemTimeToTzSpecificLocalTime,TzSpecificLocalTimeToSystemTime},WinRT::{RoInitialize,RoUninitialize,RO_INIT_SINGLETHREADED,RO_INIT_MULTITHREADED}}}};
struct Runtime;impl Drop for Runtime{fn drop(&mut self){unsafe{RoUninitialize();}}}
struct Native{deadline:Instant}
fn error(e:windows::core::Error)->Value{let mut result=if crate::windows::null_result(e.code().0){failure("target_gone","native Windows appointment/task store returned no item for this request")}else{failure("provider_failed",format!("native Windows appointment/task store failed: {e}"))};result["details"]=json!({"nativeHRESULT":e.code().0});result}
fn committed(mut result:Value)->Value{result["code"]=json!("timeout_unknown_outcome");if !result["details"].is_object(){result["details"]=json!({});}result["details"]["mutationCommitted"]=true.into();result}
fn optional<T>(value:windows::core::Result<T>)->Result<Option<T>,Value>{match value{Ok(v)=>Ok(Some(v)),Err(e)if crate::windows::null_result(e.code().0)=>Ok(None),Err(e)=>Err(error(e))}}
impl Native{
    fn wait<T:RuntimeType+'static>(&self,value:windows::core::Result<windows_future::IAsyncOperation<T>>)->Result<T,Value>{let op=value.map_err(error)?;crate::auth_windows::await_result(&op,self.deadline,None).map_err(error)}
    fn action(&self,start:impl FnOnce()->windows::core::Result<windows_future::IAsyncAction>)->Result<(),Value>{if Instant::now()>=self.deadline{return Err(failure("cancelled","appointment/task helper deadline reached before mutation"));}start().and_then(|op|crate::auth_windows::await_action(&op,self.deadline,None)).map_err(error)}
    fn mutation<T:RuntimeType+'static>(&self,start:impl FnOnce()->windows::core::Result<windows_future::IAsyncOperation<T>>)->Result<T,Value>{if Instant::now()>=self.deadline{return Err(failure("cancelled","appointment/task helper deadline reached before mutation"));}self.wait(start())}
    fn calendars(&self,write:bool)->Result<AppointmentStore,Value>{self.wait(AppointmentManager::RequestStoreAsync(if write{AppointmentStoreAccessType::AppCalendarsReadWrite}else{AppointmentStoreAccessType::AllCalendarsReadOnly}))}
    fn tasks(&self,write:bool)->Result<UserDataTaskStore,Value>{let manager=UserDataTaskManager::GetDefault().map_err(error)?;self.wait(manager.RequestStoreAsync(if write{UserDataTaskStoreAccessType::AppTasksReadWrite}else{UserDataTaskStoreAccessType::AllTasksLimitedReadWrite}))}
    fn books(&self,store:&AppointmentStore)->Result<Vec<AppointmentCalendar>,Value>{let books=self.wait(store.FindAppointmentCalendarsAsync())?;let count=books.Size().map_err(error)?;if count>128{return Err(failure("resource_limit","native appointment store exceeds 128 calendars"));}(0..count).map(|index|books.GetAt(index).map_err(error)).collect()}
    fn lists(&self,store:&UserDataTaskStore)->Result<Vec<UserDataTaskList>,Value>{let lists=self.wait(store.FindListsAsync())?;let count=lists.Size().map_err(error)?;if count>128{return Err(failure("resource_limit","native task store exceeds 128 lists"));}(0..count).map(|index|lists.GetAt(index).map_err(error)).collect()}
    // An app-owned calendar or list is found through the app store; the all-items read store may
    // not list it under the same id, so exact lookups try both before refusing.
    fn book(&self,store:&AppointmentStore,id:&str)->Result<AppointmentCalendar,Value>{for store in [Some(store.clone()),self.calendars(true).ok()].into_iter().flatten(){for book in self.books(&store)?{if calendar_id(book.LocalId().map_err(error)?)==id{return Ok(book);}}}Err(failure("target_gone","unknown exact native appointment calendar; no default fallback"))}
    fn list(&self,store:&UserDataTaskStore,id:&str)->Result<UserDataTaskList,Value>{for store in [Some(store.clone()),self.tasks(true).ok()].into_iter().flatten(){for list in self.lists(&store)?{if list.Id().map_err(error)?.to_string()==id{return Ok(list);}}}Err(failure("target_gone","unknown exact native task list; no default fallback"))}
}
fn native_date(raw:&str)->Result<DateTime,Value>{to_native(date(raw)?)}
fn to_native(d:time::OffsetDateTime)->Result<DateTime,Value>{if d.nanosecond()%100!=0{return Err(failure("invalid_request","Windows native dates require 100ns precision"));}let ticks=(d.unix_timestamp_nanos()/100).checked_add(116444736000000000).and_then(|n|i64::try_from(n).ok()).ok_or_else(||failure("invalid_request","date exceeds native Windows range"))?;Ok(DateTime{UniversalTime:ticks})}
fn from_date(d:DateTime)->Result<time::OffsetDateTime,Value>{time::OffsetDateTime::from_unix_timestamp_nanos((d.UniversalTime as i128-116444736000000000)*100).map_err(|_|failure("provider_failed","native Windows date is outside representable bounds"))}
fn reference_date(d:DateTime)->Result<IReference<DateTime>,Value>{PropertyValue::CreateDateTime(d).and_then(|v|v.cast()).map_err(error)}
// Windows keeps an all-day appointment at local midnight of its date (Appointment.AllDay remarks);
// the contract names that date at UTC midnight, as EDS does.
fn system_date(s:SYSTEMTIME)->Result<time::Date,Value>{time::Month::try_from(s.wMonth as u8).ok().and_then(|month|time::Date::from_calendar_date(s.wYear as i32,month,s.wDay as u8).ok()).ok_or_else(||failure("provider_failed","native local date is invalid"))}
fn local_date(d:DateTime)->Result<time::Date,Value>{let t=from_date(d)?;let utc=SYSTEMTIME{wYear:t.year()as u16,wMonth:t.month()as u16,wDay:t.day()as u16,wHour:t.hour()as u16,wMinute:t.minute()as u16,wSecond:t.second()as u16,wMilliseconds:t.millisecond(),..Default::default()};let mut local=SYSTEMTIME::default();unsafe{SystemTimeToTzSpecificLocalTime(None,&utc,&mut local)}.map_err(error)?;system_date(local)}
fn local_midnight(day:time::Date)->Result<DateTime,Value>{let local=SYSTEMTIME{wYear:day.year()as u16,wMonth:day.month()as u16,wDay:day.day()as u16,..Default::default()};let mut utc=SYSTEMTIME::default();unsafe{TzSpecificLocalTimeToSystemTime(None,&local,&mut utc)}.map_err(error)?;let time=time::Time::from_hms(utc.wHour as u8,utc.wMinute as u8,utc.wSecond as u8).map_err(|_|failure("provider_failed","native local midnight is invalid"))?;to_native(time::PrimitiveDateTime::new(system_date(utc)?,time).assume_utc())}
// Windows calendar LocalIds contain commas ("b,8,1f"), which the contract's comma-separated
// --calendars list cannot carry, so calendar ids travel encoded like task identities.
fn calendar_id(raw:HSTRING)->String{use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD};format!("windows-calendar:{}",URL_SAFE_NO_PAD.encode(raw.to_string()))}
fn identity(list:&str,item:&str)->String{use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD};format!("windows-task:{}:{}",URL_SAFE_NO_PAD.encode(list),URL_SAFE_NO_PAD.encode(item))}
fn decode_identity(raw:&str)->Result<(String,String),Value>{use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD};let parts=raw.strip_prefix("windows-task:").and_then(|s|s.split_once(':')).ok_or_else(||failure("target_gone","Windows task identity must retain native list and item"))?;let decode=|raw:&str|URL_SAFE_NO_PAD.decode(raw).ok().and_then(|bytes|String::from_utf8(bytes).ok()).filter(|s|!s.is_empty()&&s.len()<=4096&&!s.contains('\0')&&URL_SAFE_NO_PAD.encode(s)==raw).ok_or_else(||failure("target_gone","invalid canonical native task identity"));Ok((decode(parts.0)?,decode(parts.1)?))}
fn authorization(value:AppCapabilityAccessStatus)->&'static str{match value{AppCapabilityAccessStatus::Allowed=>"authorized",AppCapabilityAccessStatus::DeniedByUser=>"denied",AppCapabilityAccessStatus::DeniedBySystem|AppCapabilityAccessStatus::NotDeclaredByApp=>"restricted",AppCapabilityAccessStatus::UserPromptRequired=>"notDetermined",_=>"unknown"}}
fn scope(calendar:bool)->Result<AppCapability,Value>{AppCapability::Create(&HSTRING::from(if calendar{"appointments"}else{"userDataTasks"})).map_err(error)}
fn event_row(event:&Appointment)->Result<Value,Value>{
    let start=event.StartTime().map_err(error)?;let duration=event.Duration().map_err(error)?;if duration.Duration<=0{return Err(failure("provider_failed","native appointment has nonpositive duration"));}let end=DateTime{UniversalTime:start.UniversalTime.checked_add(duration.Duration).ok_or_else(||failure("provider_failed","native appointment duration overflows"))?};
    let all_day=event.AllDay().map_err(error)?;let boundary=|d:DateTime|->Result<String,Value>{iso(if all_day{local_date(d)?.midnight().assume_utc()}else{from_date(d)?})};
    let mut row=json!({"id":occurrence_id(event)?,"calendarId":calendar_id(event.CalendarId().map_err(error)?),"title":event.Subject().map_err(error)?.to_string(),"startDate":boundary(start)?,"endDate":boundary(end)?,"isAllDay":all_day,"status":if event.IsCanceledMeeting().map_err(error)?{"cancelled"}else{"none"},"availability":match event.BusyStatus().map_err(error)?{AppointmentBusyStatus::Busy=>"busy",AppointmentBusyStatus::Tentative=>"tentative",AppointmentBusyStatus::Free=>"free",AppointmentBusyStatus::OutOfOffice=>"unavailable",_=>"unknown"}});
    let location=event.Location().map_err(error)?.to_string();if !location.is_empty(){row["location"]=location.into();}let notes=event.Details().map_err(error)?.to_string();if !notes.is_empty(){if event.DetailsKind().map_err(error)?!=AppointmentDetailsKind::PlainText{return Err(failure("unsupported_operation","native appointment notes are HTML; no plain-text conversion was inferred"));}row["notes"]=notes.into();}
    if let Some(uri)=optional(event.Uri())?{row["url"]=uri.AbsoluteUri().map_err(error)?.to_string().into();}
    if let Some(original)=optional(event.OriginalStartTime())?{row["occurrenceDate"]=boundary(original.Value().map_err(error)?)?.into();}
    if let Some(reminder)=optional(event.Reminder())?{row["alarms"]=json!([{"relativeOffset":-(reminder.Value().map_err(error)?.Duration as f64)/10000000.0}]);}
    if let Some(rule)=optional(event.Recurrence())?{let frequency=match rule.Unit().map_err(error)?{AppointmentRecurrenceUnit::Daily=>"daily",AppointmentRecurrenceUnit::Weekly=>"weekly",AppointmentRecurrenceUnit::Monthly|AppointmentRecurrenceUnit::MonthlyOnDay=>"monthly",AppointmentRecurrenceUnit::Yearly|AppointmentRecurrenceUnit::YearlyOnDay=>"yearly",_=>return Err(failure("unsupported_operation","unknown native appointment recurrence unit"))};let mut value=json!({"frequency":frequency,"interval":rule.Interval().map_err(error)?});let mut end=json!({});if let Some(count)=optional(rule.Occurrences())?{end["occurrenceCount"]=count.Value().map_err(error)?.into();}if let Some(until)=optional(rule.Until())?{end["date"]=iso(from_date(until.Value().map_err(error)?)?)?.into();}if !end.as_object().unwrap().is_empty(){value["end"]=end;}row["recurrenceRules"]=json!([value]);}
    // Windows does not expose EventKit organizer/attendee identity flags or its
    // complete recurrence components in this schema. Those mappings stay open.
    Ok(row)
}
fn calendar_row(book:&AppointmentCalendar,owned:bool)->Result<Value,Value>{Ok(json!({"id":calendar_id(book.LocalId().map_err(error)?),"title":book.DisplayName().map_err(error)?.to_string(),"type":if owned{"app_owned"}else{"external"},"allowsContentModifications":owned}))}
fn appointment_options(max:u32)->Result<FindAppointmentsOptions,Value>{
    let options=FindAppointmentsOptions::new().map_err(error)?;options.SetMaxCount(max).map_err(error)?;let fields=options.FetchProperties().map_err(error)?;
    for property in [AppointmentProperties::Subject as fn()->windows::core::Result<HSTRING>,AppointmentProperties::StartTime,AppointmentProperties::Duration,AppointmentProperties::Location,AppointmentProperties::Details,AppointmentProperties::DetailsKind,AppointmentProperties::AllDay,AppointmentProperties::Reminder,AppointmentProperties::Recurrence,AppointmentProperties::Uri,AppointmentProperties::OriginalStartTime,AppointmentProperties::BusyStatus,AppointmentProperties::IsCanceledMeeting]{fields.Append(&property().map_err(error)?).map_err(error)?;}
    Ok(options)
}
fn task_row(task:&UserDataTask,list:&str)->Result<Value,Value>{
    if task.ListId().map_err(error)?.to_string()!=list{return Err(failure("provider_failed","native task list identity differs from the selected list"));}
    let completed=optional(task.CompletedDate())?;let mut row=json!({"id":identity(list,&task.Id().map_err(error)?.to_string()),"listId":list,"title":task.Subject().map_err(error)?.to_string(),"isCompleted":completed.is_some(),"priority":match task.Priority().map_err(error)?{UserDataTaskPriority::High=>"high",UserDataTaskPriority::Low=>"low",UserDataTaskPriority::Normal=>"medium",_=>return Err(failure("provider_failed","unknown native task priority"))}});
    if let Some(d)=completed{row["completionDate"]=iso(from_date(d.Value().map_err(error)?)?)?.into();}
    let notes=task.Details().map_err(error)?.to_string();if !notes.is_empty(){if task.DetailsKind().map_err(error)?!=UserDataTaskDetailsKind::PlainText{return Err(failure("unsupported_operation","native task notes are HTML; no plain-text conversion was inferred"));}row["notes"]=notes.into();}
    for(key,value)in[("dueDateComponents",task.DueDate()),("startDateComponents",task.StartDate())]{if let Some(d)=optional(value)?{let d=from_date(d.Value().map_err(error)?)?;row[key]=json!({"year":d.year(),"month":d.month()as u8,"day":d.day(),"hour":d.hour(),"minute":d.minute(),"second":d.second(),"timeZone":"GMT"});}}
    if let Some(reminder)=optional(task.Reminder())?{row["alarms"]=json!([{"relativeOffset":0,"absoluteDate":iso(from_date(reminder.Value().map_err(error)?)?)?}]);}
    if task.Kind().map_err(error)?!=UserDataTaskKind::Single{return Err(failure("unsupported_operation","recurring/regenerating Windows tasks need complete rule normalization before a positive result"));}
    Ok(row)
}
fn task_snapshot(task:&UserDataTask)->Result<Value,Value>{
    let ticks=|value:windows::core::Result<IReference<DateTime>>|->Result<Value,Value>{Ok(match optional(value)?{Some(value)=>json!(value.Value().map_err(error)?.UniversalTime),None=>Value::Null})};
    Ok(json!({"title":task.Subject().map_err(error)?.to_string(),"notes":task.Details().map_err(error)?.to_string(),"detailsKind":task.DetailsKind().map_err(error)?.0,"priority":task.Priority().map_err(error)?.0,"start":ticks(task.StartDate())?,"due":ticks(task.DueDate())?,"completed":ticks(task.CompletedDate())?,"reminder":ticks(task.Reminder())?,"kind":task.Kind().map_err(error)?.0}))
}
fn verify_event(expected:&Value,actual:&Value)->Result<(),Value>{
    // The store derives the other recurrence bound (Until or Occurrences) on save; only the requested one must match.
    let mut actual=actual.clone();if let(Some(want),Some(have))=(expected.pointer("/recurrenceRules/0/end").and_then(Value::as_object),actual.pointer_mut("/recurrenceRules/0/end").and_then(Value::as_object_mut)){have.retain(|key,_|want.contains_key(key));}
    for key in ["title","startDate","endDate","isAllDay","location","notes","url","alarms","recurrenceRules"]{
        if expected[key]!=actual[key]{return Err(committed(failure("provider_failed",format!("native appointment {key} differs after save"))));}
    }Ok(())
}
fn unique_default(ids:Vec<String>,variable:&str)->Result<Option<String>,Value>{if let Ok(configured)=std::env::var(variable){if ids.contains(&configured){return Ok(Some(configured));}return Err(failure("target_gone",format!("configured{variable} is not an app-owned native store")));}if ids.len()==1{Ok(ids.into_iter().next())}else if ids.is_empty(){Ok(None)}else{Err(failure("target_gone",format!("Windows exposes no OS default through this API; configure exact{variable} when owned stores are ambiguous")))}}
pub(crate) fn native(a:&Value)->Result<Value,Value>{
    let request=a["sub"]=="request";unsafe{RoInitialize(if request{RO_INIT_SINGLETHREADED}else{RO_INIT_MULTITHREADED}).map_err(error)?;}let _runtime=Runtime;crate::contacts_windows::installed_identity()?;
    let calendar=a["type"]=="desktop_calendar";let sub=a["sub"].as_str().unwrap();let native=Native{deadline:Instant::now()+Duration::from_secs(48)};let capability=scope(calendar)?;
    if sub=="status"{let value=authorization(capability.CheckAccess().map_err(error)?);return Ok(if calendar{json!({"events":value,"reminders":authorization(scope(false)?.CheckAccess().map_err(error)?),"provider":"windows-appointments","scope":"all-calendar-read/app-calendar-write"})}else{json!({"status":value,"provider":"windows-user-data-tasks","scope":"all-tasks-limited-read/app-tasks-write"})});}
    if request{let value=native.wait(capability.RequestAccessAsync())?;if value!=AppCapabilityAccessStatus::Allowed{return Ok(if calendar{json!({"level":a["level"].as_str().unwrap_or("full"),"granted":false,"error":authorization(value)})}else{json!({"granted":false,"error":authorization(value)})});}if calendar{native.calendars(a["level"]=="write")?;}else{native.tasks(false)?;}return Ok(if calendar{json!({"level":a["level"].as_str().unwrap_or("full"),"granted":true,"error":"Windows native grants are scoped: appointment reads and app-owned calendar writes, or limited task reads and app-owned task writes"})}else{json!({"granted":true,"error":null})});}
    if capability.CheckAccess().map_err(error)?!=AppCapabilityAccessStatus::Allowed{return Err(failure("permission_denied","native appointment/task access is not allowed; only explicit request may ask for consent"));}
    if calendar{calendar_native(a,&native)}else{reminders_native(a,&native)}
}
// Interceptor's own user data account is the Windows counterpart of a local calendar source. Windows grants writes
// only there: UserDataAccountStoreAccessType.AppAccountsReadWrite is "read/write access to the current app's user data
// accounts" and AppointmentStoreAccessType.AppCalendarsReadWrite covers "appointment calendars created by the calling app"
// (winrt-api userdataaccountstoreaccesstype.md, appointmentstoreaccesstype.md). System and other apps' accounts stay read-only.
const OWNED_SOURCE:&str="windows-account:interceptor";const OWNED_ACCOUNT_NAME:&str="Interceptor";
fn owned_account(n:&Native,create:bool)->Result<Option<UserDataAccount>,Value>{
    let store=n.wait(UserDataAccountManager::RequestStoreAsync(UserDataAccountStoreAccessType::AppAccountsReadWrite))?;
    let accounts=n.wait(store.FindAccountsAsync())?;
    for index in 0..accounts.Size().map_err(error)?{let account=accounts.GetAt(index).map_err(error)?;if account.UserDisplayName().map_err(error)?.to_string()==OWNED_ACCOUNT_NAME{return Ok(Some(account));}}
    if !create{return Ok(None);}
    n.mutation(||store.CreateAccountAsync(&HSTRING::from(OWNED_ACCOUNT_NAME))).map(Some)
}
fn calendar_native(a:&Value,n:&Native)->Result<Value,Value>{
    let sub=a["sub"].as_str().unwrap();let store=n.calendars(matches!(sub,"create-calendar"|"delete-calendar"|"create"|"update"|"delete"|"move"))?;
    if matches!(sub,"reset"){return Ok(json!({"ok":true}));} // Owned helper's native store is discarded on exit.
    // The store keeps a named change tracker across processes; tail counts its unaccepted changes.
    if sub=="tail"{
        let tracker=store.GetChangeTracker(&HSTRING::from("interceptor-calendar-tail")).map_err(error)?;
        if !tracker.IsTracking().map_err(error)?{tracker.Enable().map_err(error)?;return crate::snapshot::calendar_tail_count(0);}
        let reader=tracker.GetChangeReader().map_err(error)?;let mut count=0u64;
        loop{let batch=n.wait(reader.ReadBatchAsync())?;let size=batch.Size().map_err(error)?;if size==0{break;}
            for index in 0..size{if batch.GetAt(index).and_then(|c|c.ChangeType()).map_err(error)?==AppointmentStoreChangeType::ChangeTrackingLost{tracker.Reset().map_err(error)?;tracker.Enable().map_err(error)?;return crate::snapshot::calendar_tail_count(0);}}
            count+=size as u64;if count>=1_000_000{break;}}
        return crate::snapshot::calendar_tail_count(count);
    }
    if sub=="sources"{
        let owned_id=owned_account(n,false)?.map(|account|account.Id()).transpose().map_err(error)?.map(|id|id.to_string());
        let mut sources=std::collections::BTreeMap::new();sources.insert(OWNED_SOURCE.to_string(),json!({"id":OWNED_SOURCE,"title":OWNED_ACCOUNT_NAME,"type":"local"}));for book in n.books(&store)?{let id=book.UserDataAccountId().map_err(error)?.to_string();if id.is_empty()||Some(&id)==owned_id.as_ref(){continue;}let row=json!({"id":id,"title":book.SourceDisplayName().map_err(error)?.to_string(),"type":"userDataAccount"});if sources.get(&id).is_some_and(|prior|prior!=&row){return Err(failure("target_ambiguous","native account source has inconsistent names; no title selected arbitrarily"));}sources.insert(id,row);}return Ok(json!({"sources":sources.into_values().collect::<Vec<_>>()}));
    }
    if sub=="event-by-external"{
        let options=appointment_options(12001)?;let mut rows=Vec::new();let mut scanned=0;for book in n.books(&store)?{let appointments=n.wait(book.FindUnexpandedAppointmentsAsyncWithOptions(&options))?;for index in 0..appointments.Size().map_err(error)?{scanned+=1;if scanned>12000{return Err(failure("resource_limit","native roaming ID lookup exceeds 12000 appointments"));}let event=appointments.GetAt(index).map_err(error)?;if event.RoamingId().map_err(error)?.to_string()==a["id"].as_str().unwrap(){rows.push(event_row(&event)?);}}}let(limit,offset)=page(a);let more=rows.len()>limit+offset;return Ok(json!({"events":rows.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"limit":limit,"offset":offset,"hasMore":more}));
    }
    let owned=n.books(&n.calendars(true)?)?.into_iter().map(|b|b.LocalId().map(calendar_id)).collect::<windows::core::Result<Vec<_>>>().map_err(error)?;
    if sub=="list"{return Ok(json!({"calendars":n.books(&store)?.iter().map(|b|{let id=calendar_id(b.LocalId().map_err(error)?);calendar_row(b,owned.contains(&id))}).collect::<Result<Vec<_>,Value>>()?}));}
    if sub=="default"{return match unique_default(owned,"INTERCEPTOR_WINDOWS_DEFAULT_CALENDAR")?{Some(id)=>calendar_row(&n.book(&store,&id)?,true),None=>Ok(json!({"calendar":null}))};}
    if sub=="create-calendar"{
        if a["cal_type"].as_str().is_some_and(|value|value!="local"){return Err(failure("unsupported_operation","Windows creates app-owned calendars; no CalDAV/Exchange source conversion inferred"));}
        let title=HSTRING::from(a["title"].as_str().unwrap());let mut in_account=None;
        let book=match a["source"].as_str(){
            None=>n.mutation(||store.CreateAppointmentCalendarAsync(&title))?,
            Some(OWNED_SOURCE)=>{let account=owned_account(n,true)?.ok_or_else(||failure("provider_failed","Interceptor's own calendar account could not be created"))?;let account_id=account.Id().map_err(error)?;let book=n.mutation(||store.CreateAppointmentCalendarInAccountAsync(&title,&account_id))?;in_account=Some(account_id);book}
            Some(_)=>return Err(failure("unsupported_operation","Windows writes calendars only into Interceptor's own account (windows-account:interceptor): AppAccountsReadWrite is read/write access to the current app's user data accounts, and AppCalendarsReadWrite covers calendars created by the calling app; system and other apps' accounts are read-only")),
        };
        let id=calendar_id(book.LocalId().map_err(|e|committed(error(e)))?);
        if let Some(raw)=a["color"].as_str(){let rgb=u32::from_str_radix(&raw[1..],16).unwrap();book.SetDisplayColor(windows::UI::Color{A:255,R:(rgb>>16)as u8,G:(rgb>>8)as u8,B:rgb as u8}).map_err(|e|committed(error(e)))?;n.action(||book.SaveAsync()).map_err(committed)?;}
        let saved=n.book(&n.calendars(true).map_err(committed)?,&id).map_err(committed)?;if saved.DisplayName().map_err(|e|committed(error(e)))?.to_string()!=a["title"].as_str().unwrap(){return Err(committed(failure("provider_failed","native calendar title differs after create")));}
        if let Some(raw)=a["color"].as_str(){let rgb=u32::from_str_radix(&raw[1..],16).unwrap();let actual=saved.DisplayColor().map_err(|e|committed(error(e)))?;if actual.A!=255||actual.R!=(rgb>>16)as u8||actual.G!=(rgb>>8)as u8||actual.B!=rgb as u8{return Err(committed(failure("provider_failed","native calendar color differs after create")));}}
        let mut row=calendar_row(&saved,true).map_err(committed)?;
        if let Some(account_id)=in_account{
            if saved.UserDataAccountId().map_err(|e|committed(error(e)))?!=account_id{return Err(committed(failure("provider_failed","native calendar is not in Interceptor's own account after create")));}
            row["source"]=json!({"id":OWNED_SOURCE,"title":OWNED_ACCOUNT_NAME,"type":"local"});
        }
        return Ok(row);
    }
    if sub=="delete-calendar"{let id=a["id"].as_str().unwrap();let book=n.book(&store,id)?;n.action(||book.DeleteAsync())?;for remaining in n.books(&n.calendars(true).map_err(committed)?).map_err(committed)?{if calendar_id(remaining.LocalId().map_err(|e|committed(error(e)))?)==id{return Err(committed(failure("provider_failed","native calendar identity remains after delete")));}}return Ok(json!({"ok":true,"id":id}));}
    if sub=="refresh-sources"{for book in n.books(&store)?{
        // Local calendars have no sync manager (null); there is nothing to refresh, as on Linux.
        let Some(manager)=optional(book.SyncManager())? else{continue;};if !n.wait(manager.SyncAsync())?{return Err(failure("provider_failed","native calendar synchronization refused"));}}return Ok(json!({"ok":true}));}
    if sub=="events"{
        let start=native_date(a["start"].as_str().unwrap())?;let end=native_date(a["end"].as_str().unwrap())?;let span=TimeSpan{Duration:end.UniversalTime-start.UniversalTime};let(limit,offset)=page(a);let options=appointment_options((offset+limit+1)as u32)?;
        let mut rows=Vec::new();if let Some(id)=a["calendar"].as_str(){let book=n.book(&store,id)?;let events=n.wait(book.FindAppointmentsAsyncWithOptions(start,span,&options))?;for index in 0..events.Size().map_err(error)?{rows.push(event_row(&events.GetAt(index).map_err(error)?)?);}}else if let Some(ids)=a["calendars"].as_str(){for id in ids.split(','){let book=n.book(&store,id)?;let events=n.wait(book.FindAppointmentsAsyncWithOptions(start,span,&options))?;for index in 0..events.Size().map_err(error)?{if rows.len()>=12000{return Err(failure("resource_limit","native multi-calendar query exceeds 12000 rows"));}rows.push(event_row(&events.GetAt(index).map_err(error)?)?);}}}else{let events=n.wait(store.FindAppointmentsAsyncWithOptions(start,span,&options))?;for index in 0..events.Size().map_err(error)?{rows.push(event_row(&events.GetAt(index).map_err(error)?)?);}}
        rows.sort_by(|a,b|a["startDate"].as_str().cmp(&b["startDate"].as_str()));let more=rows.len()>offset+limit;return Ok(json!({"events":rows.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"limit":limit,"offset":offset,"hasMore":more}));
    }
    if let(series,Some(seconds))=crate::eventkit::split_occurrence(a["id"].as_str().unwrap_or_default()){
        let start=time::OffsetDateTime::from_unix_timestamp(seconds).map_err(|_|failure("target_gone","invalid native occurrence instant")).and_then(to_native)?;
        let occurrence=match n.wait(store.GetAppointmentInstanceAsync(&HSTRING::from(series),start)){Ok(o)=>o,Err(e)if e["details"]["nativeHRESULT"].as_i64().is_some_and(|code|crate::windows::null_result(code as i32))=>return Err(failure("target_gone","no occurrence of that series starts at that instant")),Err(e)=>return Err(e)};
        if occurrence_id(&occurrence)?!=a["id"].as_str().unwrap_or_default(){return Err(failure("target_gone","no occurrence of that series starts at that instant"));}
        if sub=="event"{return event_row(&occurrence);}
        return occurrence_mutation(n,&store,sub,a,series,start);
    }
    if sub=="event"{return event_row(&n.wait(store.GetAppointmentAsync(&HSTRING::from(a["id"].as_str().unwrap())))?);}
    let event=if sub=="create"{Appointment::new().map_err(error)?}else{n.wait(store.GetAppointmentAsync(&HSTRING::from(a["id"].as_str().unwrap())))?};
    // From the series master, "future" is the whole series, which Windows deletes as one item.
    let series=sub=="delete"&&a["span"]=="future"&&optional(event.OriginalStartTime())?.is_none();
    if matches!(sub,"update"|"delete")&&!series&&optional(event.Recurrence())?.is_some(){return occurrence_mutation(n,&store,sub,a,&event.LocalId().map_err(error)?.to_string(),event.StartTime().map_err(error)?);}
    if sub=="delete"{let id=a["id"].as_str().unwrap();let book=n.book(&store,&calendar_id(event.CalendarId().map_err(error)?))?;n.action(||book.DeleteAppointmentAsync(&HSTRING::from(id)))?;match n.wait(n.calendars(true).map_err(committed)?.GetAppointmentAsync(&HSTRING::from(id))){Err(e)if e["details"]["nativeHRESULT"].as_i64().is_some_and(|code|crate::windows::null_result(code as i32))=>return Ok(json!({"ok":true,"id":id})),_=>return Err(committed(failure("provider_failed","native appointment deletion lacks absence readback")))} }
    if sub=="move"{let target=n.book(&store,a["to"].as_str().unwrap())?;n.book(&store,&calendar_id(event.CalendarId().map_err(error)?))?;n.action(||store.MoveAppointmentAsync(&event,&target))?;let id=event.LocalId().map_err(error)?.to_string();let saved=n.wait(n.calendars(true).map_err(committed)?.GetAppointmentAsync(&HSTRING::from(id))).map_err(committed)?;if calendar_id(saved.CalendarId().map_err(error)?)!=a["to"].as_str().unwrap(){return Err(committed(failure("provider_failed","native move target differs after commit")));}return event_row(&saved);}
    apply_event(a,&event)?;
    let expected=event_row(&event)?;
    let book=if sub=="create"{let id=match a["calendar"].as_str(){Some(id)=>id.to_owned(),None=>unique_default(owned,"INTERCEPTOR_WINDOWS_DEFAULT_CALENDAR")?.ok_or_else(||failure("target_gone","no owned default calendar; create one and pass its exact identity"))?};n.book(&store,&id)?}else{n.book(&store,&calendar_id(event.CalendarId().map_err(error)?))?};
    n.action(||book.SaveAppointmentAsync(&event))?;let id=event.LocalId().map_err(|e|committed(error(e)))?.to_string();let saved=n.wait(n.calendars(true).map_err(committed)?.GetAppointmentAsync(&HSTRING::from(id))).map_err(committed)?;let result=event_row(&saved).map_err(committed)?;if result["calendarId"]!=calendar_id(book.LocalId().map_err(|e|committed(error(e)))?){return Err(committed(failure("provider_failed","native save target differs after commit")));}verify_event(&expected,&result)?;Ok(result)
}
// Rows read from a calendar range are instances that share the series LocalId, so deleting "that row"
// with --span future used to delete the whole series. An instance's id adds its
// original start (crate::eventkit::split_occurrence); the series id alone still names the series.
fn occurrence_id(event:&Appointment)->Result<String,Value>{
    let local=event.LocalId().map_err(error)?.to_string();
    // ponytail: whole seconds, as every create path writes; a sub-second instance start reads back target_gone.
    Ok(match optional(event.OriginalStartTime())?{Some(original)=>format!("{local}@{}",from_date(original.Value().map_err(error)?)?.unix_timestamp()),None=>local})
}
const DAY:i64=864_000_000_000;
/// The series' exceptions as (original start, deleted).
fn exceptions(n:&Native,book:&AppointmentCalendar,series:&str)->Result<Vec<(DateTime,bool)>,Value>{
    let rows=n.wait(book.FindExceptionsFromMasterAsync(&HSTRING::from(series)))?;let mut out=vec![];
    for index in 0..rows.Size().map_err(error)?{let row=rows.GetAt(index).map_err(error)?;let Some(original)=optional(row.Appointment().and_then(|a:Appointment|a.OriginalStartTime()))? else{continue;};out.push((original.Value().map_err(error)?,row.IsDeleted().map_err(error)?));}
    Ok(out)
}
/// Ends the series just before the occurrence at `start`, keeping its earlier exceptions: a series
/// with an end deletes its remaining instances one by one, because saving a changed recurrence drops the series'
/// exceptions; an endless series is shortened (Windows reads Until as an inclusive date), earlier deleted
/// occurrences are deleted again, and an earlier edited occurrence refuses before any change.
fn end_series_before(n:&Native,book:&AppointmentCalendar,master:&Appointment,series:&str,start:DateTime)->Result<(),Value>{
    let rule=optional(master.Recurrence())?.ok_or_else(||failure("target_gone","the series has no recurrence; no change was made"))?;
    let until=optional(rule.Until())?.map(|v|v.Value().map_err(error)).transpose()?;let count=optional(rule.Occurrences())?.map(|v|v.Value().map_err(error)).transpose()?;
    if until.is_some()||count.is_some(){
        let days=match rule.Unit().map_err(error)?{AppointmentRecurrenceUnit::Daily=>1,AppointmentRecurrenceUnit::Weekly=>7,AppointmentRecurrenceUnit::Monthly|AppointmentRecurrenceUnit::MonthlyOnDay=>31,_=>366};
        let window=match until{Some(until)=>(until.UniversalTime-start.UniversalTime)/DAY+2,None=>days*rule.Interval().map_err(error)?.max(1)as i64*(count.unwrap_or(0)as i64+1)}.clamp(1,36_600);
        let remaining=||->Result<Vec<DateTime>,Value>{let rows=n.wait(book.FindAppointmentsAsyncWithOptions(start,TimeSpan{Duration:window*DAY},&appointment_options(1001)?))?;let mut at=vec![];
            for index in 0..rows.Size().map_err(error)?{let row=rows.GetAt(index).map_err(error)?;if row.LocalId().map_err(error)?.to_string()==series{if let Some(original)=optional(row.OriginalStartTime())?{let value=original.Value().map_err(error)?;if value.UniversalTime>=start.UniversalTime{at.push(value);}}}}Ok(at)};
        let targets=remaining()?;if targets.len()>1000{return Err(failure("resource_limit","more than 1000 occurrences follow this one; no change was made"));}
        for(index,at)in targets.into_iter().enumerate(){n.action(||book.DeleteAppointmentInstanceAsync(&HSTRING::from(series),at)).map_err(|e|if index==0{e}else{committed(e)})?;}
        if !remaining().map_err(committed)?.is_empty(){return Err(committed(failure("provider_failed","later occurrences remain after the native deletes")));}
    }else{
        let mut deleted=vec![];
        for(at,gone)in exceptions(n,book,series)?{if at.UniversalTime>=start.UniversalTime{continue;}if gone{deleted.push(at);}else{return Err(failure("unsupported_operation","an earlier occurrence of this endless series was edited, and ending the series would discard that edit; no change was made"));}}
        let until=local_midnight(local_date(start)?.previous_day().ok_or_else(||failure("invalid_request","occurrence date is outside the native range"))?)?;
        rule.SetOccurrences(None::<&IReference<u32>>).map_err(error)?;rule.SetUntil(&reference_date(until)?).map_err(error)?;master.SetRecurrence(&rule).map_err(error)?;
        n.action(||book.SaveAppointmentAsync(master))?;
        for at in deleted{n.action(||book.DeleteAppointmentInstanceAsync(&HSTRING::from(series),at)).map_err(committed)?;}
    }
    Ok(())
}
fn reschedules(a:&Value)->bool{["start","end","all_day","recurrence_frequency","recurrence_interval","recurrence_end"].iter().any(|k|a.get(*k).is_some())}
// An occurrence (a series id names its first one, as in EventKit). "this" changes or deletes only that instance;
// "future" from the first occurrence is the whole series, and from a later one deletes the rest or splits the
// series there. Moving one occurrence to another calendar is refused.
fn occurrence_mutation(n:&Native,store:&AppointmentStore,sub:&str,a:&Value,series:&str,start:DateTime)->Result<Value,Value>{
    if sub=="move"{return Err(failure("unsupported_operation","one occurrence cannot move to another calendar; move the series by its id; no change was made"));}
    let master=n.wait(store.GetAppointmentAsync(&HSTRING::from(series)))?;
    let book=n.book(store,&calendar_id(master.CalendarId().map_err(error)?))?;
    let first=local_date(start)?<=local_date(master.StartTime().map_err(error)?)?;let future=a["span"]=="future";
    let target=format!("{series}@{}",from_date(start)?.unix_timestamp());
    if sub=="update"{
        if !future{
            if ["recurrence_frequency","recurrence_interval","recurrence_end"].iter().any(|k|a.get(*k).is_some()){return Err(failure("invalid_request","one occurrence has no recurrence of its own; change the recurrence with --span future; no change was made"));}
            // GetAppointmentInstanceAsync + SaveAppointmentAsync stores the changed instance as an exception.
            let instance=n.wait(book.GetAppointmentInstanceAsync(&HSTRING::from(series),start))?;
            apply_event(a,&instance)?;let expected=event_row(&instance)?;
            n.action(||book.SaveAppointmentAsync(&instance))?;
            let saved=n.wait(book.GetAppointmentInstanceAsync(&HSTRING::from(series),start)).map_err(committed)?;let result=event_row(&saved).map_err(committed)?;
            if result["id"]!=json!(target){return Err(committed(failure("provider_failed","the saved occurrence has a different identity")));}
            verify_event(&expected,&result)?;return Ok(result);
        }
        let before=exceptions(n,&book,series)?;
        if first{
            // The whole series. Changing its times or recurrence would discard its edited occurrences.
            if reschedules(a)&&before.iter().any(|(_,gone)|!gone){return Err(failure("unsupported_operation","this series has an edited occurrence, and changing the series' times or recurrence would discard that edit; no change was made"));}
            apply_event(a,&master)?;let expected=event_row(&master)?;
            n.action(||book.SaveAppointmentAsync(&master))?;
            if !reschedules(a){for(at,gone)in &before{if *gone&&!exceptions(n,&book,series).map_err(committed)?.iter().any(|(t,g)|*g&&t.UniversalTime==at.UniversalTime){n.action(||book.DeleteAppointmentInstanceAsync(&HSTRING::from(series),*at)).map_err(committed)?;}}}
            let after=exceptions(n,&book,series).map_err(committed)?;
            if before.iter().any(|(at,gone)|!gone&&!after.iter().any(|(t,g)|!g&&t.UniversalTime==at.UniversalTime)){return Err(committed(failure("provider_failed","an edited occurrence lost its changes when the series was saved")));}
            let saved=n.wait(store.GetAppointmentAsync(&HSTRING::from(series))).map_err(committed)?;let result=event_row(&saved).map_err(committed)?;verify_event(&expected,&result)?;return Ok(result);
        }
        // A split: the series from this occurrence on becomes a new series with the changes, then the original
        // ends before it. Edited occurrences from here on would be lost, so they refuse before any change.
        if before.iter().any(|(at,gone)|!gone&&at.UniversalTime>=start.UniversalTime){return Err(failure("unsupported_operation","an edited occurrence follows this one, and splitting the series here would lose that edit; no change was made"));}
        let rule=optional(master.Recurrence())?.ok_or_else(||failure("target_gone","the series has no recurrence; no change was made"))?;
        let copy=Appointment::new().map_err(error)?;
        copy.SetSubject(&master.Subject().map_err(error)?).map_err(error)?;copy.SetLocation(&master.Location().map_err(error)?).map_err(error)?;
        copy.SetDetailsKind(master.DetailsKind().map_err(error)?).map_err(error)?;copy.SetDetails(&master.Details().map_err(error)?).map_err(error)?;
        if let Some(uri)=optional(master.Uri())?{copy.SetUri(&uri).map_err(error)?;}if let Some(reminder)=optional(master.Reminder())?{copy.SetReminder(&reminder).map_err(error)?;}
        copy.SetAllDay(master.AllDay().map_err(error)?).map_err(error)?;copy.SetBusyStatus(master.BusyStatus().map_err(error)?).map_err(error)?;copy.SetSensitivity(master.Sensitivity().map_err(error)?).map_err(error)?;
        copy.SetStartTime(start).map_err(error)?;copy.SetDuration(master.Duration().map_err(error)?).map_err(error)?;
        let r=AppointmentRecurrence::new().map_err(error)?;
        r.SetUnit(rule.Unit().map_err(error)?).map_err(error)?;r.SetInterval(rule.Interval().map_err(error)?).map_err(error)?;r.SetDaysOfWeek(rule.DaysOfWeek().map_err(error)?).map_err(error)?;
        r.SetWeekOfMonth(rule.WeekOfMonth().map_err(error)?).map_err(error)?;r.SetMonth(rule.Month().map_err(error)?).map_err(error)?;r.SetDay(rule.Day().map_err(error)?).map_err(error)?;
        if let Some(until)=optional(rule.Until())?{r.SetUntil(&until).map_err(error)?;}
        else if let Some(count)=optional(rule.Occurrences())?{
            let earlier=n.wait(book.FindAppointmentsAsyncWithOptions(master.StartTime().map_err(error)?,TimeSpan{Duration:start.UniversalTime-master.StartTime().map_err(error)?.UniversalTime},&appointment_options(1001)?))?;let mut used=before.iter().filter(|(at,gone)|*gone&&at.UniversalTime<start.UniversalTime).count()as u32;
            for index in 0..earlier.Size().map_err(error)?{let row=earlier.GetAt(index).map_err(error)?;if row.LocalId().map_err(error)?.to_string()==series&&optional(row.OriginalStartTime())?.map(|v|v.Value().map_err(error)).transpose()?.is_some_and(|v|v.UniversalTime<start.UniversalTime){used+=1;}}
            let left=count.Value().map_err(error)?.saturating_sub(used);if left==0{return Err(failure("target_gone","no occurrence of the series starts at or after this one"));}
            let value:IReference<u32>=PropertyValue::CreateUInt32(left).and_then(|v|v.cast()).map_err(error)?;r.SetOccurrences(&value).map_err(error)?;
        }
        copy.SetRecurrence(&r).map_err(error)?;
        apply_event(a,&copy)?;let expected=event_row(&copy)?;
        n.action(||book.SaveAppointmentAsync(&copy))?;
        let new_id=copy.LocalId().map_err(|e|committed(error(e)))?.to_string();
        let saved=n.wait(store.GetAppointmentAsync(&HSTRING::from(new_id.as_str()))).map_err(committed)?;let result=event_row(&saved).map_err(committed)?;verify_event(&expected,&result).map_err(committed)?;
        let detail=|mut e:Value|{e=committed(e);e["details"]["newSeriesId"]=json!(new_id);e};
        if !reschedules(a){for(at,gone)in &before{if *gone&&at.UniversalTime>=start.UniversalTime{n.action(||book.DeleteAppointmentInstanceAsync(&HSTRING::from(new_id.as_str()),*at)).map_err(detail)?;}}}
        end_series_before(n,&book,&master,series,start).map_err(detail)?;
        return Ok(result);
    }
    if future{
        if first{return Err(failure("invalid_request","this is the first occurrence; delete the series by its id with --span future; no change was made"));}
        end_series_before(n,&book,&master,series,start)?;
    }else{
        n.action(||book.DeleteAppointmentInstanceAsync(&HSTRING::from(series),start))?;
    }
    let found=n.wait(book.FindAppointmentsAsyncWithOptions(start,TimeSpan{Duration:10_000_000},&appointment_options(64)?)).map_err(committed)?;
    for index in 0..found.Size().map_err(|e|committed(error(e)))?{let row=found.GetAt(index).map_err(|e|committed(error(e)))?;if occurrence_id(&row).map_err(committed)?==target{return Err(committed(failure("provider_failed","the occurrence remains after the native change")));}}
    Ok(json!({"ok":true,"id":a["id"]}))
}
fn apply_event(a:&Value,event:&Appointment)->Result<(),Value>{
    for(key,set)in[("title",Appointment::SetSubject as fn(&Appointment,&HSTRING)->windows::core::Result<()>),("location",Appointment::SetLocation),("notes",Appointment::SetDetails)]{if let Some(text)=a[key].as_str(){set(event,&HSTRING::from(text)).map_err(error)?;if key=="notes"{event.SetDetailsKind(AppointmentDetailsKind::PlainText).map_err(error)?;}}}
    let old_start=event.StartTime().map_err(error)?;let mut start=if let Some(raw)=a["start"].as_str(){native_date(raw)?}else{old_start};let mut end=if let Some(raw)=a["end"].as_str(){native_date(raw)?}else{DateTime{UniversalTime:old_start.UniversalTime.checked_add(event.Duration().map_err(error)?.Duration).ok_or_else(||failure("invalid_request","event duration overflows"))?}};
    if a["all_day"].as_bool().map_or_else(||event.AllDay().map_err(error),Ok)?{
        // A given boundary names a date at UTC midnight (as on EDS); a kept one keeps the local days the event covers.
        let day=|raw:Option<&str>,kept:DateTime,end:bool|->Result<DateTime,Value>{local_midnight(match raw{Some(raw)=>{let d=date(raw)?.to_offset(time::UtcOffset::UTC);if d.time()!=time::Time::MIDNIGHT{return Err(failure("invalid_request","all-day boundaries require UTC midnight"));}d.date()},None if end=>local_date(DateTime{UniversalTime:kept.UniversalTime-1})?.next_day().ok_or_else(||failure("invalid_request","event date exceeds native range"))?,None=>local_date(kept)?})};
        start=day(a["start"].as_str(),start,false)?;end=day(a["end"].as_str(),end,true)?;
    }
    if end.UniversalTime<=start.UniversalTime{return Err(failure("invalid_request","final native event interval must increase"));}event.SetStartTime(start).map_err(error)?;event.SetDuration(TimeSpan{Duration:end.UniversalTime-start.UniversalTime}).map_err(error)?;
    if let Some(value)=a["all_day"].as_bool(){event.SetAllDay(value).map_err(error)?;}if let Some(raw)=a["url"].as_str(){if raw.is_empty(){event.SetUri(None::<&Uri>).map_err(error)?;}else{event.SetUri(&Uri::CreateUri(&HSTRING::from(raw)).map_err(error)?).map_err(error)?;}}
    if let Some(alarms)=a["alarms"].as_array(){if alarms.len()>1{return Err(failure("unsupported_operation","Windows native appointments expose one reminder; no alarms discarded"));}if let Some(raw)=alarms.first().and_then(Value::as_str){let offset=match date(raw){Ok(d)=>((d.unix_timestamp_nanos()/100)+116444736000000000)-start.UniversalTime as i128,Err(_)=>(crate::eventkit::relative_alarm(raw).ok_or_else(||failure("invalid_request","invalid native relative alarm"))?*10000000.0)as i128};if offset>0||offset<i64::MIN as i128{return Err(failure("unsupported_operation","Windows reminder requires a nonpositive offset within native duration range"));}let value:IReference<TimeSpan>=PropertyValue::CreateTimeSpan(TimeSpan{Duration:-(offset as i64)}).and_then(|v|v.cast()).map_err(error)?;event.SetReminder(&value).map_err(error)?;}else{event.SetReminder(None::<&IReference<TimeSpan>>).map_err(error)?;}}
    if let Some(frequency)=a["recurrence_frequency"].as_str(){let rule=AppointmentRecurrence::new().map_err(error)?;rule.SetUnit(match frequency{"daily"=>AppointmentRecurrenceUnit::Daily,"weekly"=>AppointmentRecurrenceUnit::Weekly,"monthly"=>AppointmentRecurrenceUnit::Monthly,_=>AppointmentRecurrenceUnit::Yearly}).map_err(error)?;rule.SetInterval(integer(&a["recurrence_interval"]).unwrap_or(1)as u32).map_err(error)?;let d=local_date(start)?;if frequency=="weekly"{rule.SetDaysOfWeek(AppointmentDaysOfWeek(1<<d.weekday().number_days_from_sunday())).map_err(error)?;}if matches!(frequency,"monthly"|"yearly"){rule.SetDay(d.day()as u32).map_err(error)?;}if frequency=="yearly"{rule.SetMonth(d.month()as u32).map_err(error)?;}if let Some(raw)=a["recurrence_end"].as_str(){if let Ok(count)=raw.parse::<u32>(){let value:IReference<u32>=PropertyValue::CreateUInt32(count).and_then(|v|v.cast()).map_err(error)?;rule.SetOccurrences(&value).map_err(error)?;}else{rule.SetUntil(&reference_date(native_date(raw)?)?).map_err(error)?;}}event.SetRecurrence(&rule).map_err(error)?;}
    Ok(())
}
fn reminders_native(a:&Value,n:&Native)->Result<Value,Value>{
    let sub=a["sub"].as_str().unwrap();let write=matches!(sub,"create"|"update"|"complete"|"uncomplete"|"delete");let store=n.tasks(write)?;let owned=n.lists(&n.tasks(true)?)?.into_iter().map(|list|list.Id().map(|id|id.to_string())).collect::<windows::core::Result<Vec<_>>>().map_err(error)?;
    if sub=="lists"{return Ok(json!({"lists":n.lists(&store)?.iter().map(|list|{let id=list.Id().map_err(error)?.to_string();Ok(json!({"id":id,"title":list.DisplayName().map_err(error)?.to_string(),"allowsContentModifications":owned.contains(&id)}))}).collect::<Result<Vec<Value>,Value>>()?}));}
    if sub=="default"{return match unique_default(owned,"INTERCEPTOR_WINDOWS_DEFAULT_TASK_LIST")?{Some(id)=>{let list=n.list(&store,&id)?;Ok(json!({"id":id,"title":list.DisplayName().map_err(error)?.to_string(),"allowsContentModifications":true}))},None=>Ok(json!({"list":null}))};}
    if matches!(sub,"all"|"incomplete"|"completed"){
        let lists=if let Some(id)=a["list"].as_str(){vec![n.list(&store,id)?]}else{n.lists(&store)?};let mut rows=Vec::new();let mut scanned=0;for list in lists{let id=list.Id().map_err(error)?.to_string();let options=UserDataTaskQueryOptions::new().map_err(error)?;options.SetKind(match sub{"incomplete"=>UserDataTaskQueryKind::Incomplete,"completed"=>UserDataTaskQueryKind::Complete,_=>UserDataTaskQueryKind::All}).map_err(error)?;let reader=list.GetTaskReaderWithOptions(&options).map_err(error)?;
            loop{let tasks=n.wait(reader.ReadBatchAsync())?.Tasks().map_err(error)?;if tasks.Size().map_err(error)?==0{break;}for index in 0..tasks.Size().map_err(error)?{scanned+=1;if scanned>12000{return Err(failure("resource_limit","native task query exceeds 12000 rows"));}let task=tasks.GetAt(index).map_err(error)?;let mut include=true;for (lo,hi,field)in[("since","until",task.CompletedDate()),("due_start","due_end",task.DueDate())]{if a.get(lo).is_some()||a.get(hi).is_some(){let Some(d)=optional(field)?else{include=false;continue;};let d=d.Value().map_err(error)?.UniversalTime;if a[lo].as_str().is_some_and(|s|native_date(s).is_ok_and(|v|d<v.UniversalTime))||a[hi].as_str().is_some_and(|s|native_date(s).is_ok_and(|v|d>=v.UniversalTime)){include=false;}}}if include{rows.push(task_row(&task,&id)?);}}}
        }rows.sort_by(|a,b|a["id"].as_str().cmp(&b["id"].as_str()));let(limit,offset)=page(a);let more=rows.len()>limit+offset;return Ok(json!({"reminders":rows.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"limit":limit,"offset":offset,"hasMore":more}));
    }
    if a.get("url").is_some()||a["priority"]=="none"{return Err(failure("unsupported_operation","Windows tasks lack EventKit URL/no-priority fields; no mutation performed"));}
    // Windows lets an app write only to task lists it owns. An explicit list must be one of those;
    // without --list a fresh account gets Interceptor's own list (as Contacts does).
    let(list,task)=if sub=="create"{let list=match a["list"].as_str(){
        Some(id) if owned.iter().any(|owned|owned==id)=>n.list(&store,id)?,
        Some(_)=>return Err(failure("permission_denied","Windows lets apps add tasks only to their own lists; omit --list to use Interceptor's list")),
        None=>match unique_default(owned,"INTERCEPTOR_WINDOWS_DEFAULT_TASK_LIST")?{Some(id)=>n.list(&store,&id)?,None=>n.mutation(||store.CreateListAsync(&HSTRING::from("Interceptor")))?},
    };(list,UserDataTask::new().map_err(error)?)}else{let(list,id)=decode_identity(a["id"].as_str().unwrap())?;let list=n.list(&store,&list)?;let task=n.wait(list.GetTaskAsync(&HSTRING::from(id)))?;(list,task)};
    if task.Kind().map_err(error)?!=UserDataTaskKind::Single{return Err(failure("unsupported_operation","Windows recurring/regenerating task mutation requires exact remaining rule handling; no mutation performed"));}
    let listId=list.Id().map_err(error)?.to_string();if sub=="delete"{let id=task.Id().map_err(error)?.to_string();n.action(||list.DeleteTaskAsync(&HSTRING::from(&id)))?;match n.wait(n.list(&n.tasks(true).map_err(committed)?,&listId).map_err(committed)?.GetTaskAsync(&HSTRING::from(id))){Err(e)if e["details"]["nativeHRESULT"].as_i64().is_some_and(|code|crate::windows::null_result(code as i32))=>return Ok(json!({"ok":true,"id":a["id"]})),_=>return Err(committed(failure("provider_failed","native task deletion lacks absence readback")))} }
    if let Some(text)=a["title"].as_str(){task.SetSubject(&HSTRING::from(text)).map_err(error)?;}if let Some(text)=a["notes"].as_str(){task.SetDetailsKind(UserDataTaskDetailsKind::PlainText).map_err(error)?;task.SetDetails(&HSTRING::from(text)).map_err(error)?;}
    if let Some(priority)=a["priority"].as_str(){task.SetPriority(match priority{"high"=>UserDataTaskPriority::High,"low"=>UserDataTaskPriority::Low,_=>UserDataTaskPriority::Normal}).map_err(error)?;}
    if let Some(raw)=a["start"].as_str(){task.SetStartDate(&reference_date(native_date(raw)?)?).map_err(error)?;}if let Some(raw)=a["due"].as_str(){task.SetDueDate(&reference_date(native_date(raw)?)?).map_err(error)?;}
    if sub=="complete"{let now=time::OffsetDateTime::now_utc();let now=now.replace_nanosecond(now.nanosecond()/100*100).map_err(|_|failure("provider_failed","native completion clock is invalid"))?;task.SetCompletedDate(&reference_date(native_date(&iso(now)?)?)?).map_err(error)?;}if sub=="uncomplete"{task.SetCompletedDate(None::<&IReference<DateTime>>).map_err(error)?;}
    let expected=task_snapshot(&task)?;n.action(||list.SaveTaskAsync(&task))?;let id=task.Id().map_err(|e|committed(error(e)))?.to_string();let saved=n.wait(n.list(&n.tasks(true).map_err(committed)?,&listId).map_err(committed)?.GetTaskAsync(&HSTRING::from(id))).map_err(committed)?;
    if task_snapshot(&saved).map_err(committed)?!=expected{return Err(committed(failure("provider_failed","native task fields differ after save")));}task_row(&saved,&listId).map_err(committed)
}
