//
//  ReflectorTunnel.swift — start/stop InterceptorCompanion's own reflector NE,
//  and probe whether the loopback tunnel is actually up.
//
//  The app installs one NETunnelProviderManager configuration for the bundled
//  packet-tunnel extension and starts it on demand. Only one packet-tunnel VPN
//  runs at a time, so the reflector is brought up for the mount and torn down
//  afterwards, leaving the VPN slot free for the user's VPN (which the runner
//  dials home over). If our NE can't be provisioned on a given build, the
//  mount still works against an external StosVPN/LocalDevVPN at the same
//  10.7.0.1 — `probe()` tests the tunnel, not which app provides it.
//

import Foundation
import Network
import NetworkExtension

enum ReflectorTunnel {

    static let providerBundleId = "com.interceptor.companion.reflector"

    enum Probe: Equatable { case reachable, localNetworkDenied, unreachable(String) }

    // MARK: - manage our own NE

    @MainActor
    static func loadOrCreateManager() async throws -> NETunnelProviderManager {
        let all = try await NETunnelProviderManager.loadAllFromPreferences()
        if let existing = all.first(where: {
            ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == providerBundleId
        }) { return existing }
        let mgr = NETunnelProviderManager()
        let proto = NETunnelProviderProtocol()
        proto.providerBundleIdentifier = providerBundleId
        proto.serverAddress = "InterceptorCompanion loopback reflector"
        mgr.protocolConfiguration = proto
        mgr.localizedDescription = "Interceptor DDI reflector"
        mgr.isEnabled = true
        try await mgr.saveToPreferences()
        try await mgr.loadFromPreferences() // re-read so the connection is usable
        return mgr
    }

    enum StartError: LocalizedError {
        case notReachable(String)
        var errorDescription: String? {
            switch self {
            case .notReachable(let detail):
                return "The loopback reflector didn't connect (\(detail)). "
                     + "iOS only starts a VPN while the phone has a network, so keep Wi-Fi or Cellular Data on when you tap Connect."
            }
        }
    }

    /// Start our reflector and wait until the loopback actually answers. THROWS if
    /// it never does, so the caller does not run a mount against a dead tunnel.
    ///
    /// Cold after a reboot the NE can take tens of seconds to launch and the first
    /// connect to remoted (49152) can be slow, so this is patient: it waits for
    /// the connection to report .connected, then polls the loopback for up to ~75s
    /// total. Returning after a fixed 8s, whether or not the probe succeeded, let a
    /// post-reboot run reach the mount with an unready tunnel ("probe=unreachable").
    @MainActor
    static func start() async throws -> NETunnelProviderManager {
        let mgr = try await loadOrCreateManager()
        if !mgr.isEnabled { mgr.isEnabled = true; try await mgr.saveToPreferences(); try await mgr.loadFromPreferences() }
        if mgr.connection.status != .connected {
            try (mgr.connection as? NETunnelProviderSession)?.startTunnel(options: [
                "TunnelDeviceIP": "10.7.0.0" as NSString,
                "TunnelFakeIP": "10.7.0.1" as NSString,
            ])
        }
        // First wait for the session to report .connected (the NE finished its
        // cold launch + applied tunnel settings), up to ~45s.
        for _ in 0..<90 {
            if mgr.connection.status == .connected { break }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        guard mgr.connection.status == .connected else {
            throw StartError.notReachable("the VPN session did not reach .connected (status=\(mgr.connection.status.rawValue)) within 45s")
        }
        // The session is connected. Try the loopback probe as a readiness HINT, but
        // do NOT hard-fail on it: remoted may not answer a bare TCP connect even
        // though the real RemotePairing handshake works. Give it a short grace, then
        // return — the mount's own tunnel_create_rppairing is the real readiness test
        // and it reports a precise error if the device isn't ready.
        for _ in 0..<15 {
            if case .reachable = await probe(timeout: 1.0) { return mgr }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        return mgr  // connected but probe never answered — let the mount try anyway
    }

    @MainActor
    static func stop() async {
        guard let mgr = try? await loadOrCreateManager() else { return }
        (mgr.connection as? NETunnelProviderSession)?.stopTunnel()
    }

    // MARK: - probe (works for our NE or an external StosVPN)

    static func probe(timeout: TimeInterval = 1.5) async -> Probe {
        let host = NWEndpoint.Host(DDIMounter.tunnelAddress)
        guard let port = NWEndpoint.Port(rawValue: DDIMounter.tunnelPort) else { return .unreachable("bad port") }
        let conn = NWConnection(host: host, port: port, using: .tcp)
        let queue = DispatchQueue(label: "ic.tunnel.probe")
        return await withCheckedContinuation { cont in
            var done = false
            func finish(_ r: Probe) { guard !done else { return }; done = true; conn.cancel(); cont.resume(returning: r) }
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready: finish(.reachable)
                // A refused connect (nothing serving 49152 on this path) lands in
                // .waiting, not .failed; report it instead of sitting out the timeout.
                case .waiting(let err), .failed(let err):
                    if #available(iOS 14.2, *), conn.currentPath?.unsatisfiedReason == .localNetworkDenied { finish(.localNetworkDenied) }
                    else { finish(.unreachable(err.localizedDescription)) }
                default: break
                }
            }
            conn.start(queue: queue)
            queue.asyncAfter(deadline: .now() + timeout) {
                if #available(iOS 14.2, *), conn.currentPath?.unsatisfiedReason == .localNetworkDenied { finish(.localNetworkDenied) }
                else { finish(.unreachable("no answer in \(timeout)s")) }
            }
        }
    }
}

/// Which physical networks are usable right now. On cellular, iOS only lets the
/// reflector reach the device service (49152) with Cellular Data OFF; SideStore
/// hit the same wall on iOS 27 (SideStore issue #1505, "cellular refresh").
/// Blocking calls: use them off the main thread.
enum NetPath {
    static func isUp(_ type: NWInterface.InterfaceType) -> Bool {
        let monitor = NWPathMonitor(requiredInterfaceType: type)
        let sem = DispatchSemaphore(value: 0)
        var up = false
        monitor.pathUpdateHandler = { up = $0.status == .satisfied; sem.signal() }
        monitor.start(queue: DispatchQueue(label: "ic.netpath"))
        _ = sem.wait(timeout: .now() + 2)
        monitor.cancel()
        return up
    }

    static var internetUp: Bool { isUp(.wifi) || isUp(.cellular) }

    /// Polls `condition` once a second until it holds or `timeout` passes.
    static func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 1)
        }
        return condition()
    }
}
