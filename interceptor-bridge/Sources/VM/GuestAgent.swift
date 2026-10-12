// GuestAgent
//
// Guest-agent client used by the host bridge to dispatch verbs INTO a
// running guest. The preferred VZ path requires the guest to expose a
// Virtio socket endpoint on port 3294. We connect via
// `VZVirtioSocketDevice.connect(toPort:completionHandler:)` per
// `apple-developer-docs/Virtualization/VZVirtioSocketDevice.md:25-30`,
// take the resulting `VZVirtioSocketConnection.fileDescriptor`, and
// speak the same length-prefixed JSON framing the host bridge already
// uses (`WireFormat`).
//
// A normal macOS guest TCP listener is not the same as a Virtio socket
// endpoint. TCP is only attempted when a VM spec explicitly configures it.
//
// Wire framing (host ↔ guest):
//   [4 bytes little-endian length][JSON payload]
// Request shape:   {id: uuid, action: {verb: "exec", ...}}
// Response shape:  {id: uuid, result: {success: bool, data?: ..., error?: string}}

import Foundation
import Darwin
import GuestWire
#if canImport(Virtualization)
import Virtualization
#endif

/// Fixed vsock port we run the guest agent on. Chosen to avoid the
/// well-known low-numbered range and keep typed-out as `0xCDE` (3294)
/// for memorability. Documented in the design notes E6 evidence row.
public let kInterceptorGuestAgentPort: UInt32 = 3294

// Tiny @unchecked Sendable wrapper so we can hand a `[String: Any]` across
// CheckedContinuation boundaries — same pattern Transport.swift uses
// (Transport.swift:234 UncheckedSendableBox).
public struct GuestAgentDict: @unchecked Sendable {
    public let dict: [String: Any]

    public init(_ dict: [String: Any]) {
        self.dict = dict
    }
}

final class GuestAgentConnectContinuation: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Int32, Error>?

    init(_ continuation: CheckedContinuation<Int32, Error>) {
        self.continuation = continuation
    }

    /// Win admission before installing a connection. A timed-out callback
    /// drops its native connection without changing the current agent fd.
    @discardableResult
    func complete(_ operation: () throws -> Int32) -> Bool {
        lock.lock()
        guard let cc = continuation else { lock.unlock(); return false }
        continuation = nil
        let result = Result { try operation() }
        lock.unlock()
        cc.resume(with: result)
        return true
    }

    func resume(throwing error: Error) {
        lock.lock()
        let cc = continuation
        continuation = nil
        lock.unlock()
        cc?.resume(throwing: error)
    }
}

public enum GuestAgentError: Error, CustomStringConvertible, Sendable {
    case notConnected(String)
    case framing(String)
    case ioFailure(String)
    case remote(String)
    case timeout(String)

    public var description: String {
        switch self {
        case .notConnected(let m): return "agent.notConnected: \(m)"
        case .framing(let m): return "agent.framing: \(m)"
        case .ioFailure(let m): return "agent.ioFailure: \(m)"
        case .remote(let m): return "agent.remote: \(m)"
        case .timeout(let m): return "agent.timeout: \(m)"
        }
    }
}

/// Protocol every guest-agent client implements. Single in-process actor
/// per VM, owned by VMInstance.
public protocol GuestAgent: Sendable {
    /// Dial the guest agent. Implementation depends on transport (vsock
    /// for Linux + macOS-on-macOS; SSH fallback later).
    func connect(timeout: TimeInterval) async throws

    /// Send one request and wait for its matching response. JSON dict in,
    /// JSON dict out. Returns the `result` envelope.
    func request(_ action: GuestAgentDict, timeout: TimeInterval) async throws -> GuestAgentDict

    /// Close the underlying transport.
    func disconnect() async
}

/// Convenience helpers built atop `request(_:)`.
public extension GuestAgent {
    func control(_ verb: String, params: [String: Any] = [:], timeout: TimeInterval = 30) async throws -> [String: Any] {
        var action = params
        action["verb"] = verb
        let r = try await request(GuestAgentDict(action), timeout: timeout).dict
        let success = r["success"] as? Bool ?? false
        if !success {
            throw GuestAgentError.remote(r["error"] as? String ?? "\(verb) failed")
        }
        return (r["data"] as? [String: Any]) ?? r
    }

    func exec(_ argv: [String], env: [String: String] = [:], workdir: String? = nil, tty: Bool = false, timeout: TimeInterval = 50) async throws -> (exitCode: Int32, stdout: String, stderr: String, durationMs: Int) {
        var action: [String: Any] = ["verb": "exec", "argv": argv, "env": env, "tty": tty, "timeout": timeout]
        if let w = workdir { action["workdir"] = w }
        let responseTimeout = timeout > 0 ? timeout + 5 : timeout
        let r = try await request(GuestAgentDict(action), timeout: responseTimeout).dict
        let success = r["success"] as? Bool ?? false
        if !success {
            throw GuestAgentError.remote(r["error"] as? String ?? "exec failed")
        }
        guard let payload = r["data"] as? [String: Any], JSONSerialization.isValidJSONObject(payload) else {
            throw GuestAgentError.framing("exec success omitted its actual result; inspect guest effects before retrying")
        }
        let bytes = try JSONSerialization.data(withJSONObject: payload)
        guard bytes.count <= 1_048_576 else { throw GuestAgentError.framing("exec reply exceeds 1MiB; guest effects were not rolled back") }
        let data: DesktopVmExecution
        do { data = try JSONDecoder().decode(DesktopVmExecution.self, from: bytes) }
        catch { throw GuestAgentError.framing("exec reply needs actual exitCode, stdout, stderr and durationMs: \(error)") }
        guard data.exitCode.isFinite, data.exitCode.rounded(.towardZero) == data.exitCode,
              data.exitCode >= Double(Int32.min), data.exitCode <= Double(Int32.max),
              data.durationMs.isFinite, data.durationMs.rounded(.towardZero) == data.durationMs,
              data.durationMs >= 0, data.durationMs <= 58_000,
              data.stdout.utf8.count + data.stderr.utf8.count <= 131_072 else {
            throw GuestAgentError.framing("exec reply has impossible counters or oversized output; inspect guest effects before retrying")
        }
        return (Int32(data.exitCode), data.stdout, data.stderr, Int(data.durationMs))
    }

    func getIP(timeout: TimeInterval = 10) async throws -> String? {
        let r = try await request(GuestAgentDict(["verb": "get_ip"]), timeout: timeout).dict
        let data = r["data"] as? [String: Any]
        return data?["ipAddress"] as? String
    }

    func screenshot(out: String? = nil, timeout: TimeInterval = 30) async throws -> [String: Any] {
        var params: [String: Any] = [:]
        if let out { params["out"] = out }
        return try await control("screenshot", params: params, timeout: timeout)
    }

    func readAX(maxDepth: Int? = nil, app: String? = nil, timeout: TimeInterval = 30) async throws -> [String: Any] {
        var params: [String: Any] = [:]
        if let maxDepth { params["max_depth"] = maxDepth }
        if let app { params["app"] = app }
        return try await control("read_ax", params: params, timeout: timeout)
    }

    func click(x: Double, y: Double, button: String = "left", timeout: TimeInterval = 10) async throws -> [String: Any] {
        try await control("click", params: ["x": x, "y": y, "button": button], timeout: timeout)
    }

    func typeText(_ text: String, timeout: TimeInterval = 30) async throws -> [String: Any] {
        try await control("type", params: ["text": text], timeout: timeout)
    }

    func keys(_ keys: String, timeout: TimeInterval = 10) async throws -> [String: Any] {
        try await control("keys", params: ["keys": keys], timeout: timeout)
    }

    func mount(tag: String, path: String, timeout: TimeInterval = 30) async throws -> [String: Any] {
        try await control("mount", params: ["tag": tag, "path": path], timeout: timeout)
    }

    func trust(timeout: TimeInterval = 10) async throws -> [String: Any] {
        try await control("trust", timeout: timeout)
    }

    func logs(limit: Int? = nil, timeout: TimeInterval = 10) async throws -> [String: Any] {
        var params: [String: Any] = [:]
        if let limit { params["limit"] = limit }
        return try await control("logs", params: params, timeout: timeout)
    }

    func copyIn(path: String, data: Data, mode: String? = nil, timeout: TimeInterval = 50) async throws -> [String: Any] {
        guard data.count <= 1_048_576 else { throw GuestAgentError.framing("guest copy is capped at1MiB") }
        guard timeout.isFinite, timeout > 0, timeout <= 50 else { throw GuestAgentError.framing("guest copy budget must be positive and at most 50s") }
        let deadline = try GuestWire.Deadline(seconds: timeout)
        let probe = try await request(GuestAgentDict(["verb": "ping"]), timeout: deadline.remaining()).dict
        try GuestWire.requireExclusiveCopy(probe)
        var action: [String: Any] = ["verb": "cp_in", "path": path, "dataBase64": data.base64EncodedString(), "timeout": try deadline.remaining()]
        if let mode { action["mode"] = mode }
        let reply = try await request(GuestAgentDict(action), timeout: deadline.remaining()).dict
        try GuestWire.verifyCopied(reply, path: path, data: data)
        return reply["data"] as! [String: Any]
    }

    func copyOut(path: String, timeout: TimeInterval = 50) async throws -> [String: Any] {
        guard timeout.isFinite, timeout > 0, timeout <= 50 else { throw GuestAgentError.framing("guest copy budget must be positive and at most 50s") }
        let deadline = try GuestWire.Deadline(seconds: timeout)
        let probe = try await request(GuestAgentDict(["verb": "ping"]), timeout: deadline.remaining()).dict
        try GuestWire.requireExclusiveCopy(probe)
        let reply = try await request(GuestAgentDict(["verb": "cp_out", "path": path, "timeout": try deadline.remaining()]), timeout: deadline.remaining()).dict
        _ = try GuestWire.copyBytes(reply, path: path)
        return reply["data"] as! [String: Any]
    }
}

/// Concrete vsock-backed agent. Owns the raw fd from
/// `VZVirtioSocketConnection.fileDescriptor`. Descriptor and connection state
/// are serialized through a dedicated dispatch queue, which is async-safe
/// under Swift 6 strict concurrency where NSLock.lock() is not.
@available(macOS 11.0, *)
private actor GuestAgentRequestLock {
    private var locked = false
    func acquire() -> Bool {
        guard !locked else { return false }
        locked = true
        return true
    }
    func unlock() { locked = false }
}

@available(macOS 11.0, *)
public final class VsockGuestAgent: GuestAgent, @unchecked Sendable {
    private let socketDevice: VZVirtioSocketDevice
    private let connectQueue: DispatchQueue?
    private let port: UInt32
    private let stateQueue = DispatchQueue(label: "interceptor.bridge.vsockAgent")
    // This fd is owned by the client, not borrowed from a VZ connection.
    private var fd: Int32 = -1
    private var tcpFallbackHost: String?
    private var retainedConnection: AnyObject?
    private var generation: UInt64 = 0
    private var quarantine: String?
    private let requestLock = GuestAgentRequestLock()
    private let connectLock = GuestAgentRequestLock()

#if canImport(Virtualization)
    public init(socketDevice: VZVirtioSocketDevice, connectQueue: DispatchQueue? = nil, port: UInt32 = kInterceptorGuestAgentPort, tcpFallbackHost: String? = nil) {
        self.socketDevice = socketDevice
        self.connectQueue = connectQueue
        self.port = port
        self.tcpFallbackHost = tcpFallbackHost
    }
#endif

    deinit {
        closeConnection()
    }

    public func setTCPFallbackHost(_ host: String?) {
        stateQueue.sync { tcpFallbackHost = host }
    }

    private func requireAvailable() throws {
        try stateQueue.sync {
            if let quarantine {
                throw GuestAgentError.notConnected(quarantine + "; inspect guest effects and restart the owned VM before another guest request")
            }
        }
    }

    private func closeConnection(reason: String? = nil) {
        let oldConnection: AnyObject? = stateQueue.sync {
            generation &+= 1
            if let reason, quarantine == nil { quarantine = reason }
            if fd >= 0 {
                _ = Darwin.shutdown(fd, SHUT_RDWR)
                Darwin.close(fd)
                fd = -1
            }
            let previous = retainedConnection
            retainedConnection = nil
            return previous
        }
        if let connection = oldConnection as? VZVirtioSocketConnection {
            let owned = UncheckedSendableBox(connection)
            if let connectQueue { connectQueue.async { owned.value.close() } }
            else { connection.close() }
        }
    }

    private func retainConnection(_ connection: AnyObject, fd connectionFd: Int32, generation expected: UInt64) throws -> Int32 {
        try stateQueue.sync {
            guard generation == expected, quarantine == nil, fd < 0 else {
                throw GuestAgentError.notConnected("late or replaced guest connection refused")
            }
            let owned = Darwin.fcntl(connectionFd, F_DUPFD_CLOEXEC, 0)
            guard owned >= 0 else { throw GuestAgentError.ioFailure("cannot retain guest connection descriptor: \(errno)") }
            retainedConnection = connection
            fd = owned
            return owned
        }
    }

    public func connect(timeout: TimeInterval = 30) async throws {
        let deadline = try GuestWire.Deadline(seconds: timeout)
        guard await connectLock.acquire() else { throw GuestAgentError.notConnected("another guest connection is being admitted") }
        do {
            try await connectUnlocked(deadline: deadline)
            await connectLock.unlock()
        } catch {
            closeConnection()
            await connectLock.unlock()
            throw error
        }
    }

    private func connectUnlocked(deadline: GuestWire.Deadline) async throws {
        try requireAvailable()
        let initial = stateQueue.sync { (fd, generation) }
        if initial.0 >= 0 { return }
        var lastError: Error?
        while true {
            try requireAvailable()
            let remaining: TimeInterval
            do { remaining = try deadline.remaining() }
            catch { throw GuestAgentError.notConnected("guest connection deadline expired: \(lastError.map { "\($0)" } ?? "no successful connection")") }
            let attemptTimeout = min(5, remaining)
            do {
                if let host = stateQueue.sync(execute: { tcpFallbackHost }), !host.isEmpty {
                    let connected = try Self.connectTCP(host: host, port: port, timeout: attemptTimeout)
                    try stateQueue.sync {
                        guard generation == initial.1, fd < 0, quarantine == nil else {
                            Darwin.close(connected)
                            throw GuestAgentError.notConnected("late or replaced TCP connection refused")
                        }
                        fd = connected
                    }
                } else {
                    _ = try await connectVsockAttempt(timeout: attemptTimeout, generation: initial.1)
                }
                _ = try deadline.remaining()
                return
            } catch {
                lastError = error
                guard stateQueue.sync(execute: { generation == initial.1 }) else { throw error }
                let pause = min(0.2, try deadline.remaining())
                try await Task.sleep(nanoseconds: UInt64(pause * 1e9))
            }
        }
    }

    private func connectVsockAttempt(timeout: TimeInterval, generation: UInt64) async throws -> Int32 {
        let device = socketDevice, queue = connectQueue, port = port
        return try await withCheckedThrowingContinuation { cc in
            let gate = GuestAgentConnectContinuation(cc)
            let startConnect = {
                device.connect(toPort: port) { result in
                    switch result {
                    case .success(let connection):
                        let admitted = gate.complete {
                            do {
                                guard connection.fileDescriptor >= 0 else {
                                    throw GuestAgentError.notConnected("vsock connection closed before descriptor admission")
                                }
                                return try self.retainConnection(connection, fd: connection.fileDescriptor, generation: generation)
                            } catch {
                                connection.close()
                                throw error
                            }
                        }
                        if !admitted { connection.close() }
                    case .failure(let error):
                        gate.resume(throwing: GuestAgentError.notConnected("vsock port \(port): \(error.localizedDescription)"))
                    }
                }
            }
            if let queue { queue.async(execute: startConnect) } else { startConnect() }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout) {
                gate.resume(throwing: GuestAgentError.timeout("vsock connection deadline expired"))
            }
        }
    }

    private static func connectTCP(host: String, port: UInt32, timeout: TimeInterval) throws -> Int32 {
        guard port > 0, port <= UInt32(UInt16.max), timeout.isFinite, timeout > 0, timeout <= 58 else {
            throw GuestAgentError.notConnected("TCP guest connection needs a valid port and bounded budget")
        }
        let sock = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else {
            throw GuestAgentError.ioFailure("tcp socket: \(String(cString: strerror(errno)))")
        }

        let originalFlags = Darwin.fcntl(sock, F_GETFL, 0)
        guard originalFlags >= 0 else {
            let message = String(cString: strerror(errno))
            Darwin.close(sock)
            throw GuestAgentError.ioFailure("tcp fcntl(F_GETFL): \(message)")
        }
        guard Darwin.fcntl(sock, F_SETFL, originalFlags | O_NONBLOCK) == 0 else {
            let message = String(cString: strerror(errno))
            Darwin.close(sock)
            throw GuestAgentError.ioFailure("tcp fcntl(F_SETFL): \(message)")
        }

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        let parsed = host.withCString { inet_pton(AF_INET, $0, &addr.sin_addr) }
        guard parsed == 1 else {
            Darwin.close(sock)
            throw GuestAgentError.notConnected("tcp fallback host is not IPv4: \(host)")
        }

        let addrSize = socklen_t(MemoryLayout<sockaddr_in>.size)
        let connectResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sptr in
                Darwin.connect(sock, sptr, addrSize)
            }
        }
        if connectResult == 0 {
            _ = Darwin.fcntl(sock, F_SETFL, originalFlags)
            return sock
        }

        let connectErrno = errno
        guard connectErrno == EINPROGRESS else {
            let message = String(cString: strerror(connectErrno))
            Darwin.close(sock)
            throw GuestAgentError.notConnected("tcp connect \(host):\(port): \(message)")
        }

        let timeoutMs: Int32
        if timeout <= 0 {
            timeoutMs = -1
        } else {
            timeoutMs = Int32(min(Double(Int32.max), ceil(timeout * 1000)))
        }
        var pfd = pollfd(fd: sock, events: Int16(POLLOUT), revents: 0)
        let pollResult = Darwin.poll(&pfd, 1, timeoutMs)
        guard pollResult > 0 else {
            let message = pollResult == 0 ? "after \(Int(timeout))s" : String(cString: strerror(errno))
            Darwin.close(sock)
            if pollResult == 0 {
                throw GuestAgentError.timeout("tcp connect \(host):\(port) \(message)")
            }
            throw GuestAgentError.notConnected("tcp connect \(host):\(port): \(message)")
        }

        var socketError: Int32 = 0
        var socketErrorLength = socklen_t(MemoryLayout<Int32>.size)
        guard Darwin.getsockopt(sock, SOL_SOCKET, SO_ERROR, &socketError, &socketErrorLength) == 0 else {
            let message = String(cString: strerror(errno))
            Darwin.close(sock)
            throw GuestAgentError.ioFailure("tcp getsockopt(SO_ERROR): \(message)")
        }
        guard socketError == 0 else {
            let message = String(cString: strerror(socketError))
            Darwin.close(sock)
            throw GuestAgentError.notConnected("tcp connect \(host):\(port): \(message)")
        }

        _ = Darwin.fcntl(sock, F_SETFL, originalFlags)
        return sock
    }


    public func request(_ action: GuestAgentDict, timeout: TimeInterval = 58) async throws -> GuestAgentDict {
        let deadline = try GuestWire.Deadline(seconds: timeout)
        guard await requestLock.acquire() else {
            throw GuestAgentError.notConnected("another guest request still owns admission; nothing was sent")
        }
        do {
            let result = try await requestUnlocked(action, deadline: deadline)
            await requestLock.unlock()
            return result
        } catch {
            await requestLock.unlock()
            throw error
        }
    }

    private func requestUnlocked(_ action: GuestAgentDict, deadline: GuestWire.Deadline) async throws -> GuestAgentDict {
        try requireAvailable()
        let id = UUID().uuidString
        let payload: [String: Any] = ["id": id, "action": action.dict]
        _ = try GuestWire.requestID(payload)
        let frame = try GuestWire.encode(payload)
        // A connection carries one exchange. Discard a read-only startup
        // probe connection before sending the first bytes of this request.
        closeConnection()
        try await connect(timeout: deadline.remaining())
        let requestFD: Int32 = try stateQueue.sync {
            guard fd >= 0, quarantine == nil else { throw GuestAgentError.notConnected("guest connection disappeared before admission") }
            let owned = Darwin.fcntl(fd, F_DUPFD_CLOEXEC, 0)
            guard owned >= 0 else { throw GuestAgentError.ioFailure("cannot retain exchange socket: \(errno)") }
            return owned
        }
        defer { Darwin.close(requestFD) }
        var submitted = false
        do {
            _ = try deadline.remaining()
            submitted = true
            try GuestWire.write(fd: requestFD, frame: frame, deadline: deadline)
            let result = try GuestWire.result(GuestWire.read(fd: requestFD, deadline: deadline), for: id)
            _ = try deadline.remaining()
            closeConnection()
            return GuestAgentDict(result)
        } catch {
            if submitted {
                closeConnection(reason: "guest request outcome is unknown after submission: \(error)")
                throw GuestAgentError.timeout("guest request outcome is unknown: \(error); no reconnect or replay was performed")
            }
            closeConnection()
            throw error
        }
    }

    public func disconnect() async {
        closeConnection(reason: "guest agent was disconnected")
    }
}
