import XCTest
import Foundation
import AgentJS

// A plain ObjC-dispatched class the hook engine can interpose.
@objc(ITCHookTarget) final class ITCHookTarget: NSObject {
    var lastThing = 0
    @objc dynamic func setThing(_ x: Int) -> Int { lastThing = x; return x * 2 }
}

private func drain(_ clear: Int32 = 1) -> String {
    guard let c = itc_hook_drain(clear, 0) else { return "" }
    defer { free(c) }
    return String(cString: c)
}

final class HookEngineTests: XCTestCase {

    func testHookCapturesArgAndReturnAndPreservesOriginal() {
        _ = drain()  // clear buffer

        let installed = "ITCHookTarget".withCString { itc_hook_install($0, "setThing:") }
        XCTAssertNotNil(installed)
        if let installed { XCTAssertTrue(String(cString: installed).contains("\"ok\":true")); free(installed) }

        let t = ITCHookTarget()
        let r = t.setThing(42)

        // the ORIGINAL still ran: return value (x*2) and side effect survive the hook
        XCTAssertEqual(r, 84, "hooked method must still return the original value")
        XCTAssertEqual(t.lastThing, 42, "hooked method's side effect must still happen")

        // a hit was captured with the argument and return value
        let hits = drain()
        XCTAssertTrue(hits.contains("setThing:"), "hit should record the selector")
        XCTAssertTrue(hits.contains("42"), "hit should record the captured argument")
        XCTAssertTrue(hits.contains("84"), "hit should record the captured return value")
        XCTAssertTrue(hits.contains("\"domain\":\"Debugger\""))
    }

    func testUnhookStopsCapture() {
        _ = "ITCHookTarget".withCString { c in "setThing:".withCString { s in itc_hook_install(c, s) } }.map { free($0) }
        let t = ITCHookTarget()
        _ = t.setThing(1)
        XCTAssertTrue(drain().contains("setThing:"))

        let removed = "ITCHookTarget".withCString { c in "setThing:".withCString { s in itc_hook_remove(c, s) } }
        if let removed { free(removed) }

        _ = drain()  // clear
        _ = t.setThing(2)  // should NOT be captured anymore
        XCTAssertFalse(drain().contains("setThing:"), "removed hook must not capture further calls")
    }

    func testRefusesUnsafeSelectorsAndRootClasses() {
        let s1 = "ITCHookTarget".withCString { c in "release".withCString { s in itc_hook_install(c, s) } }
        if let s1 { XCTAssertTrue(String(cString: s1).contains("\"ok\":false")); free(s1) }
        let s2 = "NSObject".withCString { c in "description".withCString { s in itc_hook_install(c, s) } }
        if let s2 { XCTAssertTrue(String(cString: s2).contains("\"ok\":false")); free(s2) }
    }

    func testHookListReportsInstalled() {
        _ = "ITCHookTarget".withCString { c in "setThing:".withCString { s in itc_hook_install(c, s) } }.map { free($0) }
        guard let l = itc_hook_list() else { return XCTFail("list returned null") }
        defer { free(l) }
        XCTAssertTrue(String(cString: l).contains("ITCHookTarget"))
    }
}
