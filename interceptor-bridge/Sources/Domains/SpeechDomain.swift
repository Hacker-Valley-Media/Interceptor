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
    private var vadEngine: AVAudioEngine?
    private var vadActive = false
    private var vadSpeaking = false
    private var vadLevel: Double = 0

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "start":
            startListening(action, completion: completion)
        case "stop":
            stopListening(completion: completion)
        case "status":
            lock.lock()
            let listening = isListening
            lock.unlock()
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
            completion(WireFormat.success(["transcript": t, "listening": listening, "streaming": true]))
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
        if isListening {
            lock.unlock()
            completion(WireFormat.error("already listening"))
            return
        }
        lock.unlock()

        SFSpeechRecognizer.requestAuthorization { [self] status in
            guard status == .authorized else {
                completion(WireFormat.error("Speech recognition not authorized. Status: \(status.rawValue)"))
                return
            }

            guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
                completion(WireFormat.error("Speech recognizer not available"))
                return
            }

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.addsPunctuation = true

            let engine = AVAudioEngine()
            let inputNode = engine.inputNode
            let recordingFormat = inputNode.outputFormat(forBus: 0)

            inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
                request.append(buffer)
            }

            let task = recognizer.recognitionTask(with: request) { [self] result, error in
                if let result = result {
                    self.lock.lock()
                    self.transcript = result.bestTranscription.formattedString
                    self.lock.unlock()
                }
                if error != nil || (result?.isFinal ?? false) {
                    self.lock.lock()
                    self.isListening = false
                    self.lock.unlock()
                    engine.stop()
                    inputNode.removeTap(onBus: 0)
                }
            }

            do {
                engine.prepare()
                try engine.start()
            } catch {
                completion(WireFormat.error("audio engine failed: \(error.localizedDescription)"))
                return
            }

            self.lock.lock()
            self.audioEngine = engine
            self.recognitionTask = task
            self.recognitionRequest = request
            self.isListening = true
            self.transcript = ""
            self.lock.unlock()

            completion(WireFormat.success(["listening": true]))
        }
    }

    private func stopListening(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        isListening = false
        let t = transcript
        audioEngine = nil
        recognitionTask = nil
        recognitionRequest = nil
        lock.unlock()

        completion(WireFormat.success(["listening": false, "transcript": t]))
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
            customVocabulary.append(word)
            lock.unlock()
            completion(WireFormat.success(["added": word, "total": customVocabulary.count]))
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
        let op = action["op"] as? String ?? "status"
        switch op {
        case "start":
            startVAD(completion: completion)
        case "stop":
            stopVAD(completion: completion)
        case "status":
            lock.lock()
            let active = vadActive
            let speaking = vadSpeaking
            let level = vadLevel
            lock.unlock()
            completion(WireFormat.success(["active": active, "speaking": speaking, "level": level]))
        default:
            notImplemented("vad \(op)", completion: completion)
        }
    }

    private func startVAD(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        if vadActive {
            lock.unlock()
            completion(WireFormat.error("VAD already active"))
            return
        }
        lock.unlock()

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        let silenceThreshold: Float = 0.02

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self = self else { return }
            let channelData = buffer.floatChannelData?[0]
            let frameLength = Int(buffer.frameLength)
            var rms: Float = 0
            if let data = channelData {
                for i in 0..<frameLength {
                    rms += data[i] * data[i]
                }
                rms = sqrt(rms / Float(frameLength))
            }
            let speaking = rms > silenceThreshold
            self.lock.lock()
            self.vadSpeaking = speaking
            self.vadLevel = Double(rms)
            self.lock.unlock()
        }

        do {
            try engine.start()
            lock.lock()
            vadEngine = engine
            vadActive = true
            lock.unlock()
            completion(WireFormat.success(["active": true]))
        } catch {
            completion(WireFormat.error("VAD engine failed: \(error.localizedDescription)"))
        }
    }

    private func stopVAD(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        vadEngine?.stop()
        vadEngine?.inputNode.removeTap(onBus: 0)
        vadEngine = nil
        vadActive = false
        vadSpeaking = false
        vadLevel = 0
        lock.unlock()
        completion(WireFormat.success(["active": false]))
    }
}
