use crate::{contract_generated::*,failure,success};
use serde_json::{Value,json};
use std::{fs,io,path::{Path,PathBuf},process::{Command,Stdio,ExitStatus},time::{Duration,Instant}};

pub fn validate(action:&Value)->Result<(),Value>{
    if let Some(error)=desktop_container_shape_error(action){return Err(failure("invalid_request",error));}
    let text=|s:&str,cap:usize|s.len()<=cap&&!s.contains('\0');
    let image=action["image"].as_str().unwrap();
    if image.is_empty()||!image.as_bytes()[0].is_ascii_alphanumeric()||!text(image,1024)||image.chars().any(char::is_whitespace){return Err(failure("invalid_request","invalid container image"));}
    let args=action["command"].as_array().unwrap();
    if args.is_empty()||args.len()>128||args[0]==""||args.iter().any(|v|!text(v.as_str().unwrap(),32768)){return Err(failure("invalid_request","container requires 1..128 bounded exact arguments"));}
    if let Some(env)=action["env"].as_object(){
        if env.len()>64||env.iter().any(|(key,value)|key.is_empty()||key.len()>128||!key.bytes().enumerate().all(|(i,b)|b==b'_'||b.is_ascii_alphabetic()||i>0&&b.is_ascii_digit())||!text(value.as_str().unwrap(),32768)){return Err(failure("invalid_request","invalid container environment"));}
    }
    if let Some(mounts)=action["mounts"].as_array(){
        if mounts.len()>16||mounts.iter().any(|m|{
            let host=m["hostPath"].as_str().unwrap();let guest=m["mountPath"].as_str().unwrap();
            !text(host,32768)||!Path::new(host).is_absolute()||host.contains(',')||cfg!(windows)&&host.starts_with('\\')||!text(guest,32768)||!guest.starts_with('/')||guest.contains(',')||guest.split('/').any(|s|s=="..")
        }){return Err(failure("invalid_request","invalid container mount paths"));}
    }
    for (key,cap)in[("timeoutMs",DESKTOP_CONTAINER_MAX_TIMEOUT_MS),("maxOutputBytes",DESKTOP_CONTAINER_MAX_OUTPUT_BYTES)]{
        if action.get(key).is_some_and(|v|v.as_f64().is_none_or(|n|!n.is_finite()||n.fract()!=0.0||n<1.0||n>cap as f64)){return Err(failure("invalid_request","container bounds require positive bounded integers"));}
    }
    Ok(())
}

pub(crate) fn engine()->Option<PathBuf>{
    #[cfg(target_os="linux")]let candidates=vec![PathBuf::from("/usr/bin/podman"),PathBuf::from("/usr/local/bin/podman")];
    #[cfg(windows)]let candidates={
        let mut paths=vec![];
        if let Some(root)=std::env::var_os("ProgramFiles"){paths.push(PathBuf::from(root).join("RedHat/Podman/podman.exe"));}
        if let Some(root)=std::env::var_os("LOCALAPPDATA"){paths.push(PathBuf::from(root).join("Programs/Podman/podman.exe"));}
        if let Some(path)=std::env::var_os("PATH"){paths.extend(std::env::split_paths(&path).map(|dir|dir.join("podman.exe")));}paths
    };
    #[cfg(not(any(windows,target_os="linux")))]let candidates:Vec<PathBuf>=vec![];
    candidates.into_iter().find(|path|path.is_file())
}

// Both pipes use the auth/PDF helper's nonblocking native reader. Descendants
// holding a pipe cannot turn child exit or timeout into an unbounded EOF wait.
pub(crate) fn capture(binary:&Path,args:&[String],deadline:Instant,limit:usize)->Result<(ExitStatus,Vec<u8>,Vec<u8>),Value>{
    if Instant::now()>=deadline{return Err(failure("timeout_unknown_outcome","process deadline expired"));}
    let mut command=Command::new(binary);command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    let mut child=crate::auth::AuthChild(command.spawn().map_err(|error|failure("provider_failed",error))?);
    let mut out=child.0.stdout.take().unwrap();let mut err=child.0.stderr.take().unwrap();
    let (mut stdout,mut stderr)=(Vec::new(),Vec::new());let (mut out_eof,mut err_eof)=(false,false);let mut chunk=[0u8;8192];
    loop{
        if Instant::now()>=deadline{return Err(failure("timeout_unknown_outcome","process deadline expired; observe effects before retrying"));}
        for stream in 0..2{
            if if stream==0{out_eof}else{err_eof}{continue;}
            let read=if stream==0{crate::auth::ready_read(&mut out,&mut chunk)}else{crate::auth::ready_read(&mut err,&mut chunk)};
            match read{
                Ok(0)=>if stream==0{out_eof=true}else{err_eof=true},
                Ok(n)=>{if stdout.len()+stderr.len()+n>limit{return Err(failure("resource_limit","process combined output exceeded its byte limit"));}if stream==0{stdout.extend_from_slice(&chunk[..n])}else{stderr.extend_from_slice(&chunk[..n])}},
                Err(e)if matches!(e.kind(),io::ErrorKind::WouldBlock|io::ErrorKind::Interrupted)=>(),
                Err(e)=>return Err(failure("provider_failed",e)),
            }
        }
        if let Some(status)=child.0.try_wait().map_err(|e|failure("provider_failed",e))?{if out_eof&&err_eof{return Ok((status,stdout,stderr));}}
        std::thread::sleep(Duration::from_millis(2));
    }
}

pub fn dispatch(action:&Value)->Value{
    if let Err(error)=validate(action){return error;}
    let Some(binary)=engine()else{return failure("not_installed","Podman is not installed; a configured rootless Linux engine is required");};
    #[cfg(windows)]if action["mounts"].as_array().is_some_and(|rows|!rows.is_empty()){return failure("unsupported_target","Windows bind mounts require a qualified Podman-machine host path mapping");}
    let started=Instant::now();let deadline=started+Duration::from_millis(action["timeoutMs"].as_f64().unwrap_or(60000.0)as u64);
    // `podman info` gathers host state and takes 5-7 s even warm on a small VM, so 5 s was too tight.
    let info=match capture(&binary,&["info".into(),"--format".into(),"json".into()],deadline.min(started+Duration::from_secs(20)),65536){
        Ok((status,bytes,_))if status.success()=>serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null),
        Ok(_)=>return failure("not_installed",if cfg!(windows){"Podman has no running machine or connection; run `podman machine init` and `podman machine start`"}else{"Podman engine is unavailable; configure its rootless Linux runtime"}),Err(error)=>return error,
    };
    if info["host"]["os"]!="linux"||info["host"]["security"]["rootless"]!=true{return failure("restricted_by_os","container execution requires a rootless Linux Podman engine");}
    let version=info["version"]["Version"].as_str().unwrap_or("");
    if version.is_empty()||version.len()>128{return failure("provider_failed","Podman omitted its bounded engine version");}
    let engine_host=info["host"]["hostname"].as_str().unwrap_or("");
    if engine_host.is_empty()||engine_host.len()>256||engine_host.contains('\0'){return failure("provider_failed","Podman omitted its bounded engine host identity");}
    let mut mounts=vec![];
    if let Some(rows)=action["mounts"].as_array(){for row in rows{
        let path=match fs::canonicalize(row["hostPath"].as_str().unwrap()){Ok(path)=>path,Err(e)=>return failure(if e.kind()==io::ErrorKind::NotFound{"target_gone"}else{"permission_denied"},e)};
        if fs::metadata(&path).map_or(true,|m|!m.is_file()&&!m.is_dir())||path.to_string_lossy().contains(','){return failure("unsupported_target","container bind source must be an existing regular file or directory without commas");}
        mounts.push(format!("type=bind,source={},target={},readonly={}",path.to_string_lossy(),row["mountPath"].as_str().unwrap(),row["mode"]=="ro"));
    }}
    let mut bytes=[0u8;16];
    #[cfg(windows)]unsafe{use windows::Win32::Security::Cryptography::{BCryptGenRandom,BCRYPT_USE_SYSTEM_PREFERRED_RNG};if BCryptGenRandom(None,&mut bytes,BCRYPT_USE_SYSTEM_PREFERRED_RNG).ok().is_err(){return failure("provider_failed","container identity entropy unavailable");}}
    #[cfg(not(windows))]if fs::File::open("/dev/urandom").and_then(|mut f|std::io::Read::read_exact(&mut f,&mut bytes)).is_err(){return failure("provider_failed","container identity entropy unavailable");}
    let name=format!("interceptor-{}",bytes.iter().map(|b|format!("{b:02x}")).collect::<String>());
    let directory=std::env::temp_dir().join(&name);
    #[cfg(unix)]let created={use std::os::unix::fs::DirBuilderExt;fs::DirBuilder::new().mode(0o700).create(&directory)};
    #[cfg(windows)]let created=crate::windows::private_directory(&directory);
    if let Err(e)=created{return failure("provider_failed",e);}
    let cidfile=directory.join("cid");let network=action["network"].as_str().unwrap_or("off");
    let mut args=vec!["run".into(),"--rm".into(),"--name".into(),name.clone(),"--cidfile".into(),cidfile.to_string_lossy().into_owned(),"--network".into(),match network{"off"=>"none","isolated"=>"private",_=>"host"}.into()];
    if let Some(env)=action["env"].as_object(){for (key,value)in env{args.extend(["--env".into(),format!("{key}={}",value.as_str().unwrap())]);}}
    for mount in mounts{args.extend(["--mount".into(),mount]);}
    args.push("--".into());args.push(action["image"].as_str().unwrap().into());args.extend(action["command"].as_array().unwrap().iter().map(|v|v.as_str().unwrap().into()));
    let result=capture(&binary,&args,deadline,action["maxOutputBytes"].as_f64().unwrap_or(DESKTOP_CONTAINER_MAX_OUTPUT_BYTES as f64)as usize);
    // --rm handles the ordinary exit. Exact identity cleanup also covers a
    // killed engine client; never use prune, --all or another caller's name.
    let cleanup_deadline=Instant::now()+Duration::from_millis(DESKTOP_CONTAINER_CLEANUP_MS as u64);
    let removed=capture(&binary,&["rm".into(),"--force".into(),"--time".into(),"0".into(),"--ignore".into(),name.clone()],cleanup_deadline,16384).is_ok_and(|(s,_,_)|s.success());
    let absent=removed&&capture(&binary,&["container".into(),"exists".into(),name.clone()],cleanup_deadline,16384).is_ok_and(|(s,_,_)|s.code()==Some(1));
    if !absent{return json!({"success":false,"code":"timeout_unknown_outcome","error":"owned container cleanup could not be established; observe before retrying","details":{"container":name,"engine":binary,"cidfile":cidfile}});}
    let _=fs::remove_file(&cidfile);let _=fs::remove_dir(&directory);
    match result{
        Err(error)=>error,
        Ok((status,stdout,stderr))=>match(String::from_utf8(stdout),String::from_utf8(stderr)){
            (Ok(stdout),Ok(stderr))=>success(json!({"exitCode":status.code().unwrap_or(-1),"stdout":stdout,"stderr":stderr,"durationMs":started.elapsed().as_millis()as u64,"image":action["image"],"command":action["command"],"network":network,"provider":"podman-rootless","engineVersion":version,"engineHost":engine_host})),
            _=>failure("unsupported_target","container output is not UTF8; no text result was synthesized"),
        }
    }
}

pub fn capability(session:&str)->Value{
    json!({"operation":"container_run","compiled":true,"present":engine().is_some(),"permission":"not_applicable","session":session,"effective":false,"background":"unavailable","provider":"podman-rootless","versions":{},"limits":["A configured rootless Linux Podman engine is checked per request; discovery alone does not qualify execution.","Timeout1..300000ms; combined output at most 1048576 bytes; exact owned-container cleanup at most 5000ms.","Windows bind mounts require a qualified Podman-machine path mapping."],"reason":"Engine availability and isolation require an actual run."})
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn validates_before_engine_access(){
        let action=json!({"type":"desktop_container_run","image":"docker.io/library/alpine:3","command":["echo","","Unicode 验证"]});assert!(validate(&action).is_ok());
        for fields in [json!({"command":[]}),json!({"command":[""]}),json!({"command":["x\u{0000}"]}),json!({"image":"--help"}),json!({"network":"other"}),json!({"env":{"BAD=KEY":"x"}}),json!({"env":{"X":null}}),json!({"timeoutMs":0}),json!({"timeoutMs":1.5}),json!({"maxOutputBytes":1048577}),json!({"mounts":[{"hostPath":"/tmp/x","mountPath":"/../x","mode":"ro"}]}),json!({"extra":true})]{let mut request=action.clone();request.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());assert_eq!(dispatch(&request)["code"],"invalid_request","{request}");}
    }
    #[cfg(unix)]#[test]fn both_pipes_and_descendant_eof_are_bounded(){
        let args=vec!["-c".into(),"printf stdout; printf stderr >&2".into()];let (s,out,err)=capture(Path::new("/bin/sh"),&args,Instant::now()+Duration::from_secs(1),12).unwrap();assert!(s.success());assert_eq!(out,b"stdout");assert_eq!(err,b"stderr");
        assert_eq!(capture(Path::new("/bin/sh"),&args,Instant::now()+Duration::from_secs(1),11).unwrap_err()["code"],"resource_limit");
        let started=Instant::now();assert_eq!(capture(Path::new("/bin/sh"),&["-c".into(),"sleep 0.2 & exit 0".into()],started+Duration::from_millis(30),128).unwrap_err()["code"],"timeout_unknown_outcome");assert!(started.elapsed()<Duration::from_secs(1));
    }
}
