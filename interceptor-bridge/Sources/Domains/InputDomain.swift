import Foundation
import CoreGraphics
import ApplicationServices
import AppKit
import InputKeycodes

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
        // The browser path always names its window. Without one, every verb
        // below would fall back to the frontmost app.
        if (action["type"] as? String)?.hasPrefix("macos_\(Self.browserDomainKey)_") == true, windowRequest(action).bounds == nil {
            completion(WireFormat.error("the daemon named no window to address (nothing was delivered)"))
            return
        }
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

    // Refuse before posting anything when the caller named a target that
    // cannot be honored: an expired ref, an app that is not running, or a ref
    // whose owner is not the requested app. Every input verb checks this first
    // so a failed explicit target never becomes an implicit frontmost target.
    private func explicitTargetProblem(_ action: [String: Any]) -> String? {
        let appName = action["app"] as? String
        let pid: pid_t? = (action["pid"] as? Int).map { pid_t($0) } ?? (action["pid"] as? pid_t)
        // Every ref the action names must resolve and belong to the explicit
        // app/pid: "ref" for click/type/keys/scroll, "from"/"to" for drag.
        let refs = ["ref", "from", "to"].compactMap { action[$0] as? String }.filter { !$0.isEmpty }
        if refs.isEmpty { return selector.explicitTargetProblem(ref: nil, appName: appName, pid: pid) }
        for ref in refs {
            if let problem = selector.explicitTargetProblem(ref: ref, appName: appName, pid: pid) { return problem }
        }
        // A ref and --window must name the same window. The AX press and
        // value-set paths act on the ref before any window is picked, so a
        // mismatch would change the ref's window while reporting the other.
        if let wanted = windowRequest(action).windowID {
            for ref in refs {
                guard let element = refRegistry.resolve(ref),
                      let owner = BackgroundInput.windowID(owning: element, transport: transport), owner != wanted else { continue }
                return "ref \(ref) is in window \(owner), not window \(wanted); drop --window or use a ref from that window (nothing was delivered)"
            }
        }
        return nil
    }

    // MARK: - Window-addressed delivery

    private enum Addressed {
        /// Nothing to address (or the private symbols are missing): the
        /// caller keeps its plain per-pid / HID-tap delivery.
        case none
        case problem(String)
        case session(BackgroundInputSession)
    }

    private static let windowInputUnavailable =
        "window-addressed input is not available on this macOS build (nothing was delivered)"
    private static let deliveryFailed =
        "could not deliver to the window: no event source, or the window could not be given focus (nothing was delivered)"

    /// The daemon's browser path. It arrives under its own domain key so a
    /// bridge that predates window-addressed input answers "no handler"
    /// instead of posting the event to the frontmost app.
    static let browserDomainKey = "bginput"

    // `window` is a CGWindowID from `macos windows`; `windowTitle` +
    // `windowBounds` come from the daemon for a browser tab's window.
    private func windowRequest(_ action: [String: Any]) -> WindowRequest {
        var request = WindowRequest()
        if let id = action["window"] as? Int, id > 0 { request.windowID = CGWindowID(clamping: id) }
        request.title = action["windowTitle"] as? String
        if let b = action["windowBounds"] as? [String: Any],
           let left = (b["left"] as? NSNumber)?.doubleValue, let top = (b["top"] as? NSNumber)?.doubleValue,
           let width = (b["width"] as? NSNumber)?.doubleValue, let height = (b["height"] as? NSNumber)?.doubleValue {
            request.bounds = CGRect(x: left, y: top, width: width, height: height)
        }
        return request
    }

    // Finds the one window an app-targeted verb should reach. Mouse verbs
    // (`mustResolve`) refuse when no window resolves, because an unaddressed
    // per-pid mouse event is dropped by a background app. Keyboard and scroll
    // fall back to plain per-pid delivery for apps with no listed window.
    private func addressed(_ action: [String: Any], pid: pid_t?, point: CGPoint?, refKeys: [String], mustResolve: Bool) -> Addressed {
        var request = windowRequest(action)
        let explicit = request.isExplicit
        guard pid != nil || explicit else { return .none }
        guard cgsWindowInputAvailable else {
            // Without a pid there is no safe unaddressed fallback: the HID tap
            // would hit whatever is frontmost.
            return pid == nil ? .problem(Self.windowInputUnavailable) : .none
        }
        if !explicit {
            for key in refKeys {
                guard let ref = action[key] as? String, let element = refRegistry.resolve(ref) else { continue }
                request.windowID = BackgroundInput.windowID(owning: element, transport: transport)
                break
            }
            if request.windowID == nil, point == nil, let pid = pid {
                request.windowID = BackgroundInput.focusedWindow(of: pid, transport: transport)?.id
            }
        }
        switch BackgroundInput.pick(from: BackgroundInput.onScreenWindows(), pid: pid, request: request, point: point) {
        case .found(let window): return .session(BackgroundInputSession(window: window))
        case .problem(let message): return (mustResolve || explicit) ? .problem(message) : .none
        case nil: return .none
        }
    }

    // Keyboard flavor: a session to focus around the key events, or a refusal.
    private func keyboardSession(_ action: [String: Any], pid: pid_t?) -> (session: BackgroundInputSession?, refusal: String?) {
        switch addressed(action, pid: pid, point: nil, refKeys: ["ref"], mustResolve: false) {
        case .session(let session): return (session, nil)
        case .problem(let message): return (nil, message)
        case .none: return (nil, nil)
        }
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
            event.postToPidNow(pid)
        case .cghidEventTap:
            event.post(tap: .cghidEventTap)
        }
    }

    /// Posts `text` as unicode keystrokes, one key-down/up pair per character,
    /// through `target`. Shared with AuthDialogDomain (issue #244) so the admin
    /// prompt gets exactly the delivery `type` uses. False when no event
    /// source could be created.
    static func postUnicodeKeystrokes(_ text: String, to target: InputTarget, shouldContinue: () -> Bool = { true }) -> Bool {
        // Text carries its own Unicode value. A held modifier from the shared
        // session would turn background text into shortcuts instead.
        guard let source = CGEventSource(stateID: .privateState) else { return false }
        for char in text {
            guard shouldContinue() else { return false }
            let utf16 = Array(String(char).utf16)
            // Allocate both before posting either. A partial delivery is never
            // reported as a completed sequence when event creation fails.
            guard let downEvent = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let upEvent = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { return false }
            downEvent.flags = []
            downEvent.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            postEvent(downEvent, on: target)
            usleep(3000)
            guard shouldContinue() else { return false }
            upEvent.flags = []
            upEvent.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            postEvent(upEvent, on: target)
            usleep(8000)
        }
        return true
    }

    // MARK: - Click

    private func handleClick(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let double = action["double"] as? Bool ?? false
        let right = action["right"] as? Bool ?? false
        let clickCount = double ? 2 : 1

        if let problem = explicitTargetProblem(action) {
            completion(WireFormat.error(problem))
            return
        }
        // A disabled control does nothing when pressed, but AXPress still answers success;
        // refuse as action does, for every click kind on a ref.
        if let ref = action["ref"] as? String, let element = refRegistry.resolve(ref), axElementDisabled(element, transport: transport) {
            completion(WireFormat.failure("unsupported_target", "element is disabled; nothing was clicked")); return
        }
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

        // An app target (or a named window) gets window-addressed delivery:
        // it reaches a background window, and refuses when none resolves.
        var appPid: pid_t? = nil
        if case .postToPid(let pid) = resolvedPostTarget { appPid = pid }
        if appPid != nil || windowRequest(action).isExplicit {
            let point: CGPoint
            switch resolvePoint(action) {
            case .success(let p): point = p
            case .failure(.message(let msg)): completion(WireFormat.error(msg)); return
            }
            switch addressed(action, pid: appPid, point: point, refKeys: ["ref"], mustResolve: true) {
            case .problem(let message):
                completion(WireFormat.failure("unsupported_target", message, details: ["delivered": 0]))
                return
            case .session(let session):
                DispatchQueue.global().async {
                    guard session.click(at: point, right: right, count: clickCount) else {
                        completion(WireFormat.error(Self.deliveryFailed))
                        return
                    }
                    completion(WireFormat.success("clicked at (\(Int(point.x)), \(Int(point.y))) → \(session.routing)"))
                }
                return
            case .none:
                break
            }
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
        if let problem = explicitTargetProblem(action) {
            completion(WireFormat.error(problem))
            return
        }

        // AX-first path: when a ref points to a text-bearing element,
        // try AXUIElementSetAttributeValue(kAXValueAttribute, text).
        // This bypasses the keyboard entirely and never moves focus.
        // Apple documents this as the supported way to programmatically
        // populate text fields.
        let keycodesUS = action["keycodesUS"] as? Bool ?? false
        if action["keycodesUS"] != nil && !(action["keycodesUS"] is Bool) {
            completion(WireFormat.error("keycodesUS requires a boolean")); return
        }
        let physical = keycodesUS ? Self.usPhysicalKeys(text) : nil
        if keycodesUS && physical == nil {
            completion(WireFormat.error("physical US-key typing accepts printable ASCII, tab and newline only; nothing was typed")); return
        }
        if let ref = action["ref"] as? String, let element = refRegistry.resolve(ref) {
            // A disabled or read-only target takes no text. Typing into one used to fall back to keys that
            // landed in whichever field had focus; refuse instead, as value does.
            if axElementDisabled(element, transport: transport) { completion(WireFormat.failure("unsupported_target", "element is disabled; nothing was typed")); return }
            if isTextRole(element), !isSecureField(element) {
                let (probe, settable) = transport.isAttributeSettable(element, kAXValueAttribute as String)
                if probe == .success && settable == false { completion(WireFormat.failure("unsupported_target", "the field is read-only; nothing was typed")); return }
            }
            if !keycodesUS && isTextRole(element) {
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
            _ = transport.setAttributeValue(element, kAXFocusedAttribute as String, kCFBooleanTrue)
            _ = transport.performAction(element, kAXPressAction as String)
            usleep(100_000)
            // Keys go to the app's focused element. When that is provably somewhere else, typing would edit
            // another field, so refuse; nothing was typed.
            if let elsewhere = focusElsewhere(element) { completion(WireFormat.failure("unsupported_target", "the ref could not take keyboard focus (\(elsewhere) has it), so the keys would go to another element; nothing was typed")); return }
        }

        // Pick a delivery target for synthesized key events: prefer
        // postToPid (ref → owning PID, or explicit pid/app), else fall
        // through to cghidEventTap. With an app target, the window is told
        // it has focus first so the keys land there and not in whichever
        // window the app last had key.
        let (session, refusal) = keyboardSession(action, pid: targetPid(action))
        if let refusal = refusal {
            completion(WireFormat.failure("unsupported_target", refusal, details: ["delivered": 0]))
            return
        }
        let postTarget: InputTarget
        if let pid = session?.pid ?? targetPid(action) {
            postTarget = .postToPid(pid)
        } else {
            postTarget = .cghidEventTap
        }

        DispatchQueue.global().async {
            guard let posted = BackgroundInputSession.gesture(session, {
                if let physical { return Self.postPhysicalKeys(physical, to: postTarget) }
                return Self.postUnicodeKeystrokes(text, to: postTarget)
            }) else {
                completion(WireFormat.error(Self.deliveryFailed))
                return
            }
            guard posted else {
                completion(WireFormat.error("failed to create event source"))
                return
            }
            let routing: String
            switch postTarget {
            case .postToPid(let pid): routing = session?.routing ?? "pid=\(pid)"
            case .cghidEventTap: routing = "frontmost"
            case .axPress: routing = "ax"
            }
            completion(WireFormat.success("typed \(text.count) characters → \(routing)"))
        }
    }

    private func isSecureField(_ element: AXUIElement) -> Bool {
        let (result, subrole) = transport.copyAttributeValue(element, kAXSubroleAttribute as String)
        return result == .success && AXValueCodec.displayString(subrole) == "AXSecureTextField"
    }

    /// The role and title of the app's focused element when it is neither the target nor inside or around
    /// it; nil when focus is on the target or cannot be read.
    private func focusElsewhere(_ element: AXUIElement) -> String? {
        guard case (.success, let pid?) = transport.pid(element) else { return nil }
        let (result, value) = transport.copyAttributeValue(transport.createApplication(pid: pid), kAXFocusedUIElementAttribute as String)
        guard result == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        let focused = value as! AXUIElement
        func chain(_ start: AXUIElement) -> [AXUIElement] {
            var out = [start], current = start
            for _ in 0..<32 { let (r, parent) = transport.copyAttributeValue(current, kAXParentAttribute as String); guard r == .success, let parent, CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }; current = parent as! AXUIElement; out.append(current) }
            return out
        }
        if chain(focused).contains(where: { CFEqual($0, element) }) || chain(element).contains(where: { CFEqual($0, focused) }) { return nil }
        let role = AXValueCodec.displayString(transport.copyAttributeValue(focused, kAXRoleAttribute as String).1) ?? "another element"
        let title = AXValueCodec.displayString(transport.copyAttributeValue(focused, kAXTitleAttribute as String).1) ?? AXValueCodec.displayString(transport.copyAttributeValue(focused, kAXDescriptionAttribute as String).1) ?? ""
        return title.isEmpty ? role : "\(role) '\(title)'"
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

    // VM keyboard devices consume keycodes rather than attached Unicode.
    // Validate the entire text before delivery and reuse the keys map.
    static func usPhysicalKeys(_ text: String) -> [(CGKeyCode, Bool)]? {
        let shifted = Array("~!@#$%^&*()_+{}|:\"<>?")
        let bases = Array("`1234567890-=[]\\;',./")
        var result: [(CGKeyCode, Bool)] = []
        for character in text {
            let scalar = character.unicodeScalars
            guard scalar.count == 1, let value = scalar.first?.value else { return nil }
            let base: String, shift: Bool
            if value >= 65 && value <= 90 { base = String(character).lowercased(); shift = true }
            else if let index = shifted.firstIndex(of: character) { base = String(bases[index]); shift = true }
            else if character == "\n" || character == "\r" { base = "return"; shift = false }
            else if character == "\t" { base = "tab"; shift = false }
            else { guard value >= 32 && value <= 126 else { return nil }; base = String(character); shift = false }
            guard let code = keyMap[base] else { return nil }
            result.append((code, shift))
        }
        return result
    }

    private static func postPhysicalKeys(_ keys: [(CGKeyCode, Bool)], to target: InputTarget) -> Bool {
        guard let source = CGEventSource(stateID: .combinedSessionState) else { return false }
        for (code, shifted) in keys {
            if shifted {
                guard let down = CGEvent(keyboardEventSource: source, virtualKey: 56, keyDown: true) else { return false }
                down.flags = .maskShift; postEvent(down, on: target); usleep(3000)
            }
            for pressed in [true, false] {
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: pressed) else { return false }
                event.flags = shifted ? .maskShift : []; postEvent(event, on: target); usleep(5000)
            }
            if shifted {
                guard let up = CGEvent(keyboardEventSource: source, virtualKey: 56, keyDown: false) else { return false }
                up.flags = []; postEvent(up, on: target)
            }
            usleep(8000)
        }
        return true
    }

    private static let keyMap = InputKeycodes.mac

    private func handleKeys(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let keys = action["keys"] as? String else {
            completion(WireFormat.error("keys requires a key combo string"))
            return
        }

        let parts = keys.split(separator: "+").map { String($0) }
        let key = parts.last?.lowercased() ?? ""
        let modifiers = parts.dropLast().map { $0.lowercased() }

        guard let keyCode = Self.keyMap[key] else {
            completion(WireFormat.failure("invalid_request", keys.hasSuffix("+") ? "keys \(keys) has no key after the last +; name one, for example \(keys)A" : "unknown key: \(key)", details: ["dispatched": false]))
            return
        }

        var flags: CGEventFlags = []
        for mod in modifiers {
            switch mod {
            case "shift": flags.insert(.maskShift)
            case "control", "ctrl": flags.insert(.maskControl)
            case "alt", "option": flags.insert(.maskAlternate)
            case "meta", "command", "cmd", "win", "super": flags.insert(.maskCommand)
            // Same names as Windows and Linux; an unknown modifier is refused, not dropped.
            default:
                completion(WireFormat.failure("invalid_request", "unknown modifier: \(mod)", details: ["dispatched": false]))
                return
            }
        }

        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            completion(WireFormat.error("failed to create event source"))
            return
        }

        if let problem = explicitTargetProblem(action) {
            completion(WireFormat.error(problem))
            return
        }
        // Same routing rule as click/type: ref → owning PID, else
        // explicit pid/app, else cghidEventTap.
        let (session, refusal) = keyboardSession(action, pid: targetPid(action))
        if let refusal = refusal {
            completion(WireFormat.failure("unsupported_target", refusal, details: ["delivered": 0]))
            return
        }
        let postTarget: InputTarget
        if let pid = session?.pid ?? targetPid(action) {
            postTarget = .postToPid(pid)
        } else {
            postTarget = .cghidEventTap
        }

        DispatchQueue.global().async { [self, flags] in
            let delivered: Void? = BackgroundInputSession.gesture(session) {
            // Press modifiers
            let modKeyCodes: [(String, CGKeyCode)] = [
                ("shift", 56), ("control", 59), ("ctrl", 59), ("alt", 58), ("option", 58),
                ("meta", 55), ("command", 55), ("cmd", 55), ("win", 55), ("super", 55)
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
            }
            guard delivered != nil else {
                completion(WireFormat.error(Self.deliveryFailed))
                return
            }

            let routing: String
            switch postTarget {
            case .postToPid(let pid): routing = session?.routing ?? "pid=\(pid)"
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
        if let problem = explicitTargetProblem(action) {
            completion(WireFormat.error(problem))
            return
        }
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

        // With an app target, stamp the scroll for one window at a known
        // point (the ref's center, else the window's center). An unstamped
        // scroll carries the real cursor position and a background app
        // drops it.
        if pidFromAction != nil || windowRequest(action).isExplicit {
            let refPoint = (action["ref"] as? String).flatMap { refRegistry.resolve($0) }.flatMap { visibleCenter(of: $0) }
            switch addressed(action, pid: pidFromAction, point: refPoint, refKeys: ["ref"], mustResolve: false) {
            case .problem(let message):
                completion(WireFormat.failure("unsupported_target", message, details: ["delivered": 0]))
                return
            case .session(let session):
                let at = refPoint ?? CGPoint(x: session.window.bounds.midX, y: session.window.bounds.midY)
                guard session.scroll(at: at, dy: dy, dx: dx, times: times, intervalMs: intervalMs) else {
                    completion(WireFormat.error("failed to create event source"))
                    return
                }
                completion(WireFormat.success("scrolled \(direction) \(amount)x\(times) → \(session.routing)"))
                return
            case .none:
                break
            }
        }

        // No window resolved (the app lists none on screen): wake its event
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
                    scrollEvent.postToPidNow(pid)
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
        if let problem = explicitTargetProblem(action) {
            completion(WireFormat.error(problem))
            return
        }
        var pid = targetPid(action)
        let fromPoint: CGPoint
        let toPoint: CGPoint

        if let fromRef = action["from"] as? String, let toRef = action["to"] as? String {
            guard let fromElement = refRegistry.resolve(fromRef),
                  let toElement = refRegistry.resolve(toRef) else {
                completion(WireFormat.error("could not resolve refs"))
                return
            }
            guard let from = centerPoint(of: fromElement),
                  let to = centerPoint(of: toElement) else {
                completion(WireFormat.error("could not get element positions"))
                return
            }
            fromPoint = from
            toPoint = to
            // Refs were given but no app/pid was; pick up the owning PID
            // from the ref so the drag still routes correctly.
            if pid == nil { pid = refRegistry.resolvePID(fromRef) }
        } else {
            // Coordinate-based drag
            let fromParts = (action["fromCoords"] as? String ?? "").split(separator: ",").compactMap { Double($0) }
            let toParts = (action["toCoords"] as? String ?? "").split(separator: ",").compactMap { Double($0) }
            guard fromParts.count == 2, toParts.count == 2 else {
                completion(WireFormat.error("drag requires from and to refs or coordinates"))
                return
            }
            fromPoint = CGPoint(x: fromParts[0], y: fromParts[1])
            toPoint = CGPoint(x: toParts[0], y: toParts[1])
        }

        if pid != nil || windowRequest(action).isExplicit {
            switch addressed(action, pid: pid, point: fromPoint, refKeys: ["from"], mustResolve: true) {
            case .problem(let message):
                completion(WireFormat.failure("unsupported_target", message, details: ["delivered": 0]))
                return
            case .session(let session):
                // The whole gesture stays in the addressed window, as click requires of its point.
                guard session.window.bounds.contains(toPoint) else {
                    completion(WireFormat.failure("unsupported_target", "(\(Int(toPoint.x)), \(Int(toPoint.y))) is outside window \(session.window.id); 'interceptor macos windows' lists window frames (nothing was delivered)", details: ["delivered": 0]))
                    return
                }
                DispatchQueue.global().async {
                    guard session.drag(from: fromPoint, to: toPoint) else {
                        completion(WireFormat.error(Self.deliveryFailed))
                        return
                    }
                    completion(WireFormat.success("dragged from (\(Int(fromPoint.x)),\(Int(fromPoint.y))) to (\(Int(toPoint.x)),\(Int(toPoint.y))) → \(session.routing)"))
                }
                return
            case .none:
                break
            }
        }

        performDrag(from: fromPoint, to: toPoint, target: pid.map { .postToPid($0) } ?? .cghidEventTap, completion: completion)
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
        completion(resolvePoint(action))
    }

    private func resolvePoint(_ action: [String: Any]) -> Swift.Result<CGPoint, InputError> {
        // Direct coordinates: "500,300"
        if let coords = action["coords"] as? String {
            let parts = coords.split(separator: ",").compactMap { Double($0) }
            return parts.count == 2
                ? .success(CGPoint(x: parts[0], y: parts[1]))
                : .failure(.message("invalid coordinates: \(coords)"))
        }

        // Ref-based
        if let ref = action["ref"] as? String {
            guard let element = refRegistry.resolve(ref) else {
                return .failure(.message("ref \(ref) not found"))
            }
            guard let point = centerPoint(of: element) else {
                return .failure(.message("could not get position for \(ref)"))
            }
            return .success(point)
        }

        return .failure(.message("click requires ref or coords"))
    }

    /// A document view inside a scroll area reports its whole frame (a 3000 px text view), so a scroll
    /// aims at the part the nearest enclosing scroll area shows.
    private func visibleCenter(of element: AXUIElement) -> CGPoint? {
        func frame(_ e: AXUIElement) -> CGRect? {
            let (p, pos) = transport.copyAttributeValue(e, kAXPositionAttribute as String), (s, size) = transport.copyAttributeValue(e, kAXSizeAttribute as String)
            guard p == .success, s == .success, let origin = AXValueCodec.point(from: pos), let extent = AXValueCodec.size(from: size) else { return nil }
            return CGRect(origin: origin, size: extent)
        }
        guard var rect = frame(element) else { return nil }
        var current = element
        for _ in 0..<8 {
            let (result, parentRef) = transport.copyAttributeValue(current, kAXParentAttribute as String)
            guard result == .success, let parent = AXValueCodec.asElement(parentRef) else { break }
            if transport.copyAttributeValue(parent, kAXRoleAttribute as String).1 as? String == kAXScrollAreaRole as String {
                if let visible = frame(parent), !rect.intersection(visible).isEmpty { rect = rect.intersection(visible) }
                break
            }
            current = parent
        }
        return CGPoint(x: rect.midX, y: rect.midY)
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
