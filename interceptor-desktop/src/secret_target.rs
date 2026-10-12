use serde_json::Value;
use std::{collections::HashMap,time::{Duration,Instant}};

struct Grant {name:String,reference:String,identity:Value,at:Instant}
#[derive(Default)]pub struct Grants {items:HashMap<String,Grant>}
pub(crate) fn random_token()->std::io::Result<String>{
    let mut bytes=[0_u8;32];
    #[cfg(windows)]unsafe{
        use windows::Win32::Security::Cryptography::{BCryptGenRandom,BCRYPT_USE_SYSTEM_PREFERRED_RNG};
        BCryptGenRandom(None,&mut bytes,BCRYPT_USE_SYSTEM_PREFERRED_RNG).ok().map_err(std::io::Error::other)?;
    }
    #[cfg(not(windows))]{use std::io::Read;std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;}
    Ok(bytes.iter().map(|byte|format!("{byte:02x}")).collect())
}
impl Grants {
    pub fn bind(&mut self,name:&str,reference:&str,identity:Value)->std::io::Result<String>{
        self.items.retain(|_,grant|grant.at.elapsed()<Duration::from_secs(300));
        if self.items.len()>=64{return Err(std::io::Error::other("too many pending native credential grants"));}
        let token=random_token()?;
        self.items.insert(token.clone(),Grant{name:name.to_owned(),reference:reference.to_owned(),identity,at:Instant::now()});Ok(token)
    }
    pub fn check(&self,name:&str,reference:&str,token:&str,identity:&Value)->bool{
        self.items.get(token).is_some_and(|grant|grant.at.elapsed()<Duration::from_secs(300)&&grant.name==name&&grant.reference==reference&&matches(&grant.identity,identity))
    }
    pub fn consume(&mut self,name:&str,reference:&str,token:&str,identity:&Value)->bool{
        let allowed=self.check(name,reference,token,identity);
        if allowed{self.items.remove(token);}allowed
    }
}

pub fn valid(value:&Value)->bool {
    if serde_json::from_value::<crate::contract_generated::DesktopAxProcessIdentity>(value.clone()).is_err(){return false;}
    let pid=value["pid"].as_f64().unwrap_or(0.0);
    if pid<1.0||pid>i32::MAX as f64||pid.fract()!=0.0{return false;}
    for key in ["executable","user","session","creation","image"] {
        if value[key].as_str().is_none_or(|text|text.is_empty()||text.len()>4096||text.contains(['\0','\r','\n'])){return false;}
    }
    true
}

pub fn matches(expected:&Value,current:&Value)->bool {
    valid(expected)&&valid(current)&&expected["pid"].as_f64()==current["pid"].as_f64()&&
        ["host","executable","user","session","creation","image"].iter().all(|key|expected[*key]==current[*key])
}

#[cfg(test)]mod tests {
    use super::*;use serde_json::json;
    #[test]fn identity_binds_every_native_field_and_rejects_malformed_values(){
        let current=json!({"host":"linux","pid":42,"executable":"/owned/fixture","user":"1000","session":"1:100","creation":"1234","image":"device:inode:ctime"});
        assert!(matches(&current,&current));
        for key in ["host","pid","executable","user","session","creation","image"]{let mut changed=current.clone();changed[key]=if key=="pid"{json!(43)}else{json!("changed")};assert!(!matches(&changed,&current));}
        for bad in [Value::Null,json!({}),{let mut v=current.clone();v["extra"]=json!(true);v},{let mut v=current.clone();v["pid"]=json!(42.5);v},{let mut v=current.clone();v["creation"]=json!("\0");v}]{assert!(!valid(&bad));}
    }
    #[test]fn grants_are_scoped_single_use_expiring_and_bounded(){
        let identity=json!({"host":"linux","pid":42,"executable":"/owned/fixture","user":"1000","session":"1:100","creation":"1234","image":"device:inode:ctime"});
        let mut grants=Grants::default();let first=grants.bind("owned","e42",identity.clone()).unwrap();let second=grants.bind("owned","e42",identity.clone()).unwrap();
        assert_ne!(first,second);assert_eq!(first.len(),64);assert!(grants.check("owned","e42",&first,&identity));
        assert!(!grants.check("other","e42",&first,&identity));assert!(!grants.check("owned","e43",&first,&identity));
        let mut replaced=identity.clone();replaced["creation"]=json!("replacement");assert!(!grants.check("owned","e42",&first,&replaced));
        assert!(grants.consume("owned","e42",&first,&identity));assert!(!grants.consume("owned","e42",&first,&identity));
        grants.items.get_mut(&second).unwrap().at=Instant::now()-Duration::from_secs(301);assert!(!grants.check("owned","e42",&second,&identity));
        for _ in 0..64{grants.bind("owned","e42",identity.clone()).unwrap();}assert!(grants.bind("owned","e42",identity).is_err());
    }
}
