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

    // Retained through native failures. Cleared only after confirmed shutdown.
    private var linuxRuntime: LinuxRuntimeHandle?
    private var guestAgent: (any GuestAgent)?
    private var portForwarders: [String: VMPortForwarder] = [:]

#if canImport(Virtualization)
    private var macVM: MacRunningVM?
#endif

    public var ownsRuntime: Bool {
        #if canImport(Virtualization)
        if macVM != nil { return true }
        #endif
        return linuxRuntime != nil || guestAgent != nil || !portForwarders.isEmpty
    }

    public init(spec: VMSpec, bundle: VMBundle, status: VMStatus = .ready) {
        self.spec = spec
        self.bundle = bundle
        self.status = status
    }

    /// `vm start` — boot the guest. Transitions ready → starting → running.
    /// `waitForAgent` blocks the start call until the guest agent connects.
    public func start(headless: Bool, waitForAgent: Bool) async throws -> VMStartResult {
        let begin = Date()
        try VMSnapshot.requireStableStorage(bundle: bundle)
        guard !ownsRuntime else {
            throw VMInstanceError.alreadyStarted("VM '\(spec.name)' retains native ownership; confirm shutdown first")
        }
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
                linuxRuntime = rt
                try await rt.create()
                try await rt.start()
                ipAddress = await rt.ipAddress()
                if waitForAgent {
                    throw VMInstanceError.runtimeUnavailable("the native Linux boot agent is ready, but InterceptorD guest transport is not configured; native VM ownership retained")
                }
            case .macos:
                #if canImport(Virtualization)
                if #available(macOS 13.0, *) {
                    let mvm = try await MacRuntime.run(spec: spec, bundle: bundle, headless: headless)
                    macVM = mvm
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
                    ipAddress = await Self.waitForBridge100IPAddress(macAddress: mvm.macAddress, timeout: waitForAgent ? 30 : 3)
                    let fallbackIPAddress = ipAddress
                    let agentSpec = spec.agent
                    let agentEnabled = agentSpec?.enabled ?? true
                    let agentPort = agentSpec?.port ?? kInterceptorGuestAgentPort
                    let tcpFallbackHost = agentSpec?.transport == .tcp ? (agentSpec?.host ?? fallbackIPAddress) : nil
                    // GuestAgent (vsock) attach. The first socketDevice is
                    // the one we configured in MacRuntime.run. TCP fallback is
                    // only enabled when VMSpec.agent explicitly requests TCP.
                    let agent: VsockGuestAgent? = await withCheckedContinuation { cc in
                        mvm.queue.async {
                            let socketDevice = mvm.vm.socketDevices.first as? VZVirtioSocketDevice
                            cc.resume(returning: socketDevice.map {
                                VsockGuestAgent(
                                    socketDevice: $0,
                                    connectQueue: mvm.queue,
                                    port: agentPort,
                                    tcpFallbackHost: tcpFallbackHost
                                )
                            })
                        }
                    }
                    if agentEnabled, let agent {
                        if waitForAgent {
                            do {
                                try await agent.connect(timeout: 58)  // GuestWire.Deadline caps a budget at 58 s
                                self.guestAgent = agent
                            } catch {
                                self.guestAgent = agent
                                self.lastError = "guest agent connect: \(error)"
                                throw VMInstanceError.runtimeUnavailable("guest agent readiness failed: \(error)")
                            }
                        } else {
                            self.guestAgent = agent  // lazy connect on first use
                        }
                    } else if waitForAgent {
                        let transport = agentSpec?.transport.rawValue ?? "vsock"
                        throw VMInstanceError.runtimeUnavailable("guest agent transport '\(transport)' is not available for VM '\(spec.name)'")
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
        guard timeout.isFinite, timeout > 0, timeout <= 300 else {
            throw VMInstanceError.invalidTransition("stop timeout must be in (0, 300] seconds")
        }
        guard ownsRuntime else { status = .stopped; ipAddress = nil; return }
        status = .stopping
        do {
            if force {
                try await forceStop()
            } else {
                try await gracefulStop(timeout: timeout)
            }
            await guestAgent?.disconnect()
            guestAgent = nil
            for forwarder in portForwarders.values { forwarder.stop() }
            portForwarders.removeAll()
            linuxRuntime = nil
            #if canImport(Virtualization)
            macVM = nil
            #endif
            ipAddress = nil
            status = .stopped
            lastError = nil
        } catch {
            status = .error
            lastError = "shutdown not confirmed; native ownership retained: \(error)"
            throw error
        }
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
        if let rt = linuxRuntime {
            try await rt.pause()
            status = .paused
            return
        }
        throw VMInstanceError.runtimeUnavailable("no native Linux VM is owned")
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
        if let rt = linuxRuntime {
            try await rt.resume()
            status = .running
            return
        }
        throw VMInstanceError.runtimeUnavailable("no native Linux VM is owned")
    }

    public func exec(argv: [String], env: [String: String], workdir: String?, tty: Bool, timeout: TimeInterval) async throws -> (exitCode: Int32, stdout: String, stderr: String, durationMs: Int) {
        guard status == .running else {
            throw VMInstanceError.notStarted("vm '\(spec.name)' is .\(status.rawValue)")
        }
        if let agent = guestAgent {
            return try await agent.exec(argv, env: env, workdir: workdir, tty: tty, timeout: timeout)
        }
        if let rt = linuxRuntime {
            let clock = ContinuousClock(), begin = clock.now
            let r = try await rt.execve(argv, env: env, workdir: workdir, tty: tty, timeout: timeout)
            let elapsed = begin.duration(to: clock.now).components
            let ms = elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000
            return (r.exitCode, r.stdout, r.stderr, Int(ms))
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
            if spec.agent?.transport == .tcp {
                vsockAgent.setTCPFallbackHost(spec.agent?.host ?? ipAddress)
            } else {
                vsockAgent.setTCPFallbackHost(nil)
            }
        }
        #endif
        return try await agent.request(action, timeout: timeout)
    }

    public func createSnapshot(tag: String, mode: VMSnapshot.Mode) async throws -> VMSnapshotManifest {
        #if canImport(Virtualization)
        if #available(macOS 14.0, *), let mvm = macVM {
            guard status == .paused || mode == .diskOnly else {
                throw VMInstanceError.invalidTransition("paused-state snapshots require the VM to be paused")
            }
            return try await VMSnapshot.create(vm: mvm.vm, queue: mvm.queue, bundle: bundle, tag: tag, mode: mode)
        }
        #endif
        throw VMInstanceError.runtimeUnavailable("paused-state snapshots require macOS 14+ and a running macOS VM")
    }

    public func restoreSnapshot(tag: String, diskOnly: Bool, pausedStateOnly: Bool, headless: Bool) async throws -> VMSnapshotManifest {
        try VMSnapshot.requireStableStorage(bundle: bundle)
        guard !ownsRuntime else {
            throw VMInstanceError.invalidTransition("restore requires confirmed native shutdown")
        }
        guard status != .running && status != .paused && status != .starting && status != .stopping else {
            throw VMInstanceError.invalidTransition("restore requires VM '\(spec.name)' to be stopped")
        }
        status = .restoringSnapshot
        do {
            let manifest = try VMSnapshot.manifest(bundle: bundle, tag: tag)
            if diskOnly && !manifest.hasDiskClone {
                throw VMSnapshotError.missing("snapshot '\(tag)' has no Disk.img")
            }
            if pausedStateOnly && !manifest.hasPausedState {
                throw VMSnapshotError.missing("snapshot '\(tag)' has no paused machine state")
            }
            if !diskOnly && manifest.hasPausedState {
                // Preflight before restoreDisk replaces the live Disk.img.
                try VMSnapshot.requirePausedStateSupport("paused-state restore")
            }
            if !pausedStateOnly && manifest.hasDiskClone {
                _ = try VMSnapshot.restoreDisk(bundle: bundle, tag: tag)
            }
            if diskOnly || !manifest.hasPausedState {
                status = .stopped
                return manifest
            }

            guard spec.kind == .macos else {
                throw VMInstanceError.runtimeUnavailable("paused-state restore is only wired for macOS VZ guests")
            }
            #if canImport(Virtualization)
            if #available(macOS 14.0, *) {
                let mvm = try await MacRuntime.run(spec: spec, bundle: bundle, headless: headless)
                macVM = mvm
                _ = try await VMSnapshot.restorePausedState(vm: mvm.vm, queue: mvm.queue, bundle: bundle, tag: tag)
                status = .paused
                return manifest
            }
            #endif
            throw VMInstanceError.runtimeUnavailable("paused-state restore requires macOS 14+ host with Virtualization.framework")
        } catch {
            status = .error
            lastError = "\(error)"
            throw error
        }
    }

    public func consoleRead(maxBytes: Int, timeout: TimeInterval) async throws -> Data {
        guard status == .running || status == .paused else {
            throw VMInstanceError.notStarted("vm '\(spec.name)' is .\(status.rawValue)")
        }
        #if canImport(Virtualization)
        if let handle = macVM?.consoleHandles?.outputPipeReadEnd {
            return try await VMConsole.read(from: handle, maxBytes: maxBytes, timeout: timeout)
        }
        #endif
        throw VMInstanceError.runtimeUnavailable("console is only available for VZ guests with a serial attachment")
    }

    public func consoleWrite(_ text: String) async throws -> Int {
        guard status == .running || status == .paused else {
            throw VMInstanceError.notStarted("vm '\(spec.name)' is .\(status.rawValue)")
        }
        #if canImport(Virtualization)
        if let handle = macVM?.consoleHandles?.inputPipeWriteEnd {
            return try VMConsole.write(Data(text.utf8), to: handle)
        }
        #endif
        throw VMInstanceError.runtimeUnavailable("console is only available for VZ guests with a serial attachment")
    }

    public func portForward(hostAddress: String, hostPort: Int, guestPort: Int) async throws -> (hostAddress: String, hostPort: Int, guestAddress: String, guestPort: Int) {
        guard status == .running else {
            throw VMInstanceError.notStarted("vm '\(spec.name)' is .\(status.rawValue)")
        }
        if ipAddress == nil {
            #if canImport(Virtualization)
            if #available(macOS 13.0, *) {
                ipAddress = await Self.waitForBridge100IPAddress(macAddress: macVM?.macAddress, timeout: 5)
            }
            #endif
        }
        guard let guestAddress = ipAddress, !guestAddress.isEmpty else {
            throw VMInstanceError.runtimeUnavailable("cannot start port-forward without a known guest IPv4 address")
        }
        let forwarder = VMPortForwarder(
            hostAddress: hostAddress,
            hostPort: hostPort,
            guestAddress: guestAddress,
            guestPort: guestPort
        )
        let actualHostPort = try forwarder.start()
        let key = "\(hostAddress):\(actualHostPort)->\(guestAddress):\(guestPort)"
        portForwarders[key] = forwarder
        return (hostAddress, actualHostPort, guestAddress, guestPort)
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
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: .seconds(timeout))
            try await withCheckedThrowingContinuation { (cc: CheckedContinuation<Void, Error>) in
                mvm.queue.async {
                    if mvm.vm.state == .stopped { cc.resume(returning: ()); return }
                    guard mvm.vm.canRequestStop else {
                        cc.resume(throwing: VMInstanceError.invalidTransition("guest cannot accept requestStop in its current native state")); return
                    }
                    do {
                        try mvm.vm.requestStop()
                        cc.resume(returning: ())
                    } catch {
                        cc.resume(throwing: VMInstanceError.invalidTransition("requestStop: \(error.localizedDescription)"))
                    }
                }
            }
            while true {
                let nativeState = await withCheckedContinuation { cc in
                    mvm.queue.async { cc.resume(returning: mvm.vm.state) }
                }
                if nativeState == .stopped { return }
                if nativeState == .error {
                    throw VMInstanceError.invalidTransition("guest entered native error state during shutdown")
                }
                if clock.now >= deadline {
                    throw VMInstanceError.timeout("guest has not reached native stopped state; ownership retained")
                }
                try await clock.sleep(until: min(deadline, clock.now.advanced(by: .milliseconds(50))))
            }
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
                    if mvm.vm.state == .stopped { cc.resume(returning: ()); return }
                    guard mvm.vm.canStop else {
                        cc.resume(throwing: VMInstanceError.invalidTransition("cannot force stop in the current native state")); return
                    }
                    mvm.vm.stop { err in
                        if let err = err {
                            cc.resume(throwing: VMInstanceError.invalidTransition("force stop: \(err.localizedDescription)"))
                        } else if mvm.vm.state != .stopped {
                            cc.resume(throwing: VMInstanceError.invalidTransition("native stop completion did not confirm stopped state"))
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
            // Containerization.stop terminates processes and then the actual
            // native VM. Killing only its init process leaves the VM running.
            try await rt.stop()
        }
    }
}
