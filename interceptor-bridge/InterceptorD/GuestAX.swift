import Foundation
import CoreFoundation
import Darwin
import AppKit
import ApplicationServices
import NativeAX
import GuestWire

private let guestAXAdmission = DispatchSemaphore(value: 1)

/// A snapshot owns a same-user process instance, rather than a reusable PID.
final class GuestAX {
    struct Identity: Equatable {
        let pid: pid_t, user: UInt32
        let seconds: UInt64, microseconds: UInt64
        static func read(_ pid: pid_t) -> Identity? {
            var value = proc_bsdinfo()
            guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &value, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size), value.pbi_uid == getuid() else { return nil }
            return Identity(pid: pid, user: value.pbi_uid, seconds: value.pbi_start_tvsec, microseconds: value.pbi_start_tvusec)
        }
    }
    private let app: NSRunningApplication, identity: Identity
    private let meter: AXBudget, deadline: GuestWire.Deadline, depth: Int
    private var partial = false, reasons = Set<String>(), textBytes = 0
    private init(app: NSRunningApplication, identity: Identity, depth: Int, seconds: Double) throws {
        self.app = app; self.identity = identity; self.depth = depth
        meter = AXBudget(maxMs: max(1, Int(seconds * 1000)), maxNodes: 500, maxCalls: 5_000)
        deadline = try .init(seconds: seconds)
    }
    private func note(_ reason: String) { partial = true; reasons.insert(reason) }
    private func live() -> Bool { !app.isTerminated && Identity.read(identity.pid) == identity }
    private func admission() -> Bool {
        guard live() else { note("target_changed"); return false }
        guard (try? deadline.remaining()) != nil else { note("deadline"); return false }
        guard meter.callsUsed < meter.maxCalls else { note("call_limit"); return false }
        return true
    }
    private func value(_ element: AXUIElement, _ attribute: String) -> (CFTypeRef?, AXError) {
        guard admission() else { return (nil, .cannotComplete) }
        meter.countCalls(1)
        var result: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &result)
        guard live() else { note("target_changed"); return (nil, .invalidUIElement) }
        if error != .success && error != .attributeUnsupported && error != .noValue { note("native_attribute_unavailable") }
        return (result, error)
    }
    private func string(_ element: AXUIElement, _ attribute: String) -> String? {
        let (raw, error) = value(element, attribute)
        guard error == .success, let raw else { return nil }
        guard let text = raw as? String else { note("non_string_attribute"); return nil }
        let clipped = String(String.UnicodeScalarView(text.unicodeScalars.prefix(512)))
        guard textBytes + clipped.utf8.count <= 32_768 else { note("text_limit"); return nil }
        if clipped != text { note("text_clipped") }
        textBytes += clipped.utf8.count
        return clipped
    }
    private func children(_ element: AXUIElement, attribute: String) -> [AXUIElement] {
        guard admission() else { return [] }
        meter.countCalls(1)
        var count: CFIndex = 0
        let error = AXUIElementGetAttributeValueCount(element, attribute as CFString, &count)
        if error == .attributeUnsupported || error == .noValue { return [] }
        guard error == .success, count >= 0 else { note("children_unavailable"); return [] }
        guard count > 0 else { return [] }
        let maximum = min(50, max(0, meter.maxNodes - meter.nodesVisited)), wanted = min(count, maximum)
        if count > wanted { note("children_limit") }
        guard wanted > 0, admission() else { return [] }
        meter.countCalls(1)
        var raw: CFArray?
        guard AXUIElementCopyAttributeValues(element, attribute as CFString, 0, wanted, &raw) == .success,
              let raw, CFArrayGetCount(raw) == wanted else { note("children_changed"); return [] }
        var result: [AXUIElement] = []
        for index in 0..<wanted {
            let child = unsafeBitCast(CFArrayGetValueAtIndex(raw, index), to: CFTypeRef.self)
            guard CFGetTypeID(child) == AXUIElementGetTypeID() else { note("non_ax_child"); continue }
            let native = unsafeDowncast(child, to: AXUIElement.self)
            guard admission() else { break }
            meter.countCalls(1)
            var pid: pid_t = 0
            guard AXUIElementGetPid(native, &pid) == .success, pid == identity.pid else { note("foreign_child"); continue }
            result.append(native)
        }
        return result
    }
    private func node(_ element: AXUIElement, level: Int) -> [String: Any]? {
        guard admission(), !meter.shouldStop() else { note(meter.limitHit ?? "budget"); return nil }
        meter.countNode()
        meter.countCalls(1)
        guard AXUIElementSetMessagingTimeout(element, 0.25) == .success else { note("messaging_timeout_unavailable"); return nil }
        guard let role = string(element, kAXRoleAttribute as String), !role.isEmpty else { note("role_unavailable"); return nil }
        let subrole = string(element, kAXSubroleAttribute as String)
        let secure = AXSecureClassification.isSecure(role: role, subrole: subrole)
        // Unknown text-field classification does not authorize fetching a value.
        let unknown = role == "AXTextField" && subrole == nil
        var result: [String: Any] = ["ref": "ax\(meter.nodesVisited)", "role": role, "secure": secure,
                                     "valueState": secure ? "redacted" : unknown ? "withheld" : "unavailable"]
        if let subrole { result["subrole"] = subrole }
        if secure {
            guard textBytes + AXSecureClassification.placeholder.utf8.count <= 32_768 else { note("text_limit"); return nil }
            textBytes += AXSecureClassification.placeholder.utf8.count
            result["value"] = AXSecureClassification.placeholder
        }
        else if !unknown, let text = string(element, kAXValueAttribute as String) { result["value"] = text; result["valueState"] = "read" }
        if let title = string(element, kAXTitleAttribute as String), !title.isEmpty { result["title"] = title }
        if let description = string(element, kAXDescriptionAttribute as String), !description.isEmpty { result["description"] = description }
        let position = value(element, kAXPositionAttribute as String).0, size = value(element, kAXSizeAttribute as String).0
        if let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() {
            var point = CGPoint.zero, extent = CGSize.zero
            if AXValueGetValue(unsafeDowncast(position, to: AXValue.self), .cgPoint, &point), AXValueGetValue(unsafeDowncast(size, to: AXValue.self), .cgSize, &extent),
               [point.x, point.y, extent.width, extent.height].allSatisfy({ $0.isFinite && abs($0) <= 1_000_000_000 }), extent.width >= 0, extent.height >= 0 {
                result["frame"] = ["x": point.x, "y": point.y, "width": extent.width, "height": extent.height]
            }
        }
        var rows = children(element, attribute: kAXChildrenAttribute as String)
        if rows.isEmpty && level == 0 { rows = children(element, attribute: kAXWindowsAttribute as String) }
        // The wire's recursive receiver has its own nesting bound. Deeper
        // requested trees return an explicit partial snapshot, never a claim
        // that all descendants were read.
        guard level < min(depth, 12) else { if !rows.isEmpty { note("depth_limit") }; return result }
        var nodes: [[String: Any]] = []
        for child in rows { guard let childNode = node(child, level: level + 1) else { break }; nodes.append(childNode) }
        if !nodes.isEmpty { result["children"] = nodes }
        return result
    }
    static func read(_ action: [String: Any]) -> [String: Any] {
        func failure(_ error: String) -> [String: Any] { ["success": false, "error": "read_ax: " + error] }
        guard let number = (action["max_depth"] ?? 4) as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.rounded(.towardZero) == number.doubleValue, (1...64).contains(number.doubleValue) else { return failure("depth must be an integer1...64") }
        guard AXIsProcessTrusted() else { return failure("guest Accessibility permission is denied") }
        guard guestAXAdmission.wait(timeout: .now()) == .success else { return failure("another native AX traversal still owns admission") }
        defer { guestAXAdmission.signal() }
        let app: NSRunningApplication
        if let selector = action["app"] {
            guard let query = selector as? String, !query.isEmpty, query.utf8.count <= 4096, let pid = eventTargetPID(action), let exact = NSRunningApplication(processIdentifier: pid) else { return failure("selector requires one exact running app") }
            app = exact
        } else {
            let system = AXUIElementCreateSystemWide()
            guard AXUIElementSetMessagingTimeout(system, 0.25) == .success else { return failure("focused target messaging timeout unavailable") }
            var raw: CFTypeRef?, pid: pid_t = 0
            guard AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &raw) == .success,
                  let raw, CFGetTypeID(raw) == AXUIElementGetTypeID(), AXUIElementGetPid(unsafeDowncast(raw, to: AXUIElement.self), &pid) == .success,
                  let focused = NSRunningApplication(processIdentifier: pid) else { return failure("actual focused application unavailable; no cached or first-window fallback") }
            app = focused
        }
        guard let identity = Identity.read(app.processIdentifier), !app.isTerminated else { return failure("same-user live process identity unavailable") }
        do {
            let reader = try GuestAX(app: app, identity: identity, depth: number.intValue, seconds: min(5, GuestWire.requestBudget(action, defaultSeconds: 5)))
            guard let tree = reader.node(AXUIElementCreateApplication(identity.pid), level: 0), reader.live() else { return failure("target changed or root AX role inaccessible") }
            var payload: [String: Any] = ["app": app.localizedName ?? "", "bundleIdentifier": app.bundleIdentifier ?? "", "pid": identity.pid,
                                         "tree": tree, "visited": reader.meter.nodesVisited, "maxDepth": number.intValue, "partial": reader.partial,
                                         "reasons": reader.reasons.sorted(), "refsActionable": false]
            if let selector = action["app"] { payload["selector"] = selector }
            guard try JSONSerialization.data(withJSONObject: payload).count <= 131_072 else { return failure("snapshot exceeds 128KiB") }
            return ["success": true, "data": payload]
        } catch { return failure("native traversal failed: \(error)") }
    }
}
