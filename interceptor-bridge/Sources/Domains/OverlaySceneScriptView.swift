import Foundation
import AppKit
import SpriteKit
import Vision
import CoreImage
import CoreML
@preconcurrency import ScreenCaptureKit
import CoreMedia

// Generic, JSON-driven SpriteKit scene. Agents author a script describing entities
// (emoji sprites with normalized 0..1 positions) and a timeline of ops that fire
// at monotonically increasing times. The engine interprets and renders live.
//
// This is the dynamic path. Agents never write Swift — they write JSON.
//
// Script shape:
// {
//   "banner": { "text": "...", "y": 0.9, "fontSize": 40, "color": "#ffaa00" },
//   "entities": [ { "id":"a", "emoji":"🥷", "x":0.15, "y":0.3, "size":180, "facing":"right" } ],
//   "timeline": [ { "at": 0.0, "op":"idle-bob", "target":"all" }, ... ]
// }
//
// Coordinates are normalized: (0,0) bottom-left, (1,1) top-right of the view.

final class OverlaySceneScriptView: SKView, OverlayControllable {
    var interactive: Bool = false
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { interactive }

    private let script = ScriptScene()
    var captureDisplayID: CGDirectDisplayID?
    private var retired = false

    var nativeStatus: [String: Any] {
        var status = script.nativeStatus
        status["paused"] = isPaused
        status["retired"] = retired
        return status
    }

    var hasPendingNativeWork: Bool { script.hasPendingNativeWork }

    func shutdown() {
        retired = true
        script.stopFaceTracking()
        isPaused = true
        OverlayNativeCleanup.retire(script)
        presentScene(nil)
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        self.wantsLayer = true
        self.layer?.backgroundColor = NSColor.clear.cgColor
        self.allowsTransparency = true
        self.ignoresSiblingOrder = true
        script.scaleMode = .resizeFill
        script.backgroundColor = .clear
        presentScene(script)
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func layout() {
        super.layout()
        script.size = bounds.size
        script.didResize()
    }

    @MainActor
    func loadScript(_ json: [String: Any]) {
        script.loadScript(json)
    }

    var supportedVerbs: [String] {
        ["append-ops", "append-script", "say", "reset", "pause", "resume",
         "clear-entities", "spawn", "despawn",
         "face-track-start", "face-track-stop"]
    }

    @MainActor
    func perform(verb: String, args: [String: Any]) -> [String: Any] {
        guard !retired else { return ["ok": false, "code": "target_gone", "error": "scene renderer retired"] }
        let suppliedArgs = args
        let args: [String: Any]
        do { args = try DesktopOverlayValidation.controlArgs(suppliedArgs, mode: "scene-script", verb: verb) }
        catch { return ["ok": false, "code": "invalid_request", "error": error.localizedDescription] }
        if let error = script.admissionError(verb: verb, args: args) { return ["ok": false, "code": "resource_limit", "error": error] }
        switch verb {
        case "append-ops":
            guard let opsAny = args["ops"] else { return ["ok": false, "error": "ops array required"] }
            let ops: [[String: Any]]
            if let arr = opsAny as? [[String: Any]] { ops = arr }
            else if let s = opsAny as? String, let data = s.data(using: .utf8),
                    let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] { ops = arr }
            else { return ["ok": false, "error": "ops must be JSON array"] }
            let relative = (args["relative"] as? Bool) ?? true
            let count = script.appendOps(ops, relativeToNow: relative)
            return ["ok": true, "appended": count]

        case "append-script":
            guard let obj = args["json"] as? [String: Any] else {
                return ["ok": false, "error": "script object required"]
            }
            script.mergeScript(obj)
            if let error = script.lastRuntimeError { return ["ok": false, "code": "provider_failed", "error": error] }
            return ["ok": true]

        case "say":
            let text = (args["text"] as? String) ?? "—"
            script.setBanner(text)
            return ["ok": true, "text": text]

        case "reset":
            script.resetTimeline()
            return ["ok": true]

        case "pause":
            self.isPaused = true
            return ["ok": true]

        case "resume":
            self.isPaused = false
            return ["ok": true]

        case "spawn":
            guard let spec = (args["entity"] as? [String: Any])
                ?? (args["entity"] as? String).flatMap({ (s: String) -> [String: Any]? in
                    guard let data = s.data(using: .utf8) else { return nil }
                    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                })
            else { return ["ok": false, "error": "entity object required"] }
            script.spawnEntity(spec)
            if let error = script.lastRuntimeError { return ["ok": false, "code": "provider_failed", "error": error] }
            return ["ok": true]

        case "despawn":
            let id = (args["id"] as? String) ?? ""
            guard script.hasEntity(id) else { return ["ok": false, "code": "target_gone", "error": "scene entity not found"] }
            script.despawnEntity(id)
            return ["ok": true, "id": id]

        case "clear-entities":
            script.clearEntities()
            return ["ok": true]

        case "face-track-start":
            let fps = (args["fps"] as? Double) ?? (args["fps"] as? Int).map { Double($0) } ?? 15.0
            guard let displayID = captureDisplayID else { return ["ok": false, "code": "target_gone", "error": "scene has no owned capture display"] }
            do { try script.startFaceTracking(fps: fps, displayID: displayID) }
            catch { return ["ok": false, "code": "resource_busy", "error": error.localizedDescription] }
            return ["ok": true, "fps": fps]

        case "face-track-stop":
            script.stopFaceTracking()
            return ["ok": true, "nativeCleanupPending": script.hasPendingNativeWork]

        default:
            return ["ok": false, "error": "unknown verb: \(verb)", "verbs": supportedVerbs]
        }
    }
}

// MARK: - ScriptScene

final class ScriptScene: SKScene {

    struct EntityEntry {
        let node: SKSpriteNode
        var baseY: CGFloat     // for idle-bob reset
    }

    struct Op {
        var at: TimeInterval
        var params: [String: Any]
        var completed = false
    }

    private var entities: [String: EntityEntry] = [:]
    private var banner: SKLabelNode?
    private var timeline: [Op] = []
    private var opIndex: Int = 0
    private var startTime: TimeInterval?
    private var configured = false
    private var shapes: [String: SKNode] = [:]   // persistent rects/labels keyed by id
    private var shapeCounter: Int = 0
    private var faceTrackTask: Task<Void, Never>?
    private var faceCaptureTask: Task<FaceTrackResult?, any Error>?
    private var faceTrackGeneration = UUID()
    private var faceTrackOwner: UUID?
    private var faceTrackActive = false
    private var faceTrackDisplay: CGDirectDisplayID?
    private var faceTrackError: String?
    private var lastFrameTime: TimeInterval?
    private(set) var lastRuntimeError: String?
    private let faceTrackContext = CIContext()

    var hasPendingNativeWork: Bool { faceTrackTask != nil || faceCaptureTask != nil }
    var nativeStatus: [String: Any] {
        ["entities": entities.count, "shapes": shapes.count, "nodes": children.count,
         "timelineOperations": timeline.count, "remainingOperations": timeline.filter { !$0.completed }.count,
         "lastError": lastRuntimeError.map { $0 as Any } ?? NSNull(),
         "tracking": ["active": faceTrackActive, "nativeWorkOwned": hasPendingNativeWork, "capturing": faceCaptureTask != nil,
                      "displayID": faceTrackDisplay.map { $0 as Any } ?? NSNull(), "lastError": faceTrackError.map { $0 as Any } ?? NSNull()]]
    }

    func hasEntity(_ id: String) -> Bool { entities[id] != nil }

    func admissionError(verb: String, args: [String: Any]) -> String? {
        let json = args["json"] as? [String: Any]
        let ops = (args["ops"] as? [[String: Any]]) ?? (json?["timeline"] as? [[String: Any]]) ?? []
        if timeline.count + ops.count > DesktopOverlayValidation.maxOps { return "accumulated timeline exceeds 4096 operations" }
        let rows = (json?["entities"] as? [[String: Any]]) ?? (args["entity"] as? [String: Any]).map { [$0] } ?? []
        let newIds = Set(rows.compactMap { $0["id"] as? String }).subtracting(entities.keys)
        if entities.count + newIds.count > DesktopOverlayValidation.maxEntities { return "scene entity limit reached" }
        if children.count + newIds.count > DesktopOverlayValidation.maxNodes { return "scene node limit reached" }
        return nil
    }

    override func didMove(to view: SKView) {
        configured = true
    }

    override func update(_ currentTime: TimeInterval) {
        lastFrameTime = currentTime
        guard lastRuntimeError == nil else { return }
        if startTime == nil { startTime = currentTime }
        guard let t0 = startTime else { return }
        let elapsed = currentTime - t0
        var dispatched = 0
        while opIndex < timeline.count && timeline[opIndex].at <= elapsed && dispatched < 64 {
            if timeline[opIndex].completed { opIndex += 1; continue }
            execute(timeline[opIndex].params)
            timeline[opIndex].completed = true
            opIndex += 1
            dispatched += 1
            if lastRuntimeError != nil { break }
        }
    }

    func didResize() {
        repositionAll()
    }

    private func repositionAll() {
        if let b = banner, let bx = b.userData?["nx"] as? Double, let by = b.userData?["ny"] as? Double {
            b.position = CGPoint(x: size.width * CGFloat(bx), y: size.height * CGFloat(by))
        }
        for (_, entry) in entities {
            if let ud = entry.node.userData,
               let nx = ud["nx"] as? Double, let ny = ud["ny"] as? Double {
                let pos = CGPoint(x: size.width * CGFloat(nx), y: size.height * CGFloat(ny))
                entry.node.position = pos
            }
        }
    }

    // MARK: - Script loading

    @MainActor
    func loadScript(_ json: [String: Any]) {
        if let error = DesktopOverlayValidation.scriptError(json) { lastRuntimeError = error; return }
        stopFaceTracking()
        OverlayNativeCleanup.retire(self)
        isPaused = false
        removeAllChildren()
        entities.removeAll()
        shapes.removeAll()
        timeline.removeAll()
        opIndex = 0
        startTime = nil
        lastFrameTime = nil
        lastRuntimeError = nil
        banner = nil

        // Subtle atmospheric tint (optional)
        if let bg = json["background"] as? String, bg != "transparent", !bg.isEmpty {
            if let c = Self.parseColor(bg) {
                let tint = SKSpriteNode(color: c, size: size)
                tint.position = CGPoint(x: size.width/2, y: size.height/2)
                tint.zPosition = -100
                tint.alpha = 0.35
                addChild(tint)
            }
        }

        // Banner
        if let b = json["banner"] as? [String: Any] {
            setBanner(
                text: (b["text"] as? String) ?? "",
                y: (b["y"] as? Double) ?? 0.92,
                fontSize: (b["fontSize"] as? Double).map { CGFloat($0) } ?? 40,
                color: (b["color"] as? String).flatMap { Self.parseColor($0) } ?? NSColor(calibratedRed: 1, green: 0.85, blue: 0.1, alpha: 1)
            )
        }

        // Entities
        if let list = json["entities"] as? [[String: Any]] {
            for spec in list {
                spawnEntity(spec)
                if lastRuntimeError != nil { return }
            }
        }

        // Timeline
        if let t = json["timeline"] as? [[String: Any]] {
            for raw in t {
                let at = (raw["at"] as? Double) ?? 0
                timeline.append(Op(at: TimeInterval(at), params: raw))
            }
            timeline.sort { $0.at < $1.at }
        }
    }

    @MainActor
    func mergeScript(_ json: [String: Any]) {
        if let error = DesktopOverlayValidation.scriptError(json) ?? admissionError(verb: "append-script", args: ["json": json]) { lastRuntimeError = error; return }
        if let b = json["banner"] as? [String: Any] {
            setBanner(
                text: (b["text"] as? String) ?? "",
                y: (b["y"] as? Double) ?? 0.92,
                fontSize: (b["fontSize"] as? Double).map { CGFloat($0) } ?? 40,
                color: (b["color"] as? String).flatMap { Self.parseColor($0) } ?? NSColor(calibratedRed: 1, green: 0.85, blue: 0.1, alpha: 1)
            )
        }
        if let list = json["entities"] as? [[String: Any]] {
            for spec in list {
                spawnEntity(spec)
                if lastRuntimeError != nil { return }
            }
        }
        if let t = json["timeline"] as? [[String: Any]] {
            appendOps(t, relativeToNow: true)
        }
    }

    @MainActor
    @discardableResult
    func appendOps(_ ops: [[String: Any]], relativeToNow: Bool) -> Int {
        guard DesktopOverlayValidation.opsError(ops) == nil, timeline.count + ops.count <= DesktopOverlayValidation.maxOps else { return 0 }
        let base: TimeInterval
        if relativeToNow, let t0 = startTime, let last = lastFrameTime {
            base = max(0, last - t0)
        } else {
            base = 0
        }
        for raw in ops {
            let rel = (raw["at"] as? Double) ?? 0
            let at  = base + TimeInterval(rel)
            timeline.append(Op(at: at, params: raw))
        }
        timeline.sort { $0.at < $1.at }
        opIndex = timeline.firstIndex { !$0.completed } ?? timeline.count
        return ops.count
    }

    @MainActor
    func resetTimeline() {
        opIndex = 0
        startTime = nil
        lastFrameTime = nil
        lastRuntimeError = nil
        for i in timeline.indices { timeline[i].completed = false }
    }

    // MARK: - Banner

    @MainActor
    func setBanner(_ text: String) {
        if banner == nil {
            setBanner(text: text, y: 0.92, fontSize: 40,
                      color: NSColor(calibratedRed: 1, green: 0.85, blue: 0.1, alpha: 1))
        } else {
            banner?.text = text
        }
    }

    @MainActor
    private func setBanner(text: String, y: Double, fontSize: CGFloat, color: NSColor) {
        if banner == nil {
            let l = SKLabelNode(fontNamed: "Impact")
            l.zPosition = 50
            l.verticalAlignmentMode = .center
            l.horizontalAlignmentMode = .center
            addChild(l)
            banner = l
            let pulse = SKAction.sequence([
                SKAction.scale(to: 1.06, duration: 0.45),
                SKAction.scale(to: 1.00, duration: 0.45)
            ])
            l.run(.repeatForever(pulse))
        }
        guard let b = banner else { return }
        b.text = text
        b.fontSize = fontSize
        b.fontColor = color
        b.userData = NSMutableDictionary()
        b.userData?["nx"] = 0.5
        b.userData?["ny"] = y
        b.position = CGPoint(x: size.width * 0.5, y: size.height * CGFloat(y))
    }

    // MARK: - Entities

    @MainActor
    func spawnEntity(_ spec: [String: Any]) {
        if let error = DesktopOverlayValidation.entityError(spec) { lastRuntimeError = error; return }
        guard let id = spec["id"] as? String, !id.isEmpty else { return }
        guard entities[id] != nil || (entities.count < DesktopOverlayValidation.maxEntities && children.count < DesktopOverlayValidation.maxNodes) else { lastRuntimeError = "scene entity or node limit reached"; return }
        lastRuntimeError = nil
        let emoji = (spec["emoji"] as? String) ?? "❓"
        let size = (spec["size"] as? Double).map { CGFloat($0) } ?? 160
        let nx = (spec["x"] as? Double) ?? 0.5
        let ny = (spec["y"] as? Double) ?? 0.3
        let facing = (spec["facing"] as? String) ?? "right"

        guard let tex = Self.emojiTexture(emoji, pointSize: max(140, size)) else { lastRuntimeError = "native emoji texture creation failed"; return }
        let node = SKSpriteNode(texture: tex)
        node.size = tex.size()
        let scale = size / max(node.size.height, 1)
        node.setScale(scale)
        node.zPosition = 10
        node.position = CGPoint(x: self.size.width * CGFloat(nx),
                                y: self.size.height * CGFloat(ny))
        let ud = NSMutableDictionary()
        ud["nx"] = nx
        ud["ny"] = ny
        ud["facing"] = facing
        ud["baseScale"] = Double(scale)
        node.userData = ud

        if facing == "left" { node.xScale = -abs(node.xScale) }

        // Replace if id already exists
        if let existing = entities[id] { OverlayNativeCleanup.retire(existing.node); existing.node.removeFromParent() }
        entities[id] = EntityEntry(node: node, baseY: node.position.y)
        addChild(node)
    }

    @MainActor
    func despawnEntity(_ id: String) {
        guard let e = entities.removeValue(forKey: id) else { return }
        OverlayNativeCleanup.retire(e.node)
        e.node.removeFromParent()
    }

    @MainActor
    func clearEntities() {
        for (_, e) in entities { OverlayNativeCleanup.retire(e.node); e.node.removeFromParent() }
        entities.removeAll()
    }

    // MARK: - Op execution

    @MainActor
    private func execute(_ p: [String: Any]) {
        let cost = (p["op"] as? String) == "burst" ? ((p["count"] as? NSNumber)?.intValue ?? 18) : 64
        guard children.count + cost <= DesktopOverlayValidation.maxNodes, shapes.count < 256 || ["clear-shapes", "despawn", "wait"].contains(p["op"] as? String ?? "") else { lastRuntimeError = "scene live node or shape budget exceeded"; return }
        if let target = p["target"] {
            let ids = (target as? [String]) ?? (target as? String).map { [$0] } ?? []
            if ids.contains(where: { $0 != "all" && entities[$0] == nil }) { lastRuntimeError = "scene operation target is gone"; return }
        }
        for key in ["from", "to"] { if let id = p[key] as? String, entities[id] == nil { lastRuntimeError = "scene projectile target is gone"; return } }
        let op = (p["op"] as? String) ?? ""
        switch op {
        case "idle-bob":
            let amp = (p["amplitude"] as? Double).map { CGFloat($0) } ?? 8
            let dur = (p["duration"] as? Double) ?? 0.35
            let targets = resolveTargets(p["target"])
            for n in targets {
                let up = SKAction.moveBy(x: 0, y: amp, duration: dur)
                up.timingMode = .easeInEaseOut
                n.run(.repeatForever(.sequence([up, up.reversed()])), withKey: "idle-bob")
            }

        case "move-to":
            let targets = resolveTargets(p["target"])
            let duration = (p["duration"] as? Double) ?? 0.5
            for n in targets {
                var actions: [SKAction] = []
                if let nx = p["x"] as? Double {
                    let m = SKAction.moveTo(x: size.width * CGFloat(nx), duration: duration)
                    m.timingMode = easing(p["easing"] as? String)
                    actions.append(m)
                    n.userData?["nx"] = nx
                }
                if let ny = p["y"] as? Double {
                    let m = SKAction.moveTo(y: size.height * CGFloat(ny), duration: duration)
                    m.timingMode = easing(p["easing"] as? String)
                    actions.append(m)
                    n.userData?["ny"] = ny
                }
                if !actions.isEmpty { n.run(.group(actions)) }
            }

        case "move-by":
            let targets = resolveTargets(p["target"])
            let duration = (p["duration"] as? Double) ?? 0.5
            let dx = (p["dx"] as? Double) ?? 0
            let dy = (p["dy"] as? Double) ?? 0
            for n in targets {
                let m = SKAction.moveBy(x: size.width * CGFloat(dx), y: size.height * CGFloat(dy), duration: duration)
                m.timingMode = easing(p["easing"] as? String)
                n.run(m)
            }

        case "rotate-to":
            let targets = resolveTargets(p["target"])
            let duration = (p["duration"] as? Double) ?? 0.3
            let angle = CGFloat((p["angle"] as? Double) ?? 0)
            for n in targets {
                n.run(SKAction.rotate(toAngle: angle, duration: duration, shortestUnitArc: true))
            }

        case "rotate-by":
            let targets = resolveTargets(p["target"])
            let duration = (p["duration"] as? Double) ?? 0.3
            let angle = CGFloat((p["angle"] as? Double) ?? 0)
            for n in targets {
                n.run(SKAction.rotate(byAngle: angle, duration: duration))
            }

        case "scale-to":
            let targets = resolveTargets(p["target"])
            let duration = (p["duration"] as? Double) ?? 0.3
            let scale = CGFloat((p["scale"] as? Double) ?? 1)
            for n in targets {
                let base = (n.userData?["baseScale"] as? Double).map { CGFloat($0) } ?? 1
                n.run(SKAction.scale(to: base * scale, duration: duration))
            }

        case "fade-to":
            let targets = resolveTargets(p["target"])
            let duration = (p["duration"] as? Double) ?? 0.3
            let alpha = CGFloat((p["alpha"] as? Double) ?? 1)
            for n in targets { n.run(SKAction.fadeAlpha(to: alpha, duration: duration)) }

        case "tint":
            let targets = resolveTargets(p["target"])
            let color = Self.parseColor(p["color"] as? String ?? "") ?? NSColor.red
            let amount = CGFloat((p["amount"] as? Double) ?? 0.6)
            for n in targets {
                if let s = n as? SKSpriteNode {
                    s.color = color; s.colorBlendFactor = amount
                }
            }

        case "set-facing":
            let targets = resolveTargets(p["target"])
            let dir = (p["dir"] as? String) ?? "right"
            for n in targets {
                let base = abs(n.xScale)
                n.xScale = dir == "left" ? -base : base
            }

        case "throw":
            let fromId = p["from"] as? String
            let toId = p["to"] as? String
            let emoji = (p["emoji"] as? String) ?? "💥"
            let fromPt = resolvePoint(id: fromId, xKey: "fromX", yKey: "fromY", params: p)
            let toPt = resolvePoint(id: toId, xKey: "toX", yKey: "toY", params: p)
            guard let f = fromPt, let t = toPt else { return }
            throwProjectile(from: f, to: t, emoji: emoji,
                            onHitColor: Self.parseColor(p["hitColor"] as? String ?? "") ?? NSColor.orange,
                            reactTarget: toId.flatMap { entities[$0]?.node })

        case "impact":
            let pt = CGPoint(x: size.width * CGFloat((p["x"] as? Double) ?? 0.5),
                             y: size.height * CGFloat((p["y"] as? Double) ?? 0.35))
            bigImpact(at: pt, text: (p["text"] as? String) ?? ["POW!","BOOM!","BAM!","CLASH!","WHAM!","CRUNCH!"].randomElement()!)

        case "burst":
            let pt = CGPoint(x: size.width * CGFloat((p["x"] as? Double) ?? 0.5),
                             y: size.height * CGFloat((p["y"] as? Double) ?? 0.5))
            let emojis = (p["emojis"] as? [String])
                ?? (p["emojis"] as? String).map { $0.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) } }
                ?? ["✨","💫","⚡"]
            let count = (p["count"] as? Int) ?? 18
            let spread = CGFloat((p["spread"] as? Double) ?? 220)
            let lifetime = TimeInterval((p["lifetime"] as? Double) ?? 1.0)
            spawnBurst(at: pt, emojis: emojis, count: count, spread: spread, lifetime: lifetime)

        case "say":
            setBanner((p["text"] as? String) ?? "—")

        case "text":
            let txt = (p["text"] as? String) ?? ""
            let pt = CGPoint(x: size.width * CGFloat((p["x"] as? Double) ?? 0.5),
                             y: size.height * CGFloat((p["y"] as? Double) ?? 0.55))
            spawnFloatingText(txt, at: pt,
                              fontSize: CGFloat((p["fontSize"] as? Double) ?? 52),
                              color: Self.parseColor(p["color"] as? String ?? "") ?? NSColor(calibratedRed: 1, green: 0.9, blue: 0.2, alpha: 1),
                              duration: TimeInterval((p["duration"] as? Double) ?? 1.2))

        case "label":
            // Persistent text label. Survives until the overlay closes (or `clear-shapes`).
            let txt = (p["text"] as? String) ?? ""
            let nx = (p["x"] as? Double) ?? 0.5
            let ny = (p["y"] as? Double) ?? 0.5
            let fs = CGFloat((p["fontSize"] as? Double) ?? 36)
            let color = Self.parseColor(p["color"] as? String ?? "") ?? NSColor.white
            let id = (p["id"] as? String) ?? "label_\(shapeCounter)"
            shapeCounter += 1
            if let existing = shapes[id] { existing.removeFromParent() }
            let l = SKLabelNode(fontNamed: (p["font"] as? String) ?? "HelveticaNeue-Bold")
            l.text = txt
            l.fontSize = fs
            l.fontColor = color
            l.horizontalAlignmentMode = .center
            l.verticalAlignmentMode = .center
            l.position = CGPoint(x: size.width * CGFloat(nx), y: size.height * CGFloat(ny))
            l.zPosition = 70
            addChild(l)
            shapes[id] = l

        case "rect":
            // Hollow rectangle outline, persistent. Coords are normalized; (x,y) is the bottom-left.
            let nx = (p["x"] as? Double) ?? 0.4
            let ny = (p["y"] as? Double) ?? 0.4
            let nw = (p["width"] as? Double) ?? 0.2
            let nh = (p["height"] as? Double) ?? 0.2
            let color = Self.parseColor(p["color"] as? String ?? "") ?? NSColor.red
            let lineWidth = CGFloat((p["lineWidth"] as? Double) ?? 4)
            let id = (p["id"] as? String) ?? "rect_\(shapeCounter)"
            shapeCounter += 1
            if let existing = shapes[id] { existing.removeFromParent() }
            let w = size.width * CGFloat(nw)
            let h = size.height * CGFloat(nh)
            let rect = CGRect(x: -w/2, y: -h/2, width: w, height: h)
            let node = SKShapeNode(rect: rect, cornerRadius: CGFloat((p["cornerRadius"] as? Double) ?? 4))
            node.strokeColor = color
            node.fillColor = .clear
            node.lineWidth = lineWidth
            node.position = CGPoint(x: size.width * CGFloat(nx) + w/2,
                                    y: size.height * CGFloat(ny) + h/2)
            node.zPosition = 65
            addChild(node)
            shapes[id] = node

        case "clear-shapes":
            for (_, n) in shapes { n.removeFromParent() }
            shapes.removeAll()

        case "shake":
            let targets = resolveTargets(p["target"])
            let mag = CGFloat((p["magnitude"] as? Double) ?? 14)
            let dur = TimeInterval((p["duration"] as? Double) ?? 0.35)
            let shake = shakeAction(magnitude: mag, duration: dur)
            if targets.isEmpty {
                for (_, e) in entities { e.node.run(shake) }
            } else { for n in targets { n.run(shake) } }

        case "knockout":
            if let id = p["target"] as? String, let e = entities[id] {
                performKnockout(entity: e)
            }

        case "roar":
            if let id = p["target"] as? String, let n = entities[id]?.node {
                n.removeAction(forKey: "idle-bob")
                let up = SKAction.scale(to: abs(n.xScale) * 1.18, duration: 0.12)
                let dn = SKAction.scale(to: abs(n.xScale), duration: 0.18)
                n.run(.sequence([up, dn]))
                spawnFloatingText((p["text"] as? String) ?? "RAWR!",
                                  at: CGPoint(x: n.position.x, y: n.position.y + 120),
                                  fontSize: 52,
                                  color: NSColor(calibratedRed: 1, green: 0.3, blue: 0.1, alpha: 1),
                                  duration: 1.0)
            }

        case "bow":
            if let id = p["target"] as? String, let n = entities[id]?.node {
                let dir: CGFloat = n.xScale < 0 ? -0.6 : 0.6
                n.run(.sequence([
                    SKAction.rotate(byAngle: dir, duration: 0.35),
                    SKAction.wait(forDuration: 0.5),
                    SKAction.rotate(byAngle: -dir, duration: 0.35)
                ]))
            }

        case "jump":
            let height = CGFloat((p["height"] as? Double) ?? 140)
            let targets = resolveTargets(p["target"])
            for n in targets {
                let up = SKAction.moveBy(x: 0, y: height, duration: 0.25)
                up.timingMode = .easeOut
                let dn = SKAction.moveBy(x: 0, y: -height, duration: 0.3)
                dn.timingMode = .easeIn
                n.run(.sequence([up, dn]))
            }

        case "spawn":
            if let spec = p["entity"] as? [String: Any] { spawnEntity(spec) }

        case "despawn":
            if let id = p["target"] as? String { despawnEntity(id) }

        case "wait":
            break

        default:
            break
        }
    }

    // MARK: - Helpers

    private func easing(_ name: String?) -> SKActionTimingMode {
        switch name {
        case "easeIn":       return .easeIn
        case "easeOut":      return .easeOut
        case "easeInOut":    return .easeInEaseOut
        default:             return .linear
        }
    }

    private func resolveTargets(_ any: Any?) -> [SKNode] {
        guard let v = any else { return [] }
        if let s = v as? String {
            if s == "all" { return entities.values.map { $0.node } }
            if let e = entities[s] { return [e.node] }
            return []
        }
        if let list = v as? [String] {
            return list.compactMap { entities[$0]?.node }
        }
        return []
    }

    private func resolvePoint(id: String?, xKey: String, yKey: String, params: [String: Any]) -> CGPoint? {
        if let id = id, let n = entities[id]?.node { return n.position }
        if let nx = params[xKey] as? Double, let ny = params[yKey] as? Double {
            return CGPoint(x: size.width * CGFloat(nx), y: size.height * CGFloat(ny))
        }
        return nil
    }

    // MARK: - Effects

    @MainActor
    private func bigImpact(at point: CGPoint, text: String) {
        let ring = SKShapeNode(circleOfRadius: 12)
        ring.position = point
        ring.strokeColor = NSColor(calibratedRed: 1, green: 0.8, blue: 0.1, alpha: 0.95)
        ring.fillColor = .clear
        ring.lineWidth = 5
        ring.glowWidth = 18
        ring.zPosition = 50
        addChild(ring)
        ring.run(.sequence([
            .group([.scale(to: 22, duration: 0.45), .fadeOut(withDuration: 0.45)]),
            .removeFromParent()
        ]))

        spawnFloatingText(text, at: CGPoint(x: point.x, y: point.y + 70),
                          fontSize: 64,
                          color: NSColor(calibratedRed: 1, green: 0.9, blue: 0.2, alpha: 1),
                          duration: 0.9, rotatedRandom: true)

        spawnBurst(at: point, emojis: ["🔥","💥","✨","⚡","💫"], count: 32, spread: 320, lifetime: 1.2)

        let flash = SKSpriteNode(color: NSColor(calibratedRed: 1, green: 0.9, blue: 0.6, alpha: 0.35), size: size)
        flash.position = CGPoint(x: size.width/2, y: size.height/2)
        flash.zPosition = 40
        flash.blendMode = .add
        addChild(flash)
        flash.run(.sequence([.fadeOut(withDuration: 0.35), .removeFromParent()]))
    }

    @MainActor
    private func throwProjectile(from: CGPoint, to: CGPoint, emoji: String,
                                 onHitColor: NSColor, reactTarget: SKSpriteNode?) {
        let tex = Self.emojiTexture(emoji, pointSize: 96)
        let p = SKSpriteNode(texture: tex)
        p.size = tex?.size() ?? CGSize(width: 96, height: 96)
        p.position = from
        p.zPosition = 15
        addChild(p)
        let dx = to.x - from.x
        let arc = SKAction.group([
            SKAction.moveTo(x: to.x, duration: 0.55),
            SKAction.sequence([
                SKAction.moveBy(x: 0, y: 100, duration: 0.27),
                SKAction.moveBy(x: 0, y: -100, duration: 0.27)
            ]),
            SKAction.rotate(byAngle: dx > 0 ? -CGFloat.pi * 2 : CGFloat.pi * 2, duration: 0.55)
        ])
        p.run(.sequence([
            arc,
            SKAction.run { [weak self] in
                self?.spawnBurst(at: to, emojis: ["💥","✨"], count: 14, spread: 160, lifetime: 0.7)
                self?.hitReaction(target: reactTarget, color: onHitColor)
            },
            SKAction.removeFromParent()
        ]))
    }

    @MainActor
    private func hitReaction(target: SKSpriteNode?, color: NSColor) {
        guard let t = target else { return }
        let original = t.colorBlendFactor
        let awayX: CGFloat = t.position.x < size.width / 2 ? -24 : 24
        let bump = SKAction.group([
            SKAction.sequence([
                SKAction.customAction(withDuration: 0.12) { node, _ in (node as? SKSpriteNode)?.colorBlendFactor = 0.8 },
                SKAction.customAction(withDuration: 0.25) { node, _ in (node as? SKSpriteNode)?.colorBlendFactor = original }
            ]),
            SKAction.sequence([
                SKAction.moveBy(x: awayX, y: 0, duration: 0.12),
                SKAction.moveBy(x: -awayX, y: 0, duration: 0.18)
            ]),
            SKAction.sequence([
                SKAction.rotate(byAngle: 0.18, duration: 0.12),
                SKAction.rotate(byAngle: -0.18, duration: 0.12)
            ])
        ])
        t.color = color
        t.run(bump)
    }

    @MainActor
    private func performKnockout(entity: EntityEntry) {
        let t = entity.node
        t.removeAction(forKey: "idle-bob")
        let tilt = SKAction.rotate(byAngle: t.xScale < 0 ? -1.35 : 1.35, duration: 0.6)
        tilt.timingMode = .easeIn
        let drop = SKAction.moveBy(x: 0, y: -70, duration: 0.6)
        drop.timingMode = .easeIn
        t.run(.group([tilt, drop]))

        let ko = SKLabelNode(fontNamed: "Impact")
        ko.text = "K.O.!"
        ko.fontSize = 120
        ko.fontColor = NSColor(calibratedRed: 1, green: 0.3, blue: 0.1, alpha: 1)
        ko.position = CGPoint(x: size.width/2, y: size.height/2)
        ko.zPosition = 100
        addChild(ko)
        ko.setScale(0.3)
        ko.run(.sequence([
            .group([.scale(to: 1.6, duration: 0.2), .fadeIn(withDuration: 0.05)]),
            .scale(to: 1.3, duration: 0.15),
            .wait(forDuration: 1.4),
            .fadeOut(withDuration: 0.4),
            .removeFromParent()
        ]))
        spawnBurst(at: CGPoint(x: size.width/2, y: size.height/2),
                   emojis: ["🎉","🎊","✨","💥"], count: 40, spread: 400, lifetime: 1.6)
    }

    @MainActor
    private func spawnBurst(at point: CGPoint, emojis: [String], count: Int, spread: CGFloat, lifetime: TimeInterval) {
        guard count >= 1, count <= 128, children.count + count <= DesktopOverlayValidation.maxNodes,
              spread.isFinite, spread >= 0, lifetime.isFinite, lifetime > 0 else {
            lastRuntimeError = "native burst exceeded the live scene budget"; return
        }
        for _ in 0..<count {
            let emoji = emojis.randomElement() ?? "✨"
            let t = Self.emojiTexture(emoji, pointSize: 56)
            let s = SKSpriteNode(texture: t)
            s.size = t?.size() ?? CGSize(width: 56, height: 56)
            s.position = point
            s.zPosition = 55
            let scale = CGFloat.random(in: 0.5...1.4)
            s.setScale(scale * 0.4)
            addChild(s)
            let angle = CGFloat.random(in: 0...(.pi * 2))
            let dist = CGFloat.random(in: spread * 0.3...spread)
            let dx = cos(angle) * dist
            let dy = sin(angle) * dist + 40
            let fly = SKAction.group([
                SKAction.moveBy(x: dx, y: dy, duration: lifetime),
                SKAction.scale(to: scale, duration: lifetime * 0.3),
                SKAction.rotate(byAngle: CGFloat.random(in: -3.2...3.2), duration: lifetime),
                SKAction.sequence([
                    SKAction.fadeAlpha(to: 1, duration: 0.05),
                    SKAction.wait(forDuration: lifetime * 0.6),
                    SKAction.fadeOut(withDuration: lifetime * 0.4)
                ])
            ])
            s.run(.sequence([fly, .removeFromParent()]))
        }
    }

    @MainActor
    private func spawnFloatingText(_ text: String, at point: CGPoint,
                                    fontSize: CGFloat, color: NSColor,
                                    duration: TimeInterval, rotatedRandom: Bool = false) {
        let l = SKLabelNode(fontNamed: "Impact")
        l.text = text
        l.fontSize = fontSize
        l.fontColor = color
        l.position = point
        l.zPosition = 60
        if rotatedRandom { l.zRotation = CGFloat.random(in: -0.25...0.25) }
        addChild(l)
        l.setScale(0.4)
        l.run(.sequence([
            .group([.scale(to: 1.3, duration: 0.12), .fadeIn(withDuration: 0.05)]),
            .scale(to: 1.0, duration: 0.12),
            .wait(forDuration: duration * 0.55),
            .group([.scale(to: 0.8, duration: 0.2), .fadeOut(withDuration: 0.28)]),
            .removeFromParent()
        ]))
    }

    private func shakeAction(magnitude: CGFloat, duration: TimeInterval) -> SKAction {
        let steps = 10
        var actions: [SKAction] = []
        for _ in 0..<steps {
            let dx = CGFloat.random(in: -magnitude...magnitude)
            let dy = CGFloat.random(in: -magnitude...magnitude)
            let a = SKAction.moveBy(x: dx, y: dy, duration: duration / Double(steps * 2))
            actions.append(a); actions.append(a.reversed())
        }
        return SKAction.sequence(actions)
    }

    // MARK: - Emoji texture

    static func emojiTexture(_ emoji: String, pointSize: CGFloat) -> SKTexture? {
        let font = NSFont.systemFont(ofSize: pointSize)
        let attr: [NSAttributedString.Key: Any] = [.font: font]
        let str = NSAttributedString(string: emoji, attributes: attr)
        let measured = str.size()
        let pad: CGFloat = 12
        let size = NSSize(width: ceil(measured.width) + pad * 2, height: ceil(measured.height) + pad * 2)
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0,
              size.width <= 2048, size.height <= 2048, size.width * size.height <= 1048576 else { return nil }
        let img = NSImage(size: size)
        img.lockFocus()
        NSColor.clear.setFill()
        NSRect(origin: .zero, size: size).fill()
        str.draw(at: NSPoint(x: pad, y: pad))
        img.unlockFocus()
        var rect = NSRect(origin: .zero, size: size)
        guard let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return nil }
        return SKTexture(cgImage: cg)
    }

    static func parseColor(_ s: String) -> NSColor? {
        let t = s.trimmingCharacters(in: .whitespaces).lowercased()
        switch t {
        case "red":    return NSColor(calibratedRed: 1, green: 0.2, blue: 0.1, alpha: 1)
        case "green":  return NSColor(calibratedRed: 0.1, green: 1, blue: 0.3, alpha: 1)
        case "blue":   return NSColor(calibratedRed: 0.2, green: 0.4, blue: 1, alpha: 1)
        case "yellow": return NSColor(calibratedRed: 1, green: 0.85, blue: 0.1, alpha: 1)
        case "orange": return NSColor(calibratedRed: 1, green: 0.55, blue: 0.1, alpha: 1)
        case "purple": return NSColor(calibratedRed: 0.7, green: 0.2, blue: 1, alpha: 1)
        case "white":  return .white
        case "black":  return .black
        default: break
        }
        if t.hasPrefix("#"), t.count == 7 {
            let hex = String(t.dropFirst())
            if let v = UInt64(hex, radix: 16) {
                let r = CGFloat((v >> 16) & 0xff) / 255
                let g = CGFloat((v >> 8) & 0xff) / 255
                let b = CGFloat(v & 0xff) / 255
                return NSColor(calibratedRed: r, green: g, blue: b, alpha: 1)
            }
        }
        return nil
    }

    // MARK: - Face tracking (in-process, real-time)

    @MainActor
    func startFaceTracking(fps: Double, displayID: CGDirectDisplayID) throws {
        guard DesktopOverlayValidation.number(fps, 1, 30), displayID != 0 else { throw DesktopOverlayValidation.invalid("tracking requires a bounded rate and exact display") }
        guard faceTrackTask == nil, faceCaptureTask == nil else { throw DesktopOverlayValidation.invalid("previous native capture still owns this scene; wait for retirement") }
        guard CGPreflightScreenCaptureAccess() else { throw DesktopOverlayValidation.invalid("screen recording permission is required for display tracking") }
        let generation = UUID()
        faceTrackGeneration = generation
        faceTrackOwner = generation
        faceTrackDisplay = displayID
        faceTrackError = nil
        faceTrackActive = true
        faceTrackTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.faceTrackOwner == generation {
                    self.faceCaptureTask = nil
                    self.faceTrackTask = nil
                    self.faceTrackOwner = nil
                    self.faceTrackActive = false
                }
            }
            while !Task.isCancelled && self.faceTrackGeneration == generation {
                let deadline = ContinuousClock.now.advanced(by: .seconds(1 / fps))
                let capture = Task.detached(priority: .userInitiated) { () async throws -> FaceTrackResult? in
                    try Task.checkCancellation()
                    let cg = try await ScriptScene.captureDisplay(displayID: displayID)
                    try Task.checkCancellation()
                    guard let result = try ScriptScene.detectFaceAndExpression(cg: cg) else { return nil }
                    try Task.checkCancellation()
                    return FaceTrackResult(bbox: result.0, expression: result.1)
                }
                self.faceCaptureTask = capture
                do {
                    let result = try await capture.value
                    self.faceCaptureTask = nil
                    guard !Task.isCancelled, self.faceTrackGeneration == generation else { break }
                    if let result { self.applyFaceUpdate(result.bbox, expression: result.expression) }
                    else { self.applyFaceMiss() }
                } catch {
                    self.faceCaptureTask = nil
                    if !Task.isCancelled && self.faceTrackGeneration == generation {
                        self.faceTrackError = String(error.localizedDescription.prefix(2048))
                        Platform.log("overlay tracking stopped after native capture failure")
                        Platform.emitEvent("overlay_tracking_failed")
                    }
                    break
                }
                if ContinuousClock.now < deadline {
                    do { try await ContinuousClock().sleep(until: deadline) }
                    catch { break }
                }
            }
        }
    }

    @MainActor
    func stopFaceTracking() {
        faceTrackGeneration = UUID()
        faceTrackActive = false
        faceCaptureTask?.cancel()
        faceTrackTask?.cancel()
        // Cancellation does not prove that ScreenCaptureKit/Vision returned.
        // The owning task clears both handles after the native work actually ends.
    }

    nonisolated private static func captureDisplay(displayID: CGDirectDisplayID) async throws -> CGImage {
        try Task.checkCancellation()
        let content = try await SCShareableContent.current
        try Task.checkCancellation()
        guard let display = content.displays.first(where: { $0.displayID == displayID }), display.width > 0, display.height > 0 else { throw DesktopOverlayValidation.invalid("owned tracking display is gone") }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        let scale = min(0.5, 1920 / Double(display.width), 1080 / Double(display.height))
        config.width = max(1, Int(Double(display.width) * scale))
        config.height = max(1, Int(Double(display.height) * scale))
        let sample = try await SCScreenshotManager.captureSampleBuffer(contentFilter: filter, configuration: config)
        try Task.checkCancellation()
        guard let pixels = CMSampleBufferGetImageBuffer(sample), CVPixelBufferGetWidth(pixels) <= 1920, CVPixelBufferGetHeight(pixels) <= 1080 else { throw DesktopOverlayValidation.invalid("tracking capture exceeded its native frame bounds") }
        let ci = CIImage(cvPixelBuffer: pixels)
        guard let cg = CIContext().createCGImage(ci, from: ci.extent) else { throw DesktopOverlayValidation.invalid("native tracking image conversion failed") }
        return cg
    }

    nonisolated private static func detectFaceAndExpression(cg: CGImage) throws -> (CGRect, String)? {
        // Step 1: face bbox via Vision (largest face wins)
        let faceReq = VNDetectFaceRectanglesRequest()
        try VNImageRequestHandler(cgImage: cg).perform([faceReq])
        guard let face = (faceReq.results ?? []).max(by: {
            $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height
        }) else { return nil }
        let bbox = face.boundingBox

        // Step 2: crop to padded face region for downstream models
        let W = CGFloat(cg.width), H = CGFloat(cg.height)
        let pad: CGFloat = 0.30
        let cx = max(0, (bbox.origin.x - bbox.width * pad) * W)
        let cy = max(0, (CGFloat(1) - bbox.origin.y - bbox.height - bbox.height * pad) * H)
        let cw = min(W - cx, bbox.width * (1 + 2 * pad) * W)
        let ch = min(H - cy, bbox.height * (1 + 2 * pad) * H)
        let cropped = cg.cropping(to: CGRect(x: cx, y: cy, width: cw, height: ch)) ?? cg

        // Step 3: emotion classifier (Core ML)
        var emotion = "neutral"
        var emotionConf: Float = 0
        if let model = sharedEmotionModel,
           let result = try? VNCoreMLRequestRunner.run(model: model, on: cropped),
           let top = result.first {
            emotion = top.identifier
            emotionConf = top.confidence
        }

        // Step 4: face landmarks for geometric expression details
        let lmReq = VNDetectFaceLandmarksRequest()
        try? VNImageRequestHandler(cgImage: cropped).perform([lmReq])
        var smileWidth: Float = 0
        var mouthOpen: Float = 0
        var eyeOpenness: Float = 1.0
        var asymmetricEyes = false
        var headTilt: Float = 0
        var headYaw: Float = 0
        if let lm = lmReq.results?.first {
            if let outerLips = lm.landmarks?.outerLips {
                let pts = outerLips.normalizedPoints
                let xs = pts.map { Float($0.x) }
                let ys = pts.map { Float($0.y) }
                if let minX = xs.min(), let maxX = xs.max(),
                   let minY = ys.min(), let maxY = ys.max() {
                    smileWidth = maxX - minX
                    mouthOpen = maxY - minY
                }
            }
            if let leftEye = lm.landmarks?.leftEye, let rightEye = lm.landmarks?.rightEye {
                func openness(_ pts: [CGPoint]) -> Float {
                    let ys = pts.map { Float($0.y) }
                    return (ys.max() ?? 0) - (ys.min() ?? 0)
                }
                let l = openness(leftEye.normalizedPoints)
                let r = openness(rightEye.normalizedPoints)
                eyeOpenness = (l + r) / 2
                asymmetricEyes = abs(l - r) > 0.4 * max(l, r)
            }
            headYaw = lm.yaw?.floatValue ?? 0
            headTilt = lm.roll?.floatValue ?? 0
        }

        // Step 5: smile state via CIDetector for redundancy
        var hasSmile = false
        var leftEyeClosed = false
        var rightEyeClosed = false
        let ci = CIImage(cgImage: cropped)
        let det = CIDetector(ofType: CIDetectorTypeFace, context: nil,
                             options: [CIDetectorAccuracy: CIDetectorAccuracyLow,
                                       CIDetectorSmile: true,
                                       CIDetectorEyeBlink: true])
        if let feat = det?.features(in: ci, options: [CIDetectorSmile: true, CIDetectorEyeBlink: true]).first as? CIFaceFeature {
            hasSmile = feat.hasSmile
            leftEyeClosed = feat.leftEyeClosed
            rightEyeClosed = feat.rightEyeClosed
        }

        // Step 6: body pose on full frame — get joint positions for activity inference
        let bodyReq = VNDetectHumanBodyPoseRequest()
        bodyReq.revision = VNDetectHumanBodyPoseRequestRevision1
        try? VNImageRequestHandler(cgImage: cg).perform([bodyReq])
        var bodyPosture = ""
        var armsRaised = false
        var handsOnFace = false
        if let body = bodyReq.results?.first {
            bodyPosture = inferBodyPosture(body)
            armsRaised = bodyPosture.contains("arms raised") || bodyPosture.contains("waving")
        }

        // Step 7: hand pose on cropped near-face region — detect hand-near-face gestures
        let handReq = VNDetectHumanHandPoseRequest()
        handReq.maximumHandCount = 2
        try? VNImageRequestHandler(cgImage: cg).perform([handReq])
        let handCount = handReq.results?.count ?? 0

        // Hands near the face? Compare hand bboxes to face bbox (image-normalized)
        if let hands = handReq.results {
            for hand in hands {
                guard let allPts = try? hand.recognizedPoints(.all) else { continue }
                let xs = allPts.values.compactMap { $0.confidence > 0.3 ? Float($0.location.x) : nil }
                let ys = allPts.values.compactMap { $0.confidence > 0.3 ? Float($0.location.y) : nil }
                if let mx = xs.reduce(0,+) as Float?, !xs.isEmpty,
                   let my = ys.reduce(0,+) as Float?, !ys.isEmpty {
                    let cx = mx / Float(xs.count), cy = my / Float(ys.count)
                    let fx = Float(bbox.midX), fy = Float(bbox.midY)
                    let dx = cx - fx, dy = cy - fy
                    let dist = sqrt(dx*dx + dy*dy)
                    if dist < Float(bbox.width) * 1.5 {
                        handsOnFace = true
                        break
                    }
                }
            }
        }

        // Step 8: capture quality (sharp/blurry signal)
        let qReq = VNDetectFaceCaptureQualityRequest()
        try? VNImageRequestHandler(cgImage: cropped).perform([qReq])
        let captureQuality: Float = qReq.results?.first?.faceCaptureQuality ?? 0.5

        // Step 9: synthesize description (target ≤15 words)
        let desc = buildDescription(
            emotion: emotion, emotionConf: emotionConf,
            smileWidth: smileWidth, mouthOpen: mouthOpen,
            eyeOpenness: eyeOpenness, asymmetricEyes: asymmetricEyes,
            hasSmile: hasSmile, leftClosed: leftEyeClosed, rightClosed: rightEyeClosed,
            yaw: headYaw, roll: headTilt,
            bodyPosture: bodyPosture, armsRaised: armsRaised,
            handCount: handCount, handsOnFace: handsOnFace,
            captureQuality: captureQuality
        )
        return (bbox, desc)
    }

    nonisolated private static func inferBodyPosture(_ body: VNHumanBodyPoseObservation) -> String {
        // Derive a coarse posture label from joint configuration.
        // VNHumanBodyPoseObservation joints are normalized [0..1] image coords.
        guard let pts = try? body.recognizedPoints(.all) else { return "" }
        func y(_ name: VNHumanBodyPoseObservation.JointName) -> Float? {
            guard let p = pts[name], p.confidence > 0.3 else { return nil }
            return Float(p.location.y)
        }

        let leftWrist = y(.leftWrist)
        let rightWrist = y(.rightWrist)
        let leftShoulder = y(.leftShoulder)
        let rightShoulder = y(.rightShoulder)
        let leftHip = y(.leftHip)
        let rightHip = y(.rightHip)
        let nose = y(.nose)

        // Arms raised — wrists above shoulders
        if let lw = leftWrist, let ls = leftShoulder, lw > ls,
           let rw = rightWrist, let rs = rightShoulder, rw > rs {
            return "both arms raised"
        }
        if let lw = leftWrist, let ls = leftShoulder, lw > ls {
            return "left arm raised"
        }
        if let rw = rightWrist, let rs = rightShoulder, rw > rs {
            return "right arm raised"
        }

        // Sitting — hips visible but knees not, or hip-shoulder vertical span small
        if let ls = leftShoulder, let lh = leftHip {
            let span = ls - lh
            if span < 0.15 { return "seated" }
        }

        // Leaning — shoulder y-asymmetry
        if let ls = leftShoulder, let rs = rightShoulder {
            let d = ls - rs
            if d > 0.04 { return "leaning right" }
            if d < -0.04 { return "leaning left" }
        }

        // Standing — full vertical span visible
        if let n = nose, let lh = leftHip ?? rightHip, n - lh > 0.25 {
            return "standing"
        }

        return ""
    }

    nonisolated private static func buildDescription(
        emotion: String, emotionConf: Float,
        smileWidth: Float, mouthOpen: Float,
        eyeOpenness: Float, asymmetricEyes: Bool,
        hasSmile: Bool, leftClosed: Bool, rightClosed: Bool,
        yaw: Float, roll: Float,
        bodyPosture: String, armsRaised: Bool,
        handCount: Int, handsOnFace: Bool,
        captureQuality: Float
    ) -> String {
        var parts: [String] = []

        // Emotion (capitalize)
        let emoCap = emotion.prefix(1).uppercased() + emotion.dropFirst().lowercased()
        parts.append(emoCap)

        // Smile / mouth state
        if hasSmile {
            if smileWidth > 0.32 { parts.append("with broad smile") }
            else { parts.append("with subtle smile") }
        } else if smileWidth > 0.30 && mouthOpen > 0.10 {
            parts.append("mouth open")
        } else if mouthOpen > 0.06 {
            parts.append("lips slightly parted")
        } else {
            parts.append("mouth closed")
        }

        // Eye state
        if leftClosed && rightClosed {
            parts.append("eyes closed")
        } else if asymmetricEyes || leftClosed || rightClosed {
            parts.append("winking")
        } else if eyeOpenness < 0.06 {
            parts.append("eyes squinted")
        } else {
            parts.append("eyes open")
        }

        // Head orientation (yaw — left/right turn)
        if yaw > 0.25 {
            parts.append("looking left")
        } else if yaw < -0.25 {
            parts.append("looking right")
        }

        // Head tilt (roll)
        if roll > 0.18 {
            parts.append("tilted right")
        } else if roll < -0.18 {
            parts.append("tilted left")
        }

        // Body posture (from VNDetectHumanBodyPoseRequest)
        if !bodyPosture.isEmpty {
            parts.append(bodyPosture)
        }

        // Hands near face
        if handsOnFace {
            parts.append("hand near face")
        } else if handCount >= 2 {
            parts.append("both hands visible")
        } else if handCount == 1 {
            parts.append("one hand visible")
        }

        // Capture quality cue (only when notably bad — clutter-suppression)
        if captureQuality < 0.30 {
            parts.append("blurry")
        }

        // Cap to ~15 words
        var joined = parts.joined(separator: ", ")
        let words = joined.split(separator: " ")
        if words.count > 15 { joined = words.prefix(15).joined(separator: " ") }
        return joined
    }

    nonisolated private static var sharedEmotionModel: VNCoreMLModel? {
        EmotionModelHolder.shared.model
    }

    private var trackMissCount: Int {
        get { (objc_getAssociatedObject(self, &Self.missKey) as? Int) ?? 0 }
        set { objc_setAssociatedObject(self, &Self.missKey, newValue, .OBJC_ASSOCIATION_RETAIN) }
    }
    private static var missKey: UInt8 = 0

    @MainActor
    private func applyFaceUpdate(_ bbox: CGRect, expression: String) {
        trackMissCount = 0
        let pad: CGFloat = 0.15
        let rx = max(0, bbox.origin.x - bbox.width * pad)
        let ry = max(0, bbox.origin.y - bbox.height * pad)
        let rw = min(1 - rx, bbox.width * (1 + 2 * pad))
        let rh = min(1 - ry, bbox.height * (1 + 2 * pad))

        let pixW = size.width * rw
        let pixH = size.height * rh
        let centerX = size.width * rx + pixW / 2
        let centerY = size.height * ry + pixH / 2

        // Update or create rect node
        let rectId = "face-box"
        let existingRect = shapes[rectId] as? SKShapeNode
        if let r = existingRect, let path = r.path,
           abs(path.boundingBox.width - pixW) < 1, abs(path.boundingBox.height - pixH) < 1 {
            // Same size — just move
            r.position = CGPoint(x: centerX, y: centerY)
        } else {
            existingRect?.removeFromParent()
            let pathRect = CGRect(x: -pixW/2, y: -pixH/2, width: pixW, height: pixH)
            let node = SKShapeNode(rect: pathRect, cornerRadius: 6)
            node.strokeColor = NSColor.red
            node.fillColor = .clear
            node.lineWidth = 5
            node.position = CGPoint(x: centerX, y: centerY)
            node.zPosition = 65
            addChild(node)
            shapes[rectId] = node
        }

        // Update or create label node
        let labelY = max(8, size.height * ry - 22)
        let labelId = "face-label"
        if let l = shapes[labelId] as? SKLabelNode {
            l.text = expression
            l.position = CGPoint(x: centerX, y: labelY)
        } else {
            let l = SKLabelNode(fontNamed: "HelveticaNeue-Bold")
            l.text = expression
            l.fontSize = 28
            l.fontColor = NSColor.red
            l.horizontalAlignmentMode = .center
            l.verticalAlignmentMode = .center
            l.position = CGPoint(x: centerX, y: labelY)
            l.zPosition = 70
            addChild(l)
            shapes[labelId] = l
        }
    }

    @MainActor
    private func applyFaceMiss() {
        trackMissCount += 1
        if trackMissCount == 5 {
            shapes["face-box"]?.removeFromParent()
            shapes["face-label"]?.removeFromParent()
            shapes.removeValue(forKey: "face-box")
            shapes.removeValue(forKey: "face-label")
        }
    }
}

// SKView doesn't expose frame time conveniently; emulate it.
extension SKView {
    var currentFrameTime: TimeInterval { CACurrentMediaTime() }
}

// Sendable wrapper for face-track results crossing actor boundaries.
private struct FaceTrackResult: Sendable {
    let bbox: CGRect
    let expression: String
}

// Tiny wrapper that runs a VNCoreMLRequest synchronously and returns top classifications.
enum VNCoreMLRequestRunner {
    static func run(model: VNCoreMLModel, on image: CGImage) throws -> [VNClassificationObservation] {
        let req = VNCoreMLRequest(model: model)
        req.imageCropAndScaleOption = .centerCrop
        try VNImageRequestHandler(cgImage: image).perform([req])
        return (req.results as? [VNClassificationObservation])?.sorted { $0.confidence > $1.confidence } ?? []
    }
}

// Lazy, thread-safe singleton holder for the emotion model. Marked @unchecked Sendable
// because VNCoreMLModel itself is not Sendable in the Swift 6 concurrency model, but
// VNCoreMLRequest is documented thread-safe so concurrent reads of the loaded model are fine.
final class EmotionModelHolder: @unchecked Sendable {
    static let shared = EmotionModelHolder()
    let model: VNCoreMLModel?
    private init() {
        // Look up the model in the app bundle's Resources directory.
        // build-bridge.sh copies FaceEmotion.mlmodelc into Contents/Resources/.
        let url: URL?
        if let bundleUrl = Bundle.main.url(forResource: "FaceEmotion", withExtension: "mlmodelc") {
            url = bundleUrl
        } else {
            // Fallback for development: model next to the bare binary.
            let exe = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
            let candidate = exe.deletingLastPathComponent().appendingPathComponent("FaceEmotion.mlmodelc")
            url = FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
        }
        guard let modelUrl = url else {
            Platform.log("FaceEmotion.mlmodelc not found in app bundle Resources")
            self.model = nil
            return
        }
        if let coreModel = try? MLModel(contentsOf: modelUrl),
           let visionModel = try? VNCoreMLModel(for: coreModel) {
            self.model = visionModel
        } else {
            Platform.log("Failed to load FaceEmotion model from \(modelUrl.path)")
            self.model = nil
        }
    }
}
