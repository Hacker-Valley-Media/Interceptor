import Foundation
import Security

// Wraps the Security-framework code-signing introspection surface so
// TrustDomain (and the router's Accessibility gate) can report how the
// running bridge binary is signed, unit-testable without SecCode.
//
// Why this matters (issue #163 follow-up): TCC pins an Accessibility grant
// to the binary's code identity. A Developer ID signature gives a stable
// identity that survives updates; an ad-hoc seal has no signing identity —
// per the SDK (CSCommon.h): "The code has been sealed without a signing
// identity. No identity may be retrieved from it" — so the grant pins to
// the build-unique cdhash (SecCode.h kSecCodeInfoUnique: "uniquely
// identifies the static code in question … Compare to
// kSecCodeInfoIdentifier, which remains stable across (developer-approved)
// updates"). Every ad-hoc rebuild therefore silently invalidates the grant
// while the System Settings row keeps showing the toggle as on.
//
// Apple-doc anchors (SecCode.h): SecCodeCopySelf → SecCodeCopyStaticCode →
// SecCodeCopySigningInformation(kSecCSSigningInformation). Flags value is
// kSecCodeInfoFlags; kSecCodeSignatureAdhoc = 0x0002 (CSCommon.h).
struct SigningInfo: Sendable {
    let adhoc: Bool
    let teamId: String?
    let identifier: String?
    let cdhash: String?

    func toDictionary() -> [String: Any] {
        [
            "adhoc": adhoc,
            "teamId": teamId ?? NSNull(),
            "identifier": identifier ?? NSNull(),
            "cdhash": cdhash ?? NSNull(),
        ]
    }
}

protocol SigningInfoProvider: Sendable {
    func signingInfo() -> SigningInfo
}

// Production-default wiring. The running binary's signature cannot change
// mid-process, so the SecCode query runs once and is cached.
struct LiveSigningInfoProvider: SigningInfoProvider {
    static let current: SigningInfo = readSelf()

    func signingInfo() -> SigningInfo { Self.current }

    private static func readSelf() -> SigningInfo {
        // Unknown-by-default: if any step fails we report a non-adhoc,
        // identity-free result rather than guessing.
        let unknown = SigningInfo(adhoc: false, teamId: nil, identifier: nil, cdhash: nil)

        var codeRef: SecCode?
        guard SecCodeCopySelf([], &codeRef) == errSecSuccess, let code = codeRef else {
            return unknown
        }
        var staticRef: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticRef) == errSecSuccess, let staticCode = staticRef else {
            return unknown
        }
        var infoRef: CFDictionary?
        let flags = SecCSFlags(rawValue: kSecCSSigningInformation)
        guard SecCodeCopySigningInformation(staticCode, flags, &infoRef) == errSecSuccess,
              let info = infoRef as? [String: Any] else {
            return unknown
        }

        let signatureFlags = (info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
        // kSecCodeSignatureAdhoc = 0x0002 — "must be used without signer" (CSCommon.h).
        let adhoc = (signatureFlags & 0x0002) != 0
        let teamId = info[kSecCodeInfoTeamIdentifier as String] as? String
        let identifier = info[kSecCodeInfoIdentifier as String] as? String
        let cdhash = (info[kSecCodeInfoUnique as String] as? Data)
            .map { $0.map { String(format: "%02x", $0) }.joined() }

        return SigningInfo(adhoc: adhoc, teamId: teamId, identifier: identifier, cdhash: cdhash)
    }
}
