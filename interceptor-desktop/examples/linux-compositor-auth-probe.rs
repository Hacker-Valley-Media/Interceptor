//! Actual-host C ABI checks, including borrowed-handle preservation and peers
//! connecting from other kernel login sessions. No desktop input is delivered.
#[cfg(target_os = "linux")]
fn main() {
    use interceptor_desktop::{interceptor_linux_login_initialize as initialize, interceptor_linux_login_valid as valid, interceptor_linux_peers_authenticated as peers};
    use std::{io::{Read, Write}, os::{fd::AsRawFd, unix::net::{UnixListener, UnixStream}}, time::{Duration, Instant}};
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "--connect") {
        let mut caller = UnixStream::connect(args.get(2).expect("owned socket path")).unwrap();
        caller.set_read_timeout(Some(Duration::from_secs(3))).unwrap(); caller.write_all(b"x").unwrap();
        let mut admitted = [1]; caller.read_exact(&mut admitted).unwrap(); assert_eq!(admitted, [0]);
        println!("{{\"foreignCallerRefused\":true,\"pid\":{},\"uid\":{}}}", std::process::id(), unsafe { libc::geteuid() }); return;
    }
    let (mut socket, mut other) = UnixStream::pair().unwrap();
    assert_eq!(initialize(), 1, "an authoritative current login is required");
    assert_eq!(valid(), 1);
    assert_eq!(peers(socket.as_raw_fd(), other.as_raw_fd()), 1);
    assert_eq!(peers(-1, other.as_raw_fd()), 0);
    assert_eq!(peers(socket.as_raw_fd(), -1), 0);
    assert_eq!(peers(0, other.as_raw_fd()), 0, "stdin is not an authenticated connected socket");
    socket.write_all(b"borrowed handles remain usable").unwrap();
    let mut body = [0_u8; b"borrowed handles remain usable".len()]; other.read_exact(&mut body).unwrap();
    assert_eq!(&body, b"borrowed handles remain usable");
    println!("{{\"checks\":6,\"sameLogin\":true,\"originalHandlesPreserved\":true,\"pid\":{}}}", std::process::id());
    if let Some(path) = args.get(1) {
        if path == "--watch" {
            println!("{{\"watchReady\":true,\"pid\":{}}}", std::process::id()); std::io::stdout().flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(60);
            while valid() == 1 { assert!(Instant::now() < deadline, "owned login revocation deadline"); std::thread::sleep(Duration::from_millis(50)); }
            println!("{{\"revoked\":true}}"); std::io::stdout().flush().unwrap();
            if let Some(resume) = args.get(2) {
                let deadline = Instant::now() + Duration::from_secs(45);
                while !std::path::Path::new(resume).is_file() { assert!(Instant::now() < deadline, "owned login restoration handshake deadline"); std::thread::sleep(Duration::from_millis(25)); }
            } else { std::thread::sleep(Duration::from_secs(3)); }
            assert_eq!(initialize(), 0, "a revoked instance cannot reassociate");
            assert_eq!(valid(), 0); assert_eq!(peers(socket.as_raw_fd(), other.as_raw_fd()), 0);
            println!("{{\"checks\":3,\"revocationRetained\":true}}"); return;
        }
        let listener = UnixListener::bind(path).unwrap(); listener.set_nonblocking(true).unwrap();
        std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
        println!("{{\"socketReady\":true,\"path\":\"{path}\"}}"); std::io::stdout().flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(45); let mut checks = 0;
        while checks < 2 {
            assert!(Instant::now() < deadline, "owned foreign peer deadline");
            match listener.accept() {
                Ok((mut caller, _)) => {
                    caller.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                    let mut challenge = [0]; caller.read_exact(&mut challenge).unwrap();
                    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
                    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
                    assert_eq!(unsafe { libc::getsockopt(caller.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut credentials as *mut libc::ucred).cast(), &mut length) }, 0);
                    assert_eq!(length as usize, std::mem::size_of::<libc::ucred>());
                    let admitted = peers(caller.as_raw_fd(), other.as_raw_fd()); assert_eq!(admitted, 0, "foreign login/root peer refused");
                    caller.write_all(&[admitted as u8]).unwrap(); checks += 1;
                    println!("{{\"foreignPeerRefused\":true,\"check\":{checks},\"uid\":{},\"pid\":{}}}", credentials.uid, credentials.pid); std::io::stdout().flush().unwrap();
                },
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(25)),
                Err(error) => panic!("owned listener: {error}"),
            }
        }
    }
}
#[cfg(not(target_os = "linux"))]
fn main() { panic!("this actual-host qualification requires Linux"); }
