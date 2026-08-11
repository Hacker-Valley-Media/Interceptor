import Foundation
@preconcurrency import ScreenCaptureKit
import AppKit
import CoreMedia
import CoreGraphics
import UniformTypeIdentifiers
import ImageIO

final class CaptureDomain: DomainHandler, @unchecked Sendable {
    private var activeStream: SCStream?
    // Strong reference to the SCStreamOutput we registered. Apple's
    // SCStream.addStreamOutput(_:type:sampleHandlerQueue:) does NOT
    // strongly retain the output object — when the local var falls out
    // of scope, the output is deallocated and didOutputSampleBuffer
    // never fires. Holding it on the domain keeps the callback alive
    // for the stream's lifetime.
    private var activeOutput: CaptureStreamOutput?
    private var activeDelegate: CaptureStreamDelegateLogger?
    private var latestFrame: Data?
    // PRD-63 Spec 3+4: track per-frame metadata so `capture status` can
    // report frame age, and `capture frame` can return bytes/width/height
    // matching ScreenshotDomain's payload shape.
    private var latestFrameSize: CGSize?
    private var latestFrameTimestamp: Date?
    private let lock = NSLock()
    // Signaled by CaptureStreamOutput.onFrame each time a sample buffer
    // arrives. handleCapture("frame", ...) waits on this so callers don't
    // race the documented gap between SCStream.startCapture's success
    // callback (stream "successfully starts") and the first frame
    // delivery via SCStreamOutput.stream(_:didOutputSampleBuffer:of:).
    // Drained at start so leftover signals from a prior run never short-
    // circuit a fresh wait.
    private let frameReady = DispatchSemaphore(value: 0)
    // Test-only flag treated as "stream active" when activeStream itself
    // is nil. Lets CaptureFrameTimingTests exercise the "stream active
    // but no frame yet" branch without constructing a real SCStream.
    // Never set by production code paths.
    var testForcedActive: Bool = false

    // Test-only injectors mirroring what CaptureStreamOutput would do
    // when ScreenCaptureKit delivers a real sample buffer.
    func _testInjectFrame(_ data: Data) {
        lock.withLock {
            latestFrame = data
            latestFrameSize = Self.decodeJPEGSize(data)
            latestFrameTimestamp = Date()
        }
        frameReady.signal()
    }
    func _testReset() {
        lock.withLock {
            latestFrame = nil
            latestFrameSize = nil
            latestFrameTimestamp = nil
            testForcedActive = false
        }
        while frameReady.wait(timeout: .now()) == .success {}
    }

    /// PRD-63 Spec 4: decode JPEG dimensions without paying for full pixel
    /// decode. CGImageSource reads the SOI/SOF headers only.
    static func decodeJPEGSize(_ data: Data) -> CGSize? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int,
              let h = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
        return CGSize(width: CGFloat(w), height: CGFloat(h))
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "screenshot":
            takeScreenshot(action, completion: completion)
        case "capture":
            handleCapture(action, completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func takeScreenshot(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let appName = action["app"] as? String
        let save = action["save"] as? Bool ?? false
        // WebP added to format union; default jpeg with q80.
        let format = (action["format"] as? String) ?? "jpeg"
        let quality = action["quality"] as? Int ?? 80
        let displayId = action["display"] as? Int
        let windowId = action["window"] as? Int
        let mode = action["mode"] as? String  // "display" forces full-display capture
        let requestedCwd = action["cwd"] as? String
        // cap longest edge at this value before encode. Defaults to 1568 —
        // matches Anthropic vision auto-resize ceiling for Sonnet (Opus is 2576). Set to
        // 0 to disable. The default keeps payloads <300 KB on a 1728×1084 display.
        let targetMaxLongEdge: Int = (action["target_max_long_edge"] as? Int) ?? 1568

        Task {
            do {
                let content = try await SCShareableContent.current
                var filter: SCContentFilter
                // track the SCWindow / SCDisplay we ended up filtering on so
                // we can compute proper width/height for SCStreamConfiguration. SCK's
                // single-frame capture returns a black/empty buffer for occluded
                // windows when width/height are left at default — Apple's
                // capturing-screen-content-in-macos sample explicitly sets
                // `streamConfig.width = window.frame.width * 2` for window mode.
                var targetWindow: SCWindow? = nil
                var targetDisplay: SCDisplay? = nil

                if mode == "display", let display = content.displays.first {
                    filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                    targetDisplay = display
                } else if let appName = appName {
                    guard let _ = content.applications.first(where: { $0.applicationName == appName }) else {
                        completion(WireFormat.error("app not found: \(appName)"))
                        return
                    }
                    // Pick the largest window owned by the app (skip 0×0 helper windows
                    // and the menu-bar item that some apps register).
                    let appWindows = content.windows
                        .filter { $0.owningApplication?.applicationName == appName }
                        .sorted { ($0.frame.width * $0.frame.height) > ($1.frame.width * $1.frame.height) }
                    let chosen = appWindows.first ?? content.windows[0]
                    filter = SCContentFilter(desktopIndependentWindow: chosen)
                    targetWindow = chosen
                } else if let displayId = displayId,
                          let display = content.displays.first(where: { Int($0.displayID) == displayId }) {
                    filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                    targetDisplay = display
                } else if let windowId = windowId,
                          let window = content.windows.first(where: { Int($0.windowID) == windowId }) {
                    filter = SCContentFilter(desktopIndependentWindow: window)
                    targetWindow = window
                } else {
                    let frontApp = FrontmostResolver.frontmostApplication()
                    if let frontPid = frontApp?.processIdentifier,
                       let _ = content.applications.first(where: { $0.processID == frontPid }),
                       let window = content.windows.first(where: { $0.owningApplication?.processID == frontPid }) {
                        filter = SCContentFilter(desktopIndependentWindow: window)
                        targetWindow = window
                    } else if let display = content.displays.first {
                        filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                        targetDisplay = display
                    } else {
                        completion(WireFormat.error("no capturable content found"))
                        return
                    }
                }

                // explicit width/height + 2x point→pixel scale.
                // For window capture, SCK needs concrete dimensions or it returns
                // a black buffer for occluded windows. Use the window frame * pixelScale.
                // For display capture, use the display's pixel dimensions.
                let config = SCStreamConfiguration()
                let pixelScale: Int = 2
                if let w = targetWindow {
                    let wpx = max(1, Int(w.frame.width) * pixelScale)
                    let hpx = max(1, Int(w.frame.height) * pixelScale)
                    config.width = wpx
                    config.height = hpx
                    config.scalesToFit = true
                    config.showsCursor = false
                    // queueDepth + minimumFrameInterval don't apply to single-shot
                    // captureSampleBuffer but setting them is harmless.
                    config.queueDepth = 5
                    config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
                    // ignore-shadows + ignore-clipping help on occluded windows
                    // so we get the window's intrinsic content rather than what's on
                    // the visible portion of screen.
                    config.ignoreShadowsSingleWindow = true
                    config.captureResolution = .best
                } else if let d = targetDisplay {
                    config.width = d.width * pixelScale
                    config.height = d.height * pixelScale
                    config.showsCursor = false
                    config.captureResolution = .best
                }
                // For per-window captures, prefer the private SkyLight
                // CGSHWCaptureWindowList path. SCK's `captureSampleBuffer`
                // returns a black buffer for occluded / minimized / off-Space
                // Electron windows because Chromium pauses rendering when
                // unoccluded and SCK reads from the live framebuffer. The CGS
                // path reads from the WindowServer's persistent backing store
                // and works regardless of visibility — the same trick used by
                // AltTab, DockDoor, Loop, and Raycast for ~10 years.
                //
                // Per macOS 15 release notes the *public* `CGWindowListCreateImage`
                // is deprecated, but the private `CGSHWCaptureWindowList` (in
                // SkyLight.framework) remains stable. Screen Recording TCC is
                // still enforced.
                var cgImg: CGImage
                if let w = targetWindow,
                   let cgs = cgsCaptureWindow(
                    windowID: CGWindowID(w.windowID),
                    options: [.ignoreGlobalClipShape, .bestResolution, .fullSize]
                   ) {
                    cgImg = cgs
                } else {
                    // Fallback to SCK (display captures + edge cases).
                    let sampleBuffer = try await SCScreenshotManager.captureSampleBuffer(contentFilter: filter, configuration: config)
                    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
                        completion(WireFormat.error("failed to get pixel buffer"))
                        return
                    }
                    let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
                    let ciContext = CIContext()
                    guard let img = ciContext.createCGImage(ciImage, from: ciImage.extent) else {
                        completion(WireFormat.error("failed to create CGImage"))
                        return
                    }
                    cgImg = img
                }

                let originalWidth = cgImg.width
                let originalHeight = cgImg.height

                // resize at capture if requested.
                if targetMaxLongEdge > 0 {
                    let longEdge = max(originalWidth, originalHeight)
                    if longEdge > targetMaxLongEdge {
                        let scale = Double(targetMaxLongEdge) / Double(longEdge)
                        let newW = Int(Double(originalWidth) * scale)
                        let newH = Int(Double(originalHeight) * scale)
                        if let resized = Self.resize(cgImage: cgImg, width: newW, height: newH) {
                            cgImg = resized
                        }
                    }
                }

                // encode to png/jpeg/webp via CGImageDestination so we get
                // identical pipelines for all three formats (NSBitmapImageRep does not
                // support WebP).
                guard let data = Self.encode(cgImage: cgImg, format: format, quality: quality) else {
                    completion(WireFormat.error("failed to encode image as \(format)"))
                    return
                }

                let mimeType = format == "png" ? "image/png" : (format == "webp" ? "image/webp" : "image/jpeg")
                let ext = format == "png" ? "png" : (format == "webp" ? "webp" : "jpg")

                if save {
                    let filename = "interceptor-macos-screenshot-\(Int(Date().timeIntervalSince1970)).\(ext)"
                    let fileURL = resolveSaveURL(filename: filename, requestedCwd: requestedCwd)
                    try data.write(to: fileURL)
                    // when save:true, strip dataUrl from the response so
                    // downstream agents don't re-pay for the bytes inline. The filePath is
                    // sufficient — the agent can re-read the file when needed.
                    completion(WireFormat.success([
                        "filePath": fileURL.path,
                        "format": format,
                        "bytes": data.count,
                        "width": cgImg.width,
                        "height": cgImg.height,
                        "originalWidth": originalWidth,
                        "originalHeight": originalHeight
                    ]))
                } else {
                    let dataUrl = "data:\(mimeType);base64,\(data.base64EncodedString())"
                    completion(WireFormat.success([
                        "dataUrl": dataUrl,
                        "format": format,
                        "bytes": data.count,
                        "width": cgImg.width,
                        "height": cgImg.height,
                        "originalWidth": originalWidth,
                        "originalHeight": originalHeight
                    ]))
                }
            } catch {
                let errMsg = error.localizedDescription
                if errMsg.contains("3801") || errMsg.contains("declined") {
                    completion(WireFormat.error("Screen Recording permission required: System Settings → Privacy & Security → Screen Recording → Enable Interceptor"))
                } else {
                    completion(WireFormat.error("screenshot failed: \(errMsg)"))
                }
            }
        }
    }

    /// resize a CGImage via CoreGraphics. Bilinear-style filtering at
    /// `.high` interpolation quality. Returns nil on context-creation failure.
    /// Internal-default access so MonitorDomain's frame-capture path can
    /// reuse the same resize helper without duplicating the bitmap pipeline.
    static func resize(cgImage: CGImage, width: Int, height: Int) -> CGImage? {
        guard width > 0, height > 0 else { return nil }
        let bytesPerRow = 0
        let colorSpace = cgImage.colorSpace ?? CGColorSpaceCreateDeviceRGB()
        let bitmapInfo: UInt32 = CGImageAlphaInfo.premultipliedLast.rawValue
        guard let ctx = CGContext(
            data: nil,
            width: width, height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage()
    }

    /// encode a CGImage to png/jpeg/webp via CGImageDestination.
    /// WebP at q85 by default per academic evidence (ACAD-COMPRESS-BENCH).
    /// Internal-default access so MonitorDomain's frame-capture path can
    /// share this encoder instead of writing PNG via NSBitmapImageRep.
    static func encode(cgImage: CGImage, format: String, quality: Int) -> Data? {
        let utType: UTType
        switch format.lowercased() {
        case "png":  utType = .png
        case "webp":
            if #available(macOS 11.0, *), let webp = UTType("public.webp") ?? UTType("org.webmproject.webp") {
                utType = webp
            } else {
                return nil
            }
        default:     utType = .jpeg
        }

        let mutableData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            mutableData,
            utType.identifier as CFString,
            1, nil
        ) else { return nil }

        let q = max(0, min(100, quality))
        let opts: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: Float(q) / 100.0
        ]
        CGImageDestinationAddImage(dest, cgImage, opts as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return mutableData as Data
    }

    private func resolveSaveURL(filename: String, requestedCwd: String?) -> URL {
        let fm = FileManager.default

        let candidateDirs: [URL] = [
            requestedCwd.map { URL(fileURLWithPath: $0, isDirectory: true) },
            fm.urls(for: .downloadsDirectory, in: .userDomainMask).first,
            URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        ].compactMap { $0 }

        for dir in candidateDirs {
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue, fm.isWritableFile(atPath: dir.path) {
                return dir.appendingPathComponent(filename, isDirectory: false)
            }
        }

        return URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent(filename, isDirectory: false)
    }

    private func handleCapture(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? "frame"
        switch sub {
        case "start":
            startContinuousCapture(action, completion: completion)
        case "frame":
            handleFrame(action, completion: completion)
        case "status":
            // PRD-63 Spec 3: ground-truth state of the continuous-capture
            // pipeline. `active` reflects whether SCStream is registered;
            // `hasFrame` whether the cache holds a sample buffer; and
            // `frameAgeMs` how stale the cached frame is (omitted when
            // hasFrame == false).
            lock.lock()
            let active = (activeStream != nil) || testForcedActive
            let hasFrame = latestFrame != nil
            let ts = latestFrameTimestamp
            lock.unlock()
            var payload: [String: Any] = ["active": active, "hasFrame": hasFrame]
            if let ts = ts {
                payload["frameAgeMs"] = Int(Date().timeIntervalSince(ts) * 1000)
            }
            completion(WireFormat.success(payload))
        case "stop":
            lock.lock()
            activeStream?.stopCapture()
            activeStream = nil
            activeOutput = nil
            activeDelegate = nil
            latestFrame = nil
            latestFrameSize = nil
            latestFrameTimestamp = nil
            lock.unlock()
            completion(WireFormat.success("capture stopped"))
        default:
            notImplemented("capture \(sub)", completion: completion)
        }
    }

    private func handleFrame(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        // Configurable wait window for first-frame delivery. Apple's
        // SCStream.startCapture(completionHandler:) returns when the
        // stream "successfully starts" but the first frame arrives later
        // via SCStreamOutput.stream(_:didOutputSampleBuffer:of:). Empirical
        // measurements on macOS 14 show 1500-2000ms cold-start latency for
        // the first sample buffer; default to 3000ms with --timeout-ms
        // override to match what callers actually need.
        let timeoutMs = action["timeoutMs"] as? Int ?? 3000

        // Fast path: a frame is already buffered.
        lock.lock()
        let streamActive = (activeStream != nil) || testForcedActive
        let bufferedFrame = latestFrame
        let bufferedSize = latestFrameSize
        lock.unlock()

        if let frame = bufferedFrame {
            completion(WireFormat.success(Self.buildFramePayload(frame: frame, size: bufferedSize)))
            return
        }

        // No frame yet. Distinguish "stream not started" from "stream
        // started but the first sample buffer hasn't been delivered."
        if !streamActive {
            completion(WireFormat.error("capture not started — call macos capture start first"))
            return
        }

        // Stream is active. Block briefly waiting for the next frame.
        // Off the caller's queue so the bridge transport stays responsive.
        DispatchQueue.global().async { [weak self] in
            guard let self = self else {
                completion(WireFormat.error("capture domain released"))
                return
            }
            let result = self.frameReady.wait(timeout: .now() + .milliseconds(timeoutMs))
            self.lock.lock()
            let nextFrame = self.latestFrame
            let nextSize = self.latestFrameSize
            self.lock.unlock()
            if let nextFrame = nextFrame {
                completion(WireFormat.success(Self.buildFramePayload(frame: nextFrame, size: nextSize)))
            } else if result == .timedOut {
                completion(WireFormat.error("capture stream active but no frame in \(timeoutMs)ms — increase --timeout-ms or use screenshot instead"))
            } else {
                completion(WireFormat.error("capture stream active but no frame buffered"))
            }
        }
    }

    /// PRD-63 Spec 4: produce the metadata-rich frame payload that mirrors
    /// ScreenshotDomain's shape (`bytes`/`width`/`height`/`format`/`dataUrl`).
    /// Falls back to JPEG-header decode if a precomputed size isn't cached.
    static func buildFramePayload(frame: Data, size: CGSize?) -> [String: Any] {
        let resolvedSize = size ?? Self.decodeJPEGSize(frame) ?? .zero
        return [
            "dataUrl": "data:image/jpeg;base64,\(frame.base64EncodedString())",
            "bytes":   frame.count,
            "width":   Int(resolvedSize.width),
            "height":  Int(resolvedSize.height),
            "format":  "jpeg"
        ]
    }

    private func startContinuousCapture(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let appName = action["app"] as? String

        // Drain leftover semaphore signals from a prior run BEFORE
        // entering the async Task, since DispatchSemaphore.wait is
        // unavailable from async contexts under Swift strict concurrency.
        // Also clear any stale frame buffer.
        while frameReady.wait(timeout: .now()) == .success {}
        lock.withLock {
            latestFrame = nil
            latestFrameSize = nil
            latestFrameTimestamp = nil
        }

        Task {
            do {
                let content = try await SCShareableContent.current
                let filter: SCContentFilter
                // Track the size of the captured surface so we can set
                // SCStreamConfiguration.width/height. ScreenCaptureKit
                // refuses to deliver sample buffers if those are 0 (the
                // same gotcha the takeScreenshot path already handles).
                var captureWidth: Int = 0
                var captureHeight: Int = 0
                if let appName = appName,
                   let app = content.applications.first(where: { $0.applicationName == appName }),
                   let window = content.windows.first(where: { $0.owningApplication?.processID == app.processID }) {
                    // Explicit --app target: capture that app's first
                    // window via desktopIndependentWindow (works reliably
                    // for AppKit apps that own a normal NSWindow).
                    filter = SCContentFilter(desktopIndependentWindow: window)
                    captureWidth = Int(window.frame.width * 2)
                    captureHeight = Int(window.frame.height * 2)
                } else if let display = content.displays.first {
                    // No --app: default to display-mode capture. SCK's
                    // desktopIndependentWindow filter against the
                    // frontmost-app's window silently fails to deliver
                    // frames for many non-AppKit / Electron / terminal-
                    // host apps. Display-mode is universally reliable.
                    filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                    captureWidth = display.width * 2
                    captureHeight = display.height * 2
                } else {
                    completion(WireFormat.error("no capturable content"))
                    return
                }

                let config = SCStreamConfiguration()
                config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
                // Apple's capturing-screen-content-in-macos sample sets
                // these explicitly. Without them SCK silently delivers
                // empty buffers and the output callback never fires.
                if captureWidth > 0 { config.width = captureWidth }
                if captureHeight > 0 { config.height = captureHeight }

                let output = CaptureStreamOutput { [weak self] data in
                    guard let self = self else { return }
                    // Discard late-arriving sample buffers that fire
                    // after capture stop. SCK doesn't always cancel the
                    // delivery queue immediately when stopCapture is
                    // called, and we don't want a stale frame to leak
                    // out of `frame` after the user has stopped.
                    self.lock.withLock {
                        if self.activeStream != nil {
                            self.latestFrame = data
                            // PRD-63 Spec 3+4: cache the frame's pixel
                            // dimensions and ingest timestamp so handleFrame
                            // can return them in the metadata payload, and
                            // handleCapture("status") can report frame age.
                            self.latestFrameSize = Self.decodeJPEGSize(data)
                            self.latestFrameTimestamp = Date()
                        }
                    }
                    self.frameReady.signal()
                }

                // Pass a delegate so SCK's stream(_:didStopWithError:),
                // streamDidBecomeActive, and streamDidBecomeInactive
                // surface to stderr instead of vanishing silently. When
                // delegate is nil, SCK can drop the stream after
                // startCapture returns success and we never know.
                let delegate = CaptureStreamDelegateLogger()
                let stream = SCStream(filter: filter, configuration: config, delegate: delegate)
                try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue.global())
                try await stream.startCapture()

                // Strong-retain stream, output, AND delegate.
                // SCK's addStreamOutput doesn't keep the output alive,
                // SCStream(... delegate:) holds the delegate weakly per
                // Apple convention, and a deallocated delegate silently
                // kills error reporting.
                self.lock.withLock {
                    self.activeStream = stream
                    self.activeOutput = output
                    self.activeDelegate = delegate
                }

                completion(WireFormat.success("continuous capture started"))
            } catch {
                let msg = error.localizedDescription
                if msg.contains("3801") || msg.contains("declined") {
                    completion(WireFormat.error("Screen Recording permission required"))
                } else {
                    completion(WireFormat.error("capture start failed: \(msg)"))
                }
            }
        }
    }
}

@available(macOS 13.0, *)
final class CaptureStreamOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    private let onFrame: @Sendable (Data) -> Void

    init(onFrame: @escaping @Sendable (Data) -> Void) {
        self.onFrame = onFrame
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }

        // Per Apple's SCFrameStatus docs, SCK delivers buffers with one
        // of: complete, idle, blank, started, suspended, stopped. Only
        // .complete (and rarely .started) carries actual pixel data.
        // Static windows / unchanged display frames arrive as .idle —
        // the imageBuffer may be empty or absent. We must read the
        // status from the sample-buffer attachments and skip non-data
        // frames; otherwise we'd block forever on a stream whose only
        // delivery is .idle.
        if let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let attachments = attachmentsArray.first,
           let statusRawValue = attachments[.status] as? Int,
           let status = SCFrameStatus(rawValue: statusRawValue),
           status != .complete {
            // Frame is metadata-only (idle/blank/started/suspended/stopped).
            // Skip silently; the next .complete frame will drive onFrame.
            return
        }

        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ciImage = CIImage(cvPixelBuffer: imageBuffer)
        let context = CIContext()
        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)
        if let cgImage = context.createCGImage(ciImage, from: CGRect(x: 0, y: 0, width: width, height: height)) {
            let rep = NSBitmapImageRep(cgImage: cgImage)
            if let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.5]) {
                onFrame(data)
            }
        }
    }
}

// SCStreamDelegate logger. Surfaces SCK lifecycle errors that would
// otherwise vanish when delegate=nil. didStopWithError fires when
// ScreenCaptureKit kills the stream after startCapture returned
// success — this is the normal failure path for permission revocations,
// content-filter mismatches, and frame-delivery deadlocks.
@available(macOS 13.0, *)
final class CaptureStreamDelegateLogger: NSObject, SCStreamDelegate, @unchecked Sendable {
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Platform.log("SCK stream stopped with error: \(error.localizedDescription)")
    }

    func streamDidBecomeActive(_ stream: SCStream) {
        Platform.log("SCK stream became active")
    }

    func streamDidBecomeInactive(_ stream: SCStream) {
        Platform.log("SCK stream became inactive")
    }
}
