//! X11 geometry uses the WM, never GTK's minimum-size AT-SPI setter.
//! ABI: Xlib 1.8 / XRes 1.2; EWMH 1.5 _NET_MOVERESIZE_WINDOW.
use crate::failure;
use serde_json::{Value, json};
use std::{ffi::{CString, c_char, c_int, c_long, c_uint, c_ulong, c_void}, ptr,
    sync::atomic::{AtomicU8, Ordering}};

type Display = c_void;
type Window = c_ulong;
#[repr(C)] struct ClientIdSpec { client: Window, mask: c_uint }
#[repr(C)] struct ClientId { spec: ClientIdSpec, length: c_long, value: *mut c_void }
#[repr(C)] struct ErrorEvent { kind: c_int, display: *mut Display, resource: Window,
    serial: c_ulong, code: u8, request: u8, minor: u8 }
type ErrorHandler = Option<unsafe extern "C" fn(*mut Display, *mut ErrorEvent) -> c_int>;
#[repr(C)] #[derive(Copy, Clone)] struct ClientMessage { kind: c_int, serial: c_ulong,
    send_event: c_int, display: *mut Display, window: Window, message_type: c_ulong,
    format: c_int, data: [c_long; 5] }
// XKeyEvent and XButtonEvent have identical field layouts; MotionNotify uses
// the same slot with a zero is_hint. Verified against installed Xlib headers.
#[repr(C)] #[derive(Copy,Clone)] struct InputEvent {kind:c_int,serial:c_ulong,send_event:c_int,display:*mut Display,
    window:Window,root:Window,subwindow:Window,time:c_ulong,x:c_int,y:c_int,x_root:c_int,y_root:c_int,state:c_uint,detail:c_uint,same_screen:c_int}
#[repr(C)] #[derive(Copy,Clone)] struct PropertyEvent {kind:c_int,serial:c_ulong,send_event:c_int,display:*mut Display,window:Window,atom:c_ulong,time:c_ulong,state:c_int}
#[repr(C)] union Event { client: ClientMessage, input:InputEvent, property:PropertyEvent, padding: [c_long; 24] }
#[link(name = "X11")]
unsafe extern "C" {
    fn XOpenDisplay(name: *const c_char) -> *mut Display;
    fn XCloseDisplay(display: *mut Display) -> c_int;
    fn XDefaultRootWindow(display: *mut Display) -> Window;
    fn XInternAtom(display: *mut Display, name: *const c_char, only_if_exists: c_int) -> c_ulong;
    fn XGetWindowProperty(display: *mut Display, window: Window, property: c_ulong,
        offset: c_long, length: c_long, delete: c_int, requested: c_ulong,
        actual: *mut c_ulong, format: *mut c_int, count: *mut c_ulong,
        remaining: *mut c_ulong, data: *mut *mut u8) -> c_int;
    fn XFree(data: *mut c_void) -> c_int;
    fn XGetGeometry(display: *mut Display, window: Window, root: *mut Window,
        x: *mut c_int, y: *mut c_int, width: *mut c_uint, height: *mut c_uint,
        border: *mut c_uint, depth: *mut c_uint) -> c_int;
    fn XTranslateCoordinates(display: *mut Display, source: Window, dest: Window,
        x: c_int, y: c_int, dest_x: *mut c_int, dest_y: *mut c_int, child: *mut Window) -> c_int;
    fn XSendEvent(display: *mut Display, window: Window, propagate: c_int,
        mask: c_long, event: *mut Event) -> c_int;
    fn XSync(display: *mut Display, discard: c_int) -> c_int;
    fn XSetErrorHandler(handler: ErrorHandler) -> ErrorHandler;
    fn XStringToKeysym(name:*const c_char)->c_ulong;
    fn XKeysymToKeycode(display:*mut Display,keysym:c_ulong)->u8;
    fn XkbKeysymToModifiers(display:*mut Display,keysym:c_ulong)->c_uint;
    fn XGetInputFocus(display:*mut Display,focus:*mut Window,revert:*mut c_int)->c_int;
    fn XQueryPointer(display:*mut Display,window:Window,root:*mut Window,child:*mut Window,root_x:*mut c_int,root_y:*mut c_int,x:*mut c_int,y:*mut c_int,mask:*mut c_uint)->c_int;
    fn XCreateSimpleWindow(display:*mut Display,parent:Window,x:c_int,y:c_int,width:c_uint,height:c_uint,border_width:c_uint,border:c_ulong,background:c_ulong)->Window;
    fn XDestroyWindow(display:*mut Display,window:Window)->c_int;
    fn XSelectInput(display:*mut Display,window:Window,event_mask:c_long)->c_int;
    fn XChangeProperty(display:*mut Display,window:Window,property:c_ulong,property_type:c_ulong,format:c_int,mode:c_int,data:*const u8,count:c_int)->c_int;
    fn XCheckWindowEvent(display:*mut Display,window:Window,event_mask:c_long,event:*mut Event)->c_int;
}
#[link(name = "XRes")]
unsafe extern "C" {
    fn XResQueryVersion(display: *mut Display, major: *mut c_int, minor: *mut c_int) -> c_int;
    fn XResQueryClientIds(display: *mut Display, specs: c_long, spec: *mut ClientIdSpec,
        count: *mut c_long, ids: *mut *mut ClientId) -> c_int;
    fn XResGetClientPid(id: *mut ClientId) -> c_int;
    fn XResClientIdsDestroy(count: c_long, ids: *mut ClientId);
}

#[repr(C)]struct XImage{width:c_int,height:c_int,xoffset:c_int,format:c_int,data:*mut libc::c_char,
    byte_order:c_int,bitmap_unit:c_int,bitmap_bit_order:c_int,bitmap_pad:c_int,depth:c_int,bytes_per_line:c_int,bits_per_pixel:c_int,
    red_mask:c_ulong,green_mask:c_ulong,blue_mask:c_ulong,obdata:*mut libc::c_char,functions:[usize;6]}
#[repr(C)]struct Visual{ext_data:*mut c_void,visualid:c_ulong,class:c_int,
    red_mask:c_ulong,green_mask:c_ulong,blue_mask:c_ulong,bits_per_rgb:c_int,map_entries:c_int}
#[repr(C)]struct WindowAttributes{x:c_int,y:c_int,width:c_int,height:c_int,border_width:c_int,depth:c_int,
    visual:*mut Visual,root:Window,class:c_int,bit_gravity:c_int,win_gravity:c_int,backing_store:c_int,
    backing_planes:c_ulong,backing_pixel:c_ulong,save_under:c_int,colormap:c_ulong,map_installed:c_int,map_state:c_int,
    all_event_masks:c_long,your_event_mask:c_long,do_not_propagate_mask:c_long,override_redirect:c_int,screen:*mut c_void}
#[link(name="X11")]unsafe extern "C"{
    fn XGetWindowAttributes(display:*mut Display,window:Window,attributes:*mut WindowAttributes)->c_int;
    fn XGetImage(display:*mut Display,drawable:Window,x:c_int,y:c_int,width:c_uint,height:c_uint,planes:c_ulong,format:c_int)->*mut XImage;
    fn XGetPixel(image:*mut XImage,x:c_int,y:c_int)->c_ulong;
    fn XDestroyImage(image:*mut XImage)->c_int;
    fn XFreePixmap(display:*mut Display,pixmap:Window)->c_int;
}
#[link(name="Xcomposite")]unsafe extern "C"{
    fn XCompositeQueryVersion(display:*mut Display,major:*mut c_int,minor:*mut c_int)->c_int;
    fn XCompositeRedirectWindow(display:*mut Display,window:Window,update:c_int);
    fn XCompositeUnredirectWindow(display:*mut Display,window:Window,update:c_int);
    fn XCompositeNameWindowPixmap(display:*mut Display,window:Window)->Window;
}
#[repr(C)]struct MonitorInfo{name:c_ulong,primary:c_int,automatic:c_int,noutput:c_int,x:c_int,y:c_int,width:c_int,height:c_int,mwidth:c_int,mheight:c_int,outputs:*mut c_ulong}
#[link(name="Xrandr")]unsafe extern "C"{
    fn XRRQueryVersion(display:*mut Display,major:*mut c_int,minor:*mut c_int)->c_int;
    fn XRRGetMonitors(display:*mut Display,window:Window,active:c_int,count:*mut c_int)->*mut MonitorInfo;
    fn XRRFreeMonitors(monitors:*mut MonitorInfo);
}
#[derive(Clone)]pub struct Monitor{name:c_ulong,primary:bool,x:c_int,y:c_int,width:c_int,height:c_int,outputs:Vec<c_ulong>}
pub fn display_records(id:Option<u64>)->Result<Value,Value>{
    let connection=Connection::open()?;let monitors=connection.monitors()?;
    let primary=monitors.iter().position(|m|m.primary).unwrap_or(0);
    let mut data=Vec::new();
    for (index,monitor)in monitors.into_iter().enumerate(){
        if id.is_some_and(|id|id!=monitor.name){continue;}
        let mut row=json!({"id":monitor.name,"width":monitor.width,"height":monitor.height,"isMain":index==primary,"unknownFields":["isBuiltin"]});
        if id.is_some(){row["pixelWidth"]=json!(monitor.width);row["pixelHeight"]=json!(monitor.height);
            row["unknownFields"]=json!(["isBuiltin","refreshRate","rotation"]);
        }else{row["x"]=json!(monitor.x);row["y"]=json!(monitor.y);row["isVirtual"]=json!(false);}
        data.push(row);
    }
    if id.is_some(){data.into_iter().next().ok_or_else(||failure("unsupported_target","requested RandR display is not active"))}else{Ok(json!(data))}
}
pub fn capture_target(action:&Value,continuous:bool)->Result<(Window,Option<u32>,Option<Monitor>),Value>{
    let connection=Connection::open()?;let root=unsafe{XDefaultRootWindow(connection.display)};
    let display=action["mode"]=="display"||(!action["window"].is_number()&&!action["app"].is_string()&&(action["display"].is_number()||continuous));
    if display{
        let monitors=connection.monitors()?;
        let monitor=if action["display"].is_number(){
            let id=action["display"].as_f64().unwrap()as c_ulong;
            monitors.iter().find(|m|m.name==id||(id==root&&monitors.len()==1))
        }else{monitors.iter().find(|m|m.primary).or_else(||monitors.first())};
        let monitor=monitor.cloned().ok_or_else(||failure("unsupported_target","requested RandR capture display is not active"))?;
        return Ok((root,None,Some(monitor)));
    }
    let clients=connection.words(root,"_NET_CLIENT_LIST").ok_or_else(||failure("unsupported_target","X11 client list unavailable"))?;
    let mut candidates:Vec<_>=clients.into_iter().filter(|w|action["window"].as_f64().is_none_or(|id|id==*w as f64)&&
        action["_capture_pid"].as_u64().is_none_or(|pid|connection.owner(*w)==Some(pid as u32))).collect();
    if action["type"]=="desktop_stream"&&action["app"].is_string()&&candidates.len()>1{return Err(failure("target_ambiguous","stream application has multiple capturable windows; select one exact window"));}
    if !action["window"].is_number()&&!action["app"].is_string(){
        let active=connection.words(root,"_NET_ACTIVE_WINDOW").and_then(|v|v.first().copied());
        candidates.retain(|w|Some(*w)==active);
        if candidates.is_empty(){return Ok((root,None,None));}
    }else{candidates.sort_by_key(|w|connection.frame(*w).map(|(f,_)|-(f["width"].as_i64().unwrap_or(0)*f["height"].as_i64().unwrap_or(0))).unwrap_or(0));}
    let window=*candidates.first().ok_or_else(||failure("unsupported_target","requested application/window has no capturable window"))?;
    let pid=connection.owner(window).ok_or_else(||failure("unsupported_target","capture requires XRes-authenticated window ownership"))?;
    Ok((window,Some(pid),None))
}
pub struct CaptureSession{connection:Connection,window:Window,pid:Option<u32>,monitor:Option<Monitor>,ready_at:std::time::Instant}
impl CaptureSession{
    pub fn open(window:Window,pid:Option<u32>,monitor:Option<Monitor>)->Result<Self,Value>{
        let connection=Connection::open()?;let display=connection.display;
        if let Some(pid)=pid{
            if connection.owner(window)!=Some(pid){return Err(failure("target_gone","capture target changed process owner before redirection"));}
            let(mut major,mut minor)=(0,0);
            if unsafe{XCompositeQueryVersion(display,&mut major,&mut minor)}==0||(major,minor)<(0,2){return Err(failure("unsupported_operation","XComposite 0.2 is required for background window capture"));}
            unsafe{XCompositeRedirectWindow(display,window,0);XSync(display,0);}
            if X_ERROR.swap(0,Ordering::Relaxed)!=0{return Err(failure("background_unavailable","window could not be redirected for background capture"));}
        }
        // Retain automatic redirection for the source lifetime. Recreating it
        // for every sample discards occluded pixels before the target repaints.
        let ready_at=std::time::Instant::now()+std::time::Duration::from_millis(if pid.is_some(){200}else{0});
        Ok(Self{connection,window,pid,monitor,ready_at})
    }
    pub fn ready(&self)->bool{std::time::Instant::now()>=self.ready_at}
}
impl Drop for CaptureSession{fn drop(&mut self){if self.pid.is_some(){unsafe{XCompositeUnredirectWindow(self.connection.display,self.window,0);XSync(self.connection.display,0);}}}}
pub fn capture_pixels(session:&CaptureSession)->Result<image::RgbaImage,Value>{
    let connection=&session.connection;let display=connection.display;let(window,pid)=(session.window,session.pid);
    X_ERROR.store(0,Ordering::Relaxed);
    if let Some(pid)=pid{
        if connection.owner(window)!=Some(pid){return Err(failure("target_gone","X11 capture target changed process owner"));}
        let hidden=connection.atom("_NET_WM_STATE_HIDDEN");
        if hidden!=0&&connection.words(window,"_NET_WM_STATE").is_some_and(|states|states.contains(&hidden)){return Err(failure("background_unavailable","minimized X11 capture is not qualified"));}
    }
    let(mut root,mut x,mut y,mut width,mut height,mut border,mut depth)=(0,0,0,0,0,0,0);
    if unsafe{XGetGeometry(display,window,&mut root,&mut x,&mut y,&mut width,&mut height,&mut border,&mut depth)}==0{return Err(failure("target_gone","capture window geometry unavailable"));}
    let (mut crop_x,mut crop_y)=(0,0);
    if let Some(expected)=&session.monitor{
        let monitors=connection.monitors()?;
        if !monitors.iter().any(|m|m.name==expected.name&&m.outputs==expected.outputs&&m.x==expected.x&&m.y==expected.y&&m.width==expected.width&&m.height==expected.height){return Err(failure("target_gone","capture display identity or geometry changed"));}
        if expected.x<0||expected.y<0||i64::from(expected.x)+i64::from(expected.width)>i64::from(width)||i64::from(expected.y)+i64::from(expected.height)>i64::from(height){return Err(failure("unsupported_target","RandR display lies outside the qualified X11 root bounds"));}
        crop_x=expected.x;crop_y=expected.y;width=expected.width as u32;height=expected.height as u32;
    }
    let count=crate::capture::pixel_size(width,height)?;
    let mut attributes:WindowAttributes=unsafe{std::mem::zeroed()};
    if unsafe{XGetWindowAttributes(display,window,&mut attributes)}==0||attributes.visual.is_null(){return Err(failure("target_gone","capture window visual is unavailable"));}
    let visual=unsafe{&*attributes.visual};
    let masks=[visual.red_mask,visual.green_mask,visual.blue_mask];
    if visual.class!=4||!(1..=32).contains(&attributes.depth)||masks.iter().any(|mask|*mask==0||*mask>u32::MAX as c_ulong){return Err(failure("unsupported_target","capture requires a qualified TrueColor window visual"));}
    struct Pixmap(*mut Display,Window);
    impl Drop for Pixmap{fn drop(&mut self){unsafe{XFreePixmap(self.0,self.1);}}}
    struct Image(*mut XImage);
    impl Drop for Image{fn drop(&mut self){unsafe{XDestroyImage(self.0);}}}
    let mut pixmap=None;
    if pid.is_some(){
        let native=unsafe{XCompositeNameWindowPixmap(display,window)};
        unsafe{XSync(display,0);}
        if native==0||X_ERROR.swap(0,Ordering::Relaxed)!=0{return Err(failure("background_unavailable","window backing pixmap is unavailable"));}
        pixmap=Some(Pixmap(display,native));
    }
    let drawable=pixmap.as_ref().map(|p|p.1).unwrap_or(window);
    let raw=unsafe{XGetImage(display,drawable,crop_x,crop_y,width,height,c_ulong::MAX,2)};
    unsafe{XSync(display,0);}
    if raw.is_null(){return Err(failure("background_unavailable","capture drawable returned no image"));}
    let native=Image(raw);
    if X_ERROR.swap(0,Ordering::Relaxed)!=0{return Err(failure("target_gone","capture drawable changed during its read"));}
    let header=unsafe{&*raw};
    if header.width!=width as c_int||header.height!=height as c_int||header.depth!=attributes.depth{return Err(failure("unsupported_target","capture image does not match its qualified window visual"));}
    // A pixmap has no Visual; XGetImage sets its RGB masks to zero. Use the
    // authenticated source window's TrueColor visual, never assumed shifts.
    fn channel(pixel:c_ulong,mask:c_ulong)->u8{let shift=mask.trailing_zeros();let max=mask>>shift;(((pixel&mask)>>shift)*255/max)as u8}
    let mut pixels=vec![0u8;count];
    for y in 0..height{for x in 0..width{let pixel=unsafe{XGetPixel(raw,x as c_int,y as c_int)};let at=(y as usize*width as usize+x as usize)*4;
        pixels[at..at+4].copy_from_slice(&[channel(pixel,masks[0]),channel(pixel,masks[1]),channel(pixel,masks[2]),255]);}}
    drop(native);drop(pixmap);
    image::RgbaImage::from_raw(width,height,pixels).ok_or_else(||failure("provider_failed","capture pixel buffer is invalid"))
}

// Catch BadWindow from a target exit instead of letting Xlib's default handler
// terminate the provider. The handler is process-wide: install it once and never
// restore it, so long-lived connections closing out of order cannot bring the
// exiting default back.
static X_ERROR: AtomicU8 = AtomicU8::new(0);
unsafe extern "C" fn catch_error(_: *mut Display, event: *mut ErrorEvent) -> c_int {
    if !event.is_null() { X_ERROR.store(unsafe { (*event).code }, Ordering::Relaxed); }
    0
}
struct Connection { display: *mut Display }
impl Drop for Connection {
    fn drop(&mut self) { unsafe { XCloseDisplay(self.display); } }
}
enum Property { Words(Vec<c_ulong>), Bytes(Vec<u8>) }
impl Connection {
    fn app_unhide_window_manager(&self) -> Result<(), Value> {
        // ICCCM only requires IconicState. NormalState is a qualified
        // Openbox 3.6.1 extension, whose client_set_wm_state unminimizes
        // without client_activate. XMapWindow activates in that WM.
        let root = unsafe { XDefaultRootWindow(self.display) };
        let checks = self.words(root, "_NET_SUPPORTING_WM_CHECK").unwrap_or_default();
        if checks.len() != 1 || self.words(checks[0], "_NET_SUPPORTING_WM_CHECK") != Some(checks.clone())
            || self.title(checks[0]).as_deref() != Some("Openbox")
            || !matches!(self.property(root, "_OB_VERSION"), Some(Property::Bytes(bytes)) if bytes == b"3.6.1") {
            return Err(failure("background_unavailable", "background app unhide requires the qualified Openbox 3.6.1 NormalState extension"));
        }
        let owner = self.owner(checks[0]).ok_or_else(|| failure("background_unavailable", "window manager requires XRes-authenticated ownership"))?;
        let _manager = crate::linux::capture_identity(owner)?;
        Ok(())
    }
    fn open() -> Result<Self, Value> {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var_os("DISPLAY").is_none() {
            return Err(failure("background_unavailable", "window geometry requires a qualified X11 session; Wayland geometry is not qualified"));
        }
        let display = unsafe { XOpenDisplay(ptr::null()) };
        if display.is_null() { return Err(failure("no_interactive_session", "cannot connect to the session's X11 display")); }
        X_ERROR.store(0, Ordering::Relaxed);
        static HANDLER: std::sync::Once = std::sync::Once::new();
        HANDLER.call_once(|| unsafe { XSetErrorHandler(Some(catch_error)); });
        let connection = Self { display };
        let (mut major, mut minor) = (0, 0);
        if unsafe { XResQueryVersion(display, &mut major, &mut minor) } == 0 || (major, minor) < (1, 2) {
            return Err(failure("unsupported_operation", "XRes 1.2 server client-PID identity is required before geometry delivery"));
        }
        Ok(connection)
    }
    fn atom(&self, name: &str) -> c_ulong {
        unsafe { XInternAtom(self.display, CString::new(name).unwrap().as_ptr(), 1) }
    }
    fn monitors(&self)->Result<Vec<Monitor>,Value>{
        let(mut major,mut minor)=(0,0);
        if unsafe{XRRQueryVersion(self.display,&mut major,&mut minor)}==0||(major,minor)<(1,5){return Err(failure("unsupported_operation","native display reads require RandR 1.5"));}
        let mut count=0;let raw=unsafe{XRRGetMonitors(self.display,XDefaultRootWindow(self.display),1,&mut count)};
        struct Owned(*mut MonitorInfo);impl Drop for Owned{fn drop(&mut self){unsafe{XRRFreeMonitors(self.0);}}}
        if raw.is_null(){return Err(failure("provider_failed","RandR returned no monitor metadata"));}
        let _owned=Owned(raw);
        if count<0||count as usize>crate::contract_generated::DESKTOP_DISPLAY_MAX_COUNT{return Err(failure("resource_limit","RandR monitor count exceeds its bound"));}
        let mut records=Vec::new();
        for index in 0..count{
            let m=unsafe{&*raw.add(index as usize)};
            if m.name==0||m.name>9007199254740991||m.width<=0||m.height<=0||!(0..=64).contains(&m.noutput)||(m.noutput>0&&m.outputs.is_null()){return Err(failure("provider_failed","RandR monitor metadata is invalid"));}
            let outputs=if m.noutput==0{Vec::new()}else{unsafe{std::slice::from_raw_parts(m.outputs,m.noutput as usize)}.to_vec()};
            records.push(Monitor{name:m.name,primary:m.primary!=0,x:m.x,y:m.y,width:m.width,height:m.height,outputs});
        }
        Ok(records)
    }
    fn matching_window(&self,pid:u32,title:&str,before:&Value)->Result<Window,Value>{
        let clients=self.words(unsafe{XDefaultRootWindow(self.display)},"_NET_CLIENT_LIST").ok_or_else(||failure("unsupported_target","bounded X11 client list unavailable"))?;
        let candidates:Vec<_>=clients.into_iter().filter(|window|self.owner(*window)==Some(pid)&&self.title(*window).as_deref()==Some(title)&&self.frame(*window).is_some_and(|(frame,_)|frame==*before)).collect();
        if candidates.len()!=1{return Err(failure("unsupported_target","no unique XRes-authenticated window matches the accessibility process, title and frame"));}
        unsafe{XSync(self.display,0);}
        if X_ERROR.swap(0,Ordering::Relaxed)!=0{return Err(failure("stale_reference","X11 window identity changed during its query"));}
        Ok(candidates[0])
    }
    fn property(&self, window: Window, name: &str) -> Option<Property> {
        let atom = self.atom(name);
        if atom == 0 { return None; }
        let (mut actual, mut format, mut count, mut remaining, mut data) = (0, 0, 0, 0, ptr::null_mut());
        let status = unsafe { XGetWindowProperty(self.display, window, atom, 0, 10000, 0, 0,
            &mut actual, &mut format, &mut count, &mut remaining, &mut data) };
        let result = if status != 0 || data.is_null() || remaining != 0 || count > 10000 { None }
            else { unsafe { match format {
                32 => Some(Property::Words(std::slice::from_raw_parts(data.cast::<c_ulong>(), count as usize).to_vec())),
                8 => Some(Property::Bytes(std::slice::from_raw_parts(data, count as usize).to_vec())),
                _ => None,
            } } };
        if !data.is_null() { unsafe { XFree(data.cast()); } }
        result
    }
    fn words(&self, window: Window, name: &str) -> Option<Vec<c_ulong>> {
        match self.property(window, name)? { Property::Words(v) => Some(v), _ => None }
    }
    fn owner(&self, window: Window) -> Option<u32> {
        let mut spec = ClientIdSpec { client: window, mask: 2 };
        let (mut count, mut ids) = (0, ptr::null_mut());
        let status = unsafe { XResQueryClientIds(self.display, 1, &mut spec, &mut count, &mut ids) };
        let mut owner = None;
        // Unlike XResQueryVersion, QueryClientIds returns Success (zero).
        if status == 0 && !ids.is_null() && (1..=16).contains(&count) {
            for n in 0..count { let value = unsafe { XResGetClientPid(ids.add(n as usize)) }; if value > 0 { owner = Some(value as u32); } }
        }
        if !ids.is_null() { unsafe { XResClientIdsDestroy(count, ids); } }
        owner
    }
    fn title(&self, window: Window) -> Option<String> {
        let property = self.property(window, "_NET_WM_NAME").or_else(|| self.property(window, "WM_NAME"))?;
        match property { Property::Bytes(bytes) => String::from_utf8(bytes).ok(), _ => None }
    }
    fn frame(&self, window: Window) -> Option<(Value, [i64; 4])> {
        let extents = self.words(window, "_NET_FRAME_EXTENTS")?;
        if extents.len() != 4 || extents.iter().any(|n| *n > 10000) { return None; }
        let extents = [extents[0] as i64, extents[1] as i64, extents[2] as i64, extents[3] as i64];
        let (mut root, mut child, mut x, mut y, mut width, mut height, mut border, mut depth) = (0, 0, 0, 0, 0, 0, 0, 0);
        if unsafe { XGetGeometry(self.display, window, &mut root, &mut x, &mut y, &mut width, &mut height, &mut border, &mut depth) } == 0 { return None; }
        if unsafe { XTranslateCoordinates(self.display, window, root, 0, 0, &mut x, &mut y, &mut child) } == 0 { return None; }
        Some((json!({"x":i64::from(x)-extents[0],"y":i64::from(y)-extents[2],
            "width":i64::from(width)+extents[0]+extents[1],"height":i64::from(height)+extents[2]+extents[3]}), extents))
    }
}
pub fn window_id(pid:u32,title:&str,before:&Value)->Result<Window,Value>{Connection::open()?.matching_window(pid,title,before)}

// GTK 3.24 gdk_window_x11_get_frame_extents divides the root position by
// window_scale and rounds the size up, including the position remainder.
// Require that exact relationship on every axis; a size ratio alone cannot
// establish which window or coordinate system an accessible describes.
fn accessible_scale(native:&Value,accessible:&Value)->Option<i64>{
    let fields=["x","y","width","height"];
    let pixels=fields.map(|key|native[key].as_i64());
    let logical=fields.map(|key|accessible[key].as_i64());
    let [Some(x),Some(y),Some(width),Some(height)]=pixels else{return None;};
    if [x,y,width,height].iter().any(|n|i32::try_from(*n).is_err())||width<=0||height<=0{return None;}
    let mut matches=(1..=8).filter(|scale|{
        let expected=[x/scale,y/scale,(width+x%scale+scale-1)/scale,(height+y%scale+scale-1)/scale];
        logical==expected.map(Some)
    });
    let scale=matches.next()?;
    if matches.next().is_some(){None}else{Some(scale)}
}

pub fn window_info(pid:u32,title:&str,accessible:&Value)->Result<(Window,Value,i64),Value>{
    let _process=crate::linux::capture_identity(pid)?;
    let connection=Connection::open()?;
    let clients=connection.words(unsafe{XDefaultRootWindow(connection.display)},"_NET_CLIENT_LIST")
        .ok_or_else(||failure("unsupported_target","bounded X11 client list unavailable"))?;
    let mut matches=Vec::new();
    for window in clients{
        if connection.owner(window)!=Some(pid)||connection.title(window).as_deref()!=Some(title){continue;}
        if let Some((frame,_))=connection.frame(window){
            if let Some(scale)=accessible_scale(&frame,accessible){matches.push((window,frame,scale));}
        }
    }
    unsafe{XSync(connection.display,0);}
    if X_ERROR.swap(0,Ordering::Relaxed)!=0{return Err(failure("stale_reference","X11 window identity changed during its query"));}
    if matches.len()!=1{return Err(failure("unsupported_target","no unique XRes-authenticated window matches the accessibility process, title and scaled frame"));}
    Ok(matches.remove(0))
}

fn server_time(connection:&Connection)->Result<u32,Value>{
    let display=connection.display;
    let root=unsafe{XDefaultRootWindow(display)};
    let window=unsafe{XCreateSimpleWindow(display,root,0,0,1,1,0,0,0)};
    if window==0{return Err(failure("provider_failed","unable to create an unmapped timestamp window"));}
    struct OwnedWindow(*mut Display,Window);
    impl Drop for OwnedWindow{fn drop(&mut self){unsafe{XDestroyWindow(self.0,self.1);XSync(self.0,0);}}}
    let _owned=OwnedWindow(display,window);
    let atom=unsafe{XInternAtom(display,c"_INTERCEPTOR_INPUT_TIMESTAMP".as_ptr(),0)};
    let mut event=Event{padding:[0;24]};
    unsafe{
        XSelectInput(display,window,1<<22);
        XChangeProperty(display,window,atom,atom,8,0,[0_u8].as_ptr(),1);
        XSync(display,0);
    }
    if X_ERROR.swap(0,Ordering::Relaxed)!=0||unsafe{XCheckWindowEvent(display,window,1<<22,&mut event)}==0{
        return Err(failure("provider_failed","X server timestamp query failed before input delivery"));
    }
    let property=unsafe{event.property};
    if property.kind!=28||property.window!=window||property.atom!=atom{return Err(failure("provider_failed","X server timestamp reply did not match the owned query"));}
    Ok(property.time as u32)
}

/// Direct X11 messages do not alter server keyboard state, focus or pointer.
/// The reply describes delivery. Toolkit effects are qualified independently.
pub fn input(verb:&str,action:&Value,pid:u32,title:&str,frame:&Value,start:Option<(i32,i32)>,end:Option<(i32,i32)>)->Result<Value,Value>{
    let process=crate::linux::capture_identity(pid)?;
    let connection=Connection::open()?;
    let window=connection.matching_window(pid,title,frame)?;
    let root=unsafe{XDefaultRootWindow(connection.display)};
    let mut focus=0;let mut revert=0;unsafe{XGetInputFocus(connection.display,&mut focus,&mut revert);}
    let active=connection.words(root,"_NET_ACTIVE_WINDOW");
    let mut root_ret=0;let mut child=0;let(mut root_x,mut root_y,mut x,mut y,mut mask)=(0,0,0,0,0);
    unsafe{XQueryPointer(connection.display,root,&mut root_ret,&mut child,&mut root_x,&mut root_y,&mut x,&mut y,&mut mask);}
    let cursor=(root_x,root_y);
    let mut events=Vec::<(InputEvent,c_long)>::new();
    // Gtk and other toolkits use X server timestamps for multi-clicks/grabs.
    // A per-request counter can be older than their last grab and be rejected.
    let stamp=server_time(&connection)?;
    let time=std::time::Instant::now();
    let point=|p:(i32,i32)|->Result<(Window,i32,i32),Value>{
        let mut target=window;
        for _ in 0..32 {
            let(mut local_x,mut local_y,mut nested)=(0,0,0);
            if unsafe{XTranslateCoordinates(connection.display,root,target,p.0,p.1,&mut local_x,&mut local_y,&mut nested)}==0{return Err(failure("stale_reference","pointer target disappeared"));}
            let mut attributes:WindowAttributes=unsafe{std::mem::zeroed()};
            if unsafe{XGetWindowAttributes(connection.display,target,&mut attributes)}==0||attributes.map_state!=2||local_x<0||local_y<0||local_x>=attributes.width||local_y>=attributes.height{return Err(failure("unsupported_target","pointer point is outside the selected visible client window"));}
            if nested==0{return Ok((target,local_x,local_y));}
            if connection.owner(nested)!=Some(pid){return Err(failure("permission_denied","pointer subwindow belongs to a different process"));}target=nested;
        }Err(failure("resource_limit","pointer subwindow depth exceeds 32"))
    };
    let mut push=|kind:i32,p:(i32,i32),detail:u32,state:u32,event_mask:c_long|->Result<(),Value>{
        let(target,x,y)=if kind==2||kind==3{(window,0,0)}else{point(p)?};
        events.push((InputEvent{kind,serial:0,send_event:1,display:connection.display,window:target,root,subwindow:0,time:stamp as c_ulong,x,y,x_root:p.0,y_root:p.1,state,detail,same_screen:1},event_mask));Ok(())
    };
    match verb {
        "keys"=>{
            let mut keys=Vec::new();
            for name in action["keys"].as_str().unwrap_or("").split('+') {
                let lower=name.to_ascii_lowercase();
                let mapped=match lower.as_str(){"ctrl"|"control"=>"Control_L","shift"=>"Shift_L","alt"|"option"=>"Alt_L","win"|"super"|"cmd"|"command"|"meta"=>"Super_L", "enter"|"return"=>"Return","esc"|"escape"=>"Escape","tab"=>"Tab","space"=>"space","backspace"=>"BackSpace","delete"|"forwarddelete"=>"Delete","left"|"arrowleft"=>"Left","right"|"arrowright"=>"Right","up"|"arrowup"=>"Up","down"|"arrowdown"=>"Down","home"=>"Home","end"=>"End","pageup"=>"Page_Up","pagedown"=>"Page_Down",_=>name};
                let mapped=if lower.starts_with('f')&&lower[1..].parse::<u8>().is_ok_and(|n|(1..=24).contains(&n)){format!("F{}",&lower[1..])}else{mapped.to_owned()};
                let name=CString::new(mapped).map_err(|_|failure("invalid_request","invalid key name"))?;
                let symbol=unsafe{XStringToKeysym(name.as_ptr())};let code=unsafe{XKeysymToKeycode(connection.display,symbol)};
                if symbol==0||code==0||keys.len()>=8||keys.iter().any(|(prior,_)|*prior==code){return Err(failure("invalid_request","key combination is unavailable in the current layout or repeats a key"));}
                keys.push((code,unsafe{XkbKeysymToModifiers(connection.display,symbol)}));
            }
            let mut state=0;
            for(code,modifier)in &keys{push(2,cursor,*code as u32,state,1)?;state|=*modifier;}
            for(code,modifier)in keys.iter().rev(){push(3,cursor,*code as u32,state,2)?;state&=!*modifier;}
        },
        "click"|"scroll"|"drag"=>{
            let p=start.ok_or_else(||failure("unsupported_target","pointer target has no bounds"))?;
            if verb=="click" {
                let button=if action["right"]==true{3}else{1};
                for _ in 0..if action["double"]==true{2}else{1}{push(4,p,button,0,1<<2)?;push(5,p,button,1<<(7+button),1<<3)?;}
            }else if verb=="scroll"{
                let button=match action["direction"].as_str().unwrap_or("down"){"up"=>4,"down"=>5,"left"=>6,_=>7};
                let units=action["amount"].as_u64().unwrap_or(300).div_ceil(120);
                let count=units.saturating_mul(action["times"].as_u64().unwrap_or(1));
                if count>512{return Err(failure("resource_limit","X11 wheel request exceeds 512 steps"));}
                for _ in 0..count {push(4,p,button,0,1<<2)?;push(5,p,button,0,1<<3)?;}
            }else{
                let q=end.ok_or_else(||failure("invalid_request","drag requires an endpoint"))?;
                push(4,p,1,0,1<<2)?;
                for step in 1..=32 {push(6,((i64::from(p.0)+(i64::from(q.0)-i64::from(p.0))*step/32)as i32,(i64::from(p.1)+(i64::from(q.1)-i64::from(p.1))*step/32)as i32),0,1<<8,(1<<6)|(1<<8))?;}
                push(5,q,1,1<<8,1<<3)?;
            }
        },_=>return Err(failure("unsupported_operation","unknown direct X11 input operation")),
    }
    unsafe{XSync(connection.display,0);}
    if X_ERROR.swap(0,Ordering::Relaxed)!=0||!process.alive(){return Err(failure("stale_reference","input target query failed before delivery"));}
    let interval=action["intervalMs"].as_u64().unwrap_or(0);
    let group=action["amount"].as_u64().unwrap_or(300).div_ceil(120)as usize*2;
    for(index,(event,_event_mask))in events.iter().enumerate(){
        if verb=="scroll"&&index>0&&index%group==0&&interval>0{std::thread::sleep(std::time::Duration::from_millis(interval));}
        if !process.alive()||connection.owner(window)!=Some(pid){return Err(failure(if index==0{"stale_reference"}else{"timeout_unknown_outcome"},"input target exited or changed; remaining messages cancelled, observe before retrying"));}
        let mut message=Event{input:*event};
        message.input.time=stamp.wrapping_add(time.elapsed().as_millis()as u32)as c_ulong;
        // NoEventMask addresses the owning client. GTK's XI2 backend does not
        // select core key/button masks, so mask-filtered sends reach no client.
        // X.org XSendEvent(3): zero mask delivers to the window creator.
        if unsafe{XSendEvent(connection.display,event.window,0,0,&mut message)}==0{return Err(failure("timeout_unknown_outcome","X11 event delivery failed; observe before retrying"));}
    }
    unsafe{XSync(connection.display,0);}
    if X_ERROR.swap(0,Ordering::Relaxed)!=0{return Err(failure("timeout_unknown_outcome","X11 target rejected a delivered event; observe before retrying"));}
    let mut after_focus=0;unsafe{XGetInputFocus(connection.display,&mut after_focus,&mut revert);XQueryPointer(connection.display,root,&mut root_ret,&mut child,&mut root_x,&mut root_y,&mut x,&mut y,&mut mask);}
    let focus_unchanged=focus==after_focus&&active==connection.words(root,"_NET_ACTIVE_WINDOW");
    let cursor_unchanged=cursor==(root_x,root_y);
    let elapsed=time.elapsed().as_millis();
    Ok(json!({"method":"X11.XSendEvent","background":focus_unchanged,"foregroundUsed":!focus_unchanged,"focusUnchanged":focus_unchanged,"cursorUnchanged":cursor_unchanged,"delivered":events.len(),"windowId":window.to_string(),"targetPid":pid,"elapsedMs":elapsed,"effectRequiresObservation":true}))
}

fn resize_content(action: &Value, extents: [i64; 4]) -> Option<[c_long; 2]> {
    let width = action["width"].as_i64()? - extents[0] - extents[1];
    let height = action["height"].as_i64()? - extents[2] - extents[3];
    (width > 0 && height > 0).then_some([width as c_long, height as c_long])
}

pub fn deliver(verb: &str, action: &Value, pid: u32, title: &str, before: &Value) -> Result<(), Value> {
    let connection = Connection::open()?;
    let root = unsafe { XDefaultRootWindow(connection.display) };
    let message_type = connection.atom("_NET_MOVERESIZE_WINDOW");
    if message_type == 0 || !connection.words(root, "_NET_SUPPORTED").is_some_and(|v| v.contains(&message_type)) {
        return Err(failure("background_unavailable", "window manager does not advertise EWMH geometry"));
    }
    let window = connection.matching_window(pid,title,before)?;
    let required = connection.atom(if verb == "resize" { "_NET_WM_ACTION_RESIZE" } else { "_NET_WM_ACTION_MOVE" });
    if required == 0 || !connection.words(window, "_NET_WM_ALLOWED_ACTIONS").is_some_and(|actions| actions.contains(&required)) {
        return Err(failure("unsupported_target", "window manager does not permit the requested geometry action"));
    }
    let states = connection.words(window, "_NET_WM_STATE").unwrap_or_default();
    if ["_NET_WM_STATE_MAXIMIZED_HORZ", "_NET_WM_STATE_MAXIMIZED_VERT", "_NET_WM_STATE_FULLSCREEN", "_NET_WM_STATE_HIDDEN"]
        .iter().any(|name| { let atom = connection.atom(name); atom != 0 && states.contains(&atom) }) {
        return Err(failure("unsupported_target", "geometry requires a restored X11 window"));
    }
    let (frame, extents) = connection.frame(window).ok_or_else(|| failure("stale_reference", "window frame disappeared before delivery"))?;
    if connection.owner(window) != Some(pid) || frame != *before {
        return Err(failure("stale_reference", "X11 target identity or frame changed before delivery"));
    }
    let mut data = [1 | (2 << 12), 0, 0, 0, 0]; // NorthWestGravity, pager source, no restack/focus request.
    if verb == "resize" {
        let dimensions = resize_content(action, extents).ok_or_else(|| failure("unsupported_target", "requested outer frame is smaller than window decorations"))?;
        data[0] |= (1 << 10) | (1 << 11); data[3] = dimensions[0]; data[4] = dimensions[1];
    } else {
        data[0] |= (1 << 8) | (1 << 9); data[1] = action["x"].as_i64().unwrap() as c_long; data[2] = action["y"].as_i64().unwrap() as c_long;
    }
    unsafe { XSync(connection.display, 0); }
    if X_ERROR.swap(0, Ordering::Relaxed) != 0 { return Err(failure("stale_reference", "X11 target query failed before delivery")); }
    let mut event = Event { client: ClientMessage { kind: 33, serial: 0, send_event: 1,
        display: connection.display, window, message_type, format: 32, data } };
    let sent = unsafe { XSendEvent(connection.display, root, 0, (1 << 19) | (1 << 20), &mut event) };
    unsafe { XSync(connection.display, 0); }
    if sent == 0 || X_ERROR.swap(0, Ordering::Relaxed) != 0 {
        return Err(failure("timeout_unknown_outcome", "X11 geometry delivery failed; observe before retrying"));
    }
    Ok(())
}

/// App lifecycle through EWMH/ICCCM client messages sent to the root window.
/// Delivery does not change server input state; the WM performs the action.
pub fn app_action(pid: u32, sub: &str) -> Result<Value, Value> {
    let connection = Connection::open()?;
    let root = unsafe { XDefaultRootWindow(connection.display) };
    let supported = connection.words(root, "_NET_SUPPORTED").unwrap_or_default();
    let clients = connection.words(root, "_NET_CLIENT_LIST").ok_or_else(|| failure("unsupported_target", "bounded X11 client list unavailable"))?;
    let windows: Vec<Window> = clients.into_iter().filter(|w| connection.owner(*w) == Some(pid)).collect();
    if windows.is_empty() { return Err(failure("unsupported_target", "no X11 window is owned by the requested application")); }
    let process = crate::linux::capture_identity(pid)?;
    let send = |message_type: c_ulong, window: Window, data: [c_long; 5]| -> Result<(), Value> {
        if !process.alive() || connection.owner(window) != Some(pid) {
            return Err(failure("target_gone", "retained app process or authenticated window owner changed before delivery"));
        }
        let mut event = Event { client: ClientMessage { kind: 33, serial: 0, send_event: 1,
            display: connection.display, window, message_type, format: 32, data } };
        unsafe { XSync(connection.display, 0); }
        let sent = unsafe { XSendEvent(connection.display, root, 0, (1 << 19) | (1 << 20), &mut event) };
        unsafe { XSync(connection.display, 0); }
        if sent == 0 || X_ERROR.swap(0, Ordering::Relaxed) != 0 { return Err(failure("timeout_unknown_outcome", "X11 app message delivery failed; observe before retrying")); }
        Ok(())
    };
    match sub {
        "activate" => {
            let message = connection.atom("_NET_ACTIVE_WINDOW");
            if message == 0 || !supported.contains(&message) { return Err(failure("background_unavailable", "window manager does not advertise _NET_ACTIVE_WINDOW")); }
            let time = server_time(&connection)? as c_long;
            let window = *windows.last().unwrap();
            send(message, window, [1, time, 0, 0, 0])?;
            Ok(json!({"subcommand":sub,"pid":pid,"window":window as u64,"windows":windows.len(),"method":"_NET_ACTIVE_WINDOW"}))
        }
        "hide" | "unhide" => {
            if sub == "unhide" { connection.app_unhide_window_manager()?; }
            let message = connection.atom("WM_CHANGE_STATE");
            if message == 0 { return Err(failure("background_unavailable", "window manager does not support ICCCM WM_CHANGE_STATE")); }
            let state = if sub == "hide" { 3 } else { 1 }; // IconicState / NormalState
            for window in &windows { send(message, *window, [state, 0, 0, 0, 0])?; }
            Ok(json!({"subcommand":sub,"pid":pid,"windows":windows.len(),"method":if sub == "hide" {"WM_CHANGE_STATE/IconicState"} else {"Openbox3.6.1/WM_CHANGE_STATE/NormalState"}}))
        }
        "quit" => {
            let message = connection.atom("_NET_CLOSE_WINDOW");
            if message == 0 || !supported.contains(&message) { return Err(failure("background_unavailable", "window manager does not advertise _NET_CLOSE_WINDOW")); }
            let time = server_time(&connection)? as c_long;
            for window in &windows { send(message, *window, [time, 2, 0, 0, 0])?; }
            Ok(json!({"subcommand":"quit","pid":pid,"windows":windows.len(),"method":"_NET_CLOSE_WINDOW","note":"close requested; the application may prompt before exiting"}))
        }
        _ => Err(failure("invalid_request", "unsupported app subcommand")),
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn accessible_frames_require_exact_gtk_rounding_and_one_scale(){
        let frame=json!({"x":0,"y":0,"width":1042,"height":1245});
        assert_eq!(accessible_scale(&frame,&json!({"x":0,"y":0,"width":521,"height":623})),Some(2));
        assert_eq!(accessible_scale(&frame,&frame),Some(1));
        assert_eq!(accessible_scale(&frame,&json!({"x":0,"y":0,"width":521,"height":622})),None);
        assert_eq!(accessible_scale(&frame,&json!({"x":1,"y":0,"width":521,"height":623})),None);
        assert_eq!(accessible_scale(&json!({"x":-101,"y":451,"width":1042,"height":1245}),
            &json!({"x":-50,"y":225,"width":521,"height":623})),Some(2));
        assert_eq!(accessible_scale(&json!({"x":0,"y":0,"width":1,"height":1}),
            &json!({"x":0,"y":0,"width":1,"height":1})),None);
        assert_eq!(accessible_scale(&json!({"x":0,"y":0,"width":0,"height":1245}),&frame),None);
        assert_eq!(accessible_scale(&frame,&json!({"x":0,"y":0,"width":521.5,"height":623})),None);
    }
    #[test] fn outer_frame_conversion_preserves_decorations_without_changing_minimum_size() {
        assert_eq!(resize_content(&json!({"width":600,"height":480}), [1, 1, 20, 5]), Some([598,455]));
        assert_eq!(resize_content(&json!({"width":2,"height":25}), [1, 1, 20, 5]), None);
        assert_eq!(std::mem::size_of::<Event>(), 24 * std::mem::size_of::<c_long>());
    }
}
