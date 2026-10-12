//! Window-addressed message delivery. No activation, HID input, global
//! keyboard-state change or cursor movement. A native acknowledgment does
//! not establish Chromium shortcut or application acceptance.
use super::super::{CaptureIdentity,capture_identity,failure,success};
use serde_json::{Value,json};
use std::{cell::RefCell,collections::HashMap,time::{Duration,Instant}};
use windows::Win32::{
    Foundation::{HWND,POINT,RECT,WPARAM,LPARAM,GetLastError,SetLastError,ERROR_SUCCESS,ERROR_ACCESS_DENIED,WAIT_OBJECT_0},
    Graphics::Gdi::ScreenToClient,
    System::Threading::{GetCurrentProcessId,GetCurrentThreadId,WaitForSingleObject},
    UI::{WindowsAndMessaging::*,Input::KeyboardAndMouse::*},
};

thread_local! {
    // The existing UIA worker owns this cache and its process handles. An
    // unresolved message sequence stays refused until native process exit.
    static POISONED: RefCell<HashMap<usize,CaptureIdentity>> = RefCell::new(HashMap::new());
}
const MAX_MESSAGES:usize=8192;
const LEFT:usize=0x0001;
const RIGHT:usize=0x0002;

#[derive(Clone,Copy)]
struct Message { code:u32, wparam:usize, lparam:isize, release:Option<(u32,usize,isize)>, pause:Duration }
impl Message {
    fn new(code:u32,wparam:usize,lparam:isize)->Self{Self{code,wparam,lparam,release:None,pause:Duration::ZERO}}
}
struct Target { root:HWND, child:HWND, pid:u32, identity:CaptureIdentity, frame:RECT, foreground:HWND, cursor:POINT, keyboard:bool, root_thread:u32, child_thread:u32, focus:HWND }
/// The thread's focus window now; an inactive thread has none.
fn thread_focus(thread:u32)->HWND{unsafe{let mut info=GUITHREADINFO{cbSize:std::mem::size_of::<GUITHREADINFO>()as u32,..Default::default()};if GetGUIThreadInfo(thread,&mut info).is_ok(){info.hwndFocus}else{HWND::default()}}}
impl Target {
    fn live(&self)->bool{unsafe{
        let mut root_pid=0;let mut child_pid=0;
        let root_thread=GetWindowThreadProcessId(self.root,Some(&mut root_pid));let child_thread=GetWindowThreadProcessId(self.child,Some(&mut child_pid));
        // Focus must not move during delivery. An inactive window's thread has no focus window and the
        // keys go to the control it last focused (child_for); that is not a change.
        let keyboard_live=!self.keyboard||thread_focus(self.child_thread)==self.focus;
        let mut frame=RECT::default();
        self.identity.alive()&&keyboard_live&&root_thread==self.root_thread&&child_thread==self.child_thread&&root_pid==self.pid&&child_pid==self.pid&&IsWindow(Some(self.root)).as_bool()&&IsWindow(Some(self.child)).as_bool()
            &&IsWindowVisible(self.root).as_bool()&&!IsIconic(self.root).as_bool()
            &&(self.child==self.root||IsChild(self.root,self.child).as_bool())
            &&GetWindowRect(self.root,&mut frame).is_ok()&&frame.left==self.frame.left&&frame.top==self.frame.top&&frame.right==self.frame.right&&frame.bottom==self.frame.bottom
    }}
    fn unchanged(&self)->bool{unsafe{
        let mut cursor=POINT::default();GetForegroundWindow()==self.foreground&&GetCursorPos(&mut cursor).is_ok()&&cursor.x==self.cursor.x&&cursor.y==self.cursor.y
    }}
    fn local(&self,point:POINT)->Result<POINT,Value>{unsafe{
        let mut local=point;let mut client=RECT::default();
        if !ScreenToClient(self.child,&mut local).as_bool()||GetClientRect(self.child,&mut client).is_err()
            ||local.x<client.left||local.y<client.top||local.x>=client.right||local.y>=client.bottom {
            return Err(failure("unsupported_target","background pointer is outside the retained native client area"));
        }
        Ok(local)
    }}
}
fn packed(point:POINT)->Result<isize,Value>{
    if i16::try_from(point.x).is_err()||i16::try_from(point.y).is_err(){return Err(failure("unsupported_target","window message coordinates exceed the native signed 16-bit range"));}
    Ok(((point.x as u16 as u32)|((point.y as u16 as u32)<<16))as isize)
}
fn child_for(root:HWND,pid:u32,verb:&str,start:Option<POINT>)->Result<HWND,Value>{unsafe{
    if ["type","keys"].contains(&verb){
        let mut info=GUITHREADINFO{cbSize:std::mem::size_of::<GUITHREADINFO>()as u32,..Default::default()};
        if GetGUIThreadInfo(GetWindowThreadProcessId(root,None),&mut info).is_err()||info.hwndFocus.is_invalid(){
            // An inactive thread has no focus window; use the control it last focused.
            info.hwndFocus=remembered_focus(root).ok_or_else(||failure("background_unavailable","the window is inactive and has not focused a control since the provider started; pass the control's ref"))?;
        }
        if info.hwndFocus!=root&&!IsChild(root,info.hwndFocus).as_bool(){return Err(failure("background_unavailable","the target has no retained native keyboard child; no focus was assigned"));}
        let mut owner=0;GetWindowThreadProcessId(info.hwndFocus,Some(&mut owner));
        if owner!=pid||!IsWindowVisible(info.hwndFocus).as_bool()||!IsWindowEnabled(info.hwndFocus).as_bool(){return Err(failure("target_gone","keyboard child owner or native visibility changed"));}
        return Ok(info.hwndFocus);
    }
    let point=start.ok_or_else(||failure("unsupported_target","background pointer requires actual native coordinates"))?;
    let mut child=root;let mut seen=std::collections::HashSet::new();
    for _ in 0..32{
        if !seen.insert(child.0 as usize){return Err(failure("target_ambiguous","native child-window traversal is cyclic"));}
        let mut local=point;
        if !ScreenToClient(child,&mut local).as_bool(){return Err(failure("target_gone","native child coordinate conversion failed"));}
        let next=ChildWindowFromPointEx(child,local,CWP_SKIPINVISIBLE|CWP_SKIPDISABLED|CWP_SKIPTRANSPARENT);
        if next.is_invalid(){return Err(failure("unsupported_target","native pointer has no eligible child window"));}
        if next==child{return Ok(child);}
        let mut owner=0;GetWindowThreadProcessId(next,Some(&mut owner));
        if owner!=pid||!IsChild(root,next).as_bool(){return Err(failure("permission_denied","native pointer child belongs to a different process or parent"));}
        child=next;
    }
    Err(failure("resource_limit","native child-window traversal exceeds 32 levels"))
}}
fn build(target:&Target,action:&Value,verb:&str,start:Option<POINT>,end:Option<POINT>)->Result<Vec<Message>,Value>{
    let mut messages=Vec::new();
    match verb{
        "type"=>{
            if !unsafe{IsWindowUnicode(target.child).as_bool()}{return Err(failure("unsupported_target","UTF16 background text requires a native Unicode window"));}
            let text=action["text"].as_str().ok_or_else(||failure("invalid_request","background text requires an exact string"))?;
            if text.is_empty()||text.contains('\0')||text.encode_utf16().count()>MAX_MESSAGES{return Err(failure("resource_limit","background text requires 1..8192 UTF16 message units without NUL"));}
            for unit in text.encode_utf16(){messages.push(Message::new(WM_CHAR,unit as usize,1));}
        },
        "keys"=>{
            let parts=action["keys"].as_str().unwrap_or("").split('+').map(str::trim).collect::<Vec<_>>();
            if parts.is_empty()||parts.len()>8||parts.iter().any(|s|s.is_empty()){return Err(failure("invalid_request","background keys require one bounded physical chord"));}
            let keys=parts.iter().map(|s|super::virtual_key(s).ok_or_else(||failure("invalid_request",format!("unsupported physical key {s}")))).collect::<Result<Vec<_>,_>>()?;
            let modifier=|key:VIRTUAL_KEY|[VK_CONTROL,VK_SHIFT,VK_MENU,VK_LWIN,VK_RWIN].contains(&key);
            if keys[..keys.len()-1].iter().any(|key|!modifier(*key))||modifier(*keys.last().unwrap())||keys.iter().map(|key|key.0).collect::<std::collections::HashSet<_>>().len()!=keys.len(){return Err(failure("invalid_request","background chord needs distinct modifiers followed by one physical key"));}
            // Window messages cannot hold Ctrl, Alt or Win down for another app: it reads the physical
            // modifier state, so Control+A arrived as a plain A while the reply claimed delivery.
            if keys.iter().any(|key|[VK_CONTROL,VK_MENU,VK_LWIN,VK_RWIN].contains(key)){return Err(failure("background_unavailable","a background chord cannot hold Ctrl, Alt or Windows down for another app (Windows apps read the physical modifier state, so it would arrive as a plain key); run keys without --background-only, or use type, value or action"));}
            let layout=unsafe{GetKeyboardLayout(GetWindowThreadProcessId(target.child,None))};
            let alt=keys.contains(&VK_MENU);
            let message=|key:VIRTUAL_KEY,up:bool|{
                let scan=unsafe{MapVirtualKeyExW(key.0 as u32,MAPVK_VK_TO_VSC_EX,Some(layout))};
                let bits=1_u32|((scan&0xff)<<16)|(if scan&0xff00!=0{1<<24}else{0})|(if alt{1<<29}else{0})|(if up{(1<<30)|(1<<31)}else{0});
                Message::new(if alt{if up{WM_SYSKEYUP}else{WM_SYSKEYDOWN}}else if up{WM_KEYUP}else{WM_KEYDOWN},key.0 as usize,bits as isize)
            };
            for key in &keys{let mut down=message(*key,false);let up=message(*key,true);down.release=Some((up.code,up.wparam,up.lparam));messages.push(down);}
            // A sent WM_KEYDOWN skips the target's TranslateMessage, so a character key typed nothing.
            // Send the WM_CHAR that the target's own message loop would have produced (Shift applied).
            let last=*keys.last().unwrap();let mut state=[0u8;256];if keys.contains(&VK_SHIFT){state[VK_SHIFT.0 as usize]=0x80;}
            let mut units=[0u16;4];let scan=unsafe{MapVirtualKeyExW(last.0 as u32,MAPVK_VK_TO_VSC_EX,Some(layout))};
            let count=unsafe{ToUnicodeEx(last.0 as u32,scan,&state,&mut units,0x4,Some(layout))};
            if (1..=2).contains(&count){let bits=message(last,false).lparam;for unit in &units[..count as usize]{messages.push(Message::new(WM_CHAR,*unit as usize,bits));}}
            for key in keys.iter().rev(){messages.push(message(*key,true));}
        },
        "click"|"scroll"|"drag"=>{
            let point=start.ok_or_else(||failure("invalid_request","background pointer requires one exact starting point"))?;
            let local=target.local(point)?;let position=packed(local)?;
            if verb=="scroll"{
                let direction=action["direction"].as_str().unwrap_or("down");
                let horizontal=["left","right"].contains(&direction);let positive=["up","right"].contains(&direction);
                if !["up","down","left","right"].contains(&direction){return Err(failure("invalid_request","unknown wheel direction"));}
                let amount=action["amount"].as_u64().unwrap_or(3);let times=action["times"].as_u64().unwrap_or(1);
                if amount==0||amount>10000||times==0||times>10000{return Err(failure("invalid_request","background wheel amount/repetitions are invalid"));}
                // amount is wheel units (120 per notch), the same as the foreground path; one
                // message carries at most 32760 units in its signed 16-bit delta.
                let batches=amount.div_ceil(32760);
                if batches*times>MAX_MESSAGES as u64{return Err(failure("resource_limit","background wheel exceeds 8192 native messages"));}
                let screen=packed(point)?;let interval=action["intervalMs"].as_u64().unwrap_or(20);
                if interval>1000{return Err(failure("invalid_request","wheel interval exceeds 1000ms"));}
                for turn in 0..times{
                    let mut remaining=amount;
                    while remaining>0{let take=remaining.min(32760);remaining-=take;let delta=(take as i32)*if positive{1}else{-1};let mut item=Message::new(if horizontal{WM_MOUSEHWHEEL}else{WM_MOUSEWHEEL},(delta as i16 as u16 as usize)<<16,screen);if turn>0&&remaining==amount-take{item.pause=Duration::from_millis(interval);}messages.push(item);}
                }
            }else{
                let right=action["right"]==true;let flag=if right{RIGHT}else{LEFT};
                let down=if right{WM_RBUTTONDOWN}else{WM_LBUTTONDOWN};let up=if right{WM_RBUTTONUP}else{WM_LBUTTONUP};
                let mut press=Message::new(down,flag,position);press.release=Some((up,0,position));messages.push(press);
                if verb=="drag"{
                    let finish=end.ok_or_else(||failure("invalid_request","background drag requires an ending point"))?;
                    // The pressed control captures the mouse, so the end may lie outside it: its client
                    // coordinates can be negative or past its size (packed() still bounds them to 16 bits).
                    let finish={let mut p=finish;if unsafe{!ScreenToClient(target.child,&mut p).as_bool()}{return Err(failure("target_gone","native drag end coordinate conversion failed"));}p};
                    for step in 1..=20{let p=POINT{x:(local.x as i64+(finish.x as i64-local.x as i64)*step/20)as i32,y:(local.y as i64+(finish.y as i64-local.y as i64)*step/20)as i32};let mut move_event=Message::new(WM_MOUSEMOVE,flag,packed(p)?);move_event.pause=Duration::from_millis(5);messages.push(move_event);}
                    messages.push(Message::new(up,0,packed(finish)?));
                }else{
                    messages.push(Message::new(up,0,position));
                    if action["double"]==true{let mut press=Message::new(if right{WM_RBUTTONDBLCLK}else{WM_LBUTTONDBLCLK},flag,position);press.release=Some((up,0,position));messages.push(press);messages.push(Message::new(up,0,position));}
                }
            }
        },
        _=>return Err(failure("unsupported_operation","no window-addressed message input route")),
    }
    if messages.len()>MAX_MESSAGES{return Err(failure("resource_limit","background input exceeds 8192 native messages"));}
    Ok(messages)
}
pub(super) fn deliver(root:HWND,pid:u32,action:&Value,verb:&str,start:Option<POINT>,end:Option<POINT>)->Value{
    if let Err(error)=crate::authdialog::ordinary_desktop(){return error;}
    let available=POISONED.with(|entries|{let mut entries=entries.borrow_mut();entries.retain(|_,identity|unsafe{WaitForSingleObject(identity.process.handle.0,0)!=WAIT_OBJECT_0});!entries.contains_key(&(pid as usize))&&entries.len()<32});
    if !available{return failure("background_unavailable","an unresolved background sequence retains this process/window or the 32-owner admission cap; restart the owned application before further background input");}
    let identity=match capture_identity(pid){Ok(identity)=>identity,Err(_)=>return failure("permission_denied","background input requires one retained live process from the current graphical login")};
    let child=match child_for(root,pid,verb,start){Ok(child)=>child,Err(error)=>return error};
    let mut frame=RECT::default();let mut cursor=POINT::default();
    unsafe{
        if pid==GetCurrentProcessId()||GetWindowThreadProcessId(child,None)==GetCurrentThreadId(){return failure("unsupported_target","background target must have an independent native thread and process");}
        if GetWindowRect(root,&mut frame).is_err()||GetCursorPos(&mut cursor).is_err(){return failure("provider_failed","actual native window/cursor inventory unavailable");}
    }
    let target=Target{root,child,pid,identity,frame,foreground:unsafe{GetForegroundWindow()},cursor,keyboard:["type","keys"].contains(&verb),root_thread:unsafe{GetWindowThreadProcessId(root,None)},child_thread:unsafe{GetWindowThreadProcessId(child,None)},focus:thread_focus(unsafe{GetWindowThreadProcessId(child,None)})};
    // Build first so a bad key name is reported as such in any window state.
    let messages=match build(&target,action,verb,start,end){Ok(messages)=>messages,Err(error)=>return error};
    if !target.live(){return failure("target_gone","background process, native window or frame changed before input");}
    let started=Instant::now();let deadline=started+Duration::from_secs(28);
    let mut delivered=0;let mut releases=Vec::new();let mut failure_reason=None;let mut denied=false;let mut attempted=false;
    for item in messages{
        if !item.pause.is_zero(){if Instant::now()+item.pause>=deadline{failure_reason=Some("background input interval exceeds the remaining deadline");break;}std::thread::sleep(item.pause);}
        if Instant::now()>=deadline||!target.live()||!target.unchanged()||crate::authdialog::ordinary_desktop().is_err(){failure_reason=Some("native deadline, process/window, input desktop or focus/cursor observation changed");break;}
        // A handler may do real work (the fixture writes its state file on mouse-up, >100 ms on a busy
        // VM); a timeout counts as an unresolved sequence, so allow 2 s per message within the deadline.
        let milliseconds=deadline.saturating_duration_since(Instant::now()).as_millis().clamp(1,2000)as u32;
        attempted=true;
        let acknowledged=unsafe{SetLastError(ERROR_SUCCESS);SendMessageTimeoutW(child,item.code,WPARAM(item.wparam),LPARAM(item.lparam),SMTO_ABORTIFHUNG|SMTO_BLOCK|SMTO_ERRORONEXIT,milliseconds,None).0!=0};
        if !acknowledged{denied=unsafe{GetLastError()==ERROR_ACCESS_DENIED};failure_reason=Some("native message was refused, timed out or lost its window; no message was replayed");break;}
        delivered+=1;
        if let Some(release)=item.release{releases.push(release);}else if [WM_KEYUP,WM_SYSKEYUP,WM_LBUTTONUP,WM_RBUTTONUP].contains(&item.code){releases.pop();}
    }
    if failure_reason.is_none()&&(Instant::now()>=deadline||!target.live()||!target.unchanged()){failure_reason=Some("post-delivery deadline, native identity or focus/cursor observation changed");}
    if let Some(reason)=failure_reason{
        if attempted&&(!denied||delivered>0){
            // Release only acknowledged presses, without resending a down or
            // text message. This is best-effort cleanup, not proof of rollback.
            if target.live()&&target.unchanged()&&crate::authdialog::ordinary_desktop().is_ok(){for(code,wparam,lparam)in releases.into_iter().rev(){unsafe{let _=SendMessageTimeoutW(child,code,WPARAM(wparam),LPARAM(lparam),SMTO_ABORTIFHUNG|SMTO_BLOCK|SMTO_ERRORONEXIT,100,None);}}}
            POISONED.with(|entries|{entries.borrow_mut().insert(pid as usize,target.identity);});
        }
        let mut result=failure(if !attempted{"background_unavailable"}else if denied&&delivered==0{"permission_denied"}else{"timeout_unknown_outcome"},reason);
        result["details"]=json!({"delivered":delivered,"dispatched":attempted&&(!denied||delivered>0),"verified":false,"effectRequiresObservation":attempted&&(!denied||delivered>0)});
        return result;
    }
    success(json!({"method":"Win32.SendMessageTimeoutW","background":true,"foregroundUsed":false,"focusUnchanged":true,"cursorUnchanged":true,"delivered":delivered,"targetPid":pid,"windowId":(root.0 as usize).to_string(),"elapsedMs":started.elapsed().as_millis(),"effectRequiresObservation":true}))
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn native_message_coordinates_keep_signed16_bits_and_refuse_overflow(){
        for (point,expected) in [(POINT{x:0,y:0},0u32),(POINT{x:-1,y:-2},0xfffeffff),(POINT{x:32767,y:-32768},0x80007fff)]{
            assert_eq!(packed(point).unwrap()as u32,expected);
        }
        for point in [POINT{x:32768,y:0},POINT{x:-32769,y:0},POINT{x:0,y:32768},POINT{x:0,y:-32769}]{
            assert_eq!(packed(point).unwrap_err()["code"],"unsupported_target");
        }
    }
}

/// Last focused control of each top-level window, from EVENT_OBJECT_FOCUS. Windows clears a
/// thread's focus window when another thread activates, so an inactive window has no focused
/// control to type into; apps restore this one on reactivation (as macOS keeps an inactive
/// app's focused element), so background keys go there.
static REMEMBERED_FOCUS:std::sync::Mutex<Option<HashMap<usize,usize>>>=std::sync::Mutex::new(None);
unsafe extern "system" fn focus_event(_hook:windows::Win32::UI::Accessibility::HWINEVENTHOOK,_event:u32,hwnd:HWND,_object:i32,_child:i32,_thread:u32,_time:u32){unsafe{
    if hwnd.is_invalid(){return;}
    let root=GetAncestor(hwnd,GA_ROOT);if root.is_invalid(){return;}
    let mut remembered=REMEMBERED_FOCUS.lock().unwrap_or_else(|e|e.into_inner());let map=remembered.get_or_insert_with(HashMap::new);
    // ponytail: closed windows are pruned only past 1024 entries; a handle reused before then is checked by child_for.
    if map.len()>=1024{map.retain(|root,_|IsWindow(Some(HWND(*root as *mut _))).as_bool());}
    map.insert(root.0 as usize,hwnd.0 as usize);
}}
/// Starts the out-of-context focus hook on its own message thread for the provider's lifetime.
pub(crate) fn start_focus_tracker(){
    let _=std::thread::Builder::new().name("focus-tracker".into()).spawn(||unsafe{
        use windows::Win32::UI::Accessibility::SetWinEventHook;
        let hook=SetWinEventHook(EVENT_OBJECT_FOCUS,EVENT_OBJECT_FOCUS,None,Some(focus_event),0,0,WINEVENT_OUTOFCONTEXT|WINEVENT_SKIPOWNPROCESS);
        if hook.is_invalid(){return;}
        let mut message=MSG::default();
        while GetMessageW(&mut message,None,0,0).as_bool(){let _=TranslateMessage(&message);DispatchMessageW(&message);}
    });
}
fn remembered_focus(root:HWND)->Option<HWND>{
    let child=HWND(*REMEMBERED_FOCUS.lock().ok()?.as_ref()?.get(&(root.0 as usize))? as *mut _);
    unsafe{(child==root||IsChild(root,child).as_bool()).then_some(child)}
}
