use crate::{contract_generated::*,failure,success};
use base64::{Engine as _,engine::general_purpose::STANDARD};
use rquickjs::{Runtime,Context,Function,FromJs,Coerced,Persistent,Value as JsValue,Ctx};
use serde_json::{Value,json};
use std::{collections::BTreeSet,fs,path::PathBuf,sync::{Mutex,Arc,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
type Result<T>=std::result::Result<T,Value>;
const LIMIT:usize=1048576;
// ponytail: one script helper at a time; separate bounded workers if throughput requires it.
static WORK:Mutex<()>=Mutex::new(());

fn capabilities(value:Option<&Value>)->Result<BTreeSet<String>>{
    let Some(value)=value else{return Ok(BTreeSet::new());};
    let value=value.as_str().ok_or_else(||failure("invalid_request","script host capabilities require a string"))?.trim().to_ascii_lowercase();
    if value.len()>256{return Err(failure("invalid_request","script host capabilities exceed 256 bytes"));}
    let all=["env","fs","shell","sqlite"];
    if ["false","none"].contains(&value.as_str()){return Ok(BTreeSet::new());}
    if ["true","all","native","unsafe"].contains(&value.as_str()){return Ok(all.map(String::from).into());}
    let fields=value.split(|c:char|c==','||c.is_ascii_whitespace()).filter(|s|!s.is_empty()).collect::<Vec<_>>();
    if fields.is_empty()||fields.iter().any(|field|!all.contains(field)){return Err(failure("invalid_request","portable script host capabilities are env, fs, shell and sqlite; OSA requires macOS"));}
    Ok(fields.into_iter().map(String::from).collect())
}
pub(crate) fn validate(action:&Value)->Result<BTreeSet<String>>{
    if let Some(error)=desktop_script_shape_error(action){return Err(failure("invalid_request",error));}
    let script=action["jsc"].as_str().unwrap();
    if script.is_empty()||script.len()>65536||script.contains('\0'){return Err(failure("invalid_request","script requires 1..65536 UTF8 bytes without NUL"));}
    if action["args"].as_array().is_some_and(|a|a.len()>128||a.iter().any(|v|v.as_str().is_none_or(|s|s.len()>32768||s.contains('\0')))||serde_json::to_vec(a).map_or(true,|b|b.len()>65536)){return Err(failure("invalid_request","script arguments exceed their exact string bounds"));}
    for key in ["group","groupColor"]{if action.get(key).is_some_and(|v|v.as_str().is_none_or(|s|s.is_empty()||s.len()>256||s.contains('\0'))){return Err(failure("invalid_request","invalid native request group metadata"));}}
    capabilities(action.get("jscHost"))
}
fn home()->Result<PathBuf>{std::env::var_os(if cfg!(windows){"USERPROFILE"}else{"HOME"}).map(PathBuf::from).filter(|p|p.is_absolute()).ok_or_else(||failure("provider_failed","current user's home is unavailable"))}
fn io(error:std::io::Error)->Value{failure(if error.kind()==std::io::ErrorKind::PermissionDenied{"permission_denied"}else if error.kind()==std::io::ErrorKind::NotFound{"target_gone"}else{"provider_failed"},error)}
fn host_call(name:&str,args:&Value,allowed:&BTreeSet<String>,deadline:Instant,mutated:&AtomicBool)->Result<Value>{
    let capability=match name{"home"|"env"|"expandPath"=>"env","exists"|"readText"|"readBase64"|"writeText"|"list"|"stat"=>"fs","shell"|"sh"=>"shell","sqlite"=>"sqlite",_=>return Err(failure("invalid_request","unknown script host function"))};
    if !allowed.contains(capability){return Err(failure("permission_denied","script host function was not enabled"));}
    if Instant::now()>=deadline{return Err(failure("resource_limit","script host deadline expired"));}
    let args=args.as_array().ok_or_else(||failure("invalid_request","host arguments require an array"))?;
    let count=match name{"home"=>0,"writeText"|"sqlite"=>2,"shell"=>if args.len()==1{1}else{2},_=>1};
    if args.len()!=count{return Err(failure("invalid_request","incorrect host function argument count"));}
    let string=|i:usize|->Result<&str>{args.get(i).and_then(Value::as_str).filter(|s|s.len()<=LIMIT&&!s.contains('\0')).ok_or_else(||failure("invalid_request","host requires bounded exact string arguments"))};
    match name{
        "home"=>Ok(json!(home()?)),
        "env"=>{let name=string(0)?;if name.is_empty()||name.len()>128||name.contains('='){return Err(failure("invalid_request","invalid environment name"));}match std::env::var(name){Ok(value)if value.len()<=LIMIT=>Ok(json!(value)),Ok(_)=>Err(failure("resource_limit","environment value exceeds 1 MiB")),Err(std::env::VarError::NotPresent)=>Ok(Value::Null),Err(_)=>Err(failure("unsupported_target","environment value is not UTF8"))}},
        "expandPath"=>{let value=string(0)?;Ok(if value=="~"||value.starts_with("~/")||cfg!(windows)&&value.starts_with("~\\"){json!(home()?.join(value.get(2..).unwrap_or("")))}else{json!(value)})},
        "exists"=>{let path=crate::filesystem::absolute(string(0)?)?;match fs::metadata(path){Ok(_)=>Ok(json!(true)),Err(e)if e.kind()==std::io::ErrorKind::NotFound=>Ok(json!(false)),Err(e)=>Err(io(e))}},
        "readText"|"readBase64"=>{
            let path=crate::filesystem::absolute(string(0)?)?;let metadata=fs::metadata(&path).map_err(io)?;
            if metadata.len()>LIMIT as u64{return Err(failure("resource_limit","host file input exceeds 1 MiB"));}
            let read=crate::filesystem::dispatch("fs_read",&json!({"type":"desktop_fs_read","path":path,"encoding":"base64","byteRange":{"start":0,"length":LIMIT+1}}));if read["success"]!=true{return Err(read);}
            let bytes=STANDARD.decode(read["data"]["content"].as_str().ok_or_else(||failure("provider_failed","filesystem omitted content"))?).map_err(|_|failure("provider_failed","filesystem returned invalid byte encoding"))?;
            if bytes.len()>LIMIT||read["data"]["attributes"]["size"].as_f64().is_some_and(|n|n>LIMIT as f64){return Err(failure("resource_limit","host file grew beyond 1 MiB"));}
            if name=="readBase64"{Ok(json!(STANDARD.encode(bytes)))}else{Ok(json!(String::from_utf8(bytes).map_err(|_|failure("unsupported_target","host.readText requires UTF8"))?))}
        }
        "writeText"=>{
            let path=crate::filesystem::absolute(string(0)?)?;let content=string(1)?;mutated.store(true,Ordering::Relaxed);
            let result=crate::filesystem::dispatch("fs_write",&json!({"type":"desktop_fs_write","path":path,"content":content}));if result["success"]==true{Ok(json!(true))}else{Err(result)}
        }
        "list"=>{
            let path=crate::filesystem::absolute(string(0)?)?;let mut entries=vec![];let mut bytes=0;
            for entry in fs::read_dir(path).map_err(io)?{let name=entry.map_err(io)?.file_name().into_string().map_err(|_|failure("unsupported_target","directory contains a non-UTF8 name"))?;bytes+=name.len();entries.push(name);if entries.len()>4096||bytes>LIMIT||Instant::now()>=deadline{return Err(failure("resource_limit","directory listing exceeds its count, byte or time bound"));}}
            entries.sort();Ok(json!(entries))
        }
        "stat"=>{
            let path=crate::filesystem::absolute(string(0)?)?;let metadata=match fs::metadata(&path){Ok(m)=>m,Err(e)if e.kind()==std::io::ErrorKind::NotFound=>return Ok(json!({"path":path,"exists":false,"isDirectory":false})),Err(e)=>return Err(io(e))};
            let mut result=json!({"path":path,"exists":true,"isDirectory":metadata.is_dir(),"size":metadata.len()});
            for (key,value)in[("creationDate",metadata.created()),("modificationDate",metadata.modified())]{if let Ok(value)=value{let value=time::OffsetDateTime::from(value).format(&time::format_description::well_known::Rfc3339).map_err(|_|failure("provider_failed","file timestamp cannot be encoded"))?;result[key]=json!(value);}}
            #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;result["posixPermissions"]=json!(metadata.permissions().mode()&0o7777);}
            Ok(result)
        }
        "shell"|"sh"=>{
            let (binary,args)=if name=="shell"{
                let binary=crate::filesystem::absolute(string(0)?)?;let args=if args.len()==1{vec![]}else{args[1].as_array().filter(|a|a.len()<=128).ok_or_else(||failure("invalid_request","host.shell requires at most 128 exact string arguments"))?.iter().map(|v|v.as_str().filter(|s|s.len()<=32768&&!s.contains('\0')).map(String::from).ok_or_else(||failure("invalid_request","invalid shell argument"))).collect::<Result<Vec<_>>>()?};(binary,args)
            }else{
                #[cfg(unix)]let binary=PathBuf::from("/bin/sh");
                #[cfg(windows)]let binary=PathBuf::from(std::env::var_os("SystemRoot").ok_or_else(||failure("provider_failed","Windows system directory is unavailable"))?).join("System32").join("cmd.exe"); // backslashes: cmd.exe reads switches anywhere in its command line, so "System32/cmd.exe" ran "/c md.exe ..."
                #[cfg(unix)]let args=vec!["-c".into(),string(0)?.into()];
                #[cfg(windows)]let args=vec!["/D".into(),"/S".into(),"/C".into(),string(0)?.into()];
                (binary,args)
            };
            mutated.store(true,Ordering::Relaxed);
            let(status,out,err)=crate::container::capture(&binary,&args,deadline,LIMIT)?;
            Ok(json!({"exitCode":status.code().unwrap_or(-1),"timedOut":false,"stdout":String::from_utf8(out).map_err(|_|failure("unsupported_target","shell stdout is not UTF8"))?,"stderr":String::from_utf8(err).map_err(|_|failure("unsupported_target","shell stderr is not UTF8"))?}))
        }
        "sqlite"=>crate::script_sqlite::query(string(0)?,string(1)?,deadline),
        _=>unreachable!(),
    }
}
fn js_error(ctx:&Ctx<'_>,error:rquickjs::Error,deadline:Instant,mutated:&AtomicBool)->Value{
    let allocation=matches!(error,rquickjs::Error::Allocation);
    let detail=if matches!(error,rquickjs::Error::Exception){Coerced::<String>::from_js(ctx,ctx.catch()).map(|v|v.0).unwrap_or_else(|_|"JavaScript exception".into())}else{error.to_string()};
    failure(if mutated.load(Ordering::Relaxed){"partial_result"}else if allocation||Instant::now()>=deadline{"resource_limit"}else{"provider_failed"},format!("script failed: {}",detail.chars().take(512).collect::<String>()))
}
fn execute(action:&Value)->Result<Value>{
    let allowed=validate(action)?;let deadline=Instant::now()+Duration::from_secs(30);let mutated=Arc::new(AtomicBool::new(false));
    let runtime=Runtime::new().map_err(|_|failure("resource_limit","QuickJS runtime allocation failed"))?;
    runtime.set_memory_limit(32*1024*1024);runtime.set_max_stack_size(256*1024);runtime.set_interrupt_handler(Some(Box::new(move||Instant::now()>=deadline)));
    let context=Context::full(&runtime).map_err(|_|failure("resource_limit","QuickJS context allocation failed"))?;
    let value=context.with(|ctx|{
        let evaluate=(||->rquickjs::Result<_>{
            let argv=ctx.json_parse(serde_json::to_vec(&action.get("args").cloned().unwrap_or(json!([]))).unwrap())?;ctx.globals().set("argv",argv.clone())?;
            if !allowed.is_empty(){
                let capabilities=allowed.clone();let effect=mutated.clone();
                let callback=Function::new(ctx.clone(),move|name:String,args:String|->String{
                    let result=if args.len()>LIMIT{Err(failure("resource_limit","host argument encoding exceeds 1 MiB"))}else{serde_json::from_str(&args).map_err(|_|failure("invalid_request","invalid host argument encoding")).and_then(|args|host_call(&name,&args,&capabilities,deadline,&effect))};
                    let result=match result{Ok(data)=>success(data),Err(error)=>error};let bytes=serde_json::to_string(&result).unwrap();
                    if bytes.len()>LIMIT{serde_json::to_string(&failure(if effect.load(Ordering::Relaxed){"partial_result"}else{"resource_limit"},"host reply exceeds 1 MiB")).unwrap()}else{bytes}
                })?;
                ctx.globals().set("__interceptorHostCall",callback)?;
                ctx.globals().set("__interceptorCapabilities",ctx.json_parse(serde_json::to_vec(&allowed).unwrap())?)?;
                ctx.eval::<(),_>(r#"(()=>{
                    const call=__interceptorHostCall,capabilities=Object.freeze(__interceptorCapabilities),parse=JSON.parse,stringify=JSON.stringify;
                    const host={name:'Interceptor QuickJS Host',capabilities};
                    const functions={env:['home','env','expandPath'],fs:['exists','readText','readBase64','writeText','list','stat'],shell:['shell','sh'],sqlite:['sqlite']};
                    for(const capability of capabilities)for(const name of functions[capability])host[name]=(...args)=>{const reply=parse(call(name,stringify(args)));if(!reply.success)throw new Error(reply.code+': '+reply.error);return name==='env'&&reply.data===null?undefined:reply.data;};
                    globalThis.host=globalThis.Interceptor=Object.freeze(host);delete globalThis.__interceptorHostCall;delete globalThis.__interceptorCapabilities;
                })()"#)?;
            }
            // Sloppy global code, as JavaScriptCore runs `--jsc` on macOS (so `run = argv => ...` works).
            let mut options=rquickjs::context::EvalOptions::default();options.strict=false;
            let mut value:JsValue=ctx.eval_with_options(action["jsc"].as_str().unwrap(),options)?;
            if action.get("args").is_some(){let run:JsValue=ctx.globals().get("run")?;if !run.is_undefined()&&!run.is_null(){value=Function::from_value(run)?.call((argv,))?;}}
            Ok(Persistent::save(&ctx,value))
        })();
        evaluate.map_err(|error|js_error(&ctx,error,deadline,&mutated))
    })?;
    // Runtime job execution reports exceptions; Ctx::execute_pending_job
    // consumes them. Leave the context lock before draining microtasks.
    let mut jobs=0;
    while runtime.is_job_pending(){
        if jobs>=4096||Instant::now()>=deadline{return Err(failure(if mutated.load(Ordering::Relaxed){"partial_result"}else{"resource_limit"},"script pending jobs exceeded their count or time bound"));}jobs+=1;
        if let Err(error)=runtime.execute_pending_job(){return Err(error.0.with(|ctx|js_error(&ctx,rquickjs::Error::Exception,deadline,&mutated)));}
    }
    context.with(|ctx|->Result<Value>{
        let serialize=(||->rquickjs::Result<Value>{
            let value=value.restore(&ctx)?;
            let (result,raw)=if value.is_big_int()||value.is_symbol()||value.is_function(){let text=Coerced::<String>::from_js(&ctx,value)?.0;(json!(text),text)}else{
                let serialized=ctx.json_stringify(value.clone())?;
                if let Some(serialized)=serialized{let raw=serialized.to_string()?;(serde_json::from_str::<Value>(&raw).map_err(|_|rquickjs::Error::new_from_js("JSON","result"))?,raw)}else{(Value::Null,Coerced::<String>::from_js(&ctx,value)?.0)}
            };
            let mut data=json!({"result":result,"raw":raw,"script":action["jsc"],"language":"JavaScript","engine":"QuickJS"});
            if let Some(args)=action.get("args"){data["arguments"]=args.clone();}if !allowed.is_empty(){data["host"]=json!({"capabilities":allowed});}
            Ok(data)
        })();
        let data=serialize.map_err(|error|js_error(&ctx,error,deadline,&mutated))?;
        fn bounded(value:&Value,depth:usize,budget:&mut usize)->bool{
            if depth>32||*budget==0{return false;}*budget-=1;
            match value{Value::Array(values)=>values.iter().all(|v|bounded(v,depth+1,budget)),Value::Object(values)=>values.values().all(|v|bounded(v,depth+1,budget)),_=>true}
        }
        if !bounded(&data["result"],0,&mut 4096){return Err(failure(if mutated.load(Ordering::Relaxed){"partial_result"}else{"resource_limit"},"script result exceeds its JSON depth or node bound"));}
        if serde_json::to_vec(&data).map_or(true,|b|b.len()>LIMIT){return Err(failure(if mutated.load(Ordering::Relaxed){"partial_result"}else{"resource_limit"},"script result exceeds 1 MiB"));}Ok(data)
    })
}
pub fn dispatch(action:&Value)->Value{
    if let Err(error)=validate(action){return error;}
    let Ok(_work)=WORK.try_lock()else{return failure("resource_limit","script execution is busy; no work was queued");};
    match crate::thumbnail::image_helper("--script-engine",action,Instant::now()+Duration::from_secs(30)){Ok(data)=>success(data),Err(error)=>error}
}
pub fn helper()->std::io::Result<()>{
    let bytes=crate::read_frame(&mut std::io::stdin().lock())?.ok_or_else(||std::io::Error::other("script helper requires one framed request"))?;
    let action:Value=serde_json::from_slice(&bytes)?;
    #[cfg(unix)]let result=crate::thumbnail_pdf::limit_memory().and_then(|_|execute(&action));
    #[cfg(windows)]let result=execute(&action); // Parent assigns the helper to its memory-limited kill-on-close job before sending input.
    let result=match result{Ok(data)=>success(data),Err(error)=>error};crate::write_frame(&mut std::io::stdout().lock(),&serde_json::to_vec(&result)?)
}
pub fn capabilities_for(session:&str)->Vec<Value>{
    ["script_run","intent_dispatch"].map(|operation|json!({"operation":operation,"compiled":true,"present":true,"permission":"not_applicable","session":session,"effective":false,"background":"semantic","provider":"QuickJS","versions":{"contract":"1","rquickjs":"0.14.0"},"limits":["Plain JavaScript uses QuickJS; AppleScript, JXA, Apple Events and OSA host functions require macOS.","No host functions by default. Explicit env/fs/shell/sqlite capabilities; no module loader, ambient filesystem or implicit process access.","30-second action budget; 32 MiB JS heap; 256 KiB stack; 64 KiB script and arguments; 1 MiB result; one owned worker.","Host files and shell output are bounded. SQLite 3.41+ uses a read-only connection and authorizer; writes and ATTACH are denied.","host.sh uses /bin/sh -c or Windows cmd.exe /D /S /C. Microtasks are drained with a 4096-job bound; Promises serialize as objects without awaiting."],"reason":"Build, engine/license, CPU behavior, process cleanup and final installed CLI/MCP qualification remain open."})).into()
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn plain_scripts_have_no_ambient_host_and_exact_run_arguments(){
        let result=execute(&json!({"type":"desktop_script_run","jsc":"[typeof host,typeof process,typeof require,typeof Interceptor]"})).unwrap();assert_eq!(result["result"],json!(["undefined","undefined","undefined","undefined"]));
        let result=execute(&json!({"type":"desktop_script_run","jsc":"function run(args){return {argument:args[0],global:argv[0]}}","args":["Unicode 验证"]})).unwrap();assert_eq!(result["result"]["argument"],"Unicode 验证");assert_eq!(result["result"]["global"],"Unicode 验证");
        assert!(validate(&json!({"type":"desktop_script_run","jsc":"1","jscHost":"osa"})).is_err());
        assert!(execute(&json!({"type":"desktop_script_run","jsc":"host.readText('/missing')","jscHost":"env"})).is_err());
        let result=execute(&json!({"type":"desktop_script_run","jsc":"const observed=[]; Promise.resolve().then(()=>observed.push('actual job')); observed"})).unwrap();assert_eq!(result["result"],json!(["actual job"]));
        let root=std::env::current_dir().unwrap().join("target").join(format!("script-owned-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let path=root.join("验证.txt");
        let result=execute(&json!({"type":"desktop_script_run","jsc":"host.writeText(argv[0],'actual Unicode 验证'); ({text:host.readText(argv[0]),stat:host.stat(argv[0]),entries:host.list(argv[1])})","jscHost":"fs","args":[path,root]})).unwrap();
        assert_eq!(result["result"]["text"],"actual Unicode 验证");assert_eq!(result["result"]["stat"]["exists"],true);assert_eq!(result["result"]["entries"],json!(["验证.txt"]));
        fs::remove_file(path).unwrap();fs::remove_dir(root).unwrap();
    }
}
