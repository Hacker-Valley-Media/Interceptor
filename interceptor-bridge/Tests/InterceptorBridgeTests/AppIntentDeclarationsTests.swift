// AppIntentDeclarations introspection tests. Validates the
// declared-intent set matches the runtime registry mirror.

import XCTest
#if canImport(AppIntents)
import AppIntents
#endif
@testable import interceptor_bridge

final class AppIntentDeclarationsTests: XCTestCase {
    func testRegisteredCount_isAtLeast23() {
        let domain = AppIntentDomain()
        let exp = expectation(description: "registered")
        let holder = TestResultHolder()
        domain.handle("registered", action: ["sub": "registered"]) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 5.0)
        let data = holder.value["data"] as? [String: Any]
        let count = (data?["count"] as? Int) ?? 0
        XCTAssertGreaterThanOrEqual(count, 23)
    }

    func testListCount_isAtLeast11Shortcuts() {
        let domain = AppIntentDomain()
        let exp = expectation(description: "list")
        let holder = TestResultHolder()
        domain.handle("list", action: ["sub": "list"]) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 5.0)
        let data = holder.value["data"] as? [String: Any]
        let shortcuts = data?["shortcuts"] as? [[String: Any]] ?? []
        XCTAssertGreaterThanOrEqual(shortcuts.count, 11)
    }

    @available(macOS 13, *)
    func testEnumDisplayRepresentations_present() {
        #if canImport(AppIntents)
        XCTAssertEqual(PriorityEnum.caseDisplayRepresentations.count, 4)
        XCTAssertGreaterThanOrEqual(LanguageEnum.caseDisplayRepresentations.count, 10)
        XCTAssertEqual(ScreenshotFormatEnum.caseDisplayRepresentations.count, 4)
        #endif
    }
}
