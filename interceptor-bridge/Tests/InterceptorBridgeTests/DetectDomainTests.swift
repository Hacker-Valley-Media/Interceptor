// DetectDomain unit tests.

import XCTest
import Darwin
@testable import interceptor_bridge

final class DetectDomainTests: XCTestCase {
    private let domain = DetectDomain()

    func runVerb(_ sub: String, action: [String: Any] = [:]) -> [String: Any] {
        var act = action; act["sub"] = sub
        let holder = TestResultHolder()
        let exp = expectation(description: sub)
        domain.handle(sub, action: act) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 5.0)
        return holder.value
    }

    func testTypes_listsDetectorVocabulary() {
        let r = runVerb("types")
        XCTAssertEqual(r["success"] as? Bool, true)
        let data = r["data"] as? [String: Any]
        let types = data?["types"] as? [String] ?? []
        XCTAssertTrue(types.contains("link"))
        XCTAssertTrue(types.contains("phoneNumber"))
        XCTAssertTrue(types.contains("calendarEvent"))
        XCTAssertTrue(types.contains("postalAddress"))
    }

    func testRun_phoneNumber_match() {
        let r = runVerb("run", action: ["input": "Call me at 555-1234 tomorrow"])
        XCTAssertEqual(r["success"] as? Bool, true)
        let data = r["data"] as? [String: Any]
        let matches = data?["matches"] as? [[String: Any]] ?? []
        XCTAssertTrue(matches.contains(where: { ($0["type"] as? String) == "phoneNumber" }))
    }

    func testRun_url_match() {
        let r = runVerb("run", action: ["input": "Visit https://example.com for details"])
        XCTAssertEqual(r["success"] as? Bool, true)
        let data = r["data"] as? [String: Any]
        let matches = data?["matches"] as? [[String: Any]] ?? []
        XCTAssertTrue(matches.contains(where: { ($0["type"] as? String) == "link" }))
    }

    func testRun_typesFilter_phoneOnly() {
        let r = runVerb("run", action: ["input": "Call 555-1234 or visit https://example.com", "types": "phone"])
        XCTAssertEqual(r["success"] as? Bool, true)
        let data = r["data"] as? [String: Any]
        let matches = data?["matches"] as? [[String: Any]] ?? []
        XCTAssertTrue(matches.allSatisfy { ($0["type"] as? String) == "phoneNumber" })
    }

    func testRun_missingInput_errors() {
        let r = runVerb("run")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testFile_missingPath_errors() {
        let r = runVerb("file")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testStrictSelectionBoundsAndModernMoney() throws {
        for action: [String: Any] in [["input": "hello", "types": "unknown"], ["input": "hello", "types": "phone,"], ["input": String(repeating: "x", count: 65_537)]] {
            XCTAssertEqual(runVerb("run", action: action)["success"] as? Bool, false)
        }
        let filtered = runVerb("run", action: ["input": "Mail person@example.com or visit https://example.com", "types": "email"])
        let matches = (filtered["data"] as? [String: Any])?["matches"] as? [[String: Any]] ?? []
        XCTAssertFalse(matches.isEmpty)
        XCTAssertTrue(matches.allSatisfy { $0["type"] as? String == "emailAddress" })
        let money = runVerb("run", action: ["input": "The price is $42.50.", "types": "moneyAmount"])
        if #available(macOS 26, *) {
            XCTAssertEqual(money["success"] as? Bool, true)
            let rows = (money["data"] as? [String: Any])?["matches"] as? [[String: Any]] ?? []
            XCTAssertTrue(rows.contains { ($0["type"] as? String) == "moneyAmount" && ($0["components"] as? [String: Any])?["amount"] as? String == "42.5" })
        } else { XCTAssertEqual(money["success"] as? Bool, false) }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("interceptor-detect-\(UUID().uuidString).txt")
        try Data(repeating: 120, count: 65_537).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        XCTAssertEqual(runVerb("file", action: ["path": file.path])["success"] as? Bool, false)
        XCTAssertEqual(runVerb("file", action: ["path": file.path + "\0"])["success"] as? Bool, false)
        let fifo = FileManager.default.temporaryDirectory.appendingPathComponent("interceptor-detect-\(UUID().uuidString).fifo")
        XCTAssertEqual(Darwin.mkfifo(fifo.path, 0o600), 0)
        defer { try? FileManager.default.removeItem(at: fifo) }
        XCTAssertEqual(runVerb("file", action: ["path": fifo.path])["success"] as? Bool, false)
    }
}
