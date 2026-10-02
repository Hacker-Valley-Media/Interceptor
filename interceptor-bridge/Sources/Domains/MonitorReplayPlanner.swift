import Foundation

// Replay plan emitter — converts a sequence of monitor
// events into a shell-script of `interceptor macos *` invocations that an
// agent can re-run. Intentionally conservative: we never emit a verb whose
// targeting strategy we can't reconstruct from the event payload. Where the
// AX tree-position trumps role+name (e.g. raw click coords, no role/name),
// we emit a coordinate fallback with the app name pinned via --app.
//
// Mirrors the browser planner at cli/commands/monitor.ts:296-447 in spirit.
// The macOS analog of "wait-stable" is a re-read of the focused element,
// since macOS has no DOM-mutation equivalent — the AX tree is the source of
// truth and re-reading it is the deterministic gate.

enum MonitorReplayPlanner {

    static func generateTimeline(events: [[String: Any]], instruction: String?) -> String {
        var lines: [String] = []
        if let instruction = instruction {
            lines.append("# Session: \(instruction)")
            lines.append("")
        }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        for event in events {
            let ts = (event["t"] as? Int) ?? 0
            let date = Date(timeIntervalSince1970: Double(ts) / 1000.0)
            let timeStr = formatter.string(from: date)
            let kind = (event["event"] as? String) ?? "?"
            let app = (event["app"] as? String) ?? ""
            let role = (event["r"] as? String) ?? ""
            let name = (event["n"] as? String) ?? ""
            switch kind {
            case "click", "rclick", "dblclick":
                lines.append("\(timeStr)  \(kind.uppercased())  \(app)  \(role):\(name)")
            case "key":
                let kc = (event["kc"] as? String) ?? ""
                lines.append("\(timeStr)  KEY       \(app)  \(kc)")
            case "scroll":
                lines.append("\(timeStr)  SCROLL    \(app)")
            case "frontmost":
                lines.append("\(timeStr)  APP       → \(app)")
            case "input", "change":
                let v = (event["v"] as? String) ?? ""
                lines.append("\(timeStr)  INPUT     \(app)  \(role):\(name)  v=\"\(v)\"")
            case "menu_select":
                lines.append("\(timeStr)  MENU      \(app)  \(name)")
            default:
                lines.append("\(timeStr)  \(kind)  \(app)")
            }
        }
        return lines.joined(separator: "\n")
    }

    static func generateReplayPlan(events: [[String: Any]], instruction: String?) -> String {
        var lines: [String] = []
        lines.append("# Replay plan for macOS monitor session")
        if let inst = instruction { lines.append("# Instruction: \(inst)") }
        lines.append("# Generated at \(ISO8601DateFormatter().string(from: Date()))")
        lines.append("")

        var lastApp = ""
        var pendingMenuTopLevel: String?

        for event in events {
            let kind = (event["event"] as? String) ?? ""
            let app = (event["app"] as? String) ?? ""
            let role = (event["r"] as? String) ?? ""
            let name = (event["n"] as? String) ?? ""

            // The recording changed apps here. A replay must not take the
            // user's focus the way the recorded user did: `open` is a no-op on
            // a running app and a background launch otherwise, and every verb
            // below is pinned to its app with --app.
            if !app.isEmpty && app != lastApp {
                lines.append("interceptor macos open \(escapeArg(app))")
                lastApp = app
            }

            switch kind {
            case "mon_start", "mon_stop", "mon_pause", "mon_resume",
                 "mon_attach", "mon_detach":
                continue
            case "click":
                emitClick(event, kind: "click", lines: &lines)
            case "rclick":
                emitClick(event, kind: "click --right", lines: &lines)
            case "dblclick":
                emitClick(event, kind: "click --double", lines: &lines)
            case "key":
                if let kc = event["kc"] as? String, !kc.isEmpty {
                    var cmd = "interceptor macos keys \(quote(kc))"
                    if !app.isEmpty { cmd += " --app \(quote(app))" }
                    lines.append(cmd)
                }
            case "input", "change":
                if let v = event["v"] as? String,
                   !(v.hasPrefix("***") && v.hasSuffix("***")),
                   (!role.isEmpty && !name.isEmpty) {
                    var cmd = "interceptor macos type \(quote("\(role):\(name)")) \(quote(v))"
                    if !app.isEmpty { cmd += " --app \(quote(app))" }
                    lines.append(cmd)
                } else if let v = event["v"] as? String, v.hasPrefix("***") {
                    lines.append("# masked secure input on \(role):\(name) (length \(max(0, v.count - 6)))")
                }
            case "menu_open":
                pendingMenuTopLevel = name
            case "menu_select":
                if let top = pendingMenuTopLevel, !top.isEmpty, !name.isEmpty {
                    var cmd = "interceptor macos menu \(quote(top)) \(quote(name))"
                    if !app.isEmpty { cmd += " --app \(quote(app))" }
                    lines.append(cmd)
                    pendingMenuTopLevel = nil
                } else if !name.isEmpty {
                    lines.append("# menu selection \"\(name)\" — top-level menu unknown; consider explicit menu invocation")
                }
            case "scroll":
                let dy = (event["sy"] as? Double) ?? 0
                if dy > 0 { lines.append("interceptor macos scroll up 50 --app \(quote(app))") }
                if dy < 0 { lines.append("interceptor macos scroll down 50 --app \(quote(app))") }
            case "window_create", "sheet":
                lines.append("# observed-only: \(kind) on \(app) — no driver verb")
            case "frontmost":
                // Already handled above via app-switch detection.
                break
            case "focus", "blur", "selection", "title_change", "window_focus",
                 "window_move", "window_resize", "layout_change",
                 "ax_app_activated", "ax_app_deactivated", "ax_create",
                 "ax_destroy":
                // Observed-only events have no driver verb. Skip silently to
                // keep plans short.
                continue
            case "clipboard", "file_change", "network_path", "notification",
                 "log", "frame", "ocr_text", "speech_segment":
                lines.append("# observation event: \(kind)")
            default:
                lines.append("# unhandled event: \(kind)")
            }
        }
        return lines.joined(separator: "\n")
    }

    // MARK: - helpers

    private static func emitClick(_ event: [String: Any], kind: String, lines: inout [String]) {
        let role = (event["r"] as? String) ?? ""
        let name = (event["n"] as? String) ?? ""
        let app = (event["app"] as? String) ?? ""
        if !role.isEmpty && !name.isEmpty {
            var cmd = "interceptor macos \(kind) \(quote("\(role):\(name)"))"
            if !app.isEmpty && !kind.contains(",") { cmd += " --app \(quote(app))" }
            lines.append(cmd)
        } else if let x = event["x"] as? Int, let y = event["y"] as? Int {
            // Coordinate fallback — pin to the app via --app so the click
            // routes through postToPid (per InputDomain coordinate-click path).
            var cmd = "interceptor macos \(kind) \(x),\(y)"
            if !app.isEmpty { cmd += " --app \(quote(app))" }
            lines.append(cmd)
        } else {
            lines.append("# click with no ref/coords — skipped")
        }
    }

    private static func escapeArg(_ s: String) -> String {
        return "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    private static func quote(_ s: String) -> String { escapeArg(s) }
}
