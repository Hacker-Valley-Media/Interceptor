// VMSpec
//
// Codable spec for a single VM. Persisted to <state>/vms/<name>.bundle/spec.json
// alongside Apple's `VM.bundle` files (Disk.img, AuxiliaryStorage,
// MachineIdentifier, HardwareModel) per
// `apple-developer-docs/Virtualization/running-macos-in-a-virtual-machine-on-apple-silicon.md:21-32`.
//
// We do not import Virtualization here — VMSpec is pure data. Runtime
// validation against `VZVirtualMachineConfiguration.validate()` happens in
// VMInstance after the spec has been used to build a configuration.

import Foundation

/// VM kind. Linux guests use the Containerization Swift package's
/// `LinuxContainer` runtime; macOS guests use raw Virtualization framework
/// (`VZMacOSInstaller`, `VZVirtualMachine`).
public enum VMKind: String, Codable, Sendable {
    case linux
    case macos
}

/// Lifecycle status. Mirrors the design notes state diagram exactly. `VZVirtualMachine.State`
/// has fewer cases (`stopped/starting/running/paused/stopping/error`); we add
/// Interceptor-managed pre- and post- states (`created`, `imagePulling`, `installing`,
/// `ready`, `savingSnapshot`, `restoringSnapshot`, `deleted`) so progress is
/// reportable without overloading Apple's enum.
public enum VMStatus: String, Codable, Sendable {
    case created
    case imagePulling
    case installing
    case ready
    case starting
    case running
    case paused
    case stopping
    case stopped
    case savingSnapshot
    case restoringSnapshot
    case error
    case deleted
}

/// Network mode. NAT routes guest packets through the host (the only mode
/// Interceptor ships). Bridged + vmnet attachments are out of scope —
/// `com.apple.vm.networking` is Apple-restricted and not pursued.
public enum VMNetworkMode: String, Codable, Sendable {
    case none
    case nat
}

public enum VMProviderKind: String, Codable, Sendable, Equatable {
    case appleVZ
    case containerization
    case lume
    case tart
    case utm
    case qemu
    case externalAgent
}

public enum VMAdoptMode: String, Codable, Sendable, Equatable {
    case clone
    case move
    case reference
}

/// virtio-fs share. `tag` is the mount label the guest uses: `mount -t virtiofs <tag>`.
public struct VMShareSpec: Codable, Sendable, Equatable {
    public var hostPath: String
    public var tag: String
    public var readOnly: Bool
    public init(hostPath: String, tag: String, readOnly: Bool = true) {
        self.hostPath = hostPath
        self.tag = tag
        self.readOnly = readOnly
    }
}

/// Persisted spec. Bytes for memory/disk are absolute bytes (not GiB) so
/// the JSON is unambiguous across rounding modes.
public struct VMSpec: Codable, Sendable, Equatable {
    public var name: String
    public var id: String                 // UUID string
    public var kind: VMKind
    public var cpu: Int
    public var memorySize: UInt64         // bytes
    public var diskSize: UInt64           // bytes
    /// macOS guest: IPSW path on disk, or sentinel `"latest"` to mean
    /// `VZMacOSRestoreImage.latestSupported`.
    /// Linux guest: OCI reference such as `docker.io/library/alpine:3`.
    public var image: String
    public var network: VMNetworkMode
    public var shares: [VMShareSpec]
    /// Linux + ARM host only. Attaches `VZLinuxRosettaDirectoryShare`.
    public var rosetta: Bool
    public var createdAt: Date
    public var startedAt: Date?
    /// Last computed `validateSaveRestoreSupport()` result, cached so
    /// `vm snapshot --paused-state` can refuse without instantiating a VM.
    public var snapshotSupported: Bool?
    public var provider: VMProviderKind?
    public var sourcePath: String?
    public var adoptMode: VMAdoptMode?
    /// Optional persisted NIC MAC address. Preserving this for adopted VMs
    /// keeps NAT DHCP leases stable across boots and lets the host map a
    /// running macOS guest back to its bridge100 IP.
    public var macAddress: String?

    public init(
        name: String,
        id: String = UUID().uuidString,
        kind: VMKind,
        cpu: Int,
        memorySize: UInt64,
        diskSize: UInt64,
        image: String,
        network: VMNetworkMode = .nat,
        shares: [VMShareSpec] = [],
        rosetta: Bool = false,
        createdAt: Date = Date(),
        startedAt: Date? = nil,
        snapshotSupported: Bool? = nil,
        provider: VMProviderKind? = nil,
        sourcePath: String? = nil,
        adoptMode: VMAdoptMode? = nil,
        macAddress: String? = nil
    ) {
        self.name = name
        self.id = id
        self.kind = kind
        self.cpu = cpu
        self.memorySize = memorySize
        self.diskSize = diskSize
        self.image = image
        self.network = network
        self.shares = shares
        self.rosetta = rosetta
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.snapshotSupported = snapshotSupported
        self.provider = provider
        self.sourcePath = sourcePath
        self.adoptMode = adoptMode
        self.macAddress = macAddress
    }

    /// Static validation that does NOT require Virtualization framework
    /// initialization. Checks invariants that can be evaluated from pure
    /// data: name shape, cpu/memory/disk bounds, kind-image compatibility.
    /// Runtime validation against `VZVirtualMachineConfiguration.validate()`
    /// happens later in `VMInstance.prepareConfiguration()`.
    public func validateStatic() throws {
        guard !name.isEmpty else {
            throw VMSpecError.invalidName("name must be non-empty")
        }
        // Names map to filesystem dir names; keep them shell-safe.
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
        guard name.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            throw VMSpecError.invalidName("name '\(name)' contains characters outside [A-Za-z0-9._-]")
        }
        guard cpu >= 1 && cpu <= 64 else {
            throw VMSpecError.invalidResource("cpu must be 1..64 (got \(cpu))")
        }
        // 256 MiB lower bound (smaller than this and the Linux init dies).
        // Upper bound deliberately generous; the host's
        // VZVirtualMachineConfiguration.maximumAllowedMemorySize is the
        // real ceiling, enforced at instantiation.
        let minMem: UInt64 = 256 * 1024 * 1024
        guard memorySize >= minMem else {
            throw VMSpecError.invalidResource("memorySize must be ≥ \(minMem) bytes (got \(memorySize))")
        }
        // 100 MiB lower disk floor — enough to hold a minimal Alpine rootfs.
        let minDisk: UInt64 = 100 * 1024 * 1024
        guard diskSize >= minDisk else {
            throw VMSpecError.invalidResource("diskSize must be ≥ \(minDisk) bytes (got \(diskSize))")
        }
        switch kind {
        case .linux:
            guard image.contains(":") || image == "latest" else {
                throw VMSpecError.invalidImage("linux image must be an OCI ref like 'docker.io/library/alpine:3'")
            }
        case .macos:
            // image is either an absolute path to an .ipsw or the sentinel "latest"
            guard image == "latest" || image.hasSuffix(".ipsw") else {
                throw VMSpecError.invalidImage("macos image must be an .ipsw path or 'latest'")
            }
        }
        if rosetta && kind != .linux {
            throw VMSpecError.invalidResource("rosetta is only valid for linux guests")
        }
    }
}

public enum VMSpecError: Error, CustomStringConvertible, Sendable {
    case invalidName(String)
    case invalidResource(String)
    case invalidImage(String)

    public var description: String {
        switch self {
        case .invalidName(let m): return "spec.invalidName: \(m)"
        case .invalidResource(let m): return "spec.invalidResource: \(m)"
        case .invalidImage(let m): return "spec.invalidImage: \(m)"
        }
    }
}

/// Serialized view that the daemon / CLI surfaces for `vm get` / `vm list`.
/// Lighter than `VMSpec` (omits internal-only fields) and uses string-encoded
/// statuses so JSON is friendly to jq.
public struct VMPublicView: Codable, Sendable {
    public var name: String
    public var id: String
    public var kind: String
    public var status: String
    public var ipAddress: String?
    public var cpu: Int
    public var memorySize: UInt64
    public var diskSize: UInt64
    public var network: String
    public var createdAt: String
    public var startedAt: String?
    public var snapshotSupported: Bool?

    public init(spec: VMSpec, status: VMStatus, ipAddress: String? = nil) {
        let iso = ISO8601DateFormatter()
        self.name = spec.name
        self.id = spec.id
        self.kind = spec.kind.rawValue
        self.status = status.rawValue
        self.ipAddress = ipAddress
        self.cpu = spec.cpu
        self.memorySize = spec.memorySize
        self.diskSize = spec.diskSize
        self.network = spec.network.rawValue
        self.createdAt = iso.string(from: spec.createdAt)
        self.startedAt = spec.startedAt.map { iso.string(from: $0) }
        self.snapshotSupported = spec.snapshotSupported
    }

    /// Convert to a `[String: Any]` payload suitable for `WireFormat.success(data:)`.
    public var asDictionary: [String: Any] {
        var d: [String: Any] = [
            "name": name,
            "id": id,
            "kind": kind,
            "status": status,
            "cpu": cpu,
            "memorySize": memorySize,
            "diskSize": diskSize,
            "network": network,
            "createdAt": createdAt,
        ]
        if let ip = ipAddress { d["ipAddress"] = ip }
        if let s = startedAt { d["startedAt"] = s }
        if let snap = snapshotSupported { d["snapshotSupported"] = snap }
        return d
    }
}
