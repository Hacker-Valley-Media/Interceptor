#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
mod contract_generated;
mod accessibility;
mod filesystem;
mod files;
mod clipboard;
mod capture;
mod display;
#[cfg(target_os="linux")]mod display_wayland;
mod compound;
mod http;
mod log;
mod notifications_validation;
#[cfg(target_os="linux")]mod notifications_linux;
#[cfg(windows)]mod notifications_windows;
mod thumbnail;
#[cfg(any(windows,target_os="linux"))]mod thumbnail_icon;
mod thumbnail_pdf;
mod auth;
mod authdialog;
mod container;
mod monitor;
mod language;
#[cfg(any(windows,target_os="linux"))]mod language_native;
mod vision;
mod vision_models;
mod audio_models;
mod text_models;
mod local_ai;
mod snapshot;
#[cfg(windows)]mod vision_windows;
#[cfg(target_os="linux")]mod vision_linux;
mod native_library;
mod engine_bundle;
mod trust;
mod stream;
mod stream_media;
mod sounds;
mod sensitive;
mod update;
mod update_ui;
mod location;
mod maps;
mod music;
mod share;
mod contacts;
mod eventkit;
mod photos;
mod vm;
mod vm_guest;
mod vm_forward;
mod vm_input;
mod overlay;
mod overlay_tracking;
mod overlay_validation;
#[cfg(all(any(windows,target_os="linux"),feature="overlay"))]mod overlay_native;
#[cfg(windows)]mod eventkit_windows;
#[cfg(target_os="linux")]mod eventkit_linux;
#[cfg(windows)]mod contacts_windows;
#[cfg(target_os="linux")]mod contacts_linux;
#[cfg(windows)]mod share_windows;
#[cfg(target_os="linux")]mod share_linux;
#[cfg(windows)]mod music_windows;
#[cfg(target_os="linux")]mod music_linux;
#[cfg(target_os="linux")]mod native_bus;
#[cfg(windows)]mod maps_windows;
#[cfg(target_os="linux")]mod maps_linux;
#[cfg(windows)]mod location_windows;
#[cfg(target_os="linux")]mod location_linux;
mod script;
mod script_sqlite;
mod pdf;
mod audio;
mod vad;
mod speech;
#[cfg(windows)]mod speech_windows;
mod secret_registration;
mod secret_target;
#[cfg(windows)]mod auth_windows;
#[cfg(target_os="linux")]mod auth_linux;
#[cfg(windows)]mod log_windows;
#[cfg(target_os="linux")]mod log_linux;
#[cfg(windows)]mod display_windows;
#[cfg(windows)]mod capture_windows;
#[cfg(target_os="linux")]mod capture_linux;
#[cfg(windows)] mod clipboard_windows;
#[cfg(target_os = "linux")] mod clipboard_linux;
#[cfg(windows)] mod windows;
#[cfg(target_os = "linux")] mod linux;
#[cfg(target_os = "linux")] mod linux_x11;
#[cfg(target_os = "linux")] mod linux_hyprland;
#[cfg(target_os = "linux")] mod clipboard_wayland;
#[cfg(target_os = "linux")] mod linux_peer;

use contract_generated::{DESKTOP_MAX_FRAME_BYTES, DESKTOP_PROTOCOL_VERSION, DesktopRequest};
use serde_json::{Value, json};
use std::io::{self, Read, Write};

fn failure(code: &str, message: impl ToString) -> Value {
    json!({"success":false,"code":code,"error":message.to_string()})
}
fn success(data: Value) -> Value { json!({"success":true,"data":data}) }
fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0_u8; 4];
    if reader.read(&mut header[..1])? == 0 { return Ok(None); }
    reader.read_exact(&mut header[1..])?;
    let size = u32::from_le_bytes(header) as usize;
    if size == 0 || size > DESKTOP_MAX_FRAME_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid desktop frame length")); }
    let mut bytes = vec![0; size]; reader.read_exact(&mut bytes)?; Ok(Some(bytes))
}
fn write_frame<W: Write>(writer: &mut W, bytes: &[u8]) -> io::Result<()> {
    if bytes.is_empty() || bytes.len() > DESKTOP_MAX_FRAME_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidData, "desktop frame exceeds limit")); }
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(bytes)?; writer.flush()
}
fn client_session<R: Read, W: Write>(reader: &mut R, writer: &mut W, stop: bool) -> io::Result<()> {
    if stop {
        write_frame(writer, &serde_json::to_vec(&json!({"id":"shutdown","protocolVersion":DESKTOP_PROTOCOL_VERSION,"action":{"type":"desktop_shutdown"}}))?)?;
        let reply = read_frame(reader)?.ok_or_else(|| io::Error::other("provider closed before shutdown acknowledgement"))?;
        let result: Value = serde_json::from_slice(&reply)?;
        if result["id"] != "shutdown" || result["result"]["success"] != true { return Err(io::Error::other("provider refused shutdown")); }
        return Ok(());
    }
    let mut stdin = io::stdin().lock(); let mut stdout = io::stdout().lock();
    while let Some(frame) = read_frame(&mut stdin)? {
        write_frame(writer, &frame)?;
        let reply = read_frame(reader)?.ok_or_else(|| io::Error::other("native provider disconnected"))?;
        write_frame(&mut stdout, &reply)?;
    }
    Ok(())
}

fn handle(request: DesktopRequest) -> Value {
    if request.id.is_empty() || request.id.len() > 128 {
        return failure("invalid_request", "id must contain 1..128 bytes");
    }
    if request.protocolVersion.is_some_and(|v| v != DESKTOP_PROTOCOL_VERSION as f64) {
        return failure("version_mismatch", "desktop protocol version 1 required");
    }
    let Some(action_type) = request.action.get("type").and_then(Value::as_str) else {
        return failure("invalid_request", "missing action type");
    };
    let Some(verb) = action_type.strip_prefix("desktop_") else {
        return failure("invalid_request", "desktop_ action prefix required");
    };
    let mut action = serde_json::to_value(&request.action).unwrap_or(Value::Null);
    if verb == "notifications" {
        if let Err(error) = notifications_validation::validate(&action) { return error; }
        #[cfg(target_os="linux")]return notifications_linux::dispatch(&action);
        #[cfg(windows)]return notifications_windows::dispatch(&action);
    }
    if verb == "shutdown" {
        return if request.action.len() == 1 {
            let _=language::stop_translation();local_ai::shutdown();
            let sensitive=sensitive::shutdown();
            let location=location::shutdown();
            let music=music::shutdown();
            let vms=vm::shutdown();
            let overlays=overlay::shutdown();
            let speech=speech::shutdown();
            let vad=vad::shutdown();let audio=audio::shutdown();
            let streams=stream::dispatch(&json!({"type":"desktop_stream","op":"stop"}));
            let sounds=sounds::shutdown();
            if speech["success"]==true&&vad["success"]==true&&audio["success"]==true&&streams["success"]==true&&sounds["success"]==true&&sensitive["success"]==true&&location["success"]==true&&music["success"]==true&&vms["success"]==true&&overlays["success"]==true{audio}else{failure("partial_result",format!("provider native shutdown failed: speech={speech}, vad={vad}, audio={audio}, streams={streams}, sounds={sounds}, sensitive={sensitive}, location={location}, music={music}, vms={vms}, overlays={overlays}"))}
        }
            else { failure("invalid_request", "provider shutdown accepts no target fields") };
    }
    if verb.starts_with("fs_") { return filesystem::dispatch(verb, &action); }
    if verb == "files" { return files::dispatch(&action); }
    if verb == "monitor" { return monitor::dispatch(&action); }
    if ["nlp", "ai", "translate", "detect"].contains(&verb) { return language::dispatch(&action); }
    if verb == "vision" { return vision::dispatch(&action); }
    if verb == "sensitive" { return sensitive::dispatch(&action); }
    if verb == "location" { return location::dispatch(&action); }
    if verb == "maps" { return maps::dispatch(&action); }
    if verb == "share" { return share::dispatch(&action); }
    if verb == "contacts" { return contacts::dispatch(&action); }
    if ["calendar", "reminders"].contains(&verb) { return eventkit::dispatch(&action); }
    if verb == "photos" { return photos::dispatch(&action); }
    if verb == "vm" { return vm::dispatch(&action); }
    if verb == "overlay" { return overlay::dispatch(&action); }
    if verb == "music" { return music::dispatch(&action); }
    if verb == "update" { return update::dispatch(&action); }
    if ["script_run","intent_dispatch"].contains(&verb) { return script::dispatch(&action); }
    // Warmup pre-launches an Apple Events target; Windows and Linux dispatch runs --jsc only.
    if verb == "intent_warmup" { return failure("unsupported_operation", "intent warmup prepares an Apple Events target on macOS; Windows and Linux intent dispatch runs --jsc JavaScript, which needs no warmup"); }
    if verb == "pdf" { return pdf::dispatch(&action); }
    if verb == "audio" { return audio::dispatch(&action); }
    if verb == "vad" { return vad::dispatch(&action); }
    if verb == "listen" { return speech::dispatch(&action); }
    if verb == "trust" { return trust::dispatch(&action); }
    if verb == "stream" { return stream::dispatch(&action); }
    if verb == "sounds" { return sounds::dispatch(&action); }
    if verb == "clipboard" { return clipboard::dispatch(&action); }
    if verb == "url_fetch" { return http::dispatch(&action); }
    if verb == "log_query" { return log::dispatch(&action); }
    if verb == "thumbnail" { return thumbnail::dispatch(&action); }
    if verb == "auth" { return auth::dispatch(&action); }
    if verb == "authdialog" { accessibility::normalize_integer_fields(&mut action); return authdialog::dispatch(&action); }
    if verb == "health" {
        if let Some(error) = contract_generated::desktop_health_shape_error(&action) {
            return failure("invalid_request", error);
        }
        return success(json!({"available":false,"note":"This Interceptor provider has no configured health-data backend."}));
    }
    if verb == "container_run" { return container::dispatch(&action); }
    if ["display_list","display_info"].contains(&verb){return display::dispatch(verb,&action);}
    if ["screenshot","capture"].contains(&verb) {
        // Integral JSON forms such as HWND 123.0 must retain their exact
        // target. Reuse the native integer normalizer before selector reads.
        accessibility::normalize_integer_fields(&mut action);
        return capture::dispatch(verb,&action);
    }
    accessibility::normalize_integer_fields(&mut action);
    if ["read","act","inspect_app","open"].contains(&verb){return compound::dispatch(verb,&action);}
    if let Err(error) = accessibility::validate(verb, &action) { return error; }
    // Lifecycle requests share strict wire validation but remain outside the
    // accessibility worker because their targets are windows and processes.
    #[cfg(windows)] if verb == "app" { return windows::app_command(&action); }
    #[cfg(target_os = "linux")] if verb == "app" { return linux::dispatch(verb, &action); }
    if verb == "hello" || verb == "capabilities" {
        return success(hello());
    }
    #[cfg(windows)] { return windows::dispatch(verb, &action); }
    #[cfg(target_os = "linux")] { return linux::dispatch(verb, &action); }
    #[cfg(not(any(windows, target_os = "linux")))] {
        let _ = action;
        failure("unsupported_operation", "macOS uses the existing Swift provider")
    }
}

fn hello() -> Value {
    #[cfg(windows)] let (host, session, capabilities) = ("win32", windows::session(), windows::capabilities());
    #[cfg(target_os = "linux")] let (host, session, capabilities) = ("linux", linux::session(), linux::capabilities());
    #[cfg(not(any(windows, target_os = "linux")))] let (host, session, capabilities) = ("darwin", "test-only".to_owned(), json!([]));
    #[cfg(any(windows, target_os = "linux"))] let mut capabilities = capabilities;
    #[cfg(any(windows, target_os = "linux"))] if let Some(entries) = capabilities.as_array_mut() {
        entries.extend(filesystem::capabilities(host, &session));
        entries.push(files::capability(&session));
        entries.push(monitor::capability(&session));
        entries.extend(language::capabilities(&session));
        entries.push(vision::capability(&session));
        entries.push(sensitive::capability(&session));
        entries.push(update::capability(&session));
        entries.extend(script::capabilities_for(&session));
        entries.push(pdf::capability(&session));
        entries.push(audio::capability(&session));
        entries.push(vad::capability(&session));
        entries.push(speech::capability(&session));
        entries.push(trust::capability(&session));
        entries.push(location::capability(&session));
        entries.push(maps::capability(&session));
        entries.push(music::capability(&session));
        entries.push(share::capability(&session));
        entries.push(contacts::capability(&session));
        entries.extend(eventkit::capabilities(&session));
        entries.push(photos::capability(&session));
        entries.push(vm::capability(&session));
        entries.push(overlay::capability(&session));
        entries.push(stream::capability(&session));
        entries.push(sounds::capability(&session));
        entries.push(clipboard::capability(host, &session, capabilities_clipboard_session()));
        entries.extend(capture::capabilities(host,&session,graphical_session()));
        entries.extend(display::capabilities(host,&session,graphical_session()));
        let accessibility_session=entries.iter().any(|entry|entry["operation"]=="tree" && entry["effective"]==true);
        entries.extend(compound::capabilities(host,&session,accessibility_session));
        entries.push(http::capability(&session));
        entries.push(log::capability(&session));
        entries.push(thumbnail::capability(&session));
        entries.push(auth::capability(&session));
        entries.push(authdialog::capability(&session));
        entries.push(json!({"operation":"health","compiled":true,"present":true,"effective":true,
            "background":"semantic","permission":"not_applicable","session":session,
            "provider":"interceptor-desktop-rust","versions":{"contract":"1"},
            "limits":["Status-only provider configuration diagnostics. No health-data store, reads, writes or synchronization is implemented."],
            "reason":"Status reports the actual absence of a configured Interceptor health-data backend; it does not establish health-data access."}));
        entries.push(container::capability(&session));
        #[cfg(target_os="linux")]entries.push(notifications_linux::capability(&session));
        #[cfg(windows)]entries.push(notifications_windows::capability(&session));
        apply_readiness(entries);
    }
    json!({"protocolVersion":DESKTOP_PROTOCOL_VERSION,"maxFrameBytes":DESKTOP_MAX_FRAME_BYTES,
      "host":host,"provider":"interceptor-desktop-rust","version":env!("CARGO_PKG_VERSION"),
      "pid":std::process::id(),"session":session,"capabilities":capabilities})
}

fn capabilities_clipboard_session() -> bool {
    #[cfg(windows)] {windows::session() != "0"}
    #[cfg(target_os="linux")] {linux::login_session(0).is_some() && std::env::var_os("DISPLAY").is_some()&&std::env::var_os("WAYLAND_DISPLAY").is_none()&&std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some()}
    #[cfg(not(any(windows,target_os="linux")))] {false}
}

/// A graphical login this provider can read: X11 or Wayland on Linux. Unlike the clipboard
/// gate above, Wayland qualifies (display metadata reads wl_output/xdg-output there).
fn graphical_session() -> bool {
    #[cfg(windows)] {windows::session() != "0"}
    #[cfg(target_os="linux")] {linux::login_session(0).is_some() && (std::env::var_os("DISPLAY").is_some()||std::env::var_os("WAYLAND_DISPLAY").is_some()) && std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some()}
    #[cfg(not(any(windows,target_os="linux")))] {false}
}

fn serve<R: Read, W: Write>(reader: &mut R, writer: &mut W, authorized: bool) -> io::Result<()> {
    // Bound both the number and byte length of remembered IDs per connection.
    let mut request_ids = std::collections::HashSet::new();
    #[cfg(target_os = "linux")] let connection_login = linux::login_identity(0);
    loop {
        let Some(bytes) = read_frame(reader)? else { return Ok(()); };
        #[cfg(target_os = "linux")] let authorized = authorized && linux::login_identity(0) == connection_login;
        let value = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
        let id = value.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
        let shutdown = authorized && value["action"]["type"] == "desktop_shutdown";
        // serde's Option accepts explicit null, while the shared contract does
        // not. Check optional fields before converting the same parsed value.
        let malformed = !value.is_object() ||
            value.get("protocolVersion").is_some_and(|v| !v.is_number()) ||
            value.get("token").is_some_and(|v| !v.is_string());
        // Read the bounded initial frame before rejecting a peer. Closing with
        // unread handshake bytes can reset the socket before it gets the denial.
        let result = if !authorized { failure("permission_denied", "native provider requires the same user and login session") }
            else if malformed { failure("invalid_request", "malformed desktop request") }
            else if id.is_empty() || id.len() > 128 { failure("invalid_request", "id must contain 1..128 bytes") }
            else if request_ids.contains(&id) { failure("invalid_request", "duplicate request id on this connection") }
            else if request_ids.len() >= 4096 { failure("invalid_request", "connection request limit reached; open a new connection") }
            else { request_ids.insert(id.clone()); match serde_json::from_value::<DesktopRequest>(value) {
                Ok(request) => handle(request),
                Err(_) => failure("invalid_request", "malformed desktop request"),
            }};
        let reply = json!({"id":id,"result":result});
        let bytes = serde_json::to_vec(&reply)?;
        write_frame(writer, &bytes)?;
        if !authorized || (shutdown && reply["result"]["success"] == true) {
            // DisconnectNamedPipe discards unread output. Keep the connection
            // alive until the client closes (or its next byte / I/O deadline),
            // without FlushFileBuffers' unbounded wait or executing a request.
            let _ = reader.read(&mut [0_u8]);
            if authorized { std::process::exit(0); }
            return Ok(());
        }
    }
}

#[cfg(unix)] fn unix_server(path: &str) -> io::Result<()> {
    use std::os::unix::{fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt}, net::{UnixListener, UnixStream}};
    use std::os::fd::AsRawFd;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    let parent = std::path::Path::new(path).parent().ok_or_else(|| io::Error::other("missing socket parent"))?;
    match std::fs::DirBuilder::new().mode(0o700).create(parent) {
        Ok(()) => (), Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (), Err(e) => return Err(e),
    }
    let meta = std::fs::symlink_metadata(parent)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "socket parent must be an owned private directory (0700)"));
    }
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true)
        .mode(0o600).custom_flags(libc::O_NOFOLLOW).open(format!("{path}.lock"))?;
    let lock_meta = lock.metadata()?;
    if lock_meta.uid() != unsafe { libc::geteuid() } || lock_meta.mode() & 0o077 != 0 ||
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(io::Error::other("provider endpoint already owned or lock is not private"));
    }
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } || UnixStream::connect(path).is_ok() {
            return Err(io::Error::other("refusing to replace another endpoint"));
        }
        // The kernel lock is held; only this provider's inactive owned socket
        // can be removed. A live or foreign endpoint is never unlinked.
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    // This process owns the session endpoint; only the installed Full provider starts updating.
    update::start();
    #[cfg(target_os = "linux")] let login = linux::login_identity(0)
        .ok_or_else(|| io::Error::new(io::ErrorKind::PermissionDenied, "provider requires a login session; user-service callers need an authorized GUI broker"))?;
    #[cfg(target_os = "linux")] listener.set_nonblocking(true)?;
    let active = Arc::new(AtomicUsize::new(0));
    loop {
        #[cfg(target_os = "linux")] if linux::login_identity(0).as_ref() != Some(&login) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "provider login ended, changed or became ambiguous"));
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            #[cfg(target_os = "linux")] Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(100)); continue;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        stream.set_read_timeout(Some(std::time::Duration::from_secs(15)))?;
        stream.set_write_timeout(Some(std::time::Duration::from_secs(15)))?;
        #[cfg(target_os = "linux")] let authorized = linux_peer::authorized(&stream, &login.id, None);
        #[cfg(not(target_os = "linux"))] let authorized = true;
        if active.load(Ordering::SeqCst) >= 32 { continue; }
        active.fetch_add(1, Ordering::SeqCst);
        let active = active.clone();
        std::thread::spawn(move || {
            if let Ok(mut output) = stream.try_clone() { let _ = serve(&mut stream, &mut output, authorized); }
            active.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

fn client_io_timeout(args: &[String]) -> io::Result<u32> {
    if args.len() <= 3 { return Ok(15_000); }
    if args.len() == 5 && args[3] == "--timeout-ms" {
        if let Ok(value) = args[4].parse::<u32>() {
            if (100..=600_000).contains(&value) { return Ok(value); }
        }
    }
    Err(io::Error::new(io::ErrorKind::InvalidInput, "native client --timeout-ms requires an integer from 100 to 600000"))
}

/// The provider is started at login, so service settings must be in its login environment, not a shell.
#[cfg(windows)] pub(crate) const PROVIDER_ENV_HINT: &str = "set it as a Windows user environment variable (setx NAME value), then sign out and back in so the Interceptor provider sees it";
#[cfg(not(windows))] pub(crate) const PROVIDER_ENV_HINT: &str = "set it in ~/.config/environment.d/interceptor.conf (NAME=value), then log out and back in so the Interceptor provider sees it";
fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|s| s == "--version") { println!("{}", env!("CARGO_PKG_VERSION")); return Ok(()); }
    // The detached update watcher runs before any native initialization (update.rs).
    if args.get(1).is_some_and(|s| s == "--update-apply") { return update::apply(args.get(2).map(String::as_str)); }
    if args.get(1).is_some_and(|s|s=="--engines-check"){
        if args.len()!=3{return Err(io::Error::other("usage: --engines-check <absolute-engine-directory>"));}
        // Read-only disposable diagnostics may block inside filesystem APIs.
        // The watchdog terminates only this verifier, never a live provider.
        std::thread::spawn(||{std::thread::sleep(std::time::Duration::from_secs(45));eprintln!("engine verifier filesystem deadline exceeded");std::process::exit(1);});
        let result=filesystem::absolute(&args[2]).and_then(|root|engine_bundle::check(&root));
        match result{Ok(data)=>{println!("{}",data);return Ok(());},Err(error)=>{eprintln!("{}",error);return Err(io::Error::other("engine bundle validation failed"));}}
    }
    // Helpers run under a 512 MiB address-space limit. glibc reserves a 64 MiB malloc arena per
    // thread, so threaded native libraries (EDS) hit the limit while using far less and abort
    // (2 of 10 calendar helpers on Omarchy); two arenas keep the reservation small.
    #[cfg(all(target_os="linux",target_env="gnu"))]if args.get(1).is_some_and(|mode|mode.starts_with("--")){unsafe{libc::mallopt(libc::M_ARENA_MAX,2);}}
    if args.len()==2&&args[1]=="--auth-ui"{return auth::helper();}
    if args.len()==2&&args[1]=="--secret-ui"{return secret_registration::helper();}
    if args.len()==2&&args[1]=="--thumbnail-pdf"{return thumbnail::pdf_helper();}
    if args.len()==2&&args[1]=="--script-engine"{return script::helper();}
    if args.len()==2&&args[1]=="--pdf-engine"{return pdf::helper();}
    if args.get(1).is_some_and(|mode|matches!(mode.as_str(),"--audio-engine"|"--audio-devices"|"--translation-engine"|"--speech-engine"|"--trust-state"|"--sound-engine"|"--vision-ocr"|"--sensitive-engine"|"--location-engine"|"--maps-open-engine"|"--music-engine"|"--music-system-engine"|"--share-engine"|"--contacts-engine"|"--eventkit-engine"|"--photos-engine"|"--vm-engine"|"--vm-image-engine"|"--overlay-engine"|"--overlay-tracking"|"--update-ui")){
        if args.len()!=3{return Err(io::Error::other("native helper requires one provider process ID"));}
        let parent=args[2].parse::<u32>().map_err(|_|io::Error::other("native helper requires its provider process ID"))?;
        return match args[1].as_str(){"--translation-engine"=>language::translation_helper(parent),"--speech-engine"=>speech::helper(parent),"--trust-state"=>trust::helper(parent),"--sound-engine"=>sounds::helper(parent),"--vision-ocr"=>vision::helper(parent),"--sensitive-engine"=>sensitive::helper(parent),"--location-engine"=>location::helper(parent),"--maps-open-engine"=>maps::open_helper(parent),"--music-engine"=>music::helper(parent),"--music-system-engine"=>music::system_helper(parent),"--share-engine"=>share::helper(parent),"--contacts-engine"=>contacts::helper(parent),"--eventkit-engine"=>eventkit::helper(parent),"--photos-engine"=>photos::helper(parent),"--vm-engine"=>vm::system_helper(parent),"--vm-image-engine"=>vm::image_helper(parent),"--overlay-engine"=>overlay::helper(parent),"--update-ui"=>update_ui::helper(parent),"--overlay-tracking"=>overlay_tracking::helper(parent),_=>audio::helper(args[1]=="--audio-devices",parent)};
    }
    if args.len()==2&&args[1]=="--third-party-notices"{return std::io::stdout().lock().write_all(include_bytes!("../THIRD-PARTY-NOTICES.txt"));}
    if args.len()==2&&args[1]=="--files-open"{return files::inventory_helper();}
    #[cfg(windows)] if args.get(1).is_some_and(|s| s == "--identity") { println!("{}", windows::identity()?); return Ok(()); }
    #[cfg(any(windows, target_os = "linux"))] if args.get(1).is_some_and(|s| s == "--client" || s == "--stop") {
        let timeout_ms = client_io_timeout(&args)?;
        #[cfg(windows)] let result = windows::client(args.get(2).map(String::as_str), args[1] == "--stop", timeout_ms);
        #[cfg(target_os = "linux")] let result = linux::client(args.get(2).map(String::as_str), args[1] == "--stop", timeout_ms);
        if let Err(error) = result {
            // An absent endpoint is already stopped. Authentication failures
            // still fail, so maintenance cannot stop or replace a foreign peer.
            if args[1] == "--stop" && error.kind() == io::ErrorKind::NotFound { return Ok(()); }
            write_frame(&mut io::stdout().lock(), &serde_json::to_vec(&json!({"id":"hello","result":failure(
                if error.kind() == io::ErrorKind::PermissionDenied { "permission_denied" } else { "provider_failed" }, &error)}))?)?;
            return Err(error);
        }
        return Ok(());
    }
    #[cfg(target_os = "linux")] if args.get(1).is_some_and(|s| s == "--identity") { println!("{}", linux::identity()?); return Ok(()); }
    #[cfg(target_os = "linux")] if args.get(1).is_some_and(|s|s=="--pointer-stage"){
        if !(4..=5).contains(&args.len()){return Err(io::Error::other("usage: --pointer-stage <source> <private-stage> [owned-image-name]"));}
        let payload=interceptor_desktop::pointer_payload::stage(std::path::Path::new(&args[2]),std::path::Path::new(&args[3]),args.get(4).map(String::as_str))?;
        println!("{}",json!({"path":payload.path,"sha256":payload.sha256,"abiHash":payload.abi_hash}));return Ok(());
    }
    #[cfg(target_os = "linux")] {
        let operation=args.get(1).map(String::as_str);
        let maintenance=matches!(operation,Some("--pointer-check"|"--pointer-load"|"--pointer-unload"));
        let startup=args.len()==1&&std::env::var_os("WAYLAND_DISPLAY").is_some();
        if maintenance||startup{
            let directory=std::env::current_exe()?.parent().ok_or_else(||io::Error::other("native executable directory unavailable"))?.join("hyprland");
            let action=(||->io::Result<Value>{
                let Some(payload)=interceptor_desktop::pointer_payload::read(&directory)? else{return Ok(json!({"present":false,"loaded":false}));};
                if operation==Some("--pointer-check"){return Ok(json!({"present":true,"path":payload.path,"sha256":payload.sha256,"abiHash":payload.abi_hash}));}
                linux::identity()?;
                linux_hyprland::pointer_maintenance(&payload,operation!=Some("--pointer-unload")).map_err(|error|io::Error::other(error.to_string()))
            })();
            if maintenance{println!("{}",action?);return Ok(());}
            if let Err(error)=action{eprintln!("Installed pointer integration unavailable: {error}");}
        }
    }
    accessibility::initialize_refs()?;
    #[cfg(target_os="linux")]notifications_linux::initialize();
    #[cfg(windows)]notifications_windows::initialize();
    if args.get(1).is_some_and(|s| s == "--stdio") {
        return serve(&mut io::stdin().lock(), &mut io::stdout().lock(), true);
    }
    #[cfg(windows)] { return windows::run(); }
    #[cfg(target_os = "linux")] if args.len() == 1 {
        let identity = linux::identity()?;
        return unix_server(identity["endpoint"].as_str().ok_or_else(|| io::Error::other("missing native session endpoint"))?);
    }
    #[cfg(unix)] {
        if let Some(path) = args.get(1).filter(|_| args.len() == 2) { return unix_server(path); }
    }
    #[cfg(not(windows))] { Err(io::Error::other("usage: interceptor-desktop --stdio | <private-directory/socket>")) }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn health_availability_is_status_only_and_strict() {
        for action in [json!({"type":"desktop_health"}), json!({"type":"desktop_health","sub":"status"})] {
            let result = handle(serde_json::from_value(json!({"id":"health-status","action":action})).unwrap());
            assert_eq!(result["success"], true);
            assert_eq!(result["data"]["available"], false);
            assert!(result["data"]["note"].as_str().unwrap().contains("no configured health-data backend"));
            assert!(serde_json::from_value::<contract_generated::DesktopHealthData>(result["data"].clone()).is_ok());
        }
        for extra in [json!({"sub":"get"}), json!({"sub":null}), json!({"sub":1}), json!({"pid":1}), json!({"groupSoft":1})] {
            let mut action = json!({"type":"desktop_health"});
            action.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            let result = handle(serde_json::from_value(json!({"id":"health-invalid","action":action})).unwrap());
            assert_eq!(result["success"], false, "{result}");
            assert_eq!(result["code"], "invalid_request", "{result}");
        }
    }
    #[test] fn discovery_matches_generated_contract() {
        let value = hello();
        assert!(serde_json::from_value::<contract_generated::DesktopHello>(value.clone()).is_ok(), "{value}");
    }
    #[test] fn malformed_notifications_refuse_before_native_dispatch() {
        for action in [json!({"type":"desktop_notifications","sub":"log","limit":-1}),
            json!({"type":"desktop_notifications","sub":"schedule-after","seconds":59,"repeats":true}),
            json!({"type":"desktop_notifications","sub":"cancel-all","id":"unrelated"}),
            json!({"type":"desktop_notifications","sub":"categories","verb":"register","identifier":"owned","actions":"[{\"identifier\":\"x\",\"title\":\"x\",\"extra\":true}]"})] {
            let result=handle(serde_json::from_value(json!({"id":"notification-negative","protocolVersion":1,"action":action})).unwrap());
            assert_eq!(result["success"],false);assert_eq!(result["code"],"invalid_request","{result}");
        }
    }
    #[test] fn malformed_lifecycle_requests_refuse_before_platform_dispatch() {
        let fixtures: Value = serde_json::from_str(include_str!("../../shared/desktop-accessibility-fixtures.json")).unwrap();
        let actions = fixtures["invalid"].as_array().unwrap().iter()
            .filter(|case| case["action"]["type"] == "desktop_app").collect::<Vec<_>>();
        assert!(!actions.is_empty());
        for case in actions {
            let request = serde_json::from_value(json!({"id":"app-malformed","protocolVersion":1,"action":case["action"]})).unwrap();
            let result = handle(request);
            assert_eq!(result["success"], false, "{case}");
            assert_eq!(result["code"], "invalid_request", "{case}: {result}");
        }
    }
    #[test] fn native_client_deadline_is_bounded() {
        let arguments = |extra: &[&str]| ["provider", "--client", "endpoint"].into_iter()
            .chain(extra.iter().copied()).map(String::from).collect::<Vec<_>>();
        assert_eq!(client_io_timeout(&arguments(&[])).unwrap(), 15_000);
        for value in ["100", "31000", "600000"] {
            assert_eq!(client_io_timeout(&arguments(&["--timeout-ms", value])).unwrap(), value.parse::<u32>().unwrap());
        }
        for extra in [vec!["--timeout-ms"], vec!["--wrong", "31000"], vec!["--timeout-ms", "0"],
            vec!["--timeout-ms", "99"], vec!["--timeout-ms", "600001"], vec!["--timeout-ms", "NaN"],
            vec!["--timeout-ms", "31.5"], vec!["--timeout-ms", "-1"], vec!["--timeout-ms", "31000", "extra"]] {
            assert_eq!(client_io_timeout(&arguments(&extra)).unwrap_err().kind(), io::ErrorKind::InvalidInput);
        }
    }
    #[test] fn framing_and_negotiation() {
        let mut frames = Vec::new();
        for version in [1, 99] {
            let payload = serde_json::to_vec(&json!({"id":format!("fixture-{version}"),"protocolVersion":version,"action":{"type":"desktop_hello"}})).unwrap();
            frames.extend((payload.len() as u32).to_le_bytes()); frames.extend(payload);
        }
        let mut result = Vec::new();
        serve(&mut frames.as_slice(), &mut result, true).unwrap();
        let mut cursor = result.as_slice();
        for (version, expected) in [(1, true), (99, false)] {
            let mut header = [0; 4]; cursor.read_exact(&mut header).unwrap();
            let size = u32::from_le_bytes(header) as usize;
            let reply: Value = serde_json::from_slice(&cursor[..size]).unwrap(); cursor = &cursor[size..];
            assert_eq!(reply["id"], format!("fixture-{version}")); assert_eq!(reply["result"]["success"], expected);
        }
        assert!(serve(&mut (DESKTOP_MAX_FRAME_BYTES as u32 + 1).to_le_bytes().as_slice(), &mut Vec::new(), true).is_err());
        assert!(read_frame(&mut [1_u8, 0].as_slice()).is_err());
        assert!(read_frame(&mut [2_u8, 0, 0, 0, 1].as_slice()).is_err());
        let mut denied = Vec::new();
        serve(&mut frames.as_slice(), &mut denied, false).unwrap();
        let reply: Value = serde_json::from_slice(&denied[4..]).unwrap();
        assert_eq!(reply["id"], "fixture-1");
        assert_eq!(reply["result"]["code"], "permission_denied");
    }
    #[test] fn malformed_optional_fields_are_rejected() {
        for field in ["protocolVersion", "token"] {
            for invalid in [Value::Null, json!([]), json!({}), json!(true)] {
                let mut request = json!({"id":"invalid-field","action":{"type":"desktop_hello"}});
                request[field] = invalid;
                let payload = serde_json::to_vec(&request).unwrap();
                let mut frame = (payload.len() as u32).to_le_bytes().to_vec(); frame.extend(payload);
                let mut result = Vec::new(); serve(&mut frame.as_slice(), &mut result, true).unwrap();
                let reply: Value = serde_json::from_slice(&result[4..]).unwrap();
                assert_eq!(reply["id"], "invalid-field");
                assert_eq!(reply["result"]["code"], "invalid_request");
            }
        }
    }
    #[test] fn duplicate_ids_are_rejected_before_dispatch() {
        let mut frames = Vec::new();
        for version in [1, 99] {
            let payload = serde_json::to_vec(&json!({"id":"duplicate","protocolVersion":version,"action":{"type":"desktop_hello"}})).unwrap();
            write_frame(&mut frames, &payload).unwrap();
        }
        let mut replies = Vec::new();
        serve(&mut frames.as_slice(), &mut replies, true).unwrap();
        let mut cursor = replies.as_slice();
        let first: Value = serde_json::from_slice(&read_frame(&mut cursor).unwrap().unwrap()).unwrap();
        let second: Value = serde_json::from_slice(&read_frame(&mut cursor).unwrap().unwrap()).unwrap();
        assert_eq!(first["result"]["success"], true);
        assert_eq!(second["id"], "duplicate");
        assert_eq!(second["result"]["code"], "invalid_request");
        assert!(second["result"]["error"].as_str().unwrap().contains("duplicate"));
        let mut frames = Vec::new();
        for index in 0..4097 {
            write_frame(&mut frames, &serde_json::to_vec(&json!({"id":index.to_string(),"action":{"type":"desktop_hello"}})).unwrap()).unwrap();
        }
        let mut replies = Vec::new();
        serve(&mut frames.as_slice(), &mut replies, true).unwrap();
        let mut cursor = replies.as_slice();
        for index in 0..4097 {
            let reply: Value = serde_json::from_slice(&read_frame(&mut cursor).unwrap().unwrap()).unwrap();
            assert_eq!(reply["result"]["success"], index < 4096);
            if index == 4096 { assert!(reply["result"]["error"].as_str().unwrap().contains("limit")); }
        }
    }
}

/// Whether an operation can do its job on this host now, from what it actually needs (an
/// engine, a configured service, a system library or program). Rows report this
/// instead of per-module constants, and every unavailable row says why.
#[cfg(any(windows, target_os = "linux"))]
fn readiness(operation: &str) -> Option<Result<(), String>> {
    let engine = |var: &str, name: &str| native_library::engine_ready(var).map_err(|_| format!("needs the {name} engine ({var}), which this build does not ship"));
    let configured = |vars: &[&str], what: &str| if vars.iter().all(|v| std::env::var_os(v).is_some()) { Ok(()) } else { Err(format!("needs {what} ({}); {PROVIDER_ENV_HINT}", vars.join(", "))) };
    let llama = || if std::env::var_os("INTERCEPTOR_LLAMA_CHAT_URL").is_some() { Ok(()) } else { Err(String::new()) };
    #[cfg(target_os = "linux")] let library = |var: &str, stem: &str, package: &str| native_library::system_library(var, stem, package).map(|_| ()).map_err(|e| e["error"].as_str().unwrap_or("system library missing").to_owned());
    Some(match operation {
        "update" | "trust" | "script_run" | "intent_dispatch" | "monitor" | "auth" | "authdialog" | "share" | "music" => Ok(()),
        "pdf" => engine("INTERCEPTOR_PDFIUM_LIBRARY", "pdfium PDF"),
        // Windows OCR and FaceDetector ship with the OS. Linux needs tesseract (text) or
        // gst-plugin-opencv (faces); an engine bundle can still provide pinned libraries.
        #[cfg(windows)] "vision" => Ok(()),
        // The bundled models cover hands, bodies, classify and saliency on their own.
        #[cfg(target_os = "linux")] "vision" => engine("INTERCEPTOR_VISION_PALM_MODEL", "bundled vision").or_else(|_| engine("INTERCEPTOR_TESSERACT_LIBRARY", "tesseract OCR"))
            .or_else(|_| library("INTERCEPTOR_TESSERACT_SYSTEM_LIBRARY", "libtesseract", "tesseract and tesseract-data-eng"))
            .or_else(|e| if ["/usr/lib/gstreamer-1.0", "/usr/lib/aarch64-linux-gnu/gstreamer-1.0", "/usr/lib/x86_64-linux-gnu/gstreamer-1.0"].iter().any(|d| std::path::Path::new(d).join("libgstopencv.so").is_file()) { Ok(()) } else { Err(format!("{e}; faces need gst-plugin-opencv")) }),
        // tokens need nothing; language uses the OS (Windows) or libexttextcat (Linux); embed and
        // similar use the bundled model; entities and sentiment use the local AI model.
        "nlp" => engine("INTERCEPTOR_EMBED_MODEL", "bundled text-embedding"),
        // Windows ships an offline dictation recognizer (SAPI); whisper.cpp, when configured, takes precedence.
        #[cfg(windows)] "listen" => engine("INTERCEPTOR_WHISPER_CLI", "whisper.cpp speech").or_else(|e| speech_windows::installed().map_err(|w| format!("{e}; {w}"))),
        #[cfg(not(windows))] "listen" => engine("INTERCEPTOR_WHISPER_CLI", "whisper.cpp speech"),
        "sounds" => engine("INTERCEPTOR_SOUND_MODEL", "bundled sound"),
        "vm" => engine("INTERCEPTOR_QEMU_SYSTEM", "qemu virtual machine"),
        "photos" => engine("INTERCEPTOR_PHOTOS_EXIFTOOL", "exiftool metadata").and_then(|_| configured(&["INTERCEPTOR_PHOTOS_LIBRARY"], "an owner-private photo folder")),
        // A configured server, or the bundled server with its model already downloaded.
        "ai" | "translate" | "detect" => llama().or_else(|_| local_ai::ready()),
        "sensitive" => configured(&["INTERCEPTOR_LLAMA_VISION_URL"], "an image model this build does not include; a local multimodal llama.cpp server can be configured"),
        "maps" => configured(&["INTERCEPTOR_PHOTON_URL", "INTERCEPTOR_VALHALLA_URL", "INTERCEPTOR_GEOCODER_URL"], "self-hosted Photon, Valhalla and Nominatim map services"),
        "container_run" => if container::engine().is_none() { Err("needs Podman (podman is not installed)".to_owned()) }
            // Windows Podman runs containers in a machine or over a configured connection (cheap file check).
            else if cfg!(windows) && !std::env::var_os("APPDATA").is_some_and(|d| std::path::Path::new(&d).join("containers/podman-connections.json").is_file()) { Err("needs a Podman machine or connection (podman machine init, podman machine start)".to_owned()) }
            else { Ok(()) },
        #[cfg(target_os = "linux")] "audio" | "vad" => if std::env::var_os("XDG_RUNTIME_DIR").is_some_and(|d| std::path::Path::new(&d).join("pulse/native").exists()) { Ok(()) } else { Err("needs a PulseAudio or pipewire-pulse server in this login".to_owned()) },
        #[cfg(target_os = "linux")] "location" => library("INTERCEPTOR_GEOCLUE_LIBRARY", "libgeoclue-2", "geoclue"),
        #[cfg(target_os = "linux")] "contacts" => library("INTERCEPTOR_EDS_LIBRARY", "libebook-1.2", "evolution-data-server"),
        #[cfg(target_os = "linux")] "calendar" | "reminders" => library("INTERCEPTOR_ECAL_LIBRARY", "libecal-2.0", "evolution-data-server"),
        #[cfg(windows)] "audio" | "vad" | "location" => Ok(()),
        // Windows reaches the contact, appointment and task stores through the installed
        // package identity, which the installer registers for interceptor-contacts-native.exe.
        #[cfg(windows)] "contacts" | "calendar" | "reminders" => if std::env::current_exe().is_ok_and(|e| e.with_file_name("interceptor-contacts-native.exe").is_file()) { Ok(()) } else { Err("needs the installed package identity (interceptor-contacts-native.exe beside the provider)".to_owned()) },
        _ => return None,
    })
}
#[cfg(any(windows, target_os = "linux"))]
fn apply_readiness(entries: &mut [Value]) {
    let screen = entries.iter().any(|e| e["operation"] == "screenshot" && e["effective"] == true);
    for row in entries.iter_mut() {
        let operation = row["operation"].as_str().unwrap_or("").to_owned();
        let ready = if operation == "stream" { Some(if screen { Ok(()) } else { Err("needs a working screen capture backend in this session".to_owned()) }) } else { readiness(&operation) };
        match ready {
            Some(Ok(())) if row["present"] == true => { row["effective"] = json!(true); }
            Some(Err(reason)) => { row["effective"] = json!(false); row["reason"] = json!(reason); }
            _ => {}
        }
        if row["effective"] == false && row.get("reason").and_then(Value::as_str).is_none_or(str::is_empty) {
            row["reason"] = json!("not available in this session");
        }
    }
}
#[cfg(all(test, any(windows, target_os = "linux")))]
mod readiness_tests {
    use serde_json::json;
    #[test]
    fn every_unavailable_row_says_why_and_engines_are_named() {
        let mut rows = vec![
            json!({"operation":"listen","present":true,"effective":false}),
            json!({"operation":"made_up_operation","present":true,"effective":false}),
            json!({"operation":"update","present":true,"effective":false}),
        ];
        super::apply_readiness(&mut rows);
        assert!(rows.iter().all(|r| r["effective"] == true || r["reason"].as_str().is_some_and(|s| !s.is_empty())), "{rows:?}");
        if std::env::var_os("INTERCEPTOR_WHISPER_CLI").is_none() && rows[0]["effective"] != true { assert!(rows[0]["reason"].as_str().unwrap().contains("whisper"), "{}", rows[0]); }
        assert_eq!(rows[2]["effective"], true);
    }
}
