import XCTest
import ApplicationServices
@testable import interceptor_bridge

// Issue #222: the pure rule behind `LiveAXTransport.onMainIfSelfTargeted`.
// Marshal to the main thread iff the element is owned by this process and the
// caller is not already on main. Foreign pids keep the plain cross-process call.
final class AXSelfTargetPolicyTests: XCTestCase {

    func testSelfPidOffMainNeedsMarshal() {
        XCTAssertTrue(AXSelfTargetPolicy.needsMainThreadMarshal(elementPid: getpid(), selfPid: getpid(), isMainThread: false))
    }

    func testForeignPidNeverMarshals() {
        XCTAssertFalse(AXSelfTargetPolicy.needsMainThreadMarshal(elementPid: 1, selfPid: getpid(), isMainThread: false))
    }

    func testSelfPidAlreadyOnMainDoesNotMarshal() {
        XCTAssertFalse(AXSelfTargetPolicy.needsMainThreadMarshal(elementPid: getpid(), selfPid: getpid(), isMainThread: true))
    }

    func testUnknownPidDoesNotMarshal() {
        XCTAssertFalse(AXSelfTargetPolicy.needsMainThreadMarshal(elementPid: nil, selfPid: getpid(), isMainThread: false))
    }

    func testOwnApplicationElementReportsOwnPid() {
        // AXUIElementGetPid is a pure accessor on the element ref (no IPC, no
        // TCC), so our own application element must report our pid.
        XCTAssertEqual(AXSelfTargetPolicy.pid(of: AXUIElementCreateApplication(getpid())), getpid())
    }

    func testSystemWideElementIsNeverSelf() {
        XCTAssertNotEqual(AXSelfTargetPolicy.pid(of: AXUIElementCreateSystemWide()), getpid())
    }
}
