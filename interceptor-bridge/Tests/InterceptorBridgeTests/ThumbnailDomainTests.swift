// ThumbnailDomain unit tests.

import XCTest
import AppKit
@testable import interceptor_bridge

final class ThumbnailDomainTests: XCTestCase {
    private let domain = ThumbnailDomain()
    private var fixturePath: String!

    override func setUp() {
        super.setUp()
        // 100x100 PNG fixture
        let img = NSImage(size: NSSize(width: 100, height: 100))
        img.lockFocus()
        NSColor.systemBlue.setFill()
        NSRect(x: 0, y: 0, width: 100, height: 100).fill()
        img.unlockFocus()
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("interceptor-thumbnail-fixture-\(UUID().uuidString).png")
        if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: url)
            fixturePath = url.path
        }
    }

    func runVerb(_ sub: String, action: [String: Any] = [:]) -> [String: Any] {
        var act = action; act["sub"] = sub
        let holder = TestResultHolder()
        let exp = expectation(description: sub)
        domain.handle(sub, action: act) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 10.0)
        return holder.value
    }

    func testGenerate_default() {
        guard let path = fixturePath else { XCTFail("no fixture"); return }
        let r = runVerb("generate", action: ["path": path, "size": "64"])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testGenerate_withSave() {
        guard let path = fixturePath else { XCTFail("no fixture"); return }
        let outPath = "\(NSTemporaryDirectory())interceptor-thumb-out-\(UUID().uuidString).png"
        let r = runVerb("generate", action: ["path": path, "size": "64", "save": true, "out": outPath, "format": "png"])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testGenerate_missingPath_errors() {
        let r = runVerb("generate")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testGenerate_unknownVerb_errors() {
        let r = runVerb("nope")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testBatch_emptyPaths_errors() {
        let r = runVerb("batch", action: ["paths": [String]()])
        XCTAssertEqual(r["success"] as? Bool, false)
    }
}
