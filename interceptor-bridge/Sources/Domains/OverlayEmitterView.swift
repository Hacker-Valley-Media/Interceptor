import Foundation
import AppKit
import QuartzCore

// Transparent particle overlay using CAEmitterLayer — the same primitive
// FaceTime uses for reactions (see research/FaceTime/01_Feature_Catalog.md:494-527).
// Fully public API; transparent by construction because no WKWebView is involved.

final class OverlayEmitterView: NSView, OverlayControllable {
    var interactive: Bool = false
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { interactive }

    private let emitter = CAEmitterLayer()
    private var stopped = false
    private var paused = false
    private var burstGeneration = UUID()

    var nativeStatus: [String: Any] {
        ["paused": paused, "stopped": stopped, "density": cfg.density, "lifetime": cfg.lifetime,
         "direction": cfg.direction, "emojis": cfg.emojis, "scale": Double(cfg.sizeScale)]
    }

    var hasPendingNativeWork: Bool { false }

    func shutdown() {
        stopped = true
        paused = true
        burstGeneration = UUID()
        emitter.birthRate = 0
        emitter.emitterCells = nil
        emitter.removeAllAnimations()
        emitter.removeFromSuperlayer()
        layer?.removeAllAnimations()
    }

    // MARK: - OverlayControllable

    var supportedVerbs: [String] {
        ["set-density", "set-direction", "set-emojis", "set-lifetime", "set-velocity",
         "set-scale", "burst", "pause", "resume"]
    }

    @MainActor
    func perform(verb: String, args: [String: Any]) -> [String: Any] {
        guard !stopped else { return ["ok": false, "code": "target_gone", "error": "particle renderer retired"] }
        do { _ = try DesktopOverlayValidation.controlArgs(args, mode: "particles", verb: verb) }
        catch { return ["ok": false, "code": "invalid_request", "error": error.localizedDescription] }
        let density = verb == "set-density" ? (args["value"] as! NSNumber).doubleValue : cfg.density
        let lifetime = verb == "set-lifetime" ? (args["value"] as! NSNumber).doubleValue : Double(cfg.lifetime)
        guard density * lifetime <= 4096 else { return ["ok": false, "code": "resource_limit", "error": "live particle budget exceeded"] }
        let bump = (args["count"] as? NSNumber)?.doubleValue ?? 40
        if verb == "burst", cfg.density * bump > 512 { return ["ok": false, "code": "resource_limit", "error": "burst emission budget exceeded"] }
        burstGeneration = UUID()
        let generation = burstGeneration
        emitter.birthRate = paused ? 0 : 1
        switch verb {
        case "set-density":
            if let v = (args["value"] as? Double) ?? (args["value"] as? Int).map({ Double($0) }) {
                cfg = Config(emojis: cfg.emojis, direction: cfg.direction, density: v,
                             sizeRange: cfg.sizeRange, lifetime: cfg.lifetime, sway: cfg.sway,
                             velocity: cfg.velocity, sizeScale: cfg.sizeScale)
                rebuildCells()
                return ["ok": true, "density": v]
            }
            return ["ok": false, "error": "--value required"]

        case "set-direction":
            if let v = args["value"] as? String {
                cfg = Config(emojis: cfg.emojis, direction: v, density: cfg.density,
                             sizeRange: cfg.sizeRange, lifetime: cfg.lifetime, sway: cfg.sway,
                             velocity: cfg.velocity, sizeScale: cfg.sizeScale)
                rebuildCells(); relayoutEmitter()
                return ["ok": true, "direction": v]
            }
            return ["ok": false, "error": "--value required (down|up|left|right)"]

        case "set-emojis":
            var list: [String] = []
            if let l = args["value"] as? [String] { list = l }
            else if let s = args["value"] as? String {
                list = s.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            }
            if list.isEmpty { return ["ok": false, "error": "--value must be a comma-separated emoji list"] }
            cfg = Config(emojis: list, direction: cfg.direction, density: cfg.density,
                         sizeRange: cfg.sizeRange, lifetime: cfg.lifetime, sway: cfg.sway,
                         velocity: cfg.velocity, sizeScale: cfg.sizeScale)
            rebuildCells()
            return ["ok": true, "emojis": list]

        case "set-lifetime":
            if let v = (args["value"] as? Double) ?? (args["value"] as? Int).map({ Double($0) }) {
                cfg = Config(emojis: cfg.emojis, direction: cfg.direction, density: cfg.density,
                             sizeRange: cfg.sizeRange, lifetime: Float(v), sway: cfg.sway,
                             velocity: cfg.velocity, sizeScale: cfg.sizeScale)
                rebuildCells()
                return ["ok": true, "lifetime": v]
            }
            return ["ok": false, "error": "--value required (seconds)"]

        case "set-velocity":
            let v = (args["value"] as? Double).map { CGFloat($0) } ?? (args["value"] as? Int).map { CGFloat($0) }
            cfg = Config(emojis: cfg.emojis, direction: cfg.direction, density: cfg.density,
                         sizeRange: cfg.sizeRange, lifetime: cfg.lifetime, sway: cfg.sway,
                         velocity: v, sizeScale: cfg.sizeScale)
            rebuildCells()
            return ["ok": true, "velocity": v.map { Double($0) as Any } ?? NSNull()]

        case "set-scale":
            if let v = (args["value"] as? Double) ?? (args["value"] as? Int).map({ Double($0) }) {
                cfg = Config(emojis: cfg.emojis, direction: cfg.direction, density: cfg.density,
                             sizeRange: cfg.sizeRange, lifetime: cfg.lifetime, sway: cfg.sway,
                             velocity: cfg.velocity, sizeScale: CGFloat(v))
                rebuildCells()
                return ["ok": true, "scale": v]
            }
            return ["ok": false, "error": "--value required"]

        case "burst":
            // Temporarily crank density, then restore
            guard !paused else { return ["ok": false, "code": "resource_busy", "error": "particle renderer is paused"] }
            let originalRate = emitter.birthRate
            emitter.birthRate = max(1.0, Float(bump))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                guard let self, !self.stopped, !self.paused, self.burstGeneration == generation else { return }
                self.emitter.birthRate = originalRate
            }
            return ["ok": true, "burst": bump]

        case "pause":
            paused = true
            emitter.birthRate = 0
            return ["ok": true]

        case "resume":
            paused = false
            emitter.birthRate = 1
            return ["ok": true]

        default:
            return ["ok": false, "error": "unknown verb: \(verb)", "verbs": supportedVerbs]
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer = CALayer()
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.addSublayer(emitter)
        emitter.frame = bounds
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { false }

    override func layout() {
        super.layout()
        emitter.frame = bounds
        relayoutEmitter()
    }

    // MARK: - Configuration

    struct Config {
        let emojis: [String]
        let direction: String   // "down" | "up" | "left" | "right"
        let density: Double     // particles / second total across all cells
        let sizeRange: ClosedRange<CGFloat>
        let lifetime: Float
        let sway: Bool
        var velocity: CGFloat? = nil    // override preset velocity when set
        var sizeScale: CGFloat = 1.0    // multiplier applied to sizeRange
    }

    private var cfg: Config = Config(
        emojis: ["🌹"],
        direction: "down",
        density: 6,
        sizeRange: 28...52,
        lifetime: 8,
        sway: true
    )

    func apply(_ newCfg: Config) {
        cfg = newCfg
        rebuildCells()
        relayoutEmitter()
    }

    // MARK: - Presets

    static func preset(_ name: String, customEmojis: [String]?, density: Double?, direction: String?,
                       lifetime: Float? = nil, velocity: CGFloat? = nil, sizeScale: CGFloat = 1.0) -> Config {
        let dir = direction ?? defaultDirection(for: name)
        var cfg: Config
        switch name {
        case "hearts":
            cfg = Config(emojis: customEmojis ?? ["❤️", "💖", "💗", "💓", "💘", "✨"],
                         direction: dir, density: density ?? 5,
                         sizeRange: 20...40, lifetime: lifetime ?? 6, sway: true)
        case "petals":
            cfg = Config(emojis: customEmojis ?? ["🌸", "🌺", "🌷"],
                         direction: dir, density: density ?? 8,
                         sizeRange: 18...34, lifetime: lifetime ?? 9, sway: true)
        case "stars":
            cfg = Config(emojis: customEmojis ?? ["✨", "⭐️", "🌟", "💫"],
                         direction: dir, density: density ?? 10,
                         sizeRange: 14...28, lifetime: lifetime ?? 4, sway: false)
        case "snow":
            cfg = Config(emojis: customEmojis ?? ["❄️", "❅", "❆"],
                         direction: dir, density: density ?? 12,
                         sizeRange: 14...24, lifetime: lifetime ?? 10, sway: true)
        case "confetti":
            cfg = Config(emojis: customEmojis ?? ["🎉", "🎊", "🎈", "✨", "🌟"],
                         direction: dir, density: density ?? 14,
                         sizeRange: 16...32, lifetime: lifetime ?? 5, sway: true)
        case "titans":
            // Godzilla vs Kong — huge emoji, slow walk across the rect
            cfg = Config(emojis: customEmojis ?? ["🦖", "🦍"],
                         direction: dir, density: density ?? 0.8,
                         sizeRange: 90...140, lifetime: lifetime ?? 22, sway: false)
        case "fire":
            cfg = Config(emojis: customEmojis ?? ["🔥", "💥", "🌋", "💨"],
                         direction: dir, density: density ?? 16,
                         sizeRange: 40...80, lifetime: lifetime ?? 3, sway: true)
        case "beams":
            cfg = Config(emojis: customEmojis ?? ["⚡", "💫", "✨", "💥"],
                         direction: dir, density: density ?? 10,
                         sizeRange: 26...50, lifetime: lifetime ?? 2, sway: false)
        case "custom":
            cfg = Config(emojis: (customEmojis?.isEmpty == false ? customEmojis! : ["🌹"]),
                         direction: dir, density: density ?? 6,
                         sizeRange: 22...42, lifetime: lifetime ?? 8, sway: true)
        case "roses": fallthrough
        default:
            cfg = Config(emojis: customEmojis ?? ["🌹", "🌺", "🌸", "💐", "🌷", "💖"],
                         direction: dir, density: density ?? 6,
                         sizeRange: 24...48, lifetime: lifetime ?? 8, sway: true)
        }
        cfg.velocity = velocity
        cfg.sizeScale = sizeScale
        return cfg
    }

    private static func defaultDirection(for preset: String) -> String {
        switch preset {
        case "hearts": return "up"
        case "stars", "confetti": return "down"
        default: return "down"
        }
    }

    // MARK: - Cell construction

    private func rebuildCells() {
        let perEmojiRate = Float(cfg.density / Double(max(cfg.emojis.count, 1)))
        let cells: [CAEmitterCell] = cfg.emojis.compactMap { emoji in
            guard let img = Self.renderEmoji(emoji, pointSize: 64) else { return nil }
            return makeCell(contents: img, birthRate: perEmojiRate)
        }
        emitter.emitterCells = cells
    }

    private func makeCell(contents: CGImage, birthRate: Float) -> CAEmitterCell {
        let cell = CAEmitterCell()
        cell.contents = contents
        cell.birthRate = birthRate
        cell.lifetime = cfg.lifetime
        cell.lifetimeRange = cfg.lifetime * 0.3

        // Scale — emoji are rendered at 64pt; scale down to requested size range.
        let base: CGFloat = 64
        let minScale = (cfg.sizeRange.lowerBound * cfg.sizeScale) / base
        let maxScale = (cfg.sizeRange.upperBound * cfg.sizeScale) / base
        let mid = (minScale + maxScale) / 2
        let range = (maxScale - minScale) / 2
        cell.scale = mid
        cell.scaleRange = range

        cell.alphaSpeed = -1.0 / cfg.lifetime    // fade over lifetime
        cell.alphaRange = 0.25

        // Direction & motion
        let vel = cfg.velocity
        switch cfg.direction {
        case "up":
            cell.emissionLongitude = -.pi / 2   // upward in unflipped CALayer coords
            cell.velocity = vel ?? 70; cell.velocityRange = 30
            cell.yAcceleration = 0
        case "left":
            cell.emissionLongitude = .pi
            cell.velocity = vel ?? 80; cell.velocityRange = 20
        case "right":
            cell.emissionLongitude = 0
            cell.velocity = vel ?? 80; cell.velocityRange = 20
        default: // "down"
            cell.emissionLongitude = 0
            cell.velocity = vel ?? 0
            cell.velocityRange = 20
            cell.yAcceleration = -60   // negative Y in unflipped = downward visually
        }
        if cfg.sway {
            cell.emissionRange = cfg.direction == "up" || cfg.direction == "down" ? 0.3 : 0.2
            cell.xAcceleration = 0
            cell.spin = 0.6
            cell.spinRange = 1.2
        }
        return cell
    }

    // MARK: - Layout

    private func relayoutEmitter() {
        let w = bounds.width
        let h = bounds.height
        switch cfg.direction {
        case "up":
            // emit from bottom edge, line shape
            emitter.emitterShape = .line
            emitter.emitterPosition = CGPoint(x: w/2, y: 0)
            emitter.emitterSize = CGSize(width: w, height: 1)
        case "left":
            emitter.emitterShape = .line
            emitter.emitterPosition = CGPoint(x: w, y: h/2)
            emitter.emitterSize = CGSize(width: 1, height: h)
        case "right":
            emitter.emitterShape = .line
            emitter.emitterPosition = CGPoint(x: 0, y: h/2)
            emitter.emitterSize = CGSize(width: 1, height: h)
        default: // "down"
            // emit from top edge (high Y in unflipped coords)
            emitter.emitterShape = .line
            emitter.emitterPosition = CGPoint(x: w/2, y: h)
            emitter.emitterSize = CGSize(width: w, height: 1)
        }
        emitter.renderMode = .unordered
    }

    // MARK: - Emoji → CGImage

    private static func renderEmoji(_ emoji: String, pointSize: CGFloat) -> CGImage? {
        let font = NSFont.systemFont(ofSize: pointSize)
        let attr: [NSAttributedString.Key: Any] = [.font: font]
        let str = NSAttributedString(string: emoji, attributes: attr)
        let measured = str.size()
        // Pad so glyph shadow/anti-alias doesn't clip.
        let pad: CGFloat = 6
        let size = NSSize(width: ceil(measured.width) + pad * 2, height: ceil(measured.height) + pad * 2)
        let img = NSImage(size: size)
        img.lockFocus()
        NSColor.clear.setFill()
        NSRect(origin: .zero, size: size).fill()
        str.draw(at: NSPoint(x: pad, y: pad))
        img.unlockFocus()
        var rect = NSRect(origin: .zero, size: size)
        return img.cgImage(forProposedRect: &rect, context: nil, hints: nil)
    }
}
