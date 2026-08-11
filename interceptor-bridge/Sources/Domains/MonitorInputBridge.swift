import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

// MonitorInputBridge wraps NSEvent.addGlobalMonitorForEvents
// for passive input observation. Per Apple's docs (apple-developer-docs/AppKit/
// NSEvent/addGlobalMonitorForEvents(matching_handler_).md:26-30):
//   - "Events are delivered asynchronously to your app and you can only
//      observe the event; you cannot modify or otherwise prevent the event
//      from being delivered to its original target application."
//   - "Key-related events may only be monitored if accessibility is enabled
//      or if your application is trusted for accessibility access (see
//      AXIsProcessTrusted())."
//   - "Note that your handler will not be called for events that are sent
//      to your own application." — this is a feature, not a bug, for an
//      agent-driven bridge: it means we never re-record events the bridge
//      itself drove.
//
// Coordinate-space fix: the previous scaffold (MonitorDomain.swift:232) read
// `event.locationInWindow` for global mouse events, but global monitors have
// no associated window so that property is meaningless. The correct read is
// `NSEvent.mouseLocation` (screen coordinates, bottom-left origin), then
// flipped against the primary screen height to AX top-left global. This
// bridge applies that flip and also runs an AXUIElementCopyElementAtPosition
// hit-test to enrich each click with role / title.

final class MonitorInputBridge: @unchecked Sendable {
    typealias EventCallback = (_ event: String, _ data: [String: Any]) -> Void

    private let lock = NSLock()
    // the hit-test + attribute reads route through the transport.
    private let transport: any AXTransport = LiveAXTransport()
    private var monitors: [Any] = []
    private var callback: EventCallback?
    private var includeMouseMoved = false
    private var excludeKey = false

    // scroll coalescing. Within `scrollCoalesceMs`, accumulate
    // scrollingDelta into one event carrying summed deltas + a sample count, so
    // "log everything" stays full-fidelity (no lost direction/magnitude) without
    // flooding the main run loop with one write per wheel tick. 0 = per-event.
    private var scrollCoalesceMs = 0
    private var scrollAccumX: Double = 0
    private var scrollAccumY: Double = 0
    private var scrollSamples = 0
    private var scrollLatest: [String: Any]?
    private var scrollFlushTimer: DispatchSourceTimer?

    func setCallback(_ cb: @escaping EventCallback) {
        lock.lock(); defer { lock.unlock() }
        callback = cb
    }

    func start(includeMouseMoved: Bool = false, excludeKey: Bool = false, scrollCoalesceMs: Int = 0) {
        lock.lock()
        self.includeMouseMoved = includeMouseMoved
        self.excludeKey = excludeKey
        self.scrollCoalesceMs = max(0, scrollCoalesceMs)
        lock.unlock()

        // Mask: clicks, scroll, key presses (when included), modifier flags
        // for combo tracking. Only mouseMoved when explicitly opted in — that
        // event volume is enormous.
        var mask: NSEvent.EventTypeMask = [
            .leftMouseDown, .rightMouseDown, .otherMouseDown,
            .leftMouseUp, .rightMouseUp, .otherMouseUp,
            .scrollWheel, .flagsChanged
        ]
        if !excludeKey { mask.insert(.keyDown) }
        if includeMouseMoved { mask.insert(.mouseMoved) }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let monitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
                self?.handle(event)
            }
            if let m = monitor {
                self.lock.lock()
                self.monitors.append(m)
                self.lock.unlock()
            }
        }
    }

    func stop() {
        flushScroll()
        lock.lock()
        scrollFlushTimer?.cancel()
        scrollFlushTimer = nil
        lock.unlock()
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let toStop = self.monitors
            self.monitors.removeAll()
            self.lock.unlock()
            for m in toStop {
                NSEvent.removeMonitor(m)
            }
        }
    }

    // MARK: - scroll coalescing

    private func accumulateScroll(dx: CGFloat, dy: CGFloat, base: [String: Any], coalesceMs: Int) {
        lock.lock()
        scrollAccumX += Double(dx)
        scrollAccumY += Double(dy)
        scrollSamples += 1
        scrollLatest = base
        let needTimer = scrollFlushTimer == nil
        if needTimer {
            let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
            timer.schedule(deadline: .now() + .milliseconds(coalesceMs))
            timer.setEventHandler { [weak self] in self?.flushScroll() }
            scrollFlushTimer = timer
            lock.unlock()
            timer.resume()
        } else {
            lock.unlock()
        }
    }

    private func flushScroll() {
        lock.lock()
        let cb = callback
        let samples = scrollSamples
        guard samples > 0, let cb = cb, var data = scrollLatest else {
            scrollFlushTimer?.cancel()
            scrollFlushTimer = nil
            lock.unlock()
            return
        }
        data["sx"] = scrollAccumX
        data["sy"] = scrollAccumY
        data["samples"] = samples
        scrollAccumX = 0
        scrollAccumY = 0
        scrollSamples = 0
        scrollLatest = nil
        scrollFlushTimer?.cancel()
        scrollFlushTimer = nil
        lock.unlock()
        cb("scroll", data)
    }

    // MARK: - dispatch

    private func handle(_ event: NSEvent) {
        guard let cb = (lock.withLock { self.callback }) else { return }

        let frontmost = FrontmostResolver.frontmostApplication(transport: transport)
        var data: [String: Any] = [
            "tr": true,
            "app": frontmost?.localizedName ?? "",
            "bundleId": frontmost?.bundleIdentifier ?? ""
        ]

        switch event.type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            // Coordinate-space fix: NSEvent.mouseLocation is screen-coords,
            // bottom-left origin. AX uses top-left global. Flip Y against the
            // primary screen height (the screen that contains the AX origin).
            let mouse = NSEvent.mouseLocation
            let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
            let axPoint = CGPoint(x: mouse.x, y: primaryHeight - mouse.y)
            data["x"] = Int(axPoint.x)
            data["y"] = Int(axPoint.y)

            // AX hit-test for ref / role / title enrichment.
            if let app = frontmost {
                hitTest(at: axPoint, pid: app.processIdentifier, into: &data)
            }

            switch event.type {
            case .leftMouseDown:
                cb(event.clickCount >= 2 ? "dblclick" : "click", data)
            case .rightMouseDown:
                cb("rclick", data)
            default:
                cb("click", data)
            }

        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            // Released-button events are useful for measuring drag length but
            // would double the event count for replay. Only emit a `mouseup`
            // event so consumers can opt in by render-switch matching.
            data["x"] = Int(NSEvent.mouseLocation.x)
            data["y"] = Int(NSEvent.mouseLocation.y)
            cb("mouseup", data)

        case .keyDown:
            data["kc"] = MonitorInputBridge.keyComboString(event)
            cb("key", data)

        case .flagsChanged:
            data["mods"] = MonitorInputBridge.modifierString(event.modifierFlags)
            cb("mods", data)

        case .scrollWheel:
            let coalesce = lock.withLock { self.scrollCoalesceMs }
            if coalesce <= 0 {
                data["sx"] = event.scrollingDeltaX
                data["sy"] = event.scrollingDeltaY
                cb("scroll", data)
            } else {
                accumulateScroll(dx: event.scrollingDeltaX, dy: event.scrollingDeltaY, base: data, coalesceMs: coalesce)
            }

        case .mouseMoved:
            data["x"] = Int(NSEvent.mouseLocation.x)
            data["y"] = Int(NSEvent.mouseLocation.y)
            cb("move", data)

        default:
            break
        }
    }

    private func hitTest(at point: CGPoint, pid: pid_t, into data: inout [String: Any]) {
        let axApp = transport.createApplication(pid: pid)
        let (status, element) = transport.copyElementAtPosition(axApp, x: Float(point.x), y: Float(point.y))
        guard status == .success, let el = element else { return }

        let (_, role) = transport.copyAttributeValue(el, kAXRoleAttribute as String)
        let (_, title) = transport.copyAttributeValue(el, kAXTitleAttribute as String)
        let (_, desc) = transport.copyAttributeValue(el, kAXDescriptionAttribute as String)
        if let r = AXValueCodec.displayString(role) { data["r"] = r }
        if let t = AXValueCodec.displayString(title) { data["n"] = t }
        else if let d = AXValueCodec.displayString(desc) { data["n"] = d }
    }

    static func keyComboString(_ event: NSEvent) -> String {
        let mods = event.modifierFlags
        var combo = ""
        if mods.contains(.command)  { combo += "Meta+" }
        if mods.contains(.control)  { combo += "Control+" }
        if mods.contains(.option)   { combo += "Alt+" }
        if mods.contains(.shift)    { combo += "Shift+" }
        if let chars = event.charactersIgnoringModifiers, !chars.isEmpty {
            combo += chars
        } else {
            combo += "key#\(event.keyCode)"
        }
        return combo
    }

    static func modifierString(_ flags: NSEvent.ModifierFlags) -> String {
        var parts: [String] = []
        if flags.contains(.command)  { parts.append("Meta") }
        if flags.contains(.control)  { parts.append("Control") }
        if flags.contains(.option)   { parts.append("Alt") }
        if flags.contains(.shift)    { parts.append("Shift") }
        if flags.contains(.capsLock) { parts.append("CapsLock") }
        if flags.contains(.function) { parts.append("Fn") }
        return parts.joined(separator: "+")
    }
}

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock(); defer { unlock() }
        return body()
    }
}
