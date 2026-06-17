import Foundation
import MachO
#if canImport(AppKit)
import AppKit
#endif

/// The in-process agent. On `bootstrap()` it connects to the daemon's WebSocket
/// (`ws://127.0.0.1:19222`), registers as `{type:"native", contextId:"runtime:<app>"}`,
/// and serves verb requests against the host app's own ObjC/Swift runtime. All
/// AppKit access happens on the main thread; the socket lives on a private queue.
final class InterceptorAgent: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    static let shared = InterceptorAgent()

    private let q = DispatchQueue(label: "com.interceptor.agent.ws")
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var booted = false
    private var reconnectAttempts = 0

    let refs = RefRegistry()
    private(set) var contextId = "runtime:app"
    private(set) var appName = "app"
    private var slice = "unknown"
    private var wayIn: String?

    private var delegateCompletions = [String: ([String: Any]?) -> Void]()
    private let delLock = NSLock()

    // Some GUI apps close stderr after launch, so NSLog vanishes. When
    // INTERCEPTOR_NET_DEBUG is set, also append lifecycle to a file we can read.
    private static let debugEnabled = ProcessInfo.processInfo.environment["INTERCEPTOR_NET_DEBUG"] != nil
    func flog(_ s: String) {
        guard Self.debugEnabled else { return }
        NSLog("[InterceptorAgent] \(s)")
        let line = "\(ProcessInfo.processInfo.processIdentifier) \(contextId) \(s)\n"
        let path = "/tmp/interceptor-agent-debug.log"
        if let fh = FileHandle(forWritingAtPath: path) {
            fh.seekToEndOfFile(); fh.write(line.data(using: .utf8)!); try? fh.close()
        } else {
            try? line.data(using: .utf8)?.write(to: URL(fileURLWithPath: path))
        }
    }

    // MARK: bootstrap / connection

    func bootstrap() {
        // SYNCHRONOUS, at dylib load (before the app's main builds any URLSession):
        // flip capture on + install the URLProtocol so the app's own sessions route
        // through us from their very first request. Doing this on the async queue
        // below would race the app creating its session first and miss it.
        if ProcessInfo.processInfo.environment["INTERCEPTOR_NET_CAPTURE"] != nil {
            NetCapture.shared.enabled = true
            interceptor_agent_install_url_capture()
        }
        q.async { [weak self] in
            guard let self = self, !self.booted else { return }
            self.booted = true
            let env = ProcessInfo.processInfo.environment
            self.appName = env["INTERCEPTOR_NATIVE_APPNAME"]
                ?? (Bundle.main.infoDictionary?["CFBundleName"] as? String)
                ?? ProcessInfo.processInfo.processName
            let slug = env["INTERCEPTOR_NATIVE_CONTEXT"] ?? Self.slugify(self.appName)
            self.contextId = slug.hasPrefix("runtime:") ? slug : "runtime:\(slug)"
            self.slice = env["INTERCEPTOR_AGENT_SLICE"] ?? Self.compiledSlice()
            self.wayIn = env["INTERCEPTOR_NATIVE_WAYIN"]

            // Multi-process apps may do networking + work in HELPER
            // processes. By default we host the agent only in the MAIN process and
            // clear the inherited env so helpers don't load + clobber the context.
            // INTERCEPTOR_NATIVE_ALL_PROCS keeps the agent in every process and
            // registers helpers under a distinct runtime:<app>#<exe> sub-context so
            // their traffic/state is reachable too.
            let allProcs = env["INTERCEPTOR_NATIVE_ALL_PROCS"] != nil
            if !allProcs {
                unsetenv("DYLD_INSERT_LIBRARIES")
                unsetenv("INTERCEPTOR_NATIVE_CONTEXT")
            }

            let bp = Bundle.main.bundlePath
            let exe = ((Bundle.main.executablePath ?? "") as NSString).lastPathComponent
            var isHelper = false
            for marker in ["/Contents/Frameworks/", "/Contents/Helpers/", "/Contents/PlugIns/", "/Contents/XPCServices/", ".xpc/"] {
                if bp.contains(marker) { isHelper = true; break }
            }
            if isHelper {
                if allProcs {
                    self.contextId = "\(self.contextId)#\(Self.slugify(exe.isEmpty ? self.appName : exe))"
                } else {
                    NSLog("[InterceptorAgent] skipping helper process: \(bp)")
                    return
                }
            }

            // Optional capture-on-launch so endpoints dialed during startup aren't
            // missed (the connect/getaddrinfo interposers are always installed; this
            // flips the record flag + installs URLProtocol before the app's first
            // network call, so its sessions route through us from the start).
            if env["INTERCEPTOR_NET_CAPTURE"] != nil {
                NetCapture.shared.enabled = true
                interceptor_agent_install_url_capture()
            }

            NSLog("[InterceptorAgent] bootstrap context=\(self.contextId) pid=\(ProcessInfo.processInfo.processIdentifier) slice=\(self.slice)")
            self.connect()
        }
    }

    private func connect() {
        let port = ProcessInfo.processInfo.environment["INTERCEPTOR_WS_PORT"] ?? "19222"
        guard let url = URL(string: "ws://127.0.0.1:\(port)") else { return }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.waitsForConnectivity = false
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        let t = s.webSocketTask(with: url)
        session = s
        task = t
        flog("connect() -> resume ws to \(url.absoluteString)")
        t.resume()
        receiveLoop()
    }

    private func scheduleReconnect() {
        reconnectAttempts += 1
        let delay = min(Double(reconnectAttempts) * 0.5, 5.0)
        q.asyncAfter(deadline: .now() + delay) { [weak self] in self?.connect() }
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol proto: String?) {
        reconnectAttempts = 0
        flog("ws didOpen -> register()")
        register()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        flog("ws didClose code=\(closeCode.rawValue) reason=\(reason.flatMap { String(data: $0, encoding: .utf8) } ?? "")")
        scheduleReconnect()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        flog("ws didComplete error=\(error?.localizedDescription ?? "nil")")
        if error != nil { scheduleReconnect() }
    }

    private func register() {
        flog("register() sending native frame context=\(contextId)")
        send([
            "type": "native",
            "contextId": contextId,
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "slice": slice,
            "appName": appName,
            "wayIn": wayIn ?? NSNull(),
            "frameworks": Self.loadedFrameworks(),
        ])
    }

    // MARK: send / receive

    func send(_ obj: [String: Any]) {
        let s = JSONUtil.encode(obj)
        task?.send(.string(s)) { err in
            if let err = err { NSLog("[InterceptorAgent] send error: \(err.localizedDescription)") }
        }
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let err):
                self.flog("receiveLoop failure: \(err.localizedDescription)")
                self.scheduleReconnect()
            case .success(let message):
                switch message {
                case .string(let text): self.route(text)
                case .data(let d): if let t = String(data: d, encoding: .utf8) { self.route(t) }
                @unknown default: break
                }
                self.receiveLoop()
            }
        }
    }

    private func route(_ text: String) {
        guard let msg = JSONUtil.decode(text) else { return }

        // Delegation response from the bridge: { id, result } (no action).
        if let id = msg["id"] as? String, msg["action"] == nil, let result = msg["result"] as? [String: Any] {
            delLock.lock(); let comp = delegateCompletions.removeValue(forKey: id); delLock.unlock()
            comp?(result)
            return
        }

        // Verb request: { id, action }.
        guard let id = msg["id"] as? String, let action = msg["action"] as? [String: Any] else { return }
        let type = action["type"] as? String ?? ""

        // Async passthrough so the CLI can exercise the delegate channel:
        // native_delegate wraps a macos_* action and replies when the bridge does.
        if type == "native_delegate", let inner = action["action"] as? [String: Any] {
            delegate(inner) { [weak self] result in
                self?.send(["id": id, "result": result ?? JSONUtil.err("delegate timeout")])
            }
            return
        }

        // Run verbs on the main thread, but in COMMON run-loop modes — not just the
        // default mode. `DispatchQueue.main.async` only drains in the default mode, so
        // when the host app shows a MODAL sheet/dialog (for example, a file-open panel
        // which runs the run loop in NSModalPanelRunLoopMode) the main queue stalls and
        // every verb times out. AppKit registers the modal-panel + event-tracking modes
        // as common modes, so scheduling in kCFRunLoopCommonModes keeps the agent
        // responsive even while a modal is up.
        let work: () -> Void = { [weak self] in
            guard let self = self else { return }
            let result = Verbs.handle(type, action: action, agent: self)
            self.send(["id": id, "result": result])
        }
        let mainRL = CFRunLoopGetMain()
        CFRunLoopPerformBlock(mainRL, CFRunLoopMode.commonModes.rawValue, work)
        CFRunLoopWakeUp(mainRL)
    }

    // MARK: delegation (bridge-held TCC)

    /// Send a `macos_*` action to the daemon → bridge and await its result. This
    /// is how the agent does TCC-gated / cross-app work without holding TCC
    /// itself.
    func delegate(_ action: [String: Any], timeout: TimeInterval = 20, completion: @escaping ([String: Any]?) -> Void) {
        let id = UUID().uuidString
        delLock.lock(); delegateCompletions[id] = completion; delLock.unlock()
        send(["type": "delegate", "id": id, "action": action])
        q.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self = self else { return }
            self.delLock.lock(); let comp = self.delegateCompletions.removeValue(forKey: id); self.delLock.unlock()
            comp?(nil)
        }
    }

    /// Emit an unsolicited event (watch / net / intercept streams).
    func emit(_ event: String, _ data: [String: Any]) {
        var obj = data
        obj["type"] = "event"
        obj["event"] = event
        obj["contextId"] = contextId
        send(obj)
    }

    // MARK: helpers

    static func slugify(_ s: String) -> String {
        var out = ""
        var lastDash = false
        for c in s.lowercased() {
            if c.isLetter || c.isNumber { out.append(c); lastDash = false }
            else if !lastDash { out.append("-"); lastDash = true }
        }
        return out.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    static func compiledSlice() -> String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }

    static func loadedFrameworks() -> [String] {
        var names = Set<String>()
        let count = _dyld_image_count()
        for i in 0..<count {
            guard let cname = _dyld_get_image_name(i) else { continue }
            let base = (String(cString: cname) as NSString).lastPathComponent
            for marker in ["AppKit", "SwiftUI", "JavaScriptCore", "WebKit", "QtCore", "libmono", "libcoreclr", "libjvm"] {
                if base.contains(marker) { names.insert(base) }
            }
        }
        return names.sorted()
    }
}
