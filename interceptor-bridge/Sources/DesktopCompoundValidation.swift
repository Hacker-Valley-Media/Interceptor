import Foundation

enum DesktopCompoundValidation {
    static func validate(_ action: [String: Any]) -> [String: Any]? {
        guard let type = action["type"] as? String, DesktopCompoundShape.operations.contains(type) else { return nil }
        if let error = DesktopCompoundShape.validationError(action) {
            return ["success": false, "code": "invalid_request", "error": error]
        }
        var nested = action
        nested.removeValue(forKey: "activate")
        nested["type"] = type == "desktop_act" ? (action["text"] == nil ? "desktop_click" : "desktop_type") : "desktop_tree"
        return DesktopAccessibilityValidation.validate(nested)
    }

    static func normalize(_ result: [String: Any], type: String) -> [String: Any] {
        DesktopAccessibilityResult.normalize(result, type: type == "desktop_act" ? "desktop_type" : "desktop_tree")
    }
}
