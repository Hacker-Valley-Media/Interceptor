// ContactsDomain unit tests. Live tests gated behind LIVE_CONTACTS=1.

import XCTest
@testable import interceptor_bridge

final class ContactsDomainTests: XCTestCase {
    private let domain = ContactsDomain()

    func runVerb(_ sub: String, action: [String: Any] = [:]) -> [String: Any] {
        var act = action; act["sub"] = sub
        let holder = TestResultHolder()
        let exp = expectation(description: sub)
        domain.handle(sub, action: act) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 10.0)
        return holder.value
    }

    // A native call that never returns is given up at the deadline, later calls run;
    // a second stuck call keeps the family refusing and says how to recover.
    func testStuckNativeCallIsGivenUpOnce() {
        let domain = ContactsDomain(); domain.deadline = 0.2
        // A stuck native call keeps its completion alive without ever calling it.
        let hang = AtomicFlag(), stuck = NSMutableArray()
        domain.nativeForTesting = { finish in if hang.set() { stuck.add(finish); return }; finish(WireFormat.success(["granted": true, "error": NSNull()])) }
        func run() -> [String: Any] {
            let holder = TestResultHolder(), exp = expectation(description: "request")
            domain.handle("request", action: ["sub": "request"]) { holder.set($0); exp.fulfill() }
            wait(for: [exp], timeout: 5); return holder.value
        }
        XCTAssertTrue((run()["error"] as? String ?? "").contains("given up"))
        XCTAssertEqual(run()["success"] as? Bool, true)
        domain.nativeForTesting = { finish in stuck.add(finish) }
        XCTAssertTrue((run()["error"] as? String ?? "").contains("earlier call is still stuck"))
        let refused = run()
        XCTAssertEqual(refused["code"] as? String, "resource_limit")
        XCTAssertTrue((refused["error"] as? String ?? "").contains("launchctl kickstart"))
    }

    // A default page of photo-heavy rows keeps every row under the reply cap; only thumbnails past it go.
    func testDefaultPageDropsThumbnailsThatWouldPassTheReplyCap() throws {
        let thumbnail = "data:image/jpeg;base64," + String(repeating: "A", count: 40_000)
        let rows = (0..<100).map { ["id": "c\($0)", "imageDataAvailable": true, "thumbnailDataUrl": thumbnail] as [String: Any] }
        let fitted = ContactsDomain.fitDefaultThumbnails(rows)
        XCTAssertEqual(fitted.map { $0["id"] as? String }, rows.map { $0["id"] as? String })
        XCTAssertNotNil(fitted.first?["thumbnailDataUrl"])
        XCTAssertNil(fitted.last?["thumbnailDataUrl"])
        let reply = WireFormat.success(["limit": 100, "offset": 0, "contacts": fitted])
        XCTAssertNil(DesktopContactsValidation.resultError(reply, sub: "list", action: ["type": "desktop_contacts", "sub": "list"]))
        XCTAssertNotNil(DesktopContactsValidation.resultError(WireFormat.success(["limit": 100, "offset": 0, "contacts": rows]), sub: "list", action: ["type": "desktop_contacts", "sub": "list"]))
    }

    // Offline tests — input-validation only; never enter the framework.

    func testStrictFieldsRefuseDiscardedDataAndInvalidBirthdays() {
        let actions: [[String: Any]] = [
            ["type": "desktop_contacts", "sub": "status", "id": "discarded"],
            ["type": "desktop_contacts", "sub": "find", "query": "name", "email": "other"],
            ["type": "desktop_contacts", "sub": "list", "limit": 0],
            ["type": "desktop_contacts", "sub": "list", "keys": "givenName,givenName"],
            ["type": "desktop_contacts", "sub": "list", "keys": "unknown"],
            ["type": "desktop_contacts", "sub": "list", "container": "c", "group": "g"],
            ["type": "desktop_contacts", "sub": "create", "birthday": "2026-02-30"],
            ["type": "desktop_contacts", "sub": "changes", "since": "not-base64!"],
            ["type": "desktop_contacts", "sub": "import-vcard", "path": "relative.vcf"]
        ]
        for action in actions { XCTAssertNotNil(DesktopContactsValidation.actionError(action)) }
        XCTAssertNil(DesktopContactsValidation.actionError(["type": "desktop_contacts", "sub": "update", "id": "native-id", "given": "", "birthday": "2024-02-29", "postal": "home:street;;state;;country"]))
    }

    func testHistoryAndVCardReceiptsRefuseSyntheticMetadata() {
        XCTAssertNotNil(DesktopContactsValidation.resultError(WireFormat.success(["currentToken": "YWN0dWFs", "events": [], "note": "No native enumeration"]), sub: "changes", action: [:]))
        XCTAssertNil(DesktopContactsValidation.resultError(WireFormat.success(["currentToken": "YWN0dWFs", "events": [["type": "deleteContact", "contactId": "native-id"]]]), sub: "changes", action: [:]))
        XCTAssertNotNil(DesktopContactsValidation.resultError(WireFormat.success(["id": "native-id", "vcard": "é", "bytes": 1]), sub: "vcard", action: [:]))
        XCTAssertNil(DesktopContactsValidation.resultError(WireFormat.success(["id": "native-id", "vcard": "é", "bytes": 2]), sub: "vcard", action: [:]))
    }

    func testContactsCalendarDatesPreserveFloatingAndYearlessValues() {
        XCTAssertEqual(ContactsDomain.calendarDate(DateComponents(year: 2024, month: 2, day: 29)), "2024-02-29")
        XCTAssertEqual(ContactsDomain.calendarDate(DateComponents(month: 2, day: 29)), "--02-29")
        XCTAssertNil(ContactsDomain.calendarDate(DateComponents(year: 2026, month: 2, day: 30)))
        XCTAssertNil(ContactsDomain.calendarDate(DateComponents(year: 2026, day: 4)))
        XCTAssertNotNil(DesktopContactsValidation.actionError(["type": "desktop_contacts", "sub": "create", "birthday": "0000-01-01"]))
        XCTAssertNotNil(DesktopContactsValidation.resultError(WireFormat.success(["token": "%%%"]), sub: "current-token", action: [:]))
        XCTAssertNotNil(DesktopContactsValidation.resultError(WireFormat.success(["ok": true, "group": "other", "contact": "c", "added": true]), sub: "group-add-member", action: ["id": "g", "contact": "c"]))
    }

    func testStatus_returnsAuthField() {
        let r = runVerb("status")
        XCTAssertEqual(r["success"] as? Bool, true)
    }
    func testContactImageURLPreservesPNGAndRefusesInvalidOrOversizedBytes() throws {
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")!
        let value = try ContactsDomain.imageDataURL(png)
        XCTAssertTrue(value.hasPrefix("data:image/png;base64,"))
        XCTAssertEqual(Data(base64Encoded: String(value.split(separator: ",", maxSplits: 1)[1])), png)
        XCTAssertThrowsError(try ContactsDomain.imageDataURL(Data("not an image".utf8)))
        XCTAssertThrowsError(try ContactsDomain.imageDataURL(Data(repeating: 0, count: 196609)))
    }

    func testContact_missingId_errors() {
        let r = runVerb("contact")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testFind_missingQuery_errors() {
        let r = runVerb("find")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testGroupCreate_missingName_errors() {
        let r = runVerb("group-create")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testImportVcard_missingPath_errors() {
        let r = runVerb("import-vcard")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testUnknownVerb_errors() {
        let r = runVerb("nope")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    // Live tests — gated behind LIVE_CONTACTS=1. These call into CNContactStore
    // and block on TCC consent if Contacts access isn't already granted.

    func testDefaultContainer_live() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_CONTACTS"] == "1")
        let r = runVerb("default-container")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testUpdate_unknownId_live() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_CONTACTS"] == "1")
        let r = runVerb("update", action: ["id": "no-such-id"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testDelete_unknownId_live() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_CONTACTS"] == "1")
        let r = runVerb("delete", action: ["id": "no-such-id"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testVcard_unknownId_live() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_CONTACTS"] == "1")
        let r = runVerb("vcard", action: ["id": "no-such-id"])
        XCTAssertNotNil(r["success"])
    }

    func testCurrentToken_live() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_CONTACTS"] == "1")
        let r = runVerb("current-token")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testList_live() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_CONTACTS"] == "1")
        let r = runVerb("list", action: ["limit": 5])
        XCTAssertEqual(r["success"] as? Bool, true)
    }
}
