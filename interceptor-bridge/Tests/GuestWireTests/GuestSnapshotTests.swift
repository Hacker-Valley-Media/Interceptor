import XCTest
import Foundation
import CryptoKit
import GuestWire

final class GuestSnapshotTests: XCTestCase {
    private func result(_ payload: [String: Any]) -> [String: Any] { ["success": true, "data": payload] }
    func testRetainedChunksReassembleBytesBeyondTheCopyLimitWithoutChangingIdentity() throws {
        // A wire byte fixture, not a captured or decoded image.
        let bytes = Data((0..<1_100_003).map { UInt8($0 % 251) }), id = UUID().uuidString
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let receipt = try GuestWire.SnapshotReceipt(result(["snapshotId": id, "width": 1024, "height": 768, "bytes": bytes.count, "sha256": hash, "format": "png"]))
        var observed = Data()
        while observed.count < bytes.count {
            let offset = observed.count, length = min(GuestWire.snapshotChunkBytes, bytes.count - offset)
            let payload: [String: Any] = ["snapshotId": id, "offset": offset, "bytes": length, "dataBase64": bytes.subdata(in: offset..<(offset + length)).base64EncodedString()]
            observed.append(try receipt.chunk(result(payload), offset: offset, length: length))
            for change in [["snapshotId": UUID().uuidString], ["offset": offset + 1], ["bytes": length - 1], ["dataBase64": "AA=="], ["extra": true]] as [[String: Any]] {
                XCTAssertThrowsError(try receipt.chunk(result(payload.merging(change) { _, new in new }), offset: offset, length: length))
            }
        }
        XCTAssertEqual(observed, bytes)
        try receipt.verify(observed)
        observed[0] ^= 1
        XCTAssertThrowsError(try receipt.verify(observed))
        try receipt.released(result(["snapshotId": id, "released": true]))
        XCTAssertThrowsError(try receipt.released(result(["snapshotId": id, "released": 1])))
        XCTAssertThrowsError(try receipt.released(result(["snapshotId": UUID().uuidString, "released": true])))
    }
    func testLegacyScreenshotGateAndForgedMetadataAreRefusedBeforeTransfer() throws {
        XCTAssertThrowsError(try GuestWire.requireSnapshot(result(["pong": true])))
        try GuestWire.requireSnapshot(result(["protocolVersion": 2, "features": [GuestWire.snapshotFeature]]))
        let payload: [String: Any] = ["snapshotId": UUID().uuidString, "width": 1920, "height": 1080, "bytes": 100, "sha256": String(repeating: "a", count: 64), "format": "png"]
        for change in [["width": true], ["height": 0], ["bytes": 67_108_865], ["bytes": 0.5], ["snapshotId": "guess"], ["sha256": "bad"], ["format": "jpeg"], ["path": "/guest/overwrite"]] as [[String: Any]] {
            XCTAssertThrowsError(try GuestWire.SnapshotReceipt(result(payload.merging(change) { _, new in new })))
        }
    }
    func testPrivateRequestBudgetPreservesItsFractionalRemainder() throws {
        XCTAssertEqual(try GuestWire.requestBudget(["timeout": 0.125], defaultSeconds: 50), 0.125)
        XCTAssertEqual(try GuestWire.requestBudget([:], defaultSeconds: 5), 5)
        for value in [0, -1, 51, Double.infinity, true, "5"] as [Any] {
            XCTAssertThrowsError(try GuestWire.requestBudget(["timeout": value], defaultSeconds: 5))
        }
    }
}
