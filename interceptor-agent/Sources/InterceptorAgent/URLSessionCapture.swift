import Foundation

/// In-process FULL plaintext capture for the Apple stack (URLSession / CFNetwork /
/// anything built on them), using the proven Proxyman/Atlantis method:
/// **observational method-swizzling of the private URLSessionTask internals.**
///
/// We do NOT use NSURLProtocol. A URLProtocol *re-runs* the request through an inner
/// session — it is a proxy, so it (a) only catches sessions whose config lists it
/// (misses URLSession.shared + background), (b) races session creation at install
/// time, and (c) hijacks/breaks the connection it intercepts (it broke the agent's
/// own daemon WebSocket, so the agent never registered).
///
/// Instead we hook the methods the URL Loading System calls internally, ABOVE TLS,
/// and just COPY the bytes as they flow — calling the original first, never
/// interfering:
///   - `resume` on `URLSessionTask`                    → request start (method/url/headers/body)
///   - `_didReceiveResponse:sniff:rewrite:` (or `:sniff:`) on the connection class → status + headers
///   - `_didReceiveData:` on the connection class       → response body bytes
///   - `_didFinishWithError:` on the connection class   → completion → flush req+resp
///
/// This sees `URLSession.shared`, custom-config and background sessions identically,
/// with no proxy, no cert, no TLS hook — the plaintext URLRequest/URLResponse the app
/// itself handed to / got back from Foundation.
final class URLSessionCapture: NSObject, @unchecked Sendable {
    static let shared = URLSessionCapture()

    private struct Resp {
        var status = 0
        var headers: [String: Any] = [:]
        var host = ""
        var body = Data()
    }
    private var resps = [ObjectIdentifier: Resp]()
    private let lock = NSLock()
    private var installed = false

    private func debug(_ s: @autoclosure () -> String) {
        if ProcessInfo.processInfo.environment["INTERCEPTOR_NET_DEBUG"] != nil { NSLog("[InterceptorAgent] \(s())") }
    }

    /// The agent's own daemon WebSocket must never be captured (and especially never
    /// disturbed). Skip the loopback ws endpoint and any ws/wss task outright.
    private func isAgentTransport(_ url: URL?) -> Bool {
        guard let url = url else { return false }
        if let s = url.scheme?.lowercased(), s == "ws" || s == "wss" { return true }
        let host = url.host ?? ""
        if host == "127.0.0.1" || host == "::1" || host == "localhost" {
            let wsPort = ProcessInfo.processInfo.environment["INTERCEPTOR_WS_PORT"] ?? "19222"
            if String(url.port ?? -1) == wsPort { return true }
        }
        return false
    }

    // MARK: install

    func install() {
        guard !installed else { return }
        installed = true
        swizzleResume()
        // The concrete connection class that drives the data-delivery callbacks.
        let connClass = NSClassFromString("__NSCFURLLocalSessionConnection")
            ?? NSClassFromString("__NSCFURLSessionConnection")
        if let c = connClass {
            swizzleDidReceiveResponse(c)
            swizzleDidReceiveData(c)
            swizzleDidComplete(c)
        }
        debug("URLSession capture installed (conn=\(connClass != nil))")
    }

    // MARK: request — swizzle `resume` on URLSessionTask

    private func swizzleResume() {
        let cls: AnyClass = URLSessionTask.self
        let sel = NSSelectorFromString("resume")
        guard let m = class_getInstanceMethod(cls, sel) else { debug("resume swizzle: no method"); return }
        typealias Fn = @convention(c) (AnyObject, Selector) -> Void
        let orig = unsafeBitCast(method_getImplementation(m), to: Fn.self)
        let block: @convention(block) (AnyObject) -> Void = { me in
            orig(me, sel)   // call original FIRST — never interfere
            if let task = me as? URLSessionTask { URLSessionCapture.shared.noteResume(task) }
        }
        method_setImplementation(m, imp_implementationWithBlock(block))
    }

    func noteResume(_ task: URLSessionTask) {
        guard NetCapture.shared.enabled else { return }
        guard let req = task.currentRequest ?? task.originalRequest, let url = req.url else { return }
        if isAgentTransport(url) { return }
        let scheme = url.scheme?.lowercased()
        guard scheme == "http" || scheme == "https" else { return }
        debug("URLSession resume \(req.httpMethod ?? "GET") \(url.absoluteString)")
        var s = "\(req.httpMethod ?? "GET") \(url.path.isEmpty ? "/" : url.path)\(url.query.map { "?" + $0 } ?? "") HTTP/1.1\n"
        s += "Host: \(url.host ?? "")\n"
        for (k, v) in req.allHTTPHeaderFields ?? [:] { s += "\(k): \(v)\n" }
        if let b = req.httpBody, let bs = String(data: b.prefix(8192), encoding: .utf8) { s += "\n" + bs }
        NetCapture.shared.addTLS(["kind": "http", "dir": "out", "host": url.host ?? "",
                                  "len": req.httpBody?.count ?? 0, "text": s])
    }

    // MARK: response — swizzle the private connection internals

    /// `me.value(forKey: "task")` on the connection object yields the URLSessionTask
    /// the response/data belongs to — the correlation key back to the request.
    private func taskOf(_ conn: AnyObject) -> URLSessionTask? {
        return (conn as? NSObject)?.value(forKey: "task") as? URLSessionTask
    }

    private func swizzleDidReceiveResponse(_ cls: AnyClass) {
        // iOS/macOS 13+ : _didReceiveResponse:sniff:rewrite:  ; older: _didReceiveResponse:sniff:
        if let m = class_getInstanceMethod(cls, NSSelectorFromString("_didReceiveResponse:sniff:rewrite:")) {
            let sel = NSSelectorFromString("_didReceiveResponse:sniff:rewrite:")
            typealias Fn = @convention(c) (AnyObject, Selector, AnyObject, Bool, Bool) -> Void
            let orig = unsafeBitCast(method_getImplementation(m), to: Fn.self)
            let block: @convention(block) (AnyObject, AnyObject, Bool, Bool) -> Void = { me, response, sniff, rewrite in
                orig(me, sel, response, sniff, rewrite)
                URLSessionCapture.shared.noteResponse(me, response)
            }
            method_setImplementation(m, imp_implementationWithBlock(block))
        } else if let m = class_getInstanceMethod(cls, NSSelectorFromString("_didReceiveResponse:sniff:")) {
            let sel = NSSelectorFromString("_didReceiveResponse:sniff:")
            typealias Fn = @convention(c) (AnyObject, Selector, AnyObject, Bool) -> Void
            let orig = unsafeBitCast(method_getImplementation(m), to: Fn.self)
            let block: @convention(block) (AnyObject, AnyObject, Bool) -> Void = { me, response, sniff in
                orig(me, sel, response, sniff)
                URLSessionCapture.shared.noteResponse(me, response)
            }
            method_setImplementation(m, imp_implementationWithBlock(block))
        } else {
            debug("didReceiveResponse swizzle: no selector")
        }
    }

    func noteResponse(_ conn: AnyObject, _ response: AnyObject) {
        guard NetCapture.shared.enabled, let task = taskOf(conn) else { return }
        if isAgentTransport(task.currentRequest?.url ?? task.originalRequest?.url) { return }
        guard let http = response as? HTTPURLResponse else { return }
        var r = Resp()
        r.status = http.statusCode
        r.host = http.url?.host ?? (task.currentRequest?.url?.host ?? "")
        // allHeaderFields keys aren't guaranteed String — normalise.
        var hs: [String: Any] = [:]
        for (k, v) in http.allHeaderFields { hs["\(k)"] = v }
        r.headers = hs
        lock.lock(); resps[ObjectIdentifier(task)] = r; lock.unlock()
    }

    private func swizzleDidReceiveData(_ cls: AnyClass) {
        let sel = NSSelectorFromString("_didReceiveData:")
        guard let m = class_getInstanceMethod(cls, sel) else { debug("didReceiveData swizzle: no selector"); return }
        typealias Fn = @convention(c) (AnyObject, Selector, AnyObject) -> Void
        let orig = unsafeBitCast(method_getImplementation(m), to: Fn.self)
        let block: @convention(block) (AnyObject, AnyObject) -> Void = { me, data in
            orig(me, sel, data)
            URLSessionCapture.shared.noteData(me, data)
        }
        method_setImplementation(m, imp_implementationWithBlock(block))
    }

    func noteData(_ conn: AnyObject, _ data: AnyObject) {
        guard NetCapture.shared.enabled, let task = taskOf(conn) else { return }
        // _didReceiveData: may hand a Data or a dispatch_data_t (bridged to Data).
        let d: Data? = (data as? Data) ?? {
            if let nsd = data as? NSData { return Data(referencing: nsd) }
            return nil
        }()
        guard let chunk = d, !chunk.isEmpty else { return }
        let key = ObjectIdentifier(task)
        lock.lock()
        if resps[key] == nil { resps[key] = Resp(status: 0, headers: [:], host: task.currentRequest?.url?.host ?? "", body: Data()) }
        if resps[key]!.body.count < 8192 {
            let room = 8192 - resps[key]!.body.count
            resps[key]!.body.append(chunk.prefix(room))
        }
        lock.unlock()
    }

    private func swizzleDidComplete(_ cls: AnyClass) {
        let sel = NSSelectorFromString("_didFinishWithError:")
        guard let m = class_getInstanceMethod(cls, sel) else { debug("didFinish swizzle: no selector"); return }
        typealias Fn = @convention(c) (AnyObject, Selector, AnyObject?) -> Void
        let orig = unsafeBitCast(method_getImplementation(m), to: Fn.self)
        let block: @convention(block) (AnyObject, AnyObject?) -> Void = { me, error in
            orig(me, sel, error)
            URLSessionCapture.shared.noteComplete(me)
        }
        method_setImplementation(m, imp_implementationWithBlock(block))
    }

    func noteComplete(_ conn: AnyObject) {
        guard let task = taskOf(conn) else { return }
        let key = ObjectIdentifier(task)
        lock.lock(); let r = resps.removeValue(forKey: key); lock.unlock()
        guard NetCapture.shared.enabled, let r = r else { return }
        if isAgentTransport(task.currentRequest?.url ?? task.originalRequest?.url) { return }
        var s = "HTTP/1.1 \(r.status)\n"
        for (k, v) in r.headers { s += "\(k): \(v)\n" }
        let preview = String(data: r.body, encoding: .utf8)
            ?? ("hex:" + r.body.prefix(256).map { String(format: "%02x", $0) }.joined())
        s += "\n" + preview
        debug("URLSession complete \(r.host) status=\(r.status) bytes=\(r.body.count)")
        NetCapture.shared.addTLS(["kind": "http", "dir": "in", "host": r.host, "len": r.body.count, "text": s])
    }
}

/// Install the Apple-stack capture (observational URLSession swizzle). Kept under
/// the original symbol name so bootstrap + the `net` verb call sites are unchanged.
func interceptor_agent_install_url_capture() {
    URLSessionCapture.shared.install()
}
