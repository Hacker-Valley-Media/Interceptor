//! Native sharing keeps compose, send and wallpaper receipts distinct.
use crate::{contract_generated::*,failure,success};
use serde_json::{Value,json};
use std::{fs,io,path::PathBuf,sync::Mutex,time::{Duration,Instant}};
static ACTIVE:Mutex<()>=Mutex::new(());
pub(crate) fn validate(a:&Value)->Result<(),Value>{
    if let Some(error)=desktop_share_shape_error(a){return Err(failure("invalid_request",error));}
    let sub=a["sub"].as_str().unwrap();let payload=["items","text","url","body","recipient","recipients","subject"];
    let allowed:Vec<&str>=if sub=="services"{vec!["for_item"]}else if matches!(sub,"text"|"url"){vec!["service","value","recipient","recipients","subject"]}else if sub=="named"{payload.into_iter().chain(["service"]).collect()}else{payload.to_vec()};
    for key in a.as_object().unwrap().keys(){if !["type","sub","group","groupColor","groupSoft"].contains(&key.as_str())&&!allowed.contains(&key.as_str()){return Err(failure("invalid_request","Share field does not belong to selector"));}}
    for(key,value)in a.as_object().unwrap(){
        let max=if matches!(key.as_str(),"text"|"body"|"value"){65536}else if matches!(key.as_str(),"group"|"groupColor"|"recipient"|"service"){256}else{4096};
        if value.as_str().is_some_and(|v|v.trim().is_empty()||v.len()>max||v.contains('\0')){return Err(failure("invalid_request","invalid bounded Share text"));}
        if value.as_array().is_some_and(|v|v.is_empty()||v.len()>32||v.iter().any(|v|v.as_str().is_none_or(|v|v.trim().is_empty()||v.len()>if key=="recipients"{256}else{4096}||v.contains('\0')))){return Err(failure("invalid_request","invalid bounded Share collection"));}
    }
    if a.get("recipient").is_some()&&a.get("recipients").is_some(){return Err(failure("invalid_request","Share recipient aliases are mutually exclusive"));}
    if matches!(sub,"named"|"text"|"url")&&a.get("service").is_none()||matches!(sub,"text"|"url")&&a.get("value").is_none(){return Err(failure("invalid_request","Share requires its exact service/value"));}
    if sub!="services"&&!matches!(sub,"text"|"url")&&!payload[..4].iter().any(|key|a.get(key).is_some()){return Err(failure("invalid_request","Share requires content"));}
    if let Some(raw)=if sub=="url"{a["value"].as_str()}else{a["url"].as_str()}{let uri=url::Url::parse(raw).map_err(|_|failure("invalid_request","Share requires an absolute URL"))?;if !matches!(uri.scheme(),"http"|"https")||uri.host_str().is_none(){return Err(failure("invalid_request","Share requires an absolute HTTP or HTTPS URL"));}}
    if let Some(path)=a["for_item"].as_str(){crate::filesystem::absolute(path)?;}
    if serde_json::to_vec(a).map_or(true,|v|v.len()>262144){return Err(failure("resource_limit","Share request exceeds 256KiB"));}Ok(())
}
pub fn dispatch(a:&Value)->Value{
    if let Err(error)=validate(a){return error;}
    let Ok(_active)=ACTIVE.try_lock()else{return failure("resource_limit","another native Share request remains active; no work queued");};
    match crate::thumbnail::image_helper("--share-engine",a,Instant::now()+Duration::from_secs(55)){
        Ok(data)=>success(data),Err(error)if error["code"]=="resource_limit"||error["code"]=="provider_failed"&&error["error"].as_str().is_some_and(|v|v.starts_with("native helper failed"))=>failure("timeout_unknown_outcome","native sharing helper did not return a complete receipt; it was reaped, external composer/portal effects remain unknown and no content was replayed"),Err(error)=>error
    }
}
pub(crate) struct Payload{pub(crate) body:String,pub(crate) recipients:Vec<String>,pub(crate) subject:Option<String>,pub(crate) files:Vec<PathBuf>,pub(crate) originals:Vec<String>}
impl Payload{
    pub(crate) fn resolve(a:&Value)->Result<Self,Value>{
        let mut body=Vec::new();for key in ["text","url","body","value"]{if let Some(value)=a[key].as_str(){body.push(value.to_owned());}}
        let mut files=Vec::new();let mut originals=Vec::new();
        for item in a["items"].as_array().into_iter().flatten(){let item=item.as_str().unwrap();originals.push(item.to_owned());let path=PathBuf::from(item);
            if path.is_absolute(){let metadata=fs::symlink_metadata(&path).map_err(|_|failure("permission_denied","Share file is inaccessible"))?;if !metadata.is_file()||metadata.file_type().is_symlink(){return Err(failure("unsupported_target","Share attachment requires a regular nonsymlink file"));}if metadata.len()>64*1024*1024{return Err(failure("resource_limit","Share attachment exceeds 64MiB"));}files.push(path);}
            else{body.push(item.to_owned());}
        }
        let recipients=if let Some(values)=a["recipients"].as_array(){values.iter().map(|v|v.as_str().unwrap().to_owned()).collect()}else{a["recipient"].as_str().map(str::to_owned).into_iter().collect()};
        let body=body.join("\n");if body.len()>65536{return Err(failure("resource_limit","composed Share body exceeds 64KiB"));}
        Ok(Self{body,recipients,subject:a["subject"].as_str().map(str::to_owned),files,originals})
    }
}
pub(crate) fn selected(a:&Value)->Result<&str,Value>{
    let name=if matches!(a["sub"].as_str(),Some("named"|"text"|"url")){a["service"].as_str().unwrap()}else{a["sub"].as_str().unwrap()};
    match name{"email"|"mail"|"com.apple.share.composeEmail"=>Ok("email"),"desktop-picture"|"desktop"|"com.apple.share.useAsDesktopPicture"=>Ok("desktop-picture"),"message"|"messages"|"com.apple.share.composeMessage"=>Ok("message"),"airdrop"|"reading-list"=>Err(failure("unsupported_operation","this Apple sharing service has no implemented provider equivalent; no content was sent")),_=>Err(failure("unsupported_target","unknown exact native sharing service; inspect services before choosing"))}
}
pub(crate) fn message_uri(payload:&Payload)->Result<String,Value>{
    if !payload.files.is_empty()||payload.subject.is_some(){return Err(failure("unsupported_target","native SMS URI messaging does not support file attachments or a subject; no fields were discarded"));}
    if payload.recipients.is_empty()||payload.recipients.iter().any(|recipient|{let Some(digits)=recipient.strip_prefix('+')else{return true;};digits.len()<3||digits.len()>15||digits.starts_with('0')||!digits.bytes().all(|b|b.is_ascii_digit())}){return Err(failure("invalid_request","native SMS URI requires explicit global telephone recipients: plus followed by3..15 digits, with a nonzero country-code digit"));}
    let body=url::form_urlencoded::byte_serialize(payload.body.as_bytes()).collect::<String>().replace('+',"%20");
    let uri=format!("sms:{}?body={body}",payload.recipients.join(","));
    if uri.len()>16384{return Err(failure("resource_limit","native messaging URI exceeds 16KiB"));}Ok(uri)
}
/// RFC 6068 mailto: URI for an email without attachments (recipients, subject and body).
#[cfg_attr(not(windows),allow(dead_code))]
pub(crate) fn mailto_uri(payload:&Payload)->Result<String,Value>{
    let encode=|text:&str|url::form_urlencoded::byte_serialize(text.as_bytes()).collect::<String>().replace('+',"%20");
    let to=payload.recipients.iter().map(|r|encode(r).replace("%40","@")).collect::<Vec<_>>().join(",");
    let mut fields=Vec::new();if let Some(subject)=&payload.subject{fields.push(format!("subject={}",encode(subject)));}if !payload.body.is_empty(){fields.push(format!("body={}",encode(&payload.body)));}
    let uri=if fields.is_empty(){format!("mailto:{to}")}else{format!("mailto:{to}?{}",fields.join("&"))};
    if uri.len()>16384{return Err(failure("resource_limit","native mail URI exceeds 16KiB"));}Ok(uri)
}
pub(crate) fn helper(parent:u32)->io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    let bytes=crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("Share helper requires one request"))?;let a:Value=serde_json::from_slice(&bytes)?;
    let result=match validate(&a){Err(error)=>error,Ok(())=>{
        #[cfg(windows)]{match crate::share_windows::native(&a){Ok(data)=>success(data),Err(error)=>error}}
        #[cfg(target_os="linux")]{match crate::share_linux::native(&a){Ok(data)=>success(data),Err(error)=>error}}
        #[cfg(not(any(windows,target_os="linux")))]{failure("unsupported_operation","this Share helper requires Windows or Linux")}
    }};
    let result=if serde_json::to_vec(&result)?.len()>1048576{failure("partial_result","Share native receipt exceeds 1MiB after possible effect")}else{result};crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(&result)?)
}
pub fn capability(session:&str)->Value{json!({"operation":"share","compiled":cfg!(any(windows,target_os="linux")),"present":cfg!(any(windows,target_os="linux")),"effective":false,"permission":"unknown","session":session,"background":"semantic","provider":"native compose, messaging URI and wallpaper helper","versions":{"contract":"1"},"limits":["Nine exact request selectors; services, email, telephone-message and desktop-picture source backends; named/text/url require an implemented exact service. Apple AirDrop and Safari Reading List remain explicit exclusions.","Explicit native composition may display UI; completion distinguishes actual send, compose presentation, handler acceptance and wallpaper effect. Discovery sends nothing and grants no permission.","Telephone messaging requires a native SMS URI handler and explicit global plus-prefixed 3..15-digit recipients; local phone contexts, attachments, subjects, Apple Messages accounts and delivery receipts are unavailable.","One owned 55-second helper, 32 items/recipients, 64KiB body, 16KiB message URI, 64MiB regular file and 256MiB attachment aggregate, 1MiB replies; helper timeout does not prove external composer cancellation.","Native providers, source parity, process/file/request identity, installed UI/focus and packaging qualification remain open."]})}

#[cfg(test)]mod tests{use super::*;#[test]fn share_refuses_fields_that_would_be_silently_discarded(){for a in[json!({"type":"desktop_share","sub":"services","body":"x"}),json!({"type":"desktop_share","sub":"text","service":"email","value":"x","items":["ignored"]}),json!({"type":"desktop_share","sub":"email","text":"x","recipient":"a","recipients":["b"]}),json!({"type":"desktop_share","sub":"url","service":"email","value":"javascript:alert(1)"})]{assert!(validate(&a).is_err());}assert!(validate(&json!({"type":"desktop_share","sub":"email","text":"Actual content","subject":"Actual subject"})).is_ok());}
    #[test]fn message_uri_keeps_content_and_rejects_unrepresentable_fields(){let mut payload=Payload::resolve(&json!({"text":"a + b\n&é","recipients":["+15555550100","+15555550101"]})).unwrap();assert_eq!(message_uri(&payload).unwrap(),"sms:+15555550100,+15555550101?body=a%20%2B%20b%0A%26%C3%A9");payload.subject=Some("discarded".into());assert!(message_uri(&payload).is_err());payload.subject=None;for recipient in ["15555550100","+0123","1555?body=injected"]{payload.recipients=vec![recipient.into()];assert!(message_uri(&payload).is_err());}}
    #[test]fn mailto_uri_encodes_every_field(){
        let payload=Payload::resolve(&json!({"text":"a + b\n&é","recipients":["parity@example.invalid","second@example.invalid"],"subject":"Hi & bye?"})).unwrap();
        assert_eq!(mailto_uri(&payload).unwrap(),"mailto:parity@example.invalid,second@example.invalid?subject=Hi%20%26%20bye%3F&body=a%20%2B%20b%0A%26%C3%A9");
        assert_eq!(mailto_uri(&Payload::resolve(&json!({"recipients":["a@b.c"]})).unwrap()).unwrap(),"mailto:a@b.c");
    }
}
