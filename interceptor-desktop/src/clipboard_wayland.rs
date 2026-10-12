//! Native data-control clipboard. No surface, input serial or activation path.
//! Each connection is authenticated against the qualified compositor endpoint.
use crate::{failure,clipboard::bounded};
use serde_json::{Value,json};
use base64::Engine;
use std::{collections::HashMap,os::fd::{AsFd,AsRawFd,FromRawFd,OwnedFd},sync::{Arc,OnceLock,mpsc,atomic::{AtomicUsize,Ordering}},time::{Duration,Instant}};
use wayland_client::{Connection,Dispatch,EventQueue,Proxy,QueueHandle,protocol::{wl_registry,wl_seat,wl_callback}};
use wayland_protocols_wlr::data_control::v1::client::{zwlr_data_control_manager_v1 as manager,zwlr_data_control_device_v1 as device,zwlr_data_control_offer_v1 as offer,zwlr_data_control_source_v1 as source};
const TRANSFER_MS:u64=2000;
const MAX_BYTES:usize=crate::contract_generated::DESKTOP_MAX_RESULT_BYTES;
type Work=(String,Value,Instant,mpsc::Sender<Value>);
static WORKER:OnceLock<mpsc::SyncSender<Work>>=OnceLock::new();
static WRITERS:AtomicUsize=AtomicUsize::new(0);

#[derive(Default)]struct State{
    manager:Option<manager::ZwlrDataControlManagerV1>,seat:Option<wl_seat::WlSeat>,
    device:Option<device::ZwlrDataControlDeviceV1>,selection:Option<offer::ZwlrDataControlOfferV1>,
    source:Option<source::ZwlrDataControlSourceV1>,offers:HashMap<u32,Vec<String>>,
    inspector:Option<device::ZwlrDataControlDeviceV1>,inspected:Option<offer::ZwlrDataControlOfferV1>,inspection_received:bool,
    manager_global:Option<u32>,seat_global:Option<u32>,synced:bool,changes:u64,error:Option<Value>,
}
impl Dispatch<wl_registry::WlRegistry,()> for State{
    fn event(state:&mut Self,registry:&wl_registry::WlRegistry,event:wl_registry::Event,_:&(),_:&Connection,qh:&QueueHandle<Self>){
        match event{
            wl_registry::Event::Global{name,interface,version} if interface=="zwlr_data_control_manager_v1"=>{
                if version<2||state.manager.is_some(){state.error=Some(failure("background_unavailable","clipboard requires one data-control version 2 manager"));return;}
                state.manager=Some(registry.bind(name,2,qh,()));state.manager_global=Some(name);
            },
            wl_registry::Event::Global{name,interface,version} if interface=="wl_seat"=>{
                if state.seat.is_some(){state.error=Some(failure("target_ambiguous","clipboard requires one Wayland seat"));return;}
                state.seat=Some(registry.bind(name,version.min(2),qh,()));state.seat_global=Some(name);
            },
            wl_registry::Event::GlobalRemove{name} if Some(name)==state.manager_global||Some(name)==state.seat_global=>state.error=Some(failure("target_gone","clipboard protocol or seat was revoked")),
            _=>(),
        }
    }
}
impl Dispatch<wl_seat::WlSeat,()> for State{fn event(_:&mut Self,_:&wl_seat::WlSeat,_:wl_seat::Event,_:&(),_:&Connection,_:&QueueHandle<Self>){}}
impl Dispatch<manager::ZwlrDataControlManagerV1,()> for State{fn event(_:&mut Self,_:&manager::ZwlrDataControlManagerV1,_:manager::Event,_:&(),_:&Connection,_:&QueueHandle<Self>){}}
impl Dispatch<wl_callback::WlCallback,()> for State{
    fn event(state:&mut Self,_:&wl_callback::WlCallback,event:wl_callback::Event,_:&(),_:&Connection,_:&QueueHandle<Self>){if matches!(event,wl_callback::Event::Done{..}){state.synced=true;}}
}
impl Dispatch<device::ZwlrDataControlDeviceV1,()> for State{
    fn event(state:&mut Self,proxy:&device::ZwlrDataControlDeviceV1,event:device::Event,_:&(),_:&Connection,_:&QueueHandle<Self>){
        match event{
            device::Event::DataOffer{id}=>{if state.offers.len()>=128{state.error=Some(failure("resource_limit","too many clipboard offers"));}else{state.offers.insert(id.id().protocol_id(),Vec::new());}},
            device::Event::Selection{id}=>{
                if state.inspector.as_ref().is_some_and(|d|d.id()==proxy.id()){
                    if let Some(previous)=state.inspected.take(){state.offers.remove(&previous.id().protocol_id());previous.destroy();}
                    state.inspected=id;state.inspection_received=true;
                }else if state.device.as_ref().is_some_and(|d|d.id()==proxy.id()){
                    if let Some(previous)=state.selection.take(){state.offers.remove(&previous.id().protocol_id());previous.destroy();}
                    state.selection=id;state.changes=state.changes.saturating_add(1);
                }else if let Some(id)=id{state.offers.remove(&id.id().protocol_id());id.destroy();}
            },
            device::Event::PrimarySelection{id:Some(id)}=>{state.offers.remove(&id.id().protocol_id());id.destroy();},
            device::Event::Finished=>state.error=Some(failure("target_gone","compositor revoked the clipboard data device")),
            _=>(),
        }
    }
    wayland_client::event_created_child!(State,device::ZwlrDataControlDeviceV1,[0=>(offer::ZwlrDataControlOfferV1,())]);
}
impl Dispatch<offer::ZwlrDataControlOfferV1,()> for State{
    fn event(state:&mut Self,proxy:&offer::ZwlrDataControlOfferV1,event:offer::Event,_:&(),_:&Connection,_:&QueueHandle<Self>){
        if let offer::Event::Offer{mime_type}=event{
            let types=state.offers.entry(proxy.id().protocol_id()).or_default();
            if types.len()>=4096||mime_type.len()>255||mime_type.is_empty()||mime_type.bytes().any(|b|b==0||b==b'\n'||b==b'\r'){
                state.error=Some(failure("resource_limit","invalid or oversized clipboard MIME inventory"));
            }else if !types.contains(&mime_type){types.push(mime_type);}
        }
    }
}
struct Writer;impl Drop for Writer{fn drop(&mut self){WRITERS.fetch_sub(1,Ordering::Relaxed);}}
fn send_bytes(fd:OwnedFd,bytes:Arc<Vec<u8>>){
    let _permit=Writer;let flags=unsafe{libc::fcntl(fd.as_raw_fd(),libc::F_GETFL)};
    if flags<0||unsafe{libc::fcntl(fd.as_raw_fd(),libc::F_SETFL,flags|libc::O_NONBLOCK)}<0{return;}
    let deadline=Instant::now()+Duration::from_millis(TRANSFER_MS);let mut at=0;
    while at<bytes.len()&&Instant::now()<deadline{
        let mut wait=libc::pollfd{fd:fd.as_raw_fd(),events:libc::POLLOUT,revents:0};
        if unsafe{libc::poll(&mut wait,1,20)}<0{if std::io::Error::last_os_error().kind()==std::io::ErrorKind::Interrupted{continue;}break;}
        if wait.revents&(libc::POLLERR|libc::POLLHUP|libc::POLLNVAL)!=0{break;}
        if wait.revents&libc::POLLOUT==0{continue;}
        let n=unsafe{libc::write(fd.as_raw_fd(),bytes[at..].as_ptr().cast(),(bytes.len()-at).min(65536))};
        if n>0{at+=n as usize;}else if n<0{let e=std::io::Error::last_os_error();if ![std::io::ErrorKind::WouldBlock,std::io::ErrorKind::Interrupted].contains(&e.kind()){break;}}else{break;}
    }
}
impl Dispatch<source::ZwlrDataControlSourceV1,Arc<Vec<u8>>> for State{
    fn event(_:&mut Self,proxy:&source::ZwlrDataControlSourceV1,event:source::Event,bytes:&Arc<Vec<u8>>,_:&Connection,_:&QueueHandle<Self>){
        match event{
            source::Event::Send{mime_type,fd}=>{
                if !["text/plain;charset=utf-8","text/plain","UTF8_STRING"].contains(&mime_type.as_str()){return;}
                if WRITERS.fetch_update(Ordering::Relaxed,Ordering::Relaxed,|n|(n<8).then_some(n+1)).is_err(){return;}
                let bytes=bytes.clone();
                if std::thread::Builder::new().name("clipboard-send".into()).spawn(move||send_bytes(fd,bytes)).is_err(){WRITERS.fetch_sub(1,Ordering::Relaxed);}
            },
            source::Event::Cancelled=>proxy.destroy(),
            _=>(),
        }
    }
}
fn pump(connection:&Connection,queue:&mut EventQueue<State>,state:&mut State,wait_ms:i32)->Result<(),Value>{
    let result=interceptor_desktop::wayland_transport::pump(connection,queue,state,wait_ms,|state|state.error.is_none());
    if let Some(error)=&state.error{return Err(error.clone());}
    result.map_err(|error|failure(error.code,error.message))?;
    state.error.clone().map_or(Ok(()),Err)
}
fn synchronize(connection:&Connection,queue:&mut EventQueue<State>,state:&mut State)->Result<(),Value>{
    state.synced=false;connection.display().sync(&queue.handle(),());
    let deadline=Instant::now()+Duration::from_millis(TRANSFER_MS);
    while !state.synced{if Instant::now()>=deadline{let e=failure("provider_failed","Wayland clipboard synchronization deadline");state.error=Some(e.clone());return Err(e);}pump(connection,queue,state,20)?;}
    Ok(())
}
fn types(state:&State)->Vec<String>{state.selection.as_ref().and_then(|o|state.offers.get(&o.id().protocol_id())).cloned().unwrap_or_default()}
fn refresh_selection(connection:&Connection,queue:&mut EventQueue<State>,state:&mut State)->Result<(),Value>{
    // Qualified Hyprland0.56.1 only notifies core wl_data_device on a null
    // selection (SeatManager.cpp setCurrentSelection). A fresh data-control
    // device receives the authoritative initial selection, including null.
    // Keep the main observer alive so equal-value replacements retain their
    // native change events; the query's initial event is not another change.
    state.inspection_received=false;
    state.inspector=Some(state.manager.as_ref().unwrap().get_data_device(state.seat.as_ref().unwrap(),&queue.handle(),()));
    let observed=synchronize(connection,queue,state);
    if let Some(inspector)=state.inspector.take(){inspector.destroy();}
    observed?;
    if !state.inspection_received{return Err(failure("provider_failed","fresh clipboard device did not report its initial selection"));}
    let current=state.inspected.take();
    if state.selection.is_some()!=current.is_some(){state.changes=state.changes.saturating_add(1);}
    if let Some(previous)=state.selection.take(){state.offers.remove(&previous.id().protocol_id());previous.destroy();}
    state.selection=current;
    Ok(())
}
fn transfer(mime:&str,connection:&Connection,queue:&mut EventQueue<State>,state:&mut State)->Result<Vec<u8>,Value>{
    let selection=state.selection.clone().ok_or_else(||failure("unsupported_target","clipboard is empty"))?;
    let generation=state.changes;let mut pipe=[-1;2];
    if unsafe{libc::pipe2(pipe.as_mut_ptr(),libc::O_CLOEXEC|libc::O_NONBLOCK)}!=0{return Err(failure("provider_failed",std::io::Error::last_os_error()));}
    let read=unsafe{OwnedFd::from_raw_fd(pipe[0])};let write=unsafe{OwnedFd::from_raw_fd(pipe[1])};
    selection.receive(mime.to_owned(),write.as_fd());drop(write);
    let deadline=Instant::now()+Duration::from_millis(TRANSFER_MS);let mut bytes=Vec::new();let mut buffer=[0_u8;65536];
    loop{
        pump(connection,queue,state,2)?;
        if state.changes!=generation{return Err(failure("stale_reference","clipboard owner changed during transfer"));}
        let n=unsafe{libc::read(read.as_raw_fd(),buffer.as_mut_ptr().cast(),buffer.len())};
        if n==0{break;}
        if n>0{if bytes.len()+n as usize>MAX_BYTES{return Err(failure("resource_limit","clipboard transfer exceeds byte limit"));}bytes.extend_from_slice(&buffer[..n as usize]);}
        else if ![std::io::ErrorKind::WouldBlock,std::io::ErrorKind::Interrupted].contains(&std::io::Error::last_os_error().kind()){return Err(failure("provider_failed",std::io::Error::last_os_error()));}
        if Instant::now()>=deadline{return Err(failure("provider_failed","clipboard producer exceeded transfer deadline"));}
    }
    refresh_selection(connection,queue,state)?;
    if state.changes!=generation{return Err(failure("stale_reference","clipboard owner changed after transfer"));}
    Ok(bytes)
}
fn read(content_type:&str,connection:&Connection,queue:&mut EventQueue<State>,state:&mut State)->Result<Value,Value>{
    let offered=types(state);
    let candidates:&[&str]=match content_type{
        "text"=>&["text/plain;charset=utf-8","text/plain","UTF8_STRING"],
        "rtf"=>&["text/rtf","application/rtf"],
        "files"=>&["text/uri-list"],
        "image"=>&["image/png","image/jpeg","image/webp"],
        _=>return Err(failure("invalid_request","unknown clipboard content type")),
    };
    let mime=candidates.iter().find(|mime|offered.iter().any(|t|t==**mime)).ok_or_else(||failure("unsupported_target","requested clipboard MIME type is absent"))?;
    let bytes=transfer(mime,connection,queue,state)?;
    match content_type{
        "image"=>{
            let format=match *mime{"image/png"=>image::ImageFormat::Png,"image/jpeg"=>image::ImageFormat::Jpeg,_=>image::ImageFormat::WebP};
            let dimensions=image::ImageReader::with_format(std::io::Cursor::new(&bytes),format).into_dimensions().map_err(|_|failure("unsupported_target","clipboard image header is invalid"))?;
            crate::capture::pixel_size(dimensions.0,dimensions.1)?;
            let mut reader=image::ImageReader::with_format(std::io::Cursor::new(&bytes),format);
            let mut limits=image::Limits::default();limits.max_image_width=Some(dimensions.0);limits.max_image_height=Some(dimensions.1);limits.max_alloc=Some(160*1024*1024);reader.limits(limits);
            reader.decode().map_err(|_|failure("unsupported_target","clipboard image data is invalid or exceeds decoder limits"))?;
            Ok(json!(format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))))
        },
        "files"=>{
            let value=std::str::from_utf8(&bytes).map_err(|_|failure("unsupported_target","clipboard URI list is not UTF-8"))?;
            let mut paths=Vec::new();
            for uri in value.lines().filter(|line|!line.is_empty()&&!line.starts_with('#')){
                if paths.len()>=4096{return Err(failure("resource_limit","clipboard file list exceeds limit"));}
                paths.push(crate::clipboard_linux::local_file_path(uri)?);
            }
            Ok(json!(paths))
        },
        _=>String::from_utf8(bytes).map(|s|json!(s)).map_err(|_|failure("unsupported_target","clipboard text contains invalid UTF-8")),
    }
}
fn text(connection:&Connection,queue:&mut EventQueue<State>,state:&mut State)->Result<String,Value>{
    read("text",connection,queue,state).map(|v|v.as_str().unwrap().to_owned())
}
fn action(verb:&str,a:&Value,connection:&Connection,queue:&mut EventQueue<State>,state:&mut State)->Result<Value,Value>{
    synchronize(connection,queue,state)?;
    if verb=="__wayland_available"{return Ok(json!(true));}
    if verb=="__clipboard_snapshot"||["read","types"].contains(&a["sub"].as_str().unwrap_or("")){refresh_selection(connection,queue,state)?;}
    if verb=="__clipboard_snapshot"{
        let offered=types(state);let value=if offered.iter().any(|t|["text/plain;charset=utf-8","text/plain","UTF8_STRING"].contains(&t.as_str())){text(connection,queue,state)?}else{String::new()};
        return Ok(json!({"changeCount":state.changes,"types":offered,"preview":crate::clipboard::preview(&value)}));
    }
    match a["sub"].as_str().unwrap_or(""){
        "types"=>Ok(json!(types(state))),
        "read"=>read(a["contentType"].as_str().unwrap_or("text"),connection,queue,state),
        "write"=>{
            let value=a["text"].as_str().unwrap_or("");if value.len()>MAX_BYTES{return Err(failure("resource_limit","clipboard text exceeds byte limit"));}
            let source=state.manager.as_ref().unwrap().create_data_source(&queue.handle(),Arc::new(value.as_bytes().to_vec()));
            for mime in ["text/plain;charset=utf-8","text/plain","UTF8_STRING"]{source.offer(mime.to_owned());}
            state.device.as_ref().unwrap().set_selection(Some(&source));state.source=Some(source);
            synchronize(connection,queue,state).map_err(|_|failure("timeout_unknown_outcome","clipboard selection was sent but verification failed; observe before retrying"))?;
            refresh_selection(connection,queue,state).map_err(|_|failure("timeout_unknown_outcome","clipboard was written but fresh selection verification failed; observe before retrying"))?;
            let actual=text(connection,queue,state).map_err(|_|failure("timeout_unknown_outcome","clipboard was written but text verification failed; observe before retrying"))?;
            if actual!=value{return Err(failure("timeout_unknown_outcome","clipboard changed after write; observe before retrying"));}Ok(json!("ok"))
        },
        "clear"=>{
            state.device.as_ref().unwrap().set_selection(None);
            synchronize(connection,queue,state).map_err(|_|failure("timeout_unknown_outcome","clipboard clear was sent but verification failed; observe before retrying"))?;
            refresh_selection(connection,queue,state).map_err(|_|failure("timeout_unknown_outcome","clipboard clear was sent but fresh selection verification failed; observe before retrying"))?;
            if state.selection.is_some(){
                let mut error=failure("timeout_unknown_outcome","clipboard clear has no observed empty selection; observe before retrying");
                error["details"]=json!({"changeCount":state.changes,"types":types(state)});
                return Err(error);
            }Ok(json!("ok"))
        },
        _=>Err(failure("invalid_request","unknown Wayland clipboard subcommand")),
    }
}
fn start(receiver:mpsc::Receiver<Work>){
    let initialized=(||->Result<_,Value>{
        let login=crate::linux::login_identity(0).ok_or_else(||failure("no_interactive_session","clipboard requires a current login"))?;
        let connection=Connection::from_socket(crate::linux_hyprland::clipboard_connection()?).map_err(|e|failure("background_unavailable",e))?;
        let mut queue=connection.new_event_queue::<State>();let mut state=State::default();
        connection.display().get_registry(&queue.handle(),());synchronize(&connection,&mut queue,&mut state)?;
        let manager=state.manager.as_ref().ok_or_else(||failure("background_unavailable","Wayland compositor has no qualified data-control manager"))?;
        let seat=state.seat.as_ref().ok_or_else(||failure("background_unavailable","Wayland compositor has no seat"))?;
        state.device=Some(manager.get_data_device(seat,&queue.handle(),()));synchronize(&connection,&mut queue,&mut state)?;
        Ok((login,connection,queue,state))
    })();
    let(login,connection,mut queue,mut state)=match initialized{Ok(v)=>v,Err(e)=>{while let Ok((_,_,_,reply))=receiver.recv(){let _=reply.send(e.clone());}return;}};
    let mut session_checked=Instant::now();
    loop{
        if session_checked.elapsed()>=Duration::from_millis(500){
            session_checked=Instant::now();if crate::linux::login_identity(0).as_ref()!=Some(&login){return;}
        }
        if let Err(error)=pump(&connection,&mut queue,&mut state,0){
            // Preserve a terminal verdict for queued/future calls while releasing
            // the disconnected compositor, offers, source bytes and native fd.
            drop(state);drop(queue);drop(connection);
            while let Ok((_,_,_,reply))=receiver.recv(){let _=reply.send(error.clone());}return;
        }
        match receiver.recv_timeout(Duration::from_millis(10)){
            Ok((verb,a,deadline,reply))=>{
                let result=if Instant::now()>=deadline{failure("cancelled","clipboard request expired before execution; nothing was delivered")}
                    else if crate::linux::login_identity(0).as_ref()!=Some(&login){failure("no_interactive_session","clipboard login ended or changed")}
                    else{match action(&verb,&a,&connection,&mut queue,&mut state){Ok(data)=>bounded(data),Err(e)=>e}};
                let _=reply.send(result);
            },
            Err(mpsc::RecvTimeoutError::Timeout)=>(),Err(_)=>return,
        }
    }
}
pub fn execute(verb:&str,action:&Value)->Value{
    if std::env::var_os("WAYLAND_DISPLAY").is_none()||crate::linux::login_session(0).is_none(){return failure("no_interactive_session","Wayland clipboard requires the actual current login session");}
    let sender=WORKER.get_or_init(||{let(tx,rx)=mpsc::sync_channel(32);std::thread::spawn(move||start(rx));tx});
    let(tx,rx)=mpsc::channel();let deadline=Instant::now()+Duration::from_millis(7000);
    if let Err(e)=sender.try_send((verb.to_owned(),action.clone(),deadline,tx)){return failure("resource_limit",e);}
    rx.recv_timeout(Duration::from_millis(7500)).unwrap_or_else(|_|failure("timeout_unknown_outcome","Wayland clipboard worker deadline; observe before retrying"))
}
pub fn available()->bool{execute("__wayland_available",&json!({}))["success"]==true}
