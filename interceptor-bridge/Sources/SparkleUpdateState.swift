import Foundation

enum SparkleUpdatePhase: String, Sendable {
    case idle
    case checking
    case updateAvailable = "update_available"
    case downloading
    case downloaded
    case extracting
    case readyToInstall = "ready_to_install"
    case installing
    case deferred
    case error
}

enum SparkleUpdateOutcome: String, Sendable {
    case none
    case checking
    case updateAvailable = "update_available"
    case upToDate = "up_to_date"
    case noEligibleUpdate = "no_eligible_update"
    case installChosen = "install_chosen"
    case deferred
    case skipped
    case installing
    case error
}

struct SparkleUpdateSnapshot: Sendable {
    let phase: SparkleUpdatePhase
    let outcome: SparkleUpdateOutcome
    let selectedVersion: String?
    let selectedDisplayVersion: String?
    let latestFeedVersion: String?
    let noUpdateReason: String?
    let userChoice: String?
    let updateStage: String?
    let lastError: String?
    let checkStartedAt: String?
    let updatedAt: String?
    let cycleFinishedAt: String?

    var concluded: Bool { outcome != .checking }

    func payload() -> [String: Any] {
        var result: [String: Any] = [
            "phase": phase.rawValue,
            "outcome": outcome.rawValue,
            "concluded": concluded,
        ]
        if let selectedVersion { result["selectedVersion"] = selectedVersion }
        if let selectedDisplayVersion { result["selectedDisplayVersion"] = selectedDisplayVersion }
        if let latestFeedVersion { result["latestFeedVersion"] = latestFeedVersion }
        if let noUpdateReason { result["noUpdateReason"] = noUpdateReason }
        if let userChoice { result["userChoice"] = userChoice }
        if let updateStage { result["updateStage"] = updateStage }
        if let lastError { result["lastError"] = lastError }
        if let checkStartedAt { result["checkStartedAt"] = checkStartedAt }
        if let updatedAt { result["updatedAt"] = updatedAt }
        if let cycleFinishedAt { result["cycleFinishedAt"] = cycleFinishedAt }
        return result
    }
}

// Sparkle invokes updater delegate callbacks on the main thread. UpdateDomain
// also enters through DispatchQueue.main before reading or changing this store,
// so a lock or a second event system would only duplicate Sparkle's ordering.
final class SparkleUpdateState: @unchecked Sendable {
    typealias Conclusion = @Sendable (SparkleUpdateSnapshot) -> Void

    private var phase: SparkleUpdatePhase = .idle
    private var outcome: SparkleUpdateOutcome = .none
    private var selectedVersion: String?
    private var selectedDisplayVersion: String?
    private var latestFeedVersion: String?
    private var noUpdateReason: String?
    private var userChoice: String?
    private var updateStage: String?
    private var lastError: String?
    private var checkStartedAt: String?
    private var updatedAt: String?
    private var cycleFinishedAt: String?
    private var pendingConclusion: Conclusion?
    private var checkGeneration = 0

    func snapshot() -> SparkleUpdateSnapshot {
        SparkleUpdateSnapshot(
            phase: phase,
            outcome: outcome,
            selectedVersion: selectedVersion,
            selectedDisplayVersion: selectedDisplayVersion,
            latestFeedVersion: latestFeedVersion,
            noUpdateReason: noUpdateReason,
            userChoice: userChoice,
            updateStage: updateStage,
            lastError: lastError,
            checkStartedAt: checkStartedAt,
            updatedAt: updatedAt,
            cycleFinishedAt: cycleFinishedAt
        )
    }

    func beginCheck(timeout: TimeInterval, conclusion: @escaping Conclusion) {
        checkGeneration += 1
        let generation = checkGeneration
        phase = .checking
        outcome = .checking
        selectedVersion = nil
        selectedDisplayVersion = nil
        latestFeedVersion = nil
        noUpdateReason = nil
        userChoice = nil
        updateStage = nil
        lastError = nil
        checkStartedAt = Self.timestamp()
        updatedAt = checkStartedAt
        cycleFinishedAt = nil
        pendingConclusion = conclusion

        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self, self.checkGeneration == generation,
                  let pending = self.pendingConclusion else { return }
            self.pendingConclusion = nil
            pending(self.snapshot())
        }
    }

    func recordUpdateFound(version: String, displayVersion: String) {
        phase = .updateAvailable
        outcome = .updateAvailable
        selectedVersion = version
        selectedDisplayVersion = displayVersion
        lastError = nil
        touch()
        deliverConclusion()
    }

    func recordNoUpdate(latestVersion: String?, reason: String, currentIsLatest: Bool) {
        phase = .idle
        outcome = currentIsLatest ? .upToDate : .noEligibleUpdate
        latestFeedVersion = latestVersion
        noUpdateReason = reason
        lastError = nil
        touch()
        deliverConclusion()
    }

    func recordUserChoice(_ choice: String, stage: String) {
        userChoice = choice
        updateStage = stage
        switch choice {
        case "install":
            outcome = .installChosen
            phase = stage == "installing" ? .installing : (stage == "downloaded" ? .readyToInstall : .downloading)
        case "dismiss":
            outcome = .deferred
            phase = stage == "installing" ? .installing : .deferred
        case "skip":
            outcome = .skipped
            phase = .idle
        default:
            break
        }
        touch()
    }

    func recordDownloading(version: String, displayVersion: String) {
        select(version: version, displayVersion: displayVersion)
        phase = .downloading
        touch()
    }

    func recordDownloaded(version: String, displayVersion: String) {
        select(version: version, displayVersion: displayVersion)
        phase = .downloaded
        touch()
    }

    func recordExtracting(version: String, displayVersion: String) {
        select(version: version, displayVersion: displayVersion)
        phase = .extracting
        touch()
    }

    func recordReadyToInstall(version: String, displayVersion: String) {
        select(version: version, displayVersion: displayVersion)
        phase = .readyToInstall
        touch()
    }

    func recordInstalling(version: String, displayVersion: String) {
        select(version: version, displayVersion: displayVersion)
        phase = .installing
        outcome = .installing
        touch()
    }

    func recordError(_ message: String) {
        phase = .error
        outcome = .error
        lastError = message
        touch()
        deliverConclusion()
    }

    func recordCycleFinished(error: String?) {
        cycleFinishedAt = Self.timestamp()
        updatedAt = cycleFinishedAt
        if let error { recordError(error) }
    }

    private func select(version: String, displayVersion: String) {
        selectedVersion = version
        selectedDisplayVersion = displayVersion
    }

    private func touch() {
        updatedAt = Self.timestamp()
    }

    private func deliverConclusion() {
        guard let pendingConclusion else { return }
        self.pendingConclusion = nil
        pendingConclusion(snapshot())
    }

    private static func timestamp() -> String {
        ISO8601DateFormatter().string(from: Date())
    }
}
