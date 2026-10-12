// VMSnapshot
//
// Two layers design:
//   1. Pause-state via `VZVirtualMachine.saveMachineStateTo(url:)` →
//      `<bundle>/snapshots/<tag>/SaveFile.vzvmsave`. Requires the
//      configuration to pass `validateSaveRestoreSupport()` per
//      `apple-developer-docs/Virtualization/VZVirtualMachineConfiguration.md`
//      and `running-macos-in-a-virtual-machine-on-apple-silicon.md:50`.
//   2. Disk-state via APFS `clonefile(2)` of Disk.img (and aux files
//      for macOS guests). FileManager.copyItem(at:to:) uses clonefile(2)
//      transparently on APFS volumes.
//
// `manifest.json` in the snapshot dir records when the snapshot was
// taken, which kind, and which storage files were actually copied.

import Foundation
#if canImport(Virtualization)
import Virtualization
#endif

public struct VMSnapshotManifest: Codable, Sendable {
    public var tag: String
    public var kind: String                  // "paused-state" | "disk-only" | "both"
    public var createdAt: Date
    public var hasPausedState: Bool
    public var hasDiskClone: Bool
    public var notes: String?
}

public enum VMSnapshotError: Error, CustomStringConvertible, Sendable {
    case notSupported(String)
    case ioFailure(String)
    case alreadyExists(String)
    case missing(String)

    public var description: String {
        switch self {
        case .notSupported(let m): return "snapshot.notSupported: \(m)"
        case .ioFailure(let m): return "snapshot.ioFailure: \(m)"
        case .alreadyExists(let m): return "snapshot.alreadyExists: \(m)"
        case .missing(let m): return "snapshot.missing: \(m)"
        }
    }
}

public struct VMSnapshot: Sendable {
    static func requireStableStorage(bundle: VMBundle) throws {
        let pending = bundle.bundlePath.appendingPathComponent("restore-pending.json")
        guard !FileManager.default.fileExists(atPath: pending.path) else {
            throw VMSnapshotError.ioFailure("storage restore outcome is unresolved; prior files and operation receipt retained at \(pending.path)")
        }
    }
    public enum Mode: String, Sendable {
        case both
        case pausedStateOnly
        case diskOnly
    }

    /// Paused-state save/restore (`VZVirtualMachine.saveMachineStateTo` /
    /// `restoreMachineStateFrom`) is declared only for Apple silicon in the SDK.
    /// Callers run this preflight before touching the filesystem so an
    /// unsupported request fails without leaving a half-made snapshot directory
    /// or a replaced live disk behind.
    static func requirePausedStateSupport(_ operation: String) throws {
        #if !arch(arm64)
        throw VMSnapshotError.notSupported("\(operation) requires Apple silicon; use diskOnly on Intel")
        #endif
    }

#if canImport(Virtualization)
    /// Save the current paused-state of `vm` and clone `Disk.img` to a new
    /// `<bundle>/snapshots/<tag>/` directory. The VM MUST be paused before
    /// calling for `mode != .diskOnly`.
    @available(macOS 14.0, *)
    public static func create(
        vm: VZVirtualMachine,
        queue: DispatchQueue,
        bundle: VMBundle,
        tag: String,
        mode: Mode
    ) async throws -> VMSnapshotManifest {
        let snapDir = bundle.snapshotDir(tag: tag)
        if FileManager.default.fileExists(atPath: snapDir.path) {
            throw VMSnapshotError.alreadyExists(snapDir.path)
        }
        if mode != .diskOnly {
            try requirePausedStateSupport("paused-state snapshots")
        }
        let machine = UncheckedSendableBox(vm)
        let validState = await withCheckedContinuation { cc in
            queue.async { cc.resume(returning: machine.value.state == (mode == .diskOnly ? .stopped : .paused)) }
        }
        guard validState else { throw VMSnapshotError.notSupported("snapshot requires the corresponding native stopped or paused state") }
        do {
            try FileManager.default.createDirectory(at: snapDir, withIntermediateDirectories: true)
        } catch {
            throw VMSnapshotError.ioFailure("create snapshot dir: \(error.localizedDescription)")
        }

        var hasPaused = false
        var hasDisk = false

        if mode != .diskOnly {
            let saveURL = bundle.snapshotFile(tag: tag)
            #if arch(arm64)
            do {
                try await pausedStateIO(vm: vm, queue: queue, file: saveURL, save: true)
                hasPaused = true
            } catch {
                throw VMSnapshotError.ioFailure("saveMachineStateTo: \(error.localizedDescription)")
            }
            #else
            // VZVirtualMachine save/restore of machine state is declared only for Apple silicon in the SDK.
            _ = saveURL
            throw VMSnapshotError.notSupported("paused-state snapshots require Apple silicon; use diskOnly on Intel")
            #endif
        }

        if mode != .pausedStateOnly {
            let src = bundle.diskPath
            let dst = snapDir.appendingPathComponent("Disk.img")
            guard FileManager.default.fileExists(atPath: src.path) else { throw VMSnapshotError.missing("snapshot has no actual Disk.img") }
            do {
                try FileManager.default.copyItem(at: src, to: dst)
                if FileManager.default.fileExists(atPath: bundle.auxStoragePath.path) {
                    try FileManager.default.copyItem(at: bundle.auxStoragePath, to: snapDir.appendingPathComponent("AuxiliaryStorage"))
                }
                hasDisk = true
            } catch {
                throw VMSnapshotError.ioFailure("clone VM storage: \(error.localizedDescription)")
            }
        }

        let manifest = VMSnapshotManifest(
            tag: tag,
            kind: mode.rawValue,
            createdAt: Date(),
            hasPausedState: hasPaused,
            hasDiskClone: hasDisk,
            notes: nil
        )
        try writeManifest(manifest, to: bundle.snapshotManifest(tag: tag))
        return manifest
    }

    /// Restore a snapshot. For paused-state restore the VM must NOT yet be
    /// running. Returns the post-restore manifest so the caller knows what
    /// was restored.
    @available(macOS 14.0, *)
    public static func restore(
        vm: VZVirtualMachine,
        queue: DispatchQueue,
        bundle: VMBundle,
        tag: String,
        pausedStateOnly: Bool = false,
        diskOnly: Bool = false
    ) async throws -> VMSnapshotManifest {
        try requireStableStorage(bundle: bundle)
        let manifestURL = bundle.snapshotManifest(tag: tag)
        guard FileManager.default.fileExists(atPath: manifestURL.path) else {
            throw VMSnapshotError.missing("snapshot '\(tag)' not found at \(manifestURL.path)")
        }
        let manifest = try readManifest(at: manifestURL)
        if !diskOnly && manifest.hasPausedState {
            try requirePausedStateSupport("paused-state restore")
        }

        if !pausedStateOnly && manifest.hasDiskClone {
            throw VMSnapshotError.notSupported("restore disk storage before constructing the native VM; use the VMInstance restore path")
        }

        if !diskOnly && manifest.hasPausedState {
            let saveURL = bundle.snapshotFile(tag: tag)
            #if arch(arm64)
            do {
                try await pausedStateIO(vm: vm, queue: queue, file: saveURL, save: false)
            } catch {
                throw VMSnapshotError.ioFailure("restoreMachineStateFrom: \(error.localizedDescription)")
            }
            #else
            _ = saveURL
            throw VMSnapshotError.notSupported("paused-state restore requires Apple silicon; use diskOnly on Intel")
            #endif
        }

        return manifest
    }

    @available(macOS 14.0, *)
    public static func restorePausedState(
        vm: VZVirtualMachine,
        queue: DispatchQueue,
        bundle: VMBundle,
        tag: String
    ) async throws -> VMSnapshotManifest {
        let manifest = try manifest(bundle: bundle, tag: tag)
        guard manifest.hasPausedState else {
            throw VMSnapshotError.missing("snapshot '\(tag)' has no paused machine state")
        }
        try requirePausedStateSupport("paused-state restore")
        let saveURL = bundle.snapshotFile(tag: tag)
        #if arch(arm64)
        do {
            try await pausedStateIO(vm: vm, queue: queue, file: saveURL, save: false)
        } catch {
            throw VMSnapshotError.ioFailure("restoreMachineStateFrom: \(error.localizedDescription)")
        }
        return manifest
        #else
        _ = saveURL
        throw VMSnapshotError.notSupported("paused-state restore requires Apple silicon; use diskOnly on Intel")
        #endif
    }

    #if arch(arm64)
    @available(macOS 14.0, *)
    private static func pausedStateIO(vm: VZVirtualMachine, queue: DispatchQueue, file: URL, save: Bool) async throws {
        let machine = UncheckedSendableBox(vm)
        try await withCheckedThrowingContinuation { (cc: CheckedContinuation<Void, Error>) in
            queue.async {
                guard machine.value.state == (save ? .paused : .stopped) else {
                    cc.resume(throwing: VMSnapshotError.notSupported("native snapshot state differs before SDK operation")); return
                }
                let completed: @Sendable (Error?) -> Void = { error in
                    if let error {
                        cc.resume(throwing: VMSnapshotError.ioFailure("native machine-state operation: \(error.localizedDescription)"))
                    } else if machine.value.state != .paused {
                        cc.resume(throwing: VMSnapshotError.ioFailure("native machine-state operation did not confirm paused state"))
                    } else {
                        cc.resume(returning: ())
                    }
                }
                if save { machine.value.saveMachineStateTo(url: file, completionHandler: completed) }
                else { machine.value.restoreMachineStateFrom(url: file, completionHandler: completed) }
            }
        }
    }
    #endif
#endif

    public static func manifest(bundle: VMBundle, tag: String) throws -> VMSnapshotManifest {
        let manifestURL = bundle.snapshotManifest(tag: tag)
        guard FileManager.default.fileExists(atPath: manifestURL.path) else {
            throw VMSnapshotError.missing("snapshot '\(tag)' not found at \(manifestURL.path)")
        }
        return try readManifest(at: manifestURL)
    }

    public static func restoreDisk(bundle: VMBundle, tag: String) throws -> VMSnapshotManifest {
        try requireStableStorage(bundle: bundle)
        let manifest = try manifest(bundle: bundle, tag: tag)
        guard manifest.hasDiskClone else {
            throw VMSnapshotError.missing("snapshot '\(tag)' has no Disk.img")
        }
        let fm = FileManager.default
        let files = ["Disk.img", "AuxiliaryStorage"].filter { $0 == "Disk.img" || fm.fileExists(atPath: bundle.snapshotDir(tag: tag).appendingPathComponent($0).path) }
        let id = UUID().uuidString
        let pending = bundle.bundlePath.appendingPathComponent("restore-pending.json")
        // Stage every actual snapshot file before moving any live storage.
        for file in files {
            let source = bundle.snapshotDir(tag: tag).appendingPathComponent(file)
            guard fm.fileExists(atPath: source.path) else { throw VMSnapshotError.missing("snapshot is missing actual \(file)") }
            try fm.copyItem(at: source, to: bundle.bundlePath.appendingPathComponent(file + ".restore-next-" + id))
        }
        let receipt = try JSONSerialization.data(withJSONObject: ["id": id, "tag": tag, "files": files, "priorSuffix": ".pre-restore-" + id, "nextSuffix": ".restore-next-" + id], options: [.sortedKeys])
        try receipt.write(to: pending, options: .atomic)
        guard try Data(contentsOf: pending) == receipt else { throw VMSnapshotError.ioFailure("restore operation receipt readback differs") }
        for file in files {
            let live = bundle.bundlePath.appendingPathComponent(file)
            let parked = bundle.bundlePath.appendingPathComponent(file + ".pre-restore-" + id)
            if fm.fileExists(atPath: live.path) { try fm.moveItem(at: live, to: parked) }
            do {
                try fm.moveItem(at: bundle.bundlePath.appendingPathComponent(file + ".restore-next-" + id), to: live)
            } catch {
                throw VMSnapshotError.ioFailure("restore outcome unknown for \(file); prior storage retained at \(parked.path): \(error.localizedDescription)")
            }
        }
        try fm.removeItem(at: pending)
        return manifest
    }

    public static func list(bundle: VMBundle) -> [String] {
        let snapsDir = bundle.snapshotsDir
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: snapsDir.path) else {
            return []
        }
        return entries.sorted()
    }

    public static func delete(bundle: VMBundle, tag: String) throws {
        let dir = bundle.snapshotDir(tag: tag)
        guard FileManager.default.fileExists(atPath: dir.path) else {
            throw VMSnapshotError.missing("snapshot '\(tag)' not found")
        }
        do {
            try FileManager.default.removeItem(at: dir)
        } catch {
            throw VMSnapshotError.ioFailure("delete snapshot: \(error.localizedDescription)")
        }
    }

    // MARK: - manifest I/O

    private static func writeManifest(_ m: VMSnapshotManifest, to url: URL) throws {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        enc.dateEncodingStrategy = .iso8601
        do {
            let data = try enc.encode(m)
            try data.write(to: url, options: .atomic)
        } catch {
            throw VMSnapshotError.ioFailure("write manifest: \(error.localizedDescription)")
        }
    }

    private static func readManifest(at url: URL) throws -> VMSnapshotManifest {
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        do {
            let data = try Data(contentsOf: url)
            return try dec.decode(VMSnapshotManifest.self, from: data)
        } catch {
            throw VMSnapshotError.ioFailure("read manifest: \(error.localizedDescription)")
        }
    }
}
