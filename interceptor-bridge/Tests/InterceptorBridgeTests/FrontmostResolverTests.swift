import XCTest
import ApplicationServices
@testable import interceptor_bridge

// Issue #168: the resolver must PULL the frontmost app live (AX first, then
// window list) and only fall back to the frozen NSWorkspace cache last.
// These tests pin the ladder's order and fall-through behavior.
final class FrontmostResolverTests: XCTestCase {
    func testAXFocusedApplicationWinsOverAllFallbacks() {
        let fake = FakeAXTransport()
        // FakeAXTransport serves a real AXUIElement for the attribute and
        // returns pid 4242 from pid().
        fake.attributeResponses[kAXFocusedApplicationAttribute as String] = AXUIElementCreateSystemWide()
        let pid = FrontmostResolver.resolvePID(
            transport: fake,
            windowListPID: { XCTFail("window list consulted despite AX success"); return 1 },
            cachedPID: { XCTFail("cache consulted despite AX success"); return 2 }
        )
        XCTAssertEqual(pid, 4242)
    }

    func testAXFailureFallsThroughToWindowList() {
        let fake = FakeAXTransport() // no attribute response → .noValue
        let pid = FrontmostResolver.resolvePID(
            transport: fake,
            windowListPID: { 777 },
            cachedPID: { XCTFail("cache consulted despite window-list hit"); return 2 }
        )
        XCTAssertEqual(pid, 777)
    }

    func testWindowListFailureFallsThroughToCache() {
        let fake = FakeAXTransport()
        let pid = FrontmostResolver.resolvePID(
            transport: fake,
            windowListPID: { nil },
            cachedPID: { 999 }
        )
        XCTAssertEqual(pid, 999)
    }

    func testAllStagesEmptyReturnsNil() {
        let fake = FakeAXTransport()
        let pid = FrontmostResolver.resolvePID(
            transport: fake,
            windowListPID: { nil },
            cachedPID: { nil }
        )
        XCTAssertNil(pid)
    }

    func testNonElementAttributeValueFallsThrough() {
        let fake = FakeAXTransport()
        // A CFString where an AXUIElement is expected must not crash or match.
        fake.attributeResponses[kAXFocusedApplicationAttribute as String] = "not an element" as CFString
        let pid = FrontmostResolver.resolvePID(
            transport: fake,
            windowListPID: { 777 },
            cachedPID: { nil }
        )
        XCTAssertEqual(pid, 777)
    }
}
