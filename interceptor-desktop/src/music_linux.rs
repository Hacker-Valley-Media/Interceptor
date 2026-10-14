use crate::{failure,native_bus::*};
use serde_json::{Value,json};
use std::{ffi::{CStr,CString,c_char,c_int},ptr};
#[link(name="systemd")]unsafe extern "C"{
    fn sd_bus_message_enter_container(message:Raw,kind:c_char,contents:*const c_char)->c_int;
    fn sd_bus_message_exit_container(message:Raw)->c_int;
    fn sd_bus_message_skip(message:Raw,types:*const c_char)->c_int;
    fn sd_bus_get_property_string(bus:Raw,destination:*const c_char,path:*const c_char,interface:*const c_char,member:*const c_char,error:Raw,value:*mut *mut c_char)->c_int;
    fn sd_bus_get_property(bus:Raw,destination:*const c_char,path:*const c_char,interface:*const c_char,member:*const c_char,error:Raw,reply:*mut Raw,signature:*const c_char)->c_int;
    fn sd_bus_set_property(bus:Raw,destination:*const c_char,path:*const c_char,interface:*const c_char,member:*const c_char,error:Raw,signature:*const c_char,...)->c_int;
}
fn check(code:c_int)->Result<(),Value>{if code<0{Err(failure("provider_failed",format!("native MPRIS read failed with errno{}",-code)))}else{Ok(())}}
unsafe fn text(pointer:*const c_char)->Result<String,Value>{
    if pointer.is_null(){return Err(failure("provider_failed","native MPRIS text is absent"));}
    let value=unsafe{CStr::from_ptr(pointer)}.to_str().map_err(|_|failure("provider_failed","native MPRIS text is not UTF8"))?;
    if value.len()>4096{return Err(failure("resource_limit","native MPRIS text exceeds 4096 bytes"));}Ok(value.into())
}
pub(crate) fn system_snapshot()->Result<Value,Value>{unsafe{
    let mut raw=ptr::null_mut();check(sd_bus_open_user(&mut raw))?;let bus=Bus(raw);check(sd_bus_set_method_call_timeout(bus.0,500_000))?;
    let mut message=ptr::null_mut();check(sd_bus_call_method(bus.0,c"org.freedesktop.DBus".as_ptr(),c"/org/freedesktop/DBus".as_ptr(),c"org.freedesktop.DBus".as_ptr(),c"ListNames".as_ptr(),ptr::null_mut(),&mut message,c"".as_ptr()))?;let message=Message(message);
    check(sd_bus_message_enter_container(message.0,b'a' as c_char,c"s".as_ptr()))?;let mut names=Vec::new();let mut total=0;
    loop{let mut pointer=ptr::null::<c_char>();let read=sd_bus_message_read(message.0,c"s".as_ptr(),&mut pointer);check(read)?;if read==0{break;}total+=1;if total>4096{return Err(failure("resource_limit","native session bus names exceed 4096"));}let name=text(pointer)?;if name.starts_with("org.mpris.MediaPlayer2."){names.push(name);}}
    if names.is_empty(){return Ok(json!({"running":false}));}
    if names.len()!=1{return Err(failure("target_ambiguous","multiple native MPRIS players; no system player was selected"));}
    let name=CString::new(names.remove(0)).unwrap();let mut reply=ptr::null_mut();
    check(sd_bus_call_method(bus.0,c"org.freedesktop.DBus".as_ptr(),c"/org/freedesktop/DBus".as_ptr(),c"org.freedesktop.DBus".as_ptr(),c"GetNameOwner".as_ptr(),ptr::null_mut(),&mut reply,c"s".as_ptr(),name.as_ptr()))?;let reply=Message(reply);
    let mut pointer=ptr::null::<c_char>();check(sd_bus_message_read(reply.0,c"s".as_ptr(),&mut pointer))?;let owner=CString::new(text(pointer)?).unwrap();
    let mut reply=ptr::null_mut();check(sd_bus_call_method(bus.0,c"org.freedesktop.DBus".as_ptr(),c"/org/freedesktop/DBus".as_ptr(),c"org.freedesktop.DBus".as_ptr(),c"GetConnectionUnixProcessID".as_ptr(),ptr::null_mut(),&mut reply,c"s".as_ptr(),owner.as_ptr()))?;let reply=Message(reply);let mut pid=0u32;check(sd_bus_message_read(reply.0,c"u".as_ptr(),&mut pid))?;
    let identity=crate::linux::capture_identity(pid)?;
    let property=|member:&CStr|->Result<String,Value>{
        let mut value=ptr::null_mut();let result=sd_bus_get_property_string(bus.0,owner.as_ptr(),c"/org/mpris/MediaPlayer2".as_ptr(),c"org.mpris.MediaPlayer2.Player".as_ptr(),member.as_ptr(),ptr::null_mut(),&mut value);
        let observed=if result<0{Err(failure("provider_failed",format!("native MPRIS property failed with errno{}",-result)))}else{text(value)};libc::free(value.cast());observed
    };
    let state=property(c"PlaybackStatus")?;let status=playback_status(&state).ok_or_else(||failure("provider_failed","native MPRIS playback state is unknown"))?;
    let repeat=property(c"LoopStatus")?;let repeat=match repeat.as_str(){"None"=>"off","Track"=>"one","Playlist"=>"all",_=>return Err(failure("provider_failed","native MPRIS repeat state is unknown"))};
    let mut position=0i64;check(sd_bus_get_property_trivial(bus.0,owner.as_ptr(),c"/org/mpris/MediaPlayer2".as_ptr(),c"org.mpris.MediaPlayer2.Player".as_ptr(),c"Position".as_ptr(),ptr::null_mut(),b'x' as c_char,(&raw mut position).cast()))?;
    let mut shuffle:c_int=0;check(sd_bus_get_property_trivial(bus.0,owner.as_ptr(),c"/org/mpris/MediaPlayer2".as_ptr(),c"org.mpris.MediaPlayer2.Player".as_ptr(),c"Shuffle".as_ptr(),ptr::null_mut(),b'b' as c_char,(&raw mut shuffle).cast()))?;
    if position<0||!matches!(shuffle,0|1){return Err(failure("provider_failed","native MPRIS position or shuffle is invalid"));}
    let mut data=json!({"running":true,"source":name.to_str().unwrap(),"status":status,"playbackTime":position as f64/1_000_000.0,"repeatMode":repeat,"shuffleMode":if shuffle==1{"songs"}else{"off"}});
    let mut metadata=ptr::null_mut();check(sd_bus_get_property(bus.0,owner.as_ptr(),c"/org/mpris/MediaPlayer2".as_ptr(),c"org.mpris.MediaPlayer2.Player".as_ptr(),c"Metadata".as_ptr(),ptr::null_mut(),&mut metadata,c"a{sv}".as_ptr()))?;let metadata=Message(metadata);
    check(sd_bus_message_enter_container(metadata.0,b'a' as c_char,c"{sv}".as_ptr()))?;let mut entries=0;let mut id=None;let mut title=None;
    loop{
        let entered=sd_bus_message_enter_container(metadata.0,b'e' as c_char,c"sv".as_ptr());check(entered)?;if entered==0{break;}entries+=1;if entries>128{return Err(failure("resource_limit","native MPRIS metadata exceeds 128 fields"));}
        let mut key=ptr::null::<c_char>();check(sd_bus_message_read(metadata.0,c"s".as_ptr(),&mut key))?;let key=text(key)?;
        if key=="mpris:trackid"||key=="xesam:title"{
            let signature=if key=="mpris:trackid"{c"o"}else{c"s"};check(sd_bus_message_enter_container(metadata.0,b'v' as c_char,signature.as_ptr()))?;
            let mut value=ptr::null::<c_char>();check(sd_bus_message_read(metadata.0,signature.as_ptr(),&mut value))?;let value=text(value)?;if key=="mpris:trackid"{id=Some(value)}else{title=Some(value)}check(sd_bus_message_exit_container(metadata.0))?;
        }else{check(sd_bus_message_skip(metadata.0,c"v".as_ptr()))?;}
        check(sd_bus_message_exit_container(metadata.0))?;
    }
    if let Some(title)=title{data["title"]=json!(title);if let Some(id)=id.filter(|id|!id.is_empty()&&id.len()<=1024&&id!="/org/mpris/MediaPlayer2/TrackList/NoTrack"){data["currentEntry"]=json!({"id":id,"title":title});}}
    if !identity.alive(){return Err(failure("target_gone","retained native MPRIS process or login ended during observation"));}
    let mut current=ptr::null_mut();check(sd_bus_call_method(bus.0,c"org.freedesktop.DBus".as_ptr(),c"/org/freedesktop/DBus".as_ptr(),c"org.freedesktop.DBus".as_ptr(),c"GetNameOwner".as_ptr(),ptr::null_mut(),&mut current,c"s".as_ptr(),name.as_ptr()))?;let current=Message(current);
    let mut pointer=ptr::null::<c_char>();check(sd_bus_message_read(current.0,c"s".as_ptr(),&mut pointer))?;
    if text(pointer)?.as_bytes()!=owner.as_bytes(){return Err(failure("target_gone","native MPRIS bus connection changed during observation"));}
    Ok(data)
}}
fn playback_status(value:&str)->Option<&'static str>{match value{"Playing"=>Some("playing"),"Paused"=>Some("paused"),"Stopped"=>Some("stopped"),_=>None}}
#[cfg(test)]mod tests{use super::*;#[test]fn native_mpris_text_refuses_invalid_utf8_null_and_byte_overflow(){unsafe{assert!(text(ptr::null()).is_err());let bad=[255u8,0];assert!(text(bad.as_ptr().cast()).is_err());let long=CString::new("é".repeat(2049)).unwrap();assert!(text(long.as_ptr()).is_err());let real=CString::new("Actual native title").unwrap();assert_eq!(text(real.as_ptr()).unwrap(),"Actual native title");}}}
/// The one MPRIS player on the session bus (none or several are reported, never guessed).
unsafe fn player_name(bus:&Bus)->Result<CString,Value>{unsafe{
    let mut message=ptr::null_mut();check(sd_bus_call_method(bus.0,c"org.freedesktop.DBus".as_ptr(),c"/org/freedesktop/DBus".as_ptr(),c"org.freedesktop.DBus".as_ptr(),c"ListNames".as_ptr(),ptr::null_mut(),&mut message,c"".as_ptr()))?;let message=Message(message);
    check(sd_bus_message_enter_container(message.0,b'a' as c_char,c"s".as_ptr()))?;let mut names=Vec::new();
    for _ in 0..4096{let mut pointer=ptr::null::<c_char>();let read=sd_bus_message_read(message.0,c"s".as_ptr(),&mut pointer);check(read)?;if read==0{break;}let name=text(pointer)?;if name.starts_with("org.mpris.MediaPlayer2."){names.push(name);}}
    match names.len(){0=>Err(failure("target_gone","no MPRIS media player is running")),1=>Ok(CString::new(names.remove(0)).unwrap()),_=>Err(failure("target_ambiguous","multiple native MPRIS players; no system player was selected"))}
}}
/// Transport control of the system player through MPRIS (org.mpris.MediaPlayer2.Player).
pub(crate) fn system_control(action:&Value)->Result<Value,Value>{unsafe{
    let mut raw=ptr::null_mut();check(sd_bus_open_user(&mut raw))?;let bus=Bus(raw);check(sd_bus_set_method_call_timeout(bus.0,2_000_000))?;
    let name=player_name(&bus)?;let path=c"/org/mpris/MediaPlayer2";let player=c"org.mpris.MediaPlayer2.Player";
    let done=|result:c_int,what:&str|->Result<(),Value>{if result<0{Err(failure("provider_failed",format!("the media player refused {what} (errno{})",-result)))}else{Ok(())}};
    let call=|member:&CStr|->Result<(),Value>{let mut reply=ptr::null_mut();let result=sd_bus_call_method(bus.0,name.as_ptr(),path.as_ptr(),player.as_ptr(),member.as_ptr(),ptr::null_mut(),&mut reply,c"".as_ptr());if !reply.is_null(){sd_bus_message_unref(reply);}done(result,&member.to_string_lossy())};
    match action["sub"].as_str().unwrap_or(""){
        "play"|"resume"=>call(c"Play")?,"pause"=>call(c"Pause")?,"stop"=>call(c"Stop")?,"next"=>call(c"Next")?,"previous"=>call(c"Previous")?,
        "seek"=>{
            // Seek is relative; SetPosition would need the current track id.
            let mut position=0i64;check(sd_bus_get_property_trivial(bus.0,name.as_ptr(),path.as_ptr(),player.as_ptr(),c"Position".as_ptr(),ptr::null_mut(),b'x' as c_char,(&mut position as *mut i64).cast()))?;
            let target=(action["time"].as_f64().unwrap_or(0.0)*1_000_000.0) as i64;let mut reply=ptr::null_mut();
            let result=sd_bus_call_method(bus.0,name.as_ptr(),path.as_ptr(),player.as_ptr(),c"Seek".as_ptr(),ptr::null_mut(),&mut reply,c"x".as_ptr(),target-position);if !reply.is_null(){sd_bus_message_unref(reply);}done(result,"Seek")?;
        }
        "repeat"=>{let value=match action["mode"].as_str(){Some("one")=>c"Track",Some("all")=>c"Playlist",_=>c"None"};done(sd_bus_set_property(bus.0,name.as_ptr(),path.as_ptr(),player.as_ptr(),c"LoopStatus".as_ptr(),ptr::null_mut(),c"s".as_ptr(),value.as_ptr()),"LoopStatus")?;}
        "shuffle"=>{let on:c_int=c_int::from(action["mode"]=="songs");done(sd_bus_set_property(bus.0,name.as_ptr(),path.as_ptr(),player.as_ptr(),c"Shuffle".as_ptr(),ptr::null_mut(),c"b".as_ptr(),on),"Shuffle")?;}
        _=>return Err(failure("invalid_request","not a system player control")),
    }
    if let Some(reply)=crate::music::mode_reply(action){return Ok(reply);}
    let mut data=json!({"ok":true});
    if let Ok(snapshot)=system_snapshot(){if let Some(status)=snapshot["status"].as_str(){data["playbackStatus"]=json!(status);}if let Some(time)=snapshot["playbackTime"].as_f64(){data["playbackTime"]=json!(time);}}
    Ok(data)
}}
