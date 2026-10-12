// NotificationsDomain. Extends the original
// DistributedNotificationCenter tail/log verbs with the full UNUserNotificationCenter
// surface (post / schedule-* / pending / delivered / dismiss / categories /
// badge). Dispatch invariant: read action["sub"].

import Foundation
import UserNotifications

final class NotificationsDomain: NSObject, DomainHandler, UNUserNotificationCenterDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var captured: [[String: Any]] = []
    private var observers: [String: NSObjectProtocol] = [:]
    private var capturedBytes = 0
    private let categoryMutation = DispatchSemaphore(value: 1)
    private let requestMutation = DispatchSemaphore(value: 1)
    private let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let unVerbs: Set<String> = [
        "status","request","settings","post","schedule-after","schedule-at",
        "schedule-cron","cancel","cancel-all","pending","delivered","dismiss",
        "dismiss-all","categories","badge",
    ]

    deinit {
        for observer in observers.values { DistributedNotificationCenter.default().removeObserver(observer) }
    }

    func startNativeResponseObservation() {
        if Self.hasAppBundle { unCenter().delegate = self }
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if action["type"] as? String == "desktop_notifications" {
            handleNeutral(action, completion: completion)
            return
        }
        let sub = action["sub"] as? String ?? command
        // DistributedNotificationCenter verbs work in any process — never gate.
        switch sub {
        case "tail": startTailing(action, completion: completion); return
        case "untail":
            guard let name = action["name"] as? String, !name.isEmpty,
                  name.utf8.count <= 512, !name.utf8.contains(0) else {
                completion(["success": false, "code": "invalid_request", "error": "notifications.untail requires --name <exact distributed notification name>"])
                return
            }
            lock.lock()
            let observer = observers.removeValue(forKey: observerKey(action, name: name))
            if let observer { DistributedNotificationCenter.default().removeObserver(observer) }
            lock.unlock()
            completion(WireFormat.success(["tailing": false, "name": name, "removed": observer != nil]))
            return
        case "log":  getLog(action, completion: completion); return
        default: break
        }
        // Unknown sub — surface the standard error before any bundle gate.
        guard Self.unVerbs.contains(sub) else {
            completion(WireFormat.error("notifications.\(sub) — unknown verb"))
            return
        }
        // The native initializer raises an Objective-C exception, which Swift
        // cannot catch. Validate before both the bundle gate and initializer.
        if sub == "schedule-after", action["repeats"] as? Bool == true,
           let seconds = action["seconds"] as? Int, seconds > 0, seconds < 60 {
            completion(WireFormat.error("notifications.schedule-after: repeating intervals require at least 60 seconds"))
            return
        }
        // UNUserNotificationCenter requires a registered .app bundle. Calling
        // current() in xctest aborts the process — return a structured error.
        guard Self.hasAppBundle else {
            switch sub {
            case "schedule-after":
                if (action["seconds"] as? Int) == nil {
                    completion(WireFormat.error("notifications.schedule-after: --seconds <N> required"))
                    return
                }
            case "schedule-at":
                if (action["date"] as? String) == nil {
                    completion(WireFormat.error("notifications.schedule-at: --date <ISO8601> required"))
                    return
                }
            case "schedule-cron":
                if (action["components"] as? String) == nil {
                    completion(WireFormat.error("notifications.schedule-cron: --components key=val[,key=val] required"))
                    return
                }
            case "cancel":
                if (action["id"] as? String) == nil {
                    completion(WireFormat.error("notifications.cancel: <identifier> required"))
                    return
                }
            case "dismiss":
                if (action["id"] as? String) == nil {
                    completion(WireFormat.error("notifications.dismiss: <identifier> required"))
                    return
                }
            case "categories":
                if (action["verb"] as? String) == "register" {
                    completion(WireFormat.error("notifications.categories.register: --identifier and --actions <json> required"))
                    return
                }
            default: break
            }
            completion(WireFormat.error("notifications: UNUserNotificationCenter requires a registered .app bundle. Run inside the bridge bundle (`/Applications/Interceptor.app`), not the test runner."))
            return
        }
        switch sub {
        case "status":           unStatus(completion: completion)
        case "request":          unRequest(action, completion: completion)
        case "settings":         unSettings(completion: completion)
        case "post":             unPost(action, completion: completion)
        case "schedule-after":   unScheduleAfter(action, completion: completion)
        case "schedule-at":      unScheduleAt(action, completion: completion)
        case "schedule-cron":    unScheduleCron(action, completion: completion)
        case "cancel":           unCancel(action, completion: completion)
        case "cancel-all":       unCancelAll(completion: completion)
        case "pending":          unPending(completion: completion)
        case "delivered":        unDelivered(completion: completion)
        case "dismiss":          unDismiss(action, completion: completion)
        case "dismiss-all":      unDismissAll(completion: completion)
        case "categories":       unCategories(action, completion: completion)
        case "badge":            unBadge(action, completion: completion)
        default:                 completion(WireFormat.error("notifications.\(sub) — unknown verb"))
        }
    }

    // MARK: - DistributedNotificationCenter (existing)

    private func startTailing(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        // An unfiltered subscription acknowledged registration but delivered
        // no cross-process events on the qualified macOS 27 host. Exact names
        // deliver. Do not describe that empty subscription as active capture.
        guard let name = action["name"] as? String, !name.isEmpty else {
            completion(["success": false, "code": "unsupported_operation",
                        "error": "notifications.tail requires --name <exact distributed notification name>; unfiltered delivery is unavailable on the qualified host"])
            return
        }
        guard name.utf8.count <= 512, !name.utf8.contains(0) else {
            completion(["success": false, "code": "invalid_request", "error": "notification name requires 1...512 UTF-8 bytes without NUL"])
            return
        }
        lock.lock()
        let key = observerKey(action, name: name)
        if observers[key] == nil {
            guard observers.count < 32 else {
                lock.unlock()
                completion(["success": false, "code": action["_namespace"] == nil ? "invalid_request" : "resource_limit", "error": "notification tail supports at most 32 exact names per provider"])
                return
            }
            let namespace = action["_namespace"] as? String
            observers[key] = DistributedNotificationCenter.default().addObserver(
                forName: Notification.Name(name), object: nil, queue: nil
            ) { [weak self] notification in
                let object = notification.object as? String ?? ""
                let snapshot = String(decoding: object.utf8.prefix(2045), as: UTF8.self)
                let sanitized = snapshot.replacingOccurrences(of: "\0", with: "�")
                let boundedObject = String(decoding: sanitized.utf8.prefix(2045), as: UTF8.self)
                var entry: [String: Any] = [
                    "name": notification.name.rawValue,
                    "object": boundedObject,
                    "timestamp": ISO8601DateFormatter().string(from: Date()),
                    "_truncated": object.utf8.count > 2045 || snapshot.contains("\0"),
                ]
                if let namespace { entry["_namespace"] = namespace }
                self?.appendCaptured(entry)
            }
        }
        lock.unlock()
        completion(WireFormat.success(["tailing": true]))
    }

    private func getLog(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let limit = action["limit"] as? Int ?? 50
        guard (0...1000).contains(limit) else {
            completion(WireFormat.error("notifications.log: limit must be in 0...1000"))
            return
        }
        let appFilter = action["app"] as? String
        lock.lock()
        let namespace = action["_namespace"] as? String
        var results = Array(captured.filter { ($0["_namespace"] as? String) == namespace }.suffix(limit))
        lock.unlock()
        if let appFilter = appFilter {
            results = results.filter { entry in
                (entry["object"] as? String)?.contains(appFilter) == true ||
                (entry["name"] as? String)?.contains(appFilter) == true
            }
        }
        if namespace == nil { results = results.map { $0.filter { !$0.key.hasPrefix("_") } } }
        completion(WireFormat.success(results))
    }

    // MARK: - UNUserNotificationCenter

    /// `UNUserNotificationCenter.current()` raises NSInternalInconsistencyException
    /// when the host process isn't inside a real `.app` bundle. xctest's host
    /// bundle has a bundleIdentifier (`com.apple.dt.xctest.tool`) but is NOT a
    /// `.app`, and UN center init aborts the process. Detect both conditions
    /// up front so the bridge surfaces a structured error instead of crashing.
    static var hasAppBundle: Bool {
        guard Bundle.main.bundleIdentifier != nil else { return false }
        // xctest sets XCTestConfigurationFilePath; treat that as "no app bundle".
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil { return false }
        // Host bundle path must end in .app for UN center to be safe.
        return Bundle.main.bundlePath.hasSuffix(".app")
    }

    private func unCenter() -> UNUserNotificationCenter { UNUserNotificationCenter.current() }

    private func unGuard(_ completion: @escaping @Sendable ([String: Any]) -> Void) -> Bool {
        if !Self.hasAppBundle {
            completion(WireFormat.error("notifications: UNUserNotificationCenter requires a registered .app bundle. Run inside the bridge bundle (`/Applications/Interceptor.app`), not the test runner."))
            return false
        }
        return true
    }

    private func unStatus(completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard unGuard(completion) else { return }
        unCenter().getNotificationSettings { settings in
            completion(WireFormat.success([
                "status": self.statusString(settings.authorizationStatus),
                "alertSetting": self.settingString(settings.alertSetting),
                "soundSetting": self.settingString(settings.soundSetting),
                "badgeSetting": self.settingString(settings.badgeSetting),
                "lockScreenSetting": self.settingString(settings.lockScreenSetting),
                "notificationCenterSetting": self.settingString(settings.notificationCenterSetting),
                "criticalAlertSetting": self.settingString(settings.criticalAlertSetting),
                "alertStyle": NativeNames.name(settings.alertStyle.rawValue, NativeNames.alertStyle),
                "showsPreviews": NativeNames.name(settings.showPreviewsSetting.rawValue, NativeNames.previews),
                "providesAppNotificationSettings": settings.providesAppNotificationSettings,
                "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
            ]))
        }
    }

    private func statusString(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .denied:        return "denied"
        case .authorized:    return "authorized"
        case .provisional:   return "provisional"
        case .ephemeral:     return "ephemeral"
        @unknown default:    return "unknown"
        }
    }

    private func settingString(_ s: UNNotificationSetting) -> String {
        switch s {
        case .enabled: return "enabled"
        case .disabled: return "disabled"
        case .notSupported: return "notSupported"
        @unknown default: return "unknown"
        }
    }

    private func unRequest(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard unGuard(completion) else { return }
        var options: UNAuthorizationOptions = []
        let raw = (action["options"] as? String) ?? "alert,sound,badge"
        for opt in raw.split(separator: ",") {
            switch opt.trimmingCharacters(in: .whitespaces) {
            case "alert": options.insert(.alert)
            case "sound": options.insert(.sound)
            case "badge": options.insert(.badge)
            case "criticalAlert": options.insert(.criticalAlert)
            case "provisional": options.insert(.provisional)
            case "providesAppNotificationSettings": options.insert(.providesAppNotificationSettings)
            default: break
            }
        }
        // A permission request does not authorize moving the user's focus.
        // Let the OS determine whether and how its authorization UI appears.
        let center = unCenter()
        center.requestAuthorization(options: options) { granted, error in
            // Enabled feature toggles and the actual authorization response
            // are independent observations. Do not turn a denial into a grant.
            center.getNotificationSettings { settings in
                let perFeatureEnabled =
                    settings.alertSetting == .enabled ||
                    settings.soundSetting == .enabled ||
                    settings.badgeSetting == .enabled ||
                    settings.notificationCenterSetting == .enabled
                var resp: [String: Any] = [
                    "granted": granted,
                    "authorizationStatus": self.statusString(settings.authorizationStatus),
                    "perFeatureSettingsEnabled": perFeatureEnabled,
                    "options": Array(raw.split(separator: ",").map(String.init)),
                ]
                if let error = error {
                    resp["error"] = error.localizedDescription
                } else {
                    resp["error"] = NSNull()
                }
                if !granted && perFeatureEnabled {
                    resp["note"] = "Authorization was denied while some feature settings are enabled. A native delivery result must be checked separately."
                } else if !granted {
                    resp["note"] = "Notifications denied. Open System Settings → Notifications → interceptor-bridge to grant alert/sound/badge."
                }
                completion(WireFormat.success(resp))
            }
        }
    }

    private func unSettings(completion: @escaping @Sendable ([String: Any]) -> Void) {
        unStatus(completion: completion) // identical surface
    }

    private func buildContent(_ action: [String: Any]) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        if let title = action["title"] as? String { content.title = title }
        if let subtitle = action["subtitle"] as? String { content.subtitle = subtitle }
        if let body = action["body"] as? String { content.body = body }
        if let sound = action["sound"] as? String {
            switch sound {
            case "default": content.sound = .default
            case "critical":
                if #available(macOS 12, *) { content.sound = .defaultCritical }
            default:
                content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: sound))
            }
        }
        if let badge = action["badge"] as? Int { content.badge = NSNumber(value: badge) }
        if let cat = action["category"] as? String { content.categoryIdentifier = cat }
        if let thread = action["thread"] as? String { content.threadIdentifier = thread }
        if let userInfoStr = action["user_info"] as? String,
           let data = userInfoStr.data(using: .utf8),
           let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            content.userInfo = dict
        }
        if #available(macOS 12, *), let level = action["interruption"] as? String {
            switch level {
            case "active": content.interruptionLevel = .active
            case "passive": content.interruptionLevel = .passive
            case "timeSensitive": content.interruptionLevel = .timeSensitive
            default: break
            }
        }
        if let attachStr = action["attachment"] as? String {
            for raw in attachStr.split(separator: ",") {
                let parts = raw.split(separator: "=", maxSplits: 1)
                let id = parts.count == 2 ? String(parts[0]) : "att-\(UUID().uuidString.prefix(8))"
                let path = parts.count == 2 ? String(parts[1]) : String(raw)
                let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
                // The system moves an attached file into its own store, so attach a private copy, never the user's file.
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent("interceptor-attachment-\(UUID().uuidString)", isDirectory: true)
                let copy = folder.appendingPathComponent(url.lastPathComponent)
                if (try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)) != nil,
                   (try? FileManager.default.copyItem(at: url, to: copy)) != nil,
                   let attachment = try? UNNotificationAttachment(identifier: id, url: copy) {
                    content.attachments.append(attachment)
                } else {
                    try? FileManager.default.removeItem(at: folder)
                }
            }
        }
        return content
    }

    private func add(_ request: UNNotificationRequest, trigger: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard unGuard(completion) else { return }
        let identifier = request.identifier
        let categoryId = request.content.categoryIdentifier
        let center = unCenter()
        // Same as the desktop path: never report a post macOS will not show.
        center.getNotificationSettings { settings in
            if settings.authorizationStatus == .denied { completion(WireFormat.failure("permission_denied", "notifications are off for interceptor-bridge in System Settings > Notifications; nothing was posted")); return }
            if settings.authorizationStatus == .notDetermined { completion(WireFormat.failure("permission_required", "interceptor-bridge has not been allowed to post notifications yet; run notifications request first; nothing was posted")); return }
            center.add(request) { error in
                if let error = error {
                    completion(WireFormat.error("notifications: \(error.localizedDescription)"))
                } else {
                    completion(WireFormat.success([
                        "ok": true,
                        "identifier": identifier,
                        "trigger": trigger,
                        "categoryIdentifier": categoryId,
                    ]))
                }
            }
        }
    }

    private func unPost(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let content = buildContent(action)
        let identifier = (action["id"] as? String) ?? "interceptor-\(UUID().uuidString)"
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
        add(request, trigger: ["type": "timeInterval", "seconds": 1, "repeats": false], completion: completion)
    }

    private func unScheduleAfter(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let seconds = action["seconds"] as? Int, seconds > 0 else {
            completion(WireFormat.error("notifications.schedule-after: --seconds <N> required")); return
        }
        let repeats = (action["repeats"] as? Bool) ?? false
        let content = buildContent(action)
        let identifier = (action["id"] as? String) ?? "interceptor-\(UUID().uuidString)"
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: TimeInterval(seconds), repeats: repeats)
        let req = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
        add(req, trigger: ["type": "timeInterval", "seconds": seconds, "repeats": repeats], completion: completion)
    }

    private func unScheduleAt(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let dateStr = action["date"] as? String,
              let date = isoFormatter.date(from: dateStr) ?? ISO8601DateFormatter().date(from: dateStr)
        else { completion(WireFormat.error("notifications.schedule-at: --date <ISO8601> required")); return }
        let repeats = (action["repeats"] as? Bool) ?? false
        let content = buildContent(action)
        let identifier = (action["id"] as? String) ?? "interceptor-\(UUID().uuidString)"
        let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: repeats)
        let req = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
        var componentsDict: [String: Any] = [:]
        if let y = comps.year { componentsDict["year"] = y } else { componentsDict["year"] = NSNull() }
        if let m = comps.month { componentsDict["month"] = m } else { componentsDict["month"] = NSNull() }
        if let d = comps.day { componentsDict["day"] = d } else { componentsDict["day"] = NSNull() }
        if let h = comps.hour { componentsDict["hour"] = h } else { componentsDict["hour"] = NSNull() }
        if let mi = comps.minute { componentsDict["minute"] = mi } else { componentsDict["minute"] = NSNull() }
        add(req, trigger: ["type": "calendar", "components": componentsDict, "repeats": repeats], completion: completion)
    }

    private func unScheduleCron(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let raw = action["components"] as? String else {
            completion(WireFormat.error("notifications.schedule-cron: --components key=val[,key=val] required")); return
        }
        var comps = DateComponents()
        for entry in raw.split(separator: ",") {
            let parts = entry.split(separator: "=", maxSplits: 1)
            guard parts.count == 2, let v = Int(parts[1]) else { continue }
            switch String(parts[0]).trimmingCharacters(in: .whitespaces) {
            case "year": comps.year = v
            case "month": comps.month = v
            case "day": comps.day = v
            case "weekday": comps.weekday = v
            case "hour": comps.hour = v
            case "minute": comps.minute = v
            case "second": comps.second = v
            default: break
            }
        }
        let repeats = (action["repeats"] as? Bool) ?? true
        let content = buildContent(action)
        let identifier = (action["id"] as? String) ?? "interceptor-\(UUID().uuidString)"
        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: repeats)
        let req = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
        add(req, trigger: ["type": "calendar", "raw_components": raw, "repeats": repeats], completion: completion)
    }

    private func unCancel(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else {
            completion(WireFormat.error("notifications.cancel: <identifier> required")); return
        }
        guard unGuard(completion) else { return }
        unCenter().removePendingNotificationRequests(withIdentifiers: [id])
        completion(WireFormat.success(["ok": true, "id": id]))
    }

    private func unCancelAll(completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard unGuard(completion) else { return }
        unCenter().removeAllPendingNotificationRequests()
        completion(WireFormat.success(["ok": true]))
    }

    private func unPending(completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard unGuard(completion) else { return }
        unCenter().getPendingNotificationRequests { requests in
            let arr = requests.map { self.requestDict($0) }
            completion(WireFormat.success(["requests": arr]))
        }
    }

    private func unDelivered(completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard unGuard(completion) else { return }
        unCenter().getDeliveredNotifications { delivered in
            let arr = delivered.map { d -> [String: Any] in
                var e = self.requestDict(d.request)
                e["deliveryDate"] = self.isoFormatter.string(from: d.date)
                return e
            }
            completion(WireFormat.success(["delivered": arr]))
        }
    }

    private func requestDict(_ request: UNNotificationRequest) -> [String: Any] {
        var entry: [String: Any] = [
            "identifier": request.identifier,
            "title": request.content.title,
            "subtitle": request.content.subtitle,
            "body": request.content.body,
            "categoryIdentifier": request.content.categoryIdentifier,
            "threadIdentifier": request.content.threadIdentifier,
            "userInfo": request.content.userInfo,
        ]
        if let badge = request.content.badge { entry["badge"] = badge.intValue }
        entry["sound"] = request.content.sound != nil ? "set" : NSNull()
        if #available(macOS 12, *) {
            entry["interruptionLevel"] = NativeNames.name(Int(request.content.interruptionLevel.rawValue), NativeNames.interruption)
        }
        if let trig = request.trigger {
            var t: [String: Any] = ["repeats": trig.repeats]
            if let ti = trig as? UNTimeIntervalNotificationTrigger {
                t["type"] = "timeInterval"
                t["seconds"] = ti.timeInterval
            } else if let cal = trig as? UNCalendarNotificationTrigger {
                t["type"] = "calendar"
                t["nextTriggerDate"] = cal.nextTriggerDate().map { isoFormatter.string(from: $0) } as Any? ?? NSNull()
            } else {
                t["type"] = String(describing: type(of: trig))
            }
            entry["trigger"] = t
        }
        entry["attachments"] = request.content.attachments.map { att -> [String: Any] in
            ["identifier": att.identifier, "url": att.url.absoluteString, "type": att.type as Any? ?? NSNull()]
        }
        return entry
    }

    private func unDismiss(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else {
            completion(WireFormat.error("notifications.dismiss: <identifier> required")); return
        }
        guard unGuard(completion) else { return }
        unCenter().removeDeliveredNotifications(withIdentifiers: [id])
        completion(WireFormat.success(["ok": true, "id": id]))
    }

    private func unDismissAll(completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard unGuard(completion) else { return }
        unCenter().removeAllDeliveredNotifications()
        completion(WireFormat.success(["ok": true]))
    }

    private func unCategories(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard unGuard(completion) else { return }
        let verb = (action["verb"] as? String) ?? (action["sub2"] as? String) ?? "list"
        switch verb {
        case "list":
            unCenter().getNotificationCategories { cats in
                let arr = cats.map { c -> [String: Any] in
                    [
                        "identifier": c.identifier,
                        "actions": c.actions.map { ["identifier": $0.identifier, "title": $0.title] },
                        "intentIdentifiers": c.intentIdentifiers,
                        "options": c.options.rawValue,
                    ]
                }
                completion(WireFormat.success(["categories": arr]))
            }
        case "register":
            guard let id = action["identifier"] as? String,
                  let actionsJson = action["actions"] as? String,
                  let data = actionsJson.data(using: .utf8),
                  let actionsArr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
            else { completion(WireFormat.error("notifications.categories.register: --identifier and --actions <json> required")); return }
            let unActions: [UNNotificationAction] = actionsArr.compactMap { dict in
                guard let aId = dict["identifier"] as? String, let title = dict["title"] as? String else { return nil }
                var opts: UNNotificationActionOptions = []
                if let raw = dict["options"] as? [String] {
                    if raw.contains("foreground") { opts.insert(.foreground) }
                    if raw.contains("destructive") { opts.insert(.destructive) }
                    if raw.contains("authenticationRequired") { opts.insert(.authenticationRequired) }
                }
                return UNNotificationAction(identifier: aId, title: title, options: opts)
            }
            let intentIds = (action["intent_identifiers"] as? String)?.split(separator: ",").map(String.init) ?? []
            let cat = UNNotificationCategory(identifier: id, actions: unActions, intentIdentifiers: intentIds)
            unCenter().setNotificationCategories(Set([cat]))
            completion(WireFormat.success(["ok": true, "identifier": id]))
        case "clear":
            unCenter().setNotificationCategories(Set<UNNotificationCategory>())
            completion(WireFormat.success(["ok": true]))
        default:
            completion(WireFormat.error("notifications.categories: unknown verb \(verb)"))
        }
    }

    private func unBadge(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard unGuard(completion) else { return }
        let count = (action["count"] as? Int) ?? (action["clear"] as? Bool == true ? 0 : 0)
        if #available(macOS 13, *) {
            unCenter().setBadgeCount(count) { error in
                if let error = error { completion(WireFormat.error("notifications.badge: \(error.localizedDescription)")) }
                else { completion(WireFormat.success(["ok": true, "count": count])) }
            }
        } else {
            completion(WireFormat.success(["ok": true, "count": count, "note": "setBadgeCount requires macOS 13+"]))
        }
    }
}

extension NotificationsDomain {
    private func observerKey(_ action: [String: Any], name: String) -> String {
        guard let namespace = action["_namespace"] as? String else { return name }
        return "\0" + namespace + ":" + name
    }
    private func appendCaptured(_ entry: [String: Any]) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: entry).count, bytes < DESKTOP_NOTIFICATION_MAX_RESULT_BYTES else { return }
        lock.lock(); defer { lock.unlock() }
        captured.append(entry); capturedBytes += bytes + 1
        // ponytail: bounded1000-row array; replace with a deque if measured event throughput requires it.
        while captured.count > DESKTOP_NOTIFICATION_MAX_ENTRIES || capturedBytes + 2 > DESKTOP_NOTIFICATION_MAX_RESULT_BYTES {
            capturedBytes -= (try? JSONSerialization.data(withJSONObject: captured.removeFirst()).count).map { $0 + 1 } ?? 0
        }
    }
    private func record(_ namespace: String, kind: String, identifier: String, actionIdentifier: String? = nil) {
        var row: [String: Any] = ["_namespace": namespace, "kind": kind, "identifier": identifier, "timestamp": ISO8601DateFormatter().string(from: Date()), "_truncated": false]
        if let actionIdentifier { row["actionIdentifier"] = actionIdentifier }
        appendCaptured(row)
    }
    private func prefix(_ namespace: String) -> String { "interceptor.notifications.v1." + namespace + "." }
    private func owner(_ identifier: String) -> (String, String)? {
        let root = "interceptor.notifications.v1."
        guard identifier.hasPrefix(root), let separator = identifier.dropFirst(root.count).firstIndex(of: ".") else { return nil }
        let namespace = String(identifier[identifier.index(identifier.startIndex, offsetBy: root.count)..<separator])
        let publicID = String(identifier[identifier.index(after: separator)...])
        guard namespace.range(of: "^[a-zA-Z0-9_-]{1,64}$", options: .regularExpression) != nil, DesktopNotificationsValidation.identifier(publicID) else { return nil }
        return (namespace, publicID)
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let (namespace, id) = owner(response.notification.request.identifier) {
            record(namespace, kind: response.actionIdentifier == UNNotificationDismissActionIdentifier ? "dismissed" : "activated", identifier: id, actionIdentifier: response.actionIdentifier)
        }
        completionHandler()
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // Native presentation is allowed for an explicitly posted notification;
        // it does not authorize application activation or a focus change.
        completionHandler([.banner, .list, .sound, .badge])
    }
    private func neutralEntry(_ request: UNNotificationRequest, namespace: String, deliveryDate: Date? = nil) -> [String: Any] {
        var row = requestDict(request)
        row["nativeIdentifier"] = request.identifier
        row["identifier"] = String(request.identifier.dropFirst(prefix(namespace).count))
        row["categoryIdentifier"] = request.content.categoryIdentifier.hasPrefix(prefix(namespace)) ? String(request.content.categoryIdentifier.dropFirst(prefix(namespace).count)) : request.content.categoryIdentifier
        row["userInfoJSON"] = (try? JSONSerialization.data(withJSONObject: request.content.userInfo, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        row.removeValue(forKey: "userInfo")
        if let date = deliveryDate { row["deliveryDate"] = isoFormatter.string(from: date) }
        if let calendar = request.trigger as? UNCalendarNotificationTrigger {
            var trigger = row["trigger"] as? [String: Any] ?? [:]
            let c = calendar.dateComponents
            var components: [String: Int] = [:]
            for (key, value) in [("year", c.year), ("month", c.month), ("day", c.day), ("weekday", c.weekday), ("hour", c.hour), ("minute", c.minute), ("second", c.second)] { if let value { components[key] = value } }
            trigger["components"] = components; row["trigger"] = trigger
        }
        return row
    }
    private func neutralInventory(_ namespace: String, limit: Int, delivered: Bool, completion: @escaping @Sendable ([String: Any]) -> Void) {
        let finish: @Sendable ([[String: Any]]) -> Void = { entries in
            var rows = Array(entries.sorted { ($0["identifier"] as? String ?? "") < ($1["identifier"] as? String ?? "") }.prefix(limit))
            func data() -> [String: Any] { ["entries": rows, "namespace": namespace, "coverage": delivered ? "native-delivered" : "native-pending", "partial": rows.count < entries.count] }
            while (try? JSONSerialization.data(withJSONObject: data()).count) ?? Int.max > DESKTOP_NOTIFICATION_MAX_RESULT_BYTES, !rows.isEmpty { rows.removeLast() }
            completion(WireFormat.success(data()))
        }
        if delivered {
            unCenter().getDeliveredNotifications { values in finish(values.filter { $0.request.identifier.hasPrefix(self.prefix(namespace)) }.map { self.neutralEntry($0.request, namespace: namespace, deliveryDate: $0.date) }) }
        } else {
            unCenter().getPendingNotificationRequests { values in finish(values.filter { $0.identifier.hasPrefix(self.prefix(namespace)) }.map { self.neutralEntry($0, namespace: namespace) }) }
        }
    }
    private func neutralRemove(_ action: [String: Any], namespace: String, completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as! String, delivered = sub.hasPrefix("dismiss"), id = action["id"] as? String
        let all = id == nil, deadline = DispatchTime.now().uptimeNanoseconds + 3_000_000_000
        let inventory: @Sendable (@escaping @Sendable ([String]) -> Void) -> Void = { next in
            if delivered { self.unCenter().getDeliveredNotifications { next($0.map { $0.request.identifier }.filter { $0.hasPrefix(self.prefix(namespace)) }) } }
            else { self.unCenter().getPendingNotificationRequests { next($0.map(\.identifier).filter { $0.hasPrefix(self.prefix(namespace)) }) } }
        }
        inventory { before in
            guard before.count <= DESKTOP_NOTIFICATION_MAX_ENTRIES else { completion(DesktopNotificationsValidation.failure("resource_limit", "owned notification inventory exceeds 1000 entries")); return }
            let targets = before.filter { all || $0 == self.prefix(namespace) + id! }
            if delivered { self.unCenter().removeDeliveredNotifications(withIdentifiers: targets) } else { self.unCenter().removePendingNotificationRequests(withIdentifiers: targets) }
            @Sendable func poll() {
                inventory { after in
                    if !Set(targets).isDisjoint(with: Set(after)) {
                        if DispatchTime.now().uptimeNanoseconds >= deadline { completion(DesktopNotificationsValidation.failure("timeout_unknown_outcome", "native removal was requested but not confirmed; observe before retrying")); return }
                        DispatchQueue.global().asyncAfter(deadline: .now() + 0.02, execute: poll); return
                    }
                    let removed = targets.map { String($0.dropFirst(self.prefix(namespace).count)) }
                    for publicID in removed { self.record(namespace, kind: delivered ? "dismissed" : "cancelled", identifier: publicID) }
                    var data: [String: Any] = ["ok": true, "removed": removed, "remaining": after.count]
                    if let id { data["id"] = id }; completion(WireFormat.success(data))
                }
            }
            poll()
        }
    }
    private func neutralCategories(_ action: [String: Any], namespace: String, completion: @escaping @Sendable ([String: Any]) -> Void) {
        let verb = action["verb"] as? String ?? "list", center = unCenter()
        guard verb == "list" || categoryMutation.wait(timeout: .now()) == .success else { completion(DesktopNotificationsValidation.failure("resource_limit", "another category mutation is pending")); return }
        center.getNotificationCategories { categories in
            let owned = categories.filter { $0.identifier.hasPrefix(self.prefix(namespace)) }
            if verb == "list" {
                guard owned.count <= DESKTOP_NOTIFICATION_MAX_CATEGORIES else { completion(DesktopNotificationsValidation.failure("resource_limit", "owned category inventory exceeds 64 entries")); return }
                let rows = owned.sorted { $0.identifier < $1.identifier }.map { category -> [String: Any] in
                    ["identifier": String(category.identifier.dropFirst(self.prefix(namespace).count)), "actions": category.actions.map { a -> [String: Any] in
                        var options: [String] = []; if a.options.contains(.foreground) { options.append("foreground") }; if a.options.contains(.destructive) { options.append("destructive") }; if a.options.contains(.authenticationRequired) { options.append("authenticationRequired") }
                        return ["identifier": a.identifier, "title": a.title, "options": options]
                    }, "intentIdentifiers": category.intentIdentifiers, "options": category.options.rawValue,
                        "summaryFormat": category.categorySummaryFormat, "hiddenPlaceholder": category.hiddenPreviewsBodyPlaceholder]
                }
                completion(WireFormat.success(["categories": rows, "namespace": namespace])); return
            }
            var merged = categories
            if verb == "clear" { merged = Set(categories.filter { !$0.identifier.hasPrefix(self.prefix(namespace)) }) }
            else {
                let identifier = action["identifier"] as! String, nativeID = self.prefix(namespace) + identifier
                guard owned.count < DESKTOP_NOTIFICATION_MAX_CATEGORIES || owned.contains(where: { $0.identifier == nativeID }) else { self.categoryMutation.signal(); completion(DesktopNotificationsValidation.failure("resource_limit", "owned category limit 64 reached")); return }
                let actions = try! DesktopNotificationsValidation.actions(action["actions"] as! String).map { definition -> UNNotificationAction in
                    var options: UNNotificationActionOptions = []; let raw = definition.options?.map(\.rawValue) ?? []
                    if raw.contains("foreground") { options.insert(.foreground) }; if raw.contains("destructive") { options.insert(.destructive) }; if raw.contains("authenticationRequired") { options.insert(.authenticationRequired) }
                    return UNNotificationAction(identifier: definition.identifier, title: definition.title, options: options)
                }
                merged = Set(categories.filter { $0.identifier != nativeID })
                merged.insert(UNNotificationCategory(identifier: nativeID, actions: actions, intentIdentifiers: (action["intent_identifiers"] as? String)?.components(separatedBy: ",") ?? [], hiddenPreviewsBodyPlaceholder: action["hidden_placeholder"] as? String, categorySummaryFormat: action["summary_format"] as? String, options: [.customDismissAction]))
            }
            center.setNotificationCategories(merged)
            let expected = Set(merged.map(\.identifier))
            center.getNotificationCategories { after in
                self.categoryMutation.signal()
                guard Set(after.map(\.identifier)) == expected else { completion(DesktopNotificationsValidation.failure("timeout_unknown_outcome", "native category mutation readback differs; observe before retrying")); return }
                var result: [String: Any] = ["ok": true, "remaining": after.filter { $0.identifier.hasPrefix(self.prefix(namespace)) }.count]
                if verb == "register" { result["identifier"] = action["identifier"] }; completion(WireFormat.success(result))
            }
        }
    }
    private func handleNeutral(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let error = DesktopNotificationsValidation.validate(action) { completion(error); return }
        let sub = action["sub"] as! String, namespace = action["namespace"] as? String ?? "default"
        if ["tail", "untail", "log"].contains(sub) {
            let name = action["name"] as? String
            var legacy = action; legacy["type"] = "macos_notifications"; legacy["_namespace"] = namespace
            handle("notifications", action: legacy) { result in
                guard result["success"] as? Bool == true else { completion(result); return }
                if sub != "log" { var data = result["data"] as? [String: Any] ?? [:]; data["name"] = name; completion(WireFormat.success(data)); return }
                var rows = (result["data"] as? [[String: Any]] ?? []).map { entry -> [String: Any] in
                    var row = entry.filter { !$0.key.hasPrefix("_") }; row["kind"] = entry["kind"] ?? "distributed"; row["truncated"] = entry["_truncated"] ?? false; return row
                }
                func data() -> [String: Any] { ["entries": rows, "namespace": namespace, "coverage": "owned-events"] }
                while (try? JSONSerialization.data(withJSONObject: data()).count) ?? Int.max > DESKTOP_NOTIFICATION_MAX_RESULT_BYTES, !rows.isEmpty { rows.removeFirst() }
                completion(WireFormat.success(data()))
            }; return
        }
        guard Self.hasAppBundle else { completion(DesktopNotificationsValidation.failure("unsupported_target", "notifications require the registered installed bridge app bundle")); return }
        if sub == "post" || sub.hasPrefix("schedule-") || sub == "categories" && action["verb"] as? String == "register" { unCenter().delegate = self }
        switch sub {
        case "status", "settings":
            unStatus { result in
                guard let r = result["data"] as? [String: Any] else { completion(result); return }
                var settings: [String: Any] = [:]
                for key in ["alert", "sound", "badge", "lockScreen", "notificationCenter", "criticalAlert"] { settings[key] = r[key + "Setting"] }
                completion(WireFormat.success(["status": r["status"]!, "settings": settings, "provider": "UNUserNotificationCenter", "scope": "application", "namespace": namespace]))
            }
        case "request":
            unRequest(action) { result in
                guard let r = result["data"] as? [String: Any] else { completion(result); return }
                var data = r.filter { ["granted", "authorizationStatus", "perFeatureSettingsEnabled", "options", "error"].contains($0.key) }
                data["options"] = (r["options"] as? [String] ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                if let error = r["error"] as? String { data["error"] = String(decoding: error.utf8.prefix(4093), as: UTF8.self) }
                completion(WireFormat.success(data))
            }
        case "pending", "delivered": neutralInventory(namespace, limit: (action["limit"] as? NSNumber)?.intValue ?? 100, delivered: sub == "delivered", completion: completion)
        case "cancel", "cancel-all", "dismiss", "dismiss-all": neutralRemove(action, namespace: namespace, completion: completion)
        case "categories": neutralCategories(action, namespace: namespace, completion: completion)
        case "badge":
            guard #available(macOS 13, *) else { completion(DesktopNotificationsValidation.failure("unsupported_operation", "native badge mutation requires macOS 13 or later")); return }
            unBadge(action) { result in
                guard var data = result["data"] as? [String: Any] else { completion(result); return }; data["scope"] = "application"; data["presentation"] = "native-api-accepted"; completion(WireFormat.success(data))
            }
        default:
            if let category = action["category"] as? String {
                unCenter().getNotificationCategories { categories in
                    guard categories.contains(where: { $0.identifier == self.prefix(namespace) + category }) else { completion(DesktopNotificationsValidation.failure("unsupported_target", "notification category is not registered in the selected namespace; no notification posted")); return }
                    self.neutralPost(action, namespace: namespace, completion: completion)
                }
            } else { neutralPost(action, namespace: namespace, completion: completion) }
        }
    }
    private func neutralPost(_ action: [String: Any], namespace: String, completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as! String, id = action["id"] as? String ?? UUID().uuidString, center = unCenter()
        let nativeID = prefix(namespace) + id
        var bounded = action
        if let category = action["category"] as? String { bounded["category"] = prefix(namespace) + category }
        if let raw = action["attachment"] as? String {
            var total: UInt64 = 0
            for item in raw.components(separatedBy: ",") {
                let path = item.components(separatedBy: "=").last!
                guard let attributes = try? FileManager.default.attributesOfItem(atPath: path), attributes[.type] as? FileAttributeType == .typeRegular, let size = attributes[.size] as? NSNumber, size.uint64Value <= 16_777_216 else { completion(DesktopNotificationsValidation.failure("unsupported_target", "notification attachment must be a readable regular file of at most 16MiB")); return }
                total += size.uint64Value
            }
            guard total <= 33_554_432 else { completion(DesktopNotificationsValidation.failure("resource_limit", "notification attachments exceed 32MiB")); return }
        }
        let trigger: UNNotificationTrigger, description: [String: Any]
        switch sub {
        case "post": trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false); description = ["type": "immediate", "repeats": false]
        case "schedule-after":
            let seconds = (action["seconds"] as! NSNumber).intValue, repeats = action["repeats"] as? Bool ?? false
            trigger = UNTimeIntervalNotificationTrigger(timeInterval: Double(seconds), repeats: repeats); description = ["type": "timeInterval", "seconds": seconds, "repeats": repeats]
        case "schedule-at", "schedule-cron":
            let components: DateComponents
            if sub == "schedule-at" { components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: DesktopLogValidation.timestamp(action["date"] as! String)!) }
            else { components = try! DesktopNotificationsValidation.components(action["components"] as! String) }
            let repeats = action["repeats"] as? Bool ?? (sub == "schedule-cron")
            let calendar = UNCalendarNotificationTrigger(dateMatching: components, repeats: repeats)
            guard let next = calendar.nextTriggerDate() else { completion(DesktopNotificationsValidation.failure("invalid_request", "calendar components have no future native trigger")); return }
            trigger = calendar; var values: [String: Int] = [:]
            for (key, value) in [("year", components.year), ("month", components.month), ("day", components.day), ("weekday", components.weekday), ("hour", components.hour), ("minute", components.minute), ("second", components.second)] { if let value { values[key] = value } }
            description = ["type": "calendar", "components": values, "nextTriggerDate": isoFormatter.string(from: next), "repeats": repeats]
        default: completion(DesktopNotificationsValidation.failure("invalid_request", "unknown notification posting operation")); return
        }
        let content = buildContent(bounded)
        if let raw = action["attachment"] as? String, content.attachments.count != raw.components(separatedBy: ",").count { completion(DesktopNotificationsValidation.failure("unsupported_target", "native notification attachment construction failed; no notification posted")); return }
        // macOS accepts a request it will never show while notifications are off for the app.
        center.getNotificationSettings { settings in
        switch settings.authorizationStatus {
        case .denied: completion(DesktopNotificationsValidation.failure("permission_denied", "notifications are off for interceptor-bridge in System Settings > Notifications; nothing was posted")); return
        case .notDetermined: completion(DesktopNotificationsValidation.failure("permission_required", "interceptor-bridge has not been allowed to post notifications yet; run notifications request first; nothing was posted")); return
        default: break
        }
        guard self.requestMutation.wait(timeout: .now()) == .success else { completion(DesktopNotificationsValidation.failure("resource_limit", "another notification post/schedule is pending")); return }
        center.getPendingNotificationRequests { requests in
            guard requests.filter({ $0.identifier.hasPrefix(self.prefix(namespace)) }).count < DESKTOP_NOTIFICATION_MAX_ENTRIES || requests.contains(where: { $0.identifier == nativeID }) else { self.requestMutation.signal(); completion(DesktopNotificationsValidation.failure("resource_limit", "owned pending notification limit 1000 reached")); return }
            center.add(UNNotificationRequest(identifier: nativeID, content: content, trigger: trigger)) { error in
                self.requestMutation.signal()
                if let error { completion(DesktopNotificationsValidation.failure("provider_failed", error.localizedDescription)); return }
                self.record(namespace, kind: sub == "post" ? "accepted" : "scheduled", identifier: id)
                completion(WireFormat.success(["ok": true, "identifier": id, "nativeIdentifier": nativeID, "trigger": description, "categoryIdentifier": action["category"] as? String ?? ""]))
            }
        }
        }
    }
}
