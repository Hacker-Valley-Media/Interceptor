//! Read-only output identity and logical geometry from the retained compositor.
//! IDs include its authenticated socket/process lifetime, not a client proxy.
use crate::{failure, linux::CaptureIdentity};
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use std::{collections::BTreeMap,os::unix::fs::MetadataExt,path::PathBuf,time::{Duration,Instant}};
use wayland_client::{Connection,Dispatch,EventQueue,QueueHandle,Proxy,WEnum,protocol::{wl_registry,wl_output,wl_callback}};
use wayland_protocols::xdg::xdg_output::zv1::client::{zxdg_output_manager_v1 as manager,zxdg_output_v1 as logical};

#[derive(Default)]struct Output {
    proxy:Option<wl_output::WlOutput>, logical:Option<logical::ZxdgOutputV1>,
    name:Option<String>,make:Option<String>,model:Option<String>,description:Option<String>,
    position:Option<(i32,i32)>,size:Option<(i32,i32)>,mode:Option<(i32,i32,i32)>,scale:i32,rotation:Option<u32>,complete:bool,
}
#[derive(Default)]struct State {
    outputs:BTreeMap<u32,Output>,manager:Option<manager::ZxdgOutputManagerV1>,manager_name:Option<u32>,synced:bool,error:Option<Value>,
}
impl Dispatch<wl_registry::WlRegistry,()> for State {
    fn event(state:&mut Self,registry:&wl_registry::WlRegistry,event:wl_registry::Event,_:&(),_:&Connection,qh:&QueueHandle<Self>) {
        match event {
            wl_registry::Event::Global{name,interface,version} if interface=="wl_output"=>{
                if state.outputs.len()>=32||version<2 {state.error=Some(failure("unsupported_operation","output inventory requires at most 32 wl_output version 2+ globals"));return;}
                let proxy=registry.bind(name,version.min(4),qh,name);
                let output=state.outputs.entry(name).or_default();output.proxy=Some(proxy);output.scale=1;
            }
            wl_registry::Event::Global{name,interface,version} if interface=="zxdg_output_manager_v1"=>{
                if version<2||state.manager.is_some(){state.error=Some(failure("unsupported_operation","logical output inventory requires one xdg-output manager version 2+"));return;}
                state.manager=Some(registry.bind(name,version.min(3),qh,()));state.manager_name=Some(name);
            }
            wl_registry::Event::GlobalRemove{name}=>{
                if state.manager_name==Some(name){state.error=Some(failure("target_gone","logical output manager was removed"));}
                if let Some(output)=state.outputs.remove(&name){if let Some(logical)=output.logical{logical.destroy();}if let Some(proxy)=output.proxy{if proxy.version()>=3{proxy.release();}}}
            }
            _=>()
        }
    }
}
impl Dispatch<wl_callback::WlCallback,()> for State {
    fn event(state:&mut Self,_:&wl_callback::WlCallback,event:wl_callback::Event,_:&(),_:&Connection,_:&QueueHandle<Self>){if matches!(event,wl_callback::Event::Done{..}){state.synced=true;}}
}
impl Dispatch<manager::ZxdgOutputManagerV1,()> for State {
    fn event(_:&mut Self,_:&manager::ZxdgOutputManagerV1,_:manager::Event,_:&(),_:&Connection,_:&QueueHandle<Self>){}
}
impl Dispatch<wl_output::WlOutput,u32> for State {
    fn event(state:&mut Self,_:&wl_output::WlOutput,event:wl_output::Event,name:&u32,_:&Connection,_:&QueueHandle<Self>){
        let Some(output)=state.outputs.get_mut(name)else{return;};
        match event {
            wl_output::Event::Geometry{make,model,transform,..}=>{output.make=Some(make);output.model=Some(model);output.rotation=match transform{WEnum::Value(value)=>Some(value as u32),_=>None};output.complete=false;}
            wl_output::Event::Mode{flags,width,height,refresh}=>{if matches!(flags,WEnum::Value(flags)if flags.contains(wl_output::Mode::Current)){output.mode=Some((width,height,refresh));output.complete=false;}}
            wl_output::Event::Scale{factor}=>{output.scale=factor;output.complete=false;}
            wl_output::Event::Name{name}=>{output.name=Some(name);output.complete=false;}
            wl_output::Event::Description{description}=>{output.description=Some(description);output.complete=false;}
            wl_output::Event::Done=>output.complete=true,
            _=>()
        }
    }
}
impl Dispatch<logical::ZxdgOutputV1,u32> for State {
    fn event(state:&mut Self,_:&logical::ZxdgOutputV1,event:logical::Event,name:&u32,_:&Connection,_:&QueueHandle<Self>){
        let Some(output)=state.outputs.get_mut(name)else{return;};
        match event {
            logical::Event::LogicalPosition{x,y}=>{output.position=Some((x,y));output.complete=false;}
            logical::Event::LogicalSize{width,height}=>{output.size=Some((width,height));output.complete=false;}
            logical::Event::Name{name}=>{if output.name.is_none(){output.name=Some(name);}output.complete=false;}
            logical::Event::Description{description}=>{if output.description.is_none(){output.description=Some(description);}output.complete=false;}
            logical::Event::Done=>output.complete=true,
            _=>()
        }
    }
}
pub(crate) struct Registry {
    connection:Connection,queue:EventQueue<State>,state:State,owner:CaptureIdentity,
    login:crate::linux_peer::SessionIdentity,scope:String,peer_pid:libc::pid_t,
}
impl Registry {
    pub(crate) fn open()->Result<Self,Value>{
        use wayland_client::Proxy;
        let (login,path)=endpoint_path()?;
        let before=std::fs::symlink_metadata(&path).map_err(|e|failure("target_gone",e))?;
        let(stream,pid)=crate::linux_hyprland::connect(&path)?;
        let owner=crate::linux::capture_identity(pid as u32)?;
        let stat=std::fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|_|failure("target_gone","compositor creation identity is unavailable"))?;
        let creation=stat.rsplit_once(") ").and_then(|(_,s)|s.split_whitespace().nth(19)).filter(|s|!s.is_empty()&&s.bytes().all(|b|b.is_ascii_digit())).ok_or_else(||failure("provider_failed","compositor creation identity is invalid"))?;
        let after=std::fs::symlink_metadata(&path).map_err(|e|failure("target_gone",e))?;
        if !owner.alive()||before.dev()!=after.dev()||before.ino()!=after.ino(){return Err(failure("stale_reference","Wayland endpoint changed during authentication"));}
        let scope=Sha256::digest(format!("{}:{}:{}:{}:{}:{}:{}",unsafe{libc::geteuid()},login.id,login.start_usec,pid,creation,before.dev(),before.ino()).as_bytes()).iter().map(|byte|format!("{byte:02x}")).collect::<String>();
        let connection=Connection::from_socket(stream).map_err(|e|failure("provider_failed",e))?;
        let queue=connection.new_event_queue::<State>();let mut registry=Self{connection,queue,state:State::default(),owner,login,scope,peer_pid:pid};
        registry.connection.display().get_registry(&registry.queue.handle(),());registry.synchronize()?;
        if registry.state.manager.is_none(){return Err(failure("unsupported_operation","compositor does not expose xdg-output logical geometry"));}
        registry.synchronize()?;registry.records()?;Ok(registry)
    }
    pub(crate) fn pump(&mut self)->Result<(),Value>{
        if !self.owner.alive()||crate::linux::login_identity(0).as_ref()!=Some(&self.login){return Err(failure("target_gone","retained compositor or graphical login ended"));}
        let result=interceptor_desktop::wayland_transport::pump(&self.connection,&mut self.queue,&mut self.state,0,|s|s.error.is_none());
        if let Some(error)=&self.state.error{return Err(error.clone());}result.map_err(|e|failure(e.code,e.message))?;
        if let Some(manager)=&self.state.manager {
            for(name,output)in &mut self.state.outputs {if output.logical.is_none(){output.complete=false;output.logical=Some(manager.get_xdg_output(output.proxy.as_ref().unwrap(),&self.queue.handle(),*name));}}
        }Ok(())
    }
    pub(crate) fn verify_native_fd(&self,fd:libc::c_int)->Result<(),Value>{
        let mut cred:libc::ucred=unsafe{std::mem::zeroed()};let mut size=std::mem::size_of::<libc::ucred>()as libc::socklen_t;
        if fd<0||unsafe{libc::getsockopt(fd,libc::SOL_SOCKET,libc::SO_PEERCRED,(&mut cred as *mut libc::ucred).cast(),&mut size)}!=0||size as usize!=std::mem::size_of::<libc::ucred>()||cred.pid!=self.peer_pid||cred.uid!=unsafe{libc::geteuid()}||!self.owner.alive(){return Err(failure("permission_denied","native GTK connection does not belong to the retained authenticated compositor"));}Ok(())
    }
    fn synchronize(&mut self)->Result<(),Value>{
        self.state.synced=false;self.connection.display().sync(&self.queue.handle(),());let deadline=Instant::now()+Duration::from_secs(2);
        while !self.state.synced {
            if Instant::now()>=deadline{return Err(failure("provider_failed","native output synchronization exceeded 2s"));}
            self.pump()?;
            if !self.state.synced{std::thread::sleep(Duration::from_millis(2));}
        }Ok(())
    }
    pub(crate) fn records(&self)->Result<Vec<Value>,Value>{
        let mut rows=Vec::new();let mut ids=std::collections::HashSet::new();let mut names=std::collections::HashSet::new();
        for(global,output)in &self.state.outputs {
            if !output.complete{continue;}
            let name=output.name.as_deref().filter(|s|!s.is_empty()&&s.len()<=256&&!s.contains('\0')).ok_or_else(||failure("unsupported_operation","output has no native connector name"))?;
            let(x,y)=output.position.ok_or_else(||failure("provider_failed","output has no logical position"))?;
            let(width,height)=output.size.filter(|(w,h)|*w>0&&*h>0&&*w<=32768&&*h<=32768).ok_or_else(||failure("provider_failed","output logical dimensions are invalid"))?;
            let(pixel_width,pixel_height,refresh)=output.mode.filter(|(w,h,_)|*w>0&&*h>0&&*w<=65536&&*h<=65536).ok_or_else(||failure("provider_failed","output current pixel mode is absent"))?;
            if output.scale<=0||output.scale>16||i64::from(x).abs()>131072||i64::from(y).abs()>131072||[output.make.as_ref(),output.model.as_ref(),output.description.as_ref()].iter().flatten().any(|s|s.len()>4096||s.contains('\0')){return Err(failure("resource_limit","native output metadata exceeds its bounds"));}
            let digest=Sha256::digest(format!("{}:{global}:{name}",self.scope).as_bytes());let id=u64::from_be_bytes(digest[..8].try_into().unwrap())&9007199254740991;
            if id==0||!ids.insert(id)||!names.insert(name){return Err(failure("target_ambiguous","output identities collide; no numeric target is admitted"));}
            let mut row=json!({"id":id,"registryName":global,"scope":self.scope,"name":name,"make":output.make,"model":output.model,"description":output.description,"x":x,"y":y,"width":width,"height":height,"pixelWidth":pixel_width,"pixelHeight":pixel_height,"scale":output.scale,"unknownFields":["isMain","isBuiltin","isVirtual"]});
            if refresh>0{row["refreshRate"]=json!(refresh as f64/1000.0);}else{row["unknownFields"].as_array_mut().unwrap().push(json!("refreshRate"));}
            if let Some(transform)=output.rotation.filter(|n|*n<8){row["rotation"]=json!((transform&3)*90);row["reflected"]=json!(transform>=4);}else{row["unknownFields"].as_array_mut().unwrap().push(json!("rotation"));}
            rows.push(row);
        }
        if rows.is_empty(){return Err(failure("target_gone","compositor has no completed native outputs"));}Ok(rows)
    }
}
pub(crate) fn read(id:Option<u64>)->Result<Value,Value>{
    let registry=Registry::open()?;let rows=registry.records()?;let mut projected=Vec::new();
    for row in rows {
        if id.is_some_and(|id|row["id"].as_u64()!=Some(id)){continue;}
        let mut data=json!({"id":row["id"],"width":row["width"],"height":row["height"],"unknownFields":row["unknownFields"]});
        let fields=if id.is_some(){vec!["pixelWidth","pixelHeight","refreshRate","rotation"]}else{vec!["x","y"]};
        for key in fields{if let Some(value)=row.get(key){data[key]=value.clone();}}projected.push(data);
    }
    if id.is_some(){projected.into_iter().next().ok_or_else(||failure("target_gone","display ID belongs to an unavailable compositor/output lifetime"))}else{Ok(json!(projected))}
}
/// The current graphical login and its Wayland socket path (private parent directory checked).
pub(crate) fn endpoint_path()->Result<(crate::linux_peer::SessionIdentity,PathBuf),Value>{
    let login=crate::linux::login_identity(0).ok_or_else(||failure("no_interactive_session","output discovery requires a current graphical login"))?;
    if !crate::linux_peer::graphical(&login){return Err(failure("no_interactive_session","output discovery requires a graphical login"));}
    let configured=std::env::var("WAYLAND_DISPLAY").map_err(|_|failure("no_interactive_session","Wayland display is not configured"))?;
    if configured.is_empty()||configured.len()>1024||configured.contains('\0'){return Err(failure("invalid_request","invalid Wayland endpoint"));}
    let configured=PathBuf::from(configured);
    let path=if configured.is_absolute(){configured}else{
        if configured.components().count()!=1{return Err(failure("invalid_request","relative Wayland endpoint must be one socket name"));}
        PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").ok_or_else(||failure("no_interactive_session","Wayland runtime directory is absent"))?).join(configured)
    };
    crate::linux_hyprland::private_directory(path.parent().ok_or_else(||failure("invalid_request","Wayland socket has no private parent"))?)?;
    Ok((login,path))
}
/// An authenticated connection to the current login's compositor (same checks as Registry::open).
pub(crate) fn compositor_socket()->Result<(std::os::unix::net::UnixStream,libc::pid_t,CaptureIdentity),Value>{
    let (_,path)=endpoint_path()?;
    let (stream,pid)=crate::linux_hyprland::connect(&path)?;
    let owner=crate::linux::capture_identity(pid as u32)?;
    if !owner.alive(){return Err(failure("target_gone","compositor exited during authentication"));}
    Ok((stream,pid,owner))
}
