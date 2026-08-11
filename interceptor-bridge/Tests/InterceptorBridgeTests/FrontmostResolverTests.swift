import XCTest
import ApplicationServices
@testable import interceptor_bridge

// Issues #168/#198: the resolver must PULL the frontmost app live — system-wide
// AX first, then the per-app AXFrontmost scan (windowless frontmost apps), then
// the window list — and only fall back to the frozen NSWorkspace cache last.
// These tests pin the ladder's order, fall-through behavior, and the reported
// source stage.
final class FrontmostResolverTests: XCTestCase {
    func testAXFocusedApplicationWinsOverAllFallbacks() {
        let fake = FakeAXTransport()
        // FakeAXTransport serves a real AXUIElement for the attribute and
        // returns pid 4242 from pid().
        fake.attributeResponses[kAXFocusedApplicationAttribute as String] = AXUIElementCreateSystemWide()
        let result = FrontmostResolver.resolvePID(
            transport: fake,
            scanCandidates: { XCTFail("scan consulted despite AX success"); return [] },
            windowListPID: { XCTFail("window list consulted despite AX success"); return 1 },
            cachedPID: { XCTFail("cache consulted despite AX success"); return 2 }
        )
        XCTAssertEqual(result?.pid, 4242)
        XCTAssertEqual(result?.source, .ax)
    }

    func testAXFailureFallsToFrontmostScan() {
        let fake = FakeAXTransport() // no focused-app response → .noValue
        // Every candidate app element answers AXFrontmost = true in the fake,
        // so the scan must return the FIRST candidate.
        fake.attributeResponses[kAXFrontmostAttribute as String] = kCFBooleanTrue
        let result = FrontmostResolver.resolvePID(
            transport: fake,
            scanCandidates: { [301, 302] },
            windowListPID: { XCTFail("window list consulted despite scan hit"); return 1 },
            cachedPID: { XCTFail("cache consulted despite scan hit"); return 2 }
        )
        XCTAssertEqual(result?.pid, 301)
        XCTAssertEqual(result?.source, .axScan)
    }

    func testScanSkipsNonFrontmostCandidatesAndFallsToWindowList() {
        let fake = FakeAXTransport()
        // AXFrontmost = false for every candidate: the scan must reject all
        // of them and the ladder must continue to the window list.
        fake.attributeResponses[kAXFrontmostAttribute as String] = kCFBooleanFalse
        let result = FrontmostResolver.resolvePID(
            transport: fake,
            scanCandidates: { [301, 302] },
            windowListPID: { 777 },
            cachedPID: { XCTFail("cache consulted despite window-list hit"); return 2 }
        )
        XCTAssertEqual(result?.pid, 777)
        XCTAssertEqual(result?.source, .windowList)
    }

    func testScanErrorFallsThroughToWindowList() {
        let fake = FakeAXTransport() // no AXFrontmost response → .noValue per candidate
        let result = FrontmostResolver.resolvePID(
            transport: fake,
            scanCandidates: { [301] },
            windowListPID: { 777 },
            cachedPID: { nil }
        )
        XCTAssertEqual(result?.pid, 777)
        XCTAssertEqual(result?.source, .windowList)
    }

    func testWindowListFailureFallsThroughToCache() {
        let fake = FakeAXTransport()
        let result = FrontmostResolver.resolvePID(
            transport: fake,
            scanCandidates: { [] },
            windowListPID: { nil },
            cachedPID: { 999 }
        )
        XCTAssertEqual(result?.pid, 999)
        XCTAssertEqual(result?.source, .cached)
    }

    func testAllStagesEmptyReturnsNil() {
        let fake = FakeAXTransport()
        let result = FrontmostResolver.resolvePID(
            transport: fake,
            scanCandidates: { [] },
            windowListPID: { nil },
            cachedPID: { nil }
        )
        XCTAssertNil(result)
    }

    func testNonElementAttributeValueFallsThrough() {
        let fake = FakeAXTransport()
        // A CFString where an AXUIElement is expected must not crash or match.
        fake.attributeResponses[kAXFocusedApplicationAttribute as String] = "not an element" as CFString
        let result = FrontmostResolver.resolvePID(
            transport: fake,
            scanCandidates: { [] },
            windowListPID: { 777 },
            cachedPID: { nil }
        )
        XCTAssertEqual(result?.pid, 777)
        XCTAssertEqual(result?.source, .windowList)
    }
}
