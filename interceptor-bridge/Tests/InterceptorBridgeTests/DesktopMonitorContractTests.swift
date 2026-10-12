import XCTest
@testable import interceptor_bridge

final class DesktopMonitorContractTests: XCTestCase {
    func testArchiveTimeOrderAndUTF16NameBoundsApplyBeforeTailAndExports() throws {
        let fm = FileManager.default, sid = "fixtureheader" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let directory = Platform.sessionDir(sid), domain = MonitorDomain()
        try fm.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer { try? fm.removeItem(atPath: directory) }
        let meta = MonitorSession(id: sid, instruction: nil, startTime: Date(), scope: .frontmost(), includes: [], excludes: [], tcc: .init(accessibility: false)).toMetaDict()
        try JSONSerialization.data(withJSONObject: meta).write(to: URL(fileURLWithPath: Platform.sessionMetaPath(sid)))
        let cases: [(String, [Double], Bool)] = [
            ("owned_header", [2, 1], false), ("owned_header", [0, 0], true),
            (String(repeating: "界", count: 128), [0, 1], true),
            (String(repeating: "🧭", count: 64), [0, 1], true),
            (String(repeating: "界", count: 129), [0, 1], false),
            (String(repeating: "🧭", count: 64) + "a", [0, 1], false),
            ("owned_header", [0, 9007199254740991], true)
        ]
        for (event, times, valid) in cases {
            var bytes = Data()
            for (index, time) in times.enumerated() {
                bytes.append(try JSONSerialization.data(withJSONObject: ["sid": sid, "s": index, "t": time, "event": event]))
                bytes.append(10)
            }
            try bytes.write(to: URL(fileURLWithPath: Platform.sessionEventsPath(sid)))
            let actions: [[String: Any]] = [["sub": "tail", "limit": 2], ["sub": "tail", "limit": 0], ["sub": "export", "format": "json"], ["sub": "export", "format": "timeline"], ["sub": "export", "format": "plan"]]
            for fields in actions {
                var action: [String: Any] = ["type": "macos_monitor", "sid": sid]
                action.merge(fields) { _, new in new }
                let description = "UTF16 \(event.utf16.count), times \(times), route \(fields)"
                let completed = expectation(description: description)
                domain.handle("monitor", action: action) { result in
                    XCTAssertEqual(result["success"] as? Bool, valid, description)
                    if !valid { XCTAssertEqual(result["code"] as? String, "permission_denied") }
                    completed.fulfill()
                }
                wait(for: [completed], timeout: 1)
            }
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: Platform.sessionEventsPath(sid))), bytes)
        }
    }
    func testArchiveTraversalAndLimitsRefuseBeforeReads() {
        let domain = MonitorDomain()
        for sub in ["tail", "export"] {
            for fields: [String: Any] in [["sid": "../owned"], ["sid": "owned/child"], ["sid": "."], ["sid": "x\n"], ["limit": -1], ["limit": 1001], ["limit": 1.5], ["limit": true], ["limit": NSNull()]] {
                var action: [String: Any] = ["type": "macos_monitor", "sub": sub]
                action.merge(fields) { _, new in new }
                let description = String(describing: action)
                domain.handle("monitor", action: action) { result in
                    XCTAssertEqual(result["success"] as? Bool, false)
                    XCTAssertEqual(result["code"] as? String, "invalid_request", description)
                }
            }
        }
    }
    func testNeutralShapeAndScopeValidation() {
        let malformed: [[String: Any]] = [["sid": NSNull()], ["sid": 17], ["sid": "../owned"], ["frames": 61], ["video": 0], ["frameQuality": 101], ["framePixelScale": 0], ["app": "a", "apps": ["b"]], ["app": "a", "allApps": true], ["apps": []], ["apps": ["a", "a"]], ["include": [true]], ["instruction": "\0"], ["speechMode": "invented"], ["unexpected": true]]
        for fields in malformed {
            var action: [String: Any] = ["type": "desktop_monitor", "sub": "start"]
            action.merge(fields) { _, new in new }
            XCTAssertEqual(DesktopMonitorValidation.validate(action)?["code"] as? String, "invalid_request", "\(action)")
        }
        XCTAssertNil(DesktopMonitorValidation.validate(["type": "desktop_monitor", "sub": "start", "apps": ["Owned fixture"], "include": ["files"], "watchPaths": ["/tmp/owned"], "speechMode": "off", "frameBudget": 0]))
        XCTAssertNil(DesktopMonitorValidation.validate(["type": "desktop_monitor", "sub": "tail", "sid": "aaa11111", "limit": 0]))
        XCTAssertEqual(DesktopMonitorValidation.bounded(WireFormat.success(String(repeating: "x", count: DESKTOP_MONITOR_MAX_RESULT_BYTES)))["code"] as? String, "resource_limit")
    }
    func testArchiveReadsRetainParentsRefuseLinksAndHonorLimits() throws {
        let fm = FileManager.default, sid = "fixtureunit" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let directory = Platform.sessionDir(sid), linkedSid = sid + "link"
        try fm.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer { try? fm.removeItem(atPath: directory); try? fm.removeItem(atPath: Platform.sessionDir(linkedSid)) }
        let path = Platform.sessionEventsPath(sid)
        var bytes = try JSONSerialization.data(withJSONObject: ["sid": sid, "s": 0, "t": 1, "event": "mon_start", "surface": "macos", "scope": ["mode": "frontmost"], "includes": [], "speechMode": "off", "tap": false])
        bytes.append(10)
        try bytes.write(to: URL(fileURLWithPath: path))
        XCTAssertEqual(try DesktopMonitorValidation.readArchive(sid: sid, file: "events.jsonl", maxBytes: bytes.count), bytes)
        XCTAssertThrowsError(try DesktopMonitorValidation.readArchive(sid: sid, file: "events.jsonl", maxBytes: bytes.count - 1))
        try fm.createSymbolicLink(atPath: Platform.sessionDir(linkedSid), withDestinationPath: directory)
        XCTAssertThrowsError(try DesktopMonitorValidation.readArchive(sid: linkedSid, file: "events.jsonl", maxBytes: 4096))
        let copy = directory + "/hard-copy"
        try fm.linkItem(atPath: path, toPath: copy)
        XCTAssertThrowsError(try DesktopMonitorValidation.readArchive(sid: sid, file: "events.jsonl", maxBytes: 4096))
        try fm.removeItem(atPath: copy)
        let domain = MonitorDomain()
        let meta = MonitorSession(id: sid, instruction: nil, startTime: Date(), scope: .frontmost(), includes: [], excludes: [], tcc: .init(accessibility: false)).toMetaDict()
        try JSONSerialization.data(withJSONObject: meta).write(to: URL(fileURLWithPath: Platform.sessionMetaPath(sid)))
        for limit in [0, 1] {
            domain.handle("monitor", action: ["type": "macos_monitor", "sub": "tail", "sid": sid, "limit": limit]) { result in
                XCTAssertEqual((result["data"] as? [[String: Any]])?.count, limit)
            }
        }
        try fm.removeItem(atPath: Platform.sessionMetaPath(sid))
        try fm.createSymbolicLink(atPath: directory + "/session.json", withDestinationPath: path)
        XCTAssertThrowsError(try DesktopMonitorValidation.readArchive(sid: sid, file: "session.json", maxBytes: 4096))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), bytes)
    }
}
