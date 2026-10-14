import Foundation
import CoreFoundation
import CryptoKit

extension GuestWire {
    public static let snapshotFeature = "retained-png-chunks-v1"
    public static let snapshotMaxBytes = 67_108_864
    public static let snapshotChunkBytes = 524_288
    public static func snapshotInteger(_ value: Any?, maximum: Int) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue.rounded(.towardZero) == number.doubleValue, number.doubleValue >= 0, number.doubleValue <= Double(maximum) else { return nil }
        return number.intValue
    }
    public static func requireSnapshot(_ reply: [String: Any]) throws {
        guard let success = reply["success"] as? NSNumber, CFGetTypeID(success) == CFBooleanGetTypeID(), success.boolValue,
              let data = reply["data"] as? [String: Any], snapshotInteger(data["protocolVersion"], maximum: protocolVersion) == protocolVersion,
              let features = data["features"] as? [String], features.count <= 32, features.contains(snapshotFeature) else {
            throw Failure.framing("screenshot requires retained PNG chunks; no guest output path was written")
        }
    }
    public struct SnapshotReceipt: Sendable {
        public let id: String, sha256: String
        public let width: Int, height: Int, bytes: Int
        public init(_ reply: [String: Any]) throws {
            let payload = try GuestWire.snapshotPayload(reply)
            guard Set(payload.keys) == Set(["snapshotId", "width", "height", "bytes", "sha256", "format"]),
                  let id = payload["snapshotId"] as? String, UUID(uuidString: id) != nil, payload["format"] as? String == "png",
                  let width = GuestWire.snapshotInteger(payload["width"], maximum: 16384), width > 0,
                  let height = GuestWire.snapshotInteger(payload["height"], maximum: 16384), height > 0, width <= 33_554_432 / height,
                  let bytes = GuestWire.snapshotInteger(payload["bytes"], maximum: GuestWire.snapshotMaxBytes), bytes > 0,
                  let digest = payload["sha256"] as? String, digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw Failure.framing("screenshot omitted exact bounded PNG identity, dimensions or digest") }
            self.id = id; sha256 = digest; self.width = width; self.height = height; self.bytes = bytes
        }
        public func chunk(_ reply: [String: Any], offset: Int, length: Int) throws -> Data {
            let payload = try GuestWire.snapshotPayload(reply)
            guard offset >= 0, length > 0, length <= GuestWire.snapshotChunkBytes, offset <= bytes - length,
                  Set(payload.keys) == Set(["snapshotId", "offset", "bytes", "dataBase64"]), payload["snapshotId"] as? String == id,
                  GuestWire.snapshotInteger(payload["offset"], maximum: bytes) == offset, GuestWire.snapshotInteger(payload["bytes"], maximum: bytes) == length,
                  let text = payload["dataBase64"] as? String, text.utf8.count <= 699_052,
                  let data = Data(base64Encoded: text), data.count == length, data.base64EncodedString() == text else { throw Failure.framing("screenshot chunk identity, range or bytes differ") }
            return data
        }
        public func verify(_ data: Data) throws {
            guard data.count == bytes, SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == sha256 else { throw Failure.framing("screenshot final count or digest differs") }
        }
        public func released(_ reply: [String: Any]) throws {
            let payload = try GuestWire.snapshotPayload(reply)
            guard Set(payload.keys) == Set(["snapshotId", "released"]), payload["snapshotId"] as? String == id,
                  let value = payload["released"] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID(), value.boolValue else { throw Failure.framing("screenshot release was not acknowledged for its retained identity") }
        }
    }
    private static func snapshotPayload(_ reply: [String: Any]) throws -> [String: Any] {
        guard let success = reply["success"] as? NSNumber, CFGetTypeID(success) == CFBooleanGetTypeID(), success.boolValue,
              let payload = reply["data"] as? [String: Any] else { throw Failure.framing("screenshot request failed or omitted its payload") }
        return payload
    }
}
