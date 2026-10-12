import XCTest
import ApplicationServices
@testable import interceptor_bridge

final class PhysicalKeyTypingTests: XCTestCase {
    func testPhysicalTextDistinguishesAFromOtherLettersAndModifiers() throws {
        let keys = try XCTUnwrap(InputDomain.usPhysicalKeys("aAzZ19!?\t\n"))
        XCTAssertEqual(keys.map { $0.0 }, [0, 0, 6, 6, 18, 25, 18, 44, 48, 36])
        XCTAssertEqual(keys.map { $0.1 }, [false, true, false, true, false, false, true, true, false, false])
        XCTAssertNotNil(InputDomain.usPhysicalKeys(String((32...126).map { Character(UnicodeScalar($0)!) })))
    }

    func testUnsupportedTextRefusesBeforeAXWriteOrKeyDelivery() {
        for text in ["valid prefix 文件", "valid prefix\u{0000}", "valid prefix🙂"] {
            let domain = InputDomain(), holder = TestResultHolder()
            domain.handle("type", action: ["text": text, "keycodesUS": true]) { reply in holder.set(reply) }
            XCTAssertEqual(holder.value["success"] as? Bool, false)
            XCTAssertTrue((holder.value["error"] as? String)?.contains("nothing was typed") == true)
        }
    }
}
