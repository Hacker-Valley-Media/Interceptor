import Foundation

/// In-process network endpoint buffer fed by the dyld interposers in netcap.c
/// (connect / getaddrinfo) and by the URLSession swizzle. Captures the hosts and
/// IP:ports an app dials — regardless of its TLS stack — once `enabled`.
final class NetCapture: @unchecked Sendable {
    static let shared = NetCapture()
    private var items: [[String: Any]] = []
    private let lock = NSLock()
    private let cap = 1000
    var enabled = false

    // Crash-durable sink: a managed copy can be killed by its own frameworks
    // shortly after launch if expected identity metadata is absent. The in-process
    // buffer dies with the process, so when INTERCEPTOR_NET_CAPTURE_FILE is set we
    // also append every captured entry to that file as JSON lines.
    private static let captureFile = ProcessInfo.processInfo.environment["INTERCEPTOR_NET_CAPTURE_FILE"]
    private let fileLock = NSLock()
    private func persist(_ e: [String: Any]) {
        guard let path = Self.captureFile,
              let data = try? JSONSerialization.data(withJSONObject: e) else { return }
        fileLock.lock(); defer { fileLock.unlock() }
        var line = data; line.append(0x0a)
        if let fh = FileHandle(forWritingAtPath: path) {
            fh.seekToEndOfFile(); fh.write(line); try? fh.close()
        } else {
            try? line.write(to: URL(fileURLWithPath: path))
        }
    }

    func add(_ entry: [String: Any]) {
        guard enabled else { return }
        lock.lock(); defer { lock.unlock() }
        var e = entry
        e["t"] = Int(Date().timeIntervalSince1970 * 1000)
        items.append(e)
        if items.count > cap { items.removeFirst(items.count - cap) }
        persist(e)
    }

    func snapshot(clear: Bool) -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        let s = items
        if clear { items.removeAll() }
        return s
    }

    func count() -> Int {
        lock.lock(); defer { lock.unlock() }
        return items.count
    }

    // TLS plaintext (full capture) — kept in its own buffer since bodies are large.
    private var tlsItems: [[String: Any]] = []
    private let tlsCap = 600

    func addTLS(_ entry: [String: Any]) {
        guard enabled else { return }
        lock.lock(); defer { lock.unlock() }
        var e = entry
        e["t"] = Int(Date().timeIntervalSince1970 * 1000)
        tlsItems.append(e)
        if tlsItems.count > tlsCap { tlsItems.removeFirst(tlsItems.count - tlsCap) }
        persist(e)
    }

    func tlsSnapshot(clear: Bool) -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        let s = tlsItems
        if clear { tlsItems.removeAll() }
        return s
    }
}

// C sinks called from the netcap.c interposers. Gating is done in NetCapture so
// the hot path (every connect/getaddrinfo in the process) stays a flag check.
@_cdecl("interceptor_agent_net_connect")
public func interceptor_agent_net_connect(_ addr: UnsafePointer<CChar>?) {
    guard let addr = addr else { return }
    let a = String(cString: addr)
    if ProcessInfo.processInfo.environment["INTERCEPTOR_NET_DEBUG"] != nil {
        NSLog("[InterceptorAgent] net connect \(a) enabled=\(NetCapture.shared.enabled)")
    }
    guard NetCapture.shared.enabled else { return }
    NetCapture.shared.add(["kind": "connect", "addr": a])
}

@_cdecl("interceptor_agent_net_host")
public func interceptor_agent_net_host(_ host: UnsafePointer<CChar>?, _ service: UnsafePointer<CChar>?) {
    guard let host = host else { return }
    let h = String(cString: host)
    if ProcessInfo.processInfo.environment["INTERCEPTOR_NET_DEBUG"] != nil {
        NSLog("[InterceptorAgent] net dns \(h) enabled=\(NetCapture.shared.enabled)")
    }
    guard NetCapture.shared.enabled else { return }
    let svc = service.map { String(cString: $0) } ?? ""
    NetCapture.shared.add(["kind": "dns", "host": h, "port": svc])
}

// FULL capture sink — the decrypted TLS plaintext from SSL_read/SSL_write
// (netcap.c). dir 1 = outbound (request), 0 = inbound (response).
@_cdecl("interceptor_agent_tls")
public func interceptor_agent_tls(_ dir: Int32, _ ssl: UnsafeRawPointer?, _ host: UnsafePointer<CChar>?, _ buf: UnsafeRawPointer?, _ len: Int32) {
    guard NetCapture.shared.enabled, let buf = buf, len > 0 else { return }
    let n = min(Int(len), 8192)
    let data = Data(bytes: buf, count: n)
    let sampleCount = min(data.count, 64)
    let printable = data.prefix(sampleCount).filter { $0 == 9 || $0 == 10 || $0 == 13 || ($0 >= 32 && $0 < 127) }.count
    let isText = sampleCount == 0 || (printable * 100 / sampleCount) >= 75
    let body: String
    if isText {
        body = String(decoding: data, as: UTF8.self)
    } else {
        body = "hex:" + data.prefix(256).map { String(format: "%02x", $0) }.joined()
    }
    NetCapture.shared.addTLS([
        "dir": dir == 1 ? "out" : "in",
        "host": host.map { String(cString: $0) } ?? "",
        "conn": ssl.map { String(UInt(bitPattern: $0), radix: 16) } ?? "",
        "len": Int(len),
        "binary": !isText,
        "text": body,
    ])
}
