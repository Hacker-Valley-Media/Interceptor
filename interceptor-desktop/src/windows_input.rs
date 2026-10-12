//! Foreground fallback for Windows. Native messages and UIA remain preferred.
//! Uses documented Win32 APIs and verifies the actual foreground window.
use super::{Process, failure};
#[path = "windows_background_input.rs"] mod background;
pub(crate) fn start_focus_tracker(){background::start_focus_tracker()}
use serde_json::{Value, json};
use windows::Win32::{Foundation::{HWND, POINT, LPARAM, WPARAM},
    UI::{WindowsAndMessaging::*, Input::KeyboardAndMouse::*}};

pub fn point(value: &Value) -> Option<POINT> {
    let mut parts = value.as_str()?.split(',');
    let p = POINT { x: parts.next()?.parse().ok()?, y: parts.next()?.parse().ok()? };
    if parts.next().is_some() { None } else { Some(p) }
}

fn key(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, ..Default::default() } } }
}
fn mouse(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dwFlags: flags, mouseData: data as u32, ..Default::default() } } }
}
fn movement(p: POINT) -> Result<INPUT, Value> {
    let left=unsafe{GetSystemMetrics(SM_XVIRTUALSCREEN)};
    let top=unsafe{GetSystemMetrics(SM_YVIRTUALSCREEN)};
    let width=unsafe{GetSystemMetrics(SM_CXVIRTUALSCREEN)};
    let height=unsafe{GetSystemMetrics(SM_CYVIRTUALSCREEN)};
    if width<=1 || height<=1 || p.x<left || p.y<top || i64::from(p.x)>=i64::from(left)+i64::from(width) || i64::from(p.y)>=i64::from(top)+i64::from(height) {
        return Err(failure("unsupported_target", "pointer coordinates are outside the virtual desktop"));
    }
    let mut result=mouse(MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK|MOUSEEVENTF_MOVE_NOCOALESCE,0);
    result.Anonymous.mi.dx=((i64::from(p.x)-i64::from(left))*65535/i64::from(width-1))as i32;
    result.Anonymous.mi.dy=((i64::from(p.y)-i64::from(top))*65535/i64::from(height-1))as i32;
    Ok(result)
}
fn virtual_key(name: &str) -> Option<VIRTUAL_KEY> {
    let lower=name.to_ascii_lowercase();
    Some(match lower.as_str() {
        "ctrl"|"control"=>VK_CONTROL,"shift"=>VK_SHIFT,"alt"|"option"=>VK_MENU,"win"|"super"|"cmd"|"command"|"meta"=>VK_LWIN,
        "enter"|"return"=>VK_RETURN,"tab"=>VK_TAB,"esc"|"escape"=>VK_ESCAPE,"space"=>VK_SPACE,
        "backspace"|"deletebackward"=>VK_BACK,"delete"|"forwarddelete"=>VK_DELETE,"insert"=>VK_INSERT,
        "left"|"arrowleft"=>VK_LEFT,"right"|"arrowright"=>VK_RIGHT,"up"|"arrowup"=>VK_UP,"down"|"arrowdown"=>VK_DOWN,
        "home"=>VK_HOME,"end"=>VK_END,"pageup"=>VK_PRIOR,"pagedown"=>VK_NEXT,"capslock"=>VK_CAPITAL,
        _ if lower.len()==1 && lower.as_bytes()[0].is_ascii_alphanumeric()=>VIRTUAL_KEY(lower.to_ascii_uppercase().as_bytes()[0]as u16),
        _ if lower.starts_with('f')=>{let n=lower[1..].parse::<u16>().ok()?;if !(1..=24).contains(&n){return None;}VIRTUAL_KEY(VK_F1.0+n-1)},
        _=>return None,
    })
}

struct Restore { cursor: POINT, previous: HWND, target: HWND, releases: Vec<INPUT>, delivered: bool }
impl Drop for Restore {
    fn drop(&mut self) { unsafe {
        if !self.releases.is_empty() { SendInput(&self.releases,std::mem::size_of::<INPUT>()as i32); }
        if self.delivered { std::thread::sleep(std::time::Duration::from_millis(80)); }
        let _=SetCursorPos(self.cursor.x,self.cursor.y);
        // SendInput queues events. Restoring foreground immediately can route
        // queued keys to the old window. Successful foreground input leaves
        // its selected window active; failed preflight restores focus.
        if !self.delivered && GetForegroundWindow()==self.target && self.previous!=self.target && IsWindow(Some(self.previous)).as_bool() { let _=SetForegroundWindow(self.previous); }
    } }
}

pub(super) fn activate(hwnd:HWND)->bool {
    unsafe {
        let mut pid=0;GetWindowThreadProcessId(hwnd,Some(&mut pid));
        let Ok(process)=Process::open(pid)else{return false;};
        let foreground=||{let mut owner=0;GetWindowThreadProcessId(hwnd,Some(&mut owner));owner==pid && process.alive() && GetForegroundWindow()==hwnd};
        if foreground(){return true;}
        let _=SetForegroundWindow(hwnd);
        // Cross-thread activation is asynchronous. WM_NULL waits for its
        // native completion without replaying input or overriding OS policy.
        let _=SendMessageTimeoutW(hwnd,WM_NULL,WPARAM(0),LPARAM(0),SMTO_ABORTIFHUNG|SMTO_BLOCK|SMTO_ERRORONEXIT,500,None);
        if foreground(){return true;}
        // Attachment is limited to this worker and the existing foreground
        // thread on the same desktop. Do not reset input state while a user
        // holds any key or mouse button. Detach before delivering input.
        if (1..=255).any(|vk|GetAsyncKeyState(vk)<0){return false;}
        let current=windows::Win32::System::Threading::GetCurrentThreadId();
        let foreground=GetWindowThreadProcessId(GetForegroundWindow(),None);
        if foreground==0 || foreground==current{return false;}
        let mut message=MSG::default();let _=PeekMessageW(&mut message,None,0,0,PM_NOREMOVE);
        if !windows::Win32::System::Threading::AttachThreadInput(current,foreground,true).as_bool(){return false;}
        struct Attachment(u32,u32);
        impl Drop for Attachment{fn drop(&mut self){unsafe{let _=windows::Win32::System::Threading::AttachThreadInput(self.0,self.1,false);}}}
        let attachment=Attachment(current,foreground);
        let _=SetForegroundWindow(hwnd);
        drop(attachment);
        let _=SendMessageTimeoutW(hwnd,WM_NULL,WPARAM(0),LPARAM(0),SMTO_ABORTIFHUNG|SMTO_BLOCK|SMTO_ERRORONEXIT,500,None);
        if {let mut o=0;GetWindowThreadProcessId(hwnd,Some(&mut o));o==pid&&process.alive()&&GetForegroundWindow()==hwnd}{return true;}
        // The current foreground may be an AppContainer shell window (e.g. ShellExperienceHost) that
        // AttachThreadInput cannot reach. SwitchToThisWindow is the alt-tab/Task-Manager path and
        // moves foreground where SetForegroundWindow is refused. It is still a foreground move, which
        // app activate is allowed to make.
        SwitchToThisWindow(hwnd,true);
        let _=SendMessageTimeoutW(hwnd,WM_NULL,WPARAM(0),LPARAM(0),SMTO_ABORTIFHUNG|SMTO_BLOCK|SMTO_ERRORONEXIT,500,None);
        {let mut o=0;GetWindowThreadProcessId(hwnd,Some(&mut o));o==pid&&process.alive()&&GetForegroundWindow()==hwnd}
    }
}

pub fn deliver(hwnd: HWND, pid: u32, action: &Value, verb: &str, start: Option<POINT>, end: Option<POINT>, element:Option<&windows::Win32::UI::Accessibility::IUIAutomationElement>, api:&windows::Win32::UI::Accessibility::IUIAutomation) -> Value {
    // Background first: input never activates a window. SendInput is used only
    // when the target already is the foreground window, so focus cannot move; the cursor is restored.
    if action["backgroundOnly"]==true || unsafe{GetForegroundWindow()}!=hwnd { return background::deliver(hwnd,pid,action,verb,start,end); }
    let process=match Process::open(pid) {Ok(p)=>p,Err(e)=>return failure("target_gone",e)};
    let mut inputs=Vec::new();let mut releases=Vec::new();
    let built:Result<(),Value>=(||{
        match verb {
            "keys"=>{
                let parts:Vec<_>=action["keys"].as_str().unwrap_or("").split('+').collect();
                if parts.is_empty() || parts.len()>8 {return Err(failure("invalid_request","keys requires at most eight keys"));}
                let keys=parts.into_iter().map(|s|virtual_key(s).ok_or_else(||failure("invalid_request",format!("unknown Windows key: {s}")))).collect::<Result<Vec<_>,_>>()?;
                if keys.iter().map(|vk|vk.0).collect::<std::collections::HashSet<_>>().len()!=keys.len(){return Err(failure("invalid_request","key combination contains duplicate keys"));}
                let layout=unsafe{GetKeyboardLayout(GetWindowThreadProcessId(hwnd,None))};
                let event=|vk:VIRTUAL_KEY,flags:KEYBD_EVENT_FLAGS|{
                    let scan=unsafe{MapVirtualKeyExW(vk.0 as u32,MAPVK_VK_TO_VSC_EX,Some(layout))};
                    key(vk,(scan&0xff)as u16,flags|if scan&0xff00!=0{KEYEVENTF_EXTENDEDKEY}else{KEYBD_EVENT_FLAGS(0)})
                };
                for vk in &keys {inputs.push(event(*vk,KEYBD_EVENT_FLAGS(0)));}
                for vk in keys.iter().rev() {let release=event(*vk,KEYEVENTF_KEYUP);inputs.push(release);releases.push(release);}
            },
            "type"=>{
                let text=action["text"].as_str().unwrap_or("");
                if text.encode_utf16().count()>32768{return Err(failure("resource_limit","foreground text exceeds 32768 UTF-16 units"));}
                for unit in text.encode_utf16(){inputs.push(key(VIRTUAL_KEY(0),unit,KEYEVENTF_UNICODE));inputs.push(key(VIRTUAL_KEY(0),unit,KEYEVENTF_UNICODE|KEYEVENTF_KEYUP));}
            },
            "click"|"scroll"|"drag"=>{
                let p=start.ok_or_else(||failure("unsupported_target","target has no pointer bounds"))?;
                inputs.push(movement(p)?);
                if verb=="click" {
                    let right=action["right"]==true;
                    let down=if right{MOUSEEVENTF_RIGHTDOWN}else{MOUSEEVENTF_LEFTDOWN};
                    let up=if right{MOUSEEVENTF_RIGHTUP}else{MOUSEEVENTF_LEFTUP};
                    for _ in 0..if action["double"]==true{2}else{1}{inputs.push(mouse(down,0));inputs.push(mouse(up,0));}
                    releases.push(mouse(up,0));
                } else if verb=="scroll" {
                    let direction=action["direction"].as_str().unwrap_or("down");
                    let amount=action["amount"].as_i64().unwrap_or(300)as i32;
                    let data=if direction=="up"||direction=="right"{amount}else{-amount};
                    for _ in 0..action["times"].as_u64().unwrap_or(1){inputs.push(mouse(if direction=="left"||direction=="right"{MOUSEEVENTF_HWHEEL}else{MOUSEEVENTF_WHEEL},data));}
                } else {
                    let q=end.ok_or_else(||failure("invalid_request","drag requires an end point"))?;
                    inputs.push(mouse(MOUSEEVENTF_LEFTDOWN,0));releases.push(mouse(MOUSEEVENTF_LEFTUP,0));
                    for step in 1..=32 {inputs.push(movement(POINT{x:(i64::from(p.x)+(i64::from(q.x)-i64::from(p.x))*step/32)as i32,y:(i64::from(p.y)+(i64::from(q.y)-i64::from(p.y))*step/32)as i32})?);}
                    inputs.push(mouse(MOUSEEVENTF_LEFTUP,0));
                }
            },
            _=>return Err(failure("unsupported_operation","unknown foreground input operation")),
        } Ok(())
    })();
    if let Err(e)=built{return e;}
    unsafe {
        let mut cursor=POINT::default();if let Err(e)=GetCursorPos(&mut cursor){return failure("provider_failed",e);}
        let previous=GetForegroundWindow();
        let mut restore=Restore{cursor,previous,target:hwnd,releases:Vec::new(),delivered:false};
        if (1..=255).any(|vk|GetAsyncKeyState(vk)<0){return failure("restricted_by_os","a key or mouse button is already held; no input was delivered");}
        let mut owner=0;GetWindowThreadProcessId(hwnd,Some(&mut owner));
        if owner!=pid || !process.alive() || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool(){return failure("target_gone","selected window is not visible, restored and owned by the pinned process");}
        // Keep normal foreground delivery. Shell windows can still receive a
        // hit-tested click when Windows refuses their preliminary activation.
        let activated=previous==hwnd || activate(hwnd);
        let direct_click=!activated && verb=="click" && GetForegroundWindow()==previous && start.is_some_and(|p|GetAncestor(WindowFromPoint(p),GA_ROOT)==hwnd);
        if !activated && !direct_click{return failure("restricted_by_os","Windows refused foreground activation (including bounded same-desktop thread attachment); no input was delivered");}
        if !direct_click && GetForegroundWindow()!=hwnd{return failure("restricted_by_os","foreground changed before delivery; no input was delivered");}
        // Recheck ownership and actual hit testing before
        // issuing a single non-replayed SendInput batch.
        GetWindowThreadProcessId(hwnd,Some(&mut owner));
        if owner!=pid || !process.alive(){return failure("stale_reference","window ownership changed before input");}
        for p in [start,end].into_iter().flatten(){if GetAncestor(WindowFromPoint(p),GA_ROOT)!=hwnd{return failure("unsupported_target","pointer endpoint is not on the selected window before delivery");}}
        if verb=="type" || verb=="keys" {
            if let Some(element)=element {
                if element.SetFocus().is_err() || GetForegroundWindow()!=hwnd || !api.GetFocusedElement().is_ok_and(|focused| api.CompareElements(element,&focused).is_ok_and(|same|same.as_bool())) {
                    return failure("unsupported_target","element keyboard focus could not be verified; no text was delivered");
                }
                if let Ok(pattern)=element.GetCurrentPatternAs::<windows::Win32::UI::Accessibility::IUIAutomationValuePattern>(windows::Win32::UI::Accessibility::UIA_ValuePatternId) {
                    if !pattern.CurrentIsReadOnly().is_ok_and(|read_only|!read_only.as_bool()){return failure("permission_denied","text target is read-only or unavailable");}
                    let text=windows::core::BSTR::from(action["text"].as_str().unwrap_or(""));
                    restore.delivered=true;
                    return match pattern.SetValue(&text){Ok(())=>json!({"success":true,"data":{"method":"UIAutomation.ValuePattern.SetValue","background":false,"foregroundUsed":true,"foregroundRestored":false,"targetPid":pid}}),Err(e)=>failure("timeout_unknown_outcome",e)};
                }
            }
            let mut gui=GUITHREADINFO{cbSize:std::mem::size_of::<GUITHREADINFO>()as u32,..Default::default()};
            if GetGUIThreadInfo(GetWindowThreadProcessId(hwnd,None),&mut gui).is_err() || gui.hwndFocus.is_invalid() || GetAncestor(gui.hwndFocus,GA_ROOT)!=hwnd{
                return failure("unsupported_target","selected window has no owned keyboard focus");
            }
        }
        restore.releases=releases;
        let interval=if verb=="scroll"{action["intervalMs"].as_u64().unwrap_or(0)}else{0};
        let mut sent=0;
        let chunks:Vec<&[INPUT]>=if interval>0 {std::iter::once(&inputs[..2]).chain(inputs[2..].chunks(1)).collect()}else{vec![&inputs]};
        for (index,batch) in chunks.iter().enumerate() {
            if index>0 {
                std::thread::sleep(std::time::Duration::from_millis(interval));
                GetWindowThreadProcessId(hwnd,Some(&mut owner));
                if GetForegroundWindow()!=hwnd||owner!=pid||!process.alive()||start.is_some_and(|p|GetAncestor(WindowFromPoint(p),GA_ROOT)!=hwnd){
                    return failure("timeout_unknown_outcome","scroll target changed after partial delivery; remaining input cancelled, observe before retrying");
                }
            }
            let accepted=SendInput(batch,std::mem::size_of::<INPUT>()as i32);
            sent+=accepted;restore.delivered=sent>0;
            if accepted!=batch.len()as u32{return failure("timeout_unknown_outcome","SendInput accepted only part of the batch; observe before retrying (UIPI may apply)");}
        }
        restore.releases.clear();
        drop(restore);
        let foreground=GetForegroundWindow();
        // A clicked toast can close and transfer focus away from its HWND.
        json!({"success":true,"data":{"method":"Win32.SendInput","background":false,"foregroundUsed":!direct_click||previous==hwnd||foreground==hwnd||foreground!=previous,"foregroundRestored":false,"focusUnchanged":foreground==previous,"delivered":sent,"targetPid":pid,"windowId":(hwnd.0 as usize).to_string()}})
    }
}

pub fn menu(hwnd: HWND, pid: u32, action: &Value) -> Value {
    unsafe {
        let Some(process)=Process::open(pid).ok()else{return failure("target_gone","menu owner exited");};
        let root=GetMenu(hwnd);
        if root.is_invalid(){return failure("unsupported_target","window has no Win32 menu; inspect its accessibility menu controls");}
        fn entries(menu:HMENU,depth:usize,budget:&mut usize)->Result<Vec<Value>,Value>{
            if depth>16{return Err(failure("resource_limit","menu depth exceeds 16"));}
            let count=unsafe{GetMenuItemCount(Some(menu))};if count<0{return Err(failure("provider_failed","menu is unavailable"));}
            let mut result=Vec::new();
            for index in 0..count {
                if *budget==0{return Err(failure("resource_limit","menu exceeds 1024 items"));}*budget-=1;
                let mut text=[0_u16;1024];let mut info=MENUITEMINFOW{cbSize:std::mem::size_of::<MENUITEMINFOW>()as u32,fMask:MIIM_STRING|MIIM_ID|MIIM_SUBMENU|MIIM_STATE,dwTypeData:windows::core::PWSTR(text.as_mut_ptr()),cch:1024,..Default::default()};
                unsafe{GetMenuItemInfoW(menu,index as u32,true,&mut info)}.map_err(|e|failure("provider_failed",e))?;
                if info.cch>=1023{return Err(failure("resource_limit","menu label exceeds limit"));}
                let label=String::from_utf16_lossy(&text[..info.cch as usize]);
                let children=if info.hSubMenu.is_invalid(){Vec::new()}else{entries(info.hSubMenu,depth+1,budget)?};
                result.push(json!({"title":label,"id":info.wID,"enabled":info.fState.0&MFS_DISABLED.0==0,"children":children}));
            }Ok(result)
        }
        let entries=match entries(root,0,&mut 1024){Ok(e)=>e,Err(e)=>return e};
        let Some(items)=action["items"].as_array().filter(|items|!items.is_empty())else{return json!({"success":true,"data":entries});};
        let mut level=&entries;let mut selected=None;let mut native_menu=root;let mut native_index=0;
        for item in items {
            let requested=item.as_str().unwrap_or("");
            let matches:Vec<_>=level.iter().enumerate().filter(|(_,entry)|entry["title"].as_str().is_some_and(|title|title==requested||title.split('\t').next().unwrap_or("").replace('&',"")==requested)).collect();
            if matches.len()!=1{return failure(if matches.is_empty(){"target_gone"}else{"target_ambiguous"},"menu path must uniquely match each label");}
            let (index,entry)=matches[0];
            let mut info=MENUITEMINFOW{cbSize:std::mem::size_of::<MENUITEMINFOW>()as u32,fMask:MIIM_ID|MIIM_SUBMENU|MIIM_STATE,..Default::default()};
            if GetMenuItemInfoW(native_menu,index as u32,true,&mut info).is_err() || entry["id"].as_u64()!=Some(info.wID as u64){return failure("stale_reference","menu changed while resolving its path");}
            selected=Some(entry);level=entry["children"].as_array().unwrap();native_index=index;
            if !level.is_empty(){native_menu=info.hSubMenu;}
        }
        let entry=selected.unwrap();if !level.is_empty()||entry["enabled"]!=true{return failure("unsupported_target","menu path must identify an enabled leaf command");}
        let mut owner=0;GetWindowThreadProcessId(hwnd,Some(&mut owner));
        if owner!=pid||!process.alive(){return failure("stale_reference","menu owner changed before delivery");}
        let mut info=MENUINFO{cbSize:std::mem::size_of::<MENUINFO>()as u32,fMask:MIM_STYLE,..Default::default()};
        if GetMenuInfo(native_menu,&mut info).is_err(){return failure("target_gone","menu style is unavailable before delivery");}
        let parent_style=info.dwStyle;
        if GetMenuInfo(root,&mut info).is_err(){return failure("target_gone","root menu style is unavailable before delivery");}
        let by_position=(parent_style|info.dwStyle).contains(MNS_NOTIFYBYPOS);
        let message=if by_position{WM_MENUCOMMAND}else{WM_COMMAND};
        let wparam=if by_position{native_index}else{entry["id"].as_u64().unwrap_or(0)as usize};
        let lparam=if by_position{native_menu.0 as isize}else{0};
        if SendMessageTimeoutW(hwnd,message,WPARAM(wparam),LPARAM(lparam),SMTO_ABORTIFHUNG|SMTO_BLOCK|SMTO_ERRORONEXIT,1000,None).0==0{return failure("timeout_unknown_outcome","menu command timed out; observe before retrying");}
        json!({"success":true,"data":{"method":if by_position{"Win32.WM_MENUCOMMAND"}else{"Win32.WM_COMMAND.menu"},"background":true}})
    }
}
