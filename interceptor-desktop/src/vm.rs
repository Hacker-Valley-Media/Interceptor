//! Portable guest lifecycle. QMP belongs to an exact child, never a discovered
//! PID or a public monitor socket. Guest-agent operations have separate authority.
use crate::{contract_generated::*, failure, success};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{ChildStdin, ChildStdout, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, Value>;
#[path="vm_frame.rs"]mod frame;
const MAX_DISK: u64 = 64 * 1024 * 1024 * 1024;
const MAX_META: usize = 65536;
const MAX_QMP: usize = 131072;
const QEMU_VERSION: &str = "9.2.4";
fn error(e: io::Error) -> Value {
    failure(
        match e.kind() {
            io::ErrorKind::PermissionDenied => "permission_denied",
            io::ErrorKind::NotFound => "target_gone",
            io::ErrorKind::TimedOut => "timeout_unknown_outcome",
            _ => "provider_failed",
        },
        e,
    )
}
fn safe(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_alphanumeric() || i > 0 && [b'_', b'-'].contains(&b))
}
fn now() -> Result<String> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|e| failure("provider_failed", e))
}
fn deadline_alive(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        Err(failure(
            "timeout_unknown_outcome",
            "VM admission deadline expired; inspect owned artifacts before retrying",
        ))
    } else {
        Ok(())
    }
}
pub fn validate(a: &Value) -> Result<()> {
    if let Some(e) = desktop_vm_shape_error(a) {
        return Err(failure("invalid_request", e));
    }
    let sub = a["sub"].as_str().unwrap();
    let fields: &[&str] = match sub {
        "create" => &[
            "kind",
            "cpu",
            "memorySize",
            "diskSize",
            "image",
            "imageFormat",
            "network",
            "rosetta",
            "shares",
        ],
        "adopt" => &[
            "sourcePath",
            "kind",
            "provider",
            "mode",
            "installAgent",
            "waitForAgent",
            "imageFormat",
        ],
        "clone" => &["src", "dst"],
        "install" => &["ipsw", "fromLatest"],
        "pull" => &["image"],
        "list" | "get" | "inspect" | "pause" | "resume" | "reset" => &[],
        "start" => &["headless", "waitForAgent", "waitForVsock", "detach"],
        "stop" => &["force", "timeout"],
        "delete" => &["force", "keepDisk"],
        "exec" => &["command", "env", "user", "workdir", "tty", "timeout"],
        "snapshot" => &["tag", "snapshotOp", "diskOnly", "pausedStateOnly"],
        "restore" => &["tag", "diskOnly", "pausedStateOnly", "headless"],
        "cp" => &["src", "dst", "timeout"],
        "share" => &["hostPath", "tag", "readOnly"],
        "mount" => &["tag", "path", "timeout"],
        "port_forward" => &["hostAddress", "hostPort", "guestPort"],
        "screenshot" => &["out", "timeout"],
        "type" => &["text", "timeout"],
        "click" => &["x", "y", "button", "timeout"],
        "keys" => &["keys", "timeout"],
        "read_ax" => &["max_depth", "app", "timeout"],
        "console" => &["write", "maxBytes", "timeout"],
        "logs" => &["limit", "timeout"],
        "trust" => &[
            "noPrompt",
            "prompt",
            "walkthrough",
            "accessibilityPrompt",
            "screenPrompt",
            "resetDenied",
            "timeout",
        ],
        "tcc_profile_generate" => &[
            "services",
            "out",
            "bundleId",
            "appPath",
            "identifierType",
            "codeRequirement",
            "fullDisk",
            "includeUserOnly",
        ],
        _ => return Err(failure("invalid_request", "unknown VM selector")),
    };
    if a.as_object().unwrap().keys().any(|k| {
        !["type", "sub", "name", "stateDir"].contains(&k.as_str()) && !fields.contains(&k.as_str())
    }) {
        return Err(failure(
            "invalid_request",
            "field does not belong to VM selector",
        ));
    }
    if if ["list", "pull", "clone"].contains(&sub) {
        a.get("name").is_some()
    } else {
        !a["name"].as_str().is_some_and(safe)
    } {
        return Err(failure(
            "invalid_request",
            "VM selector requires one exact safe name",
        ));
    }
    for (k, v) in a.as_object().unwrap() {
        if let Some(s) = v.as_str() {
            if s.contains('\0')
                || s.len()
                    > if ["text", "write"].contains(&k.as_str()) {
                        32768
                    } else {
                        4096
                    }
                || s.is_empty() && !["text", "write"].contains(&k.as_str())
            {
                return Err(failure("invalid_request", "invalid bounded VM text"));
            }
        }
    }
    for (k, lo, hi) in [
        ("cpu", 1., 32.),
        ("memorySize", 268435456., 34359738368.),
        ("diskSize", 1048576., MAX_DISK as f64),
        ("timeout", 1., 50.),
        ("maxBytes", 1., 65536.),
        ("limit", 1., 1000.),
        ("max_depth", 1., 64.),
        ("hostPort", 0., 65535.),
        ("guestPort", 1., 65535.),
    ] {
        if a.get(k).is_some_and(|v| {
            v.as_f64()
                .is_none_or(|n| !n.is_finite() || n.fract() != 0. || n < lo || n > hi)
        }) {
            return Err(failure("invalid_request", format!("invalid VM {k}")));
        }
    }
    for k in ["x", "y"] {
        if a.get(k).is_some_and(|v| {
            v.as_f64()
                .is_none_or(|n| !n.is_finite() || !(0.0..=16383.0).contains(&n))
        }) {
            return Err(failure(
                "invalid_request",
                "invalid VM physical coordinates",
            ));
        }
    }
    if a["memorySize"].as_f64().is_some_and(|v| v % 1048576. != 0.) {
        return Err(failure(
            "invalid_request",
            "VM memory requires whole MiB in bytes",
        ));
    }
    for (k, values) in [
        ("kind", &["linux", "macos"][..]),
        ("network", &["none", "nat"][..]),
        ("provider", &["auto", "qemu"][..]),
        ("mode", &["clone", "move", "reference"][..]),
        ("imageFormat", &["raw", "qcow2"][..]),
        ("snapshotOp", &["create", "list", "delete", "restore"][..]),
        ("button", &["left", "right", "middle"][..]),
    ] {
        if a.get(k)
            .is_some_and(|v| !v.as_str().is_some_and(|s| values.contains(&s)))
        {
            return Err(failure("invalid_request", format!("invalid VM {k}")));
        }
    }
    let required: &[&str] = match sub {
        "adopt" => &["sourcePath"],
        "clone" | "cp" => &["src", "dst"],
        "pull" => &["image"],
        "exec" => &["command"],
        "restore" => &["tag"],
        "share" => &["hostPath", "tag"],
        "mount" => &["tag", "path"],
        "port_forward" => &["guestPort"],
        "type" => &["text"],
        "click" => &["x", "y"],
        "keys" => &["keys"],
        _ => &[],
    };
    if required.iter().any(|k| a.get(k).is_none()) {
        return Err(failure(
            "invalid_request",
            "VM selector requires exact fields",
        ));
    }
    if a.get("tag").is_some_and(|v| !v.as_str().is_some_and(safe))
        || sub == "snapshot" && a["snapshotOp"] != "list" && !a["tag"].as_str().is_some_and(safe)
        || sub == "clone"
            && (!a["src"].as_str().is_some_and(safe)
                || !a["dst"].as_str().is_some_and(safe)
                || a["src"] == a["dst"])
    {
        return Err(failure("invalid_request", "unsafe VM or snapshot identity"));
    }
    if a["diskOnly"] == true && a["pausedStateOnly"] == true
        || a.get("hostAddress").is_some_and(|v| v != "127.0.0.1")
    {
        return Err(failure(
            "invalid_request",
            "invalid VM mode or forward address",
        ));
    }
    for k in ["stateDir", "sourcePath", "image", "ipsw", "hostPath", "out"] {
        if let Some(s) = a[k].as_str() {
            if !(k == "image" && sub == "pull") {
                crate::filesystem::absolute(s)?;
            }
        }
    }
    if let Some(args) = a["command"].as_array() {
        if args.is_empty()
            || args.len() > 128
            || args.iter().enumerate().any(|(i, v)| {
                v.as_str()
                    .is_none_or(|s| s.contains('\0') || s.len() > 32768 || i == 0 && s.is_empty())
            })
        {
            return Err(failure("invalid_request", "VM requires bounded exact argv"));
        }
    }
    if let Some(env) = a["env"].as_object() {
        if env.len() > 64
            || env.iter().any(|(k, v)| {
                k.is_empty()
                    || k.len() > 128
                    || !k.bytes().enumerate().all(|(i, b)| {
                        b == b'_' || b.is_ascii_alphabetic() || i > 0 && b.is_ascii_digit()
                    })
                    || v.as_str()
                        .is_none_or(|s| s.len() > 32768 || s.contains('\0'))
            })
        {
            return Err(failure("invalid_request", "invalid VM environment"));
        }
    }
    if let Some(shares) = a["shares"].as_array() {
        let mut tags = std::collections::BTreeSet::new();
        if shares.len() > 16
            || shares.iter().any(|s| {
                !s["tag"].as_str().is_some_and(safe)
                    || !tags.insert(s["tag"].as_str().unwrap())
                    || s["hostPath"]
                        .as_str()
                        .is_none_or(|p| crate::filesystem::absolute(p).is_err())
            })
        {
            return Err(failure("invalid_request", "invalid VM shares"));
        }
    }
    if serde_json::to_vec(a).map_or(true, |v| v.len() > 131072) {
        return Err(failure("resource_limit", "VM request exceeds 128KiB"));
    }
    Ok(())
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Spec {
    name: String,
    id: String,
    kind: String,
    cpu: u32,
    memory_size: u64,
    disk_size: u64,
    network: String,
    created_at: String,
    source_digest: Option<String>,
}
impl Spec {
    fn valid(&self) -> bool {
        safe(&self.name)
            && self.id.len() == 36
            && self.id.bytes().enumerate().all(|(i, b)| {
                if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_hexdigit()
                }
            })
            && self.kind == "linux"
            && (1..=32).contains(&self.cpu)
            && (268435456..=34359738368).contains(&self.memory_size)
            && self.memory_size % 1048576 == 0
            && (1048576..=MAX_DISK).contains(&self.disk_size)
            && ["none", "nat"].contains(&self.network.as_str())
            && time::OffsetDateTime::parse(
                &self.created_at,
                &time::format_description::well_known::Rfc3339,
            )
            .is_ok()
            && self
                .source_digest
                .as_ref()
                .is_none_or(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    }
    fn view(&self, status: &str, path: &Path, started: Option<&str>, inspect: bool) -> Value {
        let mut d = json!({"name":self.name,"id":self.id,"kind":self.kind,"status":status,"cpu":self.cpu,"memorySize":self.memory_size,"diskSize":self.disk_size,"network":self.network,"createdAt":self.created_at,"snapshotSupported":true});
        if inspect {
            d["bundlePath"] = json!(path);
        }
        if let Some(s) = started {
            d["startedAt"] = json!(s);
        }
        d
    }
}
struct Lock {
    #[cfg(unix)]
    file: File,
    #[cfg(windows)]
    _handle: File,
}
fn lock(path: &Path) -> Result<Lock> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let file = match crate::monitor::private_file(path, true) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                crate::monitor::private_file(path, false).map_err(error)?
            }
            Err(e) => return Err(error(e)),
        };
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(failure(
                "unsupported_target",
                "owned VM storage is in use; no process identity was guessed",
            ));
        }
        Ok(Lock { file })
    }
    #[cfg(windows)]
    {
        crate::windows::private_lock(path)
            .map(|h| Lock { _handle: h })
            .map_err(error)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err(failure(
            "unsupported_operation",
            "native VM locks unavailable",
        ))
    }
}
fn private_read(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let mut f = crate::monitor::private_file(path, false).map_err(error)?;
    if f.metadata().map_err(error)?.len() > limit as u64 {
        return Err(failure(
            "resource_limit",
            "private VM metadata exceeds bound",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut f)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() > limit {
        return Err(failure(
            "resource_limit",
            "private VM metadata grew beyond bound",
        ));
    }
    Ok(bytes)
}
fn private_json(path: &Path, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|e| failure("provider_failed", e))?;
    if bytes.len() > MAX_META {
        return Err(failure("resource_limit", "VM metadata exceeds 64KiB"));
    }
    let mut f = crate::monitor::private_file(path, true).map_err(error)?;
    f.write_all(&bytes)
        .and_then(|_| f.sync_all())
        .map_err(error)?;
    drop(f);
    if private_read(path, MAX_META)? != bytes {
        return Err(failure(
            "timeout_unknown_outcome",
            "VM metadata readback differs; prepared artifacts preserved",
        ));
    }
    Ok(())
}
fn qcow_header(path: &Path) -> Result<u64> {
    // QEMU9.2.4 fixes these big-endian header offsets. Refuse external
    // pointers before admitting a file to the native image driver.
    let mut file = crate::monitor::private_file(path, false).map_err(error)?;
    if file.metadata().map_err(error)?.len() > MAX_DISK + 536870912 {
        return Err(failure(
            "resource_limit",
            "VM qcow2 file exceeds its physical bound",
        ));
    }
    let mut header = [0_u8; 104];
    file.read_exact(&mut header[..72]).map_err(error)?;
    let version = u32::from_be_bytes(header[4..8].try_into().unwrap());
    if header[..4] != [b'Q', b'F', b'I', 0xfb]
        || ![2, 3].contains(&version)
        || u64::from_be_bytes(header[8..16].try_into().unwrap()) != 0
        || u32::from_be_bytes(header[32..36].try_into().unwrap()) != 0
    {
        return Err(failure(
            "unsupported_target",
            "VM disk requires unencrypted qcow2 without backing files",
        ));
    }
    if version == 3 {
        file.read_exact(&mut header[72..]).map_err(error)?;
        let flags = u64::from_be_bytes(header[72..80].try_into().unwrap());
        if flags & 7 != 0 || flags & !31 != 0 {
            return Err(failure(
                "unsupported_target",
                "VM disk is dirty, corrupt, external-data or has unknown incompatible features; no native pointer was followed",
            ));
        }
    }
    let cluster = u32::from_be_bytes(header[20..24].try_into().unwrap());
    let size = u64::from_be_bytes(header[24..32].try_into().unwrap());
    if !(9..=21).contains(&cluster) || !(1048576..=MAX_DISK).contains(&size) {
        return Err(failure(
            "resource_limit",
            "VM disk header exceeds cluster or size admission",
        ));
    }
    Ok(size)
}
struct Registry {
    root: PathBuf,
    _lock: Lock,
}
impl Registry {
    fn open(a: &Value) -> Result<Self> {
        let root = if let Some(s) = a["stateDir"].as_str() {
            crate::filesystem::absolute(s)?
        } else if let Ok(s) = std::env::var("INTERCEPTOR_VM_STATE_DIR") {
            crate::filesystem::absolute(&s)?
        } else {
            #[cfg(windows)]
            let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
            #[cfg(not(windows))]
            let base = std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/share"))
                });
            let base = base.ok_or_else(|| {
                failure(
                    "not_installed",
                    "VM state requires an existing user data directory or explicit stateDir",
                )
            })?;
            if !base.is_absolute() || !base.is_dir() {
                return Err(failure(
                    "not_installed",
                    "VM user data parent is unavailable; select an existing private state directory",
                ));
            }
            let parent = base.join("Interceptor");
            // On Windows this product folder already exists with inherited ACEs, so the private
            // check belongs on `vms` below, not here (otherwise vm list always failed).
            #[cfg(windows)]
            fs::create_dir_all(&parent).map_err(error)?;
            #[cfg(not(windows))]
            crate::monitor::private_directory(&parent, true, false).map_err(error)?;
            parent.join("vms")
        };
        crate::monitor::private_directory(&root, true, false).map_err(error)?;
        let root = fs::canonicalize(root).map_err(error)?;
        let held = lock(&root.join("registry.lock"))?;
        Ok(Self { root, _lock: held })
    }
    fn bundle(&self, name: &str) -> Result<PathBuf> {
        if !safe(name) {
            return Err(failure("invalid_request", "unsafe VM name"));
        }
        let path = self.root.join(name);
        crate::monitor::private_directory(&path, false, false).map_err(error)?;
        Ok(path)
    }
    fn spec(&self, name: &str) -> Result<Spec> {
        let path = self.bundle(name)?;
        let spec: Spec = serde_json::from_slice(&private_read(&path.join("spec.json"), MAX_META)?)
            .map_err(|e| failure("unsupported_target", e))?;
        if !spec.valid() || spec.name != name {
            return Err(failure(
                "unsupported_target",
                "VM manifest identity or resource limits differ",
            ));
        }
        Ok(spec)
    }
    fn list(&self) -> Result<Vec<Spec>> {
        let mut out = vec![];
        for entry in fs::read_dir(&self.root).map_err(error)? {
            let entry = entry.map_err(error)?;
            if !entry.file_type().map_err(error)?.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                return Err(failure(
                    "unsupported_target",
                    "VM registry contains non-UTF8 names",
                ));
            };
            out.push(self.spec(&name)?);
            if out.len() > 128 {
                return Err(failure("resource_limit", "VM registry exceeds 128 guests"));
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }
}
fn copy_raw(source: &Path, destination: &Path, deadline: Instant) -> Result<(u64, String)> {
    #[cfg(unix)]
    let mut source = {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(source)
            .map_err(error)?
    };
    #[cfg(windows)]
    let mut source = {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .custom_flags(0x00200000)
            .open(source)
            .map_err(error)?
    };
    let before = source.metadata().map_err(error)?;
    if !before.is_file() || before.len() < 1048576 || before.len() > MAX_DISK {
        return Err(failure(
            "unsupported_target",
            "VM raw image requires a regular file from 1MiB to 64GiB",
        ));
    }
    let mut out = crate::monitor::private_file(destination, true).map_err(error)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    let mut total = 0;
    loop {
        deadline_alive(deadline)?;
        let n = source.read(&mut buffer).map_err(error)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > before.len() {
            return Err(failure(
                "unsupported_target",
                "source image grew during import; prepared copy preserved",
            ));
        }
        digest.update(&buffer[..n]);
        out.write_all(&buffer[..n]).map_err(error)?;
    }
    if total != before.len()
        || source.metadata().map_err(error)?.modified().ok() != before.modified().ok()
    {
        return Err(failure(
            "unsupported_target",
            "source image changed during import; prepared copy preserved",
        ));
    }
    out.sync_all().map_err(error)?;
    Ok((
        total,
        digest
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    ))
}
fn engine(variable: &str, deadline: Instant) -> Result<PathBuf> {
    let (path, _) = crate::native_library::pinned_bytes(variable, 64 * 1024 * 1024)?;
    let (status, bytes, _) =
        crate::container::capture(&path, &["--version".into()], deadline, 16384)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| failure("version_mismatch", "QEMU version output is not UTF8"))?;
    let prefix = if variable == "INTERCEPTOR_QEMU_IMG" {
        "qemu-img version "
    } else {
        "QEMU emulator version "
    };
    if !status.success()
        || text
            .lines()
            .next()
            .and_then(|s| s.strip_prefix(prefix))
            .and_then(|s| s.split_whitespace().next())
            != Some(QEMU_VERSION)
    {
        return Err(failure(
            "version_mismatch",
            "VM engines require pinned QEMU 9.2.4",
        ));
    }
    Ok(path)
}
fn image_job(
    kind: &str,
    path: &Path,
    source: Option<&Path>,
    format: Option<&str>,
    size: u64,
    deadline: Instant,
) -> Result<Value> {
    crate::thumbnail::image_helper(
        "--vm-image-engine",
        &json!({"kind":kind,"path":path,"source":source,"format":format,"size":size,"remainingMs":deadline.saturating_duration_since(Instant::now()).as_millis() as u64}),
        deadline,
    )
}
pub(crate) fn image_helper(parent: u32) -> io::Result<()> {
    crate::thumbnail::retain_provider(parent)?;
    let mut input = io::stdin().lock();
    let frame = crate::read_frame(&mut input)?
        .ok_or_else(|| io::Error::other("VM image helper requires an owned request"))?;
    let a: Value = serde_json::from_slice(&frame)?;
    let response = (|| -> Result<Value> {
        if a.as_object().is_none_or(|m| {
            m.keys().any(|k| {
                !["kind", "path", "source", "format", "size", "remainingMs"].contains(&k.as_str())
            })
        }) {
            return Err(failure("invalid_request", "invalid VM image job"));
        }
        let ms = a["remainingMs"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 55000)
            .ok_or_else(|| failure("invalid_request", "invalid VM image deadline"))?;
        let deadline = Instant::now() + Duration::from_millis(ms.min(50000));
        let path = crate::filesystem::absolute(
            a["path"]
                .as_str()
                .ok_or_else(|| failure("invalid_request", "missing VM image path"))?,
        )?;
        let parent = path
            .parent()
            .ok_or_else(|| failure("invalid_request", "invalid VM image parent"))?;
        crate::monitor::private_directory(parent, false, false).map_err(error)?;
        let binary = engine(
            "INTERCEPTOR_QEMU_IMG",
            deadline.min(Instant::now() + Duration::from_secs(3)),
        )?;
        let source = a["source"]
            .as_str()
            .map(crate::filesystem::absolute)
            .transpose()?;
        let kind = a["kind"].as_str().unwrap_or("");
        let args = match kind {
            "convert" => {
                let src =
                    source.ok_or_else(|| failure("invalid_request", "missing owned VM import"))?;
                let format = a["format"]
                    .as_str()
                    .filter(|s| ["raw", "qcow2"].contains(s))
                    .ok_or_else(|| failure("invalid_request", "invalid VM import format"))?;
                if format == "qcow2" {
                    qcow_header(&src)?;
                }
                let f = crate::monitor::private_file(&src, false).map_err(error)?;
                if f.metadata().map_err(error)?.len() > MAX_DISK + 536870912 {
                    return Err(failure("resource_limit", "VM disk input exceeds bound"));
                }
                drop(f);
                let out = crate::monitor::private_file(&path, true).map_err(error)?;
                drop(out);
                let mut opts = json!({"driver":format,"file":{"driver":"file","filename":src}});
                if format == "qcow2" {
                    opts["backing"] = Value::Null;
                }
                vec![
                    "convert".into(),
                    "-m".into(),
                    "1".into(),
                    "-r".into(),
                    "1073741824".into(),
                    "-O".into(),
                    "qcow2".into(),
                    format!("json:{opts}"),
                    path.to_string_lossy().into_owned(),
                ]
            }
            "info" => {
                qcow_header(&path)?;
                let f = crate::monitor::private_file(&path, false).map_err(error)?;
                if f.metadata().map_err(error)?.len() > MAX_DISK + 536870912 {
                    return Err(failure("resource_limit", "VM disk exceeds bound"));
                }
                drop(f);
                vec![
                    "info".into(),
                    "--output=json".into(),
                    "-f".into(),
                    "qcow2".into(),
                    path.to_string_lossy().into_owned(),
                ]
            }
            _ => return Err(failure("invalid_request", "unknown VM image job")),
        };
        let (status, out, err) = crate::container::capture(&binary, &args, deadline, MAX_META)?;
        if !status.success() {
            return Err(failure("provider_failed", String::from_utf8_lossy(&err)));
        }
        if kind == "info" {
            let v: Value =
                serde_json::from_slice(&out).map_err(|e| failure("provider_failed", e))?;
            if v["format"] != "qcow2"
                || v["virtual-size"]
                    .as_u64()
                    .is_none_or(|n| n < 1048576 || n > MAX_DISK)
                || v.get("backing-filename").is_some()
                || v["format-specific"]["data"].get("data-file").is_some()
            {
                return Err(failure(
                    "unsupported_target",
                    "VM disk must be bounded qcow2 without backing or external data files",
                ));
            }
            Ok(success(v))
        } else {
            let f = crate::monitor::private_file(&path, false).map_err(error)?;
            if f.metadata().map_err(error)?.len() == 0 {
                return Err(failure(
                    "provider_failed",
                    "VM image conversion produced no disk",
                ));
            }
            Ok(success(json!({"converted":true})))
        }
    })()
    .unwrap_or_else(|e| e);
    crate::write_frame(&mut io::stdout().lock(), &serde_json::to_vec(&response)?)
}
#[derive(Clone, PartialEq)]
struct Login {
    #[cfg(target_os = "linux")]
    identity: crate::linux_peer::SessionIdentity,
    #[cfg(windows)]
    identity: Value,
}
impl Login {
    fn current() -> Result<Self> {
        #[cfg(target_os = "linux")]
        return crate::linux::login_identity(0)
            .map(|identity| Self { identity })
            .ok_or_else(|| {
                failure(
                    "no_interactive_session",
                    "VM lifecycle requires the current graphical login",
                )
            });
        #[cfg(windows)]
        {
            if crate::windows::session() == "0" {
                return Err(failure(
                    "no_interactive_session",
                    "VM lifecycle requires an interactive login",
                ));
            }
            return crate::windows::identity()
                .map(|identity| Self { identity })
                .map_err(error);
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        Err(failure(
            "unsupported_operation",
            "macOS uses its native VM engine",
        ))
    }
    fn alive(&self) -> Result<()> {
        if Self::current()?.eq(self) {
            Ok(())
        } else {
            Err(failure(
                "no_interactive_session",
                "owned VM login ended or changed",
            ))
        }
    }
}
pub(crate) fn system_helper(parent: u32) -> io::Result<()> {
    crate::thumbnail::retain_provider(parent)?;
    let frame = crate::read_frame(&mut io::stdin().lock())?
        .ok_or_else(|| io::Error::other("VM helper requires owned spec"))?;
    let a: Value = serde_json::from_slice(&frame)?;
    let prepare=(||->Result<(PathBuf,Vec<String>)>{
        if a.as_object().is_none_or(|m|m.len()!=3||!m.contains_key("bundle")||!m.contains_key("id")||!m.contains_key("guestToken")){return Err(failure("invalid_request","invalid VM helper scope"));}
        let path=crate::filesystem::absolute(a["bundle"].as_str().ok_or_else(||failure("invalid_request","missing VM bundle"))?)?;crate::monitor::private_directory(&path,false,false).map_err(error)?;
        let spec:Spec=serde_json::from_slice(&private_read(&path.join("spec.json"),MAX_META)?).map_err(|e|failure("unsupported_target",e))?;if !spec.valid()||a["id"]!=spec.id{return Err(failure("unsupported_target","VM helper manifest UUID differs"));}
        let deadline=Instant::now()+Duration::from_secs(5);let binary=engine("INTERCEPTOR_QEMU_SYSTEM",deadline)?;
        let(bios,_)=crate::native_library::pinned_bytes("INTERCEPTOR_QEMU_BIOS",4*1024*1024)?;let(vga,_)=crate::native_library::pinned_bytes("INTERCEPTOR_QEMU_VGA_BIOS",4*1024*1024)?;
        if vga.to_string_lossy().contains(','){return Err(failure("invalid_request","VGA firmware path cannot contain a QEMU option separator"));}
        let disk=path.join("Disk.qcow2");if qcow_header(&disk)?!=spec.disk_size{return Err(failure("unsupported_target","VM disk header size differs from manifest"));}let held=crate::monitor::private_file(&disk,false).map_err(error)?;drop(held);
        let block=json!({"driver":"qcow2","node-name":"itc-disk","file":{"driver":"file","filename":disk},"backing":null});
        let mut args=vec!["-no-user-config".into(),"-nodefaults".into(),"-machine".into(),"pc-i440fx-9.2,accel=tcg".into(),"-smp".into(),spec.cpu.to_string(),"-m".into(),format!("size={}M",spec.memory_size/1048576),"-uuid".into(),spec.id,"-bios".into(),bios.to_string_lossy().into_owned(),"-display".into(),"none".into(),"-device".into(),format!("VGA,id=itc-display,romfile={}",vga.display()),"-blockdev".into(),block.to_string(),"-device".into(),"ide-hd,drive=itc-disk".into(),"-chardev".into(),"ringbuf,id=itc-console,size=131072".into(),"-serial".into(),"chardev:itc-console".into(),"-qmp".into(),"stdio".into(),"-S".into()];
        args.extend(["-device".into(),"qemu-xhci,id=itc-input-usb".into(),"-device".into(),"usb-tablet,id=itc-input-pointer,bus=itc-input-usb.0,display=itc-display,head=0".into()]);
        args.extend(crate::vm_guest::helper_args(&path, a["id"].as_str().unwrap_or(""), a["guestToken"].as_str().unwrap_or(""))?);
        if spec.network=="nat"{args.extend(["-netdev".into(),format!("user,id={},ipv4=on,ipv6=off,net=10.0.2.0/24,host=10.0.2.2,dhcpstart={}",crate::vm_forward::NETWORK,crate::vm_forward::GUEST),"-device".into(),format!("e1000,netdev={}",crate::vm_forward::NETWORK)]);}else{args.extend(["-nic".into(),"none".into()]);}Ok((binary,args))
    })().map_err(|e|io::Error::other(e.to_string()))?;
    let mut command = Command::new(prepare.0);
    command
        .args(prepare.1)
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    // This helper's main thread stays alive for the whole QEMU child lifetime.
    // Its retained-provider watcher exits the helper on logout or provider loss.
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let helper = std::process::id();
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0
                    || libc::getppid() as u32 != helper
                {
                    return Err(io::Error::other("VM parent changed before exec"));
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = crate::auth::AuthChild(command.spawn()?);
    // Bootstrap is written before forwarding QMP bytes. Both streams belong
    // to this retained helper, so the provider need not discover a host PID.
    let bootstrap=json!({"nativePid":child.0.id(),"helperPid":std::process::id(),"id":a["id"],"guestToken":a["guestToken"]});
    let mut output=io::stdout().lock();
    crate::write_frame(&mut output,&serde_json::to_vec(&bootstrap)?)?;
    let mut native_output=child.0.stdout.take().ok_or_else(||io::Error::other("VM native output unavailable"))?;
    io::copy(&mut native_output,&mut output)?;
    if !child.0.wait()?.success() {
        return Err(io::Error::other("owned QEMU process failed"));
    }
    Ok(())
}
fn bootstrap_pid(frame:&Value,id:&str,token:&str,helper:u32)->Result<u32>{
    if frame.as_object().is_none_or(|m|m.len()!=4||m.keys().any(|key|!["nativePid","helperPid","id","guestToken"].contains(&key.as_str())))||frame["id"]!=id||frame["guestToken"]!=token||frame["helperPid"].as_u64()!=Some(helper as u64){
        return Err(failure("permission_denied","VM native bootstrap differs from the exact owned generation"));
    }
    frame["nativePid"].as_u64().filter(|pid|*pid>0&&*pid<=i32::MAX as u64&&*pid!=helper as u64).map(|pid|pid as u32).ok_or_else(||failure("provider_failed","VM native bootstrap omitted an actual distinct child PID"))
}
struct Runtime {
    helper: crate::thumbnail::OwnedHelper,
    guest: crate::vm_guest::Channel,
    input: ChildStdin,
    output: ChildStdout,
    buffer: Vec<u8>,
    login: Login,
    _disk_lock: Lock,
    id: String,
    started: String,
    memory: u64,
    cpu: u32,
    unknown: Option<Value>,
    forwards: BTreeMap<u16, crate::vm_forward::Forward>,
    forward_unknown: Option<Value>,
    initialized: bool,
    capture:Option<frame::Frame>,
}
impl Runtime {
    fn screen_pixels(&mut self, bundle: &Path, deadline: Instant) -> Result<image::RgbaImage> {
        if self.capture.is_some(){return Err(failure("background_unavailable","previous native capture generation remains owned until confirmed VM stop"));}
        self.login.alive()?;deadline_alive(deadline)?;
        self.capture=Some(frame::Frame::prepare(bundle)?);
        let path=self.capture.as_ref().unwrap().native_path()?;
        let reply=self.command("screendump",json!({"filename":path,"device":crate::vm_input::DISPLAY,"head":0,"format":"png"}),deadline)?;
        if reply.as_object().is_none_or(|m|!m.is_empty()){
            let unknown=json!({"success":false,"code":"timeout_unknown_outcome","error":"native screendump omitted its exact empty completion; capture descriptor and runtime retained","details":{"nativeReply":reply,"ownedRuntimeRetained":true,"observeBeforeRetry":true}});
            self.unknown=Some(unknown.clone());return Err(unknown);
        }
        self.login.alive()?;deadline_alive(deadline)?;
        let pixels=self.capture.as_mut().unwrap().pixels()?;
        self.capture.as_mut().unwrap().retire()?;self.capture=None;
        deadline_alive(deadline)?;
        Ok(pixels)
    }
    fn guest_input(&mut self, name: &str, action: &Value, bundle: &Path, deadline: Instant) -> Result<Value> {
        let sub = action["sub"].as_str().unwrap();
        if sub == "type" {
            return Err(failure("unsupported_operation", "QMP physical keys do not provide guest Unicode text; no keyboard layout, host input or application acceptance was inferred"));
        }
        // Validate the entire chord before native admission. The click uses
        // the actual guest framebuffer and exact configured absolute device.
        let keys = if sub == "keys" { Some(crate::vm_input::keys(action["keys"].as_str().unwrap())?) } else { None };
        if self.exited()? || self.state(deadline)? != "running" {
            return Err(failure("unsupported_target", "guest input requires the exact actually running VM"));
        }
        let batches = if let Some(keys) = keys { keys } else {
            if self.command("qom-get",json!({"path":crate::vm_input::POINTER,"property":"display"}),deadline)? != crate::vm_input::DISPLAY
                || self.command("qom-get",json!({"path":crate::vm_input::POINTER,"property":"head"}),deadline)?.as_u64() != Some(0) {
                return Err(failure("unsupported_target", "owned guest pointer display/head binding differs"));
            }
            crate::vm_input::absolute_pointer(&self.command("query-mice",json!({}),deadline)?)?;
            let pixels = self.screen_pixels(bundle,deadline)?;
            crate::vm_input::click(pixels.width(),pixels.height(),action["x"].as_f64().unwrap(),action["y"].as_f64().unwrap(),action["button"].as_str().unwrap_or("left"))?
        };
        let mut acknowledged = 0;
        for events in batches {
            let count = events.len();
            let result = self.command("input-send-event",json!({"device":crate::vm_input::DISPLAY,"head":0,"events":events}),deadline);
            match result {
                Ok(value) if value.as_object().is_some_and(|object|object.is_empty()) => acknowledged += count,
                Err(error) if acknowledged == 0 && self.unknown.is_none() => return Err(error),
                other => {
                    let native = match other { Ok(value) => json!({"unexpectedReply":value}), Err(error) => error };
                    let unknown = json!({"success":false,"code":"timeout_unknown_outcome","error":"Guest input did not complete both press and release; no events were replayed","details":{"vmId":self.id,"name":name,"operation":sub,"eventsAcknowledged":acknowledged,"guestEffectVerified":false,"nativeError":native,"ownedRuntimeRetained":true,"observeBeforeRetry":true}});
                    // Even a known release refusal leaves a prior press
                    // unresolved. Force-stop remains independent of QMP.
                    self.unknown=Some(unknown.clone());
                    return Err(unknown);
                }
            }
        }
        let mut receipt=json!({"name":name,"operation":sub,"transport":"qmp","submittedEvents":acknowledged,"guestEffectVerified":false});
        if sub == "keys" { receipt["keys"]=action["keys"].clone(); }
        else { receipt["x"]=action["x"].clone();receipt["y"]=action["y"].clone();receipt["button"]=json!(action["button"].as_str().unwrap_or("left")); }
        Ok(success(receipt))
    }
    fn start(spec: &Spec, bundle: &Path, deadline: Instant) -> Result<Self> {
        let held = lock(&bundle.join("run.lock"))?;
        let login = Login::current()?;
        let started=now()?;
        let mut guest = crate::vm_guest::Channel::create(bundle, &spec.id)?;
        let mut helper = crate::thumbnail::OwnedHelper::spawn_with_memory(
            "--vm-engine",
            (spec.memory_size + 512 * 1024 * 1024) as usize,
        )
        .map_err(error)?;
        let mut input = helper
            .child
            .0
            .stdin
            .take()
            .ok_or_else(|| failure("provider_failed", "VM input unavailable"))?;
        guest.mark_launched();
        crate::write_frame(
            &mut input,
            &serde_json::to_vec(&json!({"bundle":bundle,"id":spec.id,"guestToken":guest.token()}))
                .map_err(|e| failure("provider_failed", e))?,
        )
        .map_err(error)?;
        let output = helper
            .child
            .0
            .stdout
            .take()
            .ok_or_else(|| failure("provider_failed", "VM QMP output unavailable"))?;
        Ok(Self {
            helper,
            guest,
            input,
            output,
            buffer: vec![],
            login,
            _disk_lock: held,
            id: spec.id.clone(),
            started,
            memory: spec.memory_size,
            cpu: spec.cpu,
            unknown: None,
            forwards: BTreeMap::new(),
            forward_unknown: None,
            initialized:false,
            capture:None,
        })
    }
    fn initialize(&mut self,deadline:Instant)->Result<()>{
        let bytes=crate::auth::bounded_child_result(|bytes|crate::auth::ready_read(&mut self.output,bytes),deadline,4096).map_err(error)?;
        let frame:Value=serde_json::from_slice(&bytes).map_err(|e|failure("provider_failed",e))?;
        let native_pid=bootstrap_pid(&frame,&self.id,self.guest.token(),self.helper.child.0.id())?;
        // Windows QEMU waits for its single pipe client while still paused.
        // Retain and verify that server before any QMP cont is sent.
        let login = &self.login;
        self.guest.connect(self.helper.child.0.id(), native_pid, deadline, || login.alive())?;
        let greeting = self.message(deadline)?;
        if greeting["QMP"]["version"]["qemu"] != json!({"major":9,"minor":2,"micro":4}) {
            return Err(failure(
                "version_mismatch",
                "owned QMP greeting differs from QEMU 9.2.4",
            ));
        }
        self.command("qmp_capabilities", json!({}), deadline)?;
        self.command("cont", json!({}), deadline)?;
        if self.state(deadline)? != "running" {
            return Err(failure(
                "timeout_unknown_outcome",
                "QMP did not confirm running guest",
            ));
        }
        self.initialized=true;
        Ok(())
    }
    fn message(&mut self, deadline: Instant) -> Result<Value> {
        let mut bytes = [0; 8192];
        loop {
            deadline_alive(deadline)?;
            self.login.alive()?;
            if let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
                if end + 1 > MAX_QMP {
                    return Err(failure("resource_limit", "native QMP line exceeds 128KiB"));
                }
                let line = self.buffer.drain(..=end).collect::<Vec<_>>();
                return serde_json::from_slice(&line).map_err(|e| {
                    failure("provider_failed", format!("invalid native QMP JSON: {e}"))
                });
            }
            if self.buffer.len() > MAX_QMP {
                return Err(failure("resource_limit", "native QMP line exceeds 128KiB"));
            }
            match crate::auth::ready_read(&mut self.output, &mut bytes) {
                Ok(0) => return Err(failure("target_gone", "owned QMP stream closed")),
                Ok(n) => self.buffer.extend_from_slice(&bytes[..n]),
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    ()
                }
                Err(e) => return Err(error(e)),
            };
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    fn command(&mut self, name: &str, args: Value, deadline: Instant) -> Result<Value> {
        if let Some(e) = &self.unknown {
            return Err(e.clone());
        }
        self.login.alive()?;
        deadline_alive(deadline)?;
        let id = crate::secret_target::random_token().map_err(error)?;
        let request = json!({"execute":name,"arguments":args,"id":id});
        let mut bytes = serde_json::to_vec(&request).map_err(|e| failure("provider_failed", e))?;
        bytes.push(b'\n');
        if bytes.len() > 4096 {
            return Err(failure("resource_limit", "QMP command exceeds 4096 bytes"));
        }
        // One outstanding command. A matching response means its previous
        // request was consumed before another bounded pipe write is admitted.
        let mut native_refusal = false;
        let outcome = (|| -> Result<Value> {
            self.input.write_all(&bytes).map_err(error)?;
            let mut events = 0;
            loop {
                let m = self.message(deadline)?;
                if m.get("event").is_some() {
                    events += 1;
                    if events > 256 {
                        return Err(failure(
                            "resource_limit",
                            "native QMP event burst exceeds 256",
                        ));
                    }
                    continue;
                }
                if m["id"] != id {
                    return Err(failure(
                        "timeout_unknown_outcome",
                        "QMP response ID differs; no mutation was replayed",
                    ));
                }
                if let Some(e) = m.get("error") {
                    if m.get("return").is_some()
                        || e["class"]
                            .as_str()
                            .is_none_or(|s| s.is_empty() || s.len() > 256)
                        || e["desc"].as_str().is_none_or(|s| s.len() > 4096)
                    {
                        return Err(failure(
                            "provider_failed",
                            "invalid native QMP error envelope",
                        ));
                    }
                    native_refusal = true;
                    return Err(failure("provider_failed", e["desc"].as_str().unwrap()));
                }
                return m.get("return").cloned().ok_or_else(|| {
                    failure(
                        "provider_failed",
                        "QMP response has neither return nor error",
                    )
                });
            }
        })();
        if let Err(e) = &outcome {
            if !native_refusal {
                let mut unknown = e.clone();
                unknown["code"] = json!("timeout_unknown_outcome");
                unknown["details"] =
                    json!({"nativeError":e,"vmId":self.id,"observeBeforeRetry":true});
                self.unknown = Some(unknown.clone());
                return Err(unknown);
            }
        }
        outcome
    }
    fn network_rows(&mut self, deadline: Instant) -> Result<BTreeMap<u16, crate::vm_forward::Forward>> {
        let value = self.command("human-monitor-command", json!({"command-line":"info usernet"}), deadline)?;
        let text = value.as_str().ok_or_else(|| failure("provider_failed", "native usernet readback is not text"))?;
        crate::vm_forward::parse(text)
    }
    fn forward(&mut self, host: u16, guest: u16, deadline: Instant) -> Result<Value> {
        if let Some(error) = &self.forward_unknown { return Err(error.clone()); }
        if self.forwards.len() >= crate::vm_forward::MAX_FORWARDS { return Err(failure("resource_limit", "VM already owns 32 listeners")); }
        let before = self.network_rows(deadline)?;
        if before != self.forwards { return Err(failure("unsupported_target", "native listener inventory differs from this retained VM generation; nothing added")); }
        if host != 0 && before.contains_key(&host) { return Err(failure("unsupported_target", "this owned VM already has the requested listener; nothing replayed")); }
        // Only the named network and validated integers enter HMP. This is a
        // hypervisor command on the existing child pipe, never shell execution.
        let command = format!("hostfwd_add {} tcp:127.0.0.1:{host}-{}:{guest}", crate::vm_forward::NETWORK, crate::vm_forward::GUEST);
        let mut confirmed_absent = false;
        let admitted = (|| -> Result<Value> {
            let reply = self.command("human-monitor-command", json!({"command-line":command}), deadline)?;
            if reply.as_str().is_none() { return Err(failure("provider_failed", "native forwarding reply is not text")); }
            let after = self.network_rows(deadline)?;
            if after == before { confirmed_absent = true; return Err(failure("provider_failed", "native table confirms no listener was created; add reply alone was not success")); }
            let row = crate::vm_forward::added(&before, &after, host, guest)?;
            self.forwards = after;
            Ok(success(json!({"hostAddress":"127.0.0.1","hostPort":row.host_port,"guestAddress":crate::vm_forward::GUEST,"guestPort":row.guest_port})))
        })();
        match admitted {
            Ok(value) => Ok(value),
            Err(e) if confirmed_absent => Err(e),
            Err(e) => {
                let error = json!({"success":false,"code":"timeout_unknown_outcome","error":"VM listener admission has an unresolved outcome; inspect and stop this owned VM before another forwarding request","details":{"nativeError":e,"vmId":self.id,"hostPortRequested":host,"guestPort":guest,"observeBeforeRetry":true}});
                self.forward_unknown = Some(error.clone()); Err(error)
            }
        }
    }
    fn state(&mut self, deadline: Instant) -> Result<&'static str> {
        let s = self.command("query-status", json!({}), deadline)?;
        match (s["status"].as_str(), s["running"].as_bool()) {
            (Some("running"), Some(true)) => Ok("running"),
            (Some("paused" | "prelaunch"), Some(false)) => Ok("paused"),
            (Some("shutdown"), Some(false)) => Ok("stopped"),
            (Some("internal-error" | "io-error" | "guest-panicked" | "watchdog"), Some(false)) => {
                Ok("error")
            }
            _ => Err(failure(
                "unsupported_target",
                "QMP state has no qualified portable lifecycle mapping",
            )),
        }
    }
    fn exited(&mut self) -> Result<bool> {
        if !self.helper.group_quiescent().map_err(error)?{return Ok(false);}
        #[cfg(windows)]if !self.initialized{
            // An empty retained Windows job covers even a failed bootstrap.
            return Ok(true);
        }
        self.guest.native_exited()
    }
    fn stop(&mut self, force: bool, deadline: Instant) -> Result<()> {
        // Retirement of an already exited owned VM is observation only and
        // remains possible after its graphical login has ended.
        if matches!(self.exited(),Ok(true)){return Ok(());}
        if force{
            self.login.alive()?;
            deadline_alive(deadline)?;
            self.helper.terminate_group().map_err(error)?;
            // No QMP or guest request is replayed. Keep this runtime and its
            // disk lock until actual native and helper exit are observed.
            loop{
                match self.exited(){
                    Ok(true)=>return Ok(()),
                    Ok(false)=>(),
                    Err(e)=>return Err(json!({"success":false,"code":"timeout_unknown_outcome","error":"force-stop was submitted but actual native exit remains unresolved","details":{"vmId":self.id,"nativeError":e,"ownedRuntimeRetained":true,"observeBeforeRetry":true}})),
                }
                if Instant::now()>=deadline{return Err(json!({"success":false,"code":"timeout_unknown_outcome","error":"force-stop deadline ended before native exit was confirmed","details":{"vmId":self.id,"ownedRuntimeRetained":true,"observeBeforeRetry":true}}));}
                self.login.alive()?;
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        if self.exited()? {
            return Ok(());
        }
        self.command("system_powerdown",json!({}),deadline)?;
        loop {
            if self.exited()? {
                return Ok(());
            }
            deadline_alive(deadline)?;
            self.login.alive()?;
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
#[cfg(test)]mod recovery_tests{
    use super::*;
    #[test]fn bootstrap_requires_exact_owned_generation_and_actual_child(){
        let frame=json!({"nativePid":24,"helperPid":12,"id":"owned","guestToken":"token"});
        assert_eq!(bootstrap_pid(&frame,"owned","token",12).unwrap(),24);
        for replacement in [json!({"id":"other"}),json!({"guestToken":"other"}),json!({"helperPid":13}),json!({"nativePid":0}),json!({"nativePid":12}),json!({"nativePid":true}),json!({"nativePid":24.5}),json!({"nativePid":2147483648_u64}),json!({"extra":true})]{
            let mut value=frame.clone();value.as_object_mut().unwrap().extend(replacement.as_object().unwrap().clone());
            assert!(bootstrap_pid(&value,"owned","token",12).is_err(),"{value}");
        }
        for key in ["nativePid","helperPid","id","guestToken"]{
            let mut value=frame.clone();value.as_object_mut().unwrap().remove(key);assert!(bootstrap_pid(&value,"owned","token",12).is_err());
        }
    }
}
#[derive(Default)]
struct Manager {
    vms: BTreeMap<PathBuf, Runtime>,
}
static MANAGER: OnceLock<Mutex<Manager>> = OnceLock::new();
/// A VM this provider started is still running (the updater does not install over it).
pub(crate) fn active() -> bool {
    let Some(mgr) = MANAGER.get() else { return false };
    let Ok(mut mgr) = mgr.try_lock() else { return true };
    mgr.vms.values_mut().any(|r| !r.exited().unwrap_or(false))
}
fn disk_info(path: &Path, deadline: Instant) -> Result<u64> {
    let info = image_job("info", path, None, None, 0, deadline)?;
    info["virtual-size"]
        .as_u64()
        .ok_or_else(|| failure("provider_failed", "VM native disk size unavailable"))
}
fn clone_disk(source: &Path, destination: &Path, deadline: Instant) -> Result<u64> {
    let result = image_job(
        "convert",
        destination,
        Some(source),
        Some("qcow2"),
        0,
        deadline,
    )?;
    if result["converted"] != true {
        return Err(failure(
            "provider_failed",
            "VM image engine omitted conversion acknowledgement",
        ));
    }
    disk_info(destination, deadline)
}
pub fn dispatch(a: &Value) -> Value {
    if let Err(e) = validate(a) {
        return e;
    }
    let started = Instant::now();
    let deadline = started + Duration::from_secs(a["timeout"].as_f64().unwrap_or(50.) as u64);
    let outcome = (|| -> Result<Value> {
        let _login = Login::current()?;
        // Every VM verb but list needs the QEMU engine; name it instead of a later file error.
        if a["sub"] != "list" && crate::native_library::pinned_spec("INTERCEPTOR_QEMU_SYSTEM").is_err() {
            return Err(failure("not_installed", "virtual machines on this host need the qemu virtual machine engine (INTERCEPTOR_QEMU_SYSTEM), which this build does not ship"));
        }
        let reg = Registry::open(a)?;
        let mut mgr = MANAGER
            .get_or_init(|| Mutex::new(Manager::default()))
            .try_lock()
            .map_err(|_| {
                failure(
                    "resource_limit",
                    "another VM operation owns admission; no fresh queued deadline was assigned",
                )
            })?;
        let sub = a["sub"].as_str().unwrap();
        let name = a["name"].as_str().unwrap_or("");
        if ["install", "tcc_profile_generate"].contains(&sub) {
            return Err(failure(
                "unsupported_operation",
                "VM IPSW installation and TCC profiles use Apple-only guest APIs",
            ));
        }
        if sub == "pull" {
            return Err(failure(
                "not_installed",
                "portable OCI guest boot/pull is not packaged; no OCI reference was replaced with a blank disk",
            ));
        }
        if ["create", "adopt"].contains(&sub) {
            if a["kind"].as_str().unwrap_or("linux") != "linux" || a["rosetta"] == true {
                return Err(failure(
                    "unsupported_operation",
                    "portable QEMU source currently accepts Linux guests without Apple Rosetta",
                ));
            }
            if a["installAgent"] == true
                || a["waitForAgent"] == true
                || a["mode"].as_str().unwrap_or("clone") != "clone"
                || a["shares"].as_array().is_some_and(|v| !v.is_empty())
            {
                return Err(failure(
                    "unsupported_target",
                    "guest bootstrap, shared folders and move/reference adoption require their qualified transport",
                ));
            }
            if a["imageFormat"].as_str() != Some("raw") {
                return Err(failure(
                    "unsupported_target",
                    "portable import requires explicit imageFormat raw; qcow2 backing chains are not imported",
                ));
            }
            let source = crate::filesystem::absolute(
                a[if sub == "adopt" {
                    "sourcePath"
                } else {
                    "image"
                }]
                .as_str()
                .ok_or_else(|| {
                    failure(
                        "not_installed",
                        "create requires an explicit bootable raw Linux guest image",
                    )
                })?,
            )?;
            let token = crate::secret_target::random_token().map_err(error)?;
            let id = format!(
                "{}-{}-{}-{}-{}",
                &token[..8],
                &token[8..12],
                &token[12..16],
                &token[16..20],
                &token[20..32]
            );
            let size = fs::metadata(&source).map_err(error)?.len();
            if a.get("diskSize")
                .is_some_and(|v| v.as_f64() != Some(size as f64))
            {
                return Err(failure(
                    "unsupported_target",
                    "portable raw import preserves actual image disk size; resizing is not implicit",
                ));
            }
            let mut spec = Spec {
                name: name.into(),
                id,
                kind: "linux".into(),
                cpu: a["cpu"].as_f64().unwrap_or(2.) as u32,
                memory_size: a["memorySize"].as_f64().unwrap_or(1073741824.) as u64,
                disk_size: size,
                network: a["network"].as_str().unwrap_or("nat").into(),
                created_at: now()?,
                source_digest: None,
            };
            // Reserve the private bundle before any expensive import. Partial
            // artifacts remain observable; a failed import cannot take a name.
            if !spec.valid() {
                return Err(failure(
                    "invalid_request",
                    "VM source size or spec exceeds admission limits",
                ));
            }
            let bundle = reg.root.join(name);
            if bundle.exists() {
                return Err(failure("unsupported_target", "VM name already exists"));
            }
            crate::monitor::private_directory(&bundle, true, false).map_err(error)?;
            let imported = bundle.join("Import.raw");
            let (actual, digest) = copy_raw(&source, &imported, deadline)?;
            spec.source_digest = Some(digest);
            spec.disk_size = actual;
            let result = image_job(
                "convert",
                &bundle.join("Disk.qcow2"),
                Some(&imported),
                Some("raw"),
                actual,
                deadline,
            )?;
            if result["converted"] != true {
                return Err(failure(
                    "provider_failed",
                    "VM image engine omitted conversion acknowledgement",
                ));
            }
            if disk_info(&bundle.join("Disk.qcow2"), deadline)? != actual {
                return Err(failure(
                    "timeout_unknown_outcome",
                    "native VM disk size differs; import artifacts preserved",
                ));
            }
            private_json(
                &bundle.join("spec.json"),
                &serde_json::to_value(&spec).map_err(|e| failure("provider_failed", e))?,
            )?;
            fs::remove_file(imported).map_err(error)?;
            return Ok(success(
                json!({"name":name,"id":spec.id,"kind":spec.kind,"status":"created","bundlePath":bundle}),
            ));
        }
        if sub == "list" {
            let mut views = vec![];
            for spec in reg.list()? {
                let bundle = reg.bundle(&spec.name)?;
                let status = if let Some(r) = mgr.vms.get_mut(&bundle) {
                    if r.id != spec.id {
                        return Err(failure("unsupported_target", "retained VM UUID differs"));
                    }
                    if r.exited()? {
                        "stopped"
                    } else {
                        r.state(deadline)?
                    }
                } else {
                    let _held = lock(&bundle.join("run.lock"))?;
                    "stopped"
                };
                let start = mgr.vms.get(&bundle).map(|r| r.started.as_str());
                views.push(spec.view(status, &bundle, start, false));
            }
            return Ok(success(json!({"vms":views})));
        }
        if sub == "clone" {
            let source = a["src"].as_str().unwrap();
            let destination = a["dst"].as_str().unwrap();
            let bundle = reg.bundle(source)?;
            if let Some(r) = mgr.vms.get_mut(&bundle) {
                if !r.exited()? {
                    return Err(failure("unsupported_target", "clone requires an exited VM"));
                }
                mgr.vms.remove(&bundle);
            }
            let _held = lock(&bundle.join("run.lock"))?;
            let mut spec = reg.spec(source)?;
            spec.name = destination.into();
            let token = crate::secret_target::random_token().map_err(error)?;
            spec.id = format!(
                "{}-{}-{}-{}-{}",
                &token[..8],
                &token[8..12],
                &token[12..16],
                &token[16..20],
                &token[20..32]
            );
            spec.created_at = now()?;
            let target = reg.root.join(destination);
            if target.exists() {
                return Err(failure("unsupported_target", "clone target already exists"));
            }
            crate::monitor::private_directory(&target, true, false).map_err(error)?;
            if clone_disk(
                &bundle.join("Disk.qcow2"),
                &target.join("Disk.qcow2"),
                deadline,
            )? != spec.disk_size
            {
                return Err(failure(
                    "timeout_unknown_outcome",
                    "clone disk readback differs; artifacts preserved",
                ));
            }
            private_json(
                &target.join("spec.json"),
                &serde_json::to_value(&spec).map_err(|e| failure("provider_failed", e))?,
            )?;
            return Ok(success(
                json!({"name":destination,"bundlePath":target,"status":"ready"}),
            ));
        }
        let spec = reg.spec(name)?;
        let bundle = reg.bundle(name)?;
        if let Some(r) = mgr.vms.get(&bundle) {
            if r.id != spec.id {
                return Err(failure(
                    "unsupported_target",
                    "retained VM UUID differs from storage",
                ));
            }
        }
        if ["get", "inspect"].contains(&sub) {
            let status = if let Some(r) = mgr.vms.get_mut(&bundle) {
                if r.exited()? {
                    "stopped"
                } else {
                    r.state(deadline)?
                }
            } else {
                let _held = lock(&bundle.join("run.lock"))?;
                "stopped"
            };
            return Ok(success(spec.view(
                status,
                &bundle,
                mgr.vms.get(&bundle).map(|r| r.started.as_str()),
                sub == "inspect",
            )));
        }
        if sub == "start" {
            if a["headless"] == false {
                return Err(failure(
                    "unsupported_target",
                    "portable VM source currently supports headless background startup only",
                ));
            }
            if a["waitForVsock"] == true {
                return Err(failure(
                    "unsupported_operation",
                    "portable QEMU guest channel is virtio-serial, not vsock; no readiness was inferred",
                ));
            }
            if let Some(r) = mgr.vms.get_mut(&bundle) {
                if !r.exited()? {
                    return Err(failure(
                        "unsupported_target",
                        "owned VM is already active; no duplicate process was launched",
                    ));
                }
                mgr.vms.remove(&bundle);
            }
            if mgr.vms.len() >= 8
                || mgr.vms.values().map(|r| r.memory).sum::<u64>() + spec.memory_size > 34359738368
                || mgr.vms.values().map(|r| r.cpu).sum::<u32>() + spec.cpu > 32
            {
                return Err(failure(
                    "resource_limit",
                    "owned VM pool exceeds 8 processes, 32 CPUs or 32GiB total memory",
                ));
            }
            if disk_info(&bundle.join("Disk.qcow2"), deadline)? != spec.disk_size {
                return Err(failure(
                    "unsupported_target",
                    "VM native disk size differs from spec",
                ));
            }
            let runtime = Runtime::start(&spec, &bundle, deadline)?;
            mgr.vms.insert(bundle.clone(), runtime);
            let r=mgr.vms.get_mut(&bundle).unwrap();
            if let Err(e)=r.initialize(deadline){
                let failure=json!({"success":false,"code":"timeout_unknown_outcome","error":"VM initialization failed after owned launch; the runtime and disk lock remain retained","details":{"vmId":spec.id,"nativeError":e,"ownedRuntimeRetained":true,"observeBeforeRetry":true}});
                r.unknown=Some(failure.clone());
                return Err(failure);
            }
            if a["waitForAgent"] == true {
                let r = mgr.vms.get_mut(&bundle).unwrap();
                let login = &r.login;
                if let Err(mut e) = r.guest.ready(deadline, || login.alive()) {
                    let guest_error = e.get("details").cloned();
                    e["details"] = json!({"guestError":guest_error,"vmId":spec.id,"vmState":"running","ownedRuntimeRetained":true,"observeBeforeRetry":true});
                    return Err(e);
                }
            }
            return Ok(success(
                json!({"state":"running","transitionMs":started.elapsed().as_millis() as u64}),
            ));
        }
        if sub == "stop" {
            if let Some(r) = mgr.vms.get_mut(&bundle) {
                r.stop(a["force"] == true, deadline)?;
                mgr.vms.remove(&bundle);
            } else {
                let _held = lock(&bundle.join("run.lock"))?;
            }
            return Ok(success(
                json!({"state":"stopped","transitionMs":started.elapsed().as_millis() as u64}),
            ));
        }
        if ["pause", "resume", "reset", "console", "screenshot"].contains(&sub) {
            let r = mgr
                .vms
                .get_mut(&bundle)
                .ok_or_else(|| failure("target_gone", "VM has no retained running process"))?;
            if sub == "console" {
                if let Some(text) = a["write"].as_str() {
                    let mut written = 0;
                    for chunk in text.as_bytes().chunks(512) {
                        if let Err(e)=r.command("ringbuf-write",json!({"device":"itc-console","data":base64::engine::general_purpose::STANDARD.encode(chunk),"format":"base64"}),deadline){return Err(json!({"success":false,"code":"timeout_unknown_outcome","error":"VM console write did not complete; no bytes were replayed","details":{"bytesAcknowledged":written,"nativeError":e}}));}
                        written += chunk.len();
                    }
                    return Ok(success(json!({"bytesWritten":written})));
                }
                let size = a["maxBytes"].as_f64().unwrap_or(4096.) as usize;
                let result = r.command(
                    "ringbuf-read",
                    json!({"device":"itc-console","size":size,"format":"base64"}),
                    deadline,
                )?;
                let b64 = result.as_str().ok_or_else(|| {
                    failure("provider_failed", "native ring buffer omitted bytes")
                })?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|_| {
                        failure(
                            "provider_failed",
                            "native ring buffer returned invalid base64",
                        )
                    })?;
                if bytes.len() > size
                    || base64::engine::general_purpose::STANDARD.encode(&bytes) != b64
                {
                    return Err(failure(
                        "resource_limit",
                        "native console bytes exceed bound or differ",
                    ));
                }
                let text = String::from_utf8(bytes.clone()).map_err(|_| {
                    failure(
                        "unsupported_target",
                        "console contains non-UTF8 bytes; no text was synthesized",
                    )
                })?;
                return Ok(success(
                    json!({"bytes":bytes.len(),"text":text,"dataBase64":b64}),
                ));
            }
            if sub == "screenshot" {
                let pixels=r.screen_pixels(&bundle,deadline)?;
                let encoded = crate::capture::encode(&pixels, "png", 100)?;
                if encoded.is_empty()||encoded.len()>frame::MAX_BYTES{return Err(failure("resource_limit","VM PNG encoding exceeds 64MiB"));}
                r.login.alive()?;deadline_alive(deadline)?;
                let mut data = json!({"width":pixels.width(),"height":pixels.height(),"bytes":encoded.len(),"format":"png"});
                if let Some(out) = a["out"].as_str() {
                    let path = crate::filesystem::absolute(out)?;
                    frame::output(&path,&encoded)?;
                    data["filePath"] = json!(path);
                } else {
                    if encoded.len()>frame::INLINE_BYTES{return Err(failure("resource_limit","VM PNG exceeds 700000 inline bytes; request an explicit host --out path"));}
                    data["dataUrl"] = json!(format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(encoded)
                    ));
                }
                r.login.alive()?;deadline_alive(deadline)?;
                return Ok(success(data));
            }
            r.command(
                match sub {
                    "pause" => "stop",
                    "resume" => "cont",
                    _ => "system_reset",
                },
                json!({}),
                deadline,
            )?;
            let state = r.state(deadline)?;
            if sub == "pause" && state != "paused" || sub == "resume" && state != "running" {
                return Err(failure(
                    "timeout_unknown_outcome",
                    "native VM transition did not confirm requested state",
                ));
            }
            return Ok(success(json!({"state":state,"name":name})));
        }
        if ["snapshot", "restore", "delete"].contains(&sub) {
            if let Some(r) = mgr.vms.get_mut(&bundle) {
                if !r.exited()? {
                    return Err(failure(
                        "unsupported_target",
                        "VM disk operation requires a confirmed exited process; force does not discard a live VM",
                    ));
                }
                mgr.vms.remove(&bundle);
            }
            let _held = lock(&bundle.join("run.lock"))?;
            if sub == "delete" {
                if a["keepDisk"] == true {
                    return Err(failure(
                        "unsupported_target",
                        "keep-disk adoption/unregister policy is not qualified; disk preserved",
                    ));
                }
                for entry in fs::read_dir(&bundle).map_err(error)? {
                    let entry = entry.map_err(error)?;
                    if entry.file_type().map_err(error)?.is_symlink() {
                        return Err(failure(
                            "unsupported_target",
                            "VM bundle contains a symlink; deletion refused",
                        ));
                    }
                }
                drop(_held); // The registry lock still excludes VM operations.
                fs::remove_dir_all(&bundle).map_err(error)?;
                if bundle.exists() {
                    return Err(failure(
                        "timeout_unknown_outcome",
                        "VM deletion is not established",
                    ));
                }
                return Ok(success(json!({"state":"deleted"})));
            }
            if a["pausedStateOnly"] == true
                || a["diskOnly"] != true
                    && a["snapshotOp"].as_str().unwrap_or("create") == "create"
                    && sub == "snapshot"
            {
                return Err(failure(
                    "unsupported_target",
                    "portable snapshots require explicit diskOnly; no CPU state was fabricated",
                ));
            }
            let snapshots = bundle.join("snapshots");
            crate::monitor::private_directory(&snapshots, true, false).map_err(error)?;
            if sub == "snapshot" && a["snapshotOp"] == "list" {
                let mut tags = vec![];
                for entry in fs::read_dir(&snapshots).map_err(error)? {
                    let entry = entry.map_err(error)?;
                    let tag = entry
                        .file_name()
                        .to_str()
                        .map(str::to_owned)
                        .ok_or_else(|| failure("unsupported_target", "invalid snapshot name"))?;
                    if !safe(&tag) || !entry.file_type().map_err(error)?.is_dir() {
                        return Err(failure(
                            "unsupported_target",
                            "snapshot inventory contains an invalid entry",
                        ));
                    }
                    let p = entry.path();
                    crate::monitor::private_directory(&p, false, false).map_err(error)?;
                    let m: Value =
                        serde_json::from_slice(&private_read(&p.join("manifest.json"), MAX_META)?)
                            .map_err(|e| failure("unsupported_target", e))?;
                    if m["id"] != spec.id || m["tag"] != tag {
                        return Err(failure(
                            "unsupported_target",
                            "snapshot manifest identity differs",
                        ));
                    }
                    tags.push(tag);
                    if tags.len() > 128 {
                        return Err(failure("resource_limit", "at most 128 disk snapshots"));
                    }
                }
                tags.sort();
                return Ok(success(json!({"snapshots":tags})));
            }
            let tag = a["tag"].as_str().unwrap();
            let target = snapshots.join(tag);
            if sub == "restore" || a["snapshotOp"] == "restore" {
                crate::monitor::private_directory(&target, false, false).map_err(error)?;
                let m: Value =
                    serde_json::from_slice(&private_read(&target.join("manifest.json"), MAX_META)?)
                        .map_err(|e| failure("unsupported_target", e))?;
                if m["id"] != spec.id || m["tag"] != tag || m["diskSize"] != spec.disk_size {
                    return Err(failure("unsupported_target", "snapshot identity differs"));
                }
                let next = bundle.join(format!("restore-{}.qcow2", crate::monitor::identifier()));
                if clone_disk(&target.join("Disk.qcow2"), &next, deadline)? != spec.disk_size {
                    return Err(failure(
                        "timeout_unknown_outcome",
                        "restored disk size differs; original preserved",
                    ));
                }
                // Preserve the old owned disk. No running engine is allowed to
                // retain it, and Windows delete sharing is never enabled.
                let old = bundle.join(format!("prior-{}.qcow2", crate::monitor::identifier()));
                fs::rename(bundle.join("Disk.qcow2"), &old).map_err(error)?;
                if let Err(e) = fs::rename(&next, bundle.join("Disk.qcow2")) {
                    return Err(failure(
                        "timeout_unknown_outcome",
                        format!(
                            "restore commit failed; prior disk retained at {}: {e}",
                            old.display()
                        ),
                    ));
                }
                if disk_info(&bundle.join("Disk.qcow2"), deadline)? != spec.disk_size {
                    return Err(failure(
                        "timeout_unknown_outcome",
                        "restore disk readback differs",
                    ));
                }
                return Ok(success(
                    json!({"tag":tag,"state":"stopped","kind":"disk-only","hasPausedState":false,"hasDiskClone":true,"restored":"disk"}),
                ));
            }
            if a["snapshotOp"] == "delete" {
                crate::monitor::private_directory(&target, false, false).map_err(error)?;
                let m: Value =
                    serde_json::from_slice(&private_read(&target.join("manifest.json"), MAX_META)?)
                        .map_err(|e| failure("unsupported_target", e))?;
                if m["id"] != spec.id || m["tag"] != tag {
                    return Err(failure("unsupported_target", "snapshot identity differs"));
                }
                fs::remove_dir_all(&target).map_err(error)?;
                if target.exists() {
                    return Err(failure(
                        "timeout_unknown_outcome",
                        "snapshot deletion unconfirmed",
                    ));
                }
                return Ok(success(json!({"tag":tag,"deleted":true})));
            }
            if target.exists() {
                return Err(failure("unsupported_target", "snapshot tag already exists"));
            }
            crate::monitor::private_directory(&target, true, false).map_err(error)?;
            if clone_disk(
                &bundle.join("Disk.qcow2"),
                &target.join("Disk.qcow2"),
                deadline,
            )? != spec.disk_size
            {
                return Err(failure(
                    "timeout_unknown_outcome",
                    "snapshot disk size differs",
                ));
            }
            private_json(
                &target.join("manifest.json"),
                &json!({"id":spec.id,"tag":tag,"diskSize":spec.disk_size,"createdAt":now()?}),
            )?;
            return Ok(success(
                json!({"tag":tag,"kind":"disk-only","hasPausedState":false,"hasDiskClone":true}),
            ));
        }
        if sub == "port_forward" {
            if spec.network != "nat" { return Err(failure("unsupported_target", "VM port forwarding requires this guest's owned NAT device")); }
            let r = mgr.vms.get_mut(&bundle).ok_or_else(|| failure("unsupported_target", "forwarding requires this provider's retained VM runtime"))?;
            if r.id != spec.id || r.exited()? { return Err(failure("target_gone", "exact owned VM generation no longer exists")); }
            if r.state(deadline)? != "running" { return Err(failure("unsupported_target", "forwarding requires an actually running VM")); }
            let host = a["hostPort"].as_f64().unwrap_or(0.) as u16;
            let guest = a["guestPort"].as_f64().unwrap() as u16;
            return r.forward(host, guest, deadline);
        }
        if ["type","keys","click"].contains(&sub) {
            let r=mgr.vms.get_mut(&bundle).ok_or_else(||failure("unsupported_target","guest input requires this provider's retained VM runtime"))?;
            return r.guest_input(name,a,&bundle,deadline);
        }
        if sub == "exec" || sub == "cp" {
            let r = mgr.vms.get_mut(&bundle).ok_or_else(|| failure("unsupported_target", "guest operation requires this provider's retained VM runtime"))?;
            if r.id != spec.id || r.exited()? { return Err(failure("target_gone", "exact owned guest generation no longer exists")); }
            if r.state(deadline)? != "running" { return Err(failure("unsupported_target", "guest operation requires an actually running VM")); }
            let login = &r.login;
            return if sub == "exec" { r.guest.execute(a, deadline, || login.alive()) } else { r.guest.copy(a, deadline, || login.alive()) };
        }
        Err(failure(
            "not_installed",
            "VM selector requires a qualified portable guest agent or native share/forward adapter; no host operation was substituted",
        ))
    })();
    let result = outcome.unwrap_or_else(|e| e);
    if serde_json::to_vec(&result).map_or(true, |v| v.len() > DESKTOP_MAX_RESULT_BYTES) {
        failure("resource_limit", "VM reply exceeds the native result bound")
    } else {
        result
    }
}
pub fn shutdown() -> Value {
    let Some(mgr) = MANAGER.get() else {
        return success(json!({"stopped":true}));
    };
    let Ok(mut mgr) = mgr.try_lock() else {
        return failure(
            "timeout_unknown_outcome",
            "VM operation still owns admission during shutdown",
        );
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    for vm in mgr.vms.values_mut() {
        if let Err(e) = vm.stop(true, deadline) {
            return e;
        }
    }
    mgr.vms.clear();
    success(json!({"stopped":true}))
}
pub fn capability(session: &str) -> Value {
    json!({"operation":"vm","compiled":true,"present":true,"permission":"not_applicable","session":session,"effective":false,"background":"unavailable","provider":"qemu","versions":{},"limits":["Source candidate requires exact QEMU 9.2.4 system/image SHA256 pins and pinned BIOS/VGA firmware; TCG x86_64 guest execution is explicit.","8 retained VM processes, 128 inventory/snapshot entries, 32 CPUs and 32GiB total pool memory, 64GiB raw disk, 50s admission and bounded QMP.","Guest source uses QEMU guest-agent 9.2.4 on owned virtio-serial only; private Linux FIFOs or a retained Windows pipe server verified against the owned helper, executable, user and session before QMP cont.","Loopback TCP forwarding has source for the exact named NAT device, 32 listeners, actual ephemeral ports and listener identity readback; real traffic, library/ABI and teardown remain unqualified.","QMP guest click and physical chords have source: exact owned display/head, absolute USB tablet, actual framebuffer bounds, separate press/release and truthful submission counts. Guest driver/application effects, queue loss, layout, pixels and cleanup remain unqualified. Guest Unicode typing is not supplied by QMP.","Exact argv/env exec and 1MiB exclusive file copy are source candidates. QGA runs with its configured guest authority. User/workdir/TTY, vsock, OCI boot, guest Unicode/AX/trust, shares and paused-state snapshots remain unavailable or unqualified. No host exec or public agent listener is substituted."],"reason":"Current source has not received a native build or installed-artifact qualification."})
}
