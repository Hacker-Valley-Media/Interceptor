//! Hyprland frame capture without the portal picker. A window is copied through
//! hyprland-toplevel-export (no decorations, works while covered or on another workspace);
//! a display through wlr-screencopy. Frames land in a shared-memory buffer this client owns.
//! Selection mirrors the X11 backend: --mode display / --display, an exact --window, the
//! authenticated application process, or the active window.
use crate::failure;
use image::RgbaImage;
use serde_json::Value;
use std::{fs::File, io::{Read, Seek, SeekFrom}, os::fd::{AsFd, FromRawFd, OwnedFd}, time::{Duration, Instant}};
use wayland_client::{Connection, Dispatch, EventQueue, QueueHandle, WEnum, protocol::{wl_buffer, wl_callback, wl_output, wl_registry, wl_shm, wl_shm_pool}};
use wayland_protocols_wlr::screencopy::v1::client::{zwlr_screencopy_frame_v1 as screen_frame, zwlr_screencopy_manager_v1 as screen_manager};

#[allow(non_camel_case_types, non_upper_case_globals, non_snake_case, unused_imports, dead_code)]
pub mod protocol {
    use wayland_client;
    use wayland_client::protocol::*;
    pub mod __interfaces {
        use wayland_client::backend as wayland_backend;
        use wayland_client::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("hyprland/hyprland-toplevel-export-v1.xml");
    }
    use self::__interfaces::*;
    wayland_scanner::generate_client_code!("hyprland/hyprland-toplevel-export-v1.xml");
}
use protocol::{hyprland_toplevel_export_frame_v1 as window_frame, hyprland_toplevel_export_manager_v1 as window_manager};

const MAX_PIXELS: u64 = 32 * 1024 * 1024;

#[derive(Default)]
struct State {
    shm: Option<wl_shm::WlShm>,
    screen: Option<screen_manager::ZwlrScreencopyManagerV1>,
    window: Option<window_manager::HyprlandToplevelExportManagerV1>,
    screen_version: u32,
    outputs: Vec<(u32, wl_output::WlOutput)>,
    synced: bool,
    /// (format, width, height, stride) offered by the compositor.
    buffer: Option<(u32, u32, u32, u32)>,
    buffer_done: bool,
    y_invert: bool,
    ready: bool,
    failed: bool,
}

pub(super) enum Target { Window { address: u64, pid: u32 }, Display { registry_name: u32 } }

pub(super) struct Source {
    connection: Connection,
    queue: EventQueue<State>,
    state: State,
    target: Target,
    identity: Option<crate::linux::CaptureIdentity>,
}

impl Source {
    pub(super) fn available() -> bool { crate::linux_hyprland::available() }

    pub(super) fn open(action: &Value, continuous: bool) -> Result<Self, Value> {
        let target = select(action, continuous)?;
        let identity = match &target { Target::Window { pid, .. } => Some(crate::linux::capture_identity(*pid)?), Target::Display { .. } => None };
        let (stream, _pid, _owner) = crate::display_wayland::compositor_socket()?;
        let connection = Connection::from_socket(stream).map_err(|e| failure("provider_failed", e))?;
        let queue = connection.new_event_queue::<State>();
        let mut source = Self { connection, queue, state: State::default(), target, identity };
        source.connection.display().get_registry(&source.queue.handle(), ());
        source.sync()?;
        if source.state.shm.is_none() { return Err(failure("unsupported_operation", "compositor exposes no wl_shm")); }
        match &source.target {
            Target::Window { .. } if source.state.window.is_none() => return Err(failure("unsupported_operation", "compositor does not expose hyprland-toplevel-export")),
            Target::Display { .. } if source.state.screen.is_none() => return Err(failure("unsupported_operation", "compositor does not expose wlr-screencopy")),
            _ => {}
        }
        Ok(source)
    }

    pub(super) fn owner(&self) -> Option<u32> { match self.target { Target::Window { pid, .. } => Some(pid), _ => None } }
    pub(super) fn window_id(&self) -> Option<u64> { match self.target { Target::Window { address, .. } => Some(address), _ => None } }

    /// One frame per call; the caller paces continuous capture.
    pub(super) fn next_frame(&mut self) -> Result<Option<RgbaImage>, Value> {
        if self.identity.as_ref().is_some_and(|p| !p.alive()) { return Err(failure("target_gone", "capture target process has exited")); }
        let qh = self.queue.handle();
        self.state.buffer = None; self.state.buffer_done = false; self.state.ready = false; self.state.failed = false; self.state.y_invert = false;
        enum Frame { Window(window_frame::HyprlandToplevelExportFrameV1), Screen(screen_frame::ZwlrScreencopyFrameV1) }
        let frame = match &self.target {
            Target::Window { address, .. } => Frame::Window(self.state.window.as_ref().unwrap().capture_toplevel(0, (*address & 0xffff_ffff) as u32, &qh, ())),
            Target::Display { registry_name } => {
                let output = self.state.outputs.iter().find(|(name, _)| name == registry_name).map(|(_, o)| o.clone())
                    .ok_or_else(|| failure("target_gone", "requested display is no longer connected"))?;
                Frame::Screen(self.state.screen.as_ref().unwrap().capture_output(0, &output, &qh, ()))
            }
        };
        let deadline = Instant::now() + Duration::from_secs(8);
        // Screencopy before v3 sends no buffer_done: the first shm offer is enough there.
        let early = matches!(frame, Frame::Screen(_)) && self.state.screen_version < 3;
        self.wait(deadline, |s| s.failed || s.buffer_done || (early && s.buffer.is_some()))?;
        let destroy = |frame: &Frame| match frame { Frame::Window(f) => f.destroy(), Frame::Screen(f) => f.destroy() };
        if self.state.failed { destroy(&frame); return Err(failure("unsupported_target", "compositor refused to copy the target (it may be closed or not mapped)")); }
        let Some((format, width, height, stride)) = self.state.buffer else { destroy(&frame); return Err(failure("unsupported_operation", "compositor offered no shared-memory buffer format")); };
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS || stride < width * 4 {
            destroy(&frame); return Err(failure("resource_limit", "capture exceeds 32 megapixels or reports an invalid buffer"));
        }
        let size = (stride as usize) * (height as usize);
        let fd = unsafe { libc::memfd_create(c"interceptor-capture".as_ptr(), libc::MFD_CLOEXEC) };
        if fd < 0 { destroy(&frame); return Err(failure("provider_failed", "shared-memory capture buffer is unavailable")); }
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        if unsafe { libc::ftruncate(std::os::fd::AsRawFd::as_raw_fd(&fd), size as libc::off_t) } != 0 { destroy(&frame); return Err(failure("provider_failed", "shared-memory capture buffer could not be sized")); }
        let shm = self.state.shm.as_ref().unwrap();
        let pool = shm.create_pool(fd.as_fd(), size as i32, &qh, ());
        let buffer = pool.create_buffer(0, width as i32, height as i32, stride as i32, wl_shm::Format::try_from(format).unwrap_or(wl_shm::Format::Xrgb8888), &qh, ());
        match &frame { Frame::Window(f) => f.copy(&buffer, 1), Frame::Screen(f) => f.copy(&buffer) }
        let copied = self.wait(deadline, |s| s.ready || s.failed);
        destroy(&frame); buffer.destroy(); pool.destroy();
        copied?;
        if !self.state.ready { return Err(failure("unsupported_target", "compositor failed to copy the frame")); }
        let mut bytes = vec![0_u8; size];
        let mut file = File::from(fd);
        file.seek(SeekFrom::Start(0)).and_then(|_| file.read_exact(&mut bytes)).map_err(|e| failure("provider_failed", e))?;
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        // wl_shm formats are little-endian: (A|X)RGB8888 is stored B,G,R,A; (A|X)BGR8888 is R,G,B,A.
        let bgr = matches!(format, 0 | 1);
        let opaque = matches!(format, 1 | 0x34324258);
        for row in 0..height {
            let source_row = if self.state.y_invert { height - 1 - row } else { row };
            let line = &bytes[(source_row * stride) as usize..][..(width * 4) as usize];
            for px in line.chunks_exact(4) {
                let (r, g, b) = if bgr { (px[2], px[1], px[0]) } else { (px[0], px[1], px[2]) };
                rgba.extend_from_slice(&[r, g, b, if opaque { 255 } else { px[3] }]);
            }
        }
        RgbaImage::from_raw(width, height, rgba).map(Some).ok_or_else(|| failure("provider_failed", "captured frame has invalid dimensions"))
    }

    fn sync(&mut self) -> Result<(), Value> {
        self.state.synced = false;
        self.connection.display().sync(&self.queue.handle(), ());
        self.wait(Instant::now() + Duration::from_secs(2), |s| s.synced)
    }
    fn wait(&mut self, deadline: Instant, done: impl Fn(&State) -> bool) -> Result<(), Value> {
        while !done(&self.state) {
            if Instant::now() >= deadline { return Err(failure("provider_failed", "compositor did not deliver the frame within the capture deadline")); }
            interceptor_desktop::wayland_transport::pump(&self.connection, &mut self.queue, &mut self.state, 20, |_| true).map_err(|e| failure(&e.code, e.message))?;
        }
        Ok(())
    }
}

/// Same rules as the X11 backend (linux_x11::capture_target), on Hyprland's own inventory.
fn select(action: &Value, continuous: bool) -> Result<Target, Value> {
    let display = action["mode"] == "display" || (!action["window"].is_number() && !action["app"].is_string() && action["_capture_pid"].is_null() && (action["display"].is_number() || continuous));
    if display {
        let rows = crate::display_wayland::Registry::open()?.records()?;
        let row = match action["display"].as_u64() {
            Some(id) => rows.iter().find(|r| r["id"].as_u64() == Some(id)).ok_or_else(|| failure("unsupported_target", "requested display is not active"))?,
            None => rows.iter().find(|r| r["x"] == 0 && r["y"] == 0).or_else(|| rows.first()).ok_or_else(|| failure("target_gone", "compositor has no displays"))?,
        };
        let registry_name = row["registryName"].as_u64().and_then(|n| u32::try_from(n).ok()).ok_or_else(|| failure("provider_failed", "display has no registry identity"))?;
        return Ok(Target::Display { registry_name });
    }
    let clients = crate::linux_hyprland::clients()?;
    // Callers that did not resolve --app to an authenticated process (vision, sensitive) are
    // matched here by process name or window class, never by "any window".
    let app = action["app"].as_str().filter(|_| action["_capture_pid"].is_null()).map(str::to_ascii_lowercase);
    let comm = |pid: u64| std::fs::read_to_string(format!("/proc/{pid}/comm")).map(|s| s.trim().to_ascii_lowercase()).unwrap_or_default();
    let mut candidates: Vec<&Value> = clients.iter().filter(|c| c["mapped"] == true && c["hidden"] != true
        && app.as_deref().is_none_or(|app| c["pid"].as_u64().is_some_and(|pid| comm(pid) == app)
            || [&c["class"], &c["initialClass"]].iter().any(|v| v.as_str().is_some_and(|s| s.eq_ignore_ascii_case(app))))
        && action["window"].as_u64().is_none_or(|id| crate::linux_hyprland::client_address(c) == Some(id))
        && action["_capture_pid"].as_u64().is_none_or(|pid| c["pid"].as_u64() == Some(pid))
        && action["pid"].as_u64().is_none_or(|pid| c["pid"].as_u64() == Some(pid))).collect();
    if !action["window"].is_number() && !action["app"].is_string() && action["_capture_pid"].is_null() && action["pid"].is_null() {
        let active = crate::linux_hyprland::active_address()?;
        candidates.retain(|c| crate::linux_hyprland::client_address(c) == active);
    } else {
        // As on X11: a stream follows one window, so an app with several is ambiguous.
        if action["type"] == "desktop_stream" && action["app"].is_string() && candidates.len() > 1 {
            return Err(failure("target_ambiguous", "stream application has multiple capturable windows; select one exact window"));
        }
        let area = |c: &&Value| c["size"].as_array().map(|s| s[0].as_i64().unwrap_or(0) * s[1].as_i64().unwrap_or(0)).unwrap_or(0);
        candidates.sort_by_key(|c| -area(c));
    }
    let client = candidates.first().ok_or_else(|| failure("unsupported_target", "requested application or window has no mapped Wayland window"))?;
    let address = crate::linux_hyprland::client_address(client).ok_or_else(|| failure("provider_failed", "compositor window has no address"))?;
    let pid = client["pid"].as_u64().and_then(|p| u32::try_from(p).ok()).filter(|p| *p > 0).ok_or_else(|| failure("provider_failed", "compositor window has no process"))?;
    Ok(Target::Window { address, pid })
}

impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(state: &mut Self, registry: &wl_registry::WlRegistry, event: wl_registry::Event, _: &(), _: &Connection, qh: &QueueHandle<Self>) {
        if let wl_registry::Event::Global { name, interface, version } = event {
            match interface.as_str() {
                "wl_shm" => state.shm = Some(registry.bind(name, 1, qh, ())),
                "zwlr_screencopy_manager_v1" => { state.screen_version = version.min(3); state.screen = Some(registry.bind(name, state.screen_version, qh, ())) }
                "hyprland_toplevel_export_manager_v1" => state.window = Some(registry.bind(name, 1, qh, ())),
                "wl_output" if state.outputs.len() < 32 => state.outputs.push((name, registry.bind(name, version.min(4), qh, ()))),
                _ => {}
            }
        }
    }
}
impl Dispatch<wl_callback::WlCallback, ()> for State {
    fn event(state: &mut Self, _: &wl_callback::WlCallback, event: wl_callback::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        if matches!(event, wl_callback::Event::Done { .. }) { state.synced = true; }
    }
}
impl Dispatch<window_frame::HyprlandToplevelExportFrameV1, ()> for State {
    fn event(state: &mut Self, _: &window_frame::HyprlandToplevelExportFrameV1, event: window_frame::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match event {
            window_frame::Event::Buffer { format, width, height, stride } => {
                let format = match format { WEnum::Value(f) => f as u32, WEnum::Unknown(f) => f };
                if state.buffer.is_none() && matches!(format, 0 | 1 | 0x34324241 | 0x34324258) { state.buffer = Some((format, width, height, stride)); }
            }
            window_frame::Event::BufferDone => state.buffer_done = true,
            window_frame::Event::Flags { flags } => state.y_invert = matches!(flags, WEnum::Value(window_frame::Flags::YInvert)),
            window_frame::Event::Ready { .. } => state.ready = true,
            window_frame::Event::Failed => state.failed = true,
            _ => {}
        }
    }
}
impl Dispatch<screen_frame::ZwlrScreencopyFrameV1, ()> for State {
    fn event(state: &mut Self, _: &screen_frame::ZwlrScreencopyFrameV1, event: screen_frame::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        match event {
            screen_frame::Event::Buffer { format, width, height, stride } => {
                let format = match format { WEnum::Value(f) => f as u32, WEnum::Unknown(f) => f };
                if state.buffer.is_none() && matches!(format, 0 | 1 | 0x34324241 | 0x34324258) { state.buffer = Some((format, width, height, stride)); }
            }
            screen_frame::Event::BufferDone => state.buffer_done = true,
            screen_frame::Event::Flags { flags } => state.y_invert = matches!(flags, WEnum::Value(f) if f.contains(screen_frame::Flags::YInvert)),
            screen_frame::Event::Ready { .. } => state.ready = true,
            screen_frame::Event::Failed => state.failed = true,
            _ => {}
        }
    }
}
macro_rules! ignore { ($($t:ty),*) => { $(impl Dispatch<$t, ()> for State { fn event(_: &mut Self, _: &$t, _: <$t as wayland_client::Proxy>::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {} })* } }
ignore!(wl_shm::WlShm, wl_shm_pool::WlShmPool, wl_buffer::WlBuffer, wl_output::WlOutput, screen_manager::ZwlrScreencopyManagerV1, window_manager::HyprlandToplevelExportManagerV1);
