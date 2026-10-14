//! Literal-only log queries. Native stores retain their existing OS permissions.
use crate::{contract_generated::*,failure,success};
use serde_json::{Value,json};
use std::time::{Duration,Instant};
use time::{OffsetDateTime,format_description::well_known::Rfc3339};

#[derive(Debug)]
pub struct Term{pub field:String,pub contains:bool,pub value:String}
pub struct Query{pub request:DesktopLogQueryAction,pub terms:Vec<Term>,pub since:OffsetDateTime,pub started:Instant}
pub fn timestamp(value:&str)->Option<OffsetDateTime>{
    let b=value.as_bytes();
    if b.len()<20||b.get(4)!=Some(&b'-')||b.get(7)!=Some(&b'-')||b.get(10)!=Some(&b'T')||b.get(13)!=Some(&b':')||b.get(16)!=Some(&b':'){return None;}
    if [0..4,5..7,8..10,11..13,14..16,17..19].iter().any(|range|!b[range.clone()].iter().all(u8::is_ascii_digit)){return None;}
    let mut end=19;
    if b.get(end)==Some(&b'.'){
        end+=1;let start=end;while b.get(end).is_some_and(u8::is_ascii_digit){end+=1;}
        if end==start||end-start>9{return None;}
    }
    let offset=&b[end..];
    if offset!=b"Z"&&!(offset.len()==6&&[b'+',b'-'].contains(&offset[0])&&offset[3]==b':'&&[1,2,4,5].iter().all(|i|offset[*i].is_ascii_digit())){return None;}
    let date=OffsetDateTime::parse(value,&Rfc3339).ok()?;
    (date.year()>=1&&date.second()<60).then_some(date)
}
pub fn predicate(value:&str)->Result<Vec<Term>,String>{
    if value.len()>4096{return Err("log predicate exceeds 4096 bytes".into());}
    let mut rest=value.trim();let mut terms=Vec::new();
    while !rest.is_empty(){
        let field=["subsystem","category","message","process","level"].iter().find(|field|rest.starts_with(**field)).ok_or("log predicate requires a known field")?;
        rest=rest[field.len()..].trim_start();
        let contains=if let Some(next)=rest.strip_prefix("=="){rest=next;false}else if let Some(next)=rest.strip_prefix("CONTAINS"){rest=next;true}else{return Err("log predicate requires == or CONTAINS".into());};
        rest=rest.trim_start();if !rest.starts_with('"'){return Err("log predicate requires a JSON string literal".into());}
        let mut escaped=false;let mut end=None;
        for(index,byte)in rest.bytes().enumerate().skip(1){
            if escaped{escaped=false;continue;}
            if byte==b'\\'{escaped=true;}else if byte==b'"'{end=Some(index+1);break;}
        }
        let end=end.ok_or("unterminated log predicate literal")?;
        let literal:String=serde_json::from_str(&rest[..end]).map_err(|_|"invalid log predicate string literal")?;
        if literal.contains('\0')||terms.len()>=16{return Err("log predicate exceeds its literal or term bounds".into());}
        terms.push(Term{field:field.to_string(),contains,value:literal});
        rest=rest[end..].trim_start();if rest.is_empty(){break;}
        let next=rest.strip_prefix("AND").ok_or("log predicate supports AND between comparisons")?;
        if !next.starts_with(char::is_whitespace)||next.trim().is_empty(){return Err("log predicate ends with AND or has no separator".into());}
        rest=next.trim_start();
    }
    Ok(terms)
}
pub fn validate(action:&Value)->Result<Query,Value>{
    if let Some(error)=desktop_log_shape_error(action){return Err(failure("invalid_request",error));}
    let request:DesktopLogQueryAction=serde_json::from_value(action.clone()).map_err(|_|failure("invalid_request","invalid log fields"))?;
    if request.limit.is_some_and(|n|!n.is_finite()||n.fract()!=0.0||!(1.0..=DESKTOP_LOG_MAX_ENTRIES as f64).contains(&n)){return Err(failure("invalid_request","log limit must be an integer in 1..1000"));}
    let since=match &request.since{Some(value)=>timestamp(value).ok_or_else(||failure("invalid_request","log since requires a valid RFC3339 timestamp"))?,None=>OffsetDateTime::now_utc()-time::Duration::seconds(300)};
    let terms=predicate(request.predicate.as_deref().unwrap_or("")).map_err(|error|failure("invalid_request",error))?;
    Ok(Query{request,terms,since,started:Instant::now()})
}
impl Query{
    pub fn check_budget(&self,scanned:usize)->Result<(),Value>{
        if self.started.elapsed()>Duration::from_millis(DESKTOP_LOG_DEADLINE_MS as u64)||scanned>=DESKTOP_LOG_MAX_SCAN_ENTRIES{return Err(failure("resource_limit","log scan exceeded 5 seconds or 100000 entries; narrow since/predicate"));}
        Ok(())
    }
    pub fn matches(&self,entry:&Value)->bool{
        if entry["level"]=="info"&&!self.request.includeInfo.unwrap_or(false)||entry["level"]=="debug"&&!self.request.includeDebug.unwrap_or(false){return false;}
        self.terms.iter().all(|term|entry[&term.field].as_str().is_some_and(|value|if term.contains{value.contains(&term.value)}else{value==term.value}))
    }
}
pub struct Output{entries:Vec<Value>,bytes:usize}
impl Output{
    pub fn new()->Self{Self{entries:Vec::new(),bytes:64}}
    pub fn push(&mut self,entry:Value,query:&Query)->Result<bool,Value>{
        if !query.matches(&entry){return Ok(false);}
        self.bytes+=serde_json::to_vec(&entry).map_err(|_|failure("provider_failed","cannot encode log entry"))?.len()+1;
        if self.bytes>DESKTOP_LOG_MAX_RESULT_BYTES{return Err(failure("resource_limit","log output exceeds 1 MiB; narrow since/predicate"));}
        self.entries.push(entry);Ok(self.entries.len()>=query.request.limit.unwrap_or(100.0)as usize)
    }
    pub fn finish(self)->Value{json!({"count":self.entries.len(),"entries":self.entries,"scope":"local"})}
}
pub fn dispatch(action:&Value)->Value{
    let query=match validate(action){Ok(query)=>query,Err(error)=>return error};
    #[cfg(target_os="linux")]let result=crate::log_linux::query(&query);
    #[cfg(windows)]let result=crate::log_windows::query(&query);
    #[cfg(not(any(target_os="linux",windows)))]let result:Result<Value,Value>={let _=query;Err(failure("unsupported_operation","macOS uses OSLogStore in the Swift provider"))};
    match result{Ok(data)=>success(data),Err(error)=>error}
}
pub fn capability(session:&str)->Value{
    #[cfg(target_os="linux")]let(provider,present,permission,reason)=crate::log_linux::availability();
    #[cfg(windows)]let(provider,present,permission,reason)=crate::log_windows::availability();
    #[cfg(not(any(target_os="linux",windows)))]let(provider,present,permission,reason)=("OSLogStore",false,"not_applicable",Some("macOS uses the Swift provider"));
    let mut value=json!({"operation":"log","compiled":true,"present":present,"permission":permission,"session":session,"effective":present&&permission=="granted","background":"semantic","provider":provider,"versions":{},"limits":["query: local logs readable by the existing user; no permission changes","default since: last 300 seconds; default limit: 100; maximum 1000","literal == and CONTAINS for subsystem/category/message/process/level, joined by AND","chronological output; 1 MiB result; 100000 scanned entries / 5-second scan","Windows category is channel; Linux category is SYSLOG_FACILITY; macOS category is OSLog category","info/debug excluded unless requested; native Windows levels and syslog priorities are mapped"]});
    if let Some(reason)=reason{value["reason"]=json!(reason);}value
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn literal_predicates_reject_injection_and_bad_shapes(){
        let terms=predicate(r#"subsystem == "fixture\" 文件" AND message CONTAINS "AND""#).unwrap();assert_eq!(terms.len(),2);assert_eq!(terms[0].value,"fixture\" 文件");
        for value in ["message == 'a'","message == \"a\" OR process == \"b\"","message == \"a\" AND","message == \"a\"ANDmessage == \"b\"","unknown == \"a\"","message == \"\\u0000\""]{assert!(predicate(value).is_err(),"{value}");}
        for fields in [json!({"limit":0}),json!({"limit":1001}),json!({"limit":1.5}),json!({"since":"2026-02-30T00:00:00Z"}),json!({"includeInfo":null}),json!({"extra":true})]{let mut action=json!({"type":"desktop_log_query"});action.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());assert!(validate(&action).is_err());}
    }
    #[test]fn timestamp_and_filter_bounds(){
        for value in ["2026-10-04T18:00:00Z","2024-02-29T18:00:00.123456789+05:30"]{assert!(timestamp(value).is_some());}
        for value in ["2026-02-29T18:00:00Z","2026-01-01t00:00:00z","2026-01-01T00:00:60Z","2026-01-01T00:00:00+25:00"]{assert!(timestamp(value).is_none());}
        let query=validate(&json!({"type":"desktop_log_query","predicate":"message CONTAINS \"文件\"","limit":1})).unwrap();let mut out=Output::new();
        assert!(!out.push(json!({"message":"文件","level":"debug"}),&query).unwrap());assert!(!out.push(json!({"message":"other","level":"error"}),&query).unwrap());assert!(out.push(json!({"message":"文件","level":"error"}),&query).unwrap());assert_eq!(out.finish()["count"],1);
        let mut out=Output::new();assert!(out.push(json!({"message":"文件".repeat(DESKTOP_LOG_MAX_RESULT_BYTES),"level":"error"}),&query).is_err());
    }
    #[test]fn scan_count_and_monotonic_time_limits(){
        let mut query=validate(&json!({"type":"desktop_log_query"})).unwrap();
        assert!(query.check_budget(0).is_ok());
        assert!(query.check_budget(DESKTOP_LOG_MAX_SCAN_ENTRIES-1).is_ok());
        assert_eq!(query.check_budget(DESKTOP_LOG_MAX_SCAN_ENTRIES).unwrap_err()["code"],"resource_limit");
        query.started=Instant::now()-Duration::from_millis(DESKTOP_LOG_DEADLINE_MS as u64+1);
        assert_eq!(query.check_budget(0).unwrap_err()["code"],"resource_limit");
    }
}
