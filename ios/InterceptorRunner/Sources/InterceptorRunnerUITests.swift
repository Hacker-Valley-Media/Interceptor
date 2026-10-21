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
//    - XCUITest's "wait for the app to be idle" is swizzled to a no-op on every
//      selector Xcode has used for it (the WDA "shouldWaitForQuiescence" fix), so
//      input verbs don't block up to 60 s, twice, on apps that never settle.
//    - Each verb runs inside ICRunCatching (Obj-C @try/@catch) so an XCUITest
//      NSException becomes an error frame instead of crashing the session.
//    - Verbs run on a dedicated serial queue; the WS receive loop is never
//      blocked, so the socket stays alive through a slow op.
//
//  Connection params arrive via the test process environment (injected into the
//  .xctestrun by the daemon at launch): INTERCEPTOR_WS_URL / _WS_TOKEN / _UDID /
//  _CONTEXT_ID, plus _DEVICE_SECRET / _WS_URLS, which the runner saves so it can
//  also be opened on the device and connect back without a Mac launch.
//
//  Wire protocol (daemon → runner): { id, op, ...args }
//                  (runner → daemon): { id, result: { success, data?, error? } }
//  Registration   (runner → daemon): { type:"ios", udid, token, contextId, launchedBy:"mac" }
//                 device-started:   { type:"ios", udid, contextId, launchedBy:"device", ts, nonce, proof }
//  Ack            (daemon → runner): { type:"ios", ok, contextId, serverProof? }
//  Quit           (daemon → runner): { id, op:"quit" }
//

import XCTest
import Foundation
import CryptoKit
import ObjectiveC.runtime
import JavaScriptCore  // Lane D: on-device JSCore scripting brain

final class InterceptorRunnerUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        ICMarkSetUpStarted()
        continueAfterFailure = true
        Runner.idleWaitPatched = disableQuiescenceWait()
    }

    /// Never-ending test that hosts the WebSocket agent (mirrors WDA's testRunner).
    func testRunner() {
        // A Mac launch passes the connection in the environment; opened on the
        // device, the runner uses the connection it saved at its last Mac launch.
        guard let connection = RunnerConnection.resolve() else {
            XCTFail(RunnerConnection.missingMessage, file: "InterceptorRunnerUITests.swift", line: #line)
            return
        }
        let agent = WSAgent(connection: connection)
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

/// Neutralize XCUITest's "wait for the app to be idle" before and after every
/// interaction. On an app that never settles (SpringBoard with a context menu open,
/// a browser's animating new-tab page) the wait runs to XCTest's 60 s ceiling
/// (`_XCTApplicationStateTimeout`) on every XCUICoordinate verb, twice, while the
/// press has already landed. Xcode 26 replaced the one-argument selector with the
/// `…isPreEvent:` pair. The application and AX client also have their own wait
/// methods. Missing methods are skipped across Xcode versions; `fgdebug` lists
/// the methods patched on this phone.
private func disableQuiescenceWait() -> [String] {
    let one: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
    let preEvent: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
    let activity: @convention(block) (AnyObject, Bool, AnyObject?, Bool) -> Void = { _, _, _, _ in }
    let table: [(String, String, IMP)] = [
        ("XCUIApplicationProcess", "waitForQuiescenceIncludingAnimationsIdle:", imp_implementationWithBlock(one)),
        ("XCUIApplicationProcess", "_waitForQuiescenceIncludingAnimationsIdle:", imp_implementationWithBlock(one)),
        ("XCUIApplicationProcess", "waitForQuiescenceIncludingAnimationsIdle:isPreEvent:", imp_implementationWithBlock(preEvent)),
        ("XCUIApplicationProcess", "waitForQuiescenceIncludingAnimationsIdle:usingActivity:isPreEvent:", imp_implementationWithBlock(activity)),
        ("XCUIApplication", "_waitForQuiescenceAsPreEvent:", imp_implementationWithBlock(one)),
        ("XCAXClient_iOS", "waitForQuiescenceOnAllForegroundApplicationsAsPreEvent:", imp_implementationWithBlock(one)),
    ]
    var patched: [String] = []
    for (className, name, imp) in table {
        guard let cls = NSClassFromString(className) else { continue }
        guard let method = class_getInstanceMethod(cls, NSSelectorFromString(name)) else { continue }
        method_setImplementation(method, imp)
        patched.append("\(className).\(name)")
    }
    return patched
}

// MARK: - Connection

/// Where the runner dials and how it proves itself.
///
/// A launch from the Mac passes everything in the test environment. When the
/// Mac also passes INTERCEPTOR_DEVICE_SECRET and INTERCEPTOR_WS_URLS, the runner
/// saves them, so it can connect when it is opened on the device (a tap on its
/// icon) and the environment is empty. A device-started runner never sends the
/// secret: it sends HMAC-SHA256(secret, "runner|UDID|ts|nonce"), and runs no op
/// until the Mac answers with HMAC-SHA256(secret, "server|UDID|nonce").
struct RunnerConnection {
    /// URL strings, kept as text and parsed only to dial.
    let urls: [String]
    let token: String
    let udid: String
    let contextId: String
    let secret: String
    /// The device started this runner (no Mac launch).
    let deviceStarted: Bool

    static let missingMessage = "InterceptorRunner has no saved connection. Run any interceptor ios command once while this device is on the Mac's network or USB, then open InterceptorRunner again."

    static func resolve(_ env: [String: String] = ProcessInfo.processInfo.environment) -> RunnerConnection? {
        guard let first = env["INTERCEPTOR_WS_URL"].map(restoreScheme), URL(string: first) != nil else { return load() }
        let conn = RunnerConnection(
            urls: [first],
            token: env["INTERCEPTOR_WS_TOKEN"] ?? "",
            udid: env["INTERCEPTOR_UDID"] ?? "",
            contextId: env["INTERCEPTOR_CONTEXT_ID"] ?? "",
            secret: env["INTERCEPTOR_DEVICE_SECRET"] ?? "",
            deviceStarted: false
        )
        let saved = (env["INTERCEPTOR_WS_URLS"] ?? "").split(separator: ",").map { restoreScheme(String($0)) }.filter { URL(string: $0) != nil }
        if !conn.secret.isEmpty && !saved.isEmpty { save(urls: saved, conn) }
        return conn
    }

    /// The test environment delivers "ws://host:port" as "ws:/host:port" (the
    /// .xctestrun holds the "//"; seen on the iOS 26.1 simulator). URLSession
    /// still connects, but the saved and reported URL should be exact.
    static func restoreScheme(_ s: String) -> String {
        s.replacingOccurrences(of: "^(wss?):/(?=[^/])", with: "$1://", options: .regularExpression)
    }

    private struct Saved: Codable { let urls: [String]; let udid: String; let contextId: String; let secret: String }

    private static var fileURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("interceptor-connection.json")
    }

    private static func save(urls: [String], _ c: RunnerConnection) {
        let saved = Saved(urls: urls, udid: c.udid, contextId: c.contextId, secret: c.secret)
        guard let file = fileURL, let data = try? JSONEncoder().encode(saved) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Readable once the device has been unlocked after boot, which is when a person can open the runner.
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private static func load() -> RunnerConnection? {
        guard let file = fileURL, let data = try? Data(contentsOf: file),
              let s = try? JSONDecoder().decode(Saved.self, from: data) else { return nil }
        let urls = s.urls.filter { URL(string: $0) != nil }
        guard !urls.isEmpty, !s.secret.isEmpty, !s.udid.isEmpty else { return nil }
        return RunnerConnection(urls: urls, token: "", udid: s.udid, contextId: s.contextId, secret: s.secret, deviceStarted: true)
    }

    /// HMAC-SHA256 over "<role>|<UDID>|<parts…>" keyed by the secret, base64url (daemon/ios/state.ts computes the same).
    func hmac(_ role: String, _ parts: [String]) -> String {
        let message = ([role, udid.uppercased()] + parts).joined(separator: "|")
        let mac = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: SymmetricKey(data: Data(secret.utf8)))
        return Data(mac).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

// MARK: - WebSocket agent

final class WSAgent: NSObject, URLSessionWebSocketDelegate {
    #if targetEnvironment(simulator)
    private static let kind = "simulator"
    #else
    private static let kind = "device"
    #endif

    private let conn: RunnerConnection
    /// Set when the socket is gone for good; the test's main run loop watches it.
    private(set) var finished = false

    private var session: URLSession!
    // Written on the reconnect queue; read from the main, delegate, and stream queues.
    private let taskLock = NSLock()
    private var _task: URLSessionWebSocketTask?
    private var task: URLSessionWebSocketTask? {
        get { taskLock.lock(); defer { taskLock.unlock() }; return _task }
        set { taskLock.lock(); _task = newValue; taskLock.unlock() }
    }
    private var reconnects = 0
    /// A Mac launch keeps five quick tries: the daemon owns its lifetime.
    private let maxReconnects = 5
    /// Device-started re-dial back-off in seconds; the last step repeats until `quit`.
    private static let backoff: [Double] = [1, 2, 4, 8, 15, 30]
    private var urlIndex = 0

    // Registration state of the current socket, shared by the reconnect and delegate queues.
    private let stateLock = NSLock()
    private var _currentURL: String
    private var _nonce = ""
    /// Ops run only once the Mac proved itself. A Mac launch is trusted as before.
    private var _authenticated: Bool
    private var _quit = false
    private var steppedAside = false

    private func locked<T>(_ body: () -> T) -> T { stateLock.lock(); defer { stateLock.unlock() }; return body() }

    init(connection: RunnerConnection) {
        self.conn = connection
        self._currentURL = connection.urls[0]
        self._authenticated = !connection.deviceStarted
        super.init()
        self.session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    func start() {
        FrameStreamer.shared.sender = { [weak self] data, done in
            guard let self = self else { done(URLError(.cancelled)); return }
            self.sendBinary(data, completion: done)
        }
        connect()
    }

    /// One binary message on the live socket (stream frames). The task is re-read
    /// per call, so frames follow a re-dialed connection.
    func sendBinary(_ data: Data, completion: @escaping (Error?) -> Void) {
        guard let t = task else { completion(URLError(.cancelled)); return }
        t.send(.data(data), completionHandler: completion)
    }

    private func connect() {
        let url = conn.urls[urlIndex % conn.urls.count]
        locked { _currentURL = url }
        // Every string was checked with URL(string:) when it was loaded.
        let t = session.webSocketTask(with: URL(string: url)!)
        task = t
        t.resume()
        register()
        receive()
    }

    private func register() {
        let url = locked { _currentURL }
        var msg: [String: Any] = ["type": "ios", "udid": conn.udid, "contextId": conn.contextId, "url": url, "kind": Self.kind]
        if conn.deviceStarted {
            let ts = Int64(Date().timeIntervalSince1970 * 1000)
            let nonce = UUID().uuidString
            locked { _nonce = nonce; _authenticated = false }
            msg["launchedBy"] = "device"
            msg["ts"] = ts
            msg["nonce"] = nonce
            msg["proof"] = conn.hmac("runner", [String(ts), nonce])
        } else {
            msg["launchedBy"] = "mac"
            msg["token"] = conn.token
        }
        send(msg)
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
                // A device-started runner resets its back-off only once the Mac proves itself (handleAck).
                if !self.conn.deviceStarted { self.reconnects = 0 }
                let text: String?
                switch message {
                case .string(let s): text = s
                case .data(let d): text = String(data: d, encoding: .utf8)
                @unknown default: text = nil
                }
                guard
                    let data = text?.data(using: .utf8),
                    let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                else { self.receive(); return }
                if obj["type"] as? String == "ios" { self.handleAck(obj); self.receive(); return }
                // A device-started runner drops every op, quit included, until the Mac has proved itself.
                if !self.locked({ self._authenticated }) { self.receive(); return }
                if obj["op"] as? String == "quit" { self.quit(id: obj["id"] as? String); return }
                // Verbs must run on the MAIN (test) thread: XCUITest's snapshot
                // and element queries require the thread-local XCTContext, which
                // exists only there ("Current context must not be nil" otherwise).
                // XCTest spins its own nested run loop while it works, so a verb
                // doesn't freeze the main loop. The receive loop stays on this
                // background delegate queue, so the socket stays responsive.
                DispatchQueue.main.async { self.handle(obj) }
                self.receive() // re-arm immediately
            case .failure:
                self.handleDisconnect()
            }
        }
    }

    /// The daemon's reply to registration. A device-started runner checks the
    /// Mac's proof, then steps aside to the Home Screen once.
    private func handleAck(_ obj: [String: Any]) {
        guard conn.deviceStarted else { return }
        let nonce = locked { _nonce }
        if obj["ok"] as? Bool == true, let proof = obj["serverProof"] as? String, proof == conn.hmac("server", [nonce]) {
            locked { _authenticated = true }
            reconnects = 0
            if !steppedAside {
                steppedAside = true
                DispatchQueue.main.async { XCUIDevice.shared.press(.home) }
            }
        } else {
            NSLog("InterceptorRunner: registration not accepted (%@)", String(describing: obj["error"] ?? "the server sent no valid proof"))
            task?.cancel(with: .policyViolation, reason: nil)
        }
    }

    /// `ios disable` on a device-started runner: stop re-dialing and end the test.
    private func quit(id: String?) {
        locked { _quit = true }
        if let id = id { send(["id": id, "result": ["success": true]]) }
        task?.cancel(with: .normalClosure, reason: nil)
        finished = true
    }

    private func handle(_ obj: [String: Any]) {
        guard let id = obj["id"] as? String, let op = obj["op"] as? String else { return }
        let result = Runner.run(op: op, args: obj)
        send(["id": id, "result": result])
    }

    private func handleDisconnect() {
        if locked({ _quit }) { finished = true; return }
        reconnects += 1
        if conn.deviceStarted {
            // Next saved URL; the delay grows after each full pass over them.
            urlIndex += 1
            let step = min((reconnects - 1) / max(conn.urls.count, 1), Self.backoff.count - 1)
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.backoff[step]) { [weak self] in self?.connect() }
        } else if reconnects <= maxReconnects {
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
    /// Idle-wait selectors replaced at setUp; empty means the phone waits for quiescence.
    static var idleWaitPatched: [String] = []

    private static func app() -> XCUIApplication { foregroundApp() }

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
            return ok(["fg": ICActiveApplicationBundleID() ?? "nil", "debug": ICActiveApplicationDebug() ?? "nil", "idleWait": idleWaitPatched])
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
        case "gesture":
            return synthesizeGesture(args["fingers"])
        case "stream":
            return FrameStreamer.shared.handle(action: args["action"] as? String ?? "status", args: args)
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

    // MARK: multi-touch (private XCSynthesizedEventRecord, see ObjCSupport.m)

    /// `fingers` is [[{x, y, t}]] with `t` in milliseconds from the record start.
    /// Validated here so a bad request never reaches the private API.
    private static func synthesizeGesture(_ raw: Any?) -> [String: Any] {
        guard let fingers = raw as? [[[String: Any]]], !fingers.isEmpty, fingers.count <= 10 else {
            return err("gesture requires 1 to 10 fingers, each a list of {x, y, t} samples")
        }
        var paths: [[[String: NSNumber]]] = []
        var durationMs = 0.0
        for finger in fingers {
            guard !finger.isEmpty else { return err("gesture: a finger has no samples") }
            var last = -1.0
            var samples: [[String: NSNumber]] = []
            for s in finger {
                let t = dbl(s["t"])
                guard t >= 0, t >= last else { return err("gesture: sample offsets must be non-negative and non-decreasing") }
                last = t
                samples.append(["x": NSNumber(value: dbl(s["x"])), "y": NSNumber(value: dbl(s["y"])), "t": NSNumber(value: t / 1000.0)])
            }
            durationMs = max(durationMs, last)
            paths.append(samples)
        }
        guard durationMs <= 55_000 else { return err("gesture: the last offset is at most 55000 ms") }
        // Points arrive in the app's interface space (what `click` and `tree` use).
        // The private record lands touches in PORTRAIT screen space (proven live on a
        // landscape game: app-space points did nothing, portrait-mapped points hit),
        // so map by the app's layout: a wider-than-tall app frame is landscape, and
        // the private `interfaceOrientation` picks the side (3: camera cutout on the
        // left, 4: right; 3 when it is missing). Both agreed with the real layout
        // every time they were checked (a landscape game, Safari upright and on its side).
        let app = foregroundApp()
        // The frame's short side is the portrait width whichever way it reports.
        // (UIScreen in this hostless runner reports a 320x480 compatibility screen.)
        let f = app.frame
        var orientation: Int64 = 1
        var source = "frame"
        if f.width > f.height {
            let o = ICApplicationInterfaceOrientation(app)
            orientation = (o == 3 || o == 4) ? o : 3
            source = (o == 3 || o == 4) ? "app" : "frame"
        }
        let W = Double(min(f.width, f.height)), H = Double(max(f.width, f.height))
        let mapped: [[[String: NSNumber]]] = paths.map { finger in
            finger.map { s in
                let x = s["x"]!.doubleValue, y = s["y"]!.doubleValue
                let p: (Double, Double)
                // Raw UIInterfaceOrientation: 3 is the layout with the camera cutout on
                // the left (proven live: the app reports 3 there and W - y, x lands).
                switch orientation {
                case 2: p = (W - x, H - y)
                case 3: p = (W - y, x)
                case 4: p = (y, H - x)
                default: p = (x, y)
                }
                return ["x": NSNumber(value: p.0), "y": NSNumber(value: p.1), "t": s["t"]!]
            }
        }
        let started = Date()
        if let e = ICSynthesizeGesture(mapped, app, 1) { return err(e.localizedDescription) }
        return ok([
            "fingers": fingers.count, "durationMs": durationMs,
            "elapsedMs": (Date().timeIntervalSince(started) * 1000).rounded(),
            "orientation": orientation, "orientationSource": source,
            "screen": ["width": W, "height": H],
        ])
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

    static func ok(_ data: Any?) -> [String: Any] {
        if let data = data { return ["success": true, "data": data] }
        return ["success": true]
    }
    static func err(_ msg: String) -> [String: Any] { ["success": false, "error": msg] }

    static func dbl(_ v: Any?, _ def: Double = 0) -> Double {
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

// MARK: - Frame stream (binary JPEG frames to the daemon)

/// Pushes downscaled JPEG frames of the screen to the daemon as binary WebSocket
/// messages, paced to a target fps, on a background queue so verbs keep running
/// on the main thread meanwhile. Capture and encode live in ObjCSupport.m
/// (XCUIScreen is main-actor-isolated in the Xcode 26 SDK).
final class FrameStreamer {
    static let shared = FrameStreamer()
    /// Installed by the WSAgent; sends one binary message on the live socket.
    var sender: ((Data, @escaping (Error?) -> Void) -> Void)?

    private let queue = DispatchQueue(label: "com.interceptor.runner.stream")
    private let lock = NSLock()
    private var generation = 0
    private var running = false
    private var inFlight = 0
    private var stats: [String: Any] = ["running": false, "frames": 0]

    func handle(action: String, args: [String: Any]) -> [String: Any] {
        switch action {
        case "start":
            let fps = min(30.0, max(1.0, Runner.dbl(args["fps"], 10)))
            let scale = min(1.0, max(0.1, Runner.dbl(args["scale"], 0.5)))
            let quality = min(1.0, max(0.05, Runner.dbl(args["quality"], 0.3)))
            start(fps: fps, scale: scale, quality: quality)
            return Runner.ok(snapshot())
        case "stop":
            stop()
            return Runner.ok(snapshot())
        case "status":
            return Runner.ok(snapshot())
        default:
            return Runner.err("unknown stream action '\(action)' (start|stop|status)")
        }
    }

    private func snapshot() -> [String: Any] { lock.lock(); defer { lock.unlock() }; return stats }

    private func update(_ f: (inout [String: Any]) -> Void) { lock.lock(); f(&stats); lock.unlock() }

    private func isCurrent(_ gen: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return running && generation == gen }

    private func stop() {
        lock.lock(); running = false; generation += 1; stats["running"] = false; lock.unlock()
    }

    private func start(fps: Double, scale: Double, quality: Double) {
        lock.lock()
        running = true
        generation += 1
        let gen = generation
        inFlight = 0
        stats = ["running": true, "fps": fps, "scale": scale, "quality": quality, "frames": 0, "dropped": 0, "sendErrors": 0, "captureErrors": 0]
        lock.unlock()
        let interval = 1.0 / fps
        queue.async { [self] in
            var frames = 0, dropped = 0, captureErrors = 0
            while isCurrent(gen) {
                let t0 = Date()
                var px = CGSize.zero
                var captureMs = 0.0, encodeMs = 0.0
                if let jpeg = ICCaptureScreenJPEG(scale, quality, &px, &captureMs, &encodeMs) {
                    frames += 1
                    // A slow link must not pile frames up in memory: at most three sends in flight.
                    lock.lock()
                    let send = inFlight < 3
                    if send { inFlight += 1 }
                    lock.unlock()
                    if send, let sender = sender {
                        sender(jpeg) { [self] error in
                            lock.lock()
                            inFlight -= 1
                            if error != nil { stats["sendErrors"] = (stats["sendErrors"] as? Int ?? 0) + 1 }
                            lock.unlock()
                        }
                    } else {
                        dropped += 1
                    }
                    update { s in
                        s["frames"] = frames; s["dropped"] = dropped
                        s["lastCaptureMs"] = captureMs.rounded(); s["lastEncodeMs"] = encodeMs.rounded()
                        s["lastBytes"] = jpeg.count; s["width"] = Int(px.width); s["height"] = Int(px.height)
                    }
                } else {
                    captureErrors += 1
                    update { s in s["captureErrors"] = captureErrors }
                }
                let elapsed = Date().timeIntervalSince(t0)
                if elapsed < interval { Thread.sleep(forTimeInterval: interval - elapsed) }
            }
        }
    }
}
