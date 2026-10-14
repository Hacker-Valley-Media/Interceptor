//! GUI-thread-only webviews. The provider owns this process through private
//! framed pipes and the existing process-group/job lifetime boundary.
use crate::{failure, success, overlay_validation as validation};
use base64::Engine as _;
use serde_json::{Value,json};
use std::{io, sync::{mpsc,Arc,Mutex,atomic::{AtomicBool,Ordering}}, time::{Duration,Instant}};
use wry::{WebView,WebViewBuilder,PageLoadEvent,PermissionResponse,NewWindowResponse};

enum Event { Loaded, Evaluation(String,String), Request(Value), Tracking(String,Value), Eof }
struct Tracking {
    epoch:String,cancel:Arc<AtomicBool>,done:Arc<AtomicBool>,error:Arc<Mutex<Option<Value>>>,
}
impl Drop for Tracking{fn drop(&mut self){self.cancel.store(true,Ordering::Release);}}
impl Tracking {
    fn spawn(display:u64,fps:f64,sender:mpsc::SyncSender<Event>)->Result<Self,Value>{
        let epoch=crate::secret_target::random_token().map_err(|e|failure("provider_failed",e))?;
        let cancel=Arc::new(AtomicBool::new(false));let done=Arc::new(AtomicBool::new(false));let error=Arc::new(Mutex::new(None));
        let owned_epoch=epoch.clone();let owned_cancel=cancel.clone();let owned_done=done.clone();let owned_error=error.clone();
        std::thread::Builder::new().name("overlay-tracking-owner".into()).spawn(move||{
            let result=(||->io::Result<()>{
                let mut helper=crate::thumbnail::OwnedHelper::spawn("--overlay-tracking")?;
                let mut input=helper.child.0.stdin.take().ok_or_else(||io::Error::other("tracking input missing"))?;
                let mut output=helper.child.0.stdout.take().ok_or_else(||io::Error::other("tracking output missing"))?;
                crate::write_frame(&mut input,&serde_json::to_vec(&json!({"epoch":owned_epoch,"display":display,"fps":fps}))?)?;drop(input);
                let mut serial=0;
                loop {
                    let bytes=crate::auth::bounded_child_result(|bytes|{
                        if owned_cancel.load(Ordering::Acquire){return Err(io::ErrorKind::ConnectionAborted.into());}crate::auth::ready_read(&mut output,bytes)
                    },Instant::now()+Duration::from_secs(10),validation::RESULT_BYTES)?;
                    let reply:Value=serde_json::from_slice(&bytes)?;
                    if reply["epoch"]!=owned_epoch||!validation::bounded(&reply,validation::RESULT_BYTES){return Err(io::Error::other("tracking frame identity or bounds differ"));}
                    if reply["result"]["success"]!=true{*owned_error.lock().unwrap()=Some(reply["result"].clone());return Err(io::Error::other("native tracking failed"));}
                    let next=reply["result"]["data"]["frames"].as_u64().filter(|n|*n>serial&&*n<=9007199254740991).ok_or_else(||io::Error::other("tracking frame serial is invalid"))?;serial=next;
                    if !owned_cancel.load(Ordering::Acquire){let _=sender.try_send(Event::Tracking(owned_epoch.clone(),reply["result"]["data"].clone()));}
                }
            })();
            if result.is_err()&&!owned_cancel.load(Ordering::Acquire)&&owned_error.lock().unwrap().is_none(){*owned_error.lock().unwrap()=Some(failure("provider_failed","tracking helper ended without a complete native observation; its direct child was reaped"));}
            // OwnedHelper drops and reaps before this flag releases admission.
            owned_done.store(true,Ordering::Release);
        }).map_err(|_|failure("resource_limit","tracking owner thread admission failed"))?;
        Ok(Self{epoch,cancel,done,error})
    }
}
struct Engine {
    generation:String, action:Value, metadata:Value, events:mpsc::Receiver<Event>,
    sender:mpsc::SyncSender<Event>, webview:WebView, ready:bool, evaluating:bool, pending_selector:String,
    startup:Instant, expires:Option<Instant>,
    tracking:Option<Tracking>,tracking_start_ticket:Option<String>,latest_tracking:Option<Value>,tracking_status:Value,
}
fn emit(generation:&str,ticket:&str,result:Value)->io::Result<()> {
    let reply=json!({"generation":generation,"ticket":ticket,"result":result});
    let bytes=serde_json::to_vec(&reply)?;
    if bytes.len()>validation::RESULT_BYTES+8192{return Err(io::Error::other("overlay reply exceeds its bound"));}
    crate::write_frame(&mut io::stdout().lock(),&bytes)
}
fn preflight(generation:&str,pixels:u64)->Result<(),Value> {
    if pixels==0||pixels>67108864{return Err(failure("resource_limit","native overlay backing pixels exceed 64Mi"));}
    emit(generation,"admission",success(json!({"pixels":pixels}))).map_err(|_|failure("provider_failed","native overlay preflight channel failed"))?;
    let bytes=crate::read_frame(&mut io::stdin().lock()).map_err(|_|failure("cancelled","native overlay admission owner ended"))?.filter(|b|b.len()<=1024).ok_or_else(||failure("cancelled","native overlay admission owner ended"))?;
    let ack:Value=serde_json::from_slice(&bytes).map_err(|_|failure("invalid_request","native overlay admission is malformed"))?;
    if ack["generation"]!=generation||ack["ticket"]!="admission"||ack["allow"]!=true{return Err(failure("cancelled","native overlay backing-pixel admission was not granted"));}Ok(())
}
fn mode(a:&Value)->&'static str {if a.get("particles").is_some(){"particles"}else if a.get("scene").is_some(){"scene"}else if a.get("scene_script").is_some(){"scene-script"}else{"html"}}
fn content(a:&Value)->Result<Option<String>,Value> {
    if a.get("url").is_some(){return Ok(None);}
    if let Some(s)=a["html_b64"].as_str(){let bytes=base64::engine::general_purpose::STANDARD.decode(s).map_err(|_|failure("invalid_request","invalid overlay HTML"))?;return String::from_utf8(bytes).map(Some).map_err(|_|failure("invalid_request","overlay HTML is not UTF-8"));}
    let mut cfg=a.clone();cfg["mode"]=json!(mode(a));
    // Escaping the HTML delimiter keeps operator scene text from terminating
    // this script element. Its values remain JSON, never executable source.
    let cfg=serde_json::to_string(&cfg).map_err(|_|failure("provider_failed","overlay config serialization failed"))?.replace('<',"\\u003c");
    let spec=serde_json::to_string(validation::spec()).unwrap().replace('<',"\\u003c");
    Ok(Some(format!("<!doctype html><html><head><meta charset='utf-8'><meta name='color-scheme' content='light dark'></head><body><script>window.__itcOverlayConfig={cfg};window.__itcOverlaySpec={spec};{}</script></body></html>",include_str!("../overlay/renderer.ts"))))
}
fn frame(a:&Value,display:&Value)->Result<Value,Value> {
    let x=display["x"].as_f64().ok_or_else(||failure("provider_failed","display has no native origin"))?;
    let y=display["y"].as_f64().ok_or_else(||failure("provider_failed","display has no native origin"))?;
    let dw=display["width"].as_f64().unwrap_or(0.0);let dh=display["height"].as_f64().unwrap_or(0.0);
    let mut result=if let Some(r)=a.get("rect"){json!({"x":r["x"].as_f64().unwrap_or(x),"y":r["y"].as_f64().unwrap_or(y),"width":r["width"],"height":r["height"]})}else if let Some(anchor)=a["anchor"].as_str(){
        let w=a["width"].as_f64().unwrap_or(400.0);let h=a["height"].as_f64().unwrap_or(160.0);
        let px=if ["tl","bl","left"].contains(&anchor){x}else if ["tr","br","right"].contains(&anchor){x+dw-w}else{x+(dw-w)/2.0};
        let py=if ["tl","tr","top"].contains(&anchor){y}else if ["bl","br","bottom"].contains(&anchor){y+dh-h}else{y+(dh-h)/2.0};
        json!({"x":px,"y":py,"width":w,"height":h})
    }else{json!({"x":x,"y":y,"width":dw,"height":dh})};
    let rx=result["x"].as_f64().unwrap();let ry=result["y"].as_f64().unwrap();let w=result["width"].as_f64().unwrap();let h=result["height"].as_f64().unwrap();
    if ![rx,ry,w,h].iter().all(|n|n.is_finite())||rx.abs()>131072.0||ry.abs()>131072.0||w<1.0||h<1.0||w>16384.0||h>16384.0||w*h>67108864.0||rx+w<=x||ry+h<=y||rx>=x+dw||ry>=y+dh{return Err(failure("invalid_request","overlay frame does not intersect the selected native display or exceeds its bound"));}
    for key in ["x","y","width","height"]{result[key]=json!(result[key].as_f64().unwrap().round());}Ok(result)
}
fn channels()->(mpsc::SyncSender<Event>,mpsc::Receiver<Event>) {
    let(tx,rx)=mpsc::sync_channel(8);let reader=tx.clone();
    std::thread::spawn(move||{
        let mut input=io::stdin().lock();loop{
            let request=match crate::read_frame(&mut input){Ok(Some(bytes))if bytes.len()<=validation::REQUEST_BYTES+8192=>serde_json::from_slice(&bytes).ok(),_=>None};
            let Some(request)=request else{let _=reader.send(Event::Eof);break;};
            if reader.send(Event::Request(request)).is_err(){break;}
        }
    });(tx,rx)
}
fn builder<'a>(a:&Value,sender:mpsc::SyncSender<Event>)->Result<WebViewBuilder<'a>,Value> {
    let loaded=sender.clone();
    let mut builder=WebViewBuilder::new().with_transparent(true).with_focused(false).with_incognito(true)
        .with_permission_handler(|_|PermissionResponse::Deny)
        .with_new_window_req_handler(|_,_|NewWindowResponse::Deny)
        .with_on_page_load_handler(move|event,_|{if matches!(event,PageLoadEvent::Finished){let _=loaded.try_send(Event::Loaded);}});
    builder=if let Some(html)=content(a)?{builder.with_html(html)}else{builder.with_url(a["url"].as_str().unwrap())};
    Ok(builder)
}
impl Engine {
    fn new(a:Value,generation:String,metadata:Value,webview:WebView,tx:mpsc::SyncSender<Event>,rx:mpsc::Receiver<Event>)->Self {
        let now=Instant::now();let expires=a["timeout_seconds"].as_f64().map(|s|now+Duration::from_secs_f64(s));
        Self{generation,action:a,metadata,events:rx,sender:tx,webview,ready:false,evaluating:false,pending_selector:String::new(),startup:now,expires,tracking:None,tracking_start_ticket:None,latest_tracking:None,tracking_status:json!({"active":false,"nativeCleanupPending":false})}
    }
    fn evaluate(&mut self,ticket:&str,source:&str)->io::Result<()> {
        if self.evaluating{return emit(&self.generation,ticket,failure("resource_limit","native overlay evaluation is unresolved"));}
        self.evaluating=true;let tx=self.sender.clone();let owned=ticket.to_owned();
        let result=self.webview.evaluate_script_with_callback(source,move|raw|{let _=tx.try_send(Event::Evaluation(owned.clone(),raw));});
        if result.is_err(){
            self.evaluating=false;
            let error=failure("provider_failed","native webview refused JavaScript evaluation");
            if self.pending_selector=="tracking" {self.tracking_status["lastError"]=error;if let Some(tracking)=&self.tracking{tracking.cancel.store(true,Ordering::Release);}}
            else {if self.pending_selector=="tracking-start"{if let Some(tracking)=&self.tracking{tracking.cancel.store(true,Ordering::Release);}}emit(&self.generation,ticket,error)?;}
            self.pending_selector.clear();
        }
        Ok(())
    }
    fn step(&mut self,metadata:Result<Value,Value>)->io::Result<bool> {
        match metadata {Ok(meta)=>self.metadata=meta,Err(e)=>{let _=emit(&self.generation,"lifecycle",e);return Ok(false);}}
        if self.tracking.as_ref().is_some_and(|t|t.done.load(Ordering::Acquire)) {
            let error=self.tracking.as_ref().unwrap().error.lock().unwrap().clone();
            self.tracking_status["active"]=json!(false);self.tracking_status["nativeCleanupPending"]=json!(false);
            if let Some(error)=error {self.tracking_status["lastError"]=error.clone();if let Some(ticket)=self.tracking_start_ticket.take(){emit(&self.generation,&ticket,error)?;}}
            self.tracking=None;self.latest_tracking=None;
        }
        self.metadata["tracking"]=self.tracking_status.clone();
        if self.expires.is_some_and(|t|Instant::now()>=t){return Ok(false);}
        if !self.ready&&self.startup.elapsed()>Duration::from_secs(30){let _=emit(&self.generation,"start",failure("timeout_unknown_outcome","native overlay content did not finish loading within 30s"));return Ok(false);}
        for _ in 0..8 {
            let event=match self.events.try_recv(){Ok(e)=>e,Err(mpsc::TryRecvError::Empty)=>break,Err(_)=>return Ok(false)};
            match event {
                Event::Eof=>return Ok(false),
                Event::Loaded if !self.ready&&!self.evaluating=>{
                    let source=if mode(&self.action)=="html"{"JSON.stringify({success:true,data:{ready:document.readyState==='complete'}})"}else{"JSON.stringify((()=>{try{if(!window.__itcOverlay)throw new Error('overlay renderer did not initialize');return{success:true,data:window.__itcOverlay.status()}}catch(e){return{success:false,code:'provider_failed',error:String(e.message).slice(0,1024)}}})())"};
                    self.pending_selector="start".into();self.evaluate("start",source)?;
                }
                Event::Evaluation(ticket,raw)=>{
                    self.evaluating=false;
                    let selector=std::mem::take(&mut self.pending_selector);
                    // evaluate_script_with_callback serializes its return value;
                    // our expression returns an explicitly bounded JSON string.
                    let result=(||->Result<Value,Value>{
                        if raw.len()>validation::RESULT_BYTES*2{return Err(failure("resource_limit","native evaluation exceeds 128KiB"));}
                        let text:Value=serde_json::from_str(&raw).map_err(|_|failure("provider_failed","native evaluation returned invalid JSON"))?;
                        let encoded=text.as_str().ok_or_else(||failure("provider_failed","native evaluation did not return a JSON string"))?;
                        if encoded.len()>validation::RESULT_BYTES{return Err(failure("resource_limit","native evaluation exceeds 128KiB"));}
                        let value:Value=serde_json::from_str(encoded).map_err(|_|failure("provider_failed","overlay result contains malformed JSON"))?;
                        if !validation::bounded(&value,validation::RESULT_BYTES)||!value["success"].is_boolean(){return Err(failure("provider_failed","native evaluation returned invalid bounded result"));}Ok(value)
                    })();
                    let mut result=match result{Ok(v)=>v,Err(e)=>e};
                    if selector=="tracking" {if result["success"]!=true {self.tracking_status["lastError"]=result;if let Some(tracking)=&self.tracking{tracking.cancel.store(true,Ordering::Release);}}continue;}
                    if selector=="tracking-start"&&result["success"]!=true {if let Some(tracking)=&self.tracking{tracking.cancel.store(true,Ordering::Release);}self.tracking_status["lastError"]=result.clone();}
                    if ticket=="start"{
                        if result["success"]!=true{emit(&self.generation,"start",result)?;return Ok(false);}
                        if mode(&self.action)=="html"&&result["data"]["ready"]!=true{emit(&self.generation,"start",failure("provider_failed","native page-load receipt does not report a complete document"))?;return Ok(false);}
                        self.ready=true;let mut data=self.metadata.clone();data["renderer"]=result["data"].clone();result=success(data);
                    }else if result["success"]==true&&selector=="status"{let mut data=self.metadata.clone();data["renderer"]=result["data"].clone();result=success(data);}
                    else if result["success"]==true&&selector=="eval"{result=success(json!({"id":self.action["id"],"generation":self.generation,"result":result["data"]}));}
                    emit(&self.generation,&ticket,result)?;
                }
                Event::Request(request)=>{
                    let ticket=request["ticket"].as_str().filter(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit())).ok_or_else(||io::Error::other("overlay request ticket is invalid"))?;
                    let a=&request["action"];
                    if request["generation"]!=self.generation||a["id"]!=self.action["id"]{emit(&self.generation,ticket,failure("target_gone","overlay request targets a different generation"))?;continue;}
                    let sub=match validation::validate(a){Ok(s)=>s,Err(e)=>{emit(&self.generation,ticket,e)?;continue;}};
                    if !self.ready{emit(&self.generation,ticket,failure("resource_limit","overlay native content is still initializing"))?;continue;}
                    if sub=="ctl"&&mode(&self.action)=="scene-script"&&["face-track-start","face-track-stop"].contains(&a["verb"].as_str().unwrap_or("")) {
                        let args=match validation::control("scene-script",a["verb"].as_str().unwrap(),&a["args"]){Ok(v)=>v,Err(e)=>{emit(&self.generation,ticket,e)?;continue;}};
                        if a["verb"]=="face-track-start" {
                            if self.evaluating||self.tracking.is_some(){emit(&self.generation,ticket,failure("resource_limit","a previous tracking generation or native callback still owns work; nothing queued"))?;continue;}
                            let display=self.metadata["display_id"].as_u64().ok_or_else(||io::Error::other("tracking display identity missing"))?;let fps=args["fps"].as_f64().unwrap_or(15.0);
                            match Tracking::spawn(display,fps,self.sender.clone()){Ok(tracking)=>{self.tracking_status=json!({"active":true,"nativeCleanupPending":true,"epoch":tracking.epoch,"requestedFPS":fps,"frames":0,"unavailable":["face landmarks","emotion/expression classification","body/hand expression details"]});self.tracking=Some(tracking);self.tracking_start_ticket=Some(ticket.to_owned());},Err(e)=>emit(&self.generation,ticket,e)?}
                        }else {
                            if let Some(tracking)=&self.tracking{tracking.cancel.store(true,Ordering::Release);}
                            self.latest_tracking=None;self.tracking_status["active"]=json!(false);self.tracking_status["nativeCleanupPending"]=json!(self.tracking.is_some());
                            emit(&self.generation,ticket,success(json!({"ok":true,"tracking":false,"nativeCleanupPending":self.tracking.is_some()})))?;
                        }continue;
                    }
                    if self.evaluating {emit(&self.generation,ticket,failure("resource_limit","native renderer callback is unresolved; no command queued"))?;continue;}
                    let source=match sub {
                        "status" if mode(&self.action)=="html"=>{let mut meta=self.metadata.clone();meta["url"]=json!(self.webview.url().ok());emit(&self.generation,ticket,success(meta))?;continue;}
                        "status"=>"JSON.stringify({success:true,data:window.__itcOverlay.status()})".to_owned(),
                        "ctl"=>{let args=match validation::control(mode(&self.action),a["verb"].as_str().unwrap(),&a["args"]){Ok(v)=>v,Err(e)=>{emit(&self.generation,ticket,e)?;continue;}};format!("JSON.stringify(window.__itcOverlay.control({},{}))",serde_json::to_string(&a["verb"])?,serde_json::to_string(&args)?)},
                        "eval"=>{let js=serde_json::to_string(a.get("js").unwrap_or(&a["javascript"]))?;format!("(()=>{{try{{const data=(0,eval)({js});if(data&&typeof data.then==='function')throw new Error('overlay eval requires a synchronous JSON result');const encoded=JSON.stringify({{success:true,data:data===undefined?null:data}});if(typeof encoded!=='string'||new TextEncoder().encode(encoded).byteLength>131072)return JSON.stringify({{success:false,code:'resource_limit',error:'overlay eval result exceeds 128KiB'}});return encoded}}catch(e){{return JSON.stringify({{success:false,code:'provider_failed',error:String(e.message).slice(0,1024)}})}}}})()")},
                        _=>{emit(&self.generation,ticket,failure("invalid_request","native overlay helper does not accept this selector"))?;continue;}
                    };
                    self.pending_selector=sub.into();self.evaluate(ticket,&source)?;
                }
                Event::Loaded=>(),
                Event::Tracking(epoch,data)=>{
                    if self.tracking.as_ref().is_some_and(|t|t.epoch==epoch&&!t.cancel.load(Ordering::Acquire)) {self.tracking_status["frames"]=data["frames"].clone();self.latest_tracking=Some(data);}
                }
            }
        }
        if self.ready&&!self.evaluating&&self.tracking.as_ref().is_some_and(|t|!t.cancel.load(Ordering::Acquire)) {
            if let Some(data)=self.latest_tracking.take() {
                let ticket=self.tracking_start_ticket.take();self.pending_selector=if ticket.is_some(){"tracking-start"}else{"tracking"}.into();
                let source=format!("JSON.stringify(window.__itcOverlay.track({},{},{}))",serde_json::to_string(&data)?,serde_json::to_string(&self.metadata["displayFrame"])?,serde_json::to_string(&self.metadata["frame"])?) ;
                self.evaluate(ticket.as_deref().unwrap_or("tracking"),&source)?;
            }
        }
        Ok(true)
    }
}

#[cfg(windows)]pub(crate) fn run(a:Value,generation:String)->io::Result<()> {
    use tao::{event_loop::{EventLoopBuilder,ControlFlow},window::WindowBuilder,dpi::{PhysicalPosition,PhysicalSize}};
    use wry::raw_window_handle::{HasWindowHandle,RawWindowHandle};
    use windows::Win32::{Foundation::HWND,Graphics::Gdi::{MonitorFromWindow,MONITOR_DEFAULTTONULL},UI::WindowsAndMessaging::*};
    let result=(||->Result<_,Value>{
        // tao makes the process per-monitor DPI aware when it builds the event loop. Build it
        // first so display geometry is read in physical pixels, not 125-150% logical sizes.
        let event_loop=EventLoopBuilder::<()>::new().build();
        let displays=crate::display_windows::read(None)?;let rows=displays.as_array().unwrap();
        let display=if let Some(id)=a["display_id"].as_f64(){rows.iter().find(|r|r["id"].as_f64()==Some(id))}else{rows.iter().find(|r|r["isMain"]==true)}.ok_or_else(||failure("target_gone","requested Win32 display is not active"))?.clone();
        let frame=frame(&a,&display)?;
        // The renderer caps its device scale at2. Reserve that conservative
        // bound before creating this generation's actual native window.
        preflight(&generation,(frame["width"].as_f64().unwrap()*frame["height"].as_f64().unwrap()*4.0).ceil()as u64)?;
        let foreground=unsafe{GetForegroundWindow()};
        let window=WindowBuilder::new().with_title("Interceptor overlay").with_visible(false).with_focused(false).with_focusable(a["interactive"]==true).with_decorations(false).with_transparent(true).with_resizable(false).with_always_on_top(true)
            .with_position(PhysicalPosition::new(frame["x"].as_f64().unwrap()as i32,frame["y"].as_f64().unwrap()as i32)).with_inner_size(PhysicalSize::new(frame["width"].as_f64().unwrap()as u32,frame["height"].as_f64().unwrap()as u32)).build(&event_loop).map_err(|_|failure("provider_failed","Win32 overlay window creation failed"))?;
        let handle=window.window_handle().map_err(|_|failure("provider_failed","overlay window handle unavailable"))?;
        let RawWindowHandle::Win32(native)=handle.as_raw()else{return Err(failure("provider_failed","overlay window has no Win32 handle"));};let hwnd=HWND(native.hwnd.get()as *mut _);
        window.set_ignore_cursor_events(a["interactive"]!=true).map_err(|_|failure("background_unavailable","Win32 overlay click-through could not be configured"))?;
        unsafe{let mut style=GetWindowLongPtrW(hwnd,GWL_EXSTYLE)as u32|WS_EX_TOOLWINDOW.0;if a["interactive"]!=true{style|=WS_EX_NOACTIVATE.0|WS_EX_TRANSPARENT.0;}let _=SetWindowLongPtrW(hwnd,GWL_EXSTYLE,style as isize);
            SetWindowPos(hwnd,Some(HWND_TOPMOST),frame["x"].as_f64().unwrap()as i32,frame["y"].as_f64().unwrap()as i32,frame["width"].as_f64().unwrap()as i32,frame["height"].as_f64().unwrap()as i32,SWP_NOACTIVATE|SWP_FRAMECHANGED).map_err(|_|failure("provider_failed","Win32 overlay placement failed"))?;
        }
        let(tx,rx)=channels();let webview=builder(&a,tx.clone())?.build(&window).map_err(|_|failure("not_installed","WebView2 overlay could not initialize; verify the installed WebView2 Runtime"))?;
        unsafe{if a["visible"]!=false{let _=ShowWindow(hwnd,SW_SHOWNOACTIVATE);}if GetForegroundWindow()!=foreground{return Err(failure("background_unavailable","native overlay initialization changed foreground ownership"));}}
        let owned_generation=generation.clone();let mut engine=Engine::new(a.clone(),generation.clone(),json!({}),webview,tx,rx);
        let readback=move||->Result<Value,Value>{unsafe{
            let monitor=MonitorFromWindow(hwnd,MONITOR_DEFAULTTONULL);if monitor.0.is_null()||monitor.0 as usize as u64!=display["id"].as_f64().unwrap()as u64{return Err(failure("target_gone","overlay left its selected Win32 monitor"));}
            crate::display_windows::read(Some(display["id"].as_f64().unwrap()as u64))?;
            let mut rect=windows::Win32::Foundation::RECT::default();GetWindowRect(hwnd,&mut rect).map_err(|_|failure("target_gone","overlay native window disappeared"))?;
            Ok(json!({"id":a["id"],"generation":owned_generation,"mode":mode(&a),"lifecycle":"active","display_id":display["id"],"displayFrame":display,"frame":{"x":rect.left,"y":rect.top,"width":rect.right-rect.left,"height":rect.bottom-rect.top},"requestedFrame":frame,"level":a["level"].as_str().unwrap_or("statusBar"),"nativeLevel":"HWND_TOPMOST","interactive":a["interactive"]==true,"visible":IsWindowVisible(hwnd).as_bool(),"provider":"WebView2"}))
        }};
        event_loop.run(move|_,_,control_flow|{*control_flow=ControlFlow::WaitUntil(Instant::now()+Duration::from_millis(10));match engine.step(readback()){Ok(true)=>(),_=>{unsafe{let _=DestroyWindow(hwnd);}*control_flow=ControlFlow::Exit;}}});
    })();
    match result{Ok(())=>Ok(()),Err(e)=>emit(&generation,"start",e)}
}

#[cfg(target_os="linux")]pub(crate) fn run(a:Value,generation:String)->io::Result<()> {
    use gtk::{prelude::*,glib::{self,translate::ToGlibPtr},gdk};
    use gtk_layer_shell::{LayerShell,Edge,Layer,KeyboardMode};
    use wry::WebViewBuilderExtUnix;
    let result=(||->Result<(),Value>{
        gtk::init().map_err(|_|failure("no_interactive_session","GTK overlay requires this user's graphical login"))?;
        let display=gdk::Display::default().ok_or_else(||failure("no_interactive_session","GDK has no graphical display"))?;
        let backend=display.type_().name();
        if !["GdkWaylandDisplay","GdkX11Display"].contains(&backend){return Err(failure("unsupported_operation","overlay requires an actual X11 or Wayland GDK display"));}
        let wayland=backend=="GdkWaylandDisplay";
        if wayland&&!gtk_layer_shell::is_supported(){return Err(failure("unsupported_operation","this Wayland compositor has no layer-shell; its native GNOME backend remains unimplemented"));}
        let mut output_registry=if wayland{Some(crate::display_wayland::Registry::open()?)}else{None};
        if let Some(registry)=&output_registry {
            unsafe {
                let get_display=libc::dlsym(libc::RTLD_DEFAULT,c"gdk_wayland_display_get_wl_display".as_ptr());let get_fd=libc::dlsym(libc::RTLD_DEFAULT,c"wl_display_get_fd".as_ptr());
                if get_display.is_null()||get_fd.is_null(){return Err(failure("unsupported_operation","GTK Wayland connection identity APIs are unavailable"));}
                let get_display:unsafe extern "C" fn(*mut gdk::ffi::GdkDisplay)->*mut libc::c_void=std::mem::transmute(get_display);
                let get_fd:unsafe extern "C" fn(*mut libc::c_void)->libc::c_int=std::mem::transmute(get_fd);
                let native=get_display(display.to_glib_none().0);if native.is_null(){return Err(failure("provider_failed","GTK has no native Wayland display"));}registry.verify_native_fd(get_fd(native))?;
            }
        }
        let mut monitors=Vec::new();for i in 0..display.n_monitors(){if let Some(m)=display.monitor(i){let r=m.geometry();monitors.push((m,json!({"x":r.x(),"y":r.y(),"width":r.width(),"height":r.height()})));}}
        if monitors.is_empty()||monitors.len()>32{return Err(failure("resource_limit","native overlay display count is invalid"));}
        if let Some(registry)=&output_registry {
            let rows=registry.records()?;
            for(monitor,row)in &mut monitors {
                let matches=rows.iter().filter(|r|["x","y","width","height"].iter().all(|k|r[*k]==row[*k])&&monitor.manufacturer().as_ref().is_none_or(|s|r["make"].as_str().is_none_or(|value|value==s.as_str()))&&monitor.model().as_ref().is_none_or(|s|r["model"].as_str().is_none_or(|value|value==s.as_str()))).collect::<Vec<_>>();
                if matches.len()!=1{return Err(failure("target_ambiguous","GDK monitor does not map to one authenticated compositor output"));}*row=matches[0].clone();
            }
        }else {
            let native=crate::linux_x11::display_records(None)?;
            for (monitor,row) in &mut monitors {let scale=monitor.scale_factor()as f64;let matches=native.as_array().unwrap().iter().filter(|r|["x","y","width","height"].iter().all(|k|r[*k].as_f64()==row[*k].as_f64().map(|n|n*scale))).collect::<Vec<_>>();if matches.len()!=1{return Err(failure("target_ambiguous","GDK monitor does not map to one exact RandR monitor"));}row["id"]=matches[0]["id"].clone();row["isMain"]=matches[0]["isMain"].clone();}
        }
        let primary=display.primary_monitor();
        let (monitor,display_row)=if let Some(id)=a["display_id"].as_f64(){monitors.iter().find(|(_,r)|r["id"].as_f64()==Some(id))}else{monitors.iter().find(|(m,r)|if wayland{primary.as_ref()==Some(m)}else{r["isMain"]==true}).or_else(||(monitors.len()==1).then(||&monitors[0]))}.ok_or_else(||failure("target_gone","overlay requires an exact active native GDK/RandR display ID"))?;
        let monitor=monitor.clone();let display_row=display_row.clone();let requested=frame(&a,&display_row)?;
        let scale=monitor.scale_factor()as f64;let rw=requested["width"].as_f64().unwrap();let rh=requested["height"].as_f64().unwrap();
        if rw*rh*scale*scale>67108864.0{return Err(failure("resource_limit","overlay native backing pixel admission exceeds 64Mi pixels"));}
        preflight(&generation,(rw*rh*scale.max(2.0).powi(2)).ceil()as u64)?;
        let window=gtk::Window::new(gtk::WindowType::Toplevel);window.set_title("Interceptor overlay");window.set_decorated(false);window.set_resizable(false);window.set_accept_focus(a["interactive"]==true);window.set_focus_on_map(false);window.set_skip_taskbar_hint(true);window.set_skip_pager_hint(true);window.set_app_paintable(true);window.set_default_size(rw as i32,rh as i32);
        let screen=gtk::prelude::WidgetExt::screen(&window).ok_or_else(||failure("provider_failed","GTK overlay screen unavailable"))?;if !screen.is_composited(){return Err(failure("background_unavailable","transparent overlays require an actual compositing desktop"));}let visual=screen.rgba_visual().ok_or_else(||failure("background_unavailable","GTK display has no transparent RGBA visual"))?;window.set_visual(Some(&visual));
        if wayland {
            window.init_layer_shell();window.set_namespace("interceptor-overlay");window.set_monitor(&monitor);window.set_layer(if a["level"]=="floating"{Layer::Top}else{Layer::Overlay});window.set_exclusive_zone(0);window.set_keyboard_mode(if a["interactive"]==true{KeyboardMode::OnDemand}else{KeyboardMode::None});window.set_anchor(Edge::Left,true);window.set_anchor(Edge::Top,true);window.set_layer_shell_margin(Edge::Left,(requested["x"].as_f64().unwrap()-display_row["x"].as_f64().unwrap())as i32);window.set_layer_shell_margin(Edge::Top,(requested["y"].as_f64().unwrap()-display_row["y"].as_f64().unwrap())as i32);
        }else{window.set_keep_above(true);if a["single_space"]!=true{window.stick();}window.move_(requested["x"].as_f64().unwrap()as i32,requested["y"].as_f64().unwrap()as i32);}
        let(tx,rx)=channels();let webview=builder(&a,tx.clone())?.build_gtk(&window).map_err(|_|failure("not_installed","WebKitGTK overlay initialization failed"))?;
        window.realize();let native=window.window().ok_or_else(||failure("provider_failed","GTK overlay has no native surface"))?;native.set_pass_through(a["interactive"]!=true);
        if a["visible"]!=false{window.show_all();}
        let mut engine=Engine::new(a.clone(),generation.clone(),json!({}),webview,tx,rx);
        let mut initialized=false;
        loop {
            for _ in 0..64{if !gtk::events_pending(){break;}gtk::main_iteration_do(false);}
            let meta=(||->Result<Value,Value>{
                if let Some(registry)=&mut output_registry {
                    registry.pump()?;let rows=registry.records()?;
                    let actual=rows.iter().find(|r|r["id"]==display_row["id"]&&r["scope"]==display_row["scope"]).ok_or_else(||failure("target_gone","selected compositor output was removed or replaced"))?;
                    if ["x","y","width","height","scale"].iter().any(|k|actual[*k]!=display_row[*k]){return Err(failure("target_gone","selected compositor output geometry changed"));}
                }
                let geometry=monitor.geometry();
                if !(0..display.n_monitors()).any(|i|display.monitor(i).as_ref()==Some(&monitor))||[geometry.x(),geometry.y(),geometry.width(),geometry.height()].into_iter().zip(["x","y","width","height"]).any(|(n,k)|display_row[k].as_i64()!=Some(n as i64))||display.monitor_at_window(&native).as_ref().is_some_and(|m|m!=&monitor){return Err(failure("target_gone","overlay display ownership or geometry changed"));}
                if window.is_visible(){initialized=true;}
                if initialized&&!window.is_visible()&&a["visible"]!=false{return Err(failure("target_gone","overlay native window was closed"));}
                let (w,h)=window.size();if w<=0||h<=0||w as f64*h as f64*scale*scale>67108864.0{return Err(failure("resource_limit","native overlay dimensions exceed backing pixel admission"));}
                // Wayland reports no window position, but a layer-shell surface anchored Top+Left sits exactly at its
            // margins from the output (wlr-layer-shell), and the output geometry was just re-checked: requested x/y.
            let (x,y)=window.position();let actual=if wayland{json!({"x":requested["x"],"y":requested["y"],"width":w,"height":h,"positionSource":"layer-shell anchor"})}else{json!({"x":x,"y":y,"width":w,"height":h})};
                Ok(json!({"id":a["id"],"generation":generation,"mode":mode(&a),"lifecycle":"active","display_id":display_row["id"],"displayFrame":display_row,"displayIdentity":if wayland{"authenticated compositor/output lifetime"}else{"RandR monitor atom"},"frame":actual,"requestedFrame":requested,"level":a["level"].as_str().unwrap_or("statusBar"),"nativeLevel":if wayland{"layer-shell"}else{"GTK keep-above"},"interactive":a["interactive"]==true,"visible":window.is_visible(),"provider":"WebKitGTK"}))
            })();
            if !engine.step(meta).map_err(|_|failure("provider_failed","native overlay result channel failed"))?{break;}
            glib::MainContext::default().iteration(false);std::thread::sleep(Duration::from_millis(2));
        }
        drop(engine);window.close();unsafe{window.destroy();}for _ in 0..64{if !gtk::events_pending(){break;}gtk::main_iteration_do(false);}Ok(())
    })();
    match result{Ok(())=>Ok(()),Err(e)=>emit(&generation,"start",e)}
}
