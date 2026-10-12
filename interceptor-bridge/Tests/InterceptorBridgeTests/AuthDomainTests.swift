// AuthDomain unit tests. `confirm` requires user interaction so it is
// gated behind LIVE_AUTH=1. `status`, `invalidate`, `domain-state` work offline.

import XCTest
@testable import interceptor_bridge

final class AuthDomainTests: XCTestCase {
    private let domain = AuthDomain()

    func runVerb(_ sub: String, action: [String: Any] = [:]) -> [String: Any] {
        var act = action; act["sub"] = sub
        let holder = TestResultHolder()
        let exp = expectation(description: sub)
        domain.handle(sub, action: act) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 60.0)
        return holder.value
    }

    func testStatus_returnsCanEvaluate() {
        let r = runVerb("status")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testInvalidate_returnsOk() {
        let r = runVerb("invalidate")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testDomainState_returnsHex() {
        let r = runVerb("domain-state")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testUnknownVerb_errors() {
        let r = runVerb("nope")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testConfirm_missingReason_errors() {
        let r = runVerb("confirm")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testConfirm_live() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_AUTH"] == "1")
        let r = runVerb("confirm", action: ["reason": "Interceptor live test"])
        XCTAssertEqual(r["success"] as? Bool, true)
    }
}
