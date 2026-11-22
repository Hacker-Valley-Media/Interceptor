import XCTest
import ApplicationServices
@testable import interceptor_bridge

// Batched tree reads, ref-keyed tree diff, chunked typing.
final class NativeSpeedTests: XCTestCase {
    func testTreeNodeIsOneBatchedCallAndStillRedactsSecureValues() {
        let fake = FakeAXTransport()
        fake.attributeResponses["AXRole"] = FakeAX.string("AXTextField")
        fake.attributeResponses["AXSubrole"] = FakeAX.string("AXSecureTextField")
        fake.attributeResponses["AXDescription"] = FakeAX.string("Owned secure fixture")
        fake.attributeResponses["AXValue"] = FakeAX.string("CANARY-SECRET-VALUE")
        let domain = AccessibilityDomain(transport: fake)
        let budget = AXBudget(maxMs: 1000, maxNodes: 10, maxCalls: 100)
        var output = ""
        domain.buildTree(element: AXUIElementCreateSystemWide(), pid: 4242, depth: 0, maxDepth: 1, filter: "all", output: &output, maxChars: 5000, budget: budget)
        XCTAssertEqual(budget.callsUsed, 1, "one AXUIElementCopyMultipleAttributeValues per node")
        XCTAssertEqual(fake.callCount, 1, "no single-attribute reads on the batched path")
        XCTAssertFalse(output.contains("CANARY-SECRET-VALUE"))
        XCTAssertTrue(output.contains(AXSecureRedaction.placeholder))
        XCTAssertTrue(output.contains("Owned secure fixture"))
    }

    func testTreeDiffIsKeyedByRef() {
        let old = AXTreeMemory.lines("[e1] button \"Save\"\n  [e2] checkbox \"Agree\" value=\"0\"\n[e3] textfield \"Name\"")
        let new = AXTreeMemory.lines("[e1] button \"Save\"\n  [e2] checkbox \"Agree\" value=\"1\"\n[e4] button \"Close\"")
        let d = AXTreeMemory.diff(old: old, new: new)
        XCTAssertEqual(d["added"], ["[e4] button \"Close\""])
        XCTAssertEqual(d["removed"], ["[e3] textfield \"Name\""])
        XCTAssertEqual(d["changed"], ["[e2] checkbox \"Agree\" value=\"0\" → [e2] checkbox \"Agree\" value=\"1\""])
    }

    func testTreeMemorySwapReturnsTheTreeItReplaces() {
        let memory = AXTreeMemory()
        XCTAssertNil(memory.swap(key: "k", tree: "[e1] button \"A\""))
        XCTAssertEqual(memory.swap(key: "k", tree: "[e1] button \"B\"")?["e1"], "[e1] button \"A\"")
    }

    func testUnicodeChunksKeepCharactersWholeAndControlKeysAlone() {
        let chunks = InputDomain.unicodeChunks(String(repeating: "a", count: 45))
        XCTAssertEqual(chunks.map { $0.count }, [20, 20, 5])
        let mixed = InputDomain.unicodeChunks("hi\nthere\tok")
        XCTAssertEqual(mixed.map { String(utf16CodeUnits: $0, count: $0.count) }, ["hi", "\n", "there", "\t", "ok"])
        // 19 ASCII then an emoji (2 UTF-16 units): the emoji moves to the next event.
        let emoji = InputDomain.unicodeChunks(String(repeating: "x", count: 19) + "🙂" + "y")
        XCTAssertEqual(emoji.map { $0.count }, [19, 3])
        XCTAssertEqual(InputDomain.unicodeChunks("文件🙂").flatMap { $0 }, Array("文件🙂".utf16))
    }
}
