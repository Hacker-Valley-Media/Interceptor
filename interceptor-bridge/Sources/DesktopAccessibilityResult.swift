import Foundation
import ApplicationServices

// The neutral accessibility contract has shared codes; legacy macos_* replies
// retain their existing envelopes. Exact uncoded literals below come from
// AccessibilityDomain's refusal branches, not target-app text or fuzzy matches.
enum DesktopAccessibilityResult {
    static func normalize(_ result: [String: Any], type: String) -> [String: Any] {
        guard DesktopAccessibilityShape.operations.contains(type), result["success"] as? Bool == false else { return result }
        var reply = result
        let message = result["error"] as? String ?? "desktop accessibility operation failed"
        let originalCode = result["code"] as? String
        var nativeCode = originalCode
        var details = result["details"] as? [String: Any] ?? [:]
        let mutation = ["desktop_click", "desktop_type", "desktop_action", "desktop_move", "desktop_resize", "desktop_keys", "desktop_scroll", "desktop_drag"].contains(type) || (type == "desktop_menu" && result["data"] == nil)

        if nativeCode == nil {
            // InputTargetSelector and resolvePoint refuse these exact ref
            // failures before posting any input. Other diagnostics retain
            // delivery uncertainty, even when they contain the same words.
            if ["desktop_click", "desktop_type"].contains(type), details["dispatched"] as? Bool != true {
                let parts = message.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
                if parts.count == 3, parts[0] == "ref" {
                    let ref = String(parts[1])
                    if ref.range(of: "^e[0-9]{1,63}$", options: .regularExpression) == ref.startIndex..<ref.endIndex,
                       message == "ref \(ref) not found" || message == InputTargetSelector.expiredReferenceProblem(ref) {
                        nativeCode = "invalid_ref"
                        details["dispatched"] = false
                    }
                }
            }
            switch message {
            case "invalid ref": nativeCode = "invalid_ref"
            case "no target app found": nativeCode = "target_gone"
            case "no focused element": nativeCode = "unsupported_target"
            case "element is disabled; nothing was changed", "value is read-only; nothing was changed", "element is disabled; no action was performed":
                nativeCode = "unsupported_target"
                details["dispatched"] = false            case "resize failed: attribute not settable on this element (use a top-level window ref)",
                 "move failed: attribute not settable on this element (use a top-level window ref)":
                nativeCode = "unsupported_target"
            case "resize set succeeded but post-set frame read failed", "move set succeeded but post-set frame read failed":
                nativeCode = "timeout_unknown_outcome"
                details["dispatched"] = true
                details["verified"] = false
            default: break
            }
            // These two setters report the actual AXError as a numeric suffix.
            let prefix = type == "desktop_resize" ? "resize failed: " : type == "desktop_move" ? "move failed: " : nil
            if let prefix, message.hasPrefix(prefix), let raw = Int32(message.dropFirst(prefix.count)),
               let error = AXError(rawValue: raw), error != .success {
                nativeCode = AXTypedError.productCode(error)
                details["axError"] = ["code": Int(error.rawValue), "name": AXTypedError.symbolicName(error)]
            }
        }

        let code: String
        if let nativeCode, DesktopErrorCode(rawValue: nativeCode) != nil { code = nativeCode }
        else {
            switch nativeCode {
            case "accessibility_unusable": code = "permission_required"
            case "invalid_ref": code = "stale_reference"
            case "unsupported_attribute", "unsupported_parameterized_attribute", "unsupported_action", "no_value": code = "unsupported_target"
            case "invalid_value": code = "invalid_request"
            case "capability_unavailable": code = "unsupported_operation"
            case "cannot_complete": code = mutation ? "timeout_unknown_outcome" : "provider_failed"
            default: code = mutation ? "timeout_unknown_outcome" : "provider_failed"
            }
            if let originalCode { details["nativeCode"] = originalCode }
        }
        reply["code"] = code
        reply["error"] = String(String.UnicodeScalarView(message.unicodeScalars.prefix(512)))
        if !details.isEmpty { reply["details"] = details }
        if mutation { reply["retryable"] = false }
        return reply
    }
}
