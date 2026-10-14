import XCTest
import CoreMedia
import CoreVideo
import ScreenCaptureKit
@testable import interceptor_bridge

// Regression: StreamDomain.handle had no
// `list` case, so callers asking to enumerate active streams got
// "not yet implemented". The fix projects the existing sessions
// dictionary into a structured array.

private final class StreamResultHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: Any] = [:]
    var value: [String: Any] {
        lock.lock(); defer { lock.unlock() }; return stored
    }
    func set(_ v: [String: Any]) { lock.lock(); stored = v; lock.unlock() }
}

final class StreamListTests: XCTestCase {
    @available(macOS 13.0, *)
    func testStreamCountsOnlyEncodedCompleteFramesAndRejectsRetiredCallbacks() throws {
        var pixels: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 4, 3, kCVPixelFormatType_32BGRA, nil, &pixels), kCVReturnSuccess)
        let buffer = try XCTUnwrap(pixels)
        var description: CMVideoFormatDescription?
        XCTAssertEqual(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &description), noErr)
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        XCTAssertEqual(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescription: try XCTUnwrap(description), sampleTiming: &timing, sampleBufferOut: &sample), noErr)
        let frame = try XCTUnwrap(sample)
        let attachments = try XCTUnwrap(CMSampleBufferGetSampleAttachmentsArray(frame, createIfNecessary: true) as? [NSMutableDictionary])
        let metadata = try XCTUnwrap(attachments.first)
        let session = StreamSession()
        session.starting = false
        metadata[SCStreamFrameInfo.status.rawValue] = SCFrameStatus.idle.rawValue
        session.consume(frame)
        XCTAssertEqual(session.frameCount, 0)
        XCTAssertNil(session.lastFrameData)
        metadata[SCStreamFrameInfo.status.rawValue] = SCFrameStatus.complete.rawValue
        session.consume(frame)
        XCTAssertEqual(session.frameCount, 1)
        XCTAssertEqual(session.lastWidth, 4)
        XCTAssertEqual(session.lastHeight, 3)
        XCTAssertTrue(session.lastFrameData?.hasPrefix("data:image/jpeg;base64,") == true)
        session.retiring = true
        session.consume(frame)
        XCTAssertEqual(session.frameCount, 1)
    }

    func testNeutralStreamRefusesMalformedInputAndMissingSessionsWithoutNativeCapture() {
        let domain = StreamDomain()
        let invalid: [[String: Any]] = [
            ["type": "desktop_stream", "op": "inject", "inputType": "keys"],
            ["type": "desktop_stream", "op": "inject", "inputType": "keys", "combo": "cmd+a", "text": "unexpected"],
            ["type": "desktop_stream", "op": "start", "app": "fixture", "display": 1],
            ["type": "desktop_stream", "op": "start", "window": 0],
            ["type": "desktop_stream", "op": "frame", "sid": "../outside"],
            ["type": "desktop_stream", "op": "record", "recordOp": "delete"],
            ["type": "desktop_stream", "op": "status", "unknown": true]
        ]
        for action in invalid {
            let holder = StreamResultHolder(), exp = expectation(description: "invalid stream request")
            domain.handle("stream", action: action) { result in holder.set(result); exp.fulfill() }
            wait(for: [exp], timeout: 1)
            XCTAssertEqual(holder.value["success"] as? Bool, false)
            XCTAssertEqual(holder.value["code"] as? String, "invalid_request")
        }
        for op in ["frame", "fps", "resolution", "record", "inject"] {
            let holder = StreamResultHolder(), exp = expectation(description: "missing stream session")
            var action: [String: Any] = ["type": "desktop_stream", "op": op]
            if op == "inject" { action["inputType"] = "keys"; action["combo"] = "cmd+a" }
            domain.handle("stream", action: action) { result in holder.set(result); exp.fulfill() }
            wait(for: [exp], timeout: 1)
            XCTAssertEqual(holder.value["success"] as? Bool, false)
            XCTAssertNil(holder.value["data"])
        }
        XCTAssertNil(StreamDomain.validationError(["type": "macos_stream", "op": "start", "display": 0]))
        XCTAssertNotNil(StreamDomain.validationError(["type": "desktop_stream", "op": "start", "display": 0]))
        XCTAssertNil(domain.latestFrame(for: "fixture"))
    }

    func testListReturnsArrayOnEmptySessions() {
        let domain = StreamDomain()
        let holder = StreamResultHolder()
        let exp = expectation(description: "stream list")
        domain.handle("stream", action: ["type": "macos_stream", "op": "list"]) { r in
            holder.set(r)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5.0)
        let result = holder.value
        let err = result["error"] as? String
        XCTAssertNil(err, "list must not error on empty sessions")
        // success-wrapped data is the array; empty when no streams active.
        let data = result["data"] as? [Any]
        XCTAssertNotNil(data, "list must return a top-level array via data field")
        XCTAssertEqual(data?.count, 0, "no sessions registered → empty array")
    }
}
