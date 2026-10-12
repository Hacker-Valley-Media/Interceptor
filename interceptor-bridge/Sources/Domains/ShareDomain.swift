// NSSharingService source candidate. Native completion is observed; a native
// compose window or share sheet may be displayed by the requested service.

import Foundation
import AppKit
import ShareNative

final class ShareDomain: DomainHandler, @unchecked Sendable {
    // Main-queue ownership includes requests whose reply timed out but whose
    // native sharing service has not completed. A timeout never implies cancel.
    private var pending: [UUID: ShareRequest] = [:]
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var input = action
        input["type"] = "desktop_share"
        input["sub"] = action["sub"] as? String ?? command
        if let error = Self.actionError(input) {
            completion(WireFormat.failure("invalid_request", error)); return
        }
        for item in input["items"] as? [String] ?? [] where item.hasPrefix("/") {
            var info = stat()
            guard lstat(item, &info) == 0, access(item, R_OK) == 0 else { completion(WireFormat.failure("permission_denied", "Share file is inaccessible: \(item); nothing was shared")); return }
            guard info.st_mode & S_IFMT == S_IFREG else { completion(WireFormat.failure("unsupported_target", "Share attachment requires a regular nonsymlink file")); return }
        }
        nonisolated(unsafe) let captured = input
        DispatchQueue.main.async { self.route(captured) { result in
            if let error = Self.resultError(result) { completion(WireFormat.failure("partial_result", error)) }
            else { completion(result) }
        } }
    }

    private func route(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as! String
        switch sub {
        case "services":         services(action, completion: completion)
        case "airdrop":          run(named: NSSharingService.Name.sendViaAirDrop, action: action, completion: completion)
        case "email":            run(named: NSSharingService.Name.composeEmail, action: action, completion: completion)
        case "message":          run(named: NSSharingService.Name.composeMessage, action: action, completion: completion)
        case "reading-list":     run(named: NSSharingService.Name.addToSafariReadingList, action: action, completion: completion)
        case "desktop-picture":  run(named: NSSharingService.Name.useAsDesktopPicture, action: action, completion: completion)
        case "named":            runNamed(action: action, completion: completion)
        case "text":             runStringOrUrl(action: action, completion: completion, isUrl: false)
        case "url":              runStringOrUrl(action: action, completion: completion, isUrl: true)
        default:                 completion(WireFormat.error("share.\(sub) — unknown verb"))
        }
    }

    /// Builds the share payload from any combination of:
    ///   - `items` array (filesystem paths, urls, or strings)
    ///   - `text` flag (plain string)
    ///   - `url` flag (parsed as URL)
    ///   - `body` flag (alias for text)
    /// At least one source must produce a non-empty list, otherwise
    /// NSSharingService.canPerform(withItems:) will reject the share.
    private func resolveItems(_ action: [String: Any]) -> [Any] {
        var out: [Any] = []
        if let raw = action["items"] as? [String] {
            for p in raw {
                let expanded = (p as NSString).expandingTildeInPath
                if FileManager.default.fileExists(atPath: expanded) {
                    out.append(URL(fileURLWithPath: expanded))
                } else if let url = URL(string: p), url.scheme != nil {
                    out.append(url)
                } else {
                    out.append(p)
                }
            }
        }
        if let t = action["text"] as? String, !t.isEmpty { out.append(t) }
        if let u = action["url"] as? String, !u.isEmpty {
            if let url = URL(string: u), url.scheme != nil { out.append(url) } else { out.append(u) }
        }
        if let b = action["body"] as? String, !b.isEmpty { out.append(b) }
        return out
    }

    /// Apple's `NSSharingService(named:)` only accepts canonical raw names
    /// (e.g. `com.apple.share.composeMessage`). The `services` enumerator
    /// returns NSSharingService instances whose `.title` is a localized
    /// display string (e.g. "Messages"). The CLI surface accepts either
    /// form — we resolve the supplied identifier against (1) the raw-value
    /// init, then (2) the live services-for-items title list, and (3) a
    /// short alias map for friendly common names.
    private func resolveService(_ identifier: String, items: [Any]) -> NSSharingService? {
        // (1) Direct raw-name init.
        if let svc = NSSharingService(named: NSSharingService.Name(rawValue: identifier)) {
            return svc
        }
        // (2) Live title match against services-for-these-items.
        let probeItems: [Any] = items.isEmpty ? [URL(fileURLWithPath: "/tmp/")] : items
        let live = NSSharingService.sharingServices(forItems: probeItems)
        let matches = live.filter { $0.title.compare(identifier, options: .caseInsensitive) == .orderedSame }
        if matches.count == 1 { return matches[0] }
        if matches.count > 1 { return nil }
        // (3) Friendly aliases for the common cases.
        let alias: [String: NSSharingService.Name] = [
            "airdrop":          .sendViaAirDrop,
            "mail":             .composeEmail,
            "email":            .composeEmail,
            "messages":         .composeMessage,
            "message":          .composeMessage,
            "reading list":     .addToSafariReadingList,
            "reading-list":     .addToSafariReadingList,
            "desktop":          .useAsDesktopPicture,
            "desktop picture":  .useAsDesktopPicture,
            "desktop-picture":  .useAsDesktopPicture,
        ]
        if let n = alias[identifier.lowercased()], let svc = NSSharingService(named: n) {
            return svc
        }
        return nil
    }

    private func services(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        // Probe with two sentinel item types so we capture both file-only and string services.
        let sentinelURL: URL = URL(fileURLWithPath: "/tmp/")
        let sentinelText: String = "interceptor-sentinel"
        let unionRaw = NSSharingService.sharingServices(forItems: [sentinelURL]) + NSSharingService.sharingServices(forItems: [sentinelText])
        var seen = Set<String>()
        let union = unionRaw.filter { svc in
            let name = svc.title // not stable across locales but unique enough for dedupe
            if seen.contains(name) { return false }
            seen.insert(name)
            return true
        }
        let forFlag = action["for_item"] as? String
        let scoped: [NSSharingService]
        if let path = forFlag {
            let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
            scoped = NSSharingService.sharingServices(forItems: [url])
        } else {
            scoped = union
        }
        guard scoped.count <= 128 else { completion(WireFormat.failure("resource_limit", "share: native service inventory exceeds 128")); return }
        let dicts = scoped.map { svc -> [String: Any] in
            return [
                "title": svc.title,
                "menuItemTitle": svc.menuItemTitle,
                "canPerform": true,
            ]
        }
        completion(WireFormat.success(["services": dicts]))
    }

    private func run(named name: NSSharingService.Name, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let items = resolveItems(action)
        guard let svc = NSSharingService(named: name) else {
            completion(WireFormat.error("share: service \(name.rawValue) is not available")); return
        }
        guard svc.canPerform(withItems: items) else {
            completion(WireFormat.error("share: service \(name.rawValue) cannot share these items (got \(items.count) item(s)). Pass --text, --url, or --items <path>."))
            return
        }
        perform(svc, items: items, identifier: name.rawValue, action: action, completion: completion)
    }

    private func runNamed(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let serviceName = action["service"] as? String else {
            completion(WireFormat.error("share.named: --service required")); return
        }
        let items = resolveItems(action)
        guard let svc = resolveService(serviceName, items: items) else {
            let live = NSSharingService.sharingServices(forItems: items.isEmpty ? [URL(fileURLWithPath: "/tmp/")] : items)
            completion(WireFormat.error("share.named: \"\(serviceName)\" not found. Live titles: \(live.map { $0.title }). Aliases: airdrop, email, messages, reading-list, desktop-picture."))
            return
        }
        guard svc.canPerform(withItems: items) else {
            completion(WireFormat.error("share.named: service \(svc.title) cannot share these items (got \(items.count) item(s)). Pass --text, --url, or --items <path>."))
            return
        }
        perform(svc, items: items, identifier: svc.title, action: action, completion: completion)
    }

    private func runStringOrUrl(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void, isUrl: Bool) {
        guard let value = action["value"] as? String else {
            completion(WireFormat.error("share: --value required")); return
        }
        let item: Any = isUrl ? ((URL(string: value)) ?? value) : value
        let items: [Any] = [item]
        guard let serviceName = action["service"] as? String else {
            completion(WireFormat.error("share: --service required")); return
        }
        guard let svc = resolveService(serviceName, items: items) else {
            let live = NSSharingService.sharingServices(forItems: items)
            completion(WireFormat.error("share: \"\(serviceName)\" not found. Live titles: \(live.map { $0.title })."))
            return
        }
        guard svc.canPerform(withItems: items) else {
            completion(WireFormat.error("share: service \(svc.title) cannot share these items"))
            return
        }
        perform(svc, items: items, identifier: svc.title, action: action, completion: completion)
    }

    private func perform(_ service: NSSharingService, items: [Any], identifier: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard pending.count < 4, !pending.values.contains(where: { $0.service === service }) else {
            completion(WireFormat.failure("resource_limit", "share: four native requests or this service remain active; no work queued")); return
        }
        // A composer cannot appear on a locked screen; the share then sat for 55 s with Mail or Messages
        // launched out of sight.
        if identifier != NSSharingService.Name.useAsDesktopPicture.rawValue, let session = CGSessionCopyCurrentDictionary() as? [String: Any], session["CGSSessionScreenIsLocked"] as? Bool == true {
            completion(WireFormat.failure("no_interactive_session", "share: the screen is locked, so the share composer cannot be shown; nothing was shared")); return
        }
        let id = UUID()
        let request = ShareRequest(service: service, items: items, identifier: identifier, completion: completion) { [weak self] in self?.pending.removeValue(forKey: id) }
        pending[id] = request
        configure(service, with: action)
        service.delegate = request
        DispatchQueue.main.asyncAfter(deadline: .now() + 55) { [weak request] in request?.deadline() }
        if let error = InterceptorPerformShare(service, items) { request.failed(error) }
    }

    static func resultError(_ result: [String: Any]) -> String? {
        guard result["success"] as? Bool == true else { return nil }
        guard let data = result["data"] as? [String: Any], let bytes = try? JSONSerialization.data(withJSONObject: data), bytes.count <= 1048576 else { return "share: native reply exceeds 1MiB" }
        if data["services"] != nil {
            guard let services = try? JSONDecoder().decode(DesktopShareServices.self, from: bytes), services.services.count <= 128 else { return "share: invalid native services reply" }
            if services.services.contains(where: { $0.title.isEmpty || $0.title.utf8.count > 4096 || $0.menuItemTitle.utf8.count > 4096 }) { return "share: invalid native service text" }
        } else {
            guard let result = try? JSONDecoder().decode(DesktopShareCompleted.self, from: bytes), result.ok, !result.service.isEmpty, result.service.utf8.count <= 4096,
                  (result.items?.count ?? 0) <= 32, (result.recipients?.count ?? 0) <= 32 else { return "share: invalid native completion metadata after effect" }
        }
        func bounded(_ value: Any) -> Bool {
            if let text = value as? String { return text.utf8.count <= 65536 && !text.contains("\0") }
            if let rows = value as? [Any] { return rows.allSatisfy(bounded) }
            if let row = value as? [String: Any] { return row.values.allSatisfy(bounded) }
            return value is NSNumber || value is NSNull
        }
        return bounded(data) ? nil : "share: invalid bounded native reply text"
    }

    static func actionError(_ a: [String: Any]) -> String? {
        if let error = DesktopShareShape.validationError(a) { return error }
        guard let sub = a["sub"] as? String else { return "share: selector required" }
        let payload = ["items", "text", "url", "body", "recipient", "recipients", "subject"]
        let allowed = sub == "services" ? ["for_item"] : (["text", "url"].contains(sub) ? ["service", "value", "recipient", "recipients", "subject"] : sub == "named" ? payload + ["service"] : payload)
        if a.keys.contains(where: { !(["type", "sub", "group", "groupColor", "groupSoft"] + allowed).contains($0) }) { return "share: field does not belong to selector" }
        for (key, value) in a {
            if let string = value as? String, string.utf8.count > (["text", "body", "value"].contains(key) ? 65536 : ["group", "groupColor", "service", "recipient"].contains(key) ? 256 : 4096) || string.contains("\0") || string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "share: invalid bounded text" }
            if let values = value as? [String], values.isEmpty || values.count > 32 || values.contains(where: { $0.isEmpty || $0.contains("\0") || $0.utf8.count > (key == "recipients" ? 256 : 4096) }) { return "share: invalid bounded list" }
        }
        if a["recipient"] != nil && a["recipients"] != nil { return "share: recipient aliases are mutually exclusive" }
        if ["named", "text", "url"].contains(sub) && a["service"] == nil { return "share: exact service required" }
        if ["text", "url"].contains(sub) && a["value"] == nil { return "share: value required" }
        if sub != "services" && !["text", "url"].contains(sub) && !payload.prefix(4).contains(where: { a[$0] != nil }) { return "share: content required" }
        if let raw = sub == "url" ? a["value"] as? String : a["url"] as? String {
            guard let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { return "share: absolute http or https URL required" }
        }
        if let path = a["for_item"] as? String, !path.hasPrefix("/") { return "share: service probe requires absolute file path" }
        guard let bytes = try? JSONSerialization.data(withJSONObject: a), bytes.count <= 262144 else { return "share: request exceeds 256KiB" }
        return nil
    }

    private func configure(_ svc: NSSharingService, with action: [String: Any]) {
        if let r = action["recipient"] as? String { svc.recipients = [r] }
        if let r = action["recipients"] as? [String] { svc.recipients = r }
        if let s = action["subject"] as? String { svc.subject = s }
    }
}


// Retains the native delegate and items until a real terminal callback.
// The client reply is consumed once, including when it times out.
final class ShareRequest: NSObject, NSSharingServiceDelegate, @unchecked Sendable {
    let service: NSSharingService
    private let items: [Any]
    private let identifier: String
    private var completion: (@Sendable ([String: Any]) -> Void)?
    private let retired: () -> Void
    private var terminal = false
    init(service: NSSharingService, items: [Any], identifier: String, completion: @escaping @Sendable ([String: Any]) -> Void, retired: @escaping () -> Void) {
        self.service = service; self.items = items; self.identifier = identifier; self.completion = completion; self.retired = retired
    }
    private func reply(_ value: [String: Any]) { let callback = completion; completion = nil; callback?(value) }
    func deadline() {
        guard !terminal else { return }
        reply(WireFormat.failure("timeout_unknown_outcome", "share: native completion exceeded 55 seconds; outcome remains unknown, no operation was replayed and native admission remains occupied until completion"))
    }
    func failed(_ error: any Error) {
        guard !terminal else { return }; terminal = true
        let native = error as NSError
        reply(WireFormat.failure("provider_failed", "share: " + String(native.localizedDescription.prefix(4096)), details: ["nativeDomain": native.domain, "nativeCode": native.code]))
        service.delegate = nil; retired()
    }
    func sharingService(_ sharingService: NSSharingService, didFailToShareItems items: [Any], error: any Error) {
        guard sharingService === service else { return }
        failed(error)
    }
    func sharingService(_ sharingService: NSSharingService, didShareItems items: [Any]) {
        guard sharingService === service else { return }
        guard !terminal else { return }; terminal = true
        let data: [String: Any] = ["ok": true, "service": identifier, "items": items.map { String(describing: $0) }, "recipients": service.recipients ?? [], "subject": service.subject as Any? ?? NSNull(), "outcome": "shared"]
        if let bytes = try? JSONSerialization.data(withJSONObject: data), bytes.count <= 1048576,
           (try? JSONDecoder().decode(DesktopShareCompleted.self, from: bytes)) != nil {
            reply(WireFormat.success(data))
        } else { reply(WireFormat.failure("partial_result", "share: native completion metadata exceeds contract bounds after effect")) }
        service.delegate = nil; retired()
    }
}
