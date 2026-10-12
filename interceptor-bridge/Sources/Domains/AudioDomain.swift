import Foundation
@preconcurrency import ScreenCaptureKit
import AVFoundation
import AppKit
import CoreMedia
import CoreAudio
import AudioToolbox

final class AudioDomain: DomainHandler, @unchecked Sendable {
    private var outputStream: SCStream?
    private var outputHandler: AudioStreamOutput?
    private var inputEngine: AVAudioEngine?
    private var inputCapture: CapturedAudio?
    private let sessionsQueue = DispatchQueue(label: "interceptor.audio.sessions")
    // ponytail: serialize lifecycle changes for both channels; no queue of capture jobs.
    private let lifecycle = DispatchSemaphore(value: 1)
    nonisolated(unsafe) private static var sharedAudioBuffer: AVAudioPCMBuffer?
    nonisolated(unsafe) private static var sharedAudioOwner: UUID?
    private static let bufferLock = NSLock()

    static func getLatestBuffer() -> AVAudioPCMBuffer? {
        bufferLock.lock(); defer { bufferLock.unlock() }; return sharedAudioBuffer
    }
    static func setLatestBuffer(_ buffer: AVAudioPCMBuffer?, owner: UUID? = nil) {
        bufferLock.lock(); defer { bufferLock.unlock() }
        if buffer == nil, let owner, sharedAudioOwner != owner { return }
        sharedAudioBuffer = buffer; sharedAudioOwner = buffer == nil ? nil : owner
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let channel = action["sub"] as? String ?? command, op = action["op"] as? String ?? ""
        var canonical = action; canonical["type"] = "desktop_audio"
        if let error = DesktopAudioShape.validationError(canonical) {
            completion(WireFormat.error(error)); return
        }
        let fields: Set<String> = ["type", "sub", "op", "app", "device", "save", "group", "groupColor", "groupSoft"]
        guard ["input", "output", "both"].contains(channel), ["start", "stop", "level", "devices"].contains(op),
              action.keys.allSatisfy(fields.contains),
              ["app", "device", "group", "groupColor"].allSatisfy({ key in
                  guard let value = action[key] else { return true }
                  let target = key == "app" || key == "device"
                  return value is String && !(value as! String).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (value as! String).utf8.count <= (target ? 4096 : 256) && !(value as! String).contains("\0") && (!target || op == "start")
              }), channel != "input" || action["app"] == nil,
              action["save"] == nil || action["save"] is Bool,
              action["save"] as? Bool != true || op == "start" else {
            completion(WireFormat.error("audio requires a valid channel/operation and only supported fields")); return
        }
        if op == "start" || op == "stop" {
            guard lifecycle.wait(timeout: .now()) == .success else {
                completion(WireFormat.error("audio lifecycle busy; no work was queued")); return
            }
        }
        let needsRelease = op == "start" || op == "stop", finished = AtomicFlag(), resolved = AtomicFlag(), released = AtomicFlag()
        let release: @Sendable () -> Void = {
            if needsRelease, released.set() { self.lifecycle.signal() }
        }
        let reply: @Sendable ([String: Any]) -> Void = { response in
            guard resolved.set() else { return }
            if finished.set() { release(); completion(response); return }
            if needsRelease, op == "start", response["success"] as? Bool == true {
                // A deadline is not evidence that native capture failed. Keep
                // admission closed until a late successful start is stopped.
                let cleanup: @Sendable ([String: Any]) -> Void = { result in
                    if result["success"] as? Bool != true { NSLog("Timed-out audio start cleanup failed: %@", String(describing: result)) }
                    release()
                }
                let stop: [String: Any] = ["op": "stop"]
                switch channel {
                case "input": self.handleInput(stop, completion: cleanup)
                case "output": self.handleOutput(stop, completion: cleanup)
                default: self.handleBoth(stop, completion: cleanup)
                }
            } else { release() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
            if finished.set() {
                // A native API that ignores cancellation retains its lifecycle
                // gate until it actually resolves; another start is not queued.
                completion(["success": false, "code": "partial_result", "error": "audio native operation exceeded ten seconds; the outcome is unknown, observe the channels before retrying"])
            }
        }
        switch channel {
        case "output": handleOutput(action, completion: reply)
        case "input": handleInput(action, completion: reply)
        default: handleBoth(action, completion: reply)
        }
    }

    private func level(_ channel: String) -> [String: Any] {
        sessionsQueue.sync {
            let capture = channel == "input" ? inputCapture : outputHandler?.capture
            return capture?.snapshot() ?? ["active": false, "level": NSNull(), "peak": NSNull(), "frames": 0]
        }
    }
    private func handleOutput(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch action["op"] as? String {
        case "start": startOutputCapture(action, completion: completion)
        case "stop": stopOutputCapture(completion: completion)
        case "level": completion(WireFormat.success(level("output")))
        default: listOutputDevices(completion: completion)
        }
    }
    private func handleInput(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch action["op"] as? String {
        case "start": startInputCapture(action, completion: completion)
        case "stop": stopInputCapture(completion: completion)
        case "level": completion(WireFormat.success(level("input")))
        default: listInputDevices(completion: completion)
        }
    }
    private func handleBoth(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch action["op"] as? String {
        case "start":
            guard sessionsQueue.sync(execute: { inputEngine == nil && outputStream == nil }) else {
                completion(WireFormat.error("both requires both capture channels to be stopped")); return
            }
            var outputAction: [String: Any] = ["op": "start", "save": action["save"] as? Bool ?? false]
            if let app = action["app"] { outputAction["app"] = app }
            let inputAction = UncheckedSendableBox(action)
            startOutputCapture(outputAction) { result in
                guard result["success"] as? Bool == true else { completion(result); return }
                let outputResult = UncheckedSendableBox(result)
                self.startInputCapture(inputAction.value) { inputResult in
                    if inputResult["success"] as? Bool == true {
                        var payload: [String: Any] = ["output": "started", "input": "started"]
                        if let path = (outputResult.value["data"] as? [String: Any])?["filePath"] { payload["outputFilePath"] = path }
                        if let path = (inputResult["data"] as? [String: Any])?["filePath"] { payload["inputFilePath"] = path }
                        completion(WireFormat.success(payload)); return
                    }
                    let failedInput = UncheckedSendableBox(inputResult)
                    self.stopOutputCapture { stopped in
                        completion(["success": false, "error": "input start failed; output rollback was requested",
                                    "details": ["input": failedInput.value, "outputRollback": stopped]])
                    }
                }
            }
        case "stop":
            stopOutputCapture { output in
                let result = UncheckedSendableBox(output)
                self.stopInputCapture { input in
                    if result.value["success"] as? Bool == true && input["success"] as? Bool == true {
                        completion(WireFormat.success("stopped both"))
                    } else {
                        completion(["success": false, "error": "one or more capture channels did not stop cleanly",
                                    "details": ["output": result.value, "input": input]])
                    }
                }
            }
        case "level": completion(WireFormat.success(["input": level("input"), "output": level("output")]))
        default:
            do { completion(WireFormat.success(["input": try Self.enumerateAudioDevices(role: "input"),
                                                "output": try Self.enumerateAudioDevices(role: "output")])) }
            catch { completion(WireFormat.error("audio devices: \(error.localizedDescription)")) }
        }
    }

    private func startOutputCapture(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard action["device"] == nil else { completion(WireFormat.error("output capture is app/system scoped; per-output-device capture is unavailable")); return }
        guard sessionsQueue.sync(execute: { outputStream == nil }) else { completion(WireFormat.error("output capture already active")); return }
        let appName = action["app"] as? String, save = action["save"] as? Bool ?? false
        Task {
            do {
                let content = try await SCShareableContent.current
                let filter: SCContentFilter
                if let appName {
                    let apps = content.applications.filter { $0.applicationName == appName || $0.bundleIdentifier == appName }
                    guard apps.count == 1, let app = apps.first,
                          let window = content.windows.first(where: { $0.owningApplication?.processID == app.processID }) else {
                        completion(WireFormat.error("requested app has no unique capturable window; system audio was not captured")); return
                    }
                    filter = SCContentFilter(desktopIndependentWindow: window)
                } else if let display = content.displays.first {
                    filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                } else { completion(WireFormat.error("no capturable content")); return }
                let config = SCStreamConfiguration()
                config.capturesAudio = true; config.excludesCurrentProcessAudio = true
                config.sampleRate = 48_000; config.channelCount = 2
                let capture = try CapturedAudio(save: save, channel: "output")
                let handler = AudioStreamOutput(capture: capture)
                let stream = SCStream(filter: filter, configuration: config, delegate: handler)
                try stream.addStreamOutput(handler, type: .audio, sampleHandlerQueue: DispatchQueue(label: "interceptor.audio.output"))
                do { try await stream.startCapture() }
                catch { capture.stop(); throw error }
                self.sessionsQueue.sync { self.outputStream = stream; self.outputHandler = handler }
                if let path = capture.filePath { completion(WireFormat.success(["message": "audio output capture started", "filePath": path])) }
                else { completion(WireFormat.success("audio output capture started")) }
            } catch { completion(WireFormat.error("output capture failed: \(error.localizedDescription)")) }
        }
    }

    private func stopOutputCapture(completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let stream = sessionsQueue.sync(execute: { outputStream }) else {
            completion(WireFormat.success("no active output capture")); return
        }
        let capture = sessionsQueue.sync { outputHandler?.capture }
        Task {
            do {
                if capture?.nativeStopped != true { try await stream.stopCapture() }
                capture?.stop()
                self.sessionsQueue.sync { self.outputStream = nil; self.outputHandler = nil }
                let result = capture?.snapshot() ?? [:]
                if let error = result["error"] as? String {
                    completion(["success": false, "error": error, "details": result])
                } else {
                    var payload: [String: Any] = ["message": "audio output capture stopped"]
                    if let path = capture?.filePath { payload["filePath"] = path }
                    completion(WireFormat.success(payload))
                }
            } catch { completion(WireFormat.error("output stop failed; capture retained for retry: \(error.localizedDescription)")) }
        }
    }

    private func startInputCapture(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard sessionsQueue.sync(execute: { inputEngine == nil }) else { completion(WireFormat.error("input capture already active")); return }
        let engine = AVAudioEngine(), inputNode = engine.inputNode
        do {
            if let requested = action["device"] as? String {
                try Self.selectInputDevice(inputNode, requested: requested)
            }
            let format = inputNode.outputFormat(forBus: 0)
            guard format.sampleRate.isFinite, format.sampleRate > 0, format.sampleRate <= 1_000_000, format.channelCount > 0, format.channelCount <= 64 else {
                throw NSError(domain: "audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "input has no usable PCM format"])
            }
            let capture = try CapturedAudio(save: action["save"] as? Bool ?? false, channel: "input")
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in _ = capture.append(buffer) }
            do { try engine.start() }
            catch { inputNode.removeTap(onBus: 0); capture.stop(); throw error }
            sessionsQueue.sync { inputEngine = engine; inputCapture = capture }
            var payload: [String: Any] = ["message": "audio input capture started (\(Int(format.sampleRate))Hz)",
                                         "sampleRate": Int(format.sampleRate), "channels": Int(format.channelCount)]
            if let path = capture.filePath { payload["filePath"] = path }
            completion(WireFormat.success(payload))
        } catch { completion(WireFormat.error("input capture failed: \(error.localizedDescription)")) }
    }

    private func stopInputCapture(completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let engine = sessionsQueue.sync(execute: { inputEngine }) else {
            completion(WireFormat.success("no active input capture")); return
        }
        engine.stop(); engine.inputNode.removeTap(onBus: 0)
        let capture = sessionsQueue.sync { inputCapture }
        capture?.stop()
        sessionsQueue.sync { inputEngine = nil; inputCapture = nil }
        let result = capture?.snapshot() ?? [:]
        if let error = result["error"] as? String { completion(["success": false, "error": error, "details": result]); return }
        var payload: [String: Any] = ["message": "audio input capture stopped"]
        if let path = capture?.filePath { payload["filePath"] = path }
        completion(WireFormat.success(payload))
    }

    static func selectInputDevice(_ inputNode: AVAudioInputNode, requested: String) throws {
        let matches = try enumerateAudioDevices(role: "input").filter {
            $0["uniqueID"] as? String == requested || String($0["deviceID"] as? UInt32 ?? 0) == requested
        }
        guard matches.count == 1, var device = matches[0]["deviceID"] as? UInt32, let unit = inputNode.audioUnit else {
            throw NSError(domain: "audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "input device is not a unique current CoreAudio device"])
        }
        let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<UInt32>.size))
        guard status == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        var actual: UInt32 = 0, actualSize = UInt32(MemoryLayout<UInt32>.size)
        guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &actual, &actualSize) == noErr,
              actual == device else { throw NSError(domain: "audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "input device selection was not confirmed"]) }
    }

    private func listOutputDevices(completion: @escaping @Sendable ([String: Any]) -> Void) {
        do { completion(WireFormat.success(try Self.enumerateAudioDevices(role: "output"))) }
        catch { completion(WireFormat.error("audio output devices: \(error.localizedDescription)")) }
    }
    private func listInputDevices(completion: @escaping @Sendable ([String: Any]) -> Void) {
        do {
            let devices = try Self.enumerateAudioDevices(role: "input")
            let device = devices.first { $0["isDefault"] as? Bool == true }
            completion(WireFormat.success(["defaultInput": device.map { ["sampleRate": $0["sampleRate"] ?? NSNull(), "channels": $0["channels"] ?? NSNull()] } as Any? ?? NSNull(),
                                           "devices": devices, "count": devices.count]))
        } catch { completion(WireFormat.error("audio input devices: \(error.localizedDescription)")) }
    }

    static func enumerateAudioDevices(role: String) throws -> [[String: Any]] {
        guard role == "input" || role == "output" else { throw NSError(domain: "audio", code: 1) }
        let system = AudioObjectID(kAudioObjectSystemObject), scope = role == "input" ? kAudioObjectPropertyScopeInput : kAudioObjectPropertyScopeOutput
        var property = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &property, 0, nil, &size) == noErr, size % 4 == 0, size <= 512 * 4 else {
            throw NSError(domain: "audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "CoreAudio device inventory unavailable or oversized"])
        }
        if size == 0 { return [] }
        let inventoryCapacity = size
        var devices = [AudioObjectID](repeating: 0, count: Int(size) / 4)
        let status = devices.withUnsafeMutableBytes { AudioObjectGetPropertyData(system, &property, 0, nil, &size, $0.baseAddress!) }
        guard status == noErr, size <= inventoryCapacity, size % 4 == 0 else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        property.mSelector = role == "input" ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice
        var defaultDevice: AudioObjectID = 0, defaultSize = UInt32(MemoryLayout<AudioObjectID>.size)
        _ = AudioObjectGetPropertyData(system, &property, 0, nil, &defaultSize, &defaultDevice)
        func string(_ device: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
            var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var value: CFString?, bytes = UInt32(MemoryLayout<CFString?>.size)
            guard AudioObjectGetPropertyData(device, &address, 0, nil, &bytes, &value) == noErr else { return nil }
            return value.map { $0 as String }
        }
        var rows: [[String: Any]] = []
        for device in devices.prefix(Int(size) / 4) {
            var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: scope, mElement: kAudioObjectPropertyElementMain)
            var bytes: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &bytes) == noErr, bytes >= MemoryLayout<AudioBufferList>.size, bytes <= 65_536 else { continue }
            let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(bytes), alignment: MemoryLayout<AudioBufferList>.alignment)
            defer { raw.deallocate() }
            let capacity = bytes
            guard AudioObjectGetPropertyData(device, &address, 0, nil, &bytes, raw) == noErr, bytes <= capacity else { continue }
            let list = raw.assumingMemoryBound(to: AudioBufferList.self)
            guard list.pointee.mNumberBuffers <= 64,
                  Int(list.pointee.mNumberBuffers) * MemoryLayout<AudioBuffer>.size + MemoryLayout<AudioBufferList>.offset(of: \.mBuffers)! <= Int(bytes) else { continue }
            let channels = UnsafeMutableAudioBufferListPointer(list).reduce(UInt64(0)) { $0 + UInt64($1.mNumberChannels) }
            guard channels > 0, let uid = string(device, kAudioDevicePropertyDeviceUID), let name = string(device, kAudioObjectPropertyName) else { continue }
            address.mSelector = kAudioDevicePropertyNominalSampleRate; address.mScope = kAudioObjectPropertyScopeGlobal
            var rate: Float64 = 0, rateSize = UInt32(MemoryLayout<Float64>.size)
            let haveRate = AudioObjectGetPropertyData(device, &address, 0, nil, &rateSize, &rate) == noErr && rate.isFinite && rate > 0
            address.mSelector = kAudioDevicePropertyDeviceIsAlive
            var alive: UInt32 = 0, aliveSize = UInt32(MemoryLayout<UInt32>.size)
            let haveAlive = AudioObjectGetPropertyData(device, &address, 0, nil, &aliveSize, &alive) == noErr
            rows.append(["uniqueID": uid, "deviceID": device, "localizedName": name,
                         "manufacturer": string(device, kAudioObjectPropertyManufacturer) as Any? ?? NSNull(),
                         "modelID": string(device, kAudioDevicePropertyModelUID) as Any? ?? NSNull(),
                         "deviceType": "CoreAudio", "isConnected": haveAlive ? (alive != 0) as Any : NSNull(), "role": role, "channels": channels,
                         "sampleRate": haveRate ? rate as Any : NSNull(), "isDefault": device == defaultDevice])
        }
        return rows
    }

    static func measurePCM(_ buffer: AVAudioPCMBuffer) -> [String: Any]? {
        let frames = Int(buffer.frameLength), channels = Int(buffer.format.channelCount), stride = buffer.stride
        guard frames > 0, frames <= 262_144, channels > 0, channels <= 64, frames * channels <= 1_048_576 else { return nil }
        var sum = 0.0, peak = 0.0
        for channel in 0..<channels { for frame in 0..<frames {
            let sample: Double
            if let data = buffer.floatChannelData { sample = Double(data[channel][frame * stride]) }
            else if let data = buffer.int16ChannelData { sample = Double(data[channel][frame * stride]) / 32768 }
            else if let data = buffer.int32ChannelData { sample = Double(data[channel][frame * stride]) / 2147483648 }
            else { return nil }
            guard sample.isFinite else { return nil }
            sum += sample * sample; peak = max(peak, abs(sample))
        }}
        let level = sqrt(sum / Double(frames * channels))
        guard level.isFinite else { return nil }
        return ["level": level, "peak": peak, "frames": frames, "channels": channels, "sampleRate": buffer.format.sampleRate]
    }
}

// The same single-writer state owns input and output PCM. Stop closes the file
// under the sample lock, so a queued callback cannot append after its acknowledgement.
final class CapturedAudio: @unchecked Sendable {
    private let lock = NSLock()
    private let owner = UUID()
    private let output: Bool
    private var active = true
    private var writer: AVAudioFile?
    private var savedFrames: Int64 = 0
    private var metrics: [String: Any] = ["level": NSNull(), "peak": NSNull(), "frames": 0]
    private var error: String?
    private var didStopNatively = false
    var nativeStopped: Bool { lock.lock(); defer { lock.unlock() }; return didStopNatively }
    let filePath: String?
    init(save: Bool, channel: String) throws {
        output = channel == "output"
        if save {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("interceptor-audio-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            filePath = directory.appendingPathComponent("\(channel).caf").path
        } else { filePath = nil }
    }
    @discardableResult func append(_ buffer: AVAudioPCMBuffer, publish: Bool = false) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard active else { return false }
        guard let measured = AudioDomain.measurePCM(buffer) else { error = "audio PCM format, sample values or frame count are invalid"; return false }
        metrics = measured; metrics["timestamp"] = Date().timeIntervalSince1970
        if publish { AudioDomain.setLatestBuffer(buffer, owner: owner) }
        if let filePath, error == nil {
            do {
                if writer == nil {
                    writer = try AVAudioFile(forWriting: URL(fileURLWithPath: filePath), settings: buffer.format.settings,
                                             commonFormat: buffer.format.commonFormat, interleaved: buffer.format.isInterleaved)
                    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: filePath)
                }
                let bytesPerFrame = UInt64(buffer.format.streamDescription.pointee.mBytesPerFrame) * UInt64(buffer.format.isInterleaved ? 1 : buffer.format.channelCount)
                guard bytesPerFrame > 0, UInt64(writer!.length + Int64(buffer.frameLength)) <= 536_870_912 / bytesPerFrame else {
                    error = "saved audio reached its 512 MiB limit"; return true
                }
                try writer!.write(from: buffer)
                savedFrames += Int64(buffer.frameLength)
            } catch { self.error = "saved audio write failed: \(error.localizedDescription)" }
        }
        return true
    }
    func stop() {
        lock.lock(); active = false
        if filePath != nil, savedFrames == 0, error == nil { error = "saved audio ended with no PCM frames; no audio file was produced" }
        writer = nil
        if output { AudioDomain.setLatestBuffer(nil, owner: owner) }
        lock.unlock()
    }
    func nativeFailure(_ failure: Error) {
        lock.lock(); error = "native audio capture stopped: \(failure.localizedDescription)"; didStopNatively = true; active = false; writer = nil; lock.unlock()
        AudioDomain.setLatestBuffer(nil, owner: owner)
    }
    func snapshot() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var result = metrics; result["active"] = active
        if let filePath { result["filePath"] = filePath }
        if let error { result["error"] = error }
        return result
    }
}

@available(macOS 13.0, *)
final class AudioStreamOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let capture: CapturedAudio
    init(capture: CapturedAudio) { self.capture = capture; super.init() }
    static func pcmBuffer(_ sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard CMSampleBufferDataIsReady(sampleBuffer), let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              let format = AVAudioFormat(streamDescription: asbd) else { return nil }
        let count = CMSampleBufferGetNumSamples(sampleBuffer)
        guard count > 0, count <= 262_144, format.channelCount > 0, format.channelCount <= 64,
              count * Int(format.channelCount) <= 1_048_576,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else { return nil }
        buffer.frameLength = AVAudioFrameCount(count)
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(count), into: buffer.mutableAudioBufferList) == noErr else { return nil }
        return buffer
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, let buffer = Self.pcmBuffer(sampleBuffer) else { return }
        capture.append(buffer, publish: true)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { capture.nativeFailure(error) }
}
