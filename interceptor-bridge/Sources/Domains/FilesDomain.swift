import Foundation
import Darwin

final class FilesDomain: DomainHandler, @unchecked Sendable {
    private struct Watch { let generation: UUID; let source: DispatchSourceFileSystemObject }
    private var watchers: [String: Watch] = [:]
    private let lock = NSLock()
    private var recentChanges: [(entry: [String: Any], bytes: Int)] = []
    private var historyBytes = 0
    private var eventFD: Int32 = -1
    private var eventError: String?
    private let runtimeDir: String
    private let eventPath: String

    init(runtimeDir: String = Platform.runtimeDir) {
        self.runtimeDir = runtimeDir
        self.eventPath = runtimeDir + "/interceptor-files-events.jsonl"
    }

    deinit {
        for watch in watchers.values { watch.source.cancel() }
        if eventFD >= 0 { close(eventFD) }
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let failure = DesktopFilesValidation.validate(action) { completion(failure); return }
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "watch": watchDirectory(action, completion: completion)
        case "unwatch":
            guard let raw = action["path"] as? String, DesktopFilesystemValidation.validPath(raw) else {
                completion(DesktopFilesValidation.failure("invalid_request", "unwatch requires a path")); return
            }
            let path = (NSString(string: raw).expandingTildeInPath as NSString).standardizingPath
            lock.lock()
            let old = watchers.removeValue(forKey: path)
            old?.source.cancel()
            lock.unlock()
            completion(WireFormat.success(["path": path, "removed": old != nil]))
        case "recent": getRecentFiles(action, completion: completion)
        case "open": getOpenFiles(action, completion: completion)
        default: notImplemented(sub, completion: completion)
        }
    }

    private func openEventLog() -> Bool {
        if eventFD >= 0 { return eventError == nil }
        var parent = stat()
        guard lstat(runtimeDir, &parent) == 0, parent.st_mode & S_IFMT == S_IFDIR,
              parent.st_uid == getuid(), parent.st_mode & 0o777 == 0o700 else {
            eventError = "file event directory must be owned and private (0700)"; return false
        }
        let fd = open(eventPath, O_RDWR | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { eventError = "private file event log is unavailable"; return false }
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_uid == getuid(), metadata.st_mode & 0o777 == 0o600, metadata.st_nlink == 1 else {
            close(fd); eventError = "file event log must be an owned private regular file with one link"; return false
        }
        eventFD = fd; eventError = nil
        return true
    }

    private func record(path: String, generation: UUID) {
        lock.lock(); defer { lock.unlock() }
        guard watchers[path]?.generation == generation, eventError == nil else { return }
        let event: [String: Any] = ["path": path, "timestamp": ISO8601DateFormatter().string(from: Date()), "event": "change"]
        guard var bytes = try? JSONSerialization.data(withJSONObject: event) else { eventError = "file event serialization failed"; return }
        bytes.append(10)
        var metadata = stat()
        guard fstat(eventFD, &metadata) == 0 else { eventError = "file event log identity is unavailable"; return }
        if metadata.st_size + off_t(bytes.count) > DESKTOP_FILES_MAX_EVENT_BYTES, ftruncate(eventFD, 0) != 0 {
            eventError = "file event log could not be rotated"; return
        }
        let written = bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(eventFD, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { return false }
                offset += count
            }
            return true
        }
        guard written else { eventError = "file event recording failed"; return }
        recentChanges.append((event, bytes.count)); historyBytes += bytes.count
        while recentChanges.count > DESKTOP_FILES_MAX_RECENT || historyBytes + 2 > DESKTOP_FILES_MAX_HISTORY_BYTES {
            historyBytes -= recentChanges.removeFirst().bytes
        }
        if runtimeDir == Platform.runtimeDir { Platform.emitEvent("file_change", data: event) }
    }

    private func watchDirectory(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let raw = action["path"] as? String, DesktopFilesystemValidation.validPath(raw) else {
            completion(DesktopFilesValidation.failure("invalid_request", "watch requires a path")); return
        }
        let path = (NSString(string: raw).expandingTildeInPath as NSString).standardizingPath
        lock.lock(); defer { lock.unlock() }
        guard watchers[path] != nil || watchers.count < DESKTOP_FILES_MAX_WATCHES else {
            completion(DesktopFilesValidation.failure("resource_limit", "file watch limit 64 reached")); return
        }
        let fd = open(path, O_EVTONLY | O_CLOEXEC)
        guard fd >= 0 else {
            completion(DesktopFilesValidation.failure(errno == ENOENT ? "target_gone" : "permission_denied", "cannot open watch path: \(path)")); return
        }
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, [S_IFREG, S_IFDIR].contains(metadata.st_mode & S_IFMT) else {
            close(fd); completion(DesktopFilesValidation.failure("unsupported_target", "watch requires a regular file or directory")); return
        }
        guard openEventLog() else { close(fd); completion(DesktopFilesValidation.failure("permission_denied", eventError!)); return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete, .extend], queue: DispatchQueue.global())
        let generation = UUID()
        source.setEventHandler { [weak self] in self?.record(path: path, generation: generation) }
        source.setCancelHandler { close(fd) }
        let old = watchers.updateValue(Watch(generation: generation, source: source), forKey: path)
        old?.source.cancel()
        source.resume()
        completion(WireFormat.success(["watching": path, "eventPath": eventPath]))
    }

    private func getRecentFiles(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard DesktopFilesystemValidation.boundedInteger(action["limit"], minimum: 0, maximum: Double(DESKTOP_FILES_MAX_RECENT)) else {
            completion(DesktopFilesValidation.failure("invalid_request", "file history limit must be an integer in 0..1000")); return
        }
        let limit = (action["limit"] as? NSNumber)?.intValue ?? 20
        lock.lock(); defer { lock.unlock() }
        if let error = eventError { completion(DesktopFilesValidation.failure("provider_failed", error)); return }
        completion(WireFormat.success(recentChanges.suffix(limit).map(\.entry)))
    }

    // A busy login's lsof inventory runs past 1 MiB (2.8 MB on the test Mac); replies stay capped at DESKTOP_FILES_MAX_OPEN.
    private static let lsofCaptureBytes = 64 * 1024 * 1024
    private func getOpenFiles(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard DesktopFilesystemValidation.boundedInteger(action["limit"], minimum: 0, maximum: Double(DESKTOP_FILES_MAX_OPEN)),
              DesktopFilesystemValidation.boundedInteger(action["pid"], minimum: 1, maximum: Double(Int32.max)) else {
            completion(DesktopFilesValidation.failure("invalid_request", "open file selectors require bounded integers")); return
        }
        let neutral = action["type"] as? String == "desktop_files"
        let limit = (action["limit"] as? NSNumber)?.intValue ?? DESKTOP_FILES_MAX_OPEN
        let pid = (action["pid"] as? NSNumber)?.int32Value
        var identity = proc_bsdinfo()
        if let pid {
            errno = 0
            guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &identity, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size) else {
                let code = errno == EPERM || errno == EACCES ? "permission_denied" : errno == ESRCH || errno == ENOENT ? "target_gone" : "provider_failed"
                completion(DesktopFilesValidation.failure(code, "open file target kernel identity is unavailable")); return
            }
            guard identity.pbi_uid == getuid() else {
                completion(DesktopFilesValidation.failure("permission_denied", "open file target requires the current user")); return
            }
        }
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(DESKTOP_FILES_DEADLINE_MS) * 1_000_000
        var args = ["-nlP", "-a", "-u", String(getuid()), "-Fnf"]
        if let pid { args += ["-p", String(pid)] }
        let result: Result<(Int32, Data, Data), ContainerDomain.ExecutionError> = limit == 0 ? .success((0, Data(), Data())) : ContainerDomain.capture("/usr/sbin/lsof", args, deadline: deadline, limit: Self.lsofCaptureBytes)
        switch result {
        case .failure(let error):
            let code: String, text: String
            switch error {
            case .timeout: code = "resource_limit"; text = "open file helper exceeded five seconds and was terminated"
            case .limit: code = "resource_limit"; text = "open file helper output exceeded 64 MiB and was terminated"
            case .failed(let message): code = "provider_failed"; text = message
            }
            completion(DesktopFilesValidation.failure(code, text))
        case .success(let (code, bytes, _)):
            guard code == 0 || code == 1, let output = String(data: bytes, encoding: .utf8) else {
                completion(DesktopFilesValidation.failure("provider_failed", "lsof inventory failed or was not UTF8")); return
            }
            if let pid {
                var after = proc_bsdinfo()
                errno = 0
                guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size) else {
                    let code = errno == EPERM || errno == EACCES ? "permission_denied" : errno == ESRCH || errno == ENOENT ? "target_gone" : "provider_failed"
                    completion(DesktopFilesValidation.failure(code, "open file target kernel identity became unavailable")); return
                }
                guard identity.pbi_start_tvsec == after.pbi_start_tvsec, identity.pbi_start_tvusec == after.pbi_start_tvusec,
                      after.pbi_uid == getuid() else {
                    completion(DesktopFilesValidation.failure("target_gone", "open file process creation changed during inventory")); return
                }
            }
            // A busy login runs past the bounds; inspect up to them and report the rest as skipped (partial coverage).
            var lines: [Substring] = [], processCount = 0, handleCount = 0
            let allLines = output.split(separator: "\n")
            for line in allLines {
                if line.hasPrefix("p") { if processCount == DESKTOP_FILES_MAX_PROCESSES { break }; processCount += 1 }
                else if line.hasPrefix("f") { if handleCount == DESKTOP_FILES_MAX_HANDLES { break }; handleCount += 1 }
                lines.append(line)
            }
            let skippedProcesses = allLines.filter { $0.hasPrefix("p") }.count - processCount
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            var seen = Set<String>()
            let all = lines.compactMap { line -> String? in
                guard line.hasPrefix("n/") else { return nil }
                let path = String(line.dropFirst())
                guard DesktopFilesystemValidation.validPath(path), !path.hasSuffix(" (deleted)"),
                      path == home || path.hasPrefix(home + "/") || path.hasPrefix("/Volumes/") || path.hasPrefix("/Applications/"),
                      !path.contains(".framework/"), !path.contains(".dylib"), seen.insert(path).inserted else { return nil }
                return path
            }
            let files = Array(all.prefix(limit))
            if !neutral { completion(WireFormat.success(files)); return }
            // lsof cannot prove that every driver supplied a name.
            completion(WireFormat.success(["files": files, "count": files.count, "partial": true, "scope": "current-user",
                "processesInspected": processCount, "handlesInspected": handleCount, "skippedProcesses": skippedProcesses,
                "reason": "lsof names only accessible current-user file handles; user-file filtering and the requested count can omit entries"] as [String: Any]))
        }
    }
}
