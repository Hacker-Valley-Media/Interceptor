import Foundation
import AppKit

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
        var lines: [String] = []
        for app in apps {
            let name = app.localizedName ?? "(unknown)"
            let pid = app.processIdentifier
            let bundleId = app.bundleIdentifier ?? ""
            let active = app.isActive ? " *" : ""
            let hidden = app.isHidden ? " (hidden)" : ""
            lines.append("[\(pid)] \(name)\(active)\(hidden) — \(bundleId)")
        }
        completion(WireFormat.success(lines.joined(separator: "\n")))
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
        case "activate":
            let name = action["app"] as? String
            let pid = action["pid"] as? Int32
            guard let app = resolveApp(name: name, pid: pid) else {
                completion(WireFormat.error("app not found"))
                return
            }
            app.unhide()
            let requested = app.activate(options: [.activateIgnoringOtherApps])
            if waitForActivation(of: app) {
                completion(WireFormat.success("activated \(app.localizedName ?? "app")"))
            } else if requested {
                completion(WireFormat.error("activation requested but app did not become frontmost"))
            } else {
                completion(WireFormat.error("activation request failed"))
            }
        case "hide":
            let name = action["app"] as? String
            let pid = action["pid"] as? Int32
            guard let app = resolveApp(name: name, pid: pid) else {
                completion(WireFormat.error("app not found"))
                return
            }
            app.hide()
            completion(WireFormat.success("hidden \(app.localizedName ?? "app")"))
        case "unhide":
            let name = action["app"] as? String
            let pid = action["pid"] as? Int32
            guard let app = resolveApp(name: name, pid: pid) else {
                completion(WireFormat.error("app not found"))
                return
            }
            app.unhide()
            completion(WireFormat.success("unhidden \(app.localizedName ?? "app")"))
        case "quit":
            let name = action["app"] as? String
            let pid = action["pid"] as? Int32
            guard let app = resolveApp(name: name, pid: pid) else {
                completion(WireFormat.error("app not found"))
                return
            }
            app.terminate()
            completion(WireFormat.success("quit \(app.localizedName ?? "app")"))
        case "launch":
            guard let bundleId = action["bundleId"] as? String else {
                completion(WireFormat.error("launch requires bundleId"))
                return
            }
            let config = NSWorkspace.OpenConfiguration()
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

    private func resolveApp(name: String?, pid: Int32?) -> NSRunningApplication? {
        if let pid = pid {
            return NSRunningApplication(processIdentifier: pid)
        }
        if let name = name {
            return NSWorkspace.shared.runningApplications.first {
                $0.localizedName?.lowercased() == name.lowercased()
            }
        }
        return FrontmostResolver.frontmostApplication()
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
