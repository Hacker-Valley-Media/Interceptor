import Foundation
import AppKit
import Sparkle

// `interceptor macos update *` — thin wrapper around SPUUpdater so the
// CLI can drive Sparkle directly (manual user-initiated update check,
// state inspection). Without this, agents and operators have to rely on
// Sparkle's automatic scheduled-check cadence, which for an LSUIElement
// app means the update prompt frequently never surfaces visibly.
//
// The `check` verb calls SPUUpdater.checkForUpdates() and waits briefly for
// Sparkle's delegate to report the selected item, no-update result, or error.
// If the feed takes longer, the command returns a truthful in-progress result
// and `status` exposes the later callback state.
final class UpdateDomain: DomainHandler, @unchecked Sendable {
    private let updaterController: SPUStandardUpdaterController
    private let updateState: SparkleUpdateState

    init(updaterController: SPUStandardUpdaterController, updateState: SparkleUpdateState) {
        self.updaterController = updaterController
        self.updateState = updateState
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "check":
            handleCheck(completion: completion)
        case "status":
            handleStatus(completion: completion)
        default:
            notImplemented("update \(sub)", completion: completion)
        }
    }

    // User-initiated check. `checkForUpdates(_:)` requires main-thread
    // invocation. The response is completed by SparkleUpdateState when the
    // delegate sees a conclusion, or after a bounded wait while still checking.
    private func handleCheck(completion: @escaping @Sendable ([String: Any]) -> Void) {
        DispatchQueue.main.async { [updaterController, updateState] in
            let updater = updaterController.updater
            guard updater.canCheckForUpdates else {
                completion(WireFormat.error("Sparkle is not ready to check for updates"))
                return
            }

            if updater.sessionInProgress {
                var payload = Self.statusPayload(updater: updater, snapshot: updateState.snapshot())
                payload["started"] = false
                payload["message"] = "an update session is already in progress"
                updaterController.checkForUpdates(nil)
                completion(WireFormat.success(payload))
                return
            }

            updateState.beginCheck(timeout: 10) { snapshot in
                DispatchQueue.main.async {
                    var payload = Self.statusPayload(updater: updater, snapshot: snapshot)
                    payload["started"] = true
                    payload["message"] = Self.message(for: snapshot)
                    completion(WireFormat.success(payload))
                }
            }
            updaterController.checkForUpdates(nil)
        }
    }

    // Snapshot of Sparkle's current scheduling and callback-observed state.
    private func handleStatus(completion: @escaping @Sendable ([String: Any]) -> Void) {
        DispatchQueue.main.async { [updaterController, updateState] in
            let updater = updaterController.updater
            completion(WireFormat.success(Self.statusPayload(updater: updater, snapshot: updateState.snapshot())))
        }
    }

    @MainActor
    private static func statusPayload(updater: SPUUpdater, snapshot: SparkleUpdateSnapshot) -> [String: Any] {
        var payload = snapshot.payload()
        payload["feed"] = updater.feedURL?.absoluteString ?? "unset"
        payload["automaticChecks"] = updater.automaticallyChecksForUpdates
        payload["checkInterval"] = updater.updateCheckInterval
        payload["canCheckForUpdates"] = updater.canCheckForUpdates
        payload["sessionInProgress"] = updater.sessionInProgress
        if let last = updater.lastUpdateCheckDate {
            payload["lastCheck"] = ISO8601DateFormatter().string(from: last)
        }
        return payload
    }

    private static func message(for snapshot: SparkleUpdateSnapshot) -> String {
        switch snapshot.outcome {
        case .updateAvailable:
            return "Sparkle selected update \(snapshot.selectedDisplayVersion ?? snapshot.selectedVersion ?? "unknown")"
        case .upToDate:
            return "Interceptor is up to date"
        case .noEligibleUpdate:
            return "Sparkle found no eligible update"
        case .error:
            return "Sparkle update check failed"
        case .checking:
            return "update check is still running; use `interceptor update status` for the result"
        default:
            return "Sparkle update check concluded"
        }
    }
}
