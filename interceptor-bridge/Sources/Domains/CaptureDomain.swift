import Foundation
@preconcurrency import ScreenCaptureKit
import AppKit
import CoreMedia

final class CaptureDomain: DomainHandler, @unchecked Sendable {
    private var activeStream: SCStream?
    private var latestFrame: Data?
    private let lock = NSLock()

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
        let format = action["format"] as? String ?? "jpeg"
        let quality = action["quality"] as? Int ?? 80
        let displayId = action["display"] as? Int
        let windowId = action["window"] as? Int

        Task {
            do {
                let content = try await SCShareableContent.current
                var filter: SCContentFilter

                if let appName = appName {
                    guard let app = content.applications.first(where: { $0.applicationName == appName }) else {
                        completion(WireFormat.error("app not found: \(appName)"))
                        return
                    }
                    filter = SCContentFilter(desktopIndependentWindow: content.windows.first(where: { $0.owningApplication?.applicationName == appName }) ?? content.windows[0])
                } else if let displayId = displayId,
                          let display = content.displays.first(where: { Int($0.displayID) == displayId }) {
                    filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                } else if let windowId = windowId,
                          let window = content.windows.first(where: { Int($0.windowID) == windowId }) {
                    filter = SCContentFilter(desktopIndependentWindow: window)
                } else {
                    // Frontmost app's first window
                    let frontApp = NSWorkspace.shared.frontmostApplication
                    if let frontPid = frontApp?.processIdentifier,
                       let scApp = content.applications.first(where: { $0.processID == frontPid }),
                       let window = content.windows.first(where: { $0.owningApplication?.processID == frontPid }) {
                        filter = SCContentFilter(desktopIndependentWindow: window)
                    } else if let display = content.displays.first {
                        filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                    } else {
                        completion(WireFormat.error("no capturable content found"))
                        return
                    }
                }

                let config = SCStreamConfiguration()
                let sampleBuffer = try await SCScreenshotManager.captureSampleBuffer(contentFilter: filter, configuration: config)
                guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
                    completion(WireFormat.error("failed to get pixel buffer"))
                    return
                }
                let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
                let ciContext = CIContext()
                guard let cgImg = ciContext.createCGImage(ciImage, from: ciImage.extent) else {
                    completion(WireFormat.error("failed to create CGImage"))
                    return
                }
                let rep = NSBitmapImageRep(cgImage: cgImg)
                let imageData: Data?
                if format == "png" {
                    imageData = rep.representation(using: .png, properties: [:])
                } else {
                    imageData = rep.representation(using: .jpeg, properties: [.compressionFactor: NSNumber(value: Float(quality) / 100.0)])
                }

                guard let data = imageData else {
                    completion(WireFormat.error("failed to encode image"))
                    return
                }

                let base64 = data.base64EncodedString()
                let mimeType = format == "png" ? "image/png" : "image/jpeg"
                let dataUrl = "data:\(mimeType);base64,\(base64)"

                if save {
                    let ext = format == "png" ? "png" : "jpg"
                    let filename = "interceptor-macos-screenshot-\(Int(Date().timeIntervalSince1970)).\(ext)"
                    let path = FileManager.default.currentDirectoryPath + "/" + filename
                    try data.write(to: URL(fileURLWithPath: path))
                    completion(WireFormat.success(["dataUrl": dataUrl, "filePath": path, "format": format, "bytes": data.count]))
                } else {
                    completion(WireFormat.success(["dataUrl": dataUrl, "format": format, "bytes": data.count]))
                }
            } catch {
                let errMsg = error.localizedDescription
                if errMsg.contains("3801") || errMsg.contains("declined") {
                    completion(WireFormat.error("Screen Recording permission required: System Settings → Privacy & Security → Screen Recording → Enable interceptor-bridge"))
                } else {
                    completion(WireFormat.error("screenshot failed: \(errMsg)"))
                }
            }
        }
    }

    private func handleCapture(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? "frame"
        switch sub {
        case "start":
            startContinuousCapture(action, completion: completion)
        case "frame":
            lock.lock()
            let frame = latestFrame
            lock.unlock()
            if let frame = frame {
                completion(WireFormat.success(["dataUrl": "data:image/jpeg;base64,\(frame.base64EncodedString())"]))
            } else {
                completion(WireFormat.error("no active capture stream — use screenshot instead"))
            }
        case "stop":
            lock.lock()
            activeStream?.stopCapture()
            activeStream = nil
            latestFrame = nil
            lock.unlock()
            completion(WireFormat.success("capture stopped"))
        default:
            notImplemented("capture \(sub)", completion: completion)
        }
    }

    private func startContinuousCapture(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let appName = action["app"] as? String
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
                    completion(WireFormat.error("no capturable content"))
                    return
                }

                let config = SCStreamConfiguration()
                config.minimumFrameInterval = CMTime(value: 1, timescale: 30)

                let output = CaptureStreamOutput { [weak self] data in
                    self?.lock.withLock { self?.latestFrame = data }
                }

                let stream = SCStream(filter: filter, configuration: config, delegate: nil)
                try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue.global())
                try await stream.startCapture()

                self.lock.withLock { self.activeStream = stream }

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
        guard type == .screen, let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
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
