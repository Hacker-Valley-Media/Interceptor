use crate::failure;
use serde_json::{Value,json};
use std::net::TcpStream;
use windows::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable,MIB_TCPROW_OWNER_PID,TCP_TABLE_OWNER_PID_CONNECTIONS};
pub(crate) fn verify_connection(socket:&TcpStream,pid:u32)->Result<(),Value>{unsafe{
    let client=socket.local_addr().map_err(|_|failure("provider_failed","Music connection identity unavailable"))?;
    let server=socket.peer_addr().map_err(|_|failure("provider_failed","Music connection peer unavailable"))?;
    if !client.ip().is_loopback()||!server.ip().is_loopback(){return Err(failure("permission_denied","Music connection must be numeric loopback"));}
    let mut size=0;let first=GetExtendedTcpTable(None,&mut size,false,2,TCP_TABLE_OWNER_PID_CONNECTIONS,0);
    if first!=122||size<4||size>1_048_576{return Err(failure("provider_failed","native Music TCP ownership table unavailable"));}
    let mut storage=vec![0u64;(size as usize+7)/8];
    if GetExtendedTcpTable(Some(storage.as_mut_ptr().cast()),&mut size,false,2,TCP_TABLE_OWNER_PID_CONNECTIONS,0)!=0{return Err(failure("provider_failed","native Music TCP ownership changed during discovery"));}
    if size<4||size as usize>storage.len()*8{return Err(failure("provider_failed","native Music TCP ownership size is invalid"));}
    let bytes=std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(),size as usize);let count=u32::from_ne_bytes(bytes[..4].try_into().unwrap())as usize;
    let stride=std::mem::size_of::<MIB_TCPROW_OWNER_PID>();if count>32768||4+count*stride>bytes.len(){return Err(failure("provider_failed","native Music TCP ownership table is malformed"));}
    let localhost=u32::from_ne_bytes([127,0,0,1]);
    let matches=(0..count).filter(|i|{let row=std::ptr::read_unaligned(bytes.as_ptr().add(4+i*stride).cast::<MIB_TCPROW_OWNER_PID>());row.dwOwningPid==pid&&row.dwState==5&&row.dwLocalAddr==localhost&&row.dwRemoteAddr==localhost&&u16::from_be(row.dwLocalPort as u16)==server.port()&&u16::from_be(row.dwRemotePort as u16)==client.port()}).count();
    if matches==1{Ok(())}else{Err(failure("permission_denied","Music TCP peer does not belong to the retained owned MPD process; no token or command sent"))}
}}
pub(crate) fn system_snapshot()->Result<Value,Value>{
    use windows::{Media::{Control::{GlobalSystemMediaTransportControlsSessionManager as Manager,GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status},MediaPlaybackAutoRepeatMode as Repeat,MediaPlaybackType},Win32::System::WinRT::{RoInitialize,RoUninitialize,RO_INIT_MULTITHREADED}};
    struct Runtime;impl Drop for Runtime{fn drop(&mut self){unsafe{RoUninitialize();}}}
    let error=|e:windows::core::Error|failure(if e.code()==windows::Win32::Foundation::E_ACCESSDENIED{"permission_denied"}else{"provider_failed"},"native Windows system-player read failed; globalMediaControl capability or current media session may be unavailable");
    unsafe{RoInitialize(RO_INIT_MULTITHREADED)}.map_err(error)?;let _runtime=Runtime;
    let manager=Manager::RequestAsync().and_then(|v|v.join()).map_err(error)?;
    let count=manager.GetSessions().and_then(|v|v.Size()).map_err(error)?;
    if count==0{return Ok(json!({"running":false}));}
    if count>64{return Err(failure("resource_limit","native system media sessions exceed 64"));}
    let session=manager.GetCurrentSession().map_err(|_|failure("target_gone","Windows has no current native media session; no alternative selected"))?;
    let info=session.GetPlaybackInfo().map_err(error)?;
    if info.PlaybackType().and_then(|v|v.Value()).map_err(error)?!=MediaPlaybackType::Music{return Err(failure("unsupported_target","Windows current media session is not natively identified as music"));}
    let state=match info.PlaybackStatus().map_err(error)?{Status::Playing=>"playing",Status::Paused=>"paused",Status::Stopped=>"stopped",Status::Opened=>"opened",Status::Closed=>"closed",Status::Changing=>"changing",_=>return Err(failure("provider_failed","native system playback state is unknown"))};
    let properties=session.TryGetMediaPropertiesAsync().and_then(|v|v.join()).map_err(error)?;
    let position=session.GetTimelineProperties().and_then(|v|v.Position()).map_err(error)?.Duration as f64/10_000_000.0;
    if !position.is_finite()||position<0.0{return Err(failure("provider_failed","native system music position is invalid"));}
    let mut data=json!({"running":true,"status":state,"source":session.SourceAppUserModelId().map_err(error)?.to_string(),"title":properties.Title().map_err(error)?.to_string(),"artistName":properties.Artist().map_err(error)?.to_string(),"playbackTime":position});
    if let Ok(mode)=info.AutoRepeatMode().and_then(|v|v.Value()){
        data["repeatMode"]=json!(match mode{Repeat::None=>"off",Repeat::Track=>"one",Repeat::List=>"all",_=>return Err(failure("provider_failed","native system repeat state is unknown"))});
    }
    if let Ok(shuffle)=info.IsShuffleActive().and_then(|v|v.Value()){data["shuffleMode"]=json!(if shuffle{"songs"}else{"off"});}
    if manager.GetCurrentSession().map_err(error)?!=session{return Err(failure("target_gone","native system music session changed during observation"));}
    // SMTC exposes metadata but no stable track ID; no entry ID is invented.
    Ok(data)
}
/// Transport control of the current Windows media session (GlobalSystemMediaTransportControls).
pub(crate) fn system_control(action:&Value)->Result<Value,Value>{
    use windows::{Media::{Control::GlobalSystemMediaTransportControlsSessionManager as Manager,MediaPlaybackAutoRepeatMode as Repeat},Win32::System::WinRT::{RoInitialize,RoUninitialize,RO_INIT_MULTITHREADED}};
    struct Runtime;impl Drop for Runtime{fn drop(&mut self){unsafe{RoUninitialize();}}}
    let error=|e:windows::core::Error|failure("provider_failed",format!("native Windows media control failed: {e}"));
    unsafe{RoInitialize(RO_INIT_MULTITHREADED)}.map_err(error)?;let _runtime=Runtime;
    let manager=Manager::RequestAsync().and_then(|v|v.join()).map_err(error)?;
    let session=manager.GetCurrentSession().map_err(|_|failure("target_gone","Windows has no current media session"))?;
    let accepted=match action["sub"].as_str().unwrap_or(""){
        "play"|"resume"=>session.TryPlayAsync(),"pause"=>session.TryPauseAsync(),"stop"=>session.TryStopAsync(),
        "next"=>session.TrySkipNextAsync(),"previous"=>session.TrySkipPreviousAsync(),
        "seek"=>session.TryChangePlaybackPositionAsync((action["time"].as_f64().unwrap_or(0.0)*10_000_000.0) as i64),
        "repeat"=>session.TryChangeAutoRepeatModeAsync(match action["mode"].as_str(){Some("one")=>Repeat::Track,Some("all")=>Repeat::List,_=>Repeat::None}),
        "shuffle"=>session.TryChangeShuffleActiveAsync(action["mode"]=="songs"),
        _=>return Err(failure("invalid_request","not a system player control")),
    }.and_then(|v|v.join()).map_err(error)?;
    if !accepted{return Err(failure("unsupported_target","the current media app does not support this control"));}
    if let Some(reply)=crate::music::mode_reply(action){return Ok(reply);}
    let mut data=json!({"ok":true});
    if let Ok(snapshot)=system_snapshot(){if let Some(status)=snapshot["status"].as_str(){data["playbackStatus"]=json!(status);}}
    Ok(data)
}
