use crate::{failure,success,contract_generated::*};
use serde_json::{Value,json};
use std::{io,sync::Mutex,time::{Duration,Instant}};
static ACTIVE:Mutex<()>=Mutex::new(());
pub(crate) const MUTABLE:[&str;8]=["given","family","organization","email","phone","postal","birthday","note"];
pub(crate) const OUTPUT_KEYS:[&str;24]=["id","contactType","namePrefix","givenName","middleName","familyName","nameSuffix","nickname","phonetic","organization","emailAddresses","phoneNumbers","urlAddresses","socialProfiles","instantMessageAddresses","contactRelations","imageDataAvailable","postalAddresses","dates","birthday","thumbnailDataUrl","imageDataUrl","note","requires_entitlement"];
pub(crate) fn integer(value:&Value)->Option<u64>{value.as_f64().filter(|n|n.is_finite()&&n.fract()==0.0&&*n>=0.0&&*n<=9007199254740991.0).map(|n|n as u64)}
pub(crate) fn validate(a:&Value)->Result<(),Value>{
    if let Some(error)=desktop_contacts_shape_error(a){return Err(failure("invalid_request",error));}
    let sub=a["sub"].as_str().unwrap();let mut allowed=match sub{
        "status"|"request"|"containers"|"default-container"|"me"|"current-token"=>vec![],"groups"=>vec!["container"],"group"|"group-delete"|"contact"|"delete"|"vcard"=>vec!["id"],"group-create"=>vec!["name","container"],"group-update"=>vec!["id","name"],"group-add-member"|"group-remove-member"=>vec!["id","contact"],"list"=>vec!["limit","offset","keys","container","group"],"find"=>vec!["query","name","email","phone"],"create"=>MUTABLE.into_iter().chain(["container"]).collect(),"update"=>MUTABLE.into_iter().chain(["id"]).collect(),"import-vcard"=>vec!["path","container"],"changes"=>vec!["since","limit"],_=>return Err(failure("invalid_request","unknown Contacts selector"))};
    allowed.extend(["type","sub","groupColor","groupSoft"]);
    for(key,value)in a.as_object().unwrap(){
        if !allowed.contains(&key.as_str()){return Err(failure("invalid_request","Contacts field does not belong to selector"));}
        if let Some(text)=value.as_str(){if text.len()>if key=="note"{65536}else if key=="since"{16384}else{4096}||text.contains('\0')||!matches!(key.as_str(),"given"|"family"|"organization"|"note")&&text.trim().is_empty(){return Err(failure("invalid_request","invalid bounded Contacts text"));}}
    }
    for key in ["limit","offset"]{if a.get(key).is_some()&&integer(&a[key]).is_none_or(|n|n<if key=="limit"{1}else{0}||n>if key=="limit"{1000}else{10000}){return Err(failure("invalid_request","invalid Contacts integer paging"));}}
    if matches!(sub,"group"|"group-update"|"group-delete"|"group-add-member"|"group-remove-member"|"contact"|"update"|"delete"|"vcard")&&a.get("id").is_none(){return Err(failure("invalid_request","Contacts selector requires exact id"));}
    if matches!(sub,"group-create"|"group-update")&&a.get("name").is_none()||matches!(sub,"group-add-member"|"group-remove-member")&&a.get("contact").is_none(){return Err(failure("invalid_request","Contacts group requires exact name/member"));}
    if matches!(sub,"create"|"update")&&!MUTABLE.iter().any(|key|a.get(key).is_some()){return Err(failure("invalid_request","Contacts mutation requires fields"));}
    if sub=="find"&&["query","name","email","phone"].iter().filter(|key|a.get(**key).is_some()).count()!=1{return Err(failure("invalid_request","Contacts find requires one query mode"));}
    if sub=="list"&&a.get("container").is_some()&&a.get("group").is_some(){return Err(failure("invalid_request","Contacts requires one store/group scope"));}
    if let Some(keys)=a["keys"].as_str(){let rows=keys.split(',').collect::<Vec<_>>();if rows.len()>OUTPUT_KEYS.len()||rows.iter().collect::<std::collections::HashSet<_>>().len()!=rows.len()||rows.iter().any(|key|!OUTPUT_KEYS.contains(key)){return Err(failure("invalid_request","unknown or duplicate Contact output key"));}}
    if matches!(sub,"create"|"update"){
        for key in ["email","phone"]{if let Some(raw)=a[key].as_str(){labeled(raw)?;}}
        if let Some(raw)=a["postal"].as_str(){let Some((label,fields))=raw.split_once(':')else{return Err(failure("invalid_request","Contacts postal requires label and five fields"));};if label.is_empty()||label.len()>128||fields.split(';').count()!=5{return Err(failure("invalid_request","Contacts postal requires label and five fields"));}}
        if let Some(raw)=a["birthday"].as_str(){let format=time::format_description::parse("[year]-[month]-[day]").unwrap();if raw.len()!=10||raw.starts_with("0000")||time::Date::parse(raw,&format).is_err(){return Err(failure("invalid_request","Contacts birthday is not an actual calendar date within years 1..9999"));}}
    }
    if let Some(token)=a["since"].as_str(){use base64::{Engine,engine::general_purpose::STANDARD};if STANDARD.decode(token).ok().is_none_or(|bytes|STANDARD.encode(bytes)!=token){return Err(failure("invalid_request","Contacts history token requires canonical base64"));}}
    if sub=="import-vcard"{crate::filesystem::absolute(a["path"].as_str().ok_or_else(||failure("invalid_request","Contacts import requires path"))?)?;}
    if serde_json::to_vec(a).map_or(true,|bytes|bytes.len()>262144){return Err(failure("resource_limit","Contacts request exceeds 256KiB"));}Ok(())
}
pub(crate) fn labeled(raw:&str)->Result<Vec<(&str,&str)>,Value>{let rows=raw.split(',').map(|row|row.split_once(':').filter(|(label,value)|!label.is_empty()&&label.len()<=128&&!value.is_empty()).ok_or_else(||failure("invalid_request","Contacts label:value pairs required"))).collect::<Result<Vec<_>,_>>()?;if rows.len()>32{return Err(failure("resource_limit","Contacts labeled fields exceed 32"));}Ok(rows)}
pub(crate) fn project(a:&Value,mut row:Value)->Value{if let Some(keys)=a["keys"].as_str(){let keys=keys.split(',').collect::<Vec<_>>();row.as_object_mut().unwrap().retain(|key,_|key=="id"||keys.contains(&key.as_str())||key=="requires_entitlement"&&keys.contains(&"note"));}row}
pub(crate) fn image_requested(a:&Value,key:&str)->bool{a["keys"].as_str().map_or(key=="thumbnailDataUrl",|keys|keys.split(',').any(|value|value==key))}
pub(crate) fn image_url(bytes:&[u8],thumbnail:bool)->Result<String,Value>{
    use base64::{Engine,engine::general_purpose::STANDARD};
    if bytes.is_empty()||bytes.len()>196608{return Err(failure("resource_limit","native Contact image exceeds 192KiB; select fields without image data"));}
    let image=crate::thumbnail::decode_raster(bytes)?;
    let(mime,data)=if thumbnail{let image=image::DynamicImage::ImageRgba8(image).thumbnail(256,256).to_rgba8();("image/png",crate::capture::encode(&image,"png",85)?)}else{
        let mime=match image::guess_format(bytes){Ok(image::ImageFormat::Png)=>"image/png",Ok(image::ImageFormat::Jpeg)=>"image/jpeg",Ok(image::ImageFormat::WebP)=>"image/webp",_=>return Err(failure("unsupported_target","native Contact image format is not supported by the selected bounded raster decoder"))};(mime,bytes.to_vec())
    };let url=format!("data:{mime};base64,{}",STANDARD.encode(data));if url.len()>262144{return Err(failure("resource_limit","native Contact image URL exceeds 256KiB; select fields without image data"));}Ok(url)
}
pub(crate) fn vcard_inputs(bytes:&[u8])->Result<Vec<String>,Value>{
    if bytes.is_empty()||bytes.len()>262144{return Err(failure("resource_limit","Contacts import requires 1..256KiB of vCard input"));}
    let text=std::str::from_utf8(bytes).map_err(|_|failure("invalid_request","Contacts vCard input requires UTF8"))?;
    let mut cards=Vec::new();let mut current:Option<String>=None;
    for line in text.lines(){
        if line.eq_ignore_ascii_case("BEGIN:VCARD"){
            if current.is_some()||cards.len()>=100{return Err(failure("invalid_request","vCard import requires 1..100 complete, unnested cards"));}
            current=Some("BEGIN:VCARD\r\n".into());
        }else if line.eq_ignore_ascii_case("END:VCARD"){
            let Some(mut card)=current.take()else{return Err(failure("invalid_request","vCard end has no matching start"));};card.push_str("END:VCARD\r\n");cards.push(card);
        }else if let Some(card)=current.as_mut(){card.push_str(line);card.push_str("\r\n");}
        else if !line.trim().is_empty(){return Err(failure("invalid_request","vCard input contains content outside a card"));}
    }
    if current.is_some()||cards.is_empty(){return Err(failure("invalid_request","vCard input is empty or incomplete"));}Ok(cards)
}
fn reply_error(a:&Value,data:&Value)->Option<String>{
    fn bounded(v:&Value,depth:usize)->bool{if depth>8{return false;}match v{Value::String(s)=>s.len()<=262144&&!s.contains('\0'),Value::Array(rows)=>rows.len()<=1000&&rows.iter().all(|r|bounded(r,depth+1)),Value::Object(rows)=>rows.values().all(|r|bounded(r,depth+1)),_=>true}}
    if serde_json::to_vec(data).map_or(true,|bytes|bytes.len()>1048576)||!bounded(data,0){return Some("Contacts native receipt exceeds bounded output".into());}
    macro_rules! shape{($t:ty)=>{serde_json::from_value::<$t>(data.clone()).map(|_|())}}
    let sub=a["sub"].as_str().unwrap();
    let shape=match sub{"status"=>shape!(DesktopContactsStatus),"request"=>shape!(DesktopContactsRequested),"containers"=>shape!(DesktopContactsContainers),"default-container"=>shape!(DesktopContactsIdentity),"groups"=>shape!(DesktopContactsGroups),"group"|"group-create"|"group-update"=>shape!(DesktopContactsGroup),"list"=>shape!(DesktopContactsList),"find"=>shape!(DesktopContactsFound),"group-delete"|"delete"=>shape!(DesktopContactsDeleted),"group-add-member"|"group-remove-member"=>shape!(DesktopContactsMember),"vcard"=>shape!(DesktopContactsVCard),"import-vcard"=>shape!(DesktopContactsImported),"current-token"=>shape!(DesktopContactsToken),"changes"=>shape!(DesktopContactsChanges),_=>shape!(DesktopContactsRow)};
    if let Err(error)=shape{return Some(format!("Contacts native receipt violates selector schema: {}",error.to_string().chars().take(256).collect::<String>()));}
    let identity=|v:&Value|v.as_str().is_some_and(|s|!s.trim().is_empty()&&s.len()<=4096&&!s.contains('\0'));
    for key in ["containers","groups","contacts","matches"]{if let Some(rows)=data[key].as_array(){let ids=rows.iter().map(|r|&r["id"]).collect::<Vec<_>>();if ids.iter().any(|id|!identity(id))||ids.iter().filter_map(|id|id.as_str()).collect::<std::collections::HashSet<_>>().len()!=ids.len(){return Some("invalid or duplicate native Contacts identities".into());}}}
    if data.get("id").is_some()&&!identity(&data["id"]){return Some("missing exact native Contacts identity".into());}
    if sub=="list"&&(integer(&data["limit"])!=Some(integer(&a["limit"]).unwrap_or(100))||integer(&data["offset"])!=Some(integer(&a["offset"]).unwrap_or(0))||data["contacts"].as_array().unwrap().len()as u64>integer(&data["limit"]).unwrap_or(0)){return Some("Contacts paging receipt differs from request".into());}
    if matches!(sub,"group-delete"|"delete")&&(data["ok"]!=true||data["id"]!=a["id"]){return Some("Contacts deletion receipt differs from target".into());}
    if matches!(sub,"group-add-member"|"group-remove-member")&&(data["ok"]!=true||data["group"]!=a["id"]||data["contact"]!=a["contact"]||data["added"]!=(sub=="group-add-member")){return Some("Contacts membership receipt differs from target or effect".into());}
    if sub=="vcard"&&(integer(&data["bytes"])!=Some(data["vcard"].as_str().unwrap().len()as u64)||integer(&data["bytes"]).is_none_or(|n|n>262144)){return Some("vCard bytes differ from actual encoded content".into());}
    if sub=="import-vcard"{let ids=data["ids"].as_array().unwrap();if ids.is_empty()||ids.len()>100||integer(&data["imported"])!=Some(ids.len()as u64)||ids.iter().any(|id|!identity(id))||ids.iter().filter_map(Value::as_str).collect::<std::collections::HashSet<_>>().len()!=ids.len(){return Some("invalid actual imported Contacts identities".into());}}
    use base64::{Engine,engine::general_purpose::STANDARD};
    for key in ["token","currentToken"]{if let Some(token)=data[key].as_str(){if token.is_empty()||token.len()>16384||STANDARD.decode(token).ok().is_none_or(|bytes|STANDARD.encode(bytes)!=token){return Some("invalid canonical native Contacts token".into());}}}
    if sub=="changes"{
        let events=data["events"].as_array().unwrap();if events.len()as u64>integer(&a["limit"]).unwrap_or(1000){return Some("Contacts native history exceeds requested limit".into());}
        for event in events{
            let required:&[&str]=match event["type"].as_str().unwrap(){"addContact"|"updateContact"|"deleteContact"=>&["contactId"],"addGroup"|"updateGroup"|"deleteGroup"=>&["groupId"],"addMemberToGroup"|"removeMemberFromGroup"=>&["groupId","contactId"],"addSubgroup"|"removeSubgroup"=>&["parent","child"],"dropEverything"=>&[],_=>return Some("Contacts history has an unknown native event; token withheld".into())};
            if required.iter().any(|key|!identity(&event[*key]))||event.as_object().unwrap().keys().any(|key|key!="type"&&!required.contains(&key.as_str())){return Some("Contacts history event has incomplete or unrelated native identities".into());}
        }
    }None
}
pub fn dispatch(a:&Value)->Value{
    if let Err(error)=validate(a){return error;}let Ok(_active)=ACTIVE.try_lock()else{return failure("resource_limit","another Contacts native helper remains active; no work queued");};
    match crate::thumbnail::image_helper("--contacts-engine",a,Instant::now()+Duration::from_secs(55)){Ok(data)=>match reply_error(a,&data){Some(error)=>failure("partial_result",error),None=>success(data)},Err(error)if matches!(a["sub"].as_str(),Some("create"|"update"|"delete"|"group-create"|"group-update"|"group-delete"|"group-add-member"|"group-remove-member"|"import-vcard"))&&(error["code"]=="resource_limit"||error["code"]=="provider_failed"&&error["error"].as_str().is_some_and(|message|message.starts_with("native helper failed")))=>failure("timeout_unknown_outcome","Contacts helper did not return a complete receipt; owned helper was reaped, native mutation outcome remains unknown and no request was replayed"),Err(error)=>error}
}
pub(crate) fn helper(parent:u32)->io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    let bytes=crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("Contacts helper requires one request"))?;let a:Value=serde_json::from_slice(&bytes)?;
    let result=match validate(&a){Err(error)=>error,Ok(())=>{
        #[cfg(windows)]{match crate::contacts_windows::native(&a){Ok(data)=>success(data),Err(error)=>error}}
        #[cfg(target_os="linux")]{match crate::contacts_linux::native(&a){Ok(data)=>success(data),Err(error)=>error}}
        #[cfg(not(any(windows,target_os="linux")))]{failure("unsupported_operation","native Contacts helper requires Windows or Linux")}
    }};
    let result=if result["success"]==true{match reply_error(&a,&result["data"]){Some(error)=>failure("partial_result",error),None=>result}}else{result};
    let result=if serde_json::to_vec(&result)?.len()>1048576{failure("partial_result","Contacts native receipt exceeds 1MiB after possible effect")}else{result};crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(&result)?)
}
pub fn capability(session:&str)->Value{json!({"operation":"contacts","compiled":cfg!(any(windows,target_os="linux")),"present":cfg!(any(windows,target_os="linux")),"effective":false,"permission":"unknown","session":session,"background":"semantic","provider":"Windows ContactStore / Evolution Data Server owned helper","versions":{"contract":"1"},"limits":["Twenty-two exact request selectors; actual native store prerequisites and operation-level backends remain required.","One 55-second owned helper; paging 1..1000, offset 0..10000;256KiB vCard, 100 import contacts and 1MiB replies; no mutation replay.","Native groups/history, complete field and store equivalence, permissions/package identity, native dependencies/licenses and installed qualification remain open."]})}
#[cfg(test)]mod tests{use super::*;#[test]fn contacts_refuses_discarded_fields_and_preserves_projection(){for action in [json!({"type":"desktop_contacts","sub":"status","id":"ignored"}),json!({"type":"desktop_contacts","sub":"find","query":"one","email":"two"}),json!({"type":"desktop_contacts","sub":"list","keys":"givenName,givenName"}),json!({"type":"desktop_contacts","sub":"create","birthday":"2026-02-30"})]{assert!(validate(&action).is_err());}assert_eq!(project(&json!({"keys":"givenName"}),json!({"id":"actual","givenName":"Actual","familyName":"omit"})),json!({"id":"actual","givenName":"Actual"}));}}

#[cfg(test)]mod receipt_tests{
    use super::*;
    #[test]fn import_keeps_every_card_and_refuses_incomplete_or_outside_content(){
        let cards=vcard_inputs(b"BEGIN:VCARD\nVERSION:3.0\nFN:One\nEND:VCARD\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Two\r\nEND:VCARD\r\n").unwrap();assert_eq!(cards.len(),2);assert!(cards[0].contains("FN:One"));assert!(cards[1].contains("FN:Two"));
        for bytes in [b"BEGIN:VCARD\nFN:incomplete".as_slice(),b"outside\nBEGIN:VCARD\nEND:VCARD",b"BEGIN:VCARD\nBEGIN:VCARD\nEND:VCARD",b"END:VCARD",b""]{assert!(vcard_inputs(bytes).is_err());}
        let many="BEGIN:VCARD\nEND:VCARD\n".repeat(101);assert!(vcard_inputs(many.as_bytes()).is_err());
    }
    #[test]fn native_receipts_correlate_targets_and_reject_lost_history(){
        assert!(reply_error(&json!({"sub":"list","limit":2.0,"offset":1.0}),&json!({"limit":2,"offset":1,"contacts":[{"id":"actual"}]})).is_none());
        assert!(reply_error(&json!({"sub":"list","limit":2}),&json!({"limit":1,"offset":0,"contacts":[{"id":"actual"}]})).is_some());
        assert!(reply_error(&json!({"sub":"delete","id":"one"}),&json!({"ok":true,"id":"other"})).is_some());
        assert!(reply_error(&json!({"sub":"current-token"}),&json!({"token":"%%%"})).is_some());
        assert!(reply_error(&json!({"sub":"changes"}),&json!({"currentToken":"YWN0dWFs","events":[{"type":"deleteContact"}]})).is_some());
        assert!(reply_error(&json!({"sub":"changes"}),&json!({"currentToken":"YWN0dWFs","events":[{"type":"unknownNativeEvent"}]})).is_some());
        assert!(validate(&json!({"type":"desktop_contacts","sub":"list","limit":2.0,"offset":1.0})).is_ok());
    }
    #[test]fn contact_image_urls_use_the_encoded_format_and_keep_projection_opt_in(){
        let image=image::RgbaImage::from_pixel(2,2,image::Rgba([17,33,91,255]));let png=crate::capture::encode(&image,"png",85).unwrap();let jpeg=crate::capture::encode(&image,"jpeg",85).unwrap();
        assert!(image_url(&png,false).unwrap().starts_with("data:image/png;base64,"));assert!(image_url(&jpeg,false).unwrap().starts_with("data:image/jpeg;base64,"));assert!(image_url(&jpeg,true).unwrap().starts_with("data:image/png;base64,"));assert!(image_url(b"not an image",false).is_err());assert!(image_url(&vec![0;196609],false).is_err());
        assert!(image_requested(&json!({}),"thumbnailDataUrl"));assert!(!image_requested(&json!({}),"imageDataUrl"));assert!(!image_requested(&json!({"keys":"givenName"}),"thumbnailDataUrl"));assert!(image_requested(&json!({"keys":"imageDataUrl"}),"imageDataUrl"));
    }
}
