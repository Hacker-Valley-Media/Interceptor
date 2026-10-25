import Foundation
import AppKit
@preconcurrency import AVFoundation
import CoreImage
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import ShareNative

/// `macos camera`: frames from a camera (the built-in one, a Continuity Camera,
/// Desk View, or a USB camera) with no window on screen.
///
/// The bridge holds the session, so the camera TCC grant belongs to
/// interceptor-bridge.app (NSCameraUsageDescription + the
/// com.apple.security.device.camera entitlement). A CLI tool such as
/// `ffmpeg -f avfoundation` run from a terminal or an agent shell has no bundle
/// to grant and hangs waiting for a prompt that never shows; the only other
/// way to see the camera was a frontmost app window, which freezes when covered.
///
///   camera list                         devices: id, name, type, position
///   camera start [--device <id|name>]   start the session; --prompt asks for access the first time
///   camera frame [--out <path>]         latest frame; JPEG file or data URL
///   camera status                       active, device, frame age, frame count
///   camera stop
final class CameraDomain: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var session: AVCaptureSession?
    // AVCaptureVideoDataOutput holds its delegate weakly; keep it alive here.
    private var output: CameraFrameOutput?
    private var device: [String: Any]?
    // The rate the camera itself was set to, when the cap could be applied.
    private var deviceFps: Double?
    private var latestImage: CGImage?
    private var latestTimestamp: Date?
    private var frameCount = 0
    private var interruption: String?
    private var starting = false
    // Bumped by every stop. A start captures it and installs its session only
    // if no stop arrived meanwhile (e.g. while the camera prompt was up).
    private var generation = 0
    private var observers: [NSObjectProtocol] = []
    // Signaled on every converted frame so `frame` can wait out the gap
    // between startRunning() and the first sample buffer.
    private let frameReady = DispatchSemaphore(value: 0)
    private let sessionQueue = DispatchQueue(label: "interceptor.camera.session")

    // Test seams. Production asks AVFoundation about `.video` through the same
    // provider TrustDomain uses for the microphone.
    var authorization: MicrophoneAuthorizationProvider = LiveMicrophoneAuthorizationProvider(mediaType: .video)
    // An answer later than this does not turn the camera on: the CLI stops
    // waiting for `start --prompt` at 125 s, so nobody would read the frames.
    var promptDeadline: TimeInterval = 120
    var testForcedActive = false

    func _testInjectFrame(_ image: CGImage) {
        lock.withLock {
            latestImage = image
            latestTimestamp = Date()
            frameCount += 1
        }
        frameReady.signal()
    }

    func _testInterrupt(_ reason: String?) {
        lock.withLock { interruption = reason }
    }

    func _testReset() {
        lock.withLock {
            latestImage = nil
            latestTimestamp = nil
            frameCount = 0
            testForcedActive = false
            interruption = nil
        }
        while frameReady.wait(timeout: .now()) == .success {}
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? "status"
        switch sub {
        case "list":
            completion(WireFormat.success(["devices": Self.devices().map(Self.describe)]))
        case "start":
            start(action, completion: completion)
        case "frame":
            frame(action, completion: completion)
        case "status":
            completion(WireFormat.success(status()))
        case "stop":
            stop()
            completion(WireFormat.success("camera stopped"))
        default:
            completion(WireFormat.failure("invalid_request", "camera requires list, start, frame, status or stop"))
        }
    }

    // MARK: - Devices

    static func devices() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .continuityCamera, .deskViewCamera, .external],
            mediaType: .video,
            position: .unspecified
        ).devices
    }

    static func describe(_ device: AVCaptureDevice) -> [String: Any] {
        let type: String
        switch device.deviceType {
        case .builtInWideAngleCamera: type = "builtIn"
        case .continuityCamera: type = "continuity"
        case .deskViewCamera: type = "deskView"
        case .external: type = "external"
        default: type = device.deviceType.rawValue
        }
        return [
            "id": device.uniqueID,
            "name": device.localizedName,
            "type": type,
            "position": device.position == .front ? "front" : device.position == .back ? "back" : "unspecified",
            "default": device.uniqueID == AVCaptureDevice.default(for: .video)?.uniqueID,
            "suspended": device.isSuspended,
        ]
    }

    /// `--device` matches a uniqueID exactly, then a name case-insensitively
    /// (exact before substring). Without it, the system default camera.
    static func resolve(_ selector: String?, in devices: [AVCaptureDevice]) -> AVCaptureDevice? {
        guard let selector, !selector.isEmpty else { return AVCaptureDevice.default(for: .video) ?? devices.first }
        return pick(selector, from: devices.map { ($0.uniqueID, $0.localizedName) }).map { devices[$0] }
    }

    /// The matching rule on plain (id, name) pairs, so it is testable without hardware.
    static func pick(_ selector: String, from devices: [(id: String, name: String)]) -> Int? {
        if let byId = devices.firstIndex(where: { $0.id == selector }) { return byId }
        let lower = selector.lowercased()
        return devices.firstIndex(where: { $0.name.lowercased() == lower })
            ?? devices.firstIndex(where: { $0.name.lowercased().contains(lower) })
    }

    // MARK: - Session

    private func start(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let claimed = lock.withLock { () -> Int? in
            if session != nil || starting { return nil }
            starting = true
            return generation
        }
        guard let gen = claimed else {
            completion(WireFormat.failure("invalid_request", "camera is already running or starting; stop it before choosing another device"))
            return
        }
        let finish: @Sendable ([String: Any]) -> Void = { [self] result in
            // A stop already cleared `starting`; a newer start may own it now.
            lock.withLock { if generation == gen { starting = false } }
            completion(result)
        }
        let boxed = UncheckedSendableBox(action)
        switch authorization.currentStatus() {
        case .authorized:
            sessionQueue.async { [self] in finish(self.startSession(boxed.value, generation: gen)) }
        case .notDetermined:
            // Only `start --prompt` asks: the prompt brings the bridge forward,
            // and every other camera call stays in the background.
            guard action["prompt"] as? Bool == true else { finish(Self.promptRequired()); return }
            // Same activation-policy upgrade as TrustDomain.checkMicrophone, so
            // the LSUIElement bridge gets a modal alert rather than a banner
            // that can auto-deny; xctest leaves its own Dock state alone.
            let isLiveBridge = Bundle.main.bundleIdentifier == "com.interceptor.bridge"
            let previous = UncheckedSendableBox(isLiveBridge ? FrontmostResolver.frontmostApplication() : nil)
            if isLiveBridge {
                DispatchQueue.main.async {
                    NSApplication.shared.setActivationPolicy(.regular)
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }
            }
            let asked = Date()
            authorization.requestAccess { [self] granted in
                let late = Date().timeIntervalSince(asked) > promptDeadline
                let proceed: @Sendable (String?) -> Void = { [self] returnedTo in
                    guard granted else { finish(Self.permissionFailure()); return }
                    guard !late else { finish(Self.answeredTooLate()); return }
                    sessionQueue.async { [self] in
                        var result = self.startSession(boxed.value, generation: gen)
                        if let returnedTo, var data = result["data"] as? [String: Any] {
                            data["returnedTo"] = returnedTo
                            result["data"] = data
                        }
                        finish(result)
                    }
                }
                guard isLiveBridge else { proceed(nil); return }
                DispatchQueue.main.async {
                    NSApplication.shared.setActivationPolicy(.accessory)
                    proceed(Self.giveFocusBack(to: previous.value))
                }
            }
        default:
            finish(Self.permissionFailure())
        }
    }

    /// Hands focus back to the app that was in front when the prompt was asked
    /// for: the active app yields, then the target activates (Apple's
    /// cooperative activation order). Returns the app's name when it worked.
    @MainActor static func giveFocusBack(to app: NSRunningApplication?) -> String? {
        guard let app, app.processIdentifier != ProcessInfo.processInfo.processIdentifier, !app.isTerminated else { return nil }
        NSApplication.shared.yieldActivation(to: app)
        return app.activate() ? (app.localizedName ?? app.bundleIdentifier) : nil
    }

    static func permissionFailure() -> [String: Any] {
        WireFormat.failure("permission_required", "Camera permission required; allow interceptor-bridge in System Settings > Privacy & Security > Camera")
    }

    static func promptRequired() -> [String: Any] {
        WireFormat.failure("permission_required", "camera access is not decided yet; run interceptor macos camera start --prompt to show the macOS camera prompt (it brings interceptor-bridge forward for the dialog, then returns to the app you were in)")
    }

    static func answeredTooLate() -> [String: Any] {
        WireFormat.failure("timeout", "camera access was answered after the request stopped waiting; the camera was not started. Run camera start again")
    }

    static func stoppedWhileStarting() -> [String: Any] {
        WireFormat.failure("invalid_request", "camera stop arrived before start finished; the camera was not started")
    }

    private func startSession(_ action: [String: Any], generation gen: Int) -> [String: Any] {
        if lock.withLock({ generation != gen }) { return Self.stoppedWhileStarting() }
        let all = Self.devices()
        let selector = action["device"] as? String
        guard let device = Self.resolve(selector, in: all) else {
            return WireFormat.failure("target_not_found", selector == nil ? "no camera found" : "no camera matches \(selector!); run camera list")
        }
        let session = AVCaptureSession()
        session.beginConfiguration()
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            session.commitConfiguration()
            return WireFormat.failure("provider_failed", "cannot open \(device.localizedName): \(error.localizedDescription)")
        }
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            return WireFormat.failure("provider_failed", "cannot add \(device.localizedName) to a capture session")
        }
        session.addInput(input)
        // .high is the camera's native video format (1920x1080 on a 2026 MacBook
        // Pro). Callers that want less pass --max-long-edge on `frame`; scaling
        // there keeps one session serving both Vision and small previews.
        session.sessionPreset = .high

        let fps = max(1, min(action["fps"] as? Int ?? 10, 30))
        let output = CameraFrameOutput(minInterval: 1.0 / Double(fps)) { [weak self] image in
            guard let self else { return }
            self.lock.withLock {
                guard self.session === session else { return }
                self.latestImage = image
                self.latestTimestamp = Date()
                self.frameCount += 1
                // Signal under the same lock as the session check: a stop and a
                // new start between the two would otherwise get a stale signal
                // that wakes the new session's first `frame` with no frame.
                self.frameReady.signal()
            }
        }
        let videoOutput = AVCaptureVideoDataOutput()
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        videoOutput.setSampleBufferDelegate(output, queue: DispatchQueue(label: "interceptor.camera.frames"))
        guard session.canAddOutput(videoOutput) else {
            session.commitConfiguration()
            return WireFormat.failure("provider_failed", "cannot add a video output for \(device.localizedName)")
        }
        session.addOutput(videoOutput)
        session.commitConfiguration()
        let applied = Self.capFrameRate(device, fps: fps, session: session)

        while frameReady.wait(timeout: .now()) == .success {}
        let info = Self.describe(device)
        let current = lock.withLock { () -> Bool in
            guard generation == gen else { return false }
            self.session = session
            self.output = output
            self.device = info
            self.deviceFps = applied
            self.latestImage = nil
            self.latestTimestamp = nil
            self.frameCount = 0
            self.interruption = nil
            return true
        }
        guard current else { return Self.stoppedWhileStarting() }
        observe(session)
        session.startRunning()
        guard session.isRunning else {
            stop()
            return WireFormat.failure("provider_failed", "\(device.localizedName) did not start; another app may hold it exclusively")
        }
        var result: [String: Any] = ["started": true, "device": info, "fps": fps]
        if let applied { result["deviceFps"] = applied }
        return WireFormat.success(result)
    }

    /// Asks the camera itself for at most `fps`, so it does not deliver (and
    /// the bridge convert) frames that `CameraFrameOutput` would drop. Apple:
    /// activeVideoMinFrameDuration limits "the maximum frame rate"; setting it
    /// to a value outside the active format's supported ranges, without the
    /// device lock, or with auto frame rate on raises an Objective-C exception,
    /// so the value comes from those ranges and the setters run inside
    /// InterceptorNativeOperation. Returns the camera's rate afterwards, or nil
    /// when it was left at its default (the output-side throttle still holds).
    static func capFrameRate(_ device: AVCaptureDevice, fps: Int, session: AVCaptureSession) -> Double? {
        guard !device.isAutoVideoFrameRateEnabled else { return nil }
        let ranges = device.activeFormat.videoSupportedFrameRateRanges.map { (min: $0.minFrameDuration, max: $0.maxFrameDuration) }
        guard let duration = frameDuration(fps: fps, ranges: ranges) else { return nil }
        session.beginConfiguration()
        guard (try? device.lockForConfiguration()) != nil else { session.commitConfiguration(); return nil }
        let failure = InterceptorNativeOperation("Camera") {
            // Keep min <= max at every step: lengthen the max first when the
            // new minimum is longer than it.
            if CMTimeCompare(duration, device.activeVideoMaxFrameDuration) > 0 { device.activeVideoMaxFrameDuration = duration }
            device.activeVideoMinFrameDuration = duration
        }
        device.unlockForConfiguration()
        session.commitConfiguration()
        if let failure { Platform.log("camera frame rate left at default: \(failure.localizedDescription)"); return nil }
        let seconds = CMTimeGetSeconds(device.activeVideoMinFrameDuration)
        return seconds > 0 ? (1 / seconds * 100).rounded() / 100 : nil
    }

    /// The supported frame duration closest to 1/fps: 1/fps itself when a
    /// range contains it, otherwise the nearer end of the closest range.
    static func frameDuration(fps: Int, ranges: [(min: CMTime, max: CMTime)]) -> CMTime? {
        let target = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
        let distance = { (time: CMTime) in abs(CMTimeGetSeconds(time) - CMTimeGetSeconds(target)) }
        return ranges.map { range -> CMTime in
            if CMTimeCompare(target, range.min) < 0 { return range.min }
            if CMTimeCompare(target, range.max) > 0 { return range.max }
            return target
        }.min { distance($0) < distance($1) }
    }

    /// A camera can be taken away mid-session (lid closed, Continuity phone
    /// walked off, another app grabbing it exclusively). `status` reports it
    /// instead of serving an ever-older frame as if it were live.
    private func observe(_ session: AVCaptureSession) {
        let center = NotificationCenter.default
        // macOS gives no interruption reason (AVCaptureSessionInterruptionReasonKey is iOS-only).
        let interrupted = center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: nil) { [weak self] _ in
            self?.lock.withLock { self?.interruption = "interrupted" }
            Platform.log("camera session interrupted")
        }
        let resumed = center.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: nil) { [weak self] _ in
            self?.lock.withLock { self?.interruption = nil }
        }
        let failed = center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] note in
            let error = (note.userInfo?[AVCaptureSessionErrorKey] as? NSError)?.localizedDescription ?? "unknown error"
            self?.lock.withLock { self?.interruption = "runtime error: \(error)" }
            Platform.log("camera session runtime error: \(error)")
        }
        lock.withLock { observers = [interrupted, resumed, failed] }
    }

    private func stop() {
        let (old, oldObservers) = lock.withLock { () -> (AVCaptureSession?, [NSObjectProtocol]) in
            let old = (session, observers)
            generation += 1
            starting = false
            session = nil
            output = nil
            device = nil
            deviceFps = nil
            latestImage = nil
            latestTimestamp = nil
            frameCount = 0
            interruption = nil
            observers = []
            return old
        }
        oldObservers.forEach(NotificationCenter.default.removeObserver)
        if let old { sessionQueue.async { old.stopRunning() } }
    }

    func status() -> [String: Any] {
        lock.withLock {
            var payload: [String: Any] = [
                "active": session != nil || testForcedActive,
                "hasFrame": latestImage != nil,
                "frames": frameCount,
                "authorization": authorization.currentStatus().permissionStatus.rawValue,
            ]
            if let device { payload["device"] = device }
            if let deviceFps { payload["deviceFps"] = deviceFps }
            if let latestTimestamp { payload["frameAgeMs"] = Int(Date().timeIntervalSince(latestTimestamp) * 1000) }
            if let interruption { payload["interruption"] = interruption }
            return payload
        }
    }

    // MARK: - Frames

    private func frame(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let timeoutMs = action["timeoutMs"] as? Int ?? 3000
        let (active, buffered, interrupted) = lock.withLock { (session != nil || testForcedActive, latestImage, interruption) }
        if let interrupted {
            completion(Self.interruptedFailure(interrupted))
            return
        }
        if let buffered {
            completion(deliver(buffered, action))
            return
        }
        guard active else {
            completion(WireFormat.failure("invalid_request", "camera not started; run camera start first"))
            return
        }
        // Started but no sample buffer yet: the first one takes ~0.5-1.5s.
        let boxed = UncheckedSendableBox(action)
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            let waited = self.frameReady.wait(timeout: .now() + .milliseconds(timeoutMs))
            let (image, interrupted) = self.lock.withLock { (self.latestImage, self.interruption) }
            if let interrupted {
                completion(Self.interruptedFailure(interrupted))
            } else if let image {
                completion(self.deliver(image, boxed.value))
            } else {
                completion(WireFormat.failure("timeout", waited == .timedOut
                    ? "camera running but no frame in \(timeoutMs)ms; raise --timeout-ms or check camera status"
                    : "camera running but no frame buffered"))
            }
        }
    }

    /// An interrupted camera's last frame is not live; say so instead of serving it.
    static func interruptedFailure(_ interruption: String) -> [String: Any] {
        WireFormat.failure("provider_failed", "camera \(interruption); its last frame is not live. Check camera status, then stop and start")
    }

    /// Writes the frame to `out` when given (an absolute path from the CLI),
    /// otherwise returns it inline as a data URL, the `capture frame` shape.
    private func deliver(_ image: CGImage, _ action: [String: Any]) -> [String: Any] {
        let maxEdge = action["maxLongEdge"] as? Int ?? 0
        let scaled = maxEdge > 0 ? Self.scale(image, maxLongEdge: maxEdge) : image
        let quality = Double(action["quality"] as? Int ?? 85) / 100
        guard let data = Self.jpeg(scaled, quality: quality) else {
            return WireFormat.failure("provider_failed", "could not encode the camera frame")
        }
        var payload: [String: Any] = [
            "bytes": data.count,
            "width": scaled.width,
            "height": scaled.height,
            "format": "jpeg",
        ]
        lock.withLock {
            if let latestTimestamp { payload["frameAgeMs"] = Int(Date().timeIntervalSince(latestTimestamp) * 1000) }
            payload["frame"] = frameCount
        }
        if let out = action["out"] as? String {
            let url = URL(fileURLWithPath: (out as NSString).expandingTildeInPath)
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: url, options: .atomic)
            } catch {
                return WireFormat.failure("provider_failed", "cannot write \(url.path): \(error.localizedDescription)")
            }
            payload["path"] = url.path
        } else {
            payload["dataUrl"] = "data:image/jpeg;base64,\(data.base64EncodedString())"
        }
        return WireFormat.success(payload)
    }

    static func jpeg(_ image: CGImage, quality: Double) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? data as Data : nil
    }

    static func scale(_ image: CGImage, maxLongEdge: Int) -> CGImage {
        let long = max(image.width, image.height)
        guard long > maxLongEdge else { return image }
        let factor = Double(maxLongEdge) / Double(long)
        let width = Int((Double(image.width) * factor).rounded())
        let height = Int((Double(image.height) * factor).rounded())
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue) else { return image }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage() ?? image
    }
}

/// Converts sample buffers to CGImage at most once per `minInterval`. The
/// camera delivers ~30 fps; converting every one would burn CPU for frames
/// nobody reads. One CIContext is reused for the session's life.
final class CameraFrameOutput: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let minInterval: TimeInterval
    private let onFrame: @Sendable (CGImage) -> Void
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var last = Date.distantPast

    init(minInterval: TimeInterval, onFrame: @escaping @Sendable (CGImage) -> Void) {
        self.minInterval = minInterval
        self.onFrame = onFrame
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let now = Date()
        guard now.timeIntervalSince(last) >= minInterval, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let image = CIImage(cvPixelBuffer: pixels)
        guard let cgImage = context.createCGImage(image, from: image.extent) else { return }
        last = now
        onFrame(cgImage)
    }
}
