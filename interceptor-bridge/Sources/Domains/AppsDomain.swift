import Foundation
import AppKit
import ApplicationServices

final class AppsDomain: DomainHandler, @unchecked Sendable {
    private struct FrontmostInfo {
        let app: NSRunningApplication
        let payload: [String: Any]
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "apps":
            listApps(completion: completion)
        case "app":
            let subcommand = action["subcommand"] as? String ?? "activate"
            handleApp(subcommand, action: action, completion: completion)
        case "frontmost":
            frontmost(completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func listApps(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let workspace = NSWorkspace.shared
        let apps = workspace.runningApplications.filter { $0.activationPolicy == .regular }
        // Same {name, pid} rows as Windows and Linux; the CLI prints them as text lines.
        let rows: [[String: Any]] = apps.map { app in
            var row: [String: Any] = ["name": app.localizedName ?? "(unknown)", "pid": Int(app.processIdentifier), "active": app.isActive, "hidden": app.isHidden]
            if let bundleId = app.bundleIdentifier { row["bundleId"] = bundleId }
            return row
        }
        completion(WireFormat.success(rows))
    }

    private func frontmost(completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let info = frontmostInfo() else {
            completion(WireFormat.error("no frontmost application"))
            return
        }
        completion(WireFormat.success(info.payload))
    }

    private func handleApp(_ subcommand: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch subcommand {
        case "activate", "hide", "unhide", "quit":
            let name = action["app"] as? String
            let pid = action["pid"] as? Int32
            let matches = resolveApp(name: name, pid: pid)
            guard matches.count == 1, let app = matches.first else {
                completion(["success": false, "code": matches.isEmpty ? "unsupported_target" : "target_ambiguous", "error": matches.isEmpty ? "app not found" : "more than one running application uses this name; pass a pid"])
                return
            }
            guard !app.isTerminated else {
                completion(["success": false, "code": "target_gone", "error": "selected application terminated before lifecycle delivery"])
                return
            }
            switch subcommand {
            case "activate":
                app.unhide()
                let requested = app.activate(options: [.activateIgnoringOtherApps])
                if waitForActivation(of: app) {
                    completion(WireFormat.success("activated \(app.localizedName ?? "app")"))
                } else if requested {
                    completion(["success": false, "code": "restricted_by_os", "error": "activation requested but app did not become frontmost"])
                } else {
                    completion(["success": false, "code": "restricted_by_os", "error": "activation request failed"])
                }
            case "hide", "unhide":
                let hidden = subcommand == "hide"
                let accepted = hidden ? app.hide() : app.unhide()
                // A false return can accompany an actual effect in this
                // headless bridge. Pull AXHidden instead of polling AppKit's
                // run-loop cache, and never deliver the request a second time.
                let observed = !accepted && app.activationPolicy == .regular
                    && Self.waitForHiddenState(pid: app.processIdentifier, hidden: hidden)
                guard accepted || observed else {
                    let uncertain = app.activationPolicy == .regular && !app.isTerminated
                    completion(["success": false,
                                "code": app.isTerminated ? "target_gone" : uncertain ? "timeout_unknown_outcome" : "restricted_by_os",
                                "error": uncertain ? "app \(subcommand) was sent but its result could not be verified; observe before retrying" : "macOS declined app \(subcommand)",
                                "retryable": false,
                                "details": ["dispatched": true, "verified": false]])
                    return
                }
                completion(WireFormat.success("\(hidden ? "hidden" : "unhidden") \(app.localizedName ?? "app")"))
            case "quit":
                guard app.terminate() else {
                    completion(["success": false, "code": app.isTerminated ? "target_gone" : "restricted_by_os", "error": "macOS declined app quit"])
                    return
                }
                completion(WireFormat.success("quit requested for \(app.localizedName ?? "app")"))
            default: notImplemented("app \(subcommand)", completion: completion)
            }
        case "launch":
            guard let bundleId = action["bundleId"] as? String else {
                completion(WireFormat.error("launch requires bundleId"))
                return
            }
            let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).filter { !$0.isTerminated }
            if running.count > 1 {
                completion(["success": false, "code": "target_ambiguous", "error": "more than one running application uses this bundle ID; address its pid"])
                return
            }
            if let app = running.first {
                completion(WireFormat.success("already running \(app.localizedName ?? bundleId)"))
                return
            }
            let config = NSWorkspace.OpenConfiguration()
            config.activates = false
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) {
                NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in
                    if let error = error {
                        completion(WireFormat.error("launch failed: \(error.localizedDescription)"))
                    } else {
                        completion(WireFormat.success("launched \(app?.localizedName ?? bundleId)"))
                    }
                }
            } else {
                completion(WireFormat.error("no app found for bundle ID: \(bundleId)"))
            }
        default:
            notImplemented("app \(subcommand)", completion: completion)
        }
    }

    static func waitForHiddenState(pid: pid_t, hidden: Bool,
                                   transport: any AXTransport = LiveAXTransport(),
                                   timeoutMs: Int = 1000) -> Bool {
        let element = transport.createApplication(pid: pid)
        _ = transport.setMessagingTimeout(element, seconds: Float(min(100, max(1, timeoutMs))) / 1000)
        let deadline = Date().addingTimeInterval(Double(max(0, timeoutMs)) / 1000)
        repeat {
            let (error, value) = transport.copyAttributeValue(element, kAXHiddenAttribute as String)
            if error == .success, let value, CFGetTypeID(value) == CFBooleanGetTypeID(),
               let actual = value as? Bool, actual == hidden { return true }
            if Date() >= deadline { return false }
            usleep(10_000)
        } while true
    }

    private func resolveApp(name: String?, pid: Int32?) -> [NSRunningApplication] {
        if let pid = pid {
            return NSRunningApplication(processIdentifier: pid).map { [$0] } ?? []
        }
        if let name = name {
            return NSWorkspace.shared.runningApplications.filter {
                $0.localizedName?.lowercased() == name.lowercased()
            }
        }
        return FrontmostResolver.frontmostApplication().map { [$0] } ?? []
    }

    private func frontmostInfo() -> FrontmostInfo? {
        guard let (pid, source) = FrontmostResolver.resolvePID(transport: LiveAXTransport()),
              let app = NSRunningApplication(processIdentifier: pid) else { return nil }
        return FrontmostInfo(
            app: app,
            payload: [
                "name": app.localizedName ?? "(unknown)",
                "pid": app.processIdentifier,
                "bundleId": app.bundleIdentifier ?? "",
                // Not app.isActive: that reads the frozen push cache (issue
                // #168) and can contradict the live resolution that just
                // named this app frontmost.
                "isActive": true,
                // Which ladder stage answered (issue #198): callers can tell
                // a focus-derived answer (ax/axScan) from a degraded one.
                "source": source.rawValue
            ]
        )
    }

    private func waitForActivation(of app: NSRunningApplication, timeoutMs: Int = 1000) -> Bool {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        while Date() < deadline {
            if Self.activationReachedTarget(
                targetPID: app.processIdentifier,
                frontmostPID: frontmostInfo()?.app.processIdentifier
            ) {
                return true
            }
            usleep(50_000)
        }
        return false
    }

    // Live frontmost pid alone is the activation signal. The old
    // `app.isActive` conjunct read the frozen NSRunningApplication cache
    // (issue #168) and could veto real activations forever.
    static func activationReachedTarget(targetPID: pid_t, frontmostPID: pid_t?) -> Bool {
        frontmostPID == targetPID
    }
}
