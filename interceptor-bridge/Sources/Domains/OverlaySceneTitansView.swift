import Foundation
import AppKit
import SpriteKit

// Choreographed Godzilla vs Kong fight scene using SpriteKit.
// Transparent by construction: SKView with allowsTransparency, SKScene with .clear bg.

final class OverlaySceneTitansView: SKView, OverlayControllable {
    var interactive: Bool = false
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { interactive }

    private let titanScene = TitansScene()
    private var retired = false

    var nativeStatus: [String: Any] {
        ["paused": isPaused, "retired": retired, "nodes": titanScene.children.count]
    }
    var hasPendingNativeWork: Bool { false }

    func shutdown() {
        retired = true
        isPaused = true
        OverlayNativeCleanup.retire(titanScene)
        presentScene(nil)
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        self.wantsLayer = true
        self.layer?.backgroundColor = NSColor.clear.cgColor
        self.allowsTransparency = true
        self.ignoresSiblingOrder = true
        self.shouldCullNonVisibleNodes = true
        titanScene.scaleMode = .resizeFill
        titanScene.backgroundColor = .clear
        presentScene(titanScene)
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func layout() {
        super.layout()
        titanScene.size = bounds.size
        titanScene.didResize()
    }

    // Agent-facing entry point. Called by OverlayDomain on the main thread.
    var supportedVerbs: [String] {
        ["say", "punch", "breathe-fire", "taunt", "roar", "bow", "knockout",
         "reset", "pause", "resume", "throw", "tint", "jump", "round"]
    }

    func perform(verb: String, args: [String: Any]) -> [String: Any] {
        guard !retired else { return ["ok": false, "code": "target_gone", "error": "scene renderer retired"] }
        let result = titanScene.perform(verb: verb, args: args)
        if result["ok"] as? Bool == true {
            if verb == "pause" { isPaused = true }
            if verb == "resume" { isPaused = false }
        }
        return result
    }
}

// MARK: - Scene

final class TitansScene: SKScene {
    private var kong: SKSpriteNode!
    private var godzilla: SKSpriteNode!
    private var banner: SKLabelNode!
    private var roundCount = 0
    private var configured = false

    override func didMove(to view: SKView) {
        configure()
    }

    func didResize() {
        if !configured { configure(); return }
        reposition()
    }

    private func configure() {
        guard size.width > 1, size.height > 1 else { return }
        removeAllChildren()

        // Subtle atmospheric sky gradient drawn via a colored node — soft alpha
        let haze = SKSpriteNode(color: NSColor(calibratedRed: 0.1, green: 0.0, blue: 0.15, alpha: 0.12),
                                size: size)
        haze.position = CGPoint(x: size.width/2, y: size.height/2)
        haze.zPosition = -100
        addChild(haze)

        // Ground line (subtle)
        let ground = SKShapeNode(rectOf: CGSize(width: size.width, height: 2))
        ground.fillColor = NSColor(calibratedRed: 1.0, green: 0.4, blue: 0.1, alpha: 0.5)
        ground.strokeColor = .clear
        ground.glowWidth = 4
        ground.position = CGPoint(x: size.width/2, y: groundY())
        ground.zPosition = -50
        addChild(ground)

        kong     = makeFighter(emoji: "🦍", name: "kong")
        godzilla = makeFighter(emoji: "🦖", name: "godzilla")
        banner   = makeBanner()

        kong.position     = CGPoint(x: size.width - 140, y: groundY() + 80)
        godzilla.position = CGPoint(x: 140,              y: groundY() + 80)
        banner.position   = CGPoint(x: size.width/2,     y: size.height - 60)

        // Face each other. Apple color emoji: 🦖 faces left by default; 🦍 faces
        // left/forward as well. We want godzilla (left side) to look RIGHT and
        // kong (right side) to look LEFT, so flip godzilla and keep kong natural.
        godzilla.xScale = -1
        kong.xScale     = 1

        addChild(kong)
        addChild(godzilla)
        addChild(banner)

        startChoreography()
        configured = true
    }

    private func reposition() {
        kong.position     = CGPoint(x: size.width - 140, y: groundY() + 80)
        godzilla.position = CGPoint(x: 140,              y: groundY() + 80)
        banner.position   = CGPoint(x: size.width/2,     y: size.height - 60)
    }

    private func groundY() -> CGFloat { max(size.height * 0.22, 110) }

    // MARK: - Node factories

    private func makeFighter(emoji: String, name: String) -> SKSpriteNode {
        let texture = Self.emojiTexture(emoji, pointSize: 180)
        let sprite = SKSpriteNode(texture: texture)
        sprite.name = name
        sprite.size = texture?.size() ?? CGSize(width: 180, height: 180)
        sprite.zPosition = 10
        // Subtle idle bob
        let up = SKAction.moveBy(x: 0, y: 8, duration: 0.35)
        up.timingMode = .easeInEaseOut
        let down = up.reversed()
        sprite.run(.repeatForever(.sequence([up, down])))
        return sprite
    }

    private func makeBanner() -> SKLabelNode {
        let label = SKLabelNode(fontNamed: "Impact")
        label.text = "ROUND 1 — FIGHT!"
        label.fontSize = 40
        label.fontColor = NSColor(calibratedRed: 1.0, green: 0.85, blue: 0.1, alpha: 1)
        label.zPosition = 20
        // Pulse scale via action
        let pulse = SKAction.sequence([
            SKAction.scale(to: 1.07, duration: 0.45),
            SKAction.scale(to: 1.00, duration: 0.45)
        ])
        label.run(.repeatForever(pulse))
        return label
    }

    // MARK: - Choreography

    private func startChoreography() {
        let loop = SKAction.run { [weak self] in self?.runRound() }
        let wait = SKAction.wait(forDuration: 4.2)
        run(.repeatForever(.sequence([loop, wait])), withKey: "choreography")
    }

    private func runRound() {
        roundCount += 1
        banner.text = "ROUND \(roundCount) — FIGHT!"

        let w = size.width
        let centerX = w / 2
        let ground = groundY() + 80

        // Phase 1 — charge toward center
        let kongCharge    = SKAction.moveTo(x: centerX + 80, duration: 0.55)
        let godCharge     = SKAction.moveTo(x: centerX - 80, duration: 0.55)
        kongCharge.timingMode = .easeIn
        godCharge.timingMode = .easeIn
        // Slight crouch + lean for charge feel
        let lean = SKAction.rotate(byAngle: -0.12, duration: 0.2)
        let leanBack = lean.reversed()

        // Phase 2 — impact (simultaneous flash + shake + emitters)
        let impact = SKAction.run { [weak self] in self?.bigImpact(at: CGPoint(x: centerX, y: ground)) }
        let shake = self.shakeAction(magnitude: 16, duration: 0.35)

        // Phase 3 — recoil back to starting corners
        let kongRecoil    = SKAction.moveTo(x: w - 140, duration: 0.7)
        let godRecoil     = SKAction.moveTo(x: 140,     duration: 0.7)
        kongRecoil.timingMode = .easeOut
        godRecoil.timingMode = .easeOut
        // Flip during recoil to show back-and-return
        let upArc1 = SKAction.moveBy(x: 0, y: 40, duration: 0.25)
        let downArc1 = SKAction.moveBy(x: 0, y: -40, duration: 0.45)
        upArc1.timingMode = .easeOut
        downArc1.timingMode = .easeIn

        // Kong punch projectile (👊) thrown at Godzilla
        let kongThrow = SKAction.run { [weak self] in
            self?.throwProjectile(from: CGPoint(x: w - 140, y: ground),
                                  to:   CGPoint(x: 140, y: ground),
                                  emoji: "👊", onHitColor: NSColor(calibratedRed: 1, green: 0.5, blue: 0, alpha: 1))
        }
        // Godzilla fire breath (🔥) flung at Kong
        let godBreathe = SKAction.run { [weak self] in
            self?.throwProjectile(from: CGPoint(x: 140, y: ground),
                                  to:   CGPoint(x: w - 140, y: ground),
                                  emoji: "🔥", onHitColor: NSColor(calibratedRed: 1, green: 0.2, blue: 0.05, alpha: 1))
        }

        // Put it together
        kong.run(.sequence([
            .group([kongCharge, lean]),
            .group([impact, shake]),
            leanBack,
            .group([kongRecoil, .sequence([upArc1, downArc1])]),
            .wait(forDuration: 0.2),
            kongThrow,
            .wait(forDuration: 0.8),
            godBreathe
        ]))
        godzilla.run(.sequence([
            .group([godCharge, lean]),
            leanBack,
            .group([godRecoil, .sequence([upArc1, downArc1])]),
        ]))
    }

    private func shakeAction(magnitude: CGFloat, duration: TimeInterval) -> SKAction {
        // camera-free shake: translate scene children via a container? Simpler:
        // run shake on the scene itself by nudging anchor point.
        // But SKScene anchor affects layout. Instead, shake the banner + particles.
        let steps = 10
        var actions: [SKAction] = []
        for _ in 0..<steps {
            let dx = CGFloat.random(in: -magnitude...magnitude)
            let dy = CGFloat.random(in: -magnitude...magnitude)
            let a = SKAction.moveBy(x: dx, y: dy, duration: duration / Double(steps * 2))
            actions.append(a)
            actions.append(a.reversed())
        }
        return SKAction.sequence(actions)
    }

    private func bigImpact(at point: CGPoint) {
        // Flash ring
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

        // POW text
        let pow = SKLabelNode(fontNamed: "Impact")
        pow.text = ["POW!", "BOOM!", "BAM!", "CLASH!", "WHAM!"].randomElement() ?? "POW!"
        pow.fontSize = 64
        pow.fontColor = NSColor(calibratedRed: 1, green: 0.9, blue: 0.2, alpha: 1)
        pow.position = CGPoint(x: point.x, y: point.y + 70)
        pow.zPosition = 60
        pow.zRotation = CGFloat.random(in: -0.25...0.25)
        addChild(pow)
        pow.setScale(0.4)
        pow.run(.sequence([
            .group([.scale(to: 1.3, duration: 0.12), .fadeIn(withDuration: 0.05)]),
            .scale(to: 1.0, duration: 0.12),
            .wait(forDuration: 0.55),
            .group([.scale(to: 0.8, duration: 0.25), .fadeOut(withDuration: 0.3)]),
            .removeFromParent()
        ]))

        // Fire/spark burst emitters
        spawnBurst(at: point, emojis: ["🔥", "💥", "✨", "⚡", "💫"], count: 32, spread: 320, lifetime: 1.2)

        // Screen ripple: flash a tinted quad fading away
        let flash = SKSpriteNode(color: NSColor(calibratedRed: 1, green: 0.9, blue: 0.6, alpha: 0.35), size: size)
        flash.position = CGPoint(x: size.width/2, y: size.height/2)
        flash.zPosition = 40
        flash.blendMode = .add
        addChild(flash)
        flash.run(.sequence([.fadeOut(withDuration: 0.35), .removeFromParent()]))
    }

    private func throwProjectile(from: CGPoint, to: CGPoint, emoji: String, onHitColor: NSColor) {
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
                self?.spawnBurst(at: to, emojis: ["💥", "✨"], count: 14, spread: 160, lifetime: 0.7)
                self?.hitReaction(target: dx > 0 ? self?.godzilla : self?.kong, color: onHitColor)
            },
            SKAction.removeFromParent()
        ]))
    }

    private func hitReaction(target: SKSpriteNode?, color: NSColor) {
        guard let t = target else { return }
        let original = t.colorBlendFactor
        t.color = color
        t.colorBlendFactor = 0.0
        // Recoil AWAY from center — whichever side they're on.
        let awayX: CGFloat = t.position.x < size.width / 2 ? -24 : 24
        let bump = SKAction.group([
            SKAction.sequence([
                SKAction.customAction(withDuration: 0.12) { node, _ in
                    (node as? SKSpriteNode)?.colorBlendFactor = 0.8
                },
                SKAction.customAction(withDuration: 0.25) { node, _ in
                    (node as? SKSpriteNode)?.colorBlendFactor = original
                }
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
        t.run(bump)
    }

    private func spawnBurst(at point: CGPoint, emojis: [String], count: Int, spread: CGFloat, lifetime: TimeInterval) {
        guard count >= 1, count <= 128, children.count + count <= DesktopOverlayValidation.maxNodes else {
            isPaused = true
            Platform.emitEvent("overlay_scene_resource_limit")
            return
        }
        for _ in 0..<count {
            let emoji = emojis.randomElement()!
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

    // MARK: - Agent-facing verbs

    private var autoChoreoEnabled = true

    func perform(verb: String, args: [String: Any]) -> [String: Any] {
        guard configured else { return ["ok": false, "error": "scene not configured yet"] }
        do { _ = try DesktopOverlayValidation.controlArgs(args, mode: "scene", verb: verb) }
        catch { return ["ok": false, "code": "invalid_request", "error": error.localizedDescription] }
        guard children.count + 128 <= DesktopOverlayValidation.maxNodes else { return ["ok": false, "code": "resource_limit", "error": "scene node limit reached"] }
        switch verb {
        case "say":
            let text = (args["text"] as? String) ?? "—"
            banner.text = text
            return ["ok": true, "text": text]

        case "round":
            roundCount = (args["n"] as? Int) ?? (roundCount + 1)
            banner.text = (args["text"] as? String) ?? "ROUND \(roundCount)"
            return ["ok": true, "round": roundCount]

        case "punch":
            let who = (args["who"] as? String) ?? "kong"
            performPunch(attacker: who, emoji: (args["emoji"] as? String) ?? "👊")
            return ["ok": true, "verb": "punch", "who": who]

        case "breathe-fire":
            let who = (args["who"] as? String) ?? "godzilla"
            performBreatheFire(attacker: who, emoji: (args["emoji"] as? String) ?? "🔥")
            return ["ok": true, "verb": "breathe-fire", "who": who]

        case "throw":
            let who = (args["who"] as? String) ?? "kong"
            let emoji = (args["emoji"] as? String) ?? "🍌"
            performThrow(attacker: who, emoji: emoji)
            return ["ok": true, "verb": "throw", "who": who, "emoji": emoji]

        case "taunt":
            let who = (args["who"] as? String) ?? "kong"
            performTaunt(who: who)
            return ["ok": true, "verb": "taunt", "who": who]

        case "roar":
            let who = (args["who"] as? String) ?? "godzilla"
            performRoar(who: who, text: (args["text"] as? String) ?? "RAAWR!")
            return ["ok": true, "verb": "roar", "who": who]

        case "bow":
            let who = (args["who"] as? String) ?? "kong"
            performBow(who: who)
            return ["ok": true, "verb": "bow", "who": who]

        case "jump":
            let who = (args["who"] as? String) ?? "kong"
            performJump(who: who, height: (args["height"] as? Double).map { CGFloat($0) } ?? 140)
            return ["ok": true, "verb": "jump", "who": who]

        case "knockout":
            let who = (args["who"] as? String) ?? "kong"
            performKnockout(who: who)
            return ["ok": true, "verb": "knockout", "who": who]

        case "tint":
            let who = (args["who"] as? String) ?? "kong"
            let color = parseColor(args["color"] as? String)
            if let target = fighter(named: who) {
                target.color = color
                target.colorBlendFactor = CGFloat((args["amount"] as? Double) ?? 0.6)
            }
            return ["ok": true, "verb": "tint", "who": who]

        case "reset":
            removeAllActions()
            fighter(named: "kong")?.removeAllActions()
            fighter(named: "godzilla")?.removeAllActions()
            reposition()
            kong.zRotation = 0
            godzilla.zRotation = 0
            kong.colorBlendFactor = 0
            godzilla.colorBlendFactor = 0
            // Restore idle bob
            let up = SKAction.moveBy(x: 0, y: 8, duration: 0.35)
            up.timingMode = .easeInEaseOut
            kong.run(.repeatForever(.sequence([up, up.reversed()])))
            godzilla.run(.repeatForever(.sequence([up, up.reversed()])))
            if autoChoreoEnabled { startChoreography() }
            return ["ok": true, "verb": "reset"]

        case "pause":
            autoChoreoEnabled = false
            self.removeAllActions()
            return ["ok": true, "verb": "pause"]

        case "resume":
            autoChoreoEnabled = true
            startChoreography()
            return ["ok": true, "verb": "resume"]

        default:
            return ["ok": false, "error": "unknown verb: \(verb)",
                    "verbs": ["say", "punch", "breathe-fire", "taunt", "roar", "bow",
                              "jump", "knockout", "throw", "tint", "reset", "pause", "resume", "round"]]
        }
    }

    private func fighter(named: String) -> SKSpriteNode? {
        switch named.lowercased() {
        case "kong", "k":     return kong
        case "godzilla", "g", "gz": return godzilla
        default: return nil
        }
    }

    private func parseColor(_ name: String?) -> NSColor {
        if let name, let color = ScriptScene.parseColor(name) { return color }
        switch (name ?? "").lowercased() {
        case "red":    return NSColor(calibratedRed: 1, green: 0.2, blue: 0.1, alpha: 1)
        case "blue":   return NSColor(calibratedRed: 0.2, green: 0.4, blue: 1.0, alpha: 1)
        case "green":  return NSColor(calibratedRed: 0.1, green: 1.0, blue: 0.3, alpha: 1)
        case "yellow": return NSColor(calibratedRed: 1.0, green: 0.85, blue: 0.1, alpha: 1)
        case "purple": return NSColor(calibratedRed: 0.7, green: 0.2, blue: 1.0, alpha: 1)
        case "orange": return NSColor(calibratedRed: 1.0, green: 0.55, blue: 0.1, alpha: 1)
        case "white":  return .white
        default:       return NSColor(calibratedRed: 1.0, green: 0.5, blue: 0.1, alpha: 1)
        }
    }

    private func performPunch(attacker: String, emoji: String) {
        guard let who = fighter(named: attacker) else { return }
        let target: SKSpriteNode = (who === kong) ? godzilla : kong
        throwProjectile(from: who.position, to: target.position, emoji: emoji,
                        onHitColor: NSColor(calibratedRed: 1, green: 0.5, blue: 0, alpha: 1))
    }

    private func performBreatheFire(attacker: String, emoji: String) {
        guard let who = fighter(named: attacker) else { return }
        let target: SKSpriteNode = (who === kong) ? godzilla : kong
        throwProjectile(from: who.position, to: target.position, emoji: emoji,
                        onHitColor: NSColor(calibratedRed: 1, green: 0.2, blue: 0.05, alpha: 1))
    }

    private func performThrow(attacker: String, emoji: String) {
        guard let who = fighter(named: attacker) else { return }
        let target: SKSpriteNode = (who === kong) ? godzilla : kong
        throwProjectile(from: who.position, to: target.position, emoji: emoji,
                        onHitColor: NSColor(calibratedRed: 1, green: 1, blue: 0.2, alpha: 1))
    }

    private func performTaunt(who: String) {
        guard let t = fighter(named: who) else { return }
        let hop = SKAction.sequence([
            SKAction.moveBy(x: 0, y: 40, duration: 0.12),
            SKAction.moveBy(x: 0, y: -40, duration: 0.18)
        ])
        let tilt = SKAction.sequence([
            SKAction.rotate(byAngle: 0.25, duration: 0.15),
            SKAction.rotate(byAngle: -0.5, duration: 0.3),
            SKAction.rotate(byAngle: 0.25, duration: 0.15)
        ])
        t.run(.group([SKAction.sequence([hop, hop]), tilt]))

        let label = SKLabelNode(fontNamed: "Impact")
        label.text = "COME ON!"
        label.fontSize = 36
        label.fontColor = NSColor(calibratedRed: 1, green: 0.8, blue: 0.2, alpha: 1)
        label.position = CGPoint(x: t.position.x, y: t.position.y + 120)
        label.zPosition = 60
        addChild(label)
        label.setScale(0.5)
        label.run(.sequence([
            .group([.scale(to: 1.2, duration: 0.12), .fadeIn(withDuration: 0.05)]),
            .scale(to: 1.0, duration: 0.12),
            .wait(forDuration: 0.6),
            .fadeOut(withDuration: 0.3),
            .removeFromParent()
        ]))
    }

    private func performRoar(who: String, text: String) {
        guard let t = fighter(named: who) else { return }
        let scaleUp = SKAction.scale(to: 1.15, duration: 0.12)
        let scaleDown = SKAction.scale(to: 1.0, duration: 0.18)
        t.run(.sequence([scaleUp, scaleDown]))

        let label = SKLabelNode(fontNamed: "Impact")
        label.text = text
        label.fontSize = 56
        label.fontColor = NSColor(calibratedRed: 1, green: 0.3, blue: 0.1, alpha: 1)
        label.position = CGPoint(x: t.position.x, y: t.position.y + 140)
        label.zPosition = 60
        addChild(label)
        label.setScale(0.3)
        label.run(.sequence([
            .group([.scale(to: 1.4, duration: 0.15), .fadeIn(withDuration: 0.05)]),
            .scale(to: 1.0, duration: 0.2),
            .wait(forDuration: 0.8),
            .fadeOut(withDuration: 0.3),
            .removeFromParent()
        ]))
        // Add small sparks from the mouth direction
        spawnBurst(at: CGPoint(x: t.position.x + (t.xScale < 0 ? -60 : 60), y: t.position.y + 20),
                   emojis: ["💥", "✨"], count: 8, spread: 90, lifetime: 0.8)
    }

    private func performBow(who: String) {
        guard let t = fighter(named: who) else { return }
        let down = SKAction.rotate(byAngle: t.xScale < 0 ? -0.6 : 0.6, duration: 0.4)
        let up = down.reversed()
        t.run(.sequence([down, .wait(forDuration: 0.5), up]))
    }

    private func performJump(who: String, height: CGFloat) {
        guard let t = fighter(named: who) else { return }
        let up = SKAction.moveBy(x: 0, y: height, duration: 0.25)
        up.timingMode = .easeOut
        let down = SKAction.moveBy(x: 0, y: -height, duration: 0.3)
        down.timingMode = .easeIn
        t.run(.sequence([up, down]))
    }

    private func performKnockout(who: String) {
        guard let t = fighter(named: who) else { return }
        // Fall over
        let tilt = SKAction.rotate(byAngle: t.xScale < 0 ? -1.35 : 1.35, duration: 0.6)
        tilt.timingMode = .easeIn
        let drop = SKAction.moveBy(x: 0, y: -70, duration: 0.6)
        drop.timingMode = .easeIn
        t.run(.group([tilt, drop]))

        // KO banner
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
        // Confetti burst
        spawnBurst(at: CGPoint(x: size.width/2, y: size.height/2),
                   emojis: ["🎉", "🎊", "✨", "💥"], count: 40, spread: 400, lifetime: 1.6)
    }

    // MARK: - Emoji texture helper

    static func emojiTexture(_ emoji: String, pointSize: CGFloat) -> SKTexture? {
        let font = NSFont.systemFont(ofSize: pointSize)
        let attr: [NSAttributedString.Key: Any] = [.font: font]
        let str = NSAttributedString(string: emoji, attributes: attr)
        let measured = str.size()
        let pad: CGFloat = 12
        let size = NSSize(width: ceil(measured.width) + pad * 2, height: ceil(measured.height) + pad * 2)
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
}
