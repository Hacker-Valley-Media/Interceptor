import Foundation

/// One shared role boundary for both bridge and guest. Callers classify
/// before asking the native app for any secure value.
public enum AXSecureClassification {
    public static let placeholder = "\u{2022}\u{2022}\u{2022}"
    public static func isSecure(role: String?, subrole: String?) -> Bool {
        role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }
}
