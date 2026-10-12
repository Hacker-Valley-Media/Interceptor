// container_run — sandboxed Linux escape hatch via Apple's
// `container` runtime (macOS 26+). This is the full implementation:
// when `/usr/local/bin/container` is present, we execute the requested
// image+command in an ephemeral container (--rm), with mounts, env,
// network policy, and timeout, and return structured stdout/stderr.
//
// stdout/stderr are drained concurrently via `readabilityHandler`
// while the child runs, and the response is resolved from
// `task.terminationHandler` — never via `waitUntilExit` followed by
// `readDataToEndOfFile`, which is the documented Foundation/Pipe deadlock
// pattern when a child writes more than the OS pipe buffer (~16–64 KB)
// before exiting (apple-developer-docs/Foundation/Process/waitUntilExit
// + apple-developer-docs/Foundation/FileHandle/readabilityHandler).

import Foundation
import Darwin

final class ContainerDomain: DomainHandler, @unchecked Sendable {
    private static let candidatePaths: [String] = [
        "/opt/homebrew/bin/container",       // Apple silicon Homebrew (default)
        "/usr/local/bin/container",          // Intel Homebrew / direct .pkg install
        "/Applications/container.app/Contents/MacOS/container", // future GUI wrapper
    ]

    static func resolveBinary() -> String? {
        if let envOverride = ProcessInfo.processInfo.environment["INTERCEPTOR_CONTAINER_BIN"],
           FileManager.default.isExecutableFile(atPath: envOverride) {
            return envOverride
        }
        for p in candidatePaths {
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "run":
            handleRun(action, completion: completion)
        default:
            completion(WireFormat.error("container: unknown command \(command)"))
        }
    }

    private func handleRun(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if action["type"] as? String == "desktop_container_run" {
            if let error = DesktopContainerValidation.validate(action) { completion(error); return }
            let request = UncheckedSendableBox(action)
            DispatchQueue.global(qos: .userInitiated).async { completion(self.neutralRun(request.value)) }
            return
        }
        guard let containerBinary = Self.resolveBinary() else {
            completion(WireFormat.error(
                "container_run: Apple's `container` runtime not found. Searched: \(Self.candidatePaths.joined(separator: ", ")). " +
                "Install via `brew install container` (macOS 26+ required), then `container system start`."
            ))
            return
        }

        guard let image = action["image"] as? String, !image.isEmpty else {
            completion(WireFormat.error("container_run: missing required 'image'"))
            return
        }
        guard let command = action["command"] as? [String], !command.isEmpty else {
            completion(WireFormat.error("container_run: 'command' must be a non-empty string array"))
            return
        }

        var args: [String] = ["run", "--rm"]

        // Network policy
        let network = (action["network"] as? String) ?? "off"
        switch network {
        case "off":
            args.append(contentsOf: ["--network", "none"])
        case "isolated":
            // Apple's container CLI defaults to isolated on macOS 26.
            args.append(contentsOf: ["--network", "default"])
        case "host":
            args.append(contentsOf: ["--network", "host"])
        default:
            args.append(contentsOf: ["--network", "none"])
        }

        // Environment vars
        if let env = action["env"] as? [String: String] {
            for (k, v) in env {
                args.append(contentsOf: ["--env", "\(k)=\(v)"])
            }
        }

        // Mounts: each is { ref?: CyArtifactRef, path: hostPath, mountPath: containerPath, mode: ro|rw }
        if let mounts = action["mounts"] as? [[String: Any]] {
            for m in mounts {
                let hostPath = (m["ref"] as? [String: Any])?["path"] as? String
                    ?? m["hostPath"] as? String
                    ?? m["path"] as? String
                let containerPath = m["mountPath"] as? String ?? hostPath
                let mode = (m["mode"] as? String) ?? "ro"
                guard let host = hostPath, let target = containerPath else { continue }
                let resolved = (host as NSString).expandingTildeInPath
                args.append(contentsOf: ["--volume", "\(resolved):\(target):\(mode)"])
            }
        }

        // Image + command
        args.append(image)
        args.append(contentsOf: command)

        let task = Process()
        task.executableURL = URL(fileURLWithPath: containerBinary)
        task.arguments = args
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        task.standardOutput = stdoutPipe
        task.standardError = stderrPipe
        task.standardInput = FileHandle.nullDevice

        // drain stdout/stderr concurrently while the child is
        // running. The lock-protected accumulators are written from the
        // FileHandle's internal dispatch queue (one queue per pipe) and read
        // from `task.terminationHandler` (a third queue). EOF arrives as
        // `availableData.isEmpty`, at which point we clear the handler so
        // the file handle can be released cleanly.
        let stdoutBuffer = LockedData()
        let stderrBuffer = LockedData()

        stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            stdoutBuffer.append(chunk)
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            stderrBuffer.append(chunk)
        }

        let startedAt = Date()
        let completionFired = AtomicFlag()

        // hardened timeout. SIGTERM at `timeoutMs`, then SIGKILL
        // after a 2-second grace if the child is still alive — we do not
        // trust children to honour SIGTERM. We use a Sendable `TimerHolder`
        // so the timers can be cancelled from `terminationHandler` (which
        // is itself a Sendable closure under Swift 6 strict concurrency).
        let timeoutMs = (action["timeoutMs"] as? Int) ?? 60000
        let timeoutSec = max(1, timeoutMs / 1000)
        let timers = TimerHolder()
        timers.sigtermTimer = DispatchWorkItem { [weak task] in
            if let t = task, t.isRunning {
                t.terminate()
            }
        }
        timers.sigkillTimer = DispatchWorkItem { [weak task] in
            if let t = task, t.isRunning {
                let pid = t.processIdentifier
                if pid > 0 {
                    _ = Darwin.kill(pid, SIGKILL)
                }
            }
        }
        if let sigterm = timers.sigtermTimer {
            DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(timeoutSec), execute: sigterm)
        }
        if let sigkill = timers.sigkillTimer {
            DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(timeoutSec + 2), execute: sigkill)
        }

        // resolve the response in `terminationHandler`. Drain
        // any final bytes still buffered in the pipe (the child has exited
        // so the write side is closed and EOF is guaranteed) before
        // building the response. Calling `availableData` once more here is
        // safe and complements the readabilityHandler accumulators —
        // anything not yet delivered to the handler will arrive in this
        // final read.
        task.terminationHandler = { finishedTask in
            timers.cancelAll()

            let trailingStdout = stdoutPipe.fileHandleForReading.availableData
            if !trailingStdout.isEmpty { stdoutBuffer.append(trailingStdout) }
            let trailingStderr = stderrPipe.fileHandleForReading.availableData
            if !trailingStderr.isEmpty { stderrBuffer.append(trailingStderr) }
            // Drop any remaining handlers explicitly so neither pipe holds
            // a strong reference to the closure capture graph.
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil

            let stdoutBytes = stdoutBuffer.snapshot()
            let stderrBytes = stderrBuffer.snapshot()
            let stdout = String(data: stdoutBytes, encoding: .utf8) ?? ""
            let stderr = String(data: stderrBytes, encoding: .utf8) ?? ""
            let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)

            if completionFired.set() {
                var payload: [String: Any] = [
                    "exitCode": finishedTask.terminationStatus,
                    "stdout": stdout,
                    "stderr": stderr,
                    "durationMs": durationMs,
                    "image": image,
                    "command": command,
                    "network": network
                ]
                // When the container daemon
                // isn't running, surface the recovery as a structured
                // setup_required field so callers don't have to scrape
                // stderr to learn what to do.
                if stderr.contains("container system service has not been started")
                    || stderr.contains("XPC connection error: Connection invalid") {
                    payload["setup_required"] = [
                        "reason": "container daemon is not running",
                        "command": "container system start",
                        "docs": "https://developer.apple.com/documentation/virtualization"
                    ]
                }
                completion(WireFormat.success(payload))
            }
        }

        do {
            try task.run()
        } catch {
            timers.cancelAll()
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            if completionFired.set() {
                completion(WireFormat.error("container_run: failed to spawn `\(containerBinary)`: \(error.localizedDescription)"))
            }
            return
        }
    }
    enum ExecutionError: Error { case failed(String), timeout, limit }

    static func capture(_ binary: String, _ args: [String], deadline: UInt64, limit: Int) -> Result<(Int32, Data, Data), ExecutionError> {
        guard DispatchTime.now().uptimeNanoseconds < deadline else { return .failure(.timeout) }
        let task = Process(), out = Pipe(), err = Pipe()
        task.executableURL = URL(fileURLWithPath: binary); task.arguments = args
        task.standardInput = FileHandle.nullDevice; task.standardOutput = out; task.standardError = err
        defer {
            if task.isRunning { _ = Darwin.kill(task.processIdentifier, SIGKILL) }
            try? out.fileHandleForReading.close(); try? err.fileHandleForReading.close()
        }
        do { try task.run() } catch { return .failure(.failed(error.localizedDescription)) }
        let fds = [out.fileHandleForReading.fileDescriptor, err.fileHandleForReading.fileDescriptor]
        for fd in fds { let flags = fcntl(fd, F_GETFL); if flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0 { return .failure(.failed("container pipe cannot be made nonblocking")) } }
        var buffers = [Data(), Data()], eof = [false, false], chunk = [UInt8](repeating: 0, count: 8192)
        while true {
            if DispatchTime.now().uptimeNanoseconds >= deadline { return .failure(.timeout) }
            for i in 0...1 where !eof[i] {
                let count = Darwin.read(fds[i], &chunk, chunk.count)
                if count == 0 { eof[i] = true }
                else if count > 0 {
                    if buffers[0].count + buffers[1].count + count > limit { return .failure(.limit) }
                    buffers[i].append(contentsOf: chunk.prefix(count))
                } else if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR { return .failure(.failed("container pipe read failed")) }
            }
            if !task.isRunning && eof.allSatisfy({ $0 }) { return .success((task.terminationStatus, buffers[0], buffers[1])) }
            Thread.sleep(forTimeInterval: 0.002)
        }
    }

    private func neutralRun(_ action: [String: Any]) -> [String: Any] {
        func failed(_ error: ExecutionError) -> [String: Any] {
            switch error {
            case .timeout: return DesktopContainerValidation.failure("timeout_unknown_outcome", "container deadline expired; observe effects before retrying")
            case .limit: return DesktopContainerValidation.failure("resource_limit", "container combined output exceeded its byte limit")
            case .failed(let text): return DesktopContainerValidation.failure("provider_failed", text)
            }
        }
        guard let binary = Self.resolveBinary() else { return DesktopContainerValidation.failure("not_installed", "Apple container is not installed; configure its native runtime") }
        let network = action["network"] as? String ?? "off"
        guard network != "host" else { return DesktopContainerValidation.failure("unsupported_operation", "Apple container0.11 has no qualified host network namespace") }
        let started = DispatchTime.now().uptimeNanoseconds
        let deadline = started + UInt64((action["timeoutMs"] as? NSNumber)?.intValue ?? 60000) * 1_000_000
        let versionResult = Self.capture(binary, ["--version"], deadline: min(deadline, started + 5_000_000_000), limit: 128)
        let version: String
        switch versionResult {
        case .failure(let error): return failed(error)
        case .success(let (code, bytes, _)):
            guard code == 0, let text = String(data: bytes, encoding: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return DesktopContainerValidation.failure("provider_failed", "Apple container omitted its version") }
            version = text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        var mountArgs: [String] = []
        for mount in action["mounts"] as? [[String: Any]] ?? [] {
            let host = URL(fileURLWithPath: mount["hostPath"] as! String).resolvingSymlinksInPath()
            guard let values = try? host.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey]), values.isRegularFile == true || values.isDirectory == true, !host.path.contains(",") else { return DesktopContainerValidation.failure("target_gone", "container bind source must be an existing regular file or directory") }
            mountArgs += ["--mount", "type=bind,source=\(host.path),target=\(mount["mountPath"] as! String)\(mount["mode"] as? String == "ro" ? ",readonly" : "")"]
        }
        let name = "interceptor-" + UUID().uuidString.lowercased()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(name, isDirectory: true), cid = root.appendingPathComponent("cid")
        do { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
        catch { return DesktopContainerValidation.failure("provider_failed", "container private run directory could not be created") }
        var args = ["run", "--rm", "--name", name, "--cidfile", cid.path, "--network", network == "off" ? "none" : "default", "--progress", "none"]
        for (key, value) in (action["env"] as? [String: String] ?? [:]).sorted(by: { $0.key < $1.key }) { args += ["--env", "\(key)=\(value)"] }
        args += mountArgs + [action["image"] as! String] + (action["command"] as! [String])
        let result = Self.capture(binary, args, deadline: deadline, limit: (action["maxOutputBytes"] as? NSNumber)?.intValue ?? DESKTOP_CONTAINER_MAX_OUTPUT_BYTES)
        let cleanupDeadline = DispatchTime.now().uptimeNanoseconds + UInt64(DESKTOP_CONTAINER_CLEANUP_MS) * 1_000_000
        _ = Self.capture(binary, ["delete", "--force", name], deadline: cleanupDeadline, limit: 16384)
        let inventory = Self.capture(binary, ["list", "--all", "--format", "json"], deadline: cleanupDeadline, limit: 65536)
        let absent: Bool
        if case .success(let (code, bytes, _)) = inventory, code == 0, let rows = (try? JSONSerialization.jsonObject(with: bytes)) as? [[String: Any]] {
            absent = rows.allSatisfy { row in
                let id = row["id"] as? String ?? (row["configuration"] as? [String: Any])?["id"] as? String
                return id != nil && id != name
            }
        } else { absent = false }
        guard absent else { return ["success": false, "code": "timeout_unknown_outcome", "error": "owned container cleanup could not be established; observe before retrying", "details": ["container": name, "engine": binary, "cidfile": cid.path]] }
        try? FileManager.default.removeItem(at: cid); try? FileManager.default.removeItem(at: root)
        switch result {
        case .failure(let error): return failed(error)
        case .success(let (code, out, err)):
            guard let stdout = String(data: out, encoding: .utf8), let stderr = String(data: err, encoding: .utf8) else { return DesktopContainerValidation.failure("unsupported_target", "container output is not UTF8; no text result was synthesized") }
            return WireFormat.success(["exitCode": code, "stdout": stdout, "stderr": stderr, "durationMs": (DispatchTime.now().uptimeNanoseconds - started) / 1_000_000, "image": action["image"]!, "command": action["command"]!, "network": network, "provider": "apple-container", "engineVersion": version, "engineHost": ProcessInfo.processInfo.hostName])
        }
    }
}

/// holder for the SIGTERM and SIGKILL `DispatchWorkItem`s.
/// `DispatchWorkItem` is not `Sendable` in Swift 6, so the holder is
/// marked `@unchecked Sendable` and exposes a `cancelAll()` method that
/// can be called safely from `task.terminationHandler` (a `@Sendable`
/// closure under strict concurrency).
final class TimerHolder: @unchecked Sendable {
    private let lock = NSLock()
    var sigtermTimer: DispatchWorkItem?
    var sigkillTimer: DispatchWorkItem?

    func cancelAll() {
        lock.lock()
        sigtermTimer?.cancel()
        sigkillTimer?.cancel()
        lock.unlock()
    }
}

/// /CY-6: tiny lock-protected `Data` accumulator written by the
/// pipe's `readabilityHandler` (background queue) and read by
/// `terminationHandler` (also background, different queue). NSLock is
/// sufficient — critical sections are bounded by `Data.append`.
final class LockedData: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func append(_ chunk: Data) {
        lock.lock()
        data.append(chunk)
        lock.unlock()
    }

    /// Keep existing unrestricted callers unchanged. Native VM output uses
    /// this atomic admission so an oversized chunk cannot enter the buffer.
    func appendBounded(_ chunk: Data, maxBytes: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard maxBytes >= 0, data.count <= maxBytes, chunk.count <= maxBytes - data.count else { return false }
        data.append(chunk)
        return true
    }

    func snapshot() -> Data {
        lock.lock()
        let copy = data
        lock.unlock()
        return copy
    }
}

/// latch that ensures the completion handler is invoked at
/// most once even if `task.run()` throws after the SIGTERM/SIGKILL timers
/// have been scheduled. `set()` returns true on the first call only.
final class AtomicFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false

    func set() -> Bool {
        lock.lock()
        let first = !fired
        fired = true
        lock.unlock()
        return first
    }

    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return fired }
}
