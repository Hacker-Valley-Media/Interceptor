//! Native owned-session-bus API probe, not installed-provider qualification.
#[cfg(target_os="linux")]fn main(){
    use std::{ffi::{c_char,c_int,c_void,CStr,CString},ptr,time::{Duration,Instant}};
    use serde_json::{Value,json};
    #[link(name="systemd")]unsafe extern "C"{
        fn sd_bus_open_user(out:*mut *mut c_void)->c_int;
        fn sd_bus_unref(bus:*mut c_void)->*mut c_void;
        fn sd_bus_message_unref(message:*mut c_void)->*mut c_void;
        fn sd_bus_slot_unref(slot:*mut c_void)->*mut c_void;
        fn sd_bus_set_method_call_timeout(bus:*mut c_void,usec:u64)->c_int;
        fn sd_bus_call_method(bus:*mut c_void,destination:*const c_char,path:*const c_char,interface:*const c_char,member:*const c_char,error:*mut c_void,reply:*mut *mut c_void,types:*const c_char,...)->c_int;
        fn sd_bus_message_read(message:*mut c_void,types:*const c_char,...)->c_int;
        fn sd_bus_add_match(bus:*mut c_void,slot:*mut *mut c_void,rule:*const c_char,callback:unsafe extern "C" fn(*mut c_void,*mut c_void,*mut c_void)->c_int,userdata:*mut c_void)->c_int;
        fn sd_bus_process(bus:*mut c_void,out:*mut *mut c_void)->c_int;
        fn sd_bus_wait(bus:*mut c_void,timeout_usec:u64)->c_int;
    }
    struct Bus(*mut c_void);impl Drop for Bus{fn drop(&mut self){unsafe{sd_bus_unref(self.0);}}}
    struct Message(*mut c_void);impl Drop for Message{fn drop(&mut self){unsafe{sd_bus_message_unref(self.0);}}}
    struct Slot(*mut c_void);impl Drop for Slot{fn drop(&mut self){unsafe{sd_bus_slot_unref(self.0);}}}
    fn check(r:c_int)->Result<(),String>{if r<0{Err(std::io::Error::from_raw_os_error(-r).to_string())}else{Ok(())}}
    #[derive(Default)]struct SignalState{id:u32,rows:Vec<Value>}
    unsafe extern "C" fn closed(message:*mut c_void,userdata:*mut c_void,_error:*mut c_void)->c_int{
        let(mut id,mut reason)=(0u32,0u32);if unsafe{sd_bus_message_read(message,c"uu".as_ptr(),&mut id,&mut reason)}<0{return 0;}
        let state=unsafe{&mut *userdata.cast::<SignalState>()};if state.id==id&&state.rows.len()<16{state.rows.push(json!({"nativeID":id,"reason":reason,"event":"NotificationClosed"}));}1
    }
    let output=std::env::args().nth(1).expect("result path");let mut rows=Vec::new();let mut active=0;let mut owner=CString::new("").unwrap();let mut bus=None;let mut state=SignalState::default();
    let result=(||->Result<(),String>{unsafe{
        let mut raw=ptr::null_mut();check(sd_bus_open_user(&mut raw))?;let current=Bus(raw);check(sd_bus_set_method_call_timeout(current.0,3_000_000))?;bus=Some(current);let b=bus.as_ref().unwrap().0;
        let mut reply=ptr::null_mut();check(sd_bus_call_method(b,c"org.freedesktop.DBus".as_ptr(),c"/org/freedesktop/DBus".as_ptr(),c"org.freedesktop.DBus".as_ptr(),c"GetNameOwner".as_ptr(),ptr::null_mut(),&mut reply,c"s".as_ptr(),c"org.freedesktop.Notifications".as_ptr()))?;
        let message=Message(reply);let mut text=ptr::null::<c_char>();check(sd_bus_message_read(message.0,c"s".as_ptr(),&mut text))?;if text.is_null(){return Err("missing bus owner".into())}owner=CStr::from_ptr(text).to_owned();
        let mut reply=ptr::null_mut();check(sd_bus_call_method(b,c"org.freedesktop.DBus".as_ptr(),c"/org/freedesktop/DBus".as_ptr(),c"org.freedesktop.DBus".as_ptr(),c"GetConnectionUnixProcessID".as_ptr(),ptr::null_mut(),&mut reply,c"s".as_ptr(),owner.as_ptr()))?;
        let message=Message(reply);let mut pid=0u32;check(sd_bus_message_read(message.0,c"u".as_ptr(),&mut pid))?;rows.push(json!({"step":"native server generation","owner":owner.to_str().map_err(|e|e.to_string())?,"pid":pid}));
        let rule=CString::new(format!("type='signal',sender='{}',path='/org/freedesktop/Notifications',interface='org.freedesktop.Notifications',member='NotificationClosed'",owner.to_str().unwrap())).unwrap();
        let mut slot=ptr::null_mut();check(sd_bus_add_match(b,&mut slot,rule.as_ptr(),closed,(&mut state as *mut SignalState).cast()))?;let _slot=Slot(slot);
        let mut reply=ptr::null_mut();check(sd_bus_call_method(b,owner.as_ptr(),c"/org/freedesktop/Notifications".as_ptr(),c"org.freedesktop.Notifications".as_ptr(),c"Notify".as_ptr(),ptr::null_mut(),&mut reply,c"susssasa{sv}i".as_ptr(),c"Interceptor owned API probe".as_ptr(),0u32,c"".as_ptr(),c"Owned native Linux notification".as_ptr(),c"Session bus API qualification only".as_ptr(),0u32,0u32,0i32))?;
        let message=Message(reply);check(sd_bus_message_read(message.0,c"u".as_ptr(),&mut active))?;if active==0{return Err("server returned notification id zero".into())}state.id=active;rows.push(json!({"step":"native Notify accepted","nativeID":active}));
        std::thread::sleep(Duration::from_millis(500));
        let mut reply=ptr::null_mut();check(sd_bus_call_method(b,owner.as_ptr(),c"/org/freedesktop/Notifications".as_ptr(),c"org.freedesktop.Notifications".as_ptr(),c"CloseNotification".as_ptr(),ptr::null_mut(),&mut reply,c"u".as_ptr(),active))?;let _message=Message(reply);
        let deadline=Instant::now()+Duration::from_secs(3);while Instant::now()<deadline&&state.rows.is_empty(){let r=sd_bus_process(b,ptr::null_mut());check(r)?;if r==0{check(sd_bus_wait(b,100000))?;}}
        rows.push(json!({"step":"owned native closure signal","events":state.rows}));if !state.rows.iter().any(|e|e["reason"]==3){return Err("owned CloseNotification signal missing".into())}active=0;Ok(())
    }})();
    let cleanup=if active!=0{if let Some(b)=bus.as_ref(){let mut reply=ptr::null_mut();let r=unsafe{sd_bus_call_method(b.0,owner.as_ptr(),c"/org/freedesktop/Notifications".as_ptr(),c"org.freedesktop.Notifications".as_ptr(),c"CloseNotification".as_ptr(),ptr::null_mut(),&mut reply,c"u".as_ptr(),active)};let _message=Message(reply);r>=0}else{false}}else{true};
    let pass=result.is_ok()&&cleanup;let evidence=json!({"pass":pass,"error":result.err(),"pid":std::process::id(),"cleanup":cleanup,"rows":rows,"scope":"Native owned session-bus prototype only; SSH invocation does not establish installed graphical-provider authorization"});
    std::fs::write(output,serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();if !pass{std::process::exit(1)}
}
#[cfg(not(target_os="linux"))]fn main(){eprintln!("requires Linux");std::process::exit(1)}
