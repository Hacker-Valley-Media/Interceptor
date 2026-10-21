//
//  ContentView.swift — the one screen.
//
//  "Connect my iPhone" runs the whole sequence: bring up the reflector, mount
//  the DDI, launch the runner, then drop the reflector so Tailscale gets the VPN
//  slot back and the runner dials home. Setup (pairing file + DDI files) is done
//  once at home; after that a reboot away from home is one tap.
//

import Network
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class CompanionModel: ObservableObject {
    @Published var status = "Idle"
    @Published var busy = false
    @Published var lastError: String?
    @Published var runnerPid: UInt64?
    @Published var pairingPresent = PairingFileStore.exists
    @Published var ddiPresent = DeveloperDiskImageStore.isComplete

    let mounter = DDIMounter()
    let ddiStore = DeveloperDiskImageStore()

    func refreshSetup() {
        pairingPresent = PairingFileStore.exists
        ddiPresent = DeveloperDiskImageStore.isComplete
    }

    /// The full one-tap flow. `mountOnly` stops after the mount (no runner launch).
    ///
    /// On cellular (no Wi-Fi) the device service didn't answer through the reflector
    /// with Cellular Data on, while the image mount needs Apple's
    /// signing server. So: reflector (needs a network) → data off → tunnel → data on
    /// → mount and launch → stop the reflector. The status line says when to flip
    /// Cellular Data, and each wait continues by itself once it flips.
    func connect(mountOnly: Bool = false) async {
        guard !busy else { return }
        busy = true; lastError = nil; runnerPid = nil
        defer { busy = false }
        do {
            guard pairingPresent else { throw DDIError.missingPairingFile }
            guard ddiPresent else { throw DDIError.missingImage }

            let wifi = await Self.up(.wifi), cellular = await Self.up(.cellular)
            icLog("AUTOCONNECT: network wifi=\(wifi) cellular=\(cellular)")

            // iOS only starts a VPN while the phone has a network (with Wi-Fi and
            // Cellular Data both off it stays disconnected), so the
            // reflector comes up before any Cellular Data step.
            status = "Starting the loopback reflector…"; icLog("AUTOCONNECT: starting reflector")
            let mgr = try await ReflectorTunnel.start()
            var probe = await ReflectorTunnel.probe()
            icLog("AUTOCONNECT: reflector up; probe=\(probe)")
            if probe != .reachable && !wifi && cellular {
                try await waitForCellularData(on: false)
                probe = await ReflectorTunnel.probe(timeout: 3)
                icLog("AUTOCONNECT: with Cellular Data off: VPN status=\(mgr.connection.status.rawValue), probe=\(probe)")
            }

            var launched: Result<UInt64, DDIError>?
            for attempt in 1...3 {
                status = "Mounting the developer disk image…"; icLog("AUTOCONNECT: mounting (attempt \(attempt))")
                await mounter.mount(
                    beforeInstall: { [weak self] in
                        guard !NetPath.internetUp else { return }
                        Task { @MainActor in self?.status = "Tunnel open. Turn Cellular Data back ON in Control Center; I'll install the disk image." }
                        icLog("AUTOCONNECT: tunnel open, no internet; waiting for Cellular Data ON")
                        let back = NetPath.waitUntil(timeout: 180) { NetPath.internetUp }
                        icLog("AUTOCONNECT: internet back = \(back)")
                        Task { @MainActor in self?.status = "Installing the developer disk image…" }
                    },
                    afterMount: mountOnly ? nil : { adapter, handshake in
                        launched = RunnerLauncher.launch(adapter: adapter, handshake: handshake)
                    })
                icLog("AUTOCONNECT: mount phase = \(mounter.phase)")
                // ponytail: matches idevice's error text. The tunnel can drop when Cellular
                // Data comes back on (about half the time); the next try usually holds.
                guard case .failed(let why) = mounter.phase, why.contains("adapter closed"), attempt < 3,
                      !(await Self.up(.wifi)) else { break }
                icLog("AUTOCONNECT: the tunnel dropped when Cellular Data came back on; retrying")
                try await waitForCellularData(on: false)
                icLog("AUTOCONNECT: retry probe=\(await ReflectorTunnel.probe(timeout: 3))")
            }
            if case .failed(let why) = mounter.phase { throw DDIError.ffi("Mount", why) }

            if mountOnly {
                status = "Mounted — reflector stopping."; icLog("AUTOCONNECT: mount OK (mount-only)")
                await ReflectorTunnel.stop()
                return
            }

            status = "Launching InterceptorRunner…"
            if case .success(let pid)? = launched {
                runnerPid = pid; icLog("AUTOCONNECT: runner pid \(pid) (mount tunnel)")
            } else {
                if case .failure(let err)? = launched { icLog("AUTOCONNECT: launch over the mount tunnel failed (\(err.localizedDescription)); opening a fresh tunnel") }
                // A fresh tunnel lists the services the new image added. On cellular that needs data off again.
                if !(await Self.up(.wifi)), await Self.up(.cellular) { try await waitForCellularData(on: false) }
                let result: Result<UInt64, DDIError> = await Task.detached { RunnerLauncher.launch() }.value
                switch result {
                case .success(let pid): runnerPid = pid; icLog("AUTOCONNECT: runner pid \(pid)")
                case .failure(let err): throw err
                }
            }

            // The runner dials home over Tailscale, so the phone needs internet again.
            if !(await Task.detached { NetPath.internetUp }.value) { try await waitForCellularData(on: true) }
            status = "Stopping the reflector (Tailscale takes over)…"
            await ReflectorTunnel.stop()
            status = "Connected — the runner is dialing home over Tailscale. You can close the app."
            icLog("AUTOCONNECT: done")
        } catch let startErr as ReflectorTunnel.StartError {
            // The reflector is still coming up (cold after a reboot). Leave it
            // RUNNING so the next tap finds it .connected, and tell the user to retry.
            lastError = startErr.localizedDescription + " — tap Connect again in a few seconds."
            status = "Reflector warming up — tap Connect again shortly."
            icLog("AUTOCONNECT: reflector not ready yet (left running for retry) — \(startErr.localizedDescription)")
        } catch {
            lastError = error.localizedDescription
            status = "Failed"; icLog("AUTOCONNECT: FAILED — \(error.localizedDescription)")
            if !(await Task.detached { NetPath.internetUp }.value) { lastError! += " Turn Cellular Data back on." }
            await ReflectorTunnel.stop()
        }
    }

    private static func up(_ type: NWInterface.InterfaceType) async -> Bool {
        await Task.detached { NetPath.isUp(type) }.value
    }

    /// Ask for Cellular Data off/on and carry on by ourselves once it flips.
    private func waitForCellularData(on: Bool) async throws {
        status = on ? "Turn Cellular Data back ON in Control Center; I'll continue by myself."
                    : "On cellular, iOS keeps the device service closed while Cellular Data is on. Turn Cellular Data OFF in Control Center (leave Wi-Fi off); I'll continue by myself."
        icLog("AUTOCONNECT: waiting for Cellular Data \(on ? "ON" : "OFF")")
        let ok = await Task.detached { NetPath.waitUntil(timeout: 180) { on ? NetPath.internetUp : !NetPath.isUp(.cellular) } }.value
        icLog("AUTOCONNECT: Cellular Data \(on ? "ON" : "OFF") = \(ok)")
        guard ok else { throw DDIError.ffi("Waiting for Cellular Data", "it didn't turn \(on ? "on" : "off") within 3 minutes") }
    }
}

struct ContentView: View {
    @ObservedObject var model: CompanionModel
    @State private var showPairingPicker = false
    @State private var showDDIPicker = false
    @State private var showLog = false

    var body: some View {
        NavigationView {
            Form {
                Section("Connect") {
                    Button {
                        Task { await model.connect() }
                    } label: {
                        Label(model.busy ? "Working…" : "Connect my iPhone", systemImage: "antenna.radiowaves.left.and.right")
                    }
                    .disabled(model.busy || !model.pairingPresent || !model.ddiPresent)
                    Text(model.status).font(.footnote).foregroundStyle(.secondary)
                    if let pid = model.runnerPid { Text("Runner launched (pid \(pid))").font(.footnote).foregroundStyle(.green) }
                    if let err = model.lastError { Text(err).font(.footnote).foregroundStyle(.red) }
                }

                Section("Setup (once, at home)") {
                    HStack {
                        Image(systemName: model.pairingPresent ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(model.pairingPresent ? .green : .secondary)
                        VStack(alignment: .leading) {
                            Text("Pairing file")
                            Text(model.pairingPresent ? "imported" : "export from the Mac: interceptor ios pairing-export")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Import") { showPairingPicker = true }.buttonStyle(.bordered)
                    }
                    HStack {
                        Image(systemName: model.ddiPresent ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(model.ddiPresent ? .green : .secondary)
                        VStack(alignment: .leading) {
                            Text("Developer disk image")
                            Text(model.ddiPresent ? "present (\(ByteCountFormatter.string(fromByteCount: DeveloperDiskImageStore.totalBytesOnDisk, countStyle: .file)))" : "import a folder, or download")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Import") { showDDIPicker = true }.buttonStyle(.bordered)
                    }
                    if !model.ddiPresent {
                        Button {
                            Task { await model.ddiStore.download(); model.refreshSetup() }
                        } label: {
                            if model.ddiStore.isDownloading {
                                ProgressView(value: model.ddiStore.progress) { Text(model.ddiStore.statusMessage ?? "Downloading…") }
                            } else { Text("Download DDI (~100 MB, cellular OK)") }
                        }.disabled(model.ddiStore.isDownloading)
                    }
                }

                Section {
                    Button("Show log") { showLog = true }
                    Text("DDI mount method: \(DeveloperDiskImageStore.mountMethod.rawValue) (iOS \(ProcessInfo.processInfo.operatingSystemVersionString))")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Interceptor Companion")
            .onAppear { model.refreshSetup() }
            .fileImporter(isPresented: $showPairingPicker, allowedContentTypes: PairingFileStore.supportedContentTypes) { result in
                if case .success(let url) = result {
                    if let why = PairingFileStore.importFile(at: url) { model.lastError = "Pairing import: \(why)" } else { model.lastError = nil }
                    model.refreshSetup()
                }
            }
            .fileImporter(isPresented: $showDDIPicker, allowedContentTypes: [.folder]) { result in
                if case .success(let url) = result {
                    _ = model.ddiStore.importFrom(directory: url)
                    model.refreshSetup()
                }
            }
            .sheet(isPresented: $showLog) {
                NavigationView {
                    ScrollView { Text(CompanionLog.tail()).font(.system(.caption, design: .monospaced)).padding() }
                        .navigationTitle("Log")
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showLog = false } } }
                }
            }
        }
    }
}
