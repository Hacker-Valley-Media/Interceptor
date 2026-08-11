import AppKit
import ApplicationServices

// Live frontmost-application resolution (issue #168).
//
// `NSWorkspace.frontmostApplication` (and every time-varying
// `NSRunningApplication` property, `isActive` included) is a push-updated
// cache that AppKit refreshes only on turns of the process's main run loop.
// In this headless daemon the cache freezes: it kept reporting one app across
// dozens of real activations (9/12 divergence vs System Events truth,
// 2026-08-11). So the bridge never trusts the push cache — it pulls the
// answer live on every call, first from the AX server, then from the window
// server, and only falls back to the cache when neither has an answer.
enum FrontmostResolver {
    static func frontmostApplication(transport: any AXTransport = LiveAXTransport()) -> NSRunningApplication? {
        guard let pid = resolvePID(transport: transport) else { return nil }
        // Fresh instance: fixed properties (name/bundleId/pid) are safe reads;
        // never reuse a cached instance whose time-varying state is frozen.
        return NSRunningApplication(processIdentifier: pid)
    }

    // Stage order: AX system-wide focused app (live, needs AX trust) →
    // front-to-back on-screen window scan (live, no AX trust needed) →
    // cached NSWorkspace scalar (last resort, e.g. nothing on screen).
    // `windowListPID`/`cachedPID` are injectable so the fallback ladder is
    // unit-testable without a live session.
    static func resolvePID(
        transport: any AXTransport,
        windowListPID: () -> pid_t? = liveWindowListPID,
        cachedPID: () -> pid_t? = { NSWorkspace.shared.frontmostApplication?.processIdentifier }
    ) -> pid_t? {
        let (err, value) = transport.copyAttributeValue(
            transport.createSystemWide(), kAXFocusedApplicationAttribute as String)
        if err == .success, let element = AXValueCodec.asElement(value) {
            let (pidErr, pid) = transport.pid(element)
            if pidErr == .success, let pid, pid > 0 { return pid }
        }
        if let pid = windowListPID() { return pid }
        return cachedPID()
    }

    // First layer-0 window in CGWindowList's front-to-back on-screen order.
    // kCGWindowOwnerPID/kCGWindowLayer are not gated by Screen Recording.
    static func liveWindowListPID() -> pid_t? {
        guard let list = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return nil }
        for window in list {
            guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
                  let pid = window[kCGWindowOwnerPID as String] as? Int
            else { continue }
            return pid_t(pid)
        }
        return nil
    }
}
