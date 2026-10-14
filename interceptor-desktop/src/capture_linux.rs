use crate::failure;
use image::RgbaImage;
use serde_json::Value;
#[path = "capture_wayland.rs"]
mod wayland;
#[path = "capture_hyprland.rs"]
mod hyprland;
enum Backend {
    X11(crate::linux_x11::CaptureSession),
    Wayland(wayland::Source),
    Hyprland(hyprland::Source),
}
/// Hyprland captures exact windows and displays without the portal picker.
pub(crate) fn hyprland_available() -> bool { std::env::var_os("WAYLAND_DISPLAY").is_some() && hyprland::Source::available() }
pub struct Source {
    session: Backend,
    identity: Option<crate::linux::CaptureIdentity>,
    pid: Option<u32>,
    window: u64,
}
impl Source {
    pub(crate) fn owner(&self) -> Option<u32> {
        self.pid
    }
    pub(crate) fn window_id(&self) -> Option<u64> {
        self.pid.map(|_| self.window)
    }
    pub fn open(action: &Value, continuous: bool) -> Result<Self, Value> {
        if hyprland_available() {
            let source = hyprland::Source::open(action, continuous)?;
            let (pid, window) = (source.owner(), source.window_id().unwrap_or(0));
            let identity = pid.map(crate::linux::capture_identity).transpose()?;
            return Ok(Self { session: Backend::Hyprland(source), identity, pid, window });
        }
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            return wayland::Source::open(action, continuous).map(|source| Self {
                session: Backend::Wayland(source),
                identity: None,
                pid: None,
                window: 0,
            });
        }
        let (window, pid, monitor) = crate::linux_x11::capture_target(action, continuous)?;
        let identity = pid.map(crate::linux::capture_identity).transpose()?;
        let session = crate::linux_x11::CaptureSession::open(window, pid, monitor)?;
        Ok(Self {
            session: Backend::X11(session),
            identity,
            pid,
            window,
        })
    }
    pub fn next_frame(&mut self) -> Result<Option<RgbaImage>, Value> {
        if self.identity.as_ref().is_some_and(|p| !p.alive()) {
            return Err(failure("target_gone", "capture target process has exited"));
        }
        match &mut self.session {
            Backend::X11(session) => {
                if !session.ready() {
                    return Ok(None);
                }
                crate::linux_x11::capture_pixels(session).map(Some)
            }
            Backend::Wayland(session) => session.next_frame(),
            Backend::Hyprland(session) => session.next_frame(),
        }
    }
}
