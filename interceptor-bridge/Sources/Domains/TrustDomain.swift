import Foundation
import ApplicationServices
import AppKit
import CoreGraphics
import AVFoundation
#if canImport(Speech)
import Speech
#endif

// Trust response payload — schema lifted from Apple's AVAuthorizationStatus
// vocabulary. Status values:
//
//   granted        — user has authorized the permission
//   denied         — user has denied the permission
//   not_determined — user has not yet been prompted (Mic only by Apple API design)
//   restricted     — system policy blocks the user from changing it (Mic only)
//
// AX and Screen Recording can only ever surface granted or denied because
// Apple's AXIsProcessTrusted / CGPreflightScreenCaptureAccess return Bool.
// We document that asymmetry inline via `limitation` on those entries.
struct Permission {
    let name: String
    let status: PermissionStatus
    let required: Bool
    let path: String
    let reason: String
    let limitation: String?

    func toDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "name": name,
            "status": status.rawValue,
            "required": required,
            "path": path,
            "reason": reason,
            // Deprecated for one release. Computed from `status`.
            // Drop in a future release once consumers have migrated.
            "granted": status == .granted
        ]
        if let limitation = limitation {
            dict["limitation"] = limitation
        }
        return dict
    }
}

final class TrustDomain: DomainHandler, @unchecked Sendable {
    private let microphoneProvider: MicrophoneAuthorizationProvider
    // Signing-status seam (issue #163 follow-up): ad-hoc-signed bridges
    // lose their TCC grants on every rebuild while the System Settings row
    // stays visibly on. Surfacing the signature here lets `macos trust`
    // warn once instead of the user debugging the target app.
    private let signingProvider: any SigningInfoProvider
    // AXIsProcessTrusted[/WithOptions] route through the
    // transport (the one Accessibility C-call surface).
    private let transport: any AXTransport = LiveAXTransport()

    init(
        microphoneProvider: MicrophoneAuthorizationProvider = LiveMicrophoneAuthorizationProvider(),
        signingProvider: any SigningInfoProvider = LiveSigningInfoProvider()
    ) {
        self.microphoneProvider = microphoneProvider
        self.signingProvider = signingProvider
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "trust", "preflight":
            preflight(action: action, completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func preflight(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        // Defense-in-depth: --no-prompt overrides every other prompt flag so
        // read-only consumers can rely on the call never modifying TCC state
        // even if a future caller-side bug accidentally sets one of the
        // prompt booleans.
        let noPrompt = action["noPrompt"] as? Bool ?? false
        let prompt = !noPrompt && (action["prompt"] as? Bool ?? false)
        let walkthrough = !noPrompt && (action["walkthrough"] as? Bool ?? false)
        let accessibilityPrompt = !noPrompt && (action["accessibilityPrompt"] as? Bool ?? false)
        let screenPrompt = !noPrompt && (action["screenPrompt"] as? Bool ?? false)
        let microphonePrompt = !noPrompt && (action["microphonePrompt"] as? Bool ?? false)
        // Speech Recognition is a distinct TCC service from
        // Microphone. `macos trust speech --prompt` (or --speech-prompt) surfaces it.
        let speechPrompt = !noPrompt && (action["speechPrompt"] as? Bool ?? false)

        let shouldPromptAccessibility = prompt || walkthrough || accessibilityPrompt
        let shouldPromptScreen = prompt || walkthrough || screenPrompt
        let shouldPromptMicrophone = prompt || walkthrough || microphonePrompt
        let shouldPromptSpeech = prompt || walkthrough || speechPrompt

        let accessibilityStatus = checkAccessibility(prompt: shouldPromptAccessibility)
        let screenStatus = checkScreenRecording(prompt: shouldPromptScreen)
        let microphoneStatus = checkMicrophone(prompt: shouldPromptMicrophone)
        let speechStatus = checkSpeech(prompt: shouldPromptSpeech)

        let displayName =
            (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
            ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String)
            ?? "Interceptor"

        let permissions: [Permission] = [
            Permission(
                name: "Accessibility",
                status: accessibilityStatus,
                required: true,
                path: "System Settings → Privacy & Security → Accessibility → Enable \(displayName)",
                reason: "Required for UI element inspection, clicking, typing, and window management",
                limitation: "Apple's AXIsProcessTrusted returns Bool only; cannot distinguish denied from not_determined"
            ),
            Permission(
                name: "Microphone",
                status: microphoneStatus,
                required: false,
                path: "System Settings → Privacy & Security → Microphone → Enable \(displayName)",
                reason: "Required for speech recognition and voice activity detection",
                limitation: nil
            ),
            Permission(
                name: "Screen Recording",
                status: screenStatus,
                required: false,
                path: "System Settings → Privacy & Security → Screen Recording → Enable \(displayName)",
                reason: "Required for screenshots, screen capture, and vision analysis",
                limitation: "Apple's CGPreflightScreenCaptureAccess returns Bool only; cannot distinguish denied from not_determined"
            ),
            Permission(
                name: "Speech Recognition",
                status: speechStatus,
                required: false,
                path: "System Settings → Privacy & Security → Speech Recognition → Enable \(displayName)",
                reason: "Required for live speech-to-text during workflow capture (mac_monitor --include speech)",
                limitation: nil
            )
        ]

        // Walkthrough opens the next non-granted Privacy pane. Order matches
        // the operator priority: Accessibility (required) before Screen
        // (used for capture) before Microphone (optional).
        var openedPanes: [String] = []
        if walkthrough {
            if accessibilityStatus != .granted {
                openPrivacyPane("Privacy_Accessibility")
                openedPanes.append("Accessibility")
            } else if screenStatus != .granted {
                openPrivacyPane("Privacy_ScreenCapture")
                openedPanes.append("Screen Recording")
            } else if microphoneStatus != .granted {
                openPrivacyPane("Privacy_Microphone")
                openedPanes.append("Microphone")
            } else if speechStatus != .granted {
                openPrivacyPane("Privacy_SpeechRecognition")
                openedPanes.append("Speech Recognition")
            }
        }

        let actionRequired = permissions
            .filter { $0.status != .granted }
            .map { $0.path }

        // pending_user_action signals that a prompt was just fired but the
        // status is still not_determined — the user is being asked right now
        // and the caller should re-poll trust later. Only meaningful for
        // Microphone since it's the only surface where not_determined is
        // observable.
        var pendingUserAction: [String] = []
        if shouldPromptMicrophone && microphoneStatus == .notDetermined {
            pendingUserAction.append("Microphone")
        }
        if shouldPromptSpeech && speechStatus == .notDetermined {
            pendingUserAction.append("Speech Recognition")
        }

        let signing = signingProvider.signingInfo()

        var result: [String: Any] = [
            "accessibility": accessibilityStatus.rawValue,
            "screenRecording": screenStatus.rawValue,
            "microphone": microphoneStatus.rawValue,
            "speechRecognition": speechStatus.rawValue,
            "permissions": permissions.map { $0.toDictionary() },
            "bundlePath": Bundle.main.bundlePath,
            "displayName": displayName,
            "signing": signing.toDictionary()
        ]

        if signing.adhoc {
            result["warnings"] = [
                "Bridge binary is ad-hoc signed: TCC grants are pinned to this exact build (cdhash) "
                + "and will NOT survive a rebuild. A System Settings row may exist without applying. "
                + "Install the signed build for durable grants."
            ]
        }

        if !actionRequired.isEmpty {
            result["action_required"] = actionRequired
        }

        var prompted: [String] = []
        if shouldPromptAccessibility { prompted.append("Accessibility") }
        if shouldPromptScreen { prompted.append("Screen Recording") }
        if shouldPromptMicrophone { prompted.append("Microphone") }
        if shouldPromptSpeech { prompted.append("Speech Recognition") }
        if !prompted.isEmpty {
            result["prompted"] = prompted
        }

        if !openedPanes.isEmpty {
            result["opened"] = openedPanes
        }

        if !pendingUserAction.isEmpty {
            result["pending_user_action"] = pendingUserAction
        }

        completion(WireFormat.success(result))
    }

    // ── Accessibility ────────────────────────────────────────────────────
    // Apple's AXIsProcessTrusted / AXIsProcessTrustedWithOptions return Bool
    // only. The prompt is async and (per Apple's docs) "does not affect the
    // return value." So this function returns the *current* trust state
    // regardless of whether we just fired a prompt.
    private func checkAccessibility(prompt: Bool) -> PermissionStatus {
        let trusted: Bool
        if prompt {
            let key = "AXTrustedCheckOptionPrompt" as CFString
            let options = [key: true] as CFDictionary
            trusted = transport.isProcessTrustedWithOptions(options)
        } else {
            trusted = transport.isProcessTrusted()
        }
        return PermissionStatus.fromBool(trusted)
    }

    // ── Screen Recording ─────────────────────────────────────────────────
    // CGPreflightScreenCaptureAccess / CGRequestScreenCaptureAccess return
    // Bool. Same Apple-imposed 2-state asymmetry as Accessibility.
    private func checkScreenRecording(prompt: Bool) -> PermissionStatus {
        if !prompt {
            return PermissionStatus.fromBool(CGPreflightScreenCaptureAccess())
        }
        if CGPreflightScreenCaptureAccess() {
            return .granted
        }
        // CGRequestScreenCaptureAccess is documented as Bool. It returns
        // the post-call grant state. We return that directly.
        return PermissionStatus.fromBool(CGRequestScreenCaptureAccess())
    }

    // ── Microphone ───────────────────────────────────────────────────────
    // Apple's AVAuthorizationStatus is the only TCC surface in this domain
    // that exposes all four states. Apple's requestAccess is documented
    // non-blocking — we fire it without awaiting. The completion handler is
    // intentionally a no-op so the bridge worker thread can return
    // immediately. Callers re-poll `interceptor macos trust` to observe the
    // user's eventual response.
    //
    // LSUIElement-attached caveat (this is the load-bearing detail for
    // the live mic prompt): when an LSUIElement = true app calls
    // requestAccess, macOS surfaces the permission alert as a transient
    // notification banner instead of a modal dialog. The banner can be
    // missed by the user and auto-resolves to "denied" within a few seconds.
    //
    // The canonical fix used by every menu-bar utility that needs TCC
    // permissions (Hammerspoon, Bartender, Karabiner-Elements, etc.) is
    // to temporarily upgrade the activation policy from .accessory to
    // .regular before requesting permission. This forces macOS to surface
    // a real modal dialog parented to the now-foreground process. After
    // the user responds, we revert to .accessory so we don't leak a Dock
    // icon or cmd-tab entry beyond the prompt.
    private func checkMicrophone(prompt: Bool) -> PermissionStatus {
        let current = microphoneProvider.currentStatus().permissionStatus

        // Already-decided states cannot be changed by another prompt; short
        // circuit so we never fire a redundant requestAccess.
        if current != .notDetermined {
            return current
        }

        guard prompt else { return .notDetermined }

        // Upgrade activation policy on the main thread BEFORE firing
        // requestAccess so the alert surfaces modally. This is documented
        // on NSApplication.setActivationPolicy and is the standard pattern
        // for LSUIElement utilities.
        //
        // Gated on bundle id so unit tests (xctest) don't try to manipulate
        // their own process's Dock presence. Only the real bridge process
        // (com.interceptor.bridge) does the upgrade.
        let isLiveBridge = Bundle.main.bundleIdentifier == "com.interceptor.bridge"

        if isLiveBridge {
            DispatchQueue.main.async {
                NSApplication.shared.setActivationPolicy(.regular)
                NSApplication.shared.activate(ignoringOtherApps: true)
            }
        }

        // Fire-and-forget. Apple-doc: "Calling this method doesn't block
        // the thread while the system is prompting the user for access."
        // Once the user responds, revert to .accessory so the Dock icon
        // disappears and we go back to background-first behavior.
        microphoneProvider.requestAccess { _ in
            if isLiveBridge {
                DispatchQueue.main.async {
                    NSApplication.shared.setActivationPolicy(.accessory)
                }
            }
        }

        // Re-read in case the request resolved synchronously (it shouldn't
        // for a true notDetermined entry, but if Apple's behavior ever
        // changes we surface the new state). If it's still notDetermined we
        // emit pending_user_action upstream.
        return microphoneProvider.currentStatus().permissionStatus
    }

    // ── Speech Recognition ───────────────────────────────────────────────
    // distinct TCC service from Microphone. Same LSUIElement
    // activation-policy-upgrade trick as the mic prompt: a faceless .accessory
    // agent can't reliably surface a TCC dialog, so go .regular for the request
    // then back to .accessory. Authorization is requested with an actor-neutral
    // closure (Apple may call it off the main queue; a @MainActor closure would
    // crash). Defensively no-op if the usage string is missing — calling
    // requestAuthorization without it CRASHES per Apple's docs.
    #if canImport(Speech)
    private func checkSpeech(prompt: Bool) -> PermissionStatus {
        let current = speechPermissionStatus(SFSpeechRecognizer.authorizationStatus())
        if current != .notDetermined { return current }
        guard prompt else { return .notDetermined }
        guard Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil else {
            return .notDetermined
        }

        let isLiveBridge = Bundle.main.bundleIdentifier == "com.interceptor.bridge"
        if isLiveBridge {
            DispatchQueue.main.async {
                NSApplication.shared.setActivationPolicy(.regular)
                NSApplication.shared.activate(ignoringOtherApps: true)
            }
        }
        SFSpeechRecognizer.requestAuthorization { _ in
            if isLiveBridge {
                DispatchQueue.main.async {
                    NSApplication.shared.setActivationPolicy(.accessory)
                }
            }
        }
        return speechPermissionStatus(SFSpeechRecognizer.authorizationStatus())
    }

    private func speechPermissionStatus(_ status: SFSpeechRecognizerAuthorizationStatus) -> PermissionStatus {
        switch status {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .notDetermined
        }
    }
    #else
    private func checkSpeech(prompt: Bool) -> PermissionStatus { .notDetermined }
    #endif

    private func openPrivacyPane(_ anchor: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else {
            return
        }
        Task { @MainActor in
            NSWorkspace.shared.open(url)
        }
    }
}
