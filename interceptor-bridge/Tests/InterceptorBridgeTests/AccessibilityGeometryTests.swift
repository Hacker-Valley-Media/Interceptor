// Tests for the resize/move ground-truth response shape.
//
// These tests cover the pure geometry-classification helpers
// (`sizeMatches`, `originMatches`, `axRectFromNSScreenRect`,
// `buildGeometryResponse`) without spinning up an AX session — the
// AX `Set` / `Copy` calls themselves require full AX entitlement and
// a real top-level window, which is out of scope for unit tests.
// Integration coverage of the full bridge round-trip lives in the
// window-tiling integration script.

import XCTest
import CoreGraphics
@testable import interceptor_bridge

final class AccessibilityGeometryTests: XCTestCase {

    // MARK: - sizeMatches / originMatches tolerance

    func testSizeMatchesExact() {
        XCTAssertTrue(AccessibilityDomain.sizeMatches(
            CGSize(width: 640, height: 960),
            CGSize(width: 640, height: 960)
        ))
    }

    func testSizeMatchesWithinOnePixelTolerance() {
        // 1px tolerance absorbs AX's CGFloat round-trip noise.
        XCTAssertTrue(AccessibilityDomain.sizeMatches(
            CGSize(width: 640.4, height: 960.0),
            CGSize(width: 640.0, height: 960.0)
        ))
    }

    func testSizeMatchesRejectsOnePixelDrift() {
        // Real defect: observed 641 vs requested 640 → must register as drift.
        XCTAssertFalse(AccessibilityDomain.sizeMatches(
            CGSize(width: 641, height: 960),
            CGSize(width: 640, height: 960)
        ))
    }

    func testSizeMatchesRejectsLargeClamp() {
        // Real defect 1: requested 1040 height, AX applied 970 → must register as drift.
        XCTAssertFalse(AccessibilityDomain.sizeMatches(
            CGSize(width: 640, height: 970),
            CGSize(width: 640, height: 1040)
        ))
    }

    func testOriginMatchesExact() {
        XCTAssertTrue(AccessibilityDomain.originMatches(
            CGPoint(x: 0, y: 30),
            CGPoint(x: 0, y: 30)
        ))
    }

    func testOriginMatchesRejectsClamp() {
        // Real defect 1: requested y=30 on cascading windows, AX clamped to y=83.
        XCTAssertFalse(AccessibilityDomain.originMatches(
            CGPoint(x: 640, y: 83),
            CGPoint(x: 640, y: 30)
        ))
    }

    // MARK: - NSScreen → AX coordinate conversion

    func testAxRectFromNSScreenRectFlipsY() {
        // 1920x1080 primary, dock at bottom (~80px), menu bar at top (~25px).
        // NSScreen visibleFrame ≈ (0, 80, 1920, 975) bottom-left.
        // Expected AX rect: (0, 25, 1920, 975) top-left.
        let vf = CGRect(x: 0, y: 80, width: 1920, height: 975)
        let ax = AccessibilityDomain.axRectFromNSScreenRect(vf, primaryHeight: 1080)
        XCTAssertEqual(ax.origin.x, 0)
        XCTAssertEqual(ax.origin.y, 25)
        XCTAssertEqual(ax.size.width, 1920)
        XCTAssertEqual(ax.size.height, 975)
    }

    func testAxRectFromNSScreenRectMultiDisplay() {
        // Secondary screen positioned at NSScreen (1920, 0, 1920, 1080).
        // Visible frame of that screen, no dock: (1920, 0, 1920, 1055) bottom-left.
        // Primary still 1080 tall. AX equivalent: (1920, 25, 1920, 1055).
        let vf = CGRect(x: 1920, y: 0, width: 1920, height: 1055)
        let ax = AccessibilityDomain.axRectFromNSScreenRect(vf, primaryHeight: 1080)
        XCTAssertEqual(ax.origin.x, 1920)
        XCTAssertEqual(ax.origin.y, 25)
        XCTAssertEqual(ax.size.width, 1920)
        XCTAssertEqual(ax.size.height, 1055)
    }

    // MARK: - buildGeometryResponse — clamp classification + clampedTo population

    func testBuildResponseRequestSatisfiedExposesNoClampedTo() {
        // When frame matches request within tolerance, clamped == false
        // and clampedTo is omitted (even if visibleFrame is supplied).
        let resp = AccessibilityDomain.buildGeometryResponse(
            frame: CGRect(x: 0, y: 30, width: 640, height: 960),
            requested: ["width": 640, "height": 960],
            targetSize: CGSize(width: 640, height: 960),
            targetOrigin: nil,
            visibleFrame: CGRect(x: 0, y: 25, width: 1920, height: 1055)
        )
        XCTAssertEqual(resp["clamped"] as? Bool, false)
        XCTAssertNil(resp["clampedTo"])
        let frame = resp["frame"] as? [String: Any]
        XCTAssertEqual(frame?["width"] as? CGFloat, 640)
        XCTAssertEqual(frame?["height"] as? CGFloat, 960)
        let requested = resp["requested"] as? [String: Any]
        XCTAssertEqual(requested?["width"] as? Int, 640)
        XCTAssertEqual(requested?["height"] as? Int, 960)
    }

    func testBuildResponseClampedHeightExposesClampedTo() {
        // Real defect 1: requested 1040, AX clamped to 970.
        let visible = CGRect(x: 0, y: 25, width: 1920, height: 970)
        let resp = AccessibilityDomain.buildGeometryResponse(
            frame: CGRect(x: 0, y: 25, width: 640, height: 970),
            requested: ["width": 640, "height": 1040],
            targetSize: CGSize(width: 640, height: 1040),
            targetOrigin: nil,
            visibleFrame: visible
        )
        XCTAssertEqual(resp["clamped"] as? Bool, true)
        let clampedTo = resp["clampedTo"] as? [String: Any]
        XCTAssertNotNil(clampedTo)
        XCTAssertEqual(clampedTo?["width"] as? CGFloat, 1920)
        XCTAssertEqual(clampedTo?["height"] as? CGFloat, 970)
    }

    func testBuildResponseClampedOriginExposesClampedTo() {
        // Real defect 3: move requested y=30 but landed at y=83 due to non-atomic
        // size+position set against current geometry.
        let visible = CGRect(x: 0, y: 25, width: 1920, height: 970)
        let resp = AccessibilityDomain.buildGeometryResponse(
            frame: CGRect(x: 640, y: 83, width: 651, height: 748),
            requested: ["x": 640, "y": 30],
            targetSize: nil,
            targetOrigin: CGPoint(x: 640, y: 30),
            visibleFrame: visible
        )
        XCTAssertEqual(resp["clamped"] as? Bool, true)
        XCTAssertNotNil(resp["clampedTo"])
    }

    func testBuildResponseClampedWithinOnePixelIsNotClamped() {
        // Tolerance: a 0.5px AX float wobble must not register as clamp.
        let resp = AccessibilityDomain.buildGeometryResponse(
            frame: CGRect(x: 0, y: 30, width: 640.4, height: 960.0),
            requested: ["width": 640, "height": 960],
            targetSize: CGSize(width: 640, height: 960),
            targetOrigin: nil,
            visibleFrame: CGRect(x: 0, y: 25, width: 1920, height: 970)
        )
        XCTAssertEqual(resp["clamped"] as? Bool, false)
        XCTAssertNil(resp["clampedTo"])
    }

    // MARK: - frameToDict round-trip

    func testFrameToDictPreservesAllFour() {
        let dict = AccessibilityDomain.frameToDict(CGRect(x: 1, y: 2, width: 3, height: 4))
        XCTAssertEqual(dict["x"] as? CGFloat, 1)
        XCTAssertEqual(dict["y"] as? CGFloat, 2)
        XCTAssertEqual(dict["width"] as? CGFloat, 3)
        XCTAssertEqual(dict["height"] as? CGFloat, 4)
    }
}
