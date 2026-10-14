use crate::{contract_generated::*, failure, success};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::VecDeque, fs::{self, OpenOptions}, io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}, time::{Duration, Instant, SystemTime}};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

type Result<T> = std::result::Result<T, Value>;
static WRITE_SERIAL: AtomicU64 = AtomicU64::new(0);

fn io_error(error: std::io::Error) -> Value {
    failure(match error.kind() {
        std::io::ErrorKind::PermissionDenied => "permission_denied",
        std::io::ErrorKind::NotFound => "target_gone",
        std::io::ErrorKind::InvalidInput => "invalid_request",
        _ => "provider_failed",
    }, error)
}
fn decode<T: for<'a> Deserialize<'a>>(action: &Value) -> Result<T> {
    fn has_null(value: &Value) -> bool {
        match value { Value::Null => true, Value::Object(v) => v.values().any(has_null),
            Value::Array(v) => v.iter().any(has_null), _ => false }
    }
    if has_null(action) { return Err(failure("invalid_request", "filesystem fields cannot be null")); }
    serde_json::from_value(action.clone()).map_err(|e| failure("invalid_request", e.to_string().chars().take(512).collect::<String>()))
}
fn bounded<T: Serialize>(data: T) -> Value {
    let result = success(serde_json::to_value(data).expect("filesystem result contains only finite numbers"));
    if serde_json::to_vec(&result).is_ok_and(|bytes| bytes.len() <= DESKTOP_MAX_RESULT_BYTES) { result }
    else { failure("resource_limit", "filesystem result exceeds the negotiated frame limit; request a smaller byte range or search limit") }
}
fn integer(value: Option<f64>, default: u64, max: u64, zero: bool) -> Result<u64> {
    match value {
        None => Ok(default),
        Some(n) if n.is_finite() && n.fract() == 0.0 && n >= if zero { 0.0 } else { 1.0 } && n <= max as f64 => Ok(n as u64),
        _ => Err(failure("invalid_request", "filesystem numeric fields must be bounded integers")),
    }
}
fn timestamp(value: SystemTime) -> Result<String> {
    let nanos = match value.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos() as i128,
        Err(error) => -(error.duration().as_nanos() as i128),
    };
    OffsetDateTime::from_unix_timestamp_nanos(nanos).map_err(|e| failure("provider_failed", e))?
        .format(&Rfc3339).map_err(|e| failure("provider_failed", e))
}
fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}
/// The canonical temp folder in the form callers print: Windows canonicalize() adds `\\?\`, which
/// readers and the result validators reject, so a plain drive path drops it.
pub(crate) fn temp_dir() -> std::io::Result<PathBuf> {
    let path = std::fs::canonicalize(std::env::temp_dir())?;
    #[cfg(windows)] if let Some(plain) = path.to_str().and_then(|p| p.strip_prefix(r"\\?\")).filter(|p| p.as_bytes().get(1) == Some(&b':')) { return Ok(PathBuf::from(plain)); }
    Ok(path)
}
pub(crate) fn absolute(text: &str) -> Result<PathBuf> {
    if text.is_empty() || text.len() > 32768 || text.contains('\0') { return Err(failure("invalid_request", "invalid filesystem path")); }
    let path = if text == "~" || text.starts_with("~/") || (cfg!(windows) && text.starts_with("~\\")) {
        home().ok_or_else(|| failure("invalid_request", "home directory is unavailable"))?.join(text.get(2..).unwrap_or(""))
    } else { PathBuf::from(text) };
    if !path.is_absolute() { return Err(failure("invalid_request", "an absolute filesystem path is required")); }
    #[cfg(windows)] if matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::DeviceNS(_))) {
        return Err(failure("restricted_by_os", "device namespace paths are not filesystem targets"));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component { Component::CurDir => (), Component::ParentDir => { normalized.pop(); }, other => normalized.push(other.as_os_str()) }
    }
    Ok(normalized)
}
fn target(path: Option<String>, reference: Option<DesktopFsPathReference>) -> Result<PathBuf> {
    let text = path.filter(|p| !p.is_empty()).or_else(|| reference.map(|r| r.path))
        .ok_or_else(|| failure("invalid_request", "filesystem path or path reference is required"))?;
    absolute(&text)
}
fn protect(path: &Path) -> Result<()> {
    #[cfg(not(windows))] let protected = ["/etc", "/usr", "/System", "/private/var", "/proc", "/sys", "/dev", "/boot"]
        .iter().any(|root| path.starts_with(root));
    #[cfg(windows)] let protected = {
        let normalize = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_start_matches("//?/").to_lowercase();
        let candidate = normalize(path);
        [std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
            std::env::var_os("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".into()),
            std::env::var_os("ProgramFiles(x86)").unwrap_or_else(|| "C:\\Program Files (x86)".into())]
            .iter().any(|root| { let root = normalize(Path::new(root)); candidate == root || candidate.starts_with(&(root + "/")) })
    };
    if protected { Err(failure("restricted_by_os", "filesystem write targets a protected system directory")) } else { Ok(()) }
}
fn content_type(path: &Path) -> String {
    match path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "txt" | "log" | "md" => "public.plain-text", "json" => "public.json", "html" | "htm" => "public.html",
        "png" => "public.png", "jpg" | "jpeg" => "public.jpeg", "pdf" => "com.adobe.pdf", _ => "public.data",
    }.into()
}
fn read(action: DesktopFsReadAction) -> Result<Value> {
    let path = target(action.path, action.r#ref)?;
    if !fs::metadata(&path).map_err(io_error)?.is_file() { return Err(failure("unsupported_target", "filesystem read requires a regular file")); }
    let mut options = OpenOptions::new(); options.read(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NONBLOCK); }
    let mut file = options.open(&path).map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() { return Err(failure("unsupported_target", "filesystem target is no longer a regular file")); }
    let range = action.byteRange.unwrap_or(DesktopFsByteRange { start: None, length: None });
    let start = integer(range.start, 0, 9_007_199_254_740_991, true)?;
    let length = integer(range.length, metadata.len().saturating_sub(start), 9_007_199_254_740_991, true)?;
    if length > DESKTOP_MAX_FRAME_BYTES as u64 { return Err(failure("resource_limit", "read exceeds frame size; request a byte range")); }
    file.seek(SeekFrom::Start(start)).map_err(io_error)?;
    let mut bytes = Vec::new(); file.take(length).read_to_end(&mut bytes).map_err(io_error)?;
    let encoding = action.encoding.unwrap_or(DesktopFsEncoding::V0);
    let content = match encoding { DesktopFsEncoding::V0 => String::from_utf8(bytes.clone()).unwrap_or_else(|_| STANDARD.encode(&bytes)),
        _ => STANDARD.encode(&bytes) };
    Ok(bounded(DesktopFsReadData { content, encoding, contentType: content_type(&path),
        attributes: DesktopFsAttributes { size: metadata.len() as f64, modified: timestamp(metadata.modified().map_err(io_error)?)?, absolutePath: path.to_string_lossy().into() } }))
}
fn write(action: DesktopFsWriteAction) -> Result<Value> {
    if action.append == Some(true) { return Err(failure("unsupported_operation", "append is not qualified; no file was changed")); }
    let path = target(action.path, action.r#ref)?;
    protect(&path)?;
    let parent = path.parent().ok_or_else(|| failure("invalid_request", "write needs a filename"))?;
    let name = path.file_name().ok_or_else(|| failure("invalid_request", "write needs a filename"))?;
    if let Some(condition) = action.ifMatch.as_ref() {
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(failure("invalid_request", "ifMatch target no longer exists; no file was changed")),
            Err(error) => return Err(io_error(error)),
        };
        if timestamp(metadata.modified().map_err(io_error)?)? != condition.modified {
            return Err(failure("invalid_request", "ifMatch precondition failed; no file was changed"));
        }
    }
    // Check the existing ancestor before creating directories, and the resolved
    // final parent afterward. Atomic replacement replaces a final symlink itself.
    let mut ancestor = parent;
    while !ancestor.exists() { ancestor = ancestor.parent().ok_or_else(|| failure("target_gone", "write parent is unavailable"))?; }
    protect(&fs::canonicalize(ancestor).map_err(io_error)?)?;
    let bytes = match action.encoding.unwrap_or(DesktopFsEncoding::V0) { DesktopFsEncoding::V1 => STANDARD.decode(&action.content)
        .map_err(|_| failure("invalid_request", "content is not valid base64"))?, _ => action.content.into_bytes() };
    fs::create_dir_all(parent).map_err(io_error)?;
    let parent = fs::canonicalize(parent).map_err(io_error)?; protect(&parent)?;
    let path = parent.join(name);
    let existing = match fs::metadata(&path) { Ok(meta) => Some(meta), Err(e) if e.kind() == std::io::ErrorKind::NotFound => None, Err(e) => return Err(io_error(e)) };
    if existing.as_ref().is_some_and(|m| !m.is_file()) { return Err(failure("unsupported_target", "filesystem write requires a file target")); }
    if let Some(condition) = action.ifMatch {
        let metadata = existing.as_ref().ok_or_else(|| failure("invalid_request", "ifMatch target no longer exists; no file was changed"))?;
        if timestamp(metadata.modified().map_err(io_error)?)? != condition.modified { return Err(failure("invalid_request", "ifMatch precondition failed; no file was changed")); }
    }
    let temporary = parent.join(format!(".interceptor-write-{}-{}.tmp", std::process::id(), WRITE_SERIAL.fetch_add(1, Ordering::Relaxed)));
    let mut output = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(io_error)?;
    let result = (|| -> std::io::Result<()> {
        if let Some(metadata) = &existing { output.set_permissions(metadata.permissions())?; }
        output.write_all(&bytes)?; output.sync_all()?; drop(output); fs::rename(&temporary, &path)
    })();
    if let Err(error) = result { let _ = fs::remove_file(&temporary); return Err(io_error(error)); }
    let partial = |error: std::io::Error| failure("partial_result", format!("file was replaced but its resulting metadata is unavailable: {error}"));
    let metadata = fs::metadata(&path).map_err(partial)?;
    let modified = timestamp(metadata.modified().map_err(partial)?).map_err(|_| failure("partial_result", "file was replaced but its resulting timestamp is unavailable"))?;
    Ok(bounded(DesktopFsWriteData { written: metadata.len() as f64, absolutePath: path.to_string_lossy().into(), modified }))
}
fn kind_matches(kinds: &[String], path: &Path, is_dir: bool) -> bool {
    kinds.is_empty() || kinds.iter().any(|kind| match kind.as_str() {
        "directory" | "directories" | "dir" | "folder" | "folders" | "public.folder" | "public.directory" => is_dir,
        "file" | "files" | "public.data" | "public.item" => !is_dir,
        other if other.ends_with(".folder") || other.ends_with(".directory") => is_dir,
        "public.text" => !is_dir && ["public.plain-text", "public.json", "public.html"].contains(&content_type(path).as_str()),
        "public.image" => !is_dir && ["public.png", "public.jpeg"].contains(&content_type(path).as_str()),
        other => !is_dir && content_type(path) == other,
    })
}
fn search(action: DesktopFsSearchAction) -> Result<Value> {
    if action.query.trim().is_empty() || action.query.contains('\0') || action.query.len() > 4096 { return Err(failure("invalid_request", "search query is required and bounded")); }
    let limit = integer(action.limit, 20, 10_000, false)? as usize;
    let timeout = integer(action.timeoutMs, 10_000, 10_000, false)?.max(200);
    let kinds = action.kinds.unwrap_or_default().into_iter().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect::<Vec<_>>();
    if kinds.iter().any(|kind| !["directory", "directories", "dir", "folder", "folders", "public.folder", "public.directory",
        "file", "files", "public.data", "public.item", "public.plain-text", "public.json", "public.html",
        "public.png", "public.jpeg", "com.adobe.pdf", "public.text", "public.image"].contains(&kind.as_str())
        && !kind.ends_with(".folder") && !kind.ends_with(".directory")) {
        return Err(failure("unsupported_operation", "kind filter is not implemented; supported typed filters: public.plain-text, public.json, public.html, public.png, public.jpeg, com.adobe.pdf, public.text, public.image"));
    }
    let scope = action.scope.unwrap_or_else(|| "everywhere".into());
    let roots = match scope.as_str() {
        "everywhere" => return indexed(&action.query, &kinds, limit, timeout),
        "cwd" | "workspace" => vec![absolute(&action.cwd.unwrap_or_else(|| home().unwrap_or_default().to_string_lossy().into()))?],
        "home" | "granted" => vec![home().ok_or_else(|| failure("invalid_request", "home directory is unavailable"))?],
        "path" => action.paths.filter(|p| !p.is_empty() && p.len() <= 64).ok_or_else(|| failure("invalid_request", "path scope requires 1..64 roots"))?
            .iter().map(|p| absolute(p)).collect::<Result<Vec<_>>>()?,
        _ => vec![absolute(&scope)?],
    };
    for root in &roots { if !fs::metadata(root).map_err(io_error)?.is_dir() { return Err(failure("unsupported_target", "search roots must be existing directories")); } }
    let scope = roots.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>().join(":");
    let query = action.query.trim().to_lowercase();
    let wildcard = query.chars().all(|c| c == '*' || c == '?');
    let deadline = Instant::now() + Duration::from_millis(timeout);
    let mut queue = roots.into_iter().map(|root| (root, 0)).collect::<VecDeque<_>>();
    let mut matches = Vec::new(); let mut scanned = 0; let mut partial = false;
    'scan: while let Some((root, depth)) = queue.pop_front() {
        if Instant::now() >= deadline || scanned >= 10_000 { partial = true; break; }
        let iterator = match fs::read_dir(&root) { Ok(entries) => entries, Err(_) => { partial = true; continue; } };
        let mut entries = Vec::new();
        for entry in iterator {
            if Instant::now() >= deadline || entries.len() >= 10_000 - scanned { partial = true; break; }
            match entry { Ok(entry) => entries.push(entry), Err(_) => partial = true }
        }
        entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
        for entry in entries {
            if Instant::now() >= deadline || scanned >= 10_000 || matches.len() >= limit { partial = true; break 'scan; }
            scanned += 1;
            let name = entry.file_name().to_string_lossy().into_owned();
            let metadata = match fs::metadata(entry.path()) { Ok(meta) => meta, Err(_) => { partial = true; continue; } };
            #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 2 != 0 { continue; } }
            if name.starts_with('.') { continue; }
            let is_dir = metadata.is_dir();
            let kind_matches = kind_matches(&kinds, &entry.path(), is_dir);
            if (wildcard || name.to_lowercase().contains(&query)) && kind_matches {
                matches.push(DesktopFsMatch { path: entry.path().to_string_lossy().into(), name: name.clone(), kind: if is_dir { "directory" } else { "file" }.into(),
                    size: metadata.is_file().then_some(metadata.len() as f64), modified: metadata.modified().ok().and_then(|value| timestamp(value).ok()) });
            }
            if !wildcard && is_dir && !entry.file_type().is_ok_and(|t| t.is_symlink()) && !["node_modules", ".git", ".Trash"].contains(&name.as_str()) {
                if depth < 4 { queue.push_back((entry.path(), depth + 1)); } else { partial = true; }
            }
        }
    }
    let count = matches.len() as f64;
    Ok(bounded(DesktopFsSearchData { matches, indexed: false, source: if wildcard { "direct_listing" } else { "native_scoped_enumeration" }.into(),
        scope, query: action.query, count, partial: Some(partial), deadlineMs: Some(timeout as f64), hint: None }))
}
pub fn dispatch(verb: &str, action: &Value) -> Value {
    if action["ref"]["kind"] == "bookmark" { return failure("unsupported_operation", "Apple security-scoped bookmarks are unavailable on this host"); }
    let result = match verb {
        "fs_read" => decode(action).and_then(read), "fs_write" => decode(action).and_then(write),
        "fs_search" => decode(action).and_then(search), _ => Err(failure("unsupported_operation", "unknown filesystem operation")),
    };
    result.unwrap_or_else(|error| error)
}
pub fn capabilities(host: &str, session: &str) -> Vec<Value> {
    ["fs", "fs_read", "fs_write", "fs_search"].map(|operation| json!({
        "operation":operation,"compiled":true,"present":true,"permission":"not_applicable","session":session,
        "effective":true,"background":"semantic","provider":"Rust.std.filesystem","versions":{"host":host,"contract":"1"},
        "limits":["absolute paths or path references", "negotiated frame limit", "scoped name enumeration: 10000 entries, depth 4,10s", "typed search uses existing filename-extension mapping: plain text, JSON, HTML, PNG, JPEG, PDF and text/image parents; other kinds refuse", "no indexed machine-wide search", "no Apple bookmarks or append", "symlink/reparse races and remote filesystems unqualified"],
        "reason":"read/write and scoped search require target permissions; full indexed-search parity is incomplete"
    })).into()
}

#[cfg(test)] mod tests {
    #[test] fn typed_kind_filters_preserve_aliases_and_refuse_unimplemented_types() {
        let root = std::env::current_dir().unwrap().join("target").join(format!("interceptor-kind-unit-{}",std::process::id()));
        fs::create_dir_all(&root).unwrap();
        for name in ["note.txt", "note.json", "note.html", "note.png", "note.jpg", "note.pdf"] {
            fs::write(root.join(name), "owned kind-filter fixture").unwrap();
        }
        fs::create_dir(root.join("folder")).unwrap();
        let cases: Vec<(Vec<&str>, Vec<&str>)> = vec![
            (vec!["public.png"], vec!["note.png"]), (vec!["public.image"], vec!["note.jpg", "note.png"]),
            (vec!["public.plain-text"], vec!["note.txt"]), (vec!["public.text"], vec!["note.html", "note.json", "note.txt"]),
            (vec!["public.json"], vec!["note.json"]), (vec!["public.html"], vec!["note.html"]),
            (vec!["public.jpeg"], vec!["note.jpg"]), (vec!["com.adobe.pdf"], vec!["note.pdf"]),
            (vec![" PUBLIC.PNG ", "public.json"], vec!["note.json", "note.png"]),
            (vec!["public.folder"], vec!["folder"]),
            (vec!["file"], vec!["note.html", "note.jpg", "note.json", "note.pdf", "note.png", "note.txt"]),
        ];
        for query in ["*", "o"] {
            for (kinds, expected) in &cases {
                let result = dispatch("fs_search", &json!({"type":"desktop_fs_search", "query":query,"scope":root,"kinds":kinds}));
                assert_eq!(result["success"],true,"{result}");
                let names = result["data"]["matches"].as_array().unwrap().iter().map(|m|m["name"].as_str().unwrap()).collect::<Vec<_>>();
                assert_eq!(&names,expected,"{query}: {kinds:?}");
            }
        }
        for kinds in [vec!["com.interceptor.unknown-type"],vec!["public.png","public.audio"]] {
            assert_eq!(dispatch("fs_search", &json!({"type":"desktop_fs_search", "query":"*","scope":root,"kinds":kinds}))["code"],"unsupported_operation");
        }
        for entry in fs::read_dir(&root).unwrap() { let p=entry.unwrap().path();if p.is_dir(){fs::remove_dir(p).unwrap()}else{fs::remove_file(p).unwrap()} }
        fs::remove_dir(root).unwrap();
    }
    #[test] fn malformed_field_diagnostic_is_bounded_before_dispatch() {
        let mut action = json!({"type":"desktop_fs_read", "path":"/missing"});
        action["x".repeat(5000)] = json!(true);
        let result = dispatch("fs_read", &action);
        assert_eq!(result["code"], "invalid_request");
        assert!(result["error"].as_str().unwrap().len() <= 2048);
    }
    #[test] fn result_budget_includes_the_maximum_escaped_request_id() {
        let overhead = serde_json::to_vec(&success(json!({"content":""}))).unwrap().len();
        let content = "A".repeat(DESKTOP_MAX_RESULT_BYTES - overhead);
        let result = bounded(json!({"content":content}));
        assert_eq!(result["success"], true);
        let envelope = json!({"id":"\0".repeat(128), "result":result});
        assert!(serde_json::to_vec(&envelope).unwrap().len() <= DESKTOP_MAX_FRAME_BYTES);
        assert_eq!(bounded(json!({"content":content + "A"}))["code"], "resource_limit");
        assert_eq!(bounded(json!({"content":"\0".repeat(2_000_000)}))["code"], "resource_limit");
    }
    use super::*;
    #[test] fn unrepresentable_file_timestamp_is_a_typed_error() {
        let value = SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(400_000_000_000)).unwrap();
        assert_eq!(timestamp(value).unwrap_err()["code"],"provider_failed");
    }
    #[test] fn filesystem_contract_rejects_malformed_payloads_before_mutation() {
        for action in [json!({"type":"desktop_fs_write","path":"relative","content":"x"}),
            json!({"type":"desktop_fs_write","path":null,"content":"x"}),
            json!({"type":"desktop_fs_write","path":"/missing","content":"x","extra":true}),
            json!({"type":"desktop_fs_write","path":"/missing","content":"x","ifMatch":{"modified":"x","extra":true}})] {
            assert_eq!(dispatch("fs_write",&action)["code"],"invalid_request");
        }
        assert_eq!(dispatch("fs_write",&json!({"type":"desktop_fs_write","path":"/missing","content":"x","append":true}))["code"],"unsupported_operation");
        assert_eq!(dispatch("fs_read",&json!({"type":"desktop_fs_read","ref":{"kind":"bookmark","bookmarkB64":"x"}}))["code"],"unsupported_operation");
        assert_eq!(dispatch("fs_search",&json!({"type":"desktop_fs_search","query":"  "}))["code"],"invalid_request");
    }
    #[test] fn native_filesystem_bytes_atomic_replacement_and_bounded_search() {
        #[cfg(target_os = "macos")] let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("interceptor-fs-unit-{}",std::process::id()));
        #[cfg(not(target_os = "macos"))] let root = std::env::temp_dir().join(format!("interceptor-fs-unit-{}",std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("parity.txt");
        let write_request = |content:&str| json!({"type":"desktop_fs_write","path":path,"content":content});
        let first=dispatch("fs_write",&write_request("first🙂")); assert_eq!(first["success"],true);
        let read_request = json!({"type":"desktop_fs_read","path":path});
        let read=dispatch("fs_read",&read_request);assert_eq!(read["data"]["content"],"first🙂");
        let stale=dispatch("fs_write",&json!({"type":"desktop_fs_write","path":path,"content":"wrong","ifMatch":{"modified":"old"}}));
        assert_eq!(stale["code"],"invalid_request");assert_eq!(fs::read_to_string(&path).unwrap(),"first🙂");
        let changed=dispatch("fs_write",&json!({"type":"desktop_fs_write","path":path,"content":"AAEC/w==","encoding":"base64","ifMatch":{"modified":read["data"]["attributes"]["modified"]}}));
        assert_eq!(changed["success"],true);assert_eq!(fs::read(&path).unwrap(),[0,1,2,255]);
        assert_eq!(dispatch("fs_read",&json!({"type":"desktop_fs_read","path":path,"encoding":"raw","byteRange":{"start":1,"length":2}}))["data"]["content"],"AQI=");
        assert_eq!(dispatch("fs_read",&json!({"type":"desktop_fs_read","path":path,"byteRange":{"start":-1}}))["code"],"invalid_request");
        let found=dispatch("fs_search",&json!({"type":"desktop_fs_search","query":"parity","scope":"path","paths":[root]}));
        assert_eq!(found["success"],true);assert_eq!(found["data"]["count"],1.0);assert_eq!(found["data"]["indexed"],false);
        assert!(!fs::read_dir(&root).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".interceptor-write-")));
        fs::remove_file(&path).unwrap();
        let missing=dispatch("fs_write",&json!({"type":"desktop_fs_write","path":path,"content":"must not recreate","ifMatch":{"modified":read["data"]["attributes"]["modified"]}}));
        assert_eq!(missing["code"],"invalid_request");assert!(!path.exists());
        let absent_parent=root.join("missing-parent");
        let missing=dispatch("fs_write",&json!({"type":"desktop_fs_write","path":absent_parent.join("missing.pdf"),"content":"must not recreate","ifMatch":{"modified":read["data"]["attributes"]["modified"]}}));
        assert_eq!(missing["code"],"invalid_request");assert!(!absent_parent.exists());
        fs::remove_dir(root).unwrap();
    }
}
/// Machine-wide search through the host's file index: plocate on Linux, the Windows Search
/// SystemIndex on Windows (the Spotlight analog). Names match case-insensitively; the same
/// kind filter as the scoped scan applies to each hit.
fn indexed(query: &str, kinds: &[String], limit: usize, timeout: u64) -> Result<Value> {
    let query = query.trim();
    let deadline = Instant::now() + Duration::from_millis(timeout);
    #[cfg(target_os = "linux")]
    let (source, mut command) = {
        let locate = ["/usr/bin/plocate", "/usr/bin/locate"].into_iter().find(|p| Path::new(p).is_file())
            .ok_or_else(|| failure("not_installed", "machine-wide search needs plocate (install the plocate package and run updatedb), or use an explicit --scope"))?;
        let mut command = std::process::Command::new(locate);
        // --basename matches the file name like the scoped scan; `--` ends options before the query.
        command.args(["--ignore-case", "--basename", "--limit", &(limit * 4).min(40_000).to_string(), "--", query]);
        ("plocate", command)
    };
    #[cfg(windows)]
    let (source, mut command) = {
        // The query reaches PowerShell as an environment value, never as script text, and is
        // escaped for Windows Search SQL (quotes doubled, LIKE wildcards bracketed). A missing
        // Search provider throws in Open/Execute; Stop + catch exits nonzero with no output, which
        // maps to the not_installed refusal below instead of looping on a null recordset.
        let script = "$ErrorActionPreference='Stop';try{$q=$env:INTERCEPTOR_FS_QUERY -replace \"'\",\"''\" -replace '([%_\\[])','[$1]';$c=New-Object -ComObject ADODB.Connection;$c.Open(\"Provider=Search.CollatorDSO;Extended Properties='Application=Windows';\");$r=$c.Execute(\"SELECT TOP $env:INTERCEPTOR_FS_LIMIT System.ItemPathDisplay FROM SystemIndex WHERE System.FileName LIKE '%$q%'\");while(-not $r.EOF){[Console]::Out.WriteLine($r.Fields.Item(0).Value);$r.MoveNext()}}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 2}";
        let mut command = std::process::Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", script]).env("INTERCEPTOR_FS_QUERY", query).env("INTERCEPTOR_FS_LIMIT", (limit * 4).min(40_000).to_string());
        { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        ("Windows.Search.SystemIndex", command)
    };
    #[cfg(not(any(target_os = "linux", windows)))]
    return { let _ = (query, kinds, limit, deadline); Err(failure("unsupported_operation", "macOS uses Spotlight through the Swift bridge")) };
    #[cfg(any(target_os = "linux", windows))]
    {
        let mut child = command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn()
            .map_err(|e| failure("not_installed", format!("machine-wide search backend did not start: {e}")))?;
        let mut stdout = child.stdout.take().unwrap();
        let reader = std::thread::spawn(move || { let mut bytes = Vec::new(); let _ = (&mut stdout).take(16 * 1024 * 1024).read_to_end(&mut bytes); bytes });
        let mut timed_out = false;
        loop {
            if child.try_wait().map_err(io_error)?.is_some() { break; }
            if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); timed_out = true; break; }
            std::thread::sleep(Duration::from_millis(20));
        }
        let status = child.wait().ok();
        let bytes = reader.join().unwrap_or_default();
        let mut stderr = String::new(); if let Some(mut e) = child.stderr.take() { let _ = (&mut e).take(4096).read_to_string(&mut stderr); }
        // plocate exits 1 when nothing matched; anything else without output is a backend failure.
        if bytes.is_empty() && !timed_out && !status.is_some_and(|s| s.success() || (cfg!(target_os = "linux") && s.code() == Some(1))) {
            return Err(failure("not_installed", format!("machine-wide search index is unavailable: {}", stderr.trim().chars().take(300).collect::<String>())));
        }
        let mut matches = Vec::new(); let mut partial = timed_out;
        for line in String::from_utf8_lossy(&bytes).lines().map(str::trim).filter(|l| !l.is_empty()) {
            if matches.len() >= limit { partial = true; break; }
            let path = PathBuf::from(line);
            let Ok(metadata) = fs::metadata(&path) else { continue };
            let is_dir = metadata.is_dir();
            if !kind_matches(kinds, &path, is_dir) { continue; }
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            matches.push(DesktopFsMatch { path: line.into(), name, kind: if is_dir { "directory" } else { "file" }.into(),
                size: metadata.is_file().then_some(metadata.len() as f64), modified: metadata.modified().ok().and_then(|value| timestamp(value).ok()) });
        }
        let count = matches.len() as f64;
        Ok(bounded(DesktopFsSearchData { matches, indexed: true, source: source.into(), scope: "everywhere".into(), query: query.into(), count,
            partial: Some(partial), deadlineMs: Some(timeout as f64), hint: None }))
    }
}
