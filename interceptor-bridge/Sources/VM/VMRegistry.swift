// VMRegistry
//
// Owns the on-disk layout of every VM. Single source of truth for "what VMs
// exist on this host". Persists `registry.json` (index of names→ids) and a
// per-VM `<name>.bundle/spec.json` (the VMSpec).
//
// State directory resolution order (first hit wins):
//   1. action["stateDir"] passed by the CLI (per-invocation override).
//   2. $INTERCEPTOR_VM_STATE_DIR environment variable.
//   3. $CWD/.interceptor/vms/   (default, matches the existing
//      .container-data/ pattern at the project root for Apple's container.)
//
// Bundle layout matches Apple's `VM.bundle` format from
// `apple-developer-docs/Virtualization/running-macos-in-a-virtual-machine-on-apple-silicon.md:21-32`:
//
//   <state>/vms/registry.json
//   <state>/vms/<name>.bundle/
//       spec.json
//       Disk.img
//       AuxiliaryStorage          (macOS only)
//       MachineIdentifier         (macOS only)
//       HardwareModel             (macOS only)
//       RestoreImage.ipsw         (macOS only; optional)
//       snapshots/<tag>/SaveFile.vzvmsave
//       snapshots/<tag>/manifest.json

import Foundation

/// Filesystem layout helper for a single VM bundle. All paths are computed,
/// not stored — re-derive from `state` + `name` so a moved state dir always
/// produces consistent paths.
public struct VMBundle: Sendable {
    public let stateDir: URL
    public let name: String

    public var bundlePath: URL { stateDir.appendingPathComponent("vms/\(name).bundle", isDirectory: true) }
    public var specPath: URL { bundlePath.appendingPathComponent("spec.json") }
    public var diskPath: URL { bundlePath.appendingPathComponent("Disk.img") }
    public var auxStoragePath: URL { bundlePath.appendingPathComponent("AuxiliaryStorage") }
    public var machineIdPath: URL { bundlePath.appendingPathComponent("MachineIdentifier") }
    public var hardwareModelPath: URL { bundlePath.appendingPathComponent("HardwareModel") }
    public var restoreImagePath: URL { bundlePath.appendingPathComponent("RestoreImage.ipsw") }
    public var snapshotsDir: URL { bundlePath.appendingPathComponent("snapshots", isDirectory: true) }

    public func snapshotDir(tag: String) -> URL { snapshotsDir.appendingPathComponent(tag, isDirectory: true) }
    public func snapshotFile(tag: String) -> URL { snapshotDir(tag: tag).appendingPathComponent("SaveFile.vzvmsave") }
    public func snapshotManifest(tag: String) -> URL { snapshotDir(tag: tag).appendingPathComponent("manifest.json") }
}

/// Top-level registry index. Kept tiny so the lock window is short.
struct VMRegistryIndex: Codable, Sendable {
    var version: Int                    // bump when the on-disk shape changes
    var entries: [String: String]       // name → id

    static let current: Int = 1
    static let empty = VMRegistryIndex(version: VMRegistryIndex.current, entries: [:])
}

public enum VMRegistryError: Error, CustomStringConvertible, Sendable {
    case duplicateName(String)
    case notFound(String)
    case ioFailure(String)
    case corruptIndex(String)
    case bundleMissing(String)

    public var description: String {
        switch self {
        case .duplicateName(let n): return "registry.duplicateName: '\(n)' already exists"
        case .notFound(let n): return "registry.notFound: '\(n)'"
        case .ioFailure(let m): return "registry.ioFailure: \(m)"
        case .corruptIndex(let m): return "registry.corruptIndex: \(m)"
        case .bundleMissing(let n): return "registry.bundleMissing: '\(n)' has no on-disk bundle"
        }
    }
}

/// Async actor that owns the registry. Every read/write is serialized
/// through the actor's mailbox so concurrent verbs cannot tear the index.
public actor VMRegistry {
    private let stateDir: URL
    private let indexURL: URL
    private let fm = FileManager.default

    public init(stateDir: URL) throws {
        self.stateDir = stateDir
        self.indexURL = stateDir.appendingPathComponent("vms/registry.json")
        try Self.ensureDirectory(stateDir.appendingPathComponent("vms"))
    }

    /// Resolve the state directory using the precedence order documented at
    /// the top of this file.
    public static func resolveStateDir(actionOverride: String? = nil) -> URL {
        if let s = actionOverride, !s.isEmpty {
            return URL(fileURLWithPath: (s as NSString).expandingTildeInPath)
        }
        if let envS = ProcessInfo.processInfo.environment["INTERCEPTOR_VM_STATE_DIR"], !envS.isEmpty {
            return URL(fileURLWithPath: (envS as NSString).expandingTildeInPath)
        }
        let cwd = FileManager.default.currentDirectoryPath
        return URL(fileURLWithPath: cwd).appendingPathComponent(".interceptor", isDirectory: true)
    }

    /// Create the directory if missing; no-op if it exists.
    private static func ensureDirectory(_ url: URL) throws {
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) {
            if !isDir.boolValue {
                throw VMRegistryError.ioFailure("\(url.path) exists but is not a directory")
            }
            return
        }
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    // MARK: - Index I/O

    private func readIndex() throws -> VMRegistryIndex {
        guard fm.fileExists(atPath: indexURL.path) else {
            return .empty
        }
        let data: Data
        do { data = try Data(contentsOf: indexURL) }
        catch { throw VMRegistryError.ioFailure("read registry.json: \(error.localizedDescription)") }
        guard !data.isEmpty else { return .empty }
        do {
            return try JSONDecoder().decode(VMRegistryIndex.self, from: data)
        } catch {
            throw VMRegistryError.corruptIndex("decode registry.json: \(error.localizedDescription)")
        }
    }

    private func writeIndex(_ index: VMRegistryIndex) throws {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data: Data
        do { data = try enc.encode(index) }
        catch { throw VMRegistryError.ioFailure("encode registry.json: \(error.localizedDescription)") }
        // atomic write so a crash mid-write can't corrupt the index.
        do {
            try data.write(to: indexURL, options: .atomic)
        } catch {
            throw VMRegistryError.ioFailure("write registry.json: \(error.localizedDescription)")
        }
    }

    // MARK: - Spec I/O

    private func readSpec(at url: URL) throws -> VMSpec {
        guard fm.fileExists(atPath: url.path) else {
            throw VMRegistryError.bundleMissing(url.path)
        }
        let data: Data
        do { data = try Data(contentsOf: url) }
        catch { throw VMRegistryError.ioFailure("read spec.json: \(error.localizedDescription)") }
        do {
            let dec = JSONDecoder()
            dec.dateDecodingStrategy = .iso8601
            return try dec.decode(VMSpec.self, from: data)
        } catch {
            throw VMRegistryError.corruptIndex("decode spec.json: \(error.localizedDescription)")
        }
    }

    private func writeSpec(_ spec: VMSpec, to url: URL) throws {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        enc.dateEncodingStrategy = .iso8601
        let data: Data
        do { data = try enc.encode(spec) }
        catch { throw VMRegistryError.ioFailure("encode spec.json: \(error.localizedDescription)") }
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            throw VMRegistryError.ioFailure("write spec.json: \(error.localizedDescription)")
        }
    }

    // MARK: - Public surface

    public func bundle(for name: String) -> VMBundle {
        VMBundle(stateDir: stateDir, name: name)
    }

    /// Atomically create a new VM entry. Throws `duplicateName` if a VM
    /// with the same name already exists in the index.
    public func create(_ spec: VMSpec) throws -> VMBundle {
        try spec.validateStatic()
        var index = try readIndex()
        if index.entries[spec.name] != nil {
            throw VMRegistryError.duplicateName(spec.name)
        }
        let bundle = VMBundle(stateDir: stateDir, name: spec.name)
        try Self.ensureDirectory(bundle.bundlePath)
        try Self.ensureDirectory(bundle.snapshotsDir)
        try writeSpec(spec, to: bundle.specPath)
        index.entries[spec.name] = spec.id
        try writeIndex(index)
        return bundle
    }

    public func get(_ name: String) throws -> VMSpec {
        let bundle = VMBundle(stateDir: stateDir, name: name)
        let index = try readIndex()
        guard index.entries[name] != nil else {
            throw VMRegistryError.notFound(name)
        }
        return try readSpec(at: bundle.specPath)
    }

    public func list() throws -> [VMSpec] {
        let index = try readIndex()
        var out: [VMSpec] = []
        out.reserveCapacity(index.entries.count)
        for (name, _) in index.entries.sorted(by: { $0.key < $1.key }) {
            let bundle = VMBundle(stateDir: stateDir, name: name)
            // Be lenient: if a bundle has been hand-deleted but the index
            // still references it, skip rather than crash the entire list.
            guard fm.fileExists(atPath: bundle.specPath.path) else { continue }
            do {
                out.append(try readSpec(at: bundle.specPath))
            } catch {
                // skip corrupt specs but log via Platform in production
                continue
            }
        }
        return out
    }

    /// Update an existing spec (e.g. after `vm start` sets `startedAt`).
    public func update(_ spec: VMSpec) throws {
        let index = try readIndex()
        guard index.entries[spec.name] != nil else {
            throw VMRegistryError.notFound(spec.name)
        }
        let bundle = VMBundle(stateDir: stateDir, name: spec.name)
        try writeSpec(spec, to: bundle.specPath)
    }

    /// Remove a VM atomically — drop from index and rm-rf the bundle dir.
    /// Pre-condition: caller has already stopped the VM (VMInstance is gone).
    public func delete(_ name: String, keepDisk: Bool = false) throws {
        var index = try readIndex()
        guard index.entries[name] != nil else {
            throw VMRegistryError.notFound(name)
        }
        let bundle = VMBundle(stateDir: stateDir, name: name)
        index.entries.removeValue(forKey: name)
        try writeIndex(index)
        // remove the bundle dir; if `keepDisk` is set, move it aside
        // instead so the user can recover. Apple's container `delete`
        // verb has no equivalent flag — we add this because manual disk
        // resize via tools outside Interceptor is a common workflow.
        if keepDisk {
            let kept = stateDir.appendingPathComponent("vms/\(name).orphan-\(Int(Date().timeIntervalSince1970)).bundle")
            try? fm.moveItem(at: bundle.bundlePath, to: kept)
        } else {
            try? fm.removeItem(at: bundle.bundlePath)
        }
    }

    /// APFS clone-from-gold. Uses `clonefile(2)` for instant CoW copy of
    /// Disk.img + aux. Caller is expected to pass a fresh
    /// `VZMacMachineIdentifier` for macOS guests so the clone doesn't
    /// collide with the source.
    ///
    /// We use `FileManager.copyItem(at:to:)` which transparently invokes
    /// `clonefile(2)` on APFS volumes per Apple's documentation. No need
    /// to drop to the BSD syscall directly.
    public func clone(from srcName: String, to dstName: String) throws -> VMBundle {
        var index = try readIndex()
        guard let _ = index.entries[srcName] else {
            throw VMRegistryError.notFound(srcName)
        }
        if index.entries[dstName] != nil {
            throw VMRegistryError.duplicateName(dstName)
        }
        let srcBundle = VMBundle(stateDir: stateDir, name: srcName)
        let dstBundle = VMBundle(stateDir: stateDir, name: dstName)
        // Read the source spec, rebrand under the new name, write to dst.
        var srcSpec = try readSpec(at: srcBundle.specPath)
        srcSpec.name = dstName
        srcSpec.id = UUID().uuidString
        srcSpec.startedAt = nil
        // Create dst dir then copy each file individually. We avoid
        // copyItem(at:bundleDir) because that recurses through snapshots/
        // which we want to omit from clones.
        try Self.ensureDirectory(dstBundle.bundlePath)
        try Self.ensureDirectory(dstBundle.snapshotsDir)
        try writeSpec(srcSpec, to: dstBundle.specPath)
        for filename in ["Disk.img", "AuxiliaryStorage", "MachineIdentifier", "HardwareModel"] {
            let src = srcBundle.bundlePath.appendingPathComponent(filename)
            let dst = dstBundle.bundlePath.appendingPathComponent(filename)
            if fm.fileExists(atPath: src.path) {
                do {
                    try fm.copyItem(at: src, to: dst)  // clonefile(2) on APFS
                } catch {
                    throw VMRegistryError.ioFailure("clone \(filename): \(error.localizedDescription)")
                }
            }
        }
        index.entries[dstName] = srcSpec.id
        try writeIndex(index)
        return dstBundle
    }
}
