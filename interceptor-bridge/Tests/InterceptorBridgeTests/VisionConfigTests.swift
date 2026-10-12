import XCTest
import CoreGraphics
@testable import interceptor_bridge

// VisionDomain.acquireImage previously constructed a fresh
// SCStreamConfiguration with default zero width/height, which produced
// degenerate frames for downstream Vision requests (OCR/faces/hands/bodies
// returning count:0 even on text-rich UIs). The fix derives buffer
// dimensions from the SCContentFilter's contentRect × pointPixelScale,
// mirroring Apple's "Capturing Screen Content in macOS" sample-code
// pattern. The dimension math is extracted to a pure helper so it can be
// tested without spinning up an SCK content session.

final class VisionConfigTests: XCTestCase {
    func testRetinaWindowDoublesContentRect() {
        // 1280×800 logical window on a Retina display (pointPixelScale=2.0)
        // captures at 2560×1600 native pixels.
        let dims = VisionDomain.dimensionsForCaptureBuffer(
            contentRect: CGRect(x: 0, y: 0, width: 1280, height: 800),
            pointPixelScale: 2.0)
        XCTAssertEqual(dims.width, 2560)
        XCTAssertEqual(dims.height, 1600)
    }

    func testNonRetinaWindowMatchesContentRect() {
        // 1280×800 logical window on a 1× display captures at 1280×800.
        let dims = VisionDomain.dimensionsForCaptureBuffer(
            contentRect: CGRect(x: 0, y: 0, width: 1280, height: 800),
            pointPixelScale: 1.0)
        XCTAssertEqual(dims.width, 1280)
        XCTAssertEqual(dims.height, 800)
    }

    func testFractionalScaleTruncatesToInt() {
        // Scaled HiDPI environments can produce non-integer scales.
        // The helper truncates via Int() — it should never produce 0
        // or negative dimensions.
        let dims = VisionDomain.dimensionsForCaptureBuffer(
            contentRect: CGRect(x: 0, y: 0, width: 1366, height: 768),
            pointPixelScale: 1.5)
        XCTAssertEqual(dims.width, Int(1366 * 1.5))
        XCTAssertEqual(dims.height, Int(768 * 1.5))
    }

    func testDegenerateRectClampsToOne() {
        // A zero-sized contentRect would produce 0×0 and recreate the
        // old defect. The helper clamps to 1×1 so the buffer is
        // always at least minimally well-formed.
        let dims = VisionDomain.dimensionsForCaptureBuffer(
            contentRect: CGRect(x: 0, y: 0, width: 0, height: 0),
            pointPixelScale: 2.0)
        XCTAssertEqual(dims.width, 1)
        XCTAssertEqual(dims.height, 1)
    }

    func testPositiveDimensionsAfterFix() {
        // The headline regression assertion: under the current contract the
        // computed width/height are always positive, so SCStreamConfiguration
        // never receives the broken (0,0) defaults that produced empty
        // Vision results.
        let dims = VisionDomain.dimensionsForCaptureBuffer(
            contentRect: CGRect(x: 0, y: 0, width: 800, height: 600),
            pointPixelScale: 2.0)
        XCTAssertGreaterThan(dims.width, 0)
        XCTAssertGreaterThan(dims.height, 0)
    }
}
