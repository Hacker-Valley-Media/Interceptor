//! Shared Windows/Linux HTTP engine. GUI identity remains in native transport.
//! reqwest 0.12.28 uses rustls with WebPKI roots, never an insecure TLS fallback.
use crate::{contract_generated::*,failure,success};
use base64::{Engine,engine::general_purpose::STANDARD};
use reqwest::{blocking::Client,cookie::{CookieStore,Jar},header::{HeaderName,HeaderValue},Method,Url};
use serde_json::{Value,json};
use std::{io::{Read,Write},sync::{Arc,Mutex,OnceLock,atomic::{AtomicU64,Ordering}},time::{Duration,SystemTime}};

struct Cookies{jar:Jar,budget:Mutex<(usize,usize)>}
impl CookieStore for Cookies{
    fn set_cookies(&self,headers:&mut dyn Iterator<Item=&HeaderValue>,url:&Url){
        let mut remaining=self.budget.lock().unwrap_or_else(|e|e.into_inner());
        let mut accepted=Vec::new();
        for header in headers{
            let size=header.as_bytes().len();
            if size>4096||size>remaining.0||remaining.1==0{*remaining=(0,0);continue;}
            remaining.0-=size;remaining.1-=1;accepted.push(header);
        }
        self.jar.set_cookies(&mut accepted.into_iter(),url);
    }
    fn cookies(&self,url:&Url)->Option<HeaderValue>{self.jar.cookies(url)}
}
struct Session{clients:Mutex<std::collections::HashMap<u64,Client>>,cookies:Arc<Cookies>}
static SESSION:OnceLock<Result<Session,()>>=OnceLock::new();
static SERIAL:AtomicU64=AtomicU64::new(0);
static CACHE_WRITE:Mutex<()>=Mutex::new(());
fn session()->Result<&'static Session,Value>{
    SESSION.get_or_init(||{
        let cookies=Arc::new(Cookies{jar:Jar::default(),budget:Mutex::new((1_048_576,4096))});
        let session=Session{clients:Mutex::new(std::collections::HashMap::new()),cookies};
        session.client(10_000).map(|_|session).map_err(|_|())
    }).as_ref().map_err(|_|failure("provider_failed","HTTP engine initialization failed"))
}
impl Session{
    /// reqwest sets the connect deadline per client, so clients are kept per deadline, all on one cookie jar.
    // ponytail: cleared at 32 distinct deadlines; requests use a handful (default timeout plus a few --timeout values).
    fn client(&self,connect_ms:u64)->Result<Client,Value>{
        let mut clients=self.clients.lock().unwrap_or_else(|e|e.into_inner());
        if let Some(client)=clients.get(&connect_ms){return Ok(client.clone());}
        if clients.len()>=32{clients.clear();}
        let client=Client::builder().cookie_provider(self.cookies.clone()).redirect(reqwest::redirect::Policy::limited(10))
            .referer(false).retry(reqwest::retry::never()).connect_timeout(Duration::from_millis(connect_ms))
            .build().map_err(|_|failure("provider_failed","HTTP engine initialization failed"))?;
        clients.insert(connect_ms,client.clone());Ok(client)
    }
}
/// The connect phase (DNS, TCP, TLS) must end before the request deadline, so a connection that never
/// opened is reported as such, not as a request timeout after dispatch. Windows answers a refused loopback
/// connect only after about 2 s of SYN retries, so a 1 s request timed out mid-connect.
// The gap absorbs timer slack on a loaded host: 10 ms at a 100 ms timeout lost the race on the Windows VM.
fn connect_deadline(timeout_ms:u64)->u64{timeout_ms.saturating_sub((timeout_ms/2).min(250)).clamp(50,10_000)}
pub(crate) fn local_origin(raw:&str,allow_https:bool)->Result<Url,Value>{
    if raw.len()>4096||raw.contains('\0'){return Err(failure("invalid_request","invalid bounded local service URL"));}
    let url=Url::parse(raw).map_err(|_|failure("invalid_request","invalid local service URL"))?;
    let loopback=url.host_str().is_some_and(|h|h.trim_matches(['[',']']).parse::<std::net::IpAddr>().is_ok_and(|ip|ip.is_loopback()));
    if !loopback||url.scheme()!="http"&&!(allow_https&&url.scheme()=="https")||url.port().is_none()||!url.username().is_empty()||url.password().is_some()||url.path()!="/"||url.query().is_some()||url.fragment().is_some(){return Err(failure("invalid_request","local service requires numeric loopback, explicit port, and a root HTTP(S) URL without credentials, query or fragment"));}Ok(url)
}
pub fn validate(action:&Value)->Result<DesktopHttpFetchAction,Value>{
    if let Some(error)=desktop_http_shape_error(action){return Err(failure("invalid_request",error));}
    let request:DesktopHttpFetchAction=serde_json::from_value(action.clone()).map_err(|_|failure("invalid_request","invalid HTTP fields"))?;
    let url=Url::parse(&request.url).map_err(|_|failure("invalid_request","an absolute HTTP(S) URL is required"))?;
    if request.url.len()>16384||!["http","https"].contains(&url.scheme())||url.host_str().is_none()||!url.username().is_empty()||url.password().is_some(){return Err(failure("invalid_request","HTTP requires a bounded absolute HTTP(S) URL without embedded credentials"));}
    if request.method.as_ref().is_some_and(|method|method.len()>32||method.is_empty()||!method.bytes().all(|b|b.is_ascii_uppercase()||b==b'-')||Method::from_bytes(method.as_bytes()).is_err()){return Err(failure("invalid_request","HTTP method must be a bounded uppercase token"));}
    if request.timeoutMs.is_some_and(|n|!n.is_finite()||n.fract()!=0.0||!(100.0..=120000.0).contains(&n)){return Err(failure("invalid_request","HTTP timeoutMs must be an integer in 100..120000"));}
    if request.body.as_ref().is_some_and(|body|body.len()>4_194_304){return Err(failure("invalid_request","HTTP request body exceeds 4 MiB"));}
    if let Some(headers)=&request.headers{
        let total:usize=headers.iter().map(|(key,value)|key.len()+value.len()).sum();
        if headers.len()>64||total>65536||headers.iter().any(|(key,value)|key.len()>256||value.len()>8192||HeaderName::from_bytes(key.as_bytes()).is_err()||HeaderValue::from_str(value).is_err()){
            return Err(failure("invalid_request","HTTP headers exceed their bounds or contain an invalid name/value"));
        }
        let mut names=std::collections::HashSet::new();
        if headers.keys().any(|key|!names.insert(key.to_ascii_lowercase())){return Err(failure("invalid_request","HTTP header names must be unique without regard to case"));}
    }
    Ok(request)
}
fn sidecar(bytes:&[u8],content_type:&str,url:&str,text:bool)->Result<Value,Value>{
    let _write=CACHE_WRITE.lock().unwrap_or_else(|error|error.into_inner());
    let home=std::env::var_os(if cfg!(windows){"USERPROFILE"}else{"HOME"}).ok_or_else(||failure("provider_failed","HTTP cache home is unavailable"))?;
    let directory=std::path::PathBuf::from(home).join(".local/share/interceptor/native_url_fetch_cache");
    if !directory.is_absolute(){return Err(failure("provider_failed","HTTP cache home must be absolute"));}
    std::fs::create_dir_all(directory.parent().unwrap()).map_err(|_|failure("permission_denied","cannot create HTTP cache parent"))?;
    #[cfg(windows)]crate::windows::private_directory(&directory).map_err(|_|failure("permission_denied","HTTP cache must be a private owned directory"))?;
    #[cfg(not(windows))]{
    let mut builder=std::fs::DirBuilder::new();
    #[cfg(unix)]{use std::os::unix::fs::DirBuilderExt;builder.mode(0o700);}
    match builder.create(&directory){Ok(())=>(),Err(error)if error.kind()==std::io::ErrorKind::AlreadyExists=>(),Err(_)=>return Err(failure("permission_denied","cannot create HTTP cache directory"))}
    let metadata=std::fs::symlink_metadata(&directory).map_err(|_|failure("permission_denied","HTTP cache metadata unavailable"))?;
    if !metadata.is_dir()||metadata.file_type().is_symlink(){return Err(failure("permission_denied","HTTP cache must be an owned directory"));}
    #[cfg(unix)]{use std::os::unix::fs::MetadataExt;if metadata.uid()!=unsafe{libc::geteuid()}||metadata.mode()&0o077!=0{return Err(failure("permission_denied","HTTP cache must be private and owned (0700)"));}}
    }
    let entries=std::fs::read_dir(&directory).map_err(|_|failure("permission_denied","HTTP cache cannot be inventoried"))?;
    let(mut count,mut total)=(0usize,0u64);
    for entry in entries.take(257){let entry=entry.map_err(|_|failure("provider_failed","HTTP cache inventory failed"))?;count+=1;total=total.saturating_add(entry.metadata().map_err(|_|failure("provider_failed","HTTP cache inventory failed"))?.len());}
    if count>=256||total.saturating_add(bytes.len()as u64)>268_435_456{return Err(failure("resource_limit","HTTP sidecar cache quota reached; remove owned retained artifacts before fetching more"));}
    let nonce=SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_err(|_|failure("provider_failed","HTTP artifact clock is unavailable"))?.as_nanos();
    let id=format!("{nonce:x}{:08x}{:016x}",std::process::id(),SERIAL.fetch_add(1,Ordering::Relaxed));
    let path=directory.join(format!("url_fetch-{id}.bin"));
    #[cfg(not(windows))]let mut file={
    let mut options=std::fs::OpenOptions::new();options.write(true).create_new(true);
    #[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;options.mode(0o600).custom_flags(libc::O_NOFOLLOW);}
    options.open(&path).map_err(|_|failure("permission_denied","cannot create HTTP sidecar"))?
    };
    #[cfg(windows)]let mut file=crate::windows::private_output(&path).map_err(|_|failure("permission_denied","cannot create private HTTP sidecar"))?;
    if file.write_all(bytes).and_then(|_|file.sync_all()).is_err(){let _=std::fs::remove_file(&path);return Err(failure("provider_failed","HTTP sidecar write failed"));}
    let preview=if text{String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).into_owned()}else{String::new()};
    Ok(json!({"kind":"bodyRef","bytes":bytes.len(),"preview":preview,"sidecarPath":path,"artifactRef":{"kind":"artifact","artifactId":id,"preview":preview,"bytes":bytes.len(),"contentType":content_type,"url":url}}))
}
fn fetch(request:DesktopHttpFetchAction)->Result<Value,Value>{
    let session=session()?;
    if session.cookies.budget.lock().unwrap_or_else(|e|e.into_inner()).0==0{return Err(failure("resource_limit","HTTP cookie quota reached; restart the native provider to clear its session"));}
    let method=Method::from_bytes(request.method.as_deref().unwrap_or("GET").as_bytes()).unwrap();
    let timeout_ms=request.timeoutMs.unwrap_or(30000.0)as u64;let connect_ms=connect_deadline(timeout_ms);
    let mut builder=session.client(connect_ms)?.request(method,&request.url).timeout(Duration::from_millis(timeout_ms));
    for (name,value) in request.headers.unwrap_or_default(){builder=builder.header(name,value);}
    if let Some(body)=request.body{let decoded=STANDARD.decode(&body).ok().filter(|bytes|!bytes.is_empty());builder=builder.body(decoded.unwrap_or_else(||body.into_bytes()));}
    // A connection that never opened sent nothing, so it is a definite failure, as on the Mac.
    let mut response=builder.send().map_err(|error|if error.is_connect(){json!({"success":false,"code":"provider_failed","error":format!("url_fetch failed: could not connect to the server ({}){}; nothing was sent",error.url().and_then(|u|u.host_str()).unwrap_or("host"),if error.is_timeout(){format!(" within {connect_ms} ms")}else{String::new()}),"details":{"dispatched":false}})}else{json!({"success":false,"code":"timeout_unknown_outcome","error":"HTTP request failed after dispatch; its outcome is unknown","retryable":false,"details":{"dispatched":true}})})?;
    let result=(||{
    let status=response.status().as_u16();let final_url=response.url().to_string();
    let mut headers=serde_json::Map::new();let mut header_bytes=0;
    for (name,value) in response.headers(){
        header_bytes+=name.as_str().len()+value.as_bytes().len();
        if headers.len()>=128||header_bytes>65536{return Err(failure("resource_limit","HTTP response headers exceed their bound"));}
        let value=value.to_str().map_err(|_|failure("provider_failed","HTTP response has a non-text header value"))?;
        headers.insert(name.to_string(),json!(value));
    }
    let content_type=headers.get("content-type").and_then(Value::as_str).unwrap_or("application/octet-stream").to_owned();
    let lower=content_type.to_ascii_lowercase();let text=lower.starts_with("text/")||["json","xml","javascript","html"].iter().any(|part|lower.contains(part));
    let mut bytes=Vec::new();
    response.by_ref().take(DESKTOP_HTTP_MAX_RESPONSE_BYTES as u64+1).read_to_end(&mut bytes).map_err(|_|json!({"success":false,"code":"timeout_unknown_outcome","error":"HTTP response body was interrupted after dispatch","retryable":false,"details":{"dispatched":true}}))?;
    if bytes.len()>DESKTOP_HTTP_MAX_RESPONSE_BYTES{return Err(failure("resource_limit","HTTP response exceeds 16 MiB"));}
    if session.cookies.budget.lock().unwrap_or_else(|e|e.into_inner()).0==0{return Err(failure("resource_limit","HTTP response exceeded the session cookie quota"));}
    let body=if bytes.len()>DESKTOP_HTTP_INLINE_BYTES{sidecar(&bytes,&content_type,&request.url,text)?}
        else if text&&std::str::from_utf8(&bytes).is_ok(){json!({"kind":"text","bytes":bytes.len(),"text":std::str::from_utf8(&bytes).unwrap()})}
        else{json!({"kind":"bytes","bytes":bytes.len(),"base64":STANDARD.encode(&bytes)})};
    Ok(json!({"status":status,"headers":headers,"contentType":content_type,"body":body,"url":final_url}))
    })();
    result.map_err(|mut error:Value|{if let Some(fields)=error.as_object_mut(){fields.insert("retryable".into(),json!(false));fields.insert("details".into(),json!({"dispatched":true}));}error})
}
pub fn dispatch(action:&Value)->Value{match validate(action).and_then(fetch){Ok(data)=>success(data),Err(error)=>error}}
pub fn capability(session:&str)->Value{json!({"operation":"url","compiled":true,"present":true,"permission":"not_applicable","session":session,"effective":true,"background":"semantic","provider":"reqwest/rustls","versions":{"reqwest":"0.12.28"},"limits":["HTTP(S) only; WebPKI TLS roots; no insecure fallback","10 redirects; 16 MiB decoded response; 4 MiB request; 64 KiB inline","1 MiB cumulative cookie input per native process; no persistence after provider exit","256 retained sidecars / 256 MiB cache; no automatic artifact deletion","no application/browser cookie sharing; proxy settings follow the engine"]})}

#[cfg(test)]mod tests{
    #[test]fn connect_deadline_ends_before_the_request_deadline(){for t in [100u64,1000,5000,30000,120000]{let c=super::connect_deadline(t);assert!(c<t&&c>=50&&c<=10_000,"{t} -> {c}");}assert_eq!(super::connect_deadline(100),50);assert_eq!(super::connect_deadline(1000),750);assert_eq!(super::connect_deadline(30000),10_000);}
    use super::*;
    #[test]fn invalid_http_fields_fail_before_network(){
        assert!(validate(&json!({"type":"desktop_url_fetch","url":"http://localhost/"})).is_ok());
        for url in ["file:///tmp/fixture","ftp://localhost/a","relative","https://user:password@localhost/"]{assert!(validate(&json!({"type":"desktop_url_fetch","url":url})).is_err());}
        for extra in [json!({"method":"GET\n"}),json!({"timeoutMs":99}),json!({"timeoutMs":100.5}),json!({"timeoutMs":null}),json!({"headers":{"x-fixture":"a\r\nb"}}),json!({"headers":{"X-Test":"a","x-test":"b"}}),json!({"extra":true})]{
            let mut action=json!({"type":"desktop_url_fetch","url":"http://localhost/"});action.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());assert!(validate(&action).is_err());
        }
    }
}
