//! Narrow C ABI for compositor integrations. Keep authentication in the
//! provider's existing PIDfd/logind module rather than reimplementing it in C++.
#[cfg(unix)]
pub mod pointer_payload;
#[cfg(target_os = "linux")]
mod linux_peer;

#[cfg(target_os = "linux")]
pub mod wayland_transport;
#[cfg(target_os = "linux")]
pub mod linux_pointer;

#[cfg(target_os = "linux")]
mod compositor_auth {
    use super::linux_peer::{self, SessionIdentity};
    use std::{io::Read, os::{fd::{AsRawFd, FromRawFd, OwnedFd}, unix::net::UnixStream}, sync::{OnceLock, atomic::{AtomicBool, Ordering}}};

    static LOGIN: OnceLock<Option<SessionIdentity>> = OnceLock::new();
    static REVOKED: AtomicBool = AtomicBool::new(false);

    fn current() -> Option<SessionIdentity> {
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0_u32) };
        if raw < 0 { return None; }
        let fd = unsafe { OwnedFd::from_raw_fd(raw as libc::c_int) };
        linux_peer::resolve_session(&fd)
    }
    pub fn initialize() -> bool { LOGIN.get_or_init(current).is_some() && valid() }
    pub fn valid() -> bool {
        if REVOKED.load(Ordering::Acquire) { return false; }
        let Some(Some(login)) = LOGIN.get() else { return false; };
        if current().as_ref() != Some(login) {
            // A compositor integration cannot reassociate existing clients
            // after logout, session reuse or an ambiguous graphical login.
            REVOKED.store(true, Ordering::Release); return false;
        }
        true
    }
    fn duplicate(fd: libc::c_int) -> Option<UnixStream> {
        let raw = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        (raw >= 0).then(|| unsafe { UnixStream::from_raw_fd(raw) })
    }
    pub fn peers(caller_socket: libc::c_int, target_socket: libc::c_int) -> bool {
        if !valid() { return false; }
        let Some(Some(login)) = LOGIN.get() else { return false; };
        let (Some(caller), Some(target)) = (duplicate(caller_socket), duplicate(target_socket)) else { return false; };
        linux_peer::authorized(&caller, &login.id, None) && linux_peer::authorized(&target, &login.id, None) && valid()
    }
    fn retained_process(raw: libc::c_int, pid: u32) -> Option<OwnedFd> {
        if raw < 0 || pid == 0 || pid > i32::MAX as u32 { return None; }
        let copy = unsafe { libc::fcntl(raw, libc::F_DUPFD_CLOEXEC, 0) };
        if copy < 0 { return None; }
        let fd = unsafe { OwnedFd::from_raw_fd(copy) };
        let alive = || {
            let mut poll = libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            unsafe { libc::poll(&mut poll, 1, 0) == 0 }
        };
        if !alive() { return None; }
        // PIDfd fdinfo identifies the retained kernel process. Reading the
        // numeric /proc/<pid> entry alone would allow a recycled PID to pass.
        let mut info = String::new();
        std::fs::File::open(format!("/proc/self/fdinfo/{}", fd.as_raw_fd())).ok()?
            .take(4097).read_to_string(&mut info).ok()?;
        if info.len() > 4096 || info.lines().find_map(|line| line.strip_prefix("Pid:").map(str::trim))?.parse::<u32>().ok()? != pid || !alive() { return None; }
        Some(fd)
    }
    pub fn target(process_fd: libc::c_int, socket: libc::c_int, pid: u32) -> bool {
        if !valid() { return false; }
        let Some(Some(login)) = LOGIN.get() else { return false; };
        let Some(fd) = retained_process(process_fd, pid) else { return false; };
        let Some(identity) = linux_peer::resolve_session(&fd) else { return false; };
        if identity.id != login.id || identity.start_usec != login.start_usec { return false; }
        let Some(stream) = duplicate(socket) else { return false; };
        let mut peer: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        if unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut peer as *mut libc::ucred).cast(), &mut size) } != 0 ||
            size as usize != std::mem::size_of::<libc::ucred>() || peer.pid != pid as libc::pid_t || !linux_peer::authorized(&stream, &login.id, None) { return false; }
        retained_process(fd.as_raw_fd(), pid).is_some() && valid()
    }
    #[cfg(test)] mod tests {
        use super::*;
        #[test] fn retained_handle_rejects_wrong_pid_non_pidfd_and_exit() {
            let pid = std::process::id();
            let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0_u32) };
            assert!(raw >= 0);
            let fd = unsafe { OwnedFd::from_raw_fd(raw as i32) };
            assert!(retained_process(fd.as_raw_fd(), pid).is_some());
            assert!(retained_process(fd.as_raw_fd(), pid + 1).is_none());
            let (stream, _) = UnixStream::pair().unwrap();
            assert!(retained_process(stream.as_raw_fd(), pid).is_none());
            assert!(retained_process(-1, pid).is_none());
            let mut child = std::process::Command::new("/usr/bin/sleep").arg("10").spawn().unwrap();
            let child_fd = unsafe { libc::syscall(libc::SYS_pidfd_open, child.id(), 0_u32) };
            assert!(child_fd >= 0);
            let child_fd = unsafe { OwnedFd::from_raw_fd(child_fd as i32) };
            assert!(retained_process(child_fd.as_raw_fd(), child.id()).is_some());
            child.kill().unwrap(); child.wait().unwrap();
            assert!(retained_process(child_fd.as_raw_fd(), child.id()).is_none());
        }
        #[test]
        #[ignore="requires an owned graphical login service"]
        fn target_socket_requires_selected_handle_and_retained_login() {
            assert!(initialize());
            let pid = std::process::id();
            let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0_u32) };
            let fd = unsafe { OwnedFd::from_raw_fd(raw as i32) };
            let (stream, _) = UnixStream::pair().unwrap();
            assert!(target(fd.as_raw_fd(), stream.as_raw_fd(), pid));
            assert!(!target(fd.as_raw_fd(), stream.as_raw_fd(), pid + 1));
            assert!(!target(stream.as_raw_fd(), stream.as_raw_fd(), pid));
            assert!(!target(fd.as_raw_fd(), -1, pid));
        }
    }
}

/// Pin the compositor's current login at plugin load. Returns 1 on success.
#[unsafe(no_mangle)]
pub extern "C" fn interceptor_linux_login_initialize() -> i32 {
    #[cfg(target_os = "linux")]
    { return i32::from(std::panic::catch_unwind(compositor_auth::initialize).unwrap_or(false)); }
    #[cfg(not(target_os = "linux"))]
    { 0 }
}

/// A lost, changed or ambiguous login permanently revokes this loaded instance.
#[unsafe(no_mangle)]
pub extern "C" fn interceptor_linux_login_valid() -> i32 {
    #[cfg(target_os = "linux")]
    { return i32::from(std::panic::catch_unwind(compositor_auth::valid).unwrap_or(false)); }
    #[cfg(not(target_os = "linux"))]
    { 0 }
}

/// Authenticate connected caller and target sockets through SO_PEERPIDFD.
/// Arguments are borrowed fds, not numeric PIDs or environment claims. This
/// function duplicates handles and never reads, writes or closes the originals.
#[unsafe(no_mangle)]
pub extern "C" fn interceptor_linux_peers_authenticated(caller_socket: i32, target_socket: i32) -> i32 {
    #[cfg(target_os = "linux")]
    { return i32::from(std::panic::catch_unwind(|| compositor_auth::peers(caller_socket, target_socket)).unwrap_or(false)); }
    #[cfg(not(target_os = "linux"))]
    { let _ = (caller_socket, target_socket); 0 }
}

/// Bind each native window connection to a live caller-retained PIDfd.
#[unsafe(no_mangle)]
pub extern "C" fn interceptor_linux_target_matches(process_fd: i32, target_socket: i32, pid: u32) -> i32 {
    #[cfg(target_os = "linux")]
    { return i32::from(std::panic::catch_unwind(|| compositor_auth::target(process_fd, target_socket, pid)).unwrap_or(false)); }
    #[cfg(not(target_os = "linux"))]
    { let _ = (process_fd, target_socket, pid); 0 }
}
