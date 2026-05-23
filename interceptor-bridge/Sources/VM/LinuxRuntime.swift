// LinuxRuntime
//
// Wraps the Apple Containerization Swift package's high-level
// `LinuxContainer` API for in-process Linux guest lifecycle. This is the
// recipe `apple/container`'s SandboxService uses at
// `research/container/Sources/Services/ContainerSandboxService/Server/SandboxService.swift:164-261`:
//
//     let vmm = VZVirtualMachineManager(kernel:..., initialFilesystem:..., rosetta:..., logger:...)
//     let container = try LinuxContainer(id, rootfs: rootfs, vmm: vmm, logger: log) { czConfig in
//         czConfig.interfaces = ...
//         czConfig.process.stdout = ...
//         czConfig.hosts = Hosts(entries: ...)
//         czConfig.bootLog = BootLog.file(path: bundle.bootlog, append: true)
//     }
//     try await container.create()      // boot the VM
//     try await container.start()       // start init process
//     try await container.exec(id, configuration:) // run new process
//     try await container.kill(SIGTERM) // signal
//     try await container.stop()        // graceful stop
//
// In v0 we instantiate Containerization types unconditionally, but everything
// is gated `#if canImport(Containerization)` so the bridge can still build on
// dev environments where the package hasn't been resolved.

import Foundation

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
    func execve(_ argv: [String], env: [String: String], workdir: String?, tty: Bool) async throws -> (exitCode: Int32, stdout: String, stderr: String)
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
/// Concrete handle, in-process LinuxContainer wrapper.
final class LinuxRuntimeImpl: LinuxRuntimeHandle, @unchecked Sendable {
    private let spec: VMSpec
    private let bundle: VMBundle
    // We do not store the LinuxContainer here as a typed property because
    // Containerization's actual public API surface evolves between
    // releases. Storing it via `Any` plus a few helper closures keeps the
    // bridge buildable across point releases while we tail Apple's pin.
    private var container: Any?

    init(spec: VMSpec, bundle: VMBundle) async throws {
        self.spec = spec
        self.bundle = bundle
        // Eager construction would require us to enumerate the kernel +
        // initrd inside Containerization's bundle layout, which is
        // documented but version-sensitive. v0 defers construction to
        // `create()` so a `vm create` that does not boot doesn't pay the
        // cost of locating Containerization assets.
    }

    func create() async throws {
        // Real Containerization initialization happens here in v0+. For
        // the bridge to build cleanly without resolving the package we
        // gate the body with `if false`-style availability — once
        // `swift package update` brings in containerization 0.31.0 the
        // body becomes the SandboxService.swift recipe documented at the
        // top of this file. Until then we surface a clear error.
        throw LinuxRuntimeError.prepareFailed(
            "LinuxRuntime.create() pending Containerization runtime wiring. The package is linked, but the LinuxContainer boot recipe still needs to be mapped to the current Containerization API before Linux guests can boot."
        )
    }

    func start() async throws {
        throw LinuxRuntimeError.lifecycleFailed("start: container not yet created")
    }

    func stop() async throws {
        throw LinuxRuntimeError.lifecycleFailed("stop: container not yet created")
    }

    func kill(signal: Int32) async throws {
        throw LinuxRuntimeError.lifecycleFailed("kill: container not yet created")
    }

    func wait() async throws -> Int32 {
        throw LinuxRuntimeError.lifecycleFailed("wait: container not yet created")
    }

    func execve(_ argv: [String], env: [String: String], workdir: String?, tty: Bool) async throws -> (exitCode: Int32, stdout: String, stderr: String) {
        // Once container is created we use container.exec(id, configuration:)
        // and capture stdout/stderr through the process's stdio handles.
        throw LinuxRuntimeError.lifecycleFailed("execve: container not yet created")
    }

    func ipAddress() async -> String? {
        // Containerization exposes the interfaces via the container config;
        // we'll wire this once the package resolves.
        return nil
    }
}
#endif
