//
//  InterceptorCompanionApp.swift — entry point.
//
//  After a reboot away from home, open this app and tap "Connect my iPhone".
//  It mounts the Developer Disk Image on the device itself (over cellular,
//  through the bundled loopback reflector) and launches the InterceptorRunner,
//  which dials home over the user's VPN. No Mac required.
//
//  Launch arg `--ic-autoconnect` runs the whole flow on launch and NSLogs each
//  step (so `devicectl device process launch --console` can drive + observe the
//  mount with no runner involved). `--ic-autoconnect-mount-only` stops after the
//  mount (does not launch the runner), for validating the mount in isolation.
//

import SwiftUI

@main
struct InterceptorCompanionApp: App {
    @StateObject private var model = CompanionModel()
    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .task {
                    let args = ProcessInfo.processInfo.arguments
                    if args.contains("--ic-autoconnect") {
                        await model.connect()
                    } else if args.contains("--ic-autoconnect-mount-only") {
                        await model.connect(mountOnly: true)
                    }
                }
        }
    }
}
