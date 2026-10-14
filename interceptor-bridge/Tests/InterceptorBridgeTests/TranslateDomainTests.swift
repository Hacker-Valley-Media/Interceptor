// TranslateDomain unit tests. Live tests gated behind LIVE_TRANSLATE.

import XCTest
@testable import interceptor_bridge

final class TranslateDomainTests: XCTestCase {
    private let domain = TranslateDomain()

    func runVerb(_ sub: String, action: [String: Any] = [:]) -> [String: Any] {
        var act = action; act["sub"] = sub
        let holder = TestResultHolder()
        let exp = expectation(description: sub)
        domain.handle(sub, action: act) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 30.0)
        return holder.value
    }

    func testStatus_returnsAvailability() {
        let r = runVerb("status")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testText_missingTo_errors() {
        if #available(macOS 15, *) {
            let r = runVerb("text", action: ["input": "Hola"])
            XCTAssertEqual(r["success"] as? Bool, false)
        } else {
            // On older macOS the handler returns the structured availability stub.
            let r = runVerb("text", action: ["input": "Hola"])
            XCTAssertEqual(r["success"] as? Bool, true)
        }
    }

    func testAvailability_missingTo_errors() {
        if #available(macOS 15, *) {
            let r = runVerb("availability")
            XCTAssertEqual(r["success"] as? Bool, false)
        }
    }

    func testUnknownVerb_errors() {
        if #available(macOS 15, *) {
            let r = runVerb("nope")
            XCTAssertEqual(r["success"] as? Bool, false)
        }
    }

    func testText_live_translatesHola() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_TRANSLATE"] == "1")
        if #available(macOS 15, *) {
            let r = runVerb("text", action: ["input": "Hola, mundo", "from": "es", "to": "en"])
            XCTAssertEqual(r["success"] as? Bool, true)
        }
    }
}
