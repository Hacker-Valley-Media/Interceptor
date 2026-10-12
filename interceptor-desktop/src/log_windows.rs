use crate::{failure,log::{Output,Query},contract_generated::DESKTOP_LOG_MAX_RESULT_BYTES};
use serde_json::{Value,json};
use windows::{core::{Error,PCWSTR},Win32::{Foundation::{ERROR_ACCESS_DENIED,ERROR_EVT_CHANNEL_NOT_FOUND,ERROR_INSUFFICIENT_BUFFER,ERROR_NO_MORE_ITEMS},System::EventLog::*}};
use time::{OffsetDateTime,format_description::well_known::Rfc3339};
use std::mem::size_of;

struct Handle(EVT_HANDLE);
impl Drop for Handle{fn drop(&mut self){unsafe{let _=EvtClose(self.0);}}}
fn wide(value:&str)->Vec<u16>{value.encode_utf16().chain(Some(0)).collect()}
fn native_error(error:Error)->Value{
    let code=error.code();
    let kind=if code==Error::from(ERROR_ACCESS_DENIED).code(){"permission_denied"}
        else if code==Error::from(ERROR_EVT_CHANNEL_NOT_FOUND).code(){"unsupported_target"}
        else{"provider_failed"};
    failure(kind,format!("Windows Event Log read failed: {error}"))
}
fn render(event:EVT_HANDLE,context:Option<EVT_HANDLE>,flag:EVT_RENDER_FLAGS)->Result<(Vec<u64>,usize,u32),Value>{
    let mut used=0;let mut count=0;
    match unsafe{EvtRender(context,event,flag.0,0,None,&mut used,&mut count)}{
        Err(error)if error.code()==Error::from(ERROR_INSUFFICIENT_BUFFER).code()=>(),
        Err(error)=>return Err(native_error(error)),Ok(())=>return Err(failure("provider_failed","Event Log returned an empty render size"))
    }
    if used==0||used as usize>DESKTOP_LOG_MAX_RESULT_BYTES{return Err(failure("resource_limit","Event Log record exceeds 1 MiB"));}
    // EvtRender places EVT_VARIANTs and pointed-to strings in this same buffer.
    // u64 storage supplies alignment for variants on both Windows architectures.
    let mut buffer=vec![0_u64;(used as usize).div_ceil(8)];
    unsafe{EvtRender(context,event,flag.0,(buffer.len()*8)as u32,Some(buffer.as_mut_ptr().cast()),&mut used,&mut count)}.map_err(native_error)?;
    if used as usize>buffer.len()*8{return Err(failure("provider_failed","Event Log render exceeded its buffer"));}
    Ok((buffer,used as usize,count))
}
fn string(pointer:PCWSTR,buffer:&[u64],used:usize)->Result<String,Value>{
    if pointer.is_null(){return Ok(String::new());}
    let start=buffer.as_ptr()as usize;let address=pointer.0 as usize;
    if address<start||address>=start+used||(address-start)%2!=0{return Err(failure("provider_failed","Event Log string points outside its render buffer"));}
    let chars=unsafe{std::slice::from_raw_parts(pointer.0,(start+used-address)/2)};
    let length=chars.iter().position(|value|*value==0).ok_or_else(||failure("provider_failed","Event Log string has no terminator"))?;
    String::from_utf16(&chars[..length]).map_err(|_|failure("unsupported_target","Event Log string is not valid UTF-16"))
}
fn formatted(event:EVT_HANDLE,provider:&str)->Result<String,Value>{
    let name=wide(provider);
    if let Ok(metadata)=unsafe{EvtOpenPublisherMetadata(None,PCWSTR(name.as_ptr()),PCWSTR::null(),0,0)}{
        let metadata=Handle(metadata);let mut used=0;
        if let Err(error)=unsafe{EvtFormatMessage(Some(metadata.0),Some(event),0,None,EvtFormatMessageEvent.0,None,&mut used)}{
            if error.code()==Error::from(ERROR_INSUFFICIENT_BUFFER).code(){
                if used as usize>DESKTOP_LOG_MAX_RESULT_BYTES/2{return Err(failure("resource_limit","formatted Event Log message exceeds its bounds"));}
                let mut buffer=vec![0_u16;used as usize];
                if unsafe{EvtFormatMessage(Some(metadata.0),Some(event),0,None,EvtFormatMessageEvent.0,Some(&mut buffer),&mut used)}.is_ok(){
                    let length=buffer.iter().position(|value|*value==0).unwrap_or(buffer.len());
                    return String::from_utf16(&buffer[..length]).map_err(|_|failure("unsupported_target","Event Log message is not valid UTF-16"));
                }
            }
        }
    }
    // Missing publisher resources are common for classic/application events.
    // Return the actual native XML record, never a fabricated empty message.
    let(buffer,used,_)=render(event,None,EvtRenderEventXml)?;
    string(PCWSTR(buffer.as_ptr().cast()),&buffer,used)
}
fn entry(event:EVT_HANDLE,context:EVT_HANDLE,query:&Query)->Result<Option<Value>,Value>{
    let(buffer,used,count)=render(event,Some(context),EvtRenderEventValues)?;
    if count<EvtSystemPropertyIdEND.0 as u32||used<size_of::<EVT_VARIANT>()*count as usize{return Err(failure("provider_failed","Event Log omitted system properties"));}
    let values=unsafe{std::slice::from_raw_parts(buffer.as_ptr().cast::<EVT_VARIANT>(),count as usize)};
    let timestamp=&values[EvtSystemTimeCreated.0 as usize];
    if timestamp.Type!=EvtVarTypeFileTime.0 as u32{return Err(failure("provider_failed","Event Log timestamp has the wrong native type"));}
    let ticks=unsafe{timestamp.Anonymous.FileTimeVal};
    let date=OffsetDateTime::from_unix_timestamp_nanos((i128::from(ticks)-116_444_736_000_000_000)*100).map_err(|_|failure("provider_failed","invalid Event Log timestamp"))?;
    if date<query.since{return Ok(None);}
    let level=&values[EvtSystemLevel.0 as usize];
    let level=if level.Type==EvtVarTypeByte.0 as u32{unsafe{level.Anonymous.ByteVal}}else{0};
    let level=match level{1=>"fault",2=>"error",3|0=>"default",4=>"info",5=>"debug",_=>"undefined"};
    if level=="info"&&!query.request.includeInfo.unwrap_or(false)||level=="debug"&&!query.request.includeDebug.unwrap_or(false){return Ok(None);}
    let read_string=|index:EVT_SYSTEM_PROPERTY_ID|->Result<String,Value>{let value=&values[index.0 as usize];if value.Type==EvtVarTypeNull.0 as u32{return Ok(String::new());}if value.Type!=EvtVarTypeString.0 as u32{return Err(failure("provider_failed","Event Log string has the wrong native type"));}string(unsafe{value.Anonymous.StringVal},&buffer,used)};
    let subsystem=read_string(EvtSystemProviderName)?;let category=read_string(EvtSystemChannel)?;
    let process=&values[EvtSystemProcessID.0 as usize];
    let process=if process.Type==EvtVarTypeUInt32.0 as u32{unsafe{process.Anonymous.UInt32Val}.to_string()}else{String::new()};
    if [&subsystem,&category,&process].iter().any(|value|value.len()>4096){return Err(failure("resource_limit","Event Log metadata exceeds 4096 bytes"));}
    let metadata=json!({"timestamp":date.format(&Rfc3339).map_err(|_|failure("provider_failed","cannot encode Event Log timestamp"))?,"subsystem":subsystem,"category":category,"process":process,"level":level,"message":""});
    // Avoid loading message resources for records already excluded by metadata.
    if query.terms.iter().filter(|term|term.field!="message").any(|term|!metadata[&term.field].as_str().is_some_and(|value|if term.contains{value.contains(&term.value)}else{value==term.value})){return Ok(None);}
    let mut result=metadata;result["message"]=json!(formatted(event,&subsystem)?);Ok(Some(result))
}
fn channels(query:&Query)->Result<Vec<String>,Value>{
    let selected:Vec<_>=query.terms.iter().filter(|term|term.field=="category"&&!term.contains).map(|term|term.value.clone()).collect();
    if let Some(channel)=selected.first(){
        if channel.is_empty()||channel.len()>256||!channel.chars().all(|c|c.is_ascii_alphanumeric()||"/_. -".contains(c)){return Err(failure("invalid_request","Windows category must name a bounded local Event Log channel"));}
        return Ok(vec![channel.clone()]);
    }
    Ok(vec!["Application".into(),"System".into()])
}
fn open_channel(channel:&str,xpath:&str)->Result<Handle,Value>{
    let channel=wide(channel);let xpath=wide(xpath);
    unsafe{EvtQuery(None,PCWSTR(channel.as_ptr()),PCWSTR(xpath.as_ptr()),EvtQueryChannelPath.0|EvtQueryForwardDirection.0)}.map(Handle).map_err(native_error)
}
pub fn availability()->(&'static str,bool,&'static str,Option<&'static str>){
    match open_channel("Application","*"){Ok(_)=>("Windows Event Log/wevtapi",true,"granted",None),Err(error)if error["code"]=="permission_denied"=>("Windows Event Log/wevtapi",true,"denied",Some("current token cannot query Application events")),Err(_)=>("Windows Event Log/wevtapi",false,"not_applicable",Some("Windows Event Log unavailable"))}
}
pub fn query(query:&Query)->Result<Value,Value>{
    let since=query.since.format(&Rfc3339).map_err(|_|failure("invalid_request","since cannot be represented in Event Log XPath"))?;
    // Only a formatter-owned timestamp enters XPath. Caller predicates stay in
    // the literal-only evaluator and channel names enter EvtQuery's path slot.
    let xpath=format!("*[System[TimeCreated[@SystemTime >= '{since}']]]");
    let context=Handle(unsafe{EvtCreateRenderContext(None,EvtRenderContextSystem.0)}.map_err(native_error)?);
    let mut records=Vec::new();let mut bytes=64;let mut scanned=0;let limit=query.request.limit.unwrap_or(100.0)as usize;
    for channel in channels(query)?{
        // Each channel reads forward in time, so its first `limit` matches hold every record the merge can return.
        let events=open_channel(&channel,&xpath)?;let mut kept=0;
        'channel:loop{
            query.check_budget(scanned)?;let mut raw=[0_isize;16];let mut returned=0;
            match unsafe{EvtNext(events.0,&mut raw,1000,0,&mut returned)}{
                Ok(())=>(),Err(error)if error.code()==Error::from(ERROR_NO_MORE_ITEMS).code()=>break,Err(error)=>return Err(native_error(error))
            }
            if returned==0||returned as usize>raw.len(){return Err(failure("provider_failed","Event Log returned an invalid batch size"));}
            let handles:Vec<_>=raw[..returned as usize].iter().map(|value|Handle(EVT_HANDLE(*value))).collect();
            for event in handles{
                query.check_budget(scanned)?;scanned+=1;
                if let Some(entry)=entry(event.0,context.0,query)?{if query.matches(&entry){
                    bytes+=serde_json::to_vec(&entry).map_err(|_|failure("provider_failed","cannot encode Event Log record"))?.len()+1;
                    if bytes>DESKTOP_LOG_MAX_RESULT_BYTES{return Err(failure("resource_limit","Event Log merge exceeds 1 MiB; narrow since/predicate"));}
                    records.push(entry);kept+=1;if kept>=limit{break 'channel;}
                }}
            }
        }
    }
    records.sort_by_key(|entry|crate::log::timestamp(entry["timestamp"].as_str().unwrap_or("")).map(|date|date.unix_timestamp_nanos()));
    let mut output=Output::new();for entry in records{if output.push(entry,query)?{break;}}
    Ok(output.finish())
}
