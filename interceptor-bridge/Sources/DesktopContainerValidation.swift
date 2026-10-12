import Foundation

enum DesktopContainerValidation {
    static func validate(_ action: [String: Any]) -> [String: Any]? {
        guard action["type"] as? String == "desktop_container_run" else { return nil }
        func bad(_ text: String) -> [String: Any] { failure("invalid_request", text) }
        if let error = DesktopContainerShape.validationError(action) { return bad(error) }
        func text(_ s: String, _ cap: Int) -> Bool { s.utf8.count <= cap && !s.contains("\0") }
        let image = action["image"] as! String
        guard !image.isEmpty, text(image, 1024), image.range(of: #"^[A-Za-z0-9][^\s]*$"#, options: .regularExpression) == image.startIndex..<image.endIndex else { return bad("invalid container image") }
        let command = action["command"] as! [String]
        guard !command.isEmpty, command.count <= 128, !command[0].isEmpty, command.allSatisfy({ text($0, 32768) }) else { return bad("container requires 1..128 bounded exact arguments") }
        if let env = action["env"] as? [String: String], env.count > 64 || !env.allSatisfy({ key, value in
            key.range(of: #"^[A-Za-z_][A-Za-z0-9_]{0,127}$"#, options: .regularExpression) == key.startIndex..<key.endIndex && text(value, 32768)
        }) { return bad("invalid container environment") }
        if let mounts = action["mounts"] as? [[String: Any]], mounts.count > 16 || !mounts.allSatisfy({ mount in
            let host = mount["hostPath"] as! String, guest = mount["mountPath"] as! String
            return host.hasPrefix("/") && text(host, 32768) && !host.contains(",") && guest.hasPrefix("/") && text(guest, 32768) && !guest.contains(",") && !guest.components(separatedBy: "/").contains("..")
        }) { return bad("invalid container mount paths") }
        for (key, cap) in [("timeoutMs", DESKTOP_CONTAINER_MAX_TIMEOUT_MS), ("maxOutputBytes", DESKTOP_CONTAINER_MAX_OUTPUT_BYTES)] {
            if let n = (action[key] as? NSNumber)?.doubleValue, !n.isFinite || n.rounded() != n || n < 1 || n > Double(cap) { return bad("container bounds require positive bounded integers") }
        }
        return nil
    }
    static func failure(_ code: String, _ message: String) -> [String: Any] {
        ["success": false, "code": code, "error": String(message.prefix(512))]
    }
}
