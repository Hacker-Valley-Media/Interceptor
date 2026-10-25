//
//  ICBootstrap.swift — the on-tap Connect flow.
//
//  Each stage publishes a `step` the Safari UI renders as a plain-language screen
//  (WebUI/src/screens.ts).
//
//  Warm vs cold is decided by whether the DDI is mounted THIS boot (ic-boot-marker
//  == kern.boottime), in ObjCSupport.m / ICRunnerUI.m:
//    - warm  → the runner runs the real XCTest and dials home. No UI flow.
//    - cold  → the Connect UI; its button POSTs /action → webConnect() below.
//
//  webConnect (cold): reflector up → (cellular: data off) → mount → (data on) →
//  install → launch the warm runner over the MOUNT's tunnel → it dials home. The
//  reflector is a 2nd VPN; iOS runs one at a time, so it pushes the user's VPN off.
//  We publish step "vpnOn" so the UI asks the user to turn their VPN back on; the
//  warm runner then dials home over it.
//

import Foundation
import NetworkExtension
import Network

@objc(ICBootstrap)
final class ICBootstrap: NSObject {

    /// The embedded Reflector appex: the runner app's own bundle id + ".reflector"
    /// (Scripts/build-dev-web.sh derives both from the signing team).
    static let reflectorProviderId = (Bundle.main.bundleIdentifier ?? "com.interceptor.runner.xctrunner") + ".reflector"

    // MARK: - boot marker (warm/cold discriminant)

    static func bootID() -> String {
        var tv = timeval(); var size = MemoryLayout<timeval>.stride
        var mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
        guard sysctl(&mib, 2, &tv, &size, nil, 0) == 0 else { return "0" }
        return "\(tv.tv_sec).\(tv.tv_usec)"
    }
    static var markerURL: URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.appendingPathComponent("ic-boot-marker")
    }
    static func mountedThisBoot() -> Bool {
        guard let url = markerURL, let s = try? String(contentsOf: url, encoding: .utf8) else { return false }
        return s.trimmingCharacters(in: .whitespacesAndNewlines) == bootID()
    }
    static func markMounted() { if let url = markerURL { try? bootID().write(to: url, atomically: true, encoding: .utf8) } }

    /// Warm startup: a cold Connect may have left the reflector VPN up (it holds the
    /// single VPN slot, keeping the user's VPN offline). Stop it so the slot frees.
    @objc static func stopReflectorBestEffort() {
        Thread.detachNewThread {
            let sem = DispatchSemaphore(value: 0)
            NETunnelProviderManager.loadAllFromPreferences { all, _ in
                for m in all ?? [] where (m.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == reflectorProviderId {
                    if m.connection.status != .disconnected {
                        icLog("WARM: stopping leftover reflector (status=\(m.connection.status.rawValue))")
                        (m.connection as? NETunnelProviderSession)?.stopTunnel()
                    }
                }
                sem.signal()
            }
            _ = sem.wait(timeout: .now() + 15)
        }
    }

    // MARK: - probe

    /// Blocking TCP probe of the device service through the reflector (10.7.0.1:49152).
    /// Refused on cellular while Cellular Data is on.
    static func syncProbe(timeout: TimeInterval = 3) -> Bool {
        let conn = NWConnection(host: NWEndpoint.Host("10.7.0.1"), port: 49152, using: .tcp)
        let sem = DispatchSemaphore(value: 0)
        let lock = NSLock(); var ok = false; var done = false
        func finish(_ v: Bool) { lock.lock(); if !done { done = true; ok = v; sem.signal() }; lock.unlock() }
        conn.stateUpdateHandler = { st in
            switch st { case .ready: finish(true); case .failed, .waiting: finish(false); default: break }
        }
        conn.start(queue: DispatchQueue(label: "ic.syncprobe"))
        _ = sem.wait(timeout: .now() + timeout)
        conn.cancel()
        return ok
    }

    // MARK: - web-driven connect (cold)

    private static let connecting = NSLock()
    private static var isConnecting = false

    /// POST /action {action:"connect"}. Runs on a worker, publishing each step.
    @objc static func webConnect() {
        connecting.lock(); if isConnecting { connecting.unlock(); return }; isConnecting = true; connecting.unlock()
        let worker = Thread {
            defer { connecting.lock(); isConnecting = false; connecting.unlock() }
            let web = ICWebServer.shared
            // Already mounted this boot: a runner may be live, and the launch below
            // replaces it. Refuse rather than kill a working session.
            guard !mountedThisBoot() else {
                icLog("WEBCONNECT: refused, the disk image is already mounted this boot")
                web.set(step: "failed", error: "Already set up since this iPhone last restarted. Close this page and open InterceptorRunner again; it connects by itself.")
                return
            }
            guard PairingFileStore.exists, DeveloperDiskImageStore.isComplete else {
                web.set(step: "setupNeeded"); return
            }
            // iOS only starts a VPN while the phone has a network, so bring the
            // reflector up first (Cellular Data still on).
            web.set(step: "startingVpn")
            guard let mgr = startReflectorSync() else {
                web.set(step: "failed", error: "The private link didn't come up. Make sure Wi-Fi or Cellular Data is on, then try again.")
                return
            }
            let cellularOnly = !NetPath.isUp(.wifi) && NetPath.isUp(.cellular)
            icLog("WEBCONNECT: reflector up; cellularOnly=\(cellularOnly) mountedThisBoot=\(mountedThisBoot())")

            var launched: Result<UInt64, DDIError>?
            var mountErr: String?
            for attempt in 1...3 {
                if cellularOnly && !syncProbe() {
                    web.set(step: "cellularOff")
                    icLog("WEBCONNECT: waiting for Cellular Data OFF (attempt \(attempt))")
                    guard NetPath.waitUntil(timeout: 180, { !NetPath.isUp(.cellular) }) else {
                        mountErr = "Cellular Data didn't turn off within 3 minutes."; break
                    }
                }
                web.set(step: "preparing")
                mountErr = DDIMounter.performMountSync(
                    beforeInstall: {
                        guard !NetPath.internetUp else { return }
                        web.set(step: "cellularOn")
                        icLog("WEBCONNECT: waiting for Cellular Data ON before install")
                        _ = NetPath.waitUntil(timeout: 180, { NetPath.internetUp })
                        web.set(step: "installing", progress: 0.3)
                    },
                    afterMount: { adapter, handshake in
                        markMounted()
                        web.set(step: "vpnOn")  // reflector is about to drop; ask the user to re-enable their VPN
                        icLog("WEBCONNECT: mounted; launching warm runner over the mount tunnel")
                        // The launch kills the running copy: the fresh warm process replaces this UI one.
                        launched = RunnerLauncher.launch(adapter: adapter, handshake: handshake)
                    })
                if mountErr == nil { break }
                icLog("WEBCONNECT: mount attempt \(attempt) failed: \(mountErr!)")
                if !(cellularOnly && mountErr!.contains("adapter closed")) { break }
            }
            // Only reached if the launch did NOT replace this process.
            stopReflectorSync(mgr)
            if let mountErr { web.set(step: "failed", error: mountErr) }
            else if case .failure(let e)? = launched { web.set(step: "failed", error: e.localizedDescription) }
            else { web.set(step: "vpnOn") }
        }
        worker.stackSize = 8 * 1024 * 1024
        worker.name = "ic.webconnect"
        worker.qualityOfService = .userInitiated
        worker.start()
    }

    // MARK: - reflector (synchronous; +load has no serviced MainActor)

    private static func startReflectorSync() -> NETunnelProviderManager? {
        guard let mgr = loadOrCreateSync() else { icLog("BOOTSTRAP: could not load NE config"); return nil }
        if !mgr.isEnabled { mgr.isEnabled = true; saveSync(mgr); _ = loadSync(mgr) }
        if mgr.connection.status != .connected {
            do {
                try (mgr.connection as? NETunnelProviderSession)?.startTunnel(options: [
                    "TunnelDeviceIP": "10.7.0.0" as NSString, "TunnelFakeIP": "10.7.0.1" as NSString,
                ])
            } catch { icLog("BOOTSTRAP: startTunnel threw \(error.localizedDescription)"); return nil }
        }
        var last = -1
        for _ in 0..<90 {
            let s = mgr.connection.status.rawValue
            if s != last { icLog("REFLECTOR: status=\(s)"); last = s }
            if mgr.connection.status == .connected { return mgr }
            Thread.sleep(forTimeInterval: 0.5)
        }
        icLog("BOOTSTRAP: reflector stuck at status=\(mgr.connection.status.rawValue) after 45s")
        stopReflectorSync(mgr) // don't leave it holding the VPN slot
        return nil
    }
    private static func stopReflectorSync(_ mgr: NETunnelProviderManager) {
        (mgr.connection as? NETunnelProviderSession)?.stopTunnel()
    }
    private static func loadOrCreateSync() -> NETunnelProviderManager? {
        let sem = DispatchSemaphore(value: 0)
        var result: NETunnelProviderManager?
        NETunnelProviderManager.loadAllFromPreferences { all, _ in
            if let existing = all?.first(where: { ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == reflectorProviderId }) {
                result = existing
            } else {
                let mgr = NETunnelProviderManager()
                let proto = NETunnelProviderProtocol()
                proto.providerBundleIdentifier = reflectorProviderId
                proto.serverAddress = "Interceptor reflector"
                mgr.protocolConfiguration = proto
                mgr.localizedDescription = "Interceptor link"
                mgr.isEnabled = true
                result = mgr
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 20)
        if let mgr = result, mgr.connection.status == .invalid { saveSync(mgr); _ = loadSync(mgr) }
        return result
    }
    @discardableResult private static func saveSync(_ mgr: NETunnelProviderManager) -> Bool {
        let sem = DispatchSemaphore(value: 0); var ok = false
        mgr.saveToPreferences { err in ok = (err == nil); if let err { icLog("BOOTSTRAP: save NE err \(err.localizedDescription)") }; sem.signal() }
        _ = sem.wait(timeout: .now() + 20); return ok
    }
    @discardableResult private static func loadSync(_ mgr: NETunnelProviderManager) -> Bool {
        let sem = DispatchSemaphore(value: 0); var ok = false
        mgr.loadFromPreferences { err in ok = (err == nil); sem.signal() }
        _ = sem.wait(timeout: .now() + 20); return ok
    }
}
