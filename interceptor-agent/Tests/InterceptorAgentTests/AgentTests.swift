import XCTest
import AppKit
@testable import InterceptorAgent

final class AgentTests: XCTestCase {
    func testSlugify() {
        XCTAssertEqual(InterceptorAgent.slugify("My Cool App.app"), "my-cool-app-app")
        XCTAssertEqual(InterceptorAgent.slugify("MyApp"), "myapp")
        XCTAssertEqual(InterceptorAgent.slugify("  A/B  "), "a-b")
    }

    func testCompiledSliceIsKnown() {
        XCTAssertTrue(["arm64", "x86_64", "unknown"].contains(InterceptorAgent.compiledSlice()))
    }

    func testJSONRoundTrip() {
        let s = JSONUtil.encode(["success": true, "data": ["n": 3, "s": "hi"]])
        let back = JSONUtil.decode(s)
        XCTAssertEqual(back?["success"] as? Bool, true)
        let data = back?["data"] as? [String: Any]
        XCTAssertEqual(data?["s"] as? String, "hi")
    }

    func testJSONSanitizeCoercesUnknown() {
        // A CGRect is not JSON-serializable; sanitize must stringify it.
        let s = JSONUtil.encode(["r": CGRect(x: 0, y: 0, width: 1, height: 1)])
        XCTAssertTrue(s.contains("\"r\""))
        XCTAssertNotNil(JSONUtil.decode(s))
    }

    func testRefRegistry() {
        let reg = RefRegistry()
        let obj = NSObject()
        let ref = reg.register(obj)
        XCTAssertTrue(ref.hasPrefix("n"))
        XCTAssertTrue(reg.resolve(ref) === obj)
        reg.clear()
        XCTAssertNil(reg.resolve(ref))
    }

    @MainActor
    func testSetTextChangesStringValue() {
        let field = NSTextField(labelWithString: "before")
        let applied = Verbs.setText(field, "after")
        XCTAssertTrue(applied.contains("stringValue"))
        XCTAssertEqual(field.stringValue, "after")
    }

    @MainActor
    func testSetTextChangesButtonTitle() {
        let button = NSButton(title: "before", target: nil, action: nil)
        let applied = Verbs.setText(button, "after")
        XCTAssertTrue(applied.contains("stringValue") || applied.contains("title"))
        XCTAssertEqual(button.title, "after")
    }

    @MainActor
    func testReadableText() {
        let field = NSTextField(labelWithString: "hello")
        XCTAssertEqual(Verbs.readableText(field), "hello")
    }
}
