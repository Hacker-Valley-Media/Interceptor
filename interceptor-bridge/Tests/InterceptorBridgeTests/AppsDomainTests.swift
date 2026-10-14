import XCTest
import ApplicationServices
@testable import interceptor_bridge

final class AppsDomainTests: XCTestCase {
    func testHiddenReadConfirmsOnlyTheRequestedLiveBooleanState() {
        let transport = FakeAXTransport()
        transport.attributeResponses[kAXHiddenAttribute as String] = kCFBooleanTrue
        XCTAssertTrue(AppsDomain.waitForHiddenState(pid: 123, hidden: true, transport: transport, timeoutMs: 0))
        XCTAssertFalse(AppsDomain.waitForHiddenState(pid: 123, hidden: false, transport: transport, timeoutMs: 0))
        transport.attributeResponses[kAXHiddenAttribute as String] = kCFBooleanFalse
        XCTAssertTrue(AppsDomain.waitForHiddenState(pid: 123, hidden: false, transport: transport, timeoutMs: 0))
    }

    func testHiddenReadDoesNotTreatMissingOrUnusableValuesAsSuccess() {
        let transport = FakeAXTransport()
        XCTAssertFalse(AppsDomain.waitForHiddenState(pid: 123, hidden: false, transport: transport, timeoutMs: 0))
        for value in [FakeAX.string("false"), FakeAX.number(0), FakeAX.null] {
            transport.attributeResponses[kAXHiddenAttribute as String] = value
            XCTAssertFalse(AppsDomain.waitForHiddenState(pid: 123, hidden: false, transport: transport, timeoutMs: 0))
        }
    }

    func testHiddenReadStopsAtItsDeadlineWithoutSendingAnotherMutation() {
        let transport = FakeAXTransport()
        transport.attributeResponses[kAXHiddenAttribute as String] = kCFBooleanFalse
        let start = Date()
        XCTAssertFalse(AppsDomain.waitForHiddenState(pid: 123, hidden: true, transport: transport, timeoutMs: 20))
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.2)
        XCTAssertTrue(transport.performedActions.isEmpty)
        XCTAssertTrue(transport.setAttributes.isEmpty)
    }

    // Issue #168: live frontmost pid equality is the whole signal — the old
    // `appIsActive` conjunct read the frozen NSRunningApplication cache and
    // could veto real activations.
    func testActivationReachedTargetRequiresMatchingFrontmostPID() {
        XCTAssertTrue(AppsDomain.activationReachedTarget(targetPID: 123, frontmostPID: 123))
        XCTAssertFalse(AppsDomain.activationReachedTarget(targetPID: 123, frontmostPID: 456))
        XCTAssertFalse(AppsDomain.activationReachedTarget(targetPID: 123, frontmostPID: nil))
    }

    func testPreferredCompoundAppIdentityPrefersExplicitTargetOverFrontmost() {
        let requested: CompoundDomain.AppIdentity = ("TextEdit", 30873, "com.apple.TextEdit")
        let frontmost: CompoundDomain.AppIdentity = ("Codex", 793, "com.openai.codex")
        let chosen = CompoundDomain.preferredAppIdentity(requested: requested, frontmost: frontmost)
        XCTAssertEqual(chosen.name, "TextEdit")
        XCTAssertEqual(chosen.pid, 30873)
        XCTAssertEqual(chosen.bundleId, "com.apple.TextEdit")
    }

    func testPreferredCompoundAppIdentityFallsBackToFrontmostWhenNoExplicitTargetExists() {
        let frontmost: CompoundDomain.AppIdentity = ("Codex", 793, "com.openai.codex")
        let chosen = CompoundDomain.preferredAppIdentity(requested: nil, frontmost: frontmost)
        XCTAssertEqual(chosen.name, "Codex")
        XCTAssertEqual(chosen.pid, 793)
        XCTAssertEqual(chosen.bundleId, "com.openai.codex")
    }
}
