import Foundation
import Darwin
import CoreFoundation
import CryptoKit

/// The host and in-guest agent use the same bounded socket framing.
public enum GuestWire {
    public static let maxFrameBytes = 2_097_152
    public static let protocolVersion = 2
    public static let exclusiveCopyFeature = "retained-exclusive-copy-v1"

    public enum Failure: Error, CustomStringConvertible, Sendable {
        case framing(String), io(String), timeout
        public var description: String {
            switch self {
            case .framing(let message): return "guest framing: \(message)"
            case .io(let message): return "guest socket: \(message)"
            case .timeout: return "guest exchange deadline expired"
            }
        }
    }

    public struct Deadline: Sendable {
        private let instant: ContinuousClock.Instant
        public init(seconds: TimeInterval) throws {
            guard seconds.isFinite, seconds > 0, seconds <= 58 else {
                throw Failure.framing("budget must be positive and at most 58s")
            }
            instant = ContinuousClock.now.advanced(by: .seconds(seconds))
        }
        public func remaining() throws -> TimeInterval {
            let parts = ContinuousClock.now.duration(to: instant).components
            let seconds = Double(parts.seconds) + Double(parts.attoseconds) / 1e18
            guard seconds > 0 else { throw Failure.timeout }
            return seconds
        }
    }

    private static func wait(fd: Int32, event: Int16, deadline: Deadline) throws {
        while true {
            let milliseconds = Int32(min(58_000, ceil(try deadline.remaining() * 1000)))
            var descriptor = pollfd(fd: fd, events: event, revents: 0)
            let result = Darwin.poll(&descriptor, 1, milliseconds)
            if result < 0, errno == EINTR { continue }
            guard result != 0 else { throw Failure.timeout }
            guard result > 0 else { throw Failure.io("poll failed: \(errno)") }
            // Read buffered bytes even when the peer has also closed.
            if descriptor.revents & event != 0 { return }
            throw Failure.io("peer closed or socket became invalid")
        }
    }

    public static func encode(_ object: [String: Any]) throws -> Data {
        let data = try JSONSerialization.data(withJSONObject: object)
        guard !data.isEmpty, data.count <= maxFrameBytes else {
            throw Failure.framing("JSON exceeds 2MiB")
        }
        var length = UInt32(data.count).littleEndian
        return Data(bytes: &length, count: 4) + data
    }

    public static func write(fd: Int32, frame: Data, deadline: Deadline) throws {
        guard frame.count >= 5, frame.count <= maxFrameBytes + 4,
              frame.withUnsafeBytes({ Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }) == frame.count - 4 else {
            throw Failure.framing("invalid encoded frame")
        }
        try nonblocking(fd: fd)
        try frame.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { throw Failure.framing("empty frame") }
            var offset = 0
            while offset < frame.count {
                _ = try deadline.remaining()
                let count = Darwin.send(fd, base.advanced(by: offset), min(65_536, frame.count - offset), MSG_DONTWAIT | MSG_NOSIGNAL)
                if count > 0 { offset += count; continue }
                if count < 0, errno == EINTR { continue }
                if count < 0, errno == EAGAIN || errno == EWOULDBLOCK {
                    try wait(fd: fd, event: Int16(POLLOUT), deadline: deadline); continue
                }
                throw Failure.io("send failed: \(errno)")
            }
        }
    }

    private static func read(fd: Int32, count: Int, deadline: Deadline) throws -> Data {
        try nonblocking(fd: fd)
        var data = Data(), buffer = [UInt8](repeating: 0, count: min(65_536, count))
        while data.count < count {
            _ = try deadline.remaining()
            let wanted = min(buffer.count, count - data.count)
            let received = buffer.withUnsafeMutableBytes {
                Darwin.recv(fd, $0.baseAddress, wanted, MSG_DONTWAIT)
            }
            if received > 0 { data.append(contentsOf: buffer.prefix(received)); continue }
            if received < 0, errno == EINTR { continue }
            if received < 0, errno == EAGAIN || errno == EWOULDBLOCK {
                try wait(fd: fd, event: Int16(POLLIN), deadline: deadline); continue
            }
            throw Failure.io(received == 0 ? "peer closed before complete frame" : "recv failed: \(errno)")
        }
        return data
    }

    private static func nonblocking(fd: Int32) throws {
        let flags = Darwin.fcntl(fd, F_GETFL)
        guard flags >= 0, Darwin.fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else {
            throw Failure.io("socket could not be made nonblocking: \(errno)")
        }
    }

    public static func read(fd: Int32, deadline: Deadline) throws -> [String: Any] {
        let header = try read(fd: fd, count: 4, deadline: deadline)
        let count = header.withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }
        guard count > 0, count <= maxFrameBytes else { throw Failure.framing("frame length is outside1...2MiB") }
        let data = try read(fd: fd, count: count, deadline: deadline)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Failure.framing("JSON must be an object")
        }
        _ = try deadline.remaining()
        return object
    }

    public static func requestID(_ request: [String: Any]) throws -> String {
        guard Set(request.keys) == Set(["id", "action"]), let id = request["id"] as? String,
              UUID(uuidString: id) != nil, let action = request["action"] as? [String: Any],
              let verb = action["verb"] as? String, !verb.isEmpty, verb.utf8.count <= 64 else {
            throw Failure.framing("request requires exact id/action and a bounded verb")
        }
        return id
    }

    public static func result(_ response: [String: Any], for id: String) throws -> [String: Any] {
        guard Set(response.keys) == Set(["id", "result"]), response["id"] as? String == id,
              let result = response["result"] as? [String: Any], let success = result["success"] as? NSNumber,
              CFGetTypeID(success) == CFBooleanGetTypeID() else {
            throw Failure.framing("reply id, result or Boolean success differs")
        }
        if let data = result["data"], !(data is [String: Any]) { throw Failure.framing("result data must be an object") }
        if !success.boolValue {
            guard let error = result["error"] as? String, !error.isEmpty, error.utf8.count <= 4096 else {
                throw Failure.framing("negative reply omitted its bounded error")
            }
        }
        return result
    }

    public static func requireExclusiveCopy(_ reply: [String: Any]) throws {
        guard let success = reply["success"] as? NSNumber, CFGetTypeID(success) == CFBooleanGetTypeID(), success.boolValue,
              let info = reply["data"] as? [String: Any], let version = info["protocolVersion"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == Double(protocolVersion),
              let features = info["features"] as? [String], features.count <= 32,
              features.allSatisfy({ $0.utf8.count <= 128 }), features.contains(exclusiveCopyFeature) else {
            throw Failure.framing("copy requires the current retained-exclusive-copy guest protocol; nothing was copied")
        }
    }

    private static func copiedPayload(_ reply: [String: Any], path: String) throws -> [String: Any] {
        guard let success = reply["success"] as? NSNumber, CFGetTypeID(success) == CFBooleanGetTypeID(), success.boolValue,
              let payload = reply["data"] as? [String: Any], payload["path"] as? String == path,
              let verified = payload["verified"] as? NSNumber, CFGetTypeID(verified) == CFBooleanGetTypeID(), verified.boolValue else {
            throw Failure.framing("copy reply failed or omitted its exact destination/readback")
        }
        return payload
    }
    private static func byteReceipt(_ payload: [String: Any], data: Data) -> Bool {
        guard data.count <= 1_048_576, let number = payload["bytes"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue == Double(data.count) else { return false }
        return payload["sha256"] as? String == SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public static func copyBytes(_ reply: [String: Any], path: String) throws -> Data {
        let payload = try copiedPayload(reply, path: path)
        guard Set(payload.keys) == Set(["path", "bytes", "dataBase64", "sha256", "verified"]),
              let text = payload["dataBase64"] as? String, text.utf8.count <= 1_398_104,
              let data = Data(base64Encoded: text), data.base64EncodedString() == text, byteReceipt(payload, data: data) else {
            throw Failure.framing("copy requires bounded canonical bytes and exact count/hash readback")
        }
        return data
    }

    public static func verifyCopied(_ reply: [String: Any], path: String, data: Data) throws {
        let payload = try copiedPayload(reply, path: path)
        guard Set(payload.keys) == Set(["path", "bytes", "sha256", "verified", "overwrite"]),
              let overwrite = payload["overwrite"] as? NSNumber, CFGetTypeID(overwrite) == CFBooleanGetTypeID(),
              !overwrite.boolValue, byteReceipt(payload, data: data) else {
            throw Failure.framing("exclusive copy receipt differs; inspect the destination before retrying")
        }
    }

    /// No connection, retry or replay is performed here.
    public static func exchange(fd: Int32, request: [String: Any], deadline: Deadline) throws -> [String: Any] {
        let id = try requestID(request), frame = try encode(request)
        try write(fd: fd, frame: frame, deadline: deadline)
        return try result(read(fd: fd, deadline: deadline), for: id)
    }
}
