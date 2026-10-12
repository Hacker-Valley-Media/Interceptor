import Foundation
import Darwin
import GuestWire

enum GuestMount {
    static func mount(_ action: [String: Any]) -> [String: Any] {
        func failure(_ message: String) -> [String: Any] { ["success": false, "error": "mount: " + message] }
        guard let tag = action["tag"] as? String, tag.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", options: .regularExpression) == tag.startIndex..<tag.endIndex,
              let path = action["path"] as? String, path.hasPrefix("/"), path.utf8.count <= 4096, !path.contains("\0"),
              !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }) else { return failure("requires an exact tag and absolute path without traversal") }
        do {
            let deadline = try GuestWire.Deadline(seconds: min(45, GuestWire.requestBudget(action, defaultSeconds: 45)))
            for argv in [["/bin/mkdir", "-p", path], ["/sbin/mount", "-t", "virtiofs", tag, path]] {
                let result = GuestExecution.execute(["argv": argv, "timeout": try deadline.remaining()])
                guard result["success"] as? Bool == true, let data = result["data"] as? [String: Any],
                      let code = data["exitCode"] as? NSNumber, code.intValue == 0 else { return failure("owned command failed or its outcome is unknown: \(result["error"] as? String ?? ((result["data"] as? [String: Any])?["stderr"] as? String ?? "missing native exit")); inspect guest mount state before retrying") }
            }
            _ = try deadline.remaining()
            let actualPath = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
            var mounts: UnsafeMutablePointer<statfs>?
            let count = getmntinfo_r_np(&mounts, MNT_NOWAIT)
            guard count > 0, count <= 8192, let mounts else { if let mounts { free(mounts) }; return failure("native mount inventory unavailable or oversized after command") }
            defer { free(mounts) }
            var matches = 0
            for index in 0..<Int(count) {
                _ = try deadline.remaining()
                var info = mounts[index]
                func text<T>(_ tuple: inout T) -> String? {
                    withUnsafeBytes(of: &tuple) { raw in
                        guard let end = raw.firstIndex(of: 0) else { return nil }
                        return String(data: Data(raw.prefix(end)), encoding: .utf8)
                    }
                }
                if text(&info.f_mntonname) == actualPath && text(&info.f_mntfromname) == tag && text(&info.f_fstypename) == "virtiofs" { matches += 1 }
            }
            guard matches == 1, URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path == actualPath else { return failure("actual virtiofs tag/path mount readback is absent, ambiguous or changed; no success was inferred from exit0") }
            return ["success": true, "data": ["tag": tag, "path": path, "nativeMountPath": actualPath, "fileSystem": "virtiofs", "mounted": true]]
        } catch { return failure("deadline or native readback failed: \(error); inspect guest mount state before retrying") }
    }
}
