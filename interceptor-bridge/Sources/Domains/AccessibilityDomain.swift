import Foundation
import ApplicationServices
import AppKit

final class AccessibilityDomain: DomainHandler, @unchecked Sendable {
    let refRegistry = RefRegistry.shared
    private var observer: AXObserver?
    private var observedPID: pid_t = 0

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "tree":
            handleTree(action: action, completion: completion)
        case "find":
            handleFind(action: action, completion: completion)
        case "inspect":
            handleInspect(action: action, completion: completion)
        case "value":
            handleValue(action: action, completion: completion)
        case "action":
            handleAction(action: action, completion: completion)
        case "focused":
            handleFocused(action: action, completion: completion)
        case "windows":
            handleWindows(action: action, completion: completion)
        case "resize":
            handleResize(action: action, completion: completion)
        case "move":
            handleMove(action: action, completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func getFrontmostApp() -> NSRunningApplication? {
        return NSWorkspace.shared.frontmostApplication
    }

    private func getTargetApp(action: [String: Any]) -> NSRunningApplication? {
        if let pid = action["pid"] as? Int {
            return NSRunningApplication(processIdentifier: pid_t(pid))
        }
        if let name = action["app"] as? String {
            let apps = NSWorkspace.shared.runningApplications
            return apps.first { $0.localizedName == name }
        }
        return getFrontmostApp()
    }

    private func handleTree(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let app = getTargetApp(action: action) else {
            completion(WireFormat.error("no target app found"))
            return
        }

        let pid = app.processIdentifier
        ensureObserver(pid: pid)
        let axApp = AXUIElementCreateApplication(pid)
        let depth = action["depth"] as? Int ?? 10
        let filter = action["filter"] as? String ?? "interactive"
        let maxChars = action["maxChars"] as? Int ?? 50000

        refRegistry.clear()

        var output = ""
        buildTree(element: axApp, depth: 0, maxDepth: depth, filter: filter, output: &output, maxChars: maxChars)

        completion(WireFormat.success(output))
    }

    private func buildTree(element: AXUIElement, depth: Int, maxDepth: Int, filter: String, output: inout String, maxChars: Int) {
        guard depth < maxDepth, output.count < maxChars else { return }

        let role = getStringAttribute(element, kAXRoleAttribute as CFString) ?? "unknown"
        let title = getStringAttribute(element, kAXTitleAttribute as CFString)
        let value = getStringAttribute(element, kAXValueAttribute as CFString)
        let desc = getStringAttribute(element, kAXDescriptionAttribute as CFString)
        let label = title ?? desc ?? ""

        let isInteractive = ["AXButton", "AXTextField", "AXTextArea", "AXCheckBox",
                            "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXSlider",
                            "AXMenu", "AXMenuItem", "AXMenuButton", "AXLink", "AXTab",
                            "AXTabGroup", "AXToolbar", "AXList", "AXTable", "AXOutline",
                            "AXDisclosureTriangle", "AXIncrementor", "AXColorWell",
                            "AXSegmentedControl", "AXSwitch", "AXToggle",
                            "AXDatePicker", "AXStepper", "AXSearchField"].contains(role)

        let isHeadingOrLandmark = ["AXHeading", "AXGroup", "AXScrollArea", "AXSplitGroup",
                                   "AXWindow", "AXSheet", "AXDrawer"].contains(role)

        let shouldInclude: Bool
        switch filter {
        case "interactive":
            shouldInclude = isInteractive
        case "all":
            shouldInclude = isInteractive || isHeadingOrLandmark
        default:
            shouldInclude = true
        }

        if shouldInclude {
            let ref = refRegistry.register(element)
            let indent = String(repeating: "  ", count: depth)
            let displayRole = role.replacingOccurrences(of: "AX", with: "").lowercased()
            var line = "\(indent)[\(ref)] \(displayRole)"
            if !label.isEmpty { line += " \"\(label)\"" }
            if let v = value, !v.isEmpty, v != label { line += " value=\"\(v)\"" }
            output += line + "\n"
        }

        var children: CFTypeRef?
        let childResult = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
        guard childResult == .success, let childArray = children as? [AXUIElement] else { return }

        for child in childArray {
            buildTree(element: child, depth: depth + 1, maxDepth: maxDepth, filter: filter, output: &output, maxChars: maxChars)
        }
    }

    private func getStringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute, &value)
        guard result == .success else { return nil }
        if let str = value as? String { return str }
        if let num = value as? NSNumber { return num.stringValue }
        return nil
    }

    private func getFrame(_ element: AXUIElement) -> CGRect? {
        var posValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posValue) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success else {
            return nil
        }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(posValue as! AXValue, .cgPoint, &point),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else {
            return nil
        }
        return CGRect(origin: point, size: size)
    }

    private func handleFind(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let query = action["query"] as? String else {
            completion(WireFormat.error("find requires a query"))
            return
        }
        guard let app = getTargetApp(action: action) else {
            completion(WireFormat.error("no target app found"))
            return
        }

        let pid = app.processIdentifier
        let axApp = AXUIElementCreateApplication(pid)
        let roleFilter = action["role"] as? String

        refRegistry.clear()

        var matches: [[String: Any]] = []
        findElements(element: axApp, query: query.lowercased(), roleFilter: roleFilter?.lowercased(), depth: 0, maxDepth: 15, matches: &matches)

        completion(WireFormat.success(matches))
    }

    private func findElements(element: AXUIElement, query: String, roleFilter: String?, depth: Int, maxDepth: Int, matches: inout [[String: Any]]) {
        guard depth < maxDepth else { return }

        let role = getStringAttribute(element, kAXRoleAttribute as CFString) ?? ""
        let title = getStringAttribute(element, kAXTitleAttribute as CFString) ?? ""
        let desc = getStringAttribute(element, kAXDescriptionAttribute as CFString) ?? ""
        let value = getStringAttribute(element, kAXValueAttribute as CFString) ?? ""

        let displayRole = role.replacingOccurrences(of: "AX", with: "").lowercased()
        let searchable = "\(title) \(desc) \(value)".lowercased()

        if searchable.contains(query) {
            if roleFilter == nil || displayRole.contains(roleFilter!) {
                let ref = refRegistry.register(element)
                var match: [String: Any] = [
                    "ref": ref,
                    "role": displayRole,
                    "name": title.isEmpty ? desc : title
                ]
                if !value.isEmpty { match["value"] = value }
                if let frame = getFrame(element) {
                    match["frame"] = ["x": frame.origin.x, "y": frame.origin.y,
                                     "width": frame.size.width, "height": frame.size.height]
                }
                matches.append(match)
            }
        }

        var children: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success,
              let childArray = children as? [AXUIElement] else { return }
        for child in childArray {
            findElements(element: child, query: query, roleFilter: roleFilter, depth: depth + 1, maxDepth: maxDepth, matches: &matches)
        }
    }

    private func handleInspect(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let ref = action["ref"] as? String,
              let element = refRegistry.resolve(ref) else {
            completion(WireFormat.error("invalid ref"))
            return
        }

        var attrNames: CFArray?
        guard AXUIElementCopyAttributeNames(element, &attrNames) == .success,
              let names = attrNames as? [String] else {
            completion(WireFormat.error("failed to read attributes"))
            return
        }

        var attrs: [String: Any] = [:]
        for name in names {
            if let val = getStringAttribute(element, name as CFString) {
                attrs[name.replacingOccurrences(of: "AX", with: "")] = val
            }
        }

        if let frame = getFrame(element) {
            attrs["frame"] = ["x": frame.origin.x, "y": frame.origin.y,
                             "width": frame.size.width, "height": frame.size.height]
        }

        var actionNames: CFArray?
        if AXUIElementCopyActionNames(element, &actionNames) == .success,
           let actions = actionNames as? [String] {
            attrs["actions"] = actions.map { $0.replacingOccurrences(of: "AX", with: "") }
        }

        completion(WireFormat.success(attrs))
    }

    private func handleValue(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let ref = action["ref"] as? String,
              let element = refRegistry.resolve(ref) else {
            completion(WireFormat.error("invalid ref"))
            return
        }

        if let newValue = action["value"] as? String {
            let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, newValue as CFTypeRef)
            if result == .success {
                completion(WireFormat.success("value set"))
            } else {
                completion(WireFormat.error("failed to set value: \(result.rawValue)"))
            }
        } else {
            let val = getStringAttribute(element, kAXValueAttribute as CFString) ?? ""
            completion(WireFormat.success(val))
        }
    }

    private func handleAction(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let ref = action["ref"] as? String,
              let element = refRegistry.resolve(ref) else {
            completion(WireFormat.error("invalid ref"))
            return
        }

        let actionName = action["action"] as? String ?? "press"
        let axAction = "AX" + actionName.prefix(1).uppercased() + actionName.dropFirst()

        let result = AXUIElementPerformAction(element, axAction as CFString)
        if result == .success {
            completion(WireFormat.success("ok"))
        } else {
            // Auto-escalation: try CGEvent click using element frame
            if let frame = getFrame(element) {
                let centerX = frame.origin.x + frame.size.width / 2
                let centerY = frame.origin.y + frame.size.height / 2
                let point = CGPoint(x: centerX, y: centerY)

                guard let source = CGEventSource(stateID: .combinedSessionState) else {
                    completion(WireFormat.error("action failed (code \(result.rawValue)), CGEvent escalation also failed"))
                    return
                }

                let mouseDown = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
                let mouseUp = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
                mouseDown?.post(tap: .cghidEventTap)
                usleep(50_000)
                mouseUp?.post(tap: .cghidEventTap)

                completion(WireFormat.success("ok (escalated to CGEvent click at \(Int(centerX)),\(Int(centerY)))"))
            } else {
                completion(WireFormat.error("action failed: \(result.rawValue)"))
            }
        }
    }

    private func handleFocused(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let app = getTargetApp(action: action) else {
            completion(WireFormat.error("no target app found"))
            return
        }

        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp, kAXFocusedUIElementAttribute as CFString, &focused) == .success else {
            completion(WireFormat.error("no focused element"))
            return
        }

        let element = focused as! AXUIElement
        let ref = refRegistry.register(element)
        let role = getStringAttribute(element, kAXRoleAttribute as CFString) ?? "unknown"
        let title = getStringAttribute(element, kAXTitleAttribute as CFString) ?? ""
        let value = getStringAttribute(element, kAXValueAttribute as CFString)

        var result: [String: Any] = ["ref": ref, "role": role.replacingOccurrences(of: "AX", with: "").lowercased()]
        if !title.isEmpty { result["name"] = title }
        if let v = value { result["value"] = v }
        if let frame = getFrame(element) {
            result["frame"] = ["x": frame.origin.x, "y": frame.origin.y,
                              "width": frame.size.width, "height": frame.size.height]
        }

        completion(WireFormat.success(result))
    }

    private func handleWindows(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let app = getTargetApp(action: action) else {
            completion(WireFormat.error("no target app found"))
            return
        }

        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var windowsRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef) == .success,
              let windows = windowsRef as? [AXUIElement] else {
            completion(WireFormat.success([]))
            return
        }

        var result: [[String: Any]] = []
        for win in windows {
            let ref = refRegistry.register(win)
            let title = getStringAttribute(win, kAXTitleAttribute as CFString) ?? ""
            var entry: [String: Any] = ["ref": ref, "title": title]
            if let frame = getFrame(win) {
                entry["frame"] = ["x": frame.origin.x, "y": frame.origin.y,
                                 "width": frame.size.width, "height": frame.size.height]
            }
            result.append(entry)
        }

        completion(WireFormat.success(result))
    }

    private func handleResize(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let ref = action["ref"] as? String,
              let element = refRegistry.resolve(ref) else {
            completion(WireFormat.error("invalid ref"))
            return
        }
        guard let w = action["width"] as? Int, let h = action["height"] as? Int else {
            completion(WireFormat.error("resize requires width and height"))
            return
        }
        var size = CGSize(width: CGFloat(w), height: CGFloat(h))
        guard let axSize = AXValueCreate(.cgSize, &size) else {
            completion(WireFormat.error("failed to create AXValue for size"))
            return
        }
        let result = AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, axSize)
        if result == .success {
            completion(WireFormat.success(["width": w, "height": h]))
        } else {
            completion(WireFormat.error("resize failed: \(result.rawValue)"))
        }
    }

    private func handleMove(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let ref = action["ref"] as? String,
              let element = refRegistry.resolve(ref) else {
            completion(WireFormat.error("invalid ref"))
            return
        }
        guard let x = action["x"] as? Int, let y = action["y"] as? Int else {
            completion(WireFormat.error("move requires x and y"))
            return
        }
        var point = CGPoint(x: CGFloat(x), y: CGFloat(y))
        guard let axPoint = AXValueCreate(.cgPoint, &point) else {
            completion(WireFormat.error("failed to create AXValue for point"))
            return
        }
        let result = AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, axPoint)
        if result == .success {
            completion(WireFormat.success(["x": x, "y": y]))
        } else {
            completion(WireFormat.error("move failed: \(result.rawValue)"))
        }
    }

    private func ensureObserver(pid: pid_t) {
        guard pid != observedPID else { return }

        // Clean up old observer
        if let old = observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(old), .defaultMode)
            observer = nil
        }

        var newObserver: AXObserver?
        let callback: AXObserverCallback = { _, element, notification, refcon in
            let domain = Unmanaged<AccessibilityDomain>.fromOpaque(refcon!).takeUnretainedValue()
            domain.refRegistry.clear()
            Platform.emitEvent("ax_notification", data: ["notification": notification as String])
        }

        guard AXObserverCreate(pid, callback, &newObserver) == .success, let obs = newObserver else {
            return
        }

        let axApp = AXUIElementCreateApplication(pid)
        let notifications: [String] = [
            kAXFocusedUIElementChangedNotification as String,
            kAXValueChangedNotification as String,
            kAXUIElementDestroyedNotification as String,
            kAXWindowCreatedNotification as String,
            kAXWindowMovedNotification as String,
            kAXWindowResizedNotification as String,
            kAXSelectedTextChangedNotification as String
        ]

        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for note in notifications {
            AXObserverAddNotification(obs, axApp, note as CFString, refcon)
        }

        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        observer = obs
        observedPID = pid
    }
}
