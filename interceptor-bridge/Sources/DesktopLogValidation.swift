import Foundation

enum DesktopLogValidation {
    struct Term { let field: String; let contains: Bool; let value: String }
    static func terms(_ value: String) throws -> [Term] {
        guard value.utf8.count <= 4096 else { throw Invalid("log predicate exceeds 4096 bytes") }
        let pattern = #"^(subsystem|category|message|process|level)\s*(==|CONTAINS)\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")"#
        let regex = try NSRegularExpression(pattern: pattern)
        var rest = value.trimmingCharacters(in: .whitespacesAndNewlines)
        var result: [Term] = []
        while !rest.isEmpty {
            let range = NSRange(rest.startIndex..<rest.endIndex, in: rest)
            guard let match = regex.firstMatch(in: rest, range: range),
                  let full = Range(match.range, in: rest),
                  let field = Range(match.range(at: 1), in: rest),
                  let op = Range(match.range(at: 2), in: rest),
                  let literal = Range(match.range(at: 3), in: rest),
                  let data = String(rest[literal]).data(using: .utf8),
                  let decoded = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? String
            else { throw Invalid("log predicate requires literal == or CONTAINS comparisons joined by AND") }
            guard result.count < 16, !decoded.contains("\0") else { throw Invalid("log predicate exceeds its literal or term bounds") }
            result.append(Term(field: String(rest[field]), contains: rest[op] == "CONTAINS", value: decoded))
            rest = String(rest[full.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if rest.isEmpty { break }
            guard rest.hasPrefix("AND"), rest.count > 3,
                  rest.dropFirst(3).first?.isWhitespace == true
            else { throw Invalid("log predicate supports AND between comparisons") }
            rest = String(rest.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !rest.isEmpty else { throw Invalid("log predicate ends with AND") }
        }
        return result
    }
    struct Invalid: Error { let message: String; init(_ message: String) { self.message = message } }
    static func timestamp(_ value: String) -> Date? {
        let pattern = #"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..<value.endIndex, in: value))
        else { return nil }
        var parts: [Int] = []
        for index in 1...6 {
            guard let range = Range(match.range(at: index), in: value), let n = Int(value[range]) else { return nil }
            parts.append(n)
        }
        guard parts[0] >= 1, (1...12).contains(parts[1]), (1...31).contains(parts[2]),
              parts[3] <= 23, parts[4] <= 59, parts[5] <= 59 else { return nil }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let components = DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: parts[3], minute: parts[4], second: parts[5])
        guard let date = calendar.date(from: components), calendar.component(.year, from: date) == parts[0],
              calendar.component(.month, from: date) == parts[1], calendar.component(.day, from: date) == parts[2]
        else { return nil }
        guard let offset = Range(match.range(at: 7), in: value) else { return nil }
        let zone = String(value[offset])
        if zone != "Z" {
            let numbers = zone.dropFirst().split(separator: ":").compactMap { Int($0) }
            guard numbers.count == 2, numbers[0] <= 23, numbers[1] <= 59 else { return nil }
        }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    static func validate(_ action: [String: Any]) -> [String: Any]? {
        guard action["type"] as? String == "desktop_log_query" else { return nil }
        if let error = DesktopLogShape.validationError(action) { return failure("invalid_request", error) }
        if let limit = (action["limit"] as? NSNumber)?.doubleValue, !limit.isFinite || limit.rounded() != limit || !(1...Double(DESKTOP_LOG_MAX_ENTRIES)).contains(limit) {
            return failure("invalid_request", "log limit must be an integer in 1..1000")
        }
        if let since = action["since"] as? String, timestamp(since) == nil { return failure("invalid_request", "log since requires a valid RFC3339 timestamp") }
        do { _ = try terms(action["predicate"] as? String ?? "") }
        catch { return failure("invalid_request", (error as? Invalid)?.message ?? "invalid log predicate") }
        return nil
    }
    static func matches(_ entry: [String: Any], terms: [Term]) -> Bool {
        terms.allSatisfy { term in
            guard let value = entry[term.field] as? String else { return false }
            return term.contains ? value.contains(term.value) : value == term.value
        }
    }
    static func failure(_ code: String, _ message: String) -> [String: Any] { ["success": false, "code": code, "error": message] }
}
