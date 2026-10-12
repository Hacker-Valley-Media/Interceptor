use std::{ffi::CStr, os::{fd::{AsRawFd, FromRawFd, OwnedFd}, unix::net::UnixStream}, path::Path};

#[link(name = "systemd")]
unsafe extern "C" {
    fn sd_pidfd_get_session(fd: libc::c_int, session: *mut *mut libc::c_char) -> libc::c_int;
    fn sd_pidfd_get_owner_uid(fd: libc::c_int, uid: *mut libc::uid_t) -> libc::c_int;
    fn sd_pidfd_get_user_unit(fd: libc::c_int, unit: *mut *mut libc::c_char) -> libc::c_int;
    fn sd_uid_get_display(uid: libc::uid_t, session: *mut *mut libc::c_char) -> libc::c_int;
    fn sd_uid_get_sessions(uid: libc::uid_t, active: libc::c_int, sessions: *mut *mut *mut libc::c_char) -> libc::c_int;
    fn sd_session_get_uid(session: *const libc::c_char, uid: *mut libc::uid_t) -> libc::c_int;
    fn sd_session_get_start_time(session: *const libc::c_char, usec: *mut u64) -> libc::c_int;
    fn sd_session_get_type(session: *const libc::c_char, kind: *mut *mut libc::c_char) -> libc::c_int;
    fn sd_session_get_class(session: *const libc::c_char, class: *mut *mut libc::c_char) -> libc::c_int;
    fn sd_session_get_state(session: *const libc::c_char, state: *mut *mut libc::c_char) -> libc::c_int;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionIdentity { pub id: String, pub start_usec: u64, pub source: &'static str }

fn owned_string(status: libc::c_int, raw: *mut libc::c_char) -> Option<String> {
    if raw.is_null() { return None; }
    let value = if status >= 0 { unsafe { CStr::from_ptr(raw).to_str().ok().map(str::to_owned) } } else { None };
    unsafe { libc::free(raw.cast()); } value
}

fn details(id: String, uid: libc::uid_t, source: &'static str) -> Option<SessionIdentity> {
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') { return None; }
    let name = std::ffi::CString::new(id.as_str()).ok()?;
    let mut actual_uid = libc::uid_t::MAX; let mut start_usec = 0;
    if unsafe { sd_session_get_uid(name.as_ptr(), &mut actual_uid) } < 0 || actual_uid != uid ||
        unsafe { sd_session_get_start_time(name.as_ptr(), &mut start_usec) } < 0 || start_usec == 0 { return None; }
    let mut raw = std::ptr::null_mut();
    let state = owned_string(unsafe { sd_session_get_state(name.as_ptr(), &mut raw) }, raw)?;
    if !["active", "online"].contains(&state.as_str()) { return None; }
    Some(SessionIdentity { id, start_usec, source })
}

/// User services are shared between logins. Associate them only when logind
/// proves their owner/unit and exactly one online graphical user login exists.
/// A kernel login (including SSH) always wins; environment claims are ignored.
pub fn resolve_session(fd: &OwnedFd) -> Option<SessionIdentity> {
    let alive = || { let mut poll = libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLIN, revents: 0 }; unsafe { libc::poll(&mut poll, 1, 0) == 0 } };
    if !alive() { return None; }
    let uid = unsafe { libc::geteuid() }; let mut owner = libc::uid_t::MAX;
    if unsafe { sd_pidfd_get_owner_uid(fd.as_raw_fd(), &mut owner) } < 0 || owner != uid { return None; }
    let mut raw = std::ptr::null_mut();
    let status = unsafe { sd_pidfd_get_session(fd.as_raw_fd(), &mut raw) };
    let kernel = owned_string(status, raw);
    if status >= 0 {
        let identity = details(kernel?, uid, "kernel-login")?;
        return alive().then_some(identity);
    }
    if status != -libc::ENODATA { return None; }
    raw = std::ptr::null_mut();
    let unit = owned_string(unsafe { sd_pidfd_get_user_unit(fd.as_raw_fd(), &mut raw) }, raw)?;
    if unit.is_empty() { return None; }
    raw = std::ptr::null_mut();
    let display = owned_string(unsafe { sd_uid_get_display(uid, &mut raw) }, raw)?;
    let mut list = std::ptr::null_mut();
    let count = unsafe { sd_uid_get_sessions(uid, 0, &mut list) };
    // Bound enumeration without leaving any libc-owned strings behind.
    let mut ids = Vec::new();
    if !list.is_null() {
        let mut index = 0;
        while !unsafe { *list.add(index) }.is_null() {
            let value = owned_string(0, unsafe { *list.add(index) });
            if index < 256 { ids.push(value); } index += 1;
        }
        unsafe { libc::free(list.cast()); }
        if index > 256 { return None; }
    }
    if count <= 0 || count > 256 || ids.len() != count as usize { return None; }
    let mut graphical = Vec::new();
    for id in ids {
        let id = id?; let name = std::ffi::CString::new(id.as_str()).ok()?;
        raw = std::ptr::null_mut();
        let kind = owned_string(unsafe { sd_session_get_type(name.as_ptr(), &mut raw) }, raw)?;
        if !["wayland", "x11"].contains(&kind.as_str()) { continue; }
        raw = std::ptr::null_mut();
        let class = owned_string(unsafe { sd_session_get_class(name.as_ptr(), &mut raw) }, raw)?;
        if class != "user" { return None; }
        graphical.push(details(id, uid, "logind-user-service-display")?);
    }
    if graphical.len() != 1 { return None; }
    let identity = graphical.pop()?;
    if identity.id != display { return None; }
    let name = std::ffi::CString::new(identity.id.as_str()).ok()?;
    raw = std::ptr::null_mut();
    if owned_string(unsafe { sd_session_get_state(name.as_ptr(), &mut raw) }, raw)?.as_str() != "active" { return None; }
    // Re-read the chosen login so logout/replacement during enumeration fails.
    if details(identity.id.clone(), uid, identity.source)? != identity || !alive() { return None; }
    Some(identity)
}

/// File helpers require a graphical login. Recheck its native creation identity
/// after reading logind's type and class; environment claims are irrelevant.
pub fn graphical(identity: &SessionIdentity) -> bool {
    let uid = unsafe { libc::geteuid() };
    let Some(name) = std::ffi::CString::new(identity.id.as_str()).ok() else { return false; };
    if details(identity.id.clone(), uid, identity.source).as_ref() != Some(identity) { return false; }
    let mut raw = std::ptr::null_mut();
    let kind = owned_string(unsafe { sd_session_get_type(name.as_ptr(), &mut raw) }, raw);
    raw = std::ptr::null_mut();
    let class = owned_string(unsafe { sd_session_get_class(name.as_ptr(), &mut raw) }, raw);
    matches!(kind.as_deref(), Some("wayland" | "x11")) && class.as_deref() == Some("user") &&
        details(identity.id.clone(), uid, identity.source).as_ref() == Some(identity)
}

fn session(fd: &OwnedFd) -> Option<String> {
    resolve_session(fd).map(|identity| identity.id)
}

/// Both directions authenticate kernel credentials on this same connected
/// handle. SO_PEERPIDFD pins the socket's creator, including after PID reuse.
/// Unsupported kernels fail closed; the qualified backend requires Linux 6.5.
pub fn authorized(stream: &UnixStream, expected_session: &str, executable: Option<&Path>) -> bool {
    let mut peer: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED,
        (&mut peer as *mut libc::ucred).cast(), &mut length) } != 0 ||
        length as usize != std::mem::size_of::<libc::ucred>() || peer.pid <= 0 || peer.uid != unsafe { libc::geteuid() } { return false; }
    let mut raw_fd: libc::c_int = -1;
    let mut length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    if unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERPIDFD,
        (&mut raw_fd as *mut libc::c_int).cast(), &mut length) } != 0 || raw_fd < 0 { return false; }
    let fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
    if length as usize != std::mem::size_of::<libc::c_int>() { return false; }
    let mut poll = libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
    if unsafe { libc::poll(&mut poll, 1, 0) } != 0 || session(&fd).as_deref() != Some(expected_session) { return false; }
    if let Some(executable) = executable {
        let expected = std::fs::canonicalize(executable);
        if expected.is_err() || std::fs::canonicalize(format!("/proc/{}/exe", peer.pid)).ok() != expected.ok() { return false; }
    }
    // A peer that exits while its session/executable is being read is refused.
    // Its retained fd cannot become the identity of a later recycled PID.
    unsafe { libc::poll(&mut poll, 1, 0) == 0 }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn live_peer_session_and_executable() {
        let (stream, _peer) = UnixStream::pair().unwrap();
        let mut raw_fd = -1;
        let mut length = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        assert_eq!(unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERPIDFD,
            (&mut raw_fd as *mut libc::c_int).cast(), &mut length) }, 0, "Linux 6.5 peer PIDfd is required");
        assert_eq!(length as usize, std::mem::size_of::<libc::c_int>());
        let fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        assert!(!authorized(&stream, "not-a-current-login", None));
        if let Some(current_session) = session(&fd) {
            assert!(authorized(&stream, &current_session, None));
            assert!(authorized(&stream, &current_session, Some(&std::env::current_exe().unwrap())));
            assert!(!authorized(&stream, &current_session, Some(Path::new("/owned-absent-executable"))));
        } else { assert!(!authorized(&stream, "", None)); }
    }
}
