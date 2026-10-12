//! Packaged defaults for the existing pinned native engines. No env mutation,
//! model download, credential storage or qualification is implied by discovery.
use crate::failure;
use serde::Deserialize;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::HashSet,fs::{self,File,OpenOptions},io::Read,path::{Path,PathBuf}};
type Result<T>=std::result::Result<T,Value>;
#[derive(Deserialize)]#[serde(deny_unknown_fields,rename_all="camelCase")]
struct Spec{schema_version:u32,max_files:usize,max_bundle_bytes:u64,assets:Vec<Asset>}
#[derive(Deserialize)]#[serde(deny_unknown_fields,rename_all="camelCase")]
struct Asset{variable:String,kind:String,max_bytes:u64,version:Option<String>}
#[derive(Deserialize)]#[serde(deny_unknown_fields,rename_all="camelCase")]
struct Manifest{schema_version:u32,host:String,architecture:String,provider_version:String,files:Vec<Entry>}
#[derive(Deserialize)]#[serde(deny_unknown_fields,rename_all="camelCase")]
struct Entry{variable:Option<String>,path:String,kind:String,bytes:u64,sha256:String,component:String,version:String,source:String,license:String,license_paths:Vec<String>,dependencies:Vec<String>}
fn invalid(message:&str)->Value{failure("invalid_request",message)}
fn relative(path:&str)->bool{
    !path.is_empty()&&path.len()<=240&&path.split('/').count()<=4&&path.split('/').all(|part|{
        let stem=part.split('.').next().unwrap_or("").to_ascii_lowercase();
        !part.is_empty()&&part!="."&&part!=".."&&!part.ends_with('.')&&part.len()<=96&&part.bytes().all(|b|b.is_ascii_alphanumeric()||b"._-".contains(&b))&&!matches!(stem.as_str(),"con"|"prn"|"aux"|"nul")&&!(stem.len()==4&&(stem.starts_with("com")||stem.starts_with("lpt"))&&matches!(stem.as_bytes()[3],b'1'..=b'9'))
    })
}
fn hash(value:&str)->bool{value.len()==64&&value.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn text(value:&str,max:usize)->bool{!value.is_empty()&&value.len()<=max&&!value.chars().any(char::is_control)}
fn regular(path:&Path)->Result<File>{
    let mut options=OpenOptions::new();options.read(true);
    #[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;options.custom_flags(libc::O_NONBLOCK|libc::O_NOFOLLOW|libc::O_CLOEXEC);}
    #[cfg(windows)]{use std::os::windows::fs::OpenOptionsExt;options.custom_flags(windows::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT.0).share_mode(windows::Win32::Storage::FileSystem::FILE_SHARE_READ.0);}
    let file=options.open(path).map_err(|_|failure("not_installed","declared engine bundle file is unavailable"))?;
    let meta=file.metadata().map_err(|_|failure("provider_failed","engine file metadata is unavailable"))?;
    #[cfg(windows)]{use std::os::windows::fs::MetadataExt;if meta.file_attributes()&windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT.0!=0{return Err(failure("permission_denied","engine bundle reparse points are refused"));}}
    #[cfg(unix)]{use std::os::unix::fs::MetadataExt;if ![0,unsafe{libc::getuid()}].contains(&meta.uid())||meta.mode()&0o022!=0{return Err(failure("permission_denied","engine bundle files must be owner/root-owned and not writable by others"));}}
    if !meta.is_file(){return Err(failure("unsupported_target","engine bundle requires regular files"));}Ok(file)
}
fn directory(path:&Path)->Result<()>{
    let meta=fs::symlink_metadata(path).map_err(|_|failure("not_installed","engine bundle directory is unavailable"))?;
    if !meta.is_dir()||meta.file_type().is_symlink(){return Err(failure("permission_denied","linked engine bundle directories are refused"));}
    #[cfg(windows)]{use std::os::windows::fs::MetadataExt;if meta.file_attributes()&windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT.0!=0{return Err(failure("permission_denied","engine bundle directory reparse points are refused"));}}
    #[cfg(unix)]{use std::os::unix::fs::MetadataExt;if ![0,unsafe{libc::getuid()}].contains(&meta.uid())||meta.mode()&0o022!=0{return Err(failure("permission_denied","engine bundle directories must be owner/root-owned and not writable by others"));}}
    Ok(())
}
fn path(root:&Path,name:&str)->Result<PathBuf>{
    if !relative(name){return Err(invalid("engine bundle path must be bounded and relative"));}
    let mut current=root.to_path_buf();let parts=name.split('/').collect::<Vec<_>>();
    for part in &parts[..parts.len()-1]{current.push(part);directory(&current)?;}
    current.push(parts[parts.len()-1]);Ok(current)
}
fn manifest(root:&Path)->Result<Manifest>{
    directory(root)?;
    let mut file=regular(&root.join("manifest.json"))?;
    if file.metadata().map_err(|_|failure("provider_failed","engine manifest metadata is unavailable"))?.len()>1024*1024{return Err(failure("resource_limit","engine manifest exceeds 1MiB"));}
    let mut bytes=Vec::new();file.by_ref().take(1024*1024+1).read_to_end(&mut bytes).map_err(|_|failure("provider_failed","engine manifest read failed"))?;
    if bytes.len()>1024*1024{return Err(failure("resource_limit","engine manifest grew beyond 1MiB"));}
    decode(&bytes,if cfg!(windows){"win32"}else{"linux"},match std::env::consts::ARCH{"x86_64"=>"x64","aarch64"=>"arm64",_=>"unsupported"},env!("CARGO_PKG_VERSION"))
}
fn decode(bytes:&[u8],host:&str,architecture:&str,version:&str)->Result<Manifest>{
    let spec:Spec=serde_json::from_str(include_str!("../../shared/desktop-engine-spec.json")).map_err(|_|failure("provider_failed","compiled engine specification is invalid"))?;
    let value:Value=serde_json::from_slice(bytes).map_err(|_|invalid("engine manifest is invalid JSON"))?;
    if value["files"].as_array().is_some_and(|rows|rows.iter().any(|row|row.get("variable").is_some_and(Value::is_null))){return Err(invalid("optional engine variable cannot be null"));}
    let m:Manifest=serde_json::from_value(value).map_err(|_|invalid("engine manifest fields are invalid"))?;
    if m.schema_version!=spec.schema_version||m.host!=host||m.architecture!=architecture||m.provider_version!=version{return Err(failure("version_mismatch","engine bundle host, architecture or provider version differs"));}
    if m.files.is_empty()||m.files.len()>spec.max_files{return Err(failure("resource_limit","engine bundle file count is invalid"));}
    let mut paths=HashSet::new();let mut variables=HashSet::new();let mut total=0_u64;
    for entry in &m.files{
        if !relative(&entry.path)||entry.path=="manifest.json"||!paths.insert(entry.path.to_ascii_lowercase())||!hash(&entry.sha256)||entry.bytes==0||!text(&entry.component,128)||!text(&entry.version,128)||!text(&entry.license,256)||!text(&entry.source,4096)||!entry.source.starts_with("https://")||entry.license_paths.len()>16||entry.dependencies.len()>32{return Err(invalid("engine bundle file identity, license or source is invalid"));}
        let source=reqwest::Url::parse(&entry.source).map_err(|_|invalid("engine source is not a valid URL"))?;
        if source.scheme()!="https"||source.host_str().is_none()||!source.username().is_empty()||source.password().is_some(){return Err(invalid("engine source requires HTTPS without credentials"));}
        let max=if let Some(variable)=&entry.variable{
            if !variables.insert(variable){return Err(invalid("engine bundle repeats an asset variable"));}
            let asset=spec.assets.iter().find(|asset|asset.variable==*variable).ok_or_else(||invalid("engine bundle asset variable is not declared"))?;
            if entry.kind!=asset.kind||asset.version.as_ref().is_some_and(|version|version!=&entry.version){return Err(failure("version_mismatch","engine asset kind or source-selected version differs"));}asset.max_bytes
        }else{match entry.kind.as_str(){"library"|"executable"=>128*1024*1024,"license"=>1024*1024,"data"=>64*1024*1024,_=>return Err(invalid("unbound engine file kind is invalid"))}};
        total=total.checked_add(entry.bytes).ok_or_else(||failure("resource_limit","engine bundle byte total overflowed"))?;
        if entry.bytes>max||total>spec.max_bundle_bytes{return Err(failure("resource_limit","engine bundle exceeds its byte budget"));}
    }
    for entry in &m.files{
        if entry.kind!="license"&&entry.license_paths.is_empty(){return Err(invalid("every engine/model file requires retained license text"));}
        let mut references=HashSet::new();
        for (name,license)in entry.license_paths.iter().map(|name|(name,true)).chain(entry.dependencies.iter().map(|name|(name,false))){
            if !relative(name)||name==&entry.path||!references.insert(name){return Err(invalid("engine file reference is duplicated or invalid"));}
            let dependency=m.files.iter().find(|candidate|candidate.path==*name).ok_or_else(||invalid("engine file reference is not declared"))?;
            if license&&dependency.kind!="license"||!license&&!matches!(dependency.kind.as_str(),"library"|"executable"|"data"){return Err(invalid("engine dependency or license reference has the wrong kind"));}
        }
    }
    Ok(m)
}
fn verified(root:&Path,entry:&Entry)->Result<PathBuf>{
    let path=path(root,&entry.path)?;let mut file=regular(&path)?;
    if file.metadata().map_err(|_|failure("provider_failed","engine file metadata failed"))?.len()!=entry.bytes{return Err(failure("version_mismatch","engine file byte count differs from its manifest"));}
    let mut digest=Sha256::new();let mut buffer=[0_u8;65536];let mut total=0_u64;let mut license=Vec::new();
    loop{let n=file.read(&mut buffer).map_err(|_|failure("provider_failed","engine file read failed"))?;if n==0{break;}total+=n as u64;if total>entry.bytes{return Err(failure("version_mismatch","engine file grew beyond its manifest"));}digest.update(&buffer[..n]);if entry.kind=="license"{license.extend_from_slice(&buffer[..n]);}}
    if total!=entry.bytes||digest.finalize().iter().map(|b|format!("{b:02x}")).collect::<String>()!=entry.sha256{return Err(failure("version_mismatch","engine file differs from its pinned manifest"));}
    if entry.kind=="license"{
        let text=std::str::from_utf8(&license).map_err(|_|invalid("engine license text is not UTF8"))?;
        if text.trim().is_empty()||text.contains('\0'){return Err(invalid("engine license text is empty or invalid"));}
    }
    Ok(path)
}
fn entries(root:&Path,m:&Manifest)->Result<()>{
    let expected=m.files.iter().map(|entry|entry.path.as_str()).chain(["manifest.json"]).collect::<HashSet<_>>();
    let mut pending=vec![(root.to_path_buf(),String::new(),0)];let mut seen=HashSet::new();let mut count=0;
    while let Some((directory_path,prefix,depth))=pending.pop(){
        for item in fs::read_dir(&directory_path).map_err(|_|failure("permission_denied","engine bundle inventory is unavailable"))?{
            let item=item.map_err(|_|failure("provider_failed","engine bundle entry is unavailable"))?;count+=1;if count>512{return Err(failure("resource_limit","engine bundle inventory exceeds its bound"));}
            let name=item.file_name().into_string().map_err(|_|invalid("engine bundle entry is not UTF8"))?;
            let name=if prefix.is_empty(){name}else{format!("{prefix}/{name}")};
            let meta=fs::symlink_metadata(item.path()).map_err(|_|failure("provider_failed","engine bundle entry metadata is unavailable"))?;
            if meta.is_dir(){directory(&item.path())?;if depth>=3||!expected.iter().any(|path|path.starts_with(&(name.clone()+"/"))){return Err(invalid("engine bundle contains an undeclared directory"));}pending.push((item.path(),name,depth+1));}
            else{if !meta.is_file()||meta.file_type().is_symlink()||!expected.contains(name.as_str()){return Err(invalid("engine bundle contains a linked or undeclared file"));}seen.insert(name);}
        }
    }
    if seen.len()!=expected.len(){return Err(failure("not_installed","engine bundle is missing declared files"));}Ok(())
}
/// Resolves a pinned engine; every refusal names the engine the operation needed, so a host
/// without the bundle says what is missing instead of only "engine bundle directory is unavailable".
pub(crate) fn resolve(variable:&str)->Result<(PathBuf,String)>{
    resolve_pinned(variable).map_err(|mut error|{
        let name=match variable{
            v if v.contains("WHISPER")=>"whisper.cpp speech engine",v if v.contains("SOUND")=>"bundled sound model",v if v.contains("EMBED")=>"bundled text-embedding model",v if v.contains("LLAMA")=>"llama.cpp server",
            v if v.contains("TESSERACT")=>"tesseract OCR engine",v if v.contains("VISION")=>"bundled vision model",v if v.contains("PDFIUM")=>"pdfium PDF engine",
            v if v.contains("EXIFTOOL")=>"exiftool metadata engine",v if v.contains("FFMPEG")=>"ffmpeg media engine",v if v.contains("QEMU")=>"qemu virtual machine engine",v if v.contains("MPD")=>"mpd music engine",_=>"pinned engine",
        };
        if let Some(message)=error["error"].as_str().map(str::to_owned){error["error"]=json!(format!("{message}; this operation needs the {name} ({variable})"));}
        error
    })
}
fn resolve_pinned(variable:&str)->Result<(PathBuf,String)>{
    let exe=std::env::current_exe().map_err(|_|failure("provider_failed","native provider image location is unavailable"))?;
    let root=exe.parent().ok_or_else(||failure("provider_failed","native provider image has no directory"))?.join("engines");
    let m=manifest(&root)?;entries(&root,&m)?;
    let entry=m.files.iter().find(|entry|entry.variable.as_deref()==Some(variable)).ok_or_else(||failure("not_installed",format!("engine bundle does not provide {variable}")))?;
    for dependency in entry.license_paths.iter().chain(&entry.dependencies){verified(&root,m.files.iter().find(|entry|entry.path==*dependency).unwrap())?;}
    let path=verified(&root,entry)?;Ok((path,entry.sha256.clone()))
}
pub(crate) fn check(root:&Path)->Result<Value>{
    let m=manifest(root)?;entries(root,&m)?;for entry in &m.files{verified(root,entry)?;}
    Ok(json!({"schemaVersion":m.schema_version,"host":m.host,"architecture":m.architecture,"providerVersion":m.provider_version,"files":m.files.iter().map(|entry|json!({"path":entry.path,"bytes":entry.bytes,"sha256":entry.sha256,"kind":entry.kind})).collect::<Vec<_>>(),"qualification":"file-identity-only","nativeRuntimeChecked":false}))
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn a_missing_bundle_names_the_engine_the_operation_needed(){
        let error=resolve("INTERCEPTOR_WHISPER_CLI").unwrap_err();
        assert!(error["error"].as_str().unwrap().contains("whisper.cpp speech engine (INTERCEPTOR_WHISPER_CLI)"),"{error}");
    }
    fn fixture()->Value{json!({"schemaVersion":1,"host":"linux","architecture":"arm64","providerVersion":"fixture-1","files":[
        {"variable":"INTERCEPTOR_TESSERACT_MODEL","path":"models/eng.traineddata","kind":"model","bytes":128,"sha256":"a".repeat(64),"component":"owned-fixture","version":"fixture-1","source":"https://github.com/Hacker-Valley-Media/Interceptor","license":"LicenseRef-OwnedFixture","licensePaths":["licenses/fixture.txt"],"dependencies":[]},
        {"path":"licenses/fixture.txt","kind":"license","bytes":64,"sha256":"b".repeat(64),"component":"owned-fixture","version":"fixture-1","source":"https://github.com/Hacker-Valley-Media/Interceptor","license":"LicenseRef-OwnedFixture","licensePaths":[],"dependencies":[]}
    ]})}
    #[test]fn malformed_bundle_identity_and_references_refuse_without_loading(){
        let encode=|value:&Value|serde_json::to_vec(value).unwrap();
        let f=fixture();assert!(decode(&encode(&f),"linux","arm64","fixture-1").is_ok());
        for fields in [json!({"qualified":true}),json!({"host":"win32"}),json!({"architecture":"x64"}),json!({"providerVersion":"other"}),json!({"files":[]})]{let mut value=fixture();value.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());assert!(decode(&encode(&value),"linux","arm64","fixture-1").is_err());}
        for fields in [json!({"path":"../model"}),json!({"variable":null}),json!({"variable":"INTERCEPTOR_UNKNOWN"}),json!({"bytes":0}),json!({"bytes":67108865}),json!({"sha256":"A".repeat(64)}),json!({"source":"http://example.com"}),json!({"source":"https://user:password@example.com/a"}),json!({"license":""}),json!({"licensePaths":[]}),json!({"licensePaths":["models/eng.traineddata"]}),json!({"licensePaths":["licenses/missing.txt"]}),json!({"dependencies":["models/eng.traineddata"]}),json!({"dependencies":["licenses/fixture.txt"]}),json!({"extra":true})]{let mut value=fixture();value["files"][0].as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());assert!(decode(&encode(&value),"linux","arm64","fixture-1").is_err(),"{value}");}
        for path in ["../other","/models/a","C:/model","models/../model","models//model","models\\model","models/CON","models/com1.dll","models/a.","a/b/c/d/e","a\0b"]{assert!(!relative(path),"{path}");}
    }
}
