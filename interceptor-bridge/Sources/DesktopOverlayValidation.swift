import Foundation
import CoreFoundation
import Darwin

enum DesktopOverlayValidation {
    static let maxBytes = 262144
    static let maxEntities = 128
    static let maxOps = 4096
    static let maxNodes = 2048
    static let particlePresets = ["roses", "hearts", "petals", "stars", "snow", "confetti", "titans", "fire", "beams", "custom"]

    static func number(_ value: Any?, _ low: Double, _ high: Double, integer: Bool = false) -> Bool {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return false }
        let d = n.doubleValue
        return d.isFinite && d >= low && d <= high && (!integer || d.rounded(.towardZero) == d)
    }

    static func text(_ value: Any?, bytes: Int = 4096, empty: Bool = false) -> Bool {
        guard let s = value as? String else { return false }
        return (empty || !s.isEmpty) && !s.contains("\0") && s.utf8.count <= bytes
    }

    static func identifier(_ value: Any?) -> Bool {
        guard let s = value as? String else { return false }
        return s.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", options: .regularExpression) == s.startIndex..<s.endIndex
    }

    static func emojis(_ value: Any?) -> [String]? {
        let rows: [String]
        if let a = value as? [String] { rows = a }
        else if let s = value as? String { rows = s.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) } }
        else { return nil }
        guard !rows.isEmpty, rows.count <= 32, rows.allSatisfy({ text($0, bytes: 128) && $0.count <= 8 }) else { return nil }
        return rows
    }

    static func jsonError(_ value: Any, maxBytes limit: Int = maxBytes) -> String? {
        var nodes = 0
        func visit(_ value: Any, depth: Int) -> Bool {
            nodes += 1
            guard nodes <= 32768, depth <= 16 else { return false }
            if value is NSNull { return true }
            if let s = value as? String { return text(s, bytes: limit, empty: true) }
            if let n = value as? NSNumber { return n.doubleValue.isFinite }
            if let a = value as? [Any] { return a.count <= maxOps && a.allSatisfy { visit($0, depth: depth + 1) } }
            if let d = value as? [String: Any] { return d.count <= 128 && d.allSatisfy { text($0.key, bytes: 128) && visit($0.value, depth: depth + 1) } }
            return false
        }
        guard visit(value, depth: 0), let data = try? JSONSerialization.data(withJSONObject: [value]), data.count <= limit else { return "overlay payload is not finite bounded JSON" }
        return nil
    }

    static func validationError(_ a: [String: Any], sub: String) -> String? {
        if let type = a["type"] as? String, !["macos_overlay_" + sub, "desktop_overlay_" + sub, "macos_overlay", "desktop_overlay"].contains(type) { return "overlay action type and selector disagree" }
        if a["sub"] != nil && a["sub"] as? String != sub { return "overlay selector requires an exact string" }
        let fields: [String: [String]] = [
            "start": ["level", "interactive", "single_space", "no_fullscreen_aux", "timeout_seconds", "scene", "scene_script", "scene_script_file", "particles", "emojis", "density", "direction", "lifetime", "velocity", "size_scale", "html_b64", "url", "source", "display_id", "visible", "rect", "anchor", "width", "height"],
            "stop": [], "list": [], "status": [], "verbs": [], "eval": ["js", "javascript", "timeout_seconds"], "ctl": ["verb", "args"]
        ]
        guard let allowed = fields[sub], a.keys.allSatisfy({ (["type", "sub", "id", "groupColor", "groupSoft"] + allowed).contains($0) }) else { return "unknown overlay selector or field" }
        if let error = jsonError(a) { return error }
        if a["id"] != nil && !identifier(a["id"]) { return "overlay requires a bounded safe ID" }
        if sub == "list", a["id"] != nil { return "overlay list does not take an ID" }
        for key in ["interactive", "single_space", "no_fullscreen_aux", "visible"] {
            if let v = a[key], !(v is NSNumber && CFGetTypeID(v as! NSNumber) == CFBooleanGetTypeID()) { return "overlay \(key) requires a Boolean" }
        }
        if let v = a["timeout_seconds"], !number(v, 0.001, sub == "eval" ? 30 : 86400) { return "invalid overlay timeout" }
        if sub == "eval" {
            guard (a["js"] == nil) != (a["javascript"] == nil), text(a["js"] ?? a["javascript"], bytes: 32768) else { return "overlay eval requires one bounded JavaScript source" }
        }
        if sub == "ctl" {
            guard text(a["verb"], bytes: 64) else { return "overlay ctl requires a verb" }
            if let v = a["args"], !(v is [String: Any]) && !(v is String) { return "overlay control args must be an object or JSON object string" }
        }
        guard sub == "start" else { return nil }
        let sources = ["scene", "scene_script", "scene_script_file", "particles", "html_b64", "url"].filter { a[$0] != nil }
        guard sources.count == 1 else { return "overlay start requires exactly one content source" }
        for key in sources + ["source"] { if let v = a[key], !text(v, bytes: ["html_b64", "scene_script"].contains(key) ? maxBytes : 4096) { return "invalid overlay \(key)" } }
        if let v = a["level"] as? String, !["statusBar", "mainMenu", "floating", "screenSaver"].contains(v) { return "unknown overlay level" }
        if a["level"] != nil && !(a["level"] is String) { return "overlay level requires a string" }
        if let v = a["scene"], v as? String != "titans" { return "unknown overlay scene preset" }
        if let v = a["particles"] as? String, !particlePresets.contains(v) { return "unknown particle preset" }
        let particleKeys = ["emojis", "density", "direction", "lifetime", "velocity", "size_scale"]
        if a["particles"] == nil && particleKeys.contains(where: { a[$0] != nil }) { return "particle parameters require particles mode" }
        if a["emojis"] != nil && emojis(a["emojis"]) == nil { return "invalid bounded emoji list" }
        if let v = a["direction"], !["up", "down", "left", "right"].contains(v as? String ?? "") { return "unknown particle direction" }
        for (key, low, high) in [("density", 0.0, 128.0), ("lifetime", 0.05, 60.0), ("velocity", 0.0, 4096.0), ("size_scale", 0.05, 8.0), ("width", 1.0, 16384.0), ("height", 1.0, 16384.0)] {
            if let v = a[key], !number(v, low, high) { return "invalid bounded overlay \(key)" }
        }
        if let v = a["display_id"], !number(v, 1, Double(UInt32.max), integer: true) { return "overlay display ID requires a nonzero UInt32" }
        if let v = a["anchor"], !["tl", "tr", "bl", "br", "top", "bottom", "right", "left", "center"].contains(v as? String ?? "") { return "unknown overlay anchor" }
        if a["anchor"] == nil && a["rect"] == nil && (a["width"] != nil || a["height"] != nil) { return "overlay width and height require an anchor" }
        if a["rect"] != nil && (a["anchor"] != nil || a["width"] != nil || a["height"] != nil) { return "overlay rectangle and anchor sizing are exclusive" }
        if let v = a["rect"] {
            guard let r = v as? [String: Any], r.keys.allSatisfy({ ["x", "y", "width", "height"].contains($0) }), number(r["width"], 1, 16384), number(r["height"], 1, 16384) else { return "invalid overlay rectangle" }
            for key in ["x", "y"] { if let v = r[key], !number(v, -131072, 131072) { return "invalid overlay rectangle position" } }
        }
        if let p = a["scene_script_file"] as? String, !p.hasPrefix("/") { return "scene script requires an absolute regular-file path" }
        if let s = a["html_b64"] as? String {
            guard let bytes = Data(base64Encoded: s), bytes.count <= 131072, bytes.base64EncodedString() == s, String(data: bytes, encoding: .utf8) != nil else { return "overlay HTML requires canonical bounded UTF-8 base64" }
        }
        if let s = a["url"] as? String {
            guard let u = URLComponents(string: s), ["http", "https"].contains(u.scheme ?? ""), u.host?.isEmpty == false, u.user == nil, u.password == nil else { return "overlay URL requires HTTP(S) without inline credentials" }
        }
        return nil
    }

    static func readScript(_ path: String) throws -> [String: Any] {
        let fd = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw invalid("cannot open scene script regular file") }
        defer { Darwin.close(fd) }
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG, metadata.st_size > 0, metadata.st_size <= maxBytes else { throw invalid("scene script must be a regular file of at most 256KiB") }
        var bytes = Data(), block = [UInt8](repeating: 0, count: 16384)
        while true {
            let count = Darwin.read(fd, &block, block.count)
            if count < 0 { if errno == EINTR { continue }; throw invalid("scene script read failed") }
            if count == 0 { break }
            guard bytes.count + count <= maxBytes else { throw invalid("scene script grew past 256KiB") }
            bytes.append(contentsOf: block.prefix(count))
        }
        guard bytes.count == Int(metadata.st_size), let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw invalid("scene script must contain a complete JSON object") }
        return object
    }

    static func controlArgs(_ raw: [String: Any], mode: String, verb: String) throws -> [String: Any] {
        if let error = jsonError(raw, maxBytes: 131072) { throw invalid(error) }
        var args = raw
        let fields: [String: [String]]
        switch mode {
        case "particles":
            fields = ["set-density": ["value"], "set-direction": ["value"], "set-emojis": ["value"], "set-lifetime": ["value"], "set-velocity": ["value"], "set-scale": ["value"], "burst": ["count"], "pause": [], "resume": []]
        case "scene":
            fields = ["say": ["text"], "round": ["n", "text"], "punch": ["who", "emoji"], "breathe-fire": ["who", "emoji"], "throw": ["who", "emoji"], "taunt": ["who"], "roar": ["who", "text"], "bow": ["who"], "jump": ["who", "height"], "knockout": ["who"], "tint": ["who", "color", "amount"], "reset": [], "pause": [], "resume": []]
        case "scene-script":
            fields = ["append-ops": ["ops", "relative"], "append-script": ["json"], "say": ["text"], "reset": [], "pause": [], "resume": [], "clear-entities": [], "spawn": ["entity"], "despawn": ["id"], "face-track-start": ["fps"], "face-track-stop": []]
        default: throw invalid("overlay mode has no native controller")
        }
        guard let allowed = fields[verb], args.keys.allSatisfy({ allowed.contains($0) }) else { throw invalid("unknown overlay control verb or field") }
        if mode == "particles" {
            if verb.hasPrefix("set-") {
                guard let v = args["value"] else { throw invalid("particle control requires value") }
                let bounds = ["set-density": (0.0, 128.0), "set-lifetime": (0.05, 60.0), "set-velocity": (0.0, 4096.0), "set-scale": (0.05, 8.0)]
                if let (lo, hi) = bounds[verb], !number(v, lo, hi) { throw invalid("invalid bounded particle value") }
                if verb == "set-direction", !["up", "down", "left", "right"].contains(v as? String ?? "") { throw invalid("invalid particle direction") }
                if verb == "set-emojis", emojis(v) == nil { throw invalid("invalid particle emoji list") }
            }
            if let v = args["count"], !number(v, 1, 64) { throw invalid("invalid particle burst multiplier") }
        }
        if mode == "scene" {
            if let v = args["who"], !["kong", "k", "godzilla", "g", "gz"].contains((v as? String ?? "").lowercased()) { throw invalid("unknown exact fighter") }
            if let v = args["emoji"], emojis([v]) == nil { throw invalid("invalid fighter emoji") }
            for (key, lo, hi) in [("n", 1.0, 100000.0), ("height", 0.0, 4096.0), ("amount", 0.0, 1.0)] {
                if let v = args[key], !number(v, lo, hi, integer: key == "n") { throw invalid("invalid bounded fighter control") }
            }
            if let v = args["color"], !color(v) { throw invalid("invalid fighter color") }
        }
        if let v = args["text"], !text(v, bytes: 4096, empty: true) { throw invalid("invalid overlay control text") }
        if verb == "say", args["text"] == nil { throw invalid("say requires text") }
        if mode == "scene-script" {
            for key in ["ops", "json", "entity"] {
                if let s = args[key] as? String {
                    guard s.utf8.count <= 131072 else { throw invalid("control JSON string exceeds 128KiB") }
                    args[key] = try JSONSerialization.jsonObject(with: Data(s.utf8))
                }
            }
            if verb == "append-ops" {
                guard let ops = args["ops"] as? [[String: Any]] else { throw invalid("append-ops requires an operation array") }
                if let error = opsError(ops) { throw invalid(error) }
            }
            if verb == "append-script" {
                guard let json = args["json"] as? [String: Any] else { throw invalid("append-script requires a script object") }
                if let error = scriptError(json) { throw invalid(error) }
            }
            if verb == "spawn" {
                guard let entity = args["entity"] as? [String: Any] else { throw invalid("spawn requires an entity object") }
                if let error = entityError(entity) { throw invalid(error) }
            }
            if verb == "despawn", !identifier(args["id"]) { throw invalid("despawn requires an exact safe entity ID") }
            if let v = args["relative"], !(v is NSNumber && CFGetTypeID(v as! NSNumber) == CFBooleanGetTypeID()) { throw invalid("relative requires a Boolean") }
            if let v = args["fps"], !number(v, 1, 30) { throw invalid("tracking fps requires 1..30") }
        }
        return args
    }

    static func scriptError(_ json: [String: Any]) -> String? {
        if let error = jsonError(json) { return error }
        guard json.keys.allSatisfy({ ["banner", "entities", "timeline", "background"].contains($0) }) else { return "unknown scene script field" }
        if let bg = json["background"], bg as? String != "transparent" && !color(bg) { return "invalid scene background" }
        if let b = json["banner"] {
            guard let d = b as? [String: Any], d.keys.allSatisfy({ ["text", "y", "fontSize", "color"].contains($0) }), text(d["text"], bytes: 4096, empty: true) else { return "invalid scene banner" }
            if let y = d["y"], !number(y, 0, 1) { return "invalid banner position" }
            if let v = d["fontSize"], !number(v, 1, 256) { return "invalid banner size" }
            if let v = d["color"], !color(v) { return "invalid banner color" }
        }
        if let entities = json["entities"] {
            guard let rows = entities as? [[String: Any]], rows.count <= maxEntities, Set(rows.compactMap { $0["id"] as? String }).count == rows.count else { return "invalid bounded unique scene entities" }
            for row in rows { if let error = entityError(row) { return error } }
        }
        if let timeline = json["timeline"] {
            guard let rows = timeline as? [[String: Any]] else { return "timeline requires an array of operation objects" }
            return opsError(rows)
        }
        return nil
    }

    static func color(_ value: Any?) -> Bool {
        guard let s = value as? String else { return false }
        return ["red", "blue", "green", "yellow", "orange", "purple", "white", "black"].contains(s.lowercased()) || (s.count == 7 && s.first == "#" && UInt32(s.dropFirst(), radix: 16) != nil)
    }

    static func entityError(_ row: [String: Any]) -> String? {
        guard row.keys.allSatisfy({ ["id", "emoji", "x", "y", "size", "facing"].contains($0) }), identifier(row["id"]) else { return "scene entity requires a safe exact ID and known fields" }
        if let v = row["emoji"], emojis([v]) == nil { return "invalid scene emoji" }
        for key in ["x", "y"] { if let v = row[key], !number(v, 0, 1) { return "invalid normalized entity position" } }
        if let v = row["size"], !number(v, 1, 512) { return "invalid entity size" }
        if let v = row["facing"], !["left", "right"].contains(v as? String ?? "") { return "invalid entity facing" }
        return nil
    }

    static func opsError(_ rows: [[String: Any]]) -> String? {
        guard rows.count <= maxOps else { return "scene timeline exceeds 4096 operations" }
        if let error = jsonError(rows) { return error }
        let common = ["at", "op"]
        let fields: [String: [String]] = [
            "idle-bob": ["target", "amplitude", "duration"], "move-to": ["target", "x", "y", "duration", "easing"], "move-by": ["target", "dx", "dy", "duration", "easing"],
            "rotate-to": ["target", "angle", "duration"], "rotate-by": ["target", "angle", "duration"], "scale-to": ["target", "scale", "duration"], "fade-to": ["target", "alpha", "duration"],
            "tint": ["target", "color", "amount"], "set-facing": ["target", "dir"], "throw": ["from", "to", "fromX", "fromY", "toX", "toY", "emoji", "hitColor"],
            "impact": ["x", "y", "text"], "burst": ["x", "y", "emojis", "count", "spread", "lifetime"], "say": ["text"], "text": ["text", "x", "y", "fontSize", "color", "duration"],
            "label": ["id", "text", "x", "y", "fontSize", "color", "font"], "rect": ["id", "x", "y", "width", "height", "color", "lineWidth", "cornerRadius"], "clear-shapes": [],
            "shake": ["target", "magnitude", "duration"], "knockout": ["target"], "roar": ["target", "text"], "bow": ["target"], "jump": ["target", "height"], "spawn": ["entity"], "despawn": ["target"], "wait": []
        ]
        var effectCost = 0
        for row in rows {
            guard let op = row["op"] as? String, let allowed = fields[op], row.keys.allSatisfy({ (common + allowed).contains($0) }) else { return "unknown scene operation or field" }
            for (key, value) in row {
                if ["at", "duration", "lifetime"].contains(key), !number(value, key == "at" ? 0 : 0.001, key == "at" ? 86400 : 300) { return "invalid bounded scene time" }
                if ["x", "y", "fromX", "fromY", "toX", "toY", "dx", "dy"].contains(key), !number(value, ["dx", "dy"].contains(key) ? -1 : 0, 1) { return "invalid normalized scene coordinate" }
                let bounds: [String: (Double, Double)] = ["angle": (-100, 100), "scale": (0.01, 8), "alpha": (0, 1), "amount": (0, 1), "amplitude": (0, 512), "count": (1, 128), "spread": (0, 4096), "fontSize": (1, 256), "width": (0.001, 1), "height": (0.001, op == "jump" ? 4096 : 1), "lineWidth": (0.1, 64), "cornerRadius": (0, 512), "magnitude": (0, 512)]
                if let (lo, hi) = bounds[key], !number(value, lo, hi, integer: key == "count") { return "invalid bounded scene \(key)" }
                if ["color", "hitColor"].contains(key), !color(value) { return "invalid scene color" }
                if ["id", "from", "to"].contains(key), !identifier(value) { return "invalid scene entity or shape ID" }
                if ["text", "font"].contains(key), !text(value, bytes: key == "font" ? 128 : 4096, empty: key == "text") { return "invalid scene text" }
                if key == "emoji", emojis([value]) == nil { return "invalid scene emoji" }
                if key == "emojis", emojis(value) == nil { return "invalid scene emoji list" }
                if key == "dir", !["left", "right"].contains(value as? String ?? "") { return "invalid scene direction" }
                if key == "easing", !["linear", "easeIn", "easeOut", "easeInOut"].contains(value as? String ?? "") { return "invalid scene easing" }
            }
            if let target = row["target"] {
                let ids = (target as? [String]) ?? (target as? String).map { [$0] }
                guard let ids, !ids.isEmpty, ids.count <= maxEntities, ids.allSatisfy({ $0 == "all" || identifier($0) }), Set(ids).count == ids.count else { return "invalid scene target" }
                if ["knockout", "roar", "bow", "despawn"].contains(op), !(target is String) || target as? String == "all" { return "scene operation requires one entity" }
            } else if allowed.contains("target") && op != "shake" { return "scene operation requires an exact target" }
            if op == "throw" {
                if row["from"] == nil && (row["fromX"] == nil || row["fromY"] == nil) { return "throw requires a source entity or point" }
                if row["to"] == nil && (row["toX"] == nil || row["toY"] == nil) { return "throw requires a destination entity or point" }
            }
            if op == "spawn" {
                guard let entity = row["entity"] as? [String: Any] else { return "spawn requires an entity object" }
                if let error = entityError(entity) { return error }
            }
            effectCost += op == "burst" ? ((row["count"] as? NSNumber)?.intValue ?? 18) : (["impact", "knockout"].contains(op) ? 48 : 1)
            if effectCost > 65536 { return "scene timeline exceeds the bounded effect budget" }
        }
        return nil
    }

    static func invalid(_ message: String) -> NSError { NSError(domain: "Interceptor.Overlay", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
