//! ScreenCast consent owns the selected monitor and its restricted remote.
//! Portal coordinates and node IDs never become app/window input identities.
use crate::{failure, native_bus::*};
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_video::prelude::*;
use image::RgbaImage;
use serde_json::Value;
use std::{
    cell::Cell,
    ffi::{CString, c_char},
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    ptr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const SCREENCAST: &std::ffi::CStr = c"org.freedesktop.portal.ScreenCast";
const MAX_NATIVE_BYTES: usize = 256 * 1024 * 1024;

unsafe extern "C" fn closed(_message: Raw, userdata: Raw, _error: Raw) -> i32 {
    unsafe {
        (&*userdata.cast::<Cell<bool>>()).set(true);
    }
    0
}
struct Session {
    // The native callback registration dies before its userdata and bus.
    _slot: Slot,
    closed: Box<Cell<bool>>,
    connection: PortalConnection,
    handle: CString,
    login: crate::linux_peer::SessionIdentity,
    last_owner_check: Instant,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.connection.close_session(&self.handle);
    }
}
impl Session {
    fn create(deadline: Instant) -> Result<Self, Value> {
        unsafe {
            let login = crate::linux::login_identity(0).ok_or_else(|| {
                failure(
                    "no_interactive_session",
                    "Wayland capture requires the current graphical login",
                )
            })?;
            let connection = PortalConnection::open()?;
            if connection.property(SCREENCAST, c"version")? < 6 {
                return Err(failure(
                    "version_mismatch",
                    "Wayland capture requires ScreenCast version 6 with non-reused PipeWire stream serials; no source was selected",
                ));
            }
            if connection.property(SCREENCAST, c"AvailableSourceTypes")? & 1 == 0 {
                return Err(failure(
                    "unsupported_target",
                    "native portal offers no monitor source",
                ));
            }
            if connection.property(SCREENCAST, c"AvailableCursorModes")? & 1 == 0 {
                return Err(failure(
                    "unsupported_target",
                    "native portal offers no hidden-cursor mode",
                ));
            }
            let token = crate::secret_target::random_token().map_err(|_| {
                failure(
                    "provider_failed",
                    "portal session identity generation failed",
                )
            })?;
            let handle = connection.session_path(&token)?;
            let session_token = CString::new(format!("interceptor_{token}")).unwrap();
            let rule=CString::new(format!("type='signal',sender='{}',interface='org.freedesktop.portal.Session',member='Closed',path='{}'",connection.destination.to_str().unwrap(),handle.to_str().unwrap())).unwrap();
            let mut state = Box::new(Cell::new(false));
            let mut slot = ptr::null_mut();
            portal_check(sd_bus_add_match(
                connection.bus.0,
                &mut slot,
                rule.as_ptr(),
                closed,
                (&mut *state as *mut Cell<bool>).cast(),
            ))?;
            // Own the expected path before dispatch, so even an unknown CreateSession
            // outcome attempts close only that caller/token's session.
            let session = Self {
                _slot: Slot(slot),
                closed: state,
                connection,
                handle,
                login,
                last_owner_check: Instant::now(),
            };
            let reply =
                session
                    .connection
                    .request(SCREENCAST, c"CreateSession", deadline, |message| {
                        portal_check(sd_bus_message_open_container(
                            message,
                            b'a' as c_char,
                            c"{sv}".as_ptr(),
                        ))?;
                        portal_option(message, c"session_handle_token", c"s", |m| {
                            portal_check(sd_bus_message_append(
                                m,
                                c"s".as_ptr(),
                                session_token.as_ptr(),
                            ))
                        })
                    })?;
            let mut observed = None;
            portal_dictionary(reply.0, |key, signature, message| {
                if key != "session_handle" {
                    return Ok(false);
                }
                if signature != c"s" {
                    return Err(failure(
                        "provider_failed",
                        "portal session handle has the wrong native type",
                    ));
                }
                observed = Some(portal_string(message, c"s", 512)?);
                Ok(true)
            })?;
            if observed.as_deref().map(str::as_bytes) != Some(session.handle.to_bytes()) {
                return Err(failure(
                    "version_mismatch",
                    "portal returned another session identity; it was not adopted",
                ));
            }
            session.check()?;
            Ok(session)
        }
    }
    fn check(&self) -> Result<(), Value> {
        if crate::linux::login_identity(0).as_ref() != Some(&self.login) {
            return Err(failure(
                "no_interactive_session",
                "Wayland capture login ended or changed",
            ));
        }
        self.connection.process()?;
        if self.closed.get() {
            return Err(failure(
                "target_gone",
                "native portal closed this capture session; no selection was replayed",
            ));
        }
        Ok(())
    }
    fn poll(&mut self) -> Result<(), Value> {
        self.check()?;
        if self.last_owner_check.elapsed() >= Duration::from_millis(500) {
            self.connection.alive()?;
            self.last_owner_check = Instant::now();
        }
        Ok(())
    }
    fn start(&self, deadline: Instant) -> Result<(u64, OwnedFd), Value> {
        unsafe {
            self.connection
                .request(SCREENCAST, c"SelectSources", deadline, |message| {
                    portal_check(sd_bus_message_append(
                        message,
                        c"o".as_ptr(),
                        self.handle.as_ptr(),
                    ))?;
                    portal_check(sd_bus_message_open_container(
                        message,
                        b'a' as c_char,
                        c"{sv}".as_ptr(),
                    ))?;
                    portal_option(message, c"types", c"u", |m| {
                        portal_check(sd_bus_message_append(m, c"u".as_ptr(), 1u32))
                    })?;
                    portal_option(message, c"multiple", c"b", |m| {
                        portal_check(sd_bus_message_append(m, c"b".as_ptr(), 0i32))
                    })?;
                    portal_option(message, c"cursor_mode", c"u", |m| {
                        portal_check(sd_bus_message_append(m, c"u".as_ptr(), 1u32))
                    })
                    // No restore token or persistent permission is requested implicitly.
                })?;
            self.check()?;
            let reply = self
                .connection
                .request(SCREENCAST, c"Start", deadline, |message| {
                    portal_check(sd_bus_message_append(
                        message,
                        c"os".as_ptr(),
                        self.handle.as_ptr(),
                        c"".as_ptr(),
                    ))?;
                    portal_check(sd_bus_message_open_container(
                        message,
                        b'a' as c_char,
                        c"{sv}".as_ptr(),
                    ))
                })?;
            let mut serial = None;
            portal_dictionary(reply.0, |key, signature, message| {
                if key != "streams" {
                    return Ok(false);
                }
                if signature != c"a(ua{sv})" {
                    return Err(failure(
                        "provider_failed",
                        "portal streams have the wrong native type",
                    ));
                }
                if sd_bus_message_enter_container(message, b'a' as c_char, c"(ua{sv})".as_ptr())
                    <= 0
                    || sd_bus_message_enter_container(message, b'r' as c_char, c"ua{sv}".as_ptr())
                        <= 0
                {
                    return Err(failure(
                        "provider_failed",
                        "portal returned no selected stream",
                    ));
                }
                let mut node = 0u32;
                if sd_bus_message_read(message, c"u".as_ptr(), &mut node) <= 0 || node == u32::MAX {
                    return Err(failure(
                        "provider_failed",
                        "portal returned an invalid stream node",
                    ));
                }
                let mut source_type = None;
                portal_dictionary(message, |key, signature, m| match key {
                    "pipewire-serial" => {
                        if signature != c"t" {
                            return Err(failure(
                                "provider_failed",
                                "portal stream serial has the wrong native type",
                            ));
                        }
                        let mut value = 0u64;
                        if sd_bus_message_read(m, c"t".as_ptr(), &mut value) <= 0 || value == 0 {
                            return Err(failure(
                                "provider_failed",
                                "portal stream serial is missing or zero",
                            ));
                        }
                        serial = Some(value);
                        Ok(true)
                    }
                    "source_type" => {
                        if signature != c"u" {
                            return Err(failure(
                                "provider_failed",
                                "portal source type has the wrong native type",
                            ));
                        }
                        let mut value = 0u32;
                        if sd_bus_message_read(m, c"u".as_ptr(), &mut value) <= 0 {
                            return Err(failure(
                                "provider_failed",
                                "portal source type is missing",
                            ));
                        }
                        source_type = Some(value);
                        Ok(true)
                    }
                    _ => Ok(false),
                })?;
                if source_type != Some(1) {
                    return Err(failure(
                        "unsupported_target",
                        "portal selected something other than the requested monitor",
                    ));
                }
                portal_check(sd_bus_message_exit_container(message))?;
                if sd_bus_message_at_end(message, 0) != 1 {
                    return Err(failure(
                        "target_ambiguous",
                        "portal returned multiple streams for one-source selection",
                    ));
                }
                portal_check(sd_bus_message_exit_container(message))?;
                Ok(true)
            })?;
            let serial = serial.ok_or_else(|| {
                failure(
                    "version_mismatch",
                    "portal omitted the selected stream's non-reused serial",
                )
            })?;
            self.check()?;
            self.connection.alive()?;
            if Instant::now() >= deadline {
                return Err(failure(
                    "timeout_unknown_outcome",
                    "portal capture deadline expired after selection; owned session close was attempted",
                ));
            }
            let mut message = ptr::null_mut();
            portal_check(sd_bus_message_new_method_call(
                self.connection.bus.0,
                &mut message,
                self.connection.destination.as_ptr(),
                c"/org/freedesktop/portal/desktop".as_ptr(),
                SCREENCAST.as_ptr(),
                c"OpenPipeWireRemote".as_ptr(),
            ))?;
            let message = Message(message);
            portal_check(sd_bus_message_append(
                message.0,
                c"o".as_ptr(),
                self.handle.as_ptr(),
            ))?;
            portal_check(sd_bus_message_open_container(
                message.0,
                b'a' as c_char,
                c"{sv}".as_ptr(),
            ))?;
            portal_check(sd_bus_message_close_container(message.0))?;
            let mut reply = ptr::null_mut();
            portal_check(sd_bus_call(
                self.connection.bus.0,
                message.0,
                deadline
                    .saturating_duration_since(Instant::now())
                    .as_micros()
                    .min(2_000_000) as u64,
                ptr::null_mut(),
                &mut reply,
            ))?;
            let reply = Message(reply);
            let mut descriptor = -1i32;
            if sd_bus_message_read(reply.0, c"h".as_ptr(), &mut descriptor) <= 0 || descriptor < 0 {
                return Err(failure(
                    "provider_failed",
                    "portal returned no restricted PipeWire descriptor",
                ));
            }
            let duplicate = libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 3);
            if duplicate < 0 {
                return Err(failure(
                    "provider_failed",
                    "restricted PipeWire descriptor could not be retained",
                ));
            }
            Ok((serial, OwnedFd::from_raw_fd(duplicate)))
        }
    }
}

struct Pipeline(gst::Pipeline);
impl Drop for Pipeline {
    fn drop(&mut self) {
        let _ = self.0.set_state(gst::State::Null);
    }
}
pub(super) struct Source {
    pipeline: Option<Pipeline>,
    sink: Option<gstreamer_app::AppSink>,
    session: Option<Session>,
    remote: Option<OwnedFd>,
    negotiation_error: Arc<Mutex<Option<Value>>>,
    error: Option<Value>,
}
impl Source {
    pub(super) fn open(action: &Value, continuous: bool) -> Result<Self, Value> {
        if [
            "app",
            "window",
            "display",
            "pid",
            "_capture_pid",
            "virtual",
            "element",
        ]
        .iter()
        .any(|key| action.get(key).is_some())
        {
            return Err(failure(
                "unsupported_target",
                "Wayland portal capture cannot establish an exact app, window, display number or virtual-output selector; no other target was captured",
            ));
        }
        if !continuous && action["mode"] != "display" {
            return Err(failure(
                "unsupported_target",
                "Wayland screenshot requires --mode display and native portal monitor selection; no frontmost-window fallback was captured",
            ));
        }
        let remaining = action["_capture_timeout_ms"]
            .as_u64()
            .unwrap_or(50_000)
            .min(50_000);
        if remaining < 1000 {
            return Err(failure(
                "cancelled",
                "capture deadline expired in the worker queue; no portal selection was dispatched",
            ));
        }
        let deadline = Instant::now() + Duration::from_millis(remaining);
        gst::init()
            .map_err(|_| failure("not_installed", "native GStreamer could not initialize"))?;
        let (major, minor, _, _) = gst::version();
        if major != 1 || minor < 24 {
            return Err(failure(
                "version_mismatch",
                "Wayland capture requires native GStreamer 1.24 or newer in the 1.x series",
            ));
        }
        let source = gst::ElementFactory::make("pipewiresrc")
            .build()
            .map_err(|_| {
                failure(
                    "not_installed",
                    "native GStreamer PipeWire source plugin is required",
                )
            })?;
        let plugin = source
            .factory()
            .and_then(|factory| factory.plugin())
            .ok_or_else(|| {
                failure(
                    "provider_failed",
                    "native PipeWire plugin identity is missing",
                )
            })?;
        if plugin.version().as_str() != "1.4.2" {
            return Err(failure(
                "version_mismatch",
                "Wayland capture source requires PipeWire plugin 1.4.2; no portal selection was dispatched",
            ));
        }
        for property in [
            "fd",
            "target-object",
            "resend-last",
            "keepalive-time",
            "max-buffers",
        ] {
            if source.find_property(property).is_none() {
                return Err(failure(
                    "version_mismatch",
                    "native PipeWire source omitted a required property",
                ));
            }
        }
        // Every output buffer is one actual frame. The plugin's last-frame
        // resend/keepalive paths remain disabled, so they cannot inflate counts.
        source.set_property("resend-last", false);
        source.set_property("keepalive-time", 0i32);
        source.set_property("max-buffers", 2i32);
        let convert = gst::ElementFactory::make("videoconvert")
            .property("n-threads", 1u32)
            .build()
            .map_err(|_| {
                failure(
                    "not_installed",
                    "native GStreamer video converter is required",
                )
            })?;
        let sink = gstreamer_app::AppSink::builder().build();
        sink.set_caps(Some(
            &gst::Caps::builder("video/x-raw")
                .field("format", "RGBA")
                .field("width", gst::IntRange::<i32>::new(1, 16384))
                .field("height", gst::IntRange::<i32>::new(1, 16384))
                .build(),
        ));
        sink.set_max_buffers(1);
        sink.set_max_bytes(128 * 1024 * 1024);
        sink.set_drop(true);
        sink.set_sync(false);
        sink.set_enable_last_sample(false);
        sink.set_wait_on_eos(false);
        let negotiation_error = Arc::new(Mutex::new(None::<Value>));
        let error = negotiation_error.clone();
        let pad = source.static_pad("src").ok_or_else(|| {
            failure(
                "provider_failed",
                "native PipeWire source has no output pad",
            )
        })?;
        if pad
            .add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_, probe| {
                if let Some(event) = probe.event() {
                    if let gst::EventView::Caps(event) = event.view() {
                        let caps = event.caps();
                        let checked = gstreamer_video::VideoInfo::from_caps(caps)
                            .map_err(|_| {
                                failure(
                                    "unsupported_target",
                                    "PipeWire supplied a format without usable CPU video metadata",
                                )
                            })
                            .and_then(|info| {
                                let size = crate::capture::pixel_size(info.width(), info.height())?;
                                if info.size() > MAX_NATIVE_BYTES || size > MAX_NATIVE_BYTES {
                                    return Err(failure(
                                        "resource_limit",
                                        "native capture negotiation exceeds the buffer bound",
                                    ));
                                }
                                Ok(())
                            });
                        if let Err(value) = checked {
                            if let Ok(mut error) = error.lock() {
                                *error = Some(value);
                            }
                            return gst::PadProbeReturn::Drop;
                        }
                    }
                }
                gst::PadProbeReturn::Ok
            })
            .is_none()
        {
            return Err(failure(
                "provider_failed",
                "native capture dimension guard could not be registered",
            ));
        }
        let pipeline = Pipeline(gst::Pipeline::new());
        pipeline
            .0
            .add_many([&source, &convert, sink.upcast_ref()])
            .map_err(|_| {
                failure(
                    "provider_failed",
                    "native capture elements could not be owned",
                )
            })?;
        gst::Element::link_many([&source, &convert, sink.upcast_ref()]).map_err(|_| {
            failure(
                "provider_failed",
                "native CPU capture pipeline could not be linked",
            )
        })?;
        let session = Session::create(deadline)?;
        let (serial, remote) = session.start(deadline)?;
        source.set_property("fd", remote.as_raw_fd());
        source.set_property("target-object", serial.to_string());
        session.check()?;
        if Instant::now() >= deadline {
            return Err(failure(
                "timeout_unknown_outcome",
                "Wayland capture initialization exceeded its deadline; owned resources were released",
            ));
        }
        pipeline.0.set_state(gst::State::Playing).map_err(|_| {
            failure(
                "provider_failed",
                "native PipeWire capture pipeline refused to start",
            )
        })?;
        session.check()?;
        if Instant::now() >= deadline {
            return Err(failure(
                "timeout_unknown_outcome",
                "native capture startup returned after its deadline; no admission receipt was issued",
            ));
        }
        Ok(Self {
            pipeline: Some(pipeline),
            sink: Some(sink),
            session: Some(session),
            remote: Some(remote),
            negotiation_error,
            error: None,
        })
    }
    fn retire(&mut self) {
        self.pipeline.take();
        self.sink.take();
        self.session.take();
        self.remote.take();
    }
    pub(super) fn next_frame(&mut self) -> Result<Option<RgbaImage>, Value> {
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        match self.poll() {
            Ok(frame) => Ok(frame),
            Err(error) => {
                self.error = Some(error.clone());
                self.retire();
                Err(error)
            }
        }
    }
    fn poll(&mut self) -> Result<Option<RgbaImage>, Value> {
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| failure("target_gone", "Wayland capture session is retired"))?;
        session.poll()?;
        if let Some(error) = self
            .negotiation_error
            .lock()
            .map_err(|_| failure("provider_failed", "native capture format guard failed"))?
            .clone()
        {
            return Err(error);
        }
        let pipeline = self
            .pipeline
            .as_ref()
            .ok_or_else(|| failure("target_gone", "Wayland capture pipeline is retired"))?;
        let bus = pipeline.0.bus().ok_or_else(|| {
            failure(
                "provider_failed",
                "native capture pipeline omitted its event bus",
            )
        })?;
        for index in 0..64 {
            let Some(message) = bus.pop() else {
                break;
            };
            match message.view() {
                gst::MessageView::Error(_) => {
                    return Err(failure(
                        "provider_failed",
                        "native PipeWire capture failed; the session was retired without reconnecting",
                    ));
                }
                gst::MessageView::Eos(_) => {
                    return Err(failure(
                        "target_gone",
                        "native PipeWire stream ended; the source was not reselected",
                    ));
                }
                _ => (),
            }
            if index == 63 {
                return Err(failure(
                    "resource_limit",
                    "native capture event queue exceeds its per-poll bound",
                ));
            }
        }
        let sink = self
            .sink
            .as_ref()
            .ok_or_else(|| failure("target_gone", "Wayland capture sink is retired"))?;
        let Some(sample) = sink.try_pull_sample(gst::ClockTime::ZERO) else {
            return Ok(None);
        };
        let caps = sample.caps().ok_or_else(|| {
            failure(
                "provider_failed",
                "native frame omitted its negotiated format",
            )
        })?;
        let info = gstreamer_video::VideoInfo::from_caps(caps)
            .map_err(|_| failure("provider_failed", "native frame format is invalid"))?;
        let size = crate::capture::pixel_size(info.width(), info.height())?;
        if info.format() != gstreamer_video::VideoFormat::Rgba || info.size() > MAX_NATIVE_BYTES {
            return Err(failure(
                "provider_failed",
                "native frame is not bounded RGBA video",
            ));
        }
        let buffer = sample.buffer().ok_or_else(|| {
            failure(
                "provider_failed",
                "native sample omitted its actual frame buffer",
            )
        })?;
        if buffer.size() > MAX_NATIVE_BYTES {
            return Err(failure(
                "resource_limit",
                "native frame buffer exceeds 256MiB",
            ));
        }
        let frame = gstreamer_video::VideoFrameRef::from_buffer_ref_readable(buffer, &info)
            .map_err(|_| {
                failure(
                    "unsupported_target",
                    "native video buffer could not be mapped as CPU pixels",
                )
            })?;
        if frame.width() != info.width()
            || frame.height() != info.height()
            || frame.format() != info.format()
            || frame.n_planes() != 1
        {
            return Err(failure(
                "provider_failed",
                "native frame mapping changed its negotiated dimensions or format",
            ));
        }
        let stride = usize::try_from(frame.plane_stride()[0]).map_err(|_| {
            failure(
                "unsupported_target",
                "negative native video stride is unsupported",
            )
        })?;
        let row = (info.width() as usize)
            .checked_mul(4)
            .ok_or_else(|| failure("resource_limit", "native row byte size overflow"))?;
        let mapped = stride
            .checked_mul(info.height() as usize)
            .filter(|n| *n <= MAX_NATIVE_BYTES)
            .ok_or_else(|| failure("resource_limit", "native mapped plane exceeds its bound"))?;
        if stride < row {
            return Err(failure(
                "provider_failed",
                "native video stride is shorter than its RGBA row",
            ));
        }
        // Check the mapped stride before the wrapper constructs its plane slice.
        let plane = frame
            .plane_data(0)
            .map_err(|_| failure("provider_failed", "native frame plane could not be read"))?;
        if plane.len() < mapped {
            return Err(failure(
                "provider_failed",
                "native frame plane is truncated",
            ));
        }
        let mut pixels = Vec::new();
        pixels.try_reserve_exact(size).map_err(|_| {
            failure(
                "resource_limit",
                "native frame copy exceeds available memory",
            )
        })?;
        for y in 0..info.height() as usize {
            pixels.extend_from_slice(&plane[y * stride..y * stride + row]);
        }
        session.check()?;
        RgbaImage::from_raw(info.width(), info.height(), pixels)
            .map(Some)
            .ok_or_else(|| {
                failure(
                    "provider_failed",
                    "native RGBA frame could not be represented",
                )
            })
    }
}
impl Drop for Source {
    fn drop(&mut self) {
        self.retire();
    }
}
