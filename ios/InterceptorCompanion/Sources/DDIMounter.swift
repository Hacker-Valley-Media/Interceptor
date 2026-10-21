//
//  DDIMounter.swift — mount the Developer Disk Image on THIS device, from this
//  device, over cellular, with no Mac.
//
//  Based on iCTRLApp/DDI/DDIMounter.swift from iCTRL by OpenMinis
//  (https://github.com/OpenMinis/iCTRL), licensed under the Apache License,
//  Version 2.0 (see ../THIRD_PARTY_NOTICES.md). Modified by Interceptor: the
//  loopback reflector NE, the RemotePairing route, the beforeInstall/afterMount
//  hooks, and the synchronous entry point. The on-device mount approach follows
//  StikDebug; no StikDebug code is included. The real protocol work is in the
//  `idevice` Rust library (MIT, fetched as IDevice.xcframework). This Swift
//  sequences it:
//
//    reflector (our NE, or StosVPN) exposes the device's own remoted at
//    10.7.0.1:49152  →  tunnel_create_rppairing (pairing-authenticated RSD
//    handshake)  →  cryptexd_install_ddi (iOS 26.4+) OR
//    image_mounter_mount_personalized_with_callback_rsd (iOS 17-26.3).
//
//  No privileged entitlement is involved anywhere: the pairing file authenticates
//  the conversation exactly as Xcode on a Mac would, and the loopback reflector
//  makes the device's own service reachable as an ordinary network client.
//
//  On cellular, iOS answers 49152 through the reflector only with Cellular Data
//  OFF (Wi-Fi works either way). The install needs Apple's signing server, so the
//  caller opens the tunnel with data off and `beforeInstall` waits for data to
//  come back on while the tunnel stays open.
//

import Foundation
import IDevice

enum DDIError: LocalizedError {
    case missingPairingFile
    case missingImage
    case tunnelDown
    case localNetworkDenied
    case tunnelUnavailable(String)
    case ffi(String, String)

    var errorDescription: String? {
        switch self {
        case .missingPairingFile: return "No pairing file imported yet. Export one from the Mac (interceptor ios pairing-export) and import it here."
        case .missingImage: return "Developer Disk Image files are missing — download or import them first."
        case .tunnelDown: return "The loopback tunnel isn't connected. It doesn't survive a reboot — connect the reflector (step 1), then mount again."
        case .localNetworkDenied: return "iOS blocked the connection to the tunnel: Local Network access is off for InterceptorCompanion. Turn it on in Settings → Privacy & Security → Local Network, then mount again."
        case .tunnelUnavailable(let why): return "Can't reach the device's debug service: \(why)"
        case .ffi(let op, let msg): return "\(op) failed: \(msg)"
        }
    }
}

@MainActor
final class DDIMounter: ObservableObject {

    /// Where the reflector (our NE, or StosVPN/LocalDevVPN) publishes this
    /// device's own remoted. Both reflectors use 10.7.0.1; not configurable in
    /// either, and our NE matches it so the same mount code works with either.
    static let tunnelAddress = "10.7.0.1"
    /// remoted — the RemotePairing service the tunnel exposes.
    static let tunnelPort: UInt16 = 49152  // remoted (RemotePairing); the RP tunnel runs here, via the reflector

    enum Phase: Equatable {
        case idle, connecting, queryingDevice
        case uploading(Double)
        case finalizing, mounted
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle {
        didSet {
            if case .uploading = phase { return }
            icLog("DDI phase → \(phase)")
        }
    }

    var isRunning: Bool {
        switch phase { case .idle, .mounted, .failed: return false; default: return true }
    }

    /// Each mount gets a number; a progress report queued by an older or finished
    /// run must not overwrite the final phase (or leave isRunning stuck true).
    private var runID = 0

    /// `beforeInstall` runs on the mount thread with the tunnel open, right before
    /// the step that needs Apple's signing server (internet); on cellular that is
    /// where Cellular Data goes back on. `afterMount` runs with the same live
    /// tunnel once an image is in place (both run on the thread that owns it).
    func mount(beforeInstall: (() -> Void)? = nil,
               afterMount: ((OpaquePointer, OpaquePointer) -> Void)? = nil) async {
        guard !isRunning else { return }
        runID += 1
        let run = runID
        phase = .connecting
        do {
            guard PairingFileStore.exists else { throw DDIError.missingPairingFile }
            guard DeveloperDiskImageStore.isComplete else { throw DDIError.missingImage }
            // A loopback probe is only a hint: remoted may not answer a bare TCP
            // connect even when the real RemotePairing handshake works. Surface a
            // Local Network denial (actionable), but on a plain "unreachable" let
            // the tunnel_create_rppairing below be the real test — it reports a
            // precise error. (A hard-fail here was the post-reboot false negative.)
            if case .localNetworkDenied = await ReflectorTunnel.probe() { throw DDIError.localNetworkDenied }

            let pairingPath = PairingFileStore.storedURL.path
            let method = DeveloperDiskImageStore.mountMethod
            let imageDir = DeveloperDiskImageStore.directory.path

            // A dedicated Thread with a 4MB stack: the TSS request builds a
            // reqwest/rustls client whose TLS setup overflows a Swift concurrency
            // worker's stack (SIGABRT). iCTRL does the same.
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                let thread = Thread {
                    do {
                        try Self.performMount(pairingPath: pairingPath, method: method, imageDir: imageDir,
                                              beforeInstall: beforeInstall, afterMount: afterMount) { p in
                            Task { @MainActor in if self.runID == run && self.isRunning { self.phase = p } }
                        }
                        cont.resume()
                    } catch { cont.resume(throwing: error) }
                }
                thread.stackSize = 4 * 1024 * 1024
                thread.name = "ic.ddi.mount"
                thread.qualityOfService = .userInitiated
                thread.start()
            }
            phase = .mounted
        } catch {
            icLog("❌ DDI mount failed: \(error.localizedDescription)")
            phase = .failed(error.localizedDescription)
        }
    }

    // MARK: - FFI

    nonisolated static func mountedImageCount(adapter: OpaquePointer, handshake: OpaquePointer) -> Int? {
        var client: OpaquePointer?
        if let err = image_mounter_connect_rsd(adapter, handshake, &client) { idevice_error_free(err); return nil }
        guard let client else { return nil }
        defer { image_mounter_free(client) }
        var devices: UnsafeMutablePointer<plist_t?>?
        var count = 0
        if let err = image_mounter_copy_devices(client, &devices, &count) { idevice_error_free(err); return nil }
        if let devices { idevice_plist_array_free(devices, UInt(count)) }
        return count
    }

    nonisolated static func cryptexDDIInstalled(adapter: OpaquePointer, handshake: OpaquePointer) -> Bool {
        var installed: UnsafeMutablePointer<InstalledCryptexC>?
        if let err = cryptexd_installed_ddi(adapter, handshake, &installed) { idevice_error_free(err) }
        defer { if let installed { cryptexd_free_installed_cryptex(installed) } }
        return installed != nil
    }

    nonisolated private static func installCryptex(adapter: OpaquePointer, handshake: OpaquePointer,
                                                   imageDir: String, report: @escaping (Phase) -> Void) throws {
        var assets: OpaquePointer?
        try check("Reading the DDI cryptex files") { cryptex1_assets_load(imageDir, &assets) }
        guard let assets else { throw DDIError.ffi("Reading the DDI cryptex files", "nothing loaded") }
        defer { cryptex1_assets_free(assets) }
        report(.uploading(0))
        try check("Installing the DDI cryptex") { cryptexd_install_ddi(adapter, handshake, assets, nil) }
        report(.finalizing)
    }

    /// Force the rustls crypto provider to install before the TSS call needs it
    /// (the library is rustls-no-provider; Client::new() otherwise panics).
    nonisolated static func primeCryptoProvider() {
        icLog("Priming rustls crypto provider via a throwaway session")
        var pairing: OpaquePointer?
        guard idevice_pairing_file_read(PairingFileStore.storedURL.path, &pairing) == nil, let pairing else { return }
        defer { idevice_pairing_file_free(pairing) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = tunnelPort.bigEndian
        guard tunnelAddress.withCString({ inet_pton(AF_INET, $0, &addr.sin_addr) }) == 1 else { return }
        var device: OpaquePointer?
        withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: idevice_sockaddr.self, capacity: 1) { sa in
                if let err = idevice_new_tcp_socket(sa, idevice_socklen_t(MemoryLayout<sockaddr_in>.size), "ic-crypto-prime", &device) { idevice_error_free(err) }
            }
        }
        guard let device else { return }
        defer { idevice_free(device) }
        if let err = idevice_start_session(device, pairing, false) { idevice_error_free(err) }
    }

    /// Synchronous mount for the pre-main / web-connect context, where the
    /// MainActor executor is not serviced. Call on a dedicated thread with a large
    /// stack (see `mount`). Returns nil on success, else the error message.
    nonisolated static func performMountSync(beforeInstall: (() -> Void)? = nil,
                                             afterMount: ((OpaquePointer, OpaquePointer) -> Void)? = nil) -> String? {
        guard PairingFileStore.exists else { return DDIError.missingPairingFile.localizedDescription }
        guard DeveloperDiskImageStore.isComplete else { return DDIError.missingImage.localizedDescription }
        do {
            try performMount(pairingPath: PairingFileStore.storedURL.path,
                             method: DeveloperDiskImageStore.mountMethod,
                             imageDir: DeveloperDiskImageStore.directory.path,
                             beforeInstall: beforeInstall, afterMount: afterMount,
                             report: { p in icLog("DDI phase → \(p)") })
            return nil
        } catch { return error.localizedDescription }
    }

    nonisolated private static func performMount(pairingPath: String, method: DeveloperDiskImageStore.MountMethod,
                                                 imageDir: String,
                                                 beforeInstall: (() -> Void)?,
                                                 afterMount: ((OpaquePointer, OpaquePointer) -> Void)?,
                                                 report: @escaping (Phase) -> Void) throws {
        icLog("DDI mount starting — \(method.rawValue) image from \(imageDir)")
        primeCryptoProvider()

        // RP route (as in StikDebug and iCTRL): a device-trusted RemotePairing file
        // authenticates the RemoteXPC tunnel to remoted (49152) via the reflector.
        // RPPairing.ensure() generated the RP file once from the lockdown pairing
        // file (tunnel_pair_usb). The lockdownd+CoreDeviceProxy route
        // (tunnel_create_usb on 62078) broken-pipes on iOS 27 — the service gate.
        if let why = RPPairing.ensure() { throw DDIError.ffi("RemotePairing setup", why) }

        var pairing: OpaquePointer?
        try check("Reading RP pairing file") { rp_pairing_file_read(RPPairing.storedURL.path, &pairing) }
        defer { if let pairing { rp_pairing_file_free(pairing) } }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = tunnelPort.bigEndian
        guard tunnelAddress.withCString({ inet_pton(AF_INET, $0, &addr.sin_addr) }) == 1 else {
            throw DDIError.tunnelUnavailable("bad tunnel address")
        }

        var adapter: OpaquePointer?
        var handshake: OpaquePointer?
        try withUnsafePointer(to: &addr) { ptr in
            try ptr.withMemoryRebound(to: idevice_sockaddr.self, capacity: 1) { sa in
                try check("Connecting to the device") {
                    tunnel_create_rppairing(sa, idevice_socklen_t(MemoryLayout<sockaddr_in>.size), "InterceptorCompanion", pairing, nil, nil, &adapter, &handshake)
                }
            }
        }
        defer {
            if let handshake { rsd_handshake_free(handshake) }
            if let adapter { adapter_free(adapter) }
        }
        guard let adapter, let handshake else { throw DDIError.tunnelUnavailable("tunnel returned no handles") }

        report(.queryingDevice)

        if cryptexDDIInstalled(adapter: adapter, handshake: handshake) {
            icLog("✅ DDI cryptex already installed — nothing to do"); afterMount?(adapter, handshake); return
        }
        if let mounted = mountedImageCount(adapter: adapter, handshake: handshake), mounted > 0 {
            icLog("✅ A developer image is already mounted — nothing to do"); afterMount?(adapter, handshake); return
        }

        icLog("No developer image on the device yet — installing it from this device")
        if let beforeInstall {
            beforeInstall()
            // Did the open tunnel survive the wait (and Cellular Data coming back on)?
            var probe: UnsafeMutablePointer<InstalledCryptexC>?
            if let err = cryptexd_installed_ddi(adapter, handshake, &probe) {
                icLog("Tunnel check after the wait: FAILED — \(err.pointee.message.map { String(cString: $0) } ?? "code \(err.pointee.code)")")
                idevice_error_free(err)
            } else { icLog("Tunnel check after the wait: alive") }
            if let probe { cryptexd_free_installed_cryptex(probe) }
        }
        if method == .cryptex {
            try installCryptex(adapter: adapter, handshake: handshake, imageDir: imageDir, report: report)
            icLog("✅ DDI cryptex installed on-device")
            afterMount?(adapter, handshake); return
        }

        let image = try Data(contentsOf: URL(fileURLWithPath: imageDir).appendingPathComponent("Image.dmg"), options: .mappedIfSafe)
        let trustCache = try Data(contentsOf: URL(fileURLWithPath: imageDir).appendingPathComponent("Image.dmg.trustcache"))
        let manifest = try Data(contentsOf: URL(fileURLWithPath: imageDir).appendingPathComponent("BuildManifest.plist"))
        let ecid = try uniqueChipID(adapter: adapter, handshake: handshake)

        var client: OpaquePointer?
        try check("Opening the image mounter") { image_mounter_connect_rsd(adapter, handshake, &client) }
        defer { if let client { image_mounter_free(client) } }
        guard let client else { throw DDIError.ffi("Opening the image mounter", "no client") }

        report(.uploading(0))
        final class ProgressBox { let report: (Phase) -> Void; init(_ r: @escaping (Phase) -> Void) { report = r } }
        let box = Unmanaged.passRetained(ProgressBox(report))
        defer { box.release() }

        try image.withUnsafeBytes { img in try trustCache.withUnsafeBytes { tc in try manifest.withUnsafeBytes { mf in
            try check("Mounting the image") {
                image_mounter_mount_personalized_with_callback_rsd(
                    client, adapter, handshake,
                    img.bindMemory(to: UInt8.self).baseAddress, image.count,
                    tc.bindMemory(to: UInt8.self).baseAddress, trustCache.count,
                    mf.bindMemory(to: UInt8.self).baseAddress, manifest.count,
                    nil, ecid,
                    { progress, total, context in
                        guard let context, total > 0 else { return }
                        Unmanaged<ProgressBox>.fromOpaque(context).takeUnretainedValue().report(.uploading(Double(progress) / Double(total)))
                    }, box.toOpaque())
            }
        }}}
        report(.finalizing)
        afterMount?(adapter, handshake)
    }

    nonisolated private static func uniqueChipID(adapter: OpaquePointer, handshake: OpaquePointer) throws -> UInt64 {
        var client: OpaquePointer?
        try check("Connecting to lockdownd") { lockdownd_connect_rsd(adapter, handshake, &client) }
        defer { if let client { lockdownd_client_free(client) } }
        guard let client else { throw DDIError.ffi("Connecting to lockdownd", "no client") }
        var value: plist_t?
        try check("Reading UniqueChipID") { lockdownd_get_value(client, "UniqueChipID", nil, &value) }
        defer { if let value { plist_free(value) } }
        guard let value else { throw DDIError.ffi("Reading UniqueChipID", "no value") }
        var ecid: UInt64 = 0
        plist_get_uint_val(value, &ecid)
        guard ecid != 0 else { throw DDIError.ffi("Reading UniqueChipID", "device returned 0") }
        return ecid
    }

    @discardableResult
    nonisolated private static func check(_ operation: String, _ call: () -> UnsafeMutablePointer<IdeviceFfiError>?) throws -> Bool {
        guard let err = call() else { return true }
        let message = err.pointee.message.map { String(cString: $0) } ?? "code \(err.pointee.code)"
        let code = err.pointee.code
        idevice_error_free(err)
        icLog("❌ \(operation): \(message) (code \(code))")
        var detail = "\(message) (code \(code))"
        if message.contains("device socket io failed") || message.contains("connect:") {
            detail += ". The device service didn't answer through the reflector. On cellular, iOS only answers with Cellular Data OFF (Wi-Fi off too); Connect walks you through it."
        }
        if message.contains("ImageMountFailed") {
            detail += ". The device rejected the image — usually a version mismatch or an incomplete download. Re-fetch the image files."
        }
        throw DDIError.ffi(operation, detail)
    }
}
