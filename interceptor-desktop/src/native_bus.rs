//! Linux session-bus ABI and owned handles, shared by Maps, Music, Share and capture.
use crate::failure;
use serde_json::Value;
use std::{
    ffi::{CStr, CString, c_char, c_int, c_void},
    ptr,
    time::{Duration, Instant},
};
pub(crate) type Raw = *mut c_void;
#[link(name = "systemd")]
unsafe extern "C" {
    pub(crate) fn sd_bus_get_property_trivial(
        bus: Raw,
        destination: *const c_char,
        path: *const c_char,
        interface: *const c_char,
        member: *const c_char,
        error: Raw,
        kind: c_char,
        value: Raw,
    ) -> c_int;
    pub(crate) fn sd_bus_open_user(out: *mut Raw) -> c_int;
    pub(crate) fn sd_bus_unref(bus: Raw) -> Raw;
    pub(crate) fn sd_bus_get_unique_name(bus: Raw, name: *mut *const c_char) -> c_int;
    pub(crate) fn sd_bus_set_method_call_timeout(bus: Raw, usec: u64) -> c_int;
    pub(crate) fn sd_bus_message_new_method_call(
        bus: Raw,
        out: *mut Raw,
        destination: *const c_char,
        path: *const c_char,
        interface: *const c_char,
        member: *const c_char,
    ) -> c_int;
    pub(crate) fn sd_bus_message_unref(message: Raw) -> Raw;
    pub(crate) fn sd_bus_message_ref(message: Raw) -> Raw;
    pub(crate) fn sd_bus_message_append(message: Raw, types: *const c_char, ...) -> c_int;
    pub(crate) fn sd_bus_message_open_container(
        message: Raw,
        kind: c_char,
        contents: *const c_char,
    ) -> c_int;
    pub(crate) fn sd_bus_message_close_container(message: Raw) -> c_int;
    pub(crate) fn sd_bus_call(
        bus: Raw,
        message: Raw,
        usec: u64,
        error: Raw,
        reply: *mut Raw,
    ) -> c_int;
    pub(crate) fn sd_bus_call_method(
        bus: Raw,
        destination: *const c_char,
        path: *const c_char,
        interface: *const c_char,
        member: *const c_char,
        error: Raw,
        reply: *mut Raw,
        types: *const c_char,
        ...
    ) -> c_int;
    pub(crate) fn sd_bus_message_read(message: Raw, types: *const c_char, ...) -> c_int;
    pub(crate) fn sd_bus_message_rewind(message: Raw, complete: c_int) -> c_int;
    pub(crate) fn sd_bus_message_enter_container(
        message: Raw,
        kind: c_char,
        contents: *const c_char,
    ) -> c_int;
    pub(crate) fn sd_bus_message_exit_container(message: Raw) -> c_int;
    pub(crate) fn sd_bus_message_peek_type(
        message: Raw,
        kind: *mut c_char,
        contents: *mut *const c_char,
    ) -> c_int;
    pub(crate) fn sd_bus_message_skip(message: Raw, types: *const c_char) -> c_int;
    pub(crate) fn sd_bus_message_at_end(message: Raw, complete: c_int) -> c_int;
    pub(crate) fn sd_bus_add_match(
        bus: Raw,
        slot: *mut Raw,
        rule: *const c_char,
        callback: unsafe extern "C" fn(Raw, Raw, Raw) -> c_int,
        userdata: Raw,
    ) -> c_int;
    pub(crate) fn sd_bus_slot_unref(slot: Raw) -> Raw;
    pub(crate) fn sd_bus_process(bus: Raw, out: *mut Raw) -> c_int;
    pub(crate) fn sd_bus_wait(bus: Raw, usec: u64) -> c_int;
}
pub(crate) struct Bus(pub(crate) Raw);
impl Drop for Bus {
    fn drop(&mut self) {
        unsafe {
            sd_bus_unref(self.0);
        }
    }
}
pub(crate) struct Message(pub(crate) Raw);
impl Drop for Message {
    fn drop(&mut self) {
        unsafe {
            sd_bus_message_unref(self.0);
        }
    }
}

pub(crate) struct Slot(pub(crate) Raw);
impl Drop for Slot {
    fn drop(&mut self) {
        unsafe {
            sd_bus_slot_unref(self.0);
        }
    }
}
struct Pending {
    bus: Raw,
    path: CString,
    destination: CString,
    finished: bool,
}
impl Drop for Pending {
    fn drop(&mut self) {
        if !self.finished {
            unsafe {
                sd_bus_call_method(
                    self.bus,
                    self.destination.as_ptr(),
                    self.path.as_ptr(),
                    c"org.freedesktop.portal.Request".as_ptr(),
                    c"Close".as_ptr(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    c"".as_ptr(),
                );
            }
        }
    }
}
pub(crate) fn portal_check(code: c_int) -> Result<(), Value> {
    if code < 0 {
        Err(failure(
            "provider_failed",
            format!("native desktop portal failed with errno{}", -code),
        ))
    } else {
        Ok(())
    }
}
fn request_path(name: &str, token: &str) -> Option<String> {
    let sender = name.strip_prefix(':')?;
    if sender.len() > 128
        || sender.is_empty()
        || !sender.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        || token.len() != 64
        || !token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    Some(format!(
        "/org/freedesktop/portal/desktop/request/{}/interceptor_{token}",
        sender.replace('.', "_")
    ))
}
struct Response {
    message: Option<(u32, Message)>,
    invalid: bool,
}
unsafe extern "C" fn response(message: Raw, userdata: Raw, _error: Raw) -> c_int {
    let value = unsafe { &mut *userdata.cast::<Response>() };
    if value.message.is_some() || value.invalid {
        return 0;
    }
    let mut code = 0u32;
    if unsafe { sd_bus_message_read(message, c"u".as_ptr(), &mut code) } <= 0 {
        value.invalid = true;
    } else {
        value.message = Some((code, Message(unsafe { sd_bus_message_ref(message) })));
    }
    0
}

/// A single authenticated bus connection is retained for the whole portal
/// session. All calls and signal matches use its original unique service owner.
pub(crate) struct PortalConnection {
    pub(crate) bus: Bus,
    pub(crate) destination: CString,
    caller: CString,
}
impl PortalConnection {
    pub(crate) fn open() -> Result<Self, Value> {
        unsafe {
            let mut raw = ptr::null_mut();
            portal_check(sd_bus_open_user(&mut raw))?;
            let bus = Bus(raw);
            portal_check(sd_bus_set_method_call_timeout(bus.0, 2_000_000))?;
            let mut activation = ptr::null_mut();
            portal_check(sd_bus_call_method(
                bus.0,
                c"org.freedesktop.DBus".as_ptr(),
                c"/org/freedesktop/DBus".as_ptr(),
                c"org.freedesktop.DBus".as_ptr(),
                c"StartServiceByName".as_ptr(),
                ptr::null_mut(),
                &mut activation,
                c"su".as_ptr(),
                c"org.freedesktop.portal.Desktop".as_ptr(),
                0u32,
            ))?;
            let activation = Message(activation);
            let mut started = 0u32;
            if sd_bus_message_read(activation.0, c"u".as_ptr(), &mut started) <= 0
                || !matches!(started, 1 | 2)
            {
                return Err(failure(
                    "provider_failed",
                    "native portal activation returned no valid receipt",
                ));
            }
            // Activation can race service exit. Every subsequent call uses the pinned
            // unique owner and still handles native errors without replaying content.
            portal_check(sd_bus_set_method_call_timeout(bus.0, 500_000))?;
            let mut owner_reply = ptr::null_mut();
            portal_check(sd_bus_call_method(
                bus.0,
                c"org.freedesktop.DBus".as_ptr(),
                c"/org/freedesktop/DBus".as_ptr(),
                c"org.freedesktop.DBus".as_ptr(),
                c"GetNameOwner".as_ptr(),
                ptr::null_mut(),
                &mut owner_reply,
                c"s".as_ptr(),
                c"org.freedesktop.portal.Desktop".as_ptr(),
            ))?;
            let owner_reply = Message(owner_reply);
            let mut owner = ptr::null::<c_char>();
            portal_check(sd_bus_message_read(
                owner_reply.0,
                c"s".as_ptr(),
                &mut owner,
            ))?;
            if owner.is_null() {
                return Err(failure(
                    "provider_failed",
                    "native portal has no unique service owner",
                ));
            }
            let owner = CStr::from_ptr(owner).to_str().map_err(|_| {
                failure("provider_failed", "native portal service owner is not UTF8")
            })?;
            if request_path(owner, &"0".repeat(64)).is_none() {
                return Err(failure(
                    "provider_failed",
                    "native portal service owner is invalid",
                ));
            }
            let destination = CString::new(owner).unwrap();
            let mut peer = ptr::null_mut();
            portal_check(sd_bus_call_method(
                bus.0,
                c"org.freedesktop.DBus".as_ptr(),
                c"/org/freedesktop/DBus".as_ptr(),
                c"org.freedesktop.DBus".as_ptr(),
                c"GetConnectionUnixUser".as_ptr(),
                ptr::null_mut(),
                &mut peer,
                c"s".as_ptr(),
                destination.as_ptr(),
            ))?;
            let peer = Message(peer);
            let mut uid = 0u32;
            if sd_bus_message_read(peer.0, c"u".as_ptr(), &mut uid) <= 0 {
                return Err(failure(
                    "provider_failed",
                    "native portal omitted its authenticated Unix user",
                ));
            }
            if uid != libc::geteuid() {
                return Err(failure(
                    "permission_denied",
                    "native portal belongs to another user",
                ));
            }
            let mut name = ptr::null::<c_char>();
            portal_check(sd_bus_get_unique_name(bus.0, &mut name))?;
            if name.is_null() {
                return Err(failure(
                    "provider_failed",
                    "native portal bus has no unique caller identity",
                ));
            }
            let caller = CStr::from_ptr(name).to_owned();
            if request_path(
                caller
                    .to_str()
                    .map_err(|_| failure("provider_failed", "portal caller identity is invalid"))?,
                &"0".repeat(64),
            )
            .is_none()
            {
                return Err(failure(
                    "provider_failed",
                    "portal caller identity is invalid",
                ));
            }
            Ok(Self {
                bus,
                destination,
                caller,
            })
        }
    }
    pub(crate) fn session_path(&self, token: &str) -> Result<CString, Value> {
        let path = request_path(
            self.caller
                .to_str()
                .map_err(|_| failure("provider_failed", "portal caller identity is invalid"))?,
            token,
        )
        .ok_or_else(|| failure("provider_failed", "portal session identity is invalid"))?;
        CString::new(path.replacen("/request/", "/session/", 1))
            .map_err(|_| failure("provider_failed", "portal session identity contains NUL"))
    }
    pub(crate) fn property(&self, interface: &CStr, member: &CStr) -> Result<u32, Value> {
        unsafe {
            let mut value = 0u32;
            portal_check(sd_bus_get_property_trivial(
                self.bus.0,
                self.destination.as_ptr(),
                c"/org/freedesktop/portal/desktop".as_ptr(),
                interface.as_ptr(),
                member.as_ptr(),
                ptr::null_mut(),
                b'u' as c_char,
                (&mut value as *mut u32).cast(),
            ))?;
            Ok(value)
        }
    }
    pub(crate) fn alive(&self) -> Result<(), Value> {
        unsafe {
            let mut raw = ptr::null_mut();
            portal_check(sd_bus_call_method(
                self.bus.0,
                c"org.freedesktop.DBus".as_ptr(),
                c"/org/freedesktop/DBus".as_ptr(),
                c"org.freedesktop.DBus".as_ptr(),
                c"GetNameOwner".as_ptr(),
                ptr::null_mut(),
                &mut raw,
                c"s".as_ptr(),
                c"org.freedesktop.portal.Desktop".as_ptr(),
            ))?;
            let reply = Message(raw);
            let owner = portal_string(reply.0, c"s", 128)?;
            if owner.as_bytes() != self.destination.to_bytes() {
                return Err(failure(
                    "target_gone",
                    "native portal service owner changed; the old session was not reopened",
                ));
            }
            Ok(())
        }
    }
    pub(crate) fn process(&self) -> Result<(), Value> {
        unsafe {
            for _ in 0..64 {
                let code = sd_bus_process(self.bus.0, ptr::null_mut());
                portal_check(code)?;
                if code == 0 {
                    return Ok(());
                }
            }
            Err(failure(
                "resource_limit",
                "native portal event queue exceeded its per-poll bound",
            ))
        }
    }
    pub(crate) fn close_session(&self, path: &CStr) {
        unsafe {
            // The unique owner/path remain fixed even after service replacement.
            sd_bus_call_method(
                self.bus.0,
                self.destination.as_ptr(),
                path.as_ptr(),
                c"org.freedesktop.portal.Session".as_ptr(),
                c"Close".as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                c"".as_ptr(),
            );
        }
    }
    pub(crate) fn request(
        &self,
        interface: &CStr,
        member: &CStr,
        deadline: Instant,
        append: impl FnOnce(Raw) -> Result<(), Value>,
    ) -> Result<Message, Value> {
        unsafe {
            if Instant::now() >= deadline {
                return Err(failure(
                    "cancelled",
                    "portal deadline expired before dispatch; nothing was delivered",
                ));
            }
            let bus = &self.bus;
            let destination = &self.destination;
            let owner = destination
                .to_str()
                .map_err(|_| failure("provider_failed", "portal owner is not UTF8"))?;
            let token = crate::secret_target::random_token().map_err(|_| {
                failure(
                    "provider_failed",
                    "portal request identity generation failed",
                )
            })?;
            let expected = request_path(
                self.caller
                    .to_str()
                    .map_err(|_| failure("provider_failed", "portal caller identity is invalid"))?,
                &token,
            )
            .ok_or_else(|| {
                failure(
                    "provider_failed",
                    "portal caller/request identity is invalid",
                )
            })?;
            let path = CString::new(expected.clone()).unwrap();
            let handle = CString::new(format!("interceptor_{token}")).unwrap();
            let rule=CString::new(format!("type='signal',sender='{owner}',interface='org.freedesktop.portal.Request',member='Response',path='{expected}'")).unwrap();
            let mut result = Box::new(Response {
                message: None,
                invalid: false,
            });
            let mut slot = ptr::null_mut();
            portal_check(sd_bus_add_match(
                bus.0,
                &mut slot,
                rule.as_ptr(),
                response,
                (&mut *result as *mut Response).cast(),
            ))?;
            let _slot = Slot(slot);
            let mut message = ptr::null_mut();
            portal_check(sd_bus_message_new_method_call(
                bus.0,
                &mut message,
                destination.as_ptr(),
                c"/org/freedesktop/portal/desktop".as_ptr(),
                interface.as_ptr(),
                member.as_ptr(),
            ))?;
            let message = Message(message);
            append(message.0)?;
            portal_check(sd_bus_message_open_container(
                message.0,
                b'e' as c_char,
                c"sv".as_ptr(),
            ))?;
            portal_check(sd_bus_message_append(
                message.0,
                c"s".as_ptr(),
                c"handle_token".as_ptr(),
            ))?;
            portal_check(sd_bus_message_open_container(
                message.0,
                b'v' as c_char,
                c"s".as_ptr(),
            ))?;
            portal_check(sd_bus_message_append(
                message.0,
                c"s".as_ptr(),
                handle.as_ptr(),
            ))?;
            for _ in 0..3 {
                portal_check(sd_bus_message_close_container(message.0))?;
            }
            let mut reply = ptr::null_mut();
            let usec = deadline
                .saturating_duration_since(Instant::now())
                .as_micros()
                .min(2_000_000) as u64;
            if usec == 0 {
                return Err(failure(
                    "cancelled",
                    "portal deadline expired before native dispatch",
                ));
            }
            let mut pending = Pending {
                bus: bus.0,
                path,
                destination: destination.clone(),
                finished: false,
            };
            let called = sd_bus_call(bus.0, message.0, usec, ptr::null_mut(), &mut reply);
            let reply = Message(reply);
            if called < 0 {
                return Err(failure(
                    "timeout_unknown_outcome",
                    "native desktop portal dispatch failed; request close was attempted, outcome remains unknown",
                ));
            }
            let mut observed = ptr::null::<c_char>();
            portal_check(sd_bus_message_read(reply.0, c"o".as_ptr(), &mut observed))?;
            if observed.is_null() || CStr::from_ptr(observed).to_bytes() != expected.as_bytes() {
                return Err(failure(
                    "version_mismatch",
                    "native portal returned a different request identity; no acceptance receipt issued",
                ));
            }
            loop {
                self.process()?;
                if result.invalid {
                    return Err(failure(
                        "provider_failed",
                        "native portal response omitted its typed response code",
                    ));
                }
                if let Some((code, message)) = result.message.take() {
                    pending.finished = true;
                    if Instant::now() >= deadline {
                        return Err(failure(
                            "timeout_unknown_outcome",
                            "native portal response arrived after its deadline; no acceptance receipt was issued",
                        ));
                    }
                    // Retaining a message retains its native read cursor as well.
                    // Other bus handlers may have read it after our callback.
                    portal_check(sd_bus_message_rewind(message.0, 1))?;
                    let mut reread = 0u32;
                    if sd_bus_message_read(message.0, c"u".as_ptr(), &mut reread) <= 0
                        || reread != code
                    {
                        return Err(failure(
                            "provider_failed",
                            "native portal response code could not be retained",
                        ));
                    }
                    return match code {
                        0 => Ok(message),
                        1 => Err(failure(
                            "cancelled",
                            "native desktop portal interaction was cancelled",
                        )),
                        _ => Err(failure(
                            "provider_failed",
                            "native desktop portal did not carry out the requested operation",
                        )),
                    };
                }
                if Instant::now() >= deadline {
                    return Err(failure(
                        "timeout_unknown_outcome",
                        "native desktop portal exceeded its deadline; owned request close was attempted and no operation was replayed",
                    ));
                }
                portal_check(sd_bus_wait(
                    bus.0,
                    deadline
                        .saturating_duration_since(Instant::now())
                        .as_micros()
                        .min(100_000) as u64,
                ))?;
            }
        }
    }
}
pub(crate) fn portal_request(
    interface: &CStr,
    member: &CStr,
    timeout: Duration,
    append: impl FnOnce(Raw) -> Result<(), Value>,
) -> Result<(), Value> {
    let deadline = Instant::now() + timeout;
    let connection = PortalConnection::open()?;
    connection
        .request(interface, member, deadline, append)
        .map(|_| ())
}

pub(crate) unsafe fn portal_string(
    message: Raw,
    signature: &CStr,
    max: usize,
) -> Result<String, Value> {
    unsafe {
        let mut text = ptr::null::<c_char>();
        if sd_bus_message_read(message, signature.as_ptr(), &mut text) <= 0 || text.is_null() {
            return Err(failure(
                "provider_failed",
                "native portal omitted a typed string",
            ));
        }
        let bytes = CStr::from_ptr(text).to_bytes();
        if bytes.len() > max {
            return Err(failure(
                "resource_limit",
                "native portal string exceeds its bound",
            ));
        }
        std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| failure("provider_failed", "native portal string is not UTF8"))
    }
}
/// Consumes one bounded a{sv}. The visitor returns false for an unknown key;
/// its complete native variant is skipped. Duplicate keys are always refused.
pub(crate) unsafe fn portal_dictionary(
    message: Raw,
    mut visit: impl FnMut(&str, &CStr, Raw) -> Result<bool, Value>,
) -> Result<(), Value> {
    unsafe {
        if sd_bus_message_enter_container(message, b'a' as c_char, c"{sv}".as_ptr()) <= 0 {
            return Err(failure(
                "provider_failed",
                "native portal omitted its typed results dictionary",
            ));
        }
        let mut keys = std::collections::HashSet::new();
        for _ in 0..64 {
            let entered = sd_bus_message_enter_container(message, b'e' as c_char, c"sv".as_ptr());
            portal_check(entered)?;
            if entered == 0 {
                portal_check(sd_bus_message_exit_container(message))?;
                return Ok(());
            }
            let key = portal_string(message, c"s", 256)?;
            if !keys.insert(key.clone()) {
                return Err(failure(
                    "provider_failed",
                    "native portal repeated a result key",
                ));
            }
            let mut kind = 0 as c_char;
            let mut signature = ptr::null::<c_char>();
            if sd_bus_message_peek_type(message, &mut kind, &mut signature) <= 0
                || kind != b'v' as c_char
                || signature.is_null()
            {
                return Err(failure(
                    "provider_failed",
                    "native portal result is not a typed variant",
                ));
            }
            let signature = CStr::from_ptr(signature).to_owned();
            if signature.to_bytes().len() > 128 {
                return Err(failure(
                    "resource_limit",
                    "native portal variant signature exceeds its bound",
                ));
            }
            if sd_bus_message_enter_container(message, b'v' as c_char, signature.as_ptr()) <= 0 {
                return Err(failure(
                    "provider_failed",
                    "native portal variant could not be read",
                ));
            }
            if !visit(&key, &signature, message)? {
                portal_check(sd_bus_message_skip(message, signature.as_ptr()))?;
            }
            if sd_bus_message_at_end(message, 0) != 1 {
                return Err(failure(
                    "provider_failed",
                    "native portal result has unexpected trailing fields",
                ));
            }
            portal_check(sd_bus_message_exit_container(message))?;
            portal_check(sd_bus_message_exit_container(message))?;
        }
        if sd_bus_message_at_end(message, 0) != 1 {
            return Err(failure(
                "resource_limit",
                "native portal dictionary exceeds 64 keys",
            ));
        }
        portal_check(sd_bus_message_exit_container(message))?;
        Ok(())
    }
}
pub(crate) unsafe fn portal_entry(message: Raw, key: &CStr, signature: &CStr) -> Result<(), Value> {
    unsafe {
        portal_check(sd_bus_message_open_container(
            message,
            b'e' as c_char,
            c"sv".as_ptr(),
        ))?;
        portal_check(sd_bus_message_append(message, c"s".as_ptr(), key.as_ptr()))?;
        portal_check(sd_bus_message_open_container(
            message,
            b'v' as c_char,
            signature.as_ptr(),
        ))
    }
}
pub(crate) unsafe fn portal_close_entry(message: Raw) -> Result<(), Value> {
    unsafe {
        portal_check(sd_bus_message_close_container(message))?;
        portal_check(sd_bus_message_close_container(message))
    }
}
pub(crate) unsafe fn portal_option(
    message: Raw,
    key: &CStr,
    signature: &CStr,
    append: impl FnOnce(Raw) -> Result<(), Value>,
) -> Result<(), Value> {
    unsafe {
        portal_entry(message, key, signature)?;
        append(message)?;
        portal_close_entry(message)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_identity_is_exact_and_not_reused() {
        let token = "0123456789abcdef".repeat(4);
        assert_eq!(
            request_path(":1.234", &token),
            Some(format!(
                "/org/freedesktop/portal/desktop/request/1_234/interceptor_{token}"
            ))
        );
        for name in ["1.234", ":1/x", ":'injection", ":"] {
            assert!(request_path(name, &token).is_none());
        }
        assert!(request_path(":1.2", "bad").is_none());
    }
}
