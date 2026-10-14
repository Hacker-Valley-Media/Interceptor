import Foundation
import CoreFoundation
import Darwin

enum DesktopMonitorValidation {
    enum ArchiveError: Error {
        case refused(String), limit(String), missing
        var reply: [String: Any] {
            switch self {
            case .refused(let message): return ["success": false, "code": "permission_denied", "error": message]
            case .limit(let message): return ["success": false, "code": "resource_limit", "error": message]
            case .missing: return ["success": false, "code": "target_gone", "error": "monitor archive was not found"]
            }
        }
    }
    static func eventPayloadError(_ row: [String: Any]) -> String? {
        let event = row["event"] as? String ?? ""
        guard DesktopMonitorShape.macPayloadEvents.contains(event) else { return nil }
        if let error = DesktopMonitorShape.macPayloadShapeError(row) { return error }
        let counterKeys = ["evt", "mut", "net", "nav", "ax", "changeCount", "sl", "samples", "coalesced", "replayBuffers", "index", "bytes", "frames", "frameBudget", "diskCapBytes", "quality", "w", "h", "fps"]
        for key in counterKeys where row[key] is NSNumber {
            let minimum = ["samples", "coalesced", "index", "w", "h", "fps"].contains(key) ? 1.0 : 0.0
            if !DesktopFilesystemValidation.boundedInteger(row[key], minimum: minimum, maximum: 9007199254740991) { return "invalid monitor Mac payload counter" }
        }
        for key in ["duration", "durationSec"] where row[key] != nil {
            if let value = row[key] as? Double, !value.isFinite || value < 0 { return "invalid monitor Mac payload duration" }
        }
        for key in ["path", "archived"] {
            if let value = row[key] as? String, value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || value.contains("\0") { return "invalid monitor Mac payload path" }
        }
        if !DesktopFilesystemValidation.boundedInteger(row["pid"], minimum: 1, maximum: 2147483647) { return "invalid monitor Mac payload pid" }
        if event == "mon_start", let scope = row["scope"] as? [String: Any] {
            let apps = scope["apps"] as? [String]
            if scope["mode"] as? String == "apps" && (apps?.isEmpty ?? true) || apps?.contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || $0.contains("\0") }) == true { return "invalid monitor Mac payload scope" }
        }
        let axEvents: Set<String> = ["input", "focus", "window_focus", "selection", "title_change", "menu_open", "menu_close", "menu_select", "sheet", "layout_change", "selection_rows", "ax_app_activated", "ax_app_deactivated", "window_create", "window_move", "window_resize", "window_min", "window_demin", "ax_create", "ax_destroy", "ax_other"]
        if axEvents.contains(event) {
            if row["v"] != nil && event != "input" || row["sl"] != nil && event != "selection" || row["coalesced"] != nil && !["input", "layout_change"].contains(event) || row["notification"] != nil && event != "ax_other" || event == "ax_other" && row["notification"] as? String == nil { return "invalid monitor Mac AX fields" }
            let window = ["window_create", "window_move", "window_resize"].contains(event)
            if window != (row["frame"] != nil) { return "invalid monitor Mac AX frame" }
            if let frame = row["frame"] as? [String: Any] {
                for key in ["x", "y", "w", "h"] {
                    if !DesktopFilesystemValidation.boundedInteger(frame[key], minimum: ["w", "h"].contains(key) ? 0 : -9007199254740991, maximum: 9007199254740991) { return "invalid monitor Mac AX frame" }
                }
            }
            if event == "input", row["r"] as? String == "AXSecureTextField" || row["sr"] as? String == "AXSecureTextField", row["v"] as? String != "***SECURE***" { return "invalid monitor Mac secure value" }
        }
        let workspace: Set<String> = ["frontmost", "app_deactivate", "app_launch", "app_terminate", "app_hide", "app_unhide", "space", "mount", "unmount", "volume_rename", "wake", "sleep", "session_active", "session_inactive"]
        if workspace.contains(event), ["app", "bundleId", "pid"].contains(where: { row[$0] != nil }), !["app", "bundleId", "pid"].allSatisfy({ row[$0] != nil }) { return "incomplete monitor Mac workspace identity" }
        if row["tr"] != nil {
            if row["tr"] as? Bool != true || (row["app"] as? String ?? "").isEmpty && (row["bundleId"] as? String ?? "").isEmpty || row["tap"] != nil && row["tap"] as? Bool != true || row["tap"] as? Bool == true && (row["x"] == nil || row["y"] == nil) { return "invalid monitor Mac input identity" }
            for key in ["x", "y"] { if !DesktopFilesystemValidation.boundedInteger(row[key], minimum: -9007199254740991, maximum: 9007199254740991) { return "invalid monitor Mac input coordinates" } }
        }
        if let quality = row["quality"] as? Double, quality > 100 { return "invalid monitor Mac media quality" }
        if event == "video_start", let fps = row["fps"] as? Double, fps > 60 { return "invalid monitor Mac video fps" }
        if event == "ocr_text", let blocks = row["blocks"] as? [[String: Any]], let frame = row["frame"] as? String {
            if frame.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || frame.contains("\0") || blocks.count > 64 { return "invalid monitor Mac OCR payload" }
            for block in blocks {
                if let confidence = block["confidence"] as? Double, confidence < 0 || confidence > 1 { return "invalid monitor Mac OCR confidence" }
                for value in (block["rect"] as? [String: Double] ?? [:]).values where value < 0 || value > 1 { return "invalid monitor Mac OCR rectangle" }
            }
        }
        return nil
    }
    static func archiveMetadataError(_ row: [String: Any], sid: String) -> String? {
        var normalized = row
        if row["sid"] != nil && row["sid"] as? String != sid { return "invalid monitor archive identity" }
        normalized["sid"] = sid
        guard let bytes = try? JSONSerialization.data(withJSONObject: normalized),
              let meta = try? JSONDecoder().decode(DesktopMonitorArchiveData.self, from: bytes),
              safeSessionId(sid), meta.sessionId == sid, meta.surface.rawValue == "macos", meta.artifactVersion == 1, meta.tcc != nil else { return "invalid monitor archive shape/identity" }
        let integer: (Double) -> Bool = { $0.isFinite && $0 >= 0 && $0 <= 9007199254740991 && $0.rounded() == $0 }
        let text: (String) -> Bool = { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !$0.contains("\0") && $0.utf8.count <= 32768 }
        let names: ([String]) -> Bool = { $0.count <= 64 && Set($0).count == $0.count && $0.allSatisfy(text) }
        if !integer(meta.startedAt) || meta.endedAt.map({ !integer($0) || $0 < meta.startedAt }) == true || meta.status.rawValue == "active" && (meta.endedAt != nil || meta.stopReason != nil) || meta.status.rawValue == "stopped" && meta.endedAt == nil { return "invalid monitor archive lifecycle" }
        if [meta.counts.evt, meta.counts.mut, meta.counts.net, meta.counts.nav, meta.counts.ax].contains(where: { !integer($0) || $0 > meta.counts.evt }) { return "invalid monitor archive counters" }
        let apps = meta.scope.apps ?? []
        if !names(apps) || meta.scope.mode.rawValue == "apps" && apps.isEmpty || meta.scope.mode.rawValue != "apps" && !apps.isEmpty || !names(meta.includes) || !names(meta.excludes) { return "invalid monitor archive scope" }
        if meta.rootPid.map({ !integer($0) || $0 < 1 || $0 > 2147483647 }) == true || meta.attachments.count > DESKTOP_MONITOR_MAX_ENTRIES { return "invalid monitor archive attachments" }
        for attachment in meta.attachments {
            if !integer(attachment.pid) || attachment.pid < 1 || attachment.pid > 2147483647 || attachment.key != "pid:\(Int64(attachment.pid))" || !integer(attachment.attachedAt) || attachment.detachedAt.map({ !integer($0) || $0 < attachment.attachedAt }) == true || !names(attachment.axNotifications) { return "invalid monitor archive attachment" }
        }
        for key in ["instruction", "taskId", "taskActorAtAttach", "taskSourceSnapshotRoot", "stopReason"] {
            if let value = row[key] as? String, !text(value) { return "invalid monitor archive text" }
        }
        if meta.taskAttachedAt.map({ !integer($0) }) == true || meta.taskDetachedAt.map({ !integer($0) || meta.taskAttachedAt == nil || $0 < meta.taskAttachedAt! }) == true { return "invalid monitor archive task timestamps" }
        return nil
    }
    // Open each directory relative to its retained parent. A valid identifier
    // must not become an escape through a symlink, hard link or FIFO.
    static func readArchive(sid: String, file: String, maxBytes: Int) throws -> Data {
        guard safeSessionId(sid), ["events.jsonl", "session.json"].contains(file) else { throw ArchiveError.refused("unsafe monitor archive selector") }
        let root = Darwin.open(Platform.monitorSessionsDir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard root >= 0 else { throw errno == ENOENT ? ArchiveError.missing : ArchiveError.refused("monitor root cannot be opened safely") }
        defer { Darwin.close(root) }
        let directory = openat(root, sid, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw errno == ENOENT ? ArchiveError.missing : ArchiveError.refused("monitor archive directory cannot be opened safely") }
        defer { Darwin.close(directory) }
        var rootInfo = stat(), directoryInfo = stat()
        guard fstat(root, &rootInfo) == 0, fstat(directory, &directoryInfo) == 0, rootInfo.st_uid == geteuid(), directoryInfo.st_uid == geteuid() else { throw ArchiveError.refused("monitor archive directories must belong to this user") }
        let descriptor = openat(directory, file, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw errno == ENOENT ? ArchiveError.missing : ArchiveError.refused("monitor archive file cannot be opened safely") }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(), info.st_nlink == 1 else { throw ArchiveError.refused("monitor archive requires an owned regular file without links") }
        guard info.st_size >= 0, info.st_size <= maxBytes else { throw ArchiveError.limit("monitor archive exceeds its byte budget; original was preserved") }
        let bytes = try handle.read(upToCount: maxBytes + 1) ?? Data()
        guard bytes.count <= maxBytes else { throw ArchiveError.limit("monitor archive grew beyond its byte budget; original was preserved") }
        return bytes
    }
    static func safeSessionId(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", options: .regularExpression) == value.startIndex..<value.endIndex
    }
    static func archiveError(_ action: [String: Any]) -> String? {
        if ["tail", "export"].contains(action["sub"] as? String ?? ""), let sid = action["sid"] as? String, !safeSessionId(sid) { return "monitor --sid requires a safe archive identifier" }
        if let number = action["limit"] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() { return "monitor --limit requires an integer in 0..1000" }
        if !DesktopFilesystemValidation.boundedInteger(action["limit"], minimum: 0, maximum: Double(DESKTOP_MONITOR_MAX_ENTRIES)) { return "monitor --limit requires an integer in 0..1000" }
        return nil
    }
    static func validate(_ action: [String: Any]) -> [String: Any]? {
        guard action["type"] as? String == "desktop_monitor" else { return nil }
        if let error = DesktopMonitorShape.validationError(action) { return failure(error) }
        if let sid = action["sid"] as? String, !safeSessionId(sid) { return failure("monitor --sid requires a safe archive identifier") }
        if let error = archiveError(action) { return failure(error) }
        let sub = action["sub"] as! String
        if sub == "export", action["sid"] == nil { return failure("monitor export requires --sid") }
        if sub == "start", action["sid"] != nil { return failure("monitor start creates its own session identifier") }
        if action["limit"] != nil, !["tail", "list"].contains(sub) { return failure("monitor --limit requires tail or list") }
        if [action["app"], action["apps"], (action["allApps"] as? Bool == true) ? true : nil].compactMap({ $0 }).count > 1 { return failure("monitor app, apps and all-apps scopes are mutually exclusive") }
        let bounds: [String: (Double, Double)] = ["frames": (0, 60), "frameQuality": (0, 100), "frameMaxLongEdge": (0, 16384), "video": (1, 60), "videoMaxBytes": (0, 10737418240), "frameBudget": (0, 1000000), "frameDiskCap": (0, 10737418240), "framePixelScale": (1, 16), "scrollCoalesceMs": (0, 60000), "axCoalesceMs": (0, 60000)]
        for (key, bound) in bounds where !DesktopFilesystemValidation.boundedInteger(action[key], minimum: bound.0, maximum: bound.1) { return failure("monitor \(key) requires a bounded integer") }
        for key in ["app", "instruction", "watchPath", "logPredicate", "taskId", "taskRef", "retentionPolicyId", "guardPolicyId", "verifierPolicyId"] {
            if let value = action[key] as? String, value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || value.contains("\0") || value.utf8.count > 32768 { return failure("monitor \(key) requires bounded nonempty text without NUL") }
        }
        for key in ["apps", "include", "exclude", "watchPaths", "excludeApps"] {
            if let values = action[key] as? [String], values.isEmpty || values.count > 64 || Set(values).count != values.count || values.contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || $0.contains("\0") || $0.utf8.count > 32768 }) { return failure("monitor \(key) requires 1..64 unique bounded nonempty values") }
        }
        let startKeys = ["instruction", "app", "apps", "allApps", "include", "exclude", "frames", "visionText", "frameFormat", "frameQuality", "frameMaxLongEdge", "tap", "watchPath", "watchPaths", "logPredicate", "speechMode", "video", "videoMaxBytes", "frameBudget", "frameDiskCap", "framePixelScale", "scrollCoalesceMs", "axCoalesceMs", "includeSystemApps", "excludeApps", "taskId", "taskMode", "retentionPolicyId", "guardPolicyId", "verifierPolicyId"]
        if sub != "start", startKeys.contains(where: { action[$0] != nil }) { return failure("monitor recording options require start") }
        return nil
    }
    static func failure(_ message: String) -> [String: Any] { ["success": false, "code": "invalid_request", "error": String(message.prefix(512))] }
    static func bounded(_ result: [String: Any]) -> [String: Any] {
        guard let bytes = try? JSONSerialization.data(withJSONObject: result), bytes.count <= DESKTOP_MONITOR_MAX_RESULT_BYTES else {
            return ["success": false, "code": "resource_limit", "error": "monitor reply exceeds its 1MiB budget"]
        }
        return result
    }
}
