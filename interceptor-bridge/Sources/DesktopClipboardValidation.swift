import Foundation

enum DesktopClipboardValidation {
    static func validate(_ action: [String: Any]) -> [String: Any]? {
        guard action["type"] as? String == "desktop_clipboard" else { return nil }
        if let error = DesktopClipboardShape.validationError(action) { return failure("invalid_request", error) }
        if action["sub"] as? String == "write", action["text"] as? String == nil {
            return failure("invalid_request", "clipboard write requires text")
        }
        if let text = action["text"] as? String {
            if text.contains("\0") { return failure("invalid_request", "clipboard text cannot contain NUL") }
            if text.utf8.count > DESKTOP_MAX_RESULT_BYTES { return failure("resource_limit", "clipboard text exceeds limit") }
        }
        if let number = action["limit"] as? NSNumber {
            let n = number.doubleValue
            if !n.isFinite || n.rounded(.towardZero) != n || n < 0 || n > Double(DESKTOP_CLIPBOARD_HISTORY_LIMIT) {
                return failure("invalid_request", "clipboard history limit must be an integer in 0..500")
            }
        }
        return nil
    }

    static func normalize(_ result: [String: Any], action: [String: Any]) -> [String: Any] {
        guard action["type"] as? String == "desktop_clipboard" else { return result }
        var result = result
        if result["success"] as? Bool == false, result["code"] == nil {
            result["code"] = action["sub"] as? String == "read" ? "unsupported_target" : "provider_failed"
        }
        guard let bytes = try? JSONSerialization.data(withJSONObject: result) else {
            return failure("provider_failed", "clipboard result could not be serialized")
        }
        guard bytes.count <= DESKTOP_MAX_RESULT_BYTES else {
            return failure("resource_limit", "clipboard result exceeds the desktop frame budget")
        }
        return result
    }

    static func failure(_ code: String, _ message: String) -> [String: Any] {
        ["success": false, "code": code, "error": String(message.unicodeScalars.prefix(512))]
    }
}
