import XCTest
import AppKit
@testable import interceptor_bridge

final class DesktopClipboardContractTests: XCTestCase {
    func testMalformedNeutralRequestsPreservePrivatePasteboard() {
        let pb = NSPasteboard.withUniqueName()
        pb.setString("owned fixture", forType: .string)
        let count = pb.changeCount
        let router = Router(axTrustCheck: { false })
        router.register("clipboard", handler: ClipboardDomain(pasteboard: pb, emitEvent: { _, _ in }))
        let invalid: [[String: Any]] = [
            ["sub": "write"], ["sub": "write", "text": NSNull()], ["sub": "write", "text": "a\0b"],
            ["sub": "history", "limit": -1], ["sub": "history", "limit": 0.5], ["sub": "history", "limit": true],
            ["sub": "history", "limit": 501], ["sub": "read", "contentType": NSNull()],
            ["sub": "clear", "pid": 42], ["sub": "unrelated"]
        ]
        for var action in invalid {
            action["type"] = "desktop_clipboard"
            let reply = expectation(description: "invalid clipboard request")
            router.route(action: action) { result in
                XCTAssertEqual(result["success"] as? Bool, false)
                XCTAssertEqual(result["code"] as? String, "invalid_request")
                reply.fulfill()
            }
            wait(for: [reply], timeout: 1)
            XCTAssertEqual(pb.changeCount, count)
            XCTAssertEqual(pb.string(forType: .string), "owned fixture")
        }
    }

    func testNeutralReadsWritesAndEmptyRefusalRetainLegacyEnvelopes() {
        let pb = NSPasteboard.withUniqueName()
        let domain = ClipboardDomain(pasteboard: pb, emitEvent: { _, _ in })
        let text = "owned Unicode 🙂 漢字"
        let write = expectation(description: "neutral write")
        domain.handle("clipboard", action: ["type": "desktop_clipboard", "sub": "write", "text": text]) { result in
            XCTAssertEqual(result["data"] as? String, "ok"); write.fulfill()
        }
        wait(for: [write], timeout: 1)
        XCTAssertEqual(pb.string(forType: .string), text)
        let read = expectation(description: "neutral read")
        domain.handle("clipboard", action: ["type": "desktop_clipboard", "sub": "read"]) { result in
            XCTAssertEqual(result["data"] as? String, text); read.fulfill()
        }
        wait(for: [read], timeout: 1)
        pb.clearContents()
        for type in ["desktop_clipboard", "macos_clipboard"] {
            let reply = expectation(description: "empty clipboard envelope")
            domain.handle("clipboard", action: ["type": type, "sub": "read"]) { result in
                XCTAssertEqual(result["success"] as? Bool, false)
                XCTAssertEqual(result["error"] as? String, "no text on clipboard")
                XCTAssertEqual(result["code"] as? String, type == "desktop_clipboard" ? "unsupported_target" : nil)
                reply.fulfill()
            }
            wait(for: [reply], timeout: 1)
        }
    }

    func testTailHistoryAndEventsMatchSharedGraphemeFixtures() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("shared/desktop-clipboard-fixtures.json"))) as! [String: Any]
        for fixture in fixtures["previewCases"] as! [[String: String]] {
            let pb = NSPasteboard.withUniqueName()
            pb.clearContents()
            pb.setString("owned initial", forType: .string)
            let expected = fixture["expected"]!
            let changed = expectation(description: fixture["name"]!)
            let domain = ClipboardDomain(pasteboard: pb) { event, entry in
                XCTAssertEqual(event, "clipboard_change")
                XCTAssertEqual(entry["preview"] as? String, expected)
                var wire = entry; wire["event"] = event
                let data = try? JSONSerialization.data(withJSONObject: wire)
                XCTAssertNotNil(data.flatMap { try? JSONDecoder().decode(DesktopClipboardEvent.self, from: $0) })
                changed.fulfill()
            }
            let started = expectation(description: "start tail")
            domain.handle("clipboard", action: ["type": "desktop_clipboard", "sub": "tail"]) { result in
                XCTAssertEqual((result["data"] as? [String: Any])?["tailing"] as? Bool, true)
                started.fulfill()
            }
            wait(for: [started], timeout: 1)
            let originalCount = pb.changeCount
            pb.clearContents()
            pb.setString(fixture["text"]!, forType: .string)
            XCTAssertNotEqual(pb.changeCount, originalCount)
            wait(for: [changed], timeout: 2)
            let history = expectation(description: "history preview")
            domain.handle("clipboard", action: ["type": "desktop_clipboard", "sub": "history", "limit": 1]) { result in
                XCTAssertEqual((result["data"] as? [[String: Any]])?.last?["preview"] as? String, expected)
                history.fulfill()
            }
            wait(for: [history], timeout: 1)
            let zero = expectation(description: "zero history")
            domain.handle("clipboard", action: ["type": "desktop_clipboard", "sub": "history", "limit": 0]) { result in
                XCTAssertEqual((result["data"] as? [Any])?.count, 0); zero.fulfill()
            }
            wait(for: [zero], timeout: 1)
        }
    }
}
