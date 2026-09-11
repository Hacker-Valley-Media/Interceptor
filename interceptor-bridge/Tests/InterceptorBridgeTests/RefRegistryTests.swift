import XCTest
import ApplicationServices
@testable import interceptor_bridge

final class RefRegistryTests: XCTestCase {
    func testRegistryStoresPIDMetadataAlongsideElementRefs() {
        let registry = RefRegistry()
        let element = AXUIElementCreateSystemWide()
        let ref = registry.register(element, pid: 4242)

        XCTAssertNotNil(registry.resolve(ref))
        XCTAssertEqual(registry.resolvePID(ref), 4242)
        XCTAssertEqual(registry.resolveInfo(ref)?.pid, 4242)
    }

    // Refs are unique for the bridge lifetime. Clearing drops the entries but
    // keeps counting, so a ref an agent still holds from an earlier tree read
    // can never resolve to another app's element (native-ref probe, 2026-09-10).
    func testClearRemovesElementsButKeepsIssuingFreshRefs() {
        let registry = RefRegistry()
        let old = registry.register(AXUIElementCreateSystemWide(), pid: 101)
        registry.clear()

        XCTAssertEqual(registry.count, 0)
        XCTAssertEqual(registry.currentCount(), 1, "the counter must not rewind")

        let next = registry.register(AXUIElementCreateSystemWide(), pid: 202)
        XCTAssertEqual(next, "e2")
        XCTAssertNotEqual(next, old)
        XCTAssertNil(registry.resolvePID(old), "a cleared ref resolves to nothing, never to the new owner")
        XCTAssertEqual(registry.resolvePID(next), 202)
    }
}
