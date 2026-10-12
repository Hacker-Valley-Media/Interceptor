import XCTest
@testable import interceptor_bridge

// Requests must reach strict validation before native policy/capture APIs.

private final class SensitiveResultHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: Any] = [:]
    var value: [String: Any] {
        lock.lock(); defer { lock.unlock() }; return stored
    }
    func set(_ v: [String: Any]) { lock.lock(); stored = v; lock.unlock() }
}

final class SensitiveDispatchTests: XCTestCase {
    private func dispatch(sub: String, extra: [String: Any] = [:]) -> [String: Any] {
        let domain = SensitiveDomain()
        var action: [String: Any] = ["type": "macos_sensitive", "sub": sub]
        for (k, v) in extra { action[k] = v }
        let holder = SensitiveResultHolder()
        let exp = expectation(description: "sensitive dispatch \(sub)")
        domain.handle("sensitive", action: action) { r in
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

    func testCheckIsRoutedFromSub() {
        let r = dispatch(sub: "check", extra: ["imagePath": "relative"])
        XCTAssertFalse(isNotImplemented(r), "check sub must reach checkContent")
        XCTAssertEqual(r["success"] as? Bool, false)
        XCTAssertEqual(r["code"] as? String, "invalid_request")
    }

    func testMonitorStatusIsRoutedFromSub() {
        let r = dispatch(sub: "monitor", extra: ["op": "status"])
        XCTAssertFalse(isNotImplemented(r), "monitor sub must reach handleMonitor")
        let data = r["data"] as? [String: Any]
        XCTAssertEqual(data?["monitoring"] as? Bool, false)
        XCTAssertEqual(data?["checks"] as? Int, 0)
        XCTAssertEqual(data?["cleanupPending"] as? Bool, false)
        XCTAssertTrue(data?["latest"] is NSNull)
        XCTAssertTrue(data?["lastError"] is NSNull)
    }

    func testMonitorRejectsMissingSourceAndFieldsBeforeNativePolicy() {
        let actions: [[String: Any]] = [["op": "start"], ["op": "stop", "app": "Any app"], ["op": "status", "imagePath": "/fixture.png"], ["op": "unknown"], ["unknown": true]]
        for extra in actions {
            let r = dispatch(sub: "monitor", extra: extra)
            XCTAssertEqual(r["success"] as? Bool, false)
            XCTAssertEqual(r["code"] as? String, "invalid_request")
        }
    }
}
