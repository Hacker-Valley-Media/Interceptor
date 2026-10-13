//! Interceptor's update window on Windows and Linux: the Sparkle update alert of the Mac bridge.
//! The provider runs it as an owned helper (`--update-ui <provider pid>`, WebView2 on Windows,
//! WebKitGTK in `interceptor-overlay` on Linux) and drives it with framed JSON views on stdin:
//! `available`, `downloading`, `ready`, `installing`, `error`. Every button writes one
//! `{"choice":"install"|"later"|"skip"|"ok"}` frame on stdout; closing the window writes `later`.
#![cfg_attr(not(feature="overlay"),allow(dead_code,unused_imports))]
use serde_json::{json,Value};
use std::io;

/// The window, in Sparkle's words (SUUpdateAlert and its status window).
const PAGE:&str=r#"<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>Interceptor Software Update</title>
<style>
:root{color-scheme:light dark;font:14px/1.45 "Segoe UI",system-ui,Cantarell,"Noto Sans",sans-serif}
body{margin:0;height:100vh;display:flex;flex-direction:column;background:Canvas;color:CanvasText}
main{flex:1;display:flex;gap:16px;padding:18px 20px 0;min-height:0}
.icon{width:56px;height:56px;flex:none;border-radius:12px;background:#2563eb;color:#fff;display:flex;align-items:center;justify-content:center;font:600 30px/1 system-ui}
.body{flex:1;display:flex;flex-direction:column;min-height:0}
h1{font-size:15px;margin:0 0 6px}p{margin:0 0 10px}
.label{font-weight:600;margin:4px 0 6px}
#notes{flex:1;min-height:120px;overflow:auto;padding:4px 10px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);border-radius:6px}
progress{width:100%;margin:6px 0 4px}
footer{display:flex;gap:8px;padding:14px 20px 18px}.spacer{flex:1}
button{font:inherit;padding:5px 14px;border-radius:6px;border:1px solid color-mix(in srgb,CanvasText 30%,transparent);background:ButtonFace;color:ButtonText}
button.default{background:#2563eb;border-color:#2563eb;color:#fff}
[hidden]{display:none!important}
</style></head><body>
<main><div class="icon" aria-hidden="true">&#8595;</div><div class="body">
<h1 id="title"></h1><p id="text"></p>
<div id="notes-area"><div class="label">Release Notes:</div></div>
<div id="notes" role="document" aria-label="Release Notes"></div>
<div id="progress-area" hidden><progress id="progress"></progress><p id="bytes"></p></div>
</div></main>
<footer id="buttons"></footer>
<script>
const send=c=>window.ipc.postMessage(JSON.stringify({choice:c}));
const mb=n=>(n/1048576).toFixed(1)+" MB";
let enter=null,escape=null;
function buttons(list){const f=document.getElementById("buttons");f.textContent="";enter=escape=null;
  for(const b of list){if(b==="|"){const s=document.createElement("span");s.className="spacer";f.append(s);continue}
    const e=document.createElement("button");e.textContent=b.label;if(b.default){e.className="default";enter=b.choice}if(b.escape)escape=b.choice;e.onclick=()=>send(b.choice);f.append(e);
    if(b.default)setTimeout(()=>e.focus(),0)}}
function show(id,on){document.getElementById(id).hidden=!on}
function render(v){const t=document.getElementById("title"),x=document.getElementById("text");
  show("notes-area",v.view==="available");show("notes",v.view==="available");show("progress-area",v.view==="downloading"||v.view==="installing");
  if(v.view==="available"){t.textContent="A new version of Interceptor is available!";
    x.textContent="Interceptor "+v.version+" is now available. You have "+v.current+". Would you like to download it now?";
    const n=document.getElementById("notes"),root=n.shadowRoot||n.attachShadow({mode:"open"});root.innerHTML=v.notes||"<p>Release notes are not available.</p>";
    buttons([{label:"Skip This Version",choice:"skip"},"|",{label:"Remind Me Later",choice:"later",escape:true},{label:"Install Update",choice:"install",default:true}])}
  else if(v.view==="downloading"){t.textContent="Downloading update…";x.textContent="";const p=document.getElementById("progress");
    if(v.total){p.max=v.total;p.value=v.received||0;document.getElementById("bytes").textContent=mb(v.received||0)+" of "+mb(v.total)}else{p.removeAttribute("value");document.getElementById("bytes").textContent=""}
    buttons(["|",{label:"Cancel",choice:"later",escape:true}])}
  else if(v.view==="ready"){t.textContent="Ready to Install";x.textContent="Interceptor "+v.version+" has been downloaded and verified. Interceptor restarts after the update installs.";
    buttons(["|",{label:"Install and Relaunch",choice:"install",default:true}])}
  else if(v.view==="installing"){t.textContent="Installing update…";x.textContent="";document.getElementById("progress").removeAttribute("value");document.getElementById("bytes").textContent="";buttons([])}
  else if(v.view==="error"){t.textContent="Update Error!";x.textContent=v.message||"An error occurred while updating Interceptor. Please try again later.";
    buttons(["|",{label:"OK",choice:"ok",default:true,escape:true}])}}
document.addEventListener("keydown",e=>{if(e.key==="Enter"&&enter){e.preventDefault();send(enter)}else if(e.key==="Escape"&&escape){e.preventDefault();send(escape)}});
render(window.__view);
</script></body></html>"#;

/// The page with its first view inline; `<` is escaped so release notes cannot end the script.
pub(crate) fn page(view:&Value)->String{
    let data=serde_json::to_string(view).unwrap_or_else(|_|"{}".into()).replace('<',"\\u003c");
    PAGE.replacen("<script>",&format!("<script>window.__view={data};"),1)
}

pub(crate) fn helper(parent:u32)->io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    #[cfg(target_os="linux")]{
        // The same WebKitGTK data-memory bound the overlay helper uses (overlay.rs).
        let limit=libc::rlimit{rlim_cur:2048*1024*1024,rlim_max:2048*1024*1024};
        if unsafe{libc::setrlimit(libc::RLIMIT_DATA,&limit)}!=0{return Err(io::Error::other("update window data-memory admission failed"));}
    }
    let frame=crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("update window requires its first view"))?;
    let view:Value=serde_json::from_slice(&frame)?;
    #[cfg(all(any(windows,target_os="linux"),feature="overlay"))]return native::run(view);
    #[cfg(not(all(any(windows,target_os="linux"),feature="overlay")))]{let _=view;Err(io::Error::other("this build has no update window; on Linux it runs in interceptor-overlay"))}
}

#[cfg(all(any(windows,target_os="linux"),feature="overlay"))]
mod native{
    use super::*;
    use std::{io::Write,sync::{mpsc,Arc,Mutex},time::Duration};
    use wry::{WebViewBuilder,NewWindowResponse};
    enum Input{View(Value),Closed}

    fn writer()->Arc<Mutex<io::Stdout>>{Arc::new(Mutex::new(io::stdout()))}
    fn choose(out:&Arc<Mutex<io::Stdout>>,choice:&str){
        let mut out=out.lock().unwrap();
        let _=crate::write_frame(&mut *out,&serde_json::to_vec(&json!({"choice":choice})).unwrap_or_default());let _=out.flush();
    }
    /// Views from the provider; the provider closing the pipe ends the window.
    fn inputs()->mpsc::Receiver<Input>{
        let(tx,rx)=mpsc::channel();
        std::thread::spawn(move||{
            let mut input=io::stdin().lock();
            loop{match crate::read_frame(&mut input){
                Ok(Some(frame))=>match serde_json::from_slice::<Value>(&frame){Ok(view)=>{if tx.send(Input::View(view)).is_err(){return;}},Err(_)=>break},
                _=>break,
            }}
            let _=tx.send(Input::Closed);
        });
        rx
    }
    fn builder(view:&Value,out:Arc<Mutex<io::Stdout>>)->WebViewBuilder<'static>{
        WebViewBuilder::new().with_html(page(view)).with_incognito(true).with_devtools(false)
            .with_ipc_handler(move|request|{
                let choice=serde_json::from_str::<Value>(request.body()).ok().and_then(|v|v["choice"].as_str().map(str::to_owned));
                if let Some(choice)=choice.filter(|c|matches!(c.as_str(),"install"|"later"|"skip"|"ok")){choose(&out,&choice);}
            })
            .with_new_window_req_handler(|_,_|NewWindowResponse::Deny)
    }
    fn apply(webview:&wry::WebView,view:&Value)->bool{
        let data=serde_json::to_string(view).unwrap_or_default();
        let _=webview.evaluate_script(&format!("render({data})"));
        true
    }

    #[cfg(windows)]
    pub(super) fn run(view:Value)->io::Result<()>{
        use tao::{event::{Event,WindowEvent},event_loop::{ControlFlow,EventLoopBuilder},window::{UserAttentionType,WindowBuilder},dpi::LogicalSize};
        let out=writer();let rx=inputs();
        let event_loop=EventLoopBuilder::<()>::new().build();
        // A background process cannot take the foreground on Windows, so the window opens on top
        // and flashes its taskbar button; it stops being topmost once the user focuses it.
        let window=WindowBuilder::new().with_title("Interceptor Software Update").with_inner_size(LogicalSize::new(640.0,470.0))
            .with_min_inner_size(LogicalSize::new(480.0,360.0)).with_always_on_top(true).build(&event_loop).map_err(io::Error::other)?;
        let webview=builder(&view,out.clone()).build(&window).map_err(|e|io::Error::other(format!("WebView2 update window could not initialize: {e}")))?;
        window.set_focus();window.request_user_attention(Some(UserAttentionType::Critical));
        event_loop.run(move|event,_,control_flow|{
            *control_flow=ControlFlow::WaitUntil(std::time::Instant::now()+Duration::from_millis(50));
            match event{
                Event::WindowEvent{event:WindowEvent::CloseRequested,..}=>{choose(&out,"later");*control_flow=ControlFlow::Exit;}
                Event::WindowEvent{event:WindowEvent::Focused(true),..}=>window.set_always_on_top(false),
                _=>{}
            }
            while let Ok(input)=rx.try_recv(){match input{Input::View(view)=>{apply(&webview,&view);},Input::Closed=>*control_flow=ControlFlow::Exit}}
        });
    }

    #[cfg(target_os="linux")]
    pub(super) fn run(view:Value)->io::Result<()>{
        use gtk::{prelude::*,glib};
        use wry::WebViewBuilderExtUnix;
        gtk::init().map_err(|_|io::Error::other("the update window requires this user's graphical login"))?;
        let out=writer();let rx=inputs();
        let window=gtk::Window::new(gtk::WindowType::Toplevel);
        window.set_title("Interceptor Software Update");window.set_default_size(640,470);
        // A dialog floats on tiling compositors (Hyprland, Sway) instead of taking a tile.
        window.set_type_hint(gtk::gdk::WindowTypeHint::Dialog);window.set_position(gtk::WindowPosition::Center);
        let closing=out.clone();
        window.connect_delete_event(move|_,_|{choose(&closing,"later");std::process::exit(0)});
        let webview=builder(&view,out.clone()).build_gtk(&window).map_err(|e|io::Error::other(format!("WebKitGTK update window could not initialize: {e}")))?;
        window.show_all();window.present();
        loop{
            for _ in 0..64{if !gtk::events_pending(){break;}gtk::main_iteration_do(false);}
            while let Ok(input)=rx.try_recv(){match input{Input::View(view)=>{apply(&webview,&view);},Input::Closed=>{window.close();return Ok(());}}}
            glib::MainContext::default().iteration(false);std::thread::sleep(Duration::from_millis(15));
        }
    }
}

#[cfg(test)] mod tests{
    use super::*;
    #[test] fn the_first_view_is_inline_and_release_notes_cannot_close_the_script(){
        let html=page(&json!({"view":"available","version":"2.1.1","current":"2.1.0","notes":"<section>x</section></script><script>alert(1)</script>"}));
        assert_eq!(html.matches("</script>").count(),1);
        assert!(html.contains("window.__view={\"current\":\"2.1.0\""));
        for label in ["Skip This Version","Remind Me Later","Install Update","Install and Relaunch","Update Error!","A new version of Interceptor is available!"]{assert!(html.contains(label),"{label}");}
    }
}
