import XCTest
import Foundation
@testable import interceptor_bridge

// Pins the per-user port mapping to the TypeScript source of truth
// (shared/platform.ts derivePorts, test/platform-runtime.test.ts).
final class PlatformPortTests: XCTestCase {
    func testPrimaryAccountKeepsThePublishedPort() {
        XCTAssertEqual(Platform.wsPort(uid: 501), 19222)
    }

    func testOtherAccountsGetTheirOwnPair() {
        XCTAssertEqual(Platform.wsPort(uid: 504), 19228)
        XCTAssertEqual(Platform.wsPort(uid: 0), 20220)
    }

    func testSlotsWrapAfterFiveHundredAccounts() {
        XCTAssertEqual(Platform.wsPort(uid: 1001), 19222)
    }

    func testMonitorSessionsLiveBesideTheOtherRuntimeFiles() {
        XCTAssertTrue(Platform.monitorSessionsDir.hasPrefix(Platform.runtimeDir))
        XCTAssertFalse(Platform.monitorSessionsDir.hasPrefix("/tmp/"))
    }
}
