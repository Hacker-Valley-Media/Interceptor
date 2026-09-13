import Foundation
import AppKit

// Sparkle's update install flow sends the running app
// an Apple Quit event (kAEQuitApplication) at stage 2 of installation —
// the documented termination request. From Sparkle's Installation.md:
//
//   "When the target application is terminated, ... the installer sends
//    a request to the progress agent to *terminate* the application. By
//    *terminate*, we mean sending an Apple quit event, allowing the
//    application or user to possibly cancel or delay termination."
//
// Without an NSApplicationDelegate that handles termination cleanly, the
// bridge's main thread hangs while Sparkle's installer is waiting for
// process exit, macOS marks the bridge "Not responding," and the install
// never completes. Adding a minimal delegate that runs cleanup and
// returns .terminateNow gets the bridge out of the way so Sparkle can
// replace the bundle, and the launchagent (`KeepAlive.SuccessfulExit =
// false`) won't immediately respawn the OLD binary during the install
// window. Package postinstall starts the LaunchAgent-owned bridge; the
// process-lifetime lock rejects any extra launch from Sparkle's progress agent.
final class BridgeAppDelegate: NSObject, NSApplicationDelegate {

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Platform.log("AppDelegate: terminate requested — running cleanup")
        // Tear down overlays so they don't outlive the bridge process.
        // Same teardown the SIGINT/SIGTERM signal handlers in main.swift
        // perform, factored here so Apple Quit events get the same cleanup.
        GlobalOverlayDomainRef.shared?.handle("stop", action: ["sub": "stop"]) { _ in }
        // Brief pause to let in-flight overlay teardown complete before
        // the bundle is replaced under us.
        Thread.sleep(forTimeInterval: 0.1)
        Platform.cleanup()
        // .terminateNow tells AppKit to proceed with terminate immediately.
        // Sparkle's install can now move to bundle replacement.
        return .terminateNow
    }

    // Sparkle may also send an "are you ready to be terminated" check via
    // applicationShouldTerminateAfterLastWindowClosed. The bridge has no
    // windows in steady state (LSUIElement = true), but during the
    // activation-policy upgrade Sparkle puts up its own alert window.
    // Returning false here keeps the bridge alive when that alert closes
    // (the user might dismiss without installing); termination then comes
    // later through applicationShouldTerminate above when Sparkle is
    // ready to install.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }
}
