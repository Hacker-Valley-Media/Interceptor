use super::*;
use windows::{core::{Interface,implement,IUnknown,HRESULT,Ref},Win32::{Media::Audio::*,System::{Com::{CoInitializeEx,CoUninitialize,COINIT_MULTITHREADED,BLOB,StructuredStorage::{PROPVARIANT,PROPVARIANT_0,PROPVARIANT_0_0,PROPVARIANT_0_0_0}},Variant::VT_BLOB,Threading::{CreateEventW,WaitForSingleObject}},Foundation::{WAIT_TIMEOUT,WAIT_OBJECT_0}}};

fn error(e:windows::core::Error)->Value{
    failure(if e.code().0==0x80070005u32 as i32{"permission_denied"}else if matches!(e.code().0 as u32,0x80070057|0x80004001|0x80070490){"unsupported_operation"}else{"provider_failed"},format!("Windows process-loopback API failed (requires Windows build 20348+): {e}"))
}
struct Apartment;
impl Drop for Apartment{fn drop(&mut self){unsafe{CoUninitialize();}}}
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Completion(std::sync::mpsc::SyncSender<windows::core::Result<IUnknown>>);
impl IActivateAudioInterfaceCompletionHandler_Impl for Completion_Impl{
    fn ActivateCompleted(&self,operation:Ref<'_,IActivateAudioInterfaceAsyncOperation>)->windows::core::Result<()>{
        let result=(||{let mut status=HRESULT::default();let mut interface=None;unsafe{operation.ok()?.GetActivateResult(&mut status,&mut interface)?;}status.ok()?;interface.ok_or_else(windows::core::Error::empty)})();
        let _=self.0.try_send(result);Ok(())
    }
}
pub(super) struct Source{client:IAudioClient,capture:IAudioCaptureClient,event:crate::windows::OwnedHandle,target:crate::windows::CaptureIdentity,_apartment:Apartment,started:bool}
impl Drop for Source{fn drop(&mut self){if self.started{unsafe{let _=self.client.Stop();}}}}
impl Source{
    pub(super) fn open(action:&Value)->Result<Self,Value>{unsafe{
        if action.get("device").is_some(){return Err(failure("invalid_request","Windows process-loopback spans the target process tree across endpoints and has no device selector"));}
        CoInitializeEx(None,COINIT_MULTITHREADED).ok().map_err(error)?;let apartment=Apartment;
        let pid=super::target_pid(action)?;let target=crate::windows::capture_identity(pid)?;
        // Windows copies these activation parameters before returning. The
        // retained target handle prevents PID reuse through the whole capture.
        let mut params=AUDIOCLIENT_ACTIVATION_PARAMS{ActivationType:AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,Anonymous:AUDIOCLIENT_ACTIVATION_PARAMS_0{ProcessLoopbackParams:AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS{TargetProcessId:pid,ProcessLoopbackMode:PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE}}};
        // windows-rs drops a PROPVARIANT with PropVariantClear, which would CoTaskMemFree this blob:
        // a pointer to `params` on the stack (heap fail-fast 0xC0000409). The variant only borrows it.
        let variant=std::mem::ManuallyDrop::new(PROPVARIANT{Anonymous:PROPVARIANT_0{Anonymous:std::mem::ManuallyDrop::new(PROPVARIANT_0_0{vt:VT_BLOB,Anonymous:PROPVARIANT_0_0_0{blob:BLOB{cbSize:std::mem::size_of_val(&params)as u32,pBlobData:(&mut params as *mut AUDIOCLIENT_ACTIVATION_PARAMS).cast()}},..Default::default()})}});
        let (tx,rx)=std::sync::mpsc::sync_channel(1);let completion:IActivateAudioInterfaceCompletionHandler=Completion(tx).into();
        let _operation=ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,&IAudioClient::IID,Some(&*variant),&completion).map_err(error)?;
        let client:IAudioClient=rx.recv_timeout(Duration::from_secs(5)).map_err(|_|failure("resource_limit","Windows process-loopback activation exceeded 5 seconds"))?.map_err(error)?.cast().map_err(error)?;
        if !target.alive(){return Err(failure("target_gone","audio application changed during activation"));}
        // A real shared-mode conversion, not inferred device metadata. The
        // native API accepts this explicit float32 stereo 48kHz format or fails.
        let format=WAVEFORMATEX{wFormatTag:3,nChannels:2,nSamplesPerSec:48000,nAvgBytesPerSec:384000,nBlockAlign:8,wBitsPerSample:32,cbSize:0};
        client.Initialize(AUDCLNT_SHAREMODE_SHARED,AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_EVENTCALLBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,0,0,&format,None).map_err(error)?;
        let event=crate::windows::OwnedHandle(CreateEventW(None,false,false,None).map_err(error)?);
        client.SetEventHandle(event.0).map_err(error)?;let capture=client.GetService::<IAudioCaptureClient>().map_err(error)?;
        Ok(Self{client,capture,event,target,_apartment:apartment,started:false})
    }}
    pub(super) fn play(&mut self)->Result<(),Value>{if !self.target.alive(){return Err(failure("target_gone","audio application exited before start"));}unsafe{self.client.Start().map_err(error)?;}self.started=true;Ok(())}
    pub(super) fn stop(&mut self)->Result<(),Value>{if self.started{unsafe{self.client.Stop().map_err(error)?;}self.started=false;}Ok(())}
    pub(super) fn next(&mut self)->Result<Option<Vec<f32>>,Value>{unsafe{
        if !self.target.alive(){return Err(failure("target_gone","retained audio application exited or changed identity"));}
        match WaitForSingleObject(self.event.0,0){WAIT_TIMEOUT=>return Ok(None),WAIT_OBJECT_0=>(),_=>return Err(failure("provider_failed","Windows audio event wait failed"))}
        let deadline=Instant::now()+Duration::from_millis(10);let mut samples=Vec::new();
        for _ in 0..64{
            let count=self.capture.GetNextPacketSize().map_err(error)?;if count==0{break;}
            if count as usize>MAX_SAMPLES/2||samples.len()+count as usize*2>MAX_SAMPLES{return Err(failure("resource_limit","Windows audio packets exceed PCM bounds"));}
            let(mut bytes,mut frames,mut flags)=(std::ptr::null_mut(),0,0);
            self.capture.GetBuffer(&mut bytes,&mut frames,&mut flags,None,None).map_err(error)?;
            let result=(||{
                if frames!=count{return Err(failure("provider_failed","Windows audio packet size changed"));}
                if flags&AUDCLNT_BUFFERFLAGS_SILENT.0 as u32!=0{samples.resize(samples.len()+frames as usize*2,0.0);}
                else{if bytes.is_null(){return Err(failure("provider_failed","Windows returned a null PCM packet"));}for chunk in std::slice::from_raw_parts(bytes,frames as usize*8).chunks_exact(4){samples.push(f32::from_le_bytes(chunk.try_into().unwrap()));}}
                Ok(())
            })();let released=self.capture.ReleaseBuffer(frames).map_err(error);result?;released?;
            if Instant::now()>=deadline{break;}
        }
        Ok((!samples.is_empty()).then_some(samples))
    }}
}
