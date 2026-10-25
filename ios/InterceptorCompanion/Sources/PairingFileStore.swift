//
//  PairingFileStore.swift — where the device pairing record lives.
//
//  The pairing file is what `idevicepair pair` / usbmuxd writes: a plist with
//  the host certificate and keys that authenticate a client to this device's
//  lockdownd. Mounting a DDI needs one because the mount goes through the same
//  trusted channel Xcode would use. Exported from the Mac with
//  `interceptor ios pairing-export` and imported here once; it survives reboots,
//  so it only has to be done again if the device is un-paired.
//
//  The store's shape (storedURL, importedAt, the explicit UTType list) follows
//  iCTRLApp/DDI/PairingFileStore.swift from iCTRL by OpenMinis, Apache License
//  2.0 (see ../THIRD_PARTY_NOTICES.md); modified by Interceptor.
//

import Foundation
import UniformTypeIdentifiers

enum PairingFileStore {

    static let supportedContentTypes: [UTType] = {
        var types: [UTType] = [.propertyList, .xml]
        for ext in ["mobiledevicepairing", "mobiledevicepair", "plist"] {
            if let t = UTType(tag: ext, tagClass: .filenameExtension, conformingTo: .propertyList) { types.append(t) }
        }
        types.append(.data)
        return types
    }()

    static var storedURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("Pairing")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("pairingFile.plist")
    }

    static var exists: Bool { FileManager.default.fileExists(atPath: storedURL.path) }

    static var importedAt: Date? {
        (try? FileManager.default.attributesOfItem(atPath: storedURL.path))?[.creationDate] as? Date
    }

    /// Validate and store a picked pairing file. A pairing record is a plist that
    /// contains HostID / SystemBUID and the host cert; reject anything else so a
    /// wrong pick fails here, not three steps into a mount.
    /// Returns nil on success, or a human message on failure.
    @discardableResult
    static func importFile(at src: URL) -> String? {
        let accessed = src.startAccessingSecurityScopedResource()
        defer { if accessed { src.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: src) else { return "could not read the file" }
        guard let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any] else {
            return "not a property list"
        }
        guard plist["HostID"] != nil, plist["SystemBUID"] != nil else {
            return "not a pairing record (missing HostID/SystemBUID)"
        }
        do {
            try? FileManager.default.removeItem(at: storedURL)
            try data.write(to: storedURL)
            icLog("Imported pairing file (\(data.count) bytes)")
            return nil
        } catch { return error.localizedDescription }
    }

    static func remove() { try? FileManager.default.removeItem(at: storedURL) }
}
