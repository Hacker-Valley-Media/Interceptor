import Foundation

enum Platform {
    static let bridgeSocketPath = "/tmp/interceptor-bridge.sock"
    static let bridgePidPath = "/tmp/interceptor-bridge.pid"
    static let bridgeLogPath = "/tmp/interceptor-bridge.log"
    static let bridgeEventsPath = "/tmp/interceptor-bridge-events.jsonl"
    static let maxEventFileSize = 10 * 1024 * 1024

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

    static func cleanup() {
        unlink(bridgeSocketPath)
        unlink(bridgePidPath)
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
}
