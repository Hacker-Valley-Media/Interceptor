import Foundation
import Vision
import AppKit
import ScreenCaptureKit

final class VisionDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "faces":
            detectFaces(action, completion: completion)
        case "text":
            recognizeText(action, completion: completion)
        case "hands":
            detectHands(action, completion: completion)
        case "bodies":
            detectBodies(action, completion: completion)
        case "classify":
            classifyImage(action, completion: completion)
        case "saliency":
            detectSaliency(action, completion: completion)
        default:
            notImplemented(sub, completion: completion)
        }
    }

    private func acquireImage(action: [String: Any], completion: @escaping @Sendable (CGImage?) -> Void) {
        let appName = action["app"] as? String

        if let streamFrame = StreamDomain.shared?.latestFrame(for: appName) {
            completion(streamFrame)
            return
        }

        Task {
            do {
                let content = try await SCShareableContent.current
                let filter: SCContentFilter

                if let appName = appName,
                   let app = content.applications.first(where: { $0.applicationName == appName }),
                   let window = content.windows.first(where: { $0.owningApplication?.processID == app.processID }) {
                    filter = SCContentFilter(desktopIndependentWindow: window)
                } else if let frontApp = NSWorkspace.shared.frontmostApplication,
                          let window = content.windows.first(where: { $0.owningApplication?.processID == frontApp.processIdentifier }) {
                    filter = SCContentFilter(desktopIndependentWindow: window)
                } else if let display = content.displays.first {
                    filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                } else {
                    completion(nil)
                    return
                }

                let config = SCStreamConfiguration()
                let sampleBuffer = try await SCScreenshotManager.captureSampleBuffer(contentFilter: filter, configuration: config)
                guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
                    completion(nil)
                    return
                }
                let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
                let context = CIContext()
                let cgImage = context.createCGImage(ciImage, from: ciImage.extent)
                completion(cgImage)
            } catch {
                Platform.log("Vision capture error: \(error.localizedDescription)")
                completion(nil)
            }
        }
    }

    private func detectFaces(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        acquireImage(action: action) { image in
            guard let image = image else {
                completion(WireFormat.error("failed to capture screen"))
                return
            }
            let request = VNDetectFaceRectanglesRequest()
            let handler = VNImageRequestHandler(cgImage: image)
            do {
                try handler.perform([request])
                let faces = (request.results ?? []).map { face -> [String: Any] in
                    let box = face.boundingBox
                    return [
                        "x": box.origin.x,
                        "y": box.origin.y,
                        "width": box.width,
                        "height": box.height,
                        "confidence": face.confidence
                    ]
                }
                completion(WireFormat.success(["faces": faces, "count": faces.count]))
            } catch {
                completion(WireFormat.error("face detection failed: \(error.localizedDescription)"))
            }
        }
    }

    private func recognizeText(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        acquireImage(action: action) { image in
            guard let image = image else {
                completion(WireFormat.error("failed to capture screen"))
                return
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            let handler = VNImageRequestHandler(cgImage: image)
            do {
                try handler.perform([request])
                let observations = request.results ?? []
                let texts = observations.compactMap { obs -> [String: Any]? in
                    guard let candidate = obs.topCandidates(1).first else { return nil }
                    let box = obs.boundingBox
                    return [
                        "text": candidate.string,
                        "confidence": candidate.confidence,
                        "x": box.origin.x,
                        "y": box.origin.y,
                        "width": box.width,
                        "height": box.height
                    ]
                }
                let fullText = texts.map { $0["text"] as? String ?? "" }.joined(separator: "\n")
                completion(WireFormat.success(["text": fullText, "regions": texts, "count": texts.count]))
            } catch {
                completion(WireFormat.error("text recognition failed: \(error.localizedDescription)"))
            }
        }
    }

    private func detectHands(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        acquireImage(action: action) { image in
            guard let image = image else {
                completion(WireFormat.error("failed to capture screen"))
                return
            }
            let request = VNDetectHumanHandPoseRequest()
            let handler = VNImageRequestHandler(cgImage: image)
            do {
                try handler.perform([request])
                let hands = (request.results ?? []).map { hand -> [String: Any] in
                    var joints: [String: [String: Any]] = [:]
                    for jointName in [VNHumanHandPoseObservation.JointsGroupName.thumb, .indexFinger, .middleFinger, .ringFinger, .littleFinger] {
                        if let points = try? hand.recognizedPoints(jointName) {
                            for (key, point) in points where point.confidence > 0.3 {
                                joints[key.rawValue.rawValue] = ["x": point.x, "y": point.y, "confidence": point.confidence]
                            }
                        }
                    }
                    return ["joints": joints, "chirality": hand.chirality.rawValue]
                }
                completion(WireFormat.success(["hands": hands, "count": hands.count]))
            } catch {
                completion(WireFormat.error("hand detection failed: \(error.localizedDescription)"))
            }
        }
    }

    private func detectBodies(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        acquireImage(action: action) { image in
            guard let image = image else {
                completion(WireFormat.error("failed to capture screen"))
                return
            }
            let request = VNDetectHumanBodyPoseRequest()
            let handler = VNImageRequestHandler(cgImage: image)
            do {
                try handler.perform([request])
                let bodies = (request.results ?? []).map { body -> [String: Any] in
                    var joints: [String: [String: Any]] = [:]
                    if let points = try? body.recognizedPoints(.all) {
                        for (key, point) in points where point.confidence > 0.3 {
                            joints[key.rawValue.rawValue] = ["x": point.x, "y": point.y, "confidence": point.confidence]
                        }
                    }
                    return ["joints": joints]
                }
                completion(WireFormat.success(["bodies": bodies, "count": bodies.count]))
            } catch {
                completion(WireFormat.error("body detection failed: \(error.localizedDescription)"))
            }
        }
    }

    private func classifyImage(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        acquireImage(action: action) { image in
            guard let image = image else {
                completion(WireFormat.error("failed to capture screen"))
                return
            }
            let request = VNClassifyImageRequest()
            let handler = VNImageRequestHandler(cgImage: image)
            do {
                try handler.perform([request])
                let classifications = (request.results ?? [])
                    .filter { $0.confidence > 0.1 }
                    .prefix(20)
                    .map { ["label": $0.identifier, "confidence": $0.confidence] as [String: Any] }
                completion(WireFormat.success(["classifications": classifications]))
            } catch {
                completion(WireFormat.error("classification failed: \(error.localizedDescription)"))
            }
        }
    }

    private func detectSaliency(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        acquireImage(action: action) { image in
            guard let image = image else {
                completion(WireFormat.error("failed to capture screen"))
                return
            }
            let request = VNGenerateAttentionBasedSaliencyImageRequest()
            let handler = VNImageRequestHandler(cgImage: image)
            do {
                try handler.perform([request])
                if let result = request.results?.first {
                    let regions = (result.salientObjects ?? []).map { obj -> [String: Any] in
                        let box = obj.boundingBox
                        return ["x": box.origin.x, "y": box.origin.y, "width": box.width, "height": box.height, "confidence": obj.confidence]
                    }
                    completion(WireFormat.success(["regions": regions]))
                } else {
                    completion(WireFormat.success(["regions": []]))
                }
            } catch {
                completion(WireFormat.error("saliency detection failed: \(error.localizedDescription)"))
            }
        }
    }
}
