//! QEMU guest-agent transport owned by one paused VM generation. QMP stays
//! on its existing exact-child pipes. No TCP listener or host-exec fallback.
use crate::{failure, success};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs::{self, File}, io::{self, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, time::{Duration, Instant}};
type Result<T> = std::result::Result<T, Value>;
const FILE_BYTES: usize = 1_048_576;
const WIRE_BYTES: usize = 2_097_152;
const OUTPUT_BYTES: usize = 131_072;
const CHUNK: usize = 32768;
fn io_error(e: io::Error) -> Value { failure(match e.kind() { io::ErrorKind::PermissionDenied => "permission_denied", io::ErrorKind::AlreadyExists => "unsupported_target", io::ErrorKind::TimedOut => "timeout_unknown_outcome", _ => "provider_failed" }, e) }
fn alive(deadline: Instant, login: &impl Fn() -> Result<()>) -> Result<()> {
    login()?;
    if Instant::now() >= deadline { Err(failure("timeout_unknown_outcome", "guest-agent deadline expired; observe guest effects before retrying")) } else { Ok(()) }
}
fn token_valid(t: &str) -> bool { (32..=128).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_hexdigit()) }
fn prefix(id: &str, token: &str) -> String { format!("itc-qga-{id}-{token}") }
fn generation(bundle: &Path, token: &str) -> PathBuf { bundle.join(format!("guest-{token}")) }

#[cfg(unix)]
fn fifo(path: &Path, create: bool) -> Result<File> {
    use std::os::{fd::AsRawFd, unix::fs::{OpenOptionsExt, MetadataExt}};
    if create {
        let text = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| failure("invalid_request", "guest FIFO path contains NUL"))?;
        if unsafe { libc::mkfifo(text.as_ptr(), 0o600) } != 0 { return Err(io_error(io::Error::last_os_error())); }
    }
    let file = fs::OpenOptions::new().read(true).write(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC).open(path).map_err(io_error)?;
    let meta = file.metadata().map_err(io_error)?;
    if meta.mode() & u32::from(libc::S_IFMT) != u32::from(libc::S_IFIFO) || meta.mode() & 0o777 != 0o600 || meta.uid() != unsafe { libc::geteuid() } || meta.nlink() != 1 || file.as_raw_fd() < 0 {
        return Err(failure("permission_denied", "guest channel requires one owned private FIFO"));
    }
    Ok(file)
}

pub(crate) fn helper_args(bundle: &Path, id: &str, token: &str) -> Result<Vec<String>> {
    if !token_valid(token) { return Err(failure("invalid_request", "invalid guest channel generation")); }
    #[cfg(unix)] let path = {
        let directory = generation(bundle, token);
        crate::monitor::private_directory(&directory, false, false).map_err(io_error)?;
        let path = directory.join("channel");
        for suffix in ["in", "out"] { drop(fifo(&path.with_extension(suffix), false)?); }
        path.to_str().ok_or_else(|| failure("invalid_request", "guest channel requires a Unicode path"))?.to_owned()
    };
    #[cfg(windows)] let path = prefix(id, token);
    if path.contains([',', '\0']) { return Err(failure("invalid_request", "guest channel path contains a QEMU option separator")); }
    Ok(vec!["-chardev".into(), format!("pipe,id=itc-agent,path={path}"), "-device".into(), "virtio-serial-pci,id=itc-agent-bus".into(), "-device".into(), "virtserialport,bus=itc-agent-bus.0,chardev=itc-agent,name=org.qemu.guest_agent.0".into()])
}

pub(crate) struct Channel {
    token: String,
    #[cfg(unix)] directory: PathBuf,
    #[cfg(unix)] directory_handle: File,
    #[cfg(unix)] input: File,
    #[cfg(unix)] output: File,
    #[cfg(unix)] launched: bool,
    #[cfg(windows)] pipe_name: String,
    #[cfg(windows)] pipe: Option<File>,
    #[cfg(windows)] server: Option<crate::windows::OwnedHandle>,
    #[cfg(target_os="linux")] server: Option<crate::linux::CaptureIdentity>,
    buffer: Vec<u8>,
    enabled: Option<BTreeSet<String>>,
    unknown: Option<Value>,
}
// The pipe and process handles have one owner and may be moved with that VM.
#[cfg(windows)] unsafe impl Send for Channel {}
impl Drop for Channel {
    fn drop(&mut self) {
        #[cfg(unix)] {
            use std::os::unix::fs::MetadataExt;
            let same = |a: &fs::Metadata, b: &fs::Metadata| a.dev() == b.dev() && a.ino() == b.ino();
            // A sent kill or helper exit is not proof that native QEMU has
            // exited. Preserve endpoints if that retained outcome is unknown.
            #[cfg(target_os="linux")]
            if self.launched&&!matches!(self.native_exited(),Ok(true)){return;}
            if self.directory_handle.metadata().ok().zip(fs::symlink_metadata(&self.directory).ok()).is_some_and(|(a,b)| same(&a,&b)) {
                for (suffix, held) in [("in", &self.input), ("out", &self.output)] {
                    let path = self.directory.join("channel").with_extension(suffix);
                    if held.metadata().ok().zip(fs::symlink_metadata(&path).ok()).is_some_and(|(a,b)| same(&a,&b)) { let _ = fs::remove_file(path); }
                }
                let _ = fs::remove_dir(&self.directory);
            }
        }
    }
}
impl Channel {
    pub(crate) fn create(bundle: &Path, id: &str) -> Result<Self> {
        let token = crate::secret_target::random_token().map_err(io_error)?;
        if !token_valid(&token) { return Err(failure("provider_failed", "native channel token has an invalid format")); }
        #[cfg(unix)] {
            use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
            let directory = generation(bundle, &token);
            fs::DirBuilder::new().mode(0o700).create(&directory).map_err(io_error)?;
            crate::monitor::private_directory(&directory, false, false).map_err(io_error)?;
            let directory_handle = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC).open(&directory).map_err(io_error)?;
            let input = fifo(&directory.join("channel.in"), true)?;
            let output = fifo(&directory.join("channel.out"), true)?;
            Ok(Self { token, directory, directory_handle, input, output, launched:false, #[cfg(target_os="linux")] server: None, buffer: vec![], enabled: None, unknown: None })
        }
        #[cfg(windows)] {
            Ok(Self { pipe_name: format!(r"\\.\pipe\{}", prefix(id, &token)), token, pipe: None, server: None, buffer: vec![], enabled: None, unknown: None })
        }
    }
    pub(crate) fn token(&self) -> &str { &self.token }
    pub(crate) fn mark_launched(&mut self){#[cfg(unix)]{self.launched=true;}}
    pub(crate) fn connect(&mut self, helper_pid: u32, native_pid: u32, deadline: Instant, login: impl Fn() -> Result<()>) -> Result<()> {
        #[cfg(target_os="linux")] {
            use std::os::unix::fs::MetadataExt;
            alive(deadline,&login)?;
            let server=crate::linux::capture_identity(native_pid)?;
            let root=PathBuf::from(format!("/proc/{native_pid}"));
            let stat=fs::read_to_string(root.join("stat")).map_err(io_error)?;
            let parent=stat.rsplit_once(") ").and_then(|(_,fields)|fields.split_whitespace().nth(1)).and_then(|s|s.parse::<u32>().ok());
            let (expected,_)=crate::native_library::pinned_spec("INTERCEPTOR_QEMU_SYSTEM")?;
            let executable=fs::read_link(root.join("exe")).map_err(io_error)?;
            let image=File::open(root.join("exe")).map_err(io_error)?.metadata().map_err(io_error)?;
            let pinned=fs::metadata(&expected).map_err(io_error)?;
            if parent!=Some(helper_pid)||image.dev()!=pinned.dev()||image.ino()!=pinned.ino()||fs::canonicalize(executable).map_err(io_error)?!=fs::canonicalize(expected).map_err(io_error)?||!server.alive(){
                return Err(failure("permission_denied","guest native process is not the retained helper's pinned QEMU child in this login"));
            }
            self.server=Some(server);
        }
        #[cfg(all(unix,not(target_os="linux")))] { let _=(helper_pid,native_pid);alive(deadline,&login)?; }
        #[cfg(windows)] {
            use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle, ffi::OsStringExt};
            use windows::{core::PWSTR, Win32::{Foundation::HANDLE, Storage::FileSystem::FILE_FLAG_OVERLAPPED, System::{Pipes::GetNamedPipeServerProcessId, RemoteDesktop::ProcessIdToSessionId, Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, QueryFullProcessImageNameW, PROCESS_NAME_WIN32}, Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, TH32CS_SNAPPROCESS, PROCESSENTRY32W, Process32FirstW, Process32NextW}}}};
            let file = loop {
                alive(deadline, &login)?;
                match fs::OpenOptions::new().read(true).write(true).custom_flags(FILE_FLAG_OVERLAPPED.0).open(&self.pipe_name) {
                    Ok(file) => break file,
                    Err(e) if matches!(e.raw_os_error(), Some(2 | 231)) => std::thread::sleep(Duration::from_millis(5)),
                    Err(e) => return Err(io_error(e)),
                }
            };
            unsafe {
                let mut pid = 0;
                GetNamedPipeServerProcessId(HANDLE(file.as_raw_handle()), &mut pid).map_err(|e| failure("permission_denied", e))?;
                if pid!=native_pid{return Err(failure("permission_denied","guest pipe server differs from the owned helper's native child bootstrap"));}
                let server = crate::windows::OwnedHandle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid).map_err(|e| failure("permission_denied", e))?);
                let snapshot = crate::windows::OwnedHandle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|e| failure("permission_denied", e))?);
                let mut row = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
                let mut valid = Process32FirstW(snapshot.0, &mut row).is_ok();
                let mut owned = false;
                while valid { if row.th32ProcessID == pid { owned = row.th32ParentProcessID == helper_pid; break; } valid = Process32NextW(snapshot.0, &mut row).is_ok(); }
                let mut session = 0;
                ProcessIdToSessionId(pid, &mut session).map_err(|e| failure("permission_denied", e))?;
                let identity = crate::windows::identity().map_err(io_error)?;
                let mut image = vec![0u16; 32768]; let mut size = image.len() as u32;
                QueryFullProcessImageNameW(server.0, PROCESS_NAME_WIN32, PWSTR(image.as_mut_ptr()), &mut size).map_err(|e| failure("permission_denied", e))?;
                let executable = PathBuf::from(std::ffi::OsString::from_wide(&image[..size as usize]));
                let (expected, _) = crate::native_library::pinned_spec("INTERCEPTOR_QEMU_SYSTEM")?;
                if !owned || session.to_string() != crate::windows::session() || crate::windows::sid(server.0).map_err(|e| failure("permission_denied", e))? != identity["sid"] || fs::canonicalize(executable).map_err(io_error)? != fs::canonicalize(expected).map_err(io_error)? {
                    return Err(failure("permission_denied", "guest pipe server is not this helper's retained QEMU child in the current user and session"));
                }
                self.server = Some(server);
            }
            self.pipe = Some(file);
        }
        Ok(())
    }
    pub(crate) fn native_exited(&self)->Result<bool>{
        #[cfg(target_os="linux")] {
            use std::os::fd::AsRawFd;
            let server=self.server.as_ref().ok_or_else(||failure("timeout_unknown_outcome","QEMU process identity was not retained; native exit is unresolved"))?;
            let mut fd=libc::pollfd{fd:server.pidfd().as_raw_fd(),events:libc::POLLIN,revents:0};
            let result=unsafe{libc::poll(&mut fd,1,0)};
            if result<0{return Err(io_error(io::Error::last_os_error()));}
            if result==0{return Ok(false);}
            if fd.revents&libc::POLLIN!=0{return Ok(true);}
            Err(failure("timeout_unknown_outcome","retained QEMU pidfd has an unresolved exit event"))
        }
        #[cfg(windows)] unsafe{
            use windows::Win32::{Foundation::{WAIT_OBJECT_0,WAIT_TIMEOUT},System::Threading::WaitForSingleObject};
            let server=self.server.as_ref().ok_or_else(||failure("timeout_unknown_outcome","QEMU process handle was not retained; native exit is unresolved"))?;
            match WaitForSingleObject(server.0,0){WAIT_OBJECT_0=>Ok(true),WAIT_TIMEOUT=>Ok(false),_=>Err(io_error(io::Error::last_os_error()))}
        }
        #[cfg(not(any(windows,target_os="linux")))]Err(failure("unsupported_operation","portable QEMU process identity requires Linux or Windows"))
    }
    fn write(&mut self, bytes: &[u8], deadline: Instant, login: &impl Fn() -> Result<()>) -> Result<()> {
        if bytes.len() > WIRE_BYTES { return Err(failure("resource_limit", "guest request exceeds 2MiB")); }
        let mut offset = 0;
        while offset < bytes.len() {
            alive(deadline, login)?;
            let end = (offset + 4096).min(bytes.len());
            #[cfg(unix)] let result = self.input.write(&bytes[offset..end]);
            #[cfg(windows)] let result = crate::windows::deadline_pipe_write(self.pipe.as_ref().ok_or_else(|| failure("target_gone", "guest channel not connected"))?, &bytes[offset..end], deadline.saturating_duration_since(Instant::now()).as_millis().max(1).min(50000) as u32);
            match result { Ok(0) => return Err(failure("target_gone", "guest channel closed while writing")), Ok(n) => offset += n, Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => std::thread::sleep(Duration::from_millis(2)), Err(e) => return Err(io_error(e)) }
        }
        Ok(())
    }
    fn message(&mut self, deadline: Instant, login: &impl Fn() -> Result<()>, sentinel: bool) -> Result<Value> {
        let mut got_sentinel = !sentinel;
        let mut discarded = 0usize;
        loop {
            alive(deadline, login)?;
            if sentinel && !got_sentinel {
                if let Some(i) = self.buffer.iter().position(|b| *b == 0xff) { self.buffer.drain(..=i); got_sentinel = true; }
                else { discarded += self.buffer.len(); self.buffer.clear(); if discarded > WIRE_BYTES { return Err(failure("resource_limit", "guest synchronization discarded more than 2MiB")); } }
            }
            if got_sentinel {
                if let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
                    if end + 1 > WIRE_BYTES { return Err(failure("resource_limit", "guest response exceeds 2MiB")); }
                    let line = self.buffer.drain(..=end).collect::<Vec<_>>();
                    if line.contains(&0xff) { return Err(failure("provider_failed", "unexpected guest synchronization sentinel")); }
                    return serde_json::from_slice(&line).map_err(|e| failure("provider_failed", format!("invalid guest-agent JSON: {e}")));
                }
                if self.buffer.len() > WIRE_BYTES { return Err(failure("resource_limit", "guest response exceeds 2MiB")); }
            }
            let mut bytes = [0u8; 8192];
            #[cfg(unix)] let result = crate::auth::ready_read(&mut self.output, &mut bytes);
            #[cfg(windows)] let result = crate::windows::available_pipe_read(self.pipe.as_ref().ok_or_else(|| failure("target_gone", "guest channel not connected"))?, &mut bytes);
            match result { Ok(0) => return Err(failure("target_gone", "owned guest channel closed")), Ok(n) => self.buffer.extend_from_slice(&bytes[..n]), Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => std::thread::sleep(Duration::from_millis(2)), Err(e) => return Err(io_error(e)) }
        }
    }
    fn poison(&mut self, e: Value) -> Value {
        let out = json!({"success":false,"code":"timeout_unknown_outcome","error":"guest channel outcome is unresolved; stop and restart this owned VM before another guest request","details":{"nativeError":e,"observeBeforeRetry":true}});
        self.unknown = Some(out.clone()); out
    }
    fn rpc(&mut self, command: &str, args: Value, deadline: Instant, login: &impl Fn() -> Result<()>, sync: Option<u64>) -> Result<Value> {
        if let Some(e) = &self.unknown { return Err(e.clone()); }
        alive(deadline, login)?;
        let id = crate::secret_target::random_token().map_err(io_error)?;
        let mut bytes = serde_json::to_vec(&json!({"execute":command,"arguments":args,"id":id})).map_err(|e| failure("provider_failed", e))?;
        if sync.is_some() { bytes.insert(0, 0xff); }
        bytes.push(b'\n');
        if bytes.len() > WIRE_BYTES { return Err(failure("resource_limit", "guest request exceeds 2MiB")); }
        if let Err(e) = self.write(&bytes, deadline, login) { return Err(self.poison(e)); }
        let reply = match self.message(deadline, login, sync.is_some()) { Ok(v) => v, Err(e) => return Err(self.poison(e)) };
        if reply["id"] != id || reply.get("return").is_some() == reply.get("error").is_some() { return Err(self.poison(failure("provider_failed", "guest reply has a different ID or contradictory result"))); }
        if let Some(error) = reply.get("error") { return Err(failure(if error["class"] == "CommandNotFound" { "not_installed" } else { "provider_failed" }, format!("guest-agent {command} refused: {}", error["desc"].as_str().unwrap_or("native error").chars().take(1024).collect::<String>()))); }
        let result = reply["return"].clone();
        if sync.is_some_and(|n| result.as_u64() != Some(n)) { return Err(self.poison(failure("provider_failed", "guest synchronization identity differs"))); }
        Ok(result)
    }
    pub(crate) fn ready(&mut self, deadline: Instant, login: impl Fn() -> Result<()>) -> Result<()> {
        if let Some(e) = &self.unknown { return Err(e.clone()); }
        if self.enabled.is_some() { return alive(deadline, &login); }
        let token = crate::secret_target::random_token().map_err(io_error)?;
        let nonce = u64::from_str_radix(&token[..12], 16).map_err(|e| failure("provider_failed", e))?;
        self.rpc("guest-sync-delimited", json!({"id":nonce}), deadline, &login, Some(nonce))?;
        let info = self.rpc("guest-info", json!({}), deadline, &login, None)?;
        if info["version"] != "9.2.4" { return Err(failure("version_mismatch", "portable guest source requires QEMU guest-agent 9.2.4")); }
        let rows = info["supported_commands"].as_array().filter(|r| r.len() <= 512).ok_or_else(|| failure("provider_failed", "guest command inventory is absent or oversized"))?;
        let mut enabled = BTreeSet::new(); let mut seen = BTreeSet::new();
        for row in rows {
            let name = row["name"].as_str().filter(|s| !s.is_empty() && s.len() <= 128).ok_or_else(|| failure("provider_failed", "invalid guest command name"))?;
            if !seen.insert(name.to_owned()) || row["enabled"].as_bool().is_none() || row["success-response"].as_bool().is_none() { return Err(failure("provider_failed", "invalid guest command availability")); }
            if row["enabled"] == true && row["success-response"] == true { enabled.insert(name.to_owned()); }
        }
        self.enabled = Some(enabled); Ok(())
    }
    fn require(&mut self, commands: &[&str], deadline: Instant, login: &impl Fn() -> Result<()>) -> Result<()> {
        self.ready(deadline, login)?;
        if commands.iter().any(|c| !self.enabled.as_ref().is_some_and(|e| e.contains(*c))) { return Err(failure("not_installed", "required guest-agent command is disabled or has no success response")); }
        Ok(())
    }
    fn exec(&mut self, argv: &[String], env: Option<&Value>, input: Option<&[u8]>, deadline: Instant, login: &impl Fn() -> Result<()>) -> Result<Value> {
        self.require(&["guest-exec", "guest-exec-status"], deadline, login)?;
        let started = Instant::now();
        let mut args = json!({"path":argv[0],"arg":&argv[1..],"capture-output":"separated"});
        if let Some(env) = env { args["env"] = json!(env.as_object().unwrap().iter().map(|(k,v)| format!("{k}={}", v.as_str().unwrap())).collect::<Vec<_>>()); }
        if let Some(input) = input { if input.len() > FILE_BYTES { return Err(failure("resource_limit", "guest stdin exceeds 1MiB")); } args["input-data"] = json!(STANDARD.encode(input)); }
        let launch = self.rpc("guest-exec", args, deadline, login, None)?;
        let pid = launch["pid"].as_i64().filter(|p| *p > 0).ok_or_else(|| self.poison(failure("provider_failed", "guest execution omitted its actual PID")))?;
        loop {
            let result = self.rpc("guest-exec-status", json!({"pid":pid}), deadline, login, None);
            let status = match result { Ok(s) => s, Err(e) => { let mut e = self.poison(e); e["details"]["guestPid"] = json!(pid); self.unknown = Some(e.clone()); return Err(e); } };
            match status["exited"].as_bool() {
                Some(false) => { std::thread::sleep(Duration::from_millis(10)); continue; }
                Some(true) => (),
                None => return Err(self.poison(failure("provider_failed", "guest execution status omitted exit state"))),
            }
            if ["out-truncated", "err-truncated"].iter().any(|k| status.get(*k).is_some_and(|v| v.as_bool().is_none())) {
                return Err(failure("partial_result", "guest exit report has invalid output truncation fields"));
            }
            if status.get("signal").is_some() || status["out-truncated"] == true || status["err-truncated"] == true {
                let mut e = failure("partial_result", "guest process exited abnormally or truncated captured output; its effects must be inspected"); e["details"] = json!({"guestPid":pid,"signal":status.get("signal"),"exitCode":status.get("exitcode"),"stdoutTruncated":status["out-truncated"],"stderrTruncated":status["err-truncated"]}); return Err(e);
            }
            let code = status["exitcode"].as_i64().filter(|n| i32::try_from(*n).is_ok()).ok_or_else(|| failure("partial_result", "guest exited without an actual exit code"))?;
            let output = |key: &str| -> Result<Vec<u8>> { let text = status.get(key).map(|v| v.as_str().ok_or_else(|| failure("partial_result", "guest output is not base64 text"))).transpose()?.unwrap_or(""); decode(text, OUTPUT_BYTES) };
            let stdout = output("out-data")?; let stderr = output("err-data")?;
            if stdout.len() + stderr.len() > OUTPUT_BYTES { return Err(failure("partial_result", "guest output exceeds 128KiB; process effects were not rolled back")); }
            let stdout = String::from_utf8(stdout).map_err(|_| failure("partial_result", "guest stdout is not UTF8; no replacement text was invented"))?;
            let stderr = String::from_utf8(stderr).map_err(|_| failure("partial_result", "guest stderr is not UTF8; no replacement text was invented"))?;
            return Ok(json!({"exitCode":code,"stdout":stdout,"stderr":stderr,"durationMs":started.elapsed().as_millis() as u64}));
        }
    }
    pub(crate) fn execute(&mut self, action: &Value, deadline: Instant, login: impl Fn() -> Result<()>) -> Result<Value> {
        if action.get("user").is_some() || action.get("workdir").is_some() || action["tty"] == true { return Err(failure("unsupported_operation", "QEMU guest-exec has no user, working-directory or TTY selector; no field was ignored")); }
        let argv = action["command"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect::<Vec<_>>();
        self.exec(&argv, action.get("env"), None, deadline, &login).map(success)
    }
    fn read_file(&mut self, path: &str, deadline: Instant, login: &impl Fn() -> Result<()>) -> Result<Vec<u8>> {
        self.require(&["guest-file-open", "guest-file-read", "guest-file-close"], deadline, login)?;
        let handle = self.rpc("guest-file-open", json!({"path":path,"mode":"rb"}), deadline, login, None)?.as_i64().filter(|h| *h >= 0).ok_or_else(|| self.poison(failure("provider_failed", "guest open returned no actual handle")))?;
        let outcome = (|| -> Result<Vec<u8>> {
            let mut bytes = vec![];
            loop {
                let result = self.rpc("guest-file-read", json!({"handle":handle,"count":CHUNK}), deadline, login, None)?;
                let count = result["count"].as_u64().filter(|n| *n <= CHUNK as u64).ok_or_else(|| failure("provider_failed", "invalid guest read count"))? as usize;
                let text = result.get("buf-b64").map(|v| v.as_str().ok_or_else(|| failure("provider_failed", "invalid guest read encoding"))).transpose()?.unwrap_or("");
                let chunk = decode(text, CHUNK)?;
                let eof = result["eof"].as_bool().ok_or_else(|| failure("provider_failed", "guest read omitted EOF state"))?;
                if chunk.len() != count || count == 0 && !eof { return Err(failure("provider_failed", "guest read bytes differ or make no progress")); }
                if bytes.len() + count > FILE_BYTES { return Err(failure("resource_limit", "guest file exceeds 1MiB")); }
                bytes.extend(chunk);
                if eof { return Ok(bytes); }
            }
        })();
        if self.unknown.is_some() { return outcome; }
        let close = self.rpc("guest-file-close", json!({"handle":handle}), deadline, login, None);
        match (outcome, close) { (Ok(bytes), Ok(_)) => Ok(bytes), (Err(e), Ok(_)) => Err(e), (_, Err(e)) => Err(self.poison(e)) }
    }
    pub(crate) fn copy(&mut self, action: &Value, deadline: Instant, login: impl Fn() -> Result<()>) -> Result<Value> {
        let name = action["name"].as_str().unwrap(); let src = action["src"].as_str().unwrap(); let dst = action["dst"].as_str().unwrap();
        let prefix = format!("{name}:");
        let incoming = dst.starts_with(&prefix); let outgoing = src.starts_with(&prefix);
        if incoming == outgoing { return Err(failure("invalid_request", "VM copy requires exactly one side in this VM and one host file")); }
        let guest = if incoming { &dst[prefix.len()..] } else { &src[prefix.len()..] };
        if !guest.starts_with('/') || guest.len() > 4096 || guest.contains('\0') || guest.split('/').any(|p| matches!(p, "." | "..")) { return Err(failure("invalid_request", "guest copy requires a bounded absolute Linux path without dot traversal")); }
        let host = crate::filesystem::absolute(if incoming { src } else { dst })?;
        // Resolve and check host syntax before guest mutation. Private_file
        // supplies exclusive output; the existing bounded source reader
        // retains readable host inputs without requiring private permissions.
        let bytes = if incoming {
            let bytes = crate::thumbnail::bounded_source_bytes(&host, FILE_BYTES, true)?;
            self.require(&["guest-exec", "guest-exec-status", "guest-file-open", "guest-file-read", "guest-file-close"], deadline, &login)?;
            // noclobber alone can open existing nonregular targets. Refuse
            // every pre-existing name (including dangling links) first.
            let argv = vec!["/bin/sh".into(), "-c".into(), "if [ -e \"$1\" ] || [ -L \"$1\" ]; then exit 73; fi; set -C; umask 077; exec 3>\"$1\" || exit 73; /bin/cat >&3".into(), "interceptor-cp".into(), guest.into()];
            let written = self.exec(&argv, None, Some(&bytes), deadline, &login).map_err(|e| {
                json!({"success":false,"code":if e["code"] == "timeout_unknown_outcome" {"timeout_unknown_outcome"} else {"partial_result"},"error":"guest copy execution did not provide a complete outcome; inspect the exact destination before retrying","details":{"nativeError":e,"destination":dst,"partialArtifactPossible":true,"observeBeforeRetry":true}})
            })?;
            if written["exitCode"] != 0 { let mut e = failure("partial_result", "guest exclusive copy did not exit successfully; inspect the exact destination before retrying"); e["details"] = json!({"execution":written,"destination":dst}); return Err(e); }
            let readback = self.read_file(guest, deadline, &login)?;
            if readback != bytes { return Err(failure("partial_result", "guest copy readback differs; destination preserved")); }
            bytes
        } else {
            // Download admission leaves existing host files untouched, even
            // when the guest returns an error, a directory or excessive bytes.
            if fs::symlink_metadata(&host).is_ok() { return Err(failure("unsupported_target", "host copy destination already exists; no file was replaced")); }
            let bytes = self.read_file(guest, deadline, &login)?;
            alive(deadline, &login)?;
            host_output(&host,&bytes,deadline,&login)?;
            #[cfg(target_os = "linux")] if let Some(parent) = host.parent() { File::open(parent).and_then(|d| d.sync_all()).map_err(io_error)?; }
            bytes
        };
        alive(deadline, &login)?;
        let digest = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>();
        Ok(success(json!({"name":name,"direction":if incoming { "host-to-guest" } else { "guest-to-host" },"source":src,"path":dst,"bytes":bytes.len(),"sha256":digest,"verified":true,"overwrite":false})))
    }
}
fn host_output(path:&Path,bytes:&[u8],deadline:Instant,login:&impl Fn()->Result<()>)->Result<()>{
    if bytes.len()>FILE_BYTES{return Err(failure("resource_limit","host guest download exceeds 1MiB"));}
    alive(deadline,login)?;
    let outcome=(||->Result<()>{
        let mut writer=crate::monitor::private_file(path,true).map_err(io_error)?;
        let mut reader=crate::monitor::retained_private_reader(&writer,path).map_err(io_error)?;
        writer.write_all(bytes).and_then(|_|writer.sync_all()).map_err(io_error)?;
        alive(deadline,login)?;
        let before=reader.metadata().map_err(io_error)?;
        reader.seek(SeekFrom::Start(0)).map_err(io_error)?;
        let mut readback=vec![];Read::by_ref(&mut reader).take(FILE_BYTES as u64+1).read_to_end(&mut readback).map_err(io_error)?;
        let after=reader.metadata().map_err(io_error)?;
        if readback!=bytes||before.len()!=bytes.len()as u64||after.len()!=before.len()||before.modified().map_err(io_error)?!=after.modified().map_err(io_error)?
            ||!crate::monitor::same_private_file(&writer,&reader).map_err(io_error)?||!crate::monitor::private_path_matches(&writer,path).map_err(io_error)?{
            return Err(failure("partial_result","host download retained bytes or native path identity differ; partial artifact preserved"));
        }
        alive(deadline,login)
    })();
    outcome.map_err(|error|{
        let code=if error["code"]=="timeout_unknown_outcome"{"timeout_unknown_outcome"}else if error["code"]=="unsupported_target"{"unsupported_target"}else{"partial_result"};
        json!({"success":false,"code":code,"error":"host guest download did not complete retained-file verification; inspect the exact destination before retrying","details":{"nativeError":error,"path":path,"partialArtifactPossible":true,"observeBeforeRetry":true}})
    })
}
fn decode(text: &str, limit: usize) -> Result<Vec<u8>> {
    if text.len() > limit.div_ceil(3) * 4 { return Err(failure("resource_limit", "guest encoded bytes exceed the requested bound")); }
    let bytes = STANDARD.decode(text).map_err(|_| failure("provider_failed", "guest bytes are not canonical base64"))?;
    if bytes.len() > limit || STANDARD.encode(&bytes) != text { return Err(failure("provider_failed", "guest bytes are not bounded canonical base64")); }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(any(windows,target_os="linux"))]#[test]fn host_download_retains_created_bytes_and_never_replaces_existing_output(){
        let directory=std::env::temp_dir().join(format!("itc-qga-download-{}",crate::monitor::identifier()));crate::monitor::private_directory(&directory,true,false).unwrap();
        let path=directory.join("验证.bin");let bytes=b"owned actual guest bytes\0\xff";
        host_output(&path,bytes,Instant::now()+Duration::from_secs(5),&||Ok(())).unwrap();assert_eq!(fs::read(&path).unwrap(),bytes);
        assert!(host_output(&path,b"replacement",Instant::now()+Duration::from_secs(5),&||Ok(())).is_err());assert_eq!(fs::read(&path).unwrap(),bytes);
        let expired=directory.join("expired.bin");assert!(host_output(&expired,bytes,Instant::now(),&||Ok(())).is_err());assert!(!expired.exists());
        let oversized=directory.join("oversized.bin");assert!(host_output(&oversized,&vec![0;FILE_BYTES+1],Instant::now()+Duration::from_secs(5),&||Ok(())).is_err());assert!(!oversized.exists());
        let empty=directory.join("empty.bin");host_output(&empty,&[],Instant::now()+Duration::from_secs(5),&||Ok(())).unwrap();assert_eq!(fs::metadata(empty).unwrap().len(),0);
        fs::remove_dir_all(directory).unwrap();
    }
    #[cfg(target_os="linux")]#[test]fn replacement_during_download_observation_is_refused_without_reading_or_overwriting_it(){
        use std::cell::Cell;
        let directory=std::env::temp_dir().join(format!("itc-qga-download-race-{}",crate::monitor::identifier()));crate::monitor::private_directory(&directory,true,false).unwrap();
        let path=directory.join("download.bin");let original=directory.join("original.bin");let calls=Cell::new(0);
        let observed=||{let n=calls.get()+1;calls.set(n);if n==2{fs::rename(&path,&original).unwrap();let mut foreign=crate::monitor::private_file(&path,true).unwrap();foreign.write_all(b"replacement bytes").unwrap();foreign.sync_all().unwrap();}Ok(())};
        let error=host_output(&path,b"actual guest bytes",Instant::now()+Duration::from_secs(5),&observed).unwrap_err();
        assert_eq!(error["code"],"partial_result");assert_eq!(fs::read(&path).unwrap(),b"replacement bytes");assert_eq!(fs::read(original).unwrap(),b"actual guest bytes");
        fs::remove_dir_all(directory).unwrap();
    }
    #[test] fn guest_tokens_and_base64_have_strict_bounds() {
        assert!(!token_valid("../foreign")); assert!(!token_valid(&"z".repeat(64))); assert!(token_valid(&"a1".repeat(32)));
        assert_eq!(decode("AAEC", 3).unwrap(), vec![0,1,2]); assert!(decode("AAEC", 2).is_err()); assert!(decode("AAEC\n", 4).is_err()); assert!(decode("AB==", 4).is_err());
    }
    #[test] fn existing_source_reader_enforces_the_vm_byte_cap_without_private_mode_requirement() {
        let root = std::env::temp_dir().join(format!("itc-guest-input-{}", crate::monitor::identifier()));
        crate::monitor::private_directory(&root, true, false).unwrap(); let path = root.join("input.bin");
        let mut file = fs::OpenOptions::new().create_new(true).write(true).open(&path).unwrap(); file.write_all(&[0,1,2,3]).unwrap(); drop(file);
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(); }
        assert_eq!(crate::thumbnail::bounded_source_bytes(&path, 4, true).unwrap(), vec![0,1,2,3]);
        assert!(crate::thumbnail::bounded_source_bytes(&path, 3, true).is_err());
        #[cfg(unix)] { let link = root.join("alias.bin"); std::os::unix::fs::symlink(&path, &link).unwrap(); assert!(crate::thumbnail::bounded_source_bytes(&link, 4, true).is_err()); assert_eq!(crate::thumbnail::source_bytes(&link).unwrap(), vec![0,1,2,3]); }
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)] #[test] fn exact_private_fifos_are_required_and_owned_names_retire() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("itc-guest-channel-{}", crate::monitor::identifier()));
        crate::monitor::private_directory(&root, true, false).unwrap();
        let channel = Channel::create(&root, "fixture").unwrap(); let directory = channel.directory.clone();
        assert!(helper_args(&root, "fixture", channel.token()).unwrap().iter().any(|a| a.contains("org.qemu.guest_agent.0")));
        drop(channel); assert!(!directory.exists());
        let channel = Channel::create(&root, "fixture").unwrap(); let path = channel.directory.join("channel.in");
        fs::remove_file(&path).unwrap(); symlink(channel.directory.join("channel.out"), &path).unwrap();
        assert!(helper_args(&root, "fixture", channel.token()).is_err()); drop(channel);
        // Replacement names are deliberately preserved by Channel::drop.
        fs::remove_dir_all(root).unwrap();
    }
    // Protocol fixtures exercise byte framing and refusal. They do not boot
    // QEMU, provide guest authority or qualify native installed behavior.
    #[cfg(unix)] fn receive_request(file: &mut File) -> Value {
        let deadline = Instant::now() + Duration::from_secs(2); let mut out = vec![];
        loop {
            assert!(Instant::now() < deadline);
            let mut byte = [0u8; 1];
            match crate::auth::ready_read(file, &mut byte) {
                Ok(1) => { if byte[0] != 0xff { out.push(byte[0]); } if byte[0] == b'\n' { return serde_json::from_slice(&out).unwrap(); } }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(1)),
                other => panic!("fixture input failed: {other:?}"),
            }
        }
    }
    #[cfg(unix)] #[test] fn sync_ignores_old_bytes_and_refuses_a_response_from_another_request() {
        let root = std::env::temp_dir().join(format!("itc-guest-wire-{}", crate::monitor::identifier())); crate::monitor::private_directory(&root, true, false).unwrap();
        let mut channel = Channel::create(&root, "fixture").unwrap();
        let mut input = channel.input.try_clone().unwrap(); let mut output = channel.output.try_clone().unwrap();
        let writer = std::thread::spawn(move || {
            let sync = receive_request(&mut input);
            output.write_all(b"old unfinished JSON\xff").unwrap();
            let mut response = serde_json::to_vec(&json!({"id":sync["id"],"return":sync["arguments"]["id"]})).unwrap(); response.push(b'\n'); output.write_all(&response).unwrap();
            let info = receive_request(&mut input); assert_eq!(info["execute"], "guest-info");
            output.write_all(b"{\"id\":\"another-request\",\"return\":{}}\n").unwrap();
        });
        assert!(channel.ready(Instant::now() + Duration::from_secs(2), || Ok(())).is_err()); writer.join().unwrap();
        assert!(channel.unknown.is_some());
        let refused = channel.ready(Instant::now() + Duration::from_secs(2), || Ok(())).unwrap_err(); assert_eq!(refused["code"], "timeout_unknown_outcome");
        drop(channel); fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)] #[test] fn absent_agent_hits_the_deadline_and_cannot_replay_a_request() {
        let root = std::env::temp_dir().join(format!("itc-guest-deadline-{}", crate::monitor::identifier())); crate::monitor::private_directory(&root, true, false).unwrap();
        let mut channel = Channel::create(&root, "fixture").unwrap();
        let error = channel.ready(Instant::now() + Duration::from_millis(10), || Ok(())).unwrap_err();
        assert_eq!(error["code"], "timeout_unknown_outcome"); assert!(channel.enabled.is_none()); assert!(channel.unknown.is_some());
        drop(channel); fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os="linux")]#[test]fn unresolved_native_identity_preserves_launched_endpoint_names(){
        let root=std::env::temp_dir().join(format!("itc-guest-unresolved-{}",crate::monitor::identifier()));crate::monitor::private_directory(&root,true,false).unwrap();
        let mut channel=Channel::create(&root,"fixture").unwrap();let directory=channel.directory.clone();
        assert!(channel.native_exited().is_err());channel.mark_launched();drop(channel);
        assert!(directory.join("channel.in").exists());assert!(directory.join("channel.out").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
