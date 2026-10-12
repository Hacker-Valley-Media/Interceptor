import Foundation
@preconcurrency import ScreenCaptureKit
@preconcurrency import AVFoundation
import CryptoKit
import Darwin

// A recording generation owns its delegate, output, directory and pending
// replies until native termination and file inspection have both resolved.
final class StreamMediaRecording: @unchecked Sendable {
    private enum Phase: Equatable { case admitting, recording, stopping, verifying, finalized, failed }
    private let lock = NSLock()
    private let worker = DispatchQueue(label: "interceptor.stream.media")
    private let sid: String, audio: String, source: [String: Any], directory: String, path: String
    private let directoryHandle: FileHandle
    private var directoryFD: Int32 { directoryHandle.fileDescriptor }
    private let stream: SCStream, configuration: SCStreamConfiguration
    private let isCurrent: @Sendable () -> Bool
    private let onResolved: @Sendable () -> Void
    private var phase: Phase = .admitting, attached = false, admissionResolving = true
    private var stopRequested = false, nativeFailed = false, failure: String?
    private var failureResolving = false, configurationChange: Task<Void, Error>?
    private var bytes: Int64 = 0, duration = 0.0, hash: String?
    private var output: SCRecordingOutput?, delegate: MonitorRecordingDelegate?, timer: DispatchSourceTimer?
    private var startReply: (@Sendable ([String: Any]) -> Void)?
    private var stopReplies: [@Sendable ([String: Any]) -> Void] = []
    private var retirementReply: (@Sendable ([String: Any]) -> Void)?

    init(sid: String, audio: String, source: [String: Any], stream: SCStream,
         configuration: SCStreamConfiguration, isCurrent: @escaping @Sendable () -> Bool,
         onResolved: @escaping @Sendable () -> Void) throws {
        self.sid = sid; self.audio = audio; self.source = source; self.stream = stream
        let ownedConfiguration = SCStreamConfiguration()
        ownedConfiguration.width = configuration.width; ownedConfiguration.height = configuration.height
        ownedConfiguration.minimumFrameInterval = configuration.minimumFrameInterval; ownedConfiguration.queueDepth = configuration.queueDepth
        ownedConfiguration.pixelFormat = configuration.pixelFormat; ownedConfiguration.showsCursor = configuration.showsCursor
        self.configuration = ownedConfiguration; self.isCurrent = isCurrent; self.onResolved = onResolved
        var template = Array((FileManager.default.temporaryDirectory.resolvingSymlinksInPath().path + "/interceptor-stream-XXXXXX").utf8CString)
        let created = template.withUnsafeMutableBufferPointer { mkdtemp($0.baseAddress!) != nil }
        guard created else { throw Self.error("could not create an exclusive private stream archive") }
        directory = template.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
        path = directory + "/recording.mp4"
        let descriptor = Darwin.open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        var info = stat()
        guard descriptor >= 0, fstat(descriptor, &info) == 0, info.st_uid == geteuid(),
              info.st_mode & 0o777 == 0o700, path.utf8.count <= 4096 else {
            if descriptor >= 0 { Darwin.close(descriptor) }
            throw Self.error("stream archive is not an owned private directory")
        }
        let config = SCRecordingOutputConfiguration()
        guard config.availableOutputFileTypes.contains(.mp4), config.availableVideoCodecTypes.contains(.h264) else {
            Darwin.close(descriptor); throw Self.error("native stream writer does not offer H264/MP4")
        }
        directoryHandle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        config.outputURL = URL(fileURLWithPath: directory + "/native.partial.mp4")
        config.outputFileType = .mp4; config.videoCodecType = .h264
        let delegate = MonitorRecordingDelegate(domain: nil, runtime: nil, path: config.outputURL.path,
            onStart: { [weak self] output in self?.nativeStarted(output) },
            onFinish: { [weak self] output in self?.nativeFinished(output) },
            onFailure: { [weak self] error in self?.nativeFailure(error) })
        self.delegate = delegate; output = SCRecordingOutput(configuration: config, delegate: delegate)
    }
    deinit { timer?.cancel() }
    private static func error(_ text: String) -> NSError {
        NSError(domain: "InterceptorStreamMedia", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
    }
    var resolved: Bool { lock.withLock { phase == .finalized || phase == .failed } }
    private func errorReply(_ text: String) -> [String: Any] {
        ["success": false, "code": "partial_result", "error": "\(text); partial stream media, if any, is preserved in \(directory)"]
    }
    func snapshot() -> [String: Any] {
        lock.withLock {
            if let failure { return errorReply(failure) }
            var artifact: [String: Any] = ["filePath": path, "container": "mp4", "videoCodec": "h264",
                "audio": audio, "timing": "native-media", "finalized": phase == .finalized,
                "bytes": max(0, bytes), "source": source]
            if let hash { artifact["sha256"] = hash }
            // SCK does not expose an encoded-frame count. Cache callbacks are
            // not substituted for that missing measurement.
            return WireFormat.success(["recording": phase != .finalized && phase != .failed,
                "sid": sid, "duration": max(0, duration), "artifact": artifact])
        }
    }
    func begin(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let replied = AtomicFlag()
        lock.withLock { startReply = { response in if replied.set() { completion(response) } } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) { [self] in
            if replied.set() {
                completion(["success": false, "code": "timeout_unknown_outcome", "error": "native media admission exceeded ten seconds; generation remains retained until cleanup resolves"])
                end(reason: "native media admission exceeded its deadline")
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + Double(DESKTOP_STREAM_MEDIA_MAX_SECONDS)) { [weak self] in
            guard let self, !self.resolved else { return }; self.end(reason: "one-hour native media ownership deadline expired")
        }
        Task { [self] in
            do {
                guard isCurrent(), !lock.withLock({ stopRequested }) else { throw Self.error("recording admission was cancelled") }
                try await updateAudio(audio == "system").value
                worker.async { [self] in
                    guard isCurrent(), !lock.withLock({ stopRequested }), let output else {
                        lock.withLock { admissionResolving = false }
                        resolveFailure("recording admission was cancelled"); return
                    }
                    lock.withLock { attached = true }
                    do {
                        try stream.addRecordingOutput(output)
                        lock.withLock { admissionResolving = false }
                        if lock.withLock({ stopRequested }) { removeOutput() }
                    } catch {
                        lock.withLock { attached = false; admissionResolving = false }
                        resolveFailure("native media attachment failed: \(error.localizedDescription)")
                    }
                }
            } catch {
                lock.withLock { admissionResolving = false }
                resolveFailure("native media admission failed: \(error.localizedDescription)")
            }
        }
    }
    private func nativeStarted(_ value: SCRecordingOutput) {
        let reply = lock.withLock { () -> (@Sendable ([String: Any]) -> Void)? in
            guard value === output, phase == .admitting, !stopRequested else { return nil }
            phase = .recording; let reply = startReply; startReply = nil; return reply
        }
        if reply == nil { end(reason: "late native recording admission was revoked"); return }
        reply?(snapshot())
        worker.async { [self] in
            let timer = DispatchSource.makeTimerSource(queue: worker)
            timer.schedule(deadline: .now(), repeating: .milliseconds(200))
            timer.setEventHandler { [weak self] in self?.observeLimits() }
            self.timer = timer; timer.resume()
        }
    }
    private func observeLimits() {
        guard let output, lock.withLock({ phase == .recording }) else { return }
        let count = output.recordedFileSize, recorded = output.recordedDuration
        // Before the first sample is written (a static target writes none for a while) the duration is
        // invalid or indefinite and its seconds are NaN (CoreMedia CMTime.seconds); that is "not yet", not malformed.
        guard recorded.isValid, !recorded.isIndefinite else { if count < 0 { end(reason: "native recording metrics are malformed") }; return }
        let seconds = recorded.seconds
        guard count >= 0, seconds.isFinite, seconds >= 0 else { end(reason: "native recording metrics are malformed"); return }
        if count > DESKTOP_STREAM_MEDIA_MAX_BYTES || seconds > Double(DESKTOP_STREAM_MEDIA_MAX_SECONDS) {
            end(reason: "native recording exceeded its 100MiB or one-hour bound"); return
        }
        lock.withLock { bytes = Int64(count); duration = seconds }
    }
    func stop(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let replied = AtomicFlag(), once: @Sendable ([String: Any]) -> Void = { response in if replied.set() { completion(response) } }
        let immediate = lock.withLock { () -> Bool in
            if phase == .finalized || phase == .failed { return true }
            if stopReplies.count >= 4 { return true }
            stopReplies.append(once); return false
        }
        if immediate { completion(resolved ? snapshot() : WireFormat.error("native recording already has four pending stop observers")); return }
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
            if replied.set() { completion(["success": false, "code": "timeout_unknown_outcome", "error": "media finalization exceeded ten seconds; no finalized artifact is acknowledged and its generation remains retained"]) }
        }
        end(reason: nil)
    }
    func end(reason: String?) {
        let admitted = lock.withLock { () -> Bool in
            guard phase != .finalized, phase != .failed else { return false }
            if let reason, failure == nil { failure = reason }
            stopRequested = true
            if phase == .admitting || phase == .recording { phase = .stopping }
            return true
        }
        guard admitted else { return }
        worker.async { [self] in removeOutput() }
    }
    func whenResolved(_ completion: @escaping @Sendable ([String: Any]) -> Void) {
        let immediate = lock.withLock { () -> Bool in
            if phase == .finalized || phase == .failed { return true }
            retirementReply = completion; return false
        }
        if immediate { completion(snapshot()) }
    }
    private func removeOutput() {
        let state = lock.withLock { (phase, attached, admissionResolving, nativeFailed) }
        guard state.0 != .finalized, state.0 != .failed, state.0 != .verifying else { return }
        if state.2 { return } // Admission will continue the same cleanup.
        guard state.1, let output else { resolveFailure(lock.withLock { failure } ?? "recording stopped before native admission"); return }
        do {
            try stream.removeRecordingOutput(output)
            lock.withLock { attached = false }
            if state.3 { resolveFailure(lock.withLock { failure } ?? "native recording failed") }
        } catch {
            // A throwing remove does not establish that native writing ended.
            lock.withLock { if failure == nil { failure = "native media detach failed: \(error.localizedDescription)" } }
        }
    }
    private func nativeFailure(_ error: Error) {
        lock.withLock { nativeFailed = true }
        end(reason: "native media failed: \(error.localizedDescription)")
    }
    private func nativeFinished(_ value: SCRecordingOutput) {
        let accepted = lock.withLock { () -> Bool in
            guard value === output, phase != .verifying, phase != .finalized, phase != .failed else { return false }
            attached = false; phase = .verifying; return true
        }
        guard accepted else { return }
        Task { [self] in
            do {
                try await updateAudio(false).value
                if let failure = lock.withLock({ failure }) { throw Self.error(failure) }
                let asset = AVURLAsset(url: URL(fileURLWithPath: directory + "/native.partial.mp4"))
                let tracks = try await asset.loadTracks(withMediaType: .video)
                guard tracks.count == 1, let track = tracks.first else { throw Self.error("finalized native movie does not contain one video track") }
                let size = try await track.load(.naturalSize), nativeDuration = try await asset.load(.duration)
                let seconds = nativeDuration.seconds
                guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0,
                      Double(size.width) * Double(size.height) <= Double(DESKTOP_CAPTURE_MAX_PIXELS), seconds.isFinite,
                      seconds > 0, seconds <= Double(DESKTOP_STREAM_MEDIA_MAX_SECONDS) else { throw Self.error("finalized movie has invalid native dimensions or duration") }
                let audioTracks = try await asset.loadTracks(withMediaType: .audio)
                guard audio == "system" ? !audioTracks.isEmpty : audioTracks.isEmpty else { throw Self.error("native movie audio tracks differ from the admitted policy") }
                let identity = try copyFinalizedMovie()
                try lock.withLock { if let failure { throw Self.error(failure) }; bytes = identity.0; hash = identity.1; duration = seconds; phase = .finalized }
                finishReplies()
            } catch { resolveFailure("media finalization failed: \(error.localizedDescription)") }
        }
    }
    private func copyFinalizedMovie() throws -> (Int64, String) {
        var directoryInfo = stat()
        guard fstat(directoryFD, &directoryInfo) == 0, directoryInfo.st_uid == geteuid(), directoryInfo.st_mode & 0o777 == 0o700 else { throw Self.error("recording archive ownership changed") }
        let input = openat(directoryFD, "native.partial.mp4", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard input >= 0 else { throw Self.error("finished native movie cannot be opened without following links") }
        defer { Darwin.close(input) }
        var before = stat()
        guard fstat(input, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_uid == geteuid(),
              before.st_nlink == 1, before.st_size > 0, before.st_size <= Int64(DESKTOP_STREAM_MEDIA_MAX_BYTES),
              fchmod(input, 0o600) == 0 else { throw Self.error("finished native movie is not an owned bounded regular file") }
        let output = try PhotosDomain.Output(path)
        var hash = SHA256(), total: Int64 = 0, buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = Darwin.read(input, &buffer, buffer.count)
            if n < 0 { if errno == EINTR { continue }; throw Self.error("native movie readback failed") }
            if n == 0 { break }
            total += Int64(n)
            guard total <= Int64(DESKTOP_STREAM_MEDIA_MAX_BYTES) else { throw Self.error("native movie grew beyond 100MiB") }
            let data = Data(buffer.prefix(n))
            guard output.append(data) else { throw Self.error("final movie write failed") }; hash.update(data: data)
        }
        var after = stat(), destination = stat()
        guard fstat(input, &after) == 0, total == before.st_size, after.st_size == before.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              try output.finish() == Int(total), fstatat(directoryFD, "recording.mp4", &destination, AT_SYMLINK_NOFOLLOW) == 0,
              destination.st_uid == geteuid(), destination.st_nlink == 1, destination.st_size == total,
              destination.st_mode & 0o777 == 0o600 else { throw Self.error("movie changed during finalized byte readback") }
        let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
        let receipt = try PhotosDomain.Output(directory + "/finalized.json")
        let metadata = try JSONSerialization.data(withJSONObject: ["sid": sid, "filePath": path, "source": source,
            "container": "mp4", "videoCodec": "h264", "audio": audio, "timing": "native-media",
            "finalized": true, "bytes": total, "sha256": digest])
        guard receipt.append(metadata), try receipt.finish() == metadata.count else { throw Self.error("stream receipt did not pass exclusive byte readback") }
        return (total, digest)
    }
    private func resolveFailure(_ text: String) {
        // Disable audio before releasing this generation. Native failures or
        // hanging updates retain admission instead of claiming termination.
        let admitted = lock.withLock { () -> Bool in
            guard phase != .finalized, phase != .failed, !failureResolving else { return false }
            failureResolving = true; if failure == nil { failure = text }; return true
        }
        guard admitted else { return }
        Task { [self] in
            do { try await updateAudio(false).value }
            catch { lock.withLock { failure = "\(text); native audio cleanup failed: \(error.localizedDescription)" }; return }
            lock.withLock { phase = .failed }; finishReplies()
        }
    }
    private func updateAudio(_ enabled: Bool) -> Task<Void, Error> {
        lock.withLock {
            let previous = configurationChange
            let next = Task { [self] in
                if let previous { _ = await previous.result }
                configuration.capturesAudio = enabled
                try await stream.updateConfiguration(configuration)
            }
            configurationChange = next; return next
        }
    }
    private func finishReplies() {
        let callbacks = lock.withLock { () -> [@Sendable ([String: Any]) -> Void] in
            let callbacks = (startReply.map { [$0] } ?? []) + stopReplies + (retirementReply.map { [$0] } ?? [])
            startReply = nil; stopReplies.removeAll(); retirementReply = nil; return callbacks
        }
        worker.async { [weak self] in self?.timer?.cancel(); self?.timer = nil }
        onResolved(); let result = snapshot(); for reply in callbacks { reply(result) }
    }
}
