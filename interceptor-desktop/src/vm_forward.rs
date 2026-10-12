//! Bounded readback of the owned QEMU user-network listener table. HMP add
//! replies are not success evidence: QEMU can report add errors on stderr.
use crate::failure;
use serde_json::Value;
use std::collections::BTreeMap;
pub(crate) const NETWORK: &str = "itc-net";
pub(crate) const GUEST: &str = "10.0.2.15";
pub(crate) const MAX_FORWARDS: usize = 32;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Forward { pub(crate) fd: u64, pub(crate) host_port: u16, pub(crate) guest_port: u16 }
type Result<T> = std::result::Result<T, Value>;
pub(crate) fn parse(text: &str) -> Result<BTreeMap<u16, Forward>> {
    if text.len() > 131072 || text.lines().count() > 1024 { return Err(failure("resource_limit", "native VM network inventory is oversized")); }
    let mut section = false; let mut header = false; let mut rows = BTreeMap::new();
    for line in text.lines().map(str::trim).filter(|s| !s.is_empty()) {
        if line.starts_with("Hub ") {
            if section || !line.ends_with(" (itc-net):") { return Err(failure("unsupported_target", "native VM network inventory belongs to another or duplicate device")); }
            let hub = line.strip_prefix("Hub ").unwrap().strip_suffix(" (itc-net):").unwrap();
            if hub.parse::<i32>().is_err() { return Err(failure("provider_failed", "native VM network section has an invalid hub ID")); }
            section = true; continue;
        }
        if !section { return Err(failure("provider_failed", "native VM network section is missing")); }
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns == ["Protocol[State]", "FD", "Source", "Address", "Port", "Dest.", "Address", "Port", "RecvQ", "SendQ"] {
            if header { return Err(failure("provider_failed", "duplicate native VM network table header")); } header = true; continue;
        }
        if !header { return Err(failure("provider_failed", "native VM network table header differs from the supported format")); }
        if columns.first() != Some(&"TCP[HOST_FORWARD]") {
            if line.contains("HOST_FORWARD") { return Err(failure("unsupported_target", "native forwarding protocol differs from the owned TCP scope")); }
            if columns.first().is_some_and(|s| s.starts_with("TCP[") || s.starts_with("UDP[") || s.starts_with("ICMP[")) { continue; }
            return Err(failure("provider_failed", "unknown native VM network row"));
        }
        if columns.len() != 8 || columns[2] != "127.0.0.1" || columns[4] != GUEST {
            return Err(failure("unsupported_target", "native VM forward has different protocol, listener or guest scope"));
        }
        let fd = columns[1].parse::<u64>().map_err(|_| failure("provider_failed", "native forward descriptor is invalid"))?;
        let host_port = columns[3].parse::<u16>().ok().filter(|n| *n > 0).ok_or_else(|| failure("provider_failed", "native listener omitted its actual port"))?;
        let guest_port = columns[5].parse::<u16>().ok().filter(|n| *n > 0).ok_or_else(|| failure("provider_failed", "native guest port is invalid"))?;
        if columns[6].parse::<u64>().is_err() || columns[7].parse::<u64>().is_err() { return Err(failure("provider_failed", "native forward queues are invalid")); }
        if rows.values().any(|row: &Forward| row.fd == fd) { return Err(failure("provider_failed", "duplicate native VM listener descriptor")); }
        if rows.insert(host_port, Forward { fd, host_port, guest_port }).is_some() || rows.len() > MAX_FORWARDS {
            return Err(failure("resource_limit", "native VM has duplicate or more than 32 listeners"));
        }
    }
    if !section || !header { return Err(failure("provider_failed", "native VM network readback is incomplete")); }
    Ok(rows)
}
pub(crate) fn added(before: &BTreeMap<u16, Forward>, after: &BTreeMap<u16, Forward>, host: u16, guest: u16) -> Result<Forward> {
    if before.iter().any(|(key, value)| after.get(key) != Some(value)) { return Err(failure("partial_result", "existing VM listener identity changed during admission")); }
    let new = after.iter().filter(|(key, _)| !before.contains_key(*key)).map(|(_, row)| row).collect::<Vec<_>>();
    if new.len() != 1 || after.len() != before.len() + 1 { return Err(failure("partial_result", "native forwarding did not create exactly one listener")); }
    let row = new[0];
    if row.guest_port != guest || host != 0 && row.host_port != host { return Err(failure("partial_result", "native forwarding port readback differs from the exact request")); }
    Ok(row.clone())
}
#[cfg(test)] mod tests {
    use super::*;
    const HEADER: &str = "Hub -1 (itc-net):\n  Protocol[State] FD Source Address Port Dest. Address Port RecvQ SendQ\n";
    #[test] fn native_table_uses_the_reported_ephemeral_socket_port() {
        let before = parse(HEADER).unwrap();
        let after = parse(&(HEADER.to_owned() + "TCP[HOST_FORWARD] 42 127.0.0.1 49152 10.0.2.15 8080 0 0\nTCP[ESTABLISHED] 43 127.0.0.1 49152 10.0.2.15 8080 10 11\n")).unwrap();
        assert_eq!(added(&before, &after, 0, 8080).unwrap().host_port, 49152);
        assert!(added(&before, &after, 49153, 8080).is_err());
        assert!(added(&before, &after, 0, 8081).is_err());
    }
    #[test] fn scope_duplicates_bad_rows_and_an_empty_add_cannot_be_success() {
        for row in ["TCP[HOST_FORWARD] 42 * 49152 10.0.2.15 8080 0 0", "TCP[HOST_FORWARD] 42 0.0.0.0 49152 10.0.2.15 8080 0 0", "TCP[HOST_FORWARD] 42 127.0.0.1 0 10.0.2.15 8080 0 0", "TCP[HOST_FORWARD] 42 127.0.0.1 49152 10.0.2.16 8080 0 0", "TCP[HOST_FORWARD] -1 127.0.0.1 49152 10.0.2.15 8080 0 0", "UDP[HOST_FORWARD] 42 127.0.0.1 49152 10.0.2.15 8080 0 0"] { assert!(parse(&(HEADER.to_owned()+row)).is_err()); }
        assert!(parse(&HEADER.replace("itc-net", "another-net")).is_err());
        let empty = parse(HEADER).unwrap(); assert!(added(&empty, &empty, 0, 8080).is_err());
        let row = "TCP[HOST_FORWARD] 42 127.0.0.1 49152 10.0.2.15 8080 0 0\n";
        assert!(parse(&(HEADER.to_owned()+row+row)).is_err());
    }
    #[test] fn an_existing_listener_cannot_be_rebound_under_the_same_port() {
        let before = parse(&(HEADER.to_owned()+"TCP[HOST_FORWARD] 42 127.0.0.1 49152 10.0.2.15 8080 0 0\n")).unwrap();
        let after = parse(&(HEADER.to_owned()+"TCP[HOST_FORWARD] 43 127.0.0.1 49152 10.0.2.15 8080 0 0\nTCP[HOST_FORWARD] 44 127.0.0.1 49153 10.0.2.15 8080 0 0\n")).unwrap();
        assert!(added(&before, &after, 0, 8080).is_err());
    }
}
