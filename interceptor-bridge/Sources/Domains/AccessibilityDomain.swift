import Foundation
import ApplicationServices
import AppKit

/// AXEnabled is false on a disabled control; a missing attribute counts as enabled.
func axElementDisabled(_ element: AXUIElement, transport: any AXTransport = LiveAXTransport()) -> Bool {
    let (result, value) = transport.copyAttributeValue(element, kAXEnabledAttribute as String)
    return result == .success && (value as? Bool) == false
}

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
        if let type = action["type"] as? String, ["desktop_move", "desktop_resize", "desktop_value", "desktop_action", "desktop_inspect"].contains(type) {
            guard let ref = action["ref"] as? String, let element = refRegistry.resolve(ref),
                  let owner = transport.pid(element).1, owner > 0,
                  InputTargetSelector.defaultPidIsLive(owner) else {
                completion(["success": false, "code": "stale_reference", "error": "read the target again for a fresh reference"])
                return
            }
            if let expected = refRegistry.resolvePID(ref), expected != owner {
                completion(["success": false, "code": "stale_reference", "error": "reference process identity changed"])
                return
            }
            if let requested = action["pid"] as? Int, requested != Int(owner) {
                completion(["success": false, "code": "unsupported_target", "error": "reference belongs to a different target process"])
                return
            }
            if let requested = action["app"] as? String {
                let matches = NSWorkspace.shared.runningApplications.filter { DefaultAppLauncher.matches($0, requested) }
                guard matches.count == 1, matches[0].processIdentifier == owner else {
                    completion(["success": false, "code": matches.count > 1 ? "target_ambiguous" : "unsupported_target", "error": "reference does not uniquely match the requested application"])
                    return
                }
            }
            if let requested = action["window"] as? Int, BackgroundInput.windowID(owning: element, transport: transport).map(Int.init) != requested {
                completion(["success": false, "code": "unsupported_target", "error": "reference belongs to a different target window"])
                return
            }
            if ["desktop_move", "desktop_resize"].contains(type) {
                guard let app = NSRunningApplication(processIdentifier: owner), !app.isTerminated else {
                    completion(["success": false, "code": "stale_reference", "error": "read the target again for a fresh reference"])
                    return
                }
                let (minimizedError, minimizedValue) = transport.copyAttributeValue(element, kAXMinimizedAttribute as String)
                let minimized = AXValueCodec.tag(minimizedValue)
                if getStringAttribute(element, kAXRoleAttribute as CFString) != "AXWindow" ||
                    minimizedError != .success || minimized["kind"] as? String != "boolean" || minimized["value"] as? Bool != false {
                    completion(["success": false, "code": "unsupported_target", "error": "geometry requires a restored top-level window ref"])
                    return
                }
            }
        }
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
            // Case-insensitive, .app-name and bundle-id tolerant (RunningApps);
            // the exact compare made `--app finder` fail while `type --app finder`
            // worked through the input selector's lowercased lookup.
            return RunningApps.resolve(name)
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

        var root = axApp
        if let requested = action["window"] as? Int {
            budget.countCalls(1)
            let (error, value) = transport.copyAttributeValue(axApp, kAXWindowsAttribute as String)
            guard error == .success, let windows = value as? [AXUIElement] else {
                completion(AXTypedError.errorDict("the requested window inventory is unavailable", code: "unsupported_target", axError: error)); return
            }
            var selected: AXUIElement?
            for window in windows {
                guard !budget.shouldStop() else {
                    completion(AXTypedError.errorDict("window selection exceeded the tree read budget", code: "resource_limit")); return
                }
                budget.countCalls(2)
                _ = transport.setMessagingTimeout(window, seconds: AXBudget.scanMessagingTimeoutSeconds)
                if cgsWindowID(of: window).map(Int.init) == requested {
                    guard selected == nil else {
                        completion(AXTypedError.errorDict("more than one accessibility window matches the requested window", code: "target_ambiguous")); return
                    }
                    selected = window
                }
            }
            guard let selected else {
                completion(AXTypedError.errorDict("the requested window does not belong to the target app", code: "unsupported_target")); return
            }
            root = selected
        }

        var output = ""
        buildTree(element: root, pid: pid, depth: 0, maxDepth: depth, filter: filter, output: &output, maxChars: maxChars, budget: budget)
        if !budget.stopMarker.isEmpty { output += budget.stopMarker + "\n" }

        // Remember this read so `macos act` can say what changed.
        // The diff is computed here, as the stored tree is replaced: act reads
        // its post-action tree through this same handler.
        let memoryKey = "\(pid)|\(filter)|\(depth)|\(action["window"] as? Int ?? 0)"
        let previous = AXTreeMemory.shared.swap(key: memoryKey, tree: output)
        var result = WireFormat.success(output)
        if action["diff"] as? Bool == true {
            result["changes"] = previous.map { AXTreeMemory.diff(old: $0, new: AXTreeMemory.lines(output)) } ?? NSNull()
        }
        completion(result)
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
        let accepted = transport.setAttributeValue(app, "AXManualAccessibility", kCFBooleanTrue) == .success
        // Tiny grace so Chromium's BrowserAccessibilityManager has a chance
        // to assemble the tree before we walk it. ~30 ms is enough on M-series
        // for typical Electron renderers. Only the first wake of an app that
        // took the flag needs it: AppKit apps refuse the attribute, and a
        // woken Chromium tree stays built (it used to cost 30 ms
        // on every tree, find, focused and windows call).
        guard accepted else { return }
        let (pidResult, pid) = transport.pid(app)
        let key = pidResult == .success ? pid ?? -1 : -1
        if key != -1, !Self.wokenPids.insert(key) { return }
        usleep(30_000)
    }

    /// pids whose AX tree was already woken (first-wake sleep only).
    static let wokenPids = WokenPidSet()

    /// The attributes one tree line needs, read in a single AX message.
    static let treeAttributes: [String] = [
        kAXRoleAttribute as String, kAXSubroleAttribute as String, kAXTitleAttribute as String,
        kAXValueAttribute as String, kAXDescriptionAttribute as String, kAXChildrenAttribute as String,
    ]

    /// One batched read of role, subrole, title, value, description and
    /// children. Secure classification uses the batched role and subrole, so a
    /// secure value never leaves this function. Nil when the batch call fails;
    /// the caller then falls back to single reads.
    func readTreeNode(_ element: AXUIElement) -> (role: String, title: String?, value: String?, desc: String?, children: [AXUIElement]?)? {
        let (err, values) = transport.copyMultipleAttributeValues(element, Self.treeAttributes, stopOnError: false)
        guard err == .success, let v = values, v.count == Self.treeAttributes.count else { return nil }
        let role = AXValueCodec.displayString(v[0]) ?? "unknown"
        let subrole = AXValueCodec.displayString(v[1])
        let secure = AXSecureRedaction.isSecure(role: role, subrole: subrole)
        let value = secure ? AXSecureRedaction.placeholder : AXValueCodec.displayString(v[3])
        return (role, AXValueCodec.displayString(v[2]), value, AXValueCodec.displayString(v[4]), v[5] as? [AXUIElement])
    }

    // internal (not private) so the budget-bounded traversal is unit-testable
    // with a FakeAXTransport, without depending on a live NSRunningApplication.
    func buildTree(element: AXUIElement, pid: pid_t, depth: Int, maxDepth: Int, filter: String, output: inout String, maxChars: Int, budget: AXBudget) {
        guard depth < maxDepth, output.count < maxChars, !budget.shouldStop() else { return }
        budget.countNode()

        let role: String, title: String?, value: String?, desc: String?
        var batchedChildren: [AXUIElement]?? = nil
        if let node = readTreeNode(element) {
            budget.countCalls(1)   // one AXUIElementCopyMultipleAttributeValues
            (role, title, value, desc) = (node.role, node.title, node.value, node.desc)
            batchedChildren = .some(node.children)
        } else {
            budget.countCalls(7)   // 4 attributes, 2 secure-classification reads, 1 children read
            role = getStringAttribute(element, kAXRoleAttribute as CFString) ?? "unknown"
            title = getStringAttribute(element, kAXTitleAttribute as CFString)
            value = getStringAttribute(element, kAXValueAttribute as CFString)
            desc = getStringAttribute(element, kAXDescriptionAttribute as CFString)
        }
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

        let childArray: [AXUIElement]
        if case .some(let batched) = batchedChildren {
            guard let kids = batched else { return }
            childArray = kids
        } else {
            let (childResult, children) = transport.copyAttributeValue(element, kAXChildrenAttribute as String)
            guard childResult == .success, let kids = children as? [AXUIElement] else { return }
            childArray = kids
        }

        for child in childArray {
            buildTree(element: child, pid: pid, depth: depth + 1, maxDepth: maxDepth, filter: filter, output: &output, maxChars: maxChars, budget: budget)
        }
    }

    private func getStringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
        let name = attribute as String
        if (name == kAXValueAttribute as String || name == kAXSelectedTextAttribute as String),
           AXSecureRedaction.isSecureElement(element, transport: transport) {
            return AXSecureRedaction.placeholder
        }
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
        let searchRoot = searchRootElement(for: axApp) ?? axApp

        var matches: [[String: Any]] = []
        findElements(element: searchRoot, pid: pid, query: query.lowercased(), roleFilter: roleFilter?.lowercased(), depth: 0, maxDepth: 15, maxMatches: 25, matches: &matches, budget: budget)

        completion(WireFormat.success(matches))
    }

    private func findElements(element: AXUIElement, pid: pid_t, query: String, roleFilter: String?, depth: Int, maxDepth: Int, maxMatches: Int, matches: inout [[String: Any]], budget: AXBudget) {
        guard depth < maxDepth, matches.count < maxMatches, !budget.shouldStop() else { return }
        budget.countNode()
        budget.countCalls(9)   // 6 attributes, 2 secure-classification reads, 1 children read

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
            // Windows and Linux refuse writes to disabled or read-only controls; AX would report success.
            if axElementDisabled(element, transport: transport) { completion(WireFormat.error("element is disabled; nothing was changed")); return }
            let (probe, settable) = transport.isAttributeSettable(element, kAXValueAttribute as String)
            if probe == .success && settable == false {
                // A checkbox, button or pop-up is not read-only, it has no text value.
                let (_, role) = transport.copyAttributeValue(element, kAXRoleAttribute as String)
                if !["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXStaticText"].contains(AXValueCodec.displayString(role) ?? "") {
                    completion(WireFormat.failure("unsupported_target", "this control has no text value; use action or act to press, toggle or select it; nothing was changed", details: ["dispatched": false])); return
                }
                completion(WireFormat.error("value is read-only; nothing was changed")); return
            }
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
        if axElementDisabled(element, transport: transport) { completion(WireFormat.error("element is disabled; no action was performed")); return }

        let result = transport.performAction(element, axAction)
        if result == .success {
            completion(WireFormat.success("ok"))
        } else {
            if action["type"] as? String == "desktop_action" {
                // A neutral reference action never falls through to a global
                // pointer event. Preserve the AX outcome for the neutral
                // normalizer, including uncertainty after cannotComplete.
                completion(AXTypedError.errorDict("accessibility action failed", code: AXTypedError.productCode(result) ?? "timeout_unknown_outcome", axError: result))
                return
            }
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
            // The id `--window` takes on the input verbs.
            if let windowId = cgsWindowID(of: win) { entry["windowId"] = Int(windowId) }
            if let frame = getFrame(win) {
                entry["frame"] = ["x": frame.origin.x, "y": frame.origin.y,
                                 "width": frame.size.width, "height": frame.size.height]
            }
            result.append(entry)
        }

        completion(WireFormat.success(result))
    }

    // Ground-truth geometry — handleResize and handleMove now read
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

        // Pre-flight settability per AXUIElementIsAttributeSettable.
        if let unsettable = settabilityError(element: element, attribute: kAXSizeAttribute as CFString, verb: "resize") {
            completion(unsettable)
            return
        }

        let target = CGSize(width: CGFloat(w), height: CGFloat(h))
        if let setError = setSize(element, target) {
            completion(WireFormat.error("resize failed: \(setError.rawValue)"))
            return
        }

        // Verify, and if drifted within visibleFrame, retry exactly once.
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

    // MARK: - Geometry helpers

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

    /// 1px tolerance absorbs AX's CGFloat round-trip noise.
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

    /// Build the geometry response shape from observed frame + intent.
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
            if (notification as String) == (kAXUIElementDestroyedNotification as String) { domain.refRegistry.remove(element) }
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


/// Thread-safe set of pids (the bridge serves requests on several queues).
final class WokenPidSet: @unchecked Sendable {
    private var pids = Set<pid_t>()
    private let lock = NSLock()
    /// True when the pid was not in the set yet.
    func insert(_ pid: pid_t) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return pids.insert(pid).inserted
    }
    func removeAll() { lock.lock(); pids.removeAll(); lock.unlock() }
}

/// The last tree read per app, pid, filter, depth and window, as ref → line
///. Refs are stable for the same element (RefRegistry uses
/// CFEqual), so two reads diff by ref like the browser's snapshot diff.
final class AXTreeMemory: @unchecked Sendable {
    static let shared = AXTreeMemory()
    private var trees: [String: [String: String]] = [:]
    private let lock = NSLock()

    /// Store the new tree and return the one it replaces.
    func swap(key: String, tree: String) -> [String: String]? {
        let lines = Self.lines(tree)
        lock.lock(); defer { lock.unlock() }
        let old = trees[key]
        trees[key] = lines
        if trees.count > 64 { trees.removeAll(keepingCapacity: true); trees[key] = lines }
        return old
    }

    static func lines(_ tree: String) -> [String: String] {
        var out: [String: String] = [:]
        for raw in tree.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("[e"), let close = line.firstIndex(of: "]") else { continue }
            out[String(line[line.index(after: line.startIndex)..<close])] = line
        }
        return out
    }

    /// added / removed / changed lines, ordered by ref number.
    static func diff(old: [String: String], new: [String: String]) -> [String: [String]] {
        func num(_ ref: String) -> Int { Int(ref.dropFirst()) ?? 0 }
        let added = new.keys.filter { old[$0] == nil }.sorted { num($0) < num($1) }.map { new[$0]! }
        let removed = old.keys.filter { new[$0] == nil }.sorted { num($0) < num($1) }.map { old[$0]! }
        let changed = new.keys.filter { old[$0] != nil && old[$0] != new[$0] }.sorted { num($0) < num($1) }.map { "\(old[$0]!) → \(new[$0]!)" }
        return ["added": added, "removed": removed, "changed": changed]
    }
}

/// Waits for an app to stop changing after an input, on its own AX
/// notifications: returns once nothing arrived for `quietMs`,
/// or at `capMs`. Nil when no observer could be set up (caller keeps the
/// old fixed wait). Polls off the main thread; callbacks arrive on the main
/// run loop.
final class AXSettle: @unchecked Sendable {
    static let notifications: [String] = [
        kAXValueChangedNotification as String, kAXFocusedUIElementChangedNotification as String,
        kAXLayoutChangedNotification as String, kAXTitleChangedNotification as String,
        kAXCreatedNotification as String, kAXUIElementDestroyedNotification as String,
        kAXMenuOpenedNotification as String, kAXSheetCreatedNotification as String,
        kAXSelectedChildrenChangedNotification as String, kAXWindowCreatedNotification as String,
    ]
    private let lock = NSLock()
    private var last = DispatchTime.now().uptimeNanoseconds
    private(set) var events = 0

    func bump() { lock.lock(); last = DispatchTime.now().uptimeNanoseconds; events += 1; lock.unlock() }
    func lastEvent() -> UInt64 { lock.lock(); defer { lock.unlock() }; return last }

    static func wait(pid: pid_t, transport: any AXTransport, quietMs: Int = 100, capMs: Int = 1000) -> (ms: Int, events: Int)? {
        let box = AXSettle()
        let callback: AXObserverCallback = { _, _, _, refcon in
            guard let refcon else { return }
            Unmanaged<AXSettle>.fromOpaque(refcon).takeUnretainedValue().bump()
        }
        let (created, observer) = transport.observerCreate(pid: pid, callback: callback)
        guard created == .success, let observer else { return nil }
        let app = transport.createApplication(pid: pid)
        let refcon = Unmanaged.passRetained(box).toOpaque()
        let added = notifications.filter { transport.observerAddNotification(observer, app, $0, refcon) == .success }
        guard !added.isEmpty else { Unmanaged<AXSettle>.fromOpaque(refcon).release(); return nil }
        let source = transport.observerGetRunLoopSource(observer)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
        let start = DispatchTime.now().uptimeNanoseconds
        while true {
            usleep(10_000)
            let now = DispatchTime.now().uptimeNanoseconds
            if now - start >= UInt64(capMs) * 1_000_000 { break }
            if now - box.lastEvent() >= UInt64(quietMs) * 1_000_000 { break }
        }
        for note in added { _ = transport.observerRemoveNotification(observer, app, note) }
        CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .defaultMode)
        let ms = Int((DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        let events = box.events
        Unmanaged<AXSettle>.fromOpaque(refcon).release()
        return (ms, events)
    }
}
