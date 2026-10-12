import Foundation
import Speech
import AVFoundation

final class SpeechDomain: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var isListening = false
    private var transcript = ""
    private var audioEngine: AVAudioEngine?
    private var analyzer: Any? // SpeechAnalyzer on macOS 26+
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var customVocabulary: [String] = []
    private var speechGeneration: UUID?
    private var speechRetiring: UUID?
    private var speechStartup: (@Sendable ([String: Any]) -> Void)?
    private var speechError: String?
    private var speechObserver: NSObjectProtocol?
    private let speechLifecycle = DispatchSemaphore(value: 1)
    private var vadEngine: AVAudioEngine?
    private var vadActive = false
    private var vadSpeaking = false
    private var vadLevel: Double = 0
    private let vadLifecycle = DispatchSemaphore(value: 1)
    private var vadGeneration: UUID?
    private var vadError: String?
    private var vadObserver: NSObjectProtocol?

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if command == "vad" || action["sub"] as? String == "vad" || ["macos_vad", "desktop_vad"].contains(action["type"] as? String ?? "") {
            handleVAD(action, completion: completion)
            return
        }
        var canonical = action
        canonical["type"] = "desktop_listen"
        let sub = action["sub"] as? String ?? (command == "listen" ? "status" : command)
        canonical["sub"] = sub
        if let error = DesktopSpeechShape.validationError(canonical) { completion(WireFormat.error(error)); return }
        if canonical["device"] != nil, sub != "start" { completion(WireFormat.error("speech device requires start")); return }
        if sub != "vocab", canonical["op"] != nil || canonical["word"] != nil { completion(WireFormat.error("vocabulary fields require vocab")); return }
        for key in ["device", "word", "group", "groupColor"] {
            if let text = canonical[key] as? String, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.contains("\0") || text.utf8.count > (["device", "word"].contains(key) ? 4096 : 256) {
                completion(WireFormat.error("speech target, vocabulary or group text is invalid")); return
            }
        }
        if sub == "vocab", ((canonical["op"] as? String ?? "list") == "add" ? canonical["word"] == nil : canonical["word"] != nil) {
            completion(WireFormat.error("vocab add requires one word; clear/list accept none")); return
        }
        switch sub {
        case "start":
            startListening(action, completion: completion)
        case "stop":
            stopListening(completion: completion)
        case "status":
            lock.lock()
            let listening = isListening
            let error = speechError
            lock.unlock()
            if let error { completion(WireFormat.failure(error.contains("configuration changed") ? "target_gone" : "provider_failed", error)); return }
            completion(WireFormat.success(["listening": listening]))
        case "transcript":
            lock.lock()
            let t = transcript
            lock.unlock()
            completion(WireFormat.success(t))
        case "tail":
            lock.lock()
            let t = transcript
            let listening = isListening
            lock.unlock()
            // Drop the always-true `streaming` field. The
            // operational state lives in `listening`; a hard-coded `true`
            // alongside it is contradictory when listening==false.
            completion(WireFormat.success(["transcript": t, "listening": listening]))
        case "vocab":
            handleVocab(action, completion: completion)
        case "vad":
            handleVAD(action, completion: completion)
        default:
            notImplemented(sub, completion: completion)
        }
    }

    private func startListening(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        if speechGeneration != nil || speechRetiring != nil {
            lock.unlock()
            completion(WireFormat.error("already listening"))
            return
        }
        let generation = UUID(), finished = AtomicFlag()
        let reply: @Sendable ([String: Any]) -> Void = { response in if finished.set() { completion(response) } }
        speechGeneration = generation; speechStartup = reply; speechError = nil; transcript = ""
        let vocabulary = customVocabulary
        lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
            if finished.set() {
                completion(["success": false, "code": "timeout_unknown_outcome", "error": "speech initialization exceeded ten seconds; late admission is revoked and native cleanup may still be resolving"])
                self.retireListening(generation: generation, error: "speech initialization exceeded its deadline")
            }
        }
        let requestAction = UncheckedSendableBox(action)
        SFSpeechRecognizer.requestAuthorization { status in
            let authorized = status == .authorized, authorizationStatus = status.rawValue
            DispatchQueue.global().async { [self] in
            lock.lock(); let current = speechGeneration == generation; lock.unlock()
            guard current else { reply(WireFormat.error("speech startup cancelled")); return }
            guard authorized else {
                retireListening(generation: generation, error: "Speech recognition not authorized. Status: \(authorizationStatus)")
                return
            }

            guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
                retireListening(generation: generation, error: "Speech recognizer not available")
                return
            }

            guard speechLifecycle.wait(timeout: .now()) == .success else { retireListening(generation: generation, error: "speech native lifecycle busy"); return }
            defer { speechLifecycle.signal() }
            lock.lock(); let admitted = speechGeneration == generation; lock.unlock()
            guard admitted else { reply(WireFormat.error("speech startup cancelled")); return }
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.addsPunctuation = true
            request.contextualStrings = vocabulary

            let engine = AVAudioEngine()
            let inputNode = engine.inputNode
            do { if let device = requestAction.value["device"] as? String { try AudioDomain.selectInputDevice(inputNode, requested: device) } }
            catch { retireListening(generation: generation, error: "speech device selection failed: \(error.localizedDescription)"); return }
            let recordingFormat = inputNode.outputFormat(forBus: 0)
            guard recordingFormat.sampleRate.isFinite, recordingFormat.sampleRate > 0, recordingFormat.sampleRate <= 1_000_000, recordingFormat.channelCount > 0, recordingFormat.channelCount <= 64 else { retireListening(generation: generation, error: "speech microphone has no bounded PCM format"); return }
            let tap: AVAudioNodeTapBlock = { [weak self] buffer, _ in
                guard let self else { return }
                self.lock.lock(); let current = self.speechGeneration == generation; self.lock.unlock()
                guard current else { return }
                guard AudioDomain.measurePCM(buffer) != nil else { self.retireListening(generation: generation, error: "speech received invalid native PCM"); return }
                request.append(buffer)
            }
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat, block: tap)
            lock.lock()
            guard speechGeneration == generation else { lock.unlock(); inputNode.removeTap(onBus: 0); return }
            // Publish only after the tap exists, so retirement always owns it.
            audioEngine = engine; recognitionRequest = request
            lock.unlock()
            // Another app opening the device's paired output also posts a configuration change, and the
            // engine stops. While the pinned device and its format stay the same, restart in place on it
            // (listen retired whenever `say` used the paired virtual speaker).
            let restarts = UncheckedSendableBox(NSMutableArray())
            let observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
                guard let self else { return }
                let changed = "speech microphone configuration changed; restart against the current device"
                guard self.speechLifecycle.wait(timeout: .now() + 2) == .success else { self.retireListening(generation: generation, error: changed); return }
                defer { self.speechLifecycle.signal() }
                self.lock.lock(); let current = self.speechGeneration == generation && self.audioEngine === engine; self.lock.unlock()
                guard current else { return }
                restarts.value.add(Date()); guard restarts.value.count <= 20 else { self.retireListening(generation: generation, error: changed); return }
                inputNode.removeTap(onBus: 0)
                do { if let device = requestAction.value["device"] as? String { try AudioDomain.selectInputDevice(inputNode, requested: device) } }
                catch { self.retireListening(generation: generation, error: changed); return }
                let format = inputNode.outputFormat(forBus: 0)
                guard format.sampleRate == recordingFormat.sampleRate, format.channelCount == recordingFormat.channelCount, format.commonFormat == recordingFormat.commonFormat else { self.retireListening(generation: generation, error: changed); return }
                inputNode.installTap(onBus: 0, bufferSize: 1024, format: format, block: tap)
                do { engine.prepare(); try engine.start(); Platform.log("speech engine restarted after a configuration change on the same input (\(restarts.value.count))") } catch { self.retireListening(generation: generation, error: changed) }
            }
            lock.lock(); let observing = speechGeneration == generation; if observing { speechObserver = observer }; lock.unlock()
            if !observing { NotificationCenter.default.removeObserver(observer); return }

            let task = recognizer.recognitionTask(with: request) { [self] result, error in
                if let result = result {
                    self.lock.lock()
                    guard self.speechGeneration == generation else { self.lock.unlock(); return }
                    let text = result.bestTranscription.formattedString
                    guard text.utf8.count <= DESKTOP_SPEECH_MAX_TRANSCRIPT_BYTES, !text.contains("\0") else { self.lock.unlock(); self.retireListening(generation: generation, error: "speech transcript exceeds its bound"); return }
                    self.transcript = text
                    self.lock.unlock()
                }
                if error != nil || (result?.isFinal ?? false) {
                    self.retireListening(generation: generation, error: error.map { "native speech recognition failed: \($0.localizedDescription)" })
                }
            }
            lock.lock(); let taskCurrent = speechGeneration == generation; if taskCurrent { recognitionTask = task }; lock.unlock()
            guard taskCurrent else { task.cancel(); return }

            do {
                engine.prepare()
                try engine.start()
            } catch {
                retireListening(generation: generation, error: "audio engine failed: \(error.localizedDescription)")
                return
            }

            self.lock.lock()
            guard self.speechGeneration == generation else { self.lock.unlock(); return }
            self.isListening = true
            self.speechStartup = nil
            self.lock.unlock()

            reply(WireFormat.success(["listening": true]))
            }
        }
    }

    private func stopListening(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        let generation = speechGeneration, retiring = speechRetiring
        let t = transcript
        lock.unlock()
        guard let generation else {
            if retiring != nil { completion(WireFormat.error("speech native cleanup is still resolving")) }
            else { lock.lock(); speechError = nil; lock.unlock(); completion(WireFormat.success(["listening": false, "transcript": t])) }
            return
        }
        let finished = AtomicFlag()
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
            if finished.set() { completion(["success": false, "code": "timeout_unknown_outcome", "error": "speech native stop exceeded ten seconds; callbacks are revoked and new starts remain blocked until cleanup resolves"]) }
        }
        retireListening(generation: generation, error: nil) { response in if finished.set() { completion(response) } }
    }

    private func retireListening(generation: UUID, error: String?, completion: (@Sendable ([String: Any]) -> Void)? = nil) {
        lock.lock()
        guard speechGeneration == generation else { lock.unlock(); completion?(WireFormat.error("speech generation already retired")); return }
        let resources = UncheckedSendableBox((engine: audioEngine, task: recognitionTask, request: recognitionRequest, observer: speechObserver))
        let startup = speechStartup, text = transcript
        speechGeneration = nil; speechRetiring = generation; isListening = false; speechError = error
        audioEngine = nil; recognitionTask = nil; recognitionRequest = nil; speechObserver = nil; speechStartup = nil
        lock.unlock()
        startup?(WireFormat.error(error ?? "speech startup cancelled"))
        DispatchQueue.global().async {
            self.speechLifecycle.wait()
            defer { self.speechLifecycle.signal() }
            if let observer = resources.value.observer { NotificationCenter.default.removeObserver(observer) }
            resources.value.engine?.stop(); resources.value.engine?.inputNode.removeTap(onBus: 0)
            resources.value.request?.endAudio(); resources.value.task?.cancel()
            self.lock.lock(); if self.speechRetiring == generation { self.speechRetiring = nil }; self.lock.unlock()
            completion?(WireFormat.success(["listening": false, "transcript": text]))
        }
    }

    private func handleVocab(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let op = action["op"] as? String ?? "list"
        switch op {
        case "add":
            guard let word = action["word"] as? String else {
                completion(WireFormat.error("vocab add requires a word"))
                return
            }
            lock.lock()
            guard customVocabulary.count < DESKTOP_SPEECH_MAX_VOCABULARY_WORDS, customVocabulary.reduce(0, { $0 + $1.utf8.count }) + word.utf8.count <= 32768 else { lock.unlock(); completion(WireFormat.error("speech vocabulary exceeds 100 entries or 32 KiB")); return }
            customVocabulary.append(word)
            let total = customVocabulary.count
            lock.unlock()
            completion(WireFormat.success(["added": word, "total": total]))
        case "clear":
            lock.lock()
            customVocabulary.removeAll()
            lock.unlock()
            completion(WireFormat.success("vocabulary cleared"))
        case "list":
            lock.lock()
            let words = customVocabulary
            lock.unlock()
            completion(WireFormat.success(words))
        default:
            notImplemented("vocab \(op)", completion: completion)
        }
    }

    private func handleVAD(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var canonical = action
        canonical["type"] = "desktop_vad"
        if action["sub"] as? String == "vad" { canonical["sub"] = action["op"] ?? "status"; canonical.removeValue(forKey: "op") }
        if canonical["sub"] == nil { canonical["sub"] = "status" }
        if let error = DesktopVadShape.validationError(canonical) { completion(WireFormat.error(error)); return }
        let op = canonical["sub"] as? String ?? "status"
        if let threshold = canonical["threshold"] as? Double, op != "start" || !threshold.isFinite || threshold < 0 || threshold > 1 {
            completion(WireFormat.error("VAD threshold requires start and a finite value 0..1")); return
        }
        for key in ["group", "groupColor"] { if let value = canonical[key] as? String, value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || value.utf8.count > 256 || value.contains("\0") {
            completion(WireFormat.error("invalid VAD group text")); return
        }}
        if op == "status" {
            lock.lock()
            let active = vadActive
            let speaking = vadSpeaking
            let level = vadLevel
            let error = vadError
            lock.unlock()
            if let error { completion(WireFormat.error(error)); return }
            completion(WireFormat.success(["active": active, "speaking": speaking, "level": level]))
            return
        }
        guard vadLifecycle.wait(timeout: .now()) == .success else { completion(WireFormat.error("VAD lifecycle busy; no work queued")); return }
        let finished = AtomicFlag(), resolved = AtomicFlag()
        let reply: @Sendable ([String: Any]) -> Void = { response in
            guard resolved.set() else { return }
            if finished.set() { self.vadLifecycle.signal(); completion(response); return }
            // Preserve admission until the native operation really resolves.
            // A late successful start must be stopped before another start.
            if op == "start", response["success"] as? Bool == true {
                self.stopVAD { _ in self.vadLifecycle.signal() }
            } else { self.vadLifecycle.signal() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
            if finished.set() { completion(["success": false, "code": "timeout_unknown_outcome", "error": "VAD native operation exceeded ten seconds; admission remains closed until it resolves and any late start is stopped"]) }
        }
        let threshold = canonical["threshold"] as? Double ?? 0.02
        DispatchQueue.global().async {
            if op == "start" { self.startVAD(threshold: threshold, completion: reply) }
            else { self.stopVAD(completion: reply) }
        }
    }

    private func startVAD(threshold: Double, completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        if vadEngine != nil {
            lock.unlock()
            completion(WireFormat.error("VAD already active"))
            return
        }
        lock.unlock()

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate.isFinite, format.sampleRate > 0, format.sampleRate <= 1_000_000, format.channelCount > 0, format.channelCount <= 64 else {
            completion(WireFormat.error("VAD microphone has no bounded PCM format")); return
        }
        let generation = UUID()
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self = self else { return }
            let rms = AudioDomain.measurePCM(buffer)?["level"] as? Double
            guard let rms else { self.failVAD(generation: generation, message: "native VAD PCM samples are non-finite, incomplete or oversized"); return }
            self.lock.lock()
            defer { self.lock.unlock() }
            guard self.vadGeneration == generation, self.vadActive else { return }
            self.vadSpeaking = rms > threshold
            self.vadLevel = rms
        }

        lock.lock(); vadEngine = engine; vadGeneration = generation; vadError = nil; vadLevel = 0; vadSpeaking = false; lock.unlock()
        let observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            // Apple's callback runs on an internal engine queue. Teardown
            // is deferred; deallocating the engine here can deadlock.
            self?.failVAD(generation: generation, message: "native VAD microphone configuration changed; restart against the current device")
        }
        lock.lock(); vadObserver = observer; lock.unlock()

        do {
            try engine.start()
            lock.lock()
            let error = vadError
            vadActive = error == nil
            lock.unlock()
            if let error { tearDownVAD(generation: generation, clearError: false); completion(WireFormat.error(error)); return }
            completion(WireFormat.success(["active": true]))
        } catch {
            tearDownVAD(generation: generation, clearError: true)
            completion(WireFormat.error("VAD engine failed: \(error.localizedDescription)"))
        }
    }

    private func stopVAD(completion: @escaping @Sendable ([String: Any]) -> Void) {
        tearDownVAD(clearError: true)
        completion(WireFormat.success(["active": false]))
    }

    private func failVAD(generation: UUID, message: String) {
        lock.lock()
        guard vadGeneration == generation, vadError == nil else { lock.unlock(); return }
        vadError = message; vadActive = false; vadSpeaking = false; vadLevel = 0
        lock.unlock()
        DispatchQueue.global().async {
            self.vadLifecycle.wait()
            defer { self.vadLifecycle.signal() }
            self.tearDownVAD(generation: generation, clearError: false)
        }
    }

    private func tearDownVAD(generation: UUID? = nil, clearError: Bool) {
        lock.lock()
        if let generation, vadGeneration != generation { lock.unlock(); return }
        let engine = vadEngine
        let observer = vadObserver
        vadEngine = nil
        vadObserver = nil
        vadGeneration = nil
        if clearError { vadError = nil }
        vadActive = false
        vadSpeaking = false
        vadLevel = 0
        lock.unlock()
        if let observer { NotificationCenter.default.removeObserver(observer) }
        // Native stop can wait for a callback. It must not hold that
        // callback's state lock; the generation is already revoked.
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
    }
}
