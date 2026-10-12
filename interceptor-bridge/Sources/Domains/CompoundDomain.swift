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
    // Completion receives the launched app's pid when NSWorkspace
    // provides one: openApplication's completion can fire before the app
    // registers in NSWorkspace.runningApplications, so a by-name lookup
    // immediately after launch can miss. The pid addresses the app
    // without that race.
    func launch(_ name: String, activates: Bool, completion: @escaping (pid_t?) -> Void)
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
            bundlePath: app.bundleURL?.path,
            name: name
        )
    }

    // Pure helper extracted so the matching policy can be unit-tested
    // without constructing a real NSRunningApplication.
    static func matches(
        localizedName: String?,
        bundleBaseName: String?,
        bundleId: String?,
        bundlePath: String? = nil,
        name: String
    ) -> Bool {
        if name.hasPrefix("/") {
            guard let bundlePath else { return false }
            return URL(fileURLWithPath: bundlePath).resolvingSymlinksInPath().standardizedFileURL.path ==
                URL(fileURLWithPath: name).resolvingSymlinksInPath().standardizedFileURL.path
        }
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

    func launch(_ name: String, activates: Bool, completion: @escaping (pid_t?) -> Void) {
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
            completion(nil)
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = activates
        config.allowsRunningApplicationSubstitution = !name.hasPrefix("/")
        config.addsToRecentItems = false
        // Reuse a running instance if there happens to be one (default).
        // createsNewApplicationInstance defaults to false; we leave it.
        workspace.openApplication(at: appURL, configuration: config) { app, _ in
            completion(app?.processIdentifier)
        }
    }

    static func resolveAppURL(name: String) -> URL? {
        if name.hasPrefix("/") {
            let url = URL(fileURLWithPath: name).resolvingSymlinksInPath().standardizedFileURL
            guard url.pathExtension.lowercased() == "app",
                  let executable = Bundle(url: url)?.executableURL,
                  FileManager.default.isExecutableFile(atPath: executable.path) else { return nil }
            return url
        }
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
        if let type = action["type"] as? String, DesktopCompoundShape.operations.contains(type) {
            handleNeutral(action, completion: completion)
            return
        }
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

    private func handleNeutral(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let failure = DesktopCompoundValidation.validate(action) { completion(failure); return }
        let type = action["type"] as! String
        if type == "desktop_open" { handleNeutralOpen(action, completion: completion); return }
        let ref = action["ref"] as? String
        let refPid = ref.flatMap { RefRegistry.shared.resolvePID($0) }
        if type == "desktop_act", refPid == nil {
            completion(["success": false, "code": "stale_reference", "error": "read the target again for a fresh reference"])
            return
        }
        let requestedPid = (action["pid"] as? NSNumber).map { pid_t($0.int32Value) }
        let requestedName = action["app"] as? String
        var targets = NSWorkspace.shared.runningApplications.filter { app in
            (requestedPid == nil || app.processIdentifier == requestedPid) &&
            (requestedName == nil || DefaultAppLauncher.matches(app, requestedName!)) &&
            (refPid == nil || app.processIdentifier == refPid)
        }
        if requestedPid == nil, requestedName == nil, refPid == nil {
            targets = NSWorkspace.shared.frontmostApplication.map { [$0] } ?? []
        }
        guard targets.count == 1, let target = targets.first else {
            let code = targets.isEmpty ? (type == "desktop_act" ? "unsupported_target" : "target_gone") : "target_ambiguous"
            completion(["success": false, "code": code, "error": "compound operation requires one matching application"])
            return
        }
        let pid = target.processIdentifier
        let name = target.localizedName ?? requestedName ?? "unknown"
        let bundleId = target.bundleIdentifier ?? ""
        let typed = action["text"] != nil
        let filter = action["filter"] as? String ?? "interactive"
        let depth = action["depth"] as? Int ?? 10
        let read: @Sendable (Bool) -> Void = { mutated in
            let treeAction = self.buildAction("desktop_tree", app: nil, pid: pid, extra: ["filter": filter, "depth": depth])
            self.router.route(action: treeAction) { result in
                guard result["success"] as? Bool == true else {
                    if mutated {
                        completion(["success": false, "code": "timeout_unknown_outcome", "error": "action was delivered but the following tree read failed", "retryable": false, "details": ["dispatched": true, "verified": false, "readFailure": result]])
                    } else { completion(DesktopCompoundValidation.normalize(result, type: type)) }
                    return
                }
                let tree = result["data"] as? String ?? ""
                if type == "desktop_act" {
                    completion(WireFormat.success(["action": typed ? "typed" : "clicked", "ref": ref!, "tree": tree]))
                } else if type == "desktop_inspect_app" {
                    completion(WireFormat.success(["tree": tree, "apps": self.appsSnapshot(), "target": ["name": name, "pid": pid, "bundleId": bundleId], "frontmost": Self.frontmostRow()]))
                } else {
                    completion(WireFormat.success(["tree": tree, "app": name, "pid": pid]))
                }
            }
        }
        if type != "desktop_act" { read(false); return }
        if let element = RefRegistry.shared.resolve(ref!), axElementDisabled(element) {
            completion(["success": false, "code": "unsupported_target", "error": "target element is disabled; nothing was clicked or typed", "details": ["dispatched": false]])
            return
        }
        var input: [String: Any] = ["type": action["text"] == nil ? "desktop_click" : "desktop_type", "ref": ref!, "pid": Int(pid)]
        if let text = action["text"] { input["text"] = text }
        router.route(action: input) { result in
            guard result["success"] as? Bool == true else { completion(result); return }
            usleep(200_000)
            read(true)
        }
    }

    private func handleNeutralOpen(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let requestedPid = (action["pid"] as? NSNumber).map { pid_t($0.int32Value) }
        let requestedName = action["app"] as? String
        let activate = action["activate"] as? Bool ?? false
        var targets = NSWorkspace.shared.runningApplications.filter {
            (requestedPid == nil || $0.processIdentifier == requestedPid) &&
            (requestedName == nil || DefaultAppLauncher.matches($0, requestedName!))
        }
        if requestedPid == nil, requestedName == nil { targets = NSWorkspace.shared.frontmostApplication.map { [$0] } ?? [] }
        var launched = false
        if targets.isEmpty, requestedPid == nil, let name = requestedName {
            guard DefaultAppLauncher.resolveAppURL(name: name) != nil else {
                completion(["success": false, "code": "target_gone", "error": "requested application is not installed"])
                return
            }
            let semaphore = DispatchSemaphore(value: 0)
            let launchedPid = LaunchedPidBox()
            launcher.launch(name, activates: activate) { pid in launchedPid.set(pid); semaphore.signal() }
            let completed = semaphore.wait(timeout: .now() + 5) == .success
            guard completed, let pid = launchedPid.get() else {
                completion(["success": false, "code": "timeout_unknown_outcome", "error": "application launch could not be verified; observe before retrying", "retryable": false, "details": ["dispatched": true, "verified": false]])
                return
            }
            launched = true
            let deadline = Date().addingTimeInterval(2)
            repeat {
                targets = NSWorkspace.shared.runningApplications.filter { $0.processIdentifier == pid }
                if !targets.isEmpty { break }
                usleep(50_000)
            } while Date() < deadline
            if targets.isEmpty {
                completion(["success": false, "code": "timeout_unknown_outcome", "error": "launched process has not registered as an application; observe before retrying", "retryable": false, "details": ["dispatched": true, "verified": false, "pid": Int(pid)]])
                return
            }
        }
        guard targets.count == 1, let target = targets.first else {
            completion(["success": false, "code": targets.isEmpty ? "target_gone" : "target_ambiguous", "error": "open requires one matching application"])
            return
        }
        let pid = target.processIdentifier
        let name = target.localizedName ?? requestedName ?? "unknown"
        if activate {
            target.activate(options: [.activateIgnoringOtherApps])
            usleep(300_000)
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
                completion(["success": false, "code": "restricted_by_os", "error": "application did not become frontmost after requested activation"])
                return
            }
        }
        let didLaunch = launched
        let failure: @Sendable ([String: Any]) -> Void = { result in
            if didLaunch {
                completion(["success": false, "code": "timeout_unknown_outcome", "error": "application was launched but the following read failed; observe before retrying", "retryable": false, "details": ["dispatched": true, "pid": Int(pid), "verified": false, "readFailure": result]])
            } else { completion(DesktopCompoundValidation.normalize(result, type: "desktop_open")) }
        }
        router.route(action: buildAction("desktop_tree", app: nil, pid: pid, extra: ["filter": action["filter"] as? String ?? "interactive", "depth": action["depth"] as? Int ?? 10])) { result in
            guard result["success"] as? Bool == true, let tree = result["data"] as? String else { failure(result); return }
            self.router.route(action: self.buildAction("desktop_windows", app: nil, pid: pid)) { result in
                guard result["success"] as? Bool == true, let windows = result["data"] as? [[String: Any]] else { failure(result); return }
                let rows = windows.map { window -> [String: Any] in
                    var row: [String: Any] = ["title": window["title"] as? String ?? ""]
                    if let ref = window["ref"] as? String { row["ref"] = ref }
                    if let id = window["windowId"] as? NSNumber { row["windowId"] = id.stringValue }
                    if let frame = window["frame"] as? [String: Any] { row["frame"] = frame }
                    return row
                }
                completion(WireFormat.success(["tree": tree, "windows": rows, "app": name, "pid": Int(pid)]))
            }
        }
    }

    // Thread-safe pid handoff from the launch completion (which runs on
    // an arbitrary NSWorkspace queue) back to handleOpen's thread.
    private final class LaunchedPidBox: @unchecked Sendable {
        private let lock = NSLock()
        private var pid: pid_t?
        func set(_ p: pid_t?) { lock.lock(); pid = p; lock.unlock() }
        func get() -> pid_t? { lock.lock(); defer { lock.unlock() }; return pid }
    }

    private func handleOpen(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let appName = action["app"] as? String
        var pid = action["pid"] as? Int32
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
                let launchedPid = LaunchedPidBox()
                launcher.launch(appName, activates: shouldActivate) { launchPid in
                    launchedPid.set(launchPid)
                    semaphore.signal()
                }
                _ = semaphore.wait(timeout: .now() + 5.0)
                // Address the freshly-launched app by pid: openApplication's
                // completion can fire before the app shows up in
                // NSWorkspace.runningApplications, so the by-name lookup in
                // the tree read below would miss and (post issue #163) fail
                // loud instead of returning an empty tree.
                if pid == nil, let launched = launchedPid.get() {
                    pid = launched
                }
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
                "target": [
                    "name": appInfo.name,
                    "pid": appInfo.pid,
                    "bundleId": appInfo.bundleId
                ],
                "frontmost": Self.frontmostRow()
            ]))
        }
    }

    // The app the person is in, reported beside the inspected target.
    static func frontmostRow() -> Any {
        guard let app = NSWorkspace.shared.frontmostApplication else { return NSNull() }
        return ["name": app.localizedName ?? "unknown", "pid": app.processIdentifier, "bundleId": app.bundleIdentifier ?? ""] as [String: Any]
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
           let app = RunningApps.resolve(appName) {
            return Self.preferredAppIdentity(
                requested: (app.localizedName ?? appName, app.processIdentifier, app.bundleIdentifier ?? ""),
                frontmost: nil
            )
        }
        let frontApp = FrontmostResolver.frontmostApplication()
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
