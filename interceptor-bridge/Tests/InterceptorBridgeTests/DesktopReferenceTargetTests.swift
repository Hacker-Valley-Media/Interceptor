import XCTest
import ApplicationServices
@testable import interceptor_bridge

final class DesktopReferenceTargetTests: XCTestCase {
    private func request(_ domain: AccessibilityDomain, command: String, action: [String: Any]) -> [String: Any] {
        let holder = TestResultHolder()
        domain.handle(command, action: action) { holder.set($0) }
        return holder.value
    }

    func testNeutralRefSelectorsRefuseBeforeReadsWritesOrActions() {
        for command in ["value", "action", "inspect"] {
            for selector: [String: Any] in [["pid": Int(Int32.max)], ["app": "Fixture no such owned application"], ["window": 2147483646]] {
                let fake = FakeAXTransport(); fake.processID = getpid()
                fake.attributeResponses["AXValue"] = FakeAX.string("UNCHANGED")
                let domain = AccessibilityDomain(transport: fake)
                let ref = domain.refRegistry.register(AXUIElementCreateSystemWide(), pid: getpid())
                var action: [String: Any] = ["type": "desktop_" + command, "ref": ref]
                if command == "value" { action["value"] = "UNEXPECTED WRITE" }
                action.merge(selector) { _, new in new }
                let result = request(domain, command: command, action: action)
                XCTAssertEqual(result["success"] as? Bool, false, String(describing: action))
                XCTAssertEqual(result["code"] as? String, "unsupported_target")
                XCTAssertTrue(fake.setAttributes.isEmpty)
                XCTAssertTrue(fake.performedActions.isEmpty)
            }
        }
    }

    func testNeutralRefIdentityAndLivenessRefuseBeforeEffects() {
        for command in ["value", "action", "inspect"] {
            for owner in [getpid(), Int32.max] {
                let fake = FakeAXTransport(); fake.processID = owner
                let domain = AccessibilityDomain(transport: fake)
                let ref = domain.refRegistry.register(AXUIElementCreateSystemWide(), pid: owner == getpid() ? getppid() : owner)
                let result = request(domain, command: command, action: ["type": "desktop_" + command, "ref": ref, "value": "UNEXPECTED WRITE"])
                XCTAssertEqual(result["success"] as? Bool, false)
                XCTAssertEqual(result["code"] as? String, "stale_reference")
                XCTAssertTrue(fake.setAttributes.isEmpty)
                XCTAssertTrue(fake.performedActions.isEmpty)
            }
        }
    }

    func testMatchingNeutralAndLegacyRefsKeepReadWriteActionBehavior() {
        let fake = FakeAXTransport(); fake.processID = getpid()
        fake.attributeResponses["AXValue"] = FakeAX.string("Owned 🙂 文件")
        fake.settable["AXValue"] = true // an editable field; read-only fields refuse the write
        let domain = AccessibilityDomain(transport: fake)
        let ref = domain.refRegistry.register(AXUIElementCreateSystemWide(), pid: getpid())
        let read = request(domain, command: "value", action: ["type": "desktop_value", "ref": ref, "pid": getpid()])
        XCTAssertEqual(read["data"] as? String, "Owned 🙂 文件")
        for value in ["", "--pid", "New 🙂 文件"] {
            XCTAssertEqual(request(domain, command: "value", action: ["type": "desktop_value", "ref": ref, "pid": getpid(), "value": value])["success"] as? Bool, true)
            XCTAssertEqual(AXValueCodec.displayString(fake.setAttributes.last?.1), value)
        }
        XCTAssertEqual(request(domain, command: "action", action: ["type": "desktop_action", "ref": ref, "pid": getpid(), "action": "press"])["success"] as? Bool, true)
        XCTAssertEqual(fake.performedActions, ["AXPress"])
        XCTAssertEqual(request(domain, command: "value", action: ["type": "macos_value", "ref": ref, "pid": Int32.max])["data"] as? String, "Owned 🙂 文件")
    }

    func testRouterRetainsNeutralRefDiscriminators() {
        let fake = FakeAXTransport(); fake.processID = getpid()
        let handler = AccessibilityDomain(transport: fake)
        let router = Router(axTrustCheck: { true })
        for verb in ["value", "action", "inspect"] {
            router.register(verb, handler: handler)
            let ref = handler.refRegistry.register(AXUIElementCreateSystemWide(), pid: getpid())
            let holder = TestResultHolder()
            router.route(action: ["type": "desktop_" + verb, "ref": ref, "pid": Int(Int32.max)]) { holder.set($0) }
            XCTAssertEqual(holder.value["success"] as? Bool, false)
            XCTAssertEqual(holder.value["code"] as? String, "unsupported_target")
            XCTAssertTrue(fake.setAttributes.isEmpty)
            XCTAssertTrue(fake.performedActions.isEmpty)
        }
    }

    func testNeutralActionFailuresKeepTypedOutcomeWithoutGlobalClickFallback() {
        for (status, code) in [(AXError.actionUnsupported, "unsupported_target"), (.cannotComplete, "timeout_unknown_outcome")] {
            let fake = FakeAXTransport(); fake.processID = getpid(); fake.performResult = status
            let domain = AccessibilityDomain(transport: fake)
            let ref = domain.refRegistry.register(AXUIElementCreateSystemWide(), pid: getpid())
            let router = Router(axTrustCheck: { true }); router.register("action", handler: domain)
            let holder = TestResultHolder()
            router.route(action: ["type": "desktop_action", "ref": ref, "pid": Int(getpid()), "action": "press"]) { holder.set($0) }
            XCTAssertEqual(holder.value["success"] as? Bool, false)
            XCTAssertEqual(holder.value["code"] as? String, code)
            XCTAssertEqual(holder.value["retryable"] as? Bool, false)
            XCTAssertEqual(fake.performedActions, ["AXPress"])
        }
    }
}
