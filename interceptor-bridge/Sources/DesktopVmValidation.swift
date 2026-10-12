import Foundation

enum DesktopVmValidation {
    static func validationError(_ action: [String: Any], sub: String) -> String? {
        var a = action
        a["type"] = "desktop_vm"
        a["sub"] = sub
        a.removeValue(forKey: "groupColor")
        a.removeValue(forKey: "groupSoft")
        let fields: [String: [String]] = [
            "create": ["kind", "cpu", "memorySize", "diskSize", "image", "network", "rosetta", "shares"],
            "adopt": ["sourcePath", "kind", "provider", "mode", "installAgent", "waitForAgent"],
            "clone": ["src", "dst"], "install": ["ipsw", "fromLatest"], "pull": ["image"],
            "list": [], "get": [], "inspect": [],
            "start": ["headless", "waitForAgent", "waitForVsock", "detach"], "stop": ["force", "timeout"],
            "pause": [], "resume": [], "reset": [], "delete": ["force", "keepDisk"],
            "exec": ["command", "env", "workdir", "tty", "timeout"],
            "snapshot": ["tag", "snapshotOp", "diskOnly", "pausedStateOnly"], "restore": ["tag", "diskOnly", "pausedStateOnly", "headless"],
            "cp": ["src", "dst", "timeout"], "share": ["hostPath", "tag", "readOnly"], "mount": ["tag", "path", "timeout"],
            "port_forward": ["hostAddress", "hostPort", "guestPort"], "screenshot": ["out", "timeout"],
            "type": ["text", "timeout"], "click": ["x", "y", "button", "timeout"], "keys": ["keys", "timeout"],
            "read_ax": ["max_depth", "app", "timeout"], "console": ["write", "maxBytes", "timeout"], "logs": ["limit", "timeout"],
            "trust": ["noPrompt", "prompt", "walkthrough", "accessibilityPrompt", "screenPrompt", "resetDenied", "timeout"],
            "tcc_profile_generate": ["services", "out", "bundleId", "appPath", "identifierType", "codeRequirement", "fullDisk", "includeUserOnly"]
        ]
        guard let allowed = fields[sub] else { return "unknown verb '\(sub)'" }
        if let error = DesktopVmShape.validationError(a) { return error }
        guard a.keys.allSatisfy({ (["type", "sub", "name", "stateDir"] + allowed).contains($0) }) else { return "field does not belong to VM selector" }
        func named(_ value: Any?) -> Bool {
            guard let text = value as? String else { return false }
            return text.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", options: .regularExpression) == text.startIndex..<text.endIndex
        }
        if ["list", "pull", "clone"].contains(sub) {
            if a["name"] != nil { return "VM selector does not take a name" }
        } else if sub != "tcc_profile_generate" || a["name"] != nil {
            if !named(a["name"]) { return "VM requires an exact bounded safe name" }
        }
        for (key, value) in a {
            if let text = value as? String {
                let emptyAllowed = ["text", "write"].contains(key)
                if text.contains("\0") || text.utf8.count > (emptyAllowed ? 32768 : 4096) || (!emptyAllowed && text.isEmpty) { return "invalid bounded VM \(key)" }
            }
        }
        let required = ["create": ["kind"], "adopt": ["kind", "sourcePath"], "clone": ["src", "dst"], "pull": ["image"], "exec": ["command"], "restore": ["tag"], "cp": ["src", "dst"], "share": ["hostPath", "tag"], "mount": ["tag", "path"], "port_forward": ["guestPort"], "type": ["text"], "click": ["x", "y"], "keys": ["keys"]]
        if required[sub]?.contains(where: { a[$0] == nil }) == true { return "VM selector requires exact fields" }
        let bounds: [(String, Double, Double)] = [("cpu", 1, 32), ("memorySize", 268435456, 34359738368), ("diskSize", 1048576, 68719476736), ("timeout", 1, 50), ("maxBytes", 1, 65536), ("limit", 1, 1000), ("max_depth", 1, 64), ("hostPort", 0, 65535), ("guestPort", 1, 65535)]
        for (key, low, high) in bounds {
            if let number = a[key] as? NSNumber {
                let value = number.doubleValue
                if !value.isFinite || value < low || value > high || value.rounded(.towardZero) != value { return "invalid bounded VM \(key)" }
            }
        }
        if let memory = a["memorySize"] as? NSNumber, memory.uint64Value % 1048576 != 0 { return "VM memory requires whole MiB in bytes" }
        for key in ["x", "y"] {
            if let number = a[key] as? NSNumber, !number.doubleValue.isFinite || number.doubleValue < 0 || number.doubleValue > 16383 { return "VM coordinates must be bounded guest pixels" }
        }
        for key in ["stateDir", "sourcePath", "hostPath", "out", "ipsw", "path"] {
            if let path = a[key] as? String, !path.hasPrefix("/") && !path.hasPrefix("~/") { return "VM requires absolute or home-relative \(key)" }
        }
        let enums = ["kind": ["linux", "macos"], "network": ["none", "nat"], "provider": ["auto", "appleVZ", "containerization", "lume", "tart", "utm", "qemu", "externalAgent"], "mode": ["clone", "move", "reference"], "snapshotOp": ["create", "list", "delete", "restore"], "button": ["left", "right", "middle"], "identifierType": ["bundleID", "path"]]
        for (key, values) in enums { if let value = a[key] as? String, !values.contains(value) { return "invalid VM \(key)" } }
        if sub == "clone", !named(a["src"]) || !named(a["dst"]) || a["src"] as? String == a["dst"] as? String { return "VM clone requires different safe names" }
        if a["tag"] != nil, !named(a["tag"]) { return "VM tag requires a safe bounded name" }
        if sub == "snapshot", a["snapshotOp"] as? String != "list", !named(a["tag"]) { return "VM snapshot requires an exact tag" }
        if a["diskOnly"] as? Bool == true && a["pausedStateOnly"] as? Bool == true { return "VM snapshot modes are mutually exclusive" }
        if sub == "install", a["ipsw"] != nil && a["fromLatest"] as? Bool == true { return "VM install requires one image source" }
        if let argv = a["command"] as? [String], argv.isEmpty || argv.count > 128 || argv[0].isEmpty || argv.contains(where: { $0.contains("\0") || $0.utf8.count > 32768 }) { return "invalid bounded VM argv" }
        if let env = a["env"] as? [String: String], env.count > 64 || env.contains(where: { key, value in key.range(of: "^[A-Za-z_][A-Za-z0-9_]{0,127}$", options: .regularExpression) != key.startIndex..<key.endIndex || value.contains("\0") || value.utf8.count > 32768 }) { return "invalid bounded VM environment" }
        if let rows = a["shares"] as? [[String: Any]] {
            if rows.count > 16 || Set(rows.compactMap { $0["tag"] as? String }).count != rows.count || rows.contains(where: { row in
                guard named(row["tag"]), let path = row["hostPath"] as? String else { return true }
                return !path.hasPrefix("/") || path.contains("\0") || path.utf8.count > 4096
            }) { return "invalid bounded VM shares" }
        }
        if let services = a["services"] as? [String], services.count > 32 || Set(services).count != services.count || services.contains(where: { $0.isEmpty || $0.utf8.count > 128 || $0.contains("\0") }) { return "invalid VM TCC service list" }
        guard let data = try? JSONSerialization.data(withJSONObject: a), data.count <= 131072 else { return "VM request exceeds 128KiB" }
        return nil
    }
}
