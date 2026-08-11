import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

// MonitorTapBridge is the CGEventTap fallback for input observation.
// NSEvent.addGlobalMonitorForEvents (used by MonitorInputBridge) is documented
// to skip events delivered to the bridge's own process and to be passive-only.
// When the agent needs richer modifier-flag observability or wants events
// that would otherwise be hidden by the "skip own-app" filter, CGEventTap
// at kCGSessionEventTap placement is the documented alternative.
//
// Apple's docs say root is only required for "the point where HID events
// enter the window server" (kCGHIDEventTap). kCGSessionEventTap runs AFTER
// the session-event coalescer, doesn't require root, but DOES require
// Accessibility TCC — same gate as the global monitor.
//
// Registered as a passive listener (.listenOnly) — never modifies or drops
// events. Returning the unmodified pointer is the documented no-op behavior
// of a passive tap callback.

final class MonitorTapBridge: @unchecked Sendable {
    typealias EventCallback = (_ event: String, _ data: [String: Any]) -> Void

    private let lock = NSLock()
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var callback: EventCallback?

    static let cTapCallback: CGEventTapCallBack = { _, type, eventRef, userInfo in
        guard let userInfo = userInfo else { return Unmanaged.passUnretained(eventRef) }
        let bridge = Unmanaged<MonitorTapBridge>.fromOpaque(userInfo).takeUnretainedValue()
        bridge.dispatch(type: type, event: eventRef)
        return Unmanaged.passUnretained(eventRef)
    }

    func setCallback(_ cb: @escaping EventCallback) {
        lock.lock(); defer { lock.unlock() }
        callback = cb
    }

    /// Returns true if the tap was created and added to the run loop. Returns
    /// false if creation failed (typically Accessibility TCC missing).
    @discardableResult
    func start() -> Bool {
        // Built piecewise — the compiler times out trying to type-check a
        // 9-term `(1 << x) | (1 << y) | …` chain in a single expression.
        let types: [CGEventType] = [
            .leftMouseDown, .rightMouseDown, .otherMouseDown,
            .leftMouseUp, .rightMouseUp, .otherMouseUp,
            .scrollWheel, .keyDown, .flagsChanged
        ]
        var mask: CGEventMask = 0
        for t in types {
            mask |= CGEventMask(1) << CGEventMask(t.rawValue)
        }

        let userInfo = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: MonitorTapBridge.cTapCallback,
            userInfo: userInfo
        ) else {
            return false
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            return false
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)

        lock.lock()
        self.tap = tap
        self.runLoopSource = source
        lock.unlock()
        return true
    }

    func stop() {
        lock.lock()
        let oldTap = tap
        let oldSource = runLoopSource
        tap = nil
        runLoopSource = nil
        lock.unlock()
        if let s = oldSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes)
        }
        if let t = oldTap {
            CGEvent.tapEnable(tap: t, enable: false)
        }
    }

    private func dispatch(type: CGEventType, event: CGEvent) {
        // System can disable the tap on timeout or input flood. Re-enable
        // rather than silently dropping events.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let t = (lock.withLock { self.tap }) {
                CGEvent.tapEnable(tap: t, enable: true)
            }
            return
        }
        guard let cb = (lock.withLock { self.callback }) else { return }

        let frontmost = FrontmostResolver.frontmostApplication()
        let location = event.location
        var data: [String: Any] = [
            "tr": true,
            "tap": true,
            "app": frontmost?.localizedName ?? "",
            "bundleId": frontmost?.bundleIdentifier ?? "",
            "x": Int(location.x),
            "y": Int(location.y)
        ]

        switch type {
        case .leftMouseDown:    cb("click", data)
        case .rightMouseDown:   cb("rclick", data)
        case .otherMouseDown:   cb("click", data)
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            cb("mouseup", data)
        case .scrollWheel:
            data["sx"] = event.getDoubleValueField(.scrollWheelEventDeltaAxis2)
            data["sy"] = event.getDoubleValueField(.scrollWheelEventDeltaAxis1)
            cb("scroll", data)
        case .keyDown:
            data["kc"] = MonitorTapBridge.keyComboString(event)
            cb("key", data)
        case .flagsChanged:
            data["mods"] = MonitorTapBridge.modifierString(event.flags)
            cb("mods", data)
        default:
            break
        }
    }

    static func modifierString(_ flags: CGEventFlags) -> String {
        var parts: [String] = []
        if flags.contains(.maskCommand) { parts.append("Meta") }
        if flags.contains(.maskControl) { parts.append("Control") }
        if flags.contains(.maskAlternate) { parts.append("Alt") }
        if flags.contains(.maskShift) { parts.append("Shift") }
        if flags.contains(.maskAlphaShift) { parts.append("CapsLock") }
        if flags.contains(.maskSecondaryFn) { parts.append("Fn") }
        return parts.joined(separator: "+")
    }

    static func keyComboString(_ event: CGEvent) -> String {
        let flags = event.flags
        var combo = ""
        if flags.contains(.maskCommand)   { combo += "Meta+" }
        if flags.contains(.maskControl)   { combo += "Control+" }
        if flags.contains(.maskAlternate) { combo += "Alt+" }
        if flags.contains(.maskShift)     { combo += "Shift+" }

        let maxLen: Int = 4
        var actualLen: Int = 0
        var chars = [UniChar](repeating: 0, count: maxLen)
        event.keyboardGetUnicodeString(maxStringLength: maxLen, actualStringLength: &actualLen, unicodeString: &chars)
        if actualLen > 0 {
            combo += String(utf16CodeUnits: chars, count: actualLen)
        } else {
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            combo += "key#\(keyCode)"
        }
        return combo
    }
}

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock(); defer { unlock() }
        return body()
    }
}
