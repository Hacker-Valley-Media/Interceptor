import XCTest
import AppKit
import ImageIO
@testable import interceptor_bridge

final class DesktopThumbnailContractTests: XCTestCase {
    private func invoke(_ action: [String: Any], router: Router? = nil) -> [String: Any] {
        let holder = TestResultHolder()
        let replied = expectation(description: "thumbnail reply")
        let completion: @Sendable ([String: Any]) -> Void = { result in holder.set(result); replied.fulfill() }
        if let router { router.route(action: action, completion: completion) }
        else { ThumbnailDomain().handle("", action: action, completion: completion) }
        wait(for: [replied], timeout: 15)
        return holder.value
    }
    private func fixture(_ root: URL) throws -> URL {
        let rep = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 32, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 256, bitsPerPixel: 32))
        let pixels = try XCTUnwrap(rep.bitmapData)
        for y in 0..<32 { for x in 0..<64 {
            let offset = y * rep.bytesPerRow + x * 4
            pixels[offset] = x < 32 ? 0 : 255; pixels[offset+1] = 0; pixels[offset+2] = x < 32 ? 255 : 0; pixels[offset+3] = 255
        } }
        let path = root.appendingPathComponent("文件.png")
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: path)
        return path
    }
    func testNeutralRouterRejectsMalformedRequestsWithoutAccessibilityPermission() {
        let router = Router(axTrustCheck: { false }); router.register("thumbnail", handler: ThumbnailDomain())
        let base: [String: Any] = ["type": "desktop_thumbnail", "sub": "generate", "path": "/owned/a.png"]
        for fields: [String: Any] in [["path": "relative"], ["size": "0"], ["size": "1.5"], ["scale": 1.5], ["scale": NSNull()], ["size": "9999", "scale": 8], ["types": "unknown"], ["out": "/owned/output.png"], ["extra": true]] {
            let result = invoke(base.merging(fields) { _, right in right }, router: router)
            XCTAssertEqual(result["success"] as? Bool, false); XCTAssertEqual(result["code"] as? String, "invalid_request")
        }
        let missing = invoke(base, router: router)
        XCTAssertEqual(missing["code"] as? String, "target_gone")
    }
    func testSavedThumbnailUsesActualImageDimensionsAndPreservesItsSource() throws {
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(".build/thumbnail-tests/interceptor-neutral-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = try fixture(root); let original = try Data(contentsOf: source)
        let router = Router(axTrustCheck: { false }); router.register("thumbnail", handler: ThumbnailDomain())
        for format in ["png", "jpeg"] {
            let out = root.appendingPathComponent("output.\(format)")
            let action: [String: Any] = ["type": "desktop_thumbnail", "sub": "generate", "path": source.path, "size": "100x80", "scale": 2, "format": format, "save": true, "out": out.path]
            let result = invoke(action, router: router)
            XCTAssertEqual(result["success"] as? Bool, true, "\(result)")
            let data = try XCTUnwrap(result["data"] as? [String: Any]); let bytes = try Data(contentsOf: out)
            let imageSource = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
            let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(imageSource, 0, nil))
            XCTAssertEqual(image.width, 64); XCTAssertEqual(image.height, 32)
            XCTAssertEqual(data["width"] as? Int, image.width); XCTAssertEqual(data["height"] as? Int, image.height)
            XCTAssertEqual(data["bytes"] as? Int, bytes.count); XCTAssertNil(data["dataUrl"])
        }
        let overwrite = invoke(["type": "desktop_thumbnail", "sub": "generate", "path": source.path, "save": true, "out": source.path], router: router)
        XCTAssertEqual(overwrite["code"] as? String, "invalid_request"); XCTAssertEqual(try Data(contentsOf: source), original)
    }
    func testBatchRetainsRequestedOrderAndTypedMissingFile() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("interceptor-thumbnail-batch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = try fixture(root), missing = root.appendingPathComponent("missing.png")
        let invalid = root.appendingPathComponent("invalid.png")
        try Data("not an image".utf8).write(to: invalid)
        XCTAssertEqual(invoke(["type": "desktop_thumbnail", "sub": "generate", "path": invalid.path])["code"] as? String, "unsupported_target")
        let paths = [source.path, missing.path, source.path]
        let result = invoke(["type": "desktop_thumbnail", "sub": "batch", "paths": paths, "size": "16", "scale": 1])
        XCTAssertEqual(result["success"] as? Bool, true, "\(result)")
        let data = try XCTUnwrap(result["data"] as? [String: Any]); let rows = try XCTUnwrap(data["results"] as? [[String: Any]])
        XCTAssertEqual(rows.compactMap { $0["path"] as? String }, paths)
        XCTAssertEqual(rows.compactMap { $0["ok"] as? Bool }, [true, false, true])
        XCTAssertEqual((rows[1]["result"] as? [String: Any])?["code"] as? String, "target_gone")
        for index in [0, 2] {
            let imageData = try XCTUnwrap((rows[index]["result"] as? [String: Any])?["data"] as? [String: Any])
            XCTAssertEqual(imageData["width"] as? Int, 16); XCTAssertEqual(imageData["height"] as? Int, 8)
        }
    }
    func testNeutralPDFRendersFirstPageAndRefusesLockedOrCorruptDocuments() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("interceptor-thumbnail-pdf-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for encrypted in [false, true] {
            let path = root.appendingPathComponent(encrypted ? "locked.pdf" : "document.pdf")
            var bounds = CGRect(x: 0, y: 0, width: 200, height: 100)
            let options: CFDictionary? = encrypted ? [kCGPDFContextUserPassword: "owned-fixture-password", kCGPDFContextOwnerPassword: "owned-fixture-owner"] as CFDictionary : nil
            let context = try XCTUnwrap(CGContext(path as CFURL, mediaBox: &bounds, options))
            for page in 0..<2 {
                context.beginPDFPage(nil)
                context.setFillColor(page == 0 ? NSColor.blue.cgColor : NSColor.green.cgColor)
                context.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
                context.setFillColor(page == 0 ? NSColor.red.cgColor : NSColor.yellow.cgColor)
                context.fill(CGRect(x: 100, y: 0, width: 100, height: 100))
                context.endPDFPage()
            }
            context.closePDF()
            let original = try Data(contentsOf: path)
            let result = invoke(["type": "desktop_thumbnail", "sub": "generate", "path": path.path, "size": "128x96", "scale": 2, "types": "thumbnail"])
            if encrypted {
                XCTAssertEqual(result["code"] as? String, "permission_denied")
                XCTAssertNil(result["data"])
            } else {
                XCTAssertEqual(result["success"] as? Bool, true, "\(result)")
                let data = try XCTUnwrap(result["data"] as? [String: Any])
                let url = try XCTUnwrap(data["dataUrl"] as? String)
                let encoded = try XCTUnwrap(Data(base64Encoded: String(url.split(separator: ",")[1])))
                let source = try XCTUnwrap(CGImageSourceCreateWithData(encoded as CFData, nil))
                let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
                XCTAssertEqual(image.width, 256); XCTAssertEqual(image.height, 128)
                var pixels = [UInt8](repeating: 0, count: 256 * 128 * 4)
                pixels.withUnsafeMutableBytes { bytes in
                    let bitmap = CGContext(data: bytes.baseAddress, width: 256, height: 128, bitsPerComponent: 8, bytesPerRow: 256 * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue)!
                    bitmap.draw(image, in: CGRect(x: 0, y: 0, width: 256, height: 128))
                }
                XCTAssertGreaterThan(pixels[(64 * 256 + 64) * 4 + 2], 200)
                XCTAssertGreaterThan(pixels[(64 * 256 + 192) * 4], 200)
            }
            XCTAssertEqual(try Data(contentsOf: path), original)
        }
        let corrupt = root.appendingPathComponent("corrupt.pdf")
        try Data("%PDF-1.7\ninvalid owned fixture".utf8).write(to: corrupt)
        XCTAssertEqual(invoke(["type": "desktop_thumbnail", "sub": "generate", "path": corrupt.path])["code"] as? String, "unsupported_target")
    }
}
