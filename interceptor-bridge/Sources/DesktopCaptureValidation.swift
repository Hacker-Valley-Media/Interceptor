import Foundation

enum DesktopCaptureValidation {
    static func validate(_ action: [String: Any]) -> [String: Any]? {
        guard let type = action["type"] as? String, DesktopCaptureShape.operations.contains(type) else { return nil }
        if let error = DesktopCaptureShape.validationError(action) { return failure("invalid_request", error) }
        for field in ["app", "element", "cwd"] {
            if let value = action[field] as? String, value.isEmpty || value.contains("\0") { return failure("invalid_request", "\(field) requires nonempty text without NUL") }
        }
        let ranges: [String: ClosedRange<Double>] = ["window": 1...9007199254740991, "display": 1...9007199254740991,
            "quality": 0...100, "target_max_long_edge": 0...16384, "timeoutMs": 0...Double(DESKTOP_CAPTURE_MAX_TIMEOUT_MS)]
        for (field, range) in ranges {
            if let n = action[field] as? NSNumber {
                let value = n.doubleValue
                if !value.isFinite || value.rounded(.towardZero) != value || !range.contains(value) { return failure("invalid_request", "\(field) requires an integer from \(Int64(range.lowerBound))\(field == "target_max_long_edge" ? " (no limit)" : "") to \(Int64(range.upperBound))") }
            }
        }
        if action["element"] != nil { return failure("unsupported_operation", "native element screenshot is not implemented by the macOS baseline") }
        return nil
    }
    static func normalize(_ result: [String: Any], action: [String: Any]) -> [String: Any] {
        guard let type = action["type"] as? String, DesktopCaptureShape.operations.contains(type) else { return result }
        var result = result
        if result["success"] as? Bool == false, result["code"] == nil {
            let error = result["error"] as? String ?? "capture failed"
            result["code"] = error.contains("permission required") ? "permission_required" :
                error.contains("not found") || error.contains("does not belong") || error.contains("no capturable") ? "unsupported_target" :
                error.contains("not started") ? "invalid_request" : "provider_failed"
        }
        guard let bytes = try? JSONSerialization.data(withJSONObject: result), bytes.count <= DESKTOP_MAX_RESULT_BYTES else {
            return failure("resource_limit", "capture result exceeds the desktop frame budget")
        }
        return result
    }
    static func failure(_ code: String, _ message: String) -> [String: Any] {
        ["success": false, "code": code, "error": String(message.unicodeScalars.prefix(512))]
    }
}
