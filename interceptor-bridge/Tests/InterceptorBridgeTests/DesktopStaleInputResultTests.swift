import XCTest
@testable import interceptor_bridge

final class DesktopStaleInputResultTests: XCTestCase {
    func testExplicitDeliveryEvidenceNeverBecomesAnUndeliveredRefusal() {
        let native: [String: Any] = ["success": false, "error": "ref e1 not found", "details": ["dispatched": true]]
        let result = DesktopAccessibilityResult.normalize(native, type: "desktop_type")
        XCTAssertEqual(result["code"] as? String, "timeout_unknown_outcome")
        XCTAssertEqual((result["details"] as? [String: Any])?["dispatched"] as? Bool, true)
        XCTAssertEqual(result["retryable"] as? Bool, false)
    }

    func testSelectorAndCoordinateRefusalsReportStaleWithoutDelivery() throws {
        let selector = InputTargetSelector(resolveRef: { _ in nil }, resolvePidByName: { _ in nil })
        for ref in ["e0", "e123", "e" + String(repeating: "9", count: 63)] {
            let selectorMessage = try XCTUnwrap(selector.explicitTargetProblem(ref: ref, appName: nil, pid: nil))
            for message in [selectorMessage, "ref \(ref) not found"] {
                let native = WireFormat.error(message)
                for type in ["desktop_click", "desktop_type"] {
                    let result = DesktopAccessibilityResult.normalize(native, type: type)
                    XCTAssertEqual(result["code"] as? String, "stale_reference")
                    XCTAssertEqual((result["details"] as? [String: Any])?["dispatched"] as? Bool, false)
                    XCTAssertEqual(result["retryable"] as? Bool, false)
                    XCTAssertEqual(result["error"] as? String, message)
                }
                let compound = DesktopCompoundValidation.normalize(native, type: "desktop_act")
                XCTAssertEqual(compound["code"] as? String, "stale_reference")
                XCTAssertEqual((compound["details"] as? [String: Any])?["dispatched"] as? Bool, false)
                for type in ["macos_click", "macos_type"] {
                    XCTAssertEqual(try JSONSerialization.data(withJSONObject: DesktopAccessibilityResult.normalize(native, type: type), options: .sortedKeys), try JSONSerialization.data(withJSONObject: native, options: .sortedKeys))
                }
            }
        }
    }

    func testOtherErrorsKeepTheirDeliveryUncertaintyAndExplicitCodes() {
        for message in ["ref e1 not found in target text", "prefix ref e1 not found", "ref bad not found", "ref e1 not found\n", "unclassified native mutation failure"] {
            let result = DesktopAccessibilityResult.normalize(WireFormat.error(message), type: "desktop_type")
            XCTAssertEqual(result["code"] as? String, "timeout_unknown_outcome")
            XCTAssertNil((result["details"] as? [String: Any])?["dispatched"])
        }
        let coded: [String: Any] = ["success": false, "code": "permission_denied", "error": "ref e1 not found", "details": ["dispatched": true]]
        let result = DesktopAccessibilityResult.normalize(coded, type: "desktop_click")
        XCTAssertEqual(result["code"] as? String, "permission_denied")
        XCTAssertEqual((result["details"] as? [String: Any])?["dispatched"] as? Bool, true)
        let read = DesktopAccessibilityResult.normalize(WireFormat.error("ref e1 not found"), type: "desktop_text")
        XCTAssertEqual(read["code"] as? String, "provider_failed")
    }
}
