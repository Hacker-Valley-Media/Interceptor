import XCTest
import Foundation
@testable import InterceptorD

final class GuestExecutionTests: XCTestCase {
    private static let lane = NSLock()
    override func setUp() { Self.lane.lock() }
    override func tearDown() { Self.lane.unlock() }
    private func execute(_ argv: [String], timeout: Double = 5) -> [String: Any] {
        GuestExecution.execute(["verb": "exec", "argv": argv, "timeout": timeout, "tty": false])
    }
    func testActualNonzeroExitAndBothOutputStreamsHaveOnlyCompleteContractFields() {
        let result = execute(["/bin/sh", "-c", "printf output; printf error >&2; exit 7"])
        XCTAssertEqual(result["success"] as? Bool, true)
        let data = result["data"] as? [String: Any]
        XCTAssertEqual(data?["exitCode"] as? Int32, 7)
        XCTAssertEqual(data?["stdout"] as? String, "output")
        XCTAssertEqual(data?["stderr"] as? String, "error")
        XCTAssertEqual(Set(data?.keys.map { $0 } ?? []), Set(["exitCode", "stdout", "stderr", "durationMs"]))
    }
    func testOutputLargerThanPipeCapacityDrainsBothStreamsBeforeNativeExit() {
        let result = execute(["/bin/sh", "-c", "/usr/bin/yes x | /usr/bin/head -c 49152; /usr/bin/yes y | /usr/bin/head -c 49152 >&2"])
        XCTAssertEqual(result["success"] as? Bool, true)
        let data = result["data"] as? [String: Any]
        XCTAssertEqual((data?["stdout"] as? String)?.utf8.count, 49_152)
        XCTAssertEqual((data?["stderr"] as? String)?.utf8.count, 49_152)
        XCTAssertEqual(data?["exitCode"] as? Int32, 0)
    }
    func testInvalidUTF8CannotBecomeInventedEmptySuccessfulOutput() {
        let result = execute(["/bin/sh", "-c", "printf '\\377'"])
        XCTAssertEqual(result["success"] as? Bool, false)
        XCTAssertEqual(result["code"] as? String, "partial_result")
        XCTAssertNil(result["data"])
    }
    func testTimeoutIsAnUnknownOutcomeAndACompleteFreshExecutionFollowsCleanup() {
        let result = execute(["/bin/sleep", "2"], timeout: 0.05)
        XCTAssertEqual(result["success"] as? Bool, false)
        XCTAssertEqual(result["code"] as? String, "timeout_unknown_outcome")
        XCTAssertNil(result["data"])
        let deadline = Date().addingTimeInterval(3)
        var next: [String: Any]
        repeat {
            next = execute(["/usr/bin/true"])
            if next["success"] as? Bool == true { break }
            XCTAssertEqual(next["code"] as? String, "invalid_target")
            Thread.sleep(forTimeInterval: 0.01)
        } while Date() < deadline
        XCTAssertEqual(next["success"] as? Bool, true)
    }
    func testInvalidSelectorsAreRefusedBeforeNativeExecution() {
        let base: [String: Any] = ["argv": ["/usr/bin/true"], "timeout": 1]
        for change in [["argv": ["relative"]], ["argv": []], ["timeout": true], ["timeout": 51], ["timeout": 0], ["tty": 0], ["tty": true], ["user": "other"], ["workdir": "relative"], ["env": ["bad-key": "x"]]] as [[String: Any]] {
            let result = GuestExecution.execute(base.merging(change) { _, replacement in replacement })
            XCTAssertEqual(result["success"] as? Bool, false)
            XCTAssertEqual(result["code"] as? String, "invalid_request")
        }
    }
}
