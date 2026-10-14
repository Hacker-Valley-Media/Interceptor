#[cfg(target_os = "linux")]
fn main() -> std::io::Result<()> {
    use std::{io::{self, Read, Write}, os::{fd::{AsRawFd, OwnedFd}, unix::{net::{UnixStream, UnixListener}, fs::DirBuilderExt}}, process::{Command, Stdio}};
    if std::env::args().nth(1).as_deref() == Some("--session-info") {
        use std::os::fd::FromRawFd;
        #[link(name="systemd")]
        unsafe extern "C" {
            fn sd_pidfd_get_session(fd:libc::c_int,out:*mut *mut libc::c_char)->libc::c_int;
            fn sd_pidfd_get_owner_uid(fd:libc::c_int,out:*mut libc::uid_t)->libc::c_int;
            fn sd_pidfd_get_user_unit(fd:libc::c_int,out:*mut *mut libc::c_char)->libc::c_int;
            fn sd_uid_get_display(uid:libc::uid_t,out:*mut *mut libc::c_char)->libc::c_int;
            fn sd_uid_get_sessions(uid:libc::uid_t,active:libc::c_int,out:*mut *mut *mut libc::c_char)->libc::c_int;
            fn sd_session_get_uid(id:*const libc::c_char,out:*mut libc::uid_t)->libc::c_int;
            fn sd_session_get_start_time(id:*const libc::c_char,out:*mut u64)->libc::c_int;
            fn sd_session_get_type(id:*const libc::c_char,out:*mut *mut libc::c_char)->libc::c_int;
            fn sd_session_get_class(id:*const libc::c_char,out:*mut *mut libc::c_char)->libc::c_int;
            fn sd_session_get_state(id:*const libc::c_char,out:*mut *mut libc::c_char)->libc::c_int;
        }
        let raw_fd=unsafe{libc::syscall(libc::SYS_pidfd_open,std::process::id() as libc::pid_t,0_u32)};
        if raw_fd<0{return Err(io::Error::last_os_error());}
        let fd=unsafe{OwnedFd::from_raw_fd(raw_fd as libc::c_int)};
        let take=|raw:*mut libc::c_char|->Option<String>{if raw.is_null(){None}else{let value=unsafe{std::ffi::CStr::from_ptr(raw).to_str().ok().map(str::to_owned)};unsafe{libc::free(raw.cast())};value}};
        let mut raw=std::ptr::null_mut();let session_status=unsafe{sd_pidfd_get_session(fd.as_raw_fd(),&mut raw)};let kernel_session=take(raw);
        let mut owner=libc::uid_t::MAX;let owner_status=unsafe{sd_pidfd_get_owner_uid(fd.as_raw_fd(),&mut owner)};
        raw=std::ptr::null_mut();let unit_status=unsafe{sd_pidfd_get_user_unit(fd.as_raw_fd(),&mut raw)};let user_unit=take(raw);
        raw=std::ptr::null_mut();let display_status=unsafe{sd_uid_get_display(unsafe{libc::geteuid()},&mut raw)};let display=take(raw);
        let mut list=std::ptr::null_mut();let list_status=unsafe{sd_uid_get_sessions(unsafe{libc::geteuid()},0,&mut list)};
        let mut sessions=Vec::new();
        if !list.is_null(){let mut index=0;while !unsafe{*list.add(index)}.is_null(){
            let id=unsafe{*list.add(index)};let mut uid=libc::uid_t::MAX;let uid_status=unsafe{sd_session_get_uid(id,&mut uid)};
            let mut start=0;let start_status=unsafe{sd_session_get_start_time(id,&mut start)};
            raw=std::ptr::null_mut();let type_status=unsafe{sd_session_get_type(id,&mut raw)};let kind=take(raw);
            raw=std::ptr::null_mut();let class_status=unsafe{sd_session_get_class(id,&mut raw)};let class=take(raw);
            raw=std::ptr::null_mut();let state_status=unsafe{sd_session_get_state(id,&mut raw)};let state=take(raw);
            sessions.push(serde_json::json!({"id":take(id),"uidStatus":uid_status,"uid":uid,"startStatus":start_status,"startUsec":start,"typeStatus":type_status,"type":kind,"classStatus":class_status,"class":class,"stateStatus":state_status,"state":state}));index+=1;
        }unsafe{libc::free(list.cast())};}
        println!("{}",serde_json::json!({"pid":std::process::id(),"uid":unsafe{libc::geteuid()},"kernelSessionStatus":session_status,"kernelSession":kernel_session,"ownerStatus":owner_status,"ownerUid":owner,"userUnitStatus":unit_status,"userUnit":user_unit,"displayStatus":display_status,"display":display,"listStatus":list_status,"sessions":sessions,"environmentSession":std::env::var("XDG_SESSION_ID").ok(),"cgroup":std::fs::read_to_string("/proc/self/cgroup")?}));return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--connect-peer") {
        let mut stream=UnixStream::connect(std::env::args().nth(2).unwrap())?;
        stream.write_all(b"x")?;let mut byte=[0];stream.read_exact(&mut byte)?;return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--inherited-peer") {
        let mut peer: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        if unsafe { libc::getsockopt(0, libc::SOL_SOCKET, libc::SO_PEERCRED,
            (&mut peer as *mut libc::ucred).cast(), &mut length) } != 0 { return Err(io::Error::last_os_error()); }
        println!("{}",serde_json::json!({"stage":"namespace","pid":std::process::id(),"peerPid":peer.pid,
            "peerUid":peer.uid,"currentUid":unsafe{libc::geteuid()},"length":length,
            "serverHeaderPredicate":peer.uid==unsafe{libc::geteuid()}}));
        assert_eq!(std::process::id(),1);
        assert_eq!(peer.pid,0,"the inherited peer must be outside the child PID namespace");
        assert_eq!(peer.uid,unsafe{libc::geteuid()});
        use std::os::fd::FromRawFd;
        let stream = unsafe { UnixStream::from_raw_fd(0) };
        let authorized = linux_peer::authorized(&stream,"owned-namespace-session",None);
        println!("{}",serde_json::json!({"stage":"guard","authorized":authorized}));
        assert!(!authorized,"an unresolved kernel peer PID cannot use this process's session");
        return Ok(());
    }
    let (stream,_retained)=UnixStream::pair()?;
    println!("{}",serde_json::json!({"stage":"parent","pid":std::process::id(),"fd":stream.as_raw_fd()}));
    let input: OwnedFd=stream.into();
    let child=Command::new("unshare").args(["--pid","--fork"]).arg(std::env::current_exe()?)
        .arg("--inherited-peer").stdin(Stdio::from(input)).output()?;
    print!("{}",String::from_utf8_lossy(&child.stdout));eprint!("{}",String::from_utf8_lossy(&child.stderr));
    if !child.status.success(){return Err(io::Error::other(format!("namespace probe failed: {}",child.status)))}
    #[link(name="systemd")]
    unsafe extern "C" { fn sd_pid_get_session(pid:libc::pid_t,session:*mut *mut libc::c_char)->libc::c_int; }
    let mut session=std::ptr::null_mut();
    assert!(unsafe{sd_pid_get_session(0,&mut session)}>=0 && !session.is_null(),"owned live/exit probe requires a login session");
    let expected=unsafe{std::ffi::CStr::from_ptr(session).to_string_lossy().into_owned()};unsafe{libc::free(session.cast())};
    let directory=std::env::temp_dir().join(format!("interceptor-peer-probe-{}",std::process::id()));
    std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let path=directory.join("peer.sock");let listener=UnixListener::bind(&path)?;
    let mut child=Command::new(std::env::current_exe()?).arg("--connect-peer").arg(&path).spawn()?;
    let (mut stream,_)=listener.accept()?;let mut byte=[0];stream.read_exact(&mut byte)?;
    let live=linux_peer::authorized(&stream,&expected,Some(&std::env::current_exe()?));
    assert!(live,"owned live peer with the same session/executable must pass");
    assert!(!linux_peer::authorized(&stream,"other-owned-session",None));
    assert!(!linux_peer::authorized(&stream,&expected,Some(std::path::Path::new("/owned-missing-provider"))));
    stream.write_all(b"x")?;assert!(child.wait()?.success());
    let exited=linux_peer::authorized(&stream,&expected,None);assert!(!exited,"an exited socket peer must fail");
    println!("{}",serde_json::json!({"stage":"live-exit","liveAuthorized":live,"exitedAuthorized":exited}));
    drop(stream);drop(listener);std::fs::remove_file(path)?;std::fs::remove_dir(directory)?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn main() { panic!("this owned diagnostic requires Linux PID namespaces"); }
#[cfg(target_os = "linux")]
#[path = "../src/linux_peer.rs"] mod linux_peer;
