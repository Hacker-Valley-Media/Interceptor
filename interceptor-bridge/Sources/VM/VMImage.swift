// VMImage
//
// Image resolution for both guest kinds.
//
// macOS: download an IPSW. Implementation calls `VZMacOSRestoreImage.latestSupported`
// (async, macOS 12+; see
// `apple-developer-docs/Virtualization/VZMacOSRestoreImage.md:5,28-30`)
// to fetch the latest supported restore image URL, then
// `URLSession.shared.download(from:)` to write it to
// `<state>/images/macos/<build>.ipsw`. Re-uses an already-downloaded
// IPSW when present (digest-checked by name only — Apple's restore-image
// download API does not expose a hash, so we trust the filename).
//
// Linux: pull an OCI image via Containerization's image registry
// surface. Cached under `<state>/images/oci/` so VM bundles and cached
// image content remain colocated under the configured state directory.

import Foundation
import CryptoKit
#if canImport(Containerization)
import Containerization
#endif
#if canImport(Virtualization)
import Virtualization
#endif

public enum VMImageError: Error, CustomStringConvertible, Sendable {
    case downloadFailed(String)
    case unsupportedKind(String)
    case missingHost(String)
    case missingFile(String)

    public var description: String {
        switch self {
        case .downloadFailed(let m): return "image.downloadFailed: \(m)"
        case .unsupportedKind(let m): return "image.unsupportedKind: \(m)"
        case .missingHost(let m): return "image.missingHost: \(m)"
        case .missingFile(let m): return "image.missingFile: \(m)"
        }
    }
}

/// Top-level helper for resolving and downloading the artifacts a
/// VMSpec.image refers to. Pure functions; state lives in `VMRegistry`.
public struct VMImage: Sendable {

    /// Directory under which downloaded images live. Lives next to vms/
    /// inside the state dir so external tools can introspect.
    public static func imagesDir(stateDir: URL) -> URL {
        stateDir.appendingPathComponent("images", isDirectory: true)
    }

    public static func macosImagesDir(stateDir: URL) -> URL {
        imagesDir(stateDir: stateDir).appendingPathComponent("macos", isDirectory: true)
    }

    public static func ociImagesDir(stateDir: URL) -> URL {
        imagesDir(stateDir: stateDir).appendingPathComponent("oci", isDirectory: true)
    }

    /// Ensure both subdirs exist.
    public static func ensureImageDirs(stateDir: URL) throws {
        for d in [imagesDir(stateDir: stateDir), macosImagesDir(stateDir: stateDir), ociImagesDir(stateDir: stateDir)] {
            var isDir: ObjCBool = false
            if !FileManager.default.fileExists(atPath: d.path, isDirectory: &isDir) {
                try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
            }
        }
    }

#if canImport(Virtualization)
    /// Resolve a macOS restore image. If `imageSpec == "latest"`, calls
    /// `VZMacOSRestoreImage.latestSupported`, downloads the file to
    /// `<state>/images/macos/<build>.ipsw`, and returns the local URL.
    /// Otherwise expects an absolute path to an existing .ipsw.
    public static func resolveMacOSImage(spec imageSpec: String, stateDir: URL) async throws -> URL {
        try ensureImageDirs(stateDir: stateDir)
        if imageSpec.hasSuffix(".ipsw") {
            let url = URL(fileURLWithPath: (imageSpec as NSString).expandingTildeInPath)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw VMImageError.missingFile(url.path)
            }
            return url
        }
        guard imageSpec == "latest" else {
            throw VMImageError.unsupportedKind("macos image must be a .ipsw path or 'latest'")
        }
        #if arch(arm64)
        let restoreImage: VZMacOSRestoreImage
        do {
            restoreImage = try await VZMacOSRestoreImage.latestSupported
        } catch {
            throw VMImageError.downloadFailed("VZMacOSRestoreImage.latestSupported: \(error.localizedDescription)")
        }
        let remote = restoreImage.url
        let buildId = restoreImage.buildVersion
        let localURL = macosImagesDir(stateDir: stateDir).appendingPathComponent("\(buildId).ipsw")
        if FileManager.default.fileExists(atPath: localURL.path) {
            return localURL
        }
        // download to a temp file then atomic-move into place
        let (tmpURL, _): (URL, URLResponse)
        do {
            (tmpURL, _) = try await URLSession.shared.download(from: remote)
        } catch {
            throw VMImageError.downloadFailed("download \(remote.absoluteString): \(error.localizedDescription)")
        }
        do {
            try FileManager.default.moveItem(at: tmpURL, to: localURL)
        } catch {
            throw VMImageError.downloadFailed("move IPSW into place: \(error.localizedDescription)")
        }
        return localURL
        #else
        // VZMacOSRestoreImage is Apple-silicon-only in the SDK.
        throw VMImageError.downloadFailed("'latest' macOS restore image requires an Apple silicon host")
        #endif
    }

    #if arch(arm64)
    /// `mostFeaturefulSupportedConfiguration` for a given IPSW. Used by
    /// `MacRuntime` to pick the hardware model + minimum CPU/memory.
    public static func loadRestoreImage(at url: URL) async throws -> VZMacOSRestoreImage {
        do {
            return try await VZMacOSRestoreImage.image(from: url)
        } catch {
            throw VMImageError.missingFile("VZMacOSRestoreImage.image(from: \(url.path)): \(error.localizedDescription)")
        }
    }
    #endif
#endif

    /// Resolve actual OCI content before returning its cache receipt path.
    public static func resolveOCIImage(ref: String, stateDir: URL) async throws -> URL {
        try ensureImageDirs(stateDir: stateDir)
        #if canImport(Containerization)
        guard ref != "latest", !ref.isEmpty, ref.utf8.count <= 4096, !ref.contains("\0") else {
            throw VMImageError.unsupportedKind("Linux VM images require an explicit OCI registry reference and tag or digest")
        }
        let store = try ImageStore(path: ociImagesDir(stateDir: stateDir).appendingPathComponent("store"))
        #if arch(arm64)
        let platform = SystemPlatform.linuxArm.ociPlatform()
        #else
        let platform = SystemPlatform.linuxAmd.ociPlatform()
        #endif
        let image = try await store.get(reference: ref, pull: true)
        _ = try await image.manifest(for: platform)
        _ = try await image.config(for: platform)
        let key = SHA256.hash(data: Data(ref.utf8)).map { String(format: "%02x", $0) }.joined()
        let path = ociImagesDir(stateDir: stateDir).appendingPathComponent(key, isDirectory: true)
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let record = try JSONSerialization.data(withJSONObject: ["reference": ref, "digest": image.digest, "mediaType": image.mediaType, "store": store.path.path], options: [.sortedKeys])
        let receipt = path.appendingPathComponent("image.json")
        try record.write(to: receipt, options: .atomic)
        guard try Data(contentsOf: receipt) == record else { throw VMImageError.downloadFailed("OCI descriptor receipt readback differs") }
        return path
        #else
        throw VMImageError.unsupportedKind("Containerization package is not linked; OCI content was not pulled")
        #endif
    }
}
