// EventKit, reminders half. macOS 10.8+ for EKReminder.
// macOS 14+ requestFullAccessToReminders. Reminders does NOT support
// write-only access (per Apple docs). References:
// apple-developer-docs/EventKit/{EKReminder,EKEventStore,...}.md.

import Foundation
import EventKit

final class RemindersDomain: DomainHandler, @unchecked Sendable {
    private let access = EventKitDomainAccess()
    private var store: EKEventStore { access.store }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var input = action; input["type"] = "desktop_reminders"; input["sub"] = action["sub"] as? String ?? command
        if let error = DesktopEventKitValidation.actionError(input) { completion(WireFormat.failure("invalid_request", error)); return }
        let sub = input["sub"] as! String
        if sub == "status" { access.withNative(completion: completion) { self.status(completion: completion) }; return }
        if sub != "request" {
            var authorized = false
            guard access.withNative(completion: completion, operation: {
                let auth = EKEventStore.authorizationStatus(for: .reminder)
                authorized = auth == .fullAccess || auth == .authorized
            }) else { return }
            guard authorized else { completion(WireFormat.failure("permission_denied", "Reminders full access required; only explicit request may ask for consent")); return }
        }
        let box = UncheckedSendableBox(input)
        access.perform(action: input, completion: completion) { finish in self.dispatch(box.value, completion: finish) }
    }
    private func dispatch(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch action["sub"] as! String {
        case "request": requestAccess(completion: completion)
        case "lists": listLists(completion: completion)
        case "default": defaultList(completion: completion)
        case "all": listAll(action, completion: completion)
        case "incomplete": listIncomplete(action, completion: completion)
        case "completed": listCompleted(action, completion: completion)
        case "create": createReminder(action, completion: completion)
        case "update": updateReminder(action, completion: completion)
        case "complete": complete(action, completion: completion, value: true)
        case "uncomplete": complete(action, completion: completion, value: false)
        case "delete": deleteReminder(action, completion: completion)
        default: completion(WireFormat.failure("invalid_request", "unknown Reminders selector"))
        }
    }

    private func authStatusString(_ s: EKAuthorizationStatus) -> String {
        switch s {
        case .fullAccess: return "fullAccess"
        case .writeOnly: return "writeOnly"
        case .denied: return "denied"
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .authorized: return "fullAccess"
        @unknown default: return "unknown"
        }
    }

    private func status(completion: @escaping @Sendable ([String: Any]) -> Void) {
        completion(WireFormat.success([
            "status": authStatusString(EKEventStore.authorizationStatus(for: .reminder)),
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
        ]))
    }

    private func requestAccess(completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let purpose = Bundle.main.object(forInfoDictionaryKey: "NSRemindersFullAccessUsageDescription") as? String, !purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { completion(WireFormat.failure("not_installed", "Reminders consent requires the installed signed app purpose key")); return }
        guard let requestID = access.currentRequest else { completion(WireFormat.failure("cancelled", "Reminder request expired before native consent")); return }
        // Keep reset on the owned native queue after actual consent delivery.
        let owner = access
        DispatchQueue.main.async {
            guard self.access.canContinue(requestID) else { completion(WireFormat.failure("cancelled", "Reminder request expired before native consent")); return }
            let delivered: @Sendable (Bool, (any Error)?) -> Void = { granted, error in
                self.access.queue.async {
                    self.access.endCallback(requestID)
                    guard self.access.canContinue(requestID) else { completion(WireFormat.failure("cancelled", "Reminder consent completed after its request expired")); return }
                    self.access.withNative(request: requestID, mayHaveMutated: true, completion: completion) {
                        if granted { owner.store.reset() }
                        completion(WireFormat.success(["granted": granted, "error": error?.localizedDescription as Any? ?? NSNull()]))
                    }
                }
            }
            self.access.withNative(request: requestID, mayHaveMutated: true, completion: completion) {
                guard self.access.beginCallback(requestID) else { completion(WireFormat.failure("cancelled", "Reminder request retired before native consent dispatch")); return }
                if #available(macOS 14, *) { owner.store.requestFullAccessToReminders(completion: delivered) }
                else { owner.store.requestAccess(to: .reminder, completion: delivered) }
            }
        }
    }

    private func calendarDict(_ c: EKCalendar) -> [String: Any] {
        ["id": c.calendarIdentifier, "title": c.title, "allowsContentModifications": c.allowsContentModifications]
    }

    private func listLists(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let lists = store.calendars(for: .reminder)
        completion(WireFormat.success(["lists": lists.map(calendarDict)]))
    }

    private func defaultList(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let c = store.defaultCalendarForNewReminders() {
            completion(WireFormat.success(calendarDict(c)))
        } else {
            completion(WireFormat.success(["list": NSNull()]))
        }
    }

    private func parseDate(_ raw: Any?) -> Date? {
        DesktopEventKitValidation.date(raw)
    }

    private func components(_ d: Date) -> DateComponents {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        var result = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: d); result.timeZone = calendar.timeZone; return result
    }

    private func priorityValue(_ s: String?) -> Int {
        switch s {
        case "high": return 1
        case "medium": return 5
        case "low": return 9
        case "none": return 0
        default: return 0
        }
    }

    private func priorityString(_ p: Int) -> String {
        switch p {
        case 1...4: return "high"
        case 5: return "medium"
        case 6...9: return "low"
        default: return "none"
        }
    }

    private func reminderDict(_ r: EKReminder) throws -> [String: Any] {
        guard !r.calendarItemIdentifier.isEmpty, let calendar = r.calendar else { throw NSError(domain: "Interceptor.Reminders", code: 1, userInfo: [NSLocalizedDescriptionKey: "Native reminder has no exact list or item identity"]) }
        var out: [String: Any] = [
            "id": r.calendarItemIdentifier,
            "listId": calendar.calendarIdentifier,
            "title": r.title ?? "",
            "isCompleted": r.isCompleted,
            "priority": priorityString(r.priority),
        ]
        if let d = r.completionDate { out["completionDate"] = DesktopEventKitValidation.iso( d) }
        if let n = r.notes { out["notes"] = n }
        if let url = r.url { out["url"] = url.absoluteString }
        if let s = r.startDateComponents { out["startDateComponents"] = encodeComponents(s) }
        if let due = r.dueDateComponents { out["dueDateComponents"] = encodeComponents(due) }
        if let alarms = r.alarms { out["alarms"] = DesktopEventKitValidation.alarmRows(alarms) }
        if let rules = r.recurrenceRules { out["recurrenceRules"] = DesktopEventKitValidation.recurrenceRows(rules) }
        return out
    }

    private func encodeComponents(_ c: DateComponents) -> [String: Any] {
        var d: [String: Any] = [:]
        if let y = c.year { d["year"] = y }
        if let m = c.month { d["month"] = m }
        if let day = c.day { d["day"] = day }
        if let h = c.hour { d["hour"] = h }
        if let min = c.minute { d["minute"] = min }
        if let second = c.second { d["second"] = second }
        if let zone = c.timeZone { d["timeZone"] = zone.identifier }
        return d
    }

    private func resolveList(_ action: [String: Any]) throws -> EKCalendar? {
        guard let id = action["list"] as? String else { return nil }
        guard let c = store.calendars(for: .reminder).first(where: { $0.calendarIdentifier == id }) else { throw NSError(domain: "Interceptor.Reminders", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unknown exact reminder-list identity; no default or all-list fallback"]) }
        return c
    }

    private func listAll(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        do { let cals = try resolveList(action).map { [$0] }; fetch(store.predicateForReminders(in: cals), action: action, completion: completion) } catch { completion(DesktopEventKitValidation.nativeError(error)) }
    }

    private func listIncomplete(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let start = parseDate(action["due_start"])
        let end = parseDate(action["due_end"])
        do { let cals = try resolveList(action).map { [$0] }; fetch(store.predicateForIncompleteReminders(withDueDateStarting: start, ending: end, calendars: cals), action: action, completion: completion) } catch { completion(DesktopEventKitValidation.nativeError(error)) }
    }

    private func listCompleted(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let start = parseDate(action["since"]), let end = parseDate(action["until"]) else {
            completion(WireFormat.error("reminders.completed: --since and --until required (ISO8601)")); return
        }
        do { let cals = try resolveList(action).map { [$0] }; fetch(store.predicateForCompletedReminders(withCompletionDateStarting: start, ending: end, calendars: cals), action: action, completion: completion) } catch { completion(DesktopEventKitValidation.nativeError(error)) }
    }

    private func fetch(_ predicate: NSPredicate, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let box = UncheckedSendableBox(action)
        access.fetch(predicate, completion: { reminders in
            guard self.access.canContinue else { completion(WireFormat.failure("cancelled", "Reminder fetch retired at deadline")); return }
            guard let reminders else { completion(WireFormat.failure("provider_failed", "Native reminder fetch returned no result; no empty success inferred")); return }
            guard reminders.count <= 12000 else { completion(WireFormat.failure("resource_limit", "Native reminder fetch exceeds 12000 items")); return }
            let limit = (box.value["limit"] as? NSNumber)?.intValue ?? 100, offset = (box.value["offset"] as? NSNumber)?.intValue ?? 0
            let sorted = reminders.sorted { $0.calendarItemIdentifier < $1.calendarItemIdentifier }
            do { completion(WireFormat.success(["reminders": try sorted.dropFirst(offset).prefix(limit).map(self.reminderDict), "limit": limit, "offset": offset, "hasMore": sorted.count > offset + limit])) } catch { completion(DesktopEventKitValidation.nativeError(error)) }
        }, cancelled: { completion(WireFormat.failure("cancelled", "Native reminder fetch cancelled; original completion suppressed by EventKit")) })
    }

    private func createReminder(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let title = action["title"] as? String else { completion(WireFormat.error("reminders.create: --title required")); return }
        let cal: EKCalendar
        do { guard let resolved = try resolveList(action) ?? store.defaultCalendarForNewReminders(), resolved.allowsContentModifications, !resolved.isImmutable else { completion(WireFormat.failure("target_gone", "Reminder create requires writable native list")); return }; cal = resolved } catch { completion(DesktopEventKitValidation.nativeError(error)); return }
        let r = EKReminder(eventStore: store)
        r.title = title
        r.calendar = cal
        if let p = action["priority"] as? String { r.priority = priorityValue(p) }
        if let n = action["notes"] as? String { r.notes = n }
        if let urlStr = action["url"] as? String, let u = URL(string: urlStr) { r.url = u }
        if let due = parseDate(action["due"]) { r.dueDateComponents = components(due) }
        if let start = parseDate(action["start"]) { r.startDateComponents = components(start) }
        saveReminder(r, completion: completion)
    }

    private func updateReminder(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String,
              let item = store.calendarItem(withIdentifier: id) as? EKReminder else {
            completion(WireFormat.error("reminders.update: unknown id")); return
        }
        if let title = action["title"] as? String { item.title = title }
        if let p = action["priority"] as? String { item.priority = priorityValue(p) }
        if let notes = action["notes"] as? String { item.notes = notes }
        if let urlStr = action["url"] as? String, let u = URL(string: urlStr) { item.url = u }
        if let urlStr = action["url"] as? String, urlStr.isEmpty { item.url = nil }
        if let due = parseDate(action["due"]) { item.dueDateComponents = components(due) }
        if let start = parseDate(action["start"]) { item.startDateComponents = components(start) }
        saveReminder(item, completion: completion)
    }

    private func complete(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void, value: Bool) {
        guard let id = action["id"] as? String,
              let item = store.calendarItem(withIdentifier: id) as? EKReminder else {
            completion(WireFormat.error("reminders.complete/uncomplete: unknown id")); return
        }
        item.isCompleted = value
        saveReminder(item, completion: completion)
    }

    private func saveReminder(_ item: EKReminder, completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let list = item.calendar, list.allowsContentModifications, !list.isImmutable else { completion(WireFormat.failure("permission_denied", "Reminder native list is read-only")); return }
        guard access.canContinue else { completion(WireFormat.failure("cancelled", "Reminder request retired before save")); return }
        let listId = list.calendarIdentifier, title = item.title, completed = item.isCompleted, priority = item.priority
        let due = item.dueDateComponents, start = item.startDateComponents, notes = item.notes, url = item.url
        var committed = false
        do {
            try store.save(item, commit: true); committed = true
            let id = item.calendarItemIdentifier; store.reset()
            guard let saved = store.calendarItem(withIdentifier: id) as? EKReminder, saved.calendar?.calendarIdentifier == listId, saved.title == title, saved.isCompleted == completed, saved.priority == priority, saved.dueDateComponents == due, saved.startDateComponents == start, saved.notes == notes, saved.url == url else { completion(WireFormat.failure("timeout_unknown_outcome", "Reminder save committed but independent native readback differs; no replay")); return }
            completion(WireFormat.success(try reminderDict(saved)))
        } catch { completion(DesktopEventKitValidation.nativeError(error, afterCommit: committed)) }
    }

    private func deleteReminder(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String,
              let item = store.calendarItem(withIdentifier: id) as? EKReminder else {
            completion(WireFormat.error("reminders.delete: unknown id")); return
        }
        guard item.calendar?.allowsContentModifications == true, item.calendar?.isImmutable == false, access.canContinue else { completion(WireFormat.failure("permission_denied", "Reminder list is read-only or request retired")); return }
        do {
            try store.remove(item, commit: true)
            store.reset()
            guard store.calendarItem(withIdentifier: id) == nil else { completion(WireFormat.failure("timeout_unknown_outcome", "Reminder remove returned but native item remains")); return }
            completion(WireFormat.success(["ok": true, "id": id]))
        } catch {
            completion(DesktopEventKitValidation.nativeError(error))
        }
    }
}
