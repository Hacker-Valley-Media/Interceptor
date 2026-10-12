// Linux VM integration uses the exact Containerization0.31.0 dependency.
// LinuxRuntime.prepare creates an owned facade; create checks pinned boot
// assets, resolves actual OCI content and retains the machine before native
// setup. Lifecycle and exec use typed SDK calls without a host shell.

import Foundation
import CryptoKit
import Darwin

#if canImport(Containerization)
import Containerization
#endif

#if canImport(ContainerizationOCI)
import ContainerizationOCI
#endif

public enum LinuxRuntimeError: Error, CustomStringConvertible, Sendable {
    case packageUnavailable(String)
    case prepareFailed(String)
    case lifecycleFailed(String)

    public var description: String {
        switch self {
        case .packageUnavailable(let m): return "linux.packageUnavailable: \(m)"
        case .prepareFailed(let m): return "linux.prepareFailed: \(m)"
        case .lifecycleFailed(let m): return "linux.lifecycleFailed: \(m)"
        }
    }
}

/// Thin facade over `Containerization.LinuxContainer`. One instance per
/// running Linux VM, owned by `VMInstance`. We accept the runtime cost of
/// wrapping the type so VMInstance does not need to import Containerization
/// directly (and so VmDomainTests can stub via protocol).
public protocol LinuxRuntimeHandle: AnyObject, Sendable {
    func create() async throws
    func start() async throws
    func stop() async throws
    func kill(signal: Int32) async throws
    func wait() async throws -> Int32
    func pause() async throws
    func resume() async throws
    func execve(_ argv: [String], env: [String: String], workdir: String?, tty: Bool, timeout: TimeInterval) async throws -> (exitCode: Int32, stdout: String, stderr: String)
    func ipAddress() async -> String?
}

public struct LinuxRuntime: Sendable {

    /// Build a runtime handle. Reads the Containerization kernel+initrd
    /// bundle laid out by `vm pull <oci-ref>` under
    /// `<state>/images/oci/<safe-ref>/` and starts a fresh
    /// `VZVirtualMachineManager` + `LinuxContainer`.
    ///
    /// In v0 we keep the implementation defensive: if Containerization
    /// hasn't been resolved (offline build, etc.) we throw a clean
    /// `packageUnavailable` so the VmDomain surfaces a `setup_required`
    /// envelope rather than crashing the bridge.
    public static func prepare(spec: VMSpec, bundle: VMBundle) async throws -> LinuxRuntimeHandle {
#if canImport(Containerization)
        return try await LinuxRuntimeImpl(spec: spec, bundle: bundle)
#else
        throw LinuxRuntimeError.packageUnavailable(
            "Containerization Swift package not linked — rebuild the bridge with `swift package update` first"
        )
#endif
    }
}

#if canImport(Containerization)
/// Exact Containerization 0.31.0 integration. The native machine is retained
/// separately because container setup can fail after the machine has booted.
actor LinuxRuntimeImpl: LinuxRuntimeHandle {
    private let spec: VMSpec
    private let bundle: VMBundle
    private var container: LinuxContainer?
    private var manager: RetainedLinuxVMManager?
    private var network: (any Network)?
    private var address: String?
    private var pending: [String: LinuxProcess] = [:]
    private var stopped = false

    init(spec: VMSpec, bundle: VMBundle) async throws {
        self.spec = spec
        self.bundle = bundle
    }

    func create() async throws {
        guard container == nil, manager == nil, !stopped else { throw LinuxRuntimeError.lifecycleFailed("create already admitted") }
        let kernel = try Self.pinnedAsset("INTERCEPTOR_VM_LINUX_KERNEL", maxBytes: 134217728)
        let initfs = try Self.pinnedAsset("INTERCEPTOR_VM_LINUX_INITFS", maxBytes: 536870912)
        #if arch(arm64)
        let platform = SystemPlatform.linuxArm
        #else
        let platform = SystemPlatform.linuxAmd
        #endif
        _ = try await VMImage.resolveOCIImage(ref: spec.image, stateDir: bundle.stateDir)
        let store = try ImageStore(path: VMImage.ociImagesDir(stateDir: bundle.stateDir).appendingPathComponent("store"))
        let image = try await store.get(reference: spec.image)
        guard let imageConfig = try await image.config(for: platform.ociPlatform()).config else {
            throw LinuxRuntimeError.prepareFailed("native OCI image lacks a process configuration; no guest filesystem was prepared")
        }
        let rootfs = try await prepareRootfs(image: image, platform: platform.ociPlatform())
        let nativeManager = RetainedLinuxVMManager(VZVirtualMachineManager(
            kernel: Kernel(path: kernel, platform: platform),
            initialFilesystem: .block(format: "ext4", source: initfs.path, destination: "/", options: ["ro"]),
            rosetta: spec.rosetta
        ))
        manager = nativeManager
        var config = LinuxContainer.Configuration()
        config.cpus = spec.cpu
        config.memoryInBytes = spec.memorySize
        config.process = LinuxProcessConfiguration(from: imageConfig)
        config.bootLog = .file(path: bundle.bundlePath.appendingPathComponent("bootlog.log"))
        if spec.network == .nat {
            if #available(macOS 26, *) {
                var net = try VmnetNetwork()
                guard let interface = try net.createInterface(spec.id) else { throw LinuxRuntimeError.prepareFailed("native NAT allocation returned no interface") }
                network = net
                address = interface.ipv4Address.address.description
                config.interfaces = [interface]
            } else {
                throw LinuxRuntimeError.prepareFailed("Containerization 0.31.0 NAT requires macOS 26; use --network none on older supported hosts")
            }
        }
        for share in spec.shares {
            config.mounts.append(.share(source: share.hostPath, destination: "/mnt/" + share.tag, options: share.readOnly ? ["ro"] : []))
        }
        let instance = try LinuxContainer(spec.id, rootfs: rootfs, vmm: nativeManager, configuration: config)
        container = instance
        try await instance.create()
    }

    func start() async throws {
        guard let container, !stopped else { throw LinuxRuntimeError.lifecycleFailed("start: container not created") }
        try await container.start()
    }

    func stop() async throws {
        if stopped { return }
        if await manager?.isPaused == true { try await manager?.resume() }
        var failure: Error?
        if let container {
            do { try await container.stop() } catch { failure = error }
        }
        // Even a failed Containerization create can have an owned running VM.
        try await manager?.stop()
        if let failure { throw LinuxRuntimeError.lifecycleFailed("native VM stopped; container cleanup failed: \(failure)") }
        if var net = network {
            try net.releaseInterface(spec.id)
            network = nil
        }
        pending.removeAll()
        self.container = nil
        manager = nil
        address = nil
        stopped = true
    }

    func kill(signal: Int32) async throws {
        guard let container else { throw LinuxRuntimeError.lifecycleFailed("kill: container not created") }
        try await container.kill(signal)
    }

    func wait() async throws -> Int32 {
        guard let container else { throw LinuxRuntimeError.lifecycleFailed("wait: container not created") }
        return try await container.wait().exitCode
    }

    func pause() async throws {
        guard let manager, !stopped else { throw LinuxRuntimeError.lifecycleFailed("pause: no owned native VM") }
        try await manager.pause()
    }

    func resume() async throws {
        guard let manager, !stopped else { throw LinuxRuntimeError.lifecycleFailed("resume: no owned native VM") }
        try await manager.resume()
    }

    func execve(_ argv: [String], env: [String: String], workdir: String?, tty: Bool, timeout: TimeInterval) async throws -> (exitCode: Int32, stdout: String, stderr: String) {
        guard let container, !stopped, pending.isEmpty, !argv.isEmpty, timeout.isFinite, timeout > 0, timeout <= 300 else { throw LinuxRuntimeError.lifecycleFailed("exec requires an owned runtime with no unresolved guest process and a bounded deadline") }
        guard !tty else { throw LinuxRuntimeError.lifecycleFailed("interactive terminal input is not configured; exec --tty refused") }
        let clock = ContinuousClock(), deadline = clock.now.advanced(by: .seconds(timeout))
        let output = LinuxVMOutput(), errors = LinuxVMOutput()
        var config = LinuxProcessConfiguration()
        config.arguments = argv
        config.environmentVariables = ["PATH=" + LinuxProcessConfiguration.defaultPath] + env.keys.sorted().map { $0 + "=" + env[$0]! }
        config.workingDirectory = workdir ?? "/"
        config.stdout = output
        config.stderr = errors
        let id = UUID().uuidString
        let process = try await container.exec(id, configuration: config)
        pending[id] = process
        try await process.start()
        guard clock.now < deadline else { throw LinuxRuntimeError.lifecycleFailed("exec deadline expired after guest start; outcome unknown; process \(id) retained") }
        let remaining = clock.now.duration(to: deadline).components
        let waitSeconds = max(Int64(1), remaining.seconds + (remaining.attoseconds > 0 ? 1 : 0))
        let result = try await process.wait(timeoutInSeconds: waitSeconds)
        guard clock.now < deadline else { throw LinuxRuntimeError.lifecycleFailed("exec deadline expired; guest returned exit \(result.exitCode), process \(id) retained for cleanup") }
        let stdout = try output.text(), stderr = try errors.text()
        try await process.delete()
        pending.removeValue(forKey: id)
        return (result.exitCode, stdout, stderr)
    }

    func ipAddress() async -> String? {
        address
    }

    private func prepareRootfs(image: Containerization.Image, platform: ContainerizationOCI.Platform) async throws -> Containerization.Mount {
        let fm = FileManager.default
        if fm.fileExists(atPath: bundle.diskPath.path) {
            let handle = try FileHandle(forReadingFrom: bundle.diskPath)
            defer { try? handle.close() }
            try handle.seek(toOffset: 1080)
            if try handle.read(upToCount: 2) == Data([0x53, 0xef]) {
                return .block(format: "ext4", source: bundle.diskPath.path, destination: "/")
            }
            throw LinuxRuntimeError.prepareFailed("existing Disk.img is not an EXT4 root filesystem; it was preserved without replacement")
        }
        let next = bundle.bundlePath.appendingPathComponent("rootfs-" + UUID().uuidString + ".ext4")
        _ = try await EXT4Unpacker(blockSizeInBytes: spec.diskSize).unpack(image, for: platform, at: next)
        if fm.fileExists(atPath: bundle.diskPath.path) {
            throw LinuxRuntimeError.prepareFailed("Disk.img appeared during root filesystem preparation; both existing and staged files were preserved")
        }
        try fm.moveItem(at: next, to: bundle.diskPath)
        let record = try JSONSerialization.data(withJSONObject: ["reference": image.reference, "digest": image.digest], options: [.sortedKeys])
        try record.write(to: bundle.bundlePath.appendingPathComponent("rootfs-image.json"), options: .atomic)
        return .block(format: "ext4", source: bundle.diskPath.path, destination: "/")
    }

    private static func pinnedAsset(_ key: String, maxBytes: Int64) throws -> URL {
        let env = ProcessInfo.processInfo.environment
        guard let path = env[key], path.hasPrefix("/"), !path.contains("\0"), let pin = env[key + "_SHA256"], pin.count == 64, pin.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { throw LinuxRuntimeError.prepareFailed("\(key) and its exact SHA256 are required") }
        let fd = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw LinuxRuntimeError.prepareFailed("cannot open pinned \(key)") }
        defer { Darwin.close(fd) }
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG, metadata.st_size > 0, metadata.st_size <= maxBytes else { throw LinuxRuntimeError.prepareFailed("invalid bounded regular boot asset") }
        var hash = SHA256(), bytes = [UInt8](repeating: 0, count: 65536), total: Int64 = 0
        while true {
            let n = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if n == 0 { break }
            if n < 0 { if errno == EINTR { continue }; throw LinuxRuntimeError.prepareFailed("boot asset read failed") }
            total += Int64(n)
            guard total <= maxBytes else { throw LinuxRuntimeError.prepareFailed("boot asset grew past limit") }
            hash.update(data: Data(bytes.prefix(n)))
        }
        let observed = hash.finalize().map { String(format: "%02x", $0) }.joined()
        guard total == metadata.st_size, observed == pin.lowercased() else { throw LinuxRuntimeError.prepareFailed("boot asset hash differs") }
        return URL(fileURLWithPath: path)
    }
}

private actor RetainedLinuxVMManager: VirtualMachineManager {
    private let base: VZVirtualMachineManager
    private var machine: (any VirtualMachineInstance)?
    private(set) var isPaused = false

    init(_ base: VZVirtualMachineManager) { self.base = base }
    func create(config: some VMCreationConfig) async throws -> any VirtualMachineInstance {
        guard machine == nil else { throw LinuxRuntimeError.lifecycleFailed("native VM already owned") }
        let result = try base.create(config: config)
        machine = result
        return result
    }
    func stop() async throws {
        guard let machine else { return }
        if isPaused { try await machine.resume(); isPaused = false }
        if machine.state != .stopped { try await machine.stop() }
        guard machine.state == .stopped else { throw LinuxRuntimeError.lifecycleFailed("native machine shutdown not confirmed") }
        self.machine = nil
    }
    func pause() async throws {
        guard let machine else { throw LinuxRuntimeError.lifecycleFailed("no owned native VM") }
        try await machine.pause()
        isPaused = true
    }
    func resume() async throws {
        guard let machine else { throw LinuxRuntimeError.lifecycleFailed("no owned native VM") }
        try await machine.resume()
        isPaused = false
    }
}

private final class LinuxVMOutput: Writer, @unchecked Sendable {
    private let buffer = LockedData()
    private let lock = NSLock()
    private var overflow = false
    private var closed = false
    func write(_ data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        guard !closed, !overflow, buffer.appendBounded(data, maxBytes: 262144) else {
            overflow = true
            throw LinuxRuntimeError.lifecycleFailed("guest output exceeds 256KiB per stream")
        }
    }
    func close() throws {
        lock.lock(); closed = true; lock.unlock()
    }
    func text() throws -> String {
        lock.lock(); defer { lock.unlock() }
        guard closed, !overflow, let text = String(data: buffer.snapshot(), encoding: .utf8) else { throw LinuxRuntimeError.lifecycleFailed("guest output has no native EOF receipt, exceeded its bound or is not UTF8") }
        return text
    }
}
#endif
