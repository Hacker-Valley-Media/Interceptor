import Foundation

/// JSON helpers for the agent's wire protocol. The agent speaks the same
/// `{id, result}` / `{id, action}` envelope the browser extension uses, so all
/// payloads are `[String: Any]` dictionaries serialized with JSONSerialization.
enum JSONUtil {
    static func encode(_ obj: [String: Any]) -> String {
        let safe = sanitize(obj)
        if JSONSerialization.isValidJSONObject(safe),
           let data = try? JSONSerialization.data(withJSONObject: safe, options: []),
           let s = String(data: data, encoding: .utf8) {
            return s
        }
        return "{\"success\":false,\"error\":\"agent encode failed\"}"
    }

    static func decode(_ s: String) -> [String: Any]? {
        guard let data = s.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            return nil
        }
        return obj
    }

    /// JSONSerialization rejects non-JSON values; coerce anything unusual to a
    /// string so a verb result can never crash the wire.
    static func sanitize(_ value: Any) -> Any {
        switch value {
        case let d as [String: Any]:
            var out = [String: Any]()
            for (k, v) in d { out[k] = sanitize(v) }
            return out
        case let a as [Any]:
            return a.map { sanitize($0) }
        case is NSNull, is String, is NSNumber, is Bool, is Int, is Double:
            return value
        default:
            return String(describing: value)
        }
    }

    static func ok(_ data: Any? = nil) -> [String: Any] {
        var r: [String: Any] = ["success": true]
        if let data = data { r["data"] = data }
        return r
    }

    static func err(_ message: String) -> [String: Any] {
        return ["success": false, "error": message]
    }
}
