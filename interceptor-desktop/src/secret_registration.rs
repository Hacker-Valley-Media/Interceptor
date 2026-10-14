//! Private child stdio protocol. Never exposed as a provider/CLI operation.
use crate::{failure,success};
use serde::Deserialize;
use serde_json::{Value,json};
use std::io::{self,Read};

pub const MAX_VALUE_BYTES:usize=8192;
#[derive(Deserialize)]#[serde(deny_unknown_fields)]pub struct Registration{
    pub name:String,pub gate:String,pub targets:Vec<String>,pub session:String,
}
impl Registration{
    fn valid(&self)->bool{
        (1..=64).contains(&self.name.len())&&self.name.bytes().all(|c|c.is_ascii_alphanumeric()||b"._-".contains(&c))&&self.name.as_bytes()[0].is_ascii_alphanumeric()
            &&["none","touchid","biometry"].contains(&self.gate.as_str())&&(1..=64).contains(&self.targets.len())
            &&self.targets.iter().all(|t|!t.is_empty()&&t.len()<=1024&&!t.contains(['\0','\n','\r'])&&(t=="any"||t=="sudo"||t=="ios"||["browser:","macos:","windows:","linux:"].iter().any(|p|t.starts_with(p)&&t.len()>p.len())))
            &&self.targets.iter().map(|t|t.len()).sum::<usize>()<=8192&&self.session.len()<=256&&!self.session.contains('\0')
    }
    pub fn policy_text(&self)->String{format!("Secret: {}\nRelease: {}\nTargets: {}{}",self.name,match self.gate.as_str(){"none"=>"Unattended (no prompt)","biometry"=>"Biometric approval only, unavailable on current Windows/Linux backends",_=>"Native approval (Windows Hello or account password)"},self.targets.join(", "),if self.session.is_empty(){String::new()}else{format!("\nRequested by session: {}",self.session)})}
}
pub fn value_matches(value:&str,confirmation:&str)->bool{!value.is_empty()&&value.len()<=MAX_VALUE_BYTES&&!value.contains('\0')&&value==confirmation}
pub fn helper()->io::Result<()>{
    let mut header=[0u8;4];io::stdin().lock().read_exact(&mut header)?;let size=u32::from_le_bytes(header)as usize;
    if size==0||size>32768{return Err(io::Error::new(io::ErrorKind::InvalidData,"invalid registration request length"));}
    let mut bytes=vec![0u8;size];io::stdin().lock().read_exact(&mut bytes)?;
    let request=serde_json::from_slice::<Registration>(&bytes);bytes.fill(0);
    let result=match request{
        Ok(request)if request.valid()=>match crate::auth::identity(){
            Err(error)=>error,Ok(before)=>{
                #[cfg(windows)]let result=crate::auth_windows::register(&request);
                #[cfg(target_os="linux")]let result=crate::auth_linux::register(&request);
                #[cfg(not(any(windows,target_os="linux")))]let result=failure("unsupported_operation","macOS uses its signed secure registration panel");
                if crate::auth::identity().ok().as_ref()==Some(&before){result}else{failure("permission_denied","registration login changed; the entered value was discarded")}
            }
        },_=>failure("invalid_request","invalid private registration request"),
    };
    let mut bytes=serde_json::to_vec(&result)?;let result=crate::write_frame(&mut io::stdout().lock(),&bytes);for byte in &mut bytes{unsafe{std::ptr::write_volatile(byte,0);}}result
}
pub fn registered(value:String)->Value{success(json!({"cancelled":false,"value":value}))}
pub fn cancelled()->Value{success(json!({"cancelled":true}))}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn vault_reply_declarations_decode_shared_fixtures(){
        use crate::contract_generated::*;
        let fixtures:Value=serde_json::from_str(include_str!("../../shared/desktop-secret-reply-fixtures.json")).unwrap();
        for fixture in fixtures["cases"].as_array().unwrap(){
            let data=fixture["data"].clone();
            let valid=match fixture["action"]["sub"].as_str().unwrap(){
                "status"=>serde_json::from_value::<DesktopSecretStatusData>(data).is_ok(),
                "list"=>serde_json::from_value::<DesktopSecretListData>(data).is_ok(),
                "register"|"set"=>serde_json::from_value::<DesktopSecretStoredData>(data).is_ok(),
                "rm"=>serde_json::from_value::<DesktopSecretRemovedData>(data).is_ok(),
                "unlock"=>serde_json::from_value::<DesktopSecretUnlockedData>(data).is_ok(),
                "lock"=>serde_json::from_value::<DesktopSecretLockedData>(data).is_ok(),
                "reveal"=>serde_json::from_value::<DesktopSecretRevealedData>(data).is_ok(),
                _=>panic!("unknown vault fixture selector"),
            };
            assert_eq!(valid,fixture["shapeValid"].as_bool().unwrap(),"{}",fixture["name"]);
        }
    }
    #[test]fn matching_values_and_registration_policy_are_strict(){
        assert!(value_matches("Owned Unicode 🙂","Owned Unicode 🙂"));
        for(value,confirmation)in[("",""),("a","b"),("a\0","a\0")]{assert!(!value_matches(value,confirmation));}
        assert!(!value_matches(&"x".repeat(MAX_VALUE_BYTES+1),&"x".repeat(MAX_VALUE_BYTES+1)));
        let valid=json!({"name":"owned-185","gate":"none","targets":["any"],"session":"owned"});assert!(serde_json::from_value::<Registration>(valid.clone()).unwrap().valid());
        for(key,value)in[("name",json!("bad/name")),("gate",json!("unknown")),("targets",json!([])),("targets",json!(["browser:"])),("session",json!("x\0"))]{let mut invalid=valid.clone();invalid[key]=value;assert!(!serde_json::from_value::<Registration>(invalid).unwrap().valid());}
        let mut extra=valid;extra["value"]=json!("credential must never be input to this helper");assert!(serde_json::from_value::<Registration>(extra).is_err());
    }
}
