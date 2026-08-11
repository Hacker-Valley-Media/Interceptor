import Foundation
import Vision
import AppKit
import ScreenCaptureKit

final class VisionDomain: DomainHandler, @unchecked Sendable {
    /// PRD-63 Spec 2: pure helper for the SCStreamConfiguration dimensions
    /// derived from a SCContentFilter. Pulled out of acquireImage so it can
    /// be unit-tested without spinning up an SCK content session. Mirrors
    /// Apple's "Capturing Screen Content in macOS" sample-code pattern of
    /// `width = contentRect.width * pointPixelScale` for window mode.
    static func dimensionsForCaptureBuffer(contentRect: CGRect, pointPixelScale: CGFloat) -> (width: Int, height: Int) {
        return (
            max(1, Int(contentRect.width  * pointPixelScale)),
            max(1, Int(contentRect.height * pointPixelScale))
        )
    }

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
                var targetWindow: SCWindow? = nil

                // PRD-63 Spec 2: pick the LARGEST window owned by the app —
                // SCK's window list returns helper windows (menu-bar items,
                // 0×0 shadow windows, 3840×60 toolbar slivers) before the
                // actual document window. Without this filter Vision was
                // OCRing menu strips. Mirrors ScreenshotDomain's picker.
                let largestWindow: (pid_t) -> SCWindow? = { pid in
                    content.windows
                        .filter { $0.owningApplication?.processID == pid }
                        .sorted { ($0.frame.width * $0.frame.height) > ($1.frame.width * $1.frame.height) }
                        .first
                }
                if let appName = appName,
                   let app = content.applications.first(where: { $0.applicationName == appName }),
                   let window = largestWindow(app.processID) {
                    filter = SCContentFilter(desktopIndependentWindow: window)
                    targetWindow = window
                } else if let frontApp = FrontmostResolver.frontmostApplication(),
                          let window = largestWindow(frontApp.processIdentifier) {
                    filter = SCContentFilter(desktopIndependentWindow: window)
                    targetWindow = window
                } else if let display = content.displays.first {
                    filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                } else {
                    completion(nil)
                    return
                }

                // PRD-63 Spec 2: prefer the private SkyLight CGSHWCaptureWindowList
                // path for window captures — same trick ScreenshotDomain uses
                // for occluded / minimized / off-Space windows where SCK's
                // SCScreenshotManager.captureSampleBuffer returns a black
                // buffer. Without this, Vision OCR/face/hand/body detection
                // returns count:0 for any non-frontmost window because the
                // SCK path silently delivers an empty frame. Fall back to
                // SCK only for display captures and as a safety net.
                if let win = targetWindow,
                   let cgs = cgsCaptureWindow(
                    windowID: CGWindowID(win.windowID),
                    options: [.ignoreGlobalClipShape, .bestResolution, .fullSize]
                   ) {
                    completion(cgs)
                    return
                }

                // PRD-63 Spec 2: SCStreamConfiguration's width/height default
                // to 0 (Apple docs: "configure if you need to customize the
                // output"), which produces degenerate frames for downstream
                // Vision requests. Derive both from the filter's contentRect
                // and pointPixelScale so the buffer matches the captured
                // window/display at native pixel density.
                let config = SCStreamConfiguration()
                let dims = Self.dimensionsForCaptureBuffer(
                    contentRect: filter.contentRect,
                    pointPixelScale: CGFloat(filter.pointPixelScale))
                config.width  = dims.width
                config.height = dims.height
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
        // Capture sendable scalars before entering the @Sendable closure.
        let debugDumpPath = action["debugDumpPath"] as? String
        acquireImage(action: action) { image in
            guard let image = image else {
                completion(WireFormat.error("failed to capture screen"))
                return
            }
            // PRD-63 Spec 2 diagnostic: dump the captured image so we can
            // confirm whether empty-result regressions are capture-side
            // (blank/off-screen frame) or OCR-side (Vision missed the text).
            // Off by default; opt-in via --debug-dump on the action object.
            if let path = debugDumpPath,
               let dest = CGImageDestinationCreateWithURL(
                URL(fileURLWithPath: path) as CFURL,
                "public.jpeg" as CFString, 1, nil) {
                CGImageDestinationAddImage(dest, image, nil)
                _ = CGImageDestinationFinalize(dest)
                Platform.log("vision diagnostic: dumped capture to \(path) (\(image.width)x\(image.height))")
            }
            // PRD-63 Spec 2: configure the Apple-documented language knobs.
            // recognitionLanguages is a priority-ordered hint; combined with
            // automaticallyDetectsLanguage=true Vision uses both — the
            // priority list as a starting point and live detection on the
            // actual image content.
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["en-US"]
            request.automaticallyDetectsLanguage = true
            request.usesLanguageCorrection = true
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
