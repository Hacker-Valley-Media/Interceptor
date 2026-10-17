import XCTest
import AVFoundation
import CoreGraphics
import ImageIO
@testable import interceptor_bridge

// `macos camera`: everything here runs without a camera or a camera grant.
// Frames are injected the way CameraFrameOutput delivers them; the live
// AVCaptureSession path was checked separately on a Developer-ID-signed build.

private final class ResultHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: Any] = [:]
    var value: [String: Any] { lock.withLock { stored } }
    func set(_ v: [String: Any]) { lock.withLock { stored = v } }
}

final class CameraDomainTests: XCTestCase {
    private func run(_ domain: CameraDomain, _ action: [String: Any], timeout: TimeInterval = 5) -> [String: Any] {
        let holder = ResultHolder()
        let exp = expectation(description: "camera \(action["sub"] ?? "")")
        domain.handle("camera", action: action.merging(["type": "macos_camera"]) { a, _ in a }) { r in
            holder.set(r)
            exp.fulfill()
        }
        wait(for: [exp], timeout: timeout)
        return holder.value
    }

    private func image(width: Int, height: Int) -> CGImage {
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)!
        ctx.setFillColor(CGColor(red: 0.57, green: 0.27, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage()!
    }

    private func data(_ r: [String: Any]) -> [String: Any] { r["data"] as? [String: Any] ?? [:] }

    func testFrameBeforeStartIsRefused() {
        let r = run(CameraDomain(), ["sub": "frame"])
        XCTAssertEqual(r["success"] as? Bool, false)
        XCTAssertEqual(r["code"] as? String, "invalid_request")
    }

    func testStatusWhenStoppedReportsAuthorization() {
        let domain = CameraDomain()
        domain.authorizationStatus = { .denied }
        let d = data(run(domain, ["sub": "status"]))
        XCTAssertEqual(d["active"] as? Bool, false)
        XCTAssertEqual(d["hasFrame"] as? Bool, false)
        XCTAssertEqual(d["authorization"] as? String, "denied")
        XCTAssertNil(d["frameAgeMs"])
    }

    func testDeniedGrantRefusesStartWithoutPrompting() {
        let domain = CameraDomain()
        domain.authorizationStatus = { .denied }
        domain.requestAccess = { _ in XCTFail("a decided grant must not prompt") }
        let r = run(domain, ["sub": "start"])
        XCTAssertEqual(r["code"] as? String, "permission_required")
    }

    func testPromptDeclinedRefusesStart() {
        let domain = CameraDomain()
        domain.authorizationStatus = { .notDetermined }
        domain.requestAccess = { done in done(false) }
        let r = run(domain, ["sub": "start"])
        XCTAssertEqual(r["code"] as? String, "permission_required")
        // A declined prompt leaves the domain startable again, not stuck in "starting".
        domain.requestAccess = { done in done(false) }
        XCTAssertEqual(run(domain, ["sub": "start"])["code"] as? String, "permission_required")
    }

    func testRunningWithoutFrameTimesOut() {
        let domain = CameraDomain()
        domain.testForcedActive = true
        let started = Date()
        let r = run(domain, ["sub": "frame", "timeoutMs": 200])
        XCTAssertEqual(r["code"] as? String, "timeout")
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
    }

    func testWaitingFrameReturnsOnceOneArrives() {
        let domain = CameraDomain()
        domain.testForcedActive = true
        let frame = image(width: 64, height: 48)
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(150)) { domain._testInjectFrame(frame) }
        let d = data(run(domain, ["sub": "frame", "timeoutMs": 3000]))
        XCTAssertEqual(d["width"] as? Int, 64)
        XCTAssertEqual(d["height"] as? Int, 48)
    }

    func testInlineFrameIsAJpegDataUrlWithCounterAndAge() {
        let domain = CameraDomain()
        domain.testForcedActive = true
        domain._testInjectFrame(image(width: 320, height: 240))
        domain._testInjectFrame(image(width: 320, height: 240))
        let d = data(run(domain, ["sub": "frame"]))
        XCTAssertEqual(d["format"] as? String, "jpeg")
        XCTAssertEqual(d["frame"] as? Int, 2)
        XCTAssertNotNil(d["frameAgeMs"] as? Int)
        XCTAssertTrue((d["dataUrl"] as? String)?.hasPrefix("data:image/jpeg;base64,") == true)
        XCTAssertNil(d["path"])
    }

    func testOutWritesAJpegFileAndScales() throws {
        let domain = CameraDomain()
        domain.testForcedActive = true
        domain._testInjectFrame(image(width: 1920, height: 1080))
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("camera-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let out = dir.appendingPathComponent("nested/frame.jpg").path
        let d = data(run(domain, ["sub": "frame", "out": out, "maxLongEdge": 640]))
        XCTAssertEqual(d["path"] as? String, out)
        XCTAssertNil(d["dataUrl"])
        XCTAssertEqual(d["width"] as? Int, 640)
        XCTAssertEqual(d["height"] as? Int, 360)
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(URL(fileURLWithPath: out) as CFURL, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, "public.jpeg")
        let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        XCTAssertEqual(props[kCGImagePropertyPixelWidth] as? Int, 640)
    }

    func testLatestFrameFeedsVisionOnlyWhileRunning() {
        let domain = CameraDomain()
        domain._testInjectFrame(image(width: 8, height: 8))
        XCTAssertNil(domain.latestFrame(), "a stopped camera must not serve a stale frame")
        domain.testForcedActive = true
        XCTAssertEqual(domain.latestFrame()?.width, 8)
    }

    func testStopClearsFrameAndCounter() {
        let domain = CameraDomain()
        domain.testForcedActive = true
        domain._testInjectFrame(image(width: 8, height: 8))
        XCTAssertEqual(run(domain, ["sub": "stop"])["success"] as? Bool, true)
        domain.testForcedActive = false
        let d = data(run(domain, ["sub": "status"]))
        XCTAssertEqual(d["hasFrame"] as? Bool, false)
        XCTAssertEqual(d["frames"] as? Int, 0)
    }

    func testUnknownSubcommandIsRefused() {
        XCTAssertEqual(run(CameraDomain(), ["sub": "record"])["code"] as? String, "invalid_request")
    }

    func testDeviceSelectorPrefersIdThenExactNameThenSubstring() {
        let devices = [(id: "A1", name: "MacBook Pro Camera"), (id: "B2", name: "PedPhone Camera"), (id: "C3", name: "Camera")]
        XCTAssertEqual(CameraDomain.pick("B2", from: devices), 1)
        XCTAssertEqual(CameraDomain.pick("camera", from: devices), 2, "an exact name beats an earlier substring match")
        XCTAssertEqual(CameraDomain.pick("pedphone", from: devices), 1)
        XCTAssertNil(CameraDomain.pick("Logitech", from: devices))
    }

    func testScaleKeepsSmallImagesAndAspect() {
        let small = image(width: 100, height: 50)
        XCTAssertEqual(CameraDomain.scale(small, maxLongEdge: 640).width, 100)
        let tall = CameraDomain.scale(image(width: 1080, height: 1920), maxLongEdge: 480)
        XCTAssertEqual(tall.height, 480)
        XCTAssertEqual(tall.width, 270)
    }
}
