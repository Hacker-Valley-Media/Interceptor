//
//  RPPairing.swift — produce the device-trusted RemotePairing file the RSD tunnel
//  needs, on-device, from the ordinary lockdown pairing file.
//
//  iOS 17+ RemoteXPC tunnels (tunnel_create_rppairing, port 49152 = remoted) are
//  authenticated by a 3-field RemotePairing identity (identifier / private_key /
//  public_key) the device must trust — not the lockdown pair record usbmux
//  exports. `tunnel_pair_usb` performs that RemotePairing handshake through a
//  lockdown provider (here, the device's own lockdownd reached via the reflector)
//  and hands back an RP file the device now trusts. We generate it once and save
//  it; it is reused on every mount, like StikDebug's imported pairing file.
//

import Foundation
import IDevice

enum RPPairing {

    static var storedURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("Pairing")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("rpPairingFile.plist")
    }

    static var exists: Bool { FileManager.default.fileExists(atPath: storedURL.path) }

    /// Create the RP file from the lockdown pairing file via tunnel_pair_usb over
    /// the reflector (10.7.0.1 lockdownd). Returns nil on success, a message on
    /// failure. Idempotent: skips if the RP file already exists.
    static func ensure() -> String? {
        if exists { icLog("RP pairing file already present"); return nil }
        guard FileManager.default.fileExists(atPath: PairingFileStore.storedURL.path) else {
            return "no lockdown pairing file to pair from"
        }
        var lockdownPairing: OpaquePointer?
        if let err = idevice_pairing_file_read(PairingFileStore.storedURL.path, &lockdownPairing) {
            return "reading lockdown pairing: \(message(err))"
        }
        defer { if let lockdownPairing { idevice_pairing_file_free(lockdownPairing) } }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(62078).bigEndian  // lockdownd, via the reflector
        guard DDIMounter.tunnelAddress.withCString({ inet_pton(AF_INET, $0, &addr.sin_addr) }) == 1 else {
            return "bad tunnel address"
        }

        var provider: OpaquePointer?
        let provErr: UnsafeMutablePointer<IdeviceFfiError>? = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: idevice_sockaddr.self, capacity: 1) { sa in
                idevice_tcp_provider_new(sa, lockdownPairing, "InterceptorCompanion-pair", &provider)
            }
        }
        if let provErr { return "creating provider: \(message(provErr))" }
        defer { if let provider { idevice_provider_free(provider) } }
        guard let provider else { return "no provider" }

        var rpFile: OpaquePointer?
        if let err = tunnel_pair_usb(provider, "InterceptorCompanion", nil, nil, &rpFile) {
            return "RemotePairing handshake: \(message(err))"
        }
        defer { if let rpFile { rp_pairing_file_free(rpFile) } }
        guard let rpFile else { return "no RP file produced" }

        if let err = storedURL.path.withCString({ rp_pairing_file_write(rpFile, $0) }) {
            return "writing RP file: \(message(err))"
        }
        icLog("✅ RP pairing file created + saved (\(storedURL.lastPathComponent))")
        return nil
    }

    static func message(_ err: UnsafeMutablePointer<IdeviceFfiError>) -> String {
        let m = err.pointee.message.map { String(cString: $0) } ?? "code \(err.pointee.code)"
        idevice_error_free(err)
        return m
    }
}
