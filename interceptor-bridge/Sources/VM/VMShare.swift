// VMShare
//
// virtio-fs directory sharing per
// `apple-developer-docs/Virtualization/shared-directories.md`. Available
// macOS 13+. Builds `VZVirtioFileSystemDeviceConfiguration` with either
// `VZSingleDirectoryShare` (one host dir → one tag) or
// `VZMultipleDirectoryShare` (multiple dirs → one tag).
//
// Linux Rosetta share via `VZLinuxRosettaDirectoryShare` per
// `VZLinuxRosettaDirectoryShare.md`. ARM host only; throws
// `VZError.invalidVirtualMachineConfiguration` if Rosetta isn't installed.

import Foundation
#if canImport(Virtualization)
import Virtualization
#endif

public enum VMShareError: Error, CustomStringConvertible, Sendable {
    case invalidTag(String)
    case rosettaUnavailable(String)
    case ioFailure(String)

    public var description: String {
        switch self {
        case .invalidTag(let m): return "share.invalidTag: \(m)"
        case .rosettaUnavailable(let m): return "share.rosettaUnavailable: \(m)"
        case .ioFailure(let m): return "share.ioFailure: \(m)"
        }
    }
}

public struct VMShare: Sendable {
#if canImport(Virtualization)
    /// Build virtio-fs device configurations from the spec's shares.
    /// Optionally append a Rosetta share when `spec.rosetta == true` on
    /// Linux guests.
    @available(macOS 13.0, *)
    public static func buildDirectorySharingDevices(
        for spec: VMSpec
    ) throws -> [VZDirectorySharingDeviceConfiguration] {
        var devs: [VZDirectorySharingDeviceConfiguration] = []

        for share in spec.shares {
            // Apple's validateTag throws on invalid tags. Wrap into VMShareError
            // so callers get a stable error type.
            do {
                try VZVirtioFileSystemDeviceConfiguration.validateTag(share.tag)
            } catch {
                throw VMShareError.invalidTag("tag '\(share.tag)': \(error.localizedDescription)")
            }
            let url = URL(fileURLWithPath: (share.hostPath as NSString).expandingTildeInPath)
            let dir = VZSharedDirectory(url: url, readOnly: share.readOnly)
            let single = VZSingleDirectoryShare(directory: dir)
            let dev = VZVirtioFileSystemDeviceConfiguration(tag: share.tag)
            dev.share = single
            devs.append(dev)
        }

        if spec.rosetta && spec.kind == .linux {
            // Use the conventional `ROSETTA` tag the Apple sample documents.
            let tag = "ROSETTA"
            do {
                try VZVirtioFileSystemDeviceConfiguration.validateTag(tag)
            } catch {
                throw VMShareError.invalidTag("rosetta tag: \(error.localizedDescription)")
            }
            let rosetta: VZLinuxRosettaDirectoryShare
            do {
                rosetta = try VZLinuxRosettaDirectoryShare()
            } catch {
                throw VMShareError.rosettaUnavailable(
                    "VZLinuxRosettaDirectoryShare(): \(error.localizedDescription) — install Rosetta with `softwareupdate --install-rosetta`"
                )
            }
            let dev = VZVirtioFileSystemDeviceConfiguration(tag: tag)
            dev.share = rosetta
            devs.append(dev)
        }

        return devs
    }

    /// Static helper: is Rosetta available on this host? Equivalent to
    /// `VZLinuxRosettaAvailability.installed`.
    @available(macOS 13.0, *)
    public static var rosettaAvailable: Bool {
        // VZLinuxRosettaDirectoryShare.availability is the typed accessor.
        return VZLinuxRosettaDirectoryShare.availability == .installed
    }
#endif
}
