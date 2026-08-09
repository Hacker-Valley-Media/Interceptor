import XCTest
import AVFoundation
@testable import interceptor_bridge

// Coverage: status vocabulary, non-blocking microphone path,
// limitation field on AX/Screen, pending_user_action signal, --no-prompt
// defense-in-depth, and the deprecated `granted` compat shim.
final class TrustDomainStatusTests: XCTestCase {

    // MARK: - PermissionStatus rawValue mapping

    func testPermissionStatusRawValues() {
        XCTAssertEqual(PermissionStatus.granted.rawValue, "granted")
        XCTAssertEqual(PermissionStatus.denied.rawValue, "denied")
        XCTAssertEqual(PermissionStatus.notDetermined.rawValue, "not_determined")
        XCTAssertEqual(PermissionStatus.restricted.rawValue, "restricted")
    }

    func testPermissionStatusFromBool() {
        XCTAssertEqual(PermissionStatus.fromBool(true), .granted)
        XCTAssertEqual(PermissionStatus.fromBool(false), .denied)
    }

    // MARK: - AVAuthorizationStatus → PermissionStatus mapping

    func testAuthorizedMapsToGranted() {
        XCTAssertEqual(AVAuthorizationStatus.authorized.permissionStatus, .granted)
    }

    func testDeniedMapsToDenied() {
        XCTAssertEqual(AVAuthorizationStatus.denied.permissionStatus, .denied)
    }

    func testRestrictedMapsToRestricted() {
        XCTAssertEqual(AVAuthorizationStatus.restricted.permissionStatus, .restricted)
    }

    func testNotDeterminedMapsToNotDetermined() {
        XCTAssertEqual(AVAuthorizationStatus.notDetermined.permissionStatus, .notDetermined)
    }

    // MARK: - Permission struct serialization

    func testPermissionDictionaryIncludesStatusAndDeprecatedGranted() {
        let perm = Permission(
            name: "Microphone",
            status: .granted,
            required: false,
            path: "Settings",
            reason: "test",
            limitation: nil
        )
        let dict = perm.toDictionary()
        XCTAssertEqual(dict["status"] as? String, "granted")
        XCTAssertEqual(dict["granted"] as? Bool, true)
        XCTAssertEqual(dict["name"] as? String, "Microphone")
        XCTAssertNil(dict["limitation"])
    }

    func testPermissionDictionaryGrantedComputedFromStatus() {
        for status: PermissionStatus in [.denied, .notDetermined, .restricted] {
            let perm = Permission(
                name: "X",
                status: status,
                required: false,
                path: "p",
                reason: "r",
                limitation: nil
            )
            let dict = perm.toDictionary()
            XCTAssertEqual(dict["status"] as? String, status.rawValue)
            XCTAssertEqual(
                dict["granted"] as? Bool, false,
                "granted shim should be false for non-granted status \(status.rawValue)"
            )
        }
    }

    func testPermissionDictionaryEmitsLimitationWhenSet() {
        let perm = Permission(
            name: "Accessibility",
            status: .denied,
            required: true,
            path: "Settings",
            reason: "test",
            limitation: "Apple's AXIsProcessTrusted returns Bool only"
        )
        let dict = perm.toDictionary()
        XCTAssertEqual(dict["limitation"] as? String, "Apple's AXIsProcessTrusted returns Bool only")
    }

    // MARK: - Microphone provider stub

    final class StubMicrophoneProvider: MicrophoneAuthorizationProvider, @unchecked Sendable {
        var status: AVAuthorizationStatus
        var requestCalls: Int = 0
        // If non-nil, requestAccess invokes the completion synchronously
        // with this value (simulating an Apple impl that returns
        // immediately). Real Apple behavior is async so the default is nil
        // and the completion is dropped — matching production.
        var synchronousResult: Bool? = nil

        init(initialStatus: AVAuthorizationStatus) {
            self.status = initialStatus
        }

        func currentStatus() -> AVAuthorizationStatus { status }

        func requestAccess(_ completion: @escaping @Sendable (Bool) -> Void) {
            requestCalls += 1
            if let synchronousResult = synchronousResult {
                completion(synchronousResult)
            }
        }
    }

    // MARK: - TrustDomain non-blocking + pending_user_action behavior
    //
    // These exercise the helper functions on TrustDomain through the same
    // `handle("trust", ...)` entry point production uses, so we cover the
    // full preflight result-shape, not just the helper path.

    // Thread-safe holder so the `@Sendable` completion closure can publish
    // the result back to the test body without violating Swift 6 sendable
    // capture rules.
    final class ResultBox: @unchecked Sendable {
        private let lock = NSLock()
        private var value: [String: Any] = [:]

        func set(_ v: [String: Any]) {
            lock.lock(); defer { lock.unlock() }
            value = v
        }

        func get() -> [String: Any] {
            lock.lock(); defer { lock.unlock() }
            return value
        }
    }

    // MARK: - Signing provider stub (issue #163 follow-up)

    struct StubSigningProvider: SigningInfoProvider {
        let info: SigningInfo
        func signingInfo() -> SigningInfo { info }
    }

    private func runTrust(
        action: [String: Any],
        provider: MicrophoneAuthorizationProvider,
        signing: SigningInfo? = nil
    ) -> [String: Any] {
        let signingProvider: any SigningInfoProvider =
            signing.map { StubSigningProvider(info: $0) } ?? LiveSigningInfoProvider()
        let domain = TrustDomain(microphoneProvider: provider, signingProvider: signingProvider)
        let box = ResultBox()
        let exp = expectation(description: "trust completion")
        domain.handle("trust", action: action) { result in
            box.set(result)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
        return box.get()
    }

    private func data(from result: [String: Any]) -> [String: Any] {
        XCTAssertEqual(result["success"] as? Bool, true)
        return result["data"] as? [String: Any] ?? [:]
    }

    private func permissions(from result: [String: Any]) -> [[String: Any]] {
        let payload = data(from: result)
        return payload["permissions"] as? [[String: Any]] ?? []
    }

    func testReadOnlyTrustReturnsCurrentMicStatusWithoutPrompting() {
        let provider = StubMicrophoneProvider(initialStatus: .notDetermined)
        let result = runTrust(action: [:], provider: provider)
        let payload = data(from: result)

        XCTAssertEqual(payload["microphone"] as? String, "not_determined")
        XCTAssertEqual(provider.requestCalls, 0)
        XCTAssertNil(payload["pending_user_action"])
    }

    func testMicrophonePromptIsNonBlockingAndTriggersRequestAccess() {
        let provider = StubMicrophoneProvider(initialStatus: .notDetermined)
        let start = DispatchTime.now()
        let result = runTrust(action: ["microphonePrompt": true], provider: provider)
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000.0

        XCTAssertEqual(provider.requestCalls, 1, "requestAccess must be called exactly once")
        XCTAssertLessThan(elapsed, 200.0, "non-blocking path should return well under 200ms (got \(elapsed)ms)")

        let payload = data(from: result)
        XCTAssertEqual(payload["microphone"] as? String, "not_determined")
        XCTAssertEqual(payload["pending_user_action"] as? [String], ["Microphone"])
    }

    func testAlreadyGrantedMicShortCircuitsRequestAccess() {
        let provider = StubMicrophoneProvider(initialStatus: .authorized)
        let result = runTrust(action: ["microphonePrompt": true], provider: provider)

        XCTAssertEqual(provider.requestCalls, 0, "must not re-prompt when already authorized")
        let payload = data(from: result)
        XCTAssertEqual(payload["microphone"] as? String, "granted")
        XCTAssertNil(payload["pending_user_action"])
    }

    func testAlreadyDeniedMicShortCircuitsRequestAccess() {
        let provider = StubMicrophoneProvider(initialStatus: .denied)
        let result = runTrust(action: ["microphonePrompt": true], provider: provider)

        XCTAssertEqual(provider.requestCalls, 0, "must not re-prompt when already denied")
        let payload = data(from: result)
        XCTAssertEqual(payload["microphone"] as? String, "denied")
        XCTAssertNil(payload["pending_user_action"])
    }

    func testRestrictedMicShortCircuitsRequestAccess() {
        let provider = StubMicrophoneProvider(initialStatus: .restricted)
        let result = runTrust(action: ["microphonePrompt": true], provider: provider)

        XCTAssertEqual(provider.requestCalls, 0)
        let payload = data(from: result)
        XCTAssertEqual(payload["microphone"] as? String, "restricted")
    }

    // MARK: - --no-prompt defense-in-depth

    func testNoPromptOverridesEveryPromptFlag() {
        let provider = StubMicrophoneProvider(initialStatus: .notDetermined)
        let result = runTrust(action: [
            "noPrompt": true,
            "prompt": true,
            "walkthrough": true,
            "accessibilityPrompt": true,
            "screenPrompt": true,
            "microphonePrompt": true
        ], provider: provider)

        XCTAssertEqual(provider.requestCalls, 0, "noPrompt must suppress every requestAccess call")
        let payload = data(from: result)
        XCTAssertNil(payload["prompted"], "noPrompt must suppress the prompted[] field")
        XCTAssertNil(payload["opened"], "noPrompt must suppress walkthrough pane opening")
    }

    // MARK: - Permissions array shape

    func testPermissionsArrayCarriesAllFourWithStatus() {
        let provider = StubMicrophoneProvider(initialStatus: .authorized)
        let result = runTrust(action: [:], provider: provider)
        let perms = permissions(from: result)

        XCTAssertEqual(perms.count, 4)
        let names = perms.compactMap { $0["name"] as? String }
        XCTAssertEqual(Set(names), Set(["Accessibility", "Microphone", "Screen Recording", "Speech Recognition"]))

        for perm in perms {
            XCTAssertNotNil(perm["status"] as? String, "every entry must have a string status")
            XCTAssertNotNil(perm["granted"] as? Bool, "deprecated granted shim must remain Bool for one release")
        }
    }

    func testAccessibilityAndScreenCarryLimitationButMicDoesNot() {
        let provider = StubMicrophoneProvider(initialStatus: .authorized)
        let result = runTrust(action: [:], provider: provider)
        let perms = permissions(from: result)

        let ax = perms.first(where: { $0["name"] as? String == "Accessibility" })
        let screen = perms.first(where: { $0["name"] as? String == "Screen Recording" })
        let mic = perms.first(where: { $0["name"] as? String == "Microphone" })

        XCTAssertNotNil(ax?["limitation"] as? String)
        XCTAssertNotNil(screen?["limitation"] as? String)
        XCTAssertNil(mic?["limitation"], "Microphone status is fully expressive — no limitation field")
    }

    func testTopLevelStatusFieldsAreStrings() {
        let provider = StubMicrophoneProvider(initialStatus: .denied)
        let result = runTrust(action: [:], provider: provider)
        let payload = data(from: result)

        XCTAssertNotNil(payload["accessibility"] as? String)
        XCTAssertNotNil(payload["screenRecording"] as? String)
        XCTAssertEqual(payload["microphone"] as? String, "denied")
    }

    // MARK: - Signing status surfacing (issue #163 follow-up)

    func testSigningBlockCarriesIdentityForSignedBuild() {
        let provider = StubMicrophoneProvider(initialStatus: .authorized)
        let result = runTrust(
            action: [:],
            provider: provider,
            signing: SigningInfo(adhoc: false, teamId: "TPWBZD35WW", identifier: "com.interceptor.bridge", cdhash: "ab12")
        )
        let payload = data(from: result)

        let signing = payload["signing"] as? [String: Any]
        XCTAssertEqual(signing?["adhoc"] as? Bool, false)
        XCTAssertEqual(signing?["teamId"] as? String, "TPWBZD35WW")
        XCTAssertEqual(signing?["identifier"] as? String, "com.interceptor.bridge")
        XCTAssertEqual(signing?["cdhash"] as? String, "ab12")
        XCTAssertNil(payload["warnings"], "signed builds must not emit the ad-hoc warning")
    }

    func testAdhocSigningEmitsPinnedGrantWarning() {
        let provider = StubMicrophoneProvider(initialStatus: .authorized)
        let result = runTrust(
            action: [:],
            provider: provider,
            signing: SigningInfo(adhoc: true, teamId: nil, identifier: nil, cdhash: "ff00")
        )
        let payload = data(from: result)

        let signing = payload["signing"] as? [String: Any]
        XCTAssertEqual(signing?["adhoc"] as? Bool, true)
        XCTAssertTrue(signing?["teamId"] is NSNull, "ad-hoc has no team identity")

        let warnings = payload["warnings"] as? [String] ?? []
        XCTAssertEqual(warnings.count, 1)
        XCTAssertTrue(warnings[0].contains("ad-hoc signed"), "warning must name the cause")
        XCTAssertTrue(warnings[0].contains("NOT survive a rebuild"), "warning must state the consequence")
    }
}
