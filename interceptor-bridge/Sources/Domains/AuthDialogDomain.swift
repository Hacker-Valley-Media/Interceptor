// issue #244: fill the macOS administrator authentication prompt from the vault.
//
// The daemon resolves the secret and sends it as `text`. This domain locates
// the SecurityAgent prompt through Accessibility, takes the "Use Password"
// path when the sheet offers Touch ID, makes sure the user name field holds
// the current user, focuses the secure field, posts the value as keystrokes
// (secure fields refuse AX value-set), and optionally presses the confirm
// button. The text is never logged.
//
// Two prompt shapes exist (issue #244): Apple's GUI flows (Installer,
// System Settings) show a Touch ID sheet with a "Use Password…" button;
// third-party and CLI callers get the user name + password form directly.

import Foundation
import AppKit
import ApplicationServices

final class AuthDialogDomain: DomainHandler, @unchecked Sendable {
    static let securityAgentBundleId = "com.apple.SecurityAgent"
    static let submitTitles: Set<String> = [
        "OK", "Install", "Install Software", "Install Helper", "Unlock", "Allow", "Always Allow",
        "Modify Settings", "Continue", "Update Settings", "Authorize", "Authenticate",
    ]

    private let transport: any AXTransport

    init(transport: any AXTransport = LiveAXTransport()) {
        self.transport = transport
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "status": completion(status())
        case "fill":   fill(action, completion: completion)
        default:       completion(WireFormat.error("authdialog.\(sub) — unknown verb (status|fill)"))
        }
    }

    struct DialogScan {
        var pid: pid_t
        var window: AXUIElement
        var title: String
        var messages: [String] = []
        var buttons: [(title: String, element: AXUIElement)] = []
        var secureField: AXUIElement?
        var usernameField: AXUIElement?
        var usernameValue: String = ""
        var usePassword: AXUIElement?
        var shape: String { secureField != nil ? "password" : (usePassword != nil ? "touchid" : "unknown") }
    }

    private func agentApp() -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: Self.securityAgentBundleId).first
    }

    private func string(_ el: AXUIElement, _ attr: String) -> String? {
        let (e, v) = transport.copyAttributeValue(el, attr)
        guard e == .success, let v else { return nil }
        return AXValueCodec.displayString(v)
    }

    /// The first SecurityAgent window and the controls the fill needs.
    func scan() -> DialogScan? {
        guard let app = agentApp() else { return nil }
        let pid = app.processIdentifier
        let appEl = transport.createApplication(pid: pid)
        _ = transport.setMessagingTimeout(appEl, seconds: 2)
        let (err, winsRef) = transport.copyAttributeValue(appEl, kAXWindowsAttribute as String)
        guard err == .success, let wins = winsRef as? [AXUIElement], let win = wins.first else { return nil }
        var scan = DialogScan(pid: pid, window: win, title: string(win, kAXTitleAttribute as String) ?? "")
        walk(win, depth: 0, into: &scan)
        return scan
    }

    private func walk(_ el: AXUIElement, depth: Int, into scan: inout DialogScan) {
        if depth > 12 { return }
        let role = string(el, kAXRoleAttribute as String) ?? ""
        let subrole = string(el, kAXSubroleAttribute as String) ?? ""
        let title = string(el, kAXTitleAttribute as String) ?? ""
        switch role {
        case "AXStaticText":
            if let v = string(el, kAXValueAttribute as String), !v.isEmpty { scan.messages.append(v) }
        case "AXButton":
            scan.buttons.append((title, el))
            if title.lowercased().hasPrefix("use password") { scan.usePassword = el }
        case "AXTextField":
            if subrole == "AXSecureTextField" {
                if scan.secureField == nil { scan.secureField = el }
            } else if scan.usernameField == nil {
                scan.usernameField = el
                scan.usernameValue = string(el, kAXValueAttribute as String) ?? ""
            }
        default:
            break
        }
        let (e, kidsRef) = transport.copyAttributeValue(el, kAXChildrenAttribute as String)
        guard e == .success, let kids = kidsRef as? [AXUIElement] else { return }
        for k in kids { walk(k, depth: depth + 1, into: &scan) }
    }

    private func payload(_ s: DialogScan) -> [String: Any] {
        [
            "present": true,
            "pid": Int(s.pid),
            "shape": s.shape,
            "title": s.title,
            "message": s.messages.joined(separator: " "),
            "buttons": s.buttons.map { $0.title },
            "username": s.usernameValue,
            "hasSecureField": s.secureField != nil,
        ]
    }

    private func status() -> [String: Any] {
        guard let s = scan() else { return WireFormat.success(["present": false, "shape": "none"]) }
        return WireFormat.success(payload(s))
    }

    private func postReturn(to target: InputTarget) {
        guard let source = CGEventSource(stateID: .combinedSessionState) else { return }
        for down in [true, false] {
            if let ev = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: down) {
                InputDomain.postEvent(ev, on: target)
            }
            usleep(8000)
        }
    }

    private func fill(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let text = action["text"] as? String, !text.isEmpty else {
            completion(WireFormat.error("authdialog fill needs --secret <name> (the daemon resolves the value)")); return
        }
        let submit = action["submit"] as? Bool ?? false
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            guard var s = scan() else {
                completion(WireFormat.error("no administrator prompt is showing (com.apple.SecurityAgent has no window)")); return
            }
            var pressedUsePassword = false
            if s.secureField == nil, let btn = s.usePassword {
                _ = transport.performAction(btn, kAXPressAction as String)
                pressedUsePassword = true
                let deadline = Date().addingTimeInterval(4)
                while Date() < deadline {
                    usleep(150_000)
                    if let again = scan() { s = again; if s.secureField != nil { break } }
                }
            }
            guard let secure = s.secureField else {
                completion(WireFormat.error("the prompt has no password field (shape \(s.shape)); buttons: \(s.buttons.map { $0.title })")); return
            }
            var usernameFixed = false
            if let u = s.usernameField {
                let me = NSUserName()
                let full = NSFullUserName()
                let cur = s.usernameValue
                if cur.isEmpty || (cur != me && cur != full) {
                    if transport.setAttributeValue(u, kAXValueAttribute as String, me as CFString) == .success { usernameFixed = true }
                }
            }
            _ = transport.setAttributeValue(secure, kAXFocusedAttribute as String, kCFBooleanTrue)
            usleep(120_000)
            let frontPid = FrontmostResolver.frontmostApplication()?.processIdentifier
            let target: InputTarget = (frontPid == s.pid) ? .cghidEventTap : .postToPid(s.pid)
            guard InputDomain.postUnicodeKeystrokes(text, to: target) else {
                completion(WireFormat.error("failed to create event source")); return
            }
            usleep(150_000)
            var submitted: String? = nil
            if submit {
                if let again = scan(), let btn = again.buttons.first(where: { Self.submitTitles.contains($0.title) }) {
                    if transport.performAction(btn.element, kAXPressAction as String) == .success { submitted = btn.title }
                }
                if submitted == nil { postReturn(to: target); submitted = "Return" }
            }
            var closed = false
            if submit {
                let deadline = Date().addingTimeInterval(3)
                while Date() < deadline {
                    usleep(200_000)
                    if scan() == nil { closed = true; break }
                }
            }
            Platform.log("authdialog: filled \(text.count) chars (shape \(pressedUsePassword ? "touchid" : "password"), submit \(submit), closed \(closed))")
            completion(WireFormat.success([
                "filled": true,
                "chars": text.count,
                "shape": pressedUsePassword ? "touchid" : "password",
                "pressedUsePassword": pressedUsePassword,
                "usernameFixed": usernameFixed,
                "routing": frontPid == s.pid ? "frontmost" : "pid=\(s.pid)",
                "submitted": submitted as Any? ?? NSNull(),
                "dialogClosed": closed,
            ]))
        }
    }
}
