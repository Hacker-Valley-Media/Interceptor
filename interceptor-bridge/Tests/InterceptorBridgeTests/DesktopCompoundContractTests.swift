import XCTest
@testable import interceptor_bridge

final class DesktopCompoundContractTests: XCTestCase {
    func testCompoundShapeAndTargetValidationBeforeDispatch() {
        XCTAssertNil(DesktopCompoundValidation.validate(["type": "desktop_read", "pid": 1, "depth": 10]))
        XCTAssertNil(DesktopCompoundValidation.validate(["type": "desktop_act", "ref": "e1", "text": ""]))
        XCTAssertNil(DesktopCompoundValidation.validate(["type": "desktop_open", "app": "fixture", "activate": false]))
        for action: [String: Any] in [
            ["type": "desktop_act", "ref": "e1", "text": NSNull()],
            ["type": "desktop_act", "ref": "1"],
            ["type": "desktop_read", "pid": 0],
            ["type": "desktop_read", "depth": 1.5],
            ["type": "desktop_read", "sub": "read"],
            ["type": "desktop_inspect_app", "app": ""],
            ["type": "desktop_inspect_app", "pid": true],
            ["type": "desktop_open", "activate": NSNull()],
            ["type": "desktop_open", "activate": 1],
            ["type": "desktop_open", "arguments": "bad"]
        ] {
            XCTAssertEqual(DesktopCompoundValidation.validate(action)?["code"] as? String, "invalid_request")
        }
        let error = DesktopCompoundValidation.normalize(["success": false, "code": "invalid_ref", "error": "invalid ref"], type: "desktop_act")
        XCTAssertEqual(error["code"] as? String, "stale_reference")
        XCTAssertEqual(error["retryable"] as? Bool, false)
    }
    func testOpenTrustGateRunsBeforeTheLaunchHandler() {
        let router = Router(axTrustCheck: { false })
        let result = expectation(description: "open permission gate")
        router.route(action: ["type": "desktop_open", "app": "fixture"]) { reply in
            XCTAssertEqual(reply["success"] as? Bool, false)
            XCTAssertEqual(reply["code"] as? String, "permission_required")
            result.fulfill()
        }
        wait(for: [result], timeout: 1)
    }
}
