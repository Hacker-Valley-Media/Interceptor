import Foundation
import SoundAnalysis
import AVFoundation

final class SoundDomain: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var isClassifying = false
    private var audioEngine: AVAudioEngine?
    private var analyzer: SNAudioStreamAnalyzer?
    private var recentClassifications: [[String: Any]] = []
    private var observer: SoundObserver?

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "start":
            startClassification(completion: completion)
        case "stop":
            stopClassification(completion: completion)
        case "status":
            lock.lock()
            let active = isClassifying
            let latest = recentClassifications.last
            lock.unlock()
            completion(WireFormat.success(["classifying": active, "latest": latest as Any]))
        case "tail":
            lock.lock()
            let classifications = recentClassifications
            let active = isClassifying
            lock.unlock()
            completion(WireFormat.success(["classifying": active, "classifications": classifications, "streaming": true]))
        case "log":
            let filter = action["filter"] as? String
            lock.lock()
            var results = recentClassifications
            lock.unlock()
            if let filter = filter {
                results = results.filter { ($0["label"] as? String)?.contains(filter) ?? false }
            }
            completion(WireFormat.success(results))
        default:
            notImplemented(sub, completion: completion)
        }
    }

    private func startClassification(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        if isClassifying {
            lock.unlock()
            completion(WireFormat.error("already classifying"))
            return
        }
        lock.unlock()

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        let streamAnalyzer = SNAudioStreamAnalyzer(format: recordingFormat)

        let request: SNClassifySoundRequest
        do {
            request = try SNClassifySoundRequest(classifierIdentifier: .version1)
        } catch {
            completion(WireFormat.error("failed to create sound classifier: \(error.localizedDescription)"))
            return
        }

        let obs = SoundObserver { [weak self] classifications in
            self?.lock.lock()
            self?.recentClassifications.append(contentsOf: classifications)
            if (self?.recentClassifications.count ?? 0) > 500 {
                self?.recentClassifications.removeFirst((self?.recentClassifications.count ?? 0) - 500)
            }
            self?.lock.unlock()
        }

        do {
            try streamAnalyzer.add(request, withObserver: obs)
        } catch {
            completion(WireFormat.error("failed to add sound request: \(error.localizedDescription)"))
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 8192, format: recordingFormat) { buffer, time in
            streamAnalyzer.analyze(buffer, atAudioFramePosition: time.sampleTime)
        }

        do {
            engine.prepare()
            try engine.start()
        } catch {
            completion(WireFormat.error("audio engine failed: \(error.localizedDescription)"))
            return
        }

        lock.lock()
        self.audioEngine = engine
        self.analyzer = streamAnalyzer
        self.observer = obs
        self.isClassifying = true
        self.recentClassifications = []
        lock.unlock()

        completion(WireFormat.success(["classifying": true]))
    }

    private func stopClassification(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        isClassifying = false
        let results = recentClassifications
        audioEngine = nil
        analyzer = nil
        observer = nil
        lock.unlock()

        completion(WireFormat.success(["classifying": false, "totalClassifications": results.count]))
    }
}

private final class SoundObserver: NSObject, SNResultsObserving, @unchecked Sendable {
    private let handler: ([[String: Any]]) -> Void

    init(handler: @escaping ([[String: Any]]) -> Void) {
        self.handler = handler
    }

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let classificationResult = result as? SNClassificationResult else { return }
        let classifications: [[String: Any]] = classificationResult.classifications
            .filter { $0.confidence > 0.3 }
            .prefix(5)
            .map { ["label": $0.identifier, "confidence": $0.confidence, "timestamp": Date().timeIntervalSince1970] }
        if !classifications.isEmpty {
            handler(classifications)
        }
    }

    func request(_ request: SNRequest, didFailWithError error: Error) {
        Platform.log("SoundAnalysis error: \(error.localizedDescription)")
    }
}
