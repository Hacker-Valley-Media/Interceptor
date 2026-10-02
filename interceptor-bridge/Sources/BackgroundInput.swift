import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// Window-addressed input: deliver synthesized events to one named window of an
// app that is not frontmost, without moving the cursor or changing the
// frontmost app.
//
// A per-pid event with no window stamp is dropped by a background app. Three
// pieces make it land:
//   stamps       — target pid + window id + window-relative point on each event
//   focus record — tells the app this window has focus (needed for any click a
//                  view would otherwise swallow as "first mouse", and for keys)
//   make-key     — cgsWakeWindowEventLoop's become-key record
// Right-click and scroll need only the stamps.

struct WindowInfo: Equatable, Sendable {
    let id: CGWindowID
    let pid: pid_t
    let bounds: CGRect
    let title: String
    /// 0 is a normal window; panels, alerts, and popups sit above it.
    var layer: Int = 0
}

/// What the caller said about the window, beyond app/pid.
struct WindowRequest: Sendable {
    var windowID: CGWindowID? = nil
    /// Browser path: the daemon knows the tab title and chrome.windows bounds.
    var title: String? = nil
    var bounds: CGRect? = nil

    var isExplicit: Bool { windowID != nil || bounds != nil }
}

enum WindowPick: Equatable {
    case found(WindowInfo)
    case problem(String)
}

enum BackgroundInput {
    /// On-screen windows at or above the normal layer, front to back
    /// (CGWindowListOption.optionOnScreenOnly documents the order).
    static func onScreenWindows() -> [WindowInfo] {
        guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        return raw.compactMap { w in
            guard let layer = w[kCGWindowLayer as String] as? Int, layer >= 0,
                  let id = w[kCGWindowNumber as String] as? CGWindowID,
                  let pid = w[kCGWindowOwnerPID as String] as? pid_t,
                  let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict) else { return nil }
            return WindowInfo(id: id, pid: pid, bounds: bounds, title: w[kCGWindowName as String] as? String ?? "", layer: layer)
        }
    }

    /// Chooses the delivery window. nil means "nothing to address": the caller
    /// keeps its unaddressed delivery. `.problem` is a refusal.
    static func pick(from windows: [WindowInfo], pid: pid_t?, request: WindowRequest, point: CGPoint?) -> WindowPick? {
        if let id = request.windowID {
            guard let w = windows.first(where: { $0.id == id }) else {
                return .problem("window \(id) is not on screen (minimized, hidden, or closed); 'interceptor macos windows --app <name>' lists window ids (nothing was delivered)")
            }
            if let pid = pid, w.pid != pid {
                return .problem("window \(id) belongs to pid \(w.pid), not the requested app/pid \(pid) (nothing was delivered)")
            }
            return .found(w)
        }
        if let bounds = request.bounds {
            let sameFrame = windows.filter { $0.layer == 0 && (pid == nil || $0.pid == pid) && near($0.bounds, bounds) }
            var matches = sameFrame
            if let title = request.title, !title.isEmpty {
                let exact = sameFrame.filter { $0.title == title }
                matches = exact.isEmpty ? sameFrame.filter { !$0.title.isEmpty && $0.title.hasPrefix(title) } : exact
            }
            if matches.count == 1 { return .found(matches[0]) }
            if matches.isEmpty {
                return .problem("no on-screen window matches the tab's window (it may be minimized, hidden, or on another Space) (nothing was delivered)")
            }
            return .problem("\(matches.count) on-screen windows share the tab's frame and title, so the target is ambiguous (nothing was delivered)")
        }
        guard let pid = pid else { return nil }
        // Normal windows first; a panel or alert of the app only when no normal
        // window is there (an app can keep click-through overlays above its windows).
        let own = windows.filter { $0.pid == pid }
        let ranked = own.filter { $0.layer == 0 } + own.filter { $0.layer != 0 }
        if let point = point {
            if let w = ranked.first(where: { $0.bounds.contains(point) }) { return .found(w) }
            return .problem("pid \(pid) has no on-screen window under (\(Int(point.x)), \(Int(point.y))); the window may be minimized or hidden, or the point is outside it. 'interceptor macos windows --app <name>' lists frames and window ids (nothing was delivered)")
        }
        return ranked.first.map { .found($0) }
    }

    private static func near(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) <= 2 && abs(a.minY - b.minY) <= 2 && abs(a.width - b.width) <= 2 && abs(a.height - b.height) <= 2
    }

    /// The window id behind an accessibility element: its AXWindow, else itself.
    static func windowID(owning element: AXUIElement, transport: any AXTransport) -> CGWindowID? {
        let (err, value) = transport.copyAttributeValue(element, kAXWindowAttribute as String)
        if err == .success, let window = AXValueCodec.asElement(value), let id = cgsWindowID(of: window) { return id }
        return cgsWindowID(of: element)
    }

    /// The window the app itself treats as focused.
    static func focusedWindow(of pid: pid_t, transport: any AXTransport) -> (element: AXUIElement, id: CGWindowID)? {
        let (err, value) = transport.copyAttributeValue(transport.createApplication(pid: pid), kAXFocusedWindowAttribute as String)
        guard err == .success, let window = AXValueCodec.asElement(value), let id = cgsWindowID(of: window) else { return nil }
        return (window, id)
    }
}

/// What a focus() call has to do, decided from who is frontmost.
enum FocusPlan: Equatable {
    /// Target is already the key window of the frontmost app: stamps only.
    case none
    /// Target app is in the background.
    case crossApp
    /// Target is another window of the frontmost app; `keyWindow` gets focus back.
    case sameApp(keyWindow: CGWindowID)

    static func decide(targetIsFrontProcess: Bool, target: CGWindowID, frontAppKeyWindow: CGWindowID?) -> FocusPlan {
        guard targetIsFrontProcess else { return .crossApp }
        guard let key = frontAppKeyWindow, key != target else { return .none }
        return .sameApp(keyWindow: key)
    }
}

/// One gesture against one window. Create, post, discard.
final class BackgroundInputSession: @unchecked Sendable {
    let window: WindowInfo
    var pid: pid_t { window.pid }
    private let transport: any AXTransport = LiveAXTransport()
    // One id for every event of the gesture (field 58), so the target groups them.
    private let group = Int64(DispatchTime.now().uptimeNanoseconds % 1_000_000_000)
    private var undoFocus: (() -> Void)?

    init(window: WindowInfo) { self.window = window }

    var routing: String { "pid=\(pid) window=\(window.id)" }

    // MARK: Focus

    /// Makes the target window read as key to its app. Safe to call once per gesture.
    func focus() {
        guard undoFocus == nil, let front = cgsFrontProcess() else { return }
        var target = ProcessSerialNumber()
        guard GetProcessForPID(pid, &target) == noErr else { return }
        let wid = window.id
        let targetIsFront = front.highLongOfPSN == target.highLongOfPSN && front.lowLongOfPSN == target.lowLongOfPSN

        let appKey = targetIsFront ? BackgroundInput.focusedWindow(of: pid, transport: transport) : nil
        let fallbackKey = targetIsFront ? BackgroundInput.onScreenWindows().first(where: { $0.pid == pid && $0.layer == 0 })?.id : nil
        switch FocusPlan.decide(targetIsFrontProcess: targetIsFront, target: wid, frontAppKeyWindow: appKey?.id ?? fallbackKey) {
        case .none:
            return
        case .sameApp(let keyWindow):
            cgsPostFocusRecord(to: target, windowID: keyWindow, activate: false)
            cgsPostFocusRecord(to: target, windowID: wid, activate: true)
            let transport = self.transport
            undoFocus = {
                // Public AX hands the key window back without raising anything.
                if let element = appKey?.element,
                   transport.setAttributeValue(element, kAXMainAttribute as String, kCFBooleanTrue as CFTypeRef) == .success { return }
                cgsPostFocusRecord(to: target, windowID: wid, activate: false)
                cgsPostFocusRecord(to: target, windowID: keyWindow, activate: true)
            }
        case .crossApp:
            var frontPid: pid_t = 0
            var frontPSN = front
            _ = GetProcessPID(&frontPSN, &frontPid)
            let frontWindow = BackgroundInput.onScreenWindows().first(where: { $0.pid == frontPid && $0.layer == 0 })?.id ?? 0
            cgsPostFocusRecord(to: front, windowID: wid, activate: false)
            cgsPostFocusRecord(to: target, windowID: wid, activate: true)
            undoFocus = {
                cgsPostFocusRecord(to: target, windowID: wid, activate: false)
                cgsPostFocusRecord(to: front, windowID: frontWindow, activate: true)
            }
        }
        usleep(50_000)
        _ = cgsWakeWindowEventLoop(pid: pid, windowID: wid)
        usleep(30_000)
    }

    /// Hands focus back to whoever had it. No-op when focus() sent nothing.
    func restore() {
        guard let undo = undoFocus else { return }
        usleep(60_000)
        undo()
        undoFocus = nil
    }

    // MARK: Stamps

    private func stamp(_ event: CGEvent, phase: Int64, clickState: Int64, button: Int64, subtype: Int64) {
        let wid = Int64(window.id)
        let at = event.location
        cgsStampEvent(event, fields: [
            (0, phase), (1, clickState), (3, button), (7, subtype),
            (40, Int64(pid)), (58, group), (51, wid), (91, wid), (92, wid),
        ], windowLocation: CGPoint(x: at.x - window.bounds.minX, y: at.y - window.bounds.minY))
    }

    private func postMouse(_ source: CGEventSource, _ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton,
                           phase: Int64 = 3, clickState: Int64 = 1, subtype: Int64 = 3) {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
        stamp(event, phase: phase, clickState: clickState, button: button == .right ? 1 : 0, subtype: subtype)
        event.postToPid(pid)
    }

    // MARK: Gestures

    /// False when no event source could be created.
    func click(at point: CGPoint, right: Bool, count: Int) -> Bool {
        guard let source = CGEventSource(stateID: .hidSystemState) else { return false }
        // A right-click is accepted by a non-key window; a left click is not.
        if !right { focus() }
        let button: CGMouseButton = right ? .right : .left
        postMouse(source, .mouseMoved, point, .left, phase: 2, clickState: 0)
        usleep(15_000)
        for click in 1...max(1, count) {
            postMouse(source, right ? .rightMouseDown : .leftMouseDown, point, button, clickState: Int64(click))
            usleep(count > 1 ? 5_000 : 28_000)
            postMouse(source, right ? .rightMouseUp : .leftMouseUp, point, button, clickState: Int64(click))
            if click < count { usleep(80_000) }
        }
        restore()
        return true
    }

    func drag(from: CGPoint, to: CGPoint, steps: Int = 20) -> Bool {
        guard let source = CGEventSource(stateID: .hidSystemState) else { return false }
        focus()
        postMouse(source, .mouseMoved, from, .left, phase: 2, clickState: 0)
        usleep(12_000)
        postMouse(source, .leftMouseDown, from, .left, subtype: 0)
        usleep(16_000)
        for i in 1...steps {
            let t = CGFloat(i) / CGFloat(steps)
            postMouse(source, .leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t), .left, subtype: 0)
            usleep(20_000)
        }
        // One run-loop turn at the drop point before the release.
        usleep(50_000)
        postMouse(source, .leftMouseUp, to, .left, subtype: 0)
        usleep(100_000)
        restore()
        return true
    }

    func scroll(at point: CGPoint, dy: Int32, dx: Int32, times: Int, intervalMs: Int) -> Bool {
        guard let source = CGEventSource(stateID: .hidSystemState) else { return false }
        let wid = Int64(window.id)
        for i in 0..<times {
            if let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
                event.location = point
                cgsStampEvent(event, fields: [(40, Int64(pid)), (51, wid), (91, wid), (92, wid)],
                              windowLocation: CGPoint(x: point.x - window.bounds.minX, y: point.y - window.bounds.minY))
                event.postToPid(pid)
            }
            if i < times - 1, intervalMs > 0 { usleep(useconds_t(intervalMs * 1000)) }
        }
        return true
    }
}
