import Foundation

enum DesktopThumbnailValidation {
    static func validate(_ action: [String: Any]) -> [String: Any]? {
        guard action["type"] as? String == "desktop_thumbnail" else { return nil }
        if let error = DesktopThumbnailShape.validationError(action) { return failure("invalid_request", error) }
        let batch = action["sub"] as? String == "batch"
        if batch {
            guard action["path"] == nil, let paths = action["paths"] as? [String],
                  !paths.isEmpty, paths.count <= DESKTOP_THUMBNAIL_MAX_PATHS, paths.allSatisfy(validPath)
            else { return failure("invalid_request", "thumbnail batch requires 1..32 absolute paths") }
        } else if action["paths"] != nil || !((action["path"] as? String).map(validPath) ?? false) {
            return failure("invalid_request", "thumbnail requires one absolute path")
        }
        let size = action["size"] as? String ?? "256"
        let scale = (action["scale"] as? NSNumber)?.doubleValue ?? 2
        guard size.range(of: #"^[1-9]\d{0,3}(?:x[1-9]\d{0,3})?$"#, options: .regularExpression) == size.startIndex..<size.endIndex,
              scale.isFinite, scale.rounded() == scale, (1...8).contains(scale)
        else { return failure("invalid_request", "thumbnail requires positive integer size and scale 1..8") }
        let dimensions = size.split(separator: "x").compactMap { Double($0) }
        let width = dimensions[0] * scale, height = (dimensions.last ?? dimensions[0]) * scale
        guard width <= 16384, height <= 16384, width * height <= Double(DESKTOP_THUMBNAIL_MAX_PIXELS)
        else { return failure("invalid_request", "thumbnail dimensions exceed their pixel bound") }
        if let format = action["format"] as? String, !["png", "jpeg", "jpg", "heic"].contains(format.lowercased()) {
            return failure("invalid_request", "thumbnail format requires png, jpeg or heic")
        }
        if let types = action["types"] as? String,
           types.utf8.count > 128 || !types.components(separatedBy: ",").allSatisfy({ ["all", "icon", "thumbnail", "lowQuality", "lowQualityThumbnail"].contains($0.trimmingCharacters(in: .whitespaces)) }) {
            return failure("invalid_request", "unknown thumbnail representation type")
        }
        if let out = action["out"] as? String, batch || action["save"] as? Bool != true || !validPath(out) {
            return failure("invalid_request", "thumbnail out requires a single saved image and absolute destination")
        }
        return nil
    }

    static func validPath(_ path: String) -> Bool {
        !path.isEmpty && path.utf8.count <= 32768 && !path.contains("\0") && (path.hasPrefix("/") || path.hasPrefix("~/"))
    }
    static func failure(_ code: String, _ message: String) -> [String: Any] {
        ["success": false, "code": code, "error": String(message.prefix(512))]
    }
    static func bounded(_ result: [String: Any], saving: Bool) -> [String: Any] {
        guard let data = try? JSONSerialization.data(withJSONObject: result), data.count <= DESKTOP_MAX_RESULT_BYTES else {
            return failure(saving ? "partial_result" : "resource_limit", "thumbnail result exceeds the desktop frame bound; request fewer or smaller images")
        }
        return result
    }
}
