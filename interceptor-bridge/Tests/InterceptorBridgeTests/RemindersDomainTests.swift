// RemindersDomain unit tests.

import XCTest
@testable import interceptor_bridge

final class RemindersDomainTests: XCTestCase {
    private let domain = RemindersDomain()

    func runVerb(_ sub: String, action: [String: Any] = [:]) -> [String: Any] {
        var act = action; act["sub"] = sub
        let holder = TestResultHolder()
        let exp = expectation(description: sub)
        domain.handle(sub, action: act) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 10.0)
        return holder.value
    }

    func testStatus_returnsField() {
        let r = runVerb("status")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testCompleted_missingDates_errors() {
        let r = runVerb("completed")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testCreate_missingTitle_errors() {
        let r = runVerb("create")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testUpdate_unknownId_errors() {
        let r = runVerb("update", action: ["id": "no-such-reminder"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testComplete_unknownId_errors() {
        let r = runVerb("complete", action: ["id": "no-such-reminder"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testDelete_unknownId_errors() {
        let r = runVerb("delete", action: ["id": "no-such-reminder"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testUnknownVerb_errors() {
        let r = runVerb("nope")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testLists_live() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_EVENTKIT"] == "1")
        let r = runVerb("lists")
        XCTAssertEqual(r["success"] as? Bool, true)
    }
}
