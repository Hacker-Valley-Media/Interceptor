import XCTest
import Foundation
@testable import interceptor_bridge

final class GuestReadValidationTests: XCTestCase {
    func testMacVmAdmissionRejectsTimeoutsBeyondTheSharedContract() {
        let action: [String: Any] = ["type": "macos_vm_logs", "sub": "logs", "name": "guest1", "timeout": 50]
        XCTAssertNil(DesktopVmValidation.validationError(action, sub: "logs"))
        for value in [0.5, 51, 300] {
            var changed = action; changed["timeout"] = value
            XCTAssertNotNil(DesktopVmValidation.validationError(changed, sub: "logs"))
        }
    }
    func testSecureAndUnclassifiedValuesCannotCrossTheHostReadBoundary() throws {
        let action: [String: Any] = ["app": "Fixture"], root: [String: Any] = ["ref": "ax1", "role": "AXSecureTextField", "secure": true, "valueState": "redacted", "value": "•••"]
        let raw: [String: Any] = ["app": "Fixture", "bundleIdentifier": "test.fixture", "selector": "Fixture", "pid": 123, "tree": root, "visited": 1, "maxDepth": 4, "partial": false, "reasons": [String](), "refsActionable": false]
        _ = try GuestReadValidation.payload(raw, verb: "read_ax", action: action, name: "guest1")
        for change in [["value": "private canary"], ["secure": false], ["valueState": "read"], ["role": "AXTextField", "secure": false, "valueState": "read", "value": "unknown field canary"]] as [[String: Any]] {
            var changed = raw; changed["tree"] = root.merging(change) { _, new in new }
            XCTAssertThrowsError(try GuestReadValidation.payload(changed, verb: "read_ax", action: action, name: "guest1"))
        }
        for change in [["selector": "other"], ["pid": 0], ["visited": 501], ["maxDepth": 5], ["refsActionable": true], ["partial": true], ["name": "foreign"], ["unknown": true]] as [[String: Any]] {
            XCTAssertThrowsError(try GuestReadValidation.payload(raw.merging(change) { _, new in new }, verb: "read_ax", action: action, name: "guest1"))
        }
    }
    func testUnavailableLogsAndMountEffectsNeedExactNativeScope() throws {
        let logs: [String: Any] = ["logs": [["path": "/tmp/InterceptorD.err.log", "lines": [String](), "state": "unavailable", "truncated": false, "error": "missing file"], ["path": "/tmp/InterceptorD.out.log", "lines": ["native line"], "state": "read", "truncated": false]], "partial": true]
        _ = try GuestReadValidation.payload(logs, verb: "logs", action: ["limit": 1], name: "guest1")
        XCTAssertThrowsError(try GuestReadValidation.payload(logs.merging(["partial": false]) { _, new in new }, verb: "logs", action: ["limit": 1], name: "guest1"))
        let mount: [String: Any] = ["tag": "data", "path": "/tmp/data", "nativeMountPath": "/private/tmp/data", "fileSystem": "virtiofs", "mounted": true]
        _ = try GuestReadValidation.payload(mount, verb: "mount", action: ["tag": "data", "path": "/tmp/data"], name: "guest1")
        XCTAssertThrowsError(try GuestReadValidation.payload(mount, verb: "mount", action: ["tag": "foreign", "path": "/tmp/data"], name: "guest1"))
        XCTAssertThrowsError(try GuestReadValidation.payload(mount.merging(["mounted": false]) { _, new in new }, verb: "mount", action: ["tag": "data", "path": "/tmp/data"], name: "guest1"))
    }
    func testPermissionReadsCannotClaimUnrequestedNativePrompts() throws {
        let trust: [String: Any] = ["platform": "macos", "accessibility": "denied", "screenRecording": "granted", "postEvent": "denied", "inputMonitoring": "granted", "notes": [String]()]
        _ = try GuestReadValidation.payload(trust, verb: "trust", action: ["noPrompt": true], name: "guest1")
        for change in [["prompted": ["Accessibility"]], ["opened": ["Accessibility"]], ["postEvent": "unknown"], ["platform": "linux"]] as [[String: Any]] {
            XCTAssertThrowsError(try GuestReadValidation.payload(trust.merging(change) { _, new in new }, verb: "trust", action: ["noPrompt": true], name: "guest1"))
        }
    }
}
