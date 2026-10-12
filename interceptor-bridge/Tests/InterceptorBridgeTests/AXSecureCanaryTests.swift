import XCTest
import ApplicationServices
@testable import interceptor_bridge

// secure canary. A unique secure-field value must never appear in
// any product output: not through the codec, the redaction helper, a typed
// error, or the TextDomain read path.
final class AXSecureCanaryTests: XCTestCase {
    static let canary = "CANARY-a7f3e9c1-9d2b-4e10-secret-password"

    private func containsCanary(_ obj: [String: Any]) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return false }
        return s.contains(Self.canary)
    }

    func testCodecRedactsSecureValue() {
        let t = AXValueCodec.tag(FakeAX.string(Self.canary), secure: true)
        XCTAssertEqual(t["kind"] as? String, "redacted")
        XCTAssertFalse(containsCanary(t))
    }

    func testRedactionHelperReplacesSecureDisplayString() {
        let out = AXSecureRedaction.displayString(FakeAX.string(Self.canary), secure: true)
        XCTAssertEqual(out, AXSecureRedaction.placeholder)
        XCTAssertNotEqual(out, Self.canary)
    }

    func testTypedErrorNeverCarriesCanary() {
        let err = AXTypedError.errorDict("read failed", code: "secure_value_redacted")
        XCTAssertFalse(containsCanary(err))
    }

    // The load-bearing path: TextDomain reading a secure field returns the
    // placeholder, never the field contents.
    func testTextDomainRedactsSecureField() {
        let registry = RefRegistry()
        let ref = registry.register(AXUIElementCreateSystemWide(), pid: 4242)

        let fake = FakeAXTransport()
        fake.attributeResponses["AXRole"] = FakeAX.string("AXSecureTextField")
        fake.attributeResponses["AXValue"] = FakeAX.string(Self.canary)

        let domain = TextDomain(refRegistry: registry, transport: fake)
        let holder = TestResultHolder()
        domain.handle("text", action: ["ref": ref, "mode": "full"]) { holder.set($0) }
        let captured = holder.value

        XCTAssertEqual(captured["data"] as? String, AXSecureRedaction.placeholder)
        XCTAssertFalse(containsCanary(captured))
    }

    func testSecureClassificationBySubrole() {
        XCTAssertTrue(AXSecureRedaction.isSecure(role: "AXTextField", subrole: "AXSecureTextField"))
        XCTAssertFalse(AXSecureRedaction.isSecure(role: "AXTextField", subrole: nil))
    }

    func testCompatibilityValueAndInspectRedactSecureAttributes() {
        for role in ["AXSecureTextField", "AXTextField"] {
            let fake = FakeAXTransport()
            fake.attributeResponses["AXRole"] = FakeAX.string(role)
            fake.attributeResponses["AXSubrole"] = FakeAX.string("AXSecureTextField")
            fake.attributeResponses["AXValue"] = FakeAX.string(Self.canary)
            fake.attributeResponses["AXSelectedText"] = FakeAX.string(Self.canary)
            let domain = AccessibilityDomain(transport: fake)
            let ref = domain.refRegistry.register(AXUIElementCreateSystemWide(), pid: 4242)
            for command in ["value", "inspect"] {
                let holder = TestResultHolder()
                domain.handle(command, action: ["ref": ref]) { holder.set($0) }
                let captured = holder.value
                XCTAssertEqual(captured["success"] as? Bool, true)
                XCTAssertFalse(containsCanary(captured), command)
                if command == "value" {
                    XCTAssertEqual(captured["data"] as? String, AXSecureRedaction.placeholder)
                } else {
                    let attributes = captured["data"] as? [String: Any]
                    XCTAssertEqual(attributes?["Value"] as? String, AXSecureRedaction.placeholder)
                    XCTAssertEqual(attributes?["SelectedText"] as? String, AXSecureRedaction.placeholder)
                }
            }
        }
    }

    func testCompatibilityTreeRedactsSecureValue() {
        let fake = FakeAXTransport()
        fake.attributeResponses["AXRole"] = FakeAX.string("AXTextField")
        fake.attributeResponses["AXSubrole"] = FakeAX.string("AXSecureTextField")
        fake.attributeResponses["AXDescription"] = FakeAX.string("Owned secure fixture")
        fake.attributeResponses["AXValue"] = FakeAX.string(Self.canary)
        let domain = AccessibilityDomain(transport: fake)
        var output = ""
        domain.buildTree(element: AXUIElementCreateSystemWide(), pid: 4242, depth: 0, maxDepth: 1, filter: "all", output: &output, maxChars: 5000, budget: AXBudget(maxMs: 1000, maxNodes: 10, maxCalls: 100))
        XCTAssertFalse(output.contains(Self.canary))
        XCTAssertTrue(output.contains(AXSecureRedaction.placeholder))
        XCTAssertTrue(output.contains("Owned secure fixture"))
    }

    func testCompatibilityNonsecureReadsAndValueWriteKeepTheirContents() {
        let fake = FakeAXTransport()
        fake.attributeResponses["AXRole"] = FakeAX.string("AXTextField")
        fake.attributeResponses["AXValue"] = FakeAX.string("Owned 🙂 文件")
        fake.attributeResponses["AXSelectedText"] = FakeAX.string("🙂 文件")
        fake.settable["AXValue"] = true // an editable field; read-only fields now refuse the write
        let domain = AccessibilityDomain(transport: fake)
        let ref = domain.refRegistry.register(AXUIElementCreateSystemWide(), pid: 4242)
        let value = TestResultHolder()
        domain.handle("value", action: ["ref": ref]) { value.set($0) }
        XCTAssertEqual(value.value["data"] as? String, "Owned 🙂 文件")
        let inspect = TestResultHolder()
        domain.handle("inspect", action: ["ref": ref]) { inspect.set($0) }
        let attributes = inspect.value["data"] as? [String: Any]
        XCTAssertEqual(attributes?["Value"] as? String, "Owned 🙂 文件")
        XCTAssertEqual(attributes?["SelectedText"] as? String, "🙂 文件")
        let write = TestResultHolder()
        domain.handle("value", action: ["ref": ref, "value": "New 🙂 文件"]) { write.set($0) }
        XCTAssertEqual(write.value["success"] as? Bool, true)
        XCTAssertEqual(fake.setAttributes.count, 1)
        XCTAssertEqual(AXValueCodec.displayString(fake.setAttributes[0].1), "New 🙂 文件")
    }

    // Windows and Linux refuse writes to read-only or disabled controls and presses on disabled ones.
    func testReadOnlyAndDisabledControlsRefuseWithoutWriting() {
        let fake = FakeAXTransport()
        fake.attributeResponses["AXRole"] = FakeAX.string("AXTextField")
        let domain = AccessibilityDomain(transport: fake)
        let ref = domain.refRegistry.register(AXUIElementCreateSystemWide(), pid: 4242)
        let readOnly = TestResultHolder()
        domain.handle("value", action: ["ref": ref, "value": "x"]) { readOnly.set($0) }
        XCTAssertEqual(readOnly.value["error"] as? String, "value is read-only; nothing was changed")
        fake.settable["AXValue"] = true
        fake.attributeResponses["AXEnabled"] = kCFBooleanFalse
        let disabled = TestResultHolder(), press = TestResultHolder()
        domain.handle("value", action: ["ref": ref, "value": "x"]) { disabled.set($0) }
        domain.handle("action", action: ["ref": ref, "action": "press"]) { press.set($0) }
        XCTAssertEqual(disabled.value["error"] as? String, "element is disabled; nothing was changed")
        XCTAssertEqual(press.value["error"] as? String, "element is disabled; no action was performed")
        XCTAssertTrue(fake.setAttributes.isEmpty)
        XCTAssertTrue(fake.performedActions.isEmpty)
    }
}
