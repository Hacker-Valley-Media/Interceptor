import Foundation
import Darwin
import CoreFoundation
import CryptoKit
import GuestWire

enum GuestFiles {
    static let maxBytes = 1_048_576

    private struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ message: String) { description = message }
    }

    /// Retain the selected parent and final file. Parent symlinks (such as
    /// /tmp) can resolve at admission; the final component never follows one.
    final class File {
        let path: String, name: String
        let directory: Int32, descriptor: Int32
        init(path: String, create: Bool) throws {
            guard path.hasPrefix("/"), path.utf8.count <= 8192, !path.contains("\0"),
                  !path.hasSuffix("/"), !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else {
                throw Failure("copy requires an exact bounded absolute file path")
            }
            self.path = path
            name = (path as NSString).lastPathComponent
            // Open into locals: a throw after every stored property is set runs deinit, which would close them again.
            let parent = Darwin.open((path as NSString).deletingLastPathComponent, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
            guard parent >= 0 else { throw Failure("copy parent must already exist and be accessible") }
            let flags = O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (create ? O_RDWR | O_CREAT | O_EXCL : O_RDONLY)
            let file = Darwin.openat(parent, name, flags, 0o600)
            guard file >= 0 else {
                Darwin.close(parent)
                throw Failure(create ? "exclusive guest creation refused; existing destinations are preserved" : "guest source cannot be opened without following its final symlink")
            }
            directory = parent; descriptor = file
        }
        deinit { Darwin.close(descriptor); Darwin.close(directory) }

        func metadata() throws -> stat {
            var held = stat(), named = stat(), absolute = stat()
            guard Darwin.fstat(descriptor, &held) == 0, held.st_mode & S_IFMT == S_IFREG,
                  held.st_nlink > 0, held.st_size >= 0, held.st_size <= maxBytes,
                  Darwin.fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
                  Darwin.lstat(path, &absolute) == 0,
                  GuestFiles.same(held, named), GuestFiles.same(held, absolute) else {
                throw Failure("retained regular guest file or exact destination identity changed")
            }
            return held
        }

        func read(deadline: GuestWire.Deadline) throws -> Data {
            let before = try metadata()
            var data = Data(), chunk = [UInt8](repeating: 0, count: 65_536)
            while true {
                _ = try deadline.remaining()
                let count = chunk.withUnsafeMutableBytes { Darwin.pread(descriptor, $0.baseAddress, $0.count, off_t(data.count)) }
                if count < 0, errno == EINTR { continue }
                guard count >= 0 else { throw Failure("retained guest file read failed: \(errno)") }
                if count == 0 { break }
                guard data.count + count <= maxBytes else { throw Failure("guest file grew past 1MiB") }
                data.append(contentsOf: chunk.prefix(count))
            }
            let after = try metadata()
            guard GuestFiles.same(before, after), Int(after.st_size) == data.count else {
                throw Failure("guest source changed during retained byte readback")
            }
            return data
        }

        func write(_ data: Data, mode: mode_t, deadline: GuestWire.Deadline) throws {
            try data.withUnsafeBytes { bytes in
                var offset = 0
                while offset < data.count {
                    _ = try deadline.remaining()
                    let count = Darwin.pwrite(descriptor, bytes.baseAddress!.advanced(by: offset), data.count - offset, off_t(offset))
                    if count < 0, errno == EINTR { continue }
                    guard count > 0 else { throw Failure("guest write failed; partial file retained: \(errno)") }
                    offset += count
                }
            }
            _ = try deadline.remaining()
            guard Darwin.fchmod(descriptor, mode) == 0, Darwin.fsync(descriptor) == 0 else {
                throw Failure("guest mode or sync failed; partial file retained")
            }
            let held = try metadata()
            guard held.st_mode & 0o7777 == mode, held.st_nlink == 1,
                  try read(deadline: deadline) == data else {
                throw Failure("guest mode, links or retained bytes differ; destination retained")
            }
        }
    }

    private static func same(_ left: stat, _ right: stat) -> Bool {
        left.st_dev == right.st_dev && left.st_ino == right.st_ino && left.st_mode == right.st_mode &&
        left.st_nlink == right.st_nlink && left.st_size == right.st_size &&
        left.st_mtimespec.tv_sec == right.st_mtimespec.tv_sec && left.st_mtimespec.tv_nsec == right.st_mtimespec.tv_nsec &&
        left.st_ctimespec.tv_sec == right.st_ctimespec.tv_sec && left.st_ctimespec.tv_nsec == right.st_ctimespec.tv_nsec
    }
    private static func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    private static func deadline(_ action: [String: Any]) throws -> GuestWire.Deadline {
        try GuestWire.Deadline(seconds: GuestWire.requestBudget(action, defaultSeconds: 50))
    }

    static func copyIn(_ action: [String: Any]) -> [String: Any] {
        var created = false
        do {
            let budget = try deadline(action)
            guard let path = action["path"] as? String, let text = action["dataBase64"] as? String,
                  text.utf8.count <= 1_398_104, let data = Data(base64Encoded: text), data.count <= maxBytes,
                  data.base64EncodedString() == text else { throw Failure("cp_in requires canonical bytes within 1MiB") }
            var mode: mode_t = 0o600
            if let supplied = action["mode"] {
                guard let text = supplied as? String, (3...4).contains(text.utf8.count), text.allSatisfy({ "01234567".contains($0) }),
                      let parsed = UInt16(text, radix: 8), parsed <= 0o777 else { throw Failure("guest file mode must be ordinary octal permissions") }
                mode = mode_t(parsed)
            }
            _ = try budget.remaining()
            let file = try File(path: path, create: true)
            created = true
            try file.write(data, mode: mode, deadline: budget)
            _ = try budget.remaining()
            return ["success": true, "data": ["path": path, "bytes": data.count, "sha256": hash(data), "verified": true, "overwrite": false]]
        } catch {
            return ["success": false, "error": "cp_in: \(error)", "mutationSubmitted": created,
                    "partialArtifactPossible": created, "observeBeforeRetry": created]
        }
    }

    static func copyOut(_ action: [String: Any]) -> [String: Any] {
        do {
            let budget = try deadline(action)
            guard let path = action["path"] as? String else { throw Failure("cp_out requires path") }
            let data = try File(path: path, create: false).read(deadline: budget)
            _ = try budget.remaining()
            return ["success": true, "data": ["path": path, "bytes": data.count, "dataBase64": data.base64EncodedString(), "sha256": hash(data), "verified": true]]
        } catch { return ["success": false, "error": "cp_out: \(error)"] }
    }
}
