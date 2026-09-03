import Foundation
import CoreGraphics
import ApplicationServices
import AppKit

enum InputError: Error {
    case message(String)
}

final class InputDomain: DomainHandler, @unchecked Sendable {
    private let refRegistry: RefRegistry
    private let selector: InputTargetSelector
    // AX press / value-set / role-probe / center-point reads
    // route through the transport + codec (removes `posValue as! AXValue`).
    private let transport: any AXTransport = LiveAXTransport()

    init(refRegistry: RefRegistry = .shared) {
        self.refRegistry = refRegistry
        self.selector = InputTargetSelector.live(refRegistry: refRegistry)
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "click":
            handleClick(action, completion: completion)
        case "type":
            handleType(action, completion: completion)
        case "keys":
            handleKeys(action, completion: completion)
        case "scroll":
            handleScroll(action, completion: completion)
        case "drag":
            handleDrag(action, completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    // MARK: - Routing helpers

    // Reads (ref?, app?, pid?) out of the action and asks the selector
    // for a delivery target. Used by every input verb so behavior is
    // uniform: ref present → AX press; explicit app/pid → postToPid;
    // nothing → legacy cghidEventTap.
    private func selectTarget(_ action: [String: Any]) -> InputTarget {
        let ref = action["ref"] as? String
        let appName = action["app"] as? String
        let pid: pid_t? = (action["pid"] as? Int).map { pid_t($0) } ?? (action["pid"] as? pid_t)
        return selector.select(ref: ref, appName: appName, pid: pid)
    }

    // Same shape but returns just a PID for keyboard fallback paths
    // (type / keys) where AX press was inappropriate or unavailable.
    private func targetPid(_ action: [String: Any]) -> pid_t? {
        let ref = action["ref"] as? String
        let appName = action["app"] as? String
        let pid: pid_t? = (action["pid"] as? Int).map { pid_t($0) } ?? (action["pid"] as? pid_t)
        return selector.resolveTargetPid(ref: ref, appName: appName, pid: pid)
    }

    // Posts a single CGEvent through the right layer for the resolved
    // target. Centralizes the post-tap vs post-to-pid choice so every
    // verb can stay short and consistent.
    private func post(_ event: CGEvent, on target: InputTarget) {
        Self.postEvent(event, on: target)
    }

    static func postEvent(_ event: CGEvent, on target: InputTarget) {
        switch target {
        case .axPress:
            // AX press doesn't post events; callers handle that path
            // explicitly. Falling through here would be a bug.
            break
        case .postToPid(let pid):
            event.postToPid(pid)
        case .cghidEventTap:
            event.post(tap: .cghidEventTap)
        }
    }

    /// Posts `text` as unicode keystrokes, one key-down/up pair per character,
    /// through `target`. Shared with AuthDialogDomain (issue #244) so the admin
    /// prompt gets exactly the delivery `type` uses. False when no event
    /// source could be created.
    static func postUnicodeKeystrokes(_ text: String, to target: InputTarget) -> Bool {
        guard let source = CGEventSource(stateID: .combinedSessionState) else { return false }
        for char in text {
            let utf16 = Array(String(char).utf16)
            if let downEvent = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) {
                downEvent.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
                postEvent(downEvent, on: target)
            }
            usleep(3000)
            if let upEvent = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) {
                upEvent.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
                postEvent(upEvent, on: target)
            }
            usleep(8000)
        }
        return true
    }

    // MARK: - Click

    private func handleClick(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let double = action["double"] as? Bool ?? false
        let right = action["right"] as? Bool ?? false
        let clickCount = double ? 2 : 1

        let target = selectTarget(action)

        // Pure AX press — only for plain single left clicks against a ref.
        // AX press doesn't model double-click or right-click semantics;
        // those keep going through synthesized CGEvents.
        if case .axPress(let element) = target, !double, !right {
            let err = transport.performAction(element, kAXPressAction as String)
            if err == .success {
                completion(WireFormat.success("ax-pressed ref"))
                return
            }
            // Fall through: AX rejected the action; synthesize the click
            // and route it via PID so it still doesn't change focus.
        }

        // For AX-resolved targets, find the owning PID up front so we
        // can postToPid the synthesized events without taking focus.
        // For coords-only with no app, this falls back to cghidEventTap
        // (legacy behavior). Resolved here (outside the closure) so the
        // non-Sendable `action` dictionary doesn't have to be captured.
        let resolvedPostTarget: InputTarget
        switch target {
        case .axPress:
            if let pid = targetPid(action) { resolvedPostTarget = .postToPid(pid) }
            else { resolvedPostTarget = .cghidEventTap }
        default:
            resolvedPostTarget = target
        }

        resolveCoordinates(action) { [self] result in
            switch result {
            case .success(let point):
                let button: CGMouseButton = right ? .right : .left
                let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown
                let upType: CGEventType = right ? .rightMouseUp : .leftMouseUp

                guard let source = CGEventSource(stateID: .combinedSessionState) else {
                    completion(WireFormat.error("failed to create event source"))
                    return
                }

                let postTarget = resolvedPostTarget

                if let moveEvent = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
                    post(moveEvent, on: postTarget)
                }

                DispatchQueue.global().asyncAfter(deadline: .now() + 0.01) { [self] in
                    for click in 1...clickCount {
                        if let downEvent = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: button) {
                            downEvent.setIntegerValueField(.mouseEventClickState, value: Int64(click))
                            post(downEvent, on: postTarget)
                        }
                        usleep(5000)
                        if let upEvent = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: button) {
                            upEvent.setIntegerValueField(.mouseEventClickState, value: Int64(click))
                            post(upEvent, on: postTarget)
                        }
                        if click < clickCount { usleep(50000) }
                    }
                    let routing: String
                    switch postTarget {
                    case .postToPid(let pid): routing = "pid=\(pid)"
                    case .cghidEventTap: routing = "frontmost"
                    case .axPress: routing = "ax"
                    }
                    completion(WireFormat.success("clicked at (\(Int(point.x)), \(Int(point.y))) → \(routing)"))
                }
            case .failure(let error):
                switch error {
                case .message(let msg): completion(WireFormat.error(msg))
                }
            }
        }
    }

    // MARK: - Type

    private func handleType(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let text = action["text"] as? String else {
            completion(WireFormat.error("type requires text"))
            return
        }

        // AX-first path: when a ref points to a text-bearing element,
        // try AXUIElementSetAttributeValue(kAXValueAttribute, text).
        // This bypasses the keyboard entirely and never moves focus.
        // Apple documents this as the supported way to programmatically
        // populate text fields.
        if let ref = action["ref"] as? String, let element = refRegistry.resolve(ref) {
            if isTextRole(element) {
                let err = transport.setAttributeValue(element, kAXValueAttribute as String, text as CFString)
                if err == .success {
                    completion(WireFormat.success("ax-set value (\(text.count) chars)"))
                    return
                }
                // Element rejected programmatic value-set (e.g. password
                // fields, fields with custom delegates). Fall through
                // to synthesized key events, but still route to the
                // ref's owning PID so we don't have to foreground.
            }
            // Focus the element first so synthesized keys land in it,
            // even though the app stays in the background.
            _ = transport.performAction(element, kAXPressAction as String)
            usleep(100_000)
        }

        // Pick a delivery target for synthesized key events: prefer
        // postToPid (ref → owning PID, or explicit pid/app), else fall
        // through to cghidEventTap.
        let postTarget: InputTarget
        if let pid = targetPid(action) {
            postTarget = .postToPid(pid)
        } else {
            postTarget = .cghidEventTap
        }

        DispatchQueue.global().async {
            guard Self.postUnicodeKeystrokes(text, to: postTarget) else {
                completion(WireFormat.error("failed to create event source"))
                return
            }
            let routing: String
            switch postTarget {
            case .postToPid(let pid): routing = "pid=\(pid)"
            case .cghidEventTap: routing = "frontmost"
            case .axPress: routing = "ax"
            }
            completion(WireFormat.success("typed \(text.count) characters → \(routing)"))
        }
    }

    // Roles that we accept programmatic value-set on. These are the
    // standard text-bearing AX roles per Apple's accessibility
    // documentation.
    private func isTextRole(_ element: AXUIElement) -> Bool {
        let (result, role) = transport.copyAttributeValue(element, kAXRoleAttribute as String)
        guard result == .success, let r = AXValueCodec.displayString(role) else {
            return false
        }
        switch r {
        case "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox":
            return true
        default:
            return false
        }
    }

    // MARK: - Keys

    private static let keyMap: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
        "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
        "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
        "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
        "enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "delete": 117,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "up": 126, "down": 125, "left": 123, "right": 124, "arrowup": 126, "arrowdown": 125, "arrowleft": 123, "arrowright": 124,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]

    private func handleKeys(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let keys = action["keys"] as? String else {
            completion(WireFormat.error("keys requires a key combo string"))
            return
        }

        let parts = keys.split(separator: "+").map { String($0) }
        let key = parts.last?.lowercased() ?? ""
        let modifiers = parts.dropLast().map { $0.lowercased() }

        guard let keyCode = Self.keyMap[key] else {
            completion(WireFormat.error("unknown key: \(key)"))
            return
        }

        var flags: CGEventFlags = []
        for mod in modifiers {
            switch mod {
            case "shift": flags.insert(.maskShift)
            case "control", "ctrl": flags.insert(.maskControl)
            case "alt", "option": flags.insert(.maskAlternate)
            case "meta", "command", "cmd": flags.insert(.maskCommand)
            default: break
            }
        }

        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            completion(WireFormat.error("failed to create event source"))
            return
        }

        // Same routing rule as click/type: ref → owning PID, else
        // explicit pid/app, else cghidEventTap.
        let postTarget: InputTarget
        if let pid = targetPid(action) {
            postTarget = .postToPid(pid)
        } else {
            postTarget = .cghidEventTap
        }

        DispatchQueue.global().async { [self] in
            // Press modifiers
            let modKeyCodes: [(String, CGKeyCode)] = [
                ("shift", 56), ("control", 59), ("ctrl", 59), ("alt", 58), ("option", 58),
                ("meta", 55), ("command", 55), ("cmd", 55)
            ]
            for mod in modifiers {
                if let (_, code) = modKeyCodes.first(where: { $0.0 == mod }) {
                    if let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true) {
                        event.flags = flags
                        post(event, on: postTarget)
                    }
                }
            }
            usleep(5000)

            if let downEvent = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true) {
                downEvent.flags = flags
                post(downEvent, on: postTarget)
            }
            usleep(5000)
            if let upEvent = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) {
                upEvent.flags = flags
                post(upEvent, on: postTarget)
            }

            usleep(5000)
            for mod in modifiers.reversed() {
                if let (_, code) = modKeyCodes.first(where: { $0.0 == mod }) {
                    if let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) {
                        post(event, on: postTarget)
                    }
                }
            }

            let routing: String
            switch postTarget {
            case .postToPid(let pid): routing = "pid=\(pid)"
            case .cghidEventTap: routing = "frontmost"
            case .axPress: routing = "ax"
            }
            completion(WireFormat.success("sent keys: \(keys) → \(routing)"))
        }
    }

    // MARK: - Scroll

    private func handleScroll(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let direction = action["direction"] as? String ?? "down"
        let amount = action["amount"] as? Int32 ?? 300
        let times = max(1, action["times"] as? Int ?? 1)
        let intervalMs = max(0, action["intervalMs"] as? Int ?? 50)
        // Prefer ref-resolved owning PID, then explicit --pid, then
        // --app name lookup. Same precedence as click/type/keys.
        let pidFromAction = targetPid(action)

        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            completion(WireFormat.error("failed to create event source"))
            return
        }

        let dy: Int32
        let dx: Int32
        switch direction {
        case "up": dy = amount; dx = 0
        case "down": dy = -amount; dx = 0
        case "left": dy = 0; dx = amount
        case "right": dy = 0; dx = -amount
        default: dy = -amount; dx = 0
        }

        // when targeting a backgrounded process, wake its event
        // loop first via the SLPS make-key trick so Chromium / Electron
        // actually processes the scroll. The window stays where it is in
        // z-order; the user's focused app is preserved.
        if let pid = pidFromAction {
            // Find a window for this pid via CGWindowList so we have a CGWindowID.
            if let arr = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] {
                let mine = arr.first(where: { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid })
                if let wid = mine?[kCGWindowNumber as String] as? CGWindowID {
                    _ = cgsWakeWindowEventLoop(pid: pid, windowID: wid)
                    // Tiny grace so Chromium can flush its input queue once.
                    usleep(40_000)
                }
            }
        }

        for i in 0..<times {
            if let scrollEvent = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
                if let pid = pidFromAction {
                    scrollEvent.postToPid(pid)
                } else {
                    scrollEvent.post(tap: .cghidEventTap)
                }
            }
            if i < times - 1, intervalMs > 0 {
                usleep(useconds_t(intervalMs * 1000))
            }
        }
        let routing = pidFromAction.map { "pid=\($0)" } ?? "frontmost"
        completion(WireFormat.success("scrolled \(direction) \(amount)x\(times) → \(routing)"))
    }

    // MARK: - Drag

    private func handleDrag(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let postTarget: InputTarget
        if let pid = targetPid(action) {
            postTarget = .postToPid(pid)
        } else {
            postTarget = .cghidEventTap
        }

        guard let fromRef = action["from"] as? String, let toRef = action["to"] as? String else {
            // Try coordinate-based drag
            if let fromCoords = action["fromCoords"] as? String, let toCoords = action["toCoords"] as? String {
                let fromParts = fromCoords.split(separator: ",").compactMap { Double($0) }
                let toParts = toCoords.split(separator: ",").compactMap { Double($0) }
                if fromParts.count == 2 && toParts.count == 2 {
                    performDrag(from: CGPoint(x: fromParts[0], y: fromParts[1]), to: CGPoint(x: toParts[0], y: toParts[1]), target: postTarget, completion: completion)
                    return
                }
            }
            completion(WireFormat.error("drag requires from and to refs or coordinates"))
            return
        }

        guard let fromElement = refRegistry.resolve(fromRef),
              let toElement = refRegistry.resolve(toRef) else {
            completion(WireFormat.error("could not resolve refs"))
            return
        }

        guard let fromPoint = centerPoint(of: fromElement),
              let toPoint = centerPoint(of: toElement) else {
            completion(WireFormat.error("could not get element positions"))
            return
        }

        // Refs were given but no app/pid was; pick up the owning PID
        // from the ref so the drag still routes correctly.
        let dragTarget: InputTarget
        switch postTarget {
        case .cghidEventTap:
            if let pid = refRegistry.resolvePID(fromRef) { dragTarget = .postToPid(pid) }
            else { dragTarget = .cghidEventTap }
        default:
            dragTarget = postTarget
        }

        performDrag(from: fromPoint, to: toPoint, target: dragTarget, completion: completion)
    }

    private func performDrag(from: CGPoint, to: CGPoint, target: InputTarget, completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            completion(WireFormat.error("failed to create event source"))
            return
        }

        DispatchQueue.global().async { [self] in
            // Move to start
            if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left) {
                post(move, on: target)
            }
            usleep(10000)

            // Mouse down
            if let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left) {
                post(down, on: target)
            }
            usleep(10000)

            // Interpolate drag
            let steps = 20
            for i in 1...steps {
                let t = CGFloat(i) / CGFloat(steps)
                let x = from.x + (to.x - from.x) * t
                let y = from.y + (to.y - from.y) * t
                if let drag = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) {
                    post(drag, on: target)
                }
                usleep(5000)
            }

            // Mouse up
            if let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left) {
                post(up, on: target)
            }
            let routing: String
            switch target {
            case .postToPid(let pid): routing = "pid=\(pid)"
            case .cghidEventTap: routing = "frontmost"
            case .axPress: routing = "ax"
            }
            completion(WireFormat.success("dragged from (\(Int(from.x)),\(Int(from.y))) to (\(Int(to.x)),\(Int(to.y))) → \(routing)"))
        }
    }

    // MARK: - Helpers

    private func resolveCoordinates(_ action: [String: Any], completion: @escaping @Sendable (Swift.Result<CGPoint, InputError>) -> Void) {
        // Direct coordinates: "500,300"
        if let coords = action["coords"] as? String {
            let parts = coords.split(separator: ",").compactMap { Double($0) }
            if parts.count == 2 {
                completion(.success(CGPoint(x: parts[0], y: parts[1])))
                return
            } else {
                completion(.failure(.message("invalid coordinates: \(coords)")))
                return
            }
        }

        // Ref-based
        if let ref = action["ref"] as? String {
            guard let element = refRegistry.resolve(ref) else {
                completion(.failure(.message("ref \(ref) not found")))
                return
            }
            guard let point = centerPoint(of: element) else {
                completion(.failure(.message("could not get position for \(ref)")))
                return
            }
            completion(.success(point))
            return
        }

        completion(.failure(.message("click requires ref or coords")))
    }

    private func centerPoint(of element: AXUIElement) -> CGPoint? {
        let (posResult, posValue) = transport.copyAttributeValue(element, kAXPositionAttribute as String)
        let (sizeResult, sizeValue) = transport.copyAttributeValue(element, kAXSizeAttribute as String)
        guard posResult == .success, sizeResult == .success,
              let position = AXValueCodec.point(from: posValue),
              let size = AXValueCodec.size(from: sizeValue) else {
            return nil
        }
        return CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
    }
}
