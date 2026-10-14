//! Hyprland 0.56.1 native Wayland keyboard routing. Version-matched Lua
//! send_shortcut calls Actions::pass, which restores the previous seat focus.
//! XWayland targets are excluded because that implementation can reroute them.
use crate::failure;
use serde_json::{Value,json};
use std::{io::{Read,Write},os::unix::{fs::{MetadataExt,FileTypeExt},net::UnixStream},
    os::fd::AsRawFd,path::{Path,PathBuf},time::Duration};

struct Endpoint{path:PathBuf,display:PathBuf,owner:libc::pid_t}
pub(crate) fn private_directory(path:&Path)->Result<(),Value>{
    let meta=std::fs::symlink_metadata(path).map_err(|e|failure("background_unavailable",e))?;
    if !path.is_absolute()||!meta.is_dir()||meta.uid()!=unsafe{libc::geteuid()}||meta.mode()&0o777!=0o700{
        return Err(failure("permission_denied","compositor runtime must be an owned private directory"));
    }Ok(())
}
pub(crate) fn connect(path:&Path)->Result<(UnixStream,libc::pid_t),Value>{
    let meta=std::fs::symlink_metadata(path).map_err(|e|failure("background_unavailable",e))?;
    if !meta.file_type().is_socket()||meta.uid()!=unsafe{libc::geteuid()}{return Err(failure("permission_denied","compositor endpoint is not an owned Unix socket"));}
    let stream=UnixStream::connect(path).map_err(|e|failure("background_unavailable",e))?;
    let mut cred:libc::ucred=unsafe{std::mem::zeroed()};let mut size=std::mem::size_of::<libc::ucred>()as libc::socklen_t;
    if unsafe{libc::getsockopt(stream.as_raw_fd(),libc::SOL_SOCKET,libc::SO_PEERCRED,(&mut cred as *mut libc::ucred).cast(),&mut size)}!=0||size as usize!=std::mem::size_of::<libc::ucred>()||cred.uid!=unsafe{libc::geteuid()}||cred.pid<=0{
        return Err(failure("permission_denied","compositor peer credentials do not match the current user"));
    }
    let login=crate::linux::login_session(0).ok_or_else(||failure("permission_denied","compositor requires a current login session"))?;
    if !crate::linux_peer::authorized(&stream,&login,None){
        return Err(failure("permission_denied","compositor peer requires the same user and login session"));
    }
    stream.set_read_timeout(Some(Duration::from_millis(750))).and_then(|_|stream.set_write_timeout(Some(Duration::from_millis(750)))).map_err(|e|failure("provider_failed",e))?;
    Ok((stream,cred.pid))
}
impl Endpoint{
    fn open()->Result<Self,Value>{
        let display=std::env::var("WAYLAND_DISPLAY").map_err(|_|failure("background_unavailable","native Wayland display is not configured"))?;
        let runtime=if Path::new(&display).is_absolute(){Path::new(&display).parent().unwrap().to_path_buf()}
            else{PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").ok_or_else(||failure("background_unavailable","Wayland runtime directory is missing"))?)};
        private_directory(&runtime)?;
        let signature=std::env::var("HYPRLAND_INSTANCE_SIGNATURE").map_err(|_|failure("background_unavailable","no Hyprland instance is configured"))?;
        if signature.is_empty()||signature.len()>128||!signature.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-'){
            return Err(failure("invalid_request","invalid Hyprland instance signature"));
        }
        let folder=runtime.join("hypr").join(signature);private_directory(&runtime.join("hypr"))?;private_directory(&folder)?;
        let display=runtime.join(display);
        let (_,display_owner)=connect(&display)?;
        let path=folder.join(".socket.sock");let (_,owner)=connect(&path)?;
        if owner!=display_owner{return Err(failure("permission_denied","Wayland and compositor IPC endpoints have different owners"));}
        let endpoint=Self{path,display,owner};let version=endpoint.json("j/version")?;
        if version["version"]!="0.56.1"||version["commit"]!="5c9377c15f85c50648f35ca5a213754f95b93ca0"||version["dirty"]!=false{
            return Err(failure("background_unavailable","Hyprland version has not passed this keyboard backend's qualification"));
        }Ok(endpoint)
    }
    fn request(&self,command:&str)->Result<String,Value>{
        let(mut stream,owner)=connect(&self.path)?;
        if owner!=self.owner{return Err(failure("stale_reference","compositor process changed before delivery"));}
        stream.write_all(command.as_bytes()).map_err(|e|failure("timeout_unknown_outcome",e))?;
        let mut bytes=Vec::new();stream.take(2_000_001).read_to_end(&mut bytes).map_err(|e|failure("timeout_unknown_outcome",e))?;
        if bytes.len()>2_000_000{return Err(failure("resource_limit","compositor reply exceeds 2 MB"));}
        String::from_utf8(bytes).map_err(|_|failure("provider_failed","compositor returned invalid UTF-8"))
    }
    fn json(&self,command:&str)->Result<Value,Value>{serde_json::from_str(&self.request(command)?).map_err(|_|failure("provider_failed","invalid compositor JSON reply"))}
    fn window(&self,pid:u32,title:&str)->Result<Value,Value>{
        let clients=self.json("j/clients")?;let clients=clients.as_array().filter(|c|c.len()<=1024).ok_or_else(||failure("resource_limit","invalid compositor client inventory"))?;
        let matches:Vec<_>=clients.iter().filter(|c|c["pid"].as_u64()==Some(pid as u64)&&c["title"]==title&&c["mapped"]==true).collect();
        if matches.len()!=1{return Err(failure(if matches.is_empty(){"target_gone"}else{"target_ambiguous"},"keyboard target requires one matching native Wayland client"));}
        let client=matches[0];
        if client["xwayland"]!=false{return Err(failure("background_unavailable","Hyprland keyboard routing does not qualify XWayland targets"));}
        address(client)?;Ok(client.clone())
    }
}
fn address(client:&Value)->Result<u64,Value>{
    client["address"].as_str().and_then(|s|s.strip_prefix("0x")).filter(|s|!s.is_empty()&&s.len()<=16&&s.bytes().all(|b|b.is_ascii_hexdigit())).and_then(|s|u64::from_str_radix(s,16).ok()).filter(|id|*id>0).ok_or_else(||failure("provider_failed","invalid compositor window address"))
}
fn chord(value:&str)->Result<(String,String),Value>{
    let names=value.split('+').map(str::to_ascii_lowercase).collect::<Vec<_>>();
    if names.is_empty()||names.len()>8||names.iter().any(|n|n.is_empty()){return Err(failure("invalid_request","invalid key combination"));}
    let mut modifiers=Vec::new();let mut key=None;
    for name in names{
        let modifier=match name.as_str(){"ctrl"|"control"=>Some("CTRL"),"shift"=>Some("SHIFT"),"alt"|"option"=>Some("ALT"),"win"|"super"|"cmd"|"command"|"meta"=>Some("SUPER"),_=>None};
        if let Some(modifier)=modifier{if modifiers.contains(&modifier){return Err(failure("invalid_request","key combination repeats a modifier"));}modifiers.push(modifier);continue;}
        let mapped=match name.as_str(){"enter"|"return"=>"Return","esc"|"escape"=>"Escape","tab"=>"Tab","space"=>"space","backspace"=>"BackSpace","delete"|"forwarddelete"=>"Delete","left"|"arrowleft"=>"Left","right"|"arrowright"=>"Right","up"|"arrowup"=>"Up","down"|"arrowdown"=>"Down","home"=>"Home","end"=>"End","pageup"=>"Page_Up","pagedown"=>"Page_Down",_=>name.as_str()};
        let mapped=if name.starts_with('f')&&name[1..].parse::<u8>().is_ok_and(|n|(1..=24).contains(&n)){format!("F{}",&name[1..])}else{mapped.to_owned()};
        if key.is_some()||!(mapped.len()==1&&mapped.bytes().all(|b|b.is_ascii_alphanumeric())||["Return","Escape","Tab","space","BackSpace","Delete","Left","Right","Up","Down","Home","End","Page_Up","Page_Down"].contains(&mapped.as_str())||mapped.starts_with('F')&&mapped[1..].parse::<u8>().is_ok_and(|n|(1..=24).contains(&n))){return Err(failure("invalid_request","Wayland key combination requires one supported non-modifier key"));}
        key=Some(mapped);
    }
    let key=key.ok_or_else(||failure("invalid_request","Wayland key combination requires a non-modifier key"))?;
    Ok((modifiers.join(" "),key))
}
pub fn available()->bool{Endpoint::open().is_ok()}
/// Only the installed, digest-checked payload can enter this maintenance path.
/// Reuse the same retained compositor user/login checks as native input.
pub fn pointer_maintenance(payload:&interceptor_desktop::pointer_payload::Payload,load:bool)->Result<Value,Value>{
    let endpoint=Endpoint::open()?;
    let owner=crate::linux::capture_identity(endpoint.owner as u32)?;
    if endpoint.json("j/version")?["abiHash"]!=payload.abi_hash{return Err(failure("background_unavailable","installed pointer payload does not match the running compositor ABI"));}
    let meta=std::fs::metadata(&payload.path).map_err(|e|failure("provider_failed",e))?;
    let mut maps=String::new();
    std::fs::File::open(format!("/proc/{}/maps",endpoint.owner)).and_then(|file|file.take(2_000_001).read_to_string(&mut maps)).map_err(|e|failure("permission_denied",e))?;
    if maps.len()>2_000_000{return Err(failure("resource_limit","compositor mappings exceed 2 MB"));}
    let mapped=maps.lines().any(|line|{
        let fields=line.split_ascii_whitespace().collect::<Vec<_>>();
        fields.len()==6&&fields[5]==payload.path.to_string_lossy()&&fields[4].parse::<u64>().ok()==Some(meta.ino())&&
            fields[3].split_once(':').is_some_and(|(major,minor)|u64::from_str_radix(major,16).ok()==Some(libc::major(meta.dev())as u64)&&u64::from_str_radix(minor,16).ok()==Some(libc::minor(meta.dev())as u64))
    });
    let plugins=endpoint.json("j/plugin list")?;
    let plugins=plugins.as_array().filter(|plugins|plugins.len()<=1024).ok_or_else(||failure("provider_failed","invalid compositor plugin inventory"))?;
    let named=plugins.iter().filter(|plugin|plugin["name"]=="interceptor-background-pointer").collect::<Vec<_>>();
    if named.len()>1||named.iter().any(|plugin|plugin["author"]!="Interceptor"||plugin["version"]!="1")||(!named.is_empty()&&!mapped){return Err(failure("permission_denied","pointer plugin inventory is not bound to the installed payload; refusing maintenance"));}
    // dlclose may retain mappings for a Rust/C++ shared library. The plugin
    // inventory establishes active registration; maps bind an active plugin
    // to this file and are not an oracle for successful unload.
    let active=!named.is_empty();
    if !owner.alive(){return Err(failure("stale_reference","compositor changed during pointer maintenance"));}
    if load==active{return Ok(json!({"loaded":load,"alreadyApplied":true,"path":payload.path,"sha256":payload.sha256,"abiHash":payload.abi_hash}));}
    let command=format!("plugin {} {}",if load{"load"}else{"unload"},payload.path.display());
    let reply=endpoint.request(&command)?;
    if reply.trim()!="ok"{return Err(failure("provider_failed",format!("compositor refused pointer maintenance: {}",reply.chars().take(1024).collect::<String>())));}
    Ok(json!({"loaded":load,"path":payload.path,"sha256":payload.sha256,"abiHash":payload.abi_hash}))
}
pub fn clipboard_connection()->Result<UnixStream,Value>{
    let endpoint=Endpoint::open()?;
    let (stream,owner)=connect(&endpoint.display)?;
    if owner!=endpoint.owner{return Err(failure("stale_reference","Wayland compositor changed before clipboard connection"));}
    Ok(stream)
}
pub fn pointer_protocol_version()->Option<u32>{
    clipboard_connection().ok().and_then(|stream|interceptor_desktop::linux_pointer::PointerConnection::connect(stream).ok()).map(|client|client.protocol_version())
}
pub fn app_action(pid:u32,operation:&str)->Result<Value,Value>{
    let process=crate::linux::capture_identity(pid).map_err(|error|if error["code"]=="target_gone"{failure("unsupported_target","selected app process is not running")}else{error})?;
    let endpoint=Endpoint::open()?;
    let inventory=endpoint.json("j/clients")?;
    let inventory=inventory.as_array().filter(|clients|clients.len()<=1024).ok_or_else(||failure("resource_limit","invalid compositor app inventory"))?;
    let windows=inventory.iter().filter(|window|window["pid"].as_u64()==Some(pid as u64)&&window["mapped"]==true).collect::<Vec<_>>();
    if windows.is_empty(){return Err(failure("unsupported_target","selected process has no mapped native Wayland windows"));}
    if windows.len()>64{return Err(failure("resource_limit","app lifecycle supports at most 64 mapped windows"));}
    if windows.iter().any(|window|window["xwayland"]!=false){return Err(failure("unsupported_target","Wayland app lifecycle excludes XWayland targets"));}
    let anchor=address(windows[0])?;
    let mut client=interceptor_desktop::linux_pointer::PointerConnection::connect(clipboard_connection()?).map_err(|error|failure(&error.code,error.message))?;
    if !process.alive(){return Err(failure("target_gone","selected app exited before delivery"));}
    let reply=client.execute_app(operation,pid,anchor,process.pidfd()).map_err(|error|{
        let mut result=failure(&error.code,error.message);
        result["retryable"]=json!(false);
        result["details"]=json!({"dispatched":error.dispatched,"effectRequiresObservation":error.dispatched});result
    })?;
    if !reply.success{
        let mut result=failure(if reply.code=="input_busy"{"background_unavailable"}else{&reply.code},"compositor refused or could not verify app lifecycle; observe any reported partial effects before another action");
        result["retryable"]=json!(false);
        result["details"]=json!({"dispatched":reply.delivered>0||reply.code=="timeout_unknown_outcome","delivered":reply.delivered,"focusUnchanged":reply.focus_unchanged,"cursorUnchanged":reply.cursor_unchanged,"effectRequiresObservation":reply.delivered>0||reply.code=="timeout_unknown_outcome"});
        return Err(result);
    }
    Ok(json!({"subcommand":operation,"pid":pid,"windows":windows.len(),"method":"Hyprland.app-lifecycle-v3","protocolVersion":client.protocol_version(),"background":operation!="activate","foregroundUsed":operation=="activate","focusUnchanged":reply.focus_unchanged,"cursorUnchanged":reply.cursor_unchanged,"delivered":reply.delivered,"effectRequiresObservation":operation=="quit"}))
}
pub struct MenuScope{
    client:interceptor_desktop::linux_pointer::PointerConnection,
    target:crate::linux::CaptureIdentity,
    command:String,
}
impl MenuScope{
    pub fn open(pid:u32,title:&str)->Result<Self,Value>{
        let target=crate::linux::capture_identity(pid)?;
        let endpoint=Endpoint::open()?;
        let id=address(&endpoint.window(pid,title)?)?;
        let client=interceptor_desktop::linux_pointer::PointerConnection::connect(clipboard_connection()?).map_err(|error|failure(&error.code,error.message))?;
        if !client.supports_menu_scope(){return Err(failure("background_unavailable","Wayland menu invocation requires the qualified version 2 companion; no menu was invoked"));}
        Ok(Self{client,target,command:format!("menu-guard {id} {pid} 0 0 0 0")})
    }
    pub fn refresh(&mut self)->Result<(),Value>{
        if !self.target.alive(){return Err(failure("stale_reference","menu target identity changed before invocation"));}
        let reply=self.client.execute(&self.command).map_err(|error|failure(&error.code,error.message))?;
        if !reply.success{return Err(failure(if reply.code=="input_busy"{"background_unavailable"}else{&reply.code},"compositor refused the menu popup scope; no menu action was invoked"));}
        Ok(())
    }
}
pub fn pointer_input(verb:&str,action:&Value,pid:u32,title:&str,start:Option<(i32,i32)>,end:Option<(i32,i32)>)->Result<Value,Value>{
    use interceptor_desktop::linux_pointer::PointerConnection;
    let process=crate::linux::capture_identity(pid)?;
    let endpoint=Endpoint::open()?;
    let id=address(&endpoint.window(pid,title)?)?;
    if action["window"].as_u64().is_some_and(|window|window!=id){return Err(failure("unsupported_target","Wayland window selector does not match the retained client"));}
    let p=start.ok_or_else(||failure("unsupported_target","pointer target has no qualified screen bounds"))?;
    let q=if verb=="drag"{end.ok_or_else(||failure("invalid_request","drag requires an endpoint"))?}else{p};
    let op=match verb{
        "click"=>if action["right"]==true{"right"}else if action["double"]==true{"double"}else{"click"},
        "drag"=>"drag",
        "scroll"=>match action["direction"].as_str().unwrap_or("down"){"up"=>"up","down"=>"down","left"=>"left","right"=>"right-scroll",_=>return Err(failure("invalid_request","invalid wheel direction"))},
        _=>return Err(failure("unsupported_operation","unknown Wayland pointer operation")),
    };
    let units=if verb=="scroll"{action["amount"].as_u64().unwrap_or(300).div_ceil(120)}else{1};
    let times=if verb=="scroll"{action["times"].as_u64().unwrap_or(1)}else{1};
    if units.saturating_mul(times)>512{return Err(failure("resource_limit","Wayland wheel request exceeds 512 steps; nothing was delivered"));}
    let interval=action["intervalMs"].as_u64().unwrap_or(0);
    let stream=clipboard_connection()?;
    let mut client=PointerConnection::connect(stream).map_err(|error|failure(&error.code,error.message))?;
    let began=std::time::Instant::now();
    let command=format!("{op} {id} {pid} {} {} {} {}",p.0,p.1,q.0,q.1);
    let mut delivered=0_u32;
    let refused=|code:&str,message:&str,delivered:u32|{
        let code=if delivered>0{"timeout_unknown_outcome"}else if code=="input_busy"{"background_unavailable"}else{code};
        let mut error=failure(code,message);
        error["details"]=json!({"delivered":delivered,"effectRequiresObservation":delivered>0});error
    };
    for group in 0..times{
        if group>0&&interval>0{std::thread::sleep(Duration::from_millis(interval));}
        for _ in 0..units{
            if began.elapsed()>Duration::from_secs(2){return Err(refused("cancelled","pointer delivery budget expired; observe before choosing another action",delivered));}
            let current=endpoint.window(pid,title).and_then(|client|address(&client))
                .map_err(|_|refused("stale_reference","Wayland target changed before remaining input",delivered))?;
            if !process.alive()||current!=id{
                return Err(refused("stale_reference","Wayland target exited or changed; remaining input cancelled",delivered));
            }
            let reply=client.execute(&command).map_err(|error|{
                let mut result=refused(if error.dispatched{"timeout_unknown_outcome"}else{&error.code},&error.message,delivered);
                result["details"]["dispatched"]=json!(error.dispatched);
                result["details"]["effectRequiresObservation"]=json!(error.dispatched||delivered>0);result
            })?;
            delivered=delivered.saturating_add(reply.delivered);
            if !reply.success{return Err(refused(&reply.code,"compositor refused pointer delivery; observe any reported partial input",delivered));}
        }
    }
    if !process.alive(){return Err(refused("target_gone","Wayland target exited after input; observe before choosing another action",delivered));}
    Ok(json!({"method":"Hyprland.background-pointer-v1","background":true,"foregroundUsed":false,"focusUnchanged":true,"cursorUnchanged":true,"delivered":delivered,"windowId":id.to_string(),"targetPid":pid,"elapsedMs":began.elapsed().as_millis(),"compositorVersion":"0.56.1","effectRequiresObservation":true}))
}
pub fn window_info(pid:u32,title:&str)->Result<(u64,Value),Value>{
    let process=crate::linux::capture_identity(pid)?;
    let client=Endpoint::open()?.window(pid,title)?;
    let frame=window_frame(&client)?;
    if !process.alive(){return Err(failure("stale_reference","Wayland window process exited during geometry read"));}
    Ok((address(&client)?,frame))
}
fn window_frame(client:&Value)->Result<Value,Value>{
    let at=client["at"].as_array().filter(|v|v.len()==2).ok_or_else(||failure("provider_failed","invalid Wayland window position"))?;
    let size=client["size"].as_array().filter(|v|v.len()==2).ok_or_else(||failure("provider_failed","invalid Wayland window dimensions"))?;
    let fields=[&at[0],&at[1],&size[0],&size[1]];
    if fields.iter().any(|v|v.as_i64().is_none_or(|n|i32::try_from(n).is_err()))||size.iter().any(|v|v.as_i64().unwrap_or(0)<=0){return Err(failure("provider_failed","Wayland window geometry is out of range"));}
    Ok(json!({"x":at[0],"y":at[1],"width":size[0],"height":size[1]}))
}
pub struct ActiveWindow{pub pid:u32,pub id:u64,pub title:String,pub frame:Value}
pub fn active_window()->Result<Option<ActiveWindow>,Value>{
    let endpoint=Endpoint::open()?;
    let active=endpoint.json("j/activewindow")?;
    if active.as_object().is_some_and(|object|object.is_empty()){return Ok(None);}
    let pid=active["pid"].as_u64().and_then(|pid|u32::try_from(pid).ok()).filter(|pid|*pid>0)
        .ok_or_else(||failure("provider_failed","invalid compositor active-window process"))?;
    let title=active["title"].as_str().filter(|title|title.len()<=65536)
        .ok_or_else(||failure("provider_failed","invalid compositor active-window title"))?;
    let process=crate::linux::capture_identity(pid)?;
    let client=endpoint.window(pid,title)?;
    let id=address(&active)?;
    if address(&client)?!=id||!process.alive(){return Err(failure("stale_reference","active Wayland window changed during observation"));}
    Ok(Some(ActiveWindow{pid,id,title:title.to_owned(),frame:window_frame(&client)?}))
}
pub fn keys(action:&Value,pid:u32,title:&str)->Result<Value,Value>{
    let(modifiers,key)=chord(action["keys"].as_str().unwrap_or(""))?;
    let process=crate::linux::capture_identity(pid)?;let endpoint=Endpoint::open()?;
    let client=endpoint.window(pid,title)?;let id=address(&client)?;
    if action["window"].as_u64().is_some_and(|window|window!=id){return Err(failure("unsupported_target","Wayland window selector does not match the retained client"));}
    let active=endpoint.json("j/activewindow")?;let cursor=endpoint.json("j/cursorpos")?;
    if !process.alive()||address(&endpoint.window(pid,title)?)?!=id{return Err(failure("stale_reference","Wayland target changed before delivery"));}
    // All interpolated values are validated ASCII key constants and an integer
    // formatted as hex. This IPC command cannot contain arbitrary Lua or shell.
    let command=format!("dispatch hl.dsp.send_shortcut{{mods=\"{modifiers}\",key=\"{key}\",window=\"address:0x{id:x}\"}}");
    let reply=endpoint.request(&command)?;
    if reply.trim()!="ok"{return Err(failure("timeout_unknown_outcome",format!("compositor rejected keyboard dispatch; observe before retrying: {}",reply.chars().take(300).collect::<String>())));}
    let after=endpoint.json("j/activewindow").map_err(|_|failure("timeout_unknown_outcome","keyboard was dispatched but foreground verification failed; observe before retrying"))?;
    let after_cursor=endpoint.json("j/cursorpos").map_err(|_|failure("timeout_unknown_outcome","keyboard was dispatched but cursor verification failed; observe before retrying"))?;
    let focus_unchanged=after["address"]==active["address"];
    let cursor_unchanged=after_cursor==cursor;
    if !process.alive(){return Err(failure("timeout_unknown_outcome","Wayland target exited after delivery; observe before retrying"));}
    // The keys were already delivered, so a moved focus cannot be undone: report it as a
    // failed background-only delivery instead of a success with foregroundUsed.
    if action["backgroundOnly"]==true&&!focus_unchanged{return Err(failure("timeout_unknown_outcome","keys were delivered but the compositor moved focus, so background-only delivery was not kept; observe before retrying"));}
    Ok(json!({"method":"Hyprland.Lua.send_shortcut","background":focus_unchanged,"foregroundUsed":!focus_unchanged,"focusUnchanged":focus_unchanged,"cursorUnchanged":cursor_unchanged,"windowId":id.to_string(),"targetPid":pid,"compositorVersion":"0.56.1","effectRequiresObservation":true}))
}
/// Exact move/resize of one Hyprland client (Lua dispatchers `hl.dsp.window.float`, `move`,
/// `resize`). A tiled window has no free geometry, so it is set floating first. Returns the
/// compositor's frame once it matches the request or settles; focus and cursor are untouched.
pub fn geometry(verb:&str,action:&Value,pid:u32,title:&str)->Result<Value,Value>{
    let fields=if verb=="resize"{["width","height"]}else{["x","y"]};
    let (x,y)=match (action[fields[0]].as_i64(),action[fields[1]].as_i64()){
        (Some(x),Some(y)) if (-32768..=32767).contains(&x)&&(-32768..=32767).contains(&y)&&(verb!="resize"||x>0&&y>0)=>(x,y),
        _=>return Err(failure("invalid_request","geometry requires integer coordinates within the native range")),
    };
    let process=crate::linux::capture_identity(pid)?;let endpoint=Endpoint::open()?;
    let client=endpoint.window(pid,title)?;let id=address(&client)?;
    let send=|command:String|->Result<(),Value>{
        let reply=endpoint.request(&command)?;
        if reply.trim()!="ok"{return Err(failure("timeout_unknown_outcome",format!("compositor rejected geometry dispatch; observe before retrying: {}",reply.chars().take(300).collect::<String>())));}
        Ok(())
    };
    // Values are validated integers and a hex address: the IPC command carries no free text.
    if client["floating"]!=true{send(format!("dispatch hl.dsp.window.float{{window=\"address:0x{id:x}\",action=\"set\"}}"))?;}
    send(format!("dispatch hl.dsp.window.{verb}{{window=\"address:0x{id:x}\",x={x},y={y},relative=false}}"))?;
    let deadline=std::time::Instant::now()+std::time::Duration::from_millis(1000);
    let mut frame=window_frame(&client)?;
    while std::time::Instant::now()<deadline{
        std::thread::sleep(std::time::Duration::from_millis(25));
        if !process.alive(){return Err(failure("timeout_unknown_outcome","window process exited after geometry delivery; observe before retrying"));}
        frame=window_frame(&endpoint.window(pid,title)?)?;
        if frame[fields[0]].as_i64()==Some(x)&&frame[fields[1]].as_i64()==Some(y){break;}
    }
    Ok(frame)
}
/// Mapped and unmapped compositor clients (`hyprctl clients -j`), at most 1024.
pub fn clients()->Result<Vec<Value>,Value>{
    let clients=Endpoint::open()?.json("j/clients")?;
    clients.as_array().filter(|c|c.len()<=1024).cloned().ok_or_else(||failure("resource_limit","invalid compositor client inventory"))
}
/// Mapped, unhidden compositor windows as (address, pid, title, class, frame).
pub fn visible_windows()->Result<Vec<(u64,u32,String,String,Value)>,Value>{
    Ok(clients()?.iter().filter(|c|c["mapped"]==true&&c["hidden"]!=true).filter_map(|c|Some((address(c).ok()?,c["pid"].as_u64().and_then(|p|u32::try_from(p).ok()).filter(|p|*p>0)?,c["title"].as_str()?.to_owned(),c["class"].as_str().unwrap_or("").to_owned(),window_frame(c).ok()?))).collect())
}
/// A client's window address as the number `windows` reports for it.
pub fn client_address(client:&Value)->Option<u64>{address(client).ok()}
pub fn active_address()->Result<Option<u64>,Value>{Ok(address(&Endpoint::open()?.json("j/activewindow")?).ok())}
