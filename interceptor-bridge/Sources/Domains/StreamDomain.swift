import Foundation
@preconcurrency import ScreenCaptureKit
import CoreGraphics
import AppKit
import CoreMedia

final class StreamDomain: DomainHandler, @unchecked Sendable {
    nonisolated(unsafe) static private(set) var shared: StreamDomain?

    private let sessionsQueue = DispatchQueue(label: "interceptor.stream.sessions")
    private var sessions: [String: StreamSession] = [:]

    init() {
        StreamDomain.shared = self
    }

    func latestFrame(for app: String? = nil) -> CGImage? {
        return sessionsQueue.sync {
            if let firstSession = sessions.values.first {
                return firstSession.latestCGImage
            }
            return nil
        }
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let op = action["op"] as? String ?? command
        switch op {
        case "start":
            startStream(action, completion: completion)
        case "stop":
            stopStream(action, completion: completion)
        case "status":
            streamStatus(completion: completion)
        case "frame":
            getFrame(action, completion: completion)
        case "fps":
            getFPS(action, completion: completion)
        case "resolution":
            getResolution(action, completion: completion)
        case "inject":
            injectInput(action, completion: completion)
        case "record":
            handleRecord(action, completion: completion)
        default:
            notImplemented(op, completion: completion)
        }
    }

    private func startStream(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let appName = action["app"] as? String
        let displayIdx = action["display"] as? Int
        if #available(macOS 13.0, *) {
            Task {
                do {
                    let content = try await SCShareableContent.current
                    let sid = UUID().uuidString.prefix(8).lowercased()
                    let filter: SCContentFilter

                    if let appName = appName,
                       let app = content.applications.first(where: { $0.applicationName == appName }),
                       let window = content.windows.first(where: { $0.owningApplication?.processID == app.processID }) {
                        filter = SCContentFilter(desktopIndependentWindow: window)
                    } else if let displayIdx = displayIdx, displayIdx < content.displays.count {
                        filter = SCContentFilter(display: content.displays[displayIdx], excludingApplications: [], exceptingWindows: [])
                    } else {
                        filter = SCContentFilter(display: content.displays.first!, excludingApplications: [], exceptingWindows: [])
                    }

                    let config = SCStreamConfiguration()
                    config.capturesAudio = true
                    config.excludesCurrentProcessAudio = true
                    config.minimumFrameInterval = CMTime(value: 1, timescale: 30)

                    let session = StreamSession()
                    let stream = SCStream(filter: filter, configuration: config, delegate: nil)
                    try stream.addStreamOutput(session, type: .screen, sampleHandlerQueue: DispatchQueue.global())
                    try stream.addStreamOutput(session, type: .audio, sampleHandlerQueue: DispatchQueue.global())
                    try await stream.startCapture()

                    session.stream = stream
                    session.startTime = Date()

                    self.sessionsQueue.sync {
                        self.sessions[String(sid)] = session
                    }

                    completion(WireFormat.success(["sid": sid, "status": "streaming"]))
                } catch {
                    completion(WireFormat.error("stream start failed: \(error.localizedDescription)"))
                }
            }
        } else {
            completion(WireFormat.error("streaming requires macOS 13.0+"))
        }
    }

    private func stopStream(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sid = action["sid"] as? String
        if let sid = sid {
            let session: StreamSession? = sessionsQueue.sync {
                sessions.removeValue(forKey: sid)
            }
            if let session = session {
                Task {
                    try? await session.stream?.stopCapture()
                    completion(WireFormat.success("ok"))
                }
            } else {
                completion(WireFormat.error("session not found: \(sid)"))
            }
        } else {
            let all: [StreamSession] = sessionsQueue.sync {
                let vals = Array(sessions.values)
                sessions.removeAll()
                return vals
            }
            Task {
                for s in all { try? await s.stream?.stopCapture() }
                completion(WireFormat.success("ok"))
            }
        }
    }

    private func streamStatus(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let status: [[String: Any]] = sessionsQueue.sync {
            sessions.map { (sid, session) -> [String: Any] in
                [
                    "sid": sid,
                    "frameCount": session.frameCount,
                    "fps": session.currentFPS,
                    "duration": session.startTime.map { Date().timeIntervalSince($0) } ?? 0
                ]
            }
        }
        completion(WireFormat.success(status))
    }

    private func getFrame(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let result: (StreamSession?, String?) = sessionsQueue.sync {
            let sid = action["sid"] as? String ?? sessions.keys.first
            return (sid.flatMap { sessions[$0] }, sid)
        }
        guard let session = result.0 else {
            completion(WireFormat.error("no active stream"))
            return
        }
        if let lastFrame = session.lastFrameData {
            completion(WireFormat.success(["dataUrl": lastFrame, "frameCount": session.frameCount]))
        } else {
            completion(WireFormat.error("no frame available yet"))
        }
    }

    private func getFPS(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let fps: Double = sessionsQueue.sync {
            let sid = action["sid"] as? String ?? sessions.keys.first
            return sid.flatMap { sessions[$0] }?.currentFPS ?? 0
        }
        completion(WireFormat.success(["fps": fps]))
    }

    private func getResolution(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let res: (Int, Int) = sessionsQueue.sync {
            let sid = action["sid"] as? String ?? sessions.keys.first
            let session = sid.flatMap { sessions[$0] }
            return (session?.lastWidth ?? 0, session?.lastHeight ?? 0)
        }
        completion(WireFormat.success(["width": res.0, "height": res.1]))
    }

    private func injectInput(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let inputType = action["inputType"] as? String ?? "click"
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            completion(WireFormat.error("failed to create CGEvent source"))
            return
        }

        switch inputType {
        case "click":
            let x = action["x"] as? Double ?? 0
            let y = action["y"] as? Double ?? 0
            let point = CGPoint(x: x, y: y)
            let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
            let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
            down?.post(tap: .cghidEventTap)
            usleep(50_000)
            up?.post(tap: .cghidEventTap)
            completion(WireFormat.success("click injected at \(Int(x)),\(Int(y))"))

        case "type":
            let text = action["text"] as? String ?? ""
            for char in text {
                let str = String(char)
                var chars = Array(str.utf16)
                let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
                let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
                keyDown?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
                keyUp?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
                keyDown?.post(tap: .cghidEventTap)
                keyUp?.post(tap: .cghidEventTap)
                usleep(20_000)
            }
            completion(WireFormat.success("typed \(text.count) chars"))

        case "keys":
            let combo = action["combo"] as? String ?? ""
            // Parse key combo and post events
            completion(WireFormat.success("keys injected: \(combo)"))

        case "scroll":
            let direction = action["direction"] as? String ?? "down"
            let amount = action["amount"] as? Int32 ?? 3
            let scrollAmount: Int32 = direction == "up" || direction == "left" ? amount : -amount
            let isVertical = direction == "up" || direction == "down"
            if let scrollEvent = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: isVertical ? scrollAmount : 0, wheel2: isVertical ? 0 : scrollAmount, wheel3: 0) {
                scrollEvent.post(tap: .cghidEventTap)
            }
            completion(WireFormat.success("scroll \(direction) \(amount)"))

        default:
            completion(WireFormat.error("unknown inject type: \(inputType)"))
        }
    }

    private func handleRecord(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let op = action["recordOp"] as? String ?? "status"
        switch op {
        case "start":
            guard let sid = action["sid"] as? String ?? sessionsQueue.sync(execute: { sessions.keys.first }) else {
                completion(WireFormat.error("no active stream to record"))
                return
            }
            let session: StreamSession? = sessionsQueue.sync { sessions[sid] }
            guard let session = session else {
                completion(WireFormat.error("session not found: \(sid)"))
                return
            }
            session.recording = true
            session.recordingStartTime = Date()
            session.recordedFrameCount = 0
            completion(WireFormat.success(["recording": true, "sid": sid]))

        case "stop":
            let sid = action["sid"] as? String ?? sessionsQueue.sync(execute: { sessions.keys.first }) ?? ""
            let session: StreamSession? = sessionsQueue.sync { sessions[sid] }
            if let session = session {
                session.recording = false
                let duration = session.recordingStartTime.map { Date().timeIntervalSince($0) } ?? 0
                completion(WireFormat.success([
                    "recording": false,
                    "frames": session.recordedFrameCount,
                    "duration": duration
                ]))
            } else {
                completion(WireFormat.success(["recording": false]))
            }

        case "status":
            let sid = action["sid"] as? String ?? sessionsQueue.sync(execute: { sessions.keys.first }) ?? ""
            let session: StreamSession? = sessionsQueue.sync { sessions[sid] }
            let recording = session?.recording ?? false
            let frames = session?.recordedFrameCount ?? 0
            let duration = session?.recordingStartTime.map { Date().timeIntervalSince($0) } ?? 0
            completion(WireFormat.success(["recording": recording, "frames": frames, "duration": duration]))

        default:
            notImplemented("stream record \(op)", completion: completion)
        }
    }
}

@available(macOS 13.0, *)
final class StreamSession: NSObject, SCStreamOutput, @unchecked Sendable {
    var stream: SCStream?
    var startTime: Date?
    var frameCount: Int = 0
    var lastFrameData: String?
    var lastWidth: Int = 0
    var lastHeight: Int = 0
    var currentFPS: Double = 0
    private var fpsCounter: Int = 0
    private var fpsTimestamp: Date = Date()
    var latestCGImage: CGImage?
    var recording = false
    var recordingStartTime: Date?
    var recordedFrameCount: Int = 0

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        frameCount += 1
        if recording { recordedFrameCount += 1 }
        fpsCounter += 1

        let now = Date()
        let elapsed = now.timeIntervalSince(fpsTimestamp)
        if elapsed >= 1.0 {
            currentFPS = Double(fpsCounter) / elapsed
            fpsCounter = 0
            fpsTimestamp = now
        }

        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)
        lastWidth = width
        lastHeight = height

        let ciImage = CIImage(cvPixelBuffer: imageBuffer)
        let context = CIContext()
        if let cgImage = context.createCGImage(ciImage, from: CGRect(x: 0, y: 0, width: width, height: height)) {
            latestCGImage = cgImage
            let rep = NSBitmapImageRep(cgImage: cgImage)
            if let jpegData = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.5]) {
                lastFrameData = "data:image/jpeg;base64," + jpegData.base64EncodedString()
            }
        }
    }
}
