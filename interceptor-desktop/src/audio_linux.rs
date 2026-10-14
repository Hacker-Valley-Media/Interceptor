use super::*;
use std::{path::{Path,PathBuf},process::{Command,Stdio,ChildStdout}};

fn tool(name:&str)->Result<PathBuf,Value>{
    ["/usr/bin","/bin"].iter().map(|root|Path::new(root).join(name)).find(|p|p.is_file()).ok_or_else(||failure("not_installed",format!("app-scoped audio requires the native {name} tool (pulseaudio-utils or Arch pulseaudio)")))
}
fn streams()->Result<Value,Value>{
    let (status,bytes,_)=crate::container::capture(&tool("pactl")?,&["--format=json".into(),"list".into(),"sink-inputs".into()],Instant::now()+Duration::from_secs(2),1_048_576)?;
    if !status.success(){return Err(failure("provider_failed","native PulseAudio stream inventory failed"));}
    let rows:Value=serde_json::from_slice(&bytes).map_err(|_|failure("provider_failed","native PulseAudio stream inventory is malformed"))?;
    if rows.as_array().is_none_or(|r|r.len()>512){return Err(failure("resource_limit","native PulseAudio stream inventory exceeds 512 entries"));}Ok(rows)
}
pub(super) fn stream_identity(row:&Value,pid:u32)->Option<(u32,u32)>{
    let reported=row["properties"]["application.process.id"].as_str()?.parse::<u32>().ok()?;
    (reported==pid).then(||Some((u32::try_from(row["index"].as_u64()?).ok()?,u32::try_from(row["sink"].as_u64()?).ok()?)))?
}
pub(super) struct Source{target:crate::linux::CaptureIdentity,pid:u32,executable:PathBuf,index:u32,sink:u32,monitor:String,child:Option<crate::auth::AuthChild>,output:Option<ChildStdout>,pending:Vec<u8>,checked:Instant}
impl Source{
    pub(super) fn open(action:&Value)->Result<Self,Value>{
        let pid=super::target_pid(action)?;let target=crate::linux::capture_identity(pid)?;
        let executable=std::fs::read_link(format!("/proc/{pid}/exe")).map_err(|_|failure("target_gone","audio application executable unavailable"))?;
        let rows=streams()?;let mut matching=rows.as_array().unwrap().iter().filter_map(|r|stream_identity(r,pid));
        let (index,sink)=matching.next().ok_or_else(||failure("unsupported_target","requested application has no current native playback stream"))?;
        // ponytail: a Pulse monitor selects one sink input. Multiple app
        // streams need a timestamp-aware mixer, never a full-sink fallback.
        if matching.next().is_some(){return Err(failure("unsupported_target","application has multiple playback streams; exact timestamp-aware mixing is required, no system capture was started"));}
        let client=pulseaudio::Client::from_env(c"interceptor-app-audio").map_err(|e|failure("provider_failed",e))?;
        let info=futures::executor::block_on(client.sink_info(sink)).map_err(|e|failure("target_gone",e))?;
        let source=futures::executor::block_on(client.source_info(info.monitor_source_index.ok_or_else(||failure("unsupported_target","application output has no native monitor"))?)).map_err(|e|failure("target_gone",e))?;
        if source.monitor_of_sink_index!=Some(sink)||info.monitor_source_name.as_ref().map(|n|n.as_bytes())!=Some(source.name.as_bytes())||source.monitor_of_sink_name.as_ref().map(|n|n.as_bytes())!=Some(info.name.as_bytes()){return Err(failure("target_gone","native application sink/monitor identity changed"));}
        let monitor=source.name.to_str().map_err(|_|failure("unsupported_target","native monitor name is not UTF-8"))?.to_owned();
        if monitor.is_empty()||monitor.len()>4096||monitor.contains('\0'){return Err(failure("provider_failed","native monitor name exceeds its bound"));}
        if let Some(device)=action["device"].as_str(){
            let host=super::host()?;let mut found=false;for d in super::device_list(&host,"output")?{let id=d.id().map_err(super::native_error)?;let name=d.description().map_err(super::native_error)?;if (id.to_string()==device||name.name()==device)&&id.id().as_bytes()==info.name.as_bytes(){found=true;}}
            if !found{return Err(failure("unsupported_target","selected device is not this application's current output sink"));}
        }
        Ok(Self{target,pid,executable,index,sink,monitor,child:None,output:None,pending:Vec::new(),checked:Instant::now()})
    }
    fn current(&self)->Result<(),Value>{
        if !self.target.alive()||std::fs::read_link(format!("/proc/{}/exe",self.pid)).ok().as_ref()!=Some(&self.executable){return Err(failure("target_gone","retained audio application exited or changed executable"));}
        let rows=streams()?;let matching=rows.as_array().unwrap().iter().filter_map(|r|stream_identity(r,self.pid)).collect::<Vec<_>>();
        if matching!=[(self.index,self.sink)]{return Err(failure("target_gone","application playback stream exited, moved, changed identity or gained another stream; capture revoked"));}Ok(())
    }
    pub(super) fn play(&mut self)->Result<(),Value>{
        self.current()?;let mut command=Command::new(tool("parec")?);
        command.args(["--raw","--format=float32le","--channels=2","--rate=48000","--latency-msec=20","--client-name=Interceptor"])
            .arg(format!("--device={}",self.monitor)).arg(format!("--monitor-stream={}",self.index)).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        // Inherit the audio helper's retained process group. Its parent owns
        // the whole group through startup, failure and provider death.
        let mut child=crate::auth::AuthChild(command.spawn().map_err(|e|failure("provider_failed",e))?);
        self.output=child.0.stdout.take();self.child=Some(child);self.current()?;Ok(())
    }
    pub(super) fn next(&mut self)->Result<Option<Vec<f32>>,Value>{
        if !self.target.alive(){return Err(failure("target_gone","retained audio application exited"));}
        if self.checked.elapsed()>=Duration::from_millis(250){self.current()?;self.checked=Instant::now();}
        let output=self.output.as_mut().ok_or_else(||failure("provider_failed","native app audio was not started"))?;
        let mut bytes=[0u8;32768];match crate::auth::ready_read(output,&mut bytes){
            Ok(0)=>return Err(failure("provider_failed","native application audio stream closed")),
            Ok(n)=>self.pending.extend_from_slice(&bytes[..n]),
            Err(e)if matches!(e.kind(),io::ErrorKind::WouldBlock|io::ErrorKind::Interrupted)=>return Ok(None),
            Err(e)=>return Err(failure("provider_failed",e)),
        }
        let length=self.pending.len()/8*8;if length==0{return Ok(None);}
        let samples=self.pending[..length].chunks_exact(4).map(|s|f32::from_le_bytes(s.try_into().unwrap())).collect();self.pending.drain(..length);Ok(Some(samples))
    }
    pub(super) fn stop(&mut self)->Result<(),Value>{
        self.output.take();if let Some(mut child)=self.child.take(){
            if child.0.try_wait().map_err(|e|failure("provider_failed",e))?.is_none(){child.0.kill().map_err(|e|failure("provider_failed",e))?;}
            child.0.wait().map_err(|e|failure("provider_failed",e))?;
        }Ok(())
    }
}
