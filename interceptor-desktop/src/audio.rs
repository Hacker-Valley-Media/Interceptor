use crate::{contract_generated::*, failure, success};
use serde_json::{json, Value};
use std::{fs::File, io::{self, Seek, SeekFrom, Write}, process::{ChildStdin, ChildStdout}, sync::{Arc, Mutex}, time::{Duration, Instant}};
#[cfg(any(windows,target_os="linux"))]use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
#[cfg(windows)]#[path="audio_windows.rs"]mod app;
#[cfg(target_os="linux")]#[path="audio_linux.rs"]mod app;

// ponytail: one input/output pair matches the Mac API; use separate session
// IDs only if the public API gains simultaneous captures on one channel.
static SESSIONS:Mutex<[Option<AudioSession>;2]>=Mutex::new([None,None]);
const MAX_SAMPLES:usize=1_048_576;
const MAX_SAVED_BYTES:u64=512*1024*1024;

pub(crate) fn pcm_windows(receiver:std::sync::mpsc::Receiver<Vec<f32>>,windows:std::sync::mpsc::SyncSender<Vec<f32>>,count:usize,cancelled:&std::sync::atomic::AtomicBool)->Result<(),String>{
    use std::sync::atomic::Ordering;
    if count==0||count>2_097_152{return Err("PCM window exceeds its 8MiB bound".into());}
    let mut pending=Vec::new();
    while let Ok(samples)=receiver.recv(){
        if cancelled.load(Ordering::Acquire){return Ok(());}pending.extend(samples);
        while pending.len()>=count{
            let rest=pending.split_off(count);let samples=std::mem::replace(&mut pending,rest);
            if windows.try_send(samples).is_err(){return Err("PCM window backlog exceeded its bounded queue; audio was not silently dropped".into());}
        }
    }
    if !pending.is_empty()&&!cancelled.load(Ordering::Acquire)&&windows.try_send(pending).is_err(){return Err("final PCM window exceeded its bounded queue".into());}
    Ok(())
}

fn validate(action:&Value)->Result<(),Value>{
    if let Some(error)=desktop_audio_shape_error(action){return Err(failure("invalid_request",error));}
    for (field,limit) in [("app",4096),("device",4096),("group",256),("groupColor",256)]{
        if action.get(field).is_some_and(|v|v.as_str().is_none_or(|s|s.trim().is_empty()||s.len()>limit||s.contains('\0'))){return Err(failure("invalid_request","audio target or group text is invalid"));}
    }
    if action["op"]!="start"&&(action.get("app").is_some()||action.get("device").is_some()||action["save"]==true)||action["sub"]=="input"&&action.get("app").is_some(){return Err(failure("invalid_request","audio target and save options require the appropriate start channel"));}
    Ok(())
}

pub(crate) struct AudioSession{helper:Option<crate::thumbnail::OwnedHelper>,input:ChildStdin,output:ChildStdout,file_path:Option<String>,pub(crate) terminal:Option<Value>}
impl AudioSession{
    pub(crate) fn request(&mut self,action:&Value,timeout:Duration)->Result<Value,Value>{
        if let Some(result)=&self.terminal{return Ok(result.clone());}
        let deadline=Instant::now()+timeout;
        let result=(||->io::Result<Value>{
            crate::write_frame(&mut self.input,&serde_json::to_vec(action)?)?;
            let bytes=crate::auth::bounded_child_result(|bytes|crate::auth::ready_read(&mut self.output,bytes),deadline,1_048_576)?;
            let result:Value=serde_json::from_slice(&bytes)?;
            if !result.is_object()||!result["success"].is_boolean()||result["success"]==true&&result.get("data").is_none()||result["success"]==false&&!result["error"].is_string(){return Err(io::Error::other("native media helper reply is malformed"));}
            Ok(result)
        })();
        result.map_err(|error|failure(if self.file_path.is_some()||action["save"]==true{"partial_result"}else if error.kind()==io::ErrorKind::TimedOut{"resource_limit"}else{"provider_failed"},format!("native media helper failed or exceeded its deadline: {error}; capture is killed and reaped; observe any saved file before retrying{}",self.file_path.as_deref().map(|p|format!(" ({p})")).unwrap_or_default())))
    }
    pub(crate) fn poll_exit(&mut self){
        if self.helper.as_mut().is_some_and(|h|!matches!(h.exited(),Ok(None))){
            let receipt=crate::auth::bounded_child_result(|bytes|crate::auth::ready_read(&mut self.output,bytes),Instant::now()+Duration::from_millis(150),1_048_576)
                .ok().and_then(|bytes|serde_json::from_slice::<Value>(&bytes).ok()).filter(|r|r["success"]==false&&r["error"].is_string());
            if self.terminal.is_none(){self.terminal=Some(receipt.unwrap_or_else(||failure(if self.file_path.is_some(){"partial_result"}else{"provider_failed"},"native media helper exited unexpectedly; its capture was reaped; observe any saved file before retrying")));}
            // Retire the retained group/job before AuthChild reaps the leader.
            // Keep its terminal error for operator readback through stop.
            drop(self.helper.take());
        }
    }
    pub(crate) fn retire(&mut self,result:Value){self.terminal=Some(result);drop(self.helper.take());}
    pub(crate) fn start(action:&Value)->Result<(Self,Value),Value>{
        Self::start_owned(action,"--audio-engine")
    }
    pub(crate) fn start_owned(action:&Value,mode:&str)->Result<(Self,Value),Value>{
        let mut helper=crate::thumbnail::OwnedHelper::spawn(mode).map_err(|e|failure("provider_failed",e))?;
        let input=helper.child.0.stdin.take().ok_or_else(||failure("provider_failed","native media helper input unavailable"))?;
        let output=helper.child.0.stdout.take().ok_or_else(||failure("provider_failed","native media helper output unavailable"))?;
        let mut session=Self{helper:Some(helper),input,output,file_path:None,terminal:None};
        let result=session.request(action,Duration::from_secs(10))?;
        if result["success"]!=true{return Err(result);}
        session.file_path=result["data"]["filePath"].as_str().map(str::to_owned);
        static WATCH:std::sync::Once=std::sync::Once::new();
        WATCH.call_once(||{std::thread::spawn(||loop{
            std::thread::sleep(Duration::from_millis(250));
            if let Ok(mut sessions)=SESSIONS.try_lock(){for session in sessions.iter_mut().flatten(){session.poll_exit();}}
            crate::vad::poll_exits();
            crate::speech::poll_exits();
            crate::sounds::poll_exits();
            crate::music::poll_exits();
        });});
        Ok((session,result))
    }
    pub(crate) fn stop(self,channel:&str)->Value{
        self.stop_with(&json!({"type":"desktop_audio","sub":channel,"op":"stop"}))
    }
    pub(crate) fn stop_with(mut self,action:&Value)->Value{
        let seconds=if matches!(action["type"].as_str(),Some("desktop_listen"|"desktop_sounds")){12}else{5};
        let result=match self.request(action,Duration::from_secs(seconds)){Ok(v)=>v,Err(e)=>return e};
        let Some(helper)=self.helper.as_mut()else{return result;};
        let deadline=Instant::now()+Duration::from_secs(1);
        loop{match helper.exited(){
            Ok(Some(true))=>return result,
            Ok(Some(false))|Err(_)=>return failure("partial_result","native media helper failed during shutdown; saved output may be incomplete"),
            Ok(None)if Instant::now()<deadline=>std::thread::sleep(Duration::from_millis(5)),
            _=>return failure("partial_result","native media helper acknowledged stop but did not exit; it was killed and reaped"),
        }}
    }
}
fn inactive()->Value{json!({"active":false,"level":null,"peak":null,"frames":0})}
fn channel(action:&Value,index:usize)->Value{let mut a=action.clone();a["sub"]=json!(if index==0{"input"}else{"output"});if let Some(o)=a.as_object_mut(){if index==0{o.remove("app");}else if action["sub"]=="both"{o.remove("device");}}a}
fn start(sessions:&mut [Option<AudioSession>;2],action:&Value,index:usize)->Value{
    if sessions[index].is_some(){return failure("invalid_request","audio capture already active");}
    let a=channel(action,index);
    match AudioSession::start(&a){Ok((s,result))=>{sessions[index]=Some(s);result},Err(e)=>e}
}
fn stop(sessions:&mut [Option<AudioSession>;2],index:usize)->Value{sessions[index].take().map(|s|s.stop(if index==0{"input"}else{"output"})).unwrap_or_else(||success(json!(format!("no active {} capture",if index==0{"input"}else{"output"}))))}
pub fn shutdown()->Value{
    let Ok(mut sessions)=SESSIONS.try_lock()else{return failure("invalid_request","audio lifecycle busy; retry shutdown after its current bounded action");};
    let input=stop(&mut sessions,0);let output=stop(&mut sessions,1);
    if input["success"]==true&&output["success"]==true{success(json!({"stopping":true}))}else{failure("partial_result",format!("audio shutdown reaped both captures; saved file closure failed: input={input}, output={output}"))}
}
pub fn dispatch(action:&Value)->Value{
    if let Err(e)=validate(action){return e;}
    let Ok(mut sessions)=SESSIONS.try_lock()else{return failure("invalid_request","audio lifecycle busy; no work was queued");};
    if action["op"]=="devices"{return match crate::thumbnail::image_helper("--audio-devices",action,Instant::now()+Duration::from_secs(10)){Ok(v)=>success(v),Err(e)=>e};}
    let indices=if action["sub"]=="both"{vec![1,0]}else{vec![usize::from(action["sub"]=="output")]};
    if action["op"]=="start"&&indices.iter().any(|&i|sessions[i].is_some()){return failure("invalid_request","requested audio channel is already active");}
    let mut rows=Vec::new();
    for &index in &indices{
        let result=match action["op"].as_str().unwrap(){
            "start"=>start(&mut sessions,action,index),
            "stop"=>stop(&mut sessions,index),
            _=>if let Some(session)=sessions[index].as_mut(){match session.request(&json!({"type":"desktop_audio","sub":if index==0{"input"}else{"output"},"op":"level"}),Duration::from_secs(2)){Ok(v)=>v,Err(e)=>{sessions[index]=None;e}}}else{success(inactive())},
        };
        if result["success"]!=true&&action["op"]=="start"{
            if action["sub"]=="both"&&index==0{let rollback=stop(&mut sessions,1);return failure("partial_result",format!("input start failed: {result}; newly started output rollback: {rollback}"));}return result;
        }
        rows.push(result);
    }
    if action["sub"]!="both"{return rows.remove(0);}
    if rows.iter().any(|r|r["success"]!=true){return failure("partial_result",format!("one or more audio channels failed: output={}, input={}",rows[0],rows[1]));}
    match action["op"].as_str().unwrap(){
        "start"=>{let mut data=json!({"input":"started","output":"started"});for (index,name)in [(0,"inputFilePath"),(1,"outputFilePath")]{if let Some(path)=sessions[index].as_ref().and_then(|s|s.file_path.as_ref()){data[name]=json!(path);}}success(data)},
        "stop"=>success(json!("stopped both")),
        _=>success(json!({"input":rows[1]["data"],"output":rows[0]["data"]})),
    }
}

pub(crate) struct WaveFile{file:File,channels:u16,rate:u32,bytes:u64,header_size:u64}
impl WaveFile{
    fn header(channels:u16,rate:u32,bytes:u64)->io::Result<Vec<u8>>{
        if channels==0||channels>64||rate==0||rate>1_000_000||bytes>MAX_SAVED_BYTES||bytes%(u64::from(channels)*4)!=0{return Err(io::Error::other("invalid bounded float32 WAV dimensions"));}
        let extended=channels>2;let size=if extended{80}else{58};
        let mut h=Vec::with_capacity(size);h.extend(b"RIFF");h.extend((size as u32-8+bytes as u32).to_le_bytes());h.extend(b"WAVEfmt ");h.extend((if extended{40u32}else{18u32}).to_le_bytes());h.extend((if extended{0xfffeu16}else{3u16}).to_le_bytes());h.extend(channels.to_le_bytes());h.extend(rate.to_le_bytes());h.extend((rate*u32::from(channels)*4).to_le_bytes());h.extend((channels*4).to_le_bytes());h.extend(32u16.to_le_bytes());h.extend((if extended{22u16}else{0u16}).to_le_bytes());
        if extended{
            // No speaker positions are invented: channel-mask0 preserves
            // native channel order as unspecified WAVEFORMATEXTENSIBLE audio.
            h.extend(32u16.to_le_bytes());h.extend(0u32.to_le_bytes());h.extend([3,0,0,0,0,0,0x10,0,0x80,0,0,0xaa,0,0x38,0x9b,0x71]);
        }
        h.extend(b"fact");h.extend(4u32.to_le_bytes());h.extend((bytes as u32/(u32::from(channels)*4)).to_le_bytes());h.extend(b"data");h.extend((bytes as u32).to_le_bytes());Ok(h)
    }
    fn create(channels:u16,rate:u32,channel:&str)->io::Result<(Self,String)>{
        let directory=crate::filesystem::temp_dir()?.join(format!("interceptor-audio-{}",crate::monitor::identifier()));
        crate::monitor::private_directory(&directory,true,false)?;
        let path=directory.join(format!("{channel}.wav"));
        let wave=Self::create_at(&path,channels,rate)?;
        let path=path.to_str().ok_or_else(||io::Error::other("audio output path is not UTF-8"))?.to_owned();
        Ok((wave,path))
    }
    pub(crate) fn create_at(path:&std::path::Path,channels:u16,rate:u32)->io::Result<Self>{
        let header=Self::header(channels,rate,0)?;
        let mut file=crate::monitor::private_file(path,true)?;file.write_all(&header)?;
        Ok(Self{file,channels,rate,bytes:0,header_size:header.len()as u64})
    }
    pub(crate) fn append(&mut self,samples:&[f32])->io::Result<()>{
        if samples.is_empty()||samples.len()>MAX_SAMPLES||samples.len()%usize::from(self.channels)!=0||samples.iter().any(|s|!s.is_finite()){return Err(io::Error::other("audio buffer has invalid PCM samples"));}
        let bytes=(samples.len()*4)as u64;if self.bytes+bytes>MAX_SAVED_BYTES{return Err(io::Error::new(io::ErrorKind::FileTooLarge,"saved audio exceeds 512MiB"));}
        let mut encoded=Vec::with_capacity(bytes as usize);for sample in samples{encoded.extend(sample.to_le_bytes());}
        self.file.seek(SeekFrom::Start(self.header_size+self.bytes))?;self.file.write_all(&encoded)?;self.bytes+=bytes;Ok(())
    }
    pub(crate) fn finish(mut self)->io::Result<()>{self.file.seek(SeekFrom::Start(0))?;self.file.write_all(&Self::header(self.channels,self.rate,self.bytes)?)?;self.file.sync_all()}
}
#[derive(Default)]
pub(crate) struct PcmState{pub(crate) active:bool,pub(crate) channels:u16,pub(crate) rate:u32,metrics:Option<(f64,f64,u64,f64)>,pub(crate) error:Option<String>,file_path:Option<String>}
impl PcmState{
    fn accept(&mut self,samples:Vec<f32>,sink:Option<&std::sync::mpsc::SyncSender<Vec<f32>>>){
        if !self.active{return;}
        let Some(measured)=Self::measured(&samples,self.channels)else{self.active=false;self.error=Some("native PCM samples are non-finite, incomplete or oversized".into());return;};
        self.metrics=Some(measured);
        if sink.is_some_and(|s|s.try_send(samples).is_err()){self.active=false;self.error=Some("native PCM consumer queue overflowed (writer stalled) or closed".into());}
    }
    fn measured(samples:&[f32],channels:u16)->Option<(f64,f64,u64,f64)>{
        if channels==0||channels>64||samples.is_empty()||samples.len()>MAX_SAMPLES||samples.len()/usize::from(channels)>262_144||samples.len()%usize::from(channels)!=0{return None;}
        let mut sum=0.0;let mut peak:f64=0.0;for &sample in samples{if !sample.is_finite(){return None;}let n=f64::from(sample);sum+=n*n;peak=peak.max(n.abs());}
        let level=(sum/samples.len()as f64).sqrt();if !level.is_finite(){return None;}
        Some((level,peak,(samples.len()/usize::from(channels))as u64,time::OffsetDateTime::now_utc().unix_timestamp_nanos()as f64/1e9))
    }
    fn snapshot(&self)->Value{
        let mut data=inactive();data["active"]=json!(self.active);data["channels"]=json!(self.channels);data["sampleRate"]=json!(self.rate);
        if let Some((rms,peak,frames,timestamp))=self.metrics{data["level"]=json!(rms);data["peak"]=json!(peak);data["frames"]=json!(frames);data["timestamp"]=json!(timestamp);}
        if let Some(path)=&self.file_path{data["filePath"]=json!(path);}if let Some(error)=&self.error{data["error"]=json!(error);}data
    }
}

fn app_pid(rows:&Value,requested:&str)->Result<u32,Value>{
    let rows=rows.as_array().filter(|r|r.len()<=2000).ok_or_else(||failure("provider_failed","native application inventory is malformed or oversized"))?;
    let matching=rows.iter().filter(|r|r["name"].as_str().is_some_and(|n|n.trim_end_matches(".exe").eq_ignore_ascii_case(requested.trim_end_matches(".exe"))))
        .filter_map(|r|r["pid"].as_u64().and_then(|n|u32::try_from(n).ok()).filter(|n|*n>0)).collect::<std::collections::BTreeSet<_>>();
    if matching.len()!=1{return Err(failure("unsupported_target","audio app requires one exact current native application name; ambiguous targets refuse"));}Ok(*matching.first().unwrap())
}
#[cfg(any(windows,target_os="linux"))]fn target_pid(action:&Value)->Result<u32,Value>{
    #[cfg(windows)]let result=crate::windows::dispatch("apps",&json!({"app":action["app"]}));
    #[cfg(target_os="linux")]let result=crate::linux::dispatch("apps",&json!({"app":action["app"]}));
    if result["success"]!=true{return Err(result);}app_pid(&result["data"],action["app"].as_str().unwrap())
}
#[cfg(any(windows,target_os="linux"))]pub(crate) enum Engine{Device(cpal::Stream),App(app::Source)}
#[cfg(any(windows,target_os="linux"))]impl Engine{
    pub(crate) fn open(action:&Value,state:&Arc<Mutex<PcmState>>,sink:Option<std::sync::mpsc::SyncSender<Vec<f32>>>)->Result<Self,Value>{
        if action.get("app").is_some(){return app::Source::open(action).map(Self::App);}
        let host=host()?;let device=selected_device(&host,action)?;let identity=device.id().map_err(native_error)?;
        #[cfg(windows)]let config=if action["sub"]=="output"{device.default_output_config()}else{device.default_input_config()}.map_err(native_error)?;
        #[cfg(target_os="linux")]let config=device.default_input_config().map_err(native_error)?;
        let (channels,rate)=(config.channels(),config.sample_rate());if channels==0||channels>64||rate==0||rate>1_000_000{return Err(failure("unsupported_target","native device has no bounded PCM format"));}
        {let mut state=state.lock().unwrap();state.channels=channels;state.rate=rate;}
        let capture=state.clone();let errors=state.clone();
        if device.id().map_err(native_error)?!=identity{return Err(failure("target_gone","audio device identity changed before capture"));}
        device.build_input_stream_raw(config.config(),config.sample_format(),move|data,_|{
            let mut state=capture.lock().unwrap();if !state.active{return;}
            match samples(data){Some(samples)=>state.accept(samples,sink.as_ref()),None=>{state.active=false;state.error=Some("native PCM sample format or buffer exceeds its bound".into());}}
        },move|error|{
            // An xrun is a dropped buffer (a glitch) on a busy host, not a dead stream; keep capturing.
            if error.kind()==cpal::ErrorKind::Xrun{return;}
            let mut state=errors.lock().unwrap();state.active=false;state.error=Some(format!("native audio capture stopped: {error}"));},Some(Duration::from_secs(5))).map(Self::Device).map_err(native_error)
    }
    pub(crate) fn play(&mut self)->Result<(),Value>{match self{Self::Device(stream)=>stream.play().map_err(native_error),Self::App(stream)=>stream.play()}}
    pub(crate) fn stop(mut self)->Result<(),Value>{match &mut self{Self::Device(_)=>Ok(()),Self::App(stream)=>stream.stop()}}
    fn tick(&mut self,state:&Arc<Mutex<PcmState>>,sink:Option<&std::sync::mpsc::SyncSender<Vec<f32>>>){
        if let Self::App(stream)=self{match stream.next(){Ok(Some(samples))=>state.lock().unwrap().accept(samples,sink),Ok(None)=>(),Err(error)=>{let mut state=state.lock().unwrap();state.active=false;state.error=Some(error.to_string());}}}
    }
}

#[cfg(any(windows,target_os="linux"))]fn native_error(error:cpal::Error)->Value{
    failure(match error.kind(){cpal::ErrorKind::PermissionDenied=>"permission_denied",cpal::ErrorKind::DeviceNotAvailable=>"target_gone",cpal::ErrorKind::UnsupportedConfig|cpal::ErrorKind::UnsupportedOperation=>"unsupported_operation",_=>"provider_failed"},error)
}
#[cfg(any(windows,target_os="linux"))]fn host()->Result<cpal::Host,Value>{
    #[cfg(windows)]let id=cpal::HostId::Wasapi;
    #[cfg(target_os="linux")]let id=cpal::HostId::PulseAudio;
    cpal::host_from_id(id).map_err(native_error)
}
#[cfg(any(windows,target_os="linux"))]fn device_list(host:&cpal::Host,role:&str)->Result<Vec<cpal::Device>,Value>{
    let iter=if role=="input"{host.input_devices()}else{host.output_devices()}.map_err(native_error)?;
    let devices=iter.take(513).collect::<Vec<_>>();if devices.len()>512{return Err(failure("resource_limit","audio device inventory exceeds 512 entries"));}Ok(devices)
}
#[cfg(any(windows,target_os="linux"))]fn devices(action:&Value)->Result<Value,Value>{
    let host=host()?;
    let rows=|role:&str|->Result<Value,Value>{
        let default=if role=="input"{host.default_input_device()}else{host.default_output_device()}.map(|d|d.id()).transpose().map_err(native_error)?;
        let mut rows=Vec::new();for device in device_list(&host,role)?{
            let id=device.id().map_err(native_error)?;let description=device.description().map_err(native_error)?;
            let config=if role=="input"{device.default_input_config()}else{device.default_output_config()}.map_err(native_error)?;
            if id.to_string().len()>4096||description.name().len()>4096{return Err(failure("resource_limit","native audio identity is oversized"));}
            rows.push(json!({"uniqueID":id.to_string(),"deviceID":id.to_string(),"localizedName":description.name(),"manufacturer":description.manufacturer(),"modelID":null,"deviceType":id.host().to_string(),"isConnected":true,"role":role,"channels":config.channels(),"sampleRate":config.sample_rate(),"isDefault":default.as_ref()==Some(&id)}));
        }Ok(json!(rows))
    };
    if action["sub"]=="both"{return Ok(json!({"input":rows("input")?,"output":rows("output")?}));}
    if action["sub"]=="output"{return rows("output");}
    let input=rows("input")?;let default=input.as_array().unwrap().iter().find(|r|r["isDefault"]==true).map(|r|json!({"channels":r["channels"],"sampleRate":r["sampleRate"]})).unwrap_or(Value::Null);
    Ok(json!({"defaultInput":default,"count":input.as_array().unwrap().len(),"devices":input}))
}
#[cfg(any(windows,target_os="linux"))]fn selected_device(host:&cpal::Host,action:&Value)->Result<cpal::Device,Value>{
    let role=action["sub"].as_str().unwrap();let default=if role=="input"{host.default_input_device()}else{host.default_output_device()};
    let device=if let Some(requested)=action["device"].as_str(){
        let mut found=Vec::new();for device in device_list(host,role)?{let id=device.id().map_err(native_error)?;let name=device.description().map_err(native_error)?;if id.to_string()==requested||name.name()==requested{found.push(device);}}
        if found.len()!=1{return Err(failure("target_gone","audio device selector requires one current native device identity or unique exact name"));}found.remove(0)
    }else{default.ok_or_else(||failure("target_gone","no native default audio device"))?};
    #[cfg(target_os="linux")]if role=="output"{
        let sink_id=device.id().map_err(native_error)?;
        // Ask the server for its actual sink/monitor relationship. A name
        // ending in .monitor alone does not establish the selected target.
        let client=pulseaudio::Client::from_env(c"interceptor-audio-target").map_err(|e|failure("provider_failed",e))?;
        let name=std::ffi::CString::new(sink_id.id()).map_err(|_|failure("provider_failed","native sink name contains NUL"))?;
        let sink=futures::executor::block_on(client.sink_info_by_name(name)).map_err(|e|failure("target_gone",e))?;
        let monitor=sink.monitor_source_index.ok_or_else(||failure("unsupported_target","selected output has no native monitor"))?;
        let source_info=futures::executor::block_on(client.source_info(monitor)).map_err(|e|failure("target_gone",e))?;
        if source_info.monitor_of_sink_index!=Some(sink.index)||source_info.monitor_of_sink_name.as_ref().map(|n|n.as_bytes())!=Some(sink.name.as_bytes())||sink.monitor_source_name.as_ref().map(|n|n.as_bytes())!=Some(source_info.name.as_bytes()){
            return Err(failure("target_gone","native sink/monitor identity changed or does not agree"));
        }
        let mut sources=Vec::new();for source in device_list(host,"input")?{
            let id=source.id().map_err(native_error)?;
            if id.id().as_bytes()==source_info.name.as_bytes(){sources.push(source);}
        }
        if sources.len()!=1{return Err(failure("unsupported_target","selected output has no uniquely identified native monitor source"));}return Ok(sources.remove(0));
    }
    Ok(device)
}
#[cfg(any(windows,target_os="linux"))]fn samples(data:&cpal::Data)->Option<Vec<f32>>{
    if data.len()==0||data.len()>MAX_SAMPLES{return None;}
    use cpal::{Sample,SampleFormat};
    macro_rules! convert{($t:ty)=>{data.as_slice::<$t>().map(|s|s.iter().map(|n|n.to_sample::<f32>()).collect())};}
    match data.sample_format(){SampleFormat::I8=>convert!(i8),SampleFormat::I16=>convert!(i16),SampleFormat::I24=>convert!(cpal::I24),SampleFormat::I32=>convert!(i32),SampleFormat::I64=>convert!(i64),SampleFormat::U8=>convert!(u8),SampleFormat::U16=>convert!(u16),SampleFormat::U24=>convert!(cpal::U24),SampleFormat::U32=>convert!(u32),SampleFormat::U64=>convert!(u64),SampleFormat::F32=>convert!(f32),SampleFormat::F64=>convert!(f64),_=>None}
}
#[cfg(any(windows,target_os="linux"))]pub fn helper(inventory:bool,parent:u32)->io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    #[cfg(unix)]{let limit=libc::rlimit{rlim_cur:512*1024*1024,rlim_max:512*1024*1024};if unsafe{libc::setrlimit(libc::RLIMIT_AS,&limit)}!=0{return Err(io::Error::other("native media helper memory limit failed"));}}
    let initial=crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("native media helper requires a request"))?;
    let action:Value=serde_json::from_slice(&initial)?;
    let reply=|r:&Value|crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(r)?);
    if let Err(error)=validate(&action){return reply(&error);}
    if inventory{return reply(&match devices(&action){Ok(v)=>success(v),Err(e)=>e});}
    if action["op"]!="start"||action["sub"]=="both"{return reply(&failure("invalid_request","audio engine requires one channel start"));}
    #[cfg(target_os="linux")]let login=match crate::linux::login_identity(0){Some(l)=>l,None=>return reply(&failure("permission_denied","audio capture requires the current GUI login"))};
    let initialized=(||->Result<_,Value>{
        let save=action["save"]==true;
        let state=Arc::new(Mutex::new(PcmState{active:false,channels:2,rate:48000,metrics:None,error:None,file_path:None}));
        // Depth 256 (~a few seconds of buffers) absorbs a transient WAV-writer disk stall on a loaded
        // host; the capture still fails rather than growing unbounded if the writer is truly stuck.
        let (tx,rx)=std::sync::mpsc::sync_channel::<Vec<f32>>(256);
        let mut stream=Engine::open(&action,&state,save.then(||tx.clone()))?;
        let (channels,rate)={let state=state.lock().unwrap();(state.channels,state.rate)};
        // Device/driver admission happens before any saved-file creation.
        // Callbacks remain gated until the private writer is ready.
        let saved=if save{Some(WaveFile::create(channels,rate,action["sub"].as_str().unwrap()).map_err(|e|failure("provider_failed",e))?)}else{None};
        let path=saved.as_ref().map(|(_,p)|p.clone());
        let writer_state=state.clone();let worker=saved.map(|(mut wave,_)|std::thread::spawn(move||{
            let mut failed=None;while let Ok(samples)=rx.recv(){if failed.is_none(){if let Err(error)=wave.append(&samples){let mut state=writer_state.lock().unwrap();state.error=Some(format!("saved audio write failed: {error}"));state.active=false;failed=Some(error);}}}
            let finalized=wave.finish();if let Some(error)=failed{Err(error)}else{finalized}
        }));
        {let mut state=state.lock().unwrap();state.file_path=path.clone();state.active=state.error.is_none();}
        if let Err(error)=stream.play(){
            state.lock().unwrap().active=false;drop(stream);drop(tx);
            let closed=worker.map(|w|w.join().map_err(|_|io::Error::other("audio writer failed")).and_then(|r|r)).transpose();
            if let Some(path)=path{return Err(failure("partial_result",format!("native capture start failed: {error}; saved file at {path}; writer finalization: {closed:?}")));}
            return Err(error);
        }
        let mut started=if action["sub"]=="input"{json!({"message":format!("audio input capture started ({rate}Hz)"),"sampleRate":rate,"channels":channels})}else if path.is_some(){json!({"message":"audio output capture started"})}else{json!("audio output capture started")};
        if let Some(path)=path{started["filePath"]=json!(path);}Ok((stream,state,tx,worker,started))
    })();
    let (stream,state,tx,worker,started)=match initialized{Ok(v)=>v,Err(e)=>return reply(&e)};
    reply(&success(started.clone()))?;
    let (commands,received)=std::sync::mpsc::sync_channel(2);
    std::thread::spawn(move||{let mut input=io::stdin().lock();loop{let r=crate::read_frame(&mut input);let end=!matches!(&r,Ok(Some(_)));if commands.send(r).is_err()||end{break;}}});
    let mut stream=Some(stream);let mut stop=true;
    loop{
        #[cfg(target_os="linux")]if crate::linux::login_identity(0)!=Some(login.clone()){state.lock().unwrap().error=Some("GUI login changed; audio capture revoked".into());break;}
        if state.lock().unwrap().error.is_some(){state.lock().unwrap().active=false;drop(stream.take());}
        if let Some(stream)=stream.as_mut(){stream.tick(&state,(action["save"]==true).then_some(&tx));}
        match received.recv_timeout(Duration::from_millis(50)){
            Ok(Ok(Some(bytes)))=>{
                let a:Value=serde_json::from_slice(&bytes)?;
                if a["type"]!="desktop_audio"||a["sub"]!=action["sub"]||a.as_object().is_none_or(|o|o.len()!=3){reply(&failure("invalid_request","native media helper control requires its exact channel and operation"))?;continue;}
                match a["op"].as_str(){Some("level")=>reply(&success(state.lock().unwrap().snapshot()))?,Some("stop")=>break,_=>reply(&failure("invalid_request","unsupported native media helper control"))?}
            },Ok(Err(e))=>return Err(e),Ok(Ok(None))|Err(std::sync::mpsc::RecvTimeoutError::Disconnected)=>{stop=false;break;},Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>(),
        }
    }
    state.lock().unwrap().active=false;
    let stopped=stream.take().map(Engine::stop).transpose();drop(stream);drop(tx);
    let finalized=worker.map(|w|w.join().map_err(|_|io::Error::other("audio writer failed")).and_then(|r|r)).transpose();
    let state=state.lock().unwrap();let result=if let Some(error)=&state.error{failure("partial_result",error)}else if let Err(error)=stopped{failure("partial_result",format!("native app capture stop failed: {error}"))}else if let Err(error)=finalized{failure("partial_result",format!("saved audio finalization failed: {error}"))}else{
        let mut data=json!({"message":format!("audio {} capture stopped",action["sub"].as_str().unwrap())});if let Some(path)=&state.file_path{data["filePath"]=json!(path);}success(data)
    };if stop{reply(&result)?;}Ok(())
}
#[cfg(not(any(windows,target_os="linux")))]pub fn helper(_:bool,_:u32)->io::Result<()>{Err(io::Error::other("portable audio requires Windows or Linux"))}
pub fn capability(session:&str)->Value{json!({"operation":"audio","compiled":cfg!(any(windows,target_os="linux")),"present":cfg!(any(windows,target_os="linux")),"effective":false,"background":"semantic","permission":"unknown","session":session,"provider":if cfg!(windows){"WASAPI"}else{"PulseAudio/PipeWire pulse"},"versions":{"contract":"1","cpal":"0.18.2"},"limits":["Availability is established only by real native device enumeration and capture; this discovery call does not probe hardware or claim permission.","Owned helpers, bounded native initialization/control, stable native device selectors, 512MiB float32 WAV saves, 8MiB writer queue; Windows app output uses native process-tree loopback, Linux app output uses one exact Pulse sink input and refuses multiple streams.","Linux requires a current GUI login and its PulseAudio or pipewire-pulse server; app capture additionally needs native pactl/parec. Stream process properties are server metadata, not a cryptographic process attestation. ALSA is linked by CPAL but is not a silent capture fallback."]})}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn pcm_wave_and_audio_request_bounds(){
        let values=[0.25,-0.5,0.75,-0.5,0.25,-0.5,0.75,-0.5];let (rms,peak,frames,_)=PcmState::measured(&values,2).unwrap();assert!((rms-0.28125f64.sqrt()).abs()<1e-12);assert_eq!(peak,0.75);assert_eq!(frames,4);assert!(PcmState::measured(&[f32::NAN],1).is_none());assert!(PcmState::measured(&values,3).is_none());
        let (mut wave,path)=WaveFile::create(2,48000,"input").unwrap();wave.append(&values).unwrap();wave.finish().unwrap();let bytes=std::fs::read(&path).unwrap();assert_eq!(&bytes[..4],b"RIFF");assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap())as usize,bytes.len()-8);assert_eq!(u32::from_le_bytes(bytes[46..50].try_into().unwrap()),4);assert_eq!(u32::from_le_bytes(bytes[54..58].try_into().unwrap()),32);for(i,value)in values.iter().enumerate(){assert_eq!(f32::from_le_bytes(bytes[58+i*4..62+i*4].try_into().unwrap()),*value);}
        #[cfg(unix)]{use std::os::unix::fs::MetadataExt;assert_eq!(std::fs::metadata(&path).unwrap().mode()&0o777,0o600);}
        assert!(WaveFile::header(0,48000,0).is_err());assert!(WaveFile::header(2,48000,1).is_err());
        let extended=WaveFile::header(4,48000,32).unwrap();assert_eq!(extended.len(),80);assert_eq!(&extended[20..22],&0xfffeu16.to_le_bytes());assert_eq!(&extended[36..38],&22u16.to_le_bytes());assert_eq!(&extended[40..44],&0u32.to_le_bytes());assert_eq!(&extended[44..48],&3u32.to_le_bytes());assert_eq!(&extended[60..64],b"fact");assert_eq!(&extended[72..76],b"data");
        assert!(validate(&json!({"type":"desktop_audio","sub":"input","op":"start","save":true})).is_ok());for a in [json!({"type":"desktop_audio","sub":"both","op":"wat"}),json!({"type":"desktop_audio","sub":"input","op":"start","app":"x"}),json!({"type":"desktop_audio","sub":"output","op":"level","save":true}),json!({"type":"desktop_audio","sub":"input","op":"start","device":null})]{assert!(validate(&a).is_err());}
        assert_eq!(channel(&json!({"type":"desktop_audio","sub":"output","op":"start","device":"wasapi:exact"}),1)["device"],"wasapi:exact");
        let both=json!({"type":"desktop_audio","sub":"both","op":"start","app":"App","device":"input-id"});assert_eq!(channel(&both,0)["device"],"input-id");assert!(channel(&both,0).get("app").is_none());assert!(channel(&both,1).get("device").is_none());assert_eq!(channel(&both,1)["app"],"App");
        assert_eq!(app_pid(&json!([{"name":"App","pid":23}]),"App").unwrap(),23);
        assert!(app_pid(&json!([{"name":"App","pid":23},{"name":"App","pid":24}]),"App").is_err());
        assert!(app_pid(&json!([{"name":"App-extra","pid":23}]),"App").is_err());
        #[cfg(target_os="linux")]{let row=json!({"index":8,"sink":4,"properties":{"application.process.id":"23"}});assert_eq!(app::stream_identity(&row,23),Some((8,4)));assert_eq!(app::stream_identity(&row,24),None);assert_eq!(app::stream_identity(&json!({"index":8,"sink":4,"properties":{"application.process.id":23}}),23),None);}
        assert!(serde_json::from_value::<DesktopCapability>(capability("fixture")).is_ok());
        #[cfg(any(windows,target_os="linux"))]assert_eq!(native_error(cpal::Error::with_message(cpal::ErrorKind::HostUnavailable,"native server unavailable"))["code"],"provider_failed");
    }
}
