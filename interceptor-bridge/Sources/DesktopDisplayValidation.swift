import Foundation
import CoreGraphics

enum DesktopDisplayValidation {
    static func validate(_ action: [String: Any]) -> [String: Any]? {
        guard let type = action["type"] as? String, DesktopDisplayShape.operations.contains(type) else { return nil }
        if let error = DesktopDisplayShape.validationError(action) { return failure("invalid_request", error) }
        if let id = action["id"] as? NSNumber {
            let n = id.doubleValue
            if !n.isFinite || n.rounded(.towardZero) != n || n < 1 || n > Double(UInt32.max) { return failure("invalid_request", "Mac display ID requires a positive UInt32") }
        }
        return nil
    }
    static func failure(_ code: String, _ message: String) -> [String: Any] {
        ["success": false, "code": code, "error": String(message.unicodeScalars.prefix(512))]
    }
}
