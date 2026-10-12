import XCTest
@testable import interceptor_bridge

final class DesktopMonitorPayloadTests: XCTestCase {
    func testMacArchiveMetadataIsValidatedBeforeTailHistoryAndEveryExport() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("shared/desktop-monitor-macos-payload-fixtures.json"))) as! [String: [[String: Any]]]
        let fm = FileManager.default, sid = "zzfixturemeta" + UUID().uuidString.replacingOccurrences(of: "-", with: ""), domain = MonitorDomain()
        let directory = Platform.sessionDir(sid), metaPath = Platform.sessionMetaPath(sid), eventPath = Platform.sessionEventsPath(sid)
        try fm.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer { try? fm.removeItem(atPath: directory) }
        var events = try JSONSerialization.data(withJSONObject: ["sid": sid, "s": 0, "t": 0, "event": "owned_extension"]); events.append(10)
        try events.write(to: URL(fileURLWithPath: eventPath))
        for (key, valid) in [("metadataValid", true), ("metadataInvalid", false)] {
            for (index, fixture) in fixtures[key]!.enumerated() {
                var meta = fixture; meta["sessionId"] = sid
                if valid {
                    var withBadAlias = meta; withBadAlias["sid"] = true
                    XCTAssertNotNil(DesktopMonitorValidation.archiveMetadataError(withBadAlias, sid: sid))
                }
                let bytes = try JSONSerialization.data(withJSONObject: meta)
                try bytes.write(to: URL(fileURLWithPath: metaPath))
                for fields: [String: Any] in [["sub": "tail", "limit": 1], ["sub": "tail", "limit": 0], ["sub": "list", "limit": 1], ["sub": "export", "format": "json"], ["sub": "export", "format": "timeline"], ["sub": "export", "format": "plan"]] {
                    var action: [String: Any] = ["type": "macos_monitor"]
                    if fields["sub"] as? String != "list" { action["sid"] = sid }
                    action.merge(fields) { _, new in new }
                    let description = key + String(index) + String(describing: fields), completed = expectation(description: description)
                    domain.handle("monitor", action: action) { result in
                        XCTAssertEqual(result["success"] as? Bool, valid, description)
                        if !valid { XCTAssertEqual(result["code"] as? String, "permission_denied", description) }
                        completed.fulfill()
                    }
                    wait(for: [completed], timeout: 1)
                }
                XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: metaPath)), bytes)
                XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: eventPath)), events)
            }
        }
    }
    func testMacPayloadsAreValidatedBeforeTailSelectionAndEveryExport() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("shared/desktop-monitor-macos-payload-fixtures.json"))) as! [String: [[String: Any]]]
        let fm = FileManager.default, sid = "fixturepayload" + UUID().uuidString.replacingOccurrences(of: "-", with: ""), domain = MonitorDomain()
        let directory = Platform.sessionDir(sid), path = Platform.sessionEventsPath(sid)
        try fm.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer { try? fm.removeItem(atPath: directory) }
        let meta = MonitorSession(id: sid, instruction: nil, startTime: Date(), scope: .frontmost(), includes: [], excludes: [], tcc: .init(accessibility: false)).toMetaDict()
        try JSONSerialization.data(withJSONObject: meta).write(to: URL(fileURLWithPath: Platform.sessionMetaPath(sid)))
        let actions: [[String: Any]] = [["sub": "tail", "limit": 100], ["sub": "tail", "limit": 0], ["sub": "export", "format": "json"], ["sub": "export", "format": "timeline"], ["sub": "export", "format": "plan"]]
        let cases = [("all-valid", fixtures["valid"]!, true)] + fixtures["invalid"]!.enumerated().map { ("invalid-\($0.offset)-\($0.element["event"]!)", [$0.element, ["event": "owned_extension"]], false) }
        for (name, payloads, valid) in cases {
            var bytes = Data()
            for (index, payload) in payloads.enumerated() {
                var row = payload
                row.merge(["sid": sid, "s": index, "t": index]) { _, new in new }
                bytes.append(try JSONSerialization.data(withJSONObject: row)); bytes.append(10)
            }
            try bytes.write(to: URL(fileURLWithPath: path))
            for fields in actions {
                var action: [String: Any] = ["type": "macos_monitor", "sid": sid]
                action.merge(fields) { _, new in new }
                let description = name + String(describing: fields)
                let completed = expectation(description: description)
                domain.handle("monitor", action: action) { result in
                    XCTAssertEqual(result["success"] as? Bool, valid, description)
                    if !valid { XCTAssertEqual(result["code"] as? String, "permission_denied") }
                    completed.fulfill()
                }
                wait(for: [completed], timeout: 1)
            }
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), bytes)
        }
    }
    func testGeneratedEmptyPayloadRequiresAnEmptyObject() throws {
        let decoder = JSONDecoder()
        let value = try decoder.decode(DesktopMonitorNativeEmptyPayload.self, from: Data("{}".utf8))
        XCTAssertEqual(String(data: try JSONEncoder().encode(value), encoding: .utf8), "{}")
        for text in ["null", "[]", "true", "17", "\"owned\"", "{\"unexpected\":true}", "{\"unexpected\":null}"] {
            XCTAssertThrowsError(try decoder.decode(DesktopMonitorNativeEmptyPayload.self, from: Data(text.utf8)), text)
        }
    }
}
