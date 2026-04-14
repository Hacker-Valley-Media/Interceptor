import Foundation
import AppKit

final class ClipboardDomain: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var history: [[String: Any]] = []
    private var lastChangeCount: Int = 0
    private var monitoring = false
    private var monitorTimer: DispatchSourceTimer?

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "read":
            readClipboard(action, completion: completion)
        case "write":
            writeClipboard(action, completion: completion)
        case "tail":
            startTail(completion: completion)
        case "history":
            getHistory(action, completion: completion)
        case "clear":
            clearClipboard(completion: completion)
        case "types":
            getTypes(completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func readClipboard(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let pb = NSPasteboard.general
        let typeFilter = action["contentType"] as? String ?? "text"

        switch typeFilter {
        case "text":
            if let text = pb.string(forType: .string) {
                completion(WireFormat.success(text))
            } else {
                completion(WireFormat.error("no text on clipboard"))
            }
        case "rtf":
            if let rtfData = pb.data(forType: .rtf),
               let rtfString = String(data: rtfData, encoding: .utf8) {
                completion(WireFormat.success(rtfString))
            } else {
                completion(WireFormat.error("no RTF on clipboard"))
            }
        case "image":
            if let imgData = pb.data(forType: .png) {
                let base64 = imgData.base64EncodedString()
                completion(WireFormat.success("data:image/png;base64," + base64))
            } else if let imgData = pb.data(forType: .tiff) {
                let base64 = imgData.base64EncodedString()
                completion(WireFormat.success("data:image/tiff;base64," + base64))
            } else {
                completion(WireFormat.error("no image on clipboard"))
            }
        case "files":
            if let urls = pb.readObjects(forClasses: [NSURL.self]) as? [URL] {
                let paths = urls.map { $0.path }
                completion(WireFormat.success(paths))
            } else {
                completion(WireFormat.error("no files on clipboard"))
            }
        default:
            completion(WireFormat.error("unknown type: \(typeFilter). Use: text, rtf, image, files"))
        }
    }

    private func writeClipboard(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let text = action["text"] as? String else {
            completion(WireFormat.error("write requires a text string"))
            return
        }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        completion(WireFormat.success("ok"))
    }

    private func startTail(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if monitoring {
            completion(WireFormat.success(["tailing": true, "note": "already monitoring"]))
            return
        }
        monitoring = true
        lastChangeCount = NSPasteboard.general.changeCount

        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        timer.schedule(deadline: .now(), repeating: .milliseconds(250))
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            let pb = NSPasteboard.general
            let current = pb.changeCount
            if current != self.lastChangeCount {
                self.lastChangeCount = current
                let entry: [String: Any] = [
                    "timestamp": ISO8601DateFormatter().string(from: Date()),
                    "changeCount": current,
                    "types": pb.types?.map { $0.rawValue } ?? [],
                    "preview": pb.string(forType: .string)?.prefix(200).description ?? ""
                ]
                self.lock.lock()
                self.history.append(entry)
                if self.history.count > 500 {
                    self.history.removeFirst(250)
                }
                self.lock.unlock()
                Platform.emitEvent("clipboard_change", data: entry)
            }
        }
        timer.resume()
        monitorTimer = timer
        completion(WireFormat.success(["tailing": true]))
    }

    private func getHistory(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let limit = action["limit"] as? Int ?? 50
        lock.lock()
        let recent = Array(history.suffix(limit))
        lock.unlock()
        completion(WireFormat.success(recent))
    }

    private func clearClipboard(completion: @escaping @Sendable ([String: Any]) -> Void) {
        NSPasteboard.general.clearContents()
        completion(WireFormat.success("ok"))
    }

    private func getTypes(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let types = NSPasteboard.general.types?.map { $0.rawValue } ?? []
        completion(WireFormat.success(types))
    }
}
