import Foundation
import SoundAnalysis
import AVFoundation

final class SoundDomain: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private let lifecycle = DispatchSemaphore(value: 1)
    private var generation: UUID?
    private var retiring: UUID?
    private var startup: (@Sendable ([String: Any]) -> Void)?
    private var error: String?
    private var configurationObserver: NSObjectProtocol?
    private var isClassifying = false
    private var audioEngine: AVAudioEngine?
    private var analyzer: SNAudioStreamAnalyzer?
    private var recentClassifications: [[String: Any]] = []
    private var observer: SoundObserver?

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var canonical = action
        let sub = action["sub"] as? String ?? (command == "sounds" ? "status" : command)
        canonical["type"] = "desktop_sounds"; canonical["sub"] = sub
        if let error = DesktopSoundShape.validationError(canonical) { completion(WireFormat.error(error)); return }
        if action["filter"] != nil && sub != "log" { completion(WireFormat.error("sound filter requires log")); return }
        for key in ["filter", "group", "groupColor"] {
            if let value = action[key] as? String, value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || value.contains("\0") || value.utf8.count > (key == "filter" ? 4096 : 256) { completion(WireFormat.error("invalid bounded sound filter/group")); return }
        }
        switch sub {
        case "start": startClassification(completion: completion)
        case "stop": stopClassification(completion: completion)
        default:
            let snapshot = lock.withLock { (isClassifying, recentClassifications, error) }
            if sub == "status", let error = snapshot.2 { completion(WireFormat.error(error)); return }
            switch sub {
            case "status": completion(WireFormat.success(["classifying": snapshot.0, "latest": snapshot.1.last as Any? ?? NSNull()]))
            case "tail": completion(WireFormat.success(["classifying": snapshot.0, "classifications": snapshot.1]))
            default:
                let filter = action["filter"] as? String
                completion(WireFormat.success(snapshot.1.filter { row in filter == nil || (row["label"] as? String)?.contains(filter!) == true }))
            }
        }
    }

    private func startClassification(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let id = UUID(), finished = AtomicFlag()
        let reply: @Sendable ([String: Any]) -> Void = { response in if finished.set() { completion(response) } }
        lock.lock()
        guard generation == nil && retiring == nil else { lock.unlock(); completion(WireFormat.error("sound native capture or cleanup is already active")); return }
        generation = id; startup = reply; error = nil; recentClassifications = []
        lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
            if finished.set() {
                completion(["success": false, "code": "timeout_unknown_outcome", "error": "sound startup exceeded ten seconds; late admission is revoked and native cleanup may still be resolving"])
                self.retire(id, error: "sound startup exceeded its deadline")
            }
        }
        DispatchQueue.global().async {
            guard self.lifecycle.wait(timeout: .now()) == .success else { self.retire(id, error: "sound native lifecycle busy"); return }
            defer { self.lifecycle.signal() }
            guard self.lock.withLock({ self.generation == id }) else { return }
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { self.retire(id, error: "Microphone permission required. Run interceptor macos trust --microphone-prompt."); return }
            let engine = AVAudioEngine(), input = engine.inputNode, format = input.outputFormat(forBus: 0)
            guard format.sampleRate.isFinite, format.sampleRate > 0, format.sampleRate <= 1_000_000, format.channelCount > 0, format.channelCount <= 64 else { self.retire(id, error: "sound microphone has no bounded native PCM format"); return }
            let analyzer = SNAudioStreamAnalyzer(format: format)
            let obs = SoundObserver(handler: { [weak self] rows in
                guard let self else { return }
                self.lock.withLock {
                    guard self.error == nil, self.generation == id || self.retiring == id else { return }
                    self.recentClassifications.append(contentsOf: rows)
                    if self.recentClassifications.count > DESKTOP_SOUND_MAX_HISTORY { self.recentClassifications.removeFirst(self.recentClassifications.count - DESKTOP_SOUND_MAX_HISTORY) }
                }
            }, failure: { [weak self] error in self?.retire(id, error: error) }, completed: { [weak self] in
                guard let self, self.lock.withLock({ self.generation == id }) else { return }
                self.retire(id, error: "native sound request completed before capture was stopped")
            })
            do { try analyzer.add(SNClassifySoundRequest(classifierIdentifier: .version1), withObserver: obs) }
            catch { self.retire(id, error: "native sound classifier request failed: \(error.localizedDescription)"); return }
            input.installTap(onBus: 0, bufferSize: 8192, format: format) { [weak self] buffer, time in
                guard let self, self.lock.withLock({ self.generation == id }) else { return }
                guard AudioDomain.measurePCM(buffer) != nil else { self.retire(id, error: "sound microphone received invalid native PCM"); return }
                analyzer.analyze(buffer, atAudioFramePosition: time.sampleTime)
            }
            self.lock.lock()
            guard self.generation == id else { self.lock.unlock(); input.removeTap(onBus: 0); analyzer.removeAllRequests(); return }
            self.audioEngine = engine; self.analyzer = analyzer; self.observer = obs
            self.configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
                self?.retire(id, error: "sound microphone configuration changed; restart against the current device")
            }
            self.lock.unlock()
            do { engine.prepare(); try engine.start() }
            catch { self.retire(id, error: "native sound microphone start failed: \(error.localizedDescription)"); return }
            let current = self.lock.withLock { () -> Bool in
                guard self.generation == id else { return false }
                self.isClassifying = true; self.startup = nil; return true
            }
            if current { reply(WireFormat.success(["classifying": true])) }
        }
    }

    private func stopClassification(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let state = lock.withLock { (generation, retiring, recentClassifications.count, error) }
        guard let id = state.0 else {
            if state.1 != nil { completion(WireFormat.error("sound native cleanup is still resolving")) }
            else if let error = state.3 { completion(WireFormat.error(error)) }
            else { completion(WireFormat.success(["classifying": false, "totalClassifications": state.2])) }
            return
        }
        let finished = AtomicFlag()
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
            if finished.set() { completion(["success": false, "code": "timeout_unknown_outcome", "error": "sound stop exceeded ten seconds; callbacks are revoked and native admission stays occupied until cleanup resolves"]) }
        }
        retire(id, error: nil) { response in if finished.set() { completion(response) } }
    }

    private func retire(_ id: UUID, error: String?, completion: (@Sendable ([String: Any]) -> Void)? = nil) {
        lock.lock()
        guard generation == id else {
            if retiring == id, let error { self.error = error }
            lock.unlock(); completion?(WireFormat.error("sound generation already retired")); return
        }
        let resources = UncheckedSendableBox((engine: audioEngine, analyzer: analyzer, observer: observer, configuration: configurationObserver))
        let startup = self.startup
        generation = nil; retiring = id; isClassifying = false; self.error = error
        audioEngine = nil; analyzer = nil; observer = nil; configurationObserver = nil; self.startup = nil
        lock.unlock()
        startup?(WireFormat.error(error ?? "sound startup cancelled"))
        DispatchQueue.global().async {
            // ponytail: in-process SDK calls cannot be interrupted; retain admission until cleanup resolves.
            self.lifecycle.wait(); defer { self.lifecycle.signal() }
            if let configuration = resources.value.configuration { NotificationCenter.default.removeObserver(configuration) }
            resources.value.engine?.stop(); resources.value.engine?.inputNode.removeTap(onBus: 0)
            if error == nil, let analyzer = resources.value.analyzer, let observer = resources.value.observer {
                analyzer.completeAnalysis()
                if observer.finished.wait(timeout: .now() + 3) != .success { self.lock.withLock { self.error = "native sound analysis did not finalize before its deadline" } }
            }
            resources.value.analyzer?.removeAllRequests()
            let result = self.lock.withLock { () -> [String: Any] in
                if self.retiring == id { self.retiring = nil }
                if let error = self.error { return WireFormat.error(error) }
                return WireFormat.success(["classifying": false, "totalClassifications": self.recentClassifications.count])
            }
            completion?(result)
        }
    }
}

private final class SoundObserver: NSObject, SNResultsObserving, @unchecked Sendable {
    private let handler: @Sendable ([[String: Any]]) -> Void
    private let failure: @Sendable (String) -> Void
    private let completed: @Sendable () -> Void
    let finished = DispatchSemaphore(value: 0)
    init(handler: @escaping @Sendable ([[String: Any]]) -> Void, failure: @escaping @Sendable (String) -> Void, completed: @escaping @Sendable () -> Void) {
        self.handler = handler; self.failure = failure; self.completed = completed
    }
    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { failure("native sound classifier returned an unexpected result"); return }
        guard result.classifications.allSatisfy({ !$0.identifier.isEmpty && !$0.identifier.contains("\0") && $0.identifier.utf8.count <= 512 && $0.confidence.isFinite && (0...1).contains($0.confidence) }) else { failure("native sound classifier returned invalid labels/probabilities"); return }
        let timestamp = Date().timeIntervalSince1970
        let rows = result.classifications.filter { $0.confidence > 0.3 }.prefix(5).map { ["label": $0.identifier, "confidence": $0.confidence, "timestamp": timestamp] as [String: Any] }
        if !rows.isEmpty { handler(rows) }
    }
    func request(_ request: SNRequest, didFailWithError error: Error) { failure("native SoundAnalysis failed: \(error.localizedDescription)"); finished.signal() }
    func requestDidComplete(_ request: SNRequest) { finished.signal(); completed() }
}
