// AppIntentDomain runtime tests.

import XCTest
@testable import interceptor_bridge

final class AppIntentDomainTests: XCTestCase {
    private let domain = AppIntentDomain()

    func runVerb(_ sub: String, action: [String: Any] = [:]) -> [String: Any] {
        var act = action; act["sub"] = sub
        let holder = TestResultHolder()
        let exp = expectation(description: sub)
        domain.handle(sub, action: act) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 5.0)
        return holder.value
    }

    func testList_returnsShortcuts() {
        let r = runVerb("list")
        XCTAssertEqual(r["success"] as? Bool, true)
        let data = r["data"] as? [String: Any]
        let shortcuts = data?["shortcuts"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(shortcuts.count, 11)
    }

    func testRegistered_returnsAllDeclaredIntents() {
        let r = runVerb("registered")
        XCTAssertEqual(r["success"] as? Bool, true)
        let data = r["data"] as? [String: Any]
        let intents = data?["intents"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(intents.count, 23)
    }

    func testDonate_unknownIntent_errors() {
        let r = runVerb("donate", action: ["intent_id": "NotAnIntent"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testDonate_knownIntent_succeeds() {
        let r = runVerb("donate", action: ["intent_id": "ScreenshotAppIntent"])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testSupports_returnsField() {
        let r = runVerb("supports")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testUnknownVerb_errors() {
        let r = runVerb("nope")
        XCTAssertEqual(r["success"] as? Bool, false)
    }
}
