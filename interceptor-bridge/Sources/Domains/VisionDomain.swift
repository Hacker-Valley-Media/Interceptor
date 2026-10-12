import Foundation
import Vision
import AppKit
import ScreenCaptureKit
import Darwin

final class VisionDomain: DomainHandler, @unchecked Sendable {
    /// Pure helper for the SCStreamConfiguration dimensions
    /// derived from a SCContentFilter. Pulled out of acquireImage so it can
    /// be unit-tested without spinning up an SCK content session. Mirrors
    /// Apple's "Capturing Screen Content in macOS" sample-code pattern of
    /// `width = contentRect.width * pointPixelScale` for window mode.
    static func dimensionsForCaptureBuffer(contentRect: CGRect, pointPixelScale: CGFloat) -> (width: Int, height: Int) {
        let width = contentRect.width * pointPixelScale, height = contentRect.height * pointPixelScale
        guard width.isFinite, height.isFinite, abs(width) <= CGFloat(DESKTOP_CAPTURE_MAX_PIXELS), abs(height) <= CGFloat(DESKTOP_CAPTURE_MAX_PIXELS) else { return (0, 0) }
        return (
            max(1, Int(contentRect.width  * pointPixelScale)),
            max(1, Int(contentRect.height * pointPixelScale))
        )
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        var canonical = action; canonical["type"] = "desktop_vision"; canonical["sub"] = sub
        if let error = DesktopVisionShape.validationError(canonical) ?? Self.sourceError(canonical) { completion(["success": false, "code": "invalid_request", "error": error]); return }
        if action["debugDumpPath"] != nil && sub != "text" { completion(WireFormat.error("vision debug dump belongs only to text")); return }
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

    static func sourceError(_ action: [String: Any]) -> String? {
        for key in ["imagePath", "debugDumpPath"] {
            if let value = action[key], (value as? String).map(DesktopThumbnailValidation.validPath) != true { return "vision requires bounded absolute image paths" }
        }
        if let value = action["app"] {
            guard let name = value as? String, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !name.contains("\0"), name.utf8.count <= 512 else { return "vision requires a bounded app name" }
            if action["imagePath"] != nil { return "image source requires either an app or an image file" }
        }
        for key in ["group", "groupColor"] {
            if let value = action[key], (value as? String).map({ $0.isEmpty || $0.contains("\0") || $0.utf8.count > 256 }) != false { return "invalid image request group" }
        }
        return nil
    }

    func acquireImage(action: [String: Any], owner: NSRunningApplication? = nil, completion: @escaping @Sendable (CGImage?) -> Void) {
        if Self.sourceError(action) != nil { completion(nil); return }
        // File source: run Vision over a saved image (e.g. an iOS screenshot)
        // instead of capturing a live macOS window. EXIF orientation is applied
        // so iPhone captures read upright. When imagePath is set, app/window
        // capture is skipped entirely.
        if let imagePath = action["imagePath"] as? String {
            completion(Self.loadImage(atPath: imagePath))
            return
        }

        let appName = action["app"] as? String

        let retainedOwner = UncheckedSendableBox(owner)
        if owner == nil, let streamFrame = StreamDomain.shared?.latestFrame(for: appName) {
            completion(streamFrame)
            return
        }

        Task {
            do {
                let content = try await SCShareableContent.current
                let filter: SCContentFilter
                var targetWindow: SCWindow? = nil

                // Pick the LARGEST window owned by the app —
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
                if let appName = appName {
                    let apps = content.applications.filter { $0.applicationName == appName && (retainedOwner.value == nil || $0.processID == retainedOwner.value?.processIdentifier) }
                    guard apps.count == 1, retainedOwner.value?.isTerminated != true, let window = largestWindow(apps[0].processID) else { completion(nil); return }
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

                // Prefer the private SkyLight CGSHWCaptureWindowList
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
                    guard cgs.width > 0, cgs.height > 0, cgs.width <= DESKTOP_CAPTURE_MAX_PIXELS / cgs.height, retainedOwner.value?.isTerminated != true else { completion(nil); return }
                    completion(cgs)
                    return
                }

                // SCStreamConfiguration's width/height default
                // to 0 (Apple docs: "configure if you need to customize the
                // output"), which produces degenerate frames for downstream
                // Vision requests. Derive both from the filter's contentRect
                // and pointPixelScale so the buffer matches the captured
                // window/display at native pixel density.
                let config = SCStreamConfiguration()
                let dims = Self.dimensionsForCaptureBuffer(
                    contentRect: filter.contentRect,
                    pointPixelScale: CGFloat(filter.pointPixelScale))
                guard dims.width > 0, dims.height > 0, dims.width <= DESKTOP_CAPTURE_MAX_PIXELS / dims.height else { completion(nil); return }
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
                completion(retainedOwner.value?.isTerminated == true ? nil : cgImage)
            } catch {
                Platform.log("Vision capture error: \(error.localizedDescription)")
                completion(nil)
            }
        }
    }

    /// Why `acquireImage` produced nothing. ImageIO only returns nil, so a file
    /// source works out the reason here; a capture keeps its original text.
    static func imageFailureMessage(imagePath: String?) -> String {
        guard let imagePath else { return "failed to capture screen" }
        do {
            _ = try URL(fileURLWithPath: imagePath).checkResourceIsReachable()
        } catch {
            return "cannot read image file \(imagePath): \(error.localizedDescription)"
        }
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: imagePath, isDirectory: &isDirectory), isDirectory.boolValue {
            return "not an image file (it is a directory): \(imagePath)"
        }
        if !FileManager.default.isReadableFile(atPath: imagePath) {
            return "cannot read image file \(imagePath): permission denied"
        }
        return "not an image file (ImageIO could not decode it): \(imagePath)"
    }

    /// Decode an image file and apply its EXIF orientation. nil when the file
    /// is unreachable or is not an image.
    static func loadImage(atPath imagePath: String) -> CGImage? {
        let path = (imagePath as NSString).expandingTildeInPath
        let fd = Darwin.open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? file.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size > 0, info.st_size <= DESKTOP_THUMBNAIL_MAX_SOURCE_BYTES,
              let data = try? file.read(upToCount: DESKTOP_THUMBNAIL_MAX_SOURCE_BYTES + 1), data.count <= DESKTOP_THUMBNAIL_MAX_SOURCE_BYTES,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber, let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.intValue > 0, height.intValue > 0, width.intValue <= DESKTOP_THUMBNAIL_MAX_PIXELS / height.intValue,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        return orientedCGImage(source: source, image: image)
    }

    /// Apply a file's EXIF orientation to a decoded CGImage so iPhone
    /// screenshots (whose pixel data is landscape with an orientation tag)
    /// read upright before Vision runs over them.
    static func orientedCGImage(source: CGImageSource, image: CGImage) -> CGImage? {
        guard let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let rawOrientation = props[kCGImagePropertyOrientation] as? UInt32,
              let orientation = CGImagePropertyOrientation(rawValue: rawOrientation),
              orientation != .up else {
            return image
        }
        let ciImage = CIImage(cgImage: image).oriented(orientation)
        let context = CIContext()
        return context.createCGImage(ciImage, from: ciImage.extent) ?? image
    }

    private func detectFaces(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let imagePath = action["imagePath"] as? String
        acquireImage(action: action) { image in
            guard let image = image else {
                completion(WireFormat.error(Self.imageFailureMessage(imagePath: imagePath)))
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
        let imagePath = action["imagePath"] as? String
        acquireImage(action: action) { image in
            guard let image = image else {
                completion(WireFormat.error(Self.imageFailureMessage(imagePath: imagePath)))
                return
            }
            if let path = debugDumpPath {
                let bytes = NSMutableData()
                guard let dest = CGImageDestinationCreateWithData(bytes, "public.jpeg" as CFString, 1, nil) else { completion(WireFormat.error("vision diagnostic encoder is unavailable")); return }
                CGImageDestinationAddImage(dest, image, nil)
                guard CGImageDestinationFinalize(dest), bytes.length > 0, bytes.length <= DESKTOP_THUMBNAIL_MAX_SOURCE_BYTES else { completion(WireFormat.error("vision diagnostic encoding failed or exceeded 64MiB")); return }
                let fd = Darwin.open((path as NSString).expandingTildeInPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
                guard fd >= 0 else { completion(WireFormat.error("vision diagnostic destination exists or cannot be created; original preserved")); return }
                let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? file.close() }
                do { try file.write(contentsOf: bytes as Data); try file.synchronize() }
                catch { completion(["success": false, "code": "partial_result", "error": "vision diagnostic write failed; partial owned file retained: \(error.localizedDescription)"]); return }
            }
            Self.recognize(image, completion: completion)
        }
    }

    // Apple's TextRecognition can wedge inside a long-lived process: every later request then fails with
    // CRImageReaderError or hangs, while a fresh process reads the same image (measured).
    // OCR runs in-process with a deadline; on a failure or timeout it runs in a short-lived child of this
    // binary (`--vision-text-helper`), and the in-process path is skipped for two minutes.
    final class OCRHealth: @unchecked Sendable {
        static let shared = OCRHealth()
        private let lock = NSLock(); private var skipUntil = Date.distantPast
        var tripped: Bool { lock.withLock { Date() < skipUntil } }
        func trip() { lock.withLock { skipUntil = Date().addingTimeInterval(120) } }
    }
    // In-process requests run one at a time; a request still queued when its deadline passes is skipped there.
    // Helpers also run one at a time, so a burst of fallbacks does not start several cold model loads at once.
    private static let ocrQueue = DispatchQueue(label: "interceptor.vision.ocr")
    private static let helperGate = DispatchSemaphore(value: 1)
    // The whole request has DESKTOP_VISION_DEADLINE_MS (35s). A cold in-process load measured 14-17s, so the in-process
    // deadline leaves room for it; a wedged process fails fast (~86ms). The helper gets what remains of the budget.
    static let inProcessOCRDeadline: TimeInterval = 20, totalOCRBudget: TimeInterval = Double(DESKTOP_VISION_DEADLINE_MS) / 1000 - 1

    static func textRequest() -> VNRecognizeTextRequest {
        // RecognitionLanguages is a priority-ordered hint; with
        // automaticallyDetectsLanguage=true Vision also detects the image's language.
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US"]
        request.automaticallyDetectsLanguage = true
        request.usesLanguageCorrection = true
        return request
    }

    static func textResult(_ image: CGImage, request: VNRecognizeTextRequest) throws -> [String: Any] {
        try VNImageRequestHandler(cgImage: image).perform([request])
        let texts = (request.results ?? []).compactMap { obs -> [String: Any]? in
            guard let candidate = obs.topCandidates(1).first else { return nil }
            let box = obs.boundingBox
            return ["text": candidate.string, "confidence": candidate.confidence, "x": box.origin.x, "y": box.origin.y, "width": box.width, "height": box.height]
        }
        return ["text": texts.map { $0["text"] as? String ?? "" }.joined(separator: "\n"), "regions": texts, "count": texts.count]
    }

    static func recognize(_ image: CGImage, completion: @escaping @Sendable ([String: Any]) -> Void) {
        let started = Date()
        guard !OCRHealth.shared.tripped else { recognizeOutOfProcess(image, started: started, completion: completion); return }
        let request = UncheckedSendableBox(textRequest()), done = AtomicFlag()
        ocrQueue.async {
            guard Date().timeIntervalSince(started) < inProcessOCRDeadline else { return } // its watchdog already moved it to a helper
            // Test hook: while this owner-only file exists, in-process OCR fails as a wedged TextRecognition does.
            // It never affects the helper, so the fallback and the recovery after removal can be shown live.
            let simulated = FileManager.default.fileExists(atPath: Platform.runtimeDir + "/interceptor-test-ocr-wedge")
            let result = Result { () throws -> [String: Any] in
                if simulated { throw NSError(domain: "TextRecognition.CRImageReaderError", code: 1, userInfo: [NSLocalizedDescriptionKey: "simulated in-process wedge (test hook)"]) }
                return try textResult(image, request: request.value)
            }
            if case .failure = result { OCRHealth.shared.trip() }
            guard done.set() else { return }
            switch result {
            case .success(let data): completion(WireFormat.success(data))
            case .failure(let error):
                Platform.log("in-process text recognition failed (\(error.localizedDescription)); retrying in a fresh helper process")
                recognizeOutOfProcess(image, started: started, completion: completion)
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + inProcessOCRDeadline) {
            guard done.set() else { return }
            request.value.cancel(); OCRHealth.shared.trip()
            Platform.log("in-process text recognition exceeded \(Int(inProcessOCRDeadline))s; retrying in a fresh helper process")
            recognizeOutOfProcess(image, started: started, completion: completion)
        }
    }

    static func recognizeOutOfProcess(_ image: CGImage, started: Date, completion: @escaping @Sendable ([String: Any]) -> Void) {
        DispatchQueue.global().async {
            let wait = totalOCRBudget - Date().timeIntervalSince(started) - 1
            guard wait > 0, helperGate.wait(timeout: .now() + wait) == .success else {
                completion(WireFormat.error("text recognition helper did not become free within the vision deadline")); return
            }
            runHelper(image, started: started) { reply in helperGate.signal(); completion(reply) }
        }
    }

    private static func runHelper(_ image: CGImage, started: Date, completion: @escaping @Sendable ([String: Any]) -> Void) {
        let png = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(png, "public.png" as CFString, 1, nil) else { completion(WireFormat.error("text recognition helper encoder is unavailable")); return }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest), png.length > 0, png.length <= DESKTOP_THUMBNAIL_MAX_SOURCE_BYTES, let executable = Bundle.main.executableURL else {
            completion(WireFormat.error("text recognition helper input is unavailable or exceeds 64MiB")); return
        }
        let process = Process(), input = Pipe(), output = Pipe()
        process.executableURL = executable; process.arguments = ["--vision-text-helper"]
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { completion(WireFormat.error("text recognition helper could not start: \(error.localizedDescription)")); return }
        let child = UncheckedSendableBox(process), bytes = png as Data, done = AtomicFlag()
        let budget = max(5, totalOCRBudget - Date().timeIntervalSince(started))
        DispatchQueue.global().asyncAfter(deadline: .now() + budget) {
            guard done.set() else { return }
            kill(child.value.processIdentifier, SIGKILL)
            completion(WireFormat.error("text recognition did not finish within \(Int(budget))s in a fresh helper process; the helper was stopped"))
        }
        DispatchQueue.global().async {
            // A helper that exits before reading everything must not SIGPIPE the bridge; the write then fails with EPIPE.
            if fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 { try? input.fileHandleForWriting.write(contentsOf: bytes) }
            try? input.fileHandleForWriting.close()
        }
        DispatchQueue.global().async {
            let reply = output.fileHandleForReading.readDataToEndOfFile()
            child.value.waitUntilExit()
            guard done.set() else { return }
            if let object = try? JSONSerialization.jsonObject(with: reply) as? [String: Any], object["success"] is Bool { completion(object) }
            else { completion(WireFormat.error("text recognition helper exited \(child.value.terminationStatus) without a result")) }
        }
    }

    /// `interceptor-bridge --vision-text-helper`: one PNG on stdin, one wire reply on stdout, then exit.
    static func textHelperMain() -> Never {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        var reply = WireFormat.error("text recognition helper received an undecodable or oversized image")
        if data.count > 0, data.count <= DESKTOP_THUMBNAIL_MAX_SOURCE_BYTES, let source = CGImageSourceCreateWithData(data as CFData, nil),
           let image = CGImageSourceCreateImageAtIndex(source, 0, nil) {
            do { reply = WireFormat.success(try textResult(image, request: textRequest())) }
            catch { reply = WireFormat.error("text recognition failed: \(error.localizedDescription)") }
        }
        FileHandle.standardOutput.write((try? JSONSerialization.data(withJSONObject: reply)) ?? Data())
        exit(reply["success"] as? Bool == true ? 0 : 1)
    }

    private func detectHands(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let imagePath = action["imagePath"] as? String
        acquireImage(action: action) { image in
            guard let image = image else {
                completion(WireFormat.error(Self.imageFailureMessage(imagePath: imagePath)))
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
        let imagePath = action["imagePath"] as? String
        acquireImage(action: action) { image in
            guard let image = image else {
                completion(WireFormat.error(Self.imageFailureMessage(imagePath: imagePath)))
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
        let imagePath = action["imagePath"] as? String
        acquireImage(action: action) { image in
            guard let image = image else {
                completion(WireFormat.error(Self.imageFailureMessage(imagePath: imagePath)))
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
        let imagePath = action["imagePath"] as? String
        acquireImage(action: action) { image in
            guard let image = image else {
                completion(WireFormat.error(Self.imageFailureMessage(imagePath: imagePath)))
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
