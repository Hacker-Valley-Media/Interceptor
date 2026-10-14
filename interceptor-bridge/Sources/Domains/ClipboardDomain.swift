import Foundation
import AppKit

final class ClipboardDomain: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var history: [[String: Any]] = []
    private var lastChangeCount: Int = 0
    private var monitoring = false
    private var monitorTimer: DispatchSourceTimer?
    private let pasteboard: NSPasteboard
    private let emitEvent: @Sendable (String, [String: Any]) -> Void

    init(pasteboard: NSPasteboard = .general,
         emitEvent: @escaping @Sendable (String, [String: Any]) -> Void = { Platform.emitEvent($0, data: $1) }) {
        self.pasteboard = pasteboard
        self.emitEvent = emitEvent
    }

    deinit { monitorTimer?.cancel() }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let failure = DesktopClipboardValidation.validate(action) { completion(failure); return }
        let originalType = action["type"] as? String ?? ""
        let sub = action["sub"] as? String ?? command
        let finish: @Sendable ([String: Any]) -> Void = {
            completion(DesktopClipboardValidation.normalize($0, action: ["type": originalType, "sub": sub]))
        }
        // Router sends command = "clipboard" because the action type is
        // two-segment (`macos_clipboard`). The CLI parser puts the real
        // sub-verb on action["sub"]. Mirror CompoundDomain's contract.
        if action["type"] as? String == "desktop_clipboard", ["read", "types", "tail"].contains(sub),
           pasteboard.name == NSPasteboard.Name.general, #available(macOS 15.4, *), pasteboard.accessBehavior != .alwaysAllow {
            // Read only the permission metadata. A neutral automation request
            // must not raise or bypass the user's pasteboard approval dialog.
            finish(DesktopClipboardValidation.failure("permission_denied", "Clipboard reading is not approved for this bridge. Set Interceptor's Clipboard access in System Settings before reading."))
            return
        }
        switch sub {
        case "read":
            readClipboard(action, completion: finish)
        case "write":
            writeClipboard(action, completion: finish)
        case "tail":
            startTail(completion: finish)
        case "history":
            getHistory(action, completion: finish)
        case "clear":
            clearClipboard(completion: finish)
        case "types":
            getTypes(completion: finish)
        default:
            notImplemented(sub, completion: finish)
        }
    }

    private func readClipboard(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let pb = pasteboard
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
        let pb = pasteboard
        pb.clearContents()
        let written = pb.setString(text, forType: .string)
        if action["type"] as? String == "desktop_clipboard", !written {
            completion(DesktopClipboardValidation.failure("partial_result", "clipboard cleared but text was not set; observe before retrying"))
            return
        }
        completion(WireFormat.success("ok"))
    }

    private func startTail(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        if monitoring {
            lock.unlock()
            completion(WireFormat.success(["tailing": true, "note": "already monitoring"]))
            return
        }
        monitoring = true
        lastChangeCount = pasteboard.changeCount

        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        timer.schedule(deadline: .now(), repeating: .milliseconds(250))
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            let pb = self.pasteboard
            let current = pb.changeCount
            self.lock.lock()
            if current != self.lastChangeCount {
                self.lastChangeCount = current
                self.lock.unlock()
                let entry: [String: Any] = [
                    "timestamp": ISO8601DateFormatter().string(from: Date()),
                    "changeCount": current,
                    "types": pb.types?.map { $0.rawValue } ?? [],
                    "preview": pb.string(forType: .string)?.prefix(DESKTOP_CLIPBOARD_PREVIEW_CHARACTERS).description ?? ""
                ]
                self.lock.lock()
                self.history.append(entry)
                if self.history.count > DESKTOP_CLIPBOARD_HISTORY_LIMIT {
                    self.history.removeFirst(250)
                }
                self.lock.unlock()
                self.emitEvent("clipboard_change", entry)
            } else { self.lock.unlock() }
        }
        timer.resume()
        monitorTimer = timer
        lock.unlock()
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
        pasteboard.clearContents()
        completion(WireFormat.success("ok"))
    }

    private func getTypes(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let types = pasteboard.types?.map { $0.rawValue } ?? []
        completion(WireFormat.success(types))
    }
}
