import Foundation
import EventKit
import CoreGraphics

enum DesktopEventKitValidation {
    static let eventFields = ["title", "start", "end", "all_day", "location", "notes", "url", "alarms", "attendees", "recurrence_frequency", "recurrence_interval", "recurrence_end"]
    static let reminderFields = ["title", "due", "start", "priority", "notes", "url"]
    static let calendarFields: [String: [String]] = ["status": [], "request": ["level"], "list": [], "default": [], "sources": [], "create-calendar": ["title", "color", "cal_type", "source"], "delete-calendar": ["id"], "events": ["start", "end", "calendar", "calendars", "limit", "offset"], "event": ["id"], "event-by-external": ["id", "limit", "offset"], "create": eventFields + ["calendar"], "update": ["id", "span"] + eventFields, "delete": ["id", "span"], "move": ["id", "to"], "refresh-sources": [], "reset": [], "tail": []]
    static let reminderSelectorFields: [String: [String]] = ["status": [], "request": [], "lists": [], "default": [], "all": ["list", "limit", "offset"], "incomplete": ["list", "due_start", "due_end", "limit", "offset"], "completed": ["list", "since", "until", "limit", "offset"], "create": ["list"] + reminderFields, "update": ["id"] + reminderFields, "complete": ["id"], "uncomplete": ["id"], "delete": ["id"]]

    static func date(_ value: Any?) -> Date? {
        guard let text = value as? String, text.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$", options: .regularExpression) != nil else { return nil }
        let pieces = Array(text.prefix(19)).map(String.init)
        func number(_ range: Range<Int>) -> Int { Int(pieces[range].joined()) ?? -1 }
        let y = number(0..<4), m = number(5..<7), d = number(8..<10), h = number(11..<13), minute = number(14..<16), second = number(17..<19)
        let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
        guard y >= 1, (1...12).contains(m), d >= 1, d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1], h <= 23, minute <= 59, second <= 59 else { return nil }
        if !text.hasSuffix("Z") { let zone = text.suffix(6); guard Int(zone.dropFirst().prefix(2))! <= 23, Int(zone.suffix(2))! <= 59 else { return nil } }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
    static func iso(_ date: Date) -> String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: date) }
    static func actionError(_ a: [String: Any]) -> String? {
        let calendar = a["type"] as? String == "desktop_calendar"
        if let error = calendar ? DesktopCalendarShape.validationError(a) : DesktopRemindersShape.validationError(a) { return error }
        let sub = a["sub"] as! String, fields = (calendar ? calendarFields : reminderSelectorFields)[sub]!
        if a.keys.contains(where: { !(["type", "sub"] + fields).contains($0) }) { return "field does not belong to this calendar/reminders selector" }
        for (key, value) in a {
            if let text = value as? String, text.utf8.count > (key == "notes" ? 65536 : 4096) || text.contains("\0") || (!["notes", "location", "url"].contains(key) && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) { return "invalid or oversized calendar/reminders text" }
        }
        for key in ["limit", "offset", "recurrence_interval"] { if let n = a[key] as? NSNumber, !n.doubleValue.isFinite || n.doubleValue.rounded(.towardZero) != n.doubleValue || n.doubleValue < (key == "offset" ? 0 : 1) || n.doubleValue > (key == "limit" ? 1000 : 10000) { return "limit, offset or recurrence interval is out of range" } }
        let required = calendar ? (["delete-calendar", "event", "event-by-external", "update", "delete", "move"].contains(sub) ? ["id"] : sub == "create" ? ["title", "start", "end"] : sub == "events" ? ["start", "end"] : sub == "create-calendar" ? ["title"] : []) : (["update", "complete", "uncomplete", "delete"].contains(sub) ? ["id"] : sub == "create" ? ["title"] : sub == "completed" ? ["since", "until"] : [])
        if required.contains(where: { a[$0] == nil }) || (calendar && sub == "move" && a["to"] == nil) { return "missing a required field for this calendar/reminders selector" }
        if sub == "update", !(calendar ? eventFields : reminderFields).contains(where: { a[$0] != nil }) { return "update requires at least one field to change" }
        for key in ["start", "end", "due", "due_start", "due_end", "since", "until"] { if a[key] != nil && date(a[key]) == nil { return "invalid actual ISO8601 instant" } }
        for (low, high) in [("start", "end"), ("due_start", "due_end"), ("since", "until")] { if let x = date(a[low]), let y = date(a[high]), y <= x || y.timeIntervalSince(x) > 1461 * 86400 { return "the end must be after the start, within 1461 days" } }
        for (key, values) in [("level", ["full", "write"]), ("span", ["this", "future"]), ("cal_type", ["local", "calDAV", "exchange", "subscribed"]), ("priority", ["none", "high", "medium", "low"]), ("recurrence_frequency", ["daily", "weekly", "monthly", "yearly"])] { if let text = a[key] as? String, !values.contains(text) { return "unknown calendar/reminders option value" } }
        if let text = a["color"] as? String, text.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) == nil { return "calendar color requires #RRGGBB" }
        if a["calendar"] != nil && a["calendars"] != nil { return "one exact calendar scope required" }
        if let raw = a["calendars"] as? String { let ids = raw.components(separatedBy: ","); if ids.count > 128 || Set(ids).count != ids.count || ids.contains(where: { $0.isEmpty || $0.trimmingCharacters(in: .whitespacesAndNewlines) != $0 }) { return "invalid exact calendar identities" } }
        if let raw = a["url"] as? String, !raw.isEmpty, URL(string: raw)?.scheme == nil { return "absolute URL required" }
        if let rows = a["attendees"] as? [String], !rows.isEmpty { return "attendees are read-only; no change was made" }
        if let rows = a["alarms"] as? [String], rows.count > 32 || rows.contains(where: { text in if date(text) != nil { return false }; guard text.range(of: "^[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)$", options: .regularExpression) != nil, let n = Double(text) else { return true }; return !n.isFinite || abs(n) > 315576000 }) { return "invalid bounded absolute or relative alarm" }
        if (a["recurrence_interval"] != nil || a["recurrence_end"] != nil) && a["recurrence_frequency"] == nil { return "recurrence fields require frequency" }
        if let raw = a["recurrence_end"] as? String, date(raw) == nil { guard raw.range(of: "^[1-9][0-9]{0,5}$", options: .regularExpression) != nil, let n = Int(raw), n <= 100000 else { return "invalid recurrence end" } }
        guard let bytes = try? JSONSerialization.data(withJSONObject: a), bytes.count <= 262144 else { return "calendar/reminders request exceeds 256 KiB" }
        return nil
    }
    static func alarms(_ action: [String: Any]) -> [EKAlarm] { (action["alarms"] as? [String] ?? []).map { text in if let d = date(text) { return EKAlarm(absoluteDate: d) }; return EKAlarm(relativeOffset: Double(text)!) } }
    static func alarmRows(_ alarms: [EKAlarm]?) -> [[String: Any]] { (alarms ?? []).map { alarm in var row: [String: Any] = ["type": NativeNames.name(alarm.type.rawValue, NativeNames.alarmType), "relativeOffset": alarm.relativeOffset]; if let date = alarm.absoluteDate { row["absoluteDate"] = iso(date) }; return row } }
    static func recurrenceRows(_ rules: [EKRecurrenceRule]?) -> [[String: Any]] { (rules ?? []).map { rule in
        var row: [String: Any] = ["frequency": NativeNames.name(rule.frequency.rawValue, NativeNames.recurrenceFrequency), "interval": rule.interval]
        if let end = rule.recurrenceEnd { var value: [String: Any] = [:]; if let date = end.endDate { value["date"] = iso(date) }; if end.occurrenceCount > 0 { value["occurrenceCount"] = end.occurrenceCount }; row["end"] = value }
        return row
    } }
    static func recurrence(_ action: [String: Any]) -> EKRecurrenceRule? {
        guard let frequency = action["recurrence_frequency"] as? String else { return nil }
        let frequencies: [String: EKRecurrenceFrequency] = ["daily": .daily, "weekly": .weekly, "monthly": .monthly, "yearly": .yearly]
        var end: EKRecurrenceEnd?
        if let text = action["recurrence_end"] as? String { if let d = date(text) { end = EKRecurrenceEnd(end: d) } else { end = EKRecurrenceEnd(occurrenceCount: Int(text)!) } }
        return EKRecurrenceRule(recurrenceWith: frequencies[frequency]!, interval: (action["recurrence_interval"] as? NSNumber)?.intValue ?? 1, end: end)
    }
    static func nativeError(_ error: any Error, afterCommit: Bool = false, mayHaveMutated: Bool = false) -> [String: Any] {
        let n = error as NSError
        var details: [String: Any] = ["nativeDomain": n.domain, "nativeCode": n.code]
        if afterCommit { details["mutationCommitted"] = true }
        else if !mayHaveMutated { details["mutationCommitted"] = false }
        if afterCommit || mayHaveMutated { details["outcomeUnknown"] = true }
        if let name = n.userInfo["exceptionName"] as? String { details["nativeException"] = String(name.prefix(256)) }
        return WireFormat.failure(afterCommit || mayHaveMutated ? "timeout_unknown_outcome" : "provider_failed", String(n.localizedDescription.prefix(4096)), details: details)
    }
    static func resultError(_ result: [String: Any], action: [String: Any]) -> String? {
        guard result["success"] as? Bool == true else { return nil }
        guard let data = result["data"] as? [String: Any], let bytes = try? JSONSerialization.data(withJSONObject: data), bytes.count <= 1048576 else { return "calendar/reminders reply exceeds 1 MiB" }
        let calendar = action["type"] as? String == "desktop_calendar", sub = action["sub"] as! String, decoder = JSONDecoder()
        do {
            if calendar {
                switch sub {
                case "status": _ = try decoder.decode(DesktopCalendarStatus.self, from: bytes)
                case "request": _ = try decoder.decode(DesktopCalendarRequested.self, from: bytes)
                case "list": _ = try decoder.decode(DesktopCalendarList.self, from: bytes)
                case "sources": _ = try decoder.decode(DesktopCalendarSources.self, from: bytes)
                case "default": if data["calendar"] is NSNull { _ = try decoder.decode(DesktopCalendarNoDefault.self, from: bytes) } else { _ = try decoder.decode(DesktopCalendarRow.self, from: bytes) }
                case "create-calendar": _ = try decoder.decode(DesktopCalendarRow.self, from: bytes)
                case "events", "event-by-external": _ = try decoder.decode(DesktopCalendarEvents.self, from: bytes)
                case "delete", "delete-calendar": _ = try decoder.decode(DesktopCalendarDeleted.self, from: bytes)
                case "refresh-sources", "reset": _ = try decoder.decode(DesktopCalendarOK.self, from: bytes)
                case "tail": _ = try decoder.decode(DesktopCalendarTail.self, from: bytes)
                default: _ = try decoder.decode(DesktopCalendarEvent.self, from: bytes)
                }
            } else {
                switch sub {
                case "status": _ = try decoder.decode(DesktopRemindersStatus.self, from: bytes)
                case "request": _ = try decoder.decode(DesktopRemindersRequested.self, from: bytes)
                case "lists": _ = try decoder.decode(DesktopRemindersLists.self, from: bytes)
                case "default": if data["list"] is NSNull { _ = try decoder.decode(DesktopRemindersNoDefault.self, from: bytes) } else { _ = try decoder.decode(DesktopRemindersList.self, from: bytes) }
                case "all", "incomplete", "completed": _ = try decoder.decode(DesktopRemindersRows.self, from: bytes)
                case "delete": _ = try decoder.decode(DesktopCalendarDeleted.self, from: bytes)
                default: _ = try decoder.decode(DesktopRemindersRow.self, from: bytes)
                }
            }
        } catch { return "calendar/reminders native reply violates the selector contract" }
        func bounded(_ value: Any, depth: Int = 0) -> Bool { if depth > 8 { return false }; if let s = value as? String { return s.utf8.count <= 65536 && !s.contains("\0") }; if let a = value as? [Any] { return a.count <= 1000 && a.allSatisfy { bounded($0, depth: depth + 1) } }; if let d = value as? [String: Any] { return d.values.allSatisfy { bounded($0, depth: depth + 1) } }; if let n = value as? NSNumber { return n.doubleValue.isFinite }; return value is NSNull }
        if !bounded(data) { return "calendar/reminders reply exceeds its nested bounds" }
        if data["ok"] != nil && data["ok"] as? Bool != true { return "calendar/reminders reply lacks an effect receipt" }
        if ["delete", "delete-calendar"].contains(sub), data["id"] as? String != action["id"] as? String { return "calendar/reminders deletion identity differs" }
        func identity(_ value: Any?) -> Bool { guard let text = value as? String else { return false }; return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.utf8.count <= 4096 }
        if data["id"] != nil && !identity(data["id"]) { return "missing actual native calendar/reminders identity" }
        if calendar && sub == "event", data["id"] as? String != action["id"] as? String { return "native event read differs from the exact requested identity" }
        if !calendar && ["update", "complete", "uncomplete"].contains(sub), data["id"] as? String != action["id"] as? String { return "native reminder mutation differs from the exact requested identity" }
        for key in ["calendars", "sources", "lists", "events", "reminders"] { if let rows = data[key] as? [[String: Any]], rows.contains(where: { !identity($0["id"]) }) { return "missing actual native calendar/reminders identity" } }
        if let limit = data["limit"] as? NSNumber { let rows = (data["events"] ?? data["reminders"]) as? [Any] ?? []; if limit.doubleValue != ((action["limit"] as? NSNumber)?.doubleValue ?? 100) || (data["offset"] as? NSNumber)?.doubleValue != ((action["offset"] as? NSNumber)?.doubleValue ?? 0) || rows.count > limit.intValue { return "calendar/reminders page differs from the requested bounds" } }
        let events = calendar ? data["events"] as? [[String: Any]] ?? (data["calendarId"] != nil ? [data] : []) : []
        for row in events { guard identity(row["calendarId"]), let start = date(row["startDate"]), let end = date(row["endDate"]), end >= start else { return "invalid native event interval or calendar" }; if let id = action["calendar"] as? String, row["calendarId"] as? String != id { return "native event differs from calendar scope" }; if let ids = action["calendars"] as? String, !ids.components(separatedBy: ",").contains(row["calendarId"] as? String ?? "") { return "native event differs from calendars scope" }; if sub == "move", row["calendarId"] as? String != action["to"] as? String { return "native move differs from target calendar" } }
        let reminders = !calendar ? data["reminders"] as? [[String: Any]] ?? (data["listId"] != nil ? [data] : []) : []
        for row in reminders { guard identity(row["listId"]), ["none", "high", "medium", "low"].contains(row["priority"] as? String ?? "") else { return "invalid native reminder list or priority" }; if let id = action["list"] as? String, row["listId"] as? String != id { return "native reminder differs from list scope" }; if ["complete", "completed"].contains(sub), row["isCompleted"] as? Bool != true { return "native reminder completion not observed" }; if ["uncomplete", "incomplete"].contains(sub), row["isCompleted"] as? Bool != false { return "native reminder incomplete state not observed" } }
        if !calendar, let rows = data["reminders"] as? [[String: Any]] {
            if rows.contains(where: { $0["completionDate"] != nil && date($0["completionDate"]) == nil }) { return "invalid native reminder completion instant" }
        } else if !calendar && data["completionDate"] != nil && date(data["completionDate"]) == nil { return "invalid native reminder completion instant" }
        if calendar && sub == "tail" {
            guard data["tailing"] as? Bool == true, let count = data["changeCount"] as? NSNumber, count.doubleValue.isFinite, count.doubleValue >= 0, count.doubleValue <= 9007199254740991, count.doubleValue.rounded(.towardZero) == count.doubleValue, data["lastChange"] is NSNull || date(data["lastChange"]) != nil else { return "invalid native Calendar change counter" }
        }
        return nil
    }
}
