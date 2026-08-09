import XCTest
@testable import interceptor_bridge

// Router-level Accessibility trust gate (issue #163): AX-dependent verbs
// must fail loud with a typed, actionable error when the bridge is not a
// trusted accessibility client — never dispatch into a handler that would
// degrade into empty-success.

private final class RecordingHandler: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var _invocations: [String] = []

    var invocations: [String] {
        lock.lock(); defer { lock.unlock() }
        return _invocations
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock(); _invocations.append(command); lock.unlock()
        completion(WireFormat.success("handled"))
    }
}

final class RouterTrustGateTests: XCTestCase {
    // The exact registration set from Sources/main.swift that reads or
    // drives apps through the Accessibility API.
    private let gatedKeys = [
        "tree", "find", "inspect", "value", "action", "focused", "windows",
        "resize", "move", "click", "type", "keys", "scroll", "drag",
        "menu", "text",
    ]

    func testUntrustedRouterBlocksEveryAxGatedVerb() {
        let handler = RecordingHandler()
        let router = Router(axTrustCheck: { false })
        for key in gatedKeys { router.register(key, handler: handler) }

        for key in gatedKeys {
            let exp = expectation(description: "gate \(key)")
            router.route(action: ["type": "macos_\(key)"]) { result in
                XCTAssertEqual(result["success"] as? Bool, false, "\(key) must fail when untrusted")
                XCTAssertEqual(result["code"] as? String, "accessibility_unusable", "\(key) must carry the typed code")
                XCTAssertEqual(result["remediation"] as? String, "interceptor macos trust --walkthrough")
                let message = result["error"] as? String ?? ""
                XCTAssertTrue(message.contains("needs Accessibility"), "\(key) message must name the missing permission")
                XCTAssertTrue(message.contains(key), "\(key) message must name the verb")
                exp.fulfill()
            }
            wait(for: [exp], timeout: 1.0)
        }
        XCTAssertTrue(handler.invocations.isEmpty, "no gated verb may reach its handler when untrusted")
    }

    func testUntrustedGateErrorCarriesApiDisabledDetails() {
        let router = Router(axTrustCheck: { false })
        router.register("tree", handler: RecordingHandler())

        let exp = expectation(description: "typed details")
        router.route(action: ["type": "macos_tree"]) { result in
            let details = result["details"] as? [String: Any]
            let axError = details?["axError"] as? [String: Any]
            XCTAssertEqual(axError?["code"] as? Int, -25211, "must carry kAXErrorAPIDisabled")
            XCTAssertEqual(axError?["name"] as? String, "kAXErrorAPIDisabled")
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
    }

    func testTrustedRouterDispatchesGatedVerbs() {
        let handler = RecordingHandler()
        let router = Router(axTrustCheck: { true })
        router.register("tree", handler: handler)

        let exp = expectation(description: "dispatch")
        router.route(action: ["type": "macos_tree"]) { result in
            XCTAssertEqual(result["success"] as? Bool, true)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
        XCTAssertEqual(handler.invocations, ["tree"])
    }

    func testUntrustedRouterStillDispatchesNonGatedVerbs() {
        let handler = RecordingHandler()
        let router = Router(axTrustCheck: { false })
        router.register("apps", handler: handler)

        let exp = expectation(description: "non-gated dispatch")
        router.route(action: ["type": "macos_apps"]) { result in
            XCTAssertEqual(result["success"] as? Bool, true, "apps needs no Accessibility and must pass")
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1.0)
        XCTAssertEqual(handler.invocations, ["apps"])
    }

    func testGateErrorMentionsAdhocSignatureOnlyWhenAdhoc() {
        let plain = Router.accessibilityGateError(verb: "tree", adhocSigned: false)
        let plainMessage = plain["error"] as? String ?? ""
        XCTAssertFalse(plainMessage.contains("ad-hoc"), "signed builds must not get the ad-hoc note")

        let adhoc = Router.accessibilityGateError(verb: "tree", adhocSigned: true)
        let adhocMessage = adhoc["error"] as? String ?? ""
        XCTAssertTrue(adhocMessage.contains("ad-hoc signed"), "ad-hoc builds must get the stale-row diagnosis")
        XCTAssertTrue(adhocMessage.contains("Remove the row"), "ad-hoc note must include the fix")
    }
}
