//
//  InterceptorRunnerUITests.swift — Interceptor's own on-device XCUITest runner
//. Replaces WebDriverAgent.
//
//  A single never-ending UI test keeps the XCUITest/testmanagerd session alive
//  (the same pattern WDA uses) while a WebSocket agent dials OUT to the
//  Interceptor daemon and answers verb frames by driving the foreground app via
//  *public* XCUITest APIs (XCUICoordinate, XCUIApplication, XCUIScreen,
//  XCUIElementSnapshot). No HTTP server, no CocoaHTTPServer, no usbmux forward.
//
//  Hardening:
//    - Quiescence wait is swizzled to a no-op, so AX ops don't block for tens of
//      seconds on apps that never settle (the WDA "shouldWaitForQuiescence" fix).
//    - Each verb runs inside ICRunCatching (Obj-C @try/@catch) so an XCUITest
//      NSException becomes an error frame instead of crashing the session.
//    - Verbs run on a dedicated serial queue; the WS receive loop is never
//      blocked, so the socket stays alive through a slow op.
//
//  Connection params arrive via the test process environment (injected into the
//  .xctestrun by the daemon at launch): INTERCEPTOR_WS_URL / _WS_TOKEN / _UDID /
//  _CONTEXT_ID.
//
//  Wire protocol (daemon → runner): { id, op, ...args }
//                  (runner → daemon): { id, result: { success, data?, error? } }
//  Registration   (runner → daemon): { type:"ios", udid, token, contextId }
//

import XCTest
import Foundation
import ObjectiveC.runtime
import JavaScriptCore  // Lane D: on-device JSCore scripting brain

final class InterceptorRunnerUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
        disableQuiescenceWait()
    }

    /// Never-ending test that hosts the WebSocket agent (mirrors WDA's testRunner).
    func testRunner() {
        let env = ProcessInfo.processInfo.environment
        guard let urlStr = env["INTERCEPTOR_WS_URL"], let url = URL(string: urlStr) else {
            XCTFail(
                "INTERCEPTOR_WS_URL is not set in the test environment",
                file: "InterceptorRunnerUITests.swift",
                line: #line
            )
            return
        }
        let agent = WSAgent(
            url: url,
            token: env["INTERCEPTOR_WS_TOKEN"] ?? "",
            udid: env["INTERCEPTOR_UDID"] ?? "",
            contextId: env["INTERCEPTOR_CONTEXT_ID"] ?? ""
        )
        agent.start()
        // Keep the MAIN RUN LOOP spinning (do NOT park the thread on a semaphore).
        // XCUITest's accessibility snapshot / app-attach dispatch work to the main
        // run loop and wait for it; a parked main thread deadlocks them (only
        // XCUIScreen/XCUIDevice ops, which don't need the run loop, would work).
        while !agent.finished {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
        }
    }
}

/// Neutralize XCUITest's "wait for the app to be idle" before every query/
/// interaction. On busy apps this otherwise blocks for tens of seconds (or
/// forever), stalling verbs. Private but allowed in a test bundle; safely no-ops
/// if the symbol isn't present on this Xcode.
private func disableQuiescenceWait() {
    guard let cls = NSClassFromString("XCUIApplicationProcess") else { return }
    let noop: @convention(block) (AnyObject, Double) -> Void = { _, _ in }
    let imp = imp_implementationWithBlock(noop)
    for name in ["waitForQuiescenceIncludingAnimationsIdle:", "_waitForQuiescenceIncludingAnimationsIdle:"] {
        let sel = NSSelectorFromString(name)
        if let method = class_getInstanceMethod(cls, sel) {
            method_setImplementation(method, imp)
        }
    }
}

// MARK: - WebSocket agent

final class WSAgent: NSObject, URLSessionWebSocketDelegate {
    private let url: URL
    private let token: String
    private let udid: String
    private let contextId: String
    /// Set when the socket is gone for good; the test's main run loop watches it.
    private(set) var finished = false

    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var reconnects = 0
    private let maxReconnects = 5

    init(url: URL, token: String, udid: String, contextId: String) {
        self.url = url
        self.token = token
        self.udid = udid
        self.contextId = contextId
        super.init()
        self.session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    func start() { connect() }

    private func connect() {
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        register()
        receive()
    }

    private func register() {
        send(["type": "ios", "udid": udid, "token": token, "contextId": contextId])
    }

    private func send(_ obj: [String: Any]) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: sanitize(obj)),
            let str = String(data: data, encoding: .utf8)
        else { return }
        task?.send(.string(str)) { _ in }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                self.reconnects = 0
                let text: String?
                switch message {
                case .string(let s): text = s
                case .data(let d): text = String(data: d, encoding: .utf8)
                @unknown default: text = nil
                }
                if let text = text {
                    // Verbs must run on the MAIN (test) thread: XCUITest's snapshot
                    // and element queries require the thread-local XCTContext, which
                    // exists only there ("Current context must not be nil" otherwise).
                    // XCTest spins its own nested run loop while it works, so a verb
                    // doesn't freeze the main loop. The receive loop stays on this
                    // background delegate queue, so the socket stays responsive.
                    DispatchQueue.main.async { self.handle(text) }
                }
                self.receive() // re-arm immediately
            case .failure:
                self.handleDisconnect()
            }
        }
    }

    private func handle(_ text: String) {
        guard
            let data = text.data(using: .utf8),
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let id = obj["id"] as? String,
            let op = obj["op"] as? String
        else { return }
        let result = Runner.run(op: op, args: obj)
        send(["id": id, "result": result])
    }

    private func handleDisconnect() {
        reconnects += 1
        if reconnects <= maxReconnects {
            DispatchQueue.global().asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.connect() }
        } else {
            finished = true
        }
    }

    /// JSONSerialization rejects non-finite numbers; coerce them defensively.
    private func sanitize(_ obj: Any) -> Any {
        if let d = obj as? [String: Any] { return d.mapValues { sanitize($0) } }
        if let a = obj as? [Any] { return a.map { sanitize($0) } }
        if let n = obj as? Double, !n.isFinite { return 0 }
        return obj
    }
}

// MARK: - Verb dispatch (public XCUITest APIs)

enum Runner {
    private static let springboard = "com.apple.springboard"
    private static var currentBundleId = springboard

    private static func app() -> XCUIApplication { XCUIApplication(bundleIdentifier: currentBundleId) }

    /// App to introspect: an explicitly-activated app wins; otherwise the live
    /// FOREGROUND app via the private accessibility client (so `tree`/`find` work
    /// without `app activate`). Falls back to SpringBoard.
    private static func foregroundApp() -> XCUIApplication {
        if currentBundleId != springboard { return XCUIApplication(bundleIdentifier: currentBundleId) }
        if let bid = ICActiveApplicationBundleID(), !bid.isEmpty {
            return XCUIApplication(bundleIdentifier: bid)
        }
        return XCUIApplication(bundleIdentifier: springboard)
    }

    /// Screen-absolute coordinate (normalized origin + point offset), like WDA's
    /// gestureCoordinateWithOffset. Based on the foreground/SpringBoard window,
    /// which spans the screen — so taps land regardless of the snapshot target.
    private static func coord(_ x: Double, _ y: Double) -> XCUICoordinate {
        app().coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            .withOffset(CGVector(dx: CGFloat(x), dy: CGFloat(y)))
    }

    /// Top-level entry: trap Obj-C exceptions and Swift throws into an error frame.
    static func run(op: String, args: [String: Any]) -> [String: Any] {
        var result: [String: Any] = err("no result produced")
        let nsErr = ICRunCatching {
            do { result = try execute(op: op, args: args) }
            catch { result = err("\(error)") }
        }
        if let nsErr = nsErr { return err(nsErr.localizedDescription) }
        return result
    }

    private static func execute(op: String, args: [String: Any]) throws -> [String: Any] {
        switch op {
        case "ping":
            return ok(["alive": true])
        case "source":
            return ok(try serialize(foregroundApp().snapshot()))
        case "windowSize":
            let f = foregroundApp().frame
            return ok(["width": Double(f.width), "height": Double(f.height)])
        case "fgdebug":
            return ok(["fg": ICActiveApplicationBundleID() ?? "nil", "debug": ICActiveApplicationDebug() ?? "nil"])
        case "screenshot":
            return ok(XCUIScreen.main.screenshot().pngRepresentation.base64EncodedString())
        case "tap":
            coord(dbl(args["x"]), dbl(args["y"])).tap()
            return ok(nil)
        case "drag":
            let from = coord(dbl(args["fromX"]), dbl(args["fromY"]))
            let to = coord(dbl(args["toX"]), dbl(args["toY"]))
            from.press(forDuration: dbl(args["duration"], 0.5), thenDragTo: to)
            return ok(nil)
        case "keys":
            return typeKeys(args["text"] as? String ?? "", bundleId: args["bundleId"] as? String)
        case "unlock":
            // issue #244: lock-screen passcode entry. `probe` stops before typing.
            return unlockDevice(passcode: args["passcode"] as? String ?? "", probe: args["probe"] as? Bool ?? false)
        case "press":
            return pressButton(args["name"] as? String ?? "")
        case "app":
            return appOp(action: args["action"] as? String ?? "", bundleId: args["bundleId"] as? String ?? "")
        case "eval":
            return jsEval(script: args["script"] as? String ?? "")
        default:
            return err("unknown op '\(op)'")
        }
    }

    /// Lane D — the on-device JSCore brain. Runs a pushed script inside a JSContext
    /// with an `Interceptor` global bridged to the native surface, so loops / waits /
    /// multi-step flows execute ON THE PHONE and only the result crosses the wire.
    ///
    private static func jsEval(script: String) -> [String: Any] {
        guard let ctx = JSContext() else { return err("JSContext unavailable") }
        if #available(iOS 16.4, *) { ctx.isInspectable = true }  // attachable by Lane B
        var logs: [String] = []
        ctx.exceptionHandler = { _, exc in logs.append("JS exception: \(exc?.toString() ?? "?")") }
        let bridge = JSValue(newObjectIn: ctx)!
        let logFn: @convention(block) (String) -> Void = { msg in logs.append(msg) }
        bridge.setObject(logFn, forKeyedSubscript: "log" as NSString)
        let treeFn: @convention(block) () -> Any = { (try? serialize(foregroundApp().snapshot())) ?? [:] }
        bridge.setObject(treeFn, forKeyedSubscript: "tree" as NSString)
        let tapFn: @convention(block) (Double, Double) -> Void = { x, y in coord(x, y).tap() }
        bridge.setObject(tapFn, forKeyedSubscript: "tap" as NSString)
        let typeFn: @convention(block) (String) -> Void = { t in app().typeText(t) }
        bridge.setObject(typeFn, forKeyedSubscript: "type" as NSString)
        let sleepFn: @convention(block) (Double) -> Void = { ms in Thread.sleep(forTimeInterval: ms / 1000.0) }
        bridge.setObject(sleepFn, forKeyedSubscript: "sleep" as NSString)
        let fgFn: @convention(block) () -> Any = { ICActiveApplicationBundleID() ?? "" }
        bridge.setObject(fgFn, forKeyedSubscript: "foreground" as NSString)
        ctx.setObject(bridge, forKeyedSubscript: "Interceptor" as NSString)
        let value = ctx.evaluateScript(script)
        return ok(["result": value?.toObject() ?? NSNull(), "logs": logs])
    }

    private static func pressButton(_ name: String) -> [String: Any] {
        switch name {
        case "home": XCUIDevice.shared.press(.home); return ok(nil)
        case "volumeUp", "volumeDown":
            #if targetEnvironment(simulator)
            return err("volume buttons are unavailable in the Simulator")
            #else
            XCUIDevice.shared.press(name == "volumeUp" ? .volumeUp : .volumeDown)
            return ok(nil)
            #endif
        case "lock":
            // iOS 27: pressLockButton no longer locks. Post the Power key
            // (consumer page 0x0C, usage 0x30, 0.5 s hold) like WebDriverAgent,
            // and fall back to the old selector when the private event API is
            // missing.
            if let hidError = ICPerformDeviceEvent(0x0C, 0x30, 0.5) {
                let sel = NSSelectorFromString("pressLockButton")
                if XCUIDevice.shared.responds(to: sel) {
                    _ = XCUIDevice.shared.perform(sel)
                    return ok(["via": "pressLockButton", "hidError": hidError.localizedDescription, "locked": waitForLockState(true, seconds: 4)])
                }
                return err("lock failed: \(hidError.localizedDescription)")
            }
            return ok(["via": "iohid", "locked": waitForLockState(true, seconds: 4)])
        default:
            return err("unknown button '\(name)' (home|lock|volumeUp|volumeDown)")
        }
    }

    // MARK: issue #244 — typing target fallback, lock state, lock-screen unlock

    /// Typing goes to the element with keyboard focus. A system passcode sheet
    /// (Face ID fallback, Settings) belongs to SpringBoard, so when the app
    /// refuses ("no keyboard focus") the same text is retried against SpringBoard.
    private static func typeKeys(_ text: String, bundleId: String?) -> [String: Any] {
        if let bid = bundleId, !bid.isEmpty {
            XCUIApplication(bundleIdentifier: bid).typeText(text)
            return ok(["via": bid])
        }
        if ICRunCatching({ app().typeText(text) }) == nil { return ok(nil) }
        if let e = ICRunCatching({ XCUIApplication(bundleIdentifier: springboard).typeText(text) }) {
            return err("typeText failed in the app and in SpringBoard: \(e.localizedDescription)")
        }
        return ok(["via": springboard])
    }

    private static func waitForLockState(_ locked: Bool, seconds: Double) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if ICIsScreenLocked() == locked { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return ICIsScreenLocked() == locked
    }

    /// Wake, swipe up to the passcode pad, type into SpringBoard's "Passcode
    /// field", and wait for lockstate 0. Only works while this runner is still
    /// resident (XCTest cannot start on a locked phone).
    private static func unlockDevice(passcode: String, probe: Bool) -> [String: Any] {
        let sb = XCUIApplication(bundleIdentifier: springboard)
        let lockedBefore = ICIsScreenLocked()
        if !lockedBefore {
            // Already unlocked: report without touching the device (a probe must not
            // press Home or swipe over whatever app is in front).
            if probe { return ok(["probe": true, "lockedBefore": false, "lockedNow": false, "passcodeField": false]) }
            return ok(["unlocked": true, "alreadyUnlocked": true])
        }
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 0.6)
        // Face ID may have unlocked on wake when the owner is looking.
        if !ICIsScreenLocked() && !probe { return ok(["unlocked": true, "via": "wake"]) }
        let from = sb.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.96))
        let to = sb.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        from.press(forDuration: 0.05, thenDragTo: to)
        let field = sb.secureTextFields["Passcode field"]
        let present = field.waitForExistence(timeout: 6)
        if probe {
            return ok(["probe": true, "lockedBefore": lockedBefore, "lockedNow": ICIsScreenLocked(), "passcodeField": present])
        }
        guard present else { return err("no passcode field appeared on the lock screen") }
        guard !passcode.isEmpty else { return err("unlock requires a passcode") }
        field.typeText(passcode)
        var unlocked = waitForLockState(false, seconds: 6)
        if !unlocked && field.exists {
            // Alphanumeric passcodes need Return; numeric ones submit on the last digit.
            field.typeText("\n")
            unlocked = waitForLockState(false, seconds: 6)
        }
        return ok(["unlocked": unlocked, "passcodeField": true, "via": "passcode"])
    }

    private static func appOp(action: String, bundleId: String) -> [String: Any] {
        guard !bundleId.isEmpty else { return err("app op requires a bundleId") }
        let a = XCUIApplication(bundleIdentifier: bundleId)
        switch action {
        case "launch": a.launch(); currentBundleId = bundleId; return ok(nil)
        case "activate": a.activate(); currentBundleId = bundleId; return ok(nil)
        case "terminate":
            a.terminate()
            if currentBundleId == bundleId { currentBundleId = springboard }
            return ok(nil)
        default:
            return err("unknown app action '\(action)' (launch|activate|terminate)")
        }
    }

    // MARK: snapshot → WdaSourceNode JSON (matches daemon/ios/tree.ts)

    private static func serialize(_ s: XCUIElementSnapshot) -> [String: Any] {
        let f = s.frame
        var node: [String: Any] = [
            "type": typeName(s.elementType),
            "label": s.label,
            "name": s.identifier,
            "rawIdentifier": s.identifier,
            "isEnabled": s.isEnabled,
            "isVisible": f.width > 0 && f.height > 0,
            "rect": [
                "x": Double(f.origin.x), "y": Double(f.origin.y),
                "width": Double(f.size.width), "height": Double(f.size.height),
            ],
        ]
        if let v = s.value { node["value"] = "\(v)" }
        let kids = s.children
        if !kids.isEmpty { node["children"] = kids.map { serialize($0) } }
        return node
    }

    // MARK: helpers

    private static func ok(_ data: Any?) -> [String: Any] {
        if let data = data { return ["success": true, "data": data] }
        return ["success": true]
    }
    private static func err(_ msg: String) -> [String: Any] { ["success": false, "error": msg] }

    private static func dbl(_ v: Any?, _ def: Double = 0) -> Double {
        if let n = v as? NSNumber { return n.doubleValue }
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        if let s = v as? String, let d = Double(s) { return d }
        return def
    }

    /// XCUIElement.ElementType raw value → "XCUIElementType<Name>" (daemon strips the prefix).
    private static func typeName(_ t: XCUIElement.ElementType) -> String {
        let names: [UInt: String] = [
            0: "Any", 1: "Other", 2: "Application", 3: "Group", 4: "Window", 5: "Sheet",
            6: "Drawer", 7: "Alert", 8: "Dialog", 9: "Button", 10: "RadioButton",
            11: "RadioGroup", 12: "CheckBox", 13: "DisclosureTriangle", 14: "PopUpButton",
            15: "ComboBox", 16: "MenuButton", 17: "ToolbarButton", 18: "Popover", 19: "Keyboard",
            20: "Key", 21: "NavigationBar", 22: "TabBar", 23: "TabGroup", 24: "Toolbar",
            25: "StatusBar", 26: "Table", 27: "TableRow", 28: "TableColumn", 29: "Outline",
            30: "OutlineRow", 31: "Browser", 32: "CollectionView", 33: "Slider", 34: "PageIndicator",
            35: "ProgressIndicator", 36: "ActivityIndicator", 37: "SegmentedControl", 38: "Picker",
            39: "PickerWheel", 40: "Switch", 41: "Toggle", 42: "Link", 43: "Image", 44: "Icon",
            45: "SearchField", 46: "ScrollView", 47: "ScrollBar", 48: "StaticText", 49: "TextField",
            50: "SecureTextField", 51: "DatePicker", 52: "TextView", 53: "Menu", 54: "MenuItem",
            55: "MenuBar", 56: "MenuBarItem", 57: "Map", 58: "WebView", 59: "IncrementArrow",
            60: "DecrementArrow", 61: "Timeline", 62: "RatingIndicator", 63: "ValueIndicator",
            64: "SplitGroup", 65: "Splitter", 66: "RelevanceIndicator", 67: "ColorWell",
            68: "HelpTag", 69: "Matte", 70: "DockItem", 71: "Ruler", 72: "RulerMarker", 73: "Grid",
            74: "LevelIndicator", 75: "Cell", 76: "LayoutArea", 77: "LayoutItem", 78: "Handle",
            79: "Stepper", 80: "Tab", 81: "TouchBar", 82: "StatusItem",
        ]
        return "XCUIElementType" + (names[t.rawValue] ?? "Other")
    }
}
