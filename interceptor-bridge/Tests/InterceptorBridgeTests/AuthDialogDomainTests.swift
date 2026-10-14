import XCTest
import ApplicationServices
@testable import interceptor_bridge

final class AuthDialogDomainTests: XCTestCase {
    func testOneTimeAllowWinsOverPersistentApproval() {
        let transport = FakeAXTransport()
        let domain = AuthDialogDomain(transport: transport)
        let window = AXUIElementCreateApplication(4242)
        let secure = AXUIElementCreateApplication(4243)
        for titles in [["Always Allow", "Deny", "Allow"], ["OK", "Always Allow", "Allow"]] {
            var scan = AuthDialogDomain.DialogScan(pid: 4242, window: window, title: "")
            scan.secureField = secure
            scan.buttons = titles.map { ($0, AXUIElementCreateSystemWide()) }
            let result = domain.submit(scan, expected: scan)
            XCTAssertEqual(result["success"] as? Bool, true)
            XCTAssertEqual(result["data"] as? String, "Allow")
        }
        XCTAssertEqual(transport.performedActions, [kAXPressAction as String, kAXPressAction as String])
    }

    func testPersistentUnknownAndAmbiguousControlsNeverSubmit() {
        let transport = FakeAXTransport()
        let domain = AuthDialogDomain(transport: transport)
        for titles in [["Always Allow", "Deny"], ["Approve permanently"], ["Allow", "Allow"], ["Install", "Unlock"]] {
            var scan = AuthDialogDomain.DialogScan(pid: 4242, window: AXUIElementCreateApplication(4242), title: "")
            scan.secureField = AXUIElementCreateSystemWide()
            scan.buttons = titles.map { ($0, AXUIElementCreateSystemWide()) }
            let result = domain.submit(scan, expected: scan)
            XCTAssertEqual(result["success"] as? Bool, false)
            XCTAssertEqual(result["retryable"] as? Bool, false)
            XCTAssertEqual((result["details"] as? [String: Any])?["dispatched"] as? Bool, false)
        }
        XCTAssertTrue(transport.performedActions.isEmpty)
    }

    func testInstallerConfirmationStillSubmitsOnce() {
        let transport = FakeAXTransport()
        let domain = AuthDialogDomain(transport: transport)
        var scan = AuthDialogDomain.DialogScan(pid: 4242, window: AXUIElementCreateApplication(4242), title: "")
        scan.secureField = AXUIElementCreateSystemWide()
        scan.buttons = [("Help", AXUIElementCreateSystemWide()), ("Cancel", AXUIElementCreateSystemWide()), ("Install Software", AXUIElementCreateSystemWide())]
        let result = domain.submit(scan, expected: scan)
        XCTAssertEqual(result["data"] as? String, "Install Software")
        XCTAssertEqual(transport.performedActions.count, 1)
    }

    func testChangedDialogAndMissingPasswordFieldRefuseBeforePress() {
        let transport = FakeAXTransport()
        let domain = AuthDialogDomain(transport: transport)
        var expected = AuthDialogDomain.DialogScan(pid: 4242, window: AXUIElementCreateApplication(4242), title: "")
        expected.secureField = AXUIElementCreateSystemWide()
        expected.buttons = [("Allow", AXUIElementCreateSystemWide())]
        var changed = expected
        changed.pid = 4243
        XCTAssertEqual(domain.submit(changed, expected: expected)["code"] as? String, "target_gone")
        changed = expected
        changed.window = AXUIElementCreateApplication(4243)
        XCTAssertEqual(domain.submit(changed, expected: expected)["code"] as? String, "target_gone")
        changed = expected
        changed.secureField = nil
        XCTAssertEqual(domain.submit(changed, expected: expected)["code"] as? String, "target_gone")
        XCTAssertTrue(transport.performedActions.isEmpty)
    }

    func testUncertainPressNeverRetriesOrFallsBackToReturn() {
        let transport = FakeAXTransport()
        transport.performResult = .cannotComplete
        transport.actionEffectHappened = true
        let domain = AuthDialogDomain(transport: transport)
        var scan = AuthDialogDomain.DialogScan(pid: 4242, window: AXUIElementCreateApplication(4242), title: "")
        scan.secureField = AXUIElementCreateSystemWide()
        scan.buttons = [("Allow", AXUIElementCreateSystemWide())]
        let result = domain.submit(scan, expected: scan)
        XCTAssertEqual(result["code"] as? String, "timeout_unknown_outcome")
        XCTAssertEqual(result["retryable"] as? Bool, false)
        XCTAssertEqual((result["details"] as? [String: Any])?["dispatched"] as? Bool, true)
        XCTAssertEqual(transport.performedActions.count, 1)
    }
}
