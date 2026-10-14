import Foundation

// Shape declarations and key allowlists come from the shared contract. These
// operation constraints match the qualified Rust filesystem request bounds.
// Only the neutral surface opts into them; legacy macos_* dispatch is retained.
enum DesktopFilesystemValidation {
    static func bounded(_ result: [String: Any]) -> [String: Any] {
        guard let bytes = try? JSONSerialization.data(withJSONObject: result) else {
            return failure("provider_failed", "filesystem result could not be serialized")
        }
        guard bytes.count <= DESKTOP_MAX_RESULT_BYTES else {
            return failure("resource_limit", "filesystem result exceeds the frame limit; request a smaller byte range or search limit")
        }
        return result
    }

    static func validate(_ action: [String: Any]) -> [String: Any]? {
        guard let type = action["type"] as? String, type.hasPrefix("desktop_fs_") else { return nil }
        if let reference = action["ref"] as? [String: Any], reference["kind"] as? String == "bookmark" {
            return failure("unsupported_operation", "bookmark references are not part of the neutral filesystem contract")
        }
        guard ["desktop_fs_read", "desktop_fs_write", "desktop_fs_search"].contains(type) else {
            return failure("unsupported_operation", "unknown filesystem operation")
        }
        if let error = DesktopFilesystemShape.validationError(action) { return failure("invalid_request", error) }
        if type == "desktop_fs_read" || type == "desktop_fs_write" {
            let reference = action["ref"] as? [String: Any]
            let supplied = (action["path"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            guard let path = supplied ?? reference?["path"] as? String, validPath(path) else {
                return failure("invalid_request", "an absolute filesystem path or path reference is required")
            }
            if type == "desktop_fs_read", let range = action["byteRange"] as? [String: Any] {
                for key in ["start", "length"] where !boundedInteger(range[key], minimum: 0, maximum: 9_007_199_254_740_991) {
                    return failure("invalid_request", "filesystem byte ranges must be nonnegative safe integers")
                }
                if let length = range["length"] as? NSNumber, length.doubleValue > Double(DESKTOP_MAX_FRAME_BYTES) {
                    return failure("resource_limit", "read exceeds frame size; request a smaller byte range")
                }
            }
            if type == "desktop_fs_write" {
                if action["append"] as? Bool == true { return failure("unsupported_operation", "append is not qualified; no file was changed") }
                if action["encoding"] as? String == "base64", let content = action["content"] as? String {
                    guard let data = Data(base64Encoded: content), data.base64EncodedString() == content else {
                        return failure("invalid_request", "content is not valid canonical base64")
                    }
                }
            }
        } else {
            let query = action["query"] as! String
            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || query.contains("\0") || query.utf8.count > 4096 {
                return failure("invalid_request", "search query is required and bounded")
            }
            for key in ["limit", "timeoutMs"] where !boundedInteger(action[key], minimum: 1, maximum: 10_000) {
                return failure("invalid_request", "filesystem search limits must be positive bounded integers")
            }
            let scope = action["scope"] as? String ?? "everywhere"
            if scope == "path" {
                guard let paths = action["paths"] as? [String], !paths.isEmpty, paths.count <= 64, paths.allSatisfy(validPath) else {
                    return failure("invalid_request", "path scope requires 1..64 absolute roots")
                }
            } else if ["cwd", "workspace"].contains(scope) {
                if let cwd = action["cwd"] as? String, !validPath(cwd) { return failure("invalid_request", "cwd must be absolute") }
            } else if !["everywhere", "home", "granted"].contains(scope), !validPath(scope) {
                return failure("invalid_request", "search scope must be an absolute directory or a named scope")
            }
        }
        return nil
    }

    static func validPath(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 32768 && !value.contains("\0") &&
            (value.hasPrefix("/") || value == "~" || value.hasPrefix("~/"))
    }

    static func boundedInteger(_ value: Any?, minimum: Double, maximum: Double) -> Bool {
        guard let value else { return true }
        guard let number = value as? NSNumber else { return false }
        let n = number.doubleValue
        return n.isFinite && n.rounded(.towardZero) == n && n >= minimum && n <= maximum
    }

    private static func failure(_ code: String, _ message: String) -> [String: Any] {
        ["success": false, "code": code, "error": String(String.UnicodeScalarView(message.unicodeScalars.prefix(512)))]
    }
}
