import Foundation
import AppKit
import WebKit

// Transparent, topmost, click-through NSPanel hosting a WKWebView.

final class OverlayPanel: NSPanel {
    var interactive: Bool = false

    override var canBecomeKey: Bool { interactive }
    override var canBecomeMain: Bool { false }
}

final class OverlayContentView: NSView {
    var interactive: Bool = false
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { interactive }
}

@MainActor
struct OverlayContext {
    let id: String
    let generation: UUID
    let panel: OverlayPanel
    let webView: WKWebView?                     // mode == "html"
    let emitterView: OverlayEmitterView?        // mode == "particles"
    let sceneView: OverlaySceneTitansView?      // mode == "scene" (hardcoded titans)
    let scriptView: OverlaySceneScriptView?     // mode == "scene-script" (dynamic)
    let mode: String                            // "html" | "particles" | "scene" | "scene-script"
    let levelName: String
    let interactive: Bool
    let source: String
    let createdAt: Date
    let displayID: CGDirectDisplayID
}

final class OverlayDomain: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var overlays: [String: OverlayContext] = [:]
    private var panicMonitor: Any?
    private var screenMonitor: NSObjectProtocol?
    private var retiring: [UUID: OverlayContext] = [:]
    private var evaluations: [UUID: PendingEvaluation] = [:]
    private var evaluationOwners: [UUID: UUID] = [:]
    private var retirementScheduled = false

    private struct PendingEvaluation {
        let owner: UUID
        let completion: @Sendable ([String: Any]) -> Void
    }

    init() {
        // Install global panic kill-switch: Ctrl+Option+Cmd+Escape closes every overlay.
        // NSEvent.addGlobalMonitorForEvents observes keys system-wide without consuming them,
        // so this never interferes with other shortcuts.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.panicMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
                let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                let required: NSEvent.ModifierFlags = [.control, .option, .command]
                if flags == required && event.keyCode == 53 /* Escape */ {
                    self?.panicCloseAll()
                }
            }
            Platform.log("overlay panic hotkey installed: Ctrl+Option+Cmd+Escape")
            self.screenMonitor = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
                DispatchQueue.main.async { [weak self] in self?.pruneDisconnectedDisplays() }
            }
        }
    }

    deinit {
        let owners = UncheckedSendableBox(Array(overlays.values) + Array(retiring.values))
        let monitors = UncheckedSendableBox((panicMonitor, screenMonitor))
        for pending in evaluations.values { pending.completion(WireFormat.failure("provider_failed", "overlay provider retired before native evaluation finished")) }
        DispatchQueue.main.async {
            if let token = monitors.value.0 { NSEvent.removeMonitor(token) }
            if let token = monitors.value.1 { NotificationCenter.default.removeObserver(token) }
            for ctx in owners.value {
                Self.controller(ctx)?.shutdown()
                ctx.webView?.stopLoading()
                ctx.panel.orderOut(nil)
                ctx.panel.close()
                ctx.panel.contentView = nil
            }
        }
    }

    private func panicCloseAll() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let all = Array(self.overlays.values)
            self.overlays.removeAll()
            self.lock.unlock()
            if all.isEmpty { return }
            for ctx in all {
                self.retire(ctx)
            }
            Platform.log("overlay PANIC closed \(all.count) overlay(s) via Ctrl+Option+Cmd+Escape")
            Platform.emitEvent("overlay_panic_closed")
        }
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        if let error = DesktopOverlayValidation.validationError(action, sub: sub) {
            completion(WireFormat.failure("invalid_request", error)); return
        }
        var prepared = action
        do {
            if let raw = action["scene_script"] as? String {
                guard let json = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { throw DesktopOverlayValidation.invalid("scene script requires an object") }
                if let error = DesktopOverlayValidation.scriptError(json) { throw DesktopOverlayValidation.invalid(error) }
                prepared["_resolved_script"] = json
            } else if let path = action["scene_script_file"] as? String {
                let json = try DesktopOverlayValidation.readScript(path)
                if let error = DesktopOverlayValidation.scriptError(json) { throw DesktopOverlayValidation.invalid(error) }
                prepared["_resolved_script"] = json
            }
        } catch {
            completion(WireFormat.failure("invalid_request", error.localizedDescription)); return
        }
        let box = UncheckedSendableBox(prepared)
        DispatchQueue.main.async { [weak self] in
            guard let self else { completion(WireFormat.failure("provider_failed", "overlay provider shut down before dispatch")); return }
            switch sub {
            case "start": self.startOverlay(box.value, completion: completion)
            case "stop": self.stopOverlay(box.value, completion: completion)
            case "eval": self.evalOverlay(box.value, completion: completion)
            case "ctl": self.ctlOverlay(box.value, completion: completion)
            case "verbs": self.verbsOverlay(box.value, completion: completion)
            case "status": self.statusOverlay(box.value, completion: completion)
            case "list": self.listOverlays(completion: completion)
            default: self.notImplemented(command, completion: completion)
            }
        }
    }

    // MARK: - start

    @MainActor
    private func startOverlay(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let id = (action["id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? UUID().uuidString.prefix(8).lowercased().description

        lock.lock()
        if overlays[id] != nil {
            lock.unlock()
            completion(WireFormat.failure("resource_limit", "overlay id already in use: \(id)"))
            return
        }
        lock.unlock()
        reapRetiring()
        guard overlays.count + retiring.count < 16 else { completion(WireFormat.failure("resource_limit", "overlay native ownership limit reached")); return }
        let generation = UUID()

        let levelName = (action["level"] as? String) ?? "statusBar"
        let interactive = (action["interactive"] as? Bool) ?? false
        let singleSpace = (action["single_space"] as? Bool) ?? false
        let noFullscreenAux = (action["no_fullscreen_aux"] as? Bool) ?? false
        let timeoutSec: Double? = (action["timeout_seconds"] as? Double)
            ?? (action["timeout_seconds"] as? Int).map { Double($0) }

        // Mode routing. Particles (native CAEmitterLayer) is the transparent path;
        // HTML (WKWebView) is the interactive path but renders opaque on macOS 15+.
        let mode: String
        let source: String
        let loadKind: LoadKind?
        let particlesPreset: String?
        let customEmojis: [String]?
        let particleDensity: Double?
        let particleDirection: String?
        let particleLifetime: Float?
        let particleVelocity: CGFloat?
        let particleSizeScale: CGFloat

        let scenePreset = action["scene"] as? String
        let sceneScriptJson = action["_resolved_script"] as? [String: Any]

        if sceneScriptJson != nil {
            mode = "scene-script"
            source = "scene-script"
            loadKind = nil
            particlesPreset = nil; customEmojis = nil; particleDensity = nil; particleDirection = nil
            particleLifetime = nil; particleVelocity = nil; particleSizeScale = 1.0
        } else if let sp = scenePreset, !sp.isEmpty {
            mode = "scene"
            source = "scene:" + sp
            loadKind = nil
            particlesPreset = nil; customEmojis = nil; particleDensity = nil; particleDirection = nil
            particleLifetime = nil; particleVelocity = nil; particleSizeScale = 1.0
        } else if let preset = action["particles"] as? String, !preset.isEmpty {
            mode = "particles"
            source = "particles:" + preset
            loadKind = nil
            particlesPreset = preset
            if let list = action["emojis"] as? [String] { customEmojis = list }
            else if let str = action["emojis"] as? String {
                customEmojis = str.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            } else { customEmojis = nil }
            particleDensity = (action["density"] as? Double) ?? (action["density"] as? Int).map { Double($0) }
            particleDirection = action["direction"] as? String
            particleLifetime = (action["lifetime"] as? Double).map { Float($0) }
                ?? (action["lifetime"] as? Int).map { Float($0) }
            particleVelocity = (action["velocity"] as? Double).map { CGFloat($0) }
                ?? (action["velocity"] as? Int).map { CGFloat($0) }
            particleSizeScale = (action["size_scale"] as? Double).map { CGFloat($0) }
                ?? (action["size_scale"] as? Int).map { CGFloat($0) }
                ?? 1.0
        } else if let b64 = action["html_b64"] as? String, let data = Data(base64Encoded: b64),
           let html = String(data: data, encoding: .utf8) {
            mode = "html"
            source = (action["source"] as? String) ?? "html"
            loadKind = .html(html)
            particlesPreset = nil; customEmojis = nil; particleDensity = nil; particleDirection = nil
            particleLifetime = nil; particleVelocity = nil; particleSizeScale = 1.0
        } else if let urlStr = action["url"] as? String, let url = URL(string: urlStr) {
            mode = "html"
            source = "url"
            loadKind = .url(url)
            particlesPreset = nil; customEmojis = nil; particleDensity = nil; particleDirection = nil
            particleLifetime = nil; particleVelocity = nil; particleSizeScale = 1.0
        } else {
            completion(WireFormat.error("overlay start requires --particles <preset>, --html <file>, --url <URL>, or --inline"))
            return
        }

        // Resolve target screen
        let requestedDisplay = action["display_id"] as? UInt32 ?? 0
        let screen: NSScreen
        if requestedDisplay != 0 {
            guard let match = NSScreen.screens.first(where: {
                ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == requestedDisplay
            }) else { completion(WireFormat.failure("target_gone", "requested overlay display is unavailable")); return }
            screen = match
        } else if let main = NSScreen.main {
            screen = main
        } else if let first = NSScreen.screens.first {
            screen = first
        } else {
            completion(WireFormat.error("no NSScreen available"))
            return
        }
        // --visible uses the screen's visibleFrame (menu bar + Dock excluded automatically).
        let useVisible = (action["visible"] as? Bool) ?? false
        let screenFrame = useVisible ? screen.visibleFrame : screen.frame
        let screenNumber = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0

        // Explicit rectangle overrides full-screen. rect = { x, y, width, height } in screen coords.
        // Corner presets via `anchor` for convenience: "tl", "tr", "bl", "br", "top", "bottom", "right", "left".
        let frame: NSRect
        if let rect = action["rect"] as? [String: Any],
           let w = (rect["width"] as? Int).map({ CGFloat($0) }) ?? (rect["width"] as? Double).map({ CGFloat($0) }),
           let h = (rect["height"] as? Int).map({ CGFloat($0) }) ?? (rect["height"] as? Double).map({ CGFloat($0) }) {
            let x = (rect["x"] as? Int).map({ CGFloat($0) }) ?? (rect["x"] as? Double).map({ CGFloat($0) }) ?? screenFrame.origin.x
            let y = (rect["y"] as? Int).map({ CGFloat($0) }) ?? (rect["y"] as? Double).map({ CGFloat($0) }) ?? screenFrame.origin.y
            frame = NSRect(x: x, y: y, width: w, height: h)
        } else if let anchor = action["anchor"] as? String {
            let w = (action["width"] as? Int).map({ CGFloat($0) }) ?? (action["width"] as? Double).map({ CGFloat($0) }) ?? 360
            let h = (action["height"] as? Int).map({ CGFloat($0) }) ?? (action["height"] as? Double).map({ CGFloat($0) }) ?? 200
            let margin: CGFloat = 24
            var x = screenFrame.origin.x + margin
            var y = screenFrame.origin.y + margin
            switch anchor {
            case "tl": x = screenFrame.minX + margin;                    y = screenFrame.maxY - h - margin
            case "tr": x = screenFrame.maxX - w - margin;                y = screenFrame.maxY - h - margin
            case "bl": x = screenFrame.minX + margin;                    y = screenFrame.minY + margin
            case "br": x = screenFrame.maxX - w - margin;                y = screenFrame.minY + margin
            case "top":    x = screenFrame.midX - w/2;                   y = screenFrame.maxY - h - margin
            case "bottom": x = screenFrame.midX - w/2;                   y = screenFrame.minY + margin
            case "right":  x = screenFrame.maxX - w - margin;            y = screenFrame.midY - h/2
            case "left":   x = screenFrame.minX + margin;                y = screenFrame.midY - h/2
            case "center": x = screenFrame.midX - w/2;                   y = screenFrame.midY - h/2
            default: break
            }
            frame = NSRect(x: x, y: y, width: w, height: h)
        } else {
            frame = screenFrame
        }

        guard screenNumber != 0, [frame.minX, frame.minY, frame.width, frame.height].allSatisfy({ $0.isFinite }),
              abs(frame.minX) <= 131072, abs(frame.minY) <= 131072,
              frame.width >= 1, frame.height >= 1, frame.width <= 16384, frame.height <= 16384,
              frame.width * frame.height <= 67108864 else {
            completion(WireFormat.failure("invalid_request", "overlay frame exceeds native geometry bounds")); return
        }
        guard screen.frame.intersects(frame) else { completion(WireFormat.failure("invalid_request", "overlay rectangle does not intersect its selected display")); return }
        let ownedArea = (Array(overlays.values) + Array(retiring.values)).reduce(0.0) { total, ctx in
            total + Double(ctx.panel.frame.width * ctx.panel.frame.height) * pow(Double(ctx.panel.backingScaleFactor), 2)
        }
        guard ownedArea + Double(frame.width * frame.height) * pow(Double(screen.backingScaleFactor), 2) <= 67108864 else {
            completion(WireFormat.failure("resource_limit", "aggregate overlay backing-pixel budget exceeded")); return
        }
        let emitterConfig = particlesPreset.map { OverlayEmitterView.preset($0, customEmojis: customEmojis, density: particleDensity, direction: particleDirection, lifetime: particleLifetime, velocity: particleVelocity, sizeScale: particleSizeScale) }
        if let cfg = emitterConfig, cfg.density * Double(cfg.lifetime) > 4096 {
            completion(WireFormat.failure("resource_limit", "particle density and lifetime exceed the live particle budget")); return
        }

            let panel = OverlayPanel(
                contentRect: frame,
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            panel.interactive = interactive
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.ignoresMouseEvents = !interactive
            panel.isMovable = false
            panel.isReleasedWhenClosed = false
            panel.hidesOnDeactivate = false

            panel.level = Self.resolveLevel(levelName)
            if levelName == "screenSaver" {
                Platform.log("overlay \(id): using .screenSaver level — window server may cap this for accessory apps")
            }

            var behavior: NSWindow.CollectionBehavior = [.ignoresCycle]
            if !singleSpace {
                behavior.insert(.canJoinAllSpaces)
            }
            if #available(macOS 13.0, *) {
                behavior.insert(.canJoinAllApplications)
            }
            if !noFullscreenAux {
                behavior.insert(.fullScreenAuxiliary)
            }
            panel.collectionBehavior = behavior

            // Container view — transparent, click-through receiver
            let container = OverlayContentView(frame: panel.contentView?.bounds ?? NSRect(origin: .zero, size: frame.size))
            container.interactive = interactive
            container.autoresizingMask = [.width, .height]
            container.wantsLayer = true
            container.layer?.backgroundColor = NSColor.clear.cgColor
            panel.contentView = container

            var webView: WKWebView? = nil
            var emitterView: OverlayEmitterView? = nil
            var sceneView: OverlaySceneTitansView? = nil
            var scriptView: OverlaySceneScriptView? = nil

            if mode == "scene-script", let json = sceneScriptJson {
                let sv = OverlaySceneScriptView(frame: NSRect(origin: .zero, size: frame.size))
                sv.captureDisplayID = screenNumber
                sv.interactive = interactive
                sv.autoresizingMask = [.width, .height]
                container.addSubview(sv)
                sv.loadScript(json)
                if let error = sv.nativeStatus["lastError"] as? String {
                    sv.shutdown()
                    panel.close()
                    completion(WireFormat.failure("provider_failed", error)); return
                }
                scriptView = sv
                Platform.log("overlay \(id): scene-script loaded (\((json["entities"] as? [[String:Any]])?.count ?? 0) entities, \((json["timeline"] as? [[String:Any]])?.count ?? 0) ops)")
            } else if mode == "scene" {
                // Currently the only scene preset is "titans" (Godzilla vs Kong).
                let sv = OverlaySceneTitansView(frame: NSRect(origin: .zero, size: frame.size))
                sv.interactive = interactive
                sv.autoresizingMask = [.width, .height]
                container.addSubview(sv)
                sceneView = sv
                Platform.log("overlay \(id): scene preset=\(scenePreset ?? "titans")")
            } else if mode == "particles", let preset = particlesPreset {
                // Native CAEmitterLayer — transparent by construction.
                let ev = OverlayEmitterView(frame: NSRect(origin: .zero, size: frame.size))
                ev.interactive = interactive
                ev.autoresizingMask = [.width, .height]
                if let emitterConfig { ev.apply(emitterConfig) }
                container.addSubview(ev)
                emitterView = ev
                Platform.log("overlay \(id): particles preset=\(preset) density=\(particleDensity ?? -1)")
            } else if let kind = loadKind {
                // WKWebView path (opaque on macOS 15+, use for interactive HUDs/tooltips).
                // Three-layer transparency best-effort (see R1).
                let config = WKWebViewConfiguration()
                config.suppressesIncrementalRendering = false
                let w = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: config)
                w.autoresizingMask = [.width, .height]
                let drawsBgSel = NSSelectorFromString("setDrawsBackground:")
                if w.responds(to: drawsBgSel) { w.setValue(false, forKey: "drawsBackground") }
                if #available(macOS 13.0, *) { w.underPageBackgroundColor = .clear }
                w.wantsLayer = true
                w.layer?.backgroundColor = NSColor.clear.cgColor
                w.layer?.isOpaque = false
                container.addSubview(w)
                webView = w

                switch kind {
                case .html(let html): w.loadHTMLString(html, baseURL: nil)
                case .url(let url):   w.load(URLRequest(url: url))
                }
            }

            panel.orderFrontRegardless()
            let actualDisplay = (panel.screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
            guard actualDisplay == screenNumber else {
                scriptView?.shutdown(); sceneView?.shutdown(); emitterView?.shutdown(); webView?.stopLoading()
                panel.orderOut(nil); panel.close()
                completion(WireFormat.failure("target_gone", "native panel did not bind to its selected display")); return
            }

            let ctx = OverlayContext(
                id: id,
                generation: generation,
                panel: panel,
                webView: webView,
                emitterView: emitterView,
                sceneView: sceneView,
                scriptView: scriptView,
                mode: mode,
                levelName: levelName,
                interactive: interactive,
                source: source,
                createdAt: Date(),
                displayID: screenNumber
            )
            self.lock.lock()
            self.overlays[id] = ctx
            self.lock.unlock()

            Platform.log("overlay \(id) started: level=\(levelName) interactive=\(interactive) source=\(source) frame=\(Int(frame.width))x\(Int(frame.height))")

            // Optional auto-teardown timer.
            if let timeout = timeoutSec, timeout > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                    guard let self = self else { return }
                    self.lock.lock()
                    let ctx = self.overlays[id]?.generation == generation ? self.overlays.removeValue(forKey: id) : nil
                    self.lock.unlock()
                    if let ctx = ctx {
                        self.retire(ctx)
                        Platform.log("overlay \(id) auto-closed after \(timeout)s timeout")
                    }
                }
                Platform.log("overlay \(id) auto-timeout scheduled for \(timeout)s")
            }

            completion(WireFormat.success([
                "id": id,
                "generation": generation.uuidString,
                "mode": mode,
                "level": levelName,
                "interactive": interactive,
                "source": source,
                "displayID": screenNumber,
                "frame": [
                    "x": Double(panel.frame.origin.x),
                    "y": Double(panel.frame.origin.y),
                    "width": Double(panel.frame.width),
                    "height": Double(panel.frame.height)
                ]
            ]))
    }

    // MARK: - stop

    @MainActor
    private func stopOverlay(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let id = action["id"] as? String
        let targets: [OverlayContext]
        if let id {
            targets = overlays[id].map { [$0] } ?? retiring.values.filter { $0.id == id }
            overlays.removeValue(forKey: id)
        } else {
            targets = Array(overlays.values) + Array(retiring.values)
            overlays.removeAll()
        }
        guard id == nil || !targets.isEmpty else { completion(WireFormat.failure("target_gone", "overlay not found")); return }
        for ctx in targets { retire(ctx) }
        awaitRetirement(targets, deadline: ContinuousClock.now.advanced(by: .seconds(10)), completion: completion)
    }

    @MainActor
    private func awaitRetirement(_ targets: [OverlayContext], deadline: ContinuousClock.Instant, completion: @escaping @Sendable ([String: Any]) -> Void) {
        reapRetiring()
        let pending = targets.filter { nativePending($0) }
        let ids = Array(Set(targets.map { $0.id })).sorted()
        if pending.isEmpty {
            completion(WireFormat.success(["stopped": ids, "nativeCleanupPending": []])); return
        }
        if ContinuousClock.now >= deadline {
            completion(WireFormat.failure("outcome_unknown", "overlay panels closed; native work has not acknowledged retirement", details: ["closed": ids, "nativeCleanupPending": pending.map { $0.generation.uuidString }]))
            return
        }
        let box = UncheckedSendableBox(targets)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self else { completion(WireFormat.failure("provider_failed", "overlay provider shut down during retirement")); return }
            self.awaitRetirement(box.value, deadline: deadline, completion: completion)
        }
    }

    // MARK: - eval

    @MainActor
    private func evalOverlay(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let target = target(action), let webView = target.webView else {
            completion(WireFormat.failure("unsupported_target", "eval requires one exact live HTML overlay")); return
        }
        guard !evaluationOwners.values.contains(target.generation) else {
            completion(WireFormat.failure("resource_busy", "native evaluation is still owned by this overlay; do not replay")); return
        }
        let js = (action["js"] ?? action["javascript"]) as! String
        let ticket = UUID()
        evaluations[ticket] = PendingEvaluation(owner: target.generation, completion: completion)
        evaluationOwners[ticket] = target.generation
        let timeout = (action["timeout_seconds"] as? NSNumber)?.doubleValue ?? 10
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self, let pending = self.evaluations.removeValue(forKey: ticket) else { return }
            pending.completion(WireFormat.failure("outcome_unknown", "native JavaScript did not finish before its deadline; evaluation ownership is retained"))
        }
        webView.evaluateJavaScript(js) { [weak self] result, error in
            guard let self else { return }
            self.evaluationOwners.removeValue(forKey: ticket)
            defer { self.reapRetiring() }
            guard let pending = self.evaluations.removeValue(forKey: ticket) else { return }
            guard self.overlays[target.id]?.generation == pending.owner else {
                pending.completion(WireFormat.failure("target_gone", "overlay generation retired before evaluation finished")); return
            }
            if let error {
                pending.completion(WireFormat.failure("provider_failed", "native evaluation failed: " + error.localizedDescription)); return
            }
            let value = result ?? NSNull()
            if let error = DesktopOverlayValidation.jsonError(value, maxBytes: 131072) {
                pending.completion(WireFormat.failure("resource_limit", error)); return
            }
            pending.completion(WireFormat.success(["id": target.id, "generation": target.generation.uuidString, "result": value]))
        }
    }

    // MARK: - ctl / verbs

    @MainActor
    private func ctlOverlay(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let target = target(action), let c = Self.controller(target) else {
            completion(WireFormat.failure("unsupported_target", "ctl requires one exact live native overlay")); return
        }
        do {
            let raw: [String: Any]
            if let string = action["args"] as? String {
                guard let parsed = try JSONSerialization.jsonObject(with: Data(string.utf8)) as? [String: Any] else { throw DesktopOverlayValidation.invalid("control args require a JSON object") }
                raw = parsed
            } else { raw = (action["args"] as? [String: Any]) ?? [:] }
            let verb = action["verb"] as! String
            let args = try DesktopOverlayValidation.controlArgs(raw, mode: target.mode, verb: verb)
            let result = c.perform(verb: verb, args: args)
            if let error = DesktopOverlayValidation.jsonError(result, maxBytes: 131072) {
                completion(WireFormat.failure("resource_limit", error)); return
            }
            guard result["ok"] as? Bool == true else {
                completion(WireFormat.failure((result["code"] as? String) ?? "provider_failed", (result["error"] as? String) ?? "native overlay control failed", details: result)); return
            }
            completion(WireFormat.success(result))
        } catch { completion(WireFormat.failure("invalid_request", error.localizedDescription)) }
    }

    @MainActor
    private func verbsOverlay(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let ctx = target(action) else { completion(WireFormat.failure("target_gone", "select one exact live overlay")); return }
        completion(WireFormat.success(["id": ctx.id, "mode": ctx.mode, "verbs": Self.controller(ctx)?.supportedVerbs ?? []]))
    }

    @MainActor
    private func statusOverlay(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        reapRetiring()
        let id = action["id"] as? String
        let ctx = target(action) ?? (id.flatMap { id in retiring.values.first { $0.id == id } })
        guard let ctx else { completion(WireFormat.failure("target_gone", "select one exact owned overlay")); return }
        completion(WireFormat.success(describe(ctx)))
    }

    @MainActor
    private func listOverlays(completion: @escaping @Sendable ([String: Any]) -> Void) {
        reapRetiring()
        let all = Array(overlays.values) + Array(retiring.values)
        completion(WireFormat.success(all.sorted { $0.createdAt < $1.createdAt }.map { describe($0) }))
    }

    // MARK: - helpers

    private enum LoadKind { case html(String); case url(URL) }

    private static func resolveLevel(_ name: String) -> NSWindow.Level {
        switch name {
        case "statusBar": return .statusBar
        case "mainMenu": return NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 1)
        case "floating": return .floating
        case "screenSaver": return .screenSaver
        default: return .statusBar
        }
    }

    @MainActor
    private func target(_ action: [String: Any]) -> OverlayContext? {
        if let id = action["id"] as? String { return overlays[id] }
        return overlays.count == 1 ? overlays.values.first : nil
    }

    @MainActor
    private static func controller(_ ctx: OverlayContext) -> (any OverlayControllable)? {
        if let view = ctx.scriptView { return view }
        if let view = ctx.sceneView { return view }
        return ctx.emitterView
    }

    @MainActor
    private func nativePending(_ ctx: OverlayContext) -> Bool {
        (Self.controller(ctx)?.hasPendingNativeWork ?? false) || evaluationOwners.values.contains(ctx.generation)
    }

    @MainActor
    private func retire(_ ctx: OverlayContext) {
        guard retiring[ctx.generation] == nil else { return }
        // Retain the native owner until outstanding capture/evaluation callbacks return.
        retiring[ctx.generation] = ctx
        Self.controller(ctx)?.shutdown()
        ctx.webView?.stopLoading()
        ctx.panel.orderOut(nil)
        ctx.panel.close()
        let tickets = evaluations.filter { $0.value.owner == ctx.generation }.map { $0.key }
        for ticket in tickets {
            evaluations.removeValue(forKey: ticket)?.completion(WireFormat.failure("target_gone", "overlay retired while evaluation was in flight"))
        }
        reapRetiring()
    }

    @MainActor
    private func pruneDisconnectedDisplays() {
        let available = Set(NSScreen.screens.compactMap { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value })
        let gone = overlays.values.filter { !available.contains($0.displayID) }
        for ctx in gone { overlays.removeValue(forKey: ctx.id); retire(ctx) }
        if !gone.isEmpty { Platform.emitEvent("overlay_display_retired") }
    }

    @MainActor
    private func reapRetiring() {
        for (generation, ctx) in retiring where !nativePending(ctx) {
            ctx.panel.contentView = nil
            retiring.removeValue(forKey: generation)
        }
        guard !retiring.isEmpty, !retirementScheduled else { return }
        retirementScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self else { return }
            self.retirementScheduled = false
            self.reapRetiring()
        }
    }

    @MainActor
    private func describe(_ ctx: OverlayContext) -> [String: Any] {
        let frame = ctx.panel.frame
        return [
            "id": ctx.id, "generation": ctx.generation.uuidString, "mode": ctx.mode,
            "level": ctx.levelName, "interactive": ctx.interactive, "source": ctx.source,
            "displayID": ctx.displayID, "isVisible": ctx.panel.isVisible,
            "lifecycle": retiring[ctx.generation] == nil ? "running" : "retiring",
            "nativeCleanupPending": nativePending(ctx),
            "native": Self.controller(ctx)?.nativeStatus ?? [:],
            "createdAt": ISO8601DateFormatter().string(from: ctx.createdAt),
            "frame": ["x": Double(frame.origin.x), "y": Double(frame.origin.y), "width": Double(frame.width), "height": Double(frame.height)]
        ]
    }
}
