// EventKit, events half. macOS 10.8+ for EKEvent;
// macOS 14+ for requestFullAccessToEvents / requestWriteOnlyAccessToEvents.
// References: apple-developer-docs/EventKit/{EKEventStore,EKEvent,EKCalendar,
// EKAlarm,EKRecurrenceRule,EKAuthorizationStatus,accessing-the-event-store}.md.

import Foundation
import EventKit

final class CalendarDomain: DomainHandler, @unchecked Sendable {
    private let access = EventKitDomainAccess()
    private var store: EKEventStore { access.store }
    private let changesLock = NSLock()
    private var observer: NSObjectProtocol?
    private var changeCount = 0
    private var lastChange: Date?
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var input = action; input["type"] = "desktop_calendar"; input["sub"] = action["sub"] as? String ?? command
        if let error = DesktopEventKitValidation.actionError(input) { completion(WireFormat.failure("invalid_request", error)); return }
        let sub = input["sub"] as! String
        if sub == "status" { access.withNative(completion: completion) { self.status(completion: completion) }; return }
        if !["request", "reset"].contains(sub) {
            var authorized = false
            guard access.withNative(completion: completion, operation: {
                let auth = EKEventStore.authorizationStatus(for: .event)
                authorized = auth == .fullAccess || auth == .authorized
            }) else { return }
            guard authorized else { completion(WireFormat.failure("permission_denied", "Calendar full access required for native identities and readback; only explicit request may ask for consent")); return }
        }
        let box = UncheckedSendableBox(input)
        access.perform(action: input, completion: completion) { finish in self.dispatch(box.value, completion: finish) }
    }
    private func dispatch(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch action["sub"] as! String {
        case "request": requestAccess(action, completion: completion)
        case "list": listCalendars(completion: completion)
        case "default": defaultCalendar(completion: completion)
        case "sources": listSources(completion: completion)
        case "create-calendar": createCalendar(action, completion: completion)
        case "delete-calendar": deleteCalendar(action, completion: completion)
        case "events": listEvents(action, completion: completion)
        case "event": getEvent(action, completion: completion)
        case "event-by-external": eventByExternal(action, completion: completion)
        case "create": createEvent(action, completion: completion)
        case "update": updateEvent(action, completion: completion)
        case "delete": deleteEvent(action, completion: completion)
        case "move": moveEvent(action, completion: completion)
        case "refresh-sources": refreshSources(completion: completion)
        case "reset": reset(completion: completion)
        case "tail": tail(completion: completion)
        default: completion(WireFormat.failure("invalid_request", "unknown Calendar selector"))
        }
    }

    private func authStatusString(_ s: EKAuthorizationStatus) -> String {
        switch s {
        case .fullAccess:    return "fullAccess"
        case .writeOnly:     return "writeOnly"
        case .denied:        return "denied"
        case .notDetermined: return "notDetermined"
        case .restricted:    return "restricted"
        case .authorized:    return "fullAccess"
        @unknown default:    return "unknown"
        }
    }

    private func status(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let events = EKEventStore.authorizationStatus(for: .event)
        let reminders = EKEventStore.authorizationStatus(for: .reminder)
        completion(WireFormat.success([
            "events": authStatusString(events),
            "reminders": authStatusString(reminders),
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
        ]))
    }

    private func requestAccess(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let level = (action["level"] as? String) ?? "full"
        let purpose = level == "write" ? "NSCalendarsWriteOnlyAccessUsageDescription" : "NSCalendarsFullAccessUsageDescription"
        guard let text = Bundle.main.object(forInfoDictionaryKey: purpose) as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { completion(WireFormat.failure("not_installed", "Calendar consent requires the installed signed app purpose key " + purpose)); return }
        guard let requestID = access.currentRequest else { completion(WireFormat.failure("cancelled", "Calendar request expired before native consent")); return }
        // Apple's consent docs require reset when earlier reads preceded grant.
        let owner = access
        DispatchQueue.main.async {
            guard self.access.canContinue(requestID) else { completion(WireFormat.failure("cancelled", "Calendar request expired before native consent")); return }
            let nativeLevel: String
            if #available(macOS 14, *) { nativeLevel = level } else { nativeLevel = "legacy" }
            let delivered: @Sendable (Bool, (any Error)?) -> Void = { granted, error in
                self.access.queue.async {
                    self.access.endCallback(requestID)
                    guard self.access.canContinue(requestID) else { completion(WireFormat.failure("cancelled", "Calendar consent completed after its request expired")); return }
                    self.access.withNative(request: requestID, mayHaveMutated: true, completion: completion) {
                        if granted { owner.store.reset() }
                        completion(WireFormat.success(["level": nativeLevel, "granted": granted, "error": error?.localizedDescription as Any? ?? NSNull()]))
                    }
                }
            }
            self.access.withNative(request: requestID, mayHaveMutated: true, completion: completion) {
                guard self.access.beginCallback(requestID) else { completion(WireFormat.failure("cancelled", "Calendar request retired before native consent dispatch")); return }
                if #available(macOS 14, *) {
                    if level == "write" { owner.store.requestWriteOnlyAccessToEvents(completion: delivered) }
                    else { owner.store.requestFullAccessToEvents(completion: delivered) }
                } else {
                    owner.store.requestAccess(to: .event, completion: delivered)
                }
            }
        }
    }

    private func calendarDict(_ c: EKCalendar) -> [String: Any] {
        var out: [String: Any] = [
            "id": c.calendarIdentifier,
            "title": c.title,
            "type": NativeNames.name(c.type.rawValue, NativeNames.calendarType),
            "allowsContentModifications": c.allowsContentModifications,
            "isImmutable": c.isImmutable,
            "isSubscribed": c.isSubscribed,
            "supportedEventAvailabilities": c.supportedEventAvailabilities.rawValue,
        ]
        if let s = c.source { out["source"] = ["id": s.sourceIdentifier, "title": s.title, "type": NativeNames.name(s.sourceType.rawValue, NativeNames.sourceType)] }
        return out
    }

    private func listCalendars(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let calendars = store.calendars(for: .event)
        completion(WireFormat.success(["calendars": calendars.map(calendarDict)]))
    }

    private func defaultCalendar(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let c = store.defaultCalendarForNewEvents {
            completion(WireFormat.success(calendarDict(c)))
        } else {
            completion(WireFormat.success(["calendar": NSNull()]))
        }
    }

    private func listSources(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let arr = store.sources.map { s -> [String: Any] in
            [
                "id": s.sourceIdentifier,
                "title": s.title,
                "type": NativeNames.name(s.sourceType.rawValue, NativeNames.sourceType),
            ]
        }
        completion(WireFormat.success(["sources": arr]))
    }

    private func createCalendar(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let title = action["title"] as? String else { completion(WireFormat.error("calendar.create-calendar: --title required")); return }
        let typeStr = (action["cal_type"] as? String) ?? "local"
        let cal = EKCalendar(for: .event, eventStore: store)
        cal.title = title
        // Pick a source matching the requested type.
        let sourceTypes: [String: EKSourceType] = ["local": .local, "calDAV": .calDAV, "exchange": .exchange, "subscribed": .subscribed]
        let candidates = store.sources.filter { source in
            if let id = action["source"] as? String { return source.sourceIdentifier == id && (action["cal_type"] == nil || source.sourceType == sourceTypes[typeStr]) }
            return source.sourceType == sourceTypes[typeStr]
        }
        guard candidates.count == 1, let src = candidates.first else { completion(WireFormat.failure(candidates.isEmpty ? "target_gone" : "target_ambiguous", "calendar.create-calendar requires one exact native source; pass --source when type is ambiguous")); return }
        cal.source = src
        let sourceId = src.sourceIdentifier
        if let text = action["color"] as? String, let rgb = UInt32(text.dropFirst(), radix: 16) { cal.cgColor = CGColor(red: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1) }
        guard access.canContinue else { completion(WireFormat.failure("cancelled", "Calendar request expired before save")); return }
        var committed = false
        do {
            try store.saveCalendar(cal, commit: true)
            committed = true
            let id = cal.calendarIdentifier; store.reset()
            guard let saved = store.calendar(withIdentifier: id), saved.title == title, saved.source?.sourceIdentifier == sourceId else { completion(WireFormat.failure("timeout_unknown_outcome", "Calendar save committed but exact native readback differs")); return }
            completion(WireFormat.success(calendarDict(saved)))
        } catch {
            completion(DesktopEventKitValidation.nativeError(error, afterCommit: committed))
        }
    }

    private func deleteCalendar(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String, let cal = eventCalendar(id), cal.allowsContentModifications, !cal.isImmutable else {
            completion(WireFormat.error("calendar.delete-calendar: unknown id")); return
        }
        guard access.canContinue else { completion(WireFormat.failure("cancelled", "Calendar request expired before remove")); return }
        do {
            try store.removeCalendar(cal, commit: true)
            store.reset()
            guard store.calendar(withIdentifier: id) == nil else { completion(WireFormat.failure("timeout_unknown_outcome", "Calendar remove returned but native identity remains")); return }
            completion(WireFormat.success(["ok": true, "id": id]))
        } catch {
            completion(DesktopEventKitValidation.nativeError(error))
        }
    }

    private func parseDate(_ s: Any?) -> Date? {
        DesktopEventKitValidation.date(s)
    }

    private func parseSpan(_ raw: String?) -> EKSpan {
        return raw == "future" ? .futureEvents : .thisEvent
    }

    private func eventCalendar(_ id: String) -> EKCalendar? {
        store.calendars(for: .event).first { $0.calendarIdentifier == id }
    }
    private func resolveCalendars(_ action: [String: Any]) throws -> [EKCalendar]? {
        let ids = (action["calendar"] as? String).map { [$0] } ?? (action["calendars"] as? String)?.components(separatedBy: ",")
        guard let ids else { return nil }
        return try ids.map { id in guard let cal = eventCalendar(id) else { throw NSError(domain: "Interceptor.Calendar", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown exact event-calendar identity; no broader query performed"]) }; return cal }
    }

    // A recurring event's occurrences share one eventIdentifier, and event(withIdentifier:) returns the
    // first one, so "delete <row from events> --span future" removed the whole series.
    // Listed occurrences are named "<eventIdentifier>@<unix seconds of occurrenceDate>", as on Windows.
    private func occurrenceId(_ e: EKEvent) -> String? {
        guard let id = e.eventIdentifier, e.hasRecurrenceRules || e.isDetached, let date = e.occurrenceDate else { return e.eventIdentifier }
        // A saved occurrence's identifier gains "/RID=<n>"; leave it out so the id stays the same across edits, as on Windows and Linux.
        let base = id.range(of: "/RID=").map { String(id[..<$0.lowerBound]) } ?? id
        return "\(base)@\(Int(date.timeIntervalSince1970.rounded(.down)))"
    }

    // Saving one occurrence detaches it, and its eventIdentifier gains a "/RID=<n>" suffix, so the
    // readback looked for the series identifier and reported a failure after a correct save.
    static func sameEvent(_ a: String, _ b: String) -> Bool { a == b || a.hasPrefix(b + "/RID=") || b.hasPrefix(a + "/RID=") }

    static func isOccurrenceId(_ id: String) -> Bool {
        guard let at = id.lastIndex(of: "@"), at != id.startIndex else { return false }
        let tail = id[id.index(after: at)...]
        return Int(tail).map { String($0) == tail } ?? false
    }

    private func resolveEvent(_ id: String) -> EKEvent? {
        guard Self.isOccurrenceId(id), let at = id.lastIndex(of: "@"), let seconds = Int(id[id.index(after: at)...]) else { return store.event(withIdentifier: id) }
        let series = String(id[..<at])
        guard let first = store.event(withIdentifier: series), let calendar = first.calendar else { return store.event(withIdentifier: id) }
        // ponytail: an occurrence moved away from its original time falls outside this window and reads as unknown.
        let instant = Date(timeIntervalSince1970: TimeInterval(seconds))
        let predicate = store.predicateForEvents(withStart: instant.addingTimeInterval(-1), end: instant.addingTimeInterval(1), calendars: [calendar])
        return store.events(matching: predicate).first { occurrenceId($0) == id }
    }

    // All-day boundaries are dates at UTC midnight in the contract, end exclusive, as EDS and Windows
    // store them. EventKit keeps local days with an inclusive 23:59:59 end, so a UTC instant read as a
    // local time landed a day early and spanned two days.
    static func localDay(_ utcMidnight: Date, end: Bool) -> Date? {
        var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
        let parts = utc.dateComponents([.year, .month, .day, .hour, .minute, .second], from: utcMidnight)
        guard parts.hour == 0, parts.minute == 0, parts.second == 0, utcMidnight.timeIntervalSince1970.truncatingRemainder(dividingBy: 1) == 0,
              let midnight = localGregorian().date(from: DateComponents(year: parts.year, month: parts.month, day: parts.day)) else { return nil }
        return end ? midnight.addingTimeInterval(-1) : midnight
    }

    static func contractDay(_ local: Date, end: Bool) -> Date {
        var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC")!
        let midnight = utc.date(from: localGregorian().dateComponents([.year, .month, .day], from: local))!
        return end ? utc.date(byAdding: .day, value: 1, to: midnight)! : midnight
    }

    // Contract days are Gregorian. Calendar.current may be Buddhist or Japanese, whose year numbers
    // would move the event by centuries while reading back the same wrong day.
    static func localGregorian() -> Calendar {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .current; return calendar
    }

    private func allDayDates(_ event: EKEvent, _ action: [String: Any]) -> Bool {
        guard event.isAllDay else { return true }
        for (key, end) in [("start", false), ("end", true)] {
            guard let given = parseDate(action[key]) else { continue }
            guard let local = Self.localDay(given, end: end) else { return false }
            if end { event.endDate = local } else { event.startDate = local }
        }
        return true
    }

    private func eventDict(_ e: EKEvent, id rowId: String? = nil) throws -> [String: Any] {
        guard let id = e.eventIdentifier, !id.isEmpty, let calendar = e.calendar, let start = e.startDate, let end = e.endDate, end >= start else { throw NSError(domain: "Interceptor.Calendar", code: 2, userInfo: [NSLocalizedDescriptionKey: "Native event has no exact identity, calendar or ordered interval"]) }
        var out: [String: Any] = [
            "id": rowId ?? id,
            "calendarId": calendar.calendarIdentifier,
            "title": e.title ?? "",
            "startDate": DesktopEventKitValidation.iso(e.isAllDay ? Self.contractDay(start, end: false) : start),
            "endDate": DesktopEventKitValidation.iso(e.isAllDay ? Self.contractDay(end, end: true) : end),
            "isAllDay": e.isAllDay,
            "isDetached": e.isDetached,
            "status": NativeNames.name(e.status.rawValue, NativeNames.eventStatus),
            "availability": NativeNames.name(e.availability.rawValue, NativeNames.eventAvailability),
        ]
        if let loc = e.location { out["location"] = loc }
        if let notes = e.notes { out["notes"] = notes }
        if let url = e.url { out["url"] = url.absoluteString }
        if let occ = e.occurrenceDate { out["occurrenceDate"] = DesktopEventKitValidation.iso(e.isAllDay ? Self.contractDay(occ, end: false) : occ) }
        if let org = e.organizer {
            out["organizer"] = ["name": org.name as Any? ?? NSNull(), "isCurrentUser": org.isCurrentUser]
        }
        if let attendees = e.attendees {
            out["attendees"] = attendees.map { p -> [String: Any] in
                ["name": p.name as Any? ?? NSNull(),
                 "role": NativeNames.name(p.participantRole.rawValue, NativeNames.participantRole),
                 "status": NativeNames.name(p.participantStatus.rawValue, NativeNames.participantStatus),
                 "type": NativeNames.name(p.participantType.rawValue, NativeNames.participantType)]
            }
        }
        if let alarms = e.alarms { out["alarms"] = DesktopEventKitValidation.alarmRows(alarms) }
        if let rules = e.recurrenceRules { out["recurrenceRules"] = DesktopEventKitValidation.recurrenceRows(rules) }
        if let sl = e.structuredLocation {
            var s: [String: Any] = ["title": sl.title as Any? ?? NSNull()]
            if let geo = sl.geoLocation {
                s["geoLocation"] = ["latitude": geo.coordinate.latitude, "longitude": geo.coordinate.longitude]
            }
            s["radius"] = sl.radius
            out["structuredLocation"] = s
        }
        return out
    }

    private func listEvents(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let start = parseDate(action["start"]),
              let end = parseDate(action["end"]) else {
            completion(WireFormat.error("calendar.events: --start and --end (ISO8601) required")); return
        }
        do {
            let cals = try resolveCalendars(action)
            let predicate = store.predicateForEvents(withStart: start, end: end, calendars: cals)
            let limit = (action["limit"] as? NSNumber)?.intValue ?? 100, offset = (action["offset"] as? NSNumber)?.intValue ?? 0
            let state = UncheckedSendableBox(CalendarEnumeration())
            store.enumerateEvents(matching: predicate) { event, stop in
                if !self.access.canContinue { stop.pointee = true; return }
                if state.value.scanned >= offset + limit { state.value.hasMore = true; stop.pointee = true; return }
                if state.value.scanned >= offset { state.value.events.append(event) }
                state.value.scanned += 1
            }
            guard access.canContinue else { completion(WireFormat.failure("cancelled", "Calendar enumeration retired at deadline")); return }
            completion(WireFormat.success(["events": try state.value.events.map { try eventDict($0, id: occurrenceId($0)) }, "limit": limit, "offset": offset, "hasMore": state.value.hasMore]))
        } catch { completion(DesktopEventKitValidation.nativeError(error)) }
    }

    private func getEvent(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("calendar.event: <id> required")); return }
        if let e = resolveEvent(id) {
            do { completion(WireFormat.success(try eventDict(e, id: id))) } catch { completion(DesktopEventKitValidation.nativeError(error)) }
        } else {
            completion(WireFormat.error("calendar.event: not found"))
        }
    }

    private func eventByExternal(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("calendar.event-by-external: <id> required")); return }
        let items = store.calendarItems(withExternalIdentifier: id).compactMap { $0 as? EKEvent }
        guard items.count <= 12000 else { completion(WireFormat.failure("resource_limit", "Calendar external-identity result exceeds 12000 native items")); return }
        let limit = (action["limit"] as? NSNumber)?.intValue ?? 100, offset = (action["offset"] as? NSNumber)?.intValue ?? 0
        do { completion(WireFormat.success(["events": try items.dropFirst(offset).prefix(limit).map { try eventDict($0) }, "limit": limit, "offset": offset, "hasMore": items.count > offset + limit])) } catch { completion(DesktopEventKitValidation.nativeError(error)) }
    }

    private func createEvent(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let title = action["title"] as? String,
              let start = parseDate(action["start"]),
              let end = parseDate(action["end"])
        else { completion(WireFormat.error("calendar.create: --title, --start, --end required")); return }
        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = start
        event.endDate = end
        if let allDay = action["all_day"] as? Bool { event.isAllDay = allDay }
        guard allDayDates(event, action) else { completion(WireFormat.failure("invalid_request", "all-day boundaries require UTC-midnight dates (for example 2030-03-08T00:00:00Z)")); return }
        if let loc = action["location"] as? String { event.location = loc }
        if let notes = action["notes"] as? String { event.notes = notes }
        if let urlStr = action["url"] as? String, let u = URL(string: urlStr) { event.url = u }
        let calId = action["calendar"] as? String
        guard let cal = calId == nil ? store.defaultCalendarForNewEvents : eventCalendar(calId!), cal.allowsContentModifications, !cal.isImmutable else { completion(WireFormat.failure("target_gone", "Calendar create requires an exact writable event calendar; invalid explicit identity never selects the default")); return }
        event.calendar = cal
        event.alarms = DesktopEventKitValidation.alarms(action)
        if let rule = DesktopEventKitValidation.recurrence(action) { event.recurrenceRules = [rule] }
        saveEvent(event, span: .thisEvent, completion: completion)
    }

    private func updateEvent(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String, let event = resolveEvent(id) else {
            completion(WireFormat.error("calendar.update: unknown id")); return
        }
        let span = parseSpan(action["span"] as? String)
        // EventKit accepted a recurrence change for one occurrence and changed the series instead (live check), so this refuses as on Windows and Linux.
        if span == .thisEvent, event.hasRecurrenceRules || event.isDetached, ["recurrence_frequency", "recurrence_interval", "recurrence_end"].contains(where: { action[$0] != nil }) {
            completion(WireFormat.failure("invalid_request", "one occurrence has no recurrence of its own; change the recurrence with --span future; no change was made")); return
        }
        if let title = action["title"] as? String { event.title = title }
        if let start = parseDate(action["start"]) { event.startDate = start }
        if let end = parseDate(action["end"]) { event.endDate = end }
        if let allDay = action["all_day"] as? Bool { event.isAllDay = allDay }
        guard allDayDates(event, action) else { completion(WireFormat.failure("invalid_request", "all-day boundaries require UTC-midnight dates (for example 2030-03-08T00:00:00Z)")); return }
        if let loc = action["location"] as? String { event.location = loc }
        if let notes = action["notes"] as? String { event.notes = notes }
        if let urlStr = action["url"] as? String, let u = URL(string: urlStr) { event.url = u }
        if let urlStr = action["url"] as? String, urlStr.isEmpty { event.url = nil }
        if action["alarms"] != nil { event.alarms = DesktopEventKitValidation.alarms(action) }
        if let rule = DesktopEventKitValidation.recurrence(action) { event.recurrenceRules = [rule] }
        // On a recurring event EventKit owns the rule after a one-occurrence save or a split (it shortens the count), so
        // the rule is compared only when this edit changed it.
        let recurring = event.hasRecurrenceRules || event.isDetached
        let ruleChanged = ["recurrence_frequency", "recurrence_interval", "recurrence_end"].contains(where: { action[$0] != nil })
        saveEvent(event, span: span, occurrenceRow: Self.isOccurrenceId(id) || recurring, checkRule: !recurring || ruleChanged, completion: completion)
    }

    private func deleteEvent(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String, let event = resolveEvent(id), let nativeId = event.eventIdentifier else {
            completion(WireFormat.error("calendar.delete: unknown id")); return
        }
        let span = parseSpan(action["span"] as? String)
        guard let calendar = event.calendar, calendar.allowsContentModifications, !calendar.isImmutable, access.canContinue else { completion(WireFormat.failure("permission_denied", "Calendar event is not writable or request retired")); return }
        guard let start = event.startDate, let end = event.endDate else { completion(WireFormat.failure("provider_failed", "Calendar event lacks occurrence dates")); return }
        let calendarId = calendar.calendarIdentifier
        var committed = false
        do {
            try store.remove(event, span: span, commit: true)
            committed = true; store.reset()
            guard try readOccurrence(id: nativeId, calendar: calendarId, start: start, end: end) == nil else { completion(WireFormat.failure("timeout_unknown_outcome", "Calendar remove returned but exact native occurrence remains")); return }
            completion(WireFormat.success(["ok": true, "id": id]))
        } catch {
            completion(DesktopEventKitValidation.nativeError(error, afterCommit: committed))
        }
    }

    private func moveEvent(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String, let event = resolveEvent(id) else {
            completion(WireFormat.error("calendar.move: unknown id")); return
        }
        guard !Self.isOccurrenceId(id) else { completion(WireFormat.failure("unsupported_operation", "one occurrence cannot move to another calendar; move the series by its id; no change was made")); return }
        guard let to = action["to"] as? String, let target = eventCalendar(to), target.allowsContentModifications, !target.isImmutable, event.calendar?.allowsContentModifications == true else {
            completion(WireFormat.error("calendar.move: --to <calendar-id> required")); return
        }
        event.calendar = target
        saveEvent(event, span: .thisEvent, completion: completion)
    }

    private func saveEvent(_ event: EKEvent, span: EKSpan, occurrenceRow: Bool = false, checkRule: Bool = true, completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let calendar = event.calendar, calendar.allowsContentModifications, !calendar.isImmutable, let start = event.startDate, let end = event.endDate, end > start else { completion(WireFormat.failure("target_gone", "Calendar mutation requires writable native calendar and increasing final dates")); return }
        guard access.canContinue else { completion(WireFormat.failure("cancelled", "Calendar request expired before native save")); return }
        let expectedCalendar = calendar.calendarIdentifier, expectedTitle = event.title, expectedStart = start, expectedEnd = end
        let expectedAllDay = event.isAllDay, expectedLocation = event.location, expectedNotes = event.notes, expectedURL = event.url
        let expectedAlarms = DesktopEventKitValidation.alarmRows(event.alarms), expectedRecurrence = DesktopEventKitValidation.recurrenceRows(event.recurrenceRules)
        var committed = false
        do {
            try store.save(event, span: span, commit: true); committed = true
            guard let id = event.eventIdentifier else { completion(WireFormat.failure("timeout_unknown_outcome", "Calendar save committed without native identity")); return }
            store.reset()
            guard let saved = try readOccurrence(id: id, calendar: expectedCalendar, start: expectedStart, end: expectedEnd) else { completion(WireFormat.failure("timeout_unknown_outcome", "Calendar save committed but the saved occurrence could not be read back; no replay")); return }
            let differs = [("title", saved.title == expectedTitle), ("end", saved.endDate == expectedEnd), ("allDay", saved.isAllDay == expectedAllDay), ("location", saved.location == expectedLocation), ("notes", saved.notes == expectedNotes), ("url", saved.url == expectedURL), ("alarms", NSArray(array: DesktopEventKitValidation.alarmRows(saved.alarms)).isEqual(to: expectedAlarms)), ("recurrence", !checkRule || NSArray(array: DesktopEventKitValidation.recurrenceRows(saved.recurrenceRules)).isEqual(to: expectedRecurrence))].filter { !$0.1 }.map { $0.0 }
            guard differs.isEmpty else { completion(WireFormat.failure("timeout_unknown_outcome", "Calendar save committed but independent native occurrence readback differs (\(differs.joined(separator: ", "))); no replay", details: ["differs": differs])); return }
            completion(WireFormat.success(try eventDict(saved, id: occurrenceRow ? occurrenceId(saved) : nil)))
        } catch { completion(DesktopEventKitValidation.nativeError(error, afterCommit: committed)) }
    }

    private func readOccurrence(id: String, calendar: String, start: Date, end: Date) throws -> EKEvent? {
        guard let cal = eventCalendar(calendar) else { throw NSError(domain: "Interceptor.Calendar", code: 3, userInfo: [NSLocalizedDescriptionKey: "Native calendar vanished during readback"]) }
        let state = UncheckedSendableBox(CalendarEnumeration())
        let predicate = store.predicateForEvents(withStart: start.addingTimeInterval(-1), end: end.addingTimeInterval(1), calendars: [cal])
        store.enumerateEvents(matching: predicate) { event, stop in
            if !self.access.canContinue || state.value.scanned >= 12000 { state.value.hasMore = true; stop.pointee = true; return }
            state.value.scanned += 1
            if let native = event.eventIdentifier, Self.sameEvent(native, id), event.startDate == start { state.value.events.append(event); if state.value.events.count > 1 { stop.pointee = true } }
        }
        guard !state.value.hasMore, state.value.events.count <= 1 else { throw NSError(domain: "Interceptor.Calendar", code: 4, userInfo: [NSLocalizedDescriptionKey: "Native occurrence readback exceeded bounds or identity is ambiguous"]) }
        return state.value.events.first
    }

    private func refreshSources(completion: @escaping @Sendable ([String: Any]) -> Void) {
        store.refreshSourcesIfNecessary()
        completion(WireFormat.success(["ok": true]))
    }

    private func reset(completion: @escaping @Sendable ([String: Any]) -> Void) {
        store.reset()
        completion(WireFormat.success(["ok": true]))
    }

    // Store invalidation notices are a counter, never a fabricated event journal.
    private func tail(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if observer == nil { observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: nil) { [weak self] _ in
            guard let self else { return }; self.changesLock.lock(); if self.changeCount < 9_007_199_254_740_991 { self.changeCount += 1 }; self.lastChange = Date(); self.changesLock.unlock()
        } }
        changesLock.lock(); let count = changeCount, last = lastChange; changesLock.unlock()
        completion(WireFormat.success(["tailing": true, "changeCount": count, "lastChange": last.map(DesktopEventKitValidation.iso) as Any? ?? NSNull()]))
    }
}

private final class CalendarEnumeration { var scanned = 0; var events: [EKEvent] = []; var hasMore = false }
