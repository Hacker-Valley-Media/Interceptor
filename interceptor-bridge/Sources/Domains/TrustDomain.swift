import Foundation
import ApplicationServices
@preconcurrency import ScreenCaptureKit
import AVFoundation

final class TrustDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "trust", "preflight":
            preflight(completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func preflight(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let accessibilityGranted = AXIsProcessTrusted()

        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        let micGranted: String
        switch micStatus {
        case .authorized: micGranted = "true"
        case .denied, .restricted: micGranted = "false"
        case .notDetermined: micGranted = "not_requested"
        @unknown default: micGranted = "unknown"
        }

        Task { @Sendable in
            var screenGranted: Any = "unknown"
            do {
                let _ = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                screenGranted = true
            } catch {
                screenGranted = false
            }

            var permissions: [[String: Any]] = [
                [
                    "name": "Accessibility",
                    "granted": accessibilityGranted,
                    "required": true,
                    "path": "System Settings → Privacy & Security → Accessibility → Enable interceptor-bridge",
                    "reason": "Required for UI element inspection, clicking, typing, and window management"
                ],
                [
                    "name": "Microphone",
                    "granted": micGranted,
                    "required": false,
                    "path": "System Settings → Privacy & Security → Microphone → Enable interceptor-bridge",
                    "reason": "Required for speech recognition and voice activity detection"
                ],
                [
                    "name": "Screen Recording",
                    "granted": screenGranted,
                    "required": false,
                    "path": "System Settings → Privacy & Security → Screen Recording → Enable interceptor-bridge",
                    "reason": "Required for screenshots, screen capture, and vision analysis"
                ]
            ]

            var instructions: [String] = []
            for perm in permissions {
                if (perm["granted"] as? Bool) == false {
                    instructions.append(perm["path"] as? String ?? "")
                }
            }

            var result: [String: Any] = [
                "accessibility": accessibilityGranted,
                "screenRecording": screenGranted,
                "microphone": micGranted,
                "permissions": permissions
            ]

            if !instructions.isEmpty {
                result["action_required"] = instructions
            }

            completion(WireFormat.success(result))
        }
    }
}
