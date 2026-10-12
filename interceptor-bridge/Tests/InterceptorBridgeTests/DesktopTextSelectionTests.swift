import XCTest
import ApplicationServices
@testable import interceptor_bridge

final class DesktopTextSelectionTests: XCTestCase {
    func testNeutralOwnershipRefusalPrecedesSelectedTextAndLegacyRemainsUnchanged() {
        let registry = RefRegistry(), fake = FakeAXTransport()
        let ref = registry.register(AXUIElementCreateSystemWide(), pid: 4242)
        fake.attributeResponses["AXRole"] = FakeAX.string("AXTextField")
        fake.attributeResponses["AXSelectedText"] = FakeAX.string("Selected \u{1F642} \u{6587}\u{4EF6}")
        let domain = TextDomain(refRegistry: registry, transport: fake, pidIsLive: { $0 == 4242 })
        let owned = TestResultHolder()
        domain.handle("text", action: ["type": "desktop_text", "ref": ref, "pid": 4242, "mode": "selection"]) { owned.set($0) }
        XCTAssertEqual(owned.value["data"] as? String, "Selected \u{1F642} \u{6587}\u{4EF6}")
        let count = fake.callCount, foreign = TestResultHolder()
        domain.handle("text", action: ["type": "desktop_text", "ref": ref, "pid": 42, "mode": "selection"]) { foreign.set($0) }
        XCTAssertEqual(foreign.value["code"] as? String, "unsupported_target")
        XCTAssertEqual(fake.callCount, count + 1)
        let legacy = TestResultHolder()
        domain.handle("text", action: ["type": "macos_text", "ref": ref, "pid": 42, "mode": "selection"]) { legacy.set($0) }
        XCTAssertEqual(legacy.value["data"] as? String, owned.value["data"] as? String)
        registry.clear()
        let stale = TestResultHolder()
        domain.handle("text", action: ["type": "desktop_text", "ref": ref, "mode": "selection"]) { stale.set($0) }
        XCTAssertEqual(stale.value["code"] as? String, "stale_reference")
    }

    func testEmptySelectionAndEverySecureTextMode() {
        let registry = RefRegistry(), fake = FakeAXTransport()
        let ref = registry.register(AXUIElementCreateSystemWide(), pid: 4242)
        fake.attributeResponses["AXRole"] = FakeAX.string("AXTextField")
        fake.attributeResponses["AXSelectedText"] = FakeAX.string("")
        let domain = TextDomain(refRegistry: registry, transport: fake, pidIsLive: { $0 == 4242 }), empty = TestResultHolder()
        domain.handle("text", action: ["type": "desktop_text", "ref": ref, "mode": "selection"]) { empty.set($0) }
        XCTAssertEqual(empty.value["data"] as? String, "")
        fake.attributeResponses["AXRole"] = FakeAX.string("AXSecureTextField")
        fake.attributeResponses["AXSelectedText"] = FakeAX.string("SYNTHETIC SECRET MUST NOT LEAK")
        for mode in ["full", "selection", "visible"] {
            let secure = TestResultHolder()
            domain.handle("text", action: ["type": "desktop_text", "ref": ref, "mode": mode]) { secure.set($0) }
            XCTAssertEqual(secure.value["data"] as? String, AXSecureRedaction.placeholder)
        }
    }

    func testExitedNeutralOwnerRefusesBeforeReadingTextAndLegacyKeepsItsResult() {
        let registry = RefRegistry(), fake = FakeAXTransport()
        let ref = registry.register(AXUIElementCreateSystemWide(), pid: 4242)
        fake.attributeResponses["AXRole"] = FakeAX.string("AXTextField")
        fake.attributeResponses["AXValue"] = FakeAX.string("Retained value")
        fake.attributeResponses["AXSelectedText"] = FakeAX.string("Retained selection")
        let domain = TextDomain(refRegistry: registry, transport: fake, pidIsLive: { _ in false })
        for mode in ["full", "visible", "selection"] {
            let before = fake.callCount, stale = TestResultHolder()
            domain.handle("text", action: ["type": "desktop_text", "ref": ref, "mode": mode]) { stale.set($0) }
            XCTAssertEqual(stale.value["code"] as? String, "stale_reference")
            XCTAssertEqual(fake.callCount, before + 1, "Only the retained AX PID may be queried")
        }
        let legacy = TestResultHolder()
        domain.handle("text", action: ["type": "macos_text", "ref": ref]) { legacy.set($0) }
        XCTAssertEqual(legacy.value["data"] as? String, "Retained value")
    }
}
