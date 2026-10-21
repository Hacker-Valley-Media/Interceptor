//
//  RunnerLauncher.swift — launch the InterceptorRunner from this device, over
//  the same loopback tunnel the mount used.
//
//  After the DDI is mounted, the companion opens the device's own remoted again,
//  connects process-control (dvt), and launches the InterceptorRunner's
//  xctrunner. Launching the xctrunner process starts its XCUITest, which reads
//  the saved connection and dials home over the user's VPN. The reflector is
//  then stopped so that VPN gets the single VPN slot back; the runner's own
//  back-off retry bridges the handover.
//

import Foundation
import IDevice

enum RunnerLauncher {

    /// The team-scoped InterceptorRunner installed by `interceptor ios setup`
    /// (com.interceptor.runner.<team, lowercased>.xctrunner). The Companion app
    /// reads it from its Info.plist (ICRunnerBundleId, filled from
    /// DEVELOPMENT_TEAM at build time); inside the runner itself it is the
    /// runner's own bundle id.
    static let defaultBundleId: String =
        Bundle.main.object(forInfoDictionaryKey: "ICRunnerBundleId") as? String
        ?? Bundle.main.bundleIdentifier ?? ""

    static func launch(bundleId: String = defaultBundleId) -> Result<UInt64, DDIError> {
        var pairing: OpaquePointer?
        guard rp_pairing_file_read(RPPairing.storedURL.path, &pairing) == nil, let pairing else {
            return .failure(.ffi("launch runner", "could not read the RP pairing file"))
        }
        defer { rp_pairing_file_free(pairing) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = DDIMounter.tunnelPort.bigEndian
        guard DDIMounter.tunnelAddress.withCString({ inet_pton(AF_INET, $0, &addr.sin_addr) }) == 1 else {
            return .failure(.ffi("launch runner", "bad tunnel address"))
        }

        var adapter: OpaquePointer?
        var handshake: OpaquePointer?
        let connErr: UnsafeMutablePointer<IdeviceFfiError>? = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: idevice_sockaddr.self, capacity: 1) { sa in
                tunnel_create_rppairing(sa, idevice_socklen_t(MemoryLayout<sockaddr_in>.size), "InterceptorCompanion-launch", pairing, nil, nil, &adapter, &handshake)
            }
        }
        if let connErr { return .failure(.ffi("launch runner", Self.message(connErr))) }
        defer { if let handshake { rsd_handshake_free(handshake) }; if let adapter { adapter_free(adapter) } }
        guard let adapter, let handshake else { return .failure(.ffi("launch runner", "tunnel returned no handles")) }
        return launch(adapter: adapter, handshake: handshake, bundleId: bundleId)
    }

    /// Launch over a tunnel that is already open (the mount's). Works right after
    /// an on-device mount even though the RSD handshake predates it (seen on
    /// iOS 27.2); on failure the caller opens a fresh tunnel with
    /// `launch(bundleId:)`. Kills a running copy first (kill_existing).
    static func launch(adapter: OpaquePointer, handshake: OpaquePointer,
                       bundleId: String = defaultBundleId) -> Result<UInt64, DDIError> {
        var server: OpaquePointer?
        if let err = remote_server_connect_rsd(adapter, handshake, &server) { return .failure(.ffi("launch runner", Self.message(err))) }
        defer { if let server { remote_server_free(server) } }
        guard let server else { return .failure(.ffi("launch runner", "no remote server")) }

        var pc: OpaquePointer?
        if let err = process_control_new(server, &pc) { return .failure(.ffi("launch runner", Self.message(err))) }
        defer { if let pc { process_control_free(pc) } }
        guard let pc else { return .failure(.ffi("launch runner", "no process control")) }

        var pid: UInt64 = 0
        let launchErr = bundleId.withCString { bid -> UnsafeMutablePointer<IdeviceFfiError>? in
            process_control_launch_app(pc, bid, nil, 0, nil, 0, false, true, &pid)
        }
        if let launchErr { return .failure(.ffi("launch runner", Self.message(launchErr))) }
        icLog("Launched \(bundleId) as pid \(pid)")
        return .success(pid)
    }

    private static func message(_ err: UnsafeMutablePointer<IdeviceFfiError>) -> String {
        let m = err.pointee.message.map { String(cString: $0) } ?? "code \(err.pointee.code)"
        idevice_error_free(err)
        return m
    }
}
