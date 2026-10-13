//! Interceptor's update window on Windows and Linux: the Sparkle update alert of the Mac bridge.
//! The provider runs it as an owned helper (`--update-ui <provider pid>`, WebView2 on Windows,
//! native GTK3 in `interceptor-overlay` on Linux) and drives it with framed JSON views on stdin:
//! `available`, `downloading`, `ready`, `installing`, `error`. Every button writes one
//! `{"choice":"install"|"later"|"skip"|"ok"}` frame on stdout; closing the window writes `later`.
#![cfg_attr(not(feature="overlay"),allow(dead_code,unused_imports))]
use serde_json::{json,Value};
use std::io;

/// The window, in Sparkle's words (SUUpdateAlert and its status window).
#[cfg_attr(not(windows),allow(dead_code))]
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
#[cfg_attr(not(windows),allow(dead_code))]
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
    #[cfg(windows)]use wry::{WebViewBuilder,NewWindowResponse};
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
    #[cfg(windows)]fn builder(view:&Value,out:Arc<Mutex<io::Stdout>>)->WebViewBuilder<'static>{
        WebViewBuilder::new().with_html(page(view)).with_incognito(true).with_devtools(false)
            .with_ipc_handler(move|request|{
                let choice=serde_json::from_str::<Value>(request.body()).ok().and_then(|v|v["choice"].as_str().map(str::to_owned));
                if let Some(choice)=choice.filter(|c|matches!(c.as_str(),"install"|"later"|"skip"|"ok")){choose(&out,&choice);}
            })
            .with_new_window_req_handler(|_,_|NewWindowResponse::Deny)
    }
    #[cfg(windows)]fn apply(webview:&wry::WebView,view:&Value)->bool{
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
        // Chromium builds the page's accessibility tree only when asked; without it UI Automation sees
        // no buttons, and an agent could not click Install Update the way it does in Sparkle's window.
        // wry's default arguments are kept.
        use wry::WebViewBuilderExtWindows;
        let webview=builder(&view,out.clone()).with_additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --force-renderer-accessibility")
            .build(&window).map_err(|e|io::Error::other(format!("WebView2 update window could not initialize: {e}")))?;
        window.set_focus();window.request_user_attention(Some(UserAttentionType::Critical));
        // The provider waits for this before it counts the window as open.
        choose(&out,"shown");
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

    /// Native GTK3 widgets on Linux: GTK reaches assistive technologies through AT-SPI, which
    /// WebKitGTK content did not (agents could not find its buttons), and a fixed-size dialog floats
    /// on tiling compositors such as Hyprland.
    #[cfg(target_os="linux")]
    pub(super) fn run(view:Value)->io::Result<()>{
        use gtk::{prelude::*,glib};
        use std::{cell::RefCell,rc::Rc};
        gtk::init().map_err(|_|io::Error::other("the update window requires this user's graphical login"))?;
        let out=writer();let rx=inputs();
        let window=gtk::Window::new(gtk::WindowType::Toplevel);
        window.set_title("Interceptor Software Update");window.set_resizable(false);window.set_size_request(600,440);
        window.set_type_hint(gtk::gdk::WindowTypeHint::Dialog);window.set_position(gtk::WindowPosition::Center);window.set_border_width(18);
        let column=gtk::Box::new(gtk::Orientation::Vertical,10);
        let title=gtk::Label::new(None);title.set_xalign(0.0);
        let text=gtk::Label::new(None);text.set_xalign(0.0);text.set_line_wrap(true);text.set_max_width_chars(70);
        let notes_label=gtk::Label::new(Some("Release Notes:"));notes_label.set_xalign(0.0);
        let notes=gtk::TextView::new();notes.set_editable(false);notes.set_cursor_visible(false);notes.set_wrap_mode(gtk::WrapMode::Word);notes.set_left_margin(8);notes.set_right_margin(8);
        let scroller=gtk::ScrolledWindow::new(gtk::Adjustment::NONE,gtk::Adjustment::NONE);scroller.set_vexpand(true);scroller.set_shadow_type(gtk::ShadowType::In);scroller.add(&notes);
        let progress=gtk::ProgressBar::new();progress.set_show_text(true);
        let buttons=gtk::Box::new(gtk::Orientation::Horizontal,8);
        for widget in [title.upcast_ref::<gtk::Widget>(),text.upcast_ref(),notes_label.upcast_ref(),scroller.upcast_ref(),progress.upcast_ref(),buttons.upcast_ref()]{column.pack_start(widget,widget==scroller.upcast_ref::<gtk::Widget>(),true,0);}
        window.add(&column);
        let escape=Rc::new(RefCell::new(String::from("later")));
        let closing=out.clone();
        window.connect_delete_event(move|_,_|{choose(&closing,"later");std::process::exit(0)});
        let (key_out,key_escape)=(out.clone(),escape.clone());
        window.connect_key_press_event(move|_,event|{
            if event.keyval()==gtk::gdk::keys::constants::Escape{let choice=key_escape.borrow().clone();if !choice.is_empty(){choose(&key_out,&choice);}return glib::Propagation::Stop;}
            glib::Propagation::Proceed
        });
        let render=|view:&Value|{
            let kind=view["view"].as_str().unwrap_or("");
            let heading=|s:&str|title.set_markup(&format!("<b>{}</b>",glib::markup_escape_text(s)));
            let available=kind=="available";
            notes_label.set_visible(available);scroller.set_visible(available);progress.set_visible(kind=="downloading"||kind=="installing");
            for child in buttons.children(){buttons.remove(&child);}
            let mut list:Vec<(&str,&str,bool)>=Vec::new();
            match kind{
                "available"=>{heading("A new version of Interceptor is available!");
                    text.set_text(&format!("Interceptor {} is now available. You have {}. Would you like to download it now?",view["version"].as_str().unwrap_or(""),view["current"].as_str().unwrap_or("")));
                    notes.buffer().unwrap().set_text(&view["notes"].as_str().map(super::notes_text).unwrap_or_else(||"Release notes are not available.".into()));
                    list=vec![("Skip This Version","skip",false),("","",false),("Remind Me Later","later",false),("Install Update","install",true)];*escape.borrow_mut()="later".into();}
                "downloading"=>{heading("Downloading update\u{2026}");text.set_text("");
                    let (received,total)=(view["received"].as_f64().unwrap_or(0.0),view["total"].as_f64().unwrap_or(0.0));
                    if total>0.0{progress.set_fraction((received/total).clamp(0.0,1.0));progress.set_text(Some(&format!("{:.1} MB of {:.1} MB",received/1_048_576.0,total/1_048_576.0)));}else{progress.pulse();}
                    list=vec![("","",false),("Cancel","later",false)];*escape.borrow_mut()="later".into();}
                "ready"=>{heading("Ready to Install");text.set_text(&format!("Interceptor {} has been downloaded and verified. Interceptor restarts after the update installs.",view["version"].as_str().unwrap_or("")));
                    list=vec![("","",false),("Install and Relaunch","install",true)];*escape.borrow_mut()="later".into();}
                "installing"=>{heading("Installing update\u{2026}");text.set_text("");progress.set_text(None);progress.pulse();escape.borrow_mut().clear();}
                "error"=>{heading("Update Error!");text.set_text(view["message"].as_str().unwrap_or("An error occurred while updating Interceptor. Please try again later."));
                    list=vec![("","",false),("OK","ok",true)];*escape.borrow_mut()="ok".into();}
                _=>{}
            }
            for (label,choice,default) in list{
                if label.is_empty(){let spacer=gtk::Label::new(None);spacer.set_hexpand(true);buttons.pack_start(&spacer,true,true,0);continue;}
                let button=gtk::Button::with_label(label);let (owned,choice)=(out.clone(),choice.to_owned());
                button.connect_clicked(move|_|choose(&owned,&choice));buttons.pack_start(&button,false,false,0);
                if default{button.set_can_default(true);button.style_context().add_class("suggested-action");window.set_default(Some(&button));button.grab_focus();}
            }
            column.show_all();notes_label.set_visible(available);scroller.set_visible(available);progress.set_visible(kind=="downloading"||kind=="installing");
        };
        render(&view);
        window.show_all();render(&view);window.present();
        choose(&out,"shown");
        loop{
            for _ in 0..64{if !gtk::events_pending(){break;}gtk::main_iteration_do(false);}
            while let Ok(input)=rx.try_recv(){match input{Input::View(view)=>render(&view),Input::Closed=>{window.close();return Ok(());}}}
            glib::MainContext::default().iteration(false);std::thread::sleep(Duration::from_millis(15));
        }
    }
}

/// The release notes as text for the native Linux window: newest release first, stopping at the
/// section Sparkle marks installed (update.rs mark_installed), tags removed and entities decoded.
#[cfg_attr(windows,allow(dead_code))]
pub(crate) fn notes_text(html:&str)->String{
    let clean=|s:&str|{
        let mut text=String::new();let mut tag=false;
        for c in s.chars(){match c{'<'=>tag=true,'>'=>tag=false,_ if !tag=>text.push(c),_=>{}}}
        let text=text.replace("&lt;","<").replace("&gt;",">").replace("&quot;","\"").replace("&#39;","'").replace("&amp;","&");
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    };
    let between=|s:&str,a:&str,b:&str|->Option<String>{let i=s.find(a)?+a.len();let j=s[i..].find(b)?+i;Some(s[i..j].to_owned())};
    let mut out=String::new();
    for section in html.split("<section").skip(1){
        if section.starts_with(" class=\"sparkle-installed-version\""){break;}
        let section=section.split("</section>").next().unwrap_or(section);
        if let Some(heading)=between(section,"<h2>","</h2>"){out.push_str(&clean(&heading));out.push('\n');}
        if let Some(date)=between(section,"<time","</time>").and_then(|t|t.split_once('>').map(|(_,d)|d.to_owned())){out.push_str(&clean(&date));out.push('\n');}
        for item in section.split("<li>").skip(1){out.push_str("\u{2022} ");out.push_str(&clean(item.split("</li>").next().unwrap_or(item)));out.push('\n');}
        out.push('\n');
    }
    out.trim_end().to_owned()
}

#[cfg(test)] mod tests{
    use super::*;
    #[test] fn linux_notes_text_stops_at_the_installed_release(){
        let html="<main><section data-sparkle-version=\"2.1.1\"><h2>Interceptor 2.1.1</h2><time datetime=\"x\">October 13, 2026</time><ul><li>Install <strong>Update</strong> &amp; relaunch</li><li>Two</li></ul></section><section class=\"sparkle-installed-version\" data-sparkle-version=\"2.1.0\"><h2>Interceptor 2.1.0</h2></section></main>";
        assert_eq!(notes_text(html),"Interceptor 2.1.1\nOctober 13, 2026\n\u{2022} Install Update & relaunch\n\u{2022} Two");
    }
    #[test] fn the_first_view_is_inline_and_release_notes_cannot_close_the_script(){
        let html=page(&json!({"view":"available","version":"2.1.1","current":"2.1.0","notes":"<section>x</section></script><script>alert(1)</script>"}));
        assert_eq!(html.matches("</script>").count(),1);
        assert!(html.contains("window.__view={\"current\":\"2.1.0\""));
        for label in ["Skip This Version","Remind Me Later","Install Update","Install and Relaunch","Update Error!","A new version of Interceptor is available!"]{assert!(html.contains(label),"{label}");}
    }
}
