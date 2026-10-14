//! Versioned pointer RPC. The compositor authenticates both connected peers.
//! This client creates no surface and has no activation or global-input path.
use std::{os::{fd::BorrowedFd,unix::net::UnixStream},time::{Duration,Instant}};
use wayland_client::{Connection,Dispatch,EventQueue,QueueHandle,protocol::{wl_registry,wl_callback}};

#[allow(non_camel_case_types,non_upper_case_globals,non_snake_case,unused_imports,dead_code)]
pub mod protocol{
    use wayland_client;
    use wayland_client::protocol::*;
    pub mod __interfaces{
        use wayland_client::backend as wayland_backend;
        use wayland_client::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("hyprland/interceptor-background-pointer-v1.xml");
    }
    use self::__interfaces::*;
    wayland_scanner::generate_client_code!("hyprland/interceptor-background-pointer-v1.xml");
}
use protocol::interceptor_background_pointer_v1::{self as pointer,InterceptorBackgroundPointerV1};

#[derive(Debug,serde::Serialize)]
pub struct Error{pub code:String,pub message:String,pub dispatched:bool}
impl Error{
    fn new(code:&str,message:impl Into<String>,dispatched:bool)->Self{Self{code:code.into(),message:message.into(),dispatched}}
}
#[derive(Debug,serde::Serialize)]
pub struct Reply{pub success:bool,pub code:String,pub delivered:u32,pub focus_unchanged:bool,pub cursor_unchanged:bool}
#[derive(Default)]
struct State{
    pointer:Option<InterceptorBackgroundPointerV1>,global:Option<u32>,synced:bool,
    pending:u32,reply:Option<Reply>,error:Option<Error>,
    menu_guard:bool,
    app_lifecycle:bool,app_activation:bool,max_version:u32,
    version:u32,
}
impl Dispatch<wl_registry::WlRegistry,()> for State{
    fn event(state:&mut Self,registry:&wl_registry::WlRegistry,event:wl_registry::Event,_:&(),_:&Connection,qh:&QueueHandle<Self>){
        match event{
            wl_registry::Event::Global{name,interface,version} if interface=="interceptor_background_pointer_v1"=>{
                if ![1,2,3,4].contains(&version)||state.pointer.is_some(){state.error=Some(Error::new("background_unavailable","pointer requires one qualified version 1 through version 4 integration",false));return;}
                let version=version.min(state.max_version);
                state.pointer=Some(registry.bind(name,version,qh,()));state.global=Some(name);state.version=version;
            },
            wl_registry::Event::GlobalRemove{name} if Some(name)==state.global=>state.error=Some(Error::new("target_gone","pointer integration was revoked",state.pending!=0)),
            _=>(),
        }
    }
}
impl Dispatch<wl_callback::WlCallback,()> for State{
    fn event(state:&mut Self,_:&wl_callback::WlCallback,event:wl_callback::Event,_:&(),_:&Connection,_:&QueueHandle<Self>){if matches!(event,wl_callback::Event::Done{..}){state.synced=true;}}
}
impl Dispatch<InterceptorBackgroundPointerV1,()> for State{
    fn event(state:&mut Self,_:&InterceptorBackgroundPointerV1,event:pointer::Event,_:&(),_:&Connection,_:&QueueHandle<Self>){
        let pointer::Event::Result{id,success,code,delivered,focus_unchanged,cursor_unchanged}=event;
            let allowed=["ok","invalid_request","permission_denied","input_busy","target_gone","unsupported_target","resource_limit","timeout_unknown_outcome","provider_failed","background_unavailable"];
            if id==0||id!=state.pending||state.reply.is_some()||success>1||focus_unchanged>1||cursor_unchanged>1||delivered>256||!allowed.contains(&code.as_str())||
                (success==1&&(code!="ok"||(if state.menu_guard{delivered!=0}else{!state.app_lifecycle&&delivered==0})||(!state.app_activation&&focus_unchanged!=1)||cursor_unchanged!=1))||(success==0&&code=="ok"){
                state.error=Some(Error::new("provider_failed","pointer integration returned an invalid result",state.pending!=0));return;
            }
            state.reply=Some(Reply{success:success==1,code,delivered,focus_unchanged:focus_unchanged==1,cursor_unchanged:cursor_unchanged==1});
    }
}
pub struct PointerConnection{connection:Connection,queue:EventQueue<State>,state:State,sequence:u32,tainted:bool}
impl PointerConnection{
    pub fn protocol_version(&self)->u32{self.state.version}
    pub fn supports_menu_scope(&self)->bool{self.state.version>=2}
    pub fn supports_app_lifecycle(&self)->bool{self.state.version>=3}
    pub fn connect(stream:UnixStream)->Result<Self,Error>{
        Self::connect_version(stream,4)
    }
    fn connect_version(stream:UnixStream,max_version:u32)->Result<Self,Error>{
        let connection=Connection::from_socket(stream).map_err(|e|Error::new("background_unavailable",e.to_string(),false))?;
        let queue=connection.new_event_queue();let state=State{max_version,..State::default()};
        connection.display().get_registry(&queue.handle(),());
        connection.display().sync(&queue.handle(),());
        let mut value=Self{connection,queue,state,sequence:0,tainted:false};
        value.wait(false,|s|s.synced)?;
        if value.state.pointer.is_none(){return Err(Error::new("background_unavailable","qualified background pointer integration is not loaded",false));}
        // The first sync discovers the global. A second sync completes bind
        // authentication before any input request can be sent.
        value.state.synced=false;value.connection.display().sync(&value.queue.handle(),());
        value.wait(false,|s|s.synced)?;Ok(value)
    }
    fn wait(&mut self,dispatched:bool,ready:impl Fn(&State)->bool)->Result<(),Error>{
        let deadline=Instant::now()+Duration::from_millis(if dispatched{2000}else{750});
        while !ready(&self.state){
            if Instant::now()>=deadline{return Err(Error::new(if dispatched{"timeout_unknown_outcome"}else{"background_unavailable"},"pointer integration response deadline",dispatched));}
            let result=crate::wayland_transport::pump(&self.connection,&mut self.queue,&mut self.state,20,|s|s.error.is_none());
            if let Some(error)=self.state.error.take(){return Err(error);}
            if let Err(error)=result{
                let denied=self.connection.protocol_error().is_some_and(|e|e.object_interface=="interceptor_background_pointer_v1"&&e.code==2);
                return Err(Error::new(if denied{"permission_denied"}else if dispatched{"timeout_unknown_outcome"}else{error.code},error.message,dispatched));
            }
        }Ok(())
    }
    pub fn execute(&mut self,command:&str)->Result<Reply,Error>{
        if self.tainted{return Err(Error::new("timeout_unknown_outcome","pointer connection has an unresolved delivery; observe before choosing a new action",false));}
        if command.is_empty()||command.len()>512||!command.is_ascii()||command.bytes().any(|b|b==0||b==b'\n'||b==b'\r'){
            return Err(Error::new("invalid_request","pointer command must be bounded ASCII",false));
        }
        if command.split_ascii_whitespace().next()==Some("menu-guard")&&!self.supports_menu_scope(){return Err(Error::new("background_unavailable","installed pointer integration has no qualified menu scope",false));}
        if command.split_ascii_whitespace().next()==Some("launch-guard")&&self.protocol_version()<4{return Err(Error::new("background_unavailable","background launch requires the qualified version 4 companion; no request was sent",false));}
        self.begin_request()?;
        // Both scopes acknowledge zero input delivery through the existing result.
        self.state.menu_guard=matches!(command.split_ascii_whitespace().next(),Some("menu-guard"|"launch-guard"));
        self.state.pointer.as_ref().unwrap().execute(self.sequence,command.into());
        self.finish_request()
    }
    fn begin_request(&mut self)->Result<(),Error>{
        if self.tainted{return Err(Error::new("timeout_unknown_outcome","pointer connection has an unresolved delivery; observe before choosing a new action",false));}
        self.sequence=self.sequence.checked_add(1).ok_or_else(||Error::new("resource_limit","pointer request ids exhausted",false))?;
        self.state.pending=self.sequence;self.state.reply=None;
        self.state.menu_guard=false;self.state.app_lifecycle=false;self.state.app_activation=false;
        Ok(())
    }
    fn finish_request(&mut self)->Result<Reply,Error>{
        if let Err(error)=self.wait(true,|s|s.reply.is_some()){self.tainted=true;return Err(error);}
        self.state.pending=0;
        Ok(self.state.reply.take().unwrap())
    }
    pub fn execute_app(&mut self,operation:&str,pid:u32,address:u64,process:BorrowedFd<'_>)->Result<Reply,Error>{
        if !self.supports_app_lifecycle(){return Err(Error::new("background_unavailable","app lifecycle requires the qualified version 3 companion; no request was sent",false));}
        let action=match operation{
            "activate"=>pointer::AppOperation::Activate,"hide"=>pointer::AppOperation::Hide,
            "unhide"=>pointer::AppOperation::Unhide,"quit"=>pointer::AppOperation::Quit,
            _=>return Err(Error::new("invalid_request","unsupported app lifecycle operation",false)),
        };
        if pid==0||pid>i32::MAX as u32||address==0{return Err(Error::new("invalid_request","app lifecycle requires a positive target PID and window address",false));}
        self.begin_request()?;
        self.state.app_lifecycle=true;self.state.app_activation=operation=="activate";
        self.state.pointer.as_ref().unwrap().app(self.sequence,action,pid,(address>>32)as u32,address as u32,process);
        self.finish_request()
    }
}
impl Drop for PointerConnection{fn drop(&mut self){if let Some(pointer)=self.state.pointer.take(){pointer.destroy();let _=self.connection.flush();}}}

#[cfg(test)]mod qualification{
    #[test]
    #[ignore="requires the qualified authenticated version 4 compositor"]
    fn launch_guards_are_bounded_owned_and_versioned(){
        let display=std::env::var("INTERCEPTOR_POINTER_TEST_DISPLAY").unwrap();
        let connect=||PointerConnection::connect(UnixStream::connect(&display).unwrap()).unwrap();
        let mut first=connect();assert_eq!(first.protocol_version(),4);
        for command in ["launch-guard","launch-guard ","launch-guard abc","launch-guard ../../other",&format!("launch-guard {}","F".repeat(64)),&format!("launch-guard {} extra","a".repeat(64))]{
            let reply=first.execute(command).unwrap();assert!(!reply.success);assert_eq!(reply.code,"invalid_request");assert_eq!(reply.delivered,0);
        }
        let command=format!("launch-guard {}","a".repeat(64));
        for version in [1,2,3]{
            let mut old=PointerConnection::connect_version(UnixStream::connect(&display).unwrap(),version).unwrap();
            let refused=old.execute(&command).unwrap_err();assert_eq!(refused.code,"background_unavailable");assert!(!refused.dispatched);assert_eq!(old.sequence,0);
        }
        let reply=first.execute(&command).unwrap();assert!(reply.success);assert_eq!(reply.delivered,0);
        assert_eq!(first.execute(&command).unwrap().code,"input_busy");
        let mut second=connect();assert_eq!(second.execute(&command).unwrap().code,"invalid_request");
        drop(first);assert!(second.execute(&command).unwrap().success,"disconnect releases token ownership");
        std::thread::sleep(Duration::from_millis(10600));
        assert!(second.execute(&command).unwrap().success,"expired guard can be replaced without replaying a launch");
    }
    #[test]
    #[ignore="requires owned native Wayland app windows in the authenticated graphical login"]
    fn app_requests_reject_unbound_handles_and_wire_replays(){
        use std::os::fd::{AsFd,FromRawFd,OwnedFd};
        let display=std::env::var("INTERCEPTOR_POINTER_TEST_DISPLAY").unwrap();
        let pid: u32=std::env::var("INTERCEPTOR_APP_TEST_PID").unwrap().parse().unwrap();
        let address: u64=u64::from_str_radix(std::env::var("INTERCEPTOR_APP_TEST_ADDRESS").unwrap().trim_start_matches("0x"),16).unwrap();
        let connect=||PointerConnection::connect(UnixStream::connect(&display).unwrap()).unwrap();
        let own_raw=unsafe{libc::syscall(libc::SYS_pidfd_open,std::process::id(),0_u32)};
        assert!(own_raw>=0);let own=unsafe{OwnedFd::from_raw_fd(own_raw as i32)};
        let mut client=connect();assert!(client.supports_app_lifecycle());
        let invalid=std::fs::File::open("/dev/null").unwrap();
        for fd in [own.as_fd(),invalid.as_fd()]{
            for _ in 0..32{
                let reply=client.execute_app("hide",pid,address,fd).unwrap();
                assert!(!reply.success);assert_eq!(reply.code,"permission_denied");assert_eq!(reply.delivered,0);
            }
        }
        let mut child=std::process::Command::new("/usr/bin/sleep").arg("10").spawn().unwrap();
        let dead_raw=unsafe{libc::syscall(libc::SYS_pidfd_open,child.id(),0_u32)};
        assert!(dead_raw>=0);let dead=unsafe{OwnedFd::from_raw_fd(dead_raw as i32)};
        child.kill().unwrap();child.wait().unwrap();
        let reply=client.execute_app("hide",pid,address,dead.as_fd()).unwrap();
        assert!(!reply.success);assert_eq!(reply.code,"permission_denied");assert_eq!(reply.delivered,0);
        let target_raw=unsafe{libc::syscall(libc::SYS_pidfd_open,pid,0_u32)};
        assert!(target_raw>=0);let target=unsafe{OwnedFd::from_raw_fd(target_raw as i32)};
        let reply=client.execute_app("unhide",pid,address,target.as_fd()).unwrap();assert!(reply.success);
        // Replay a different, mutating operation with the consumed id. The
        // protocol must disconnect this object before hiding any window.
        client.state.pending=client.sequence;client.state.app_lifecycle=true;
        client.state.pointer.as_ref().unwrap().app(client.sequence,pointer::AppOperation::Hide,pid,(address>>32)as u32,address as u32,target.as_fd());
        assert!(client.wait(true,|state|state.reply.is_some()).is_err());
        let error=client.connection.protocol_error().unwrap();
        assert_eq!(error.object_interface,"interceptor_background_pointer_v1");assert_eq!(error.code,1);
        println!("65 unbound/dead handle requests refused without delivery; duplicate app request rejected: pid={pid} address={address}");
    }
    #[test]
    #[ignore="requires an owned authenticated compositor and target"]
    fn prior_protocol_versions_remain_usable(){
        let display=std::env::var("INTERCEPTOR_POINTER_TEST_DISPLAY").unwrap();
        let action=std::env::var("INTERCEPTOR_POINTER_TEST_ACTION").unwrap();
        for version in [1,2]{
            let mut client=PointerConnection::connect_version(UnixStream::connect(&display).unwrap(),version).unwrap();
            assert_eq!(client.protocol_version(),version);
            assert!(!client.supports_app_lifecycle());
            assert!(client.execute(&action).unwrap().success);
            let process=std::fs::File::open("/dev/null").unwrap();
            use std::os::fd::AsFd;
            let refused=client.execute_app("hide",std::process::id(),1,process.as_fd()).unwrap_err();
            assert_eq!(refused.code,"background_unavailable");assert!(!refused.dispatched);
        }
    }
    #[test]
    #[ignore="requires an owned authenticated compositor and target"]
    fn menu_scope_expires_and_releases_its_owner(){
        let display=std::env::var("INTERCEPTOR_POINTER_TEST_DISPLAY").unwrap();
        let action=std::env::var("INTERCEPTOR_POINTER_TEST_ACTION").unwrap();
        let parts=action.split_ascii_whitespace().collect::<Vec<_>>();assert_eq!(parts.len(),7);
        let command=format!("menu-guard {} {} 0 0 0 0",parts[1],parts[2]);
        let connect=||PointerConnection::connect(UnixStream::connect(&display).unwrap()).unwrap();
        let mut first=connect();let mut second=connect();
        let reply=first.execute(&command).unwrap();assert!(reply.success);assert_eq!(reply.delivered,0);
        let busy=second.execute(&command).unwrap();assert!(!busy.success);assert_eq!(busy.code,"input_busy");assert_eq!(busy.delivered,0);
        drop(first);
        assert!(second.execute(&command).unwrap().success,"resource destruction releases its guard");
        let mut third=connect();assert_eq!(third.execute(&command).unwrap().code,"input_busy");
        std::thread::sleep(Duration::from_millis(850));
        assert!(third.execute(&command).unwrap().success,"expired guard cannot block another authenticated owner");
        let malformed=format!("menu-guard {} {} 1 0 0 0",parts[1],parts[2]);
        let refused=third.execute(&malformed).unwrap();assert!(!refused.success);assert_eq!(refused.code,"invalid_request");assert_eq!(refused.delivered,0);
    }
    use super::*;
    // Requires the owned live compositor fixture, not an emulated server.
    #[test]
    #[ignore="owned Hyprland protocol fixture supplies the display and action"]
    fn duplicate_request_is_refused_by_the_compositor(){
        let display=std::env::var("INTERCEPTOR_POINTER_TEST_DISPLAY").expect("owned display");
        let action=std::env::var("INTERCEPTOR_POINTER_TEST_ACTION").expect("owned effect oracle");
        let stream=UnixStream::connect(display).unwrap();
        let mut client=PointerConnection::connect(stream).unwrap();
        let reply=client.execute(&action).unwrap();assert!(reply.success);
        // Deliberately bypass the public monotonic-id API. The compositor
        // must reject this wire replay before it can execute the click again.
        client.state.pending=client.sequence;
        client.state.pointer.as_ref().unwrap().execute(client.sequence,action);
        let result=client.wait(true,|state|state.reply.is_some());
        assert!(result.is_err());
        let error=client.connection.protocol_error().expect("typed native protocol error");
        assert_eq!(error.object_interface,"interceptor_background_pointer_v1");assert_eq!(error.code,1);
        println!("native duplicate rejected: pid={} code={} interface={}",std::process::id(),error.code,error.object_interface);
    }
    #[test]
    #[ignore="owned Hyprland protocol fixture supplies the display"]
    fn oversized_wire_command_is_refused_before_input(){
        let display=std::env::var("INTERCEPTOR_POINTER_TEST_DISPLAY").unwrap();
        let mut client=PointerConnection::connect(UnixStream::connect(display).unwrap()).unwrap();
        client.state.pending=1;
        client.state.pointer.as_ref().unwrap().execute(1,"click ".to_owned()+&"0".repeat(513));
        client.wait(true,|state|state.reply.is_some()).unwrap();
        let reply=client.state.reply.take().unwrap();
        assert!(!reply.success);assert_eq!(reply.code,"invalid_request");assert_eq!(reply.delivered,0);
    }
    #[test]
    #[ignore="owned Hyprland protocol fixture supplies the display"]
    fn compositor_bounds_live_protocol_objects(){
        let display=std::env::var("INTERCEPTOR_POINTER_TEST_DISPLAY").unwrap();
        let mut client=PointerConnection::connect(UnixStream::connect(display).unwrap()).unwrap();
        let registry=client.connection.display().get_registry(&client.queue.handle(),());
        let mut objects=Vec::new();
        for _ in 0..64{objects.push(registry.bind::<InterceptorBackgroundPointerV1,_,_>(client.state.global.unwrap(),1,&client.queue.handle(),()));}
        let deadline=Instant::now()+Duration::from_secs(2);
        loop{
            assert!(Instant::now()<deadline,"bounded native resource-limit response");
            if crate::wayland_transport::pump(&client.connection,&mut client.queue,&mut client.state,20,|_|true).is_err(){break;}
        }
        let error=client.connection.protocol_error().expect("typed native resource-limit error");
        assert_eq!(error.object_interface,"interceptor_background_pointer_v1");assert_eq!(error.code,3);
    }
    #[test]
    #[ignore="owned controller creates and removes only its extra PAM login"]
    fn integration_revokes_after_login_ambiguity(){
        let display=std::env::var("INTERCEPTOR_POINTER_TEST_DISPLAY").unwrap();
        let root=std::path::PathBuf::from(std::env::var("INTERCEPTOR_POINTER_TEST_CONTROL").unwrap());
        let mut client=PointerConnection::connect(UnixStream::connect(&display).unwrap()).unwrap();
        std::fs::write(root.join("lifetime-ready.json"),serde_json::json!({"display":display,"pid":std::process::id(),"uid":unsafe{libc::geteuid()},"connected":true}).to_string()).unwrap();
        let deadline=Instant::now()+Duration::from_secs(65);
        let revoked=loop{
            assert!(Instant::now()<deadline,"owned login ambiguity must revoke the retained protocol");
            match client.execute("unsupported 0 0 0 0 0 0"){
                Ok(reply)=>assert!(!reply.success&&["invalid_request","permission_denied"].contains(&reply.code.as_str()),"{reply:?}"),
                Err(error)=>{assert!(["target_gone","timeout_unknown_outcome","permission_denied"].contains(&error.code.as_str()),"{error:?}");break error;}
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        std::fs::write(root.join("lifetime-revoked.json"),serde_json::to_string(&revoked).unwrap()).unwrap();
        let restored=Instant::now()+Duration::from_secs(45);
        while !root.join("lifetime-resumed.json").exists(){assert!(Instant::now()<restored,"owned controller must restore original login state");std::thread::sleep(Duration::from_millis(100));}
        match PointerConnection::connect(UnixStream::connect(&display).unwrap()){
            Ok(_)=>panic!("revoked integration reassociated after ambiguity disappeared"),
            Err(error)=>{assert_eq!(error.code,"background_unavailable");assert!(!error.dispatched);std::fs::write(root.join("lifetime-still-revoked.json"),serde_json::to_string(&error).unwrap()).unwrap();}
        }
    }
}
