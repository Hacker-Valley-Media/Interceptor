// LocalAuthentication. macOS 10.10+. References:
// apple-developer-docs/LocalAuthentication/{LAContext,LAPolicy,LABiometryType}.md.

import Foundation
import LocalAuthentication

final class AuthDomain: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    // Reuse a context to honor touchIDAuthenticationAllowableReuseDuration windows.
    private var sharedContext = LAContext()

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if action["type"] as? String == "desktop_auth" { handleNeutral(action, completion: completion); return }
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "status":         status(completion: completion)
        case "confirm":        confirm(action, completion: completion)
        case "invalidate":     invalidate(completion: completion)
        case "domain-state":   domainState(completion: completion)
        default:               completion(WireFormat.error("auth.\(sub) — unknown verb"))
        }
    }

    private func handleNeutral(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let failure = DesktopAuthValidation.validate(action) { completion(failure); return }
        let sub = action["sub"] as? String ?? ""
        let requested = action["policy"] as? String ?? "any"
        let provider = "local-authentication"
        let user = String(getuid())
        if sub == "status" {
            let context = LAContext()
            let policies = ["any", "biometry", "biometry-or-watch", "watch"].filter { context.canEvaluatePolicy(policy(from: $0), error: nil) }
            var error: NSError?
            let available = context.canEvaluatePolicy(policy(from: requested), error: &error)
            var data: [String: Any] = ["canEvaluate": available, "policy": requested, "provider": provider, "user": user, "biometryType": biometryString(context.biometryType), "availablePolicies": policies]
            if !available { data["error"] = error?.localizedDescription ?? "Authentication policy unavailable"; if let error { data["errorCode"] = error.code } }
            completion(WireFormat.success(data)); return
        }
        var legacy = action
        legacy["type"] = "macos_auth"
        legacy["reuse_seconds"] = action["reuse_seconds"] ?? 0
        legacy["fallback_title"] = action["fallback_title"] ?? "Use Password"
        legacy["cancel_title"] = action["cancel_title"] ?? "Cancel"
        let started = Date()
        let reason = action["reason"] as? String ?? ""
        handle(sub, action: legacy) { result in
            guard result["success"] as? Bool == true, let old = result["data"] as? [String: Any] else {
                completion(["success": false, "code": "provider_failed", "error": result["error"] as? String ?? "Native authentication failed"]); return
            }
            switch sub {
            case "confirm":
                let ok = old["ok"] as? Bool == true
                var data: [String: Any] = ["ok": ok, "policy": requested, "provider": provider, "user": user, "reason": reason, "elapsedMs": Int(Date().timeIntervalSince(started) * 1000), "biometryType": old["biometryType"] as? String ?? "unspecified"]
                if let state = old["domainState"] as? String { data["domainState"] = state }
                if !ok { data["error"] = old["error"] as? String ?? "Authentication was not approved"; if let code = old["errorCode"] as? Int { data["errorCode"] = code } }
                completion(WireFormat.success(data))
            case "invalidate": completion(WireFormat.success(["invalidated": true, "provider": provider]))
            case "domain-state":
                var data: [String: Any] = ["available": false, "provider": provider]
                if let state = old["domainState"] as? String, !state.isEmpty { data["available"] = true; data["state"] = state }
                else { data["reason"] = "No evaluated authentication domain state" }
                completion(WireFormat.success(data))
            default: completion(["success": false, "code": "invalid_request", "error": "Unknown authentication verb"])
            }
        }
    }

    private func policy(from string: String?) -> LAPolicy {
        switch string {
        case "biometry":             return .deviceOwnerAuthenticationWithBiometrics
        case "biometry-or-watch":
            if #available(macOS 10.15, *) { return .deviceOwnerAuthenticationWithBiometricsOrWatch }
            return .deviceOwnerAuthenticationWithBiometrics
        case "watch":
            if #available(macOS 10.15, *) { return .deviceOwnerAuthenticationWithWatch }
            return .deviceOwnerAuthentication
        default:                     return .deviceOwnerAuthentication
        }
    }

    private func biometryString(_ t: LABiometryType) -> String {
        switch t {
        case .faceID: return "faceID"
        case .touchID: return "touchID"
        case .none: return "none"
        @unknown default:
            // .opticID (raw 4) is visionOS hardware; anything newer reads "unknown".
            return t.rawValue == 4 ? "opticID" : "unknown"
        }
    }

    private func status(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let ctx = LAContext()
        var nsError: NSError?
        let policyArg: LAPolicy = .deviceOwnerAuthentication
        let canEvaluate = ctx.canEvaluatePolicy(policyArg, error: &nsError)
        var resp: [String: Any] = [
            "canEvaluate": canEvaluate,
            "policy": "deviceOwnerAuthentication",
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        if canEvaluate {
            resp["biometryType"] = biometryString(ctx.biometryType)
            resp["error"] = NSNull()
        } else {
            resp["biometryType"] = "none"
            resp["error"] = nsError?.localizedDescription as Any? ?? NSNull()
            if let code = nsError?.code { resp["errorCode"] = code }
        }
        completion(WireFormat.success(resp))
    }

    private func confirm(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let reason = action["reason"] as? String else {
            completion(WireFormat.error("auth.confirm: <reason> required")); return
        }
        let pol = policy(from: action["policy"] as? String)
        lock.lock()
        let ctx = sharedContext
        if let title = action["fallback_title"] as? String { ctx.localizedFallbackTitle = title }
        if let title = action["cancel_title"] as? String { ctx.localizedCancelTitle = title }
        if let reuse = action["reuse_seconds"] as? Int {
            let clamped = min(Double(reuse), LATouchIDAuthenticationMaximumAllowableReuseDuration)
            ctx.touchIDAuthenticationAllowableReuseDuration = clamped
        }
        lock.unlock()

        let started = Date()
        ctx.evaluatePolicy(pol, localizedReason: reason) { ok, error in
            let elapsedMs = Int(Date().timeIntervalSince(started) * 1000)
            if ok {
                completion(WireFormat.success([
                    "ok": true,
                    "policy": action["policy"] as? String ?? "any",
                    "reason": reason,
                    "biometryType": self.biometryString(ctx.biometryType),
                    "domainState": ctx.evaluatedPolicyDomainState?.map { String(format: "%02x", $0) }.joined() as Any? ?? NSNull(),
                    "elapsedMs": elapsedMs,
                ]))
            } else {
                let nsErr = error as NSError?
                completion(WireFormat.success([
                    "ok": false,
                    "policy": action["policy"] as? String ?? "any",
                    "errorCode": nsErr?.code as Any? ?? NSNull(),
                    "errorDomain": nsErr?.domain as Any? ?? NSNull(),
                    "error": nsErr?.localizedDescription as Any? ?? NSNull(),
                ]))
            }
        }
    }

    private func invalidate(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        sharedContext.invalidate()
        sharedContext = LAContext()
        lock.unlock()
        completion(WireFormat.success(["ok": true]))
    }

    private func domainState(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock(); let ctx = sharedContext; lock.unlock()
        let hex = ctx.evaluatedPolicyDomainState?.map { String(format: "%02x", $0) }.joined()
        completion(WireFormat.success(["domainState": hex as Any? ?? NSNull()]))
    }
}
