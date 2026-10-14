//! Validate the neutral wire contract before reaching any host notification API.
use crate::{contract_generated::*,failure};
use serde_json::Value;
use std::{collections::{BTreeMap,HashSet},path::Path};

pub fn string(value:&str,maximum:usize,empty:bool)->bool{
    (empty||!value.is_empty())&&value.len()<=maximum&&!value.contains('\0')
}
pub fn identifier(value:&str)->bool{string(value,128,false)}
pub fn namespace(value:&str)->bool{
    (1..=64).contains(&value.len())&&value.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')
}
pub fn format(value:&str,summary:bool)->bool{
    let mut chars=value.chars();let(mut count,mut list)=(false,false);
    while let Some(c)=chars.next(){if c=='%'{match chars.next(){
        Some('%')=>(),Some('u')if !count&&!list=>count=true,
        Some('@')if summary&&count&&!list=>list=true,_=>return false,
    }}}
    true
}
pub fn user_info(raw:&str)->Result<Value,String>{
    if !string(raw,16384,false){return Err("notification user-info requires a bounded JSON object".into());}
    let value:Value=serde_json::from_str(raw).map_err(|_|"invalid notification user-info JSON")?;
    if !value.is_object(){return Err("notification user-info requires a JSON object".into());}
    fn visit(value:&Value,depth:usize,budget:&mut usize)->Result<(),String>{
        if *budget==0||depth>8{return Err("notification user-info exceeds depth 8 or 2048 values".into());}
        *budget-=1;
        match value{
            Value::String(s)if s.contains('\0')=>return Err("notification user-info contains NUL".into()),
            Value::Array(a)=>for v in a{visit(v,depth+1,budget)?;},
            Value::Object(o)=>for(k,v)in o{if k.contains('\0'){return Err("notification user-info key contains NUL".into());}visit(v,depth+1,budget)?;},
            _=>(),
        }
        Ok(())
    }
    visit(&value,0,&mut 2048)?;Ok(value)
}
pub fn components(raw:&str)->Result<BTreeMap<String,u16>,String>{
    if !string(raw,512,false){return Err("notification components require a bounded key=integer list".into());}
    let mut result=BTreeMap::new();
    for part in raw.split(','){
        let Some((key,value))=part.trim().split_once('=')else{return Err("malformed notification component".into());};
        let(min,max)=match key{"year"=>(1,9999),"month"=>(1,12),"day"=>(1,31),"weekday"=>(1,7),"hour"=>(0,23),"minute"|"second"=>(0,59),_=>return Err("unknown notification component".into())};
        if value.is_empty()||value.len()>4||!value.bytes().all(|b|b.is_ascii_digit()){return Err("notification component requires unsigned decimal digits".into());}
        let n=value.parse::<u16>().map_err(|_|"invalid notification component")?;
        if !(min..=max).contains(&n)||result.insert(key.into(),n).is_some(){return Err("duplicate or out-of-range notification component".into());}
    }
    if let(Some(&month),Some(&day))=(result.get("month"),result.get("day")){
        let year=*result.get("year").unwrap_or(&2000)as i32;
        if time::Date::from_calendar_date(year,time::Month::try_from(month as u8).unwrap(),day as u8).is_err(){return Err("notification calendar date does not exist".into());}
    }
    Ok(result)
}
pub fn actions(raw:&str)->Result<Vec<DesktopNotificationActionDefinition>,String>{
    if !string(raw,16384,false){return Err("notification category actions exceed 16384 bytes".into());}
    let rows:Vec<DesktopNotificationActionDefinition>=serde_json::from_str(raw).map_err(|_|"invalid notification category actions JSON")?;
    if rows.len()>8{return Err("notifications allow at most 8 actions".into());}
    let mut ids=HashSet::new();
    for row in &rows{
        let options=row.options.as_deref().unwrap_or(&[]);
        if !identifier(&row.identifier)||!ids.insert(&row.identifier)||!string(&row.title,256,false)||options.len()>3||options.iter().map(std::mem::discriminant).collect::<HashSet<_>>().len()!=options.len(){return Err("notification action identity/title/options are invalid or duplicated".into());}
    }
    Ok(rows)
}
pub fn validate(action:&Value)->Result<(),Value>{
    if let Some(error)=desktop_notifications_shape_error(action){return Err(failure("invalid_request",error));}
    // Shape validation above rejects null, unknown keys and wrong primitive types.
    let sub=action["sub"].as_str().unwrap();
    let content=&["title","subtitle","body","sound","badge","category","thread","user_info","interruption","attachment","id"][..];
    let fields:&[&str]=match sub{
        "tail"|"untail"=>&["name"],"log"=>&["limit","app"],"request"=>&["options"],"post"=>content,
        "schedule-after"=>&["seconds","repeats"],"schedule-at"=>&["date","repeats"],"schedule-cron"=>&["components","repeats"],
        "cancel"|"dismiss"=>&["id"],"pending"|"delivered"=>&["limit"],
        "categories"=>&["verb","identifier","actions","intent_identifiers","summary_format","hidden_placeholder"],"badge"=>&["count","clear"],_=>&[],
    };
    let common=["type","sub","namespace","group","groupColor","groupSoft"];
    let scheduled=["schedule-after","schedule-at","schedule-cron"].contains(&sub);
    let invalid=|message:&str|failure("invalid_request",message);
    if action.as_object().unwrap().keys().any(|key|!common.contains(&key.as_str())&&!fields.contains(&key.as_str())&&!(scheduled&&content.contains(&key.as_str()))){return Err(invalid("notification field is not valid for this operation"));}
    if action["namespace"].as_str().is_some_and(|s|!namespace(s)){return Err(invalid("notification namespace requires 1..64 ASCII letters, digits, underscore or hyphen"));}
    let integer=|key:&str,min:f64,max:f64|action.get(key).is_none_or(|v|v.as_f64().is_some_and(|n|n.is_finite()&&n.fract()==0.0&&(min..=max).contains(&n)));
    if !integer("limit",0.0,DESKTOP_NOTIFICATION_MAX_ENTRIES as f64){return Err(invalid("notification limit must be an integer in 0..1000"));}
    for key in ["id","identifier","category","thread"]{if action[key].as_str().is_some_and(|s|!identifier(s)){return Err(invalid("notification identifiers require 1..128 UTF-8 bytes without NUL"));}}
    if ["cancel","dismiss"].contains(&sub)&&action.get("id").is_none(){return Err(invalid("notification removal requires an exact public identifier"));}
    if ["tail","untail"].contains(&sub)&&!action["name"].as_str().is_some_and(|s|string(s,512,false)){return Err(invalid("notification tail/untail require an exact bounded name"));}
    for(key,max,empty)in [("app",512,false),("title",4096,true),("subtitle",4096,true),("body",32768,true),("sound",2048,false),("summary_format",2048,false),("hidden_placeholder",2048,false)]{
        if action[key].as_str().is_some_and(|s|!string(s,max,empty)){return Err(invalid("notification text exceeds its bound or contains NUL"));}
    }
    for key in ["summary_format","hidden_placeholder"]{if action[key].as_str().is_some_and(|s|!format(s,key=="summary_format")){return Err(invalid("notification category format has unsupported placeholders"));}}
    if !integer("badge",0.0,9999.0)||!integer("count",0.0,9999.0){return Err(invalid("notification badge must be an integer in 0..9999"));}
    if sub=="badge"&&((action.get("clear").is_none()&&action.get("count").is_none())||(action.get("clear").is_some()&&(action["clear"]!=true||action.get("count").is_some()))){return Err(invalid("notification badge requires a count or clear, without conflicting selectors"));}
    if sub=="schedule-after"&&(action.get("seconds").is_none()||!integer("seconds",1.0,DESKTOP_NOTIFICATION_MAX_SECONDS as f64)||action["repeats"]==true&&action["seconds"].as_f64().unwrap_or(0.0)<60.0){return Err(invalid("notification seconds require 1..31536000; repeating intervals require at least 60 seconds"));}
    if sub=="schedule-at"{
        let now=time::OffsetDateTime::now_utc();
        if !action["date"].as_str().and_then(crate::log::timestamp).is_some_and(|date|date>now&&date-now<=time::Duration::seconds(DESKTOP_NOTIFICATION_MAX_SECONDS as i64))||action["repeats"]==true{return Err(invalid("notification date requires a future one-time RFC3339 instant within 365 days"));}
    }
    if let Some(raw)=action["user_info"].as_str(){user_info(raw).map_err(|e|invalid(&e))?;}
    if sub=="schedule-cron"{components(action["components"].as_str().unwrap_or("")).map_err(|e|invalid(&e))?;}
    if let Some(raw)=action["attachment"].as_str(){
        let parts=raw.split(',').collect::<Vec<_>>();let mut ids=HashSet::new();
        if !string(raw,32768,false)||parts.len()>8{return Err(invalid("notifications allow at most 8 bounded attachments"));}
        for entry in parts{let parts=entry.split('=').collect::<Vec<_>>();let path=*parts.last().unwrap();
            if parts.len()>2||!string(path,4096,false)||!Path::new(path).is_absolute()||parts.len()==2&&(!identifier(parts[0])||!ids.insert(parts[0])){return Err(invalid("notification attachments require bounded absolute paths and distinct optional identifiers"));}
        }
    }
    if sub=="request"{
        let options=action["options"].as_str().unwrap_or("alert,sound,badge").split(',').map(str::trim).collect::<Vec<_>>();
        if options.is_empty()||options.len()>6||options.iter().collect::<HashSet<_>>().len()!=options.len()||options.iter().any(|o|!["alert","sound","badge","criticalAlert","provisional","providesAppNotificationSettings"].contains(o)){return Err(invalid("notification authorization options are unknown, empty or duplicated"));}
    }
    if sub=="categories"{
        if action["verb"].as_str().unwrap_or("list")=="register"{
            if !action["identifier"].as_str().is_some_and(identifier)||action["actions"].as_str().is_none(){return Err(invalid("notification category register requires identifier and actions JSON"));}
            actions(action["actions"].as_str().unwrap()).map_err(|e|invalid(&e))?;
            if let Some(raw)=action["intent_identifiers"].as_str(){let ids=raw.split(',').collect::<Vec<_>>();if ids.len()>8||ids.iter().collect::<HashSet<_>>().len()!=ids.len()||ids.iter().any(|id|!identifier(id)){return Err(invalid("notification intent identifiers require at most 8 distinct bounded strings"));}}
        }else if action.as_object().unwrap().keys().any(|k|!common.contains(&k.as_str())&&k!="verb"){return Err(invalid("notification category list/clear accept no registration fields"));}
    }
    if serde_json::to_vec(action).map_err(|_|invalid("cannot encode notification request"))?.len()>DESKTOP_NOTIFICATION_MAX_CONTENT_BYTES{return Err(invalid("notification content exceeds 65536 bytes"));}
    Ok(())
}

#[cfg(test)]mod tests{
    use super::*;use serde_json::json;
    #[test]fn malformed_and_misplaced_fields_refuse_before_platform_dispatch(){
        for fields in [json!({"sub":"log","limit":-1}),json!({"sub":"log","limit":1001}),json!({"sub":"log","limit":true}),json!({"sub":"pending","limit":null}),json!({"sub":"tail"}),json!({"sub":"tail","name":"x","namespace":"a.b"}),json!({"sub":"post","user_info":"[]"}),json!({"sub":"post","id":""}),json!({"sub":"post","extra":true}),json!({"sub":"cancel-all","id":"unrelated"}),json!({"sub":"cancel"}),json!({"sub":"schedule-after","seconds":59,"repeats":true}),json!({"sub":"schedule-after","seconds":1.5}),json!({"sub":"schedule-at","date":"2025-02-30T00:00:00Z"}),json!({"sub":"schedule-cron","components":"month=2,day=30"}),json!({"sub":"request","options":"alert,alert"}),json!({"sub":"categories","verb":"clear","identifier":"unrelated"}),json!({"sub":"categories","verb":"register","identifier":"x","actions":"[{\"identifier\":\"x\",\"title\":\"y\",\"extra\":true}]"}),json!({"sub":"badge","clear":true,"count":2}),json!({"sub":"badge","clear":false})]{
            let mut action=json!({"type":"desktop_notifications"});action.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());assert_eq!(validate(&action).unwrap_err()["code"],"invalid_request","{action}");
        }
    }
    #[test]fn valid_boundary_requests_and_native_format_specs(){
        for fields in [json!({"sub":"pending","limit":0}),json!({"sub":"log","limit":1000}),json!({"sub":"post","id":"文件🙂","user_info":"{\"nested\":{\"unicode\":\"🙂\"}}"}),json!({"sub":"schedule-after","seconds":60.0,"repeats":true}),json!({"sub":"schedule-cron","components":"year=2028,month=2,day=29,hour=0,minute=0,second=0","repeats":false}),json!({"sub":"categories","verb":"register","identifier":"x","actions":"[]","summary_format":"%u from %@ %%","hidden_placeholder":"%u notifications"}),json!({"sub":"badge","count":9999}),json!({"sub":"badge","clear":true})]{let mut action=json!({"type":"desktop_notifications","namespace":"owned_1"});action.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());assert!(validate(&action).is_ok(),"{action}");}
        for raw in ["%n","%@ before %u","%u %u","%u %d","%"][..].iter(){assert!(!format(raw,true),"{raw}");}
        assert!(!format("%u %@",false));
    }
    #[test]fn nested_identity_calendar_and_content_bounds(){
        for raw in ["[]","{\"x\":\"\\u0000\"}","{\"\\u0000\":1}"]{assert!(user_info(raw).is_err());}
        let mut nested=json!({});for _ in 0..9{nested=json!({"x":nested});}assert!(user_info(&nested.to_string()).is_err());
        assert!(user_info(&json!({"x":vec![0;2048]}).to_string()).is_err());
        for raw in ["year=2025,month=2,day=29","month=1,month=2","hour=-1","minute=60","second=1e1","timezone=UTC"]{assert!(components(raw).is_err(),"{raw}");}
        for raw in ["[{\"identifier\":\"x\",\"title\":\"x\",\"options\":[\"foreground\",\"foreground\"]}]","[{\"identifier\":\"x\",\"title\":\"x\"},{\"identifier\":\"x\",\"title\":\"y\"}]"]{assert!(actions(raw).is_err());}
        assert!(validate(&json!({"type":"desktop_notifications","sub":"post","body":"🙂".repeat(8193)})).is_err());
        assert!(validate(&json!({"type":"desktop_notifications","sub":"post","attachment":"one=relative.png"})).is_err());
    }
}
