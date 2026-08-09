import XCTest
import Foundation
@testable import interceptor_bridge

// Platform.appendMonitorEvent + writeSessionMeta tests. These pin
// the persistence contract (per-session events.jsonl in the configured
// monitor-sessions dir, plus a JSON session.json sibling) without requiring
// any TCC consents.

final class MonitorPersistenceTests: XCTestCase {
    private var tmpDir: String = ""
    private var savedEnv: String?

    override func setUp() {
        super.setUp()
        // Redirect monitor-sessions dir to a per-test temp folder so test
        // runs don't collide and so we don't pollute /tmp.
        tmpDir = NSTemporaryDirectory() + "interceptor-monitor-tests-\(UUID().uuidString.prefix(6))"
        savedEnv = ProcessInfo.processInfo.environment["INTERCEPTOR_MONITOR_SESSIONS_DIR"]
        setenv("INTERCEPTOR_MONITOR_SESSIONS_DIR", tmpDir, 1)
    }

    override func tearDown() {
        if let s = savedEnv {
            setenv("INTERCEPTOR_MONITOR_SESSIONS_DIR", s, 1)
        } else {
            unsetenv("INTERCEPTOR_MONITOR_SESSIONS_DIR")
        }
        try? FileManager.default.removeItem(atPath: tmpDir)
        super.tearDown()
    }

    func testAppendMonitorEventWritesSessionLocalNDJSON() {
        let sid = "test\(UUID().uuidString.prefix(4))".lowercased()
        Platform.appendMonitorEvent(sid: sid, event: "click", data: ["x": 100, "y": 200])
        // appendMonitorEvent hands the write to MonitorEventWriter's serial
        // queue; flush() is a sync barrier that drains it before we assert.
        MonitorEventWriter.shared.flush()
        let path = Platform.sessionEventsPath(sid)
        XCTAssertTrue(FileManager.default.fileExists(atPath: path), "session events.jsonl must exist after append")

        let content = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        XCTAssertTrue(content.contains("\"event\":\"click\""))
        XCTAssertTrue(content.contains("\"sid\":\"\(sid)\""))
        XCTAssertTrue(content.contains("\"x\":100"))
    }

    func testAppendMonitorEventAlsoWritesToBridgeRollingLog() {
        let sid = "test\(UUID().uuidString.prefix(4))".lowercased()
        Platform.appendMonitorEvent(sid: sid, event: "frontmost", data: ["app": "TestApp"])
        MonitorEventWriter.shared.flush()
        XCTAssertTrue(FileManager.default.fileExists(atPath: Platform.bridgeEventsPath))
        let bridgeContent = (try? String(contentsOfFile: Platform.bridgeEventsPath, encoding: .utf8)) ?? ""
        XCTAssertTrue(bridgeContent.contains("\"sid\":\"\(sid)\""))
    }

    func testWriteSessionMetaProducesValidJson() {
        let sid = "meta\(UUID().uuidString.prefix(4))".lowercased()
        let meta: [String: Any] = [
            "artifactVersion": 1,
            "surface": "macos",
            "sessionId": sid,
            "startedAt": 1715000000000,
            "status": "active",
            "paused": false,
            "attachments": []
        ]
        Platform.writeSessionMeta(sid: sid, meta: meta)
        let path = Platform.sessionMetaPath(sid)
        let data = try! Data(contentsOf: URL(fileURLWithPath: path))
        let parsed = try? JSONSerialization.jsonObject(with: data)
        XCTAssertNotNil(parsed)
        let dict = parsed as? [String: Any]
        XCTAssertEqual(dict?["sessionId"] as? String, sid)
        XCTAssertEqual(dict?["surface"] as? String, "macos")
    }

    func testEnsureSessionDirCreatesNestedPath() {
        let sid = "dir\(UUID().uuidString.prefix(4))".lowercased()
        Platform.ensureSessionDir(sid)
        XCTAssertTrue(FileManager.default.fileExists(atPath: Platform.sessionDir(sid)))
    }

    func testMonitorSessionsDirRespectsEnvOverride() {
        XCTAssertEqual(Platform.monitorSessionsDir, tmpDir)
    }
}
