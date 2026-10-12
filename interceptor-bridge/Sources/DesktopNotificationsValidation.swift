import Foundation

enum DesktopNotificationsValidation {
    static let common: Set<String> = ["type", "sub", "namespace", "group", "groupColor", "groupSoft"]
    static let content: Set<String> = ["title", "subtitle", "body", "sound", "badge", "category", "thread", "user_info", "interruption", "attachment", "id"]
    static func string(_ value: Any?, _ maximum: Int, empty: Bool = true) -> Bool {
        guard let s = value as? String else { return false }
        return (empty || !s.isEmpty) && s.utf8.count <= maximum && !s.utf8.contains(0)
    }
    static func identifier(_ value: Any?) -> Bool { string(value, 128, empty: false) }
    static func format(_ raw: String, summary: Bool) -> Bool {
        let chars = Array(raw); var index = 0, count = false, list = false
        while index < chars.count {
            if chars[index] == "%" {
                index += 1; guard index < chars.count else { return false }
                let spec = chars[index]
                if spec == "%" { index += 1; continue }
                if spec == "u", !count, !list { count = true }
                else if spec == "@", summary, count, !list { list = true }
                else { return false }
            }
            index += 1
        }
        return true
    }
    static func json(_ raw: String) throws -> [String: Any] {
        guard string(raw, 16384, empty: false), let dict = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { throw Invalid("notification user-info requires a JSON object of at most 16384 bytes") }
        var budget = 2048
        func visit(_ value: Any, depth: Int) throws {
            budget -= 1
            guard budget >= 0, depth <= 8 else { throw Invalid("notification user-info exceeds depth 8 or 2048 values") }
            if let s = value as? String, s.contains("\0") { throw Invalid("notification user-info contains NUL") }
            if let d = value as? [String: Any] { for (key, item) in d { guard !key.contains("\0") else { throw Invalid("notification user-info key contains NUL") }; try visit(item, depth: depth + 1) } }
            else if let a = value as? [Any] { for item in a { try visit(item, depth: depth + 1) } }
        }
        try visit(dict, depth: 0); return dict
    }
    static func components(_ raw: String) throws -> DateComponents {
        guard string(raw, 512, empty: false) else { throw Invalid("notification components require a bounded key=integer list") }
        let ranges = ["year": 1...9999, "month": 1...12, "day": 1...31, "weekday": 1...7, "hour": 0...23, "minute": 0...59, "second": 0...59]
        var result: [String: Int] = [:]
        for entry in raw.components(separatedBy: ",") {
            let parts = entry.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "=")
            guard parts.count == 2, let range = ranges[parts[0]], result[parts[0]] == nil,
                  parts[1].range(of: "^[0-9]{1,4}$", options: .regularExpression) != nil,
                  let n = Int(parts[1]), range.contains(n) else { throw Invalid("notification components contain an unknown, duplicate, malformed or out-of-range key") }
            result[parts[0]] = n
        }
        if let month = result["month"], let day = result["day"] {
            var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(secondsFromGMT: 0)!
            let value = DateComponents(year: result["year"] ?? 2000, month: month, day: day)
            guard let date = cal.date(from: value), cal.component(.month, from: date) == month else { throw Invalid("notification calendar date does not exist") }
        }
        return DateComponents(year: result["year"], month: result["month"], day: result["day"], hour: result["hour"], minute: result["minute"], second: result["second"], weekday: result["weekday"])
    }
    static func actions(_ raw: String) throws -> [DesktopNotificationActionDefinition] {
        guard string(raw, 16384, empty: false) else { throw Invalid("notification category actions exceed 16384 bytes") }
        let entries = try JSONDecoder().decode([DesktopNotificationActionDefinition].self, from: Data(raw.utf8))
        guard entries.count <= 8 else { throw Invalid("notification categories allow at most 8 actions") }
        var ids: Set<String> = []
        for row in entries {
            let options = row.options ?? []
            guard identifier(row.identifier), ids.insert(row.identifier).inserted, string(row.title, 256, empty: false), Set(options.map(\.rawValue)).count == options.count, options.count <= 3 else { throw Invalid("notification action identity/title/options are invalid or duplicated") }
        }
        return entries
    }
    struct Invalid: Error { let message: String; init(_ message: String) { self.message = message } }
    static func failure(_ code: String, _ text: String) -> [String: Any] { ["success": false, "code": code, "error": String(text.prefix(512))] }
    static func validate(_ action: [String: Any]) -> [String: Any]? {
        guard action["type"] as? String == "desktop_notifications" else { return nil }
        if let error = DesktopNotificationShape.validationError(action) { return failure("invalid_request", error) }
        let sub = action["sub"] as! String
        let fields: Set<String>
        switch sub {
        case "tail", "untail": fields = ["name"]
        case "log": fields = ["limit", "app"]
        case "request": fields = ["options"]
        case "post": fields = content
        case "schedule-after": fields = content.union(["seconds", "repeats"])
        case "schedule-at": fields = content.union(["date", "repeats"])
        case "schedule-cron": fields = content.union(["components", "repeats"])
        case "cancel", "dismiss": fields = ["id"]
        case "pending", "delivered": fields = ["limit"]
        case "categories": fields = ["verb", "identifier", "actions", "intent_identifiers", "summary_format", "hidden_placeholder"]
        case "badge": fields = ["count", "clear"]
        default: fields = []
        }
        guard Set(action.keys).isSubset(of: common.union(fields)) else { return failure("invalid_request", "notification field is not valid for this operation") }
        if let ns = action["namespace"] as? String, ns.range(of: "^[a-zA-Z0-9_-]{1,64}$", options: .regularExpression) == nil { return failure("invalid_request", "notification namespace requires 1..64 ASCII letters, digits, underscore or hyphen") }
        func int(_ key: String, _ min: Int, _ max: Int) -> Bool { DesktopFilesystemValidation.boundedInteger(action[key], minimum: Double(min), maximum: Double(max)) }
        if !int("limit", 0, DESKTOP_NOTIFICATION_MAX_ENTRIES) { return failure("invalid_request", "notification limit must be an integer in 0..1000") }
        for key in ["id", "identifier", "category", "thread"] where action[key] != nil { if !identifier(action[key]) { return failure("invalid_request", "notification identifiers require 1..128 UTF-8 bytes without NUL") } }
        if ["cancel", "dismiss"].contains(sub), action["id"] == nil { return failure("invalid_request", "notification removal requires an exact public identifier") }
        if ["tail", "untail"].contains(sub), !string(action["name"], 512, empty: false) { return failure("invalid_request", "notification tail/untail require an exact bounded distributed name") }
        if action["app"] != nil, !string(action["app"], 512, empty: false) { return failure("invalid_request", "notification log filter requires 1..512 bytes") }
        for key in ["title", "subtitle"] where action[key] != nil { if !string(action[key], 4096) { return failure("invalid_request", "notification title/subtitle exceed 4096 bytes or contain NUL") } }
        if action["body"] != nil, !string(action["body"], 32768) { return failure("invalid_request", "notification body exceeds 32768 bytes or contains NUL") }
        for key in ["sound", "summary_format", "hidden_placeholder"] where action[key] != nil { if !string(action[key], 2048, empty: false) { return failure("invalid_request", "notification option exceeds 2048 bytes or contains NUL") } }
        for key in ["summary_format", "hidden_placeholder"] { if let raw = action[key] as? String, !format(raw, summary: key == "summary_format") { return failure("invalid_request", "notification category formats allow one %u, followed by an optional %@ in summaries, and escaped %%") } }
        if !int("badge", 0, 9999) || !int("count", 0, 9999) { return failure("invalid_request", "notification badge must be an integer in 0..9999") }
        if sub == "badge", (action["clear"] == nil && action["count"] == nil) || (action["clear"] != nil && action["clear"] as? Bool != true) || (action["clear"] != nil && action["count"] != nil) { return failure("invalid_request", "notification badge requires a count or clear, without conflicting selectors") }
        if sub == "schedule-after", action["seconds"] == nil || !int("seconds", 1, DESKTOP_NOTIFICATION_MAX_SECONDS) { return failure("invalid_request", "notification seconds require an integer in 1..31536000") }
        if sub == "schedule-after", action["repeats"] as? Bool == true, (action["seconds"] as? NSNumber)?.intValue ?? 0 < 60 { return failure("invalid_request", "repeating notification intervals require at least 60 seconds") }
        if sub == "schedule-at" {
            guard let raw = action["date"] as? String, let date = DesktopLogValidation.timestamp(raw), date > Date(), date.timeIntervalSinceNow <= Double(DESKTOP_NOTIFICATION_MAX_SECONDS), action["repeats"] as? Bool != true else { return failure("invalid_request", "notification date requires a future one-time RFC3339 instant within 365 days") }
        }
        do {
            if let raw = action["user_info"] as? String { _ = try json(raw) }
            if sub == "schedule-cron" { _ = try components(action["components"] as? String ?? "") }
            if let raw = action["attachment"] as? String {
                guard string(raw, 32768, empty: false) else { throw Invalid("notification attachments exceed 32768 bytes") }
                let attachments = raw.components(separatedBy: ","); var ids: Set<String> = []
                guard attachments.count <= 8 else { throw Invalid("notifications allow at most 8 attachments") }
                for item in attachments {
                    let parts = item.components(separatedBy: "="), path = parts.last!
                    guard parts.count <= 2, path.hasPrefix("/"), string(path, 4096, empty: false), parts.count == 1 || (identifier(parts[0]) && ids.insert(parts[0]).inserted) else { throw Invalid("notification attachments require bounded absolute paths and distinct optional identifiers") }
                }
            }
            if sub == "request" {
                let options = (action["options"] as? String ?? "alert,sound,badge").components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                let allowed: Set<String> = ["alert", "sound", "badge", "criticalAlert", "provisional", "providesAppNotificationSettings"]
                guard !options.isEmpty, options.count <= 6, Set(options).count == options.count, options.allSatisfy({ allowed.contains($0) }) else { throw Invalid("notification authorization options are unknown, empty or duplicated") }
            }
            if sub == "categories" {
                if action["verb"] as? String ?? "list" == "register" {
                    guard identifier(action["identifier"]), let raw = action["actions"] as? String else { throw Invalid("notification category register requires identifier and actions JSON") }
                    _ = try actions(raw)
                    if let raw = action["intent_identifiers"] as? String { let ids = raw.components(separatedBy: ","); guard ids.count <= 8, Set(ids).count == ids.count, ids.allSatisfy({ identifier($0) }) else { throw Invalid("notification intent identifiers must be at most 8 distinct bounded strings") } }
                } else if !Set(action.keys).isSubset(of: common.union(["verb"])) { throw Invalid("notification category list/clear accept no registration fields") }
            }
            guard try JSONSerialization.data(withJSONObject: action).count <= DESKTOP_NOTIFICATION_MAX_CONTENT_BYTES else { throw Invalid("notification content exceeds 65536 bytes") }
        } catch { return failure("invalid_request", (error as? Invalid)?.message ?? "invalid notification JSON/calendar/action fields") }
        return nil
    }
}
