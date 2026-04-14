import Foundation

final class FilesDomain: DomainHandler, @unchecked Sendable {
    private var watchers: [String: DispatchSourceFileSystemObject] = [:]
    private let lock = NSLock()
    private var recentChanges: [[String: Any]] = []

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "watch":
            watchDirectory(action, completion: completion)
        case "recent":
            getRecentFiles(action, completion: completion)
        case "open":
            getOpenFiles(completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func watchDirectory(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String else {
            completion(WireFormat.error("watch requires a path"))
            return
        }
        let expandedPath = NSString(string: path).expandingTildeInPath
        let fd = open(expandedPath, O_EVTONLY)
        guard fd >= 0 else {
            completion(WireFormat.error("cannot open path: \(expandedPath)"))
            return
        }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete, .extend],
            queue: DispatchQueue.global()
        )
        source.setEventHandler { [weak self] in
            let event: [String: Any] = [
                "path": expandedPath,
                "timestamp": ISO8601DateFormatter().string(from: Date()),
                "event": "change"
            ]
            self?.lock.lock()
            self?.recentChanges.append(event)
            if (self?.recentChanges.count ?? 0) > 1000 {
                self?.recentChanges.removeFirst(500)
            }
            self?.lock.unlock()
            Platform.emitEvent("file_change", data: event)
        }
        source.setCancelHandler { close(fd) }
        source.resume()
        lock.lock()
        watchers[expandedPath] = source
        lock.unlock()
        completion(WireFormat.success(["watching": expandedPath]))
    }

    private func getRecentFiles(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let limit = action["limit"] as? Int ?? 20
        lock.lock()
        let recent = Array(recentChanges.suffix(limit))
        lock.unlock()
        completion(WireFormat.success(recent))
    }

    private func getOpenFiles(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        task.arguments = ["-c", "^com.apple", "+D", FileManager.default.homeDirectoryForCurrentUser.path, "-Fn"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice

        do {
            try task.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            let output = String(data: data, encoding: .utf8) ?? ""
            let files = output.split(separator: "\n")
                .filter { $0.hasPrefix("n/") }
                .map { String($0.dropFirst(1)) }
                .prefix(100)
            completion(WireFormat.success(Array(files)))
        } catch {
            completion(WireFormat.error("lsof failed: \(error.localizedDescription)"))
        }
    }
}
