import Foundation

enum DesktopAuthValidation {
    static func validate(_ action: [String: Any]) -> [String: Any]? {
        guard action["type"] as? String == "desktop_auth" else { return nil }
        func failure(_ message: String) -> [String: Any] { ["success": false, "code": "invalid_request", "error": message] }
        if let error = DesktopAuthShape.validationError(action) { return failure(error) }
        let sub = action["sub"] as? String ?? ""
        let confirm = sub == "confirm"
        if !confirm, ["reason", "reuse_seconds", "fallback_title", "cancel_title"].contains(where: { action[$0] != nil }) { return failure("authentication prompt fields require confirm") }
        if !confirm, sub != "status", action["policy"] != nil { return failure("authentication policy requires status or confirm") }
        if confirm, (action["reason"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return failure("authentication confirm requires a reason") }
        for (key, cap) in [("reason", DESKTOP_AUTH_MAX_REASON_BYTES), ("fallback_title", DESKTOP_AUTH_MAX_TITLE_BYTES), ("cancel_title", DESKTOP_AUTH_MAX_TITLE_BYTES)] {
            if let value = action[key] as? String, value.utf8.count > cap || value.contains("\0") { return failure("authentication text exceeds its limit or contains NUL") }
        }
        if let reuse = action["reuse_seconds"] as? NSNumber {
            let n = reuse.doubleValue
            if !n.isFinite || n.rounded(.towardZero) != n || n < 0 || n > 300 { return failure("authentication reuse requires an integer 0..300 seconds") }
        }
        return nil
    }
}
