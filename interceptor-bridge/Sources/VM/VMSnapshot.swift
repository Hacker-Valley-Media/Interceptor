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
// taken, which kind, and which Disk.img digest it points at.

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
    public enum Mode: String, Sendable {
        case both
        case pausedStateOnly
        case diskOnly
    }

#if canImport(Virtualization)
    /// Save the current paused-state of `vm` and clone `Disk.img` to a new
    /// `<bundle>/snapshots/<tag>/` directory. The VM MUST be paused before
    /// calling for `mode != .diskOnly`.
    @available(macOS 14.0, *)
    public static func create(
        vm: VZVirtualMachine,
        bundle: VMBundle,
        tag: String,
        mode: Mode
    ) async throws -> VMSnapshotManifest {
        let snapDir = bundle.snapshotDir(tag: tag)
        if FileManager.default.fileExists(atPath: snapDir.path) {
            throw VMSnapshotError.alreadyExists(snapDir.path)
        }
        do {
            try FileManager.default.createDirectory(at: snapDir, withIntermediateDirectories: true)
        } catch {
            throw VMSnapshotError.ioFailure("create snapshot dir: \(error.localizedDescription)")
        }

        var hasPaused = false
        var hasDisk = false

        if mode != .diskOnly {
            let saveURL = bundle.snapshotFile(tag: tag)
            do {
                try await vm.saveMachineStateTo(url: saveURL)
                hasPaused = true
            } catch {
                throw VMSnapshotError.ioFailure("saveMachineStateTo: \(error.localizedDescription)")
            }
        }

        if mode != .pausedStateOnly {
            let src = bundle.diskPath
            let dst = snapDir.appendingPathComponent("Disk.img")
            if FileManager.default.fileExists(atPath: src.path) {
                do {
                    try FileManager.default.copyItem(at: src, to: dst) // APFS clonefile(2)
                    hasDisk = true
                } catch {
                    throw VMSnapshotError.ioFailure("clone Disk.img: \(error.localizedDescription)")
                }
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
        bundle: VMBundle,
        tag: String,
        pausedStateOnly: Bool = false,
        diskOnly: Bool = false
    ) async throws -> VMSnapshotManifest {
        let manifestURL = bundle.snapshotManifest(tag: tag)
        guard FileManager.default.fileExists(atPath: manifestURL.path) else {
            throw VMSnapshotError.missing("snapshot '\(tag)' not found at \(manifestURL.path)")
        }
        let manifest = try readManifest(at: manifestURL)

        if !pausedStateOnly && manifest.hasDiskClone {
            let snapDisk = bundle.snapshotDir(tag: tag).appendingPathComponent("Disk.img")
            let liveDisk = bundle.diskPath
            // Replace live disk with the snapshot's clone. We move the
            // current disk aside so a botched restore can be undone.
            let parked = bundle.bundlePath.appendingPathComponent("Disk.img.pre-restore-\(Int(Date().timeIntervalSince1970))")
            if FileManager.default.fileExists(atPath: liveDisk.path) {
                try? FileManager.default.moveItem(at: liveDisk, to: parked)
            }
            do {
                try FileManager.default.copyItem(at: snapDisk, to: liveDisk)
            } catch {
                // attempt rollback
                try? FileManager.default.moveItem(at: parked, to: liveDisk)
                throw VMSnapshotError.ioFailure("restore Disk.img: \(error.localizedDescription)")
            }
            // best-effort cleanup
            try? FileManager.default.removeItem(at: parked)
        }

        if !diskOnly && manifest.hasPausedState {
            let saveURL = bundle.snapshotFile(tag: tag)
            do {
                try await vm.restoreMachineStateFrom(url: saveURL)
            } catch {
                throw VMSnapshotError.ioFailure("restoreMachineStateFrom: \(error.localizedDescription)")
            }
        }

        return manifest
    }
#endif

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
