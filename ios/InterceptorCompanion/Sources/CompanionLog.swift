//
//  CompanionLog.swift — one shared on-device log for InterceptorCompanion.
//
//  A DDI mount that fails on a phone far from any Mac needs a breadcrumb trail
//  the person can read on the device. Writes are SYNCHRONOUS (serialized by a
//  lock) so a line survives even when `devicectl --console` terminates the app a
//  moment after it logs. The file is in the app's own Documents, pullable with
//  `devicectl device copy from --domain-type appDataContainer`.
//

import Foundation

enum CompanionLog {
    private static let lock = NSLock()

    private static var fileURL: URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
            .first?.appendingPathComponent("companion.log")
    }

    static func log(_ message: String) {
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
        NSLog("InterceptorCompanion: %@", message)
        guard let url = fileURL, let data = line.data(using: .utf8) else { return }
        lock.lock(); defer { lock.unlock() }
        if let h = try? FileHandle(forWritingTo: url) {
            defer { try? h.close() }
            try? h.seekToEnd()
            try? h.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }

    static func tail(_ lines: Int = 200) -> String {
        guard let url = fileURL, let text = try? String(contentsOf: url, encoding: .utf8) else { return "(no log yet)" }
        return text.split(separator: "\n").suffix(lines).joined(separator: "\n")
    }
}

func icLog(_ message: String) { CompanionLog.log(message) }
