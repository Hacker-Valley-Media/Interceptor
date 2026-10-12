import XCTest
@testable import interceptor_bridge

// Regression: IntelligenceDomain.handle
// previously switched on `command` (always "ai" for two-segment action
// types), so every verb fell through to notImplemented despite having
// FoundationModels-backed implementations. These tests pin the dispatch.

private final class IntelligenceResultHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: Any] = [:]
    var value: [String: Any] {
        lock.lock(); defer { lock.unlock() }; return stored
    }
    func set(_ v: [String: Any]) { lock.lock(); stored = v; lock.unlock() }
}

final class IntelligenceDispatchTests: XCTestCase {
    private func dispatch(sub: String, extra: [String: Any] = [:]) -> [String: Any] {
        let domain = IntelligenceDomain()
        var action: [String: Any] = ["type": "macos_ai", "sub": sub]
        for (k, v) in extra { action[k] = v }
        let holder = IntelligenceResultHolder()
        let exp = expectation(description: "ai dispatch \(sub)")
        domain.handle("ai", action: action) { r in
            holder.set(r)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5.0)
        return holder.value
    }

    private func isNotImplemented(_ result: [String: Any]) -> Bool {
        let err = (result["error"] as? String) ?? ""
        return err.contains("not yet implemented") || err.contains("not implemented")
    }

    func testStatusIsRoutedFromSub() {
        let r = dispatch(sub: "status")
        XCTAssertFalse(isNotImplemented(r), "status sub must reach checkStatus")
        // Either FoundationModels-backed payload (macOS 26+) or a structured
        // unavailable response — both are "reached" outcomes.
        XCTAssertNotNil(r["data"] ?? r["error"], "must produce a structured response")
    }

    func testPromptIsRoutedFromSub() {
        let r = dispatch(sub: "prompt")
        XCTAssertFalse(isNotImplemented(r), "prompt sub must reach runPrompt")
    }

    func testSessionIsRoutedFromSub() {
        // Pass an op that reaches a real branch inside handleSession.
        // Bare `session` defaults to op="status" which isn't a documented
        // sub-verb of session — that would conflate dispatch failure with
        // inner-switch fall-through. `history` always returns success
        // (empty array) so a successful response proves dispatch reached
        // the handler.
        let r = dispatch(sub: "session", extra: ["op": "history"])
        XCTAssertFalse(isNotImplemented(r), "session sub must reach handleSession")
    }
}
