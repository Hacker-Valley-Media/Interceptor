import Foundation
import AppKit

/// Runtime Agent surface. Discovers apps and classifies the
/// lightest way-in; enables a resident InterceptorAgent dylib by using
/// DYLD_INSERT_LIBRARIES when the target permits it, or by preparing a managed
/// re-signed copy for hardened apps; disables + cleans up.
///
/// Wire: `macos_native_<command>` → command ∈ discover|enable|disable|status|signid.
/// The resident agent then registers with the daemon over WebSocket as
/// `runtime:<app>` and serves verbs from inside the target process.
final class NativeDomain: DomainHandler, @unchecked Sendable {

    private let managedRoot = (NSHomeDirectory() as NSString).appendingPathComponent(".interceptor/native")
    private static var platformTargetsEnabled: Bool {
        #if INTERCEPTOR_ENABLE_PLATFORM_TARGETS
        return true
        #else
        return false
        #endif
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        // Shell-outs + copies can be slow; never block the bridge's main pump.
        DispatchQueue.global(qos: .userInitiated).async {
            switch command {
            case "discover": completion(self.discover(action))
            case "enable":   completion(self.enable(action))
            case "disable":  completion(self.disable(action))
            case "status":   completion(self.status(action))
            case "signid":   completion(self.signingIdentityInfo(action))
            default:         completion(WireFormat.error("runtime \(command) not implemented"))
            }
        }
    }

    // MARK: discover

    private func discover(_ action: [String: Any]) -> [String: Any] {
        if let target = (action["app"] as? String) ?? (action["bundleId"] as? String) {
            guard let app = resolveApp(target) else { return WireFormat.error("app not found: \(target)") }
            return WireFormat.success(describe(app, deep: true))
        }
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        let rows = apps.compactMap { app -> [String: Any]? in
            guard app.bundleURL != nil else { return nil }
            return describe(app, deep: false)
        }
        return WireFormat.success(rows)
    }

    private func describe(_ app: NSRunningApplication, deep: Bool) -> [String: Any] {
        let name = app.localizedName ?? "(unknown)"
        let path = app.bundleURL?.path ?? ""
        let binary = mainExecutable(bundlePath: path)
        let slice = deep ? archs(binary) : "unknown"
        let cs = deep ? codesignVerbose(path) : ""
        let hardened = deep ? cs.range(of: #"flags=0x[0-9a-f]*\([^)]*\bruntime\b"#, options: .regularExpression) != nil : false
        let platform = deep ? (cs.contains("anchor apple") || path.hasPrefix("/System/")) : path.hasPrefix("/System/")
        let ents = deep ? entitlements(path) : []
        let runtime = deep ? classifyRuntime(bundlePath: path, binary: binary) : "unknown"
        let wayIn = classifyWayIn(
            platformBinary: platform,
            runtime: runtime,
            hardened: hardened,
            disableLibVal: ents.contains("com.apple.security.cs.disable-library-validation"),
            allowDyldEnv: ents.contains("com.apple.security.cs.allow-dyld-environment-variables"),
            getTaskAllow: ents.contains("com.apple.security.get-task-allow")
        )
        var row: [String: Any] = [
            "appName": name,
            "bundleId": app.bundleIdentifier ?? "",
            "pid": Int(app.processIdentifier),
            "path": path,
            "contextId": "runtime:" + slugify(name),
            "runtime": runtime,
            "wayIn": wayIn,
        ]
        if deep {
            row["slice"] = slice
            row["hardened"] = hardened
            row["platformBinary"] = platform
            row["entitlements"] = ents
        }
        return row
    }

    // MARK: enable

    private func enable(_ action: [String: Any]) -> [String: Any] {
        guard let target = (action["app"] as? String) ?? (action["bundleId"] as? String) ?? (action["path"] as? String) else {
            return WireFormat.error("macos runtime enable requires --app / --bundle / --path")
        }
        let bundlePath = resolveBundlePath(target)
        guard !bundlePath.isEmpty, FileManager.default.fileExists(atPath: bundlePath) else {
            return WireFormat.error("app bundle not found: \(target)")
        }
        let name = (bundlePath as NSString).lastPathComponent.replacingOccurrences(of: ".app", with: "")
        let slug = slugify(name)
        let contextId = "runtime:" + slug
        let binary = mainExecutable(bundlePath: bundlePath)
        let slice = archs(binary)
        let cs = codesignVerbose(bundlePath)
        let hardened = cs.range(of: #"flags=0x[0-9a-f]*\([^)]*\bruntime\b"#, options: .regularExpression) != nil
        let platform = cs.contains("anchor apple") || bundlePath.hasPrefix("/System/")
        let ents = entitlements(bundlePath)
        let runtime = classifyRuntime(bundlePath: bundlePath, binary: binary)
        var wayIn = classifyWayIn(
            platformBinary: platform, runtime: runtime, hardened: hardened,
            disableLibVal: ents.contains("com.apple.security.cs.disable-library-validation"),
            allowDyldEnv: ents.contains("com.apple.security.cs.allow-dyld-environment-variables"),
            getTaskAllow: ents.contains("com.apple.security.get-task-allow")
        )

        // Platform-target gating: a system platform binary needs a
        // research build even to reach the (relocated) hardened-target path below.
        let allowPlatform = action["allowPlatform"] as? Bool ?? false
        if allowPlatform && !Self.platformTargetsEnabled {
            return Self.platformTargetsCompiledOutError()
        }

        if wayIn == "unsupported" {
            guard allowPlatform else {
                return WireFormat.error("\(name) is a system platform binary. This public build supports owned-app audit targets only; system platform target support requires a research build compiled with INTERCEPTOR_ENABLE_PLATFORM_TARGETS=1.")
            }
            wayIn = "re-sign"
        }
        if wayIn == "runtime-channel" {
            return WireFormat.error("\(name) is runtime-hosted (\(runtime)) — use `interceptor macos cdp` / `interceptor macos cdp app` (its own debug channel), not the app runtime agent.")
        }

        let buildMode = action["build"] as? Bool ?? false

        // rung 4 (hardened / platform target): the capability-blind core NEVER
        // re-signs. The hardened-target managed-copy audit flow lives in
        // an operator-supplied extension that surfaces its own `macos <prefix>
        // <cmd>` verb. Delegate with guidance; if no such extension is installed,
        // report that — the core itself does rung-1 and rung-3 only.
        if !buildMode && wayIn == "re-sign" {
            return Self.hardenedTargetNotInstalledError(name: name)
        }

        // rung 1 (own build) and rung 3 (weak entitlement) load the resident
        // agent dylib with no re-sign.
        let agent = resolveAgentDylib(slice: slice)
        guard !agent.isEmpty, FileManager.default.fileExists(atPath: agent) else {
            return WireFormat.error("agent dylib for slice '\(slice)' not found. Public Full packages do not bundle runtime agent dylibs; build or provide one and set INTERCEPTOR_AGENT_DYLIB.")
        }

        // rung 1 (own build): the agent is already linked — just launch with env.
        if buildMode {
            return launch(bundlePath: bundlePath, agentInsert: nil, contextId: contextId, appName: name, slice: slice, wayIn: wayIn)
        }
        // rung 3 (weak entitlement / non-hardened): load with DYLD_INSERT_LIBRARIES.
        return launch(bundlePath: bundlePath, agentInsert: agent, contextId: contextId, appName: name, slice: slice, wayIn: wayIn)
    }

    /// rung 4 (hardened-target managed-copy audit) is relocated out of the
    /// capability-blind core. The core never re-signs. This neutral hook
    /// reports that the flow is operator-supplied via an extension; the extension
    /// surfaces its own `macos <prefix> <cmd>` verb to perform it.
    private static func hardenedTargetNotInstalledError(name: String) -> [String: Any] {
        return [
            "success": false,
            "error": "\(name) requires a hardened-target managed-copy audit handler, which this build does not include. The core supports own-build (--build) and weak-entitlement targets directly; the hardened-target flow is provided by an operator-installed extension.",
            "setup_required": [
                "reason": "hardened_target_handler_not_installed",
                "detail": "Install an extension that provides the hardened-target managed-copy audit flow under ~/.interceptor/extensions/ and invoke its own verb. See docs/extensions/authoring.md."
            ]
        ]
    }

    /// Launch a bundle as the bridge's child — making the bridge the responsible
    /// process for TCC — with the agent env + DYLD (rung-1 own-build / rung-3
    /// weak-entitlement only; the core never re-signs).
    private func launch(bundlePath: String, agentInsert: String?, contextId: String, appName: String, slice: String, wayIn: String) -> [String: Any] {
        let url = URL(fileURLWithPath: bundlePath)
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.createsNewApplicationInstance = true
        cfg.activates = false
        var env: [String: String] = [
            "INTERCEPTOR_NATIVE_CONTEXT": contextId,
            "INTERCEPTOR_NATIVE_APPNAME": appName,
            "INTERCEPTOR_AGENT_SLICE": slice,
            "INTERCEPTOR_NATIVE_WAYIN": wayIn,
            "INTERCEPTOR_WS_PORT": ProcessInfo.processInfo.environment["INTERCEPTOR_WS_PORT"] ?? "19222",
            // Capture-on-launch: the native surface exists to capture, so flip the
            // record flag + install the URLSession swizzle before the app's first
            // request (the swizzle is class-level so there's no race, but this also
            // buffers startup traffic). `macos runtime net log/bodies` reads it back.
            "INTERCEPTOR_NET_CAPTURE": "1",
        ]
        if let insert = agentInsert { env["DYLD_INSERT_LIBRARIES"] = insert }
        cfg.environment = env

        let sem = DispatchSemaphore(value: 0)
        var outcome: [String: Any] = WireFormat.error("launch did not complete")
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, error in
            if let error = error {
                outcome = WireFormat.error("launch failed: \(error.localizedDescription)")
            } else {
                Platform.emitEvent("native_enabled", data: ["app": appName, "contextId": contextId, "wayIn": wayIn, "pid": Int(app?.processIdentifier ?? -1)])
                outcome = WireFormat.success([
                    "contextId": contextId,
                    "appName": appName,
                    "pid": Int(app?.processIdentifier ?? -1),
                    "wayIn": wayIn,
                    "note": "agent loaded; it registers with the daemon as \(contextId). Drive it: interceptor macos runtime tree --context \(contextId)",
                ])
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 20)
        return outcome
    }

    // MARK: disable

    private func disable(_ action: [String: Any]) -> [String: Any] {
        guard let target = (action["app"] as? String) ?? (action["bundleId"] as? String) else {
            return WireFormat.error("macos runtime disable requires --app")
        }
        let slug = slugify(target.replacingOccurrences(of: ".app", with: ""))
        let copyPath = (managedRoot as NSString).appendingPathComponent("\(slug).app")
        var removed = false
        // Terminate the managed copy if running.
        if let running = NSWorkspace.shared.runningApplications.first(where: { $0.bundleURL?.path == copyPath }) {
            running.terminate()
            removed = true
        }
        if FileManager.default.fileExists(atPath: copyPath) {
            if action["keep"] as? Bool != true {
                try? FileManager.default.removeItem(atPath: copyPath)
            }
            removed = true
        }
        Platform.emitEvent("native_disable", data: ["app": target, "slug": slug])
        return removed
            ? WireFormat.success("disabled \(slug); the daemon drops runtime:\(slug) when the agent disconnects")
            : WireFormat.error("no managed copy for \(slug) (own-build/weak-ent agents stop when you quit the app)")
    }

    // MARK: status (managed copies on disk; live agents come from the daemon)

    private func status(_ action: [String: Any]) -> [String: Any] {
        let fm = FileManager.default
        let copies = (try? fm.contentsOfDirectory(atPath: managedRoot)) ?? []
        let rows = copies.filter { $0.hasSuffix(".app") }.map { name -> [String: Any] in
            let path = (managedRoot as NSString).appendingPathComponent(name)
            let running = NSWorkspace.shared.runningApplications.contains { $0.bundleURL?.path == path }
            return ["slug": name.replacingOccurrences(of: ".app", with: ""), "managedCopy": path, "running": running]
        }
        return WireFormat.success(["managedRoot": managedRoot, "copies": rows])
    }

    // MARK: signing identity

    private func signingIdentityInfo(_ action: [String: Any]) -> [String: Any] {
        let configured = ProcessInfo.processInfo.environment["INTERCEPTOR_NATIVE_SIGNING_IDENTITY"]
        if let id = configured, id != "-" {
            let found = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]).out
            let present = found.contains(id)
            return WireFormat.success(["mode": "configured", "identity": id, "present": present,
                                       "note": present ? "ready" : "INTERCEPTOR_NATIVE_SIGNING_IDENTITY not found in keychain"])
        }
        return WireFormat.success(["mode": "bring-your-own-required", "identity": NSNull(),
                                   "note": "A native code-signing identity (INTERCEPTOR_NATIVE_SIGNING_IDENTITY) is required by extensions that prepare a locally-signed audit copy. The core never signs with the vendor certificate."])
    }

    // MARK: classification (mirrors shared/native-agent.ts classifyWayIn)

    private func classifyWayIn(platformBinary: Bool, runtime: String, hardened: Bool,
                               disableLibVal: Bool, allowDyldEnv: Bool, getTaskAllow: Bool) -> String {
        if platformBinary { return "unsupported" }
        let runtimeChannels: Set<String> = ["electron", "chromium", "dotnet", "jvm", "mono", "python"]
        if runtimeChannels.contains(runtime) { return "runtime-channel" }
        if !hardened || (disableLibVal && allowDyldEnv) || getTaskAllow { return "weak-entitlement" }
        return "re-sign"
    }

    private func classifyRuntime(bundlePath: String, binary: String) -> String {
        let fm = FileManager.default
        let fw = (bundlePath as NSString).appendingPathComponent("Contents/Frameworks")
        if fm.fileExists(atPath: (fw as NSString).appendingPathComponent("Electron Framework.framework")) { return "electron" }
        // chromium: a "<X> Framework.framework" + a Helpers dir
        if let items = try? fm.contentsOfDirectory(atPath: fw) {
            if items.contains(where: { $0.hasSuffix(" Framework.framework") }) {
                let helpers = (fw as NSString).appendingPathComponent(items.first { $0.hasSuffix(" Framework.framework") }! + "/Versions")
                if fm.fileExists(atPath: helpers) { /* fallthrough to dylib scan first */ }
            }
        }
        let libs = run("/usr/bin/otool", ["-L", binary]).out.lowercased()
        if libs.contains("libcoreclr") || libs.contains("libhostfxr") { return "dotnet" }
        if libs.contains("libjvm") || libs.contains("libjli") { return "jvm" }
        if libs.contains("libmono") { return "mono" }
        if libs.contains("libpython") || libs.contains("python.framework") { return "python" }
        if libs.contains("qtcore") { return "qt" }
        // bundle-wide scan for managed runtimes that ship dylibs out of Frameworks
        if dirContains(bundlePath, names: ["libcoreclr.dylib", "libhostfxr.dylib"]) { return "dotnet" }
        if dirContains(bundlePath, names: ["libjvm.dylib", "libjli.dylib"]) { return "jvm" }
        if libs.contains("swiftui") { return "swiftui" }
        return "appkit"
    }

    // MARK: shell + bundle helpers

    private struct ShellResult { let out: String; let err: String; let code: Int32 }

    private func run(_ launchPath: String, _ args: [String]) -> ShellResult {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: launchPath)
        p.arguments = args
        let outPipe = Pipe(); let errPipe = Pipe()
        p.standardOutput = outPipe; p.standardError = errPipe
        do { try p.run() } catch { return ShellResult(out: "", err: error.localizedDescription, code: -1) }
        let o = outPipe.fileHandleForReading.readDataToEndOfFile()
        let e = errPipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return ShellResult(out: String(data: o, encoding: .utf8) ?? "", err: String(data: e, encoding: .utf8) ?? "", code: p.terminationStatus)
    }

    private func archs(_ binary: String) -> String {
        guard !binary.isEmpty else { return "unknown" }
        let s = run("/usr/bin/lipo", ["-archs", binary]).out.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let arm64e = s.contains("arm64e")
        let arm64 = s.range(of: #"\barm64\b"#, options: .regularExpression) != nil
        let x86 = s.contains("x86_64")
        if (arm64 || arm64e) && x86 { return "universal" }
        if arm64e { return "arm64e" }
        if arm64 { return "arm64" }
        if x86 { return "x86_64" }
        return "unknown"
    }

    private func codesignVerbose(_ path: String) -> String {
        let r = run("/usr/bin/codesign", ["-d", "-vvv", path])
        return r.out + "\n" + r.err
    }

    private func entitlements(_ path: String) -> [String] {
        let xml = run("/usr/bin/codesign", ["-d", "--entitlements", ":-", "--xml", path]).out
        let keys = [
            "com.apple.security.cs.disable-library-validation",
            "com.apple.security.cs.allow-dyld-environment-variables",
            "com.apple.security.cs.allow-unsigned-executable-memory",
            "com.apple.security.get-task-allow",
            "com.apple.security.app-sandbox",
        ]
        return keys.filter { xml.contains($0) }
    }

    private func mainExecutable(bundlePath: String) -> String {
        let plist = (bundlePath as NSString).appendingPathComponent("Contents/Info.plist")
        if let d = NSDictionary(contentsOfFile: plist), let exe = d["CFBundleExecutable"] as? String {
            return (bundlePath as NSString).appendingPathComponent("Contents/MacOS/\(exe)")
        }
        let macos = (bundlePath as NSString).appendingPathComponent("Contents/MacOS")
        if let items = try? FileManager.default.contentsOfDirectory(atPath: macos), let first = items.first {
            return (macos as NSString).appendingPathComponent(first)
        }
        return ""
    }

    private func dirContains(_ root: String, names: [String]) -> Bool {
        guard let en = FileManager.default.enumerator(atPath: root) else { return false }
        var checked = 0
        for case let p as String in en {
            checked += 1
            if checked > 4000 { break }
            let base = (p as NSString).lastPathComponent
            if names.contains(base) { return true }
        }
        return false
    }

    private func resolveApp(_ target: String) -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first {
            $0.localizedName?.lowercased() == target.lowercased() || $0.bundleIdentifier == target
        }
    }

    private func resolveBundlePath(_ target: String) -> String {
        if target.hasSuffix(".app") && FileManager.default.fileExists(atPath: target) { return target }
        if let app = resolveApp(target), let p = app.bundleURL?.path { return p }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: target) { return url.path }
        // by name in /Applications
        let candidate = "/Applications/\(target).app"
        if FileManager.default.fileExists(atPath: candidate) { return candidate }
        return ""
    }

    /// Resolve the resident agent dylib for `slice`. Precedence:
    ///   1. INTERCEPTOR_AGENT_DYLIB (explicit operator override)
    ///   2. per-extension agent dirs: ~/.interceptor/extensions/<name>/agent/ (sorted)
    ///   3. ~/.interceptor/native/agent
    ///   4. /Library/Application Support/Interceptor/agent
    ///   5. the bridge bundle's parent dir
    /// Within each dir, the slice-specific name wins over the arm64 fallback.
    private func resolveAgentDylib(slice: String) -> String {
        let want = (slice == "arm64e") ? "arm64e" : (slice == "x86_64" ? "x86_64" : "arm64")
        var candidates: [String] = []
        if let env = ProcessInfo.processInfo.environment["INTERCEPTOR_AGENT_DYLIB"] { candidates.append(env) }
        var dirs: [String] = []
        // Per-extension agent slices: ~/.interceptor/extensions/<name>/agent/.
        let extRoot = ExtensionFabric.extensionsRoot()
        if let exts = try? FileManager.default.contentsOfDirectory(atPath: extRoot) {
            for name in exts.sorted() {
                dirs.append((extRoot as NSString).appendingPathComponent("\(name)/agent"))
            }
        }
        dirs.append(contentsOf: [
            (NSHomeDirectory() as NSString).appendingPathComponent(".interceptor/native/agent"),
            "/Library/Application Support/Interceptor/agent",
            (Bundle.main.bundlePath as NSString).deletingLastPathComponent,
        ])
        for d in dirs {
            candidates.append((d as NSString).appendingPathComponent("InterceptorAgent-\(want).dylib"))
            candidates.append((d as NSString).appendingPathComponent("InterceptorAgent-arm64.dylib"))
        }
        for c in candidates where FileManager.default.fileExists(atPath: c) { return c }
        return ""
    }

    private static func platformTargetsCompiledOutError() -> [String: Any] {
        [
            "success": false,
            "error": "System platform target support is not included in this build.",
            "setup_required": [
                "reason": "platform_target_support_compiled_out",
                "detail": "Use owned-app audit targets or a research build compiled with INTERCEPTOR_ENABLE_PLATFORM_TARGETS=1."
            ]
        ]
    }

    private func slugify(_ s: String) -> String {
        var out = ""
        var lastDash = false
        for c in s.lowercased() {
            if c.isLetter || c.isNumber { out.append(c); lastDash = false }
            else if !lastDash { out.append("-"); lastDash = true }
        }
        return out.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}
