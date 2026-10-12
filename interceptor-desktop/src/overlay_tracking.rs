//! Independent exact-display capture and native face measurements. This private
//! helper never replaces the public capture stream or accepts an app fallback.
use crate::{failure,success,overlay_validation as validation};
use base64::Engine;
use serde_json::{Value,json};
use std::{io,time::{Duration,Instant}};

pub(crate) fn helper(parent:u32)->io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    #[cfg(target_os="linux")]crate::thumbnail_pdf::limit_memory().map_err(|_|io::Error::other("tracking memory admission failed"))?;
    #[cfg(windows)]unsafe{
        use windows::Win32::System::Com::{CoInitializeEx,COINIT_MULTITHREADED};
        CoInitializeEx(None,COINIT_MULTITHREADED).ok().map_err(io::Error::other)?;
    }
    let bytes=crate::read_frame(&mut io::stdin().lock())?.filter(|b|b.len()<=4096).ok_or_else(||io::Error::other("tracking requires one bounded request"))?;
    let request:Value=serde_json::from_slice(&bytes)?;
    let epoch=request["epoch"].as_str().filter(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit())).ok_or_else(||io::Error::other("tracking epoch is invalid"))?;
    let display=request["display"].as_u64().filter(|id|*id>0&&*id<=9007199254740991).ok_or_else(||io::Error::other("tracking display identity is invalid"))?;
    let fps=request["fps"].as_f64().filter(|n|n.is_finite()&&(1.0..=30.0).contains(n)).ok_or_else(||io::Error::other("tracking rate must be1..30"))?;
    let mut index=0_u64;
    let result=(||->Result<(),Value>{
        #[cfg(target_os="linux")]if std::env::var_os("WAYLAND_DISPLAY").is_some()&&!crate::capture_linux::hyprland_available(){return Err(failure("unsupported_target","portal consent does not prove the selected overlay output identity; exact Wayland tracking capture needs Hyprland"));}
        // Existing Vision validates pinned runtime/model bytes inside its own
        // helper. Captured pixels are bounded before its native inference.
        let target=json!({"type":"desktop_capture","sub":"start","mode":"display","display":display});
        #[cfg(any(windows,target_os="linux"))]let mut source=crate::capture::Source::open(&target,true)?;
        let mut first=true;let mut last_frame=Instant::now();
        loop {
            let deadline=Instant::now()+Duration::from_secs(8);
            #[cfg(any(windows,target_os="linux"))]crate::display::records(Some(display))?;
            #[cfg(any(windows,target_os="linux"))]let pixels=loop {
                match source.next_frame()?{Some(pixels)=>break pixels,None=>{if Instant::now()>=deadline{return Err(failure("provider_failed","selected native tracking display supplied no complete frame within 8s"));}std::thread::sleep(Duration::from_millis(5));}}
            };
            #[cfg(not(any(windows,target_os="linux")))]return Err(failure("unsupported_operation","macOS tracking uses native Vision"));
            #[cfg(any(windows,target_os="linux"))]{
                crate::capture::pixel_size(pixels.width(),pixels.height())?;
                let width=pixels.width();let height=pixels.height();
                let resized=if width.max(height)>1600{let edge=width.max(height)as u64;image::imageops::resize(&pixels,(width as u64*1600/edge).max(1)as u32,(height as u64*1600/edge).max(1)as u32,image::imageops::FilterType::Triangle)}else{pixels};
                let png=crate::capture::encode(&resized,"png",85)?;
                let data_url=format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(png));
                let observations=crate::thumbnail::image_helper("--vision-ocr",&json!({"action":{"type":"desktop_vision","sub":"faces"},"dataUrl":data_url}),deadline)?;
                let faces=observations["faces"].as_array().filter(|v|v.len()<=64).ok_or_else(||failure("provider_failed","native tracking detector omitted its bounded face measurements"))?;
                if observations["count"].as_u64()!=Some(faces.len()as u64)||faces.iter().any(|face|["x","y","width","height"].iter().any(|k|face[*k].as_f64().is_none_or(|n|!n.is_finite()||!(0.0..=1.0).contains(&n)))||!face["confidence"].is_null()&&face["confidence"].as_f64().is_none_or(|n|!n.is_finite()||!(0.0..=1.0).contains(&n))||face["width"]==0||face["height"]==0||face["x"].as_f64().unwrap()+face["width"].as_f64().unwrap()>1.000001||face["y"].as_f64().unwrap()+face["height"].as_f64().unwrap()>1.000001){return Err(failure("provider_failed","tracking detector returned invalid normalized face measurements"));}
                index=index.checked_add(1).ok_or_else(||failure("resource_limit","tracking frame serial exhausted"))?;
                let now=Instant::now();let interval=now.duration_since(last_frame).as_secs_f64();last_frame=now;
                let result=success(json!({"faces":faces,"capturedWidth":width,"capturedHeight":height,"frames":index,"intervalSeconds":if first{Value::Null}else{json!(interval)},"requestedFPS":fps,"unavailable":["face landmarks","emotion/expression classification","body/hand expression details"]}));
                first=false;let reply=json!({"epoch":epoch,"result":result});let bytes=serde_json::to_vec(&reply).map_err(|_|failure("provider_failed","tracking result serialization failed"))?;
                if bytes.len()>validation::RESULT_BYTES{return Err(failure("resource_limit","tracking observation exceeds 128KiB"));}
                crate::write_frame(&mut io::stdout().lock(),&bytes).map_err(|_|failure("cancelled","tracking owner closed its private result channel"))?;
                let next=now+Duration::from_secs_f64(1.0/fps);while Instant::now()<next{std::thread::sleep(Duration::from_millis(2));}
            }
        }
    })();
    if let Err(error)=result{crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(&json!({"epoch":epoch,"result":error}))?)?;}
    Ok(())
}
