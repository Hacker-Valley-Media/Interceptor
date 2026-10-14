//! Windows Vision through the operating system: Windows.Media.Ocr for text and
//! Windows.Media.FaceAnalysis.FaceDetector for faces. Neither reports a score, so
//! confidence is null (contract `DesktopVisionConfidence`).
use crate::failure;
use serde_json::{Value,json};
use windows::{Graphics::Imaging::{BitmapPixelFormat,SoftwareBitmap},Media::{FaceAnalysis::FaceDetector,Ocr::OcrEngine},Storage::Streams::DataWriter,Win32::System::WinRT::{RO_INIT_MULTITHREADED,RoInitialize}};
type Result<T>=std::result::Result<T,Value>;

fn runtime()->Result<()>{
    // The helper process owns one apartment for its single request; a second init on the same thread is fine.
    match unsafe{RoInitialize(RO_INIT_MULTITHREADED)}{Ok(())=>Ok(()),Err(e) if e.code()==windows::Win32::Foundation::RPC_E_CHANGED_MODE=>Ok(()),Err(e)=>Err(failure("provider_failed",format!("Windows runtime initialization failed: {e}")))}
}
fn bitmap(bytes:&[u8],format:BitmapPixelFormat,width:u32,height:u32)->Result<SoftwareBitmap>{
    let error=|e:windows::core::Error|failure("provider_failed",format!("Windows bitmap creation failed: {e}"));
    let writer=DataWriter::new().map_err(error)?;writer.WriteBytes(bytes).map_err(error)?;
    SoftwareBitmap::CreateCopyFromBuffer(&writer.DetachBuffer().map_err(error)?,format,width as i32,height as i32).map_err(error)
}
/// Normalized bottom-left region, as the Mac and the other backends report it.
fn region(x:f64,y:f64,w:f64,h:f64,width:u32,height:u32)->Value{
    let(fw,fh)=(width as f64,height as f64);
    let x0=(x/fw).clamp(0.0,1.0);let x1=((x+w)/fw).clamp(0.0,1.0);let y0=(y/fh).clamp(0.0,1.0);let y1=((y+h)/fh).clamp(0.0,1.0);
    json!({"x":x0,"y":1.0-y1,"width":x1-x0,"height":y1-y0,"confidence":Value::Null})
}
fn scaled(pixels:&image::RgbaImage,limit:u32)->std::borrow::Cow<'_,image::RgbaImage>{
    let long=pixels.width().max(pixels.height());
    // Downscale past the OCR ceiling; upscale tiny captures, which the OS OCR otherwise reads as empty.
    let target=if long>limit{limit}else if long<640{640}else{return std::borrow::Cow::Borrowed(pixels);};
    let(w,h)=((u64::from(pixels.width())*u64::from(target)/u64::from(long)).max(1)as u32,(u64::from(pixels.height())*u64::from(target)/u64::from(long)).max(1)as u32);
    std::borrow::Cow::Owned(image::imageops::resize(pixels,w,h,image::imageops::FilterType::Lanczos3))
}

pub(crate) fn text(pixels:&image::RgbaImage)->Result<Value>{
    runtime()?;
    let error=|e:windows::core::Error|failure("provider_failed",format!("Windows OCR failed: {e}"));
    let engine=OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_|failure("not_installed","Windows OCR has no recognizer for this user's languages; add an OCR-capable language in Settings > Time & language > Language & region"))?;
    let limit=OcrEngine::MaxImageDimension().map_err(error)?;
    let pixels=scaled(pixels,limit);let(width,height)=(pixels.width(),pixels.height());
    let mut bgra=Vec::with_capacity(width as usize*height as usize*4);
    for p in pixels.pixels(){let a=p.0[3]as u16;for c in [p.0[2],p.0[1],p.0[0]]{bgra.push(((c as u16*a+255*(255-a))/255)as u8);}bgra.push(255);}
    let result=engine.RecognizeAsync(&bitmap(&bgra,BitmapPixelFormat::Bgra8,width,height)?).map_err(error)?.join().map_err(error)?;
    let mut regions=vec![];let mut bytes=0usize;
    for line in result.Lines().map_err(error)?{
        let text=line.Text().map_err(error)?.to_string_lossy();let text=text.trim();if text.is_empty(){continue;}
        let(mut x0,mut y0,mut x1,mut y1)=(f64::MAX,f64::MAX,0f64,0f64);
        for word in line.Words().map_err(error)?{let r=word.BoundingRect().map_err(error)?;x0=x0.min(r.X as f64);y0=y0.min(r.Y as f64);x1=x1.max((r.X+r.Width)as f64);y1=y1.max((r.Y+r.Height)as f64);}
        if x1<=x0||y1<=y0{continue;}
        bytes+=text.len()+1;if regions.len()>=4096||bytes>65536{return Err(failure("resource_limit","OCR text or region count exceeds its bound"));}
        let mut row=region(x0,y0,x1-x0,y1-y0,width,height);row["text"]=json!(text);regions.push(row);
    }
    Ok(json!({"text":regions.iter().map(|r|r["text"].as_str().unwrap()).collect::<Vec<_>>().join("\n"),"count":regions.len(),"regions":regions}))
}

pub(crate) fn faces(pixels:&image::RgbaImage)->Result<Value>{
    runtime()?;
    let error=|e:windows::core::Error|failure("provider_failed",format!("Windows face detection failed: {e}"));
    if !FaceDetector::IsSupported().map_err(error)?{return Err(failure("unsupported_target","Windows FaceDetector is not supported on this device"));}
    let pixels=scaled(pixels,4096);let(width,height)=(pixels.width(),pixels.height());
    let gray:Vec<u8>=pixels.pixels().map(|p|{let a=p.0[3]as u32;let l=(299*p.0[0]as u32+587*p.0[1]as u32+114*p.0[2]as u32)/1000;((l*a+255*(255-a))/255)as u8}).collect();
    let detector=FaceDetector::CreateAsync().map_err(error)?.join().map_err(error)?;
    let found=detector.DetectFacesAsync(&bitmap(&gray,BitmapPixelFormat::Gray8,width,height)?).map_err(error)?.join().map_err(error)?;
    let mut faces=vec![];
    for face in found{let b=face.FaceBox().map_err(error)?;if b.Width==0||b.Height==0{continue;}faces.push(region(b.X as f64,b.Y as f64,b.Width as f64,b.Height as f64,width,height));if faces.len()==64{break;}}
    Ok(json!({"count":faces.len(),"faces":faces}))
}
