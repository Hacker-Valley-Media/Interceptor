import XCTest
import Foundation
@testable import interceptor_bridge

private struct ReplyAgent: GuestAgent {
    let reply: GuestAgentDict
    func connect(timeout: TimeInterval) async throws {}
    func request(_ action: GuestAgentDict, timeout: TimeInterval) async throws -> GuestAgentDict { reply }
    func disconnect() async {}
}

final class VMGuestReplyTests: XCTestCase {
    // Protocol fixtures qualify reply validation only. They do not establish
    // a running guest, guest authority, file transfer or installed behavior.
    func testMissingExecutionFieldsCannotBecomeSuccessfulDefaults() async throws {
        let samples: [[String: Any]] = [[:], ["exitCode": 0], ["exitCode": 0, "stdout": "", "stderr": ""]]
        for payload in samples {
            let agent = ReplyAgent(reply: GuestAgentDict(["success": true, "data": payload]))
            do { _ = try await agent.exec(["/bin/true"]); XCTFail("Missing native execution fields were accepted") }
            catch { XCTAssertTrue(String(describing: error).contains("exec")) }
        }
    }
    func testExecutionUsesActualExitAndTextAndRefusesImpossibleReplies() async throws {
        let payload: [String: Any] = ["exitCode": 7, "stdout": "observed stdout", "stderr": "observed stderr", "durationMs": 12]
        let agent = ReplyAgent(reply: GuestAgentDict(["success": true, "data": payload]))
        let result = try await agent.exec(["/owned/fixture"])
        XCTAssertEqual(result.exitCode, 7); XCTAssertEqual(result.stdout, "observed stdout"); XCTAssertEqual(result.stderr, "observed stderr"); XCTAssertEqual(result.durationMs, 12)
        let changes: [[String: Any]] = [["exitCode": true], ["exitCode": 0.25], ["durationMs": -1], ["durationMs": 58_001], ["stdout": String(repeating: "a", count: 131_073)]]
        for change in changes {
            var invalid = payload; for (key, value) in change { invalid[key] = value }
            let invalidAgent = ReplyAgent(reply: GuestAgentDict(["success": true, "data": invalid]))
            do { _ = try await invalidAgent.exec(["/owned/fixture"]); XCTFail("Impossible native result was accepted") } catch {}
        }
    }
    func testVMEmptyOutputRequiresAnExplicitOverrideAndExistingDestinationIsPreserved() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("itc-vm-empty-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let path = root.appendingPathComponent("empty.bin").path
        let output = try PhotosDomain.Output(path)
        XCTAssertEqual(try output.finish(allowEmpty: true), 0)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), Data())
        XCTAssertThrowsError(try PhotosDomain.Output(path))
        let strict = try PhotosDomain.Output(root.appendingPathComponent("strict-empty.bin").path)
        XCTAssertThrowsError(try strict.finish())
        XCTAssertEqual(try PhotosDomain().readFile(path, maxBytes: 1_048_576, allowEmpty: true), Data())
        XCTAssertThrowsError(try PhotosDomain().readFile(path))
    }
}
