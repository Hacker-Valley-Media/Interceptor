// PRD-66 — PhotosDomain unit tests. Live tests gated behind LIVE_PHOTOS=1.

import XCTest
@testable import interceptor_bridge

final class PhotosDomainTests: XCTestCase {
    private let domain = PhotosDomain()

    func runVerb(_ sub: String, action: [String: Any] = [:]) -> [String: Any] {
        var act = action; act["sub"] = sub
        let holder = TestResultHolder()
        let exp = expectation(description: sub)
        domain.handle(sub, action: act) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 10.0)
        return holder.value
    }

    func testStatus_returnsAuthField() {
        let r = runVerb("status")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testAlbum_missingId_errors() {
        let r = runVerb("album")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testAsset_missingId_errors() {
        let r = runVerb("asset")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testExport_missingFields_errors() {
        let r = runVerb("export")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testFavorite_missingId_errors() {
        let r = runVerb("favorite")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testHide_missingId_errors() {
        let r = runVerb("hide")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testDelete_missingId_errors() {
        let r = runVerb("delete")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testAlbumCreate_missingName_errors() {
        let r = runVerb("album-create")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testImport_missingFile_errors() {
        let r = runVerb("import")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testUnknownVerb_errors() {
        let r = runVerb("nope")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testExport_rejectsUnsupportedFormat() {
        // --format used to be accepted and silently discarded, so a bad value looked
        // identical to a good one. Validate before any asset lookup can mask it.
        let r = runVerb("export", action: ["id": "bogus/L0/001", "out": "/tmp/x.jpg", "format": "webp"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testExport_live_formatJpegTranscodesHEIC() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_PHOTOS"] == "1")
        let assets = runVerb("assets", action: ["limit": 1])
        guard let list = assets["assets"] as? [[String: Any]], let id = list.first?["id"] as? String else {
            throw XCTSkip("no assets in library")
        }
        let out = NSTemporaryDirectory() + "interceptor-photos-format-test.jpg"
        let r = runVerb("export", action: ["id": id, "out": out, "format": "jpeg"])
        XCTAssertEqual(r["success"] as? Bool, true)
        XCTAssertEqual(r["uti"] as? String, "public.jpeg")
        try? FileManager.default.removeItem(atPath: out)
    }

    func testExport_live_sizeComposesWithFormatPng() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_PHOTOS"] == "1")
        let assets = runVerb("assets", action: ["limit": 1])
        guard let list = assets["assets"] as? [[String: Any]], let id = list.first?["id"] as? String else {
            throw XCTSkip("no assets in library")
        }
        let out = NSTemporaryDirectory() + "interceptor-photos-size-png-test.png"
        // The resize branch used to hardcode JPEG, so --size + --format png wrote
        // JPEG bytes under a .png name. The two flags must compose.
        let r = runVerb("export", action: ["id": id, "out": out, "size": 200, "format": "png"])
        XCTAssertEqual(r["success"] as? Bool, true)
        XCTAssertEqual(r["uti"] as? String, "public.png")
        if let data = FileManager.default.contents(atPath: out) {
            XCTAssertEqual([UInt8](data.prefix(4)), [0x89, 0x50, 0x4E, 0x47]) // PNG magic
        } else {
            XCTFail("no file written at \(out)")
        }
        try? FileManager.default.removeItem(atPath: out)
    }

    func testThumbnail_live_outImpliesSave() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_PHOTOS"] == "1")
        let assets = runVerb("assets", action: ["limit": 1])
        guard let list = assets["assets"] as? [[String: Any]], let id = list.first?["id"] as? String else {
            throw XCTSkip("no assets in library")
        }
        let out = NSTemporaryDirectory() + "interceptor-photos-thumb-test.jpg"
        try? FileManager.default.removeItem(atPath: out)
        // --out alone, no --save: must write the file rather than return a base64 dataUrl.
        let r = runVerb("thumbnail", action: ["id": id, "out": out])
        XCTAssertEqual(r["success"] as? Bool, true)
        XCTAssertNil(r["dataUrl"])
        XCTAssertEqual(r["filePath"] as? String, out)
        XCTAssertTrue(FileManager.default.fileExists(atPath: out))
        try? FileManager.default.removeItem(atPath: out)
    }

    func testAlbums_live() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_PHOTOS"] == "1")
        let r = runVerb("albums")
        XCTAssertEqual(r["success"] as? Bool, true)
    }
}
