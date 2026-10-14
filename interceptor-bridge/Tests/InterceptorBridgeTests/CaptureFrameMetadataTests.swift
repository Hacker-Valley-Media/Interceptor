import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@testable import interceptor_bridge

// Regression: `capture frame` previously returned
// {dataUrl} only. This brings it to parity with `screenshot`'s shape:
// {dataUrl, bytes, width, height, format}. These tests cover both the
// pure decoder helper and the buildFramePayload assembly used by
// handleFrame's fast and slow paths.

final class CaptureFrameMetadataTests: XCTestCase {

    // MARK: - decodeJPEGSize

    private func makeJPEG(width: Int, height: Int) -> Data? {
        let bytesPerRow = width * 4
        let data = NSMutableData(length: bytesPerRow * height)!
        guard let ctx = CGContext(
            data: data.mutableBytes, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: bytesPerRow,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
        ) else { return nil }
        ctx.setFillColor(CGColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let cg = ctx.makeImage() else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: 0.6] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }

    func testDecodeJPEGSizeReturnsKnownDimensions() {
        guard let jpeg = makeJPEG(width: 320, height: 200) else {
            return XCTFail("failed to synthesize JPEG fixture")
        }
        let size = CaptureDomain.decodeJPEGSize(jpeg)
        XCTAssertEqual(size?.width, 320)
        XCTAssertEqual(size?.height, 200)
    }

    func testDecodeJPEGSizeReturnsNilOnGarbageData() {
        let junk = Data([0xDE, 0xAD, 0xBE, 0xEF])
        XCTAssertNil(CaptureDomain.decodeJPEGSize(junk))
    }

    // MARK: - buildFramePayload

    func testBuildFramePayloadIncludesAllFiveKeys() {
        guard let jpeg = makeJPEG(width: 640, height: 360) else {
            return XCTFail("failed to synthesize JPEG fixture")
        }
        let payload = CaptureDomain.buildFramePayload(frame: jpeg, size: CGSize(width: 640, height: 360))
        XCTAssertNotNil(payload["dataUrl"], "must include dataUrl")
        XCTAssertEqual(payload["bytes"] as? Int, jpeg.count)
        XCTAssertEqual(payload["width"] as? Int, 640)
        XCTAssertEqual(payload["height"] as? Int, 360)
        XCTAssertEqual(payload["format"] as? String, "jpeg")
    }

    func testBuildFramePayloadDataUrlIsValidBase64() {
        guard let jpeg = makeJPEG(width: 32, height: 32) else {
            return XCTFail("failed to synthesize JPEG fixture")
        }
        let payload = CaptureDomain.buildFramePayload(frame: jpeg, size: nil)
        let dataUrl = payload["dataUrl"] as? String ?? ""
        XCTAssertTrue(dataUrl.hasPrefix("data:image/jpeg;base64,"))
        let b64 = String(dataUrl.dropFirst("data:image/jpeg;base64,".count))
        let decoded = Data(base64Encoded: b64)
        XCTAssertEqual(decoded, jpeg)
    }

    func testBuildFramePayloadFallsBackToHeaderDecodeWhenSizeNil() {
        // When the cached size isn't available (e.g. legacy frame ingested
        // before this change), the helper should still recover dimensions from the
        // JPEG header so the payload is never missing width/height.
        guard let jpeg = makeJPEG(width: 100, height: 50) else {
            return XCTFail("failed to synthesize JPEG fixture")
        }
        let payload = CaptureDomain.buildFramePayload(frame: jpeg, size: nil)
        XCTAssertEqual(payload["width"] as? Int, 100)
        XCTAssertEqual(payload["height"] as? Int, 50)
    }
}
