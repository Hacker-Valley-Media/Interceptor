import XCTest
@testable import interceptor_bridge

final class AppsDomainTests: XCTestCase {
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
