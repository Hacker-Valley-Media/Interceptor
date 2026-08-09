import Foundation
import AppKit

// Pluggable launcher seam so CompoundOpenTests can drive the
// foreground-vs-background decision without depending on AppKit
// activation behavior at runtime.
protocol AppLauncher {
    // Returns true iff the app is already running. Caller decides
    // whether to launch or activate based on this.
    func isRunning(_ name: String) -> Bool
    // Activates a running app — used only when the caller asked for
    // foregrounding via --activate.
    func activateRunning(_ name: String)
    // Launches a not-running app. The `activates` flag flows directly
    // into NSWorkspace.OpenConfiguration.activates per Apple docs:
    // false means "open in the background, do not steal focus."
    func launch(_ name: String, activates: Bool, completion: @escaping () -> Void)
}

final class DefaultAppLauncher: AppLauncher {
    // Case/locale-tolerant match on a running NSRunningApplication.
    // The original `localizedName == name` check was the leak: it's
    // exact-match and locale-sensitive, so an `isRunning` miss caused
    // the launch fallback to fire on already-running apps and trigger
    // self-foregrounding via kAEOpenApplication. We compare both
    // `localizedName` and the bundle URL's last component (the .app
    // basename), case-insensitive, against either the user-supplied
    // name or the same name with .app appended/stripped.
    static func matches(_ app: NSRunningApplication, _ name: String) -> Bool {
        matches(
            localizedName: app.localizedName,
            bundleBaseName: app.bundleURL?.deletingPathExtension().lastPathComponent,
            bundleId: app.bundleIdentifier,
            name: name
        )
    }

    // Pure helper extracted so the matching policy can be unit-tested
    // without constructing a real NSRunningApplication.
    static func matches(
        localizedName: String?,
        bundleBaseName: String?,
        bundleId: String?,
        name: String
    ) -> Bool {
        let target = name.lowercased()
        let targetNoExt = target.hasSuffix(".app") ? String(target.dropLast(4)) : target
        if let localized = localizedName?.lowercased(),
           localized == target || localized == targetNoExt {
            return true
        }
        if let bundle = bundleBaseName?.lowercased(),
           bundle == target || bundle == targetNoExt {
            return true
        }
        if let id = bundleId?.lowercased(), id == target {
            return true
        }
        return false
    }

    func isRunning(_ name: String) -> Bool {
        NSWorkspace.shared.runningApplications.contains(where: { Self.matches($0, name) })
    }

    func activateRunning(_ name: String) {
        if let app = NSWorkspace.shared.runningApplications.first(where: { Self.matches($0, name) }) {
            app.activate(options: [.activateIgnoringOtherApps])
            usleep(300_000)
        }
    }

    func launch(_ name: String, activates: Bool, completion: @escaping () -> Void) {
        // Modern URL resolution path. Per Apple docs:
        //   - `urlForApplication(withBundleIdentifier:)` is the modern
        //     replacement for `absolutePathForApplication(...)`.
        //   - `fullPath(forApplication:)` is deprecated since macOS 11.0
        //     and is intentionally NOT used here.
        //   - `launchApplication(_:)` is deprecated and always
        //     foregrounds; it is intentionally NOT used here.
        // For the "launch by display name" case where we don't have a
        // bundle ID, we walk /Applications + /System/Applications to
        // find a matching `.app` bundle. If that fails, we fail the
        // launch rather than falling into a deprecated foregrounding
        // API.
        let workspace = NSWorkspace.shared
        let appURL = Self.resolveAppURL(name: name)
        guard let appURL = appURL else {
            // No URL resolved by any modern API — fail closed instead
            // of foregrounding via the deprecated path.
            completion()
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = activates
        config.addsToRecentItems = false
        // Reuse a running instance if there happens to be one (default).
        // createsNewApplicationInstance defaults to false; we leave it.
        workspace.openApplication(at: appURL, configuration: config) { _, _ in
            completion()
        }
    }

    static func resolveAppURL(name: String) -> URL? {
        let workspace = NSWorkspace.shared
        // 1. If `name` is itself a bundle id (contains a dot and matches
        //    a known app), use the modern bundle-id resolver.
        if name.contains("."),
           let url = workspace.urlForApplication(withBundleIdentifier: name) {
            return url
        }
        // 2. Walk standard app locations for a `.app` bundle whose
        //    last-path-component matches `name` (with or without .app).
        let target = name.hasSuffix(".app") ? name : "\(name).app"
        let searchDirs = [
            "/Applications",
            "/System/Applications",
            "/System/Applications/Utilities",
            "\(NSHomeDirectory())/Applications",
        ]
        let fm = FileManager.default
        for dir in searchDirs {
            let candidate = "\(dir)/\(target)"
            if fm.fileExists(atPath: candidate) {
                return URL(fileURLWithPath: candidate)
            }
        }
        return nil
    }
}

final class CompoundDomain: DomainHandler, @unchecked Sendable {
    private let router: Router
    private let launcher: AppLauncher
    typealias AppIdentity = (name: String, pid: pid_t, bundleId: String)

    init(router: Router, launcher: AppLauncher = DefaultAppLauncher()) {
        self.router = router
        self.launcher = launcher
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "open":
            handleOpen(action, completion: completion)
        case "read":
            handleRead(action, completion: completion)
        case "act":
            handleAct(action, completion: completion)
        case "inspect":
            handleInspect(action, completion: completion)
        default:
            notImplemented(sub, completion: completion)
        }
    }

    private func handleOpen(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let appName = action["app"] as? String
        let pid = action["pid"] as? Int32
        // Background-first: only foreground when the caller explicitly
        // sets activate=true on the action. The default is therefore
        // "open and read AX state without stealing focus."
        let shouldActivate = action["activate"] as? Bool ?? false
        if let appName = appName {
            // Critical background-first invariant: when the target
            // is already running, NEVER call NSWorkspace.openApplication.
            // Per Apple docs (OpenConfiguration.activates), the activates
            // flag only suppresses the *system's* activation pass; it does
            // not stop an AppKit app from self-activating in response to
            // the kAEOpenApplication / kAEOpenDocuments Apple Event that
            // openApplication delivers. The only way to truly stay
            // background-first for a running app is to do nothing.
            if launcher.isRunning(appName) {
                if shouldActivate { launcher.activateRunning(appName) }
                // Else: no-op. Tree/windows reads below operate via AX
                // and don't move focus.
            } else {
                let semaphore = DispatchSemaphore(value: 0)
                launcher.launch(appName, activates: shouldActivate) {
                    semaphore.signal()
                }
                _ = semaphore.wait(timeout: .now() + 5.0)
            }
        }

        let filter = action["filter"] as? String ?? "interactive"
        let depth = action["depth"] as? Int ?? 10
        let treeAction: [String: Any] = buildAction("macos_tree", app: appName, pid: pid, extra: ["filter": filter, "depth": depth])

        router.route(action: treeAction) { [router, appName, pid] treeResult in
            // Propagate sub-call failures (e.g. the Accessibility trust
            // gate) instead of composing a success around an empty tree —
            // same pattern handleAct uses.
            guard treeResult["success"] as? Bool == true else {
                completion(treeResult)
                return
            }
            let treeData: String = (treeResult["data"] as? String) ?? ""
            let windowsAction: [String: Any] = self.buildAction("macos_windows", app: appName, pid: pid)
            router.route(action: windowsAction) { windowsResult in
                let appInfo = self.describeApp(named: appName, pid: pid)
                completion(WireFormat.success([
                    "tree": treeData,
                    "windows": (windowsResult["data"] as? [[String: Any]]) ?? [] as [[String: Any]],
                    "app": appInfo.name,
                    "pid": appInfo.pid
                ]))
            }
        }
    }

    private func handleRead(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let appName = action["app"] as? String
        let pid = action["pid"] as? Int32
        let filter = action["filter"] as? String ?? "interactive"
        let depth = action["depth"] as? Int ?? 10
        let treeAction = buildAction("macos_tree", app: appName, pid: pid, extra: ["filter": filter, "depth": depth])

        router.route(action: treeAction) { treeResult in
            guard treeResult["success"] as? Bool == true else {
                completion(treeResult)
                return
            }
            let appInfo = self.describeApp(named: appName, pid: pid)
            completion(WireFormat.success([
                "tree": treeResult["data"] ?? "",
                "app": appInfo.name,
                "pid": appInfo.pid
            ]))
        }
    }

    private func handleAct(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let ref = action["ref"] as? String ?? ""
        let text = action["text"] as? String
        let appName = action["app"] as? String
        let pid = (action["pid"] as? Int32) ?? RefRegistry.shared.resolvePID(ref)

        let inputAction: [String: Any]
        if let text = text {
            inputAction = ["type": "macos_type", "ref": ref, "text": text]
        } else {
            inputAction = ["type": "macos_click", "ref": ref]
        }

        router.route(action: inputAction) { [router, ref, text, appName] actionResult in
            guard actionResult["success"] as? Bool == true else {
                completion(actionResult)
                return
            }

            usleep(200_000)

            let treeAction = self.buildAction("macos_tree", app: appName, pid: pid, extra: ["filter": "interactive", "depth": 10])
            router.route(action: treeAction) { treeResult in
                completion(WireFormat.success([
                    "action": text != nil ? "typed" : "clicked",
                    "ref": ref,
                    "tree": treeResult["data"] ?? ""
                ]))
            }
        }
    }

    private func handleInspect(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let appName = action["app"] as? String
        let pid = action["pid"] as? Int32
        let treeAction = buildAction("macos_tree", app: appName, pid: pid, extra: ["filter": "interactive", "depth": 10])

        router.route(action: treeAction) { [appName, pid] treeResult in
            guard treeResult["success"] as? Bool == true else {
                completion(treeResult)
                return
            }
            let treeData: String = (treeResult["data"] as? String) ?? ""
            let appInfo = self.describeApp(named: appName, pid: pid)
            completion(WireFormat.success([
                "tree": treeData,
                "apps": self.appsSnapshot(),
                "frontmost": [
                    "name": appInfo.name,
                    "pid": appInfo.pid,
                    "bundleId": appInfo.bundleId
                ]
            ]))
        }
    }

    private func buildAction(_ type: String, app: String?, pid: Int32? = nil, extra: [String: Any] = [:]) -> [String: Any] {
        var action: [String: Any] = ["type": type]
        if let app = app { action["app"] = app }
        if let pid = pid { action["pid"] = Int(pid) }
        for (k, v) in extra { action[k] = v }
        return action
    }

    private func describeApp(named appName: String?, pid: Int32? = nil) -> AppIdentity {
        if let pid = pid,
           let app = NSRunningApplication(processIdentifier: pid_t(pid)) {
            return Self.preferredAppIdentity(
                requested: (app.localizedName ?? appName ?? "unknown", app.processIdentifier, app.bundleIdentifier ?? ""),
                frontmost: nil
            )
        }
        if let appName = appName,
           let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == appName }) {
            return Self.preferredAppIdentity(
                requested: (app.localizedName ?? appName, app.processIdentifier, app.bundleIdentifier ?? ""),
                frontmost: nil
            )
        }
        let frontApp = NSWorkspace.shared.frontmostApplication
        return Self.preferredAppIdentity(
            requested: nil,
            frontmost: (
                frontApp?.localizedName ?? appName ?? "unknown",
                frontApp?.processIdentifier ?? 0,
                frontApp?.bundleIdentifier ?? ""
            )
        )
    }

    private func appsSnapshot() -> [[String: Any]] {
        NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map { app in
                [
                    "name": app.localizedName ?? "(unknown)",
                    "pid": app.processIdentifier,
                    "bundleId": app.bundleIdentifier ?? "",
                    "isActive": app.isActive,
                    "isHidden": app.isHidden
                ]
            }
    }

    static func preferredAppIdentity(requested: AppIdentity?, frontmost: AppIdentity?) -> AppIdentity {
        requested ?? frontmost ?? ("unknown", 0, "")
    }
}
