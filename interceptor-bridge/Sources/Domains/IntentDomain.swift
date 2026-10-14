// Apple Events / OSA script execution.
//
// Apple Events is the universal app-control channel that has been on
// macOS since 1991. This is separate from AppIntents, which declare
// system-discoverable app actions for Shortcuts/Siri/Spotlight. By
// dispatching via NSAppleScript and OSAKit we get:
//   - true cross-app verb dispatch
//   - macOS TCC Automation consent prompt on first use per (interceptor-bridge,
//     target_app) pair (correct consent UX, no entitlement audit)
//   - structured parameter passing via AppleScript record syntax
//   - structured result back via NSAppleEventDescriptor
//
// The wire shape (action["..."]) accepts these input forms,
// in order of flexibility:
//
//   1. Raw script:    { script: "<applescript source>" }
//   2. Structured:    { bundleId, intent, parameters?, target?, args? }
//                     → "tell application id \"<bundleId>\" to <intent> [<args>] [<target>] [with properties <parameters>]"
//   3. JSC:           { jsc: "<JavaScriptCore source>" }
//   4. JXA:           { jxa: "<JXA source>" }
//
// AppleScript/JXA return NSAppleEventDescriptor-derived values. JSC returns
// sanitized JSValue-derived values.

import Foundation
import AppKit
import Carbon // for AEDeterminePermissionToAutomateTarget
import OSAKit
import JavaScriptCore

private struct JSCHostOptions {
    static let allCapabilities: Set<String> = ["env", "fs", "osa", "shell", "sqlite"]

    let capabilities: Set<String>

    var enabled: Bool {
        !capabilities.isEmpty
    }
}

final class IntentDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "dispatch", "run":
            handleDispatch(action, completion: completion)
        case "warmup":
            handleWarmup(action, completion: completion)
        default:
            completion(WireFormat.error("intent: unknown command \(command)"))
        }
    }

    /// pre-prompt TCC for a batch of bundle ids in one call. macOS
    /// will display each consent dialog in turn; user clicks Allow once
    /// per app and is never bothered again for that pair. Returns a map
    /// of bundleId → granted/denied so the engine can record state.
    private func handleWarmup(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let bundleIds = action["bundleIds"] as? [String], !bundleIds.isEmpty else {
            completion(WireFormat.error("intent.warmup: requires bundleIds: [String]"))
            return
        }
        DispatchQueue.main.async {
            var results: [[String: Any]] = []
            for bid in bundleIds {
                let status = self.requestAutomationPermission(for: bid)
                let outcome: String
                switch status {
                case noErr:
                    outcome = "granted"
                case -1743:
                    outcome = "denied"
                case -600:
                    outcome = "app_not_running"
                default:
                    outcome = "status_\(status)"
                }
                results.append([
                    "bundleId": bid,
                    "status": status,
                    "outcome": outcome
                ])
            }
            let granted = results.filter { ($0["outcome"] as? String) == "granted" }.count
            let denied = results.filter { ($0["outcome"] as? String) == "denied" }.count
            completion(WireFormat.success([
                "results": results,
                "summary": [
                    "total": bundleIds.count,
                    "granted": granted,
                    "denied": denied
                ]
            ]))
        }
    }

    // MARK: dispatch
    private func handleDispatch(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        // Form 1: raw AppleScript source.
        if let rawScript = action["script"] as? String, !rawScript.isEmpty {
            executeAppleScript(rawScript, targetBundleId: nil, completion: completion)
            return
        }

        // Form 3: JavaScriptCore (plain ECMAScript in this bridge process).
        if let jsc = action["jsc"] as? String, !jsc.isEmpty {
            let hostParse = jscHostOptions(from: action["jscHost"] ?? action["jsc_host"])
            if let error = hostParse.error {
                completion(WireFormat.error(error))
                return
            }
            executeJavaScriptCore(
                jsc,
                targetBundleId: action["bundleId"] as? String,
                arguments: scriptArguments(from: action["args"]),
                hostOptions: hostParse.options,
                completion: completion
            )
            return
        }

        // Form 4: JavaScript for Automation (JXA) source. `javascript` is a
        // deprecated compatibility key for older CLI builds.
        let jxa = (action["jxa"] as? String) ?? (action["javascript"] as? String)
        if let jxa, !jxa.isEmpty {
            executeOSAScript(
                jxa,
                language: "JavaScript",
                targetBundleId: action["bundleId"] as? String,
                arguments: scriptArguments(from: action["args"]),
                completion: completion
            )
            return
        }

        // Form 2: structured intent dispatch.
        guard let bundleId = action["bundleId"] as? String, !bundleId.isEmpty,
              let intent = action["intent"] as? String, !intent.isEmpty else {
            completion(WireFormat.error("app_intent: requires bundleId + intent (or raw script/jxa/jsc)"))
            return
        }
        let parameters = action["parameters"] as? [String: Any] ?? [:]
        let target = action["target"] as? String
        let argsArr = action["args"] as? [Any]

        let source = buildAppleScriptSource(
            bundleId: bundleId,
            intent: intent,
            parameters: parameters,
            target: target,
            args: argsArr
        )
        executeAppleScript(source, targetBundleId: bundleId, completion: completion)
    }

    /// Forces the macOS TCC consent dialog to appear synchronously by calling
    /// AEDeterminePermissionToAutomateTarget(askUserIfNeeded: true). Returns
    /// noErr (0) if granted, errAEEventNotPermitted (-1743) if denied, or
    /// other OSStatus values for transient errors.
    private func requestAutomationPermission(for bundleId: String) -> OSStatus {
        var targetDesc = AEAddressDesc()
        let bidNS = bundleId as NSString
        guard let cString = bidNS.cString(using: String.Encoding.utf8.rawValue) else {
            return -50 // paramErr
        }
        let length = bidNS.lengthOfBytes(using: String.Encoding.utf8.rawValue)
        let createStatus = AECreateDesc(typeApplicationBundleID, cString, length, &targetDesc)
        guard createStatus == noErr else { return OSStatus(createStatus) }
        defer { AEDisposeDesc(&targetDesc) }
        // typeWildCard for both class and id means "any Apple Event" — TCC
        // grant is per-(source, target) pair, not per-event-type.
        return OSStatus(AEDeterminePermissionToAutomateTarget(&targetDesc, typeWildCard, typeWildCard, true))
    }

    // MARK: AppleScript builder
    private func buildAppleScriptSource(
        bundleId: String,
        intent: String,
        parameters: [String: Any],
        target: String?,
        args: [Any]?
    ) -> String {
        var inner = intent
        if let args = args, !args.isEmpty {
            let argList = args.map { applescriptValue($0) }.joined(separator: ", ")
            inner += " " + argList
        }
        if let target = target, !target.isEmpty {
            // Caller already wrote AppleScript-shaped target like
            // 'first document' or 'window 1'. Pass through verbatim.
            inner += " " + target
        }
        if !parameters.isEmpty {
            inner += " with properties " + applescriptRecord(parameters)
        }
        // Wrap in tell-block addressed to the target app by bundle id.
        return """
        tell application id \"\(applescriptEscape(bundleId))\"
            \(inner)
        end tell
        """
    }

    private func applescriptValue(_ v: Any) -> String {
        if let s = v as? String { return "\"\(applescriptEscape(s))\"" }
        if let n = v as? NSNumber {
            // Bool vs Int/Double
            let typeStr = String(cString: n.objCType)
            if typeStr == "c" { return n.boolValue ? "true" : "false" }
            return n.stringValue
        }
        if let arr = v as? [Any] {
            let inner = arr.map { applescriptValue($0) }.joined(separator: ", ")
            return "{\(inner)}"
        }
        if let dict = v as? [String: Any] {
            return applescriptRecord(dict)
        }
        return "missing value"
    }

    private func applescriptRecord(_ dict: [String: Any]) -> String {
        let parts = dict.map { (k, v) -> String in
            "\(applescriptKey(k)):\(applescriptValue(v))"
        }
        return "{" + parts.joined(separator: ", ") + "}"
    }

    /// AppleScript record keys are bare identifiers; sanitize.
    private func applescriptKey(_ raw: String) -> String {
        let allowed = CharacterSet.letters.union(.decimalDigits).union(CharacterSet(charactersIn: "_"))
        let scrub = raw.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
        if let first = scrub.first, first.isLetter { return scrub }
        return "_" + scrub
    }

    private func applescriptEscape(_ s: String) -> String {
        // Inside a "..." literal: escape backslashes and double quotes.
        var out = ""
        for ch in s.unicodeScalars {
            if ch == "\\" { out += "\\\\" }
            else if ch == "\"" { out += "\\\"" }
            else if ch == "\n" { out += "\\n" }
            else if ch == "\r" { out += "\\r" }
            else if ch == "\t" { out += "\\t" }
            else { out += String(ch) }
        }
        return out
    }

    // MARK: NSAppleScript executor
    private func executeAppleScript(_ source: String, targetBundleId: String?, completion: @escaping @Sendable ([String: Any]) -> Void) {
        // TCC consent dialogs need to render against a foreground run loop.
        // interceptor-bridge is an NSApplication.accessory agent, so the main run
        // loop IS active — but we have to make the request from the main
        // thread or TCC silently denies. So we dispatch to main, do the
        // permission check + the AppleScript execute synchronously there,
        // and reply via completion.
        DispatchQueue.main.async {
            if let bid = targetBundleId, !bid.isEmpty {
                let permStatus = self.requestAutomationPermission(for: bid)
                if permStatus != noErr {
                    let codeStr = String(permStatus)
                    let hint: String
                    if permStatus == -1743 {
                        hint = "User denied Apple Events permission for \(bid). " +
                               "Re-prompt with: tccutil reset AppleEvents com.interceptor.bridge"
                    } else {
                        hint = "AEDeterminePermissionToAutomateTarget returned \(codeStr) for \(bid)."
                    }
                    completion(WireFormat.error("app_intent: \(hint)\n--- script ---\n\(source)"))
                    return
                }
            }

            guard let script = NSAppleScript(source: source) else {
                completion(WireFormat.error("app_intent: failed to construct NSAppleScript"))
                return
            }
            var errInfo: NSDictionary?
            let result = script.executeAndReturnError(&errInfo)
            if let err = errInfo as? [String: Any] {
                let msg = (err[NSAppleScript.errorMessage] as? String) ?? "unknown AppleScript error"
                let code = err[NSAppleScript.errorNumber] as? Int ?? -1
                let appName = (err[NSAppleScript.errorAppName] as? String) ?? ""

                // Common code -1743 = errAEEventNotPermitted (TCC denial).
                // Append clear instructions for the user to grant access.
                var hint = ""
                if code == -1743 {
                    hint = "\n\nTCC denial. To authorize interceptor-bridge to send Apple Events to this app:\n" +
                           "  System Settings → Privacy & Security → Automation → interceptor-bridge → toggle on for the target app.\n" +
                           "If interceptor-bridge does not appear under Automation, the first event dispatch should have prompted you.\n" +
                           "Reset the entry with: tccutil reset AppleEvents com.interceptor.bridge"
                }
                completion(WireFormat.error(
                    "app_intent failed (\(code)): \(msg)" +
                    (appName.isEmpty ? "" : " — app: \(appName)") +
                    hint +
                    "\n--- script ---\n\(source)"
                ))
                return
            }
            let serialized = self.descriptorToValue(result)
            completion(WireFormat.success([
                "result": serialized ?? NSNull(),
                "raw": result.stringValue ?? "",
                "script": source
            ]))
        }
    }

    // MARK: OSAScript executor (JavaScript / JXA)
    private func executeOSAScript(
        _ source: String,
        language: String,
        targetBundleId: String?,
        arguments: [String]?,
        completion: @escaping @Sendable ([String: Any]) -> Void
    ) {
        DispatchQueue.main.async {
            guard let osaLanguage = OSALanguage(forName: language) else {
                completion(WireFormat.error("osa_script: OSA language not available: \(language)"))
                return
            }

            let executableSource: String
            if let bid = targetBundleId, !bid.isEmpty {
                executableSource = "const target = Application(\(self.javascriptStringLiteral(bid)));\n" + source
            } else {
                executableSource = source
            }

            let script = OSAScript(source: executableSource, language: osaLanguage)
            var compileError: NSDictionary?
            if !script.compileAndReturnError(&compileError) {
                completion(WireFormat.error(self.formatOSAError(prefix: "osa_script JXA compile failed", errorInfo: compileError, source: executableSource)))
                return
            }

            var executeError: NSDictionary?
            let result: NSAppleEventDescriptor?
            if let arguments {
                result = script.executeHandler(withName: "run", arguments: [arguments], error: &executeError)
            } else {
                result = script.executeAndReturnError(&executeError)
            }
            if executeError != nil {
                completion(WireFormat.error(self.formatOSAError(prefix: "osa_script JXA failed", errorInfo: executeError, source: executableSource)))
                return
            }

            let serialized = self.descriptorToValue(result)
            var payload: [String: Any] = [
                "result": serialized ?? NSNull(),
                "raw": result?.stringValue ?? "",
                "script": executableSource,
                "language": language
            ]
            if let targetBundleId { payload["targetBundleId"] = targetBundleId }
            if let arguments { payload["arguments"] = arguments }
            completion(WireFormat.success(payload))
        }
    }

    private func scriptArguments(from value: Any?) -> [String]? {
        guard let value else { return nil }
        if let strings = value as? [String] {
            return strings
        }
        if let values = value as? [Any] {
            return values.map { String(describing: $0) }
        }
        return [String(describing: value)]
    }

    // MARK: JavaScriptCore executor (plain ECMAScript)
    private func executeJavaScriptCore(
        _ source: String,
        targetBundleId: String?,
        arguments: [String]?,
        hostOptions: JSCHostOptions,
        completion: @escaping @Sendable ([String: Any]) -> Void
    ) {
        if let bid = targetBundleId, !bid.isEmpty {
            completion(WireFormat.error(
                "jsc: --bundle targets are only valid for AppleScript/JXA or structured Apple Events. " +
                "JavaScriptCore runs inside interceptor-bridge and does not provide Application(...).\n--- script ---\n\(source)"
            ))
            return
        }

        DispatchQueue.main.async {
            guard let context = JSContext() else {
                completion(WireFormat.error("jsc: failed to create JSContext"))
                return
            }
            context.name = "Interceptor JavaScriptCore"

            var capturedException: JSValue?
            context.exceptionHandler = { _, exception in
                capturedException = exception
            }

            if #available(macOS 13.3, *) {
                context.isInspectable = false
            }

            let argv = arguments ?? []
            context.setObject(argv, forKeyedSubscript: "argv" as NSString)
            if hostOptions.enabled {
                self.installJSCHost(in: context, capabilities: hostOptions.capabilities)
            }

            var result = context.evaluateScript(source)
            if let exception = capturedException ?? context.exception {
                completion(WireFormat.error(self.formatJSCError(exception, source: source)))
                return
            }

            if let arguments {
                let runValue = context.objectForKeyedSubscript("run")
                if let runValue, !runValue.isUndefined, !runValue.isNull {
                    capturedException = nil
                    context.exception = nil
                    result = runValue.call(withArguments: [arguments])
                    if let exception = capturedException ?? context.exception {
                        completion(WireFormat.error(self.formatJSCError(exception, source: source)))
                        return
                    }
                }
            }

            let serialized = self.jsValueToValue(result, context: context)
            var payload: [String: Any] = [
                "result": serialized ?? NSNull(),
                "raw": self.jsValueRawString(result, context: context),
                "script": source,
                "language": "JavaScriptCore"
            ]
            if let arguments { payload["arguments"] = arguments }
            if hostOptions.enabled {
                payload["host"] = ["capabilities": Array(hostOptions.capabilities).sorted()]
            }
            completion(WireFormat.success(payload))
        }
    }

    private func jscHostOptions(from value: Any?) -> (options: JSCHostOptions, error: String?) {
        guard let value else {
            return (JSCHostOptions(capabilities: []), nil)
        }
        if let enabled = value as? Bool {
            return (JSCHostOptions(capabilities: enabled ? JSCHostOptions.allCapabilities : []), nil)
        }

        let tokens: [String]
        if let raw = value as? String {
            tokens = raw
                .split { char in char == "," || char == " " || char == "\t" || char == "\n" }
                .map { String($0).lowercased() }
        } else if let values = value as? [String] {
            tokens = values.flatMap {
                $0.split { char in char == "," || char == " " || char == "\t" || char == "\n" }
                    .map { String($0).lowercased() }
            }
        } else if let values = value as? [Any] {
            tokens = values.flatMap {
                String(describing: $0)
                    .split { char in char == "," || char == " " || char == "\t" || char == "\n" }
                    .map { String($0).lowercased() }
            }
        } else {
            tokens = [String(describing: value).lowercased()]
        }

        if tokens.isEmpty || tokens.contains("none") || tokens.contains("false") {
            return (JSCHostOptions(capabilities: []), nil)
        }
        if tokens.contains("all") || tokens.contains("native") || tokens.contains("unsafe") {
            return (JSCHostOptions(capabilities: JSCHostOptions.allCapabilities), nil)
        }
        let requested = Set(tokens)
        let unknown = requested.subtracting(JSCHostOptions.allCapabilities).sorted()
        if !unknown.isEmpty {
            return (
                JSCHostOptions(capabilities: []),
                "jsc: unknown --jsc-host capability \(unknown.joined(separator: ",")); expected all or one of \(JSCHostOptions.allCapabilities.sorted().joined(separator: ","))"
            )
        }
        return (JSCHostOptions(capabilities: requested), nil)
    }

    private func installJSCHost(in context: JSContext, capabilities: Set<String>) {
        guard let host = JSValue(newObjectIn: context) else { return }
        let sortedCapabilities = Array(capabilities).sorted()
        host.setObject("Interceptor JavaScriptCore Host", forKeyedSubscript: "name" as NSString)
        host.setObject(sortedCapabilities, forKeyedSubscript: "capabilities" as NSString)

        let fail: (String) -> Any? = { message in
            context.exception = JSValue(newErrorFromMessage: message, in: context)
            return nil
        }

        if capabilities.contains("env") {
            let home: @convention(block) () -> String = {
                FileManager.default.homeDirectoryForCurrentUser.path
            }
            let env: @convention(block) (String) -> Any? = { name in
                ProcessInfo.processInfo.environment[name] as Any?
            }
            let expandPath: @convention(block) (String) -> String = { path in
                self.expandJSCPath(path)
            }
            host.setObject(home, forKeyedSubscript: "home" as NSString)
            host.setObject(env, forKeyedSubscript: "env" as NSString)
            host.setObject(expandPath, forKeyedSubscript: "expandPath" as NSString)
        }

        if capabilities.contains("fs") {
            let exists: @convention(block) (String) -> Bool = { path in
                FileManager.default.fileExists(atPath: self.expandJSCPath(path))
            }
            let readText: @convention(block) (String) -> Any? = { path in
                do {
                    return try String(contentsOfFile: self.expandJSCPath(path), encoding: .utf8)
                } catch {
                    return fail("host.readText failed for \(path): \(error.localizedDescription)")
                }
            }
            let readBase64: @convention(block) (String) -> Any? = { path in
                do {
                    let data = try Data(contentsOf: URL(fileURLWithPath: self.expandJSCPath(path)))
                    return data.base64EncodedString()
                } catch {
                    return fail("host.readBase64 failed for \(path): \(error.localizedDescription)")
                }
            }
            let writeText: @convention(block) (String, String) -> Any? = { path, contents in
                do {
                    let expanded = self.expandJSCPath(path)
                    let url = URL(fileURLWithPath: expanded)
                    try FileManager.default.createDirectory(
                        at: url.deletingLastPathComponent(),
                        withIntermediateDirectories: true
                    )
                    try contents.write(to: url, atomically: true, encoding: .utf8)
                    return true
                } catch {
                    return fail("host.writeText failed for \(path): \(error.localizedDescription)")
                }
            }
            let list: @convention(block) (String) -> Any? = { path in
                do {
                    return try FileManager.default.contentsOfDirectory(atPath: self.expandJSCPath(path))
                } catch {
                    return fail("host.list failed for \(path): \(error.localizedDescription)")
                }
            }
            let stat: @convention(block) (String) -> Any? = { path in
                let expanded = self.expandJSCPath(path)
                do {
                    return try self.jscFileStat(path: expanded)
                } catch {
                    return fail("host.stat failed for \(path): \(error.localizedDescription)")
                }
            }
            host.setObject(exists, forKeyedSubscript: "exists" as NSString)
            host.setObject(readText, forKeyedSubscript: "readText" as NSString)
            host.setObject(readBase64, forKeyedSubscript: "readBase64" as NSString)
            host.setObject(writeText, forKeyedSubscript: "writeText" as NSString)
            host.setObject(list, forKeyedSubscript: "list" as NSString)
            host.setObject(stat, forKeyedSubscript: "stat" as NSString)
        }

        if capabilities.contains("shell") {
            let shell: @convention(block) (String, JSValue?) -> Any? = { executable, argsValue in
                let args = self.jscStringArray(argsValue) ?? []
                return self.runJSCProcess(executable: executable, arguments: args)
            }
            let sh: @convention(block) (String) -> Any? = { command in
                self.runJSCProcess(executable: "/bin/zsh", arguments: ["-lc", command])
            }
            host.setObject(shell, forKeyedSubscript: "shell" as NSString)
            host.setObject(sh, forKeyedSubscript: "sh" as NSString)
        }

        if capabilities.contains("sqlite") {
            let sqlite: @convention(block) (String, String) -> Any? = { path, sql in
                do {
                    return try self.runJSCSQLite(path: self.expandJSCPath(path), sql: sql)
                } catch {
                    return fail("host.sqlite failed for \(path): \(error.localizedDescription)")
                }
            }
            host.setObject(sqlite, forKeyedSubscript: "sqlite" as NSString)
        }

        if capabilities.contains("osa") {
            let appleScript: @convention(block) (String) -> Any? = { source in
                do {
                    return try self.runOSAScriptSync(source, language: "AppleScript", arguments: nil)
                } catch {
                    return fail("host.appleScript failed: \(error.localizedDescription)")
                }
            }
            let jxa: @convention(block) (String, JSValue?) -> Any? = { source, argsValue in
                do {
                    return try self.runOSAScriptSync(
                        source,
                        language: "JavaScript",
                        arguments: self.jscStringArray(argsValue)
                    )
                } catch {
                    return fail("host.jxa failed: \(error.localizedDescription)")
                }
            }
            host.setObject(appleScript, forKeyedSubscript: "appleScript" as NSString)
            host.setObject(jxa, forKeyedSubscript: "jxa" as NSString)
        }

        context.setObject(host, forKeyedSubscript: "host" as NSString)
        context.setObject(host, forKeyedSubscript: "Interceptor" as NSString)
    }

    private func expandJSCPath(_ path: String) -> String {
        NSString(string: path).expandingTildeInPath
    }

    private func jscStringArray(_ value: JSValue?) -> [String]? {
        guard let value, !value.isUndefined, !value.isNull else { return nil }
        if value.isArray {
            return (value.toArray() ?? []).map { String(describing: $0) }
        }
        if let object = value.toObject() {
            return [String(describing: object)]
        }
        return nil
    }

    private func jscFileStat(path: String) throws -> [String: Any] {
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
        var result: [String: Any] = [
            "path": path,
            "exists": exists,
            "isDirectory": isDirectory.boolValue
        ]
        guard exists else { return result }

        let attrs = try FileManager.default.attributesOfItem(atPath: path)
        if let size = attrs[.size] as? NSNumber {
            result["size"] = sanitizeJSCNumber(size)
        }
        if let created = attrs[.creationDate] as? Date {
            result["creationDate"] = ISO8601DateFormatter().string(from: created)
        }
        if let modified = attrs[.modificationDate] as? Date {
            result["modificationDate"] = ISO8601DateFormatter().string(from: modified)
        }
        if let permissions = attrs[.posixPermissions] as? NSNumber {
            result["posixPermissions"] = permissions.intValue
        }
        return result
    }

    private func runJSCProcess(executable: String, arguments: [String]) -> [String: Any] {
        let expandedExecutable = expandJSCPath(executable)
        let task = Process()
        task.executableURL = URL(fileURLWithPath: expandedExecutable)
        task.arguments = arguments

        let tempRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("interceptor-jsc-\(UUID().uuidString)", isDirectory: true)
        let stdoutURL = tempRoot.appendingPathComponent("stdout")
        let stderrURL = tempRoot.appendingPathComponent("stderr")

        do {
            try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: stdoutURL.path, contents: nil)
            FileManager.default.createFile(atPath: stderrURL.path, contents: nil)

            let stdout = try FileHandle(forWritingTo: stdoutURL)
            let stderr = try FileHandle(forWritingTo: stderrURL)
            task.standardOutput = stdout
            task.standardError = stderr
            try task.run()

            let sema = DispatchSemaphore(value: 0)
            DispatchQueue.global(qos: .utility).async {
                task.waitUntilExit()
                sema.signal()
            }
            let timedOut = sema.wait(timeout: .now() + 30) == .timedOut
            if timedOut {
                task.terminate()
                _ = sema.wait(timeout: .now() + 2)
                if task.isRunning {
                    task.interrupt()
                }
            }
            try? stdout.close()
            try? stderr.close()

            var payload: [String: Any] = [
                "exitCode": timedOut ? -1 : Int(task.terminationStatus),
                "timedOut": timedOut,
                "stdout": readJSCOutputFile(stdoutURL),
                "stderr": readJSCOutputFile(stderrURL)
            ]
            if timedOut {
                payload["error"] = "process timed out after 30s"
            }
            try? FileManager.default.removeItem(at: tempRoot)
            return payload
        } catch {
            try? FileManager.default.removeItem(at: tempRoot)
            return [
                "exitCode": -1,
                "timedOut": false,
                "stdout": "",
                "stderr": error.localizedDescription,
                "error": error.localizedDescription
            ]
        }
    }

    private func readJSCOutputFile(_ url: URL, maxBytes: Int = 1_000_000) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? handle.close() }
        let data = (try? handle.read(upToCount: maxBytes + 1)) ?? Data()
        let truncated = data.count > maxBytes
        let prefix = truncated ? data.prefix(maxBytes) : data[...]
        let text = String(data: Data(prefix), encoding: .utf8) ?? ""
        return truncated ? text + "\n[truncated at \(maxBytes) bytes]" : text
    }

    private func runJSCSQLite(path: String, sql: String) throws -> Any {
        let result = runJSCProcess(executable: "/usr/bin/sqlite3", arguments: ["-readonly", "-json", path, sql])
        let exitCode = result["exitCode"] as? Int ?? -1
        if exitCode != 0 {
            throw NSError(
                domain: "InterceptorJSC",
                code: exitCode,
                userInfo: [NSLocalizedDescriptionKey: result["stderr"] as? String ?? "sqlite3 failed"]
            )
        }
        let stdout = result["stdout"] as? String ?? ""
        guard !stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return []
        }
        guard let data = stdout.data(using: .utf8) else { return stdout }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    private func runOSAScriptSync(_ source: String, language: String, arguments: [String]?) throws -> [String: Any] {
        guard let osaLanguage = OSALanguage(forName: language) else {
            throw NSError(
                domain: "InterceptorJSC",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "OSA language not available: \(language)"]
            )
        }
        let script = OSAScript(source: source, language: osaLanguage)
        var compileError: NSDictionary?
        if !script.compileAndReturnError(&compileError) {
            throw NSError(
                domain: "InterceptorJSC",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: formatOSAError(prefix: "OSA compile failed", errorInfo: compileError, source: source)]
            )
        }
        var executeError: NSDictionary?
        let result: NSAppleEventDescriptor?
        if let arguments {
            result = script.executeHandler(withName: "run", arguments: [arguments], error: &executeError)
        } else {
            result = script.executeAndReturnError(&executeError)
        }
        if executeError != nil {
            throw NSError(
                domain: "InterceptorJSC",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: formatOSAError(prefix: "OSA failed", errorInfo: executeError, source: source)]
            )
        }
        return [
            "result": descriptorToValue(result) ?? NSNull(),
            "raw": result?.stringValue ?? "",
            "language": language
        ]
    }

    private func formatJSCError(_ exception: JSValue?, source: String) -> String {
        let message = exception?.toString() ?? "unknown JavaScriptCore exception"
        var extra = ""
        if let line = exception?.forProperty("line"), !line.isUndefined, !line.isNull {
            extra += " — line: \(line.toString() ?? "")"
        }
        if let column = exception?.forProperty("column"), !column.isUndefined, !column.isNull {
            extra += " — column: \(column.toString() ?? "")"
        }
        if let stack = exception?.forProperty("stack"), !stack.isUndefined, !stack.isNull,
           let stackText = stack.toString(), !stackText.isEmpty {
            extra += "\nstack: \(stackText)"
        }
        return "jsc failed: \(message)\(extra)\n--- script ---\n\(source)"
    }

    private func jsValueRawString(_ value: JSValue?, context: JSContext) -> String {
        guard let value else { return "" }
        if value.isUndefined { return "undefined" }
        if value.isNull { return "null" }

        let stringifier = context.evaluateScript("""
        (function(value) {
          try {
            var json = JSON.stringify(value);
            return json === undefined ? String(value) : json;
          } catch (_) {
            return String(value);
          }
        })
        """)
        if let raw = stringifier?.call(withArguments: [value])?.toString() {
            return raw
        }
        return value.toString() ?? ""
    }

    private func jsValueToValue(_ value: JSValue?, context: JSContext? = nil) -> Any? {
        guard let value else { return nil }
        if value.isUndefined || value.isNull { return NSNull() }
        if value.isBoolean { return value.toBool() }
        if value.isNumber {
            let number = value.toDouble()
            if number.isFinite && number.rounded(.towardZero) == number {
                if number >= Double(Int.min) && number <= Double(Int.max) {
                    return Int(number)
                }
            }
            return number
        }
        if value.isString { return value.toString() ?? "" }
        if value.isArray {
            if let context, let jsonValue = jsValueJSONValue(value, context: context) {
                return jsonValue
            }
            return sanitizeJSCValue(value.toArray()) ?? []
        }
        if value.isDate {
            if let date = value.toDate() {
                let formatter = ISO8601DateFormatter()
                return formatter.string(from: date)
            }
            return value.toString() ?? ""
        }
        if value.isObject {
            if let context, let jsonValue = jsValueJSONValue(value, context: context) {
                return jsonValue
            }
            return sanitizeJSCValue(value.toObject()) ?? (value.toString() ?? "")
        }
        return value.toString() ?? ""
    }

    private func jsValueJSONValue(_ value: JSValue, context: JSContext) -> Any? {
        let stringifier = context.evaluateScript("""
        (function(value) {
          try {
            var json = JSON.stringify(value);
            return json === undefined ? null : json;
          } catch (_) {
            return null;
          }
        })
        """)
        guard let jsonText = stringifier?.call(withArguments: [value])?.toString(),
              !jsonText.isEmpty,
              let data = jsonText.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return nil
        }
        return sanitizeJSCValue(object)
    }

    private func sanitizeJSCValue(_ value: Any?) -> Any? {
        guard let value else { return nil }
        if value is NSNull { return NSNull() }
        if let value = value as? String { return value }
        if let value = value as? NSNumber { return sanitizeJSCNumber(value) }
        if let value = value as? Bool { return value }
        if let value = value as? Int { return value }
        if let value = value as? Int32 { return value }
        if let value = value as? Int64 { return value }
        if let value = value as? Double { return value }
        if let value = value as? Float { return Double(value) }
        if let value = value as? JSValue { return jsValueToValue(value) }
        if let value = value as? Date {
            let formatter = ISO8601DateFormatter()
            return formatter.string(from: value)
        }
        if let value = value as? [Any] {
            return value.map { sanitizeJSCValue($0) ?? NSNull() }
        }
        if let value = value as? [AnyHashable: Any] {
            var dict: [String: Any] = [:]
            for (key, item) in value {
                dict[String(describing: key)] = sanitizeJSCValue(item) ?? NSNull()
            }
            return dict
        }
        if let value = value as? NSDictionary {
            var dict: [String: Any] = [:]
            for (key, item) in value {
                dict[String(describing: key)] = sanitizeJSCValue(item) ?? NSNull()
            }
            return dict
        }
        if let value = value as? NSArray {
            return value.map { sanitizeJSCValue($0) ?? NSNull() }
        }
        return String(describing: value)
    }

    private func sanitizeJSCNumber(_ number: NSNumber) -> Any {
        let type = String(cString: number.objCType)
        if CFGetTypeID(number) == CFBooleanGetTypeID() || type == "c" {
            return number.boolValue
        }
        let value = number.doubleValue
        if value.isFinite && value.rounded(.towardZero) == value {
            if value >= Double(Int.min) && value <= Double(Int.max) {
                return Int(value)
            }
        }
        return value
    }

    private func javascriptStringLiteral(_ value: String) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: [value], options: []),
           let raw = String(data: data, encoding: .utf8),
           raw.count >= 2 {
            return String(raw.dropFirst().dropLast())
        }
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
        return "\"\(escaped)\""
    }

    private func formatOSAError(prefix: String, errorInfo: NSDictionary?, source: String) -> String {
        guard let err = errorInfo as? [String: Any] else {
            return "\(prefix): unknown OSA error\n--- script ---\n\(source)"
        }

        let msg = (err[OSAScriptErrorMessage] as? String)
            ?? (err[OSAScriptErrorBriefMessage] as? String)
            ?? "unknown OSA error"
        let code = err[OSAScriptErrorNumber] as? Int ?? -1
        let appName = (err[OSAScriptErrorAppName] as? String) ?? ""
        let rangeText: String
        if let rangeValue = err[OSAScriptErrorRange] as? NSValue {
            let range = rangeValue.rangeValue
            rangeText = " range: \(range.location)..<\(range.location + range.length)"
        } else {
            rangeText = ""
        }
        let partial = descriptorToValue(err[OSAScriptErrorPartialResultKey] as? NSAppleEventDescriptor)
        let expected = descriptorToValue(err[OSAScriptErrorExpectedTypeKey] as? NSAppleEventDescriptor)
        let offending = descriptorToValue(err[OSAScriptErrorOffendingObjectKey] as? NSAppleEventDescriptor)

        var extra = ""
        if !appName.isEmpty { extra += " — app: \(appName)" }
        if !rangeText.isEmpty { extra += " —\(rangeText)" }
        if let partial { extra += "\npartialResult: \(partial)" }
        if let expected { extra += "\nexpectedType: \(expected)" }
        if let offending { extra += "\noffendingObject: \(offending)" }
        if code == -1743 {
            extra += "\n\nTCC denial. Authorize interceptor-bridge under System Settings → Privacy & Security → Automation."
        }

        return "\(prefix) (\(code)): \(msg)\(extra)\n--- script ---\n\(source)"
    }

    // MARK: result descriptor → Foundation value
    private func descriptorToValue(_ desc: NSAppleEventDescriptor?) -> Any? {
        guard let d = desc else { return nil }
        // Common scalar types first.
        if d.descriptorType == typeUnicodeText || d.descriptorType == typeUTF8Text || d.descriptorType == typeText {
            return d.stringValue
        }
        if d.descriptorType == typeTrue {
            return true
        }
        if d.descriptorType == typeFalse {
            return false
        }
        if d.descriptorType == typeBoolean {
            return d.booleanValue
        }
        if d.descriptorType == typeSInt32 || d.descriptorType == typeSInt16 {
            return d.int32Value
        }
        if d.descriptorType == typeIEEE64BitFloatingPoint {
            return d.doubleValue
        }
        // List → array.
        if d.descriptorType == typeAEList {
            var arr: [Any?] = []
            for i in stride(from: 1, through: d.numberOfItems, by: 1) {
                let item = d.atIndex(i)
                arr.append(descriptorToValue(item))
            }
            return arr
        }
        // Record → dict.
        if d.descriptorType == typeAERecord {
            var dict: [String: Any?] = [:]
            for i in stride(from: 1, through: d.numberOfItems, by: 1) {
                let key = d.keywordForDescriptor(at: i)
                let val = d.atIndex(i)
                let keyStr = String(format: "%c%c%c%c",
                    (key >> 24) & 0xff, (key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff)
                dict[keyStr] = descriptorToValue(val)
            }
            if dict.count == 1, let userFields = dict["usrf"] as? [Any?] {
                var record: [String: Any?] = [:]
                var i = 0
                while i + 1 < userFields.count {
                    if let key = userFields[i] as? String {
                        record[key] = userFields[i + 1]
                    }
                    i += 2
                }
                if !record.isEmpty || userFields.isEmpty { return record }
            }
            return dict
        }
        return d.stringValue
    }
}
