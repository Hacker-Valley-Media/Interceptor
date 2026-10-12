//! Owned WinRT API qualification. This is not installed-provider evidence.
#[cfg(windows)] fn main() {
    use serde_json::{Value,json};
    use std::{path::PathBuf,time::{SystemTime,UNIX_EPOCH,Duration}};
    use windows::{core::{HSTRING,Interface,PCWSTR,PWSTR,GUID},Data::Xml::Dom::XmlDocument,
        Foundation::DateTime,UI::Notifications::{ToastNotificationManager,ToastNotification,ScheduledToastNotification,BadgeUpdateManager,BadgeNotification},
        Win32::{Foundation::PROPERTYKEY,System::Com::{CoInitializeEx,CoUninitialize,CoCreateInstance,COINIT_MULTITHREADED,CLSCTX_INPROC_SERVER,IPersistFile,StructuredStorage::PROPVARIANT},
        UI::Shell::{ShellLink,IShellLinkW,PropertiesSystem::IPropertyStore,SetCurrentProcessExplicitAppUserModelID},System::Variant::VT_LPWSTR}};
    let output=PathBuf::from(std::env::args().nth(1).expect("result path"));
    let mode=std::env::args().nth(2);
    let state=||unsafe{
        use windows::Win32::{Foundation::POINT,UI::WindowsAndMessaging::{GetForegroundWindow,GetCursorPos}};
        let mut p=POINT::default();GetCursorPos(&mut p)?;
        Ok::<_,windows::core::Error>(json!({"foreground":GetForegroundWindow().0 as usize,"cursor":[p.x,p.y]}))
    };
    if mode.as_deref()==Some("inspect-state"){
        let session=unsafe{let mut s=0;windows::Win32::System::RemoteDesktop::ProcessIdToSessionId(std::process::id(),&mut s).ok().map(|_|s)};
        let result=state();let pass=result.is_ok();
        std::fs::write(output,serde_json::to_vec_pretty(&json!({"pass":pass,"state":result.as_ref().ok(),"error":result.err().map(|e|e.to_string()),"session":session,"pid":std::process::id(),"scope":"Read-only native foreground/cursor snapshot"})).unwrap()).unwrap();
        if !pass{std::process::exit(1);}return;
    }
    if matches!(mode.as_deref(),Some("packaged-badge"|"packaged-toasts")) {
        use windows::Win32::{Foundation::POINT,UI::WindowsAndMessaging::*};
        // The installed windows dependency does not enable Appx bindings. Use
        // the documented kernel32 ABI here without adding a probe dependency.
        #[link(name="kernel32")] unsafe extern "system" {
            fn GetCurrentApplicationUserModelId(length:*mut u32,id:*mut u16)->u32;
        }
        let expected=std::env::args().nth(3).expect("expected owned package AUMID");
        let control=output.with_extension("control");
        let mut rows=Vec::<Value>::new();let mut window=None;let mut updater=None;let mut toast_cleanup=false;
        let before=state().expect("read original focus/cursor");
        let result=(||->windows::core::Result<()>{unsafe{
            CoInitializeEx(None,COINIT_MULTITHREADED).ok()?;
            let mut length=0;let query=GetCurrentApplicationUserModelId(&mut length,std::ptr::null_mut());
            if query!=122||length==0||length>256{return Err(windows::core::Error::new(windows::core::HRESULT::from_win32(query),"owned package identity is required"));}
            let mut id=vec![0_u16;length as usize];let read=GetCurrentApplicationUserModelId(&mut length,id.as_mut_ptr());
            if read!=0{return Err(windows::core::Error::new(windows::core::HRESULT::from_win32(read),"read package AUMID"));}
            let id=String::from_utf16_lossy(&id[..length as usize-1]);
            if id!=expected||!id.starts_with("Interceptor.Probe.Badge."){return Err(windows::core::Error::new(windows::core::HRESULT(0x80070005_u32 as i32),"package AUMID does not match this owned prototype"));}
            SetCurrentProcessExplicitAppUserModelID(PCWSTR(HSTRING::from(id.as_str()).as_ptr()))?;
            rows.push(json!({"step":"attested own package identity","aumid":id,"pid":std::process::id(),"before":before,"noToastPosted":true}));
            if mode.as_deref()==Some("packaged-toasts") {
                let notifier=ToastNotificationManager::CreateToastNotifier()?;
                let history=ToastNotificationManager::History()?;
                if history.GetHistory()?.Size()?!=0||notifier.GetScheduledToastNotifications()?.Size()?!=0{return Err(windows::core::Error::new(windows::core::HRESULT(0x80004005_u32 as i32),"fresh owned package already has notifications"));}
                toast_cleanup=true;
                for api_id in [id.as_str(),"Desktop",id.split('_').next().unwrap()] {
                    let result=ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(api_id)).and_then(|n|n.Setting());
                    rows.push(json!({"step":"WithId notifier contract","id":api_id,"setting":result.as_ref().ok().map(|s|format!("{s:?}")),"error":result.err().map(|e|e.to_string())}));
                }
                let legacy=HSTRING::from("HackerValleyMedia.Interceptor.Desktop");
                let legacy_notifier=ToastNotificationManager::CreateToastNotifierWithId(&legacy)?;
                let legacy_pending=legacy_notifier.GetScheduledToastNotifications()?;
                let legacy_history=history.GetHistoryWithId(&legacy)?;
                rows.push(json!({"step":"packaged read of existing registered legacy AUMID","setting":format!("{:?}",legacy_notifier.Setting()?),"pending":legacy_pending.Size()?,"delivered":legacy_history.Size()?,"readOnly":true}));
                let doc=XmlDocument::new()?;doc.LoadXml(&HSTRING::from("<toast><visual><binding template='ToastGeneric'><text>Owned packaged toast contract</text></binding></visual><audio silent='true'/></toast>"))?;
                let post=ToastNotification::CreateToastNotification(&doc)?;post.SetTag(&HSTRING::from("owned-post"))?;post.SetGroup(&HSTRING::from("Probe"))?;notifier.Show(&post)?;
                let now=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
                let schedule=ScheduledToastNotification::CreateScheduledToastNotification(&doc,DateTime{UniversalTime:((now+11644473600+5)*10000000)as i64})?;
                schedule.SetId(&HSTRING::from("owned-schedule"))?;schedule.SetTag(&HSTRING::from("owned-schedule"))?;schedule.SetGroup(&HSTRING::from("Probe"))?;notifier.AddToSchedule(&schedule)?;
                let pending=notifier.GetScheduledToastNotifications()?;
                if pending.Size()?!=1||pending.GetAt(0)?.Id()?.to_string()!="owned-schedule"{return Err(windows::core::Error::new(windows::core::HRESULT(0x80004005_u32 as i32),"owned native pending schedule differs"));}
                rows.push(json!({"step":"owned packaged schedule accepted","pending":pending.Size()?}));
                std::thread::sleep(Duration::from_secs(7));
                let entries=history.GetHistory()?;
                let tags=(0..entries.Size()?).map(|i|entries.GetAt(i)?.Tag().map(|t|t.to_string())).collect::<windows::core::Result<Vec<_>>>()?;
                if !tags.iter().any(|t|t=="owned-post")||!tags.iter().any(|t|t=="owned-schedule")||notifier.GetScheduledToastNotifications()?.Size()?!=0{return Err(windows::core::Error::new(windows::core::HRESULT(0x80004005_u32 as i32),"owned packaged delivery/history differs"));}
                rows.push(json!({"step":"actual packaged history","tags":tags,"fullAumidCount":history.GetHistoryWithId(&HSTRING::from(id.as_str()))?.Size()?}));
                let cancel=ScheduledToastNotification::CreateScheduledToastNotification(&doc,DateTime{UniversalTime:((now+11644473600+120)*10000000)as i64})?;cancel.SetId(&HSTRING::from("owned-cancel"))?;notifier.AddToSchedule(&cancel)?;notifier.RemoveFromSchedule(&cancel)?;
                history.RemoveGroupedTag(&HSTRING::from("owned-post"),&HSTRING::from("Probe"))?;history.RemoveGroupedTagWithId(&HSTRING::from("owned-schedule"),&HSTRING::from("Probe"),&HSTRING::from(id.as_str()))?;
                if history.GetHistory()?.Size()?!=0||notifier.GetScheduledToastNotifications()?.Size()?!=0{return Err(windows::core::Error::new(windows::core::HRESULT(0x80004005_u32 as i32),"owned packaged cancellation/cleanup differs"));}
                rows.push(json!({"step":"owned packaged cancellation and cleanup","pending":0,"delivered":0}));return Ok(());
            }
            let hwnd=CreateWindowExW(WS_EX_APPWINDOW|WS_EX_NOACTIVATE,windows::core::w!("STATIC"),windows::core::w!("Owned first-use badge"),WS_OVERLAPPEDWINDOW,120,120,460,160,None,None,None,None)?;
            window=Some(hwnd);let _=ShowWindow(hwnd,SW_SHOWNOACTIVATE);
            let first_visible=IsWindowVisible(hwnd).as_bool();
            // First ShowWindow honors the launching GUI task's STARTUPINFO.
            // A second nonactivating show is needed if that hid this window.
            if !first_visible{let _=ShowWindow(hwnd,SW_SHOWNOACTIVATE);}
            if !IsWindowVisible(hwnd).as_bool(){return Err(windows::core::Error::new(windows::core::HRESULT(0x80004005_u32 as i32),"owned native visual window remains hidden"));}
            let native=BadgeUpdateManager::CreateBadgeUpdaterForApplication()?;updater=Some(native.clone());
            let mut stage="window";let started=std::time::Instant::now();
            let publish=|stage:&str,rows:&Vec<Value>|std::fs::write(&output,serde_json::to_vec_pretty(&json!({"pass":false,"waiting":true,"stage":stage,"hwnd":hwnd.0 as usize,"rows":rows})).unwrap()).map_err(|e|windows::core::Error::new(windows::core::HRESULT(0x80004005_u32 as i32),e.to_string()));
            let mut frame=windows::Win32::Foundation::RECT::default();GetWindowRect(hwnd,&mut frame)?;
            rows.push(json!({"step":"owned nonactivating taskbar window","hwnd":hwnd.0 as usize,"visibleAfterFirstShow":first_visible,"visible":IsWindowVisible(hwnd).as_bool(),"frame":[frame.left,frame.top,frame.right,frame.bottom],"state":state()?}));publish(stage,&rows)?;
            while started.elapsed()<Duration::from_secs(240) {
                let mut message=MSG::default();while PeekMessageW(&mut message,None,0,0,PM_REMOVE).as_bool(){let _=TranslateMessage(&message);DispatchMessageW(&message);}
                if !IsWindow(Some(hwnd)).as_bool()||state()?!=before{return Err(windows::core::Error::new(windows::core::HRESULT(0x80004005_u32 as i32),"owned window or independent focus/cursor guard changed"));}
                let command=std::fs::read_to_string(&control).unwrap_or_default();
                match (stage,command.trim()) {
                    ("window","badge")=>{let xml=XmlDocument::new()?;xml.LoadXml(&HSTRING::from("<badge value='2'/>"))?;native.Update(&BadgeNotification::CreateBadgeNotification(&xml)?)?;stage="badge";rows.push(json!({"step":"first-use badge count accepted","count":2,"noToastPosted":true,"state":state()?}));publish(stage,&rows)?;},
                    ("badge","clear")=>{native.Clear()?;stage="clear";rows.push(json!({"step":"badge clear accepted","state":state()?}));publish(stage,&rows)?;},
                    ("clear","finish")=>return Ok(()),
                    _=>(),
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(windows::core::Error::new(windows::core::HRESULT(0x800705b4_u32 as i32),"owned badge visual checkpoints timed out"))
        }})();
        let cleanup=(||->windows::core::Result<()>{if toast_cleanup{let n=ToastNotificationManager::CreateToastNotifier()?;let pending=n.GetScheduledToastNotifications()?;for i in 0..pending.Size()?{n.RemoveFromSchedule(&pending.GetAt(i)?)?;}ToastNotificationManager::History()?.Clear()?;}if let Some(native)=updater{native.Clear()?;}if let Some(hwnd)=window{unsafe{DestroyWindow(hwnd)?;}}Ok(())})();
        let after=state();let pass=result.is_ok()&&cleanup.is_ok()&&after.as_ref().is_ok_and(|s|s==&before);
        let session=unsafe{let mut s=0;windows::Win32::System::RemoteDesktop::ProcessIdToSessionId(std::process::id(),&mut s).ok().map(|_|s)};
        std::fs::write(output,serde_json::to_vec_pretty(&json!({"pass":pass,"error":result.err().map(|e|e.to_string()),"cleanupError":cleanup.err().map(|e|e.to_string()),"rows":rows,"before":before,"after":after.ok(),"pid":std::process::id(),"session":session,"scope":"Owned signed sparse-package API prototype; visible badge qualification requires independently inspected captures; no installed-provider completion"})).unwrap()).unwrap();
        unsafe{CoUninitialize()};if !pass{std::process::exit(1)}return;
    }
    if matches!(mode.as_deref(),Some("inspect-ui"|"invoke-owned-toast"|"post-owned-toast"|"post-owned-toast-move")) {
        use windows::Win32::UI::Accessibility::{CUIAutomation,IUIAutomation,IUIAutomationInvokePattern,TreeScope_Children,UIA_InvokePatternId};
        use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW,IsWindowVisible,IsHungAppWindow,GetWindowThreadProcessId};
        let only_window=std::env::args().nth(3).map(|s|s.parse::<usize>().expect("exact native window handle"));
        let invoke_title=if matches!(mode.as_deref(),Some("invoke-owned-toast"|"post-owned-toast"|"post-owned-toast-move")){
            let title=std::env::args().nth(4).expect("exact current owned toast title");
            assert!(only_window.is_some_and(|h|h!=0)&&title.strip_prefix("Owned Windows default action ").and_then(|s|s.strip_suffix(" 🙂 文件")).is_some_and(|s|!s.is_empty()&&s.bytes().all(|b|b.is_ascii_digit())),"Exact owned toast invocation scope required");Some(title)
        }else{None};
        let before=state().expect("independent foreground/cursor read");
        let mut rows=Vec::<Value>::new();
        let result=(||->windows::core::Result<()>{unsafe{
            CoInitializeEx(None,COINIT_MULTITHREADED).ok()?;
            let state=windows::Win32::UI::Shell::SHQueryUserNotificationState();
            let mut input=windows::Win32::UI::Input::KeyboardAndMouse::LASTINPUTINFO{cbSize:std::mem::size_of::<windows::Win32::UI::Input::KeyboardAndMouse::LASTINPUTINFO>()as u32,..Default::default()};
            let input_ok=windows::Win32::UI::Input::KeyboardAndMouse::GetLastInputInfo(&mut input).as_bool();
            rows.push(json!({"step":"native user notification state","state":state.as_ref().ok().map(|s|s.0),"error":state.err().map(|e|e.to_string()),"lastInputRead":input_ok,"lastInputTick":input.dwTime,"unixMilliseconds":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()}));
            let mut previous=None;let mut seen=std::collections::HashSet::new();
            for _ in 0..2000 {
                let Ok(hwnd)=FindWindowExW(None,previous,PCWSTR::null(),PCWSTR::null())else{break;};
                if !seen.insert(hwnd.0 as usize){rows.push(json!({"partial":true,"reason":"native desktop enumeration repeated a handle"}));break;}
                previous=Some(hwnd);
                if IsWindowVisible(hwnd).as_bool(){let mut pid=0;GetWindowThreadProcessId(hwnd,Some(&mut pid));rows.push(json!({"step":"FindWindowEx desktop child","hwnd":hwnd.0 as usize,"pid":pid,"hung":IsHungAppWindow(hwnd).as_bool()}));}
            }
            let api:IUIAutomation=CoCreateInstance(&CUIAutomation,None,CLSCTX_INPROC_SERVER)?;
            let root=api.GetRootElement()?;let children=root.FindAll(TreeScope_Children,&api.CreateTrueCondition()?)?;
            let walker=api.ControlViewWalker()?;let started=std::time::Instant::now();
            let mut owned_invokes=Vec::<IUIAutomationInvokePattern>::new();
            let mut owned_frames=Vec::new();
            for i in 0..children.Length()?.min(200) {
                if started.elapsed()>Duration::from_secs(5){rows.push(json!({"partial":true,"reason":"five-second read budget"}));break;}
                let child=children.GetElement(i)?;
                let name=child.CurrentName()?.to_string();let pid=child.CurrentProcessId()?;let hwnd=child.CurrentNativeWindowHandle()?.0 as usize;
                if only_window.is_some_and(|expected|hwnd!=expected){continue;}
                let frame=child.CurrentBoundingRectangle()?;
                rows.push(json!({"name":name,"pid":pid,"hwnd":hwnd,"frame":[frame.left,frame.top,frame.right,frame.bottom],"depth":0,"visible":IsWindowVisible(windows::Win32::Foundation::HWND(hwnd as *mut _)).as_bool(),"hung":IsHungAppWindow(windows::Win32::Foundation::HWND(hwnd as *mut _)).as_bool()}));
                // Read only the existing taskbar and notification surfaces, with
                // bounded siblings/depth. Never enumerate all desktop descendants.
                if !(name.to_lowercase().contains("notification")||name.to_lowercase().contains("toast")||name.contains("Taskbar")||hwnd==131274){continue;}
                let mut stack=vec![(child,0_u32)];let mut count=0;
                while let Some((element,depth))=stack.pop() {
                    if count>=500||started.elapsed()>Duration::from_secs(5){rows.push(json!({"partial":true,"reason":"bounded surface read"}));break;}count+=1;
                    let frame=element.CurrentBoundingRectangle()?;
                    let invoke=element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId);
                    if invoke_title.as_ref().is_some_and(|title|element.CurrentName().is_ok_and(|n|n.to_string().contains(title)))&&element.CurrentClassName()?.to_string()=="FlexibleToastView"&&element.CurrentAutomationId()?.to_string()=="NormalToastView"&&element.CurrentControlType()?.0==50032&&!element.CurrentIsOffscreen()?.as_bool(){
                        owned_invokes.push(invoke.as_ref().map_err(Clone::clone)?.clone());
                        owned_frames.push(frame);
                    }
                    rows.push(json!({"name":element.CurrentName()?.to_string(),"pid":element.CurrentProcessId()?,"hwnd":element.CurrentNativeWindowHandle()?.0 as usize,"role":element.CurrentControlType()?.0,"automationId":element.CurrentAutomationId()?.to_string(),"className":element.CurrentClassName()?.to_string(),"offscreen":element.CurrentIsOffscreen()?.as_bool(),"invokeAvailable":invoke.is_ok(),"invokeError":invoke.as_ref().err().map(|e|e.to_string()),"invokeHRESULT":invoke.as_ref().err().map(|e|e.code().0),"frame":[frame.left,frame.top,frame.right,frame.bottom],"depth":depth}));
                    if depth>=12{continue;}
                    let mut next=walker.GetFirstChildElement(&element).ok();let mut siblings=0;
                    while let Some(child)=next {if siblings>=500{break;}siblings+=1;next=walker.GetNextSiblingElement(&child).ok();stack.push((child,depth+1));}
                }
            }
            if invoke_title.is_some(){
                if owned_invokes.len()!=1||rows.iter().any(|r|r["partial"]==true){return Err(windows::core::Error::new(windows::Win32::Foundation::E_INVALIDARG,"Exactly one complete current owned toast body required"));}
                if matches!(mode.as_deref(),Some("post-owned-toast"|"post-owned-toast-move")){
                    use windows::Win32::{Foundation::{HWND,POINT,WPARAM,LPARAM},UI::WindowsAndMessaging::{PostMessageW,WM_MOUSEMOVE,WM_LBUTTONDOWN,WM_LBUTTONUP,WindowFromPoint,GetAncestor,GA_ROOT}};
                    let hwnd=HWND(only_window.unwrap()as*mut _);let frame=owned_frames[0];
                    let mut p=POINT{x:frame.left+(frame.right-frame.left)/2,y:frame.top+(frame.bottom-frame.top)/2};
                    if !IsWindowVisible(hwnd).as_bool()||GetAncestor(WindowFromPoint(p),GA_ROOT)!=hwnd||!windows::Win32::Graphics::Gdi::ScreenToClient(hwnd,&mut p).as_bool()||i16::try_from(p.x).is_err()||i16::try_from(p.y).is_err(){return Err(windows::core::Error::new(windows::Win32::Foundation::E_INVALIDARG,"Exact current owned toast point required"));}
                    let position=LPARAM(((p.x as u16 as u32)|((p.y as u16 as u32)<<16))as isize);
                    let messages=if mode.as_deref()==Some("post-owned-toast-move"){vec![(WM_MOUSEMOVE,0),(WM_LBUTTONDOWN,1),(WM_LBUTTONUP,0)]}else{vec![(WM_LBUTTONDOWN,1),(WM_LBUTTONUP,0)]};
                    for (message,buttons) in messages{
                        let queued=PostMessageW(Some(hwnd),message,WPARAM(buttons),position);
                        rows.push(json!({"step":"post exact owned current toast mouse message once","message":message,"title":invoke_title,"hwnd":only_window,"point":[p.x,p.y],"queued":queued.is_ok(),"error":queued.as_ref().err().map(|e|e.to_string()),"HRESULT":queued.as_ref().err().map(|e|e.code().0)}));queued?;
                    }
                }else{
                    let invoked=owned_invokes[0].Invoke();
                    rows.push(json!({"step":"invoke exact owned current toast body once","title":invoke_title,"hwnd":only_window,"success":invoked.is_ok(),"error":invoked.as_ref().err().map(|e|e.to_string()),"HRESULT":invoked.as_ref().err().map(|e|e.code().0)}));
                    invoked?;
                }
            }
            Ok(())
        }})();
        let after=state();let pass=result.is_ok()&&after.as_ref().is_ok_and(|s|s==&before);
        std::fs::write(output,serde_json::to_vec_pretty(&json!({"pass":pass,"error":result.as_ref().err().map(|e|e.to_string()),"before":before,"after":after.ok(),"rows":rows,"scope":if matches!(mode.as_deref(),Some("post-owned-toast"|"post-owned-toast-move")){"One exact owned toast Win32 mouse-message prototype; queued messages require independent actual callback qualification; no foreground or cursor API mutation"}else if invoke_title.is_some(){"One exact fresh owned toast body UIA Invoke prototype; no raw input or foreground API mutation; not installed product behavior"}else{"Read-only native UIA desktop children, bounded taskbar/notification surfaces and supported Invoke patterns; no input, focus, notification or registry mutation"}})).unwrap()).unwrap();
        unsafe{CoUninitialize()};if !pass{std::process::exit(1)}return;
    }
    if matches!(mode.as_deref(),Some("inspect-installed"|"cleanup-diagnostic")) {
        let mut rows=Vec::<Value>::new();
        let result=(||->windows::core::Result<()>{unsafe{CoInitializeEx(None,COINIT_MULTITHREADED).ok()?;}
            for length in [16,32,43,63,64] {
                let doc=XmlDocument::new()?;doc.LoadXml(&HSTRING::from("<toast><visual><binding template='ToastGeneric'><text>Unshown native object</text></binding></visual></toast>"))?;
                let toast=ToastNotification::CreateToastNotification(&doc)?;
                let tag=toast.SetTag(&HSTRING::from("a".repeat(length))).and_then(|_|toast.Tag());
                let group=toast.SetGroup(&HSTRING::from("b".repeat(length))).and_then(|_|toast.Group());
                rows.push(json!({"step":"unshown object tag/group round trip","length":length,"tag":tag.as_ref().ok().map(|v|v.len()),"tagError":tag.err().map(|e|e.to_string()),"group":group.as_ref().ok().map(|v|v.len()),"groupError":group.err().map(|e|e.to_string())}));
            }
            for length in [14,15,16] {
                let doc=XmlDocument::new()?;doc.LoadXml(&HSTRING::from("<toast><visual><binding template='ToastGeneric'><text>Unshown schedule</text></binding></visual></toast>"))?;
                let now=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
                let toast=ScheduledToastNotification::CreateScheduledToastNotification(&doc,DateTime{UniversalTime:((now+11644473600+120)*10000000)as i64})?;
                let result=toast.SetId(&HSTRING::from("a".repeat(length))).and_then(|_|toast.Id());
                rows.push(json!({"step":"unshown scheduled ID round trip","length":length,"id":result.as_ref().ok().map(|v|v.to_string()),"error":result.err().map(|e|e.to_string())}));
            }
            let history=ToastNotificationManager::History()?;rows.push(json!({"step":"History"}));
            let list=history.GetHistoryWithId(&HSTRING::from("HackerValleyMedia.Interceptor.Desktop"))?;rows.push(json!({"step":"GetHistoryWithId"}));
            let size=list.Size()?;rows.push(json!({"step":"Size","value":size}));
            for i in 0..size {
                let t=list.GetAt(i)?;rows.push(json!({"step":"GetAt","index":i}));
                let tag=t.Tag();rows.push(json!({"step":"Tag","value":tag.as_ref().ok().map(|v|v.to_string()),"error":tag.err().map(|e|e.to_string())}));
                let group=t.Group();rows.push(json!({"step":"Group","value":group.as_ref().ok().map(|v|v.to_string()),"error":group.err().map(|e|e.to_string())}));
                let doc=t.Content()?;rows.push(json!({"step":"Content"}));
                let xml=doc.GetXml()?;rows.push(json!({"step":"GetXml","bytes":xml.len()}));
                let element=doc.DocumentElement()?;rows.push(json!({"step":"DocumentElement"}));
                let launch=element.GetAttribute(&HSTRING::from("launch"))?.to_string();
                use base64::Engine;
                let metadata:Value=serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(launch.strip_prefix("ip1:").unwrap_or("")).unwrap_or_default()).unwrap_or(Value::Null);
                let owned=metadata["namespace"]=="badge_diag_1791259564689" && metadata["token"]=="0FC3C21C-1F85-4991-B49F-FA043EDFAD77" && metadata["entry"]["nativeIdentifier"]=="winrt:250bbce3eba53d4e0410b10b6e519f28f8221eee62f1532e03722345e56b5554:788e916629277ad153caeddefdd62487962caebb4355a2bacb19dcd5850b291b";
                rows.push(json!({"step":"GetAttribute","ownedDiagnostic":owned,"metadata":if owned{metadata}else{Value::Null}}));
                if mode.as_deref()==Some("cleanup-diagnostic") && owned {
                    history.RemoveGroupedTagWithId(&HSTRING::from("788e916629277ad153caeddefdd62487962caebb4355a2bacb19dcd5850b291b"),&HSTRING::from("250bbce3eba53d4e0410b10b6e519f28f8221eee62f1532e03722345e56b5554"),&HSTRING::from("HackerValleyMedia.Interceptor.Desktop"))?;
                    rows.push(json!({"step":"removed exact recorded owned diagnostic tag/group","remaining":history.GetHistoryWithId(&HSTRING::from("HackerValleyMedia.Interceptor.Desktop"))?.Size()?}));
                }
            }
            Ok(())
        })();
        let evidence=json!({"pass":result.is_ok(),"error":result.as_ref().err().map(|e|e.to_string()),"rows":rows,"pid":std::process::id(),"mode":mode,"scope":"Installed AUMID native API diagnosis; optional removal restricted to exact previously recorded owned namespace, token and native identifier"});
        std::fs::write(output,serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();unsafe{CoUninitialize()};
        if result.is_err(){std::process::exit(1)}return;
    }
    let stamp=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    let id=HSTRING::from(format!("Interceptor.Probe.Notifications.{stamp}"));
    let link_path=PathBuf::from(std::env::var("APPDATA").unwrap()).join("Microsoft/Windows/Start Menu/Programs").join(format!("Interceptor owned notifications {stamp}.lnk"));
    let mut rows=Vec::<Value>::new();let mut created=false;
    let result=(||->windows::core::Result<()>{unsafe{
        CoInitializeEx(None,COINIT_MULTITHREADED).ok()?;
        let link:IShellLinkW=CoCreateInstance(&ShellLink,None,CLSCTX_INPROC_SERVER)?;
        let exe=HSTRING::from(std::env::current_exe().unwrap().to_string_lossy().as_ref());
        link.SetPath(PCWSTR(exe.as_ptr()))?;link.SetArguments(windows::core::w!(""))?;
        let store:IPropertyStore=link.cast()?;
        let key=PROPERTYKEY{fmtid:GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),pid:5};
        // PKEY_AppUserModel_ID is VT_LPWSTR, not VT_BSTR. The store copies
        // this borrowed NUL-terminated HSTRING; do not free its storage.
        let mut value=std::mem::ManuallyDrop::new(PROPVARIANT::default());
        (*value.Anonymous.Anonymous).vt=VT_LPWSTR;
        (*value.Anonymous.Anonymous).Anonymous.pwszVal=PWSTR(id.as_ptr() as *mut u16);
        store.SetValue(&key,&*value)?;store.Commit()?;
        let persist:IPersistFile=link.cast()?;let path=HSTRING::from(link_path.to_string_lossy().as_ref());persist.Save(PCWSTR(path.as_ptr()),true)?;created=true;
        let read=store.GetValue(&key)?;rows.push(json!({"step":"owned shortcut AUMID","value":read.to_string(),"path":link_path}));
        SetCurrentProcessExplicitAppUserModelID(PCWSTR(id.as_ptr()))?;
        std::thread::sleep(Duration::from_secs(2));
        let notifier=ToastNotificationManager::CreateToastNotifierWithId(&id)?;
        rows.push(json!({"step":"created native notifier"}));
        let setting=notifier.Setting();
        rows.push(json!({"step":"notifier setting","setting":setting.as_ref().ok().map(|s|format!("{s:?}")),"error":setting.err().map(|e|e.to_string())}));
        let doc=XmlDocument::new()?;doc.LoadXml(&HSTRING::from("<toast><visual><binding template='ToastGeneric'><text>Owned native notification</text><text>WinRT API probe only</text></binding></visual><audio silent='true'/></toast>"))?;
        let post=ToastNotification::CreateToastNotification(&doc)?;post.SetTag(&HSTRING::from("owned-post"))?;post.SetGroup(&HSTRING::from("Probe"))?;notifier.Show(&post)?;
        let now=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let schedule=ScheduledToastNotification::CreateScheduledToastNotification(&doc,DateTime{UniversalTime:((now+11644473600+5)*10000000)as i64})?;
        schedule.SetId(&HSTRING::from("owned-schedule"))?;schedule.SetTag(&HSTRING::from("owned-schedule"))?;schedule.SetGroup(&HSTRING::from("Probe"))?;
        notifier.AddToSchedule(&schedule)?;
        let pending=notifier.GetScheduledToastNotifications()?;
        rows.push(json!({"step":"native pending queue","count":pending.Size()?,"identifier":pending.GetAt(0)?.Id()?.to_string(),"tag":pending.GetAt(0)?.Tag()?.to_string(),"group":pending.GetAt(0)?.Group()?.to_string()}));
        if pending.Size()?!=1{return Err(windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32),"expected exactly one owned scheduled toast"));}
        std::thread::sleep(Duration::from_secs(7));
        let history=ToastNotificationManager::History()?;let delivered=history.GetHistoryWithId(&id)?;
        let entries=(0..delivered.Size()?).map(|n|{let x=delivered.GetAt(n)?;Ok(json!({"tag":x.Tag()?.to_string(),"group":x.Group()?.to_string(),"xml":x.Content()?.GetXml()?.to_string()}))}).collect::<windows::core::Result<Vec<_>>>()?;
        rows.push(json!({"step":"native delivered history","entries":entries,"pendingAfterDelivery":notifier.GetScheduledToastNotifications()?.Size()?}));
        if !entries.iter().any(|x|x["tag"]=="owned-schedule"){return Err(windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32),"scheduled toast missing from actual native history"));}
        let cancel=ScheduledToastNotification::CreateScheduledToastNotification(&doc,DateTime{UniversalTime:((now+11644473600+120)*10000000)as i64})?;
        cancel.SetId(&HSTRING::from("owned-cancel"))?;notifier.AddToSchedule(&cancel)?;notifier.RemoveFromSchedule(&cancel)?;
        rows.push(json!({"step":"native schedule cancellation","remaining":notifier.GetScheduledToastNotifications()?.Size()?}));
        let badge=(||->windows::core::Result<()>{let updater=BadgeUpdateManager::CreateBadgeUpdaterForApplicationWithId(&id)?;let xml=XmlDocument::new()?;xml.LoadXml(&HSTRING::from("<badge value='3'/>"))?;updater.Update(&BadgeNotification::CreateBadgeNotification(&xml)?)?;updater.Clear()?;Ok(())})();
        rows.push(json!({"step":"native badge update and clear","accepted":badge.is_ok(),"error":badge.err().map(|e|e.to_string())}));
        history.ClearWithId(&id)?;rows.push(json!({"step":"owned native cleanup","delivered":history.GetHistoryWithId(&id)?.Size()?,"pending":notifier.GetScheduledToastNotifications()?.Size()?}));
        Ok(())
    }})();
    // Every cleanup is scoped to this run's unique AUMID; no shared history is touched.
    let cleanup=(||->windows::core::Result<()>{let n=ToastNotificationManager::CreateToastNotifierWithId(&id)?;let pending=n.GetScheduledToastNotifications()?;for i in 0..pending.Size()?{n.RemoveFromSchedule(&pending.GetAt(i)?)?;}ToastNotificationManager::History()?.ClearWithId(&id)?;Ok(())})();
    let removed=if created{std::fs::remove_file(&link_path).is_ok()}else{!link_path.exists()};
    let pass=result.is_ok()&&cleanup.is_ok()&&removed;
    let session=unsafe{let mut s=0;windows::Win32::System::RemoteDesktop::ProcessIdToSessionId(std::process::id(),&mut s).ok().map(|_|s)};
    let evidence=json!({"pass":pass,"error":result.err().map(|e|e.to_string()),"aumid":id.to_string(),"pid":std::process::id(),"session":session,"shortcutRemoved":removed,"notificationCleanup":cleanup.is_ok(),"cleanupError":cleanup.err().map(|e|e.to_string()),"rows":rows,"scope":"Owned native WinRT API prototype only; no installed-provider qualification"});
    std::fs::write(output,serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();unsafe{CoUninitialize()};
    if !pass{std::process::exit(1)}
}
#[cfg(not(windows))] fn main(){eprintln!("requires Windows");std::process::exit(1)}
