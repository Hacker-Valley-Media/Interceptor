//! Store snapshots for verbs whose macOS backend keeps change history the Windows/Linux store
//! does not (contacts change tokens, Linux calendar tail). A snapshot maps each item id to a
//! digest of its contents; comparing two snapshots gives the real adds, updates and deletes.
//! Files are private to the user (0700 folder, 0600 files) under the user's state folder.
use crate::failure;
use serde_json::{Value,json};
use std::{collections::BTreeMap,path::PathBuf};
type Result<T>=std::result::Result<T,Value>;
pub(crate) type Digests=BTreeMap<String,String>;

pub(crate) fn digest(value:&Value)->String{
    use sha2::{Digest,Sha256};
    Sha256::digest(serde_json::to_vec(value).unwrap_or_default()).iter().take(16).map(|b|format!("{b:02x}")).collect()
}
pub(crate) fn folder(name:&str)->Result<PathBuf>{
    let error=|e:std::io::Error|failure("permission_denied",format!("private state folder is unavailable: {e}"));
    // The provider's private runtime dir (same helper the monitor uses); tokens are ephemeral, so
    // living beside the monitor sessions is correct. shared_root lets the shared base pre-exist.
    let base=crate::filesystem::temp_dir().map_err(|e|failure("provider_failed",e))?.join("interceptor-desktop-state");
    crate::monitor::private_directory(&base,true,true).map_err(error)?;
    let dir=base.join(name);crate::monitor::private_directory(&dir,true,false).map_err(error)?;Ok(dir)
}
pub(crate) fn load(path:&std::path::Path)->Option<Value>{serde_json::from_slice(&std::fs::read(path).ok()?).ok()}
pub(crate) fn save(path:&std::path::Path,value:&Value)->Result<()>{
    use std::io::Write;
    let error=|e:std::io::Error|failure("provider_failed",format!("private state could not be saved: {e}"));
    let temp=path.with_extension(format!("tmp{}",std::process::id()));let _=std::fs::remove_file(&temp);
    let mut file=crate::monitor::private_file(&temp,true).map_err(error)?;
    file.write_all(&serde_json::to_vec(value).unwrap()).and_then(|_|file.sync_all()).map_err(error)?;drop(file);
    std::fs::rename(&temp,path).map_err(error)
}
/// (added, changed, removed) ids between two snapshots.
pub(crate) fn diff(old:&Digests,new:&Digests)->(Vec<String>,Vec<String>,Vec<String>){
    let added=new.keys().filter(|k|!old.contains_key(*k)).cloned().collect();
    let changed=new.iter().filter(|(k,v)|old.get(*k).is_some_and(|o|o!=*v)).map(|(k,_)|k.clone()).collect();
    let removed=old.keys().filter(|k|!new.contains_key(*k)).cloned().collect();
    (added,changed,removed)
}
pub(crate) fn digests(value:&Value)->Digests{value.as_object().map(|o|o.iter().filter_map(|(k,v)|v.as_str().map(|v|(k.clone(),v.to_owned()))).collect()).unwrap_or_default()}

/// Contacts `current-token` / `changes`: save the present store as a token, and for `changes`
/// compare it with the snapshot the starting token names. At most 32 tokens are kept.
pub(crate) fn contact_history(a:&Value,contacts:Digests,groups:Digests)->Result<Value>{
    use base64::{Engine,engine::general_purpose::STANDARD};
    let dir=folder("contacts-tokens")?;
    let mut raw=[0u8;18];getrandom(&mut raw)?;
    let token=STANDARD.encode(raw);let hex=|bytes:&[u8]|bytes.iter().map(|b|format!("{b:02x}")).collect::<String>();
    let snapshot=json!({"contacts":contacts,"groups":groups});
    let events=if a["sub"]=="changes"{
        let mut events=vec![];
        let (old_contacts,old_groups)=match a["since"].as_str(){
            Some(since)=>{
                let bytes=STANDARD.decode(since).map_err(|_|failure("invalid_request","contacts change token is not valid"))?;
                let old=load(&dir.join(format!("{}.json",hex(&bytes)))).ok_or_else(||failure("invalid_request","this contacts change token is unknown or expired here; take a new one with contacts current-token"))?;
                (digests(&old["contacts"]),digests(&old["groups"]))
            },
            // No starting token: the whole store, as macOS answers a history fetch without one.
            None=>{events.push(json!({"type":"dropEverything"}));(Digests::new(),Digests::new())},
        };
        let(added,changed,removed)=diff(&old_groups,&groups);
        for(kind,ids)in[("addGroup",added),("updateGroup",changed),("deleteGroup",removed)]{for id in ids{events.push(json!({"type":kind,"groupId":id}));}}
        let(added,changed,removed)=diff(&old_contacts,&contacts);
        for(kind,ids)in[("addContact",added),("updateContact",changed),("deleteContact",removed)]{for id in ids{events.push(json!({"type":kind,"contactId":id}));}}
        let limit=a["limit"].as_f64().unwrap_or(1000.0)as usize;
        if events.len()>limit{return Err(failure("resource_limit",format!("{} contact changes exceed --limit {limit}; the starting token was not advanced",events.len())));}
        Some(events)
    }else{None};
    save(&dir.join(format!("{}.json",hex(&raw))),&snapshot)?;
    let mut saved:Vec<_>=std::fs::read_dir(&dir).map(|r|r.flatten().filter(|e|e.path().extension().is_some_and(|x|x=="json")).filter_map(|e|Some((e.metadata().ok()?.modified().ok()?,e.path()))).collect()).unwrap_or_default();
    saved.sort();while saved.len()>32{let _=std::fs::remove_file(saved.remove(0).1);}
    Ok(match events{Some(events)=>json!({"currentToken":token,"events":events}),None=>json!({"token":token})})
}
fn getrandom(buffer:&mut [u8])->Result<()>{
    #[cfg(unix)]{use std::io::Read;std::fs::File::open("/dev/urandom").and_then(|mut f|f.read_exact(buffer)).map_err(|e|failure("provider_failed",format!("random token unavailable: {e}")))}
    #[cfg(windows)]{unsafe{windows::Win32::Security::Cryptography::BCryptGenRandom(None,buffer,windows::Win32::Security::Cryptography::BCRYPT_USE_SYSTEM_PREFERRED_RNG)}.ok().map_err(|e|failure("provider_failed",format!("random token unavailable: {e}")))}
}

/// Calendar `tail` without native change tracking: count item changes since the first `tail`.
/// Returns the macOS shape {tailing, changeCount, lastChange}.
pub(crate) fn calendar_tail(current:Digests)->Result<Value>{
    let path=folder("calendar-tail")?.join("state.json");
    let now=time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default();
    let Some(old)=load(&path)else{save(&path,&json!({"items":current,"count":0,"lastChange":null}))?;return Ok(json!({"tailing":true,"changeCount":0,"lastChange":null}));};
    let(added,changed,removed)=diff(&digests(&old["items"]),&current);
    let delta=(added.len()+changed.len()+removed.len())as u64;
    let count=old["count"].as_u64().unwrap_or(0)+delta;
    let last=if delta>0{json!(now)}else{old["lastChange"].clone()};
    save(&path,&json!({"items":current,"count":count,"lastChange":last}))?;
    Ok(json!({"tailing":true,"changeCount":count,"lastChange":last}))
}
/// Calendar `tail` with a native change count (Windows AppointmentStore change tracker).
pub(crate) fn calendar_tail_count(count:u64)->Result<Value>{
    let path=folder("calendar-tail")?.join("count.json");
    let now=time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default();
    let old=load(&path).unwrap_or(json!({"count":0,"lastChange":null}));
    let last=if count>old["count"].as_u64().unwrap_or(0){json!(now)}else if count==0{Value::Null}else{old["lastChange"].clone()};
    save(&path,&json!({"count":count,"lastChange":last}))?;
    Ok(json!({"tailing":true,"changeCount":count,"lastChange":last}))
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn snapshots_compare_into_adds_updates_and_deletes(){
        let old:Digests=[("a","1"),("b","2"),("c","3")].iter().map(|(k,v)|(k.to_string(),v.to_string())).collect();
        let new:Digests=[("a","1"),("b","9"),("d","4")].iter().map(|(k,v)|(k.to_string(),v.to_string())).collect();
        assert_eq!(diff(&old,&new),(vec!["d".to_string()],vec!["b".to_string()],vec!["c".to_string()]));
        assert_eq!(digest(&json!({"x":1})),digest(&json!({"x":1})));assert_ne!(digest(&json!({"x":1})),digest(&json!({"x":2})));
    }
}
