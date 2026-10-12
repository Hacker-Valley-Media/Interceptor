import XCTest
import Foundation
import GuestWire
@testable import interceptor_bridge

private actor LegacyCopyAgent: GuestAgent {
    private var received: [String] = []
    func connect(timeout: TimeInterval) async throws {}
    func disconnect() async {}
    func verbs() -> [String] { received }
    func request(_ action: GuestAgentDict, timeout: TimeInterval) async throws -> GuestAgentDict {
        let verb = action.dict["verb"] as? String ?? ""
        received.append(verb)
        if verb == "ping" { return GuestAgentDict(["success": true, "data": ["pong": true]]) }
        // This is the old native overwrite behavior. The capability gate
        // must prevent reaching it even when the caller uses the helper.
        if verb == "cp_in", let path = action.dict["path"] as? String,
           let text = action.dict["dataBase64"] as? String, let data = Data(base64Encoded: text) {
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
        return GuestAgentDict(["success": true, "data": [:]])
    }
}

final class GuestCopyProtocolTests: XCTestCase {
    func testLegacyAgentCannotOverwriteDestinationThroughTheExistingCopyHelper() async throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("interceptor-legacy-copy-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("existing").path, original = Data("preserve".utf8)
        try original.write(to: URL(fileURLWithPath: path))
        let agent = LegacyCopyAgent()
        do {
            _ = try await agent.copyIn(path: path, data: Data("replacement".utf8), timeout: 5)
            XCTFail("legacy protocol was accepted")
        } catch {}
        let verbs = await agent.verbs()
        XCTAssertEqual(verbs, ["ping"])
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), original)
    }

    func testMalformedCopyProofCannotCreateAUsableByteReceipt() throws {
        let bytes = Data("x".utf8)
        let hash = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
        let payload: [String: Any] = ["path": "/guest/file", "bytes": 1, "dataBase64": bytes.base64EncodedString(), "sha256": hash, "verified": true]
        XCTAssertEqual(try GuestWire.copyBytes(["success": true, "data": payload], path: "/guest/file"), bytes)
        for change in [["path": "/guest/other"], ["bytes": true], ["bytes": 0], ["verified": 1], ["sha256": String(repeating: "0", count: 64)], ["dataBase64": "eA==\n"], ["extra": true]] as [[String: Any]] {
            XCTAssertThrowsError(try GuestWire.copyBytes(["success": true, "data": payload.merging(change) { _, replacement in replacement }], path: "/guest/file"))
        }
        let copied: [String: Any] = ["path": "/guest/file", "bytes": 1, "sha256": hash, "verified": true, "overwrite": false]
        XCTAssertNoThrow(try GuestWire.verifyCopied(["success": true, "data": copied], path: "/guest/file", data: bytes))
        for change in [["overwrite": true], ["overwrite": 0], ["verified": false], ["bytes": true], ["path": "/guest/other"]] as [[String: Any]] {
            XCTAssertThrowsError(try GuestWire.verifyCopied(["success": true, "data": copied.merging(change) { _, replacement in replacement }], path: "/guest/file", data: bytes))
        }
    }
}
