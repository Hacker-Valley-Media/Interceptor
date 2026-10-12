import Foundation
import CoreFoundation
import Darwin

// One guest execution owns its process and both pipes until native cleanup
// finishes. A timed-out reply does not release admission for another command.
private let guestExecutionAdmission = DispatchSemaphore(value: 1)

final class GuestExecution: @unchecked Sendable {
    private let lock = NSLock()
    private let completed = DispatchSemaphore(value: 0)
    private var reply: [String: Any]?
    private let argv: [String]
    private let environment: [String: String]
    private let directory: String?
    private let timeout: Double
    private let started = DispatchTime.now().uptimeNanoseconds

    init(argv: [String], environment: [String: String], directory: String?, timeout: Double) {
        self.argv = argv; self.environment = environment; self.directory = directory; self.timeout = timeout
    }
    private var elapsed: Double { Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000_000 }
    private func publish(_ value: [String: Any]) {
        lock.lock()
        let first = reply == nil
        if first { reply = value }
        lock.unlock()
        if first { completed.signal() }
    }
    private func failure(_ code: String, _ message: String) {
        publish(["success": false, "code": code, "error": message,
                 "details": ["observeBeforeRetry": true, "executionLeaseRetainedUntilCleanup": true]])
    }
    func response() -> [String: Any] {
        Thread.detachNewThread { [self] in work() }
        if completed.wait(timeout: .now() + timeout + 1) == .timedOut {
            failure("timeout_unknown_outcome", "guest native execution did not complete before its response deadline; no command was replayed")
        }
        lock.lock(); defer { lock.unlock() }
        return reply!
    }
    private func work() {
        var finalReply: [String: Any]?
        defer {
            guestExecutionAdmission.signal()
            if let finalReply { publish(finalReply) }
        }
        let task = Process(), stdout = Pipe(), stderr = Pipe()
        task.executableURL = URL(fileURLWithPath: argv[0]); task.arguments = Array(argv.dropFirst())
        task.environment = ProcessInfo.processInfo.environment.merging(environment) { _, replacement in replacement }
        if let directory { task.currentDirectoryURL = URL(fileURLWithPath: directory) }
        task.standardInput = FileHandle.nullDevice; task.standardOutput = stdout; task.standardError = stderr
        let readers = [stdout.fileHandleForReading, stderr.fileHandleForReading]
        defer { for reader in readers { try? reader.close() } }
        for reader in readers {
            let flags = fcntl(reader.fileDescriptor, F_GETFL)
            guard flags >= 0, fcntl(reader.fileDescriptor, F_SETFL, flags | O_NONBLOCK) >= 0 else {
                failure("provider_failed", "guest output pipe could not enter bounded nonblocking mode"); return
            }
        }
        guard elapsed < timeout else { failure("timeout_unknown_outcome", "guest execution admission expired before spawn"); return }
        do { try task.run() }
        catch { failure("provider_failed", "guest exec spawn failed: \(error.localizedDescription)"); return }
        try? stdout.fileHandleForWriting.close(); try? stderr.fileHandleForWriting.close()
        var output = [Data(), Data()], closed = [false, false], rejected = false, terminated = false
        while task.isRunning || !closed.allSatisfy({ $0 }) {
            if elapsed >= timeout && !rejected {
                rejected = true
                failure("timeout_unknown_outcome", "guest execution or inherited output pipes exceeded the deadline; inspect effects and stop the owned VM if cleanup remains blocked")
            }
            for index in readers.indices where !closed[index] {
                var chunk = [UInt8](repeating: 0, count: 8192)
                let count = chunk.withUnsafeMutableBytes { Darwin.read(readers[index].fileDescriptor, $0.baseAddress, $0.count) }
                if count == 0 { closed[index] = true }
                else if count > 0 && !rejected {
                    if output[0].count + output[1].count + count > 131_072 {
                        rejected = true; failure("partial_result", "guest output exceeds 128KiB; execution effects were not rolled back")
                    } else { output[index].append(contentsOf: chunk.prefix(count)) }
                } else if count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR {
                    rejected = true; failure("partial_result", "guest output read failed; process and pipe cleanup remain owned")
                    // Keep ownership and the pipe open. A native read failure
                    // is not proof that an inherited writer has exited.
                }
            }
            if rejected && task.isRunning && !terminated {
                terminated = true; task.terminate()
            }
            if task.isRunning || !closed.allSatisfy({ $0 }) { usleep(2_000) }
        }
        guard !rejected else { return }
        guard elapsed < timeout else { failure("timeout_unknown_outcome", "guest output finished after its native execution deadline; inspect effects before retrying"); return }
        guard task.terminationReason == .exit else { finalReply = ["success": false, "code": "partial_result", "error": "guest command terminated by a signal; no normal exit code was invented"]; return }
        guard let out = String(data: output[0], encoding: .utf8), let err = String(data: output[1], encoding: .utf8) else {
            finalReply = ["success": false, "code": "partial_result", "error": "guest output is not UTF8; no bytes were silently replaced"]; return
        }
        let duration = Int(elapsed * 1000)
        guard duration <= 58_000 else { failure("timeout_unknown_outcome", "guest native execution finished outside its bounded reply window"); return }
        finalReply = ["success": true, "data": ["exitCode": task.terminationStatus, "stdout": out, "stderr": err, "durationMs": duration]]
    }
    static func execute(_ action: [String: Any]) -> [String: Any] {
        func invalid(_ message: String) -> [String: Any] { ["success": false, "code": "invalid_request", "error": message] }
        guard let argv = action["argv"] as? [String], !argv.isEmpty, argv.count <= 128, argv[0].hasPrefix("/"),
              argv.allSatisfy({ !$0.contains("\0") && $0.utf8.count <= 32_768 }) else { return invalid("guest exec requires bounded exact argv and an absolute executable") }
        if action["user"] != nil { return invalid("guest exec user selection is unavailable; no field was ignored") }
        if let tty = action["tty"] {
            guard let number = tty as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return invalid("guest exec TTY selector requires a Boolean") }
            if number.boolValue { return invalid("guest exec TTY selection is unavailable; no field was ignored") }
        }
        let environment: [String: String]
        if let value = action["env"] {
            guard let typed = value as? [String: String], typed.count <= 64,
                  typed.allSatisfy({ key, value in key.range(of: "^[A-Za-z_][A-Za-z0-9_]{0,127}$", options: .regularExpression) != nil && !value.contains("\0") && value.utf8.count <= 32_768 }) else { return invalid("invalid guest exec environment") }
            environment = typed
        } else { environment = [:] }
        let directory: String?
        if let value = action["workdir"] {
            guard let typed = value as? String, typed.hasPrefix("/"), !typed.contains("\0"), typed.utf8.count <= 4096 else { return invalid("guest exec working directory requires an absolute bounded path") }; directory = typed
        } else { directory = nil }
        var timeout = 50.0
        if let value = action["timeout"] {
            // Private copy transactions pass a fractional remaining budget.
            // Public CLI timeout admission remains integral in the contract.
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite, number.doubleValue > 0, number.doubleValue <= 50 else { return invalid("guest exec timeout requires a positive finite budget of at most 50 seconds") }; timeout = number.doubleValue
        }
        guard JSONSerialization.isValidJSONObject(action), let bytes = try? JSONSerialization.data(withJSONObject: action), bytes.count <= 131_072 else { return invalid("guest exec request exceeds 128KiB") }
        guard guestExecutionAdmission.wait(timeout: .now()) == .success else { return ["success": false, "code": "invalid_target", "error": "guest execution or cleanup still owns admission; no duplicate command was started"] }
        return GuestExecution(argv: argv, environment: environment, directory: directory, timeout: timeout).response()
    }
}
