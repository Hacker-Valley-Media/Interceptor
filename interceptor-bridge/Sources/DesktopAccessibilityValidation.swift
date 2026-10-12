import Foundation

// Generated declarations own the wire shape. Host-independent constraints run
// before the existing trust gate and handlers; macos_* compatibility is untouched.
enum DesktopAccessibilityValidation {
    static func validate(_ action: [String: Any]) -> [String: Any]? {
        guard let type = action["type"] as? String, DesktopAccessibilityShape.operations.contains(type) else { return nil }
        if let error = DesktopAccessibilityShape.validationError(action) { return failure(error) }
        for (key, value) in action {
            if let string = value as? String, string.contains("\0") { return failure("invalid \(key) field") }
            switch key {
            case "width", "height", "x", "y":
                guard let number = value as? NSNumber else { return failure("invalid \(key) field") }
                let n = number.doubleValue
                let minimum = ["width", "height"].contains(key) ? 1.0 : Double(Int32.min)
                if !n.isFinite || n.rounded(.towardZero) != n || n < minimum || n > Double(Int32.max) {
                    return failure("invalid \(key) field")
                }
            case "pid", "window", "depth", "maxChars", "maxNodes", "maxMs":
                guard let number = value as? NSNumber else { return failure("invalid \(key) field") }
                let n = number.doubleValue
                let maximum = key == "pid" ? Double(Int32.max) : key == "window" ? Double(UInt32.max) : 9_007_199_254_740_991
                if !n.isFinite || n.rounded(.towardZero) != n || n < 1 || n > maximum { return failure("invalid \(key) field") }
            case "amount", "times", "intervalMs":
                let n = (value as! NSNumber).doubleValue
                let minimum = key == "intervalMs" ? 0.0 : 1.0
                let maximum = key == "intervalMs" ? 1000.0 : 10000.0
                if !n.isFinite || n.rounded(.towardZero) != n || n < minimum || n > maximum { return failure("invalid \(key) field; expected an integer from \(Int(minimum)) to \(Int(maximum))") }
            case "items":
                let items = value as! [String]
                if items.count > 16 || items.contains(where: { $0.isEmpty || $0.utf8.count > 256 || $0.contains("\0") }) { return failure("invalid menu items") }
            case "ref", "from", "to":
                let ref = value as! String
                if ref.utf8.count > 64 || ref.range(of: "^e[0-9]+$", options: .regularExpression) != ref.startIndex..<ref.endIndex {
                    return failure("invalid ref field")
                }
            case "app", "bundleId", "query", "role", "action", "filter", "mode", "sub", "windowTitle":
                let string = value as! String
                if string.isEmpty || string.utf8.count > 4096 { return failure("invalid \(key) field") }
            case "coords", "fromCoords", "toCoords":
                let parts = (value as! String).split(separator: ",", omittingEmptySubsequences: false)
                if parts.count != 2 || !parts.allSatisfy({ Int32($0) != nil }) {
                    return failure("invalid coordinates")
                }
            case "windowBounds":
                for (field, value) in value as! [String: Any] {
                    let n = (value as! NSNumber).doubleValue
                    if !n.isFinite || abs(n) > 9_007_199_254_740_991 || (["width", "height"].contains(field) && n <= 0) {
                        return failure("invalid window bounds")
                    }
                }
            default: break
            }
        }
        // Background-only input must name a native target (same rule as the Rust provider); without one the
        // handlers would fall back to the HID tap at the cursor. A title+frame resolves through InputDomain.windowRequest.
        if action["backgroundOnly"] as? Bool == true, ["desktop_click", "desktop_type", "desktop_keys", "desktop_scroll", "desktop_drag"].contains(type),
           ["app", "pid", "window", "ref", "from"].allSatisfy({ action[$0] == nil }),
           !(action["windowTitle"] is String && action["windowBounds"] is [String: Any]) {
            return failure("background input requires an explicit native target or an exact title and frame")
        }
        if type == "desktop_app" {
            if (action["subcommand"] as? String ?? "activate") == "launch" {
                if action["bundleId"] == nil || action["app"] != nil || action["pid"] != nil { return failure("app launch requires only a bundleId target") }
            } else if (action["app"] != nil) == (action["pid"] != nil) || action["bundleId"] != nil {
                return failure("app lifecycle requires exactly one app or pid target")
            }
        }
        if type == "desktop_click", action["ref"] == nil && action["coords"] == nil { return failure("click requires a ref or coordinates") }
        if type == "desktop_click", action["ref"] != nil && action["coords"] != nil { return failure("click requires exactly one ref or coordinate pair") }
        if type == "desktop_drag" {
            let refs = action["from"] != nil && action["to"] != nil && action["fromCoords"] == nil && action["toCoords"] == nil
            let coords = action["fromCoords"] != nil && action["toCoords"] != nil && action["from"] == nil && action["to"] == nil
            if !refs && !coords { return failure("drag requires two refs or two coordinate pairs") }
        }
        if type == "desktop_keys", let keys = action["keys"] as? String, keys.isEmpty || keys.utf8.count > 128 { return failure("keys requires a bounded key combination") }
        if type == "desktop_scroll" {
            let times = (action["times"] as? NSNumber)?.doubleValue ?? 1
            let interval = (action["intervalMs"] as? NSNumber)?.doubleValue ?? 0
            if times * interval > 2000 { return failure("scroll repetitions exceed the two second delivery budget") }
        }
        return nil
    }

    private static func failure(_ message: String) -> [String: Any] {
        ["success": false, "code": "invalid_request", "error": String(String.UnicodeScalarView(message.unicodeScalars.prefix(512)))]
    }
}
