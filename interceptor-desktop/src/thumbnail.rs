use crate::{contract_generated::*,failure,success};
use base64::Engine;
use serde_json::{Value,json};
use std::{fs,io::{self,Read,Cursor},path::PathBuf,process::{Command,Stdio},time::{Duration,Instant}};

fn request(action:&Value)->Result<(u32,u32,u32),Value>{
    if let Some(error)=desktop_thumbnail_shape_error(action){return Err(failure("invalid_request",error));}
    let path=|value:&Value|value.as_str().is_some_and(|s|crate::filesystem::absolute(s).is_ok());
    if action["sub"]=="generate" {
        if !path(&action["path"])||action.get("paths").is_some(){return Err(failure("invalid_request","thumbnail requires one absolute path"));}
    }else if action.get("path").is_some()||action["paths"].as_array().is_none_or(|rows|rows.is_empty()||rows.len()>DESKTOP_THUMBNAIL_MAX_PATHS||!rows.iter().all(path)){
        return Err(failure("invalid_request","thumbnail batch requires 1..32 absolute paths"));
    }
    let scale=action["scale"].as_f64().unwrap_or(2.0);
    if !scale.is_finite()||scale.fract()!=0.0||!(1.0..=8.0).contains(&scale){return Err(failure("invalid_request","thumbnail scale requires an integer 1..8"));}
    let size=action["size"].as_str().unwrap_or("256");
    let parts=size.split('x').collect::<Vec<_>>();
    if parts.is_empty()||parts.len()>2||parts.iter().any(|part|part.is_empty()||part.len()>4||part.starts_with('0')||!part.bytes().all(|b|b.is_ascii_digit())){return Err(failure("invalid_request","thumbnail size requires positive integer dimensions"));}
    let width=parts[0].parse::<u32>().unwrap_or(0)*(scale as u32);
    let height=parts.get(1).unwrap_or(&parts[0]).parse::<u32>().unwrap_or(0)*(scale as u32);
    if width>16384||height>16384||width as u64*height as u64>DESKTOP_THUMBNAIL_MAX_PIXELS as u64{return Err(failure("invalid_request","thumbnail dimensions exceed their pixel bound"));}
    if action.get("format").is_some_and(|v|!matches!(v.as_str().map(str::to_ascii_lowercase).as_deref(),Some("png"|"jpeg"|"jpg"|"heic"))){return Err(failure("invalid_request","thumbnail format requires png, jpeg or heic"));}
    if action.get("types").is_some_and(|v|v.as_str().is_none_or(|s|s.len()>128||!s.split(',').all(|v|matches!(v.trim(),"all"|"icon"|"thumbnail"|"lowQuality"|"lowQualityThumbnail")))){return Err(failure("invalid_request","unknown thumbnail representation type"));}
    if action.get("out").is_some()&&(!path(&action["out"])||action["save"]!=true||action["sub"]=="batch"){return Err(failure("invalid_request","thumbnail out requires one saved image and an absolute destination"));}
    Ok((width,height,scale as u32))
}

fn io_error(error:std::io::Error)->Value{
    failure(match error.kind(){std::io::ErrorKind::NotFound=>"target_gone",std::io::ErrorKind::PermissionDenied=>"permission_denied",_=>"provider_failed"},error)
}

pub(crate) fn source_bytes(path:&std::path::Path)->Result<Vec<u8>,Value>{
    bounded_source_bytes(path,DESKTOP_THUMBNAIL_MAX_SOURCE_BYTES,false)
}
// VM copy uses the same retained regular-file reader with a smaller cap and
// no-follow/replacement checks. Existing image/engine callers retain defaults.
pub(crate) fn bounded_source_bytes(path:&std::path::Path,limit:usize,retained:bool)->Result<Vec<u8>,Value>{
    if limit==0||limit>DESKTOP_THUMBNAIL_MAX_SOURCE_BYTES{return Err(failure("invalid_request","invalid source byte cap"));}
    let before=fs::metadata(path).map_err(io_error)?;
    if !before.is_file(){return Err(failure("unsupported_target","image source requires a regular file"));}
    if before.len()>limit as u64{return Err(failure("resource_limit",if retained{"source exceeds its byte cap"}else{"image source exceeds 64 MiB"}));}
    #[cfg(unix)] let mut file={use std::os::unix::fs::OpenOptionsExt;fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK|if retained{libc::O_NOFOLLOW|libc::O_CLOEXEC}else{0}).open(path).map_err(io_error)?};
    #[cfg(windows)] let mut file={use std::os::windows::fs::OpenOptionsExt;fs::OpenOptions::new().read(true).custom_flags(if retained{windows::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT.0}else{0}).open(path).map_err(io_error)?};
    let metadata=file.metadata().map_err(io_error)?;
    if !metadata.is_file(){return Err(failure("unsupported_target","image source requires a regular file"));}
    #[cfg(windows)]if retained{use std::os::windows::fs::MetadataExt;if metadata.file_attributes()&0x400!=0{return Err(failure("unsupported_target","VM copy input cannot be a reparse point"));}}
    if metadata.len()>limit as u64{return Err(failure("resource_limit",if retained{"source exceeds its byte cap"}else{"image source exceeds 64 MiB"}));}
    let mut bytes=Vec::new();file.by_ref().take(limit as u64+1).read_to_end(&mut bytes).map_err(io_error)?;
    if bytes.len()>limit{return Err(failure("resource_limit",if retained{"source grew beyond its byte cap"}else{"image source grew beyond 64 MiB"}));}
    if retained{let after=file.metadata().map_err(io_error)?;if metadata.len()!=after.len()||bytes.len()as u64!=after.len()||metadata.modified().map_err(io_error)?!=after.modified().map_err(io_error)?{return Err(failure("unsupported_target","VM input changed during retained read"));}}
    Ok(bytes)
}

pub(crate) fn decode_raster(bytes:&[u8])->Result<image::RgbaImage,Value>{
    use image::ImageDecoder;
    let format=image::guess_format(bytes).map_err(|_|failure("unsupported_target","source is not a supported raster image"))?;
    if !matches!(format,image::ImageFormat::Png|image::ImageFormat::Jpeg|image::ImageFormat::WebP){return Err(failure("unsupported_target","raster input requires PNG, JPEG or WebP"));}
    let dimensions=image::ImageReader::with_format(Cursor::new(bytes),format).into_dimensions().map_err(|_|failure("unsupported_target","image header is invalid"))?;
    crate::capture::pixel_size(dimensions.0,dimensions.1)?;
    let mut reader=image::ImageReader::with_format(Cursor::new(bytes),format);
    let mut limits=image::Limits::default();limits.max_image_width=Some(dimensions.0);limits.max_image_height=Some(dimensions.1);limits.max_alloc=Some(160*1024*1024);reader.limits(limits);
    let mut decoder=reader.into_decoder().map_err(|_|failure("unsupported_target","image decoder refused the source"))?;
    let orientation=decoder.orientation().map_err(|_|failure("unsupported_target","image orientation metadata is invalid"))?;
    let mut image=image::DynamicImage::from_decoder(decoder).map_err(|_|failure("unsupported_target","image is invalid or exceeds decoder limits"))?;
    image.apply_orientation(orientation);
    Ok(image.to_rgba8())
}

fn generate(action:&Value,size:(u32,u32,u32),deadline:Instant,in_pdf_helper:bool)->Result<Value,Value>{
    if Instant::now()>=deadline{return Err(failure("resource_limit","thumbnail action exceeded its ten-second budget"));}
    let original=action["path"].as_str().unwrap();
    let path=crate::filesystem::absolute(original)?;
    let format=match action["format"].as_str().unwrap_or("png").to_ascii_lowercase().as_str(){"jpg"|"jpeg"=>"jpeg","heic"=>"heic",_=>"png"};
    if format=="heic"{return Err(failure("unsupported_operation","the native raster thumbnail backend has no HEIC encoder"));}
    let icon=action["types"].as_str().is_some_and(|types|types.split(',').all(|s|s.trim()=="icon"));
    #[cfg(any(windows,target_os="linux"))]
    let image=if icon&&!in_pdf_helper{
        // Icons render square; bound that square, not the requested box (2048x1 at scale 8 is 16384 square).
        let icon=crate::thumbnail_icon::file_icon(&path,size.0.max(size.1).min((DESKTOP_THUMBNAIL_MAX_PIXELS as f64).sqrt()as u32))?;
        Some(if icon.width()>size.0||icon.height()>size.1{image::DynamicImage::ImageRgba8(icon).thumbnail(size.0,size.1).to_rgba8()}else{icon})
    }else{None};
    #[cfg(not(any(windows,target_os="linux")))]
    let image:Option<image::RgbaImage>=if icon{return Err(failure("unsupported_operation","icon representation requires a host thumbnail provider"))}else{None};
    let image=if let Some(image)=image{image}else{
    let bytes=source_bytes(&path)?;
    let pdf=bytes[..bytes.len().min(1024)].windows(5).any(|chunk|chunk==b"%PDF-");
    let image=if pdf {
        if !in_pdf_helper{return pdf_generate(action,deadline);}
        crate::thumbnail_pdf::render(&bytes,(size.0,size.1))?
    }else{
    if in_pdf_helper{return Err(failure("unsupported_target","PDF source changed or has no PDF header"));}
    let image=image::DynamicImage::ImageRgba8(decode_raster(&bytes)?);
    image.thumbnail(size.0.min(image.width()),size.1.min(image.height())).to_rgba8()
    };
    image
    };
    let encoded=crate::capture::encode(&image,format,85)?;
    let mut data=json!({"path":original,"type":"thumbnail","width":image.width(),"height":image.height(),"scale":size.2,"format":format,"bytes":encoded.len()});
    if action["save"]==true{
        let destination=action["out"].as_str().map(crate::filesystem::absolute).transpose()?.unwrap_or_else(||PathBuf::from(format!("{}.thumb.{format}",path.display())));
        if destination==path||fs::canonicalize(&destination).ok().zip(fs::canonicalize(&path).ok()).is_some_and(|(a,b)|a==b){return Err(failure("invalid_request","thumbnail output must not replace its source image"));}
        let written=crate::filesystem::dispatch("fs_write",&json!({"type":"desktop_fs_write","path":destination,"content":base64::engine::general_purpose::STANDARD.encode(&encoded),"encoding":"base64"}));
        if written["success"]!=true{return Err(written);}
        data["filePath"]=written["data"]["absolutePath"].clone();
    }else{data["dataUrl"]=json!(format!("data:image/{format};base64,{}",base64::engine::general_purpose::STANDARD.encode(&encoded)));}
    Ok(data)
}

fn pdf_generate(action:&Value,deadline:Instant)->Result<Value,Value>{
    image_helper("--thumbnail-pdf",action,deadline)
}

pub(crate) fn retain_provider(parent:u32)->std::io::Result<()>{
    #[cfg(target_os="linux")]{
        use std::os::fd::AsRawFd;
        // PR_SET_PDEATHSIG follows the spawning thread, which can end after
        // one CLI request. Pin the whole provider process with the existing
        // same-login pidfd identity instead, before any native initialization.
        if !crate::linux::graphical_login(){return Err(io::Error::new(io::ErrorKind::PermissionDenied,"native helper requires the current graphical login"));}
        if unsafe{libc::getppid()}as u32!=parent{return Err(io::Error::other("native provider parent changed before retention"));}
        let identity=crate::linux::capture_identity(parent).map_err(|e|io::Error::other(e.to_string()))?;
        if unsafe{libc::getppid()}as u32!=parent||!identity.alive(){return Err(io::Error::other("native provider parent exited before retention"));}
        let login=crate::linux::login_identity(0).ok_or_else(||io::Error::other("native helper GUI login ended before retention"))?;
        std::thread::spawn(move||{
            let mut fd=libc::pollfd{fd:identity.pidfd().as_raw_fd(),events:libc::POLLIN,revents:0};
            loop{let result=unsafe{libc::poll(&mut fd,1,250)};if result<0&&io::Error::last_os_error().kind()==io::ErrorKind::Interrupted{continue;}
                if result==0&&crate::linux::login_identity(0).as_ref()==Some(&login){continue;}
                // This is our helper, never a numeric target PID. A hung
                // native engine cannot survive the retained provider's exit.
                unsafe{libc::_exit(1);}
            }
        });
    }
    #[cfg(windows)]let _=parent; // Parent-owned kill-on-close job retains Windows lifetime.
    #[cfg(not(any(windows,target_os="linux")))]let _=parent;
    Ok(())
}

pub(crate) struct OwnedHelper{
    pub(crate) child:crate::auth::AuthChild,
    #[cfg(unix)]grouped:bool,
    #[cfg(windows)]job:Option<windows::Win32::Foundation::HANDLE>,
}
// The job handle has one owner; Windows permits moving it between threads.
#[cfg(windows)]unsafe impl Send for OwnedHelper{}
impl Drop for OwnedHelper{fn drop(&mut self){
    // Unix exit observation uses WNOWAIT below, keeping the leader's PID
    // reserved until this exact process group is killed and AuthChild reaps it.
    #[cfg(unix)]if self.grouped{unsafe{libc::kill(-(self.child.0.id()as i32),libc::SIGKILL);}}
    #[cfg(windows)]if let Some(job)=self.job.take(){unsafe{let _=windows::Win32::Foundation::CloseHandle(job);}}
}}
impl OwnedHelper{
    pub(crate) fn spawn(mode:&str)->std::io::Result<Self>{
        Self::spawn_with_memory(mode,512*1024*1024)
    }
    pub(crate) fn spawn_with_memory(mode:&str,memory:usize)->std::io::Result<Self>{
        if memory<512*1024*1024||memory>36_usize*1024*1024*1024||mode!="--vm-engine"&&memory!=512*1024*1024{return Err(std::io::Error::other("invalid owned helper memory admission"));}
        let executable=std::env::current_exe()?;
        // The provider retains its unpackaged toast identity. Only the Contacts
        // copy carries the sparse-package Contacts, calendar and task identity.
        #[cfg(windows)]let executable=if matches!(mode,"--contacts-engine"|"--eventkit-engine"){executable.with_file_name("interceptor-contacts-native.exe")}else{executable};
        // A Linux provider built without the overlay feature runs overlays and the update window in its sibling helper,
        // which links WebKitGTK and gtk-layer-shell so the provider itself does not.
        #[cfg(all(target_os="linux",not(feature="overlay")))]let executable=if matches!(mode,"--overlay-engine"|"--update-ui"){executable.with_file_name("interceptor-overlay")}else{executable};
        // And the reverse: face tracking runs in that helper, but its WebKitGTK-linked binary takes ~20s to
        // answer one --vision-ocr request (the provider takes ~90ms), so per-frame vision uses the provider.
        #[cfg(all(target_os="linux",feature="overlay"))]let executable=if mode=="--vision-ocr"{executable.with_file_name("interceptor-desktop")}else{executable};
        let mut command=Command::new(executable);command.arg(mode).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(unix)]let grouped=matches!(mode,"--script-engine"|"--audio-engine"|"--audio-devices"|"--translation-engine"|"--speech-engine"|"--trust-state"|"--sound-engine"|"--vision-ocr"|"--sensitive-engine"|"--location-engine"|"--maps-open-engine"|"--music-engine"|"--music-system-engine"|"--share-engine"|"--contacts-engine"|"--eventkit-engine"|"--photos-engine"|"--vm-engine"|"--vm-image-engine"|"--overlay-engine"|"--overlay-tracking"|"--update-ui");
        #[cfg(unix)]if grouped{use std::os::unix::process::CommandExt;command.process_group(0);}
        if mode.starts_with("--audio-")||matches!(mode,"--translation-engine"|"--speech-engine"|"--trust-state"|"--sound-engine"|"--vision-ocr"|"--sensitive-engine"|"--location-engine"|"--maps-open-engine"|"--music-engine"|"--music-system-engine"|"--share-engine"|"--contacts-engine"|"--eventkit-engine"|"--photos-engine"|"--vm-engine"|"--vm-image-engine"|"--overlay-engine"|"--overlay-tracking"|"--update-ui"){command.arg(std::process::id().to_string());}
        #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
        let mut helper=Self{child:crate::auth::AuthChild(command.spawn()?),#[cfg(unix)]grouped,#[cfg(windows)]job:None};
        #[cfg(windows)]if matches!(mode,"--script-engine"|"--audio-engine"|"--audio-devices"|"--translation-engine"|"--speech-engine"|"--trust-state"|"--sound-engine"|"--vision-ocr"|"--sensitive-engine"|"--location-engine"|"--maps-open-engine"|"--music-engine"|"--music-system-engine"|"--share-engine"|"--contacts-engine"|"--eventkit-engine"|"--photos-engine"|"--vm-engine"|"--vm-image-engine"|"--overlay-engine"|"--overlay-tracking"|"--update-ui"){unsafe{
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::{Foundation::{HANDLE,CloseHandle},System::JobObjects::*};
            let job=CreateJobObjectW(None,None).map_err(std::io::Error::other)?;
            let mut limits=JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_PROCESS_MEMORY;limits.ProcessMemoryLimit=memory;
            let assigned=SetInformationJobObject(job,JobObjectExtendedLimitInformation,(&raw const limits).cast(),std::mem::size_of_val(&limits)as u32).and_then(|_|AssignProcessToJobObject(job,HANDLE(helper.child.0.as_raw_handle())));
            if let Err(error)=assigned{let _=CloseHandle(job);return Err(std::io::Error::other(error));}helper.job=Some(job);
        }}
        // Helpers wait for input, so no native work or host process can
        // start before the Windows job assignment has completed.
        Ok(helper)
    }
    pub(crate) fn exited(&mut self)->std::io::Result<Option<bool>>{
        #[cfg(unix)]if self.grouped{unsafe{
            let mut info:libc::siginfo_t=std::mem::zeroed();
            if libc::waitid(libc::P_PID,self.child.0.id(),&mut info,libc::WEXITED|libc::WNOHANG|libc::WNOWAIT)!=0{return Err(std::io::Error::last_os_error());}
            return Ok((info.si_pid()!=0).then(||info.si_code==libc::CLD_EXITED&&info.si_status()==0));
        }}
        self.child.0.try_wait().map(|status|status.map(|s|s.success()))
    }
    pub(crate) fn terminate_group(&mut self)->std::io::Result<()>{
        // The retained Unix leader is observed with WNOWAIT. Its process
        // group cannot be confused with a recycled numeric target PID.
        #[cfg(unix)]{
            if !self.grouped{return Err(io::Error::other("helper has no retained process group"));}
            if unsafe{libc::kill(-(self.child.0.id()as i32),libc::SIGKILL)}!=0{
                let error=io::Error::last_os_error();
                if error.raw_os_error()!=Some(libc::ESRCH)||self.exited()?.is_none(){return Err(error);}
            }
        }
        #[cfg(windows)]unsafe{
            let job=self.job.ok_or_else(||io::Error::other("helper has no retained job"))?;
            windows::Win32::System::JobObjects::TerminateJobObject(job,1).map_err(io::Error::other)?;
        }
        Ok(())
    }
    pub(crate) fn group_quiescent(&mut self)->std::io::Result<bool>{
        if self.exited()?.is_none(){return Ok(false);}
        #[cfg(windows)]unsafe{
            use windows::Win32::System::JobObjects::*;
            let job=self.job.ok_or_else(||io::Error::other("helper has no retained job"))?;
            let mut info=JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            QueryInformationJobObject(Some(job),JobObjectBasicAccountingInformation,(&raw mut info).cast(),std::mem::size_of_val(&info)as u32,None).map_err(io::Error::other)?;
            return Ok(info.ActiveProcesses==0);
        }
        // Linux VM callers also require a POLLIN exit observation on the
        // retained QEMU pidfd. Leader exit alone does not establish that.
        #[cfg(unix)]Ok(true)
    }
}
pub(crate) fn image_helper(mode:&str,action:&Value,deadline:Instant)->Result<Value,Value>{
    let result=(||->std::io::Result<Value>{
        let mut helper=OwnedHelper::spawn(mode)?;
        if let Some(mut input)=helper.child.0.stdin.take(){crate::write_frame(&mut input,&serde_json::to_vec(action)?)?;}
        let mut output=helper.child.0.stdout.take().ok_or_else(||std::io::Error::other("native helper output unavailable"))?;
        let bytes=crate::auth::bounded_child_result(|bytes|crate::auth::ready_read(&mut output,bytes),deadline,DESKTOP_MAX_RESULT_BYTES)?;
        loop{
            if let Some(success)=helper.exited()?{if !success{return Err(std::io::Error::other("native helper failed"));}break;}
            if Instant::now()>=deadline{return Err(std::io::ErrorKind::TimedOut.into());}
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(serde_json::from_slice(&bytes)?)
    })().map_err(|error|failure(if action["save"]==true||action["action"].get("debugDumpPath").is_some()||mode=="--script-engine"&&action["jscHost"].as_str().is_some_and(|s|!matches!(s,"none"|"false"|"env"|"sqlite")){"partial_result"}else if error.kind()==std::io::ErrorKind::TimedOut{"resource_limit"}else{"provider_failed"},
        if error.kind()==std::io::ErrorKind::TimedOut{"native helper exceeded its deadline; it was killed and reaped; observe requested writes or shell effects before retrying"}else{"native helper failed before a complete result; it was reaped; observe requested writes or shell effects before retrying"}))?;
    if result["success"]==true{result.get("data").cloned().ok_or_else(||failure("provider_failed","native helper omitted result data"))}else{Err(result)}
}

pub fn pdf_helper()->std::io::Result<()>{
    let result=match crate::thumbnail_pdf::limit_memory(){Err(error)=>error,Ok(())=>{
        let bytes=crate::read_frame(&mut std::io::stdin().lock())?.ok_or_else(||std::io::Error::other("PDF helper requires a request"))?;
        let action:Value=serde_json::from_slice(&bytes)?;
        match request(&action){Err(error)=>error,Ok(size)=>if action["sub"]!="generate"{failure("invalid_request","PDF helper requires one generate request")}else{
            match generate(&action,size,Instant::now()+Duration::from_secs(10),true){Ok(data)=>success(data),Err(error)=>error}
        }}
    }};
    let mut bytes=serde_json::to_vec(&result)?;
    if bytes.len()>DESKTOP_MAX_RESULT_BYTES{bytes=serde_json::to_vec(&failure("resource_limit","PDF thumbnail exceeds the result bound"))?;}
    crate::write_frame(&mut std::io::stdout().lock(),&bytes)
}

pub fn dispatch(action:&Value)->Value{
    let size=match request(action){Ok(size)=>size,Err(error)=>return error};
    let deadline=Instant::now()+Duration::from_secs(10);
    let result=if action["sub"]=="batch"{
        let mut rows=Vec::new();
        for path in action["paths"].as_array().unwrap(){
            let mut single=action.clone();single["path"]=path.clone();single["sub"]=json!("generate");single.as_object_mut().unwrap().remove("paths");
            let result=match generate(&single,size,deadline,false){Ok(data)=>success(data),Err(error)=>error};
            rows.push(json!({"path":path,"ok":result["success"],"result":result}));
            if serde_json::to_vec(&rows).map_or(true,|v|v.len()>DESKTOP_MAX_RESULT_BYTES-64){return failure(if action["save"]==true{"partial_result"}else{"resource_limit"},"thumbnail batch exceeds the result bound; request fewer paths");}
        }
        success(json!({"results":rows}))
    }else{match generate(action,size,deadline,false){Ok(data)=>success(data),Err(error)=>error}};
    if serde_json::to_vec(&result).is_ok_and(|bytes|bytes.len()<=DESKTOP_MAX_RESULT_BYTES){result}else{failure("resource_limit","thumbnail result exceeds the desktop frame bound")}
}

pub fn capability(session:&str)->Value{
    json!({"operation":"thumbnail","compiled":true,"present":true,"permission":"not_applicable","session":session,"effective":true,"background":"semantic","provider":"native-image-raster","versions":{"image":"0.25.9","pdf":if cfg!(windows){"Windows.Data.Pdf (WinRT 1)"}else{"Poppler GLib runtime (libpoppler-glib.so.8)"}},"limits":["PNG/JPEG/WebP and first-page PDF sources; PNG/JPEG output. HEIC, file icons, other documents and video remain unimplemented. Linux PDF requires the Poppler GLib runtime.","64 MiB source; 32 megapixels; 32 batch paths; ten-second action budget; no raster upscaling; atomic saves reuse filesystem policy.","PDF parsing/rendering runs in a reaped helper with a 512 MiB process memory limit; encrypted PDFs are refused."]})
}

#[cfg(test)]mod tests{
    use super::*;
    #[cfg(target_os="linux")]#[test]fn retained_group_termination_observes_child_exit_and_preserves_an_unrelated_process(){
        use std::{io::{BufRead,BufReader},os::{unix::process::CommandExt,fd::{OwnedFd,FromRawFd,AsRawFd}}};
        let mut observer=crate::auth::AuthChild(Command::new("/bin/sleep").arg("30").spawn().unwrap());
        let mut command=Command::new("/bin/sh");command.args(["-c","sleep 30 & printf '%s\\n' \"$!\"; wait"]).process_group(0).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut helper=OwnedHelper{child:crate::auth::AuthChild(command.spawn().unwrap()),grouped:true};
        let mut line=String::new();BufReader::new(helper.child.0.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let native_pid:u32=line.trim().parse().unwrap();
        let raw=unsafe{libc::syscall(libc::SYS_pidfd_open,native_pid,0_u32)};assert!(raw>=0);
        let retained=unsafe{OwnedFd::from_raw_fd(raw as i32)};
        assert!(!helper.group_quiescent().unwrap());
        helper.terminate_group().unwrap();
        let deadline=Instant::now()+Duration::from_secs(3);
        loop{
            let mut fd=libc::pollfd{fd:retained.as_raw_fd(),events:libc::POLLIN,revents:0};
            let result=unsafe{libc::poll(&mut fd,1,0)};assert!(result>=0);
            if helper.group_quiescent().unwrap()&&result>0&&fd.revents&libc::POLLIN!=0{break;}
            assert!(Instant::now()<deadline,"owned group or retained native child did not exit");std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(helper.exited().unwrap(),Some(false));
        // WNOWAIT keeps the owned leader reserved until Drop retires the group.
        assert_eq!(unsafe{libc::kill(helper.child.0.id()as i32,0)},0);
        assert!(observer.0.try_wait().unwrap().is_none());
        drop(helper);
        assert!(observer.0.try_wait().unwrap().is_none());
    }
    struct Fixture{root:PathBuf,path:PathBuf}
    impl Fixture{
        fn new()->Self{
            static NEXT:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
            let root=std::env::current_dir().unwrap().join("target/thumbnail-tests").join(format!("{}-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),NEXT.fetch_add(1,std::sync::atomic::Ordering::SeqCst)));
            fs::create_dir_all(&root).unwrap();let path=root.join("文件.png");
            let pixels=image::RgbaImage::from_fn(64,32,|x,_|image::Rgba(if x<32{[0,0,255,255]}else{[255,0,0,255]}));
            fs::write(&path,crate::capture::encode(&pixels,"png",85).unwrap()).unwrap();Self{root,path}
        }
        fn action(&self)->Value{json!({"type":"desktop_thumbnail","sub":"generate","path":self.path,"size":"16","scale":1})}
    }
    impl Drop for Fixture{fn drop(&mut self){fs::remove_dir_all(&self.root).unwrap();}}
    #[test]fn raster_outputs_preserve_aspect_pixels_and_do_not_upscale(){
        let f=Fixture::new();
        for source in ["png","jpeg","webp"]{
            let pixels=image::load_from_memory(&fs::read(&f.path).unwrap()).unwrap().to_rgba8();
            let path=f.root.join(format!("source.{source}"));fs::write(&path,crate::capture::encode(&pixels,source,85).unwrap()).unwrap();
            for format in ["png","jpeg"]{
                let mut action=f.action();action["path"]=json!(path);action["format"]=json!(format);
                let result=dispatch(&action);assert_eq!(result["success"],true,"{result}");
                let data=&result["data"];let encoded=base64::engine::general_purpose::STANDARD.decode(data["dataUrl"].as_str().unwrap().split(',').nth(1).unwrap()).unwrap();
                let decoded=image::load_from_memory(&encoded).unwrap().to_rgba8();
                assert_eq!(decoded.dimensions(),(16,8));assert_eq!(data["width"],16);assert_eq!(data["height"],8);assert_eq!(data["bytes"],encoded.len());
                assert!(decoded.get_pixel(2,2)[2]>200);assert!(decoded.get_pixel(13,2)[0]>200);
            }
        }
        let mut action=f.action();action["size"]=json!("100x80");action["scale"]=json!(2);
        let result=dispatch(&action);assert_eq!(result["data"]["width"],64);assert_eq!(result["data"]["height"],32);
    }
    #[test]fn saved_dimensions_are_real_and_source_is_never_overwritten(){
        let f=Fixture::new();let original=fs::read(&f.path).unwrap();let out=f.root.join("nested/output.png");
        let mut action=f.action();action["save"]=json!(true);action["out"]=json!(out);
        let result=dispatch(&action);assert_eq!(result["success"],true,"{result}");
        let saved=fs::read(&out).unwrap();let decoded=image::load_from_memory(&saved).unwrap();assert_eq!((decoded.width(),decoded.height()),(16,8));assert_eq!(result["data"]["bytes"],saved.len());assert_eq!(result["data"]["filePath"],json!(fs::canonicalize(&out).unwrap()));assert!(result["data"].get("dataUrl").is_none());
        action["out"]=json!(f.path);assert_eq!(dispatch(&action)["code"],"invalid_request");assert_eq!(fs::read(&f.path).unwrap(),original);
    }
    #[test]fn batch_retains_order_failures_and_rejects_shared_save_destination(){
        let f=Fixture::new();let missing=f.root.join("missing.png");
        let mut action=json!({"type":"desktop_thumbnail","sub":"batch","paths":[f.path,missing,f.path],"size":"16","scale":1});
        let result=dispatch(&action);assert_eq!(result["success"],true);let rows=result["data"]["results"].as_array().unwrap();assert_eq!(rows.len(),3);assert_eq!(rows[0]["path"],json!(f.path));assert_eq!(rows[0]["ok"],true);assert_eq!(rows[1]["result"]["code"],"target_gone");assert_eq!(rows[2]["ok"],true);
        let out=f.root.join("must-not-exist.png");action["save"]=json!(true);action["out"]=json!(out);assert_eq!(dispatch(&action)["code"],"invalid_request");assert!(!out.exists());
    }
    #[test]fn malformed_oversized_and_unsupported_sources_have_typed_failures(){
        let f=Fixture::new();
        for fields in [json!({"size":"0"}),json!({"size":"9999","scale":8}),json!({"scale":1.5}),json!({"format":"gif"}),json!({"save":null}),json!({"extra":true})]{let mut action=f.action();action.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());assert_eq!(dispatch(&action)["code"],"invalid_request");}
        let mut heic=f.action();heic["format"]=json!("heic");assert_eq!(dispatch(&heic)["code"],"unsupported_operation");
        // File icons come from the shell (Windows) or the icon theme (Linux).
        let mut icon=f.action();icon["types"]=json!("icon");let icon=dispatch(&icon);
        if cfg!(any(windows,target_os="linux")){assert_eq!(icon["success"],true,"{icon}");assert!(icon["data"]["bytes"].as_u64().unwrap_or(0)>0);}else{assert_eq!(icon["code"],"unsupported_operation");}
        fs::write(&f.path,b"not an image").unwrap();assert_eq!(dispatch(&f.action())["code"],"unsupported_target");
        fs::File::create(&f.path).unwrap().set_len(DESKTOP_THUMBNAIL_MAX_SOURCE_BYTES as u64+1).unwrap();assert_eq!(dispatch(&f.action())["code"],"resource_limit");
    }
    #[cfg(unix)]#[test]fn non_regular_files_are_refused_without_waiting_for_a_writer(){
        let f=Fixture::new();let path=f.root.join("fifo");let c=std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe{libc::mkfifo(c.as_ptr(),0o600)},0);
        let mut action=f.action();action["path"]=json!(path);
        assert_eq!(dispatch(&action)["code"],"unsupported_target");
    }
}
