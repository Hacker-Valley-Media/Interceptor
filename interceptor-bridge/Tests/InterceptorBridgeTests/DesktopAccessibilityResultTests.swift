import XCTest
import ApplicationServices
@testable import interceptor_bridge

private final class NativeResultFixture: DomainHandler, @unchecked Sendable {
    let result: [String: Any]
    init(_ result: [String: Any]) { self.result = result }
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) { completion(result) }
}

final class DesktopAccessibilityResultTests: XCTestCase {
    func testInstalledMissingCodeFailuresNormalizeThroughRouterAndPreserveLegacyBytes() throws {
        for (action, native, expected) in [
            (["type": "desktop_value", "ref": "e1"] as [String: Any], WireFormat.error("invalid ref"), "stale_reference"),
            (["type": "desktop_inspect", "ref": "e1"], WireFormat.error("invalid ref"), "stale_reference"),
            (["type": "desktop_tree", "pid": 2147483647], WireFormat.error("no target app found"), "target_gone"),
            (["type": "desktop_resize", "ref": "e1", "width": 700, "height": 500], WireFormat.error("resize failed: attribute not settable on this element (use a top-level window ref)"), "unsupported_target"),
        ] {
            let router = Router(axTrustCheck: { true })
            let type = action["type"] as! String
            let nativeMessage = native["error"] as? String
            router.register(String(type.dropFirst(8)), handler: NativeResultFixture(native))
            let neutral = expectation(description: "shared code")
            router.route(action: action) { result in
                XCTAssertEqual(result["success"] as? Bool, false)
                XCTAssertEqual(result["code"] as? String, expected)
                XCTAssertEqual(result["error"] as? String, nativeMessage)
                neutral.fulfill()
            }
            var legacyAction = action; legacyAction["type"] = "macos_" + type.dropFirst(8)
            let legacy = expectation(description: "legacy exact envelope")
            let bytes = try JSONSerialization.data(withJSONObject: native, options: .sortedKeys)
            router.route(action: legacyAction) { result in
                XCTAssertEqual(try? JSONSerialization.data(withJSONObject: result, options: .sortedKeys), bytes)
                legacy.fulfill()
            }
            wait(for: [neutral, legacy], timeout: 1)
        }
    }

    func testPermissionDenialRetainsNativeAxDetailsAndRemediation() {
        let router = Router(axTrustCheck: { false })
        router.register("value", handler: NativeResultFixture(WireFormat.success("MUST NOT RUN")))
        let reply = expectation(description: "permission preflight")
        router.route(action: ["type": "desktop_value", "ref": "e1"]) { result in
            XCTAssertEqual(result["code"] as? String, "permission_required")
            XCTAssertEqual(result["remediation"] as? String, "interceptor macos trust --walkthrough")
            let details = result["details"] as? [String: Any]
            XCTAssertEqual(details?["nativeCode"] as? String, "accessibility_unusable")
            XCTAssertEqual((details?["axError"] as? [String: Any])?["code"] as? Int, Int(AXError.apiDisabled.rawValue))
            XCTAssertEqual(details?["dispatched"] as? Bool, false)
            reply.fulfill()
        }
        wait(for: [reply], timeout: 1)
    }

    func testUncertainMutationsNeverBecomeRetryableAndRetainActualAxFailure() {
        let failed = "resize failed: \(AXError.cannotComplete.rawValue)"
        let result = DesktopAccessibilityResult.normalize(WireFormat.error(failed), type: "desktop_resize")
        XCTAssertEqual(result["code"] as? String, "timeout_unknown_outcome")
        XCTAssertEqual(result["retryable"] as? Bool, false)
        let ax = (result["details"] as? [String: Any])?["axError"] as? [String: Any]
        XCTAssertEqual(ax?["code"] as? Int, Int(AXError.cannotComplete.rawValue))
        XCTAssertEqual(ax?["name"] as? String, "kAXErrorCannotComplete")
        let postSet = DesktopAccessibilityResult.normalize(WireFormat.error("move set succeeded but post-set frame read failed"), type: "desktop_move")
        XCTAssertEqual(postSet["code"] as? String, "timeout_unknown_outcome")
        XCTAssertEqual((postSet["details"] as? [String: Any])?["dispatched"] as? Bool, true)
        XCTAssertEqual((postSet["details"] as? [String: Any])?["verified"] as? Bool, false)
        XCTAssertEqual(postSet["retryable"] as? Bool, false)
        let read = DesktopAccessibilityResult.normalize(AXTypedError.from(.cannotComplete, message: "native read failure"), type: "desktop_value")
        XCTAssertEqual(read["code"] as? String, "provider_failed")
        let unknown = DesktopAccessibilityResult.normalize(WireFormat.error("unclassified native mutation failure"), type: "desktop_type")
        XCTAssertEqual(unknown["code"] as? String, "timeout_unknown_outcome")
        XCTAssertEqual(unknown["retryable"] as? Bool, false)
        XCTAssertNil((unknown["details"] as? [String: Any])?["dispatched"])
    }

    func testUnknownNativeCodeKeepsDetailsAndBoundsUnicodeDiagnostic() {
        let native: [String: Any] = ["success": false, "code": "future_native_error", "error": String(repeating: "🙂", count: 2000), "details": ["provider": "native_fixture", "value": 42]]
        let result = DesktopAccessibilityResult.normalize(native, type: "desktop_value")
        XCTAssertEqual(result["code"] as? String, "provider_failed")
        XCTAssertEqual((result["error"] as? String)?.utf8.count, 2048)
        let details = result["details"] as? [String: Any]
        XCTAssertEqual(details?["provider"] as? String, "native_fixture")
        XCTAssertEqual(details?["value"] as? Int, 42)
        XCTAssertEqual(details?["nativeCode"] as? String, "future_native_error")
    }

    func testSuccessUnrelatedNeutralAndLegacyRepliesRemainByteIdentical() throws {
        for (type, result) in [
            ("desktop_value", WireFormat.success(["native": 42, "text": "🙂"])),
            ("desktop_clipboard", WireFormat.error("invalid ref")),
            ("macos_value", AXTypedError.from(.cannotComplete, message: "legacy AX error")),
        ] {
            XCTAssertEqual(try JSONSerialization.data(withJSONObject: DesktopAccessibilityResult.normalize(result, type: type), options: .sortedKeys), try JSONSerialization.data(withJSONObject: result, options: .sortedKeys))
        }
    }

    func testPrefixFallbackAndMissingHandlerUseTheSameNeutralErrorContract() {
        let router = Router(axTrustCheck: { true })
        router.register("val", handler: NativeResultFixture(WireFormat.error("invalid ref")))
        let fallback = expectation(description: "prefix dispatch")
        router.route(action: ["type": "desktop_value", "ref": "e1"]) { result in
            XCTAssertEqual(result["code"] as? String, "stale_reference")
            fallback.fulfill()
        }
        let missing = expectation(description: "missing implementation")
        router.route(action: ["type": "desktop_find", "query": "fixture"]) { result in
            XCTAssertEqual(result["code"] as? String, "unsupported_operation")
            missing.fulfill()
        }
        wait(for: [fallback, missing], timeout: 1)
    }
}
