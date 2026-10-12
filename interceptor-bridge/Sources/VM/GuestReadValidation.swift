import Foundation
import GuestWire
import NativeAX

/// Validate scoped guest read results before the host publishes them. The
/// generated decoders reject unknown fields and wrong native field types.
enum GuestReadValidation {
    static func payload(_ raw: [String: Any], verb: String, action: [String: Any], name: String) throws -> [String: Any] {
        func reject(_ text: String) throws -> Never { throw GuestAgentError.framing("guest \(verb): " + text) }
        guard raw["name"] == nil else { try reject("guest must not choose its host registry name") }
        var payload = raw; payload["name"] = name
        let bytes = try JSONSerialization.data(withJSONObject: payload)
        guard bytes.count <= 131_072 else { try reject("read reply exceeds 128KiB") }
        let decoder = JSONDecoder()
        func bounded(_ text: String, bytes: Int = 4096) -> Bool { !text.contains("\0") && text.utf8.count <= bytes }
        switch verb {
        case "read_ax":
            let snapshot = try decoder.decode(DesktopVmAxSnapshot.self, from: bytes)
            guard snapshot.name == name, bounded(snapshot.app), bounded(snapshot.bundleIdentifier),
                  snapshot.selector == action["app"] as? String, snapshot.pid.rounded(.towardZero) == snapshot.pid, (1...Double(Int32.max)).contains(snapshot.pid),
                  snapshot.maxDepth == ((action["max_depth"] as? NSNumber)?.doubleValue ?? 4),
                  (1...500).contains(snapshot.visited), snapshot.visited.rounded(.towardZero) == snapshot.visited,
                  !snapshot.refsActionable, snapshot.reasons.count <= 16, Set(snapshot.reasons).count == snapshot.reasons.count,
                  snapshot.reasons.allSatisfy({ $0.range(of: "^[a-z_]{1,64}$", options: .regularExpression) != nil }),
                  snapshot.partial == !snapshot.reasons.isEmpty else { try reject("AX target, bounds or partial metadata differ") }
            var count = 0, strings = 0, refs = Set<String>()
            func node(_ value: DesktopVmAxNode, depth: Int) throws {
                count += 1
                guard count <= 500, depth <= min(Int(snapshot.maxDepth), 12),
                      value.ref.range(of: "^ax[1-9][0-9]{0,2}$", options: .regularExpression) != nil, refs.insert(value.ref).inserted,
                      !value.role.isEmpty, (value.children?.count ?? 0) <= 50 else { try reject("AX node identity, count or nesting is invalid") }
                for text in [value.role, value.subrole, value.value, value.title, value.description].compactMap({ $0 }) {
                    guard bounded(text, bytes: 2048), text.unicodeScalars.count <= 512 else { try reject("AX text exceeds its scalar or byte bound") }
                    strings += text.utf8.count
                }
                guard strings <= 32_768 else { try reject("AX aggregate text exceeds 32KiB") }
                let secure = AXSecureClassification.isSecure(role: value.role, subrole: value.subrole)
                guard value.secure == secure else { try reject("AX secure classification differs") }
                if secure {
                    guard value.valueState.rawValue == "redacted", value.value == AXSecureClassification.placeholder else { try reject("secure AX value escaped redaction") }
                } else if value.role == "AXTextField" && value.subrole == nil {
                    guard value.valueState.rawValue == "withheld", value.value == nil else { try reject("unclassified text-field value was read") }
                } else {
                    guard value.valueState.rawValue == (value.value == nil ? "unavailable" : "read") else { try reject("AX value availability differs") }
                }
                if let frame = value.frame {
                    guard [frame.x, frame.y, frame.width, frame.height].allSatisfy({ $0.isFinite && abs($0) <= 1_000_000_000 }), frame.width >= 0, frame.height >= 0 else { try reject("invalid AX frame") }
                }
                for child in value.children ?? [] { try node(child, depth: depth + 1) }
            }
            try node(snapshot.tree, depth: 0)
            guard Double(count) <= snapshot.visited, Double(count) == snapshot.visited || snapshot.partial else { try reject("AX visited count is inconsistent") }
        case "logs":
            let logs = try decoder.decode(DesktopVmLogs.self, from: bytes)
            guard logs.name == name, logs.logs.map(\.path) == ["/tmp/InterceptorD.err.log", "/tmp/InterceptorD.out.log"] else { try reject("log paths differ from the guest-owned files") }
            var size = 0, partial = false
            let limit = (action["limit"] as? NSNumber)?.intValue ?? 200
            for row in logs.logs {
                guard row.lines.count <= limit else { try reject("log line count exceeds the request") }
                for line in row.lines {
                    guard bounded(line, bytes: 2048), line.unicodeScalars.count <= 512 else { try reject("log line is oversized") }; size += line.utf8.count
                }
                if row.state.rawValue == "unavailable" {
                    guard row.lines.isEmpty, !row.truncated, let error = row.error, !error.isEmpty, bounded(error) else { try reject("unavailable log has invented content or omitted its failure") }; partial = true
                } else { guard row.error == nil else { try reject("read log has a conflicting error") } }
                partial = partial || row.truncated
            }
            guard size <= 65_536, logs.partial == partial else { try reject("log aggregate or partial state differs") }
        case "mount":
            let mount = try decoder.decode(DesktopVmMounted.self, from: bytes)
            guard mount.name == name, mount.tag == action["tag"] as? String, mount.path == action["path"] as? String,
                  mount.nativeMountPath.hasPrefix("/"), bounded(mount.nativeMountPath), mount.fileSystem == "virtiofs", mount.mounted else { try reject("mount tag, path or native readback differs") }
        case "trust":
            let trust = try decoder.decode(DesktopVmTrust.self, from: bytes)
            guard trust.name == name, trust.platform == "macos", [trust.accessibility, trust.screenRecording, trust.postEvent, trust.inputMonitoring].allSatisfy({ ["granted", "denied"].contains($0.rawValue) }),
                  trust.notes.count <= 16, trust.notes.allSatisfy({ bounded($0) }), (trust.action_required?.count ?? 0) <= 8,
                  (trust.action_required ?? []).allSatisfy({ bounded($0) }) else { try reject("permission preflight metadata is invalid") }
            let noPrompt = action["noPrompt"] as? Bool == true
            let ax = !noPrompt && ["prompt", "walkthrough", "accessibilityPrompt"].contains(where: { action[$0] as? Bool == true })
            let screen = !noPrompt && ["prompt", "walkthrough", "screenPrompt"].contains(where: { action[$0] as? Bool == true })
            let expected = (ax ? ["Accessibility"] : []) + (screen ? ["Screen Recording"] : [])
            guard (trust.prompted ?? []) == expected, (trust.opened?.count ?? 0) <= 1,
                  (trust.opened ?? []).allSatisfy({ ["Accessibility", "Screen Recording"].contains($0) }),
                  trust.opened == nil || !noPrompt && action["walkthrough"] as? Bool == true else { try reject("permission prompts or opened panes differ from the explicit request") }
            let services = (!noPrompt && action["resetDenied"] as? Bool == true) ? (ax ? ["Accessibility"] : []) + (screen ? ["ScreenCapture"] : []) : []
            guard (trust.reset ?? []).map(\.service) == services else { try reject("TCC reset services differ") }
            for reset in trust.reset ?? [] {
                if let code = reset.exitCode {
                    guard code.isFinite, code.rounded(.towardZero) == code, (-2147483648...2147483647).contains(code), reset.ok == (code == 0),
                          let out = reset.stdout, let err = reset.stderr, bounded(out, bytes: 16384), bounded(err, bytes: 16384),
                          let duration = reset.durationMs, duration.rounded(.towardZero) == duration, (0...58000).contains(duration),
                          reset.truncated != nil, reset.error == nil, reset.outcomeUnknown == nil else { try reject("native TCC reset receipt is inconsistent") }
                } else {
                    guard !reset.ok, let error = reset.error, bounded(error), !error.isEmpty, reset.outcomeUnknown == true,
                          reset.stdout == nil, reset.stderr == nil, reset.durationMs == nil, reset.truncated == nil else { try reject("unknown TCC reset invented a native exit or omitted uncertainty") }
                }
            }
        default: try reject("no scoped guest read contract")
        }
        return payload
    }
}
