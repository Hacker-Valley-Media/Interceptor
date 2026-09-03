// issue #244: the secret vault's native pieces.
//
//   register  — the registration box: an AppKit panel with two secure text
//               fields (value + confirm), a gate picker, and a targets field.
//               A focused NSSecureTextField turns on Secure Event Input, so no
//               event tap (ours included) sees the keystrokes. The value is
//               returned to the daemon over the local socket and never logged.
//   status / set / get / delete / list
//             — the data protection keychain. Items are owned by this
//               signed bundle (application-identifier + keychain-access-groups
//               from the embedded provisioning profile), so no ACL prompt can
//               ever appear and a pkg upgrade keeps access. When the bridge is
//               built without the profile `status` reports dataProtection:false
//               and the daemon keeps items in the login keychain instead.
//
// References: Security/kSecUseDataProtectionKeychain.md, TN3137, Apple's
// "Restricting keychain item accessibility".

import Foundation
import AppKit
import Security

final class SecretPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// One open registration box. Owns the controls and the daemon's completion.
/// Main-actor only: it is AppKit through and through.
@MainActor
final class SecretRegistrationController: NSObject, NSWindowDelegate {
    private let name: String
    private let panel: SecretPanel
    private let valueField = NSSecureTextField()
    private let confirmField = NSSecureTextField()
    private let gatePopup = NSPopUpButton()
    private let targetsField = NSTextField()
    private let statusLabel = NSTextField(labelWithString: "")
    private let previousApp: NSRunningApplication?
    private var completion: (@Sendable ([String: Any]) -> Void)?
    private let onFinish: @Sendable () -> Void

    static let gateValues = ["none", "touchid", "biometry"]
    static let gateTitles = ["Unattended (no prompt)", "Touch ID or Mac password", "Touch ID only"]

    init(name: String, gate: String, targets: [String], session: String,
         completion: @escaping @Sendable ([String: Any]) -> Void, onFinish: @escaping @Sendable () -> Void) {
        self.name = name
        self.completion = completion
        self.onFinish = onFinish
        self.previousApp = NSWorkspace.shared.frontmostApplication
        self.panel = SecretPanel(contentRect: NSRect(x: 0, y: 0, width: 480, height: 330),
                                 styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()

        panel.title = "Store a secret for Interceptor"
        panel.level = .floating
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.delegate = self

        let heading = NSTextField(labelWithString: "Secret \"\(name)\"" + (session.isEmpty ? "" : "   ·   requested by session \(session)"))
        heading.font = NSFont.boldSystemFont(ofSize: 13)
        let note = NSTextField(wrappingLabelWithString: "Stored in the macOS keychain. Interceptor delivers it by name to the targets below and never shows the value again.")
        note.font = NSFont.systemFont(ofSize: 11)
        note.textColor = .secondaryLabelColor

        valueField.placeholderString = "Value"
        confirmField.placeholderString = "Confirm value"
        for f in [valueField, confirmField, targetsField] { f.translatesAutoresizingMaskIntoConstraints = false }

        gatePopup.addItems(withTitles: Self.gateTitles)
        gatePopup.selectItem(at: max(0, Self.gateValues.firstIndex(of: gate) ?? 0))

        targetsField.stringValue = targets.joined(separator: ", ")
        targetsField.placeholderString = "sudo, macos:<bundleId>, browser:<host>, ios, any"

        statusLabel.textColor = .systemRed
        statusLabel.font = NSFont.systemFont(ofSize: 11)

        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelPressed))
        cancel.keyEquivalent = "\u{1b}"
        let save = NSButton(title: "Save", target: self, action: #selector(savePressed))
        save.keyEquivalent = "\r"
        let buttons = NSStackView(views: [NSView(), cancel, save])
        buttons.orientation = .horizontal
        buttons.spacing = 8

        func labeled(_ title: String, _ control: NSView) -> NSStackView {
            let l = NSTextField(labelWithString: title)
            l.font = NSFont.systemFont(ofSize: 12)
            l.setContentHuggingPriority(.required, for: .horizontal)
            let row = NSStackView(views: [l, control])
            row.orientation = .horizontal
            row.spacing = 8
            l.widthAnchor.constraint(equalToConstant: 70).isActive = true
            return row
        }

        let stack = NSStackView(views: [
            heading, note,
            labeled("Value", valueField),
            labeled("Confirm", confirmField),
            labeled("Release", gatePopup),
            labeled("Targets", targetsField),
            statusLabel,
            buttons,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 20, bottom: 16, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        for v in [heading, note, statusLabel, buttons] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
        }
        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        for row in stack.arrangedSubviews {
            row.leadingAnchor.constraint(equalTo: stack.leadingAnchor, constant: 20).isActive = true
            row.trailingAnchor.constraint(equalTo: stack.trailingAnchor, constant: -20).isActive = true
        }
        panel.contentView = content
        panel.setContentSize(NSSize(width: 480, height: 330))
        panel.center()
    }

    func present() {
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(valueField)
        // Hygiene: a forgotten box closes itself.
        DispatchQueue.main.asyncAfter(deadline: .now() + 600) { [weak self] in self?.finish(["cancelled": true, "reason": "timeout"]) }
    }

    static func parseTargets(_ raw: String) -> [String]? {
        let parts = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if parts.isEmpty { return ["any"] }
        for p in parts {
            let lower = p.lowercased()
            let ok = lower == "sudo" || lower == "ios" || lower == "any"
                || (lower.hasPrefix("macos:") && p.count > 6)
                || (lower.hasPrefix("browser:") && p.count > 8)
            if !ok { return nil }
        }
        return parts
    }

    @objc private func savePressed() {
        let value = valueField.stringValue
        if value.isEmpty { statusLabel.stringValue = "Enter a value."; return }
        if value != confirmField.stringValue { statusLabel.stringValue = "The two entries differ."; confirmField.stringValue = ""; return }
        guard let targets = Self.parseTargets(targetsField.stringValue) else {
            statusLabel.stringValue = "Targets: sudo, macos:<bundleId>, browser:<host>, ios, any (comma separated)."
            return
        }
        let gate = Self.gateValues[max(0, min(gatePopup.indexOfSelectedItem, Self.gateValues.count - 1))]
        finish(["cancelled": false, "value": value, "gate": gate, "targets": targets])
    }

    @objc private func cancelPressed() { finish(["cancelled": true]) }

    func windowWillClose(_ notification: Notification) { finish(["cancelled": true]) }

    private func finish(_ payload: [String: Any]) {
        guard let done = completion else { return }
        completion = nil
        panel.delegate = nil
        valueField.stringValue = ""
        confirmField.stringValue = ""
        panel.orderOut(nil)
        panel.close()
        previousApp?.activate()
        onFinish()
        done(WireFormat.success(payload))
    }
}

final class SecretsDomain: DomainHandler, @unchecked Sendable {
    static let service = "com.interceptor.secrets"
    private let lock = NSLock()
    private var active: SecretRegistrationController?

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "register": register(action, completion: completion)
        case "status":   completion(WireFormat.success(Self.statusPayload()))
        case "set":      completion(Self.set(action))
        case "get":      completion(Self.get(action))
        case "delete":   completion(Self.delete(action))
        case "list":     completion(Self.list())
        default:         completion(WireFormat.error("secrets.\(sub) — unknown verb (register|status|set|get|delete|list)"))
        }
    }

    // MARK: - registration box

    private func register(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let name = action["name"] as? String, !name.isEmpty else {
            completion(WireFormat.error("secrets.register: name required")); return
        }
        let gate = action["gate"] as? String ?? "none"
        let targets = (action["targets"] as? [String]) ?? ["any"]
        let session = action["session"] as? String ?? ""
        DispatchQueue.main.async { [self] in
            MainActor.assumeIsolated {
                lock.lock()
                if active != nil {
                    lock.unlock()
                    completion(WireFormat.error("a registration box is already open"))
                    return
                }
                let controller = SecretRegistrationController(
                    name: name, gate: gate, targets: targets, session: session,
                    completion: completion,
                    onFinish: { [weak self] in
                        guard let self else { return }
                        self.lock.lock(); self.active = nil; self.lock.unlock()
                    })
                active = controller
                lock.unlock()
                Platform.log("secrets: registration box opened for \"\(name)\"")
                controller.present()
            }
        }
    }

    // MARK: - data protection keychain

    static func baseQuery(_ name: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let name { q[kSecAttrAccount as String] = name }
        return q
    }

    /// True when this process may use the data protection keychain. Without the
    /// profile-authorized keychain-access-groups entitlement SecItem returns
    /// errSecMissingEntitlement (-34018).
    static func dataProtectionAvailable() -> Bool {
        var q = baseQuery("interceptor.probe")
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &out)
        return st == errSecSuccess || st == errSecItemNotFound
    }

    static func entitledAccessGroups() -> [String] {
        guard let task = SecTaskCreateFromSelf(nil) else { return [] }
        var err: Unmanaged<CFError>?
        let v = SecTaskCopyValueForEntitlement(task, "keychain-access-groups" as CFString, &err)
        return (v as? [String]) ?? []
    }

    static func statusPayload() -> [String: Any] {
        let available = dataProtectionAvailable()
        return [
            "dataProtection": available,
            "service": service,
            "accessGroups": entitledAccessGroups(),
            "count": available ? ((try? listNames())?.count ?? 0) : 0,
        ]
    }

    static func listNames() throws -> [String] {
        var q = baseQuery(nil)
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &out)
        if st == errSecItemNotFound { return [] }
        guard st == errSecSuccess, let items = out as? [[String: Any]] else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(st), userInfo: [NSLocalizedDescriptionKey: osStatusMessage(st)])
        }
        return items.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
    }

    static func osStatusMessage(_ st: OSStatus) -> String {
        (SecCopyErrorMessageString(st, nil) as String?) ?? "OSStatus \(st)"
    }

    static func set(_ action: [String: Any]) -> [String: Any] {
        guard let name = action["name"] as? String, !name.isEmpty else { return WireFormat.error("secrets.set: name required") }
        guard let value = action["value"] as? String, !value.isEmpty else { return WireFormat.error("secrets.set: value required") }
        guard dataProtectionAvailable() else { return WireFormat.error("data protection keychain unavailable (bridge built without keychain-access-groups)") }
        var q = baseQuery(name)
        SecItemDelete(q as CFDictionary)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        q[kSecAttrLabel as String] = "Interceptor secret: \(name)"
        let st = SecItemAdd(q as CFDictionary, nil)
        guard st == errSecSuccess else { return WireFormat.error("SecItemAdd failed: \(osStatusMessage(st)) (\(st))") }
        return WireFormat.success(["stored": true, "name": name])
    }

    static func get(_ action: [String: Any]) -> [String: Any] {
        guard let name = action["name"] as? String, !name.isEmpty else { return WireFormat.error("secrets.get: name required") }
        var q = baseQuery(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &out)
        if st == errSecItemNotFound { return WireFormat.error("secret '\(name)' not found") }
        guard st == errSecSuccess, let data = out as? Data, let value = String(data: data, encoding: .utf8) else {
            return WireFormat.error("SecItemCopyMatching failed: \(osStatusMessage(st)) (\(st))")
        }
        return WireFormat.success(["name": name, "value": value])
    }

    static func delete(_ action: [String: Any]) -> [String: Any] {
        guard let name = action["name"] as? String, !name.isEmpty else { return WireFormat.error("secrets.delete: name required") }
        let st = SecItemDelete(baseQuery(name) as CFDictionary)
        if st == errSecSuccess { return WireFormat.success(["deleted": true, "name": name]) }
        if st == errSecItemNotFound { return WireFormat.error("secret '\(name)' not found") }
        return WireFormat.error("SecItemDelete failed: \(osStatusMessage(st)) (\(st))")
    }

    static func list() -> [String: Any] {
        do { return WireFormat.success(["names": try listNames()]) }
        catch { return WireFormat.error("list failed: \(error.localizedDescription)") }
    }
}
