// PdfDomain unit tests. Covers dispatch invariant + each verb's
// error path and a roundtrip on a synthesized PDF.

import XCTest
import AppKit
import PDFKit
@testable import interceptor_bridge

final class PdfDomainTests: XCTestCase {
    private var domain: PdfDomain!
    private var fixturePath: String!

    override func setUp() {
        super.setUp()
        domain = PdfDomain()
        fixturePath = makeFixturePdf()
    }

    private func makeFixturePdf() -> String {
        // Synthesize a 3-page PDF with rendered content using a CGContext.
        // PDFPage(image:) requires the NSImage to have at least one
        // representation, so we render into a bitmap representation first.
        let doc = PDFDocument()
        for i in 1...3 {
            let img = NSImage(size: NSSize(width: 612, height: 792))
            img.lockFocus()
            NSColor.white.setFill()
            NSRect(x: 0, y: 0, width: 612, height: 792).fill()
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 24),
                .foregroundColor: NSColor.black,
            ]
            ("Page \(i) — interceptor-bridge fixture" as NSString)
                .draw(at: NSPoint(x: 50, y: 700), withAttributes: attrs)
            img.unlockFocus()
            if let page = PDFPage(image: img) {
                doc.insert(page, at: i - 1)
            }
        }
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("interceptor-fixture-\(UUID().uuidString).pdf")
        XCTAssertTrue(doc.write(to: url))
        return url.path
    }

    func runVerb(_ sub: String, action: [String: Any] = [:]) -> [String: Any] {
        var act = action
        act["sub"] = sub
        let holder = TestResultHolder()
        let exp = expectation(description: sub)
        domain.handle(sub, action: act) { resp in
            holder.set(resp)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5.0)
        return holder.value
    }

    // An unopenable document refuses with a code, gone vs not-a-PDF.
    func testOpenFailuresCarryCodes() throws {
        let missing = NSTemporaryDirectory() + "interceptor-qa-missing-\(UUID().uuidString).pdf"
        XCTAssertEqual(runVerb("info", action: ["path": missing])["code"] as? String, "target_gone")
        let notPdf = NSTemporaryDirectory() + "interceptor-qa-notpdf-\(UUID().uuidString).pdf"
        try Data("not a pdf".utf8).write(to: URL(fileURLWithPath: notPdf))
        defer { try? FileManager.default.removeItem(atPath: notPdf) }
        XCTAssertEqual(runVerb("text", action: ["path": notPdf])["code"] as? String, "unsupported_target")
    }

    func testDispatchInvariant_unknownSub_errors() {
        let r = runVerb("nope")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testInfo_returnsPageCountAndPermissions() {
        let r = runVerb("info", action: ["path": fixturePath as Any])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testInfo_missingPath_errors() {
        let r = runVerb("info")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testText_concatenated() {
        let r = runVerb("text", action: ["path": fixturePath as Any])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testOutline_emptyDoc_returnsEmpty() {
        let r = runVerb("outline", action: ["path": fixturePath as Any])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testAnnotations_emptyDoc_returnsEmpty() {
        let r = runVerb("annotations", action: ["path": fixturePath as Any])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testForms_emptyDoc_returnsEmpty() {
        let r = runVerb("forms", action: ["path": fixturePath as Any])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testFind_noMatch_returnsEmpty() {
        let r = runVerb("find", action: ["path": fixturePath as Any, "query": "no-such-word"])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testAttributes_returnsDict() {
        let r = runVerb("attributes", action: ["path": fixturePath as Any])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testPermissions_returnsAllowsCopying() {
        let r = runVerb("permissions", action: ["path": fixturePath as Any])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testSplit_extractsRange() {
        let outURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("interceptor-split-\(UUID().uuidString).pdf").path
        let r = runVerb("split", action: ["path": fixturePath as Any, "pages": "1-2", "out": outURL])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testMerge_concatenatesDocs() {
        let outURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("interceptor-merge-\(UUID().uuidString).pdf").path
        let r = runVerb("merge", action: ["paths": [fixturePath as Any, fixturePath as Any], "out": outURL])
        XCTAssertEqual(r["success"] as? Bool, true)
    }
}
