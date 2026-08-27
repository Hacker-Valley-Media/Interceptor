import XCTest
import Sparkle
@testable import interceptor_bridge

final class SparkleUpdateStateTests: XCTestCase {
    private final class SnapshotBox: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [SparkleUpdateSnapshot] = []

        func append(_ value: SparkleUpdateSnapshot) {
            lock.lock()
            values.append(value)
            lock.unlock()
        }

        func snapshot() -> [SparkleUpdateSnapshot] {
            lock.lock()
            defer { lock.unlock() }
            return values
        }
    }

    func testInitialStateIsIdleAndOmitsUnknownFields() {
        let payload = SparkleUpdateState().snapshot().payload()

        XCTAssertEqual(payload["phase"] as? String, "idle")
        XCTAssertEqual(payload["outcome"] as? String, "none")
        XCTAssertEqual(payload["concluded"] as? Bool, true)
        XCTAssertNil(payload["selectedVersion"])
        XCTAssertNil(payload["latestFeedVersion"])
        XCTAssertNil(payload["lastError"])
    }

    func testBeginCheckTimesOutWithTruthfulCheckingSnapshot() {
        let state = SparkleUpdateState()
        let result = SnapshotBox()
        let done = expectation(description: "bounded check wait")

        state.beginCheck(timeout: 0.01) { snapshot in
            result.append(snapshot)
            done.fulfill()
        }

        wait(for: [done], timeout: 1)
        let snapshot = try! XCTUnwrap(result.snapshot().first)
        XCTAssertEqual(snapshot.phase, .checking)
        XCTAssertEqual(snapshot.outcome, .checking)
        XCTAssertFalse(snapshot.concluded)
        XCTAssertNotNil(snapshot.checkStartedAt)
    }

    func testSelectedVersionConcludesPendingCheckExactlyOnce() {
        let state = SparkleUpdateState()
        let result = SnapshotBox()

        state.beginCheck(timeout: 60) { result.append($0) }
        state.recordUpdateFound(version: "23", displayVersion: "0.23.33")
        state.recordError("later failure")

        let conclusions = result.snapshot()
        XCTAssertEqual(conclusions.count, 1)
        XCTAssertEqual(conclusions[0].outcome, .updateAvailable)
        XCTAssertEqual(conclusions[0].selectedVersion, "23")
        XCTAssertEqual(conclusions[0].selectedDisplayVersion, "0.23.33")
        XCTAssertEqual(state.snapshot().outcome, .error)
    }

    func testNoUpdateReportsLatestVersionAndEligibilityReason() {
        let state = SparkleUpdateState()
        let result = SnapshotBox()

        state.beginCheck(timeout: 60) { result.append($0) }
        state.recordNoUpdate(latestVersion: "0.23.32", reason: "system_too_old", currentIsLatest: false)

        let snapshot = try! XCTUnwrap(result.snapshot().first)
        XCTAssertEqual(snapshot.phase, .idle)
        XCTAssertEqual(snapshot.outcome, .noEligibleUpdate)
        XCTAssertEqual(snapshot.latestFeedVersion, "0.23.32")
        XCTAssertEqual(snapshot.noUpdateReason, "system_too_old")
    }

    func testLatestAndNewerReasonsMapToUpToDate() {
        for reason in ["on_latest_version", "on_newer_than_latest_version"] {
            let state = SparkleUpdateState()
            state.recordNoUpdate(latestVersion: "0.23.32", reason: reason, currentIsLatest: true)
            XCTAssertEqual(state.snapshot().outcome, .upToDate)
        }
    }

    func testInstallDismissAndSkipChoicesAreDistinct() {
        let install = SparkleUpdateState()
        install.recordUserChoice("install", stage: "not_downloaded")
        XCTAssertEqual(install.snapshot().outcome, .installChosen)
        XCTAssertEqual(install.snapshot().phase, .downloading)

        let dismiss = SparkleUpdateState()
        dismiss.recordUserChoice("dismiss", stage: "downloaded")
        XCTAssertEqual(dismiss.snapshot().outcome, .deferred)
        XCTAssertEqual(dismiss.snapshot().phase, .deferred)

        let skip = SparkleUpdateState()
        skip.recordUserChoice("skip", stage: "not_downloaded")
        XCTAssertEqual(skip.snapshot().outcome, .skipped)
        XCTAssertEqual(skip.snapshot().phase, .idle)
    }

    func testDownloadExtractionAndInstallPhasesRetainSelectedVersion() {
        let state = SparkleUpdateState()

        state.recordDownloading(version: "23", displayVersion: "0.23.33")
        XCTAssertEqual(state.snapshot().phase, .downloading)
        state.recordDownloaded(version: "23", displayVersion: "0.23.33")
        XCTAssertEqual(state.snapshot().phase, .downloaded)
        state.recordExtracting(version: "23", displayVersion: "0.23.33")
        XCTAssertEqual(state.snapshot().phase, .extracting)
        state.recordReadyToInstall(version: "23", displayVersion: "0.23.33")
        XCTAssertEqual(state.snapshot().phase, .readyToInstall)
        state.recordInstalling(version: "23", displayVersion: "0.23.33")
        XCTAssertEqual(state.snapshot().phase, .installing)
        XCTAssertEqual(state.snapshot().outcome, .installing)
        XCTAssertEqual(state.snapshot().selectedDisplayVersion, "0.23.33")
    }

    func testErrorConcludesPendingCheckWithRealMessage() {
        let state = SparkleUpdateState()
        let result = SnapshotBox()

        state.beginCheck(timeout: 60) { result.append($0) }
        state.recordError("feed signature rejected")

        let snapshot = try! XCTUnwrap(result.snapshot().first)
        XCTAssertEqual(snapshot.phase, .error)
        XCTAssertEqual(snapshot.outcome, .error)
        XCTAssertEqual(snapshot.lastError, "feed signature rejected")
    }

    func testDelegateValueMappingsMatchPinnedSparkleContract() {
        XCTAssertEqual(SparkleUpdaterDelegate.noUpdateReason(0), "unknown")
        XCTAssertEqual(SparkleUpdaterDelegate.noUpdateReason(1), "on_latest_version")
        XCTAssertEqual(SparkleUpdaterDelegate.noUpdateReason(2), "on_newer_than_latest_version")
        XCTAssertEqual(SparkleUpdaterDelegate.noUpdateReason(3), "system_too_old")
        XCTAssertEqual(SparkleUpdaterDelegate.noUpdateReason(4), "system_too_new")
        XCTAssertEqual(SparkleUpdaterDelegate.noUpdateReason(5), "hardware_does_not_support_arm64")
        XCTAssertEqual(SparkleUpdaterDelegate.choiceName(.install), "install")
        XCTAssertEqual(SparkleUpdaterDelegate.choiceName(.dismiss), "dismiss")
        XCTAssertEqual(SparkleUpdaterDelegate.choiceName(.skip), "skip")
        XCTAssertEqual(SparkleUpdaterDelegate.stageName(.notDownloaded), "not_downloaded")
        XCTAssertEqual(SparkleUpdaterDelegate.stageName(.downloaded), "downloaded")
        XCTAssertEqual(SparkleUpdaterDelegate.stageName(.installing), "installing")
    }
}
