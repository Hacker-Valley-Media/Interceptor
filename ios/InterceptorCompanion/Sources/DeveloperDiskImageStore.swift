//
//  DeveloperDiskImageStore.swift — the DDI files a mount needs, kept on disk.
//
//  Based on iCTRLApp/DDI/DeveloperDiskImageStore.swift from iCTRL by OpenMinis
//  (https://github.com/OpenMinis/iCTRL), licensed under the Apache License,
//  Version 2.0 (see ../THIRD_PARTY_NOTICES.md). Modified by Interceptor: always
//  the personalized method, whole-folder import, and a simpler download.
//
//  A personalized image (BuildManifest.plist, Image.dmg, Image.dmg.trustcache),
//  which is what Xcode mounts on iOS 17 through 27. The cryptex layout (adds
//  Image.dmg.cryptex_info and Image.dmg.root_hash) is unused. The files are the ones Xcode ships at
//  /Library/Developer/DeveloperDiskImages/iOS_DDI/Restore/ on a Mac; a host-side
//  helper (interceptor ios ddi-export) copies them here, or they can be
//  downloaded from the doronz88 mirror on first use.
//

import Foundation

/// Mirror maintained by the pymobiledevice3 author; the same files ship inside
/// Xcode (interceptor ios ddi-export). Apple does not publish the DDI directly.
private let ddiMirrorBase = "https://github.com/doronz88/DeveloperDiskImage/raw/refs/heads/main/PersonalizedImages"

@MainActor
final class DeveloperDiskImageStore: ObservableObject {

    enum MountMethod: String {
        case personalized, cryptex
        var mirrorFolder: String {
            switch self { case .personalized: return "Xcode_iOS_DDI_Personalized"; case .cryptex: return "Xcode_iOS_DDI_Cryptex" }
        }
        var components: [Component] {
            switch self {
            case .personalized: return [.buildManifest, .image, .trustCache]
            case .cryptex: return [.buildManifest, .image, .trustCache, .cryptexInfo, .rootHash]
            }
        }
    }

    // ponytail: always personalized. Xcode mounts the personalized image on iOS 27.2
    // (devicectl: PersonalizedImage mountImage 022-20360-068.dmg), and the cryptex
    // identity in Xcode's manifest ("Cryptex Developer Disk Image") fails idevice's
    // cryptex loader (BadBuildManifest). Switch per version only if a
    // DDI ships without a PersonalizedDMG identity.
    nonisolated static var mountMethod: MountMethod { .personalized }


    enum Component: String, CaseIterable {
        case buildManifest = "BuildManifest.plist"
        case image = "Image.dmg"
        case trustCache = "Image.dmg.trustcache"
        case cryptexInfo = "Image.dmg.cryptex_info"
        case rootHash = "Image.dmg.root_hash"
        var remoteURL: URL { URL(string: "\(ddiMirrorBase)/\(DeveloperDiskImageStore.mountMethod.mirrorFolder)/\(rawValue)")! }
        var weight: Double { switch self { case .image: return 0.9; case .buildManifest: return 0.07; default: return 0.01 } }
    }

    @Published private(set) var isDownloading = false
    @Published private(set) var progress: Double = 0
    @Published private(set) var statusMessage: String?

    private nonisolated static var rootDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("DDI")
    }
    nonisolated static var directory: URL {
        let dir = rootDirectory.appendingPathComponent(mountMethod.mirrorFolder)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    nonisolated static func url(for c: Component) -> URL { directory.appendingPathComponent(c.rawValue) }

    nonisolated static var isComplete: Bool {
        mountMethod.components.allSatisfy { FileManager.default.fileExists(atPath: url(for: $0).path) }
    }
    static var totalBytesOnDisk: Int64 {
        mountMethod.components.reduce(0) { sum, c in
            sum + (((try? FileManager.default.attributesOfItem(atPath: url(for: c).path))?[.size] as? Int64) ?? 0)
        }
    }

    /// Import a directory that already holds this device's DDI components (what
    /// `interceptor ios ddi-export` writes, or a folder picked from Files).
    func importFrom(directory src: URL) -> Bool {
        let fm = FileManager.default
        let dest = Self.directory
        var imported = 0
        let accessed = src.startAccessingSecurityScopedResource()
        defer { if accessed { src.stopAccessingSecurityScopedResource() } }
        for c in Self.mountMethod.components {
            let from = src.appendingPathComponent(c.rawValue)
            guard fm.fileExists(atPath: from.path) else { continue }
            let to = dest.appendingPathComponent(c.rawValue)
            try? fm.removeItem(at: to)
            do { try fm.copyItem(at: from, to: to); imported += 1 }
            catch { icLog("DDI import \(c.rawValue) failed: \(error.localizedDescription)") }
        }
        icLog("DDI import: \(imported)/\(Self.mountMethod.components.count) components into \(dest.path)")
        objectWillChange.send()
        return Self.isComplete
    }

    /// Download the missing components from the doronz88 mirror. Needs internet
    /// (cellular is fine); the image is ~100MB.
    func download() async {
        guard !isDownloading else { return }
        isDownloading = true; progress = 0; statusMessage = "Starting…"
        defer { isDownloading = false }
        let method = Self.mountMethod
        var done = 0.0
        for c in method.components {
            let dest = Self.url(for: c)
            if FileManager.default.fileExists(atPath: dest.path) { done += c.weight; progress = done; continue }
            statusMessage = "Downloading \(c.rawValue)…"
            do {
                let (tmp, resp) = try await URLSession.shared.download(from: c.remoteURL)
                if let http = resp as? HTTPURLResponse, http.statusCode != 200 { throw URLError(.badServerResponse) }
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.moveItem(at: tmp, to: dest)
                done += c.weight; progress = done
            } catch {
                statusMessage = "Failed on \(c.rawValue): \(error.localizedDescription)"
                icLog("DDI download \(c.rawValue) failed: \(error.localizedDescription)")
                return
            }
        }
        progress = 1; statusMessage = Self.isComplete ? "Ready" : "Incomplete"
        objectWillChange.send()
    }
}
