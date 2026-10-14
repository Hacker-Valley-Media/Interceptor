import XCTest
@testable import interceptor_bridge

private final class AccessibilityContractHandler: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return calls }
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock(); calls += 1; lock.unlock()
        completion(WireFormat.success(action))
    }
}

final class DesktopAccessibilityContractTests: XCTestCase {
    private func fixtures() throws -> [String: Any] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("shared/desktop-accessibility-fixtures.json"))) as! [String: Any]
    }
    private func router(_ handler: AccessibilityContractHandler, trusted: Bool) -> Router {
        let router = Router(axTrustCheck: { trusted })
        for domain in ["desktop", "apps", "app", "windows", "frontmost", "focused", "tree", "find", "inspect", "text", "value", "type", "click", "action", "resize", "move", "keys", "scroll", "drag", "menu"] {
            router.register(domain, handler: handler)
        }
        return router
    }

    func testSharedMalformedFixturesRefuseBeforeTrustOrDispatch() throws {
        let handler = AccessibilityContractHandler()
        let router = router(handler, trusted: false)
        var invalid = (try fixtures()["invalid"] as! [[String: Any]]).map { $0["action"] as! [String: Any] }
        invalid.append(["type": "desktop_value", "ref": "e1", String(repeating: "x", count: 5000): true])
        for action in invalid {
            let description = String(describing: action)
            let replied = expectation(description: "refuse malformed accessibility payload")
            router.route(action: action) { result in
                XCTAssertEqual(result["success"] as? Bool, false, description)
                XCTAssertEqual(result["code"] as? String, "invalid_request", description)
                XCTAssertLessThanOrEqual((result["error"] as? String)?.utf8.count ?? Int.max, 2048)
                replied.fulfill()
            }
            wait(for: [replied], timeout: 1)
        }
        XCTAssertEqual(handler.count, 0)
    }

    func testBackgroundOnlyInputWithoutNativeTargetNeverReachesTheHIDTap() {
        let untargeted: [String: Any] = ["type": "desktop_click", "coords": "10,10", "backgroundOnly": true]
        XCTAssertEqual(DesktopAccessibilityValidation.validate(untargeted)?["code"] as? String, "invalid_request")
        for target: [String: Any] in [["pid": 42], ["app": "Fixture"], ["window": 7], ["windowTitle": "Fixture", "windowBounds": ["left": 0, "top": 0, "width": 10, "height": 10]]] {
            XCTAssertNil(DesktopAccessibilityValidation.validate(untargeted.merging(target) { $1 }))
        }
        XCTAssertNil(DesktopAccessibilityValidation.validate(["type": "desktop_click", "coords": "10,10"]))
    }

    func testNativeWindowIDsRefuseBeyondCGWindowIDBeforeTrustOrDispatch() {
        let handler = AccessibilityContractHandler()
        let router = router(handler, trusted: false)
        for window in [UInt64(UInt32.max) + 1, 187_651_961_215_680] {
            let replied = expectation(description: "refuse oversized CGWindowID")
            router.route(action: ["type": "desktop_keys", "keys": "ctrl+a", "window": NSNumber(value: window)]) { result in
                XCTAssertEqual(result["success"] as? Bool, false)
                XCTAssertEqual(result["code"] as? String, "invalid_request")
                replied.fulfill()
            }
            wait(for: [replied], timeout: 1)
        }
        XCTAssertEqual(handler.count, 0)
        XCTAssertNil(DesktopAccessibilityValidation.validate(["type": "desktop_keys", "keys": "ctrl+a", "window": NSNumber(value: UInt32.max)]))
    }

    func testSharedValidFixturesAndMacVariantsPreserveCompatibilityFields() throws {
        let handler = AccessibilityContractHandler()
        let router = router(handler, trusted: true)
        let fixture = try fixtures()
        let valid = (fixture["valid"] as! [[String: Any]]) + (fixture["supportedVariants"] as! [[String: Any]])
        for action in valid {
            let type = action["type"] as! String
            let expectedType = ["desktop_move", "desktop_resize", "desktop_text", "desktop_value", "desktop_action", "desktop_inspect"].contains(type) ? type :
                ["desktop_hello", "desktop_capabilities"].contains(type) ? "macos_desktop" : "macos_" + type.dropFirst(8)
            var expected = action; expected["type"] = expectedType
            let expectedBytes = try JSONSerialization.data(withJSONObject: expected, options: .sortedKeys)
            let replied = expectation(description: "preserve valid accessibility fields")
            router.route(action: action) { result in
                XCTAssertEqual(result["success"] as? Bool, true)
                XCTAssertEqual(try? JSONSerialization.data(withJSONObject: result["data"] ?? [:], options: .sortedKeys), expectedBytes)
                replied.fulfill()
            }
            wait(for: [replied], timeout: 1)
        }
        XCTAssertEqual(handler.count, valid.count)
    }

    func testLegacyRequestsAndUnrelatedNeutralDomainsRemainUnchanged() {
        let handler = AccessibilityContractHandler()
        let router = router(handler, trusted: true)
        router.register("battery", handler: handler)
        for action: [String: Any] in [
            ["type": "macos_type", "text": "legacy", "extra": true, "secret": "marker"],
            ["type": "desktop_battery", "sub": "status", "extra": true],
        ] {
            let replied = expectation(description: "preserve existing compatibility request")
            router.route(action: action) { result in
                XCTAssertEqual(result["success"] as? Bool, true)
                XCTAssertEqual((result["data"] as? [String: Any])?["extra"] as? Bool, true)
                replied.fulfill()
            }
            wait(for: [replied], timeout: 1)
        }
        XCTAssertEqual(handler.count, 2)
    }

    func testLifecycleRequestsDoNotRequireAccessibilityTrust() throws {
        let handler = AccessibilityContractHandler()
        let router = router(handler, trusted: false)
        let actions = (try fixtures()["valid"] as! [[String: Any]]).filter { $0["type"] as? String == "desktop_app" }
        XCTAssertFalse(actions.isEmpty)
        for action in actions {
            let replied = expectation(description: "dispatch lifecycle without accessibility trust")
            router.route(action: action) { result in
                XCTAssertEqual(result["success"] as? Bool, true)
                replied.fulfill()
            }
            wait(for: [replied], timeout: 1)
        }
        XCTAssertEqual(handler.count, actions.count)
    }
}
