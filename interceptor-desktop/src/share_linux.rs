use crate::native_bus::{portal_close_entry as close_entry, portal_entry as entry};
use crate::{failure, native_bus::*, share::Payload};
use serde_json::{Value, json};
use std::{
    ffi::{CStr, CString, c_char},
    fs,
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    ptr,
    time::Duration,
};
fn version(interface: &CStr) -> Result<u32, Value> {
    unsafe {
        let mut bus = ptr::null_mut();
        portal_check(sd_bus_open_user(&mut bus))?;
        let bus = Bus(bus);
        portal_check(sd_bus_set_method_call_timeout(bus.0, 500_000))?;
        let mut version = 0u32;
        portal_check(sd_bus_get_property_trivial(
            bus.0,
            c"org.freedesktop.portal.Desktop".as_ptr(),
            c"/org/freedesktop/portal/desktop".as_ptr(),
            interface.as_ptr(),
            c"version".as_ptr(),
            ptr::null_mut(),
            b'u' as c_char,
            (&raw mut version).cast(),
        ))?;
        Ok(version)
    }
}
unsafe fn string(message: Raw, key: &CStr, value: &str) -> Result<(), Value> {
    unsafe {
        let value = CString::new(value)
            .map_err(|_| failure("invalid_request", "native Share text contains NUL"))?;
        entry(message, key, c"s")?;
        portal_check(sd_bus_message_append(
            message,
            c"s".as_ptr(),
            value.as_ptr(),
        ))?;
        close_entry(message)
    }
}
pub(crate) fn native(a: &Value) -> Result<Value, Value> {
    if a["sub"] == "services" {
        if let Some(path) = a["for_item"].as_str() {
            let metadata = fs::metadata(path).map_err(|_| {
                failure(
                    "permission_denied",
                    "native Share service probe is inaccessible",
                )
            })?;
            if !metadata.is_file() {
                return Err(failure(
                    "unsupported_target",
                    "native Share service probe requires a regular file",
                ));
            }
        }
        let email = version(c"org.freedesktop.portal.Email").map_or(false, |v| v >= 1);
        let wallpaper = version(c"org.freedesktop.portal.Wallpaper").map_or(false, |v| v >= 1);
        let sms = crate::linux::uri_handler(c"sms")
            && version(c"org.freedesktop.portal.OpenURI").is_ok_and(|v| v >= 1);
        return Ok(
            json!({"services":[{"id":"email","title":"Email","menuItemTitle":"Compose email","canPerform":email},{"id":"message","title":"Message","menuItemTitle":"Compose telephone message","canPerform":sms},{"id":"desktop-picture","title":"Desktop Picture","menuItemTitle":"Set desktop picture","canPerform":wallpaper}]}),
        );
    }
    let service = crate::share::selected(a)?;
    let payload = Payload::resolve(a)?;
    let mut files = Vec::new();
    let mut total = 0u64;
    if service == "message" {
        let uri = CString::new(crate::share::message_uri(&payload)?).unwrap();
        if !crate::linux::uri_handler(c"sms") {
            return Err(failure(
                "not_installed",
                "a native SMS URI handler is required; no content was sent",
            ));
        }
        if version(c"org.freedesktop.portal.OpenURI")? < 1 {
            return Err(failure(
                "version_mismatch",
                "native messaging needs OpenURI portal version 1",
            ));
        }
        portal_request(
            c"org.freedesktop.portal.OpenURI",
            c"OpenURI",
            Duration::from_secs(50),
            |message| unsafe {
                portal_check(sd_bus_message_append(
                    message,
                    c"ss".as_ptr(),
                    c"".as_ptr(),
                    uri.as_ptr(),
                ))?;
                portal_check(sd_bus_message_open_container(
                    message,
                    b'a' as c_char,
                    c"{sv}".as_ptr(),
                ))
            },
        )?;
        return Ok(
            json!({"ok":true,"service":"message","recipients":payload.recipients,"items":payload.originals,"outcome":"handler-accepted","note":"Native portal accepted SMS handler dispatch; no send or delivery receipt is available."}),
        );
    }
    for path in &payload.files {
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| failure("permission_denied", "native Share file cannot be retained"))?;
        let metadata = file.metadata().map_err(|_| {
            failure(
                "provider_failed",
                "native Share file metadata is inaccessible",
            )
        })?;
        if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
            return Err(failure(
                "resource_limit",
                "native Share file is not a bounded regular file",
            ));
        }
        total += metadata.len();
        if total > 256 * 1024 * 1024 {
            return Err(failure(
                "resource_limit",
                "native Share attachments exceed 256MiB",
            ));
        }
        files.push(file);
    }
    if service == "desktop-picture" {
        if files.len() != 1
            || !payload.body.is_empty()
            || !payload.recipients.is_empty()
            || payload.subject.is_some()
        {
            return Err(failure(
                "invalid_request",
                "desktop-picture requires exactly one local image without compose fields",
            ));
        }
        // Hyprland's portal has no Wallpaper interface; reading its version fails with InvalidArgs.
        if version(c"org.freedesktop.portal.Wallpaper").unwrap_or(0) < 1 {
            return Err(failure(
                "unsupported_target",
                "this desktop has no wallpaper portal; desktops without one (such as Hyprland) set wallpapers with their own tools",
            ));
        }
        portal_request(
            c"org.freedesktop.portal.Wallpaper",
            c"SetWallpaperFile",
            Duration::from_secs(50),
            |message| unsafe {
                portal_check(sd_bus_message_append(
                    message,
                    c"sh".as_ptr(),
                    c"".as_ptr(),
                    files[0].as_raw_fd(),
                ))?;
                portal_check(sd_bus_message_open_container(
                    message,
                    b'a' as c_char,
                    c"{sv}".as_ptr(),
                ))?;
                string(message, c"set-on", "background")?;
                entry(message, c"show-preview", c"b")?;
                portal_check(sd_bus_message_append(message, c"b".as_ptr(), 1i32))?;
                close_entry(message)
            },
        ).map_err(|error| if error["code"] == "provider_failed" {
            failure("unsupported_target", "this desktop's wallpaper portal backend refused the image; desktops without a portal wallpaper backend (such as Hyprland) set wallpapers with their own tools")
        } else { error })?;
        return Ok(
            json!({"ok":true,"service":service,"items":payload.originals,"outcome":"wallpaper-set"}),
        );
    }
    let native_version = version(c"org.freedesktop.portal.Email")?;
    if native_version < 1 || payload.recipients.len() > 1 && native_version < 3 {
        return Err(failure(
            "version_mismatch",
            "native email portal needs version 1 or version 3 for multiple recipients",
        ));
    }
    portal_request(
        c"org.freedesktop.portal.Email",
        c"ComposeEmail",
        Duration::from_secs(50),
        |message| unsafe {
            portal_check(sd_bus_message_append(message, c"s".as_ptr(), c"".as_ptr()))?;
            portal_check(sd_bus_message_open_container(
                message,
                b'a' as c_char,
                c"{sv}".as_ptr(),
            ))?;
            if let Some(subject) = &payload.subject {
                string(message, c"subject", subject)?;
            }
            if !payload.body.is_empty() {
                string(message, c"body", &payload.body)?;
            }
            if payload.recipients.len() == 1 {
                string(message, c"address", &payload.recipients[0])?;
            } else if !payload.recipients.is_empty() {
                entry(message, c"addresses", c"as")?;
                portal_check(sd_bus_message_open_container(
                    message,
                    b'a' as c_char,
                    c"s".as_ptr(),
                ))?;
                for address in &payload.recipients {
                    let address = CString::new(address.as_str()).unwrap();
                    portal_check(sd_bus_message_append(
                        message,
                        c"s".as_ptr(),
                        address.as_ptr(),
                    ))?;
                }
                portal_check(sd_bus_message_close_container(message))?;
                close_entry(message)?;
            }
            if !files.is_empty() {
                entry(message, c"attachment_fds", c"ah")?;
                portal_check(sd_bus_message_open_container(
                    message,
                    b'a' as c_char,
                    c"h".as_ptr(),
                ))?;
                for file in &files {
                    portal_check(sd_bus_message_append(
                        message,
                        c"h".as_ptr(),
                        file.as_raw_fd(),
                    ))?;
                }
                portal_check(sd_bus_message_close_container(message))?;
                close_entry(message)?;
            }
            Ok(())
        },
    )?;
    Ok(
        json!({"ok":true,"service":"email","items":payload.originals,"recipients":payload.recipients,"subject":payload.subject,"outcome":"compose-presented","note":"Native portal accepted presentation of a composer; no message-send receipt is available."}),
    )
}
