import Foundation

enum WireFormat {
    static func frame(_ data: Data) -> Data {
        var length = UInt32(data.count).littleEndian
        var frame = Data(bytes: &length, count: 4)
        frame.append(data)
        return frame
    }

    static func extractFrame(from buffer: inout Data) -> Data? {
        guard buffer.count >= 4 else { return nil }
        let length = buffer.withUnsafeBytes { $0.load(as: UInt32.self).littleEndian }
        guard length > 0, length <= 10 * 1024 * 1024 else {
            Platform.log("invalid message length: \(length), discarding buffer")
            buffer.removeAll()
            return nil
        }
        let total = 4 + Int(length)
        guard buffer.count >= total else { return nil }
        let payload = buffer.subdata(in: 4..<total)
        buffer.removeSubrange(0..<total)
        return payload
    }

    static func success(_ data: Any? = nil) -> [String: Any] {
        var result: [String: Any] = ["success": true]
        if let data = data { result["data"] = data }
        return result
    }

    static func error(_ message: String) -> [String: Any] {
        return ["success": false, "error": message]
    }
}
