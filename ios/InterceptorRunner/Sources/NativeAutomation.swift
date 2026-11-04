import XCTest
import UIKit
import CoreLocation

// Swift's prefix maps omit file paths embedded by runtime isolation diagnostics.
#sourceLocation(file: "InterceptorRunner/NativeAutomation.swift", line: 7)
/// Native operations stay in the existing XCTest session and exception boundary.
enum NativeAutomation {
    private static var supportsSiri: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        // shortcut: physical iOS 27 Siri answered but detached the runner; enable after a stable round trip passes.
        if #available(iOS 27.0, *) { return false }
        return true
        #endif
    }

    private static var supportsKeyboardShortcuts: Bool {
        // shortcut: enable only the verified physical iOS 27 path until other runtimes pass editing checks.
        #if targetEnvironment(simulator)
        return false
        #else
        if #available(iOS 27.0, *) { return true }
        return false
        #endif
    }

    private static func failure(_ message: String) -> NSError {
        NSError(domain: "InterceptorRunner", code: 198, userInfo: [NSLocalizedDescriptionKey: message])
    }

    static func run(op: String, args: [String: Any], app: XCUIApplication) throws -> [String: Any] {
        let action = args["action"] as? String ?? ""
        let value = args["value"] as? String ?? ""
        if ["element", "key", "audit"].contains(op) && app.state != .runningForeground {
            throw failure("target app is no longer foreground; activate it and read a fresh tree")
        }
        switch op {
        case "capabilities":
            var data: [String: Any] = [
                "osVersion": UIDevice.current.systemVersion,
                "operations": ["element", "key", "device", "audit", "authorization", "voiceover"],
                "nativeElementTargets": true,
                "directJPEGSelector": XCUIScreen.main.responds(to: NSSelectorFromString("screenshotWithPreferredEncoding:rect:error:")),
                "hidRecordingSelectors": ["startHIDEventRecordingWithError:", "stopHIDEventRecordingAndSaveToURL:error:", "playBackHIDEventRecordingFromURL:error:"].allSatisfy { XCUIDevice.shared.responds(to: NSSelectorFromString($0)) },
                "voiceover": false,
                "keyboardShortcuts": supportsKeyboardShortcuts,
                "siri": supportsSiri,
                "audit": false,
            ]
            if #available(iOS 17.0, *) { data["audit"] = true }
            if #available(iOS 27.0, *) { data["voiceover"] = true }
            if #available(iOS 16.0, *) {
                data["buttons"] = ["action": XCUIDevice.shared.hasHardwareButton(.action), "camera": XCUIDevice.shared.hasHardwareButton(.camera)]
            }
            return Runner.ok(data)
        case "element":
            let element = try resolve(args["target"], app: app)
            let velocity = Runner.dbl(args["velocity"], 1000)
            guard velocity.isFinite && velocity > 0 && velocity <= 10000 else { throw failure("velocity must be greater than 0 and at most 10000") }
            if ["tap", "double-tap", "two-finger-tap", "swipe", "pinch", "rotate"].contains(action) && !element.isHittable {
                throw failure("element is not hittable; reveal it or read a fresh tree")
            }
            switch action {
            case "tap": element.tap()
            case "double-tap": element.doubleTap()
            case "two-finger-tap": element.twoFingerTap()
            case "swipe":
                switch value {
                case "up": element.swipeUp(velocity: XCUIGestureVelocity(velocity))
                case "down": element.swipeDown(velocity: XCUIGestureVelocity(velocity))
                case "left": element.swipeLeft(velocity: XCUIGestureVelocity(velocity))
                case "right": element.swipeRight(velocity: XCUIGestureVelocity(velocity))
                default: throw failure("swipe requires up|down|left|right")
                }
            case "pinch":
                let scale = Runner.dbl(args["value"], .nan)
                guard scale.isFinite && scale > 0 && scale <= 10 else { throw failure("pinch scale must be greater than 0 and at most 10") }
                element.pinch(withScale: CGFloat(scale), velocity: CGFloat(scale < 1 ? -velocity : velocity))
            case "rotate":
                let radians = Runner.dbl(args["value"], .nan)
                guard radians.isFinite && abs(radians) <= 4 * .pi else { throw failure("rotation must be between -4pi and 4pi radians") }
                element.rotate(CGFloat(radians), withVelocity: CGFloat(radians < 0 ? -velocity : velocity))
            case "slider":
                let position = Runner.dbl(args["value"], .nan)
                guard element.elementType == .slider, position.isFinite && (0...1).contains(position) else { throw failure("slider requires a slider and a position from 0 to 1") }
                element.adjust(toNormalizedSliderPosition: CGFloat(position))
            case "picker":
                guard element.elementType == .pickerWheel, !value.isEmpty else { throw failure("picker requires a picker wheel and an exact value") }
                element.adjust(toPickerWheelValue: value)
            case "reveal":
                if let error = ICInvokeVoid(element, "scrollToVisible") { throw error }
                guard element.isHittable else { throw failure("scrollToVisible returned but the element is still not hittable") }
            default: throw failure("unknown element action")
            }
            return Runner.ok(["action": action, "via": "native-element"])
        case "key":
            let raw = args["key"] as? String ?? ""
            let usages: [String: UInt32] = ["enter": 0x28, "return": 0x28, "escape": 0x29, "delete": 0x2a, "backspace": 0x2a, "tab": 0x2b, "space": 0x2c, "home": 0x4a, "end": 0x4d, "right": 0x4f, "left": 0x50, "down": 0x51, "up": 0x52]
            guard raw.count == 1 || usages[raw.lowercased()] != nil else { throw failure("key requires one physical key") }
            var flags: XCUIElement.KeyModifierFlags = []
            for modifier in args["modifiers"] as? [String] ?? [] {
                switch modifier {
                case "command": flags.insert(.command)
                case "shift": flags.insert(.shift)
                case "control": flags.insert(.control)
                case "option": flags.insert(.option)
                default: throw failure("unknown modifier")
                }
            }
            guard flags.isEmpty || supportsKeyboardShortcuts else { throw failure("modified keys require a physical iOS 27 or later device in this runner. No key was sent. Use ios keys for literal text") }
            // XCTest's text-key path acknowledges named controls without delivering them on iOS 26/27.
            if let usage = usages[raw.lowercased()] {
                var error: Error?
                if flags.isEmpty { error = ICPerformDeviceEvent(0x07, usage, 0.05) }
                else { XCUIElement.perform(withKeyModifiers: flags) { error = ICPerformDeviceEvent(0x07, usage, 0.05) } }
                if let error = error { throw error }
                return Runner.ok(["key": raw, "via": "hid-key"])
            }
            app.typeKey(raw, modifierFlags: flags)
            return Runner.ok(["key": raw, "via": "native-key"])
        case "device":
            switch action {
            case "open":
                guard let url = URL(string: value), url.scheme != nil, !value.contains(where: { $0.isWhitespace }) else { throw failure("open requires an absolute URL") }
                if #available(iOS 16.4, *) {
                    if let bundle = args["bundleId"] as? String, !bundle.isEmpty { XCUIApplication(bundleIdentifier: bundle).open(url) }
                    else { XCUIDevice.shared.system.open(url) }
                } else { throw failure("runner URL opening requires iOS 16.4 or later") }
            case "appearance":
                let modes: [String: XCUIDevice.Appearance] = ["light": .light, "dark": .dark, "unspecified": .unspecified]
                guard let mode = modes[value] else { throw failure("appearance requires light|dark|unspecified") }
                XCUIDevice.shared.appearance = mode
                return Runner.ok(["appearance": value, "rawValue": XCUIDevice.shared.appearance.rawValue])
            case "orientation":
                let modes: [String: UIDeviceOrientation] = ["portrait": .portrait, "portrait-upside-down": .portraitUpsideDown, "landscape-left": .landscapeLeft, "landscape-right": .landscapeRight]
                guard let mode = modes[value] else { throw failure("invalid orientation") }
                XCUIDevice.shared.orientation = mode
                return Runner.ok(["orientation": value, "rawValue": XCUIDevice.shared.orientation.rawValue])
            case "location":
                if #available(iOS 16.4, *) {
                    if value == "clear" { XCUIDevice.shared.location = nil }
                    else {
                        let lat = Runner.dbl(args["lat"], .nan), lon = Runner.dbl(args["lon"], .nan)
                        guard lat.isFinite && lon.isFinite && abs(lat) <= 90 && abs(lon) <= 180 else { throw failure("invalid latitude or longitude") }
                        XCUIDevice.shared.location = XCUILocation(location: CLLocation(latitude: lat, longitude: lon))
                    }
                } else { throw failure("runner location requires iOS 16.4 or later") }
            case "siri":
                guard !value.isEmpty else { throw failure("siri requires recognition text") }
                guard supportsSiri else { throw failure("Siri automation is unavailable on physical iOS 27 in this runner: validation lost the command reply. No Siri request was sent") }
                XCUIDevice.shared.siriService.activate(voiceRecognitionText: value)
            case "present":
                if let error = ICInvokeVoid(XCUIDevice.shared, "simulateUserPresent") { throw error }
            default: throw failure("unknown device action")
            }
            return Runner.ok(["requested": action])
        case "audit":
            if #available(iOS 17.0, *) {
                var issues: [[String: Any]] = []
                try app.performAccessibilityAudit(for: .all) { issue in
                    var item: [String: Any] = ["type": issue.auditType.rawValue, "description": issue.compactDescription, "detail": issue.detailedDescription]
                    if let element = issue.element { item["label"] = element.label; item["identifier"] = element.identifier }
                    issues.append(item)
                    return true
                }
                return Runner.ok(["issues": issues, "count": issues.count])
            }
            throw failure("accessibility audit requires iOS 17 or later")
        case "authorization":
            let resources: [String: XCUIProtectedResource] = ["contacts": .contacts, "calendar": .calendar, "reminders": .reminders,
                "photos": .photos, "microphone": .microphone, "camera": .camera, "media-library": .mediaLibrary,
                "homekit": .homeKit, "focus": .focus, "bluetooth": .bluetooth, "location": .location, "health": .health, "tracking": .userTracking]
            guard action == "reset", let bundle = args["bundleId"] as? String, !bundle.isEmpty else { throw failure("authorization requires reset and an app bundle") }
            if value == "local-network" {
                if #available(iOS 15.4, *) { XCUIApplication(bundleIdentifier: bundle).resetAuthorizationStatus(for: .localNetwork) }
                else { throw failure("local-network reset requires iOS 15.4 or later") }
            } else {
                guard let resource = resources[value] else { throw failure("unsupported authorization resource") }
                XCUIApplication(bundleIdentifier: bundle).resetAuthorizationStatus(for: resource)
            }
            return Runner.ok(["reset": value, "bundleId": bundle])
        case "voiceover":
            guard #available(iOS 27.0, *) else { throw failure("VoiceOver automation requires iOS 27 or later; other native operations support iOS 26") }
            var error: NSError?
            guard let result = ICVoiceOverAction(action, &error) else { throw error ?? failure("VoiceOver operation failed") }
            return Runner.ok(result)
        default: throw failure("unknown native operation")
        }
    }

    private static func resolve(_ raw: Any?, app: XCUIApplication) throws -> XCUIElement {
        guard let target = raw as? [String: Any], let bundle = target["bundleId"] as? String,
              bundle == ICApplicationBundleID(app), let type = target["type"] as? UInt,
              let elementType = XCUIElement.ElementType(rawValue: type),
              let identifier = target["identifier"] as? String, let label = target["label"] as? String else {
            throw failure("invalid or stale native target; re-read ios tree")
        }
        if let foreground = ICActiveApplicationBundleID(), foreground != bundle { throw failure("target app is no longer foreground; re-read ios tree") }
        if elementType == .application { return app }
        let query = app.descendants(matching: elementType)
        let matches = identifier.isEmpty ? query.matching(NSPredicate(format: "label == %@", label)) : query.matching(identifier: identifier)
        var elements = matches.allElementsBoundByIndex.filter { $0.label == label && $0.identifier == identifier }
        // Unnamed picker wheels and repeated labels need the snapshot geometry too.
        if identifier.isEmpty && label.isEmpty || elements.count > 1 {
            guard let rect = target["rect"] as? [String: Any] else { throw failure("anonymous or ambiguous target needs a fresh tree") }
            let expected = CGRect(x: Runner.dbl(rect["x"], .nan), y: Runner.dbl(rect["y"], .nan), width: Runner.dbl(rect["width"], .nan), height: Runner.dbl(rect["height"], .nan))
            elements = elements.filter { abs($0.frame.minX - expected.minX) < 1 && abs($0.frame.minY - expected.minY) < 1 && abs($0.frame.width - expected.width) < 1 && abs($0.frame.height - expected.height) < 1 }
        }
        guard elements.count == 1 else { throw failure("native target is missing or ambiguous; re-read ios tree") }
        guard elements[0].isEnabled else { throw failure("native target is disabled") }
        return elements[0]
    }
}
