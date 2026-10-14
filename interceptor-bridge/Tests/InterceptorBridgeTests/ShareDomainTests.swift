// ShareDomain unit tests.

import XCTest
import AppKit
@testable import interceptor_bridge

final class ShareDomainTests: XCTestCase {
    private let domain = ShareDomain()

    func runVerb(_ sub: String, action: [String: Any] = [:]) -> [String: Any] {
        var act = action; act["sub"] = sub
        let holder = TestResultHolder()
        let exp = expectation(description: sub)
        domain.handle(sub, action: act) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 5.0)
        return holder.value
    }

    // A missing file refuses at once instead of being shared as text.
    func testMissingFileRefusesBeforeAnyService() {
        let r = runVerb("email", action: ["items": ["/nope/interceptor-qa-missing.txt"], "recipient": "a@x.invalid"])
        XCTAssertEqual(r["code"] as? String, "permission_denied")
        XCTAssertTrue((r["error"] as? String ?? "").contains("inaccessible"))
    }

    func testServices_returnsLiveList() {
        let r = runVerb("services")
        XCTAssertEqual(r["success"] as? Bool, true)
        let data = r["data"] as? [String: Any]
        XCTAssertNotNil(data?["services"])
    }

    func testNamed_unknownService_errors() {
        let r = runVerb("named", action: ["service": "com.does.not.exist"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testText_missingValue_errors() {
        let r = runVerb("text", action: ["service": "com.apple.share.AirDrop.send"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testUrl_missingService_errors() {
        let r = runVerb("url", action: ["value": "https://example.com"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testUnknownVerb_errors() {
        let r = runVerb("nope")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testServices_forItem_filtersByApplicableServices() {
        let r = runVerb("services", action: ["for_item": "/etc/hosts"])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testAirdrop_live() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_SHARE"] == "1")
        let r = runVerb("airdrop", action: ["items": ["/etc/hosts"]])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testStrictRequestsRefuseDiscardedPayloads() {
        let actions: [[String: Any]] = [
            ["type": "desktop_share", "sub": "services", "body": "discarded"],
            ["type": "desktop_share", "sub": "text", "service": "email", "value": "actual", "items": ["discarded"]],
            ["type": "desktop_share", "sub": "email", "text": "actual", "recipient": "a", "recipients": ["b"]],
            ["type": "desktop_share", "sub": "url", "service": "email", "value": "javascript:alert(1)"]
        ]
        for action in actions { XCTAssertNotNil(ShareDomain.actionError(action)) }
        XCTAssertNil(ShareDomain.actionError(["type": "desktop_share", "sub": "email", "text": "actual", "subject": "actual subject"]))
    }

    @MainActor func testDeadlineRepliesOnceButRetiresOnlyOnNativeCompletion() {
        let service = NSSharingService(title: "Owned fixture", image: NSImage(size: NSSize(width: 1, height: 1)), alternateImage: nil, handler: {})
        let other = NSSharingService(title: "Other fixture", image: NSImage(size: NSSize(width: 1, height: 1)), alternateImage: nil, handler: {})
        let reply = TestResultHolder(), retirement = TestResultHolder()
        let once = expectation(description: "one terminal client reply")
        once.assertForOverFulfill = true
        let request = ShareRequest(service: service, items: ["actual"], identifier: "owned", completion: { reply.set($0); once.fulfill() }, retired: { retirement.set(["retired": true]) })
        service.delegate = request
        request.sharingService(other, didShareItems: ["wrong service"])
        XCTAssertTrue(reply.value.isEmpty)
        request.deadline()
        XCTAssertEqual(reply.value["code"] as? String, "timeout_unknown_outcome")
        XCTAssertTrue(retirement.value.isEmpty)
        XCTAssertTrue(service.delegate === request)
        request.sharingService(service, didShareItems: ["actual"])
        XCTAssertEqual(retirement.value["retired"] as? Bool, true)
        XCTAssertNil(service.delegate)
        request.failed(NSError(domain: "Owned fixture", code: 7))
        request.deadline()
        wait(for: [once], timeout: 1)
    }

    @MainActor func testActualFailurePreservesNativeErrorAndReleasesDelegate() {
        let service = NSSharingService(title: "Owned fixture", image: NSImage(size: NSSize(width: 1, height: 1)), alternateImage: nil, handler: {})
        let reply = TestResultHolder(), retirement = TestResultHolder()
        let request = ShareRequest(service: service, items: ["actual"], identifier: "owned", completion: { reply.set($0) }, retired: { retirement.set(["retired": true]) })
        service.delegate = request
        request.sharingService(service, didFailToShareItems: ["actual"], error: NSError(domain: "Owned fixture", code: 7))
        XCTAssertEqual(reply.value["code"] as? String, "provider_failed")
        XCTAssertEqual((reply.value["details"] as? [String: Any])?["nativeCode"] as? Int, 7)
        XCTAssertEqual(retirement.value["retired"] as? Bool, true)
        XCTAssertNil(service.delegate)
    }

    @MainActor func testNativeCompletionCarriesObservedMetadata() {
        let service = NSSharingService(title: "Owned fixture", image: NSImage(size: NSSize(width: 1, height: 1)), alternateImage: nil, handler: {})
        service.recipients = ["owned@example.test"]
        service.subject = "actual subject"
        let reply = TestResultHolder()
        let request = ShareRequest(service: service, items: ["actual"], identifier: "owned", completion: { reply.set($0) }, retired: {})
        service.delegate = request
        XCTAssertTrue(reply.value.isEmpty)
        request.sharingService(service, didShareItems: ["actual"])
        XCTAssertNil(ShareDomain.resultError(reply.value))
        let data = reply.value["data"] as? [String: Any]
        XCTAssertEqual(data?["outcome"] as? String, "shared")
        XCTAssertEqual(data?["items"] as? [String], ["actual"])
        XCTAssertEqual(data?["recipients"] as? [String], ["owned@example.test"])
        XCTAssertEqual(data?["subject"] as? String, "actual subject")
        XCTAssertNil(service.delegate)
    }
}
