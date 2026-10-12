// issue #244: deliver a vault-resolved value only to the retained Apple
// SecurityAgent password dialog. Secure values are never read or logged.
import Foundation
import AppKit
import ApplicationServices
import Security
import Darwin

final class AuthDialogDomain: DomainHandler, @unchecked Sendable {
    static let securityAgentBundleId = "com.apple.SecurityAgent"
    static let submitTitles: Set<String> = [
        "OK", "Install", "Install Software", "Install Helper", "Unlock", "Allow",
        "Modify Settings", "Continue", "Update Settings", "Authorize", "Authenticate",
    ]
    private let transport: any AXTransport
    private let lock = NSLock()
    private var activeFill: UUID?
    private struct DialogBinding { let name: String; let dialog: DialogScan; let created: UInt64 }
    private var bindings: [String: DialogBinding] = [:]
    private static let requirement = UncheckedSendableBox<SecRequirement?>({
        var value: SecRequirement?
        guard SecRequirementCreateWithString(
            #"identifier "com.apple.SecurityAgent" and anchor apple"# as CFString, [], &value
        ) == errSecSuccess else { return nil }
        return value
    }())

    init(transport: any AXTransport = LiveAXTransport()) { self.transport = transport }

    private struct Failure: Error {
        let code: String
        let message: String
        var reply: [String: Any] {
            ["success": false, "code": code, "error": message, "retryable": false]
        }
    }

    // The timer retires delivery, not admission. A blocked native call keeps
    // the domain's active owner until the worker actually returns.
    private final class FillOperation: @unchecked Sendable {
        let generation = UUID()
        let deadline = DispatchTime.now().uptimeNanoseconds + 20_000_000_000
        private let lock = NSLock()
        private var callback: (@Sendable ([String: Any]) -> Void)?
        private var dispatched = false
        init(_ callback: @escaping @Sendable ([String: Any]) -> Void) { self.callback = callback }
        var current: Bool {
            lock.lock(); defer { lock.unlock() }
            return callback != nil && DispatchTime.now().uptimeNanoseconds < deadline
        }
        func markDispatch() -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard callback != nil, DispatchTime.now().uptimeNanoseconds < deadline else { return false }
            dispatched = true
            return true
        }
        func finish(_ result: [String: Any]) {
            lock.lock()
            let reply = callback; callback = nil
            let expired = DispatchTime.now().uptimeNanoseconds >= deadline
            let sent = dispatched
            lock.unlock()
            if expired {
                reply?(["success": false, "code": sent ? "timeout_unknown_outcome" : "timeout",
                        "error": "authentication operation exceeded its deadline; observe before another action",
                        "retryable": false, "details": ["dispatched": sent, "nativeCleanupPending": true]])
            } else { reply?(result) }
        }
        func expire() {
            lock.lock()
            let reply = callback; callback = nil; let sent = dispatched
            lock.unlock()
            reply?([
                "success": false,
                "code": sent ? "timeout_unknown_outcome" : "timeout",
                "error": sent ? "authentication mutation outcome is unknown; observe before any new action" : "authentication delivery deadline expired before mutation",
                "retryable": false,
                "details": ["dispatched": sent, "nativeCleanupPending": true],
            ])
        }
    }

    fileprivate final class AgentIdentity {
        let app: NSRunningApplication
        let code: SecCode
        let seconds: UInt64
        let microseconds: UInt64
        let uid: uid_t
        let bundleURL: URL
        let executableURL: URL
        var pid: pid_t { app.processIdentifier }
        init(app: NSRunningApplication, code: SecCode, kernel: proc_bsdinfo, bundleURL: URL, executableURL: URL) {
            self.app = app; self.code = code
            seconds = kernel.pbi_start_tvsec; microseconds = kernel.pbi_start_tvusec
            uid = kernel.pbi_uid; self.bundleURL = bundleURL; self.executableURL = executableURL
        }
        func isCurrent() -> Bool {
            var kernel = proc_bsdinfo()
            guard !app.isTerminated, uid == getuid(),
                  proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &kernel, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size),
                  kernel.pbi_uid == uid, kernel.pbi_start_tvsec == seconds, kernel.pbi_start_tvusec == microseconds,
                  let live = NSRunningApplication(processIdentifier: pid),
                  live.bundleIdentifier == AuthDialogDomain.securityAgentBundleId,
                  live.bundleURL?.resolvingSymlinksInPath() == bundleURL,
                  live.executableURL?.resolvingSymlinksInPath() == executableURL,
                  let requirement = AuthDialogDomain.requirement.value,
                  SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { return false }
            return true
        }
    }

    struct DialogScan: @unchecked Sendable {
        var pid: pid_t
        var window: AXUIElement
        var title: String
        var messages: [String] = []
        var buttons: [(title: String, element: AXUIElement)] = []
        var secureField: AXUIElement?
        var usernameField: AXUIElement?
        var usernameValue: String = ""
        var usePassword: AXUIElement?
        fileprivate var identity: AgentIdentity?
        init(pid: pid_t, window: AXUIElement, title: String) {
            self.pid = pid
            self.window = window
            self.title = title
        }
        var shape: String { secureField != nil ? "password" : (usePassword != nil ? "touchid" : "unknown") }
    }

    private func agentApp() throws -> AgentIdentity? {
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: Self.securityAgentBundleId)
        guard !apps.isEmpty else { return nil }
        guard apps.count == 1, let app = apps.first else {
            throw Failure(code: "target_ambiguous", message: "multiple SecurityAgent processes are present")
        }
        var kernel = proc_bsdinfo()
        let pid = app.processIdentifier
        guard pid > 0, !app.isTerminated,
              proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &kernel, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size),
              kernel.pbi_uid == getuid(), let bundle = app.bundleURL?.resolvingSymlinksInPath(),
              let executable = app.executableURL?.resolvingSymlinksInPath(),
              bundle.path.hasPrefix("/System/Library/"), executable.path.hasPrefix(bundle.path + "/Contents/MacOS/"),
              let requirement = Self.requirement.value else {
            throw Failure(code: "permission_denied", message: "SecurityAgent kernel, user or system bundle identity is unavailable")
        }
        var code: SecCode?
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
              let code, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else {
            throw Failure(code: "permission_denied", message: "running SecurityAgent does not satisfy its Apple signing requirement")
        }
        var staticCode: SecStaticCode?
        var path: CFURL?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopyPath(staticCode, [], &path) == errSecSuccess, let path,
              (path as URL).resolvingSymlinksInPath() == bundle else {
            throw Failure(code: "permission_denied", message: "running SecurityAgent signed bundle does not match its application identity")
        }
        let identity = AgentIdentity(app: app, code: code, kernel: kernel, bundleURL: bundle, executableURL: executable)
        guard identity.isCurrent() else { throw Failure(code: "target_gone", message: "SecurityAgent changed during identity lookup") }
        return identity
    }

    private struct ScanBudget {
        let deadline: UInt64
        var nodes = 0
        var bytes = 0
        var visited: [AXUIElement] = []
        mutating func check(_ element: AXUIElement, depth: Int) throws -> Bool {
            guard DispatchTime.now().uptimeNanoseconds < deadline, depth <= 12, nodes < 512 else {
                throw Failure(code: "resource_limit", message: "authentication dialog traversal exceeded its time, depth or node limit")
            }
            if visited.contains(where: { CFEqual($0, element) }) { return false }
            nodes += 1; visited.append(element)
            return true
        }
    }

    private func value(_ element: AXUIElement, _ attribute: String, deadline: UInt64) throws -> CFTypeRef? {
        guard DispatchTime.now().uptimeNanoseconds < deadline else {
            throw Failure(code: "timeout", message: "authentication dialog observation deadline expired")
        }
        _ = transport.setMessagingTimeout(element, seconds: 0.25)
        let (error, value) = transport.copyAttributeValue(element, attribute)
        if error == .attributeUnsupported || error == .noValue { return nil }
        guard error == .success else {
            throw Failure(code: error == .invalidUIElement ? "target_gone" : "provider_failed",
                          message: "authentication dialog AX observation failed (\(error.rawValue))")
        }
        guard DispatchTime.now().uptimeNanoseconds < deadline else {
            throw Failure(code: "timeout", message: "authentication dialog native observation exceeded its deadline")
        }
        return value
    }

    private func string(_ element: AXUIElement, _ attribute: String, budget: inout ScanBudget) throws -> String {
        guard let raw = try value(element, attribute, deadline: budget.deadline) else { return "" }
        guard let text = raw as? String, text.utf8.count <= 8192, budget.bytes <= 32768 - text.utf8.count else {
            throw Failure(code: "resource_limit", message: "authentication dialog text exceeded its bounded observation size")
        }
        budget.bytes += text.utf8.count
        return text
    }

    private func scan(expected: DialogScan? = nil, deadline: UInt64? = nil) throws -> DialogScan? {
        let identity: AgentIdentity
        if let retained = expected?.identity { identity = retained }
        else { guard let found = try agentApp() else { return nil }; identity = found }
        guard identity.isCurrent() else { throw Failure(code: "target_gone", message: "retained SecurityAgent process ended or changed") }
        let scanDeadline = min(deadline ?? UInt64.max, DispatchTime.now().uptimeNanoseconds + 2_000_000_000)
        let app = transport.createApplication(pid: identity.pid)
        _ = transport.setMessagingTimeout(app, seconds: 0.25)
        let (countError, count) = transport.attributeValueCount(app, kAXWindowsAttribute as String)
        guard DispatchTime.now().uptimeNanoseconds < scanDeadline else {
            throw Failure(code: "timeout", message: "authentication window inventory exceeded its deadline")
        }
        guard countError == .success, let count, (0...16).contains(count) else {
            throw Failure(code: countError == .success ? "resource_limit" : "provider_failed", message: "authentication window inventory is inaccessible or exceeds 16 windows")
        }
        if count == 0 { guard identity.isCurrent() else { throw Failure(code: "target_gone", message: "SecurityAgent changed during window observation") }; return nil }
        let (error, raw) = transport.copyAttributeValues(app, kAXWindowsAttribute as String, index: 0, maxValues: 16)
        guard error == .success, let raw, raw.count == count, raw.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }) else {
            throw Failure(code: "provider_failed", message: "authentication window inventory changed or could not be read")
        }
        let windows = raw.map { unsafeBitCast($0, to: AXUIElement.self) }
        let window: AXUIElement
        if let expected {
            guard let retained = windows.first(where: { CFEqual($0, expected.window) }) else { return nil }
            window = retained
        } else {
            guard windows.count == 1, let only = windows.first else {
                throw Failure(code: "target_ambiguous", message: "multiple SecurityAgent windows require a unique authentication target")
            }
            window = only
        }
        var budget = ScanBudget(deadline: scanDeadline)
        var result = DialogScan(pid: identity.pid, window: window, title: "")
        result.identity = identity
        result.title = try string(window, kAXTitleAttribute as String, budget: &budget)
        try walk(window, depth: 0, budget: &budget, into: &result)
        guard identity.isCurrent() else { throw Failure(code: "target_gone", message: "SecurityAgent changed during dialog traversal") }
        return result
    }

    private func walk(_ element: AXUIElement, depth: Int, budget: inout ScanBudget, into scan: inout DialogScan) throws {
        guard try budget.check(element, depth: depth) else { return }
        let (pidError, pid) = transport.pid(element)
        guard pidError == .success, pid == scan.pid else { throw Failure(code: "target_gone", message: "authentication control is not owned by the retained process") }
        let role = try string(element, kAXRoleAttribute as String, budget: &budget)
        let subrole = try string(element, kAXSubroleAttribute as String, budget: &budget)
        let title = try string(element, kAXTitleAttribute as String, budget: &budget)
        switch role {
        case "AXStaticText":
            let text = try string(element, kAXValueAttribute as String, budget: &budget)
            if !text.isEmpty { scan.messages.append(text) }
        case "AXButton":
            scan.buttons.append((title, element))
            if title.lowercased().hasPrefix("use password") {
                guard scan.usePassword == nil else { throw Failure(code: "target_ambiguous", message: "multiple password fallback controls are present") }
                scan.usePassword = element
            }
        case "AXTextField", "AXSecureTextField":
            if subrole == "AXSecureTextField" || role == "AXSecureTextField" {
                guard scan.secureField == nil else { throw Failure(code: "target_ambiguous", message: "multiple secure authentication fields are present") }
                scan.secureField = element
            } else {
                guard scan.usernameField == nil else { throw Failure(code: "target_ambiguous", message: "multiple authentication user fields are present") }
                scan.usernameField = element
                scan.usernameValue = try string(element, kAXValueAttribute as String, budget: &budget)
            }
        default: break
        }
        let (countError, count) = transport.attributeValueCount(element, kAXChildrenAttribute as String)
        if countError == .attributeUnsupported || countError == .noValue { return }
        guard countError == .success, let count, (0...256).contains(count), count <= 512 - budget.nodes else {
            throw Failure(code: countError == .success ? "resource_limit" : "provider_failed", message: "authentication child inventory is inaccessible or exceeds its node limit")
        }
        if count == 0 { return }
        let (error, children) = transport.copyAttributeValues(element, kAXChildrenAttribute as String, index: 0, maxValues: count)
        guard error == .success, let children, children.count == count, children.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }) else {
            throw Failure(code: "provider_failed", message: "authentication child inventory changed or could not be read")
        }
        for child in children { try walk(unsafeBitCast(child, to: AXUIElement.self), depth: depth + 1, budget: &budget, into: &scan) }
    }

    private func payload(_ scan: DialogScan) -> [String: Any] {
        var result: [String: Any] = [
            "present": true, "pid": Int(scan.pid), "shape": scan.shape,
            "title": scan.title, "message": scan.messages.joined(separator: " "),
            "buttons": scan.buttons.map { $0.title }, "username": scan.usernameValue,
            "hasSecureField": scan.secureField != nil,
        ]
        if let identity = scan.identity {
            result["identity"] = ["bundle": Self.securityAgentBundleId, "uid": Int(identity.uid),
                                  "processStartSeconds": String(identity.seconds), "processStartMicroseconds": String(identity.microseconds),
                                  "signingRequirement": #"identifier "com.apple.SecurityAgent" and anchor apple"#]
        }
        return result
    }

    private func validSecretName(_ name: String) -> Bool {
        name.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", options: .regularExpression) != nil
    }

    private func pruneBindings() {
        let now = DispatchTime.now().uptimeNanoseconds
        bindings = bindings.filter { now >= $0.value.created && now - $0.value.created < 300_000_000_000 }
    }

    private func status(_ action: [String: Any]) -> [String: Any] {
        do {
            let name = action["secretBindingName"] as? String
            let token = action["bindingToken"] as? String
            if action["secretBindingName"] != nil && (name == nil || !validSecretName(name!)) {
                throw Failure(code: "invalid_request", message: "authentication binding requires a bounded vault name")
            }
            if action["bindingToken"] != nil && (token == nil || token!.range(of: "^[a-f0-9]{64}$", options: .regularExpression) == nil || name == nil) {
                throw Failure(code: "invalid_request", message: "authentication binding token requires its exact vault name")
            }
            var retained: DialogBinding?
            if let token, let name {
                lock.lock(); pruneBindings(); retained = bindings[token]; lock.unlock()
                guard retained?.name == name else { throw Failure(code: "permission_denied", message: "authentication target binding expired or changed") }
            }
            guard let found = try scan(expected: retained?.dialog) else {
                if name != nil { throw Failure(code: "target_gone", message: "authentication binding target is no longer present") }
                return WireFormat.success(["present": false, "shape": "none"])
            }
            if let expected = retained?.dialog.secureField {
                guard let secure = found.secureField, CFEqual(expected, secure) else { throw Failure(code: "target_gone", message: "authentication binding secure field changed") }
            }
            var data = payload(found)
            if let name {
                var issued = token
                if issued == nil {
                    var bytes = [UInt8](repeating: 0, count: 32)
                    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
                        throw Failure(code: "provider_failed", message: "authentication binding randomness is unavailable")
                    }
                    let candidate = bytes.map { String(format: "%02x", $0) }.joined()
                    lock.lock(); pruneBindings()
                    guard bindings.count < 16 else { lock.unlock(); throw Failure(code: "resource_limit", message: "authentication target binding limit reached") }
                    bindings[candidate] = DialogBinding(name: name, dialog: found, created: DispatchTime.now().uptimeNanoseconds)
                    lock.unlock(); issued = candidate
                }
                data["bindingToken"] = issued
                data["bindingPurpose"] = "target-identity-only"
            }
            return WireFormat.success(data)
        } catch let failure as Failure { return failure.reply }
        catch { return WireFormat.failure("provider_failed", "authentication dialog observation failed") }
    }

    func submit(_ current: DialogScan, expected: DialogScan) -> [String: Any] {
        guard current.pid == expected.pid, CFEqual(current.window, expected.window),
              let secure = current.secureField, let expectedSecure = expected.secureField, CFEqual(secure, expectedSecure) else {
            return ["success": false, "code": "target_gone", "error": "authentication dialog changed after filling; no confirmation was sent", "retryable": false, "details": ["filled": true, "dispatched": false]]
        }
        // One-time permission wins. Never send Return or persistent approval.
        let allowed = current.buttons.filter { Self.submitTitles.contains($0.title) }
        let oneTime = allowed.filter { $0.title == "Allow" }
        let choices = oneTime.isEmpty ? allowed : oneTime
        guard choices.count == 1, let button = choices.first else {
            return ["success": false, "code": choices.isEmpty ? "unsupported_target" : "target_ambiguous", "error": "authentication dialog has no unique supported confirmation; no confirmation was sent", "retryable": false, "details": ["filled": true, "dispatched": false]]
        }
        let error = transport.performAction(button.element, kAXPressAction as String)
        guard error == .success else {
            return ["success": false, "code": "timeout_unknown_outcome", "error": "authentication confirmation outcome is unknown; observe before another action", "retryable": false, "details": ["filled": true, "dispatched": true, "submitted": button.title, "axError": Int(error.rawValue)]]
        }
        return WireFormat.success(button.title)
    }

    private func focused(_ scan: DialogScan, operation: FillOperation) -> Bool {
        guard operation.current, let identity = scan.identity, identity.isCurrent(), let secure = scan.secureField else { return false }
        let app = transport.createApplication(pid: scan.pid)
        guard let field = try? value(app, kAXFocusedUIElementAttribute as String, deadline: operation.deadline),
              CFGetTypeID(field) == AXUIElementGetTypeID(), CFEqual(field, secure),
              let window = try? value(app, kAXFocusedWindowAttribute as String, deadline: operation.deadline),
              CFGetTypeID(window) == AXUIElementGetTypeID(), CFEqual(window, scan.window) else { return false }
        let role = (try? value(secure, kAXRoleAttribute as String, deadline: operation.deadline)) as? String
        let subrole = (try? value(secure, kAXSubroleAttribute as String, deadline: operation.deadline)) as? String
        guard role == "AXSecureTextField" || role == "AXTextField" && subrole == "AXSecureTextField" else { return false }
        return operation.current && identity.isCurrent()
    }

    private func fill(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let text = action["text"] as? String, !text.isEmpty, text.utf8.count <= 8192,
              text.utf16.count <= 1024, text.count <= 512, !text.unicodeScalars.contains(where: { $0.value == 0 || $0.value == 10 || $0.value == 13 }) else {
            completion(WireFormat.failure("invalid_request", "authentication value must be nonempty, bounded and contain no NUL or line breaks")); return
        }
        if let raw = action["submit"], !(raw is NSNumber && CFGetTypeID(raw as! NSNumber) == CFBooleanGetTypeID()) {
            completion(WireFormat.failure("invalid_request", "authentication submit must be a Boolean")); return
        }
        let shouldSubmit = action["submit"] as? Bool ?? false
        guard let token = action["bindingToken"] as? String, token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let name = action["secretBindingName"] as? String, validSecretName(name) else {
            completion(WireFormat.failure("permission_denied", "authentication fill requires a retained vault target binding")); return
        }
        let operation = FillOperation(completion)
        lock.lock()
        guard activeFill == nil else {
            lock.unlock(); completion(WireFormat.failure("resource_limit", "another authentication fill or its native cleanup is still pending")); return
        }
        pruneBindings()
        guard let binding = bindings[token], binding.name == name else {
            lock.unlock(); completion(WireFormat.failure("permission_denied", "authentication fill target binding expired, was consumed or changed")); return
        }
        bindings.removeValue(forKey: token)
        activeFill = operation.generation
        lock.unlock()
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: DispatchTime(uptimeNanoseconds: operation.deadline)) { operation.expire() }
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            defer {
                if operation.current { operation.finish(WireFormat.failure("provider_failed", "authentication worker exited without a complete receipt")) }
                lock.lock(); if activeFill == operation.generation { activeFill = nil }; lock.unlock()
            }
            do {
                guard var dialog = try scan(expected: binding.dialog, deadline: operation.deadline) else {
                    throw Failure(code: "target_gone", message: "no administrator authentication dialog is present")
                }
                if let expected = binding.dialog.secureField {
                    guard let secure = dialog.secureField, CFEqual(secure, expected) else { throw Failure(code: "target_gone", message: "bound authentication secure field changed") }
                }
                var pressedUsePassword = false
                if dialog.secureField == nil, let fallback = dialog.usePassword {
                    guard operation.current else { return }
                    guard dialog.identity?.isCurrent() == true else { throw Failure(code: "target_gone", message: "SecurityAgent changed before password fallback") }
                    guard operation.markDispatch() else { return }
                    let error = transport.performAction(fallback, kAXPressAction as String)
                    guard error == .success else {
                        throw Failure(code: "timeout_unknown_outcome", message: "password fallback outcome is unknown; no value was delivered")
                    }
                    pressedUsePassword = true
                    let fallbackDeadline = min(operation.deadline, DispatchTime.now().uptimeNanoseconds + 4_000_000_000)
                    while operation.current && DispatchTime.now().uptimeNanoseconds < fallbackDeadline {
                        usleep(150_000)
                        guard let current = try scan(expected: dialog, deadline: fallbackDeadline) else {
                            throw Failure(code: "target_gone", message: "retained authentication window disappeared during password fallback")
                        }
                        dialog = current
                        if dialog.secureField != nil { break }
                    }
                }
                guard operation.current else { return }
                guard let secure = dialog.secureField else { throw Failure(code: "unsupported_target", message: "retained authentication dialog has no secure password field") }
                var usernameFixed = false
                if let username = dialog.usernameField {
                    let user = NSUserName()
                    if dialog.usernameValue != user && dialog.usernameValue != NSFullUserName() {
                        guard operation.current else { return }
                        guard dialog.identity?.isCurrent() == true else { throw Failure(code: "target_gone", message: "SecurityAgent changed before user selection") }
                        guard operation.markDispatch() else { return }
                        guard transport.setAttributeValue(username, kAXValueAttribute as String, user as CFString) == .success,
                              let current = try scan(expected: dialog, deadline: operation.deadline),
                              current.usernameValue == user, let currentField = current.secureField, CFEqual(currentField, secure) else {
                            throw Failure(code: "target_gone", message: "authentication user or secure field could not be verified; no password was posted")
                        }
                        dialog = current; usernameFixed = true
                    }
                }
                guard operation.current else { return }
                guard dialog.identity?.isCurrent() == true else { throw Failure(code: "target_gone", message: "SecurityAgent changed before secure field focus") }
                guard operation.markDispatch() else { return }
                guard transport.setAttributeValue(secure, kAXFocusedAttribute as String, kCFBooleanTrue) == .success else {
                    throw Failure(code: "timeout_unknown_outcome", message: "secure field focus outcome is unknown; no password was posted")
                }
                usleep(120_000)
                guard focused(dialog, operation: operation) else {
                    throw Failure(code: "target_gone", message: "the retained password field does not own the process keyboard focus; no password was posted")
                }
                // Select within the verified secure field, without activating
                // the application or routing through the shared HID tap.
                guard let source = CGEventSource(stateID: .privateState),
                      let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                    throw Failure(code: "provider_failed", message: "authentication event source is unavailable")
                }
                down.flags = .maskCommand; up.flags = .maskCommand
                guard focused(dialog, operation: operation) else { throw Failure(code: "target_gone", message: "authentication target changed before secure field selection") }
                guard operation.markDispatch() else { return }
                InputDomain.postEvent(down, on: .postToPid(dialog.pid))
                guard focused(dialog, operation: operation) else {
                    throw Failure(code: "timeout_unknown_outcome", message: "authentication target changed during selection; password was not posted")
                }
                InputDomain.postEvent(up, on: .postToPid(dialog.pid))
                usleep(50_000)
                guard InputDomain.postUnicodeKeystrokes(text, to: .postToPid(dialog.pid), shouldContinue: { self.focused(dialog, operation: operation) }) else {
                    throw Failure(code: "timeout_unknown_outcome", message: "password event delivery was interrupted; partial delivery is possible, observe before another action")
                }
                guard operation.current else { return }
                var submitted: String?
                if shouldSubmit {
                    usleep(150_000)
                    guard let current = try scan(expected: dialog, deadline: operation.deadline),
                          current.identity?.isCurrent() == true, operation.markDispatch() else {
                        throw Failure(code: "target_gone", message: "retained authentication dialog disappeared before confirmation")
                    }
                    let result = submit(current, expected: dialog)
                    guard result["success"] as? Bool == true else { operation.finish(result); return }
                    submitted = result["data"] as? String
                }
                var closed = false
                var observationError: String?
                if shouldSubmit {
                    let closeDeadline = min(operation.deadline, DispatchTime.now().uptimeNanoseconds + 3_000_000_000)
                    while operation.current && DispatchTime.now().uptimeNanoseconds < closeDeadline {
                        usleep(200_000)
                        do {
                            if try scan(expected: dialog, deadline: closeDeadline) == nil { closed = true; break }
                        } catch let failure as Failure { observationError = failure.code; break }
                    }
                }
                var data: [String: Any] = [
                    "filled": true, "chars": text.count,
                    "delivery": "event-posted", "valueAccepted": NSNull(),
                    "shape": pressedUsePassword ? "touchid" : "password",
                    "pressedUsePassword": pressedUsePassword, "usernameFixed": usernameFixed,
                    "routing": "pid=\(dialog.pid)", "submitted": submitted as Any? ?? NSNull(),
                    "dialogClosed": closed, "generation": operation.generation.uuidString,
                ]
                if let observationError { data["closureObservationError"] = observationError }
                operation.finish(WireFormat.success(data))
            } catch let failure as Failure { operation.finish(failure.reply) }
            catch { operation.finish(WireFormat.failure("provider_failed", "authentication dialog operation failed")) }
        }
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        let allowed: Set<String> = sub == "status"
            ? ["type", "sub", "group", "groupColor", "groupSoft", "secretBindingName", "bindingToken"]
            : ["type", "sub", "group", "groupColor", "groupSoft", "secretBindingName", "bindingToken", "text", "submit", "sensitive"]
        guard action.keys.allSatisfy({ allowed.contains($0) }) else {
            completion(WireFormat.failure("invalid_request", "authentication dialog received unsupported fields")); return
        }
        for key in ["group", "groupColor"] {
            if let raw = action[key] {
                guard let value = raw as? String, !value.isEmpty, value.utf8.count <= 256, !value.contains("\0") else {
                    completion(WireFormat.failure("invalid_request", "authentication dialog group metadata is invalid")); return
                }
            }
        }
        for key in ["groupSoft", "sensitive"] {
            if let raw = action[key], !(raw is NSNumber && CFGetTypeID(raw as! NSNumber) == CFBooleanGetTypeID()) {
                completion(WireFormat.failure("invalid_request", "authentication dialog flags must be Boolean")); return
            }
        }
        switch sub {
        case "status": completion(status(action))
        case "fill": fill(action, completion: completion)
        default: completion(WireFormat.failure("invalid_request", "unknown authentication dialog selector"))
        }
    }
}
