import Foundation
import ApplicationServices
import NativeAX

// one central secure-field boundary.
//
// Secure classification happens BEFORE DTO serialization, logging, metrics, ref
// previews, and error construction. A secure value is always `redacted`;
// `--include-sensitive` can never override this. The placeholder is a fixed
// constant that shares no bytes with any real field content.
enum AXSecureRedaction {
    static let placeholder = AXSecureClassification.placeholder

    /// A role/subrole pair identifies a secure text field.
    static func isSecure(role: String?, subrole: String?) -> Bool {
        AXSecureClassification.isSecure(role: role, subrole: subrole)
    }

    /// Read role + subrole through the transport and classify. Used by domains
    /// before emitting any value for an element.
    static func isSecureElement(_ element: AXUIElement, transport: any AXTransport) -> Bool {
        let (rr, roleVal) = transport.copyAttributeValue(element, kAXRoleAttribute as String)
        let (sr, subVal) = transport.copyAttributeValue(element, kAXSubroleAttribute as String)
        let role = rr == .success ? AXValueCodec.displayString(roleVal) : nil
        let subrole = sr == .success ? AXValueCodec.displayString(subVal) : nil
        return isSecure(role: role, subrole: subrole)
    }

    /// Tagged redacted variant (never carries the underlying value).
    static func redactedTag(reason: String = "secure_value") -> [String: Any] {
        ["kind": "redacted", "reason": reason]
    }

    /// Compat display value that respects secure classification. Non-secure
    /// values pass through `displayString`; secure values become the placeholder.
    static func displayString(_ value: CFTypeRef?, secure: Bool) -> String? {
        if secure { return placeholder }
        return AXValueCodec.displayString(value)
    }
}
