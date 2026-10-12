//! Linux faces through the distribution's GStreamer OpenCV `facedetect` element
//! (gst-plugin-opencv, Haar cascade). OpenCV's cascade reports no score, so
//! confidence is null (contract `DesktopVisionConfidence`).
use crate::failure;
use gstreamer as gst;
use gstreamer::prelude::*;
use serde_json::{Value,json};
type Result<T>=std::result::Result<T,Value>;

pub(crate) fn faces(pixels:&image::RgbaImage)->Result<Value>{
    gst::init().map_err(|e|failure("not_installed",format!("GStreamer did not initialize: {e}")))?;
    if gst::ElementFactory::find("facedetect").is_none(){
        // The provider's GStreamer registry cache may predate the plugin; load the file directly.
        let mut loaded=false;let mut last=String::new();
        for dir in ["/usr/lib/gstreamer-1.0","/usr/lib/aarch64-linux-gnu/gstreamer-1.0","/usr/lib/x86_64-linux-gnu/gstreamer-1.0","/usr/lib64/gstreamer-1.0"]{
            let path=std::path::Path::new(dir).join("libgstopencv.so");
            if path.is_file(){match gst::Plugin::load_file(&path){Ok(_)=>{loaded=true;break;},Err(e)=>last=e.to_string()}}
        }
        if !loaded||gst::ElementFactory::find("facedetect").is_none(){return Err(failure("not_installed",format!("Linux face detection needs the GStreamer OpenCV plugin (gst-plugin-opencv){}",if last.is_empty(){String::new()}else{format!("; {last}")})));}
    }
    let long=pixels.width().max(pixels.height());
    let scaled=(long>1600).then(||image::imageops::resize(pixels,((u64::from(pixels.width())*1600/u64::from(long)).max(1))as u32,((u64::from(pixels.height())*1600/u64::from(long)).max(1))as u32,image::imageops::FilterType::Triangle));
    let pixels=scaled.as_ref().unwrap_or(pixels);let(width,height)=(pixels.width(),pixels.height());
    let error=|e:&dyn std::fmt::Display|failure("provider_failed",format!("GStreamer face detection failed: {e}"));
    let pipeline=gst::parse::launch(&format!("appsrc name=src format=time caps=video/x-raw,format=RGBA,width={width},height={height},framerate=0/1 ! videoconvert ! facedetect display=false updates=every_frame ! fakesink sync=false")).map_err(|e|error(&e))?
        .downcast::<gst::Pipeline>().map_err(|_|failure("provider_failed","GStreamer face pipeline is not a pipeline"))?;
    struct Stop(gst::Pipeline);impl Drop for Stop{fn drop(&mut self){let _=self.0.set_state(gst::State::Null);}}
    let pipeline=Stop(pipeline);
    let src=pipeline.0.by_name("src").and_then(|e|e.downcast::<gstreamer_app::AppSrc>().ok()).ok_or_else(||failure("provider_failed","GStreamer face pipeline has no source"))?;
    pipeline.0.set_state(gst::State::Playing).map_err(|e|error(&e))?;
    let mut buffer=gst::Buffer::from_slice(pixels.as_raw().clone());
    buffer.get_mut().unwrap().set_pts(gst::ClockTime::ZERO);
    src.push_buffer(buffer).map_err(|e|error(&e))?;src.end_of_stream().map_err(|e|error(&e))?;
    let bus=pipeline.0.bus().ok_or_else(||failure("provider_failed","GStreamer face pipeline has no bus"))?;
    let mut faces=vec![];let mut seen=false;
    for message in bus.iter_timed(gst::ClockTime::from_seconds(20)){
        match message.view(){
            gst::MessageView::Element(element)=>if let Some(s)=element.structure().filter(|s|s.name()=="facedetect"){
                seen=true;
                let Ok(list)=s.get::<gst::List>("faces")else{continue};
                for value in list.iter(){
                    let Ok(face)=value.get::<gst::Structure>()else{continue};
                    let n=|k:&str|face.get::<u32>(k).map(f64::from).unwrap_or(0.0);
                    let(x,y,w,h)=(n("x"),n("y"),n("width"),n("height"));if w<=0.0||h<=0.0{continue;}
                    let(fw,fh)=(width as f64,height as f64);let x0=(x/fw).clamp(0.0,1.0);let x1=((x+w)/fw).clamp(0.0,1.0);let y0=(y/fh).clamp(0.0,1.0);let y1=((y+h)/fh).clamp(0.0,1.0);
                    faces.push(json!({"x":x0,"y":1.0-y1,"width":x1-x0,"height":y1-y0,"confidence":Value::Null}));if faces.len()==64{break;}
                }
            },
            gst::MessageView::Eos(_)=>break,
            gst::MessageView::Error(e)=>return Err(error(&e.error())),
            _=>(),
        }
    }
    if !seen{return Err(failure("provider_failed","GStreamer facedetect reported no result for the frame"));}
    Ok(json!({"count":faces.len(),"faces":faces}))
}
