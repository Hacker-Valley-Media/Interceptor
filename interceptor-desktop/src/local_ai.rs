//! The local AI model. The engine bundle carries a llama.cpp server; the provider
//! downloads one pinned Gemma 4 model the first time an AI command is used, then starts the
//! server itself on loopback with a random key. A server the user configured with
//! INTERCEPTOR_LLAMA_CHAT_URL is never touched by this module.
use crate::failure;
use reqwest::Url;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{fs,io::{Read,Write},path::{Path,PathBuf},process::{Child,Command,Stdio},sync::Mutex,time::{Duration,Instant}};
type Result<T>=std::result::Result<T,Value>;

/// The name the server answers to; chat replies must echo it.
pub(crate) const MODEL:&str="gemma-4-E2B-it-Q4_0";
const FILE:&str="gemma-4-E2B-it-Q4_0.gguf";
// Pinned to one Hugging Face revision; Apache-2.0 (ggml-org/gemma-4-E2B-it-GGUF).
const SOURCE:&str="https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/b4243c156154b6dca9324415f8c7ccc098b4aed1/gemma-4-E2B-it-Q4_0.gguf";
const BYTES:u64=2_841_481_184;
const SHA256:&str="8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52";
/// Languages the translate commands accept with this model: the set Apple's Translation offers.
pub(crate) const LANGUAGES:[&str;19]=["ar","de","en","es","fr","hi","id","it","ja","ko","nl","pl","pt","ru","th","tr","uk","vi","zh"];

enum Download{Idle,Running(u64),Failed(String)}
static DOWNLOAD:Mutex<Download>=Mutex::new(Download::Idle);
/// The model download is running (the updater does not install over it).
pub(crate) fn downloading()->bool{DOWNLOAD.try_lock().map_or(true,|d|matches!(*d,Download::Running(_)))}
struct Server{child:Child,url:Url,key:String}
static SERVER:Mutex<Option<Server>>=Mutex::new(None);

fn megabytes(bytes:u64)->u64{bytes/1_000_000}
fn download_off()->bool{std::env::var("INTERCEPTOR_AI_DOWNLOAD").is_ok_and(|v|matches!(v.trim().to_ascii_lowercase().as_str(),"off"|"0"|"false"|"no"))}
/// Where the model lives: outside the install folder, so an upgrade does not download it again.
/// Status reads only this path; the folder is created when a download or the server needs it.
fn folder()->Result<PathBuf>{
    #[cfg(windows)]let base=std::env::var_os("LOCALAPPDATA").map(|p|PathBuf::from(p).join("Interceptor").join("Models"));
    #[cfg(not(windows))]let base=std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(||std::env::var_os("HOME").map(|h|PathBuf::from(h).join(".local").join("share"))).map(|p|p.join("interceptor-models"));
    base.filter(|p|p.is_absolute()).ok_or_else(||failure("provider_failed","this login has no folder for the local AI model"))
}
fn directory()->Result<PathBuf>{
    let path=folder()?;
    fs::create_dir_all(&path).map_err(|e|failure("provider_failed",format!("the local AI model folder could not be created: {e}")))?;
    #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;let _=fs::set_permissions(&path,fs::Permissions::from_mode(0o700));}
    Ok(path)
}
/// The model is in place when the file has its exact size and the marker written after its hash check.
fn installed(directory:&Path)->bool{
    fs::metadata(directory.join(FILE)).is_ok_and(|m|m.is_file()&&m.len()==BYTES)&&fs::read_to_string(directory.join(format!("{FILE}.sha256"))).is_ok_and(|s|s.trim()==SHA256)
}

/// Download `url` to `destination`, resuming a partial file, and keep it only if the whole
/// file has the pinned size and SHA256. `progress` gets the bytes on disk as they arrive.
pub(crate) fn fetch(url:&str,destination:&Path,bytes:u64,sha256:&str,progress:&dyn Fn(u64))->std::result::Result<(),String>{
    let part=destination.with_extension("part");
    let mut have=fs::metadata(&part).map(|m|m.len()).unwrap_or(0);
    if have>bytes{let _=fs::remove_file(&part);have=0;}
    if have<bytes{
        let client=reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(20)).timeout(None::<Duration>).tcp_keepalive(Duration::from_secs(30)).build().map_err(|e|format!("download client could not start: {e}"))?;
        let mut request=client.get(url);if have>0{request=request.header("Range",format!("bytes={have}-"));}
        let mut response=request.send().map_err(|e|format!("the model server could not be reached: {e}"))?;
        let mut file=match response.status().as_u16(){
            206=>fs::OpenOptions::new().append(true).open(&part),
            200=>{have=0;fs::File::create(&part)},
            416=>{let _=fs::remove_file(&part);return Err("the model server refused the resume point; the next call starts over".into());},
            code=>return Err(format!("the model server answered HTTP {code}")),
        }.map_err(|e|format!("the model file could not be written: {e}"))?;
        let mut buffer=vec![0u8;1024*1024];
        loop{
            let n=response.read(&mut buffer).map_err(|e|format!("the download was interrupted at {} of {} MB: {e}; the next call resumes it",megabytes(have),megabytes(bytes)))?;
            if n==0{break;}
            have+=n as u64;if have>bytes{drop(file);let _=fs::remove_file(&part);return Err("the model server sent more data than the pinned size; nothing was kept".into());}
            file.write_all(&buffer[..n]).map_err(|e|format!("the model file could not be written at {} MB: {e}",megabytes(have)))?;progress(have);
        }
        file.sync_all().map_err(|e|format!("the model file could not be saved: {e}"))?;
        if have!=bytes{return Err(format!("the download ended early at {} of {} MB; the next call resumes it",megabytes(have),megabytes(bytes)));}
    }
    let mut digest=Sha256::new();let mut file=fs::File::open(&part).map_err(|e|format!("the downloaded model could not be read: {e}"))?;let mut buffer=vec![0u8;1024*1024];
    loop{let n=file.read(&mut buffer).map_err(|e|format!("the downloaded model could not be read: {e}"))?;if n==0{break;}digest.update(&buffer[..n]);}
    if digest.finalize().iter().map(|b|format!("{b:02x}")).collect::<String>()!=sha256{let _=fs::remove_file(&part);return Err("the downloaded model did not match its pinned SHA256 and was deleted".into());}
    fs::rename(&part,destination).and_then(|_|fs::write(destination.with_file_name(format!("{}.sha256",destination.file_name().unwrap().to_string_lossy())),sha256)).map_err(|e|format!("the verified model could not be put in place: {e}"))
}
fn start_download(directory:PathBuf){
    let mut state=DOWNLOAD.lock().unwrap();if matches!(*state,Download::Running(_)){return;}
    *state=Download::Running(fs::metadata(directory.join(FILE).with_extension("part")).map(|m|m.len()).unwrap_or(0));
    std::thread::spawn(move||{
        let result=fetch(SOURCE,&directory.join(FILE),BYTES,SHA256,&|done|*DOWNLOAD.lock().unwrap()=Download::Running(done));
        *DOWNLOAD.lock().unwrap()=match result{Ok(())=>Download::Idle,Err(error)=>Download::Failed(error)};
    });
}
/// Why the local model cannot answer right now, in words for the person. Starts nothing.
fn unavailable()->Option<String>{
    if let Err(error)=crate::native_library::engine_ready("INTERCEPTOR_LLAMA_SERVER"){return Some(error["error"].as_str().unwrap_or("this build does not include the local AI server").to_owned());}
    let directory=match folder(){Ok(d)=>d,Err(e)=>return Some(e["error"].as_str().unwrap_or("no model folder").to_owned())};
    if installed(&directory){return None;}
    Some(match &*DOWNLOAD.lock().unwrap(){
        Download::Running(done)=>format!("the local AI model is downloading: {} of {} MB",megabytes(*done),megabytes(BYTES)),
        Download::Failed(error)=>format!("the last model download stopped ({error}); the next ai, translate, detect or nlp command continues it"),
        Download::Idle if download_off()=>format!("the local AI model ({} MB) is not on this machine and automatic download is off (INTERCEPTOR_AI_DOWNLOAD=off)",megabytes(BYTES)),
        Download::Idle=>format!("the local AI model ({} MB) downloads the first time ai, translate, detect, nlp entities or nlp sentiment is used",megabytes(BYTES)),
    })
}
pub(crate) fn ready()->std::result::Result<(),String>{unavailable().map_or(Ok(()),Err)}
pub(crate) fn status()->Value{match unavailable(){None=>json!({"available":true,"framework":"llama.cpp","model":MODEL}),Some(reason)=>json!({"available":false,"framework":"llama.cpp","reason":reason})}}

#[cfg(windows)]fn runtime()->Result<()>{
    // The llama.cpp Windows builds link the Visual C++ runtime dynamically; the provider itself does not.
    let system=PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(||"C:\\Windows".into())).join("System32");
    let needed:&[&str]=if cfg!(target_arch="x86_64"){&["vcruntime140.dll","vcruntime140_1.dll","msvcp140.dll"]}else{&["vcruntime140.dll","msvcp140.dll"]};
    let missing=needed.iter().filter(|name|!system.join(name).is_file()).copied().collect::<Vec<_>>();
    if missing.is_empty(){Ok(())}else{Err(failure("not_installed",format!("the local AI server needs the Microsoft Visual C++ runtime ({} not found); install it with: winget install Microsoft.VCRedist.2015+.{}",missing.join(", "),if cfg!(target_arch="x86_64"){"x64"}else{"arm64"})))}
}
#[cfg(not(windows))]fn runtime()->Result<()>{Ok(())}

/// Start a child that cannot outlive the provider.
fn spawn_owned(mut command:Command)->std::io::Result<Child>{
    #[cfg(target_os="linux")]{
        // PR_SET_PDEATHSIG follows the spawning thread, and request threads end. One thread that
        // lives as long as the provider does every spawn, so the server dies only with the provider.
        use std::{os::unix::process::CommandExt,sync::{mpsc,OnceLock}};
        static SPAWNER:OnceLock<Mutex<mpsc::Sender<(Command,mpsc::Sender<std::io::Result<Child>>)>>>=OnceLock::new();
        let spawner=SPAWNER.get_or_init(||{let(sender,receiver)=mpsc::channel::<(Command,mpsc::Sender<std::io::Result<Child>>)>();std::thread::spawn(move||{for(mut command,reply)in receiver{let _=reply.send(command.spawn());}});Mutex::new(sender)});
        let parent=std::process::id();
        unsafe{command.pre_exec(move||{if libc::prctl(libc::PR_SET_PDEATHSIG,libc::SIGKILL)!=0||libc::getppid()as u32!=parent{return Err(std::io::Error::other("provider exited before the local AI server started"));}Ok(())});}
        let(reply,result)=mpsc::channel();
        spawner.lock().unwrap().send((command,reply)).map_err(|_|std::io::Error::other("local AI spawner stopped"))?;
        return result.recv().map_err(|_|std::io::Error::other("local AI spawner stopped"))?;
    }
    #[cfg(windows)]unsafe{
        use std::os::windows::{io::AsRawHandle,process::CommandExt};
        use windows::Win32::{Foundation::HANDLE,System::JobObjects::*};
        command.creation_flags(0x08000000);
        let child=command.spawn()?;
        // The job handle is never closed, so it closes when the provider exits and takes the server with it.
        let job=CreateJobObjectW(None,None).map_err(std::io::Error::other)?;
        let mut limits=JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job,JobObjectExtendedLimitInformation,(&raw const limits).cast(),std::mem::size_of_val(&limits)as u32).and_then(|_|AssignProcessToJobObject(job,HANDLE(child.as_raw_handle()))).map_err(std::io::Error::other)?;
        return Ok(child);
    }
    #[cfg(not(any(windows,target_os="linux")))]command.spawn()
}
/// Half the logical processors, at most four. The server's own default of one thread per
/// processor collapses when anything else wants a core: measured on an 8-processor VM under
/// load, 8 threads gave 1.2 tokens a second and 4 threads gave 37.
pub(crate) fn threads(processors:usize)->usize{(processors/2).clamp(1,4)}
/// The arguments the server always gets: loopback only, no downloads, no web page, no thinking
/// text in answers, and the model unloaded after ten idle minutes.
pub(crate) fn arguments(model:&Path,port:u16)->Vec<String>{
    let threads=threads(std::thread::available_parallelism().map(|n|n.get()).unwrap_or(2)).to_string();
    ["--model",&model.to_string_lossy(),"--alias",MODEL,"--host","127.0.0.1","--port",&port.to_string(),"--offline","--no-webui","--ctx-size","8192","--parallel","1","--threads",&threads,"--reasoning","off","--sleep-idle-seconds","600","--log-disable"].iter().map(|s|(*s).to_owned()).collect()
}
fn healthy(url:&Url)->bool{
    reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().ok().and_then(|client|client.get(url.join("health").unwrap()).send().ok()).is_some_and(|r|r.status().is_success())
}
/// The running server's address, model name and key; starts it and waits for the model to load.
fn serve(binary:&Path,model:&Path)->Result<(Url,String,String)>{
    let mut slot=SERVER.lock().unwrap();
    if slot.as_mut().is_some_and(|server|server.child.try_wait().ok().flatten().is_some()){*slot=None;}
    if slot.is_none(){
        runtime()?;
        let port=std::net::TcpListener::bind("127.0.0.1:0").and_then(|l|l.local_addr()).map_err(|e|failure("provider_failed",format!("no loopback port for the local AI server: {e}")))?.port();
        let key=crate::secret_target::random_token().map_err(|e|failure("provider_failed",format!("no key for the local AI server: {e}")))?;
        let folder=binary.parent().ok_or_else(||failure("provider_failed","the local AI server has no folder"))?;
        let mut command=Command::new(binary);
        // The key travels in the environment so it never shows in the process list.
        command.args(arguments(model,port)).current_dir(folder).env("LLAMA_API_KEY",&key).env("LD_LIBRARY_PATH",folder).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let child=spawn_owned(command).map_err(|e|failure("provider_failed",format!("the local AI server could not start: {e}")))?;
        *slot=Some(Server{child,url:Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap(),key});
    }
    let server=slot.as_mut().unwrap();let deadline=Instant::now()+Duration::from_secs(90);
    loop{
        if healthy(&server.url){return Ok((server.url.clone(),MODEL.to_owned(),server.key.clone()));}
        if server.child.try_wait().ok().flatten().is_some(){*slot=None;return Err(failure("provider_failed","the local AI server stopped while loading the model"));}
        if Instant::now()>=deadline{return Err(failure("resource_limit","the local AI model is still loading; run the command again in a moment"));}
        std::thread::sleep(Duration::from_millis(250));
    }
}
/// The local engine for a chat request. With no model on disk this starts the download and
/// refuses, saying how far along it is.
pub(crate) fn engine()->Result<(Url,String,String)>{
    // The server binary is hashed against its pin before it is started, override or bundled.
    let binary=crate::native_library::pinned_file("INTERCEPTOR_LLAMA_SERVER",128*1024*1024)?;
    let directory=directory()?;
    if !installed(&directory){
        if download_off(){return Err(failure("not_installed",unavailable().unwrap_or_default()));}
        start_download(directory);
        return Err(failure("not_installed",format!("{}. Run the command again when `interceptor desktop ai status` reports available",unavailable().unwrap_or_else(||"the local AI model has just finished downloading".into()))));
    }
    serve(&binary,&directory.join(FILE))
}
/// Stop the server. Also the way to cancel a generation nobody is waiting for any more: the
/// next request starts it again.
pub(crate) fn shutdown(){if let Some(mut server)=SERVER.lock().unwrap().take(){let _=server.child.kill();let _=server.child.wait();}}

#[cfg(test)]mod tests{
    use super::*;
    use std::{io::BufRead,net::TcpListener};
    /// A one-file HTTP server: honors Range, answers `requests` connections, then stops.
    fn serve_file(body:Vec<u8>,requests:usize,truncate:Option<usize>)->(String,std::thread::JoinHandle<Vec<Option<u64>>>){
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();let url=format!("http://{}/model.gguf",listener.local_addr().unwrap());
        (url,std::thread::spawn(move||{
            let mut ranges=Vec::new();
            for _ in 0..requests{
                let(mut stream,_)=listener.accept().unwrap();let mut reader=std::io::BufReader::new(stream.try_clone().unwrap());let mut start=None;
                loop{let mut line=String::new();reader.read_line(&mut line).unwrap();if line.trim().is_empty(){break;}if let Some(value)=line.to_ascii_lowercase().strip_prefix("range: bytes="){start=value.trim().trim_end_matches('-').parse::<u64>().ok();}}
                ranges.push(start);
                let from=start.unwrap_or(0)as usize;let slice=&body[from..truncate.unwrap_or(body.len()).max(from)];
                let head=if start.is_some(){format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {from}-{}/{}\r\n",body.len()-1,body.len())}else{"HTTP/1.1 200 OK\r\n".to_owned()};
                // The declared length is the full remainder, so a truncated body reads as a dropped connection.
                let _=stream.write_all(format!("{head}Content-Length: {}\r\nConnection: close\r\n\r\n",body.len()-from).as_bytes());let _=stream.write_all(slice);
            }
            ranges
        }))
    }
    fn digest(bytes:&[u8])->String{Sha256::digest(bytes).iter().map(|b|format!("{b:02x}")).collect()}
    #[test]fn downloads_resume_and_keep_only_files_that_match_their_hash(){
        let folder=std::env::temp_dir().join(format!("interceptor-local-ai-test-{}",std::process::id()));let _=fs::remove_dir_all(&folder);fs::create_dir_all(&folder).unwrap();
        let body:Vec<u8>=(0..300_000u32).map(|n|(n%251)as u8).collect();let destination=folder.join("model.gguf");
        // A whole download.
        let(url,server)=serve_file(body.clone(),1,None);let seen=std::sync::Mutex::new(0u64);
        fetch(&url,&destination,body.len()as u64,&digest(&body),&|done|*seen.lock().unwrap()=done).unwrap();
        assert_eq!(server.join().unwrap(),[None]);assert_eq!(fs::read(&destination).unwrap(),body);assert_eq!(*seen.lock().unwrap(),300_000);
        assert_eq!(fs::read_to_string(folder.join("model.gguf.sha256")).unwrap(),digest(&body));assert!(!folder.join("model.part").exists());
        // A dropped connection keeps the part; the next call asks only for the rest.
        fs::remove_file(&destination).unwrap();
        let(url,server)=serve_file(body.clone(),1,Some(100_000));
        assert!(fetch(&url,&destination,body.len()as u64,&digest(&body),&|_|()).unwrap_err().contains("resumes"));server.join().unwrap();
        assert_eq!(fs::metadata(folder.join("model.part")).unwrap().len(),100_000);assert!(!destination.exists());
        let(url,server)=serve_file(body.clone(),1,None);
        fetch(&url,&destination,body.len()as u64,&digest(&body),&|_|()).unwrap();assert_eq!(server.join().unwrap(),[Some(100_000)]);assert_eq!(fs::read(&destination).unwrap(),body);
        // A file that does not match its hash is deleted, never kept.
        fs::remove_file(&destination).unwrap();
        let(url,server)=serve_file(body.clone(),1,None);
        assert!(fetch(&url,&destination,body.len()as u64,&digest(b"other"),&|_|()).unwrap_err().contains("SHA256"));server.join().unwrap();
        assert!(!destination.exists()&&!folder.join("model.part").exists());
        // A server that sends more than the pinned size is cut off.
        let(url,server)=serve_file(body.clone(),1,None);
        assert!(fetch(&url,&destination,1000,&digest(&body[..1000]),&|_|()).unwrap_err().contains("more data"));let _=server.join();
        let _=fs::remove_dir_all(&folder);
    }
    #[test]fn the_server_is_started_loopback_only_offline_and_without_a_key_on_its_command_line(){
        let args=arguments(Path::new("/models/m.gguf"),4321);
        let value=|flag:&str|args[args.iter().position(|a|a==flag).unwrap()+1].clone();
        assert_eq!(value("--host"),"127.0.0.1");assert_eq!(value("--port"),"4321");assert_eq!(value("--alias"),MODEL);assert_eq!(value("--reasoning"),"off");
        assert!(args.contains(&"--offline".to_owned())&&args.contains(&"--no-webui".to_owned())&&!args.iter().any(|a|a.contains("api-key")));
        assert!(SOURCE.starts_with("https://huggingface.co/")&&SOURCE.contains("/resolve/b4243c156154b6dca9324415f8c7ccc098b4aed1/")&&SHA256.len()==64);
        assert_eq!([threads(1),threads(2),threads(4),threads(8),threads(20)],[1,1,2,4,4]);assert!(args.contains(&"--threads".to_owned()));
        assert_eq!(megabytes(BYTES),2841);assert!(LANGUAGES.contains(&"en")&&LANGUAGES.windows(2).all(|w|w[0]<w[1]));
    }
}
