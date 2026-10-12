import Foundation

enum DesktopFilesValidation {
    static func validate(_ action: [String: Any]) -> [String: Any]? {
        guard action["type"] as? String == "desktop_files" else { return nil }
        if let error = DesktopFilesShape.validationError(action) { return failure("invalid_request", error) }
        let sub = action["sub"] as! String
        if ["watch", "unwatch"].contains(sub) {
            guard let path = action["path"] as? String, path.hasPrefix("/"), DesktopFilesystemValidation.validPath(path), action["limit"] == nil, action["pid"] == nil else {
                return failure("invalid_request", "files watch/unwatch require one bounded absolute path and no inventory selectors")
            }
        } else {
            guard action["path"] == nil else { return failure("invalid_request", "files recent/open accept no path") }
            if !DesktopFilesystemValidation.boundedInteger(action["limit"], minimum: 0, maximum: Double(sub == "recent" ? DESKTOP_FILES_MAX_RECENT : DESKTOP_FILES_MAX_OPEN)) {
                return failure("invalid_request", "file inventory/history limit is not a bounded integer")
            }
            if action["pid"] != nil && (sub != "open" || !DesktopFilesystemValidation.boundedInteger(action["pid"], minimum: 1, maximum: Double(Int32.max))) {
                return failure("invalid_request", "files pid requires an exact positive process id on open")
            }
        }
        return nil
    }
    static func failure(_ code: String, _ message: String) -> [String: Any] { ["success": false, "code": code, "error": String(message.prefix(512))] }
}
