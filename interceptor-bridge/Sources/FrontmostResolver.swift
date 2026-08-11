import AppKit
import ApplicationServices

// Live frontmost-application resolution (issues #168, #198).
//
// `NSWorkspace.frontmostApplication` (and every time-varying
// `NSRunningApplication` property, `isActive` included) is a push-updated
// cache that AppKit refreshes only on turns of the process's main run loop.
// In this headless daemon the cache freezes (issue #168), so the bridge
// pulls the answer live on every call. The system-wide focused-application
// attribute follows *window* focus, so it has nothing to return for a
// frontmost app that owns zero windows (issue #198) — that case is resolved
// by reading the per-app `kAXFrontmostAttribute` across running apps, which
// is exactly how System Events answers `frontmost of process`. A window-list
// scan can never resolve it: a windowless frontmost app owns zero on-screen
// windows at any layer (even its menu bar belongs to Window Server).
//
// The answering stage travels with the answer so callers can tell a
// focus-derived result from a degraded one.
enum FrontmostSource: String {
    case ax          // system-wide focused application (windowed case)
    case axScan      // per-app AXFrontmost scan (windowless frontmost)
    case windowList  // front layer-0 window owner (no AX trust needed)
    case cached      // NSWorkspace push cache — last resort only
}

enum FrontmostResolver {
    static func frontmostApplication(transport: any AXTransport = LiveAXTransport()) -> NSRunningApplication? {
        guard let (pid, _) = resolvePID(transport: transport) else { return nil }
        // Fresh instance: fixed properties (name/bundleId/pid) are safe reads;
        // never reuse a cached instance whose time-varying state is frozen.
        return NSRunningApplication(processIdentifier: pid)
    }

    // Stage order: system-wide AX focused app → per-app AXFrontmost scan →
    // front-to-back on-screen window scan → cached NSWorkspace scalar.
    // `scanCandidates`/`windowListPID`/`cachedPID` are injectable so the
    // ladder is unit-testable without a live session.
    static func resolvePID(
        transport: any AXTransport,
        scanCandidates: () -> [pid_t] = liveScanCandidates,
        windowListPID: () -> pid_t? = liveWindowListPID,
        cachedPID: () -> pid_t? = { NSWorkspace.shared.frontmostApplication?.processIdentifier }
    ) -> (pid: pid_t, source: FrontmostSource)? {
        let (err, value) = transport.copyAttributeValue(
            transport.createSystemWide(), kAXFocusedApplicationAttribute as String)
        if err == .success, let element = AXValueCodec.asElement(value) {
            let (pidErr, pid) = transport.pid(element)
            if pidErr == .success, let pid, pid > 0 { return (pid, .ax) }
        }
        if let pid = axFrontmostScan(transport: transport, candidates: scanCandidates()) {
            return (pid, .axScan)
        }
        if let pid = windowListPID() { return (pid, .windowList) }
        if let pid = cachedPID() { return (pid, .cached) }
        return nil
    }

    // The System Events algorithm: ask each candidate app whether it is
    // frontmost via the per-app, live kAXFrontmostAttribute. Only consulted
    // when the focused-application route fails (windowless frontmost app).
    // The short per-candidate messaging timeout keeps one wedged app from
    // stalling the whole ladder.
    static func axFrontmostScan(transport: any AXTransport, candidates: [pid_t]) -> pid_t? {
        for pid in candidates {
            let app = transport.createApplication(pid: pid)
            _ = transport.setMessagingTimeout(app, seconds: 0.25)
            let (err, value) = transport.copyAttributeValue(app, kAXFrontmostAttribute as String)
            if err == .success, let flag = value as? Bool, flag { return pid }
        }
        return nil
    }

    // Membership of runningApplications is maintained even in this daemon
    // (unlike the frozen time-varying properties, which the scan never reads).
    static func liveScanCandidates() -> [pid_t] {
        NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map { $0.processIdentifier }
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
