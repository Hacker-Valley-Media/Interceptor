//! Validate the installed compositor payload before any plugin IPC mutation.
use std::{fs::OpenOptions,io::{self,Read,Write},path::{Path,PathBuf},os::unix::fs::{MetadataExt,OpenOptionsExt,DirBuilderExt}};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};

#[allow(non_snake_case)]
#[derive(Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
struct FileDigest{path:String,sha256:String}
#[allow(non_snake_case)]
#[derive(Deserialize,Serialize)]
#[serde(deny_unknown_fields)]
struct Manifest{
    schemaVersion:u32,protocolVersion:u32,platform:String,architecture:String,
    hyprlandVersion:String,hyprlandCommit:String,hyprlandABIHash:String,
    compiler:String,compilerIdentity:String,waylandVersion:String,
    headerSHA256:String,sessionAuthSHA256:String,sources:Vec<FileDigest>,headers:Vec<FileDigest>,
    payload:String,payloadSHA256:String,payloadBytes:u64,linkage:String,builtAt:String,
}
pub struct Payload{pub path:PathBuf,pub abi_hash:String,pub sha256:String}
fn invalid(message:&str)->io::Error{io::Error::new(io::ErrorKind::InvalidData,message)}
fn digest(value:&str)->bool{value.len()==64&&value.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn payload_name(name:&str,hash:&str)->bool{
    let prefix=format!("interceptor-pointer-{hash}");
    name.strip_prefix(&prefix).is_some_and(|suffix|suffix==".so"||suffix.strip_prefix('-').and_then(|s|s.strip_suffix(".so")).is_some_and(|nonce|nonce.len()==16&&nonce.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))))
}
fn owned_file(path:&Path,max:u64)->io::Result<Vec<u8>>{
    let mut file=OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC).open(path)?;
    let meta=file.metadata()?;
    if !meta.is_file()||meta.uid()!=unsafe{libc::geteuid()}||meta.mode()&0o022!=0||meta.nlink()!=1{
        return Err(io::Error::new(io::ErrorKind::PermissionDenied,"pointer payload files must be regular, singly linked and owned without group/other write access"));
    }
    if meta.len()==0||meta.len()>max{return Err(invalid("pointer payload file exceeds its bound"));}
    let mut bytes=Vec::new();Read::by_ref(&mut file).take(max+1).read_to_end(&mut bytes)?;
    if bytes.len()as u64!=meta.len(){return Err(invalid("pointer payload file changed while reading"));}Ok(bytes)
}
pub fn read(directory:&Path)->io::Result<Option<Payload>>{
    let meta=match std::fs::symlink_metadata(directory){Ok(meta)=>meta,Err(error)if error.kind()==io::ErrorKind::NotFound=>return Ok(None),Err(error)=>return Err(error)};
    if !directory.is_absolute()||!meta.is_dir()||meta.uid()!=unsafe{libc::geteuid()}||meta.mode()&0o777!=0o700{
        return Err(io::Error::new(io::ErrorKind::PermissionDenied,"pointer payload directory must be absolute, owned and private"));
    }
    let manifest:Manifest=serde_json::from_slice(&owned_file(&directory.join("manifest.json"),1024*1024)?).map_err(|_|invalid("invalid pointer payload manifest"))?;
    let architecture=match std::env::consts::ARCH{"aarch64"=>"arm64","x86_64"=>"x64",_=>return Err(invalid("unsupported pointer architecture"))};
    if manifest.schemaVersion!=1||![1,2,3,4].contains(&manifest.protocolVersion)||manifest.platform!="linux"||manifest.architecture!=architecture||
        manifest.hyprlandVersion!="0.56.1"||manifest.hyprlandCommit!="5c9377c15f85c50648f35ca5a213754f95b93ca0"||
        manifest.compiler!="16.1.1"||manifest.waylandVersion!="1.26.0"||!payload_name(&manifest.payload,&manifest.payloadSHA256)||
        manifest.hyprlandABIHash.is_empty()||manifest.hyprlandABIHash.len()>256||manifest.compilerIdentity.len()>4096||manifest.linkage.len()>65536||manifest.builtAt.len()>128||
        !digest(&manifest.headerSHA256)||!digest(&manifest.sessionAuthSHA256)||!digest(&manifest.payloadSHA256)||
        manifest.sources.len()!=4||manifest.headers.is_empty()||manifest.headers.len()>4096||
        manifest.sources.iter().chain(&manifest.headers).any(|f|f.path.is_empty()||f.path.len()>4096||!digest(&f.sha256)){
        return Err(invalid("pointer payload is not bound to the qualified architecture/compiler/header/runtime contract"));
    }
    let path=directory.join(&manifest.payload);
    if path.to_str().is_none_or(|s|s.bytes().any(|b|!b.is_ascii_alphanumeric()&&!b"/-_.".contains(&b))){return Err(invalid("pointer IPC path contains unsupported characters"));}
    let bytes=owned_file(&path,16*1024*1024)?;
    let machine=if architecture=="arm64"{183}else{62};
    let actual_hash=Sha256::digest(&bytes).iter().map(|byte|format!("{byte:02x}")).collect::<String>();
    if bytes.len()<20||bytes[..6]!=[0x7f,b'E',b'L',b'F',2,1]||u16::from_le_bytes([bytes[18],bytes[19]])!=machine||
        bytes.len()as u64!=manifest.payloadBytes||actual_hash!=manifest.payloadSHA256{
        return Err(invalid("pointer payload architecture, length or SHA256 does not match its manifest"));
    }
    Ok(Some(Payload{path,abi_hash:manifest.hyprlandABIHash,sha256:manifest.payloadSHA256}))
}

/// Stage a checked archive payload under a unique installation name. Reusing
/// an owned unchanged image keeps its inode; fresh installs cannot hit an
/// inactive loader entry retained after uninstall.
pub fn stage(source:&Path,destination:&Path,reuse:Option<&str>)->io::Result<Payload>{
    let input=read(source)?.ok_or_else(||invalid("pointer source is absent"))?;
    let mut manifest:Manifest=serde_json::from_slice(&owned_file(&source.join("manifest.json"),1024*1024)?).map_err(|_|invalid("invalid pointer source manifest"))?;
    if manifest.payloadSHA256!=input.sha256{return Err(invalid("pointer source changed before staging"));}
    let bytes=owned_file(&input.path,16*1024*1024)?;
    let mut nonce=[0u8;8];std::fs::File::open("/dev/urandom")?.read_exact(&mut nonce)?;
    manifest.payload=match reuse{
        Some(name)if payload_name(name,&input.sha256)=>name.to_owned(),
        Some(_)=>return Err(invalid("reused pointer image is not bound to the source digest")),
        None=>format!("interceptor-pointer-{}-{}.so",input.sha256,nonce.iter().map(|byte|format!("{byte:02x}")).collect::<String>()),
    };
    let parent=destination.parent().ok_or_else(||invalid("pointer staging parent is absent"))?;
    let meta=std::fs::symlink_metadata(parent)?;
    if !destination.is_absolute()||!meta.is_dir()||meta.uid()!=unsafe{libc::geteuid()}||meta.mode()&0o777!=0o700{return Err(io::Error::new(io::ErrorKind::PermissionDenied,"pointer staging parent must be owned and private"));}
    std::fs::DirBuilder::new().mode(0o700).create(destination)?;
    let payload=destination.join(&manifest.payload);let metadata=destination.join("manifest.json");
    let result=(||{
        let mut file=OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC).open(&payload)?;file.write_all(&bytes)?;file.sync_all()?;
        let mut file=OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC).open(&metadata)?;file.write_all(&serde_json::to_vec(&manifest).map_err(|e|invalid(&e.to_string()))?)?;file.sync_all()?;
        read(destination)?.ok_or_else(||invalid("staged pointer payload is absent"))
    })();
    if result.is_err(){let _=std::fs::remove_file(payload);let _=std::fs::remove_file(metadata);let _=std::fs::remove_dir(destination);}
    result
}

#[cfg(test)]mod tests{
    use super::*;
    use std::os::unix::fs::{PermissionsExt,symlink};
    #[test]fn payload_binding_rejects_tampering_links_and_malformed_manifests(){
        let directory=std::env::temp_dir().join(format!("interceptor-pointer-payload-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&directory).unwrap();std::fs::set_permissions(&directory,std::fs::Permissions::from_mode(0o700)).unwrap();
        struct Cleanup(PathBuf);impl Drop for Cleanup{fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
        let _cleanup=Cleanup(directory.clone());
        let architecture=if std::env::consts::ARCH=="aarch64"{"arm64"}else{"x64"};
        let mut bytes=vec![0u8;32];bytes[..6].copy_from_slice(&[0x7f,b'E',b'L',b'F',2,1]);bytes[18]=if architecture=="arm64"{183}else{62};
        let hash=Sha256::digest(&bytes).iter().map(|byte|format!("{byte:02x}")).collect::<String>();
        let payload=format!("interceptor-pointer-{hash}.so");
        let (file,manifest_file)=(directory.join(&payload),directory.join("manifest.json"));
        std::fs::write(&file,&bytes).unwrap();
        let hash_record=serde_json::json!({"path":"qualified-header","sha256":"0".repeat(64)});
        let manifest=serde_json::json!({"schemaVersion":1,"protocolVersion":1,"platform":"linux","architecture":architecture,
            "hyprlandVersion":"0.56.1","hyprlandCommit":"5c9377c15f85c50648f35ca5a213754f95b93ca0","hyprlandABIHash":"qualified-abi",
            "compiler":"16.1.1","compilerIdentity":"fixture","waylandVersion":"1.26.0","headerSHA256":"0".repeat(64),"sessionAuthSHA256":"0".repeat(64),
            "sources":[hash_record.clone(),hash_record.clone(),hash_record.clone(),hash_record.clone()],"headers":[hash_record],
            "payload":payload,"payloadSHA256":hash,"payloadBytes":bytes.len(),"linkage":"fixture","builtAt":"2026-10-04T00:00:00Z"});
        std::fs::write(&manifest_file,serde_json::to_vec(&manifest).unwrap()).unwrap();assert!(read(&directory).unwrap().is_some());
        for version in [1,2,3,4,5]{
            let mut versioned=manifest.clone();versioned["protocolVersion"]=serde_json::json!(version);
            std::fs::write(&manifest_file,serde_json::to_vec(&versioned).unwrap()).unwrap();
            if version<=4{assert!(read(&directory).unwrap().is_some());}else{assert_eq!(read(&directory).err().unwrap().kind(),io::ErrorKind::InvalidData);}
        }
        std::fs::write(&manifest_file,serde_json::to_vec(&manifest).unwrap()).unwrap();
        let first=stage(&directory,&directory.join("first"),None).unwrap();
        let second=stage(&directory,&directory.join("second"),None).unwrap();
        assert_ne!(first.path.file_name(),second.path.file_name());assert_eq!(first.sha256,second.sha256);
        let reused=stage(&directory,&directory.join("reused"),first.path.file_name().unwrap().to_str()).unwrap();
        assert_eq!(reused.path.file_name(),first.path.file_name());
        assert_eq!(stage(&directory,&directory.join("invalid"),Some("../../foreign.so")).err().unwrap().kind(),io::ErrorKind::InvalidData);
        assert!(!directory.join("invalid").exists());
        assert_eq!(stage(&directory,&directory.join("first"),None).err().unwrap().kind(),io::ErrorKind::AlreadyExists);
        assert!(read(&directory).unwrap().is_some(),"staging leaves the original source intact");
        bytes[31]=1;std::fs::write(&file,&bytes).unwrap();assert_eq!(read(&directory).err().unwrap().kind(),io::ErrorKind::InvalidData);
        let actual=directory.join("actual.so");std::fs::rename(&file,&actual).unwrap();symlink(&actual,&file).unwrap();assert_eq!(read(&directory).err().unwrap().raw_os_error(),Some(libc::ELOOP));
        std::fs::remove_file(&file).unwrap();std::fs::rename(&actual,&file).unwrap();bytes[31]=0;std::fs::write(&file,&bytes).unwrap();
        let mut wrong=manifest.clone();wrong["architecture"]=serde_json::json!(if architecture=="arm64"{"x64"}else{"arm64"});
        std::fs::write(&manifest_file,serde_json::to_vec(&wrong).unwrap()).unwrap();assert_eq!(read(&directory).err().unwrap().kind(),io::ErrorKind::InvalidData);
        let valid=serde_json::to_string(&manifest).unwrap();let duplicate=format!("{{\"schemaVersion\":1,{}",&valid[1..]);
        std::fs::write(&manifest_file,duplicate).unwrap();assert_eq!(read(&directory).err().unwrap().kind(),io::ErrorKind::InvalidData);
        std::fs::write(&manifest_file,valid).unwrap();std::fs::set_permissions(&file,std::fs::Permissions::from_mode(0o666)).unwrap();
        assert_eq!(read(&directory).err().unwrap().kind(),io::ErrorKind::PermissionDenied);
    }
}
