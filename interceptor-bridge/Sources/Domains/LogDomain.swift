// native log query primitive — log_query.
// Replaces tailing files via bash. Uses OSLogStore + OSLogEnumerator on
// macOS 12+. Returns structured entries (timestamp, subsystem, category,
// message, level) instead of opaque text.

import Foundation
#if canImport(OSLog)
import OSLog
#endif

final class LogDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "query":
            handleQuery(action, completion: completion)
        default:
            completion(WireFormat.error("log: unknown command \(command)"))
        }
    }

    private func handleQuery(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let neutral = action["type"] as? String == "desktop_log_query"
        if let failure = DesktopLogValidation.validate(action) { completion(failure); return }
        let limit = (action["limit"] as? Int) ?? 100
        let predicateStr = action["predicate"] as? String
        let sinceStr = action["since"] as? String
        let includeInfo = (action["includeInfo"] as? Bool) ?? false
        let includeDebug = (action["includeDebug"] as? Bool) ?? false
        let terms = neutral ? ((try? DesktopLogValidation.terms(predicateStr ?? "")) ?? []) : []

        #if canImport(OSLog)
        if #available(macOS 12.0, *) {
            do {
                // OSLogStore.Scope
                // .currentProcessIdentifier returns ONLY entries from this
                // bridge process — by definition cannot return entries
                // from com.apple.WindowServer or any other subsystem the
                // caller queries. Apple documents OSLogStore.local() as
                // the system-wide alternative
                // (OSLog/OSLogStore.md:25-26). Switch to .local() so the
                // documented predicate-based queries against arbitrary
                // subsystems actually return entries.
                let store = try OSLogStore.local()
                let position: OSLogPosition
                if let s = sinceStr {
                    let f = ISO8601DateFormatter()
                    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                    if let date = neutral ? DesktopLogValidation.timestamp(s) : (f.date(from: s) ?? ISO8601DateFormatter().date(from: s)) {
                        position = store.position(date: date)
                    } else {
                        position = store.position(date: Date(timeIntervalSinceNow: -300))
                    }
                } else {
                    position = store.position(date: Date(timeIntervalSinceNow: -300))
                }
                var pred: NSPredicate? = nil
                if let p = predicateStr, !p.isEmpty, !neutral {
                    pred = NSPredicate(format: p)
                } else if neutral {
                    // These string keys are documented by the installed `log
                    // help predicates`. Values are arguments, never syntax.
                    let nativeTerms = terms.filter { $0.field != "level" }.map { term in
                        let key = term.field == "message" ? "composedMessage" : term.field
                        return NSPredicate(format: term.contains ? "%K CONTAINS %@" : "%K == %@", key, term.value)
                    }
                    if !nativeTerms.isEmpty { pred = NSCompoundPredicate(andPredicateWithSubpredicates: nativeTerms) }
                }
                let entries = try store.getEntries(at: position, matching: pred)
                let started = ProcessInfo.processInfo.systemUptime
                var out: [[String: Any]] = []
                var scanned = 0
                var bytes = 64
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                for entry in entries {
                    if neutral && (scanned >= DESKTOP_LOG_MAX_SCAN_ENTRIES || (ProcessInfo.processInfo.systemUptime - started) * 1000 > Double(DESKTOP_LOG_DEADLINE_MS)) {
                        completion(DesktopLogValidation.failure("resource_limit", "log scan exceeded 5 seconds or 100000 entries; narrow since/predicate")); return
                    }
                    scanned += 1
                    var record: [String: Any]
                    if let logEntry = entry as? OSLogEntryLog {
                        let level: String
                        if neutral {
                            switch logEntry.level {
                            case .debug: level = "debug"
                            case .info: level = "info"
                            case .notice: level = "default"
                            case .error: level = "error"
                            case .fault: level = "fault"
                            default: level = "undefined"
                            }
                        } else { level = String(describing: logEntry.level) }
                        if logEntry.level == .info && !includeInfo { continue }
                        if logEntry.level == .debug && !includeDebug { continue }
                        record = [
                            "timestamp": f.string(from: logEntry.date),
                            "subsystem": logEntry.subsystem,
                            "category": logEntry.category,
                            "message": logEntry.composedMessage,
                            "level": level,
                            "process": logEntry.process
                        ]
                    } else {
                        record = [
                            "timestamp": f.string(from: entry.date),
                            "message": entry.composedMessage
                        ]
                    }
                    if neutral {
                        if !DesktopLogValidation.matches(record, terms: terms) { continue }
                        if record.contains(where: { key, value in key != "message" && key != "timestamp" && (value as? String)?.utf8.count ?? 0 > 4096 }) {
                            completion(DesktopLogValidation.failure("resource_limit", "log metadata exceeds 4096 bytes")); return
                        }
                        bytes += try JSONSerialization.data(withJSONObject: record).count + 1
                        if bytes > DESKTOP_LOG_MAX_RESULT_BYTES {
                            completion(DesktopLogValidation.failure("resource_limit", "log output exceeds 1 MiB; narrow since/predicate")); return
                        }
                    }
                    out.append(record)
                    if out.count >= limit { break }
                }
                completion(WireFormat.success(["entries": out, "count": out.count, "scope": "local"]))
                return
            } catch {
                if neutral {
                    let native = error as NSError
                    // OSLogStore.local() requires an administrative account.
                    // The actual non-admin macOS 27 fixture returns this domain
                    // and code for "Client lacks entitlement to perform operation".
                    let denied = (native.domain == "OSLogErrorDomain" && native.code == 9) ||
                        (native.domain == NSPOSIXErrorDomain && [EPERM, EACCES].contains(Int32(native.code))) ||
                        (native.domain == NSCocoaErrorDomain && native.code == NSFileReadNoPermissionError)
                    completion(DesktopLogValidation.failure(denied ? "permission_denied" : "provider_failed", "log_query failed: \(error.localizedDescription)"))
                } else { completion(WireFormat.error("log_query failed: \(error.localizedDescription)")) }
                return
            }
        }
        #endif
        completion(WireFormat.error("log_query: requires macOS 12+ (OSLogStore unavailable)"))
    }
}
