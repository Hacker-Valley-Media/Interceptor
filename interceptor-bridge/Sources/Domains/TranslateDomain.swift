// Translation framework. macOS 15+. Headless via
// init(installedSource:target:). On macOS < 15, every verb returns a
// structured "Translation requires macOS 15.0+" payload (no notImplemented).
// References: apple-developer-docs/Translation/{TranslationSession,LanguageAvailability}.md.

import Foundation
#if canImport(Translation)
import Translation
#endif

final class TranslateDomain: DomainHandler, @unchecked Sendable {

    private let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        if #available(macOS 26, *) {
            switch sub {
            case "status":        statusModern(completion: completion)
            case "languages":     languagesModern(completion: completion)
            case "availability":  availabilityModern(action, completion: completion)
            case "prepare":       prepareModern(action, completion: completion)
            case "text":          textModern(action, completion: completion)
            case "batch":         batchModern(action, completion: completion)
            case "file":          fileModern(action, completion: completion)
            case "stop":          stopModern(completion: completion)
            default:              completion(WireFormat.error("translate.\(sub) — unknown verb"))
            }
        } else {
            completion(WireFormat.success([
                "available": false,
                "framework": "Translation",
                "note": "Translation headless TranslationSession.init(installedSource:target:) requires macOS 26+. Current OS exposes only the SwiftUI translationTask integration.",
            ]))
        }
    }

    // MARK: - macOS 15+

    @available(macOS 26, *)
    private func statusModern(completion: @escaping @Sendable ([String: Any]) -> Void) {
        completion(WireFormat.success([
            "available": true,
            "framework": "Translation",
            "note": "On-device, requires installed languages.",
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
        ]))
    }

    @available(macOS 26, *)
    private func languagesModern(completion: @escaping @Sendable ([String: Any]) -> Void) {
        Task {
            let availability = LanguageAvailability()
            let langs = await availability.supportedLanguages
            let arr = langs.map { l -> [String: Any] in
                ["languageCode": l.languageCode?.identifier ?? "", "region": l.region?.identifier ?? ""]
            }
            completion(WireFormat.success(["supported": arr]))
        }
    }

    @available(macOS 26, *)
    private func availabilityModern(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let to = action["to"] as? String else {
            completion(WireFormat.error("translate.availability: --to required")); return
        }
        let from = action["from"] as? String
        let sample = action["sample"] as? String
        Task {
            let availability = LanguageAvailability()
            let target = Locale.Language(identifier: to)
            if let from = from {
                let source = Locale.Language(identifier: from)
                let status = (try? await availability.status(from: source, to: target)) ?? .unsupported
                completion(WireFormat.success(["from": from, "to": to, "status": describe(status)]))
            } else if let sample = sample {
                let status = (try? await availability.status(for: sample, to: target)) ?? .unsupported
                completion(WireFormat.success(["sample": sample, "to": to, "status": describe(status)]))
            } else {
                completion(WireFormat.error("translate.availability: requires --from or --sample"))
            }
        }
    }

    @available(macOS 26, *)
    private func describe(_ status: LanguageAvailability.Status) -> String {
        switch status {
        case .installed: return "installed"
        case .supported: return "supported"
        case .unsupported: return "unsupported"
        @unknown default: return "unknown"
        }
    }

    /// Per `apple-developer-docs/Translation/TranslationSession.md` line 19,
    /// the headless `init(installedSource:target:)` "throws an error if the
    /// languages aren't already installed on the person's device" — and
    /// download permission can only be requested via the SwiftUI
    /// `translationTask` modifier, not from a daemon. So a headless bridge
    /// must pre-flight `LanguageAvailability.status(from:to:)` and surface
    /// a structured "open System Settings to install" message when the
    /// pair is `.supported` but not yet `.installed`.
    @available(macOS 26, *)
    private func ensureInstalled(from fromCode: String?, to toCode: String) async -> (code: String, reason: String)? {
        let availability = LanguageAvailability()
        let target = Locale.Language(identifier: toCode)
        let source = Locale.Language(identifier: fromCode ?? "en")
        guard let status = try? await availability.status(from: source, to: target) else {
            return ("provider_failed", "language pair (\(fromCode ?? "en") → \(toCode)) availability could not be determined")
        }
        switch status {
        case .installed:
            return nil
        case .supported:
            return ("not_installed", "language pair (\(fromCode ?? "en") → \(toCode)) is supported but not installed. Open System Settings → General → Language & Region → Translation Languages to download it. The headless TranslationSession.init(installedSource:target:) cannot trigger downloads from a daemon — only the SwiftUI translationTask path can.")
        case .unsupported:
            return ("unsupported_operation", "language pair (\(fromCode ?? "en") → \(toCode)) is not supported by Apple's Translation framework on this OS")
        @unknown default:
            return ("provider_failed", "language pair (\(fromCode ?? "en") → \(toCode)) status unknown")
        }
    }

    @available(macOS 26, *)
    private func prepareModern(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let from = action["from"] as? String, let to = action["to"] as? String else {
            completion(WireFormat.error("translate.prepare: requires --from and --to")); return
        }
        Task {
            if let refusal = await ensureInstalled(from: from, to: to) {
                completion(WireFormat.failure(refusal.code, "translate.prepare: \(refusal.reason)")); return
            }
            let session = TranslationSession(installedSource: Locale.Language(identifier: from),
                                              target: Locale.Language(identifier: to))
            do {
                try await session.prepareTranslation()
                let ready = await session.isReady
                completion(WireFormat.success(["from": from, "to": to, "ready": ready]))
            } catch {
                completion(WireFormat.error("translate.prepare: \(error.localizedDescription)"))
            }
        }
    }

    @available(macOS 26, *)
    private func textModern(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let input = action["input"] as? String, let to = action["to"] as? String else {
            completion(WireFormat.error("translate.text: requires text and --to")); return
        }
        let from = action["from"] as? String
        let target = Locale.Language(identifier: to)
        Task {
            if let refusal = await ensureInstalled(from: from, to: to) {
                completion(WireFormat.failure(refusal.code, "translate.text: \(refusal.reason)")); return
            }
            let source: Locale.Language = from.map { Locale.Language(identifier: $0) } ?? Locale.Language(identifier: "en")
            let session = TranslationSession(installedSource: source, target: target)
            do {
                let response = try await session.translate(input)
                let ready = await session.isReady
                completion(WireFormat.success([
                    "sourceText": input,
                    "sourceLanguage": from as Any? ?? NSNull(),
                    "targetLanguage": to,
                    "targetText": response.targetText,
                    "isReady": ready,
                ]))
            } catch {
                completion(WireFormat.error("translate.text: \(error.localizedDescription)"))
            }
        }
    }

    @available(macOS 26, *)
    private func batchModern(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let to = action["to"] as? String else {
            completion(WireFormat.error("translate.batch: requires --to")); return
        }
        // JSONSerialization returns Any (typically NSArray of NSString); the
        // single-step `as? [String]` cast was rejecting valid arrays. Parse
        // permissively, then compactMap each element to String to keep only
        // string entries, and reject only when nothing parses to a string.
        guard let raw = action["json"] as? String,
              let data = raw.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data),
              let arr = any as? [Any] else {
            completion(WireFormat.error("translate.batch: --json must be a JSON array (got: \(action["json"] ?? "nil"))")); return
        }
        let inputs = arr.compactMap { $0 as? String }
        guard !inputs.isEmpty else {
            completion(WireFormat.error("translate.batch: --json array contains no strings (parsed \(arr.count) elements, 0 string)")); return
        }
        let from = action["from"] as? String
        Task {
            if let refusal = await ensureInstalled(from: from, to: to) {
                completion(WireFormat.failure(refusal.code, "translate.batch: \(refusal.reason)")); return
            }
            let source: Locale.Language = from.map { Locale.Language(identifier: $0) } ?? Locale.Language(identifier: "en")
            let session = TranslationSession(installedSource: source, target: Locale.Language(identifier: to))
            var results: [[String: Any]] = []
            for s in inputs {
                do {
                    let response = try await session.translate(s)
                    results.append(["sourceText": s, "targetText": response.targetText, "ok": true])
                } catch {
                    results.append(["sourceText": s, "targetText": NSNull(), "ok": false, "error": error.localizedDescription])
                }
            }
            completion(WireFormat.success(["from": from as Any? ?? "auto", "to": to, "translations": results]))
        }
    }

    @available(macOS 26, *)
    private func fileModern(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String else { completion(WireFormat.error("translate.file: --path required")); return }
        guard let text = try? String(contentsOfFile: (path as NSString).expandingTildeInPath, encoding: .utf8) else {
            completion(WireFormat.error("translate.file: cannot read \(path)")); return
        }
        var fwd = action; fwd["input"] = text
        textModern(fwd, completion: completion)
    }

    @available(macOS 26, *)
    private func stopModern(completion: @escaping @Sendable ([String: Any]) -> Void) {
        // TranslationSession is created per-call in this domain; nothing to cancel.
        completion(WireFormat.success(["ok": true, "note": "TranslationSession is stateless across requests in this bridge."]))
    }
}
