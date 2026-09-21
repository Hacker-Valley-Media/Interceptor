import XCTest
import CoreGraphics
import ImageIO
@testable import interceptor_bridge

// `macos vision --image <path>` runs Vision over a saved file. ImageIO decodes
// without applying the EXIF orientation tag and reports every failure as nil,
// so the bridge applies the tag itself and works out why a file produced nothing.

final class VisionImageFileTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("vision-image-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    /// A 40x20 (landscape) JPEG, optionally stamped with an EXIF orientation.
    private func writeImage(_ name: String, orientation: Int? = nil) throws -> String {
        let ctx = CGContext(data: nil, width: 40, height: 20, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 40, height: 20))
        let url = dir.appendingPathComponent(name)
        let dest = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.jpeg" as CFString, 1, nil))
        let props = orientation.map { [kCGImagePropertyOrientation: $0] as CFDictionary }
        CGImageDestinationAddImage(dest, try XCTUnwrap(ctx.makeImage()), props)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return url.path
    }

    func testUntaggedImageKeepsItsPixelDimensions() throws {
        let image = try XCTUnwrap(VisionDomain.loadImage(atPath: try writeImage("plain.jpg")))
        XCTAssertEqual(image.width, 40)
        XCTAssertEqual(image.height, 20)
    }

    func testQuarterTurnOrientationsSwapDimensions() throws {
        // 6 (right) and 8 (left) are what an iPhone writes for a rotated capture.
        for orientation in [6, 8] {
            let image = try XCTUnwrap(VisionDomain.loadImage(atPath: try writeImage("turn\(orientation).jpg", orientation: orientation)))
            XCTAssertEqual(image.width, 20, "orientation \(orientation)")
            XCTAssertEqual(image.height, 40, "orientation \(orientation)")
        }
    }

    func testHalfTurnKeepsDimensions() throws {
        let image = try XCTUnwrap(VisionDomain.loadImage(atPath: try writeImage("flip.jpg", orientation: 3)))
        XCTAssertEqual(image.width, 40)
        XCTAssertEqual(image.height, 20)
    }

    func testMissingFileAndNonImageLoadAsNil() throws {
        XCTAssertNil(VisionDomain.loadImage(atPath: dir.appendingPathComponent("nope.png").path))
        let text = dir.appendingPathComponent("notes.txt")
        try "not an image".write(to: text, atomically: true, encoding: .utf8)
        XCTAssertNil(VisionDomain.loadImage(atPath: text.path))
    }

    func testFailureMessageNamesThePathAndTheReason() throws {
        let missing = dir.appendingPathComponent("nope.png").path
        let missingMessage = VisionDomain.imageFailureMessage(imagePath: missing)
        XCTAssertTrue(missingMessage.hasPrefix("cannot read image file \(missing)"), missingMessage)

        let directoryMessage = VisionDomain.imageFailureMessage(imagePath: dir.path)
        XCTAssertTrue(directoryMessage.contains("it is a directory"), directoryMessage)
        XCTAssertTrue(directoryMessage.contains(dir.path), directoryMessage)

        let text = dir.appendingPathComponent("notes.txt")
        try "not an image".write(to: text, atomically: true, encoding: .utf8)
        let textMessage = VisionDomain.imageFailureMessage(imagePath: text.path)
        XCTAssertTrue(textMessage.contains("could not decode"), textMessage)
        XCTAssertTrue(textMessage.contains(text.path), textMessage)
    }

    func testCaptureFailureKeepsItsOriginalText() {
        XCTAssertEqual(VisionDomain.imageFailureMessage(imagePath: nil), "failed to capture screen")
    }
}
