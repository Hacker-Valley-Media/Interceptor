use crate::{failure, success};
use serde_json::{Value, json};
use std::{cell::RefCell,collections::{HashMap,VecDeque}, ffi::{CStr, CString, c_char, c_int, c_void}, os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd}, ptr, rc::Rc,
    sync::{Arc,OnceLock, mpsc,atomic::Ordering}, time::{Duration, Instant}};
#[path="linux_background_text.rs"] mod background_text;

// ABI declarations match Ubuntu 24.04's libatspi 2.52 headers. Objects
// returned with transfer-full stay on the GLib worker and are released there.
type Raw = *mut c_void;
#[repr(C)] struct Rect { x: c_int, y: c_int, width: c_int, height: c_int }
#[link(name = "atspi")]
unsafe extern "C" {
    fn atspi_init() -> c_int;
    fn atspi_set_timeout(timeout: c_int, startup: c_int);
    fn atspi_get_desktop(index: c_int) -> Raw;
    fn atspi_get_version(major: *mut c_int, minor: *mut c_int, micro: *mut c_int);
    fn atspi_accessible_get_application(obj: Raw, error: Raw) -> Raw;
    fn atspi_accessible_get_toolkit_name(obj: Raw, error: Raw) -> *mut c_char;
    fn atspi_accessible_get_toolkit_version(obj: Raw, error: Raw) -> *mut c_char;
    fn atspi_accessible_get_child_count(obj: Raw, error: Raw) -> c_int;
    fn atspi_accessible_get_child_at_index(obj: Raw, index: c_int, error: Raw) -> Raw;
    fn atspi_accessible_get_parent(obj:Raw,error:Raw)->Raw;
    fn atspi_accessible_get_name(obj: Raw, error: Raw) -> *mut c_char;
    fn atspi_accessible_get_role_name(obj: Raw, error: Raw) -> *mut c_char;
    fn atspi_accessible_get_role(obj:Raw,error:Raw)->c_int;
    fn atspi_accessible_get_process_id(obj: Raw, error: Raw) -> u32;
    fn atspi_accessible_get_state_set(obj: Raw) -> Raw;
    fn atspi_state_set_contains(obj: Raw, state: c_int) -> c_int;
    fn atspi_accessible_get_text_iface(obj: Raw) -> Raw;
    fn atspi_text_get_character_count(obj: Raw, error: Raw) -> c_int;
    fn atspi_text_get_caret_offset(obj:Raw,error:Raw)->c_int;
    fn atspi_text_set_caret_offset(obj:Raw,offset:c_int,error:Raw)->c_int;
    fn atspi_text_get_text(obj: Raw, start: c_int, end: c_int, error: Raw) -> *mut c_char;
    fn atspi_text_get_n_selections(obj: Raw, error: Raw) -> c_int;
    fn atspi_text_get_selection(obj: Raw, index: c_int, error: Raw) -> *mut TextRange;
    fn atspi_text_get_bounded_ranges(obj: Raw, x: c_int, y: c_int, width: c_int, height: c_int, coordinates: c_int, clip_x: c_int, clip_y: c_int, error: Raw) -> *mut GArray;
    fn atspi_text_get_character_extents(obj: Raw, offset: c_int, coordinates: c_int, error: Raw) -> *mut Rect;
    fn atspi_accessible_get_editable_text_iface(obj: Raw) -> Raw;
    fn atspi_editable_text_set_text_contents(obj: Raw, text: *const c_char, error: Raw) -> c_int;
    fn atspi_editable_text_insert_text(obj:Raw,position:c_int,text:*const c_char,length:c_int,error:Raw)->c_int;
    fn atspi_editable_text_delete_text(obj:Raw,start:c_int,end:c_int,error:Raw)->c_int;
    fn atspi_accessible_get_action_iface(obj: Raw) -> Raw;
    fn atspi_action_get_n_actions(obj: Raw, error: Raw) -> c_int;
    fn atspi_action_get_action_name(obj: Raw, index: c_int, error: Raw) -> *mut c_char;
    fn atspi_action_do_action(obj: Raw, index: c_int, error: Raw) -> c_int;
    fn atspi_accessible_get_component_iface(obj: Raw) -> Raw;
    fn atspi_component_get_extents(obj: Raw, coordinates: c_int, error: Raw) -> *mut Rect;
    fn atspi_event_get_type()->usize;
    fn atspi_event_listener_new(callback:unsafe extern "C" fn(*mut AtspiEvent,Raw),data:Raw,destroy:unsafe extern "C" fn(Raw))->Raw;
    fn atspi_event_listener_register(listener:Raw,event:*const c_char,error:*mut Raw)->c_int;
    fn atspi_event_listener_deregister(listener:Raw,event:*const c_char,error:*mut Raw)->c_int;
}
#[link(name = "gobject-2.0")]
unsafe extern "C" { fn g_object_unref(obj: Raw); fn g_object_ref(obj: Raw) -> Raw; fn g_boxed_free(kind:usize,value:Raw); }
#[link(name = "glib-2.0")]
unsafe extern "C" { fn g_free(obj: Raw); fn g_main_context_iteration(context: Raw, blocking: c_int) -> c_int; }
#[link(name = "glib-2.0")]
unsafe extern "C" { fn g_error_free(error: Raw); }
#[link(name = "glib-2.0")]
unsafe extern "C" { fn g_array_get_element_size(array: *mut GArray) -> u32; fn g_array_unref(array: *mut GArray); }

pub(crate) struct Object(pub(crate) Raw);
impl Object { pub(crate) fn from(raw: Raw) -> Option<Self> { (!raw.is_null()).then(|| Self(raw)) } }
impl Clone for Object { fn clone(&self) -> Self { Self(unsafe { g_object_ref(self.0) }) } }
impl Drop for Object { fn drop(&mut self) { unsafe { g_object_unref(self.0); } } }
#[link(name = "gio-2.0")]
unsafe extern "C" { fn g_app_info_get_default_for_uri_scheme(scheme:*const c_char)->Raw; }
pub(crate) fn uri_handler(scheme:&CStr)->bool { Object::from(unsafe { g_app_info_get_default_for_uri_scheme(scheme.as_ptr()) }).is_some() }
// pidfd pins the kernel process creation, so a recycled numeric PID cannot
// make an old accessibility reference usable. One fd is shared per process.
struct Process { pid: u32, fd: OwnedFd }
pub struct CaptureIdentity(Process);
impl CaptureIdentity{
    pub fn alive(&self)->bool{self.0.alive()}
    pub fn pidfd(&self)->BorrowedFd<'_>{self.0.fd.as_fd()}
}
pub fn capture_identity(pid:u32)->Result<CaptureIdentity,Value>{
    let process=Process::open(pid).ok_or_else(||failure("target_gone","capture target exited before process retention"))?;
    if !process.same_login(){
        return Err(failure("permission_denied","capture target requires the same user and login session"));
    }
    Ok(CaptureIdentity(process))
}
impl Process {
    fn secret_identity(&self)->Result<Value,Value>{
        use std::os::unix::fs::MetadataExt;
        if !self.same_login(){return Err(failure("permission_denied","native secret target requires the current graphical login"));}
        let inspect=||->std::io::Result<Value>{
            let root=format!("/proc/{}",self.pid);
            let exe=format!("{root}/exe");
            let path=std::fs::read_link(&exe)?;
            let path=path.to_str().filter(|path|path.starts_with('/')&&!path.ends_with(" (deleted)")).ok_or_else(||std::io::Error::other("executable path is unavailable"))?;
            let image=std::fs::File::open(&exe)?;let metadata=image.metadata()?;
            let stat=std::fs::read_to_string(format!("{root}/stat"))?;
            let creation=stat.rsplit_once(") ").and_then(|(_,fields)|fields.split_whitespace().nth(19)).filter(|text|!text.is_empty()&&text.bytes().all(|byte|byte.is_ascii_digit())).ok_or_else(||std::io::Error::other("process creation is unavailable"))?;
            let session=crate::linux_peer::resolve_session(&self.fd).ok_or_else(||std::io::Error::other("graphical login changed"))?;
            let uid=std::fs::metadata(&root)?.uid();if uid!=unsafe{libc::geteuid()}{return Err(std::io::Error::other("process owner changed"));}
            let after=std::fs::metadata(&exe)?;
            if metadata.dev()!=after.dev()||metadata.ino()!=after.ino()||std::fs::read_link(&exe)?.to_str()!=Some(path)||!self.same_login(){return Err(std::io::Error::other("executable identity changed"));}
            Ok(json!({"host":"linux","pid":self.pid,"executable":path,"user":uid.to_string(),"session":format!("{}:{}",session.id,session.start_usec),"creation":creation,
                "image":format!("{}:{}:{}:{}:{}",metadata.dev(),metadata.ino(),metadata.ctime(),metadata.ctime_nsec(),metadata.len())}))
        };
        inspect().map_err(|_|failure("stale_reference","native secret target identity is unavailable or changed"))
    }
    fn open(pid: u32) -> Option<Self> {
        if pid == 0 || pid > i32::MAX as u32 { return None; }
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0_u32) };
        if fd < 0 { return None; }
        let process = Self { pid, fd: unsafe { OwnedFd::from_raw_fd(fd as c_int) } };
        process.alive().then_some(process)
    }
    fn alive(&self) -> bool {
        let mut fd = libc::pollfd { fd: self.fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        unsafe { libc::poll(&mut fd, 1, 0) == 0 }
    }
    fn same_login(&self) -> bool {
        let Some(current)=login_identity(0) else{return false;};
        crate::linux_peer::resolve_session(&self.fd).is_some_and(|target|target.id==current.id&&target.start_usec==current.start_usec)&&self.alive()
    }
}
unsafe fn string(raw: *mut c_char) -> String {
    if raw.is_null() { return String::new(); }
    unsafe { let text = CStr::from_ptr(raw).to_string_lossy().into_owned(); g_free(raw.cast()); text }
}
fn children(obj: &Object, max: usize) -> Vec<Object> {
    unsafe {
        let count = atspi_accessible_get_child_count(obj.0, ptr::null_mut()).max(0) as usize;
        (0..count.min(max)).filter_map(|i| Object::from(atspi_accessible_get_child_at_index(obj.0, i as c_int, ptr::null_mut()))).collect()
    }
}
fn has_state(obj: &Object, state: c_int) -> bool {
    unsafe { Object::from(atspi_accessible_get_state_set(obj.0)).is_some_and(|set| atspi_state_set_contains(set.0, state) != 0) }
}
fn name(obj: &Object) -> String { unsafe { string(atspi_accessible_get_name(obj.0, ptr::null_mut())) } }
fn role(obj: &Object) -> String { unsafe { string(atspi_accessible_get_role_name(obj.0, ptr::null_mut())) } }
fn pid(obj: &Object) -> u32 { unsafe { atspi_accessible_get_process_id(obj.0, ptr::null_mut()) } }
fn value(obj: &Object, secure: bool) -> String {
    if secure { return "•••".to_owned(); }
    unsafe { Object::from(atspi_accessible_get_text_iface(obj.0)).map(|text|
        string(atspi_text_get_text(text.0, 0, atspi_text_get_character_count(text.0, ptr::null_mut()).clamp(0, 65536), ptr::null_mut()))).unwrap_or_default() }
}
#[repr(C)] struct TextRange { start: c_int, end: c_int }
fn selected_text(obj: &Object) -> Value {
    if role(obj) == "password text" { return success(json!("•••")); }
    unsafe {
        let Some(text) = Object::from(atspi_accessible_get_text_iface(obj.0)) else { return failure("unsupported_target", "target does not expose text selection"); };
        let mut error: Raw = ptr::null_mut();
        let location = (&mut error as *mut Raw).cast();
        let count = atspi_text_get_n_selections(text.0, location);
        if !error.is_null() { g_error_free(error); return failure("provider_failed", "AT-SPI selection count failed"); }
        if !(0..=64).contains(&count) { return failure("resource_limit", "too many selected text ranges"); }
        let mut selected = String::new();
        for index in 0..count {
            let range = atspi_text_get_selection(text.0, index, location);
            if !error.is_null() || range.is_null() {
                if !range.is_null() { g_free(range.cast()); }
                if !error.is_null() { g_error_free(error); }
                return failure("provider_failed", "AT-SPI selection range failed");
            }
            let (start, end) = ((*range).start, (*range).end); g_free(range.cast());
            if start < 0 || end < start { return failure("provider_failed", "AT-SPI selection range is invalid"); }
            if i64::from(end) - i64::from(start) > 65536 { return failure("resource_limit", "selected text exceeds the native read limit"); }
            let raw = atspi_text_get_text(text.0, start, end, location);
            if !error.is_null() || raw.is_null() {
                if !raw.is_null() { g_free(raw.cast()); }
                if !error.is_null() { g_error_free(error); }
                return failure("provider_failed", "AT-SPI selected text read failed");
            }
            let part = string(raw);
            if index > 0 { selected.push('\n'); }
            selected.push_str(&part);
            if selected.len() > 262144 { return failure("resource_limit", "selected text exceeds the native read limit"); }
        }
        success(json!(selected))
    }
}

#[repr(C)] struct GArray { data: Raw, len: u32 }
#[repr(C)] struct BoundedTextRange { start: c_int, end: c_int, content: *mut c_char }
struct BoundedRanges(*mut GArray);
impl Drop for BoundedRanges {
    fn drop(&mut self) {
        unsafe {
            // libatspi 2.52 dbind stores (iisv) ranges by value, with the
            // unused variant taking no space. Each content is g_strdup-owned;
            // its GArray has no element clear callback.
            if g_array_get_element_size(self.0) as usize == std::mem::size_of::<BoundedTextRange>() {
                for index in 0..(*self.0).len as usize {
                    g_free((*(*self.0).data.cast::<BoundedTextRange>().add(index)).content.cast());
                }
            }
            g_array_unref(self.0);
        }
    }
}
fn visible_text(obj: &Object) -> Value {
    if role(obj) == "password text" { return success(json!("•••")); }
    unsafe {
        let Some(text) = Object::from(atspi_accessible_get_text_iface(obj.0)) else { return failure("unsupported_target", "target does not expose native text"); };
        // Visibility states do not depend on the bounded-range ABI. A hidden
        // control must never fall back to its nonempty full value.
        if !has_state(obj, 25) || !has_state(obj, 30) { return success(json!("")); }
        let mut error: Raw = ptr::null_mut();
        let location = (&mut error as *mut Raw).cast();
        // Both inspected libatspi/ATK versions send width,height and read
        // height,width. Keep the compensation scoped to qualified pairs.
        let (mut major, mut minor, mut micro) = (0, 0, 0);
        atspi_get_version(&mut major, &mut minor, &mut micro);
        let application = Object::from(atspi_accessible_get_application(obj.0, location));
        let gtk_version = application.as_ref().and_then(|app| {
            if !error.is_null() || string(atspi_accessible_get_toolkit_name(app.0, location)) != "gtk" || !error.is_null() { return None; }
            let version = string(atspi_accessible_get_toolkit_version(app.0, location));
            error.is_null().then_some(version)
        });
        let native_ranges = error.is_null() && matches!((gtk_version.as_deref(), major, minor, micro),
            (Some("3.24.41"), 2, 52, 0) | (Some("3.24.52"), 2, 60, 6));
        if !error.is_null() { g_error_free(error); error = ptr::null_mut(); }
        if let Some(component) = native_ranges.then(|| Object::from(atspi_accessible_get_component_iface(obj.0))).flatten() {
            let rect = atspi_component_get_extents(component.0, 0, location);
            let bounds = if !rect.is_null() { let bounds = ((*rect).x, (*rect).y, (*rect).width, (*rect).height); g_free(rect.cast()); Some(bounds) } else { None };
            if !error.is_null() { g_error_free(error); error = ptr::null_mut(); }
            else if let Some((x, y, width, height)) = bounds.filter(|(_, _, w, h)| *w > 0 && *h > 0) {
                // Screen coordinates and CLIP_NONE include partial boundary
                // glyphs, matching native visible-range reads.
                let raw = atspi_text_get_bounded_ranges(text.0, x, y, height, width, 0, 0, 0, location);
                let ranges = (!raw.is_null()).then(|| BoundedRanges(raw));
                if !error.is_null() { g_error_free(error); error = ptr::null_mut(); }
                else if let Some(ranges) = ranges {
                    if g_array_get_element_size(ranges.0) as usize != std::mem::size_of::<BoundedTextRange>() { return failure("unsupported_target", "native bounded text range ABI is not qualified"); }
                    if (*ranges.0).len > 64 { return failure("resource_limit", "too many visible text ranges"); }
                    if (*ranges.0).len == 0 {
                        // GTK Entry's default ATK bounded-range method also
                        // returns no ranges when its corner probes miss the
                        // text layout. A visible first glyph proves that
                        // empty answer is unavailable range support, so use
                        // the bounded full-value fallback. True empty or
                        // off-viewport text stays empty.
                        let count = atspi_text_get_character_count(text.0, location);
                        if !error.is_null() { g_error_free(error); return failure("provider_failed", "native visible text count failed"); }
                        if count < 0 { return failure("provider_failed", "native visible text count is invalid"); }
                        if count == 0 { return success(json!("")); }
                        let glyph = atspi_text_get_character_extents(text.0, 0, 0, location);
                        let glyph_bounds = if !glyph.is_null() { let r = &*glyph; let bounds = (r.x, r.y, r.width, r.height); g_free(glyph.cast()); Some(bounds) } else { None };
                        if !error.is_null() { g_error_free(error); error = ptr::null_mut(); }
                        else if let Some((gx, gy, gw, gh)) = glyph_bounds {
                            let intersects = gw > 0 && gh > 0 && i64::from(gx) < i64::from(x) + i64::from(width)
                                && i64::from(gy) < i64::from(y) + i64::from(height)
                                && i64::from(gx) + i64::from(gw) > i64::from(x)
                                && i64::from(gy) + i64::from(gh) > i64::from(y);
                            if !intersects { return success(json!("")); }
                        }
                    } else {
                    let mut result = String::new();
                    for index in 0..(*ranges.0).len as usize {
                        let range = &*(*ranges.0).data.cast::<BoundedTextRange>().add(index);
                        if range.start < 0 || range.end < range.start || range.content.is_null() { return failure("provider_failed", "native visible text range is invalid"); }
                        if i64::from(range.end) - i64::from(range.start) > 65536 { return failure("resource_limit", "visible text range exceeds the read limit"); }
                        let bytes = CStr::from_ptr(range.content).to_bytes();
                        if bytes.len() > 262144 { return failure("resource_limit", "visible text range exceeds the read limit"); }
                        let part = match std::str::from_utf8(bytes) { Ok(part) => part, Err(_) => return failure("provider_failed", "native visible text contains invalid UTF-8") };
                        if index > 0 { result.push('\n'); }
                        result.push_str(part);
                        if result.len() > 262144 { return failure("resource_limit", "visible text ranges exceed the read limit"); }
                    }
                    return success(json!(result));
                    }
                }
            }
        }
        // The Mac baseline falls back to full value when visible ranges are
        // unavailable, including the geometry-confirmed GTK Entry failure.
        let count = atspi_text_get_character_count(text.0, location);
        if !error.is_null() { g_error_free(error); return failure("provider_failed", "native full text count failed"); }
        if count < 0 { return failure("provider_failed", "native full text count is invalid"); }
        if count > 65536 { return failure("resource_limit", "full-value visible text fallback exceeds the read limit"); }
        let raw = atspi_text_get_text(text.0, 0, count, location);
        if !error.is_null() || raw.is_null() {
            if !raw.is_null() { g_free(raw.cast()); }
            if !error.is_null() { g_error_free(error); }
            return failure("provider_failed", "native full text fallback failed");
        }
        let result = match CStr::from_ptr(raw).to_str() {
            Ok(value) if value.len() <= 262144 => success(json!(value)),
            Ok(_) => failure("resource_limit", "full-value text fallback exceeds the byte limit"),
            Err(_) => failure("provider_failed", "native full text fallback contains invalid UTF-8"),
        };
        g_free(raw.cast()); result
    }
}
pub fn login_session(pid: libc::pid_t) -> Option<String> {
    login_identity(pid).map(|identity|identity.id)
}
pub fn login_identity(pid: libc::pid_t) -> Option<crate::linux_peer::SessionIdentity> {
    let pid=if pid==0{std::process::id()}else{u32::try_from(pid).ok()?};
    let process=Process::open(pid)?;
    let identity=crate::linux_peer::resolve_session(&process.fd)?;
    process.alive().then_some(identity)
}
pub fn graphical_login() -> bool { login_identity(0).is_some_and(|identity| crate::linux_peer::graphical(&identity)) }
pub fn session() -> String { login_session(0).unwrap_or_else(|| "none".to_owned()) }
pub fn identity() -> std::io::Result<Value> {
    use std::os::unix::fs::MetadataExt;
    let association = login_identity(0).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::PermissionDenied, "no systemd login session; a GUI broker is required (no unique authorized graphical display)"))?;
    let session = &association.id;
    if session.is_empty() || session.len() > 128 || !session.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err(std::io::Error::other("invalid native login session identifier"));
    }
    let uid = unsafe { libc::geteuid() };
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from).unwrap_or_else(|| format!("/run/user/{uid}").into());
    let meta = std::fs::symlink_metadata(&runtime)?;
    if !runtime.is_absolute() || !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o777 != 0o700 {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "XDG_RUNTIME_DIR must be an owned private directory (0700)"));
    }
    let endpoint = runtime.join("interceptor-desktop").join(format!("session-{session}.sock"));
    if endpoint.as_os_str().as_encoded_bytes().len() >= 108 { return Err(std::io::Error::other("native session socket path is too long")); }
    Ok(json!({"uid":uid,"session":session,"endpoint":endpoint,"sessionSource":association.source,"sessionStartUsec":association.start_usec.to_string()}))
}
pub fn client(endpoint: Option<&str>, stop: bool, timeout_ms: u32) -> std::io::Result<()> {
    use std::os::unix::{net::UnixStream, fs::{FileTypeExt, MetadataExt}};
    let identity = identity()?;
    let endpoint = endpoint.unwrap_or(identity["endpoint"].as_str().unwrap_or(""));
    let mut stream = match UnixStream::connect(endpoint) {
        Ok(stream) => stream,
        Err(error) if stop && error.kind() == std::io::ErrorKind::ConnectionRefused &&
            std::fs::symlink_metadata(endpoint).is_ok_and(|meta| meta.file_type().is_socket() &&
                meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o777 == 0o600) => return Ok(()),
        Err(error) => return Err(error),
    };
    stream.set_read_timeout(Some(Duration::from_millis(timeout_ms.into())))?;
    stream.set_write_timeout(Some(Duration::from_secs(15)))?;
    if !crate::linux_peer::authorized(&stream, identity["session"].as_str().unwrap_or(""), Some(&std::env::current_exe()?)) {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "native socket server identity does not match this user, session and provider binary"));
    }
    let mut output = stream.try_clone()?;
    crate::client_session(&mut stream, &mut output, stop)
}
fn gui() -> bool { login_session(0).is_some() && (std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()) && std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some() }
pub fn capabilities() -> Value {
    let session = session();
    let graphical = gui();
    let x11 = graphical && std::env::var_os("DISPLAY").is_some() && std::env::var_os("WAYLAND_DISPLAY").is_none();
    let hyprland_keys=graphical&&std::env::var_os("WAYLAND_DISPLAY").is_some()&&crate::linux_hyprland::available();
    // One authenticated negotiation supplies presence, menu support and the
    // reported version. Do not infer a protocol version from a second probe.
    let pointer_protocol=if hyprland_keys{crate::linux_hyprland::pointer_protocol_version().unwrap_or(0)}else{0};
    let hyprland_pointer=pointer_protocol>0;
    let hyprland_menu=pointer_protocol>=2;
    let mut entries: Vec<Value> = ["apps", "windows", "frontmost", "focused", "tree", "find", "inspect", "value", "text", "click", "type", "action", "resize", "move", "keys", "scroll", "drag", "menu"].iter().map(|&operation|
        { let geometry = ["resize", "move"].contains(&operation);let direct_input=["keys","scroll","drag"].contains(&operation);let native_wayland_keys=operation=="keys"&&hyprland_keys;let native_wayland_pointer=["click","scroll","drag"].contains(&operation)&&hyprland_pointer;let wayland_menu=operation=="menu"&&std::env::var_os("WAYLAND_DISPLAY").is_some();
        // Geometry: X11 EWMH, or Hyprland IPC on Wayland. Menus on Wayland need the menu-scope companion.
        let ready=if geometry { x11||hyprland_keys } else if direct_input { x11||native_wayland_keys||native_wayland_pointer } else if wayland_menu { graphical&&hyprland_menu } else { graphical };
        json!({"operation":operation,"compiled":true,"present":true,"permission":"not_applicable","session":session,
            "effective":ready,"background":if ready { "semantic" } else { "unavailable" },
            "provider":if geometry&&hyprland_keys { "Hyprland.Lua.window+AT-SPI2" } else if geometry { "X11.EWMH/XRes+AT-SPI2" }else if native_wayland_keys{"Hyprland.Lua.send_shortcut+AT-SPI2"}else if native_wayland_pointer{"Hyprland/background-pointer-v1+AT-SPI2"}else if wayland_menu&&hyprland_menu{"Hyprland/menu-scope-v1+AT-SPI2"}else if direct_input{"X11.XSendEvent/XRes+AT-SPI2"} else { "AT-SPI2" },"versions":if native_wayland_pointer{json!({"abi":"2","Hyprland":"0.56.1","pointerProtocol":pointer_protocol.to_string()})}else if wayland_menu&&hyprland_menu{json!({"abi":"2","Hyprland":"0.56.1","pointerProtocol":pointer_protocol.to_string(),"menuScope":"1","scopeMilliseconds":"750"})}else if native_wayland_keys{json!({"abi":"2","Hyprland":"0.56.1"})}else{json!({"abi":"2"})},
            "limits":if geometry&&hyprland_keys { vec!["Hyprland 0.56.1 exact qualified commit; native Wayland targets only", "a tiled window is set floating before exact geometry", "unique process/title match", "same user session"] } else if geometry { vec!["X11 only; XRes 1.2 server process identity and EWMH support required", "unique process/title/frame match", "same user session"] }
                else if native_wayland_keys{vec!["Hyprland 0.56.1 exact qualified commit; native Wayland targets only", "one non-modifier key with supported modifiers; current compositor layout", "same user/login through retained PIDfd identity or unique logind graphical-display association", "Linux 6.5 peer PIDfd and libsystemd 254 session identity APIs required", "physical held modifiers and alternate layouts require further qualification"]}
                else if native_wayland_pointer{vec!["Hyprland 0.56.1 exact qualified commit and loaded authenticated pointer integration", "native Wayland target and AT-SPI/compositor window match required", "logical screen coordinates; cursor and compositor focus preserved", "wheel units 120; at most 512 steps and two second delivery budget", "session lock, drag-and-drop, seat grabs and held physical buttons refuse before input", "application effects require observation after delivery"]}
                else if wayland_menu{vec!["menu inventory requires AT-SPI interfaces", "invocation requires Hyprland 0.56.1 and the qualified menu-scope companion", "popup scope expires after 750ms and is released with its authenticated protocol object", "disabled, ambiguous and non-leaf menu paths refuse before invocation", "same retained user/login and target process; effects require observation"]}
                else if direct_input{vec!["X11 only; toolkit must accept direct messages", "XRes-authenticated target", "wheel units 120; at most 512 steps", "no server input-state or focus mutation"]}
                else { vec!["target must expose AT-SPI interfaces", "same user session", "no global input or compositor privilege"] },
            "reason":if !ready && wayland_menu { "Wayland menu invocation needs the Hyprland menu-scope companion (pointer protocol 2)" } else if !ready && graphical && !x11 && ["click","scroll","drag"].contains(&operation) { "Wayland click, scroll and drag need the Hyprland background-pointer companion (the hyprland/ payload in the Full archive), loaded when the provider starts" } else if !ready && graphical { "no qualified input or geometry backend for this session" } else if graphical { "target interface qualification required" } else { "no desktop session environment" }}) }).collect();
    // Background restoration is not a generic EWMH activation request.
    entries.push(json!({"operation":"app","compiled":true,"present":true,"permission":"not_applicable","session":session,
        "effective":x11||pointer_protocol>=3,"background":if x11||pointer_protocol>=3 {"window"} else {"unavailable"},"provider":if x11{"X11.EWMH+AT-SPI2"}else{"Hyprland.app-lifecycle-v3+AT-SPI2"},"versions":if x11{json!({"abi":"2"})}else{json!({"abi":"2","Hyprland":"0.56.1","pointerProtocol":pointer_protocol.to_string()})},
        "limits":if x11{vec!["EWMH _NET_ACTIVE_WINDOW/_NET_CLOSE_WINDOW and ICCCM WM_CHANGE_STATE required", "background unhide requires XRes-authenticated Openbox3.6.1 and its NormalState extension", "same retained process and login session"]}else{vec!["Hyprland 0.56.1 exact qualified commit and authenticated version 3 companion required", "native Wayland mapped windows only; at most 64 per selected retained PIDfd", "every target connection requires the same retained process and graphical login", "grouped windows, XWayland and other compositor hiding state are excluded", "hide and quit on the active app refuse to preserve focus; activate explicitly changes focus", "plugin unload and login revocation restore only windows hidden by this instance", "quit requests normal window close; process exit requires observation", "launch uses desktop open with an absolute executable path", "other Wayland compositors require separate qualification"]},
        "reason":if x11 {"window-manager EWMH support required"}else if pointer_protocol>=3{"target interface qualification required"}else{"authenticated version 3 companion required; no app lifecycle request is sent"}}));
    json!(entries)
}
// The transfer-full event's GValue is deliberately never read. Text is
// collected through the existing secure-field reader after scope checks.
#[repr(C)]struct AtspiEvent{kind:*mut c_char,source:Raw,detail1:c_int,detail2:c_int,any_data:[usize;3],sender:Raw}
struct ObservedObject{generation:u64,kind:String,object:Object,identity:CaptureIdentity,application:Option<Object>}
struct ObservationQueue{observer:Arc<crate::monitor::Observer>,events:RefCell<VecDeque<ObservedObject>>}
unsafe extern "C" fn observation_callback(event:*mut AtspiEvent,data:Raw){
    unsafe{
        if event.is_null(){return;}
        let state=&*data.cast::<ObservationQueue>();
        if let Some(generation)=state.observer.epoch(){
            if !(*event).kind.is_null()&&!(*event).source.is_null(){
                let length=libc::strnlen((*event).kind,256);
                if length<256{
                    let object=Object(g_object_ref((*event).source));
                    if let Ok(identity)=capture_identity(pid(&object)){
                        let application=Object::from(atspi_accessible_get_application(object.0,ptr::null_mut()));
                        let accepted=application.as_ref().is_some_and(|app|state.observer.accepts(identity.0.pid,&name(app),true));
                        if !accepted{g_boxed_free(atspi_event_get_type(),event.cast());return;}
                        let kind=String::from_utf8_lossy(std::slice::from_raw_parts((*event).kind.cast::<u8>(),length)).into_owned();
                        // The destroyed accessible becomes defunct before
                        // the worker reads it. Retain its live application
                        // while this native notification still identifies it.
                        let application=if kind=="window:destroy"{application}else{None};
                        let mut queue=state.events.borrow_mut();
                        if queue.len()<256{queue.push_back(ObservedObject{generation,kind,object,identity,application});}
                        else{state.observer.dropped.fetch_add(1,Ordering::Relaxed);}
                    }
                }
            }
        }
        g_boxed_free(atspi_event_get_type(),event.cast());
    }
}
unsafe extern "C" fn observation_destroy(data:Raw){unsafe{drop(Rc::from_raw(data.cast::<ObservationQueue>()));}}
struct Observation{listener:Object,state:Rc<ObservationQueue>,registered:Vec<CString>}
impl Observation{
    fn new(observer:Arc<crate::monitor::Observer>)->Result<Self,Value>{
        let state=Rc::new(ObservationQueue{observer,events:RefCell::new(VecDeque::new())});
        let data=Rc::into_raw(state.clone())as Raw;
        let Some(listener)=Object::from(unsafe{atspi_event_listener_new(observation_callback,data,observation_destroy)})else{
            unsafe{observation_destroy(data);}return Err(failure("provider_failed","AT-SPI listener creation failed"));
        };
        let mut result=Self{listener,state,registered:vec![]};
        let ax=["object:state-changed:focused","object:text-changed","object:property-change:accessible-name","object:property-change:accessible-value","object:bounds-changed","object:children-changed"];
        let workspace=["window:create","window:destroy","window:activate","window:deactivate"];
        for source in ["ax","workspace"]{if !result.state.observer.excludes.contains(source){
            for kind in if source=="ax"{ax.as_slice()}else{workspace.as_slice()}{
                let kind=CString::new(*kind).unwrap();let mut error=ptr::null_mut();
                let registered=unsafe{atspi_event_listener_register(result.listener.0,kind.as_ptr(),&mut error)!=0};
                if !error.is_null(){unsafe{g_error_free(error);}}
                if !registered{return Err(failure("provider_failed","AT-SPI source subscription was refused"));}
                result.registered.push(kind);
            }
        }}Ok(result)
    }
    fn coverage(&self)->Value{json!(self.state.observer.excludes.iter().fold(vec!["ax","workspace"],|mut sources,excluded|{sources.retain(|s|*s!=excluded);sources}).iter().map(|source|json!({"source":source,"available":true,"provider":"AT-SPI2-event-listener","limits":["accessible applications in the retained graphical login only","focus, text/property/bounds/children and window lifecycle notifications; no global device events","bounded 256-event queues; secure values masked; current snapshot may differ from notification time"]})).collect::<Vec<_>>())}
    fn detach(&mut self)->Result<(),Value>{
        while let Some(kind)=self.registered.last(){let mut error=ptr::null_mut();let removed=unsafe{atspi_event_listener_deregister(self.listener.0,kind.as_ptr(),&mut error)!=0};let failed=!removed||!error.is_null();if !error.is_null(){unsafe{g_error_free(error);}}
            if failed{return Err(failure("timeout_unknown_outcome","AT-SPI listener removal was not acknowledged"));}self.registered.pop();
        }self.state.events.borrow_mut().clear();self.state.observer.detached.store(true,Ordering::Release);Ok(())
    }
}
impl Drop for Observation{fn drop(&mut self){let _=self.detach();}}
type Work = (String, Value, Instant, mpsc::Sender<Value>,Option<Arc<crate::monitor::Observer>>);
static WORKER: OnceLock<mpsc::SyncSender<Work>> = OnceLock::new();
pub fn dispatch(verb: &str, action: &Value) -> Value {
    dispatch_work(verb,action,None)
}
pub(crate) fn observe(observer:Arc<crate::monitor::Observer>)->Value{dispatch_work("__monitor_observe",&json!({}),Some(observer))}
pub(crate) fn record_frames(action:&Value,owner:Arc<crate::monitor::Observer>)->Value{dispatch_work("__monitor_frames_start",action,Some(owner))}
fn dispatch_work(verb:&str,action:&Value,observer:Option<Arc<crate::monitor::Observer>>)->Value{
    if !gui() { return failure("no_interactive_session", "Linux native control requires DISPLAY or WAYLAND_DISPLAY and the logged-in user's D-Bus session"); }
    if ["clipboard","__clipboard_snapshot"].contains(&verb) && std::env::var_os("WAYLAND_DISPLAY").is_some() { return crate::clipboard_wayland::execute(verb,action); }
    let wayland=std::env::var_os("WAYLAND_DISPLAY").is_some();
    if wayland&&["display_list","display_info"].contains(&verb){return crate::display::execute(verb,action);}
    // Hyprland captures an exact, process-authenticated window; only the portal path cannot.
    let hyprland=wayland&&crate::capture_linux::hyprland_available();
    if verb=="__monitor_frames_start"&&wayland&&!hyprland{return failure("unsupported_target","Wayland portal streams expose no authenticated application process; app-scoped recording did not capture another source");}
    let portal_admission=wayland&&!hyprland&&(verb=="screenshot"||verb=="capture"&&action["sub"]=="start"||verb=="stream"&&action["op"]=="start");
    let timeout=Duration::from_secs(if portal_admission{58}else{10});
    let worker = WORKER.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel::<Work>(32);
        std::thread::spawn(move || {
            let Some(login)=login_identity(0) else{return;};
            let mut login_checked=Instant::now();
            let initialized = unsafe { atspi_set_timeout(500, 2000); atspi_init() == 0 };
            let mut state = Atspi { refs: HashMap::new(), processes: HashMap::new(), launches: HashMap::new(), screen_frames: HashMap::new(), serial: 0, grants:Default::default(), auth_deadline:None, auth_window:None };
            let mut observations:HashMap<String,Observation>=HashMap::new();
            let mut observation_turn=0_usize;
            loop {
                if login_checked.elapsed()>=Duration::from_millis(500){
                    login_checked=Instant::now();if login_identity(0).as_ref()!=Some(&login){return;}
                }
                crate::capture::tick();
                unsafe { for _ in 0..64 { if g_main_context_iteration(ptr::null_mut(), 0) == 0 { break; } } }
                observations.retain(|_,source|source.state.observer.generation.load(Ordering::Acquire)!=0);
                let observation_deadline=Instant::now()+Duration::from_millis(20);
                let count=observations.len();
                for source in observations.values().cycle().skip(observation_turn%count.max(1)).take(count){if Instant::now()>=observation_deadline{break;}state.observe_events(source,observation_deadline);}
                observation_turn=observation_turn.wrapping_add(1);
                match rx.recv_timeout(Duration::from_millis(10)) {
                    Ok((verb, mut action, deadline, reply,observer)) => {
                        if std::env::var_os("WAYLAND_DISPLAY").is_some()&&(verb=="screenshot"||verb=="capture"&&action["sub"]=="start"||verb=="stream"&&action["op"]=="start"){
                            // Expired queued work never receives a fresh consent
                            // budget. Reserve time for close/reply after expiry.
                            action["_capture_timeout_ms"]=json!(deadline.saturating_duration_since(Instant::now()).as_millis().saturating_sub(3000).min(50_000));
                        }
                        let _ = reply.send(if Instant::now() >= deadline {
                            failure("cancelled", "request expired before execution; nothing was delivered")
                        } else if login_identity(0).as_ref()!=Some(&login){failure("no_interactive_session","accessibility login ended or changed")}
                        else if initialized || (std::env::var_os("WAYLAND_DISPLAY").is_some()&&["screenshot","capture","stream"].contains(&verb.as_str())) {
                            if verb=="__monitor_frames_start"{
                                match observer{
                                    Some(owner)=>match state.capture_action(&action){Ok(action)=>crate::capture::record_start(&action,owner),Err(error)=>error},
                                    None=>failure("invalid_request","internal frame stream omitted its owner")
                                }
                            }else if verb=="__monitor_frames"{crate::capture::record_control(&action)}
                            else if verb=="__monitor_observe"{
                                match observer.ok_or_else(||failure("invalid_request","internal subscription omitted its owner")).and_then(Observation::new){Ok(source)=>{let coverage=source.coverage();observations.insert(source.state.observer.sid.clone(),source);success(json!({"coverage":coverage}))},Err(error)=>error}
                            }else if verb=="__monitor_stop"{match observations.remove(action["sid"].as_str().unwrap_or("")){Some(mut source)=>match source.detach(){Ok(())=>success(json!({"detached":true})),Err(error)=>error},None=>success(json!({"detached":true}))}}
                            else if verb=="__monitor_flush"{
                                let mut drained=false;unsafe{for _ in 0..256{if g_main_context_iteration(ptr::null_mut(),0)==0{drained=true;break;}}}
                                if let Some(source)=observations.get(action["sid"].as_str().unwrap_or("")){source.state.events.borrow_mut().clear();}
                                if drained{success(json!({}))}else{failure("resource_limit","AT-SPI callback queue remains pending; recording remains paused")}
                            }
                            else{
                                state.auth_deadline=if verb=="authdialog"{Some(deadline)}else{None};
                                let result=state.execute(&verb, &action);
                                state.auth_deadline=None;
                                result
                            }
                        }
                        else { failure("provider_failed", "AT-SPI accessibility bus initialization failed") }); },
                    Err(mpsc::RecvTimeoutError::Timeout) => (),
                    Err(_) => break,
                }
            }
        }); tx
    });
    let (tx, rx) = mpsc::channel();
    if worker.try_send((verb.to_owned(), action.clone(), Instant::now() + timeout, tx,observer)).is_err() { return failure("resource_limit", "AT-SPI worker queue is full or unavailable"); }
    rx.recv_timeout(timeout).unwrap_or_else(|_| failure("timeout_unknown_outcome", "Linux native worker deadline exceeded; observe the target before retrying"))
}
fn top_level(element:&Object)->Option<Object>{
    let mut obj=element.clone();
    for _ in 0..32 {
        if ["frame","dialog","window"].contains(&role(&obj).as_str()){return Some(obj);}
        obj=Object::from(unsafe{atspi_accessible_get_parent(obj.0,ptr::null_mut())})?;
    }None
}
fn component_frame(obj:&Object,coordinates:c_int)->Option<Value>{
    unsafe{
        let component=Object::from(atspi_accessible_get_component_iface(obj.0))?;
        let mut error:Raw=ptr::null_mut();
        let rect=atspi_component_get_extents(component.0,coordinates,(&mut error as *mut Raw).cast());
        let result=if !error.is_null()||rect.is_null(){None}else{
            let r=&*rect;Some(json!({"x":r.x,"y":r.y,"width":r.width,"height":r.height}))
        };
        if !rect.is_null(){g_free(rect.cast());}
        if !error.is_null(){g_error_free(error);}
        result
    }
}
struct Atspi { refs: HashMap<String, (Object, Instant, Rc<Process>)>, processes: HashMap<u32, Rc<Process>>, launches: HashMap<u32, (std::path::PathBuf, Rc<Process>, Option<(interceptor_desktop::linux_pointer::PointerConnection,Instant)>)>, screen_frames: HashMap<Raw,Option<(Value,Value,i64)>>, serial: u64, grants:crate::secret_target::Grants, auth_deadline:Option<Instant>, auth_window:Option<Object> }
struct CredentialDialog { application:Object, window:Object, secure:Object, username:Option<Object>, user:String, title:String, message:String, buttons:Vec<(String,Object)>, process:Rc<Process>, identity:Value }
// AT_SPI2_CORE_2_52_0 atspi-constants.h, enum AtspiRole. These identities do
// not depend on display labels. Other roles are not credential controls.
#[derive(Clone,Copy,PartialEq,Eq)]
enum AuthRole{Dialog,Frame,Label,Password,Button,Text,Window,Entry,Other}
impl Atspi {
    unsafe fn auth_role(object:&Object,deadline:Instant)->Result<AuthRole,Value>{unsafe{
        crate::authdialog::check_deadline(deadline)?;
        let mut error:Raw=ptr::null_mut();let role=atspi_accessible_get_role(object.0,(&raw mut error).cast());
        if !error.is_null(){g_error_free(error);return Err(failure("provider_failed","authentication native role is inaccessible"));}
        crate::authdialog::check_deadline(deadline)?;
        Ok(match role{16=>AuthRole::Dialog,23=>AuthRole::Frame,29=>AuthRole::Label,40=>AuthRole::Password,43=>AuthRole::Button,61=>AuthRole::Text,69=>AuthRole::Window,79=>AuthRole::Entry,0=>return Err(failure("target_gone","authentication native role is invalid")),_=>AuthRole::Other})
    }}
    unsafe fn auth_children(object:&Object,deadline:Instant)->Result<Vec<Object>,Value>{unsafe{
        crate::authdialog::check_deadline(deadline)?;
        let mut error:Raw=ptr::null_mut();let count=atspi_accessible_get_child_count(object.0,(&raw mut error).cast());
        if !error.is_null(){g_error_free(error);return Err(failure("provider_failed","authentication child count is inaccessible"));}
        if !(0..=512).contains(&count){return Err(failure("resource_limit","authentication native children exceed 512"));}
        let mut children=Vec::with_capacity(count as usize);
        for index in 0..count{
            crate::authdialog::check_deadline(deadline)?;
            let raw=atspi_accessible_get_child_at_index(object.0,index,(&raw mut error).cast());
            let child=Object::from(raw);
            if !error.is_null(){g_error_free(error);return Err(failure("provider_failed","authentication child inventory changed or is inaccessible"));}
            children.push(child.ok_or_else(||failure("provider_failed","authentication child inventory returned a missing object"))?);
        }
        crate::authdialog::check_deadline(deadline)?;Ok(children)
    }}
    unsafe fn auth_text(object:&Object,get:unsafe extern "C" fn(Raw,Raw)->*mut c_char,deadline:Instant)->Result<String,Value>{unsafe{
        crate::authdialog::check_deadline(deadline)?;
        let mut error:Raw=ptr::null_mut();let raw=get(object.0,(&raw mut error).cast());
        if !error.is_null(){if !raw.is_null(){g_free(raw.cast());}g_error_free(error);return Err(failure("provider_failed","authentication native text is inaccessible"));}
        if raw.is_null(){return Err(failure("provider_failed","authentication native text is unavailable"));}
        let length=libc::strnlen(raw,8193);let result=if length>8192{Err(failure("resource_limit","authentication native text exceeds 8192 bytes"))}else{std::str::from_utf8(std::slice::from_raw_parts(raw.cast::<u8>(),length)).map(str::to_owned).map_err(|_|failure("provider_failed","authentication native text is invalid UTF8"))};
        g_free(raw.cast());crate::authdialog::check_deadline(deadline)?;result
    }}
    unsafe fn credential_dialog(&mut self,a:&Value,deadline:Instant)->Result<Option<CredentialDialog>,Value>{unsafe{
        crate::authdialog::check_deadline(deadline)?;
        let target=if a.get("ref").is_some(){Some(self.reference_object(&a["ref"]).ok_or_else(||failure("stale_reference","authentication secure-field reference expired"))?)}else{None};
        let applications=if let Some(target)=&target{
            vec![Object::from(atspi_accessible_get_application(target.0,ptr::null_mut())).ok_or_else(||failure("provider_failed","authentication application identity is unavailable"))?]
        }else{
            let desktop=Object::from(atspi_get_desktop(0)).ok_or_else(||failure("provider_failed","authentication accessibility desktop is unavailable"))?;
            Self::auth_children(&desktop,deadline)?
        };
        let mut found=None;let mut roots=0;
        for application in applications{
            crate::authdialog::check_deadline(deadline)?;
            let application_pid=pid(&application);
            if a["pid"].as_u64().is_some_and(|wanted|wanted!=application_pid as u64){continue;}
            if let Some(wanted)=a["app"].as_str(){if !Self::auth_text(&application,atspi_accessible_get_name,deadline)?.eq_ignore_ascii_case(wanted){continue;}}
            let process=if let Some(reference)=a["ref"].as_str(){self.refs.get(reference).map(|(_,_,process)|process.clone()).ok_or_else(||failure("stale_reference","authentication process reference expired"))?}
                else{let Some(process)=Process::open(application_pid)else{continue;};Rc::new(process)};
            let identity=match process.secret_identity(){Ok(identity)=>identity,Err(error)if target.is_some()=>return Err(error),Err(_)=>continue};
            let eligible=identity["executable"].as_str().and_then(|p|std::path::Path::new(p).file_name()).and_then(|p|p.to_str()).is_some_and(|name|["polkit-gnome-authentication-agent-1","polkit-kde-authentication-agent-1","lxqt-policykit-agent","mate-polkit","xfce-polkit","hyprpolkitagent"].contains(&name));
            if !eligible{if target.is_some(){return Err(failure("unsupported_target","authentication reference is not owned by an eligible native Polkit agent"));}continue;}
            crate::authdialog::trusted_agent(&identity,deadline)?;
            if a.get("expectedIdentity").is_some()&&!crate::secret_target::matches(&a["expectedIdentity"],&identity){return Err(failure("stale_reference","authentication process differs from its retained vault target"));}
            for window in Self::auth_children(&application,deadline)?{
                crate::authdialog::check_deadline(deadline)?;
                let window_role=Self::auth_role(&window,deadline)?;
                if !matches!(window_role,AuthRole::Frame|AuthRole::Dialog|AuthRole::Window)||has_state(&window,6){continue;}
                roots+=1;if roots>16{return Err(failure("resource_limit","authentication agent roots exceed 16"));}
                if let Some(target)=&target{
                    let top=top_level(target).ok_or_else(||failure("unsupported_target","authentication field has no bounded top-level window"))?;
                    if top.0!=window.0{continue;}
                    if a.get("window").is_some(){self.input_window(a,Some(target))?;}
                }
                if let Some(reference)=a["dialogRef"].as_str(){
                    let expected=self.reference_object(&json!(reference)).ok_or_else(||failure("stale_reference","authentication window reference expired"))?;
                    if expected.0!=window.0{return Err(failure("target_gone","authentication secure field moved to a different window"));}
                }
                let mut stack=vec![(window.clone(),0_usize)];let mut visited=std::collections::HashSet::new();let mut bytes=0_usize;
                let(mut secure,mut username,mut user,mut messages,mut buttons)=(None,None,String::new(),Vec::new(),Vec::new());
                while let Some((object,depth))=stack.pop(){
                    crate::authdialog::check_deadline(deadline)?;
                    if depth>12||visited.len()>=512||!visited.insert(object.0){return Err(failure("resource_limit","authentication tree exceeded its node/depth bound or repeated an object"));}
                    if pid(&object)!=process.pid{return Err(failure("target_gone","authentication control belongs to another process"));}
                    let native_role=Self::auth_role(&object,deadline)?;
                    if native_role==AuthRole::Password{
                        if secure.is_some(){return Err(failure("target_ambiguous","authentication requires one native password field"));}secure=Some(object.clone());
                    }else if matches!(native_role,AuthRole::Label|AuthRole::Button){
                        let title=Self::auth_text(&object,atspi_accessible_get_name,deadline)?;
                        if bytes>32768-title.len(){return Err(failure("resource_limit","authentication observation text exceeds 32768 bytes"));}bytes+=title.len();
                        if native_role==AuthRole::Label{if !title.is_empty(){messages.push(title);}}else{if buttons.len()>=64{return Err(failure("resource_limit","authentication buttons exceed 64"));}buttons.push((title,object.clone()));}
                    }else if matches!(native_role,AuthRole::Text|AuthRole::Entry)&&Object::from(atspi_accessible_get_editable_text_iface(object.0)).is_some(){
                        if username.is_some(){return Err(failure("target_ambiguous","authentication has multiple ordinary editable fields"));}
                        let text=Object::from(atspi_accessible_get_text_iface(object.0)).ok_or_else(||failure("provider_failed","authentication user text interface is unavailable"))?;
                        let mut error:Raw=ptr::null_mut();let count=atspi_text_get_character_count(text.0,(&raw mut error).cast());
                        if !error.is_null(){g_error_free(error);return Err(failure("provider_failed","authentication user field is inaccessible"));}
                        if !(0..=256).contains(&count){return Err(failure("resource_limit","authentication user field exceeds 256 characters"));}
                        let raw=atspi_text_get_text(text.0,0,count,(&raw mut error).cast());
                        if !error.is_null(){if !raw.is_null(){g_free(raw.cast());}g_error_free(error);return Err(failure("provider_failed","authentication user field could not be read"));}
                        if raw.is_null(){return Err(failure("provider_failed","authentication user field is unavailable"));}user=string(raw);username=Some(object.clone());
                    }
                    let children=Self::auth_children(&object,deadline)?;
                    if children.len()>256||stack.len()+visited.len()+children.len()>512{return Err(failure("resource_limit","authentication native child inventory exceeds its bound"));}
                    for child in children{stack.push((child,depth+1));}
                }
                let Some(secure)=secure else{continue;};
                if target.as_ref().is_some_and(|target|target.0!=secure.0){return Err(failure("unsupported_target","authentication reference is not the unique password field"));}
                if !process.secret_identity().is_ok_and(|current|crate::secret_target::matches(&identity,&current)){return Err(failure("target_gone","authentication process changed during traversal"));}
                if found.is_some(){return Err(failure("target_ambiguous","multiple eligible native authentication dialogs are present"));}
                found=Some(CredentialDialog{application:application.clone(),window:window.clone(),secure,username,user,title:Self::auth_text(&window,atspi_accessible_get_name,deadline)?,message:messages.join(" "),buttons,process:process.clone(),identity:identity.clone()});
            }
        }
        crate::authdialog::check_deadline(deadline)?;Ok(found)
    }}
    fn authdialog(&mut self,a:&Value)->Value{
        let result=(||->Result<Value,Value>{unsafe{
            let deadline=self.auth_deadline.ok_or_else(||failure("provider_failed","authentication worker omitted its retained deadline"))?;
            let provider="linux-polkit-dialog";
            let Some(dialog)=self.credential_dialog(a,deadline)?else{
                return if a["sub"]=="status"&&a.get("ref").is_none(){Ok(success(json!({"present":false,"shape":"none","provider":provider})))}else{Err(failure("target_gone","retained native authentication dialog is unavailable"))};
            };
            if a["sub"]=="status"{
                let describe=|state:&mut Atspi,object:Object|->Result<String,Value>{let result=state.describe(object);result["ref"].as_str().filter(|s|!s.is_empty()).map(str::to_owned).ok_or_else(||failure("target_gone","authentication native reference could not be retained"))};
                let secure_ref=if let Some(reference)=a["ref"].as_str(){reference.to_owned()}else{describe(self,dialog.secure.clone())?};
                let dialog_ref=if let Some(reference)=a["dialogRef"].as_str(){reference.to_owned()}else{describe(self,dialog.window.clone())?};
                let mut data=json!({"present":true,"shape":"password","provider":provider,"pid":dialog.process.pid,"title":dialog.title,"message":dialog.message,"buttons":dialog.buttons.iter().map(|(title,_)|title).collect::<Vec<_>>(),"username":dialog.user,"hasSecureField":true,"dialogRef":dialog_ref,"secureRef":secure_ref,"targetIdentity":dialog.identity});
                if let Some(username)=dialog.username{data["usernameRef"]=json!(describe(self,username)?);}crate::authdialog::check_deadline(deadline)?;return Ok(success(data));
            }
            if dialog.username.is_some(){return Err(failure("unsupported_target","authentication account selection requires a qualified native account binding; no password was delivered"));}
            if !has_state(&dialog.secure,7)||!has_state(&dialog.secure,8)||!has_state(&dialog.secure,24)||Object::from(atspi_accessible_get_editable_text_iface(dialog.secure.0)).is_none(){return Err(failure("background_unavailable","native password field has no enabled editable background interface"));}
            crate::authdialog::check_deadline(deadline)?;
            let generation=crate::secret_target::random_token().map_err(|_|failure("provider_failed","authentication request randomness is unavailable"))?;
            self.auth_window=Some(dialog.window.clone());
            let delivery=self.execute("type",&crate::authdialog::typed_action(a));
            self.auth_window=None;
            if delivery["success"]!=true{return Err(if matches!(delivery["code"].as_str(),Some("permission_denied"|"stale_reference"|"background_unavailable")){delivery}else{failure("timeout_unknown_outcome","native authentication value delivery failed; partial effect is possible, observe before another action")});}
            crate::authdialog::check_deadline(deadline).map_err(|_|failure("timeout_unknown_outcome","authentication value delivery completed after its deadline; no confirmation was sent"))?;
            let(mut submitted,mut closed,mut closure_error)=(None,false,None);
            if a["submit"]==true{
                let current=self.credential_dialog(a,deadline)?.ok_or_else(||failure("target_gone","authentication dialog disappeared after value delivery"))?;
                if current.window.0!=dialog.window.0||current.secure.0!=dialog.secure.0{return Err(failure("target_gone","authentication dialog changed after filling; no confirmation was sent"));}
                let titles=current.buttons.iter().map(|(title,_)|title.clone()).collect::<Vec<_>>();let selected=crate::authdialog::confirmation(&titles)?;let(title,button)=&current.buttons[selected];
                if !has_state(button,8)||!has_state(button,24)||pid(button)!=current.process.pid{return Err(failure("target_gone","authentication confirmation is disabled or changed"));}
                let action=Object::from(atspi_accessible_get_action_iface(button.0)).ok_or_else(||failure("unsupported_target","authentication confirmation has no native action interface"))?;
                let mut error:Raw=ptr::null_mut();let count=atspi_action_get_n_actions(action.0,(&raw mut error).cast());
                if !error.is_null(){g_error_free(error);return Err(failure("provider_failed","authentication confirmation actions are inaccessible"));}
                if !(0..=16).contains(&count){return Err(failure("resource_limit","authentication native actions exceed 16"));}
                let mut choices=Vec::new();
                for index in 0..count{
                    crate::authdialog::check_deadline(deadline)?;let raw=atspi_action_get_action_name(action.0,index,(&raw mut error).cast());
                    if !error.is_null(){if !raw.is_null(){g_free(raw.cast());}g_error_free(error);return Err(failure("provider_failed","authentication native action name is inaccessible"));}
                    if raw.is_null(){return Err(failure("provider_failed","authentication native action name is unavailable"));}
                    let name=string(raw);if ["click","press","activate"].contains(&name.as_str()){choices.push(index);}
                }
                if choices.len()!=1{return Err(failure("target_ambiguous","authentication confirmation requires one supported native action"));}
                if !current.process.secret_identity().is_ok_and(|identity|crate::secret_target::matches(&current.identity,&identity)){return Err(failure("target_gone","authentication confirmation process changed"));}
                crate::authdialog::check_deadline(deadline)?;
                let accepted=atspi_action_do_action(action.0,choices[0],(&raw mut error).cast());
                if !error.is_null()||accepted==0{if !error.is_null(){g_error_free(error);}return Err(failure("timeout_unknown_outcome","authentication confirmation outcome is unknown; no fallback or replay was sent"));}submitted=Some(title.clone());
                let observe_until=deadline.min(Instant::now()+Duration::from_secs(2));
                while Instant::now()<observe_until{
                    if !dialog.process.alive(){closed=true;break;}
                    match Self::auth_children(&dialog.application,observe_until){Ok(windows)if !windows.iter().any(|window|window.0==dialog.window.0)=>{closed=true;break;},Ok(_)=>(),Err(error)=>{closure_error=Some(error["code"].as_str().unwrap_or("provider_failed").to_owned());break;}}
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            Ok(crate::authdialog::filled(a,provider,dialog.identity,submitted,closed,closure_error,generation))
        }})();result.unwrap_or_else(|error|error)
    }
    fn observe_events(&mut self,source:&Observation,deadline:Instant){
        for _ in 0..256{
            if Instant::now()>=deadline{break;}
            // Release the queue borrow before D-Bus reads, which can dispatch
            // another callback on this same GLib thread.
            let event=source.state.events.borrow_mut().pop_front();let Some(event)=event else{break;};
            let observer=&source.state.observer;if observer.epoch()!=Some(event.generation){continue;}
            let destroyed=event.kind=="window:destroy";
            let object=event.object;let identity=event.identity;let target=identity.0.pid;if !identity.alive()||!destroyed&&pid(&object)!=target{continue;}
            let Some(app)=(if destroyed{event.application}else{Object::from(unsafe{atspi_accessible_get_application(object.0,ptr::null_mut())})})else{continue;};
            let app_name=name(&app);
            let frontmost=if observer.scope["mode"]=="frontmost"{
                if std::env::var_os("WAYLAND_DISPLAY").is_some()&&std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some(){crate::linux_hyprland::active_window().is_ok_and(|w|w.is_some_and(|w|w.pid==target))}
                else{children(&app,1024).iter().any(|w|has_state(w,1))}
            }else{false};
            if !observer.accepts(target,&app_name,frontmost)||!identity.alive(){continue;}
            let(kind,source_name)=match event.kind.as_str(){
                "window:create"=>("window_create","workspace"),"window:destroy"=>("window_destroy","workspace"),"window:activate"=>("frontmost","workspace"),"window:deactivate"=>("app_deactivate","workspace"),
                kind if kind.starts_with("object:text-changed")||kind=="object:property-change:accessible-value"=>("input","ax"),
                "object:state-changed:focused"=>("focus","ax"),"object:property-change:accessible-name"=>("title_change","ax"),"object:bounds-changed"=>("layout_change","ax"),_ =>("ax_other","ax"),
            };
            if observer.excludes.contains(source_name)||observer.excludes.contains(kind){continue;}
            self.screen_frames.clear();let description=if destroyed{json!({"pid":target,"role":"AXWindow","name":"","secure":false})}else{self.describe_fields(object,kind=="input",true)};
            if description["success"]==false||description["pid"]!=target||!identity.alive(){continue;}
            observer.emit(event.generation,kind,source_name,&app_name,description,&event.kind);
        }
    }
    fn screen_frame(&mut self,obj:&Object)->Option<Value>{
        let wayland=std::env::var_os("WAYLAND_DISPLAY").is_some();
        if !wayland&&top_level(obj).is_none(){return component_frame(obj,0);}
        let window=top_level(obj)?;
        // WINDOW coordinates are toolkit-local on Wayland. Match the retained
        // accessible toplevel to the authenticated native compositor window.
        // Cache only during this request; a later read must see a moved window.
        if !self.screen_frames.contains_key(&window.0){
            let frame=if wayland{
                crate::linux_hyprland::window_info(pid(&window),&name(&window)).ok()
                    .and_then(|(_,screen)|Some((screen,component_frame(&window,1)?,1)))
            }else{
                component_frame(&window,0).and_then(|origin|
                    crate::linux_x11::window_info(pid(&window),&name(&window),&origin).ok()
                        .map(|(_,screen,scale)|(screen,origin,scale)))
            };
            self.screen_frames.insert(window.0,frame);
        }
        let(screen,origin,scale)=self.screen_frames.get(&window.0)?.as_ref()?;
        if window.0==obj.0{return Some(screen.clone());}
        let mut frame=component_frame(obj,if wayland{1}else{0})?;
        for key in ["x","y"]{
            let local=frame[key].as_i64()?;let origin=origin[key].as_i64()?;
            // GTK uses G_MININT for widgets outside their viewport or unmapped.
            // It is unavailable geometry, never a usable screen position.
            if local==i64::from(i32::MIN)||origin==i64::from(i32::MIN){return None;}
            let translated=local.checked_sub(origin)?.checked_mul(*scale)?.checked_add(screen[key].as_i64()?)?;
            frame[key]=json!(i32::try_from(translated).ok()?);
        }
        if ["width","height"].iter().any(|key|frame[*key].as_i64().is_none_or(|n|n<0)){return None;}
        for key in ["width","height"]{frame[key]=json!(i32::try_from(frame[key].as_i64()?.checked_mul(*scale)?).ok()?);}
        Some(frame)
    }
    fn reference_object(&self,reference:&Value)->Option<Object>{
        reference.as_str().and_then(|r|self.refs.get(r)).filter(|(obj,at,process)|at.elapsed()<Duration::from_secs(300)&&process.same_login()&&pid(obj)==process.pid&&!has_state(obj,6)).map(|(obj,_,_)|obj.clone())
    }
    fn input_window(&mut self,a:&Value,element:Option<&Object>)->Result<(Object,Value),Value>{
        let ancestor=element.map(top_level);
        let ancestor=match ancestor{Some(Some(obj))=>Some(obj),Some(None)=>return Err(failure("unsupported_target","reference has no bounded top-level window")),None=>None};
        let windows=self.applications(a).into_iter().flat_map(|app|children(&app,1024)).filter(|obj|["frame","dialog","window"].contains(&role(obj).as_str())).collect::<Vec<_>>();
        let mut matches=Vec::new();
        for obj in windows{
            if ancestor.as_ref().is_some_and(|ancestor|ancestor.0!=obj.0){continue;}
            if a["windowTitle"].as_str().is_some_and(|title|title!=name(&obj)){continue;}
            let mut frame=self.describe(obj.clone())["frame"].clone();
            let wayland=if std::env::var_os("WAYLAND_DISPLAY").is_some(){crate::linux_hyprland::window_info(pid(&obj),&name(&obj)).ok()}else{None};
            if let Some((_,actual))=&wayland{frame=actual.clone();}
            if !frame.is_object()||a["windowBounds"].as_object().is_some_and(|bounds|bounds.iter().any(|(k,v)|frame[match k.as_str(){"left"=>"x","top"=>"y",_=>k.as_str()}].as_f64()!=v.as_f64())){continue;}
            if let Some(id)=a["window"].as_u64(){
                let native=if std::env::var_os("WAYLAND_DISPLAY").is_some(){wayland.as_ref().map(|(id,_)|*id)}else{crate::linux_x11::window_id(pid(&obj),&name(&obj),&frame).ok()};
                if native!=Some(id){continue;}
            }
            if ancestor.is_none()&&a["pid"].is_null()&&a["app"].is_null()&&a["window"].is_null()&&a["windowTitle"].is_null()&&!has_state(&obj,1){continue;}
            matches.push((obj,frame));
        }
        // Several windows of one app: a coordinate picks the window under that point, as macOS does.
        if matches.len()>1{
            let point=[&a["coords"],&a["fromCoords"]].into_iter().find_map(|v|v.as_str().and_then(|v|{let mut p=v.split(',');Some((p.next()?.trim().parse::<f64>().ok()?,p.next()?.trim().parse::<f64>().ok()?))}));
            if let Some((x,y))=point{
                let inside=|f:&Value|f["x"].as_f64().zip(f["y"].as_f64()).zip(f["width"].as_f64().zip(f["height"].as_f64())).is_some_and(|((fx,fy),(w,h))|x>=fx&&y>=fy&&x<fx+w&&y<fy+h);
                if let Some(index)=matches.iter().position(|(_,frame)|inside(frame)){matches=vec![matches.swap_remove(index)];}
            }
        }
        if matches.len()!=1{return Err(failure(if matches.is_empty(){"target_gone"}else{"target_ambiguous"},"input requires exactly one matching top-level window"));}
        let selected=matches.remove(0);
        if a["backgroundOnly"]==true&&background_text::blocked(pid(&selected.0)){return Err(failure("background_unavailable","unresolved native text input retains this process until confirmed exit, or the 32-process admission cap is full"));}
        Ok(selected)
    }
    fn pointer_input(&mut self,verb:&str,a:&Value)->Value{
        let first_ref=if verb=="drag"{&a["from"]}else{&a["ref"]};
        let element=self.reference_object(first_ref);
        if !first_ref.is_null()&&element.is_none(){return failure("stale_reference","read the target again for a fresh reference");}
        if element.as_ref().is_some_and(|obj|!has_state(obj,8)||!has_state(obj,24)){return failure("permission_denied","target is disabled");}
        let(window,frame)=match self.input_window(a,element.as_ref()){Ok(target)=>target,Err(error)=>return error};
        if verb=="keys"&&std::env::var_os("WAYLAND_DISPLAY").is_some(){
            return match crate::linux_hyprland::keys(a,pid(&window),&name(&window)){Ok(result)=>success(result),Err(error)=>error};
        }
        let coords=|value:&Value|value.as_str().and_then(|value|{let mut parts=value.split(',');Some((parts.next()?.parse::<i32>().ok()?,parts.next()?.parse::<i32>().ok()?))});
        let mut center=|obj:&Object|{let f=self.describe(obj.clone())["frame"].clone();Some((i32::try_from(f["x"].as_i64()?+f["width"].as_i64()?/2).ok()?,i32::try_from(f["y"].as_i64()?+f["height"].as_i64()?/2).ok()?))};
        let start=if verb=="keys"{None}else{coords(if verb=="drag"{&a["fromCoords"]}else{&a["coords"]}).or_else(||element.as_ref().and_then(&mut center)).or_else(||center(&window))};
        let end=if verb=="drag"{
            let second=self.reference_object(&a["to"]);
            if !a["to"].is_null()&&second.is_none(){return failure("stale_reference","drag endpoint reference expired");}
            if let Some(second)=&second{
                if !has_state(second,8)||!has_state(second,24){return failure("permission_denied","drag endpoint is disabled");}
                match self.input_window(a,Some(second)){Ok((other,_))if other.0==window.0=>(),_=>return failure("unsupported_target","drag endpoints require the same selected window")}
            }
            coords(&a["toCoords"]).or_else(||second.as_ref().and_then(|obj|{let f=self.describe(obj.clone())["frame"].clone();Some((i32::try_from(f["x"].as_i64()?+f["width"].as_i64()?/2).ok()?,i32::try_from(f["y"].as_i64()?+f["height"].as_i64()?/2).ok()?))}))
        }else{None};
        let result=if std::env::var_os("WAYLAND_DISPLAY").is_some(){crate::linux_hyprland::pointer_input(verb,a,pid(&window),&name(&window),start,end)}else{crate::linux_x11::input(verb,a,pid(&window),&name(&window),&frame,start,end)};
        match result{Ok(result)=>success(result),Err(error)=>error}
    }
    fn menu(&mut self,a:&Value)->Value{
        let window=match self.input_window(a,None){
            Ok((window,_))=>window,
            // Several windows and no window named: the menu belongs to the one window that has a
            // menu bar (macOS has one menu bar per app, so the CLI names no window there).
            Err(error) if error["code"]=="target_ambiguous"&&a["window"].is_null()&&a["windowTitle"].is_null()=>{
                fn has_menu_bar(obj:&Object,budget:&mut usize)->bool{
                    for child in children(obj,256){
                        if *budget==0{return false;}*budget-=1;
                        if role(&child)=="menu bar"||has_menu_bar(&child,budget){return true;}
                    }false
                }
                let windows=self.applications(a).into_iter().flat_map(|app|children(&app,1024)).filter(|obj|["frame","dialog","window"].contains(&role(obj).as_str())&&has_menu_bar(obj,&mut 512)).collect::<Vec<_>>();
                if windows.len()!=1{return error;}
                windows.into_iter().next().unwrap()
            }
            Err(error)=>return error,
        };
        fn entries(obj:&Object,budget:&mut usize,depth:usize)->Result<Vec<(Object,Value)>,Value>{
            if depth>16{return Err(failure("resource_limit","menu depth exceeds 16"));}
            let mut result=Vec::new();
            for child in children(obj,1024){
                if *budget==0{return Err(failure("resource_limit","menu traversal exceeds 1024 objects"));}*budget-=1;
                let nested=entries(&child,budget,depth+1)?;
                if ["menu","menu item","check menu item","radio menu item"].contains(&role(&child).as_str()){
                    let row=json!({"title":name(&child),"enabled":has_state(&child,8)&&has_state(&child,24),"children":nested.iter().map(|(_,v)|v).collect::<Vec<_>>()});result.push((child,row));
                }else{result.extend(nested);}
            }Ok(result)
        }
        let mut level=match entries(&window,&mut 1024,0){Ok(items)=>items,Err(error)=>return error};
        if a["items"].as_array().is_none_or(|items|items.is_empty()){return success(json!(level.into_iter().map(|(_,v)|v).collect::<Vec<_>>()));}
        let mut path=Vec::new();
        for label in a["items"].as_array().unwrap(){
            let mut matches=level.into_iter().filter(|(_,row)|row["title"]==*label).collect::<Vec<_>>();
            if matches.len()!=1{return failure(if matches.is_empty(){"target_gone"}else{"target_ambiguous"},"menu path must uniquely match each label");}
            let(obj,row)=matches.remove(0);
            if row["enabled"]!=true{return failure("permission_denied","selected menu item is disabled");}
            level=match entries(&obj,&mut 1024,0){Ok(items)=>items,Err(error)=>return error};path.push(obj);
        }
        if path.is_empty(){return failure("invalid_request","menu path is empty");}
        if !level.is_empty(){return failure("unsupported_target","menu path must identify a leaf command");}
        let wayland=std::env::var_os("WAYLAND_DISPLAY").is_some();
        let mut scope=if wayland{match crate::linux_hyprland::MenuScope::open(pid(&window),&name(&window)){Ok(scope)=>Some(scope),Err(error)=>return error}}else{None};
        // GTK's ATK menu action activates the current item of its menu shell.
        // Hidden submenu leaves require their parent shells to be posted first.
        // Preflight the full path above before invoking any item.
        for(index,obj)in path.iter().enumerate(){
            if index>0{
                let deadline=Instant::now()+Duration::from_millis(500);
                while !has_state(obj,25)&&Instant::now()<deadline{
                    unsafe{g_main_context_iteration(ptr::null_mut(),0);}
                    std::thread::sleep(Duration::from_millis(10));
                }
                if !has_state(obj,25){return failure("timeout_unknown_outcome","menu ancestor was invoked but the next item did not become visible; observe before retrying");}
            }
            if let Some(scope)=&mut scope{if let Err(error)=scope.refresh(){return if index==0{error}else{failure("timeout_unknown_outcome","menu popup scope expired after an ancestor was invoked; observe before retrying")};}}
            let reference=self.describe(obj.clone())["ref"].clone();
            let result=self.execute("action",&json!({"ref":reference,"action":"click"}));
            if result["success"]!=true{return if index==0{result}else{failure("timeout_unknown_outcome","menu path changed after an ancestor was invoked; observe before retrying")};}
        }
        success(json!({"method":if wayland{"AT-SPI.Action+Hyprland.menu-scope-v1"}else{"AT-SPI.Action"},"background":true,"invoked":path.len()}))
    }
    fn launch(&mut self,action:&Value)->Value{
        // __argv is set only by `app launch` from a desktop entry's Exec line; `open` takes none.
        use std::os::unix::fs::PermissionsExt;
        let path=std::path::Path::new(action["app"].as_str().unwrap_or(""));
        if !path.is_absolute(){return failure("unsupported_target","new Linux application launch requires an absolute executable path without arguments");}
        let path=match path.canonicalize(){Ok(path)=>path,Err(_)=>return failure("target_gone","requested launch executable is unavailable")};
        if !std::fs::metadata(&path).is_ok_and(|m|m.is_file()&&m.permissions().mode()&0o111!=0){return failure("permission_denied","requested launch target is not an executable file");}
        self.launches.retain(|_,(_,process,_)|process.alive());
        let matching:Vec<_>=self.applications(&json!({})).into_iter().filter(|app|self.launches.get(&pid(app)).is_some_and(|(image,process,_)|*image==path&&process.alive())||std::fs::read_link(format!("/proc/{}/exe",pid(app))).is_ok_and(|image|image==path)).collect();
        if matching.len()>1{return failure("target_ambiguous","more than one running accessible application uses this executable");}
        if let Some(app)=matching.first(){return success(json!({"pid":pid(app),"launched":false}));}
        if self.launches.len()>=64{return failure("resource_limit","64 provider-owned launch processes are already live");}
        let mut command=std::process::Command::new(&path);
        if let Some(argv)=action["__argv"].as_array(){command.args(argv.iter().filter_map(Value::as_str));}
        command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).env_remove("HL_EXEC_RULE_TOKEN");
        let mut scope=None;
        if std::env::var_os("WAYLAND_DISPLAY").is_some() && action["activate"]!=true{
            let stream=match crate::linux_hyprland::clipboard_connection(){Ok(stream)=>stream,Err(error)=>return error};
            let mut client=match interceptor_desktop::linux_pointer::PointerConnection::connect(stream){Ok(client)=>client,Err(error)=>return failure(&error.code,error.message)};
            let mut bytes=[0_u8;32];
            {use std::io::Read;if let Err(error)=std::fs::File::open("/dev/urandom").and_then(|mut file|file.read_exact(&mut bytes)){return failure("provider_failed",error);}}
            let token=bytes.iter().map(|byte|format!("{byte:02x}")).collect::<String>();
            let reply=match client.execute(&format!("launch-guard {token}")){Ok(reply)=>reply,Err(error)=>return failure(&error.code,error.message)};
            if !reply.success{return failure(if reply.code=="input_busy"{"background_unavailable"}else{&reply.code},"compositor refused the background launch scope; no process was started");}
            command.env("HL_EXEC_RULE_TOKEN",token).env_remove("HL_INITIAL_WORKSPACE_TOKEN").env_remove("XDG_ACTIVATION_TOKEN").env_remove("DESKTOP_STARTUP_ID");
            scope=Some((client,Instant::now()));
        }
        let mut child=match command.spawn(){Ok(child)=>child,Err(error)=>return failure("provider_failed",error)};
        let pid=child.id();
        let identity=Process::open(pid).map(Rc::new);
        // Reap only our child without blocking the accessibility worker.
        std::thread::spawn(move||{let _=child.wait();});
        let Some(identity)=identity else{return json!({"success":false,"code":"timeout_unknown_outcome","error":"launch process exited before its identity could be retained; observe before retrying","retryable":false,"details":{"dispatched":true,"pid":pid,"verified":false}});};
        self.launches.insert(pid,(path,identity.clone(),scope));
        self.processes.insert(pid,identity);
        success(json!({"pid":pid,"launched":true}))
    }
    fn describe(&mut self, obj: Object) -> Value {
        self.describe_fields(obj,true,false)
    }
    fn describe_fields(&mut self,obj:Object,read_value:bool,recording:bool)->Value{
        if capture_identity(pid(&obj)).is_err(){return failure("permission_denied","accessibility target requires the same user and login session");}
        let native_role = role(&obj); let secure = native_role == "password text";
        let role = match native_role.as_str() {
            "push button" | "button" => "AXButton", "text" | "entry" | "password text" => "AXTextField",
            "label" => "AXStaticText", "frame" | "dialog" | "window" => "AXWindow", "check box" => "AXCheckBox",
            "combo box" => "AXPopUpButton", "menu" | "popup menu" => "AXMenu", "menu bar" => "AXMenuBar",
            "menu item" => "AXMenuItem", "list" => "AXList", "list item" | "table row" => "AXRow", "table" => "AXTable",
            "scroll bar" => "AXScrollBar", "slider" => "AXSlider", "link" => "AXLink", "image" => "AXImage",
            "tree" => "AXOutline", "radio button" => "AXRadioButton", "panel" | "filler" | "application" => "AXGroup",
            _ => "AXUnknown",
        };
        let frame = self.screen_frame(&obj);
        let title = name(&obj); let value = if read_value{value(&obj, secure)}else{String::new()}; let process = pid(&obj);
        let reference=if recording{String::new()}else{
            if self.refs.len() >= 20000 { self.refs.clear(); self.processes.clear(); }
            let identity = self.processes.get(&process).filter(|p| p.alive()).cloned().or_else(|| {
                let identity = Rc::new(Process::open(process)?); self.processes.insert(process, identity.clone()); Some(identity)
            });
            self.serial = self.serial.checked_add(1).expect("native reference counter exhausted"); let reference = crate::accessibility::reference(self.serial);
            if let Some(identity) = identity { self.refs.insert(reference.clone(), (obj, Instant::now(), identity)); }reference
        };
        json!({"ref":reference,"role":if recording{role.to_owned()}else{crate::accessibility::display_role(role)},"nativeRole":native_role,"name":title,"title":title,"value":value,"pid":process,"secure":secure,"frame":frame})
    }
    fn app_command(&mut self, a: &Value) -> Value {
        let sub = a["subcommand"].as_str().unwrap_or("activate");
        if sub == "launch" {
            // The Linux meaning of a bundle id is the XDG desktop-file id (org.gnome.Calculator).
            let Some(id) = a["bundleId"].as_str().filter(|s| !s.trim().is_empty() && s.len() <= 1024 && !s.contains('\0')) else { return failure("invalid_request", "app launch requires an app id"); };
            let (program, argv) = match desktop_entry(id) { Ok(entry) => entry, Err(error) => return error };
            let mut result = self.launch(&json!({"type":"desktop_open","app":program,"__argv":argv}));
            if result["success"] == true { let d = &mut result["data"]; d["subcommand"] = json!("launch"); d["method"] = json!("exec/background-scope"); d["appId"] = json!(id); d["path"] = json!(program); }
            return result;
        }
        if !matches!(sub, "activate" | "hide" | "unhide" | "quit") {
            return failure("invalid_request", format!("unsupported app subcommand: {}", sub.chars().take(64).collect::<String>()));
        }
        if a["app"].as_str().is_none_or(str::is_empty) && a["pid"].as_u64().is_none() {
            return failure("invalid_request", "app requires --app or --pid");
        }
        let mut pids: Vec<u32> = Vec::new();
        for app in self.applications(a) { let p = pid(&app); if !pids.contains(&p) { pids.push(p); } }
        // A pid target can name a non-AT-SPI process that still owns X11 windows.
        if let Some(p) = a["pid"].as_u64() { let p = p as u32; if !pids.contains(&p) { pids.push(p); } }
        if pids.is_empty() { return failure("unsupported_target", "no accessible application matches the request"); }
        if pids.len() > 1 { return failure("target_ambiguous", "more than one application matches; pass --pid to disambiguate"); }
        let result=if std::env::var_os("WAYLAND_DISPLAY").is_some(){crate::linux_hyprland::app_action(pids[0],sub)}else{crate::linux_x11::app_action(pids[0],sub)};
        match result { Ok(value) => success(value), Err(error) => error }
    }
    fn applications(&self, a: &Value) -> Vec<Object> {
        let Some(desktop) = Object::from(unsafe { atspi_get_desktop(0) }) else { return vec![]; };
        children(&desktop, 4096).into_iter().filter(|app|capture_identity(pid(app)).is_ok()).filter(|app|
            a["pid"].as_u64().is_none_or(|p| p == pid(app) as u64) &&
            a["app"].as_str().is_none_or(|n| n.eq_ignore_ascii_case(&name(app)))).collect()
    }
    fn capture_action(&self,a:&Value)->Result<Value,Value>{
        let mut action=a.clone();
        // Portal capture validates its own selector before asking for consent. It does not
        // require an accessibility application inventory; Hyprland and X11 capture an exact
        // application process, so --app resolves to its pid here.
        if std::env::var_os("WAYLAND_DISPLAY").is_some()&&!crate::capture_linux::hyprland_available(){return Ok(action);}
        if a["app"].is_string()&&a["mode"]!="display"{
            let apps=self.applications(a);
            if apps.len()!=1{return Err(failure(if apps.is_empty(){"unsupported_target"}else{"target_ambiguous"},"capture requires one matching accessible application"));}
            action["_capture_pid"]=json!(pid(&apps[0]));
        }
        Ok(action)
    }
    fn execute(&mut self, verb: &str, a: &Value) -> Value {
        if verb=="authdialog"{return self.authdialog(a);}
        self.screen_frames.clear();
        for(_,process,scope)in self.launches.values_mut(){if scope.as_ref().is_some_and(|(_,at)|at.elapsed()>=Duration::from_secs(10)||!process.alive()){*scope=None;}}
        if ["keys","scroll","drag"].contains(&verb)||(verb=="click"&&(a["coords"].is_string()||a["right"]==true||a["double"]==true)){return self.pointer_input(verb,a);}
        if verb=="menu"{return self.menu(a);}
        if verb=="app"{return self.app_command(a);}
        if verb=="__activate"{return self.app_command(&json!({"type":"desktop_app","subcommand":"activate","pid":a["pid"]}));}
        if ["read","act","inspect_app","open"].contains(&verb){return crate::compound::execute(verb,a,|operation,action|self.execute(operation,action));}
        if verb=="__launch"{return self.launch(a);}
        if verb=="__launch_alive"{
            unsafe{for _ in 0..64{if g_main_context_iteration(ptr::null_mut(),0)==0{break;}}}
            return success(json!(a["pid"].as_u64().is_some_and(|pid|self.launches.get(&(pid as u32)).is_some_and(|(_,process,_)|process.alive()))));
        }
        if ["display_list","display_info"].contains(&verb){return crate::display::execute(verb,a);}
        if verb=="stream"{
            let action=if a["op"]=="start"{match self.capture_action(a){Ok(action)=>action,Err(error)=>return error}}else{a.clone()};
            return crate::stream::execute(&action,|operation,action|self.execute(operation,action));
        }
        if ["screenshot","capture"].contains(&verb){
            let action=if verb=="screenshot"||a["sub"]=="start"{match self.capture_action(a){Ok(action)=>action,Err(error)=>return error}}else{a.clone()};
            return crate::capture::execute(verb,&action);
        }
        if verb == "clipboard" || verb == "__clipboard_snapshot" { return crate::clipboard_linux::execute(verb,a); }
        if verb=="type"&&a["ref"].is_null(){
            let(window,_)=match self.input_window(a,None){Ok(target)=>target,Err(error)=>return error};
            let deadline=Instant::now()+Duration::from_secs(2);let mut stack=vec![window];let mut focused=Vec::new();let mut editable=Vec::new();let mut visited=0;
            while let Some(obj)=stack.pop(){
                if visited>=2000||Instant::now()>=deadline{return failure("resource_limit","focused text target exceeded its bounded window traversal");}visited+=1;
                if has_state(&obj,12)&&has_state(&obj,7){focused.push(obj.clone());if focused.len()>1{return failure("target_ambiguous","selected window has multiple focused editable controls");}}
                // AtspiStateType EDITABLE=7, ENABLED=8, SENSITIVE=24. GTK reports FOCUSED only in the
                // active window, so an inactive window falls back to its one editable text field.
                if has_state(&obj,7)&&has_state(&obj,8)&&has_state(&obj,24)&&role(&obj)!="password text"{editable.push(obj.clone());}
                stack.extend(children(&obj,2000-visited));
            }
            let obj=match (focused.pop(),editable.len()){
                (Some(obj),_)=>obj,
                (None,1)=>editable.pop().unwrap(),
                (None,0)=>return failure("unsupported_target","selected window exposes no editable text control"),
                (None,_)=>return failure("target_ambiguous","the window is not focused and has several editable text fields; pass an element ref"),
            };
            let mut child=a.clone();child["ref"]=self.describe(obj)["ref"].clone();return self.execute("type",&child);
        }
        if ["inspect", "value", "text", "click", "type", "action", "resize", "move"].contains(&verb) {
            let Some(obj) = a["ref"].as_str().and_then(|r| self.refs.get(r))
                .filter(|(o, at, process)| at.elapsed() < Duration::from_secs(300) && process.same_login() && pid(o) == process.pid && !has_state(o, 6))
                .map(|(o, _, _)| o.clone()) else {
                    return failure("stale_reference", "read the target again for a fresh reference");
                };
            if !a["window"].is_null()||a["windowTitle"].is_string()||a["windowBounds"].is_object(){if let Err(error)=self.input_window(a,Some(&obj)){return error;}}
            if a["pid"].as_u64().is_some_and(|p| p != pid(&obj) as u64) { return failure("unsupported_target", "reference belongs to a different target process"); }
            if a["app"].is_string() && !self.applications(a).iter().any(|app| pid(app) == pid(&obj)) { return failure("unsupported_target", "reference belongs to a different target application"); }
            let process=self.refs.get(a["ref"].as_str().unwrap()).map(|(_,_,process)|process.clone()).unwrap();
            if verb == "inspect" {
                let mut data=self.describe(obj.clone());
                if let Ok(identity)=process.secret_identity(){
                    if let Some(name)=a["secretBindingName"].as_str(){
                        if !has_state(&obj,7)||!has_state(&obj,8)||!has_state(&obj,24)||Object::from(unsafe{atspi_accessible_get_editable_text_iface(obj.0)}).is_none(){return failure("permission_denied","native credential target requires an enabled editable background text control");}
                        let reference=a["ref"].as_str().unwrap();
                        let token=if let Some(token)=a["secretLease"].as_str(){if !self.grants.check(name,reference,token,&identity){return failure("permission_denied","native credential grant is unavailable, expired or changed");}token.to_owned()}
                            else{match self.grants.bind(name,reference,identity.clone()){Ok(token)=>token,Err(_)=>return failure("resource_limit","native credential grant could not be issued")}};
                        data["secretLease"]=json!(token);
                    }
                    data["targetIdentity"]=identity;
                }else if a.get("secretBindingName").is_some(){return failure("permission_denied","native credential target identity is unavailable");}
                return success(data);
            }
            if a.get("expectedIdentity").is_some()&&!process.secret_identity().is_ok_and(|identity|crate::secret_target::matches(&a["expectedIdentity"],&identity)){
                return failure("stale_reference","native secret target changed before delivery");
            }
            if verb == "text" && (a["mode"] == "selection" || a["mode"] == "visible") {
                let result = if a["mode"] == "visible" { visible_text(&obj) } else { selected_text(&obj) };
                if !a["ref"].as_str().and_then(|r| self.refs.get(r)).is_some_and(|(_, _, process)| process.alive() && pid(&obj) == process.pid && !has_state(&obj, 6)) {
                    return failure("stale_reference", "target identity changed during native text read");
                }
                return result;
            }
            if verb == "text" || (verb == "value" && a["value"].is_null()) { return success(json!(value(&obj, role(&obj) == "password text"))); }
            // AtspiStateType: EDITABLE=7, ENABLED=8, SENSITIVE=24.
            // EditableText/Action can accept calls even for noninteractive widgets.
            if !has_state(&obj, 8) || !has_state(&obj, 24) { return failure("permission_denied", "target is disabled"); }
            if verb == "resize" || verb == "move" {
                if !["frame", "dialog", "window"].contains(&role(&obj).as_str()) || has_state(&obj, 15) {
                    return failure("unsupported_target", "geometry requires a restored top-level window ref");
                }
                // Wayland has no client-side geometry; Hyprland moves and resizes through its IPC.
                if std::env::var_os("WAYLAND_DISPLAY").is_some() {
                    return match crate::linux_hyprland::geometry(verb, a, pid(&obj), &name(&obj)) {
                        Ok(frame) => success(crate::accessibility::geometry_response(frame, verb, a)),
                        Err(error) => error,
                    };
                }
                let before = self.describe(obj.clone())["frame"].clone();
                if !before.is_object() { return failure("unsupported_target", "target has no readable window frame"); }
                let fields = if verb == "resize" { ["width", "height"] } else { ["x", "y"] };
                if fields.iter().all(|key| before[*key] == a[*key]) {
                    return success(crate::accessibility::geometry_response(before, verb, a));
                }
                if let Err(error) = crate::linux_x11::deliver(verb, a, pid(&obj), &name(&obj), &before) { return error; }
                let deadline = Instant::now() + Duration::from_millis(750);
                let mut previous = before; let mut changed = false; let mut stable = 0;
                while Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(25));
                    if !a["ref"].as_str().and_then(|r| self.refs.get(r)).is_some_and(|(_, _, process)| process.alive() && pid(&obj) == process.pid) {
                        return failure("timeout_unknown_outcome", "window identity changed after geometry delivery; observe before retrying");
                    }
                    // A geometry mutation must observe the WM again. The
                    // traversal cache describes the pre-delivery frame.
                    self.screen_frames.clear();
                    let frame = self.describe(obj.clone())["frame"].clone();
                    if !frame.is_object() { return failure("timeout_unknown_outcome", "window frame is unavailable after geometry delivery"); }
                    changed |= frame != previous;
                    stable = if frame == previous { stable + 1 } else { 0 };
                    if fields.iter().all(|key| frame[*key] == a[*key]) || (changed && stable >= 4) {
                        return success(crate::accessibility::geometry_response(frame, verb, a));
                    }
                    previous = frame;
                }
                return failure("timeout_unknown_outcome", "geometry delivery was not observed before its deadline; observe before retrying");
            }
            if verb == "type" || verb == "value" {
                // The browser text path needs the field focused (FOCUSED=12); an unfocused native field
                // takes the EditableText path below, which needs no focus.
                if verb=="type"&&a["backgroundOnly"]==true&&has_state(&obj,12)&&a["windowTitle"].is_string()&&a["windowBounds"].is_object()&&a.get("expectedIdentity").is_none()&&a.get("secretBindingName").is_none()&&a.get("secretLease").is_none(){
                    return background_text::insert(a,&obj,process.clone(),||self.input_window(a,Some(&obj)).is_ok());
                }
                if !has_state(&obj, 7) {
                    // A check box, button or combo box is not read-only, it has no text value.
                    if !matches!(role(&obj).as_str(), "text" | "entry" | "password text" | "paragraph" | "terminal" | "document text" | "spin button" | "label" | "static") { return failure("unsupported_target", "this control has no text value; use action or act to press, toggle or select it; nothing was changed"); }
                    return failure("permission_denied", "target is read-only");
                }
                let Some(new_value) = (if verb == "type" { &a["text"] } else { &a["value"] }).as_str() else { return failure("invalid_request", "text must be a string"); };
                let Ok(text) = CString::new(new_value) else { return failure("invalid_request", "embedded NUL is not supported by AT-SPI text"); };
                unsafe {
                    let Some(edit) = Object::from(atspi_accessible_get_editable_text_iface(obj.0)) else { return failure("unsupported_target", "target has no EditableText interface"); };
                    if a.get("expectedIdentity").is_some()&&!process.secret_identity().is_ok_and(|identity|crate::secret_target::matches(&a["expectedIdentity"],&identity)){
                        return failure("stale_reference","native secret target changed immediately before delivery");
                    }
                    if let Some(deadline)=self.auth_deadline{
                        if let Err(error)=crate::authdialog::check_deadline(deadline){return error;}
                        match process.secret_identity(){Ok(identity)=>if let Err(error)=crate::authdialog::trusted_agent(&identity,deadline){return error;},Err(error)=>return error}
                        match Self::auth_role(&obj,deadline){Ok(AuthRole::Password)=>(),Ok(_)=>return failure("target_gone","authentication control is no longer a secure password field"),Err(error)=>return error}
                        if !matches!((&self.auth_window,top_level(&obj)),(Some(expected),Some(current))if expected.0==current.0){return failure("target_gone","authentication field no longer belongs to its retained window");}
                        if let Err(error)=crate::authdialog::check_deadline(deadline){return error;}
                    }
                    if a.get("expectedIdentity").is_some()&&!self.grants.consume(a["secretBindingName"].as_str().unwrap(),a["ref"].as_str().unwrap(),a["secretLease"].as_str().unwrap(),&a["expectedIdentity"]){return failure("permission_denied","native credential grant was consumed, expired or changed");}
                    if atspi_editable_text_set_text_contents(edit.0, text.as_ptr(), ptr::null_mut()) == 0 { return failure("unsupported_target", "EditableText rejected the update"); }
                }
                return success(json!({"method":"AT-SPI.EditableText","background":true}));
            }
            unsafe {
                if a["double"].as_bool() == Some(true) || a["right"].as_bool() == Some(true) || !a["coords"].is_null() {
                    return failure("unsupported_operation", "coordinate, right and double clicks require a separately qualified input path");
                }
                let Some(action) = Object::from(atspi_accessible_get_action_iface(obj.0)) else { return failure("unsupported_target", "target has no Action interface"); };
                let requested = a["action"].as_str().unwrap_or("click");
                for i in 0..atspi_action_get_n_actions(action.0, ptr::null_mut()).clamp(0, 128) {
                    let action_name = string(atspi_action_get_action_name(action.0, i, ptr::null_mut()));
                    if action_name == requested || (["press", "AXPress", "invoke"].contains(&requested) && action_name == "click") {
                        if atspi_action_do_action(action.0, i, ptr::null_mut()) == 0 { return failure("unsupported_target", "Action rejected the request"); }
                        return success(json!({"method":"AT-SPI.Action","background":true}));
                    }
                }
            }
            return failure("unsupported_target", "requested action is not exposed by the target");
        }
        if !["apps", "windows", "frontmost", "focused", "tree", "find"].contains(&verb) {
            return failure("unsupported_operation", format!("Linux operation {verb} has not passed parity qualification"));
        }
        // --window <id>: the native id `windows` reports (Hyprland address on Wayland, X11 window id).
        let window_root = match a["window"].as_u64() {
            None if a["window"].is_null() => None,
            None => return failure("invalid_request", "window must be a native window id"),
            Some(_) if !["tree", "find", "focused"].contains(&verb) => return failure("unsupported_target", "window targeting applies to tree, find and focused"),
            Some(id) => {
                let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
                let windows = self.applications(a).into_iter().flat_map(|app| children(&app, 1024)).filter(|w| ["frame", "dialog", "window"].contains(&role(w).as_str())).collect::<Vec<_>>();
                let mut found = None;
                for w in windows {
                    let native = if wayland { crate::linux_hyprland::window_info(pid(&w), &name(&w)).ok().map(|(id, _)| id) }
                        else { let frame = self.describe(w.clone())["frame"].clone(); crate::linux_x11::window_id(pid(&w), &name(&w), &frame).ok() };
                    if native == Some(id) { found = Some(w); break; }
                }
                match found { Some(w) => Some(w), None => return failure("target_gone", "no accessible top-level window has that native id") }
            }
        };
        let apps = self.applications(a);
        // An explicit target that matches nothing is a refusal, as on macOS, not an empty read.
        let compositor_app = verb == "windows" && std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() && a["app"].as_str().is_some_and(|app| crate::linux_hyprland::visible_windows().unwrap_or_default().iter()
            .any(|(_, owner, _, class, _)| app.eq_ignore_ascii_case(class) || std::fs::read_to_string(format!("/proc/{owner}/comm")).is_ok_and(|comm| app.eq_ignore_ascii_case(comm.trim()))));
        if apps.is_empty() && window_root.is_none() && !compositor_app && ["tree", "find", "focused", "windows"].contains(&verb) && (a["pid"].is_u64() || a["app"].is_string()) {
            if let Some(code) = missing_target_code(a["pid"].as_u64(), |p| std::path::Path::new(&format!("/proc/{p}")).exists(), verb) { return failure(code, if code == "target_gone" { "no target app found" } else { "the process exposes no accessibility tree" }); }
        }
        // One row per process, as on macOS and Windows: a toolkit can register a process with
        // AT-SPI twice (a Qt shell after accessibility is switched on), and two rows for one pid
        // made compound reads ambiguous and their app snapshot invalid.
        if verb == "apps" { return success(json!(unique_apps(&apps).map(|app| json!({"name":name(app),"pid":pid(app)})).collect::<Vec<_>>())); }
        if verb=="frontmost" && std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some(){
            // Background input can leave a toolkit's ACTIVE flag stale even
            // when the compositor retains another window's keyboard focus.
            let active=match crate::linux_hyprland::active_window(){Ok(Some(active))=>active,Ok(None)=>return success(Value::Null),Err(error)=>return error};
            let mut matches=apps.iter().flat_map(|app|children(app,1024))
                .filter(|window|pid(window)==active.pid && name(window)==active.title);
            // No accessibility window (Chromium and others expose none by default): still report the
            // compositor's frontmost app, as macOS does, with the reason there is no ref.
            let Some(window)=matches.next() else{
                let name=std::fs::read_to_string(format!("/proc/{}/comm",active.pid)).map(|s|s.trim().to_owned()).unwrap_or_default();
                return success(json!({"windowId":active.id.to_string(),"title":active.title,"pid":active.pid,"name":name,"frame":active.frame,
                    "refUnavailable":failure("unsupported_target","the frontmost window exposes no accessibility tree, so it has no ref")}));
            };
            if matches.next().is_some(){return failure("target_ambiguous","active compositor window has multiple matching accessibility windows");}
            let mut data=self.describe(window);
            data["windowId"]=json!(active.id.to_string());data["frame"]=active.frame;
            return success(data);
        }
        if verb == "windows" || verb == "frontmost" {
            let windows = apps.iter().flat_map(|app| children(app, 1024)).filter(|w| verb != "frontmost" || has_state(w, 1)).collect::<Vec<_>>();
            let mut data: Vec<_> = windows.into_iter().map(|w| {
                let mut data=self.describe(w);
                let target_pid=data["pid"].as_u64().unwrap_or(0)as u32;
                let title=data["title"].as_str().unwrap_or("");
                if std::env::var_os("WAYLAND_DISPLAY").is_some(){
                    match crate::linux_hyprland::window_info(target_pid,title){
                        Ok((id,frame))=>{data["windowId"]=json!(id.to_string());data["frame"]=frame;},
                        Err(error)=>data["windowIdUnavailable"]=error,
                    }
                }else{
                    match crate::linux_x11::window_id(target_pid,title,&data["frame"]){
                        Ok(id)=>data["windowId"]=json!(id.to_string()),
                        Err(error)=>data["windowIdUnavailable"]=error,
                    }
                }
                data
            }).collect();
            // A visible window without an accessibility tree (Chromium, foot) is still a window: list it as
            // frontmost reports it, without a ref. Hyprland only; X11 keeps the AX list.
            if verb == "windows" && std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
                let listed: std::collections::HashSet<String> = data.iter().filter_map(|d| d["windowId"].as_str().map(str::to_owned)).collect();
                for (id, owner, title, class, frame) in crate::linux_hyprland::visible_windows().unwrap_or_default() {
                    let comm = std::fs::read_to_string(format!("/proc/{owner}/comm")).map(|s| s.trim().to_owned()).unwrap_or_default();
                    if listed.contains(&id.to_string()) || a["pid"].as_u64().is_some_and(|p| p != owner as u64) || a["app"].as_str().is_some_and(|app| !app.eq_ignore_ascii_case(&comm) && !app.eq_ignore_ascii_case(&class)) { continue; }
                    data.push(json!({"windowId":id.to_string(),"title":title,"pid":owner,"name":comm,"frame":frame,
                        "refUnavailable":failure("unsupported_target","this window exposes no accessibility tree, so it has no ref")}));
                }
            }
            return success(if verb == "frontmost" { data.into_iter().next().unwrap_or(Value::Null) } else { json!(data) });
        }
        // Separate reads must retain both endpoints of a reference drag. The
        // existing size cap, expiry and retained process/login checks bound
        // these references without invalidating them on an unrelated find.
        let limit = a["maxNodes"].as_u64().unwrap_or(2500).clamp(1, 20000) as usize;
        let depth_limit = a["depth"].as_u64().unwrap_or(if verb == "find" { 15 } else { 10 }).clamp(1, 100) as usize;
        let milliseconds = a["maxMs"].as_u64().unwrap_or(5000).clamp(1, 10000);
        let chars = a["maxChars"].as_u64().unwrap_or(50000).clamp(1, 1000000) as usize;
        let mut stack: Vec<_> = match window_root { Some(window) => vec![(window, 1)], None => apps.into_iter().rev().map(|app| (app, 0)).collect() };
        let started = Instant::now(); let mut count = 0; let mut text = String::new(); let mut matches = Vec::new();
        while let Some((obj, depth)) = stack.pop() {
            if count >= limit || started.elapsed().as_millis() >= milliseconds as u128 || text.len() >= chars { text.push_str("… (stopped: traversal budget)\n"); break; }
            if capture_identity(pid(&obj)).is_err(){continue;}
            count += 1;
            if depth + 1 < depth_limit { stack.extend(children(&obj, limit-count).into_iter().rev().map(|child| (child, depth+1))); }
            if verb == "focused" && !has_state(&obj, 12) { continue; }
            let node = self.describe(obj);
            if verb == "focused" { return success(node); }
            if verb == "find" {
                if crate::accessibility::matches(&node, a) { matches.push(node); if matches.len() >= 25 { break; } }
            } else if let Some(line) = crate::accessibility::tree_line(&node, depth, a["filter"].as_str().unwrap_or("interactive")) { text.push_str(&line); }
        }
        success(if verb == "find" { json!(matches) } else if verb == "focused" { Value::Null } else { json!(text) })
    }
}

/// Refusal code for a --pid/--app target with no accessible application: gone when the process
/// does not exist or the name matches nothing; a live process without AT-SPI has no tree to read,
/// though `windows` still answers [] for it (its windows can exist without accessibility).
fn missing_target_code(pid: Option<u64>, exists: impl Fn(u64) -> bool, verb: &str) -> Option<&'static str> {
    match pid {
        Some(p) if exists(p) => (verb != "windows").then_some("unsupported_target"),
        _ => Some("target_gone"),
    }
}

/// The first item for each process, in their original order.
fn first_per_pid<'a, T>(items: &'a [T], pid_of: impl Fn(&T) -> u32) -> impl Iterator<Item = &'a T> {
    let mut seen = std::collections::HashSet::new();
    items.iter().filter(move |item| seen.insert(pid_of(item)))
}
fn unique_apps(apps: &[Object]) -> impl Iterator<Item = &Object> { first_per_pid(apps, pid) }

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn a_process_registered_twice_is_listed_once() {
        let rows = [(660, "quickshell"), (876, "portal"), (660, "quickshell"), (658, "udiskie")];
        let kept: Vec<_> = first_per_pid(&rows, |row| row.0).collect();
        assert_eq!(kept, vec![&(660, "quickshell"), &(876, "portal"), &(658, "udiskie")]);
    }
    #[test] fn missing_targets_refuse_like_macos() {
        assert_eq!(missing_target_code(Some(987654), |_| false, "tree"), Some("target_gone"));
        assert_eq!(missing_target_code(None, |_| true, "find"), Some("target_gone"));
        assert_eq!(missing_target_code(Some(42), |_| true, "focused"), Some("unsupported_target"));
        assert_eq!(missing_target_code(Some(42), |_| true, "windows"), None);
    }
    // G_DEBUG=fatal-criticals makes an accidental g_object_unref(NULL) fail.
    #[test] fn null_interfaces_have_no_object_to_release() {
        assert!(Object::from(ptr::null_mut()).is_none());
    }
    #[test] fn retained_process_identity_rejects_exit() {
        assert!(Process::open(0).is_none());
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let identity = Process::open(child.id());
        let was_alive = identity.as_ref().is_some_and(Process::alive);
        child.kill().unwrap(); child.wait().unwrap();
        assert!(was_alive);
        assert!(!identity.unwrap().alive());
    }
}

/// Resolves an XDG desktop-file id to its program and arguments (Desktop Entry spec: Exec field
/// codes are dropped, quoted arguments kept). Hidden or non-application entries are not launchable.
fn desktop_entry(id: &str) -> Result<(String, Vec<String>), Value> {
    let file = if id.ends_with(".desktop") { id.to_owned() } else { format!("{id}.desktop") };
    if file.contains('/') || file.starts_with('.') { return Err(failure("invalid_request", "app id must be a desktop-file id, not a path")); }
    let home = std::env::var("HOME").unwrap_or_default();
    let data_home = std::env::var("XDG_DATA_HOME").ok().filter(|s| !s.is_empty()).unwrap_or(format!("{home}/.local/share"));
    let data_dirs = std::env::var("XDG_DATA_DIRS").ok().filter(|s| !s.is_empty()).unwrap_or("/usr/local/share:/usr/share".into());
    let roots: Vec<String> = std::iter::once(data_home).chain(data_dirs.split(':').map(str::to_owned)).map(|d| format!("{d}/applications")).collect();
    // A dash in the id can stand for a subfolder (kde4-foo.desktop is kde4/foo.desktop).
    let candidates: Vec<std::path::PathBuf> = roots.iter().flat_map(|root| std::iter::once(std::path::Path::new(root).join(&file)).chain(file.split_once('-').map(|(dir, rest)| std::path::Path::new(root).join(dir).join(rest)))).collect();
    let path = candidates.into_iter().find(|p| p.is_file()).ok_or_else(|| failure("target_gone", format!("no installed desktop entry uses the app id {id}")))?;
    let text = std::fs::read_to_string(&path).map_err(|e| failure("provider_failed", format!("desktop entry is unreadable: {e}")))?;
    let mut section = false; let mut fields = std::collections::HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') { section = line == "[Desktop Entry]"; continue; }
        if section { if let Some((k, v)) = line.split_once('=') { fields.entry(k.trim().to_owned()).or_insert_with(|| v.trim().to_owned()); } }
    }
    if fields.get("Type").map(String::as_str) != Some("Application") || fields.get("Hidden").is_some_and(|v| v == "true") { return Err(failure("unsupported_target", format!("desktop entry {id} is not a launchable application"))); }
    let argv = exec_argv(fields.get("Exec").map(String::as_str).unwrap_or("")).ok_or_else(|| failure("unsupported_target", format!("desktop entry {id} has no usable Exec line")))?;
    let program = if argv[0].starts_with('/') { argv[0].clone() } else {
        std::env::var("PATH").unwrap_or("/usr/local/bin:/usr/bin".into()).split(':').map(|d| std::path::Path::new(d).join(&argv[0])).find(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned())
            .ok_or_else(|| failure("target_gone", format!("desktop entry {id} runs {}, which is not installed", argv[0])))?
    };
    Ok((program, argv[1..].to_vec()))
}
fn exec_argv(exec: &str) -> Option<Vec<String>> {
    let mut argv = vec![]; let mut current = String::new(); let mut quoted = false; let mut started = false; let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => { quoted = !quoted; started = true; }
            '\\' if quoted => { if let Some(n) = chars.next() { current.push(n); } }
            '%' => match chars.next() { Some('%') => { current.push('%'); started = true; } Some(_) | None => {} },
            c if c.is_whitespace() && !quoted => { if started || !current.is_empty() { argv.push(std::mem::take(&mut current)); started = false; } }
            c => { current.push(c); started = true; }
        }
    }
    if started || !current.is_empty() { argv.push(current); }
    argv.retain(|a| !a.is_empty());
    (!argv.is_empty()).then_some(argv)
}
#[cfg(test)] mod desktop_entry_tests {
    #[test] fn exec_lines_drop_field_codes_and_keep_quoted_arguments() {
        assert_eq!(super::exec_argv("gnome-calculator").unwrap(), vec!["gnome-calculator"]);
        assert_eq!(super::exec_argv("/usr/bin/chromium %U").unwrap(), vec!["/usr/bin/chromium"]);
        assert_eq!(super::exec_argv("env FOO=1 \"/opt/My App/run\" --flag %f 100%%").unwrap(), vec!["env", "FOO=1", "/opt/My App/run", "--flag", "100%"]);
        assert!(super::exec_argv("  %u ").is_none());
    }
}
