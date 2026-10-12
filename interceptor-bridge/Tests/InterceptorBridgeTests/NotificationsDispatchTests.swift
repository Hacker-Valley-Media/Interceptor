import XCTest
@testable import interceptor_bridge

// Regression: NotificationsDomain.handle was switching on
// `command` so `notifications tail` and `notifications log` all fell
// through to `notImplemented`. These tests pin the dispatch contract.

private final class NotificationsResultHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: Any] = [:]
    var value: [String: Any] {
        lock.lock(); defer { lock.unlock() }; return stored
    }
    func set(_ v: [String: Any]) { lock.lock(); stored = v; lock.unlock() }
}

final class NotificationsDispatchTests: XCTestCase {
    private func dispatch(sub: String, extra: [String: Any] = [:]) -> [String: Any] {
        let domain = NotificationsDomain()
        var action: [String: Any] = ["type": "macos_notifications", "sub": sub]
        for (k, v) in extra { action[k] = v }
        let holder = NotificationsResultHolder()
        let exp = expectation(description: "notifications dispatch \(sub)")
        domain.handle("notifications", action: action) { r in
            holder.set(r)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 2.0)
        return holder.value
    }

    private func isNotImplemented(_ result: [String: Any]) -> Bool {
        let err = (result["error"] as? String) ?? ""
        return err.contains("not yet implemented") || err.contains("not implemented")
    }

    func testTailIsRoutedFromSub() {
        let r = dispatch(sub: "tail", extra: ["name": "com.interceptor.fixture.dispatch"])
        XCTAssertFalse(isNotImplemented(r), "tail sub must reach the tail handler")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testUnfilteredTailDoesNotClaimCapture() {
        let result = dispatch(sub: "tail")
        XCTAssertEqual(result["success"] as? Bool, false)
        XCTAssertEqual(result["code"] as? String, "unsupported_operation")
    }

    func testTailRejectsUnsafeNamesBeforeObservation() {
        for name in ["nul\0name", String(repeating: "x", count: 513)] {
            let result = dispatch(sub: "tail", extra: ["name": name])
            XCTAssertEqual(result["success"] as? Bool, false)
            XCTAssertEqual(result["code"] as? String, "invalid_request")
        }
    }

    func testNamedTailBoundAndOwnedUnsubscription() {
        let domain = NotificationsDomain()
        func run(_ sub: String, _ name: String) -> [String: Any] {
            let result = NotificationsResultHolder()
            domain.handle("notifications", action: ["sub": sub, "name": name]) { result.set($0) }
            return result.value
        }
        for index in 0..<32 { XCTAssertEqual(run("tail", "com.interceptor.fixture.bound.\(index)")["success"] as? Bool, true) }
        XCTAssertEqual(run("tail", "com.interceptor.fixture.bound.0")["success"] as? Bool, true)
        XCTAssertEqual(run("tail", "com.interceptor.fixture.bound.overflow")["code"] as? String, "invalid_request")
        XCTAssertEqual((run("untail", "com.interceptor.fixture.bound.0")["data"] as? [String: Any])?["removed"] as? Bool, true)
        XCTAssertEqual((run("untail", "com.interceptor.fixture.bound.0")["data"] as? [String: Any])?["removed"] as? Bool, false)
        XCTAssertEqual(run("tail", "com.interceptor.fixture.bound.overflow")["success"] as? Bool, true)
    }

    func testLogIsRoutedFromSub() {
        let r = dispatch(sub: "log", extra: ["limit": 5])
        XCTAssertFalse(isNotImplemented(r), "log sub must reach the log handler")
    }

    func testLogRejectsUnsafeLimitsWithoutTrapping() {
        for limit in [-1, 1001, Int.max] {
            let result = dispatch(sub: "log", extra: ["limit": limit])
            XCTAssertEqual(result["success"] as? Bool, false)
            XCTAssertTrue((result["error"] as? String ?? "").contains("0...1000"))
        }
        let zero = dispatch(sub: "log", extra: ["limit": 0])
        XCTAssertEqual(zero["success"] as? Bool, true)
        XCTAssertEqual((zero["data"] as? [[String: Any]])?.count, 0)
    }

    func testRepeatingIntervalsRejectNativeExceptionBeforeBundleGate() {
        for seconds in [1, 59] {
            let result = dispatch(sub: "schedule-after", extra: ["seconds": seconds, "repeats": true])
            XCTAssertEqual(result["success"] as? Bool, false)
            XCTAssertTrue((result["error"] as? String ?? "").contains("at least 60 seconds"))
        }
        let boundary = dispatch(sub: "schedule-after", extra: ["seconds": 60, "repeats": true])
        XCTAssertFalse((boundary["error"] as? String ?? "").contains("at least 60 seconds"))
    }

    func testUnknownSubReturnsNotImplementedWithSubString() {
        let r = dispatch(sub: "unknownop")
        let err = (r["error"] as? String) ?? ""
        XCTAssertTrue(err.contains("unknownop"), "Error should reference the unknown sub")
    }

    // UNUserNotificationCenter dispatch tests.
    //
    // The xctest runner has no .app bundle, so UNUserNotificationCenter.current()
    // raises NSInternalInconsistencyException. Production code runs inside the
    // Interceptor.app bundle and reaches the live UN center; the bridge guards
    // every UN entry point with `unGuard` and returns a structured error here.
    // Tests below assert dispatch reaches the handler and returns either the
    // live success or the bundle-absence error — never `notImplemented`.

    private func reachesUnHandler(_ result: [String: Any]) -> Bool {
        if !isNotImplemented(result) { return true }
        return false
    }

    func testUnStatus_dispatchesToHandler() {
        let r = dispatch(sub: "status")
        XCTAssertTrue(reachesUnHandler(r))
    }

    func testUnPost_dispatchesToHandler() {
        let r = dispatch(sub: "post", extra: ["title": "Test", "body": "Hello"])
        XCTAssertTrue(reachesUnHandler(r))
    }

    func testUnScheduleAfter_missingSeconds_errors() {
        let r = dispatch(sub: "schedule-after", extra: ["title": "x", "body": "y"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testUnScheduleAt_missingDate_errors() {
        let r = dispatch(sub: "schedule-at", extra: ["title": "x", "body": "y"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testUnScheduleCron_missingComponents_errors() {
        let r = dispatch(sub: "schedule-cron", extra: ["title": "x", "body": "y"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testUnCancel_missingId_errors() {
        let r = dispatch(sub: "cancel")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testUnCancelAll_dispatchesToHandler() {
        let r = dispatch(sub: "cancel-all")
        XCTAssertTrue(reachesUnHandler(r))
    }

    func testUnPending_dispatchesToHandler() {
        let r = dispatch(sub: "pending")
        XCTAssertTrue(reachesUnHandler(r))
    }

    func testUnDelivered_dispatchesToHandler() {
        let r = dispatch(sub: "delivered")
        XCTAssertTrue(reachesUnHandler(r))
    }

    func testUnDismiss_missingId_errors() {
        let r = dispatch(sub: "dismiss")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testUnDismissAll_dispatchesToHandler() {
        let r = dispatch(sub: "dismiss-all")
        XCTAssertTrue(reachesUnHandler(r))
    }

    func testUnCategoriesList_dispatchesToHandler() {
        let r = dispatch(sub: "categories", extra: ["verb": "list"])
        XCTAssertTrue(reachesUnHandler(r))
    }

    func testUnCategoriesRegister_missingFields_errors() {
        let r = dispatch(sub: "categories", extra: ["verb": "register"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testUnCategoriesClear_dispatchesToHandler() {
        let r = dispatch(sub: "categories", extra: ["verb": "clear"])
        XCTAssertTrue(reachesUnHandler(r))
    }
}
