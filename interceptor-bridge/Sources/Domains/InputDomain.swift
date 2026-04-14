import Foundation
import CoreGraphics
import ApplicationServices

enum InputError: Error {
    case message(String)
}

final class InputDomain: DomainHandler, @unchecked Sendable {
    private let refRegistry: RefRegistry

    init(refRegistry: RefRegistry = .shared) {
        self.refRegistry = refRegistry
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

    // MARK: - Click

    private func handleClick(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let double = action["double"] as? Bool ?? false
        let right = action["right"] as? Bool ?? false
        let clickCount = double ? 2 : 1

        resolveCoordinates(action) { result in
            switch result {
            case .success(let point):
                let button: CGMouseButton = right ? .right : .left
                let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown
                let upType: CGEventType = right ? .rightMouseUp : .leftMouseUp

                guard let source = CGEventSource(stateID: .combinedSessionState) else {
                    completion(WireFormat.error("failed to create event source"))
                    return
                }

                // Move first
                if let moveEvent = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
                    moveEvent.post(tap: .cghidEventTap)
                }

                DispatchQueue.global().asyncAfter(deadline: .now() + 0.01) {
                    for click in 1...clickCount {
                        if let downEvent = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: button) {
                            downEvent.setIntegerValueField(.mouseEventClickState, value: Int64(click))
                            downEvent.post(tap: .cghidEventTap)
                        }
                        usleep(5000)
                        if let upEvent = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: button) {
                            upEvent.setIntegerValueField(.mouseEventClickState, value: Int64(click))
                            upEvent.post(tap: .cghidEventTap)
                        }
                        if click < clickCount { usleep(50000) }
                    }
                    completion(WireFormat.success("clicked at (\(Int(point.x)), \(Int(point.y)))"))
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

        // If ref provided, focus first
        if let ref = action["ref"] as? String {
            if let element = refRegistry.resolve(ref) {
                AXUIElementPerformAction(element, kAXPressAction as CFString)
                usleep(100_000)
            }
        }

        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            completion(WireFormat.error("failed to create event source"))
            return
        }

        DispatchQueue.global().async {
            for char in text {
                let utf16 = Array(String(char).utf16)
                if let downEvent = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) {
                    downEvent.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
                    downEvent.post(tap: .cghidEventTap)
                }
                usleep(3000)
                if let upEvent = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) {
                    upEvent.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
                    upEvent.post(tap: .cghidEventTap)
                }
                usleep(8000)
            }
            completion(WireFormat.success("typed \(text.count) characters"))
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

        DispatchQueue.global().async {
            // Press modifiers
            let modKeyCodes: [(String, CGKeyCode)] = [
                ("shift", 56), ("control", 59), ("ctrl", 59), ("alt", 58), ("option", 58),
                ("meta", 55), ("command", 55), ("cmd", 55)
            ]
            for mod in modifiers {
                if let (_, code) = modKeyCodes.first(where: { $0.0 == mod }) {
                    if let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true) {
                        event.flags = flags
                        event.post(tap: .cghidEventTap)
                    }
                }
            }
            usleep(5000)

            if let downEvent = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true) {
                downEvent.flags = flags
                downEvent.post(tap: .cghidEventTap)
            }
            usleep(5000)
            if let upEvent = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) {
                upEvent.flags = flags
                upEvent.post(tap: .cghidEventTap)
            }

            usleep(5000)
            for mod in modifiers.reversed() {
                if let (_, code) = modKeyCodes.first(where: { $0.0 == mod }) {
                    if let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) {
                        event.post(tap: .cghidEventTap)
                    }
                }
            }

            completion(WireFormat.success("sent keys: \(keys)"))
        }
    }

    // MARK: - Scroll

    private func handleScroll(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let direction = action["direction"] as? String ?? "down"
        let amount = action["amount"] as? Int32 ?? 300

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

        if let scrollEvent = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
            scrollEvent.post(tap: .cghidEventTap)
        }
        completion(WireFormat.success("scrolled \(direction) \(amount)"))
    }

    // MARK: - Drag

    private func handleDrag(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let fromRef = action["from"] as? String, let toRef = action["to"] as? String else {
            // Try coordinate-based drag
            if let fromCoords = action["fromCoords"] as? String, let toCoords = action["toCoords"] as? String {
                let fromParts = fromCoords.split(separator: ",").compactMap { Double($0) }
                let toParts = toCoords.split(separator: ",").compactMap { Double($0) }
                if fromParts.count == 2 && toParts.count == 2 {
                    performDrag(from: CGPoint(x: fromParts[0], y: fromParts[1]), to: CGPoint(x: toParts[0], y: toParts[1]), completion: completion)
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

        performDrag(from: fromPoint, to: toPoint, completion: completion)
    }

    private func performDrag(from: CGPoint, to: CGPoint, completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            completion(WireFormat.error("failed to create event source"))
            return
        }

        DispatchQueue.global().async {
            // Move to start
            if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left) {
                move.post(tap: .cghidEventTap)
            }
            usleep(10000)

            // Mouse down
            if let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left) {
                down.post(tap: .cghidEventTap)
            }
            usleep(10000)

            // Interpolate drag
            let steps = 20
            for i in 1...steps {
                let t = CGFloat(i) / CGFloat(steps)
                let x = from.x + (to.x - from.x) * t
                let y = from.y + (to.y - from.y) * t
                if let drag = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) {
                    drag.post(tap: .cghidEventTap)
                }
                usleep(5000)
            }

            // Mouse up
            if let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left) {
                up.post(tap: .cghidEventTap)
            }
            completion(WireFormat.success("dragged from (\(Int(from.x)),\(Int(from.y))) to (\(Int(to.x)),\(Int(to.y)))"))
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
        var posValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posValue) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success else {
            return nil
        }

        var position = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(posValue as! AXValue, .cgPoint, &position)
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)

        return CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
    }
}
