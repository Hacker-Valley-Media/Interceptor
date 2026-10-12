// Verification suite for the per-fd async-dispatch +
// per-fd write-serialization model in Transport.swift.
//
// These tests cover:
//   1. Two concurrent requests on the same fd both reach `router.route`
//      before either completes.
//   2. With one synthetic ~5s slow request in flight, an interleaved fast
//      request still completes in <500 ms.
//   3. 100 concurrent requests on one fd produce 100 cleanly-decoded
//      responses (no interleaved frame bytes on the wire).
//
// Strategy: each test creates a `socketpair(AF_UNIX, SOCK_STREAM)`, hands
// one end to `Transport.handleClient` on a background thread, registers a
// `BlockingTestDomain` on a `Router`, and writes/reads framed JSON
// directly on the other end. This exercises the full read loop, worker
// dispatch, write-queue serialization, and shutdown-drain path.

import XCTest
import Darwin
@testable import interceptor_bridge

/// Test domain that lets each test stage requests with caller-controlled
/// latency. The router dispatches `macos_test_<command>`; the command
/// becomes the lookup key into `replies`.
final class BlockingTestDomain: DomainHandler, @unchecked Sendable {
    struct Reply {
        let delay: TimeInterval
        let payload: [String: Any]
    }

    private let lock = NSLock()
    private var replies: [String: Reply] = [:]
    private(set) var receivedAt: [String: Date] = [:]

    func arm(_ command: String, delay: TimeInterval, payload: [String: Any] = [:]) {
        lock.lock()
        replies[command] = Reply(delay: delay, payload: payload)
        lock.unlock()
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        let reply = replies[command]
        receivedAt[command] = Date()
        lock.unlock()

        let delay = reply?.delay ?? 0
        let payloadBox = UncheckedSendableBox(reply?.payload ?? [String: Any]())
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) {
            var merged = payloadBox.value
            merged["command"] = command
            completion(WireFormat.success(merged))
        }
    }
}

/// Helpers around the framed wire protocol (4-byte LE length + JSON).
enum TestFrame {
    static func encode(_ obj: [String: Any]) -> Data {
        let body = try! JSONSerialization.data(withJSONObject: obj)
        var len = UInt32(body.count)
        var out = Data(bytes: &len, count: 4)
        out.append(body)
        return out
    }

    static func readFrame(fd: Int32, timeoutSeconds: Int = 10) -> [String: Any]? {
        let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
        var buf = [UInt8](repeating: 0, count: 65536)

        func readOnce(into target: inout Data, want: Int) -> Bool {
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 { return false }
            var tv = timeval(tv_sec: Int(remaining), tv_usec: 0)
            var rfds = fd_set()
            withUnsafeMutablePointer(to: &rfds) { ptr in
                let raw = UnsafeMutableRawPointer(ptr)
                memset(raw, 0, MemoryLayout<fd_set>.size)
            }
            let intOffset = Int(fd) / 32
            let bitOffset = Int32(fd) % 32
            withUnsafeMutablePointer(to: &rfds.fds_bits) { tuplePtr in
                tuplePtr.withMemoryRebound(to: Int32.self, capacity: 32) { wordPtr in
                    wordPtr[intOffset] |= (Int32(1) << bitOffset)
                }
            }
            let rc = Darwin.select(fd + 1, &rfds, nil, nil, &tv)
            if rc <= 0 { return false }
            let n = buf.withUnsafeMutableBufferPointer { bufPtr in
                Darwin.read(fd, bufPtr.baseAddress!, want)
            }
            if n <= 0 { return false }
            target.append(buf, count: n)
            return true
        }

        var header = Data()
        while header.count < 4 {
            if !readOnce(into: &header, want: 4 - header.count) { return nil }
        }
        let len: UInt32 = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        var body = Data()
        while body.count < Int(len) {
            let need = Int(len) - body.count
            if !readOnce(into: &body, want: min(need, 65536)) { return nil }
        }
        return try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    }
}

final class TransportConcurrencyTests: XCTestCase {
    func testSocketAddressPreservesExactUTF8PathAndRejectsTruncation() throws {
        for path in ["/tmp/owned.sock", "/" + String(repeating: "x", count: 102), "/tmp/通知.sock"] {
            var address = try Transport.socketAddress(path)
            let actual = withUnsafePointer(to: &address.sun_path) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: 104) { String(cString: $0) }
            }
            XCTAssertEqual(actual, path)
            XCTAssertEqual(address.sun_family, sa_family_t(AF_UNIX))
        }
        for path in ["", "/tmp/owned\u{0000}other", "/" + String(repeating: "x", count: 103), "/" + String(repeating: "通", count: 35)] {
            XCTAssertThrowsError(try Transport.socketAddress(path)) { error in
                XCTAssertEqual((error as NSError).code, 4)
                XCTAssertTrue(error.localizedDescription.contains("UTF-8 bytes"))
            }
        }
    }
    private var pair: (server: Int32, client: Int32) = (-1, -1)
    private var serverThread: Thread?
    private var router: Router!
    private var domain: BlockingTestDomain!

    override func setUp() {
        super.setUp()
        signal(SIGPIPE, SIG_IGN)

        var fds: [Int32] = [-1, -1]
        let rc = fds.withUnsafeMutableBufferPointer { ptr in
            Darwin.socketpair(AF_UNIX, SOCK_STREAM, 0, ptr.baseAddress!)
        }
        XCTAssertEqual(rc, 0, "socketpair failed: \(String(cString: strerror(errno)))")
        pair = (server: fds[0], client: fds[1])

        domain = BlockingTestDomain()
        router = Router()
        router.register("test", handler: domain)

        let serverFD = pair.server
        let r = router!
        let thread = Thread {
            Transport.handleClient(fd: serverFD, router: r)
        }
        thread.qualityOfService = .userInitiated
        thread.start()
        serverThread = thread
    }

    override func tearDown() {
        if pair.client >= 0 { Darwin.close(pair.client) }
        let deadline = Date().addingTimeInterval(5)
        while let t = serverThread, !t.isFinished, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        pair = (-1, -1)
        serverThread = nil
        router = nil
        domain = nil
        super.tearDown()
    }

    func testTwoConcurrentRequestsBothReachRouterBeforeEitherCompletes() throws {
        domain.arm("a", delay: 0.6)
        domain.arm("b", delay: 0.6)

        let frameA = TestFrame.encode(["id": "req-a", "action": ["type": "macos_test_a"]])
        let frameB = TestFrame.encode(["id": "req-b", "action": ["type": "macos_test_b"]])

        let writeStart = Date()
        _ = frameA.withUnsafeBytes { Darwin.write(pair.client, $0.baseAddress!, frameA.count) }
        _ = frameB.withUnsafeBytes { Darwin.write(pair.client, $0.baseAddress!, frameB.count) }

        let r1 = TestFrame.readFrame(fd: pair.client, timeoutSeconds: 5)
        let r2 = TestFrame.readFrame(fd: pair.client, timeoutSeconds: 5)
        let totalElapsed = Date().timeIntervalSince(writeStart)

        XCTAssertNotNil(r1, "first response missing")
        XCTAssertNotNil(r2, "second response missing")
        XCTAssertLessThan(totalElapsed, 1.0, "responses arrived sequentially (≥1.0s elapsed) — handleClient is still serializing per-fd")

        let aAt = domain.receivedAt["a"]
        let bAt = domain.receivedAt["b"]
        XCTAssertNotNil(aAt)
        XCTAssertNotNil(bAt)
        if let aAt = aAt, let bAt = bAt {
            XCTAssertLessThan(abs(aAt.timeIntervalSince(bAt)), 0.2,
                "router.route did not get both requests near-simultaneously — read loop is blocked")
        }
    }

    func testDuplicateRequestDoesNotReachRouter() throws {
        domain.arm("original", delay: 0)
        domain.arm("duplicate", delay: 0)
        for command in ["original", "duplicate"] {
            let frame = TestFrame.encode(["id": "repeated", "action": ["type": "macos_test_\(command)"]])
            _ = frame.withUnsafeBytes { Darwin.write(pair.client, $0.baseAddress!, frame.count) }
        }
        let replies = [TestFrame.readFrame(fd: pair.client), TestFrame.readFrame(fd: pair.client)]
        XCTAssertEqual(replies.compactMap { ($0?["result"] as? [String: Any])?["success"] as? Bool }.sorted { !$0 && $1 }, [false, true])
        let refused = replies.compactMap { $0?["result"] as? [String: Any] }.first { $0["success"] as? Bool == false }
        XCTAssertEqual(refused?["code"] as? String, "invalid_request")
        XCTAssertTrue((refused?["error"] as? String)?.contains("duplicate") == true)
        XCTAssertNotNil(domain.receivedAt["original"])
        XCTAssertNil(domain.receivedAt["duplicate"])
    }

    func testConnectionOutlivesRequestIdWindowAndStillRefusesRecentDuplicates() throws {
        domain.arm("seq", delay: 0)
        func write(_ id: String) {
            let frame = TestFrame.encode(["id": id, "action": ["type": "macos_test_seq"]])
            _ = frame.withUnsafeBytes { Darwin.write(pair.client, $0.baseAddress!, frame.count) }
        }
        func send(_ id: String) -> [String: Any]? {
            write(id)
            return TestFrame.readFrame(fd: pair.client, timeoutSeconds: 5)?["result"] as? [String: Any]
        }
        for start in stride(from: 0, through: Transport.requestIdWindow, by: 128) {
            let batch = start..<min(start + 128, Transport.requestIdWindow + 1)
            for i in batch { write("seq-\(i)") }
            for _ in batch {
                guard (TestFrame.readFrame(fd: pair.client, timeoutSeconds: 5)?["result"] as? [String: Any])?["success"] as? Bool == true else {
                    return XCTFail("a request near \(start) was refused or the connection closed")
                }
            }
        }
        let duplicate = send("seq-\(Transport.requestIdWindow)")
        XCTAssertEqual(duplicate?["success"] as? Bool, false)
        XCTAssertTrue((duplicate?["error"] as? String)?.contains("duplicate") == true)
        XCTAssertEqual(send("seq-0")?["success"] as? Bool, true, "the oldest id should have left the window")
    }

    func testNeutralEnvelopeIsValidatedBeforeDispatchWithoutChangingLegacyRequests() throws {
        router.register("desktop", handler: domain)
        domain.arm("desktop", delay: 0)
        let invalid: [([String: Any], String)] = [
            (["id": "wrong-version", "protocolVersion": 99], "version_mismatch"),
            (["id": "fraction-version", "protocolVersion": 1.5], "version_mismatch"),
            (["id": "string-version", "protocolVersion": "1"], "invalid_request"),
            (["id": "bool-version", "protocolVersion": true], "invalid_request"),
            (["id": "null-version", "protocolVersion": NSNull()], "invalid_request"),
            (["id": "null-token", "token": NSNull()], "invalid_request"),
            (["id": "array-token", "token": []], "invalid_request"),
            (["protocolVersion": 1], "invalid_request"),
            (["id": 42, "protocolVersion": 1], "invalid_request"),
        ]
        for (fields, code) in invalid {
            var request = fields; request["action"] = ["type": "macos_desktop"]
            let frame = TestFrame.encode(request)
            _ = frame.withUnsafeBytes { Darwin.write(pair.client, $0.baseAddress!, frame.count) }
            let reply = TestFrame.readFrame(fd: pair.client)
            let result = reply?["result"] as? [String: Any]
            XCTAssertEqual(result?["success"] as? Bool, false)
            XCTAssertEqual(result?["code"] as? String, code)
        }
        XCTAssertNil(domain.receivedAt["desktop"], "invalid neutral envelopes reached the handler")
        for request: [String: Any] in [
            ["id": "valid", "protocolVersion": 1, "token": "opaque", "action": ["type": "macos_desktop"]],
            ["id": "omitted-version", "action": ["type": "macos_desktop"]],
            ["protocolVersion": 99, "action": ["type": "macos_test_legacy"]],
        ] {
            let frame = TestFrame.encode(request)
            _ = frame.withUnsafeBytes { Darwin.write(pair.client, $0.baseAddress!, frame.count) }
            let reply = TestFrame.readFrame(fd: pair.client)
            XCTAssertEqual((reply?["result"] as? [String: Any])?["success"] as? Bool, true)
            XCTAssertFalse((reply?["id"] as? String ?? "").isEmpty)
        }
        XCTAssertNotNil(domain.receivedAt["legacy"])
    }

    func testFastRequestNotStarvedBySlowRequest() throws {
        domain.arm("slow", delay: 5.0)
        domain.arm("fast", delay: 0.05)

        let slow = TestFrame.encode(["id": "req-slow", "action": ["type": "macos_test_slow"]])
        let fast = TestFrame.encode(["id": "req-fast", "action": ["type": "macos_test_fast"]])

        let start = Date()
        _ = slow.withUnsafeBytes { Darwin.write(pair.client, $0.baseAddress!, slow.count) }
        usleep(20_000)
        _ = fast.withUnsafeBytes { Darwin.write(pair.client, $0.baseAddress!, fast.count) }

        guard let firstResp = TestFrame.readFrame(fd: pair.client, timeoutSeconds: 2) else {
            XCTFail("fast response did not arrive within 2s — slow request is starving the fd")
            return
        }
        let firstResponseElapsed = Date().timeIntervalSince(start)
        XCTAssertEqual(firstResp["id"] as? String, "req-fast",
            "expected fast response first, got \(firstResp["id"] ?? "nil")")
        XCTAssertLessThan(firstResponseElapsed, 0.5,
            "fast request took \(firstResponseElapsed)s — should be <500ms")
    }

    func testBackpressuredResponseIsWrittenInFull() throws {
        var capacity: Int32 = 4096
        var timeout = timeval(tv_sec: 0, tv_usec: 100_000)
        XCTAssertEqual(setsockopt(pair.server, SOL_SOCKET, SO_SNDBUF, &capacity, socklen_t(MemoryLayout.size(ofValue: capacity))), 0)
        XCTAssertEqual(setsockopt(pair.server, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout))), 0)
        let body = String(repeating: "x", count: 524_288)
        domain.arm("large", delay: 0, payload: ["body": body])
        let request = TestFrame.encode(["id": "large", "action": ["type": "macos_test_large"]])
        _ = request.withUnsafeBytes { Darwin.write(pair.client, $0.baseAddress!, request.count) }
        Thread.sleep(forTimeInterval: 0.3)
        let response = TestFrame.readFrame(fd: pair.client, timeoutSeconds: 3)
        XCTAssertEqual(response?["id"] as? String, "large")
        let data = (response?["result"] as? [String: Any])?["data"] as? [String: Any]
        XCTAssertEqual((data?["body"] as? String)?.count, body.count)
        XCTAssertTrue(data?["body"] as? String == body, "large frame body was truncated or corrupted")
    }

    func testManyConcurrentRequestsAllDecodeCleanly() throws {
        let n = 100
        for i in 0..<n {
            domain.arm("req\(i)", delay: 0.0)
        }

        for i in 0..<n {
            let frame = TestFrame.encode([
                "id": "id-\(i)",
                "action": ["type": "macos_test_req\(i)"],
            ])
            _ = frame.withUnsafeBytes { Darwin.write(pair.client, $0.baseAddress!, frame.count) }
        }

        var seenIds = Set<String>()
        for _ in 0..<n {
            guard let resp = TestFrame.readFrame(fd: pair.client, timeoutSeconds: 5) else {
                XCTFail("ran out of responses; collected \(seenIds.count)/\(n) before timeout")
                return
            }
            guard let id = resp["id"] as? String else {
                XCTFail("response missing id: \(resp)")
                return
            }
            XCTAssertTrue(seenIds.insert(id).inserted, "duplicate response id \(id)")
        }
        XCTAssertEqual(seenIds.count, n)
    }

    func testDisconnectedReaderCannotSignalTheBridge() throws {
        domain.arm("disconnect", delay: 0.1, payload: ["body": String(repeating: "x", count: 524_288)])
        let request = TestFrame.encode(["id": "disconnect", "action": ["type": "macos_test_disconnect"]])
        _ = request.withUnsafeBytes { Darwin.write(pair.client, $0.baseAddress!, request.count) }
        let configured = Date().addingTimeInterval(1)
        var noSignal: Int32 = 0
        var size = socklen_t(MemoryLayout.size(ofValue: noSignal))
        repeat {
            XCTAssertEqual(getsockopt(pair.server, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, &size), 0)
            if noSignal == 1 { break }
            Thread.sleep(forTimeInterval: 0.01)
        } while Date() < configured
        XCTAssertEqual(noSignal, 1)
        XCTAssertEqual(Darwin.shutdown(pair.client, SHUT_RDWR), 0)
        let deadline = Date().addingTimeInterval(3)
        while serverThread?.isFinished == false && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        XCTAssertTrue(serverThread?.isFinished == true, "disconnected client retained the transport thread")
    }

    func testUnreadResponseEndsConnectionAtWriteDeadline() throws {
        var capacity: Int32 = 4096
        XCTAssertEqual(setsockopt(pair.server, SOL_SOCKET, SO_SNDBUF, &capacity, socklen_t(MemoryLayout.size(ofValue: capacity))), 0)
        domain.arm("blocked", delay: 0, payload: ["body": String(repeating: "x", count: 524_288)])
        let request = TestFrame.encode(["id": "blocked", "action": ["type": "macos_test_blocked"]])
        let start = Date()
        _ = request.withUnsafeBytes { Darwin.write(pair.client, $0.baseAddress!, request.count) }
        let deadline = start.addingTimeInterval(18)
        while serverThread?.isFinished == false && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        XCTAssertTrue(serverThread?.isFinished == true, "unread response exceeded its bounded write deadline")
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(start), 14.5)
    }

    func testNeutralTypesPreserveLegacyRoutingAndAccessibilityDenial() throws {
        let trusted = Router(axTrustCheck: { true })
        trusted.register("test", handler: domain)
        trusted.register("desktop", handler: domain)
        domain.arm("alias", delay: 0)
        domain.arm("desktop", delay: 0)
        for type in ["desktop_test_alias", "macos_test_alias", "desktop_hello", "desktop_capabilities"] {
            let replied = expectation(description: type)
            trusted.route(action: ["type": type]) { result in
                XCTAssertEqual(result["success"] as? Bool, true)
                let command = (result["data"] as? [String: Any])?["command"] as? String
                XCTAssertEqual(command, type.hasSuffix("alias") ? "alias" : "desktop")
                replied.fulfill()
            }
            wait(for: [replied], timeout: 1)
        }
        let untrusted = Router(axTrustCheck: { false })
        for key in ["tree", "find", "inspect", "value", "action", "focused", "windows", "resize", "move", "click", "type", "keys", "scroll", "drag", "menu", "text", "bginput", "authdialog"] {
            untrusted.register(key, handler: domain)
            let refused = expectation(description: key)
            var action: [String: Any] = ["type": "desktop_\(key)"]
            if ["inspect", "value", "action", "click", "type", "text", "resize", "move"].contains(key) { action["ref"] = "e1" }
            if key == "resize" { action["width"] = 640; action["height"] = 480 }
            if key == "move" { action["x"] = 0; action["y"] = 0 }
            if key == "type" { action["text"] = "permission gate fixture" }
            if key == "find" { action["query"] = "permission gate fixture" }
            if key == "keys" { action["keys"] = "cmd+a" }
            if key == "scroll" { action["direction"] = "down"; action["amount"] = 100 }
            if key == "drag" { action["from"] = "e1"; action["to"] = "e2" }
            untrusted.route(action: action) { result in
                XCTAssertEqual(result["success"] as? Bool, false)
                let neutral = DesktopAccessibilityShape.operations.contains("desktop_\(key)")
                XCTAssertEqual(result["code"] as? String, neutral ? "permission_required" : "accessibility_unusable")
                if neutral {
                    XCTAssertEqual((result["details"] as? [String: Any])?["nativeCode"] as? String, "accessibility_unusable")
                    XCTAssertEqual(((result["details"] as? [String: Any])?["axError"] as? [String: Any])?["code"] as? Int, -25211)
                }
                refused.fulfill()
            }
            wait(for: [refused], timeout: 1)
            XCTAssertNil(domain.receivedAt[key])
        }
        for type in ["desktop_test_alias\n", "desktop_", "desktop_🙂"] {
            let refused = expectation(description: type)
            trusted.route(action: ["type": type]) { result in
                XCTAssertEqual(result["success"] as? Bool, false)
                XCTAssertEqual(result["code"] as? String, "invalid_request")
                refused.fulfill()
            }
            wait(for: [refused], timeout: 1)
        }
    }
}

/// Unit tests for the small Sendable helpers introduced in Transport.swift
/// and ContainerDomain.swift.
final class TransportInternalsTests: XCTestCase {
    func testInflightCounterIncrementsAndDecrements() {
        let c = InflightCounter()
        XCTAssertEqual(c.increment(), 1)
        XCTAssertEqual(c.increment(), 2)
        XCTAssertEqual(c.increment(), 3)
        XCTAssertEqual(c.decrement(), 2)
        XCTAssertEqual(c.decrement(), 1)
        XCTAssertEqual(c.decrement(), 0)
        XCTAssertEqual(c.decrement(), 0)
    }

    func testInflightCounterIsThreadSafe() {
        let c = InflightCounter()
        let g = DispatchGroup()
        let q = DispatchQueue.global(qos: .userInitiated)
        for _ in 0..<1000 {
            g.enter()
            q.async {
                _ = c.increment()
                _ = c.decrement()
                g.leave()
            }
        }
        g.wait()
        XCTAssertEqual(c.increment(), 1, "counter drift after 1000 inc/dec pairs")
    }

    func testLockedDataAccumulatesUnderConcurrency() {
        let d = LockedData()
        let g = DispatchGroup()
        let q = DispatchQueue.global(qos: .userInitiated)
        for i in 0..<100 {
            g.enter()
            q.async {
                d.append(Data([UInt8(i % 256)]))
                g.leave()
            }
        }
        g.wait()
        XCTAssertEqual(d.snapshot().count, 100)
    }

    func testAtomicFlagSetIsOneShot() {
        let f = AtomicFlag()
        XCTAssertTrue(f.set())
        XCTAssertFalse(f.set())
        XCTAssertFalse(f.set())
    }

    func testAtomicFlagIsThreadSafe() {
        let f = AtomicFlag()
        let g = DispatchGroup()
        let q = DispatchQueue.global()
        let firstSetters = LockedCounter()
        for _ in 0..<200 {
            g.enter()
            q.async {
                if f.set() { firstSetters.increment() }
                g.leave()
            }
        }
        g.wait()
        XCTAssertEqual(firstSetters.value, 1, "AtomicFlag.set() granted 'first' to multiple racers")
    }
}

/// Tiny test-only counter (separate from the production `InflightCounter`
/// because we want to assert on exact values).
final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    var value: Int {
        lock.lock(); defer { lock.unlock() }; return n
    }
    func increment() {
        lock.lock(); n += 1; lock.unlock()
    }
}
