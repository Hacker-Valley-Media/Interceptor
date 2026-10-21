//
//  ICWebServer.swift — the runner's loopback web server.
//
//  The xctrunner can't foreground a native window (XCTest keeps it in the
//  background), so the Connect UI is a web page served on 127.0.0.1 (loopback
//  needs no Local Network grant) and shown in Safari. This serves the bundled
//  WebUIDist, GET /snapshot (the state the page polls; WebUI/src/types.ts holds
//  the step contract) and POST /action (the Connect button). Started from the
//  ObjCSupport +load patch that Scripts/build-dev-web.sh applies.
//
//  POST /action needs the per-process `token`. It reaches the page only through
//  the Safari URL the runner opens (ICRunnerUI.m), so another app on the phone
//  can't start the Connect flow. Network.framework NWListener, loopback only.
//

import Foundation
import Network

@objc(ICWebServer)
final class ICWebServer: NSObject {

    static let port: UInt16 = 8723
    static let shared = ICWebServer()

    /// Per-process secret for POST /action. Never served by GET.
    @objc static let token = UUID().uuidString

    /// Requests (headers + body) larger than this are dropped.
    static let maxRequestBytes = 64 * 1024
    /// A connection that hasn't finished its request by now is dropped.
    static let requestTimeout: TimeInterval = 10

    private var listener: NWListener?
    private let queue = DispatchQueue(label: "ic.webserver")
    private let lock = NSLock()
    private var snapshotJSON: Data = ICWebServer.defaultSnapshot()

    // MARK: - state the UI polls

    /// Publish a full step. `phase` is derived from the step so the two never drift.
    func set(step: String, status: String = "", error: String? = nil,
             runnerPid: UInt64? = nil, progress: Double? = nil) {
        var d = baseSnapshot()
        d["step"] = step
        d["phase"] = Self.phase(for: step)
        d["busy"] = Self.phase(for: step) == "working"
        d["status"] = status
        d["error"] = error as Any? ?? NSNull()
        d["runnerPid"] = runnerPid.map { Int($0) } as Any? ?? NSNull()
        d["progress"] = progress as Any? ?? NSNull()
        setSnapshot(d)
    }

    static func phase(for step: String) -> String {
        switch step {
        case "allClear": return "connected"
        case "ready": return "ready"
        case "failed": return "failed"
        case "setupNeeded": return "setup"
        case "cellularOff", "cellularOn", "vpnOn": return "needsUser"
        default: return "working" // startingVpn, preparing, installing, connecting
        }
    }

    func setSnapshot(_ dict: [String: Any]) {
        if let d = try? JSONSerialization.data(withJSONObject: dict) { lock.withLock { snapshotJSON = d } }
    }

    @objc static func start() {
        // Route the UI's Connect button to the real mount+launch flow.
        if onAction == nil {
            onAction = { msg in if (msg["action"] as? String) == "connect" { ICBootstrap.webConnect() } }
        }
        shared.seedDeviceFacts()
        shared.startIfNeeded()
    }

    /// Fill the snapshot with live device facts + the right opening step.
    private func seedDeviceFacts() {
        let ready = PairingFileStore.exists && DeveloperDiskImageStore.isComplete
        var d = baseSnapshot()
        d["iosVersion"] = ProcessInfo.processInfo.operatingSystemVersionString
        d["pairingPresent"] = PairingFileStore.exists
        d["ddiPresent"] = DeveloperDiskImageStore.isComplete
        d["ddiLabel"] = DeveloperDiskImageStore.isComplete ? "ready" : "not added"
        d["mountMethod"] = DeveloperDiskImageStore.mountMethod.rawValue
        d["network"] = ICWebServer.networkKind()
        // Warm (already mounted this boot) → the runner is dialing home: show "connecting";
        // it flips to allClear when it registers. Cold + ready → ready. Else → setup.
        let step = ICBootstrap.mountedThisBoot() ? "connecting" : (ready ? "ready" : "setupNeeded")
        d["step"] = step
        d["phase"] = Self.phase(for: step)
        setSnapshot(d)
    }

    static func networkKind() -> String {
        if NetPath.isUp(.wifi) { return "wifi" }
        if NetPath.isUp(.cellular) { return "cellular" }
        return "none"
    }

    // MARK: - listener

    func startIfNeeded() {
        guard listener == nil else { return }
        do {
            let params = NWParameters.tcp
            params.requiredInterfaceType = .loopback
            params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.port)!)
            params.allowLocalEndpointReuse = true
            let l = try NWListener(using: params)
            l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
            l.stateUpdateHandler = { st in icLog("WEB: listener \(st)") }
            l.start(queue: queue)
            listener = l
            icLog("WEB: serving on http://127.0.0.1:\(Self.port)")
        } catch { icLog("WEB: listen failed \(error.localizedDescription)") }
    }

    private func accept(_ conn: NWConnection) {
        conn.start(queue: queue)
        // Every request finishes in milliseconds; drop a stalled one. Cancelling an
        // already-closed connection is a no-op.
        queue.asyncAfter(deadline: .now() + Self.requestTimeout) { conn.cancel() }
        receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: Self.maxRequestBytes) { [weak self] data, _, done, err in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            guard buf.count <= Self.maxRequestBytes else { conn.cancel(); return }
            switch HTTPRequest.parse(buf) {
            case .ok(let req): self.handle(req, conn)
            case .invalid: conn.cancel()
            case .incomplete:
                if done || err != nil { conn.cancel() } else { self.receive(conn, buffer: buf) }
            }
        }
    }

    private func handle(_ req: HTTPRequest, _ conn: NWConnection) {
        let (status, type, body) = route(req)
        var head = "HTTP/1.1 \(status)\r\n"
        head += "Content-Type: \(type)\r\nContent-Length: \(body.count)\r\n"
        head += "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
        var out = Data(head.utf8); out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }

    private func route(_ req: HTTPRequest) -> (String, String, Data) {
        let path = req.path.split(separator: "?").first.map(String.init) ?? req.path
        if req.method == "GET", path == "/snapshot" {
            return ("200 OK", "application/json", lock.withLock { snapshotJSON })
        }
        if req.method == "POST", path == "/action" {
            guard req.headers["x-interceptor-token"] == Self.token else {
                icLog("WEB: refused /action without a valid token")
                return ("403 Forbidden", "application/json", Data("{\"ok\":false}".utf8))
            }
            let msg = (try? JSONSerialization.jsonObject(with: req.body)) as? [String: Any] ?? [:]
            ICWebServer.onAction?(msg)
            return ("200 OK", "application/json", Data("{\"ok\":true}".utf8))
        }
        let rel = path == "/" ? "index.html" : String(path.drop(while: { $0 == "/" }))
        if rel.contains("..") { return ("403 Forbidden", "text/plain", Data("no".utf8)) }
        if let url = Self.webRoot?.appendingPathComponent(rel), let data = try? Data(contentsOf: url) {
            return ("200 OK", Self.mime(rel), data)
        }
        return ("404 Not Found", "text/plain", Data("not found".utf8))
    }

    static let webRoot: URL? = {
        let b = Bundle(for: ICWebServer.self)
        return b.url(forResource: "WebUIDist", withExtension: nil)
            ?? b.resourceURL?.appendingPathComponent("WebUIDist")
    }()

    @objc static var onAction: (([String: Any]) -> Void)?

    static func mime(_ name: String) -> String {
        if name.hasSuffix(".html") { return "text/html; charset=utf-8" }
        if name.hasSuffix(".js") { return "text/javascript; charset=utf-8" }
        if name.hasSuffix(".css") { return "text/css; charset=utf-8" }
        if name.hasSuffix(".json") { return "application/json" }
        if name.hasSuffix(".svg") { return "image/svg+xml" }
        if name.hasSuffix(".ttf") { return "font/ttf" }      // brand fonts (assets/brand; small ones get inlined)
        return "application/octet-stream"
    }

    private func baseSnapshot() -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: lock.withLock { snapshotJSON })) as? [String: Any] ?? [:]
    }
    static func defaultSnapshot() -> Data {
        let d: [String: Any] = [
            "generation": 1, "phase": "ready", "step": "ready", "pairingPresent": true,
            "ddiPresent": true, "ddiLabel": "ready", "mountMethod": "personalized",
            "iosVersion": "", "network": "wifi", "status": "", "error": NSNull(),
            "runnerPid": NSNull(), "busy": false, "progress": NSNull(),
        ]
        return (try? JSONSerialization.data(withJSONObject: d)) ?? Data("{}".utf8)
    }
}

// Minimal HTTP/1.1 request. `parse` says whether the buffer holds a complete
// request, needs more bytes, or can never become one (the caller drops those).
private struct HTTPRequest {
    enum Parse { case incomplete, invalid, ok(HTTPRequest) }

    let method: String
    let path: String
    let headers: [String: String] // lowercased names
    let body: Data

    static func parse(_ buf: Data) -> Parse {
        guard let headerEnd = buf.range(of: Data("\r\n\r\n".utf8)) else { return .incomplete }
        guard let header = String(data: buf.subdata(in: buf.startIndex..<headerEnd.lowerBound), encoding: .utf8) else {
            return .invalid
        }
        let lines = header.components(separatedBy: "\r\n")
        let parts = lines[0].components(separatedBy: " ")
        guard parts.count >= 2, !parts[0].isEmpty, !parts[1].isEmpty else { return .invalid }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        var length = 0
        if let raw = headers["content-length"] {
            guard let n = Int(raw), n >= 0, n <= ICWebServer.maxRequestBytes else { return .invalid }
            length = n
        }
        let bodyStart = headerEnd.upperBound
        guard buf.distance(from: bodyStart, to: buf.endIndex) >= length else { return .incomplete }
        let body = buf.subdata(in: bodyStart..<buf.index(bodyStart, offsetBy: length))
        return .ok(HTTPRequest(method: parts[0], path: parts[1], headers: headers, body: body))
    }
}
