// VMInstance
//
// One actor per running VM. Owns:
//   - the spec (read mostly; mutated under registry control)
//   - the runtime handle (LinuxRuntimeHandle or MacRunningVM)
//   - the GuestAgent (vsock)
//   - lifecycle state machine transitions
//
// The state machine is the same one in design notes. Transitions are
// serialized through the actor's mailbox so two `vm start` requests on
// the same VM never race.

import Foundation
#if canImport(Virtualization)
import Virtualization
#endif

public enum VMInstanceError: Error, CustomStringConvertible, Sendable {
    case invalidTransition(String)
    case alreadyStarted(String)
    case notStarted(String)
    case runtimeUnavailable(String)
    case timeout(String)

    public var description: String {
        switch self {
        case .invalidTransition(let m): return "vm.invalidTransition: \(m)"
        case .alreadyStarted(let m): return "vm.alreadyStarted: \(m)"
        case .notStarted(let m): return "vm.notStarted: \(m)"
        case .runtimeUnavailable(let m): return "vm.runtimeUnavailable: \(m)"
        case .timeout(let m): return "vm.timeout: \(m)"
        }
    }
}

/// Result of `start()` so callers can read the current state cheaply.
public struct VMStartResult: Sendable {
    public let status: VMStatus
    public let transitionMs: Int
    public let ipAddress: String?
}

public actor VMInstance {
    public let bundle: VMBundle
    public private(set) var spec: VMSpec
    public private(set) var status: VMStatus
    public private(set) var lastError: String?
    public private(set) var ipAddress: String?

    // Held only when running. Cleared on stop.
    private var linuxRuntime: LinuxRuntimeHandle?
    private var guestAgent: (any GuestAgent)?

#if canImport(Virtualization)
    private var macVM: MacRunningVM?
#endif

    public init(spec: VMSpec, bundle: VMBundle, status: VMStatus = .ready) {
        self.spec = spec
        self.bundle = bundle
        self.status = status
    }

    /// `vm start` — boot the guest. Transitions ready → starting → running.
    /// `waitForVsock` blocks the start call until the guest agent connects.
    public func start(headless: Bool, waitForVsock: Bool) async throws -> VMStartResult {
        let begin = Date()
        switch status {
        case .running, .paused, .starting, .stopping, .savingSnapshot, .restoringSnapshot:
            throw VMInstanceError.alreadyStarted("VM '\(spec.name)' is in state .\(status.rawValue)")
        default:
            break
        }
        status = .starting
        do {
            switch spec.kind {
            case .linux:
                let rt = try await LinuxRuntime.prepare(spec: spec, bundle: bundle)
                try await rt.create()
                try await rt.start()
                linuxRuntime = rt
                ipAddress = await rt.ipAddress()
            case .macos:
                #if canImport(Virtualization)
                if #available(macOS 13.0, *) {
                    let mvm = try await MacRuntime.run(spec: spec, bundle: bundle, headless: headless)
                    // Bridge start(completionHandler:) into async.
                    try await withCheckedThrowingContinuation { (cc: CheckedContinuation<Void, Error>) in
                        mvm.queue.async {
                            mvm.vm.start { result in
                                switch result {
                                case .success:
                                    cc.resume(returning: ())
                                case .failure(let err):
                                    cc.resume(throwing: VMInstanceError.invalidTransition("VZVirtualMachine.start: \(err.localizedDescription)"))
                                }
                            }
                        }
                    }
                    macVM = mvm
                    ipAddress = await Self.waitForBridge100IPAddress(macAddress: mvm.macAddress, timeout: waitForVsock ? 30 : 3)
                    let fallbackIPAddress = ipAddress
                    // GuestAgent (vsock) attach. The first socketDevice is
                    // the one we configured in MacRuntime.run.
                    let agent: VsockGuestAgent? = await withCheckedContinuation { cc in
                        mvm.queue.async {
                            let socketDevice = mvm.vm.socketDevices.first as? VZVirtioSocketDevice
                            cc.resume(returning: socketDevice.map { VsockGuestAgent(socketDevice: $0, connectQueue: mvm.queue, tcpFallbackHost: fallbackIPAddress) })
                        }
                    }
                    if let agent {
                        if waitForVsock {
                            do {
                                try await agent.connect(timeout: 60)
                                self.guestAgent = agent
                            } catch {
                                // boot succeeded; agent not up — still
                                // a running VM. Keep the agent handle so
                                // later guest verbs can retry after login
                                // items / LaunchAgents finish starting.
                                self.guestAgent = agent
                                self.lastError = "vsock connect: \(error.localizedDescription)"
                            }
                        } else {
                            self.guestAgent = agent  // lazy connect on first use
                        }
                    }
                } else {
                    throw VMInstanceError.runtimeUnavailable("macOS guests require macOS 13+ host")
                }
                #else
                throw VMInstanceError.runtimeUnavailable("Virtualization framework not available")
                #endif
            }
            status = .running
            spec.startedAt = Date()
            let elapsed = Int(Date().timeIntervalSince(begin) * 1000)
            return VMStartResult(status: status, transitionMs: elapsed, ipAddress: ipAddress)
        } catch {
            status = .error
            lastError = "\(error)"
            throw error
        }
    }

    /// `vm stop` — graceful (requestStop / container.stop) or forceful
    /// (VZVirtualMachine.stop / container.kill SIGKILL).
    public func stop(force: Bool, timeout: TimeInterval) async throws {
        let begin = Date()
        guard status == .running || status == .paused else {
            // already stopped — no-op
            if status == .stopped { return }
            throw VMInstanceError.notStarted("VM '\(spec.name)' is in state .\(status.rawValue)")
        }
        status = .stopping
        if force {
            try await forceStop()
        } else {
            try await gracefulStop(timeout: timeout)
        }
        // tear down agent
        await guestAgent?.disconnect()
        guestAgent = nil
        linuxRuntime = nil
        #if canImport(Virtualization)
        macVM = nil
        #endif
        status = .stopped
        let _ = Date().timeIntervalSince(begin)
    }

    public func pause() async throws {
        guard status == .running else {
            throw VMInstanceError.invalidTransition(".\(status.rawValue) → .paused not allowed")
        }
        #if canImport(Virtualization)
        if let mvm = macVM {
            try await withCheckedThrowingContinuation { (cc: CheckedContinuation<Void, Error>) in
                mvm.queue.async {
                    mvm.vm.pause { result in
                        switch result {
                        case .success: cc.resume(returning: ())
                        case .failure(let e): cc.resume(throwing: VMInstanceError.invalidTransition("pause: \(e.localizedDescription)"))
                        }
                    }
                }
            }
            status = .paused
            return
        }
        #endif
        // Linux: Containerization exposes pause via container API once
        // the package resolves; until then return clean error.
        throw VMInstanceError.invalidTransition("pause for Linux guests pending Containerization 0.31.0 resolution")
    }

    public func resume() async throws {
        guard status == .paused else {
            throw VMInstanceError.invalidTransition(".\(status.rawValue) → .running not allowed")
        }
        #if canImport(Virtualization)
        if let mvm = macVM {
            try await withCheckedThrowingContinuation { (cc: CheckedContinuation<Void, Error>) in
                mvm.queue.async {
                    mvm.vm.resume { result in
                        switch result {
                        case .success: cc.resume(returning: ())
                        case .failure(let e): cc.resume(throwing: VMInstanceError.invalidTransition("resume: \(e.localizedDescription)"))
                        }
                    }
                }
            }
            status = .running
            return
        }
        #endif
        throw VMInstanceError.invalidTransition("resume for Linux guests pending Containerization 0.31.0 resolution")
    }

    public func exec(argv: [String], env: [String: String], workdir: String?, tty: Bool, timeout: TimeInterval) async throws -> (exitCode: Int32, stdout: String, stderr: String, durationMs: Int) {
        guard status == .running else {
            throw VMInstanceError.notStarted("vm '\(spec.name)' is .\(status.rawValue)")
        }
        if let agent = guestAgent {
            return try await agent.exec(argv, env: env, workdir: workdir, tty: tty, timeout: timeout)
        }
        if let rt = linuxRuntime {
            let r = try await rt.execve(argv, env: env, workdir: workdir, tty: tty)
            return (r.exitCode, r.stdout, r.stderr, 0)
        }
        throw VMInstanceError.runtimeUnavailable("no guest agent or runtime to exec into")
    }

    public func requestGuest(action: GuestAgentDict, timeout: TimeInterval) async throws -> GuestAgentDict {
        guard status == .running else {
            throw VMInstanceError.notStarted("vm '\(spec.name)' is .\(status.rawValue)")
        }
        guard let agent = guestAgent else {
            throw VMInstanceError.runtimeUnavailable("no guest agent connected")
        }
        #if canImport(Virtualization)
        if #available(macOS 13.0, *), let vsockAgent = agent as? VsockGuestAgent {
            if ipAddress == nil {
                ipAddress = await Self.waitForBridge100IPAddress(macAddress: macVM?.macAddress, timeout: 5)
            }
            vsockAgent.setTCPFallbackHost(ipAddress)
        }
        #endif
        try await agent.connect(timeout: min(timeout, 30))
        return try await agent.request(action, timeout: timeout)
    }

    public func createSnapshot(tag: String, mode: VMSnapshot.Mode) async throws -> VMSnapshotManifest {
        #if canImport(Virtualization)
        if #available(macOS 14.0, *), let mvm = macVM {
            guard status == .paused || mode == .diskOnly else {
                throw VMInstanceError.invalidTransition("paused-state snapshots require the VM to be paused")
            }
            return try await VMSnapshot.create(vm: mvm.vm, bundle: bundle, tag: tag, mode: mode)
        }
        #endif
        throw VMInstanceError.runtimeUnavailable("paused-state snapshots require macOS 14+ and a running macOS VM")
    }

    public func current() -> VMSpec { spec }

    // MARK: - private helpers

    private static func waitForBridge100IPAddress(macAddress: String?, timeout: TimeInterval) async -> String? {
        let deadline = Date().addingTimeInterval(max(timeout, 0))
        while true {
            if let ip = bridge100IPAddress(macAddress: macAddress) {
                return ip
            }
            if timeout <= 0 || Date() >= deadline {
                return nil
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    private static func bridge100IPAddress(macAddress: String?) -> String? {
        if let output = processOutput("/usr/sbin/arp", args: ["-an"]),
           let ip = parseARPBridge100(output, macAddress: macAddress) {
            return ip
        }
        if let macAddress,
           let leases = try? String(contentsOfFile: "/var/db/dhcpd_leases", encoding: .utf8),
           let ip = parseDHCPLeases(leases, macAddress: macAddress) {
            return ip
        }
        return nil
    }

    private static func parseARPBridge100(_ output: String, macAddress: String?) -> String? {
        let targetMac = macAddress.map(normalizedMAC)
        for rawLine in output.split(separator: "\n") {
            let line = String(rawLine)
            let lower = line.lowercased()
            guard lower.contains(" on bridge100"), !lower.contains("permanent") else { continue }
            guard let ipRange = line.range(of: #"(?<=\()192\.168\.64\.\d+(?=\))"#, options: .regularExpression) else { continue }
            let ip = String(line[ipRange])
            guard ip != "192.168.64.1" else { continue }
            if let targetMac {
                guard let observedMac = arpMACAddress(from: line), normalizedMAC(observedMac) == targetMac else { continue }
            }
            return ip
        }
        return nil
    }

    private static func parseDHCPLeases(_ leases: String, macAddress: String) -> String? {
        let targetMac = normalizedMAC(macAddress)
        var currentIP: String?
        for rawLine in leases.split(separator: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("ip_address=") {
                currentIP = String(line.dropFirst("ip_address=".count))
            } else if line.hasPrefix("hw_address=1,") {
                let observed = String(line.dropFirst("hw_address=1,".count))
                if normalizedMAC(observed) == targetMac {
                    return currentIP
                }
            } else if line == "}" {
                currentIP = nil
            }
        }
        return nil
    }

    private static func arpMACAddress(from line: String) -> String? {
        guard let start = line.range(of: " at "),
              let end = line.range(of: " on bridge100", range: start.upperBound..<line.endIndex) else {
            return nil
        }
        return String(line[start.upperBound..<end.lowerBound])
    }

    private static func normalizedMAC(_ macAddress: String) -> String {
        macAddress
            .lowercased()
            .split(separator: ":")
            .map { byte -> String in
                let trimmed = byte.trimmingCharacters(in: .whitespacesAndNewlines)
                guard let value = Int(trimmed, radix: 16) else { return trimmed }
                return String(value, radix: 16)
            }
            .joined(separator: ":")
    }

    private static func processOutput(_ executable: String, args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        let stdoutPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }
        guard process.terminationStatus == 0 else { return nil }
        let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)
    }

    private func gracefulStop(timeout: TimeInterval) async throws {
        #if canImport(Virtualization)
        if let mvm = macVM {
            // VZVirtualMachine.requestStop() asks the guest OS to shutdown.
            // We then poll the delegate's stop callback up to `timeout`.
            let result: Error? = try? await withCheckedThrowingContinuation { (cc: CheckedContinuation<Error?, Error>) in
                mvm.delegate.onStop { err in cc.resume(returning: err) }
                mvm.queue.async {
                    do {
                        try mvm.vm.requestStop()
                    } catch {
                        cc.resume(throwing: VMInstanceError.invalidTransition("requestStop: \(error.localizedDescription)"))
                    }
                }
            }
            if let err = result {
                throw VMInstanceError.invalidTransition("guest stop error: \(err.localizedDescription)")
            }
            return
        }
        #endif
        if let rt = linuxRuntime {
            try await rt.stop()
        }
    }

    private func forceStop() async throws {
        #if canImport(Virtualization)
        if let mvm = macVM {
            // VZVirtualMachine.stop(completionHandler:) takes (Error?) -> Void
            // — not a Result. Bridge it into the throwing async surface
            // by checking the optional.
            try await withCheckedThrowingContinuation { (cc: CheckedContinuation<Void, Error>) in
                mvm.queue.async {
                    mvm.vm.stop { err in
                        if let err = err {
                            cc.resume(throwing: VMInstanceError.invalidTransition("force stop: \(err.localizedDescription)"))
                        } else {
                            cc.resume(returning: ())
                        }
                    }
                }
            }
            return
        }
        #endif
        if let rt = linuxRuntime {
            try await rt.kill(signal: 9)
        }
    }
}
