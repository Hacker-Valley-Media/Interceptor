import Foundation
import AppKit
import Sparkle

// Sparkle "gentle reminders":
//
// The bridge ships LSUIElement = true (background-only) so it doesn't get a
// Dock icon for normal operation. Sparkle's `SPUStandardUserDriver` detects
// this via `SUApplicationInfo.isBackgroundApplication` (which checks
// `application.activationPolicy == .accessory`) and, per its own docs,
// shows update alerts "in the background, behind other running apps." The
// user therefore never sees the prompt, even though Sparkle correctly
// schedules + downloads the update. Sparkle itself logs an Error-level
// warning every launch:
//
//   "Background app automatically schedules for update checks but does not
//    implement gentle reminders. As a result, users may not take notice
//    to update alerts that show up in the background."
//
// The fix is the same activation-policy pattern used for the
// Microphone TCC dialog: temporarily upgrade NSApp to .regular while the
// alert is being shown so it surfaces as a real modal window the user
// can't miss, then revert to .accessory after the user has responded.
// This is the canonical pattern used by Hammerspoon, Bartender, and other
// LSUIElement utilities that integrate Sparkle.
//
// Implementation notes:
//   - `supportsGentleScheduledUpdateReminders` must be `true` so Sparkle's
//     own warning shuts up.
//   - `standardUserDriverShouldHandleShowingScheduledUpdate` returns `true`
//     so Sparkle still owns the alert UI — we just upgrade the activation
//     policy around it.
//   - `standardUserDriverWillHandleShowingUpdate` fires before the alert
//     window is keyed; that's where we promote to `.regular`.
//   - `standardUserDriverWillFinishUpdateSession` fires after the user
//     dismisses, installs, or skips; that's where we revert to `.accessory`.
final class SparkleUserDriverDelegate: NSObject, SPUStandardUserDriverDelegate {

    // Sparkle reads this property at delegate-installation time. Without
    // it set to `true`, Sparkle logs the Error-level warning and falls
    // back to default (background) alert behavior.
    var supportsGentleScheduledUpdateReminders: Bool { true }

    // Returning `true` keeps Sparkle in charge of showing the alert UI.
    // We only intervene to make the alert window visible — we don't try
    // to replace Sparkle's own UI with our own (that's Path B / a future
    // PRD that uses UNUserNotificationCenter).
    func standardUserDriverShouldHandleShowingScheduledUpdate(
        _ update: SUAppcastItem,
        andInImmediateFocus immediateFocus: Bool
    ) -> Bool {
        return true
    }

    // Called immediately before the alert window is shown. Upgrade the
    // activation policy on the main thread so the alert parents to a
    // regular foreground app (visible Dock icon, proper NSApp.activate).
    // Same dispatch dance the mic prompt uses.
    func standardUserDriverWillHandleShowingUpdate(
        _ handleShowingUpdate: Bool,
        forUpdate update: SUAppcastItem,
        state: SPUUserUpdateState
    ) {
        DispatchQueue.main.async {
            NSApplication.shared.setActivationPolicy(.regular)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
    }

    // Called when the update session ends — user dismissed, skipped,
    // installed, or hit an error. Revert to `.accessory` so the bridge
    // disappears from the Dock and goes back to background-first.
    func standardUserDriverWillFinishUpdateSession() {
        DispatchQueue.main.async {
            NSApplication.shared.setActivationPolicy(.accessory)
        }
    }
}

// SPUUpdaterDelegate — separate from the user-driver delegate. Implements
// `allowedChannelsForUpdater:` so Sparkle accepts items posted to our
// "full" channel (every appcast item we publish carries
// `<sparkle:channel>full</sparkle:channel>`). Without this opt-in, Sparkle
// silently skips every channel-tagged item per its documented rule:
//
//   "If the @c <sparkle:channel> element is not present, the update item
//    is posted to the default channel and can be found by any updater.
//    Otherwise an item posted to a channel can only be found by an
//    updater that is allowed to use that channel."
//
// Source: research/Sparkle/Sparkle/SPUUpdaterDelegate.h:90-111.
final class SparkleUpdaterDelegate: NSObject, SPUUpdaterDelegate {
    func allowedChannels(for updater: SPUUpdater) -> Set<String> {
        return ["full"]
    }

    // The pkg postinstall bootstraps + kickstarts the LaunchAgent, which is the
    // only supervised owner of the bridge process. Sparkle's own stage-3
    // relaunch (Autoupdate `relaunchApplication`) would start a second,
    // unsupervised instance that survives the next install and leaves the Mac
    // with two bridges (observed after a Sparkle update). Sparkle still quits
    // the bridge for the bundle swap (stage 2, `BridgeAppDelegate`); only the
    // relaunch is declined.
    func updaterShouldRelaunchApplication(_ updater: SPUUpdater) -> Bool {
        return false
    }
}
