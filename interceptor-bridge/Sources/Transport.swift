import Foundation
import Darwin.POSIX

final class Transport: @unchecked Sendable {
    private let router: Router
    private let socketPath: String
    private var serverFD: Int32 = -1
    private var running = true
    static let requestIdWindow = 4096

    init(router: Router) throws {
        self.router = router
        self.socketPath = Platform.bridgeSocketPath
        var addr = try Self.socketAddress(socketPath)
        Platform.cleanupSocket()

        serverFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard serverFD >= 0 else {
            throw NSError(domain: "Transport", code: 1, userInfo: [NSLocalizedDescriptionKey: "failed to create socket"])
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                bind(serverFD, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            Darwin.close(serverFD)
            throw NSError(domain: "Transport", code: 2, userInfo: [NSLocalizedDescriptionKey: "bind failed: \(String(cString: strerror(errno)))"])
        }

        guard Darwin.listen(serverFD, SOMAXCONN) == 0 else {
            Darwin.close(serverFD)
            throw NSError(domain: "Transport", code: 3, userInfo: [NSLocalizedDescriptionKey: "listen failed"])
        }
    }

    // Validate before cleanup or bind. Truncation creates a different socket
    // from the advertised endpoint, leaving every client unable to connect.
    static func socketAddress(_ path: String) throws -> sockaddr_un {
        var address = sockaddr_un()
        let bytes = Array(path.utf8CString)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard !path.isEmpty, !path.utf8.contains(0), bytes.count <= capacity else {
            throw NSError(domain: "Transport", code: 4, userInfo: [NSLocalizedDescriptionKey:
                "bridge socket path requires 1...\(capacity - 1) UTF-8 bytes without NUL; use a shorter runtime directory"])
        }
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutablePointer(to: &address.sun_path) { target in
            bytes.withUnsafeBufferPointer { source in
                UnsafeMutableRawPointer(target).copyMemory(from: source.baseAddress!, byteCount: bytes.count)
            }
        }
        return address
    }

    func start() {
        Platform.log("transport listening on \(socketPath)")
        let fd = serverFD
        let rtr = router
        let thread = Thread {
            Transport.acceptLoop(serverFD: fd, router: rtr)
        }
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    func stop() {
        running = false
        if serverFD >= 0 { Darwin.close(serverFD); serverFD = -1 }
    }

    private static func acceptLoop(serverFD: Int32, router: Router) {
        while true {
            var clientAddr = sockaddr_un()
            var clientLen = socklen_t(MemoryLayout<sockaddr_un>.size)
            let clientFD = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                    Darwin.accept(serverFD, sockPtr, &clientLen)
                }
            }
            guard clientFD >= 0 else {
                usleep(10_000)
                continue
            }

            Platform.log("client connected (fd: \(clientFD))")

            let rtr = router
            Thread.detachNewThread {
                Transport.handleClient(fd: clientFD, router: rtr)
            }
        }
    }

    // per-connection state held by the read loop. The read loop
    // never blocks on a router callback completing; instead each request is
    // dispatched to a global worker queue, and the per-fd serial writeQueue
    // serializes the actual `Darwin.write(fd, ...)` so framed bytes from
    // concurrent completions never interleave on the wire. The DispatchGroup
    // tracks every in-flight request so the read loop's exit path can drain
    // pending writes before closing the fd.
    /// Exposed at module-internal access so `@testable import interceptor_bridge`
    /// can drive a `socketpair`-backed handleClient in tests.
    static func handleClient(fd: Int32, router: Router) {
        var noSignal: Int32 = 1
        let flags = Darwin.fcntl(fd, F_GETFL)
        guard flags >= 0,
              Darwin.fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0,
              setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout.size(ofValue: noSignal))) == 0 else {
            Platform.log("failed to configure client socket: \(String(cString: strerror(errno)))")
            Darwin.close(fd)
            return
        }
        var buffer = Data()
        let readBuf = UnsafeMutablePointer<UInt8>.allocate(capacity: 65536)

        let writeQueue = DispatchQueue(label: "interceptor-bridge.write.\(fd)", qos: .userInitiated)
        let workQueue = DispatchQueue.global(qos: .userInitiated)
        let inflightGroup = DispatchGroup()
        let inflightCounter = InflightCounter()
        // Duplicate detection covers the newest `requestIdWindow` ids. The
        // daemon keeps one connection for its lifetime, so the oldest id is
        // forgotten instead of refusing the connection at a fixed count.
        var requestIds = Set<String>(), requestOrder: [String] = [], oldest = 0
        func remember(_ id: String) {
            requestIds.insert(id)
            if requestOrder.count < requestIdWindow { requestOrder.append(id); return }
            requestIds.remove(requestOrder[oldest])
            requestOrder[oldest] = id
            oldest = (oldest + 1) % requestIdWindow
        }

        defer {
            readBuf.deallocate()
            // drain in-flight router callbacks + their writeQueue
            // tasks before closing the fd. group.wait() waits for every
            // group.enter() (request received) to be matched by group.leave()
            // (response written or write failure). writeQueue.sync afterwards
            // is a belt-and-braces flush — group.leave() runs inside the
            // writeQueue closure, so once the group is drained the queue is
            // empty, but a sync barrier is cheap and makes the ordering
            // self-evident to readers.
            inflightGroup.wait()
            writeQueue.sync { }
            Darwin.close(fd)
            Platform.log("client disconnected (fd: \(fd))")
        }

        while true {
            let bytesRead = Darwin.read(fd, readBuf, 65536)
            if bytesRead < 0 && errno == EINTR { continue }
            if bytesRead < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                var readable = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                let ready = Darwin.poll(&readable, 1, -1)
                if ready >= 0 || errno == EINTR { continue }
            }
            if bytesRead <= 0 { break }
            buffer.append(readBuf, count: bytesRead)

            while buffer.count >= 4 {
                let payloadLen: UInt32 = buffer.withUnsafeBytes { ptr in
                    ptr.loadUnaligned(as: UInt32.self)
                }
                let frameLen = 4 + Int(payloadLen)
                // Sanity check: max 10MB message
                guard payloadLen > 0, payloadLen < 10_000_000, buffer.count >= frameLen else {
                    if payloadLen == 0 || payloadLen >= 10_000_000 {
                        Platform.log("invalid frame length: \(payloadLen), dropping buffer")
                        buffer.removeAll()
                    }
                    break
                }

                let payload = Data(buffer[4..<frameLen])
                buffer = Data(buffer[frameLen...])

                guard let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
                    // Synchronous write of an error frame is fine here — we
                    // have not yet entered the in-flight group for this id.
                    if let frame = Transport.encodeFrame(response: ["error": "invalid JSON"]) {
                        writeQueue.sync { Transport.writeFrame(fd: fd, frame: frame) }
                    }
                    continue
                }

                let action = json["action"] as? [String: Any] ?? [:]
                let actionType = action["type"] as? String ?? "unknown"
                let neutral = actionType.hasPrefix("desktop_") || actionType == "macos_desktop" || actionType.hasPrefix("macos_desktop_")
                let requestId = json["id"] as? String ?? (neutral ? "" : UUID().uuidString)
                let protocolNumber = json["protocolVersion"] as? NSNumber
                let malformedProtocol = json["protocolVersion"] != nil && !(protocolNumber.map {
                    CFGetTypeID($0) != CFBooleanGetTypeID() && $0.doubleValue.isFinite
                } ?? false)
                let malformedToken = json["token"] != nil && !(json["token"] is String)

                // Reject repeats in the read loop before dispatch, including
                // when the original request's callback is still in flight.
                let refusal: String?
                var refusalCode = "invalid_request"
                if neutral && (malformedProtocol || malformedToken) {
                    refusal = "malformed desktop request"
                } else if requestId.utf8.count > 128 || requestId.isEmpty {
                    refusal = "id must contain 1..128 bytes"
                } else if requestIds.contains(requestId) {
                    refusal = "duplicate request id on this connection"
                } else if neutral && protocolNumber.map({ $0.doubleValue != Double(DESKTOP_PROTOCOL_VERSION) }) == true {
                    remember(requestId)
                    refusalCode = "version_mismatch"
                    refusal = "desktop protocol version \(DESKTOP_PROTOCOL_VERSION) required"
                } else {
                    refusal = nil
                }
                if let refusal = refusal {
                    if let frame = Transport.encodeFrame(response: ["id": requestId, "result": ["success": false, "code": refusalCode, "error": refusal]]) {
                        writeQueue.sync { Transport.writeFrame(fd: fd, frame: frame) }
                    }
                    continue
                }
                remember(requestId)

                let inflight = inflightCounter.increment()
                Platform.log("request \(requestId.prefix(8)) \(actionType) inflight=\(inflight)")

                let startTime = Date()
                inflightGroup.enter()

                // dispatch each request onto the global worker
                // queue. The read loop continues immediately to the next
                // frame — one slow router callback no longer blocks
                // unrelated requests on the same connection. `action` is
                // `[String: Any]` (not Sendable under Swift 6 strict
                // concurrency) so we wrap it in an unchecked-Sendable box
                // for the queue hop. Router.route already documents that
                // its action parameter is consumed exactly once.
                let actionBox = UncheckedSendableBox(action)
                workQueue.async {
                    router.route(action: actionBox.value) { result in
                        let duration = Date().timeIntervalSince(startTime) * 1000
                        let success = result["success"] as? Bool ?? false
                        let remaining = inflightCounter.decrement()
                        Platform.log("response \(requestId.prefix(8)) \(success ? "ok" : "err") \(actionType) \(Int(duration))ms inflight=\(remaining)")

                        // Serialize the response on the worker queue (off
                        // the read thread, off the writeQueue) so we hand
                        // an already-framed `Data` blob across the queue
                        // boundary — `[String: Any]` is not Sendable, but
                        // `Data` is.
                        let response: [String: Any] = [
                            "id": requestId,
                            "result": result
                        ]
                        let frame = Transport.encodeFrame(response: response)

                        // writes are serialized per-fd so frame
                        // bytes from concurrent completions cannot interleave.
                        // group.leave() is called from inside the writeQueue
                        // closure so the read loop's exit-path drain
                        // (inflightGroup.wait()) actually waits until the
                        // bytes are out the door.
                        writeQueue.async {
                            if let frame = frame {
                                Transport.writeFrame(fd: fd, frame: frame)
                            }
                            inflightGroup.leave()
                        }
                    }
                }
            }
        }
    }

    /// serialize a response dict to the framed wire format. Returns
    /// nil and logs if JSON encoding fails. Done OFF the writeQueue so we
    /// hand a Sendable `Data` across queue boundaries (`[String: Any]` is
    /// not Sendable under Swift 6 strict concurrency).
    fileprivate static func encodeFrame(response: [String: Any]) -> Data? {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: response) else {
            Platform.log("failed to serialize response")
            return nil
        }
        var length = UInt32(jsonData.count)
        let header = Data(bytes: &length, count: 4)
        return header + jsonData
    }

    /// caller MUST already be running on the per-fd writeQueue so
    /// frame bytes cannot interleave with a concurrent in-flight write.
    fileprivate static func writeFrame(fd: Int32, frame: Data) {
        let deadline = DispatchTime.now().uptimeNanoseconds + 15_000_000_000
        let complete = frame.withUnsafeBytes { ptr -> Bool in
            guard let base = ptr.baseAddress else { return true }
            var written = 0
            while written < frame.count {
                let now = DispatchTime.now().uptimeNanoseconds
                guard now < deadline else { return false }
                let count = Darwin.write(fd, base.advanced(by: written), frame.count - written)
                if count > 0 { written += count; continue }
                if count < 0 && errno == EINTR { continue }
                guard count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) else { return false }
                var pending = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                let milliseconds = Int32(min(1000, (deadline - now + 999_999) / 1_000_000))
                let ready = Darwin.poll(&pending, 1, milliseconds)
                if ready < 0 && errno != EINTR { return false }
                if ready > 0 && pending.revents & Int16(POLLERR | POLLHUP | POLLNVAL) != 0 { return false }
            }
            return true
        }
        if !complete {
            // No subsequent frame may follow a truncated one. Wake the reader
            // and leave client-side mutation outcomes unknown, without replay.
            Platform.log("client frame delivery failed or exceeded 15s (fd: \(fd))")
            _ = Darwin.shutdown(fd, SHUT_RDWR)
        }
    }
}

/// tiny `@unchecked Sendable` wrapper so we can pass non-Sendable
/// values (here, the parsed action `[String: Any]`) across a queue
/// boundary without a torrent of warnings. The transport hands the action
/// to exactly one consumer (`router.route`) which lives on the worker
/// queue, so concurrent access is not a real risk.
struct UncheckedSendableBox<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

/// tiny lock-protected counter used to stamp `inflight=N` onto
/// `request`/`response` log lines, giving operators a queue-depth signal
/// now that the read loop no longer serializes per-fd. The counter is
/// per-connection (constructed inside `handleClient`).
final class InflightCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count: Int = 0

    /// Increment and return the new value (for the `request` log line).
    func increment() -> Int {
        lock.lock()
        count += 1
        let now = count
        lock.unlock()
        return now
    }

    /// Decrement and return the new value (for the `response` log line).
    func decrement() -> Int {
        lock.lock()
        count = max(0, count - 1)
        let now = count
        lock.unlock()
        return now
    }
}
