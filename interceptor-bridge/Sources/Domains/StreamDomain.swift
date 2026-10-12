import Foundation
@preconcurrency import ScreenCaptureKit
import CoreGraphics
import AppKit
import CoreMedia

final class StreamDomain: DomainHandler, @unchecked Sendable {
    nonisolated(unsafe) static private(set) var shared: StreamDomain?

    private let sessionsQueue = DispatchQueue(label: "interceptor.stream.sessions")
    private var sessions: [String: StreamSession] = [:]
    private weak var router: Router?

    init(router: Router? = nil) {
        self.router = router
        StreamDomain.shared = self
    }

    func latestFrame(for app: String? = nil) -> CGImage? {
        return sessionsQueue.sync {
            let matching = sessions.values.filter { session in session.lock.withLock { app == nil || session.appName == app } }
            if matching.count == 1, let firstSession = matching.first {
                return firstSession.lock.withLock { firstSession.error == nil ? firstSession.latestCGImage : nil }
            }
            return nil
        }
    }

    static func code(for message: String) -> String { message.contains("one exact current application") || message.contains("no longer") ? "target_gone" : "provider_failed" }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let error = Self.validationError(action) { completion(["success": false, "code": "invalid_request", "error": error]); return }
        if action["virtual"] != nil { completion(WireFormat.failure("unsupported_operation", "virtual-output selection requires the virtual-display backend; no display fallback was captured")); return }
        let op = action["op"] as? String ?? command
        switch op {
        case "start":
            startStream(action, completion: completion)
        case "stop":
            stopStream(action, completion: completion)
        case "status":
            streamStatus(completion: completion)
        case "list":
            // Project the sessions dict so
            // callers can enumerate active streams. The dict already holds
            // per-session metadata; this verb just shapes it for the wire.
            listStreams(completion: completion)
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

    static func validationError(_ action: [String: Any]) -> String? {
        var canonical = action
        canonical["type"] = "desktop_stream"
        canonical["op"] = action["op"] as? String ?? "status"
        if let error = DesktopStreamShape.validationError(canonical) { return error }
        let op = canonical["op"] as? String ?? "status"
        func bounded(_ value: Any?, _ max: Int) -> Bool {
            guard let text = value as? String else { return false }
            return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !text.contains("\0") && text.utf8.count <= max
        }
        if let sid = action["sid"] as? String, sid.range(of: "^[a-zA-Z0-9_-]{1,64}$", options: .regularExpression) == nil { return "invalid stream identity" }
        if action["sid"] != nil, ["start", "status", "list"].contains(op) { return "this operation accepts no session identity" }
        let targets = ["app", "window", "display", "virtual"]
        if targets.filter({ action[$0] != nil }).count > 1 { return "stream requires one target selector" }
        if op != "start", (targets + ["format"]).contains(where: { action[$0] != nil }) { return "stream target/format fields require start" }
        for key in ["window", "display"] {
            if let n = action[key] as? NSNumber {
                let value = n.doubleValue, minimum: Double = key == "display" && action["type"] as? String != "desktop_stream" ? 0 : 1
                if !value.isFinite || value.rounded(.towardZero) != value || !(minimum...9007199254740991).contains(value) { return "stream target requires a bounded native identity" }
            }
        }
        for (key, max) in [("app", 512), ("virtual", 64), ("group", 256), ("groupColor", 256)] {
            if action[key] != nil && !bounded(action[key], max) { return "invalid bounded stream target/group text" }
        }
        if let format = action["format"] as? String, !["jpeg", "jpg"].contains(format) { return "stream frames require JPEG" }
        let inputs = ["inputType", "ref", "x", "y", "text", "combo", "direction", "amount"]
        if op != "inject", inputs.contains(where: { action[$0] != nil }) { return "input fields require stream inject" }
        if op == "inject" {
            let kind = action["inputType"] as? String ?? "click"
            let owned = kind == "click" ? ["x", "y"] : kind == "type" ? ["text", "ref"] : kind == "keys" ? ["combo"] : ["direction", "amount"]
            if inputs.contains(where: { $0 != "inputType" && action[$0] != nil && !owned.contains($0) }) { return "input fields contradict the input kind" }
            if kind == "click", ["x", "y"].contains(where: { key in
                guard let n = action[key] as? NSNumber else { return true }
                return !n.doubleValue.isFinite || n.doubleValue.rounded(.towardZero) != n.doubleValue || abs(n.doubleValue) > 1_000_000
            }) { return "stream click requires bounded integer screen coordinates" }
            if kind == "type" && !bounded(action["text"], 1_048_576) || kind == "keys" && !bounded(action["combo"], 4096) || action["ref"] != nil && !bounded(action["ref"], 256) { return "invalid bounded stream input" }
            if kind == "scroll" {
                guard action["direction"] != nil, let n = action["amount"] as? NSNumber, n.doubleValue.rounded(.towardZero) == n.doubleValue, (1...10000).contains(n.doubleValue) else { return "stream scroll requires direction and an integer amount 1..10000" }
            }
        }
        if action["recordOp"] != nil && op != "record" { return "record selector requires stream record" }
        if (action["media"] != nil || action["recordAudio"] != nil) && (op != "record" || action["recordOp"] as? String != "start") { return "media and recording audio require stream record start" }
        if action["recordAudio"] != nil && action["media"] as? Bool != true { return "recording audio requires explicit media recording" }
        return nil
    }

    private func selectedSession(_ action: [String: Any]) -> StreamSession? {
        sessionsQueue.sync {
            if let sid = action["sid"] as? String { return sessions[sid] }
            return sessions.count == 1 ? sessions.values.first : nil
        }
    }

    private func listStreams(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let snapshot: [[String: Any]] = sessionsQueue.sync {
            sessions.map { (sid, session) in session.lock.withLock {
                var entry: [String: Any] = [
                    "sid": sid,
                    "frameCount": session.frameCount,
                    "currentFPS": session.currentFPS,
                    "width": session.lastWidth,
                    "height": session.lastHeight,
                    "recording": session.recording
                ]
                if let started = session.startTime {
                    let f = ISO8601DateFormatter()
                    f.formatOptions = [.withInternetDateTime]
                    entry["startedAt"] = f.string(from: started)
                }
                return entry
            }
            }
        }
        if let error = sessionsQueue.sync(execute: { sessions.values.compactMap { s in s.lock.withLock { s.problem } }.first }) { completion(WireFormat.failure(Self.code(for: error), error)); return }
        completion(WireFormat.success(snapshot))
    }

    private func startStream(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let appName = action["app"] as? String
        let displayIdx = action["display"] as? Int
        if #available(macOS 13.0, *) {
            let sid = UUID().uuidString.lowercased(), session = StreamSession(), finished = AtomicFlag()
            session.sid = sid
            session.startReply = { response in if finished.set() { completion(response) } }
            let admitted = sessionsQueue.sync { () -> Bool in
                guard sessions.count < DESKTOP_STREAM_MAX_SESSIONS, sessions[sid] == nil else { return false }
                sessions[sid] = session
                return true
            }
            guard admitted else { completion(WireFormat.failure("resource_limit", "at most four native streams, including unresolved cleanup, may be admitted")); return }
            session.onFailure = { [weak self, weak session] error in
                guard let self, let session else { return }
                self.retire(sid, session: session, error: error)
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
                if finished.set() {
                    completion(["success": false, "code": "timeout_unknown_outcome", "error": "stream startup exceeded ten seconds; late admission is revoked, native cleanup may still be resolving"])
                    self.retire(sid, session: session, error: "stream startup exceeded its deadline")
                }
            }
            let boxedAction = UncheckedSendableBox(action)
            Task {
                do {
                    let content = try await SCShareableContent.current
                    let action = boxedAction.value
                    guard !session.lock.withLock({ session.retiring }) else { self.finishStart(sid, session: session, error: "stream startup cancelled"); return }
                    let filter: SCContentFilter

                    var targetWindow: SCWindow?, targetDisplay: SCDisplay?
                    if let appName {
                        let apps = content.applications.filter { $0.applicationName == appName }
                        guard apps.count == 1, let app = apps.first else { self.finishStart(sid, session: session, error: "stream requires one exact current application; no display fallback was captured"); return }
                        let windows = content.windows.filter { $0.owningApplication?.processID == app.processID && $0.isOnScreen }
                        guard windows.count == 1, let window = windows.first else { self.finishStart(sid, session: session, error: "stream application requires one on-screen window; use an exact window target"); return }
                        targetWindow = window
                        filter = SCContentFilter(desktopIndependentWindow: window)
                    } else if let windowID = action["window"] as? Int {
                        guard windowID > 0, let window = content.windows.first(where: { Int($0.windowID) == windowID && $0.isOnScreen }) else { self.finishStart(sid, session: session, error: "stream window is not available; no display fallback was captured"); return }
                        targetWindow = window
                        filter = SCContentFilter(desktopIndependentWindow: window)
                    } else if let displayIdx {
                        let display: SCDisplay?
                        if action["type"] as? String == "desktop_stream" { display = content.displays.first(where: { Int($0.displayID) == displayIdx }) }
                        else { display = content.displays.indices.contains(displayIdx) ? content.displays[displayIdx] : nil }
                        guard let display else { self.finishStart(sid, session: session, error: "requested stream display is not available"); return }
                        targetDisplay = display
                        filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                    } else {
                        guard let display = content.displays.first else { self.finishStart(sid, session: session, error: "no stream display is available"); return }
                        targetDisplay = display
                        filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                    }

                    let config = SCStreamConfiguration()
                    config.capturesAudio = false
                    config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
                    let scale = Double(max(1, filter.pointPixelScale))
                    let width = ceil(Double(filter.contentRect.width) * scale), height = ceil(Double(filter.contentRect.height) * scale)
                    guard width.isFinite, height.isFinite, width > 0, height > 0, width <= 16384, height <= 16384,
                          width * height <= Double(DESKTOP_CAPTURE_MAX_PIXELS) else { self.finishStart(sid, session: session, error: "native stream geometry exceeds its pixel bound"); return }
                    config.width = Int(width); config.height = Int(height)

                    let stream = SCStream(filter: filter, configuration: config, delegate: session)
                    let current = session.lock.withLock { () -> Bool in
                        guard !session.retiring else { return false }
                        session.windowID = targetWindow?.windowID
                        session.appName = targetWindow?.owningApplication?.applicationName
                        session.application = targetWindow?.owningApplication.flatMap { NSRunningApplication(processIdentifier: $0.processID) }
                        session.displayID = targetDisplay?.displayID; session.explicitDisplay = displayIdx != nil
                        session.configuration = config
                        session.stream = stream
                        session.startTime = Date()
                        return true
                    }
                    guard current else { self.finishStart(sid, session: session, error: "stream startup cancelled"); return }
                    try stream.addStreamOutput(session, type: .screen, sampleHandlerQueue: DispatchQueue.global())
                    let starting = session.lock.withLock { () -> Bool in
                        guard !session.retiring else { return false }
                        session.captureAttempted = true
                        return true
                    }
                    guard starting else { self.finishStart(sid, session: session, error: "stream startup cancelled"); return }
                    try await stream.startCapture()
                    self.finishStart(sid, session: session, error: nil)
                } catch {
                    self.finishStart(sid, session: session, error: "stream start failed: \(error.localizedDescription)")
                }
            }
        } else {
            completion(WireFormat.failure("unsupported_operation", "streaming requires macOS 13.0+"))
        }
    }

    private func finishStart(_ sid: String, session: StreamSession, error: String?) {
        let reply = session.lock.withLock { () -> (@Sendable ([String: Any]) -> Void)? in
            session.starting = false
            if let error { session.error = error; session.retiring = true }
            let reply = session.startReply; session.startReply = nil
            return reply
        }
        let retiring = session.lock.withLock { session.retiring }
        if retiring {
            reply?(WireFormat.failure(Self.code(for: error ?? "stream startup cancelled"), error ?? "stream startup cancelled"))
            retire(sid, session: session, error: error)
        } else { reply?(WireFormat.success(["sid": sid, "status": "streaming"])) }
    }

    private func retire(_ sid: String, session: StreamSession, error: String? = nil, completion: (@Sendable ([String: Any]) -> Void)? = nil) {
        session.lock.lock()
        if completion != nil && session.stopReply != nil { session.lock.unlock(); completion?(WireFormat.failure("resource_limit", "stream native cleanup is already resolving")); return }
        session.retiring = true; session.recording = false; session.lastFrameData = nil; session.latestCGImage = nil
        if let error { session.error = error }
        let startup = session.startReply; session.startReply = nil
        if let completion { session.stopReply = completion }
        let ready = !session.starting && !session.stopping
        if ready { session.stopping = true }
        let stream = session.captureAttempted ? session.stream : nil
        let media = session.mediaRecord
        session.lock.unlock()
        startup?(WireFormat.failure(Self.code(for: error ?? "stream startup cancelled"), error ?? "stream startup cancelled"))
        guard ready else { return }
        let closeNative: @Sendable ([String: Any]?) -> Void = { mediaFailure in
        let failureBox = UncheckedSendableBox(mediaFailure)
        let stopped: @Sendable (Error?) -> Void = { stopError in
            // SCStreamError.attemptToStopStreamState: the stream is already stopped or gone (it stopped
            // itself, e.g. its window closed), so native cleanup is complete; keeping the session would
            // fail every later stream command with this stale error.
            let error = (stopError as NSError?).flatMap { $0.domain == SCStreamErrorDomain && $0.code == SCStreamError.Code.attemptToStopStreamState.rawValue ? nil : $0 }
            let reply = session.lock.withLock { () -> (@Sendable ([String: Any]) -> Void)? in
                let reply = session.stopReply; session.stopReply = nil; session.stopping = false
                if let error { session.error = "native stream cleanup failed: \(error.localizedDescription)" }
                else { session.stream = nil }
                return reply
            }
            if error == nil { self.sessionsQueue.sync { if self.sessions[sid] === session { self.sessions.removeValue(forKey: sid) } } }
            reply?(error.map { WireFormat.failure("provider_failed", "native stream cleanup failed: \($0.localizedDescription)") } ?? failureBox.value ?? WireFormat.success("ok"))
        }
        if let stream { stream.stopCapture(completionHandler: stopped) } else { stopped(nil) }
        }
        if let media {
            media.whenResolved { response in closeNative(response["success"] as? Bool == true ? nil : response) }
            media.end(reason: error)
        } else { closeNative(nil) }
    }

    private func stopStream(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let targets: [String: StreamSession] = sessionsQueue.sync {
            if let sid = action["sid"] as? String { return sessions[sid].map { [sid: $0] } ?? [:] }
            return sessions
        }
        if action["sid"] != nil && targets.isEmpty { completion(WireFormat.failure("target_gone", "stream session is not active")); return }
        let finished = AtomicFlag(), group = DispatchGroup(), errors = LockedData()
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
            if finished.set() { completion(["success": false, "code": "timeout_unknown_outcome", "error": "stream stop exceeded ten seconds; callbacks are revoked and admission remains occupied until native cleanup resolves"]) }
        }
        for (sid, session) in targets {
            group.enter()
            retire(sid, session: session) { response in
                if response["success"] as? Bool != true { errors.append(Data((String(response["error"] as? String ?? "native stream cleanup failed").prefix(512) + "\n").utf8)) }
                group.leave()
            }
        }
        group.notify(queue: .global()) {
            guard finished.set() else { return }
            let error = errors.snapshot()
            completion(error.isEmpty ? WireFormat.success("ok") : ["success": false, "code": "partial_result", "error": String(String(decoding: error, as: UTF8.self).prefix(512))])
        }
    }

    private func streamStatus(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let status: [[String: Any]] = sessionsQueue.sync {
            sessions.map { (sid, session) -> [String: Any] in session.lock.withLock {
                [
                    "sid": sid,
                    "frameCount": session.frameCount,
                    "fps": session.currentFPS,
                    "duration": session.startTime.map { Date().timeIntervalSince($0) } ?? 0
                ]
            }
            }
        }
        if let error = sessionsQueue.sync(execute: { sessions.values.compactMap { s in s.lock.withLock { s.problem } }.first }) { completion(WireFormat.failure(Self.code(for: error), error)); return }
        completion(WireFormat.success(status))
    }

    private func getFrame(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let session = selectedSession(action) else { completion(WireFormat.failure("target_gone", "name one active stream; selection is missing or ambiguous")); return }
        let result: [String: Any] = session.lock.withLock {
            if let error = session.problem { return WireFormat.failure(Self.code(for: error), error) }
            guard let frame = session.lastFrameData else { return WireFormat.failure("partial_result", "no native frame available yet") }
            return WireFormat.success(["dataUrl": frame, "frameCount": session.frameCount])
        }
        completion(result)
    }

    private func getFPS(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let session = selectedSession(action) else { completion(WireFormat.failure("target_gone", "name one active stream; selection is missing or ambiguous")); return }
        completion(session.lock.withLock { session.problem.map { WireFormat.failure(Self.code(for: $0), $0) } ?? WireFormat.success(["fps": session.currentFPS]) })
    }

    private func getResolution(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let session = selectedSession(action) else { completion(WireFormat.failure("target_gone", "name one active stream; selection is missing or ambiguous")); return }
        completion(session.lock.withLock { session.problem.map { WireFormat.failure(Self.code(for: $0), $0) } ?? WireFormat.success(["width": session.lastWidth, "height": session.lastHeight]) })
    }

    private func injectInput(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let selected = selectedSession(action) else { completion(WireFormat.failure("target_gone", "name one active stream; selection is missing or ambiguous")); return }
        let (application, window, error) = selected.lock.withLock { (selected.application, selected.windowID, selected.problem) }
        if let error { completion(WireFormat.failure(Self.code(for: error), error)); return }
        guard let application, !application.isTerminated, let window, let router else { completion(WireFormat.failure("unsupported_target", "stream input requires one current owned application/window capture; no global input was delivered")); return }
        let kind = action["inputType"] as? String ?? "click"
        var child: [String: Any] = ["type": "desktop_\(kind)", "pid": Int(application.processIdentifier), "window": Int(window), "backgroundOnly": true]
        switch kind {
        case "click":
            guard let x = action["x"] as? NSNumber, let y = action["y"] as? NSNumber else { completion(WireFormat.failure("invalid_request", "stream click requires screen coordinates")); return }
            // desktop_click coords are whole Int32 points ("170,338"); "170.0,338.0" fails its validation.
            guard let px = Int32(exactly: x.doubleValue.rounded()), let py = Int32(exactly: y.doubleValue.rounded()) else { completion(WireFormat.failure("invalid_request", "invalid coordinates")); return }
            child["coords"] = "\(px),\(py)"
        case "type": child["text"] = action["text"]; child["ref"] = action["ref"]
        case "keys": child["keys"] = action["combo"]
        case "scroll": child["direction"] = action["direction"]; child["amount"] = action["amount"]
        default: completion(WireFormat.failure("invalid_request", "unknown stream input type")); return
        }
        router.route(action: child, completion: completion)
    }

    private func handleRecord(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let session = selectedSession(action) else { completion(WireFormat.failure("target_gone", "name one active stream; selection is missing or ambiguous")); return }
        let op = action["recordOp"] as? String ?? "status"
        if op == "start", action["media"] as? Bool == true {
            let generation = UUID().uuidString
            var native: (SCStream, SCStreamConfiguration, [String: Any])?
            let admitted: [String: Any]? = session.lock.withLock {
                if let error = session.problem { return WireFormat.failure(Self.code(for: error), error) }
                guard !session.recording, session.mediaRecord?.resolved != false, let stream = session.stream, let configuration = session.configuration else { return WireFormat.failure("resource_limit", "stream recording admission or cleanup is already active") }
                let audio = action["recordAudio"] as? String ?? "none"
                if audio == "system", !session.explicitDisplay || session.displayID == nil { return WireFormat.failure("invalid_request", "system audio recording requires one explicitly selected native display; no unrelated application audio was captured") }
                var source: [String: Any]
                if let window = session.windowID {
                    guard let application = session.application, !application.isTerminated else { return WireFormat.failure("target_gone", "stream window owner is unavailable; no replacement source was recorded") }
                    source = ["kind": "window", "window": Int(window), "pid": Int(application.processIdentifier)]
                } else if let display = session.displayID { source = ["kind": "display", "display": Int(display)] }
                else { return WireFormat.failure("target_gone", "stream has no retained native media source identity") }
                session.mediaRecord = nil; session.recording = true; session.recordGeneration = generation
                session.recordingStartTime = Date(); session.recordedFrameCount = 0; session.recordDuration = 0
                native = (stream, configuration, source); return nil
            }
            if let admitted { completion(admitted); return }
            guard let native else { completion(WireFormat.failure("provider_failed", "native media admission was not reserved")); return }
            do {
                let media = try StreamMediaRecording(sid: session.sid, audio: action["recordAudio"] as? String ?? "none",
                    source: native.2, stream: native.0, configuration: native.1,
                    isCurrent: { [weak session] in session?.lock.withLock { session?.recordGeneration == generation && session?.retiring == false } ?? false },
                    onResolved: { [weak session] in
                        session?.lock.withLock { if session?.recordGeneration == generation { session?.recording = false; session?.recordGeneration = nil; session?.recordingStartTime = nil } }
                    })
                let current = session.lock.withLock { () -> Bool in
                    guard session.recordGeneration == generation, session.recording, !session.retiring else { return false }
                    session.mediaRecord = media; return true
                }
                guard current else { completion(WireFormat.failure("provider_failed", "media admission was cancelled before native attachment")); return }
                media.begin(completion: completion)
            } catch {
                session.lock.withLock { if session.recordGeneration == generation { session.recordGeneration = nil; session.recording = false; session.recordingStartTime = nil } }
                completion(WireFormat.failure("provider_failed", "native media archive admission failed: \(error.localizedDescription)"))
            }
            return
        }
        if op != "start", let media = session.lock.withLock({ session.mediaRecord }) {
            if op == "stop" { media.stop(completion: completion) } else { completion(media.snapshot()) }
            return
        }
        let response: [String: Any] = session.lock.withLock {
            if let error = session.problem { return WireFormat.failure(Self.code(for: error), error) }
            if op == "start" {
                guard !session.recording, session.mediaRecord?.resolved != false else { return WireFormat.failure("resource_limit", "stream recording or native media cleanup is already active") }
                session.mediaRecord = nil; session.recordGeneration = nil
                session.recording = true; session.recordingStartTime = Date(); session.recordedFrameCount = 0; session.recordDuration = 0
                return WireFormat.success(["recording": true, "sid": session.sid])
            }
            if op == "stop", session.recording {
                session.recording = false
                session.recordGeneration = nil
                session.recordDuration = session.recordingStartTime.map { max(0, Date().timeIntervalSince($0)) } ?? 0
                session.recordingStartTime = nil
            }
            let duration = session.recordingStartTime.map { max(0, Date().timeIntervalSince($0)) } ?? session.recordDuration
            return WireFormat.success(["recording": session.recording, "frames": session.recordedFrameCount, "duration": duration])
        }
        completion(response)
    }
}

@available(macOS 13.0, *)
final class StreamSession: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let lock = NSLock()
    var sid = ""
    var starting = true
    var retiring = false
    var stopping = false
    var captureAttempted = false
    var startReply: (@Sendable ([String: Any]) -> Void)?
    var stopReply: (@Sendable ([String: Any]) -> Void)?
    var onFailure: (@Sendable (String) -> Void)?
    var problem: String? { error ?? (retiring ? "stream native cleanup is resolving" : starting ? "stream startup is resolving" : nil) }
    var appName: String?
    var windowID: CGWindowID?
    var application: NSRunningApplication?
    var displayID: CGDirectDisplayID?, explicitDisplay = false
    var configuration: SCStreamConfiguration?
    var mediaRecord: StreamMediaRecording?, recordGeneration: String?
    var error: String?
    var stream: SCStream?
    var startTime: Date?
    var frameCount: Int = 0
    var lastFrameData: String?
    var lastWidth: Int = 0
    var lastHeight: Int = 0
    var currentFPS: Double = 0
    private var fpsCounter: Int = 0
    private var fpsTimestamp: Date = Date()
    private let imageContext = CIContext()
    var latestCGImage: CGImage?
    var recording = false
    var recordingStartTime: Date?
    var recordedFrameCount: Int = 0
    var recordDuration: Double = 0

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, lock.withLock({ self.stream === stream }) else { return }
        consume(sampleBuffer)
    }

    func consume(_ sampleBuffer: CMSampleBuffer) {
        var failure: String?
        lock.lock()
        defer { let callback = onFailure; lock.unlock(); if let failure { callback?(failure) } }
        guard error == nil, !retiring, CMSampleBufferIsValid(sampleBuffer),
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: status) == .complete,
              let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)
        guard width > 0, height > 0, width <= DESKTOP_CAPTURE_MAX_PIXELS / height else { failure = "stream frame exceeds its pixel bound"; error = failure; latestCGImage = nil; lastFrameData = nil; return }
        let ciImage = CIImage(cvPixelBuffer: imageBuffer)
        guard let cgImage = imageContext.createCGImage(ciImage, from: CGRect(x: 0, y: 0, width: width, height: height)),
              let jpegData = NSBitmapImageRep(cgImage: cgImage).representation(using: .jpeg, properties: [.compressionFactor: 0.5]) else { failure = "native stream JPEG encoding failed"; error = failure; latestCGImage = nil; lastFrameData = nil; return }
        let url = "data:image/jpeg;base64," + jpegData.base64EncodedString()
        guard url.utf8.count < DESKTOP_MAX_RESULT_BYTES, frameCount < 9007199254740991 else { failure = "stream frame/counter exceeds its wire bound"; error = failure; latestCGImage = nil; lastFrameData = nil; return }
        latestCGImage = cgImage; lastFrameData = url; lastWidth = width; lastHeight = height
        frameCount += 1; fpsCounter += 1
        if recording { recordedFrameCount += 1 }
        let now = Date(), elapsed = now.timeIntervalSince(fpsTimestamp)
        if elapsed >= 1.0 {
            currentFPS = Double(fpsCounter) / elapsed
            fpsCounter = 0; fpsTimestamp = now
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let failure = "native stream stopped: \(error.localizedDescription)"
        let callback = lock.withLock { () -> (@Sendable (String) -> Void)? in
            guard !retiring else { return nil }
            self.error = failure; latestCGImage = nil; lastFrameData = nil; recording = false
            return onFailure
        }
        callback?(failure)
    }
}
