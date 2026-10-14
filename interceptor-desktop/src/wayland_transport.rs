//! Shared bounded Wayland event transport for clipboard and pointer clients.
use std::os::fd::AsRawFd;
use wayland_client::{Connection,EventQueue};

#[derive(Debug)]
pub struct Error{pub code:&'static str,pub message:String}
impl Error{
    fn backend(error:impl std::fmt::Display)->Self{Self{code:"provider_failed",message:error.to_string()}}
}
pub fn pump<State>(connection:&Connection,queue:&mut EventQueue<State>,state:&mut State,wait_ms:i32,valid:impl Fn(&State)->bool)->Result<(),Error>{
    queue.dispatch_pending(state).map_err(Error::backend)?;
    if !valid(state){return Err(Error::backend("Wayland protocol state refused transport"));}
    if let Err(error)=connection.flush(){
        if !matches!(&error,wayland_client::backend::WaylandError::Io(e) if e.kind()==std::io::ErrorKind::WouldBlock){return Err(Error::backend(error));}
    }
    if let Some(guard)=queue.prepare_read(){
        let mut fd=libc::pollfd{fd:connection.backend().poll_fd().as_raw_fd(),events:libc::POLLIN,revents:0};
        let ready=unsafe{libc::poll(&mut fd,1,wait_ms.clamp(0,1000))};
        if ready<0{if std::io::Error::last_os_error().kind()!=std::io::ErrorKind::Interrupted{return Err(Error::backend(std::io::Error::last_os_error()));}}
        else if fd.revents&libc::POLLIN!=0{guard.read().map_err(Error::backend)?;}
        else if fd.revents&(libc::POLLERR|libc::POLLHUP|libc::POLLNVAL)!=0{return Err(Error{code:"target_gone",message:"Wayland connection closed".into()});}
    }
    queue.dispatch_pending(state).map_err(Error::backend)?;
    if !valid(state){return Err(Error::backend("Wayland protocol state refused transport"));}
    Ok(())
}
