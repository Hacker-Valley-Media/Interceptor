import XCTest
@testable import interceptor_bridge

private final class LogContractHandler: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        completion(WireFormat.success(["command": command, "type": action["type"] as? String ?? ""]))
    }
}
final class DesktopLogContractTests: XCTestCase {
    func testLiteralPredicateAndTimestampValidation() throws {
        let terms = try DesktopLogValidation.terms(#"subsystem == "quote\" 文件" AND message CONTAINS "AND""#)
        XCTAssertEqual(terms.count, 2); XCTAssertEqual(terms[0].value, "quote\" 文件")
        for predicate in ["message == 'a'", #"message == "a" OR process == "b""#, #"message == "a" AND"#, #"message == "a"ANDmessage == "b""#, #"message == "\u0000""#] {
            XCTAssertThrowsError(try DesktopLogValidation.terms(predicate))
        }
        for value in ["2024-02-29T18:00:00.123456789+05:30", "2026-10-04T00:00:00Z"] { XCTAssertNotNil(DesktopLogValidation.timestamp(value)) }
        for value in ["2026-02-29T18:00:00Z", "2026-01-01t00:00:00z", "2026-01-01T00:00:60Z", "2026-01-01T00:00:00+25:00", "0000-01-01T00:00:00Z"] { XCTAssertNil(DesktopLogValidation.timestamp(value), value) }
    }
    func testRouterRejectsMalformedNeutralCallsAndPreservesBothDiscriminators() {
        let router = Router(axTrustCheck: { false }); router.register("log", handler: LogContractHandler())
        for fields: [String: Any] in [["limit": 0], ["limit": 1001], ["limit": 1.5], ["includeInfo": NSNull()], ["since": "2026-02-30T00:00:00Z"], ["extra": true], ["predicate": #"message == "a" OR process == "b""#]] {
            var action = fields; action["type"] = "desktop_log_query"
            let replied = expectation(description: "invalid log")
            router.route(action: action) { result in
                XCTAssertEqual(result["success"] as? Bool, false); XCTAssertEqual(result["code"] as? String, "invalid_request"); replied.fulfill()
            }
            wait(for: [replied], timeout: 1)
        }
        for type in ["desktop_log_query", "macos_log_query"] {
            let replied = expectation(description: "retain log discriminator")
            router.route(action: ["type": type]) { result in
                let data = result["data"] as? [String: Any]
                XCTAssertEqual(data?["type"] as? String, type); XCTAssertEqual(data?["command"] as? String, "query"); replied.fulfill()
            }
            wait(for: [replied], timeout: 1)
        }
    }
}
