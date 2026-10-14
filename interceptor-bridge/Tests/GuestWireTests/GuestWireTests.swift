import XCTest
import Foundation
import Darwin
import CoreFoundation
import GuestWire

final class GuestWireTests: XCTestCase {
    private func sockets() throws -> [Int32] {
        var pair = [Int32](repeating: -1, count: 2)
        guard Darwin.socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        return pair
    }

    func testActualPartialSocketWritesAndPeerCloseKeepTheCompleteReply() throws {
        let pair = try sockets()
        defer { Darwin.close(pair[0]) }
        let id = UUID().uuidString
        let request: [String: Any] = ["id": id, "action": ["verb": "ping"]]
        let reply: [String: Any] = ["id": id, "result": ["success": true, "data": ["value": String(repeating: "x", count: 300_000)]]]
        let replyFrame = try GuestWire.encode(reply)
        let writer = expectation(description: "fragmented peer completed")
        DispatchQueue.global().async {
            defer { Darwin.close(pair[1]); writer.fulfill() }
            do {
                let deadline = try GuestWire.Deadline(seconds: 5)
                let actual = try GuestWire.read(fd: pair[1], deadline: deadline)
                XCTAssertEqual(actual["id"] as? String, id)
                // Fragment the actual header and body deliberately. Then
                // close the peer with buffered bytes still available.
                for offset in stride(from: 0, to: replyFrame.count, by: 113) {
                    let piece = replyFrame.subdata(in: offset..<min(replyFrame.count, offset + 113))
                    try piece.withUnsafeBytes { bytes in
                        var sent = 0
                        while sent < piece.count {
                            let count = Darwin.send(pair[1], bytes.baseAddress!.advanced(by: sent), piece.count - sent, MSG_NOSIGNAL)
                            if count < 0, errno == EINTR { continue }
                            // GuestWire.read left this fd nonblocking; wait out a full 8 KiB socket buffer.
                            if count < 0, errno == EAGAIN || errno == EWOULDBLOCK {
                                var writable = pollfd(fd: pair[1], events: Int16(POLLOUT), revents: 0)
                                guard Darwin.poll(&writable, 1, 5_000) > 0 else { throw GuestWire.Failure.io("test peer send stalled") }
                                continue
                            }
                            guard count > 0 else { throw GuestWire.Failure.io("test peer send failed") }
                            sent += count
                        }
                    }
                }
            } catch { XCTFail("real peer failed: \(error)") }
        }
        let result = try GuestWire.exchange(fd: pair[0], request: request, deadline: .init(seconds: 5))
        XCTAssertEqual((result["data"] as? [String: Any])?["value"] as? String, String(repeating: "x", count: 300_000))
        wait(for: [writer], timeout: 6)
    }

    func testLostReplyDoesNotReplayTheSubmittedRequest() throws {
        let pair = try sockets()
        defer { Darwin.close(pair[0]) }
        let received = expectation(description: "one request received")
        let finished = expectation(description: "peer observed no replay")
        let request: [String: Any] = ["id": UUID().uuidString, "action": ["verb": "exec", "argv": ["/usr/bin/true"]]]
        DispatchQueue.global().async {
            defer { Darwin.close(pair[1]); finished.fulfill() }
            do {
                let actual = try GuestWire.read(fd: pair[1], deadline: .init(seconds: 2))
                XCTAssertEqual((actual["action"] as? [String: Any])?["verb"] as? String, "exec")
                received.fulfill()
                // Deliberately withhold the response while still listening
                // for a second frame on the same real socket.
                var pending = pollfd(fd: pair[1], events: Int16(POLLIN), revents: 0)
                XCTAssertEqual(Darwin.poll(&pending, 1, 350), 0)
            } catch { XCTFail("real peer failed: \(error)") }
        }
        XCTAssertThrowsError(try GuestWire.exchange(fd: pair[0], request: request, deadline: .init(seconds: 0.1))) {
            guard case GuestWire.Failure.timeout = $0 else { XCTFail("expected actual deadline, received \($0)"); return }
        }
        wait(for: [received, finished], timeout: 3)
    }

    func testMismatchedReplyIDAndNumericSuccessCannotBeAccepted() throws {
        for result in [["success": true], ["success": 1]] as [[String: Any]] {
            let pair = try sockets()
            defer { Darwin.close(pair[0]) }
            let id = UUID().uuidString
            let replyID = (result["success"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } == true ? UUID().uuidString : id
            let frame = try GuestWire.encode(["id": replyID, "result": result])
            let finished = expectation(description: "invalid peer reply sent")
            DispatchQueue.global().async {
                defer { Darwin.close(pair[1]); finished.fulfill() }
                do {
                    _ = try GuestWire.read(fd: pair[1], deadline: .init(seconds: 2))
                    try GuestWire.write(fd: pair[1], frame: frame, deadline: .init(seconds: 2))
                } catch { XCTFail("peer failed: \(error)") }
            }
            XCTAssertThrowsError(try GuestWire.exchange(fd: pair[0], request: ["id": id, "action": ["verb": "ping"]], deadline: .init(seconds: 2)))
            wait(for: [finished], timeout: 3)
        }
    }

    func testHeaderAndBodyShareTheSameActualDeadline() throws {
        let pair = try sockets()
        defer { Darwin.close(pair[0]) }
        let finished = expectation(description: "slow peer completed")
        DispatchQueue.global().async {
            defer { Darwin.close(pair[1]); finished.fulfill() }
            Thread.sleep(forTimeInterval: 0.08)
            var length = UInt32(2).littleEndian
            _ = withUnsafeBytes(of: &length) { Darwin.send(pair[1], $0.baseAddress, 4, MSG_NOSIGNAL) }
            Thread.sleep(forTimeInterval: 0.08)
            _ = "{}".withCString { Darwin.send(pair[1], $0, 2, MSG_NOSIGNAL) }
        }
        XCTAssertThrowsError(try GuestWire.read(fd: pair[0], deadline: .init(seconds: 0.12))) {
            guard case GuestWire.Failure.timeout = $0 else { XCTFail("expected shared deadline, received \($0)"); return }
        }
        wait(for: [finished], timeout: 2)
    }

    func testOversizedNativeHeaderIsRejectedBeforeItsBodyIsRead() throws {
        let pair = try sockets()
        defer { Darwin.close(pair[0]); Darwin.close(pair[1]) }
        var length = UInt32(GuestWire.maxFrameBytes + 1).littleEndian
        XCTAssertEqual(withUnsafeBytes(of: &length) { Darwin.send(pair[1], $0.baseAddress, 4, MSG_NOSIGNAL) }, 4)
        XCTAssertThrowsError(try GuestWire.read(fd: pair[0], deadline: .init(seconds: 1))) {
            guard case GuestWire.Failure.framing = $0 else { XCTFail("expected frame size refusal, received \($0)"); return }
        }
    }

    func testNonreadingPeerCannotBlockSocketSendPastDeadline() throws {
        let pair = try sockets()
        defer { Darwin.close(pair[0]); Darwin.close(pair[1]) }
        var capacity: Int32 = 4096
        XCTAssertEqual(Darwin.setsockopt(pair[0], SOL_SOCKET, SO_SNDBUF, &capacity, socklen_t(MemoryLayout<Int32>.size)), 0)
        let frame = try GuestWire.encode(["value": String(repeating: "x", count: 1_500_000)])
        XCTAssertThrowsError(try GuestWire.write(fd: pair[0], frame: frame, deadline: .init(seconds: 0.1))) {
            guard case GuestWire.Failure.timeout = $0 else { XCTFail("expected actual blocked send deadline, received \($0)"); return }
        }
    }
}
