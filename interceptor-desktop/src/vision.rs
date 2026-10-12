//! Image analysis in the existing image helper: OCR through the operating system or Tesseract,
//! and hands, bodies, image classes and saliency through the bundled models (vision_models.rs).
use crate::{contract_generated::*,failure,success};
use base64::{Engine as _,engine::general_purpose::STANDARD};
use serde_json::{Value,json};
use std::{ffi::{CStr,c_char,c_int,c_void},sync::Mutex,time::{Duration,Instant}};
use crate::native_library::{Library,pinned_bytes};
type Result<T>=std::result::Result<T,Value>;
type Raw=*mut c_void;
// ponytail: one CPU vision helper at a time; add queues only if concurrent inference is needed.
static WORK:Mutex<()>=Mutex::new(());

fn validate(action:&Value)->Result<()>{
    if let Some(error)=desktop_vision_shape_error(action){return Err(failure("invalid_request",error));}
    for key in ["imagePath","debugDumpPath"]{if let Some(value)=action.get(key){crate::filesystem::absolute(value.as_str().unwrap_or(""))?;}}
    if action.get("app").is_some_and(|v|v.as_str().is_none_or(|s|s.trim().is_empty()||s.len()>512||s.contains('\0')))||action.get("imagePath").is_some()&&action.get("app").is_some(){return Err(failure("invalid_request","vision requires one bounded app name or an image file"));}
    if ["group","groupColor"].iter().any(|key|action.get(key).is_some_and(|v|v.as_str().is_none_or(|s|s.is_empty()||s.len()>256||s.contains('\0')))){return Err(failure("invalid_request","invalid native request group metadata"));}
    if action.get("debugDumpPath").is_some()&&action["sub"]!="text"{return Err(failure("invalid_request","vision debug dump belongs only to text"));}
    Ok(())
}
fn recognize(pixels:&image::RgbaImage)->Result<Value>{unsafe{
    // A configured engine bundle pins Tesseract 5.5.2 and its model bytes. Without one, Linux uses the
    // distribution Tesseract 5.x and its installed tessdata (tesseract + tesseract-data-eng).
    let pinned=pinned_bytes("INTERCEPTOR_TESSERACT_LIBRARY",64*1024*1024);
    #[cfg(target_os="linux")]let system=pinned.is_err()&&std::env::var_os("INTERCEPTOR_TESSERACT_LIBRARY").is_none();
    #[cfg(not(target_os="linux"))]let system=false;
    let library_path=match pinned{Ok((path,_))=>path,Err(error)=>{
        #[cfg(target_os="linux")]if system{crate::native_library::system_library("INTERCEPTOR_TESSERACT_SYSTEM_LIBRARY","libtesseract","tesseract and tesseract-data-eng")?}else{return Err(error)}
        #[cfg(not(target_os="linux"))]return Err(error)
    }};
    let library=Library::load(&library_path)?;
    macro_rules! symbol{($name:literal,$type:ty)=>{std::mem::transmute::<Raw,$type>(library.symbol(CStr::from_bytes_with_nul(concat!($name,"\0").as_bytes()).unwrap())?)}}
    let version=symbol!("TessVersion",unsafe extern "C" fn()->*const c_char);
    let raw=version();
    if raw.is_null()||if system{!CStr::from_ptr(raw).to_bytes().starts_with(b"5.")}else{CStr::from_ptr(raw).to_bytes()!=b"5.5.2"}{return Err(failure("version_mismatch",if system{"OCR requires Tesseract 5.x"}else{"CPU OCR requires the selected Tesseract 5.5.2 runtime"}));}
    let model=if system{vec![]}else{pinned_bytes("INTERCEPTOR_TESSERACT_MODEL",64*1024*1024)?.1};
    let create=symbol!("TessBaseAPICreate",unsafe extern "C" fn()->Raw);
    let delete=symbol!("TessBaseAPIDelete",unsafe extern "C" fn(Raw));
    let init=if system{None}else{Some(symbol!("TessBaseAPIInit5",unsafe extern "C" fn(Raw,*const u8,c_int,*const c_char,c_int,*mut *mut c_char,c_int,*mut *mut c_char,*mut *mut c_char,usize,c_int)->c_int))};
    let set_image=symbol!("TessBaseAPISetImage",unsafe extern "C" fn(Raw,*const u8,c_int,c_int,c_int,c_int));
    let recognize=symbol!("TessBaseAPIRecognize",unsafe extern "C" fn(Raw,Raw)->c_int);
    let get_tsv=symbol!("TessBaseAPIGetTsvText",unsafe extern "C" fn(Raw,c_int)->*mut c_char);
    let free=symbol!("TessDeleteText",unsafe extern "C" fn(*const c_char));
    struct Api(Raw,unsafe extern "C" fn(Raw));impl Drop for Api{fn drop(&mut self){unsafe{(self.1)(self.0);}}}
    let api=create();if api.is_null(){return Err(failure("resource_limit","Tesseract instance allocation failed"));}let api=Api(api,delete);
    if system{
        let init3=symbol!("TessBaseAPIInit3",unsafe extern "C" fn(Raw,*const c_char,*const c_char)->c_int);
        if init3(api.0,std::ptr::null(),c"eng".as_ptr())!=0{return Err(failure("not_installed","Tesseract has no English data; install tesseract-data-eng"));}
    }else if init.unwrap()(api.0,model.as_ptr(),model.len()as c_int,c"eng".as_ptr(),1,std::ptr::null_mut(),0,std::ptr::null_mut(),std::ptr::null_mut(),0,0)!=0{return Err(failure("unsupported_target","Tesseract refused the pinned English LSTM model"));}
    let long=pixels.width().max(pixels.height());
    let upscaled=(long<640).then(||image::imageops::resize(pixels,(u64::from(pixels.width())*640/u64::from(long.max(1)))as u32,(u64::from(pixels.height())*640/u64::from(long.max(1)))as u32,image::imageops::FilterType::Lanczos3));
    let pixels=upscaled.as_ref().unwrap_or(pixels);
    let mut rgb=Vec::with_capacity(pixels.width()as usize*pixels.height()as usize*3);
    for pixel in pixels.pixels(){for channel in &pixel.0[..3]{rgb.push(((*channel as u16*pixel.0[3]as u16+255*(255-pixel.0[3]as u16))/255)as u8);}}
    set_image(api.0,rgb.as_ptr(),pixels.width()as c_int,pixels.height()as c_int,3,pixels.width()as c_int*3);
    if recognize(api.0,std::ptr::null_mut())!=0{return Err(failure("provider_failed","Tesseract recognition did not complete"));}
    let tsv=get_tsv(api.0,0);if tsv.is_null(){return Err(failure("provider_failed","Tesseract omitted its OCR layout"));}
    struct Text(*mut c_char,unsafe extern "C" fn(*const c_char));impl Drop for Text{fn drop(&mut self){unsafe{(self.1)(self.0);}}}let tsv=Text(tsv,free);
    let bytes=CStr::from_ptr(tsv.0).to_bytes();if bytes.len()>1048576{return Err(failure("resource_limit","OCR layout exceeds 1 MiB"));}
    let text=std::str::from_utf8(bytes).map_err(|_|failure("provider_failed","OCR layout is not UTF8"))?;
    parse_tsv(text,pixels.width(),pixels.height())
}}

fn parse_tsv(tsv:&str,width:u32,height:u32)->Result<Value>{
    let bad=||failure("provider_failed","Tesseract returned invalid text layout");
    // TessBaseAPIGetTsvText returns rows only; the header line comes from the TSV file renderer.
    let lines=tsv.lines().filter(|line|*line!="level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext");
    let mut groups:Vec<(String,u32,u32,u32,u32,f64,usize,String)>=vec![];
    let mut text_bytes=0usize;
    for line in lines{
        let fields=line.splitn(12,'\t').collect::<Vec<_>>();if fields.len()!=12{return Err(bad());}if fields[0]!="5"{continue;}
        let number=|i:usize|fields[i].parse::<u32>().map_err(|_|bad());
        let(left,top,w,h)=(number(6)?,number(7)?,number(8)?,number(9)?);
        let confidence=fields[10].parse::<f64>().map_err(|_|bad())?;let word=fields[11].trim();
        if word.is_empty(){continue;}
        if w==0||h==0||left.checked_add(w).is_none_or(|n|n>width)||top.checked_add(h).is_none_or(|n|n>height)||!confidence.is_finite()||!(0.0..=100.0).contains(&confidence)||word.contains('\0'){return Err(bad());}
        let key=fields[1..5].join(":");for i in 1..6{number(i)?;}
        if let Some(last)=groups.last_mut().filter(|g|g.0==key){last.1=last.1.min(left);last.2=last.2.min(top);last.3=last.3.max(left+w);last.4=last.4.max(top+h);last.5+=confidence;last.6+=1;last.7.push(' ');last.7.push_str(word);}else{groups.push((key,left,top,left+w,top+h,confidence,1,word.into()));}
        text_bytes+=word.len()+1;
        if groups.len()>4096||text_bytes>65536{return Err(failure("resource_limit","OCR text or region count exceeds its bound"));}
    }
    let regions=groups.into_iter().map(|(_,left,top,right,bottom,confidence,count,text)|json!({"text":text,"confidence":confidence/count as f64/100.0,"x":left as f64/width as f64,"y":(height-bottom)as f64/height as f64,"width":(right-left)as f64/width as f64,"height":(bottom-top)as f64/height as f64})).collect::<Vec<_>>();
    Ok(json!({"text":regions.iter().map(|r|r["text"].as_str().unwrap()).collect::<Vec<_>>().join("\n"),"count":regions.len(),"regions":regions}))
}
pub fn dispatch(action:&Value)->Value{
    if let Err(error)=validate(action){return error;}
    let Ok(_work)=WORK.try_lock()else{return failure("resource_limit","vision is busy; no work was queued");};
    let deadline=Instant::now()+Duration::from_secs(30);
    let mut request=json!({"action":action});
    if action.get("imagePath").is_none(){
        // Refuse a missing model BEFORE capturing, so the refusal does not spend a window
        // capture that could flake.
        if let Some(variable)=model_variables(action["sub"].as_str().unwrap_or("")).first(){if let Err(error)=crate::native_library::pinned_spec(variable){return error;}}
        let mut capture=json!({"type":"desktop_screenshot","format":"png","target_max_long_edge":0});if let Some(app)=action.get("app"){capture["app"]=app.clone();}
        // A single Hyprland toplevel-export can miss a static window frame; retry a few times.
        let mut result=crate::capture::dispatch("screenshot",&capture);
        for _ in 0..3{if result["success"]==true{break;}if result["error"].as_str().is_none_or(|e|!e.contains("capture deadline")&&!e.contains("deliver the frame")){break;}result=crate::capture::dispatch("screenshot",&capture);}
        if result["success"]!=true{return result;}
        request["dataUrl"]=result["data"]["dataUrl"].clone();
    }
    match crate::thumbnail::image_helper("--vision-ocr",&request,deadline){Ok(data)=>success(data),Err(error)=>error}
}
pub fn helper(parent:u32)->std::io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    let bytes=crate::read_frame(&mut std::io::stdin().lock())?.ok_or_else(||std::io::Error::other("OCR helper requires one framed request"))?;
    let request:Value=serde_json::from_slice(&bytes)?;
    let result=(||->Result<Value>{
        #[cfg(unix)]crate::thumbnail_pdf::limit_memory()?;
        let action=&request["action"];validate(action)?;
        let bytes=if let Some(path)=action["imagePath"].as_str(){crate::thumbnail::source_bytes(&crate::filesystem::absolute(path)?)?}else{
            let url=request["dataUrl"].as_str().and_then(|s|s.strip_prefix("data:image/png;base64,")).ok_or_else(||failure("invalid_request","OCR helper requires native PNG pixels"))?;
            STANDARD.decode(url).map_err(|_|failure("invalid_request","OCR image bytes are invalid"))?
        };
        let pixels=crate::thumbnail::decode_raster(&bytes)?;
        let sub=action["sub"].as_str().unwrap();
        // The operating system first: Windows OCR and FaceDetector, the Linux GStreamer
        // face detector; an explicitly configured Tesseract still wins. Everything else runs on
        // the bundled models.
        let configured=|variable:&str|std::env::var_os(variable).is_some();
        let result=match sub{
            #[cfg(windows)]"text" if !configured("INTERCEPTOR_TESSERACT_LIBRARY")=>crate::vision_windows::text(&pixels)?,
            #[cfg(windows)]"faces"=>crate::vision_windows::faces(&pixels)?,
            #[cfg(target_os="linux")]"faces"=>crate::vision_linux::faces(&pixels)?,
            "text"=>recognize(&pixels)?,
            _=>bundled(&pixels,sub)?,
        };
        if let Some(path)=action["debugDumpPath"].as_str(){
            let destination=crate::filesystem::absolute(path)?;
            let png=crate::capture::encode(&pixels,"png",85)?;
            let mut options=std::fs::OpenOptions::new();options.write(true).create_new(true);
            #[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;options.mode(0o600).custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC);}
            let mut file=options.open(&destination).map_err(|e|failure(if e.kind()==std::io::ErrorKind::AlreadyExists{"invalid_request"}else if e.kind()==std::io::ErrorKind::PermissionDenied{"permission_denied"}else{"provider_failed"},format!("vision diagnostic destination cannot be created; original preserved: {e}")))?;
            use std::io::Write;
            file.write_all(&png).and_then(|_|file.sync_all()).map_err(|e|failure("partial_result",format!("vision diagnostic write failed; partial owned file retained: {e}")))?;
        }
        Ok(result)
    })();
    let result=match result{Ok(data)=>success(data),Err(error)=>error};
    crate::write_frame(&mut std::io::stdout().lock(),&serde_json::to_vec(&result)?)
}
pub fn capability(session:&str)->Value{
    json!({"operation":"vision","compiled":true,"present":true,"effective":false,"permission":"not_applicable","session":session,"background":"semantic","provider":"operating-system OCR and face detection / bundled hand, body and image-class models on tract","versions":{"contract":"1","tract":"0.23.8","image":"0.25.9"},"limits":["Text and faces use the operating system (Windows OCR and FaceDetector; Linux Tesseract 5.x and the GStreamer face detector).","Hands, bodies, classify and saliency run bundled models inside the provider; no vendor library is loaded and nothing leaves the machine.","Hands: up to 2, 21 named joints, no per-joint score (null). Bodies: 1, up to 33 named joints with the lower of the model's visibility and presence. Classify: ImageNet labels above 0.1, at most 20.","Saliency regions are the connected areas of the U2-Net-p salient-object map at or above 0.5; confidence is the mean map value in the area.","Owned reaped 512MiB helper; 30s total budget; 64 MiB files; 32 megapixels; input scaled to 1600px; normalized bottom-left coordinates.","EXIF orientation applied; diagnostic output is private/exclusive and never replaces an existing file."]})
}

/// The bundle entries a selector needs; empty when it needs none.
fn model_variables(sub:&str)->&'static [&'static str]{match sub{
    "hands"=>&["INTERCEPTOR_VISION_PALM_MODEL","INTERCEPTOR_VISION_HAND_MODEL"],
    "bodies"=>&["INTERCEPTOR_VISION_PERSON_MODEL","INTERCEPTOR_VISION_POSE_MODEL"],
    "classify"=>&["INTERCEPTOR_VISION_CLASSIFY_MODEL","INTERCEPTOR_VISION_CLASSIFY_LABELS"],
    "saliency"=>&["INTERCEPTOR_VISION_SALIENCY_MODEL"],
    _=>&[],
}}
fn bundled(pixels:&image::RgbaImage,sub:&str)->Result<Value>{
    let long=pixels.width().max(pixels.height());
    let scaled=if long>1600{Some(image::imageops::resize(pixels,((u64::from(pixels.width())*1600/u64::from(long)).max(1))as u32,((u64::from(pixels.height())*1600/u64::from(long)).max(1))as u32,image::imageops::FilterType::Triangle))}else{None};
    let pixels=scaled.as_ref().unwrap_or(pixels);
    let mut rgb=Vec::with_capacity(pixels.width()as usize*pixels.height()as usize*3);
    for pixel in pixels.pixels(){for channel in &pixel.0[..3]{rgb.push(((*channel as u16*pixel.0[3]as u16+255*(255-pixel.0[3]as u16))/255)as u8);}}
    let image=crate::vision_models::Rgb{width:pixels.width()as usize,height:pixels.height()as usize,data:&rgb};
    let mut files=Vec::new();for variable in model_variables(sub){files.push(pinned_bytes(variable,64*1024*1024)?.1);}
    match sub{
        "hands"=>crate::vision_models::hands(&image,&files[0],&files[1]),
        "bodies"=>crate::vision_models::bodies(&image,&files[0],&files[1]),
        "classify"=>crate::vision_models::classify(&image,&files[0],&files[1]),
        "saliency"=>crate::vision_models::saliency(&image,&files[0]),
        _=>Err(failure("unsupported_operation","this host has no face detector")),
    }
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn tsv_lines_have_real_normalized_bounds_and_confidence(){
        let header="level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n";
        let result=parse_tsv(&format!("{header}5\t1\t1\t1\t1\t1\t10\t20\t20\t10\t90\tHello\n5\t1\t1\t1\t1\t2\t35\t20\t20\t10\t70\t世界\n"),100,100).unwrap();
        assert_eq!(result["text"],"Hello 世界");assert_eq!(result["count"],1);assert_eq!(result["regions"][0]["x"],0.1);assert_eq!(result["regions"][0]["y"],0.7);assert_eq!(result["regions"][0]["confidence"],0.8);
        assert!(parse_tsv(&format!("{header}5\t1\t1\t1\t1\t1\t99\t20\t20\t10\t90\tbad\n"),100,100).is_err());
        assert!(validate(&json!({"type":"desktop_vision","sub":"text","imagePath":"relative"})).is_err());
    }
    #[test]fn selectors_name_their_models_and_the_capability_row_is_valid(){
        assert_eq!(model_variables("hands").len(),2);assert_eq!(model_variables("classify")[1],"INTERCEPTOR_VISION_CLASSIFY_LABELS");assert_eq!(model_variables("saliency"),["INTERCEPTOR_VISION_SALIENCY_MODEL"]);assert!(model_variables("text").is_empty()&&model_variables("faces").is_empty());
        assert!(validate(&json!({"type":"desktop_vision","sub":"faces","debugDumpPath":"/fixture"})).is_err());
        assert!(serde_json::from_value::<DesktopCapability>(capability("fixture")).is_ok());
    }
}
