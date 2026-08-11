import Foundation
import ApplicationServices
import AppKit

final class AccessibilityDomain: DomainHandler, @unchecked Sendable {
    let refRegistry = RefRegistry.shared
    // every AX C call in this domain now routes through the
    // injectable transport, and every value decodes through AXValueCodec — no
    // force casts on unverified AX values. Public command behavior is unchanged.
    private let transport: any AXTransport
    private var observer: AXObserver?
    private var observedPID: pid_t = 0

    init(transport: any AXTransport = LiveAXTransport()) {
        self.transport = transport
    }

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
        return FrontmostResolver.frontmostApplication(transport: transport)
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
        let axApp = transport.createApplication(pid: pid)
        let depth = action["depth"] as? Int ?? 10
        let filter = action["filter"] as? String ?? "interactive"
        let maxChars = action["maxChars"] as? Int ?? 50000
        // bound the traversal so a huge/slow tree returns a partial
        // result instead of hanging until the CLI's 15s timeout. Overridable via
        // --max-nodes / --max-ms; clamped to the safety hard caps.
        let budget = AXBudget(
            maxMs: AXBudget.clamp(action["maxMs"] as? Int, def: AXBudget.defaultMaxMs, hard: AXBudget.hardMaxMs),
            maxNodes: AXBudget.clamp(action["maxNodes"] as? Int, def: AXBudget.defaultMaxNodes, hard: AXBudget.hardMaxNodes),
            maxCalls: AXBudget.defaultMaxCalls
        )
        _ = transport.setMessagingTimeout(axApp, seconds: AXBudget.scanMessagingTimeoutSeconds)

        // wake up the AX tree for Electron / Chromium apps.
        // Electron and Chromium-based apps (Slack, Discord, Signal, VS Code,
        // Cursor, Brave, Chrome, Notion) build their AX tree lazily — only when
        // an assistive client signals interest. Setting AXManualAccessibility
        // and AXEnhancedUserInterface to true on the app element triggers the
        // tree generation. Without this, `mac_tree --app Signal` returns empty
        // when Signal is in the background.
        // Refs: AXUIElement.h, Apple a11y guides, Chromium a11y_extension.cc.
        wakeAXTree(app: axApp)

        refRegistry.clear()

        var output = ""
        buildTree(element: axApp, pid: pid, depth: 0, maxDepth: depth, filter: filter, output: &output, maxChars: maxChars, budget: budget)
        if !budget.stopMarker.isEmpty { output += budget.stopMarker + "\n" }

        completion(WireFormat.success(output))
    }

    /// signal AX interest to Electron/Chromium apps so they expose
    /// their full AX tree. Idempotent — safe to call repeatedly.
    ///
    /// Only sets AXManualAccessibility (the Chromium-specific signal that
    /// triggers BrowserAccessibilityManager to build its tree). We do NOT
    /// set AXEnhancedUserInterface — that's the AppKit "screen reader is
    /// active" flag, which many AppKit apps respond to by raising their
    /// main window to the foreground. The bridge is background-first by
    /// contract; setting AXEnhancedUserInterface contradicted that contract
    /// and was the reason `interceptor macos open <app>` was still
    /// foregrounding AppKit apps even after the CompoundDomain activation
    /// removal. AppKit apps don't need either flag — their AX tree is
    /// always populated. Chromium needs only AXManualAccessibility.
    func wakeAXTree(app: AXUIElement) {
        _ = transport.setAttributeValue(app, "AXManualAccessibility", kCFBooleanTrue)
        // Tiny grace so Chromium's BrowserAccessibilityManager has a chance
        // to assemble the tree before we walk it. ~30 ms is enough on M-series
        // for typical Electron renderers.
        usleep(30_000)
    }

    // internal (not private) so the budget-bounded traversal is unit-testable
    // with a FakeAXTransport, without depending on a live NSRunningApplication.
    func buildTree(element: AXUIElement, pid: pid_t, depth: Int, maxDepth: Int, filter: String, output: inout String, maxChars: Int, budget: AXBudget) {
        guard depth < maxDepth, output.count < maxChars, !budget.shouldStop() else { return }
        budget.countNode()
        budget.countCalls(5)   // 4 attribute reads + 1 children read below

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
            let ref = refRegistry.register(element, pid: pid)
            let indent = String(repeating: "  ", count: depth)
            let displayRole = role.replacingOccurrences(of: "AX", with: "").lowercased()
            var line = "\(indent)[\(ref)] \(displayRole)"
            if !label.isEmpty { line += " \"\(label)\"" }
            if let v = value, !v.isEmpty, v != label { line += " value=\"\(v)\"" }
            output += line + "\n"
        }

        let (childResult, children) = transport.copyAttributeValue(element, kAXChildrenAttribute as String)
        guard childResult == .success, let childArray = children as? [AXUIElement] else { return }

        for child in childArray {
            buildTree(element: child, pid: pid, depth: depth + 1, maxDepth: maxDepth, filter: filter, output: &output, maxChars: maxChars, budget: budget)
        }
    }

    private func getStringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
        let (result, value) = transport.copyAttributeValue(element, attribute as String)
        guard result == .success else { return nil }
        return AXValueCodec.displayString(value)
    }

    private func getFrame(_ element: AXUIElement) -> CGRect? {
        let (posResult, posValue) = transport.copyAttributeValue(element, kAXPositionAttribute as String)
        let (sizeResult, sizeValue) = transport.copyAttributeValue(element, kAXSizeAttribute as String)
        guard posResult == .success, sizeResult == .success,
              let point = AXValueCodec.point(from: posValue),
              let size = AXValueCodec.size(from: sizeValue) else {
            return nil
        }
        return CGRect(origin: point, size: size)
    }

    private func searchRootElement(for app: AXUIElement) -> AXUIElement? {
        let (focusedResult, focusedWindow) = transport.copyAttributeValue(app, kAXFocusedWindowAttribute as String)
        if focusedResult == .success, let window = AXValueCodec.asElement(focusedWindow) {
            return window
        }

        let (mainResult, mainWindow) = transport.copyAttributeValue(app, kAXMainWindowAttribute as String)
        if mainResult == .success, let window = AXValueCodec.asElement(mainWindow) {
            return window
        }

        return nil
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
        let axApp = transport.createApplication(pid: pid)
        let roleFilter = action["role"] as? String
        let budget = AXBudget(
            maxMs: AXBudget.clamp(action["maxMs"] as? Int, def: AXBudget.defaultMaxMs, hard: AXBudget.hardMaxMs),
            maxNodes: AXBudget.clamp(action["maxNodes"] as? Int, def: AXBudget.defaultMaxNodes, hard: AXBudget.hardMaxNodes),
            maxCalls: AXBudget.defaultMaxCalls
        )
        _ = transport.setMessagingTimeout(axApp, seconds: AXBudget.scanMessagingTimeoutSeconds)

        wakeAXTree(app: axApp)
        refRegistry.clear()
        let searchRoot = searchRootElement(for: axApp) ?? axApp

        var matches: [[String: Any]] = []
        findElements(element: searchRoot, pid: pid, query: query.lowercased(), roleFilter: roleFilter?.lowercased(), depth: 0, maxDepth: 15, maxMatches: 25, matches: &matches, budget: budget)

        completion(WireFormat.success(matches))
    }

    private func findElements(element: AXUIElement, pid: pid_t, query: String, roleFilter: String?, depth: Int, maxDepth: Int, maxMatches: Int, matches: inout [[String: Any]], budget: AXBudget) {
        guard depth < maxDepth, matches.count < maxMatches, !budget.shouldStop() else { return }
        budget.countNode()
        budget.countCalls(6)   // 6 attribute reads per node

        let role = getStringAttribute(element, kAXRoleAttribute as CFString) ?? ""
        let identifier = getStringAttribute(element, kAXIdentifierAttribute as CFString) ?? ""
        let roleDescription = getStringAttribute(element, kAXRoleDescriptionAttribute as CFString) ?? ""
        let title = getStringAttribute(element, kAXTitleAttribute as CFString) ?? ""
        let desc = getStringAttribute(element, kAXDescriptionAttribute as CFString) ?? ""
        let value = getStringAttribute(element, kAXValueAttribute as CFString) ?? ""

        let displayRole = role.replacingOccurrences(of: "AX", with: "").lowercased()
        let searchable = Self.buildSearchableText(
            title: title,
            description: desc,
            value: value,
            identifier: identifier,
            roleDescription: roleDescription,
            displayRole: displayRole
        )

        if searchable.contains(query) {
            if roleFilter == nil || displayRole.contains(roleFilter!) {
                let ref = refRegistry.register(element, pid: pid)
                var match: [String: Any] = [
                    "ref": ref,
                    "role": displayRole,
                    "name": title.isEmpty ? desc : title
                ]
                if !value.isEmpty { match["value"] = value }
                if !identifier.isEmpty { match["identifier"] = identifier }
                if let frame = getFrame(element) {
                    match["frame"] = ["x": frame.origin.x, "y": frame.origin.y,
                                     "width": frame.size.width, "height": frame.size.height]
                }
                matches.append(match)
            }
        }

        let (childResult, children) = transport.copyAttributeValue(element, kAXChildrenAttribute as String)
        guard childResult == .success, let childArray = children as? [AXUIElement] else { return }
        for child in childArray {
            findElements(element: child, pid: pid, query: query, roleFilter: roleFilter, depth: depth + 1, maxDepth: maxDepth, maxMatches: maxMatches, matches: &matches, budget: budget)
        }
    }

    private func handleInspect(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let ref = action["ref"] as? String,
              let element = refRegistry.resolve(ref) else {
            completion(WireFormat.error("invalid ref"))
            return
        }

        let (namesResult, namesOpt) = transport.copyAttributeNames(element)
        guard namesResult == .success, let names = namesOpt else {
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

        let (actionsResult, actionsOpt) = transport.copyActionNames(element)
        if actionsResult == .success, let actions = actionsOpt {
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
            let result = transport.setAttributeValue(element, kAXValueAttribute as String, newValue as CFTypeRef)
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

        let result = transport.performAction(element, axAction)
        if result == .success {
            completion(WireFormat.success("ok"))
        } else {
            // Auto-escalation: try CGEvent click using element frame.
            // NOTE (future work): this global-click fallback is slated for removal
            // in favor of PID-routed InputDomain delegation; G0 preserves it.
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

        let axApp = transport.createApplication(pid: app.processIdentifier)
        wakeAXTree(app: axApp)
        let (focusedResult, focused) = transport.copyAttributeValue(axApp, kAXFocusedUIElementAttribute as String)
        guard focusedResult == .success, let element = AXValueCodec.asElement(focused) else {
            completion(WireFormat.error("no focused element"))
            return
        }

        let ref = refRegistry.register(element, pid: app.processIdentifier)
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

        let axApp = transport.createApplication(pid: app.processIdentifier)
        wakeAXTree(app: axApp)
        let (windowsResult, windowsRef) = transport.copyAttributeValue(axApp, kAXWindowsAttribute as String)
        guard windowsResult == .success, let windows = windowsRef as? [AXUIElement] else {
            completion(WireFormat.success([]))
            return
        }

        var result: [[String: Any]] = []
        for win in windows {
            let ref = refRegistry.register(win, pid: app.processIdentifier)
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

    // PRD-62: ground-truth geometry — handleResize and handleMove now read
    // post-set kAXSize / kAXPosition back via getFrame() instead of echoing
    // the input dict, expose NSScreen.visibleFrame as `clampedTo` whenever
    // the system clamped the request, and run a single internal retry to
    // absorb single-shot drift caused by non-atomic AX position+size sets.

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

        // Spec 3: pre-flight settability per AXUIElementIsAttributeSettable.
        if let unsettable = settabilityError(element: element, attribute: kAXSizeAttribute as CFString, verb: "resize") {
            completion(unsettable)
            return
        }

        let target = CGSize(width: CGFloat(w), height: CGFloat(h))
        if let setError = setSize(element, target) {
            completion(WireFormat.error("resize failed: \(setError.rawValue)"))
            return
        }

        // Spec 2: verify, and if drifted within visibleFrame, retry exactly once.
        var frame = getFrame(element)
        if let f = frame, !Self.sizeMatches(f.size, target) {
            if let visible = visibleFrameRectForElement(element),
               target.width <= visible.width && target.height <= visible.height {
                _ = setSize(element, target)
                frame = getFrame(element)
            }
        }

        guard let finalFrame = frame else {
            completion(WireFormat.error("resize set succeeded but post-set frame read failed"))
            return
        }
        let response = Self.buildGeometryResponse(
            frame: finalFrame,
            requested: ["width": w, "height": h],
            targetSize: target,
            targetOrigin: nil,
            visibleFrame: visibleFrameRectForElement(element)
        )
        completion(WireFormat.success(response))
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

        if let unsettable = settabilityError(element: element, attribute: kAXPositionAttribute as CFString, verb: "move") {
            completion(unsettable)
            return
        }

        let target = CGPoint(x: CGFloat(x), y: CGFloat(y))
        if let setError = setPosition(element, target) {
            completion(WireFormat.error("move failed: \(setError.rawValue)"))
            return
        }

        var frame = getFrame(element)
        if let f = frame, !Self.originMatches(f.origin, target) {
            if let visible = visibleFrameRectForElement(element),
               let currentSize = frame?.size,
               target.x >= visible.minX,
               target.y >= visible.minY,
               target.x + currentSize.width <= visible.maxX,
               target.y + currentSize.height <= visible.maxY {
                _ = setPosition(element, target)
                frame = getFrame(element)
            }
        }

        guard let finalFrame = frame else {
            completion(WireFormat.error("move set succeeded but post-set frame read failed"))
            return
        }
        let response = Self.buildGeometryResponse(
            frame: finalFrame,
            requested: ["x": x, "y": y],
            targetSize: nil,
            targetOrigin: target,
            visibleFrame: visibleFrameRectForElement(element)
        )
        completion(WireFormat.success(response))
    }

    // MARK: - PRD-62 geometry helpers

    private func setSize(_ element: AXUIElement, _ size: CGSize) -> AXError? {
        var s = size
        guard let axSize = AXValueCreate(.cgSize, &s) else { return .failure }
        let result = transport.setAttributeValue(element, kAXSizeAttribute as String, axSize)
        return result == .success ? nil : result
    }

    private func setPosition(_ element: AXUIElement, _ point: CGPoint) -> AXError? {
        var p = point
        guard let axPoint = AXValueCreate(.cgPoint, &p) else { return .failure }
        let result = transport.setAttributeValue(element, kAXPositionAttribute as String, axPoint)
        return result == .success ? nil : result
    }

    private func settabilityError(element: AXUIElement, attribute: CFString, verb: String) -> [String: Any]? {
        let (probe, settable) = transport.isAttributeSettable(element, attribute as String)
        if probe != .success {
            // If the probe itself fails (e.g. .cannotComplete), surface that —
            // but don't block the verb on it; some apps refuse the probe yet
            // honor the set. Fall through.
            return nil
        }
        if settable == false {
            return WireFormat.error("\(verb) failed: attribute not settable on this element (use a top-level window ref)")
        }
        return nil
    }

    /// PRD-62 Spec 1: 1px tolerance absorbs AX's CGFloat round-trip noise.
    static func sizeMatches(_ a: CGSize, _ b: CGSize) -> Bool {
        return abs(a.width - b.width) < 1.0 && abs(a.height - b.height) < 1.0
    }

    static func originMatches(_ a: CGPoint, _ b: CGPoint) -> Bool {
        return abs(a.x - b.x) < 1.0 && abs(a.y - b.y) < 1.0
    }

    static func frameToDict(_ frame: CGRect) -> [String: Any] {
        return [
            "x": frame.origin.x,
            "y": frame.origin.y,
            "width": frame.size.width,
            "height": frame.size.height
        ]
    }

    /// Convert an NSScreen rect (bottom-left origin) into AX coords (top-left origin)
    /// using the primary screen's full-frame height as the global Y reference.
    /// Apple docs: kAXPositionAttribute → top-left global; NSScreen.frame/visibleFrame → bottom-left.
    static func axRectFromNSScreenRect(_ vf: CGRect, primaryHeight: CGFloat) -> CGRect {
        let axY = primaryHeight - (vf.origin.y + vf.height)
        return CGRect(x: vf.origin.x, y: axY, width: vf.width, height: vf.height)
    }

    /// Build the PRD-62 response shape from observed frame + intent.
    /// Pure logic so tests can exercise the clamp classification without AX.
    static func buildGeometryResponse(
        frame: CGRect,
        requested: [String: Any],
        targetSize: CGSize?,
        targetOrigin: CGPoint?,
        visibleFrame: CGRect?
    ) -> [String: Any] {
        var clamped = false
        if let s = targetSize, !sizeMatches(frame.size, s) { clamped = true }
        if let o = targetOrigin, !originMatches(frame.origin, o) { clamped = true }
        var response: [String: Any] = [
            "frame": frameToDict(frame),
            "requested": requested,
            "clamped": clamped
        ]
        if clamped, let vf = visibleFrame {
            response["clampedTo"] = frameToDict(vf)
        }
        return response
    }

    /// Returns the NSScreen.visibleFrame of the screen the element's window is
    /// currently on, converted to AX top-left coordinates. Per Apple:
    ///   - kAXPositionAttribute: top-left global, (0,0) at top-left of menu-bar screen.
    ///   - NSScreen.visibleFrame: bottom-left, excludes dock + menu bar.
    /// We map by the window's center to handle non-rectangular multi-display layouts.
    private func visibleFrameRectForElement(_ element: AXUIElement) -> CGRect? {
        guard let frame = getFrame(element) else { return nil }
        let screens = NSScreen.screens
        guard let primary = screens.first else { return nil }
        let primaryHeight = primary.frame.height

        // AX center → NSScreen coord (Y-flip against primary screen height).
        let axCenter = CGPoint(x: frame.midX, y: frame.midY)
        let nsCenter = CGPoint(x: axCenter.x, y: primaryHeight - axCenter.y)

        let owning = screens.first(where: { $0.frame.contains(nsCenter) }) ?? NSScreen.main ?? primary
        return Self.axRectFromNSScreenRect(owning.visibleFrame, primaryHeight: primaryHeight)
    }

    private func ensureObserver(pid: pid_t) {
        guard pid != observedPID else { return }

        // Clean up old observer
        if let old = observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), transport.observerGetRunLoopSource(old), .defaultMode)
            observer = nil
        }

        let callback: AXObserverCallback = { _, element, notification, refcon in
            let domain = Unmanaged<AccessibilityDomain>.fromOpaque(refcon!).takeUnretainedValue()
            domain.refRegistry.clear()
            Platform.emitEvent("ax_notification", data: ["notification": notification as String])
        }

        let (createResult, newObserver) = transport.observerCreate(pid: pid, callback: callback)
        guard createResult == .success, let obs = newObserver else {
            return
        }

        let axApp = transport.createApplication(pid: pid)
        let notifications: [String] = [
            kAXUIElementDestroyedNotification as String,
            kAXWindowCreatedNotification as String,
            kAXWindowMovedNotification as String,
            kAXWindowResizedNotification as String
        ]

        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for note in notifications {
            _ = transport.observerAddNotification(obs, axApp, note, refcon)
        }

        CFRunLoopAddSource(CFRunLoopGetMain(), transport.observerGetRunLoopSource(obs), .defaultMode)
        observer = obs
        observedPID = pid
    }

    static func buildSearchableText(title: String, description: String, value: String, identifier: String, roleDescription: String, displayRole: String) -> String {
        "\(title) \(description) \(value) \(identifier) \(roleDescription) \(displayRole)".lowercased()
    }
}
