import Foundation

enum Platform {
    static let bridgeSocketPath = "/tmp/interceptor-bridge.sock"
    static let bridgePidPath = "/tmp/interceptor-bridge.pid"
    static let bridgeLogPath = "/tmp/interceptor-bridge.log"
    static let bridgeEventsPath = "/tmp/interceptor-bridge-events.jsonl"
    static let maxEventFileSize = 10 * 1024 * 1024

    // Monitor-session artifacts. The directory mirrors the browser's
    // shared/platform.ts contract (`MONITOR_SESSIONS_DIR`) so the existing
    // CLI in cli/commands/monitor.ts (which prefers session-local files)
    // works for macOS sessions without changes. The env var override matches
    // the CLI's INTERCEPTOR_MONITOR_SESSIONS_DIR lookup.
    static var monitorSessionsDir: String {
        if let override = ProcessInfo.processInfo.environment["INTERCEPTOR_MONITOR_SESSIONS_DIR"], !override.isEmpty {
            return override
        }
        return "/tmp/interceptor-monitor-sessions"
    }

    static func sessionDir(_ sid: String) -> String {
        return monitorSessionsDir + "/" + sid
    }

    static func sessionEventsPath(_ sid: String) -> String {
        return sessionDir(sid) + "/events.jsonl"
    }

    static func sessionMetaPath(_ sid: String) -> String {
        return sessionDir(sid) + "/session.json"
    }

    static func ensureSessionDir(_ sid: String) {
        let dir = sessionDir(sid)
        if !FileManager.default.fileExists(atPath: dir) {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        }
    }

    static func log(_ msg: String) {
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(msg)\n"
        if let data = line.data(using: .utf8) {
            if FileManager.default.fileExists(atPath: bridgeLogPath) {
                if let handle = FileHandle(forWritingAtPath: bridgeLogPath) {
                    handle.seekToEndOfFile()
                    handle.write(data)
                    handle.closeFile()
                }
            } else {
                FileManager.default.createFile(atPath: bridgeLogPath, contents: data)
            }
        }
    }

    static func writePID() {
        let pid = "\(ProcessInfo.processInfo.processIdentifier)\n"
        try? pid.write(toFile: bridgePidPath, atomically: true, encoding: .utf8)
    }

    static func cleanupSocket() {
        unlink(bridgeSocketPath)
    }

    // Only the latest-started instance owns the socket path and pid file: every
    // instance writes its pid (main.swift) before Transport unlinks + rebinds
    // the path, so the pid file always names the current owner. An older
    // instance that exits later (an orphan from a pre-0.23.24 install being
    // killed) must not take the live bridge's files with it.
    static func cleanup(socketPath: String = bridgeSocketPath, pidPath: String = bridgePidPath) {
        guard ownsBridgeFiles(pidPath: pidPath) else { return }
        unlink(socketPath)
        unlink(pidPath)
    }

    static func ownsBridgeFiles(pidPath: String = bridgePidPath, selfPid: pid_t = ProcessInfo.processInfo.processIdentifier) -> Bool {
        guard let raw = try? String(contentsOfFile: pidPath, encoding: .utf8) else { return true }
        let owner = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return owner.isEmpty || owner == "\(selfPid)"
    }

    static func emitEvent(_ event: String, data: [String: Any] = [:]) {
        var entry = data
        entry["timestamp"] = ISO8601DateFormatter().string(from: Date())
        entry["event"] = event
        guard let jsonData = try? JSONSerialization.data(withJSONObject: entry),
              let line = String(data: jsonData, encoding: .utf8) else { return }
        let content = line + "\n"
        if let data = content.data(using: .utf8) {
            if FileManager.default.fileExists(atPath: bridgeEventsPath) {
                if let handle = FileHandle(forWritingAtPath: bridgeEventsPath) {
                    handle.seekToEndOfFile()
                    handle.write(data)
                    handle.closeFile()
                }
            } else {
                FileManager.default.createFile(atPath: bridgeEventsPath, contents: data)
            }
        }
    }

    // appendMonitorEvent tees a single line to BOTH the rolling bridge
    // NDJSON (so `monitor tail` against /tmp/interceptor-bridge-events.jsonl
    // still works) AND the session-local events.jsonl. The CLI prefers the
    // session-local file when it exists, falling back to the rolling log.
    //
    // the actual disk I/O is delegated to MonitorEventWriter,
    // a single-writer serial queue with open-once FileHandles, so a scroll/AX
    // flood under `--all-apps` no longer performs blocking open→seek→write→close
    // on TWO files per event on the main run loop (which previously starved the
    // start/stop ack past the 15s client deadline). Returns true when the writer
    // is over its high-water mark (backpressure signal).
    @discardableResult
    static func appendMonitorEvent(sid: String, event: String, data: [String: Any] = [:]) -> Bool {
        var entry = data
        entry["event"] = event
        entry["sid"] = sid
        if entry["t"] == nil {
            entry["t"] = Int(Date().timeIntervalSince1970 * 1000)
        }
        if entry["timestamp"] == nil {
            entry["timestamp"] = ISO8601DateFormatter().string(from: Date())
        }
        guard let jsonData = try? JSONSerialization.data(withJSONObject: entry),
              let line = String(data: jsonData, encoding: .utf8) else { return false }
        let payload = (line + "\n").data(using: .utf8) ?? Data()
        ensureSessionDir(sid)
        return MonitorEventWriter.shared.enqueue(
            sessionPath: sessionEventsPath(sid),
            rollingPath: bridgeEventsPath,
            payload: payload
        )
    }

    /// Atomically write the session.json meta file.
    static func writeSessionMeta(sid: String, meta: [String: Any]) {
        ensureSessionDir(sid)
        guard let json = try? JSONSerialization.data(withJSONObject: meta, options: [.prettyPrinted]) else { return }
        let path = sessionMetaPath(sid)
        try? json.write(to: URL(fileURLWithPath: path), options: [.atomic])
    }
}

// non-blocking monitor event writer.
//
// Each monitor event was previously written with a synchronous
// open→seekToEnd→write→close on TWO files on the calling (main run-loop)
// thread. Under `--all-apps` AX/scroll volume that saturated the main thread
// and delayed the start/stop ack past the 15s client deadline. This writer
// moves all disk I/O to a dedicated serial queue, keeps the two target files
// open across the session, preserves submission order (serial queue), bounds
// the in-flight queue (backpressure signal), and exposes flush/close so a
// graceful SIGINT/SIGTERM (or `pause`/`stop`) durably persists what was
// captured.
final class MonitorEventWriter: @unchecked Sendable {
    static let shared = MonitorEventWriter()

    private let queue = DispatchQueue(label: "interceptor.monitor.writer", qos: .utility)
    private let lock = NSLock()
    private var handles: [String: FileHandle] = [:]
    private var pendingCount = 0
    // High-water mark for in-flight events. ~20k events is generous headroom
    // for any real human-teach session; crossing it means the producer is
    // outrunning the disk and the caller should shed the noisiest event kinds.
    private let highWaterMark = 20_000

    /// True when the in-flight queue is over the high-water mark — the producer
    /// is outrunning the disk and the caller should shed its noisiest events.
    var isOverHighWater: Bool {
        lock.lock(); defer { lock.unlock() }
        return pendingCount > highWaterMark
    }

    /// Enqueue a line for append to both the session file and the rolling
    /// bridge log. Returns true when the in-flight queue is over the high-water
    /// mark (backpressure).
    @discardableResult
    func enqueue(sessionPath: String, rollingPath: String, payload: Data) -> Bool {
        lock.lock()
        pendingCount += 1
        let over = pendingCount > highWaterMark
        lock.unlock()
        queue.async { [weak self] in
            guard let self = self else { return }
            self.appendLocked(path: rollingPath, data: payload)
            self.appendLocked(path: sessionPath, data: payload)
            self.lock.lock(); self.pendingCount -= 1; self.lock.unlock()
        }
        return over
    }

    // Must run on `queue`. Opens the handle once and appends.
    private func appendLocked(path: String, data: Data) {
        let handle: FileHandle
        if let existing = handles[path] {
            handle = existing
        } else {
            if !FileManager.default.fileExists(atPath: path) {
                FileManager.default.createFile(atPath: path, contents: nil)
            }
            guard let opened = FileHandle(forWritingAtPath: path) else { return }
            _ = try? opened.seekToEnd()
            handles[path] = opened
            handle = opened
        }
        do { try handle.write(contentsOf: data) } catch { /* drop on irrecoverable IO error */ }
    }

    /// Flush all buffered writes to disk. Drains the queue (sync barrier) then
    /// fsyncs each open handle. Safe to call from any thread except `queue`.
    func flush() {
        queue.sync {
            for (_, handle) in handles { try? handle.synchronize() }
        }
    }

    /// Close a single path's handle (used before rotating a session log so the
    /// next write re-opens the fresh file rather than the moved inode).
    func close(path: String) {
        queue.sync {
            if let handle = handles.removeValue(forKey: path) { try? handle.close() }
        }
    }

    /// Close every open handle (process shutdown).
    func closeAll() {
        queue.sync {
            for (_, handle) in handles { try? handle.close() }
            handles.removeAll()
        }
    }
}
