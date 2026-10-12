import XCTest
import AppKit
@testable import interceptor_bridge

// Regression: ClipboardDomain.handle was switching on `command`
// (which the router passes as the literal "clipboard" for two-segment
// action types) instead of action["sub"], so every clipboard call fell
// through to `notImplemented`. These tests pin the dispatch contract.
//
// Use private pasteboards. Dispatch tests must not read, overwrite or clear
// the user's general clipboard.

private final class ClipboardResultHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: Any] = [:]
    var value: [String: Any] {
        lock.lock(); defer { lock.unlock() }; return stored
    }
    func set(_ v: [String: Any]) { lock.lock(); stored = v; lock.unlock() }
}

final class ClipboardDispatchTests: XCTestCase {
    private func dispatch(sub: String, extra: [String: Any] = [:]) -> [String: Any] {
        let domain = ClipboardDomain(pasteboard: .withUniqueName(), emitEvent: { _, _ in })
        var action: [String: Any] = ["type": "macos_clipboard", "sub": sub]
        for (k, v) in extra { action[k] = v }
        let holder = ClipboardResultHolder()
        let exp = expectation(description: "clipboard dispatch \(sub)")
        domain.handle("clipboard", action: action) { r in
            holder.set(r)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 2.0)
        return holder.value
    }

    private func errorMessage(_ result: [String: Any]) -> String? {
        result["error"] as? String
    }

    private func isNotImplemented(_ result: [String: Any]) -> Bool {
        let err = errorMessage(result) ?? ""
        return err.contains("not yet implemented") || err.contains("not implemented")
    }

    func testReadIsRoutedFromSub() {
        let r = dispatch(sub: "read")
        XCTAssertFalse(isNotImplemented(r), "read sub must reach the read handler")
    }

    func testWriteIsRoutedFromSub() {
        let r = dispatch(sub: "write", extra: ["text": "fixture-clip"])
        XCTAssertFalse(isNotImplemented(r), "write sub must reach the write handler")
    }

    func testTailIsRoutedFromSub() {
        let r = dispatch(sub: "tail")
        XCTAssertFalse(isNotImplemented(r), "tail sub must reach the tail handler")
        // Tail returns success with {"tailing": true} payload.
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testHistoryIsRoutedFromSub() {
        let r = dispatch(sub: "history")
        XCTAssertFalse(isNotImplemented(r), "history sub must reach the history handler")
    }

    func testClearIsRoutedFromSub() {
        let r = dispatch(sub: "clear")
        XCTAssertFalse(isNotImplemented(r), "clear sub must reach the clear handler")
    }

    func testTypesIsRoutedFromSub() {
        let r = dispatch(sub: "types")
        XCTAssertFalse(isNotImplemented(r), "types sub must reach the types handler")
    }

    func testUnknownSubReturnsNotImplementedWithSubString() {
        let r = dispatch(sub: "nonexistent")
        let err = errorMessage(r) ?? ""
        XCTAssertTrue(err.contains("nonexistent"), "Error should reference the unknown sub, not the domain key")
    }

    func testFallsBackToCommandWhenSubMissing() {
        // If a future caller (or the router on a hypothetical
        // three-segment routing change) doesn't pass `sub`, the
        // handler should still try `command` as the sub-verb.
        let domain = ClipboardDomain(pasteboard: .withUniqueName(), emitEvent: { _, _ in })
        let holder = ClipboardResultHolder()
        let exp = expectation(description: "clipboard fallback")
        domain.handle("read", action: ["type": "macos_clipboard"]) { r in
            holder.set(r)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 2.0)
        XCTAssertFalse(isNotImplemented(holder.value))
    }
}
