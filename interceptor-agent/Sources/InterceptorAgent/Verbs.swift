import Foundation
import ObjectiveC.runtime
import QuartzCore
import ApplicationServices
import Speech
import AVFoundation
import Contacts
import AgentJS
import Darwin
#if canImport(AppKit)
import AppKit
#endif

// Private libsystem API: TCC scopes by the RESPONSIBLE process. This returns the
// pid TCC holds responsible for `pid` — the process whose grants we actually
// inherit. (Qt/Vestbø "The Curious Case of the Responsible Process".)
@_silgen_name("responsibility_get_pid_responsible_for_pid")
func responsibility_get_pid_responsible_for_pid(_ pid: Int32) -> Int32

/// In-process verb implementations. These run on the main thread (AppKit access)
/// and act on the host app's OWN objects — which needs no TCC. Anything that
/// reaches out (other apps, screen of other windows, protected files) is
/// delegated to the bridge via `agent.delegate(...)`.
enum Verbs {
    static func handle(_ type: String, action: [String: Any], agent: InterceptorAgent) -> [String: Any] {
        switch type {
        case "native_ping":                        return ping(agent)
        case "native_tree", "tree", "get_state":   return tree(action, agent)
        case "native_eval", "evaluate":            return eval(action, agent)
        case "native_mutate":                      return mutate(action, agent)
        case "native_layers":                      return layers(action, agent)
        case "native_intercept":                   return intercept(action, agent)
        case "native_screenshot", "screenshot":    return screenshot(action, agent)
        case "native_watch":                       return watch(action, agent)
        case "native_net":                         return net(action, agent)
        case "native_net_log":                     return netLog(action, agent)
        case "native_net_bodies":                  return netBodies(action, agent)
        case "native_ax":                          return ax(action, agent)
        case "native_file":                        return fileRead(action, agent)
        case "native_tcc":                         return tccStatus(action, agent)
        case "native_draw":                        return draw(action, agent)
        case "native_js", "js":                    return js(action, agent)
        // Runtime Hook Fabric
        case "native_hook":                        return hookInstall(action, agent)
        case "native_unhook":                      return hookRemove(action, agent)
        case "native_hooks":                       return cresult(itc_hook_list())
        case "native_hook_log", "native_events":   return hookDrain(action, agent)
        case "native_trace":                       return trace(action, agent)
        case "native_untrace":                     return untrace(action, agent)
        case "native_cintercept":                  return cintercept(action, agent)
        case "native_dom_watch":                   return cresult(itc_dom_watch())
        case "native_domains":                     return domains(action, agent)
        default:                                   return JSONUtil.err("unknown native verb: \(type)")
        }
    }

    // MARK: ping

    static func ping(_ agent: InterceptorAgent) -> [String: Any] {
        return JSONUtil.ok([
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "app": agent.appName,
            "context": agent.contextId,
            "windows": NSApplication.shared.windows.count,
        ])
    }

    // MARK: tree / read — the view + runtime graph

    static func tree(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        let maxDepth = action["depth"] as? Int ?? 14
        let includeHidden = action["all"] as? Bool ?? false
        // Refs persist across reads (weak-backed) so a ref handed out by one tree
        // call stays valid for a later mutate/eval — only an explicit {reset:true}
        // clears them.
        if action["reset"] as? Bool == true { agent.refs.clear() }
        var windows: [[String: Any]] = []
        for w in NSApplication.shared.windows {
            if !w.isVisible && !includeHidden { continue }
            var win: [String: Any] = [
                "role": "window",
                "title": w.title,
                "ref": agent.refs.register(w),
                "frame": rectDict(w.frame),
                "key": w.isKeyWindow,
            ]
            if let content = w.contentView {
                win["content"] = nodeForView(content, depth: 0, maxDepth: maxDepth, agent: agent)
            }
            windows.append(win)
        }
        return JSONUtil.ok(["app": agent.appName, "windows": windows])
    }

    private static func nodeForView(_ view: NSView, depth: Int, maxDepth: Int, agent: InterceptorAgent) -> [String: Any] {
        var node: [String: Any] = [
            "class": String(describing: type(of: view)),
            "ref": agent.refs.register(view),
            "frame": rectDict(view.frame),
        ]
        if let text = readableText(view) { node["value"] = text }
        if view.isHidden { node["hidden"] = true }
        if depth < maxDepth && !view.subviews.isEmpty {
            node["children"] = view.subviews.map { nodeForView($0, depth: depth + 1, maxDepth: maxDepth, agent: agent) }
        }
        return node
    }

    /// Best-effort displayed text of a control/label/textview.
    static func readableText(_ obj: NSObject) -> String? {
        for sel in ["stringValue", "string", "title", "placeholderString"] {
            if obj.responds(to: Selector(sel)) {
                if let val = obj.value(forKey: sel) as? String, !val.isEmpty { return val }
            }
        }
        return nil
    }

    // MARK: eval — invoke a selector on a ref

    static func eval(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        guard let ref = action["ref"] as? String, let obj = agent.refs.resolve(ref) as? NSObject else {
            return JSONUtil.err("native_eval requires a valid ref (run native_tree first)")
        }
        guard let selName = action["selector"] as? String else {
            return JSONUtil.err("native_eval requires a selector")
        }
        let sel = Selector(selName)
        guard obj.responds(to: sel) else {
            return JSONUtil.err("\(type(of: obj)) does not respond to \(selName)")
        }
        // We must NOT blindly `perform(sel).takeUnretainedValue()` — that assumes an
        // OBJECT return. A selector that returns BOOL/Int/Double/struct would have its
        // primitive value retained as if it were a pointer (e.g. BOOL 1 → retain 0x1 →
        // SIGSEGV). Inspect the return type encoding and call through a correctly-typed
        // IMP so primitives are read safely. Object refs returned can be registered so
        // they're chainable (eval → mutate/eval on the result).
        guard let method = class_getInstanceMethod(type(of: obj) as AnyClass, sel) else {
            return JSONUtil.err("no instance method for \(selName)")
        }
        var retBuf = [Int8](repeating: 0, count: 256)
        method_getReturnType(method, &retBuf, 256)
        let enc = String(cString: retBuf)
        let imp = method_getImplementation(method)
        let argStr = action["arg"] as? String
        let hasArg = argStr != nil
        var result = "nil"
        var resultRef: String? = nil

        func objResult(_ v: Unmanaged<AnyObject>?) -> String {
            guard let any = v?.takeUnretainedValue() else { return "nil" }
            if let ns = any as? NSObject { resultRef = agent.refs.register(ns) }   // chainable
            return String(describing: any)
        }

        switch enc.first.map(String.init) ?? "v" {
        case "v":
            if hasArg { typealias F = @convention(c) (AnyObject, Selector, AnyObject) -> Void
                unsafeBitCast(imp, to: F.self)(obj, sel, argStr! as NSString) }
            else { typealias F = @convention(c) (AnyObject, Selector) -> Void
                unsafeBitCast(imp, to: F.self)(obj, sel) }
            result = "void"
        case "@", "#":
            result = hasArg ? objResult(obj.perform(sel, with: argStr)) : objResult(obj.perform(sel))
        case "c", "B":
            typealias F = @convention(c) (AnyObject, Selector) -> Bool
            result = String(unsafeBitCast(imp, to: F.self)(obj, sel))
        case "i", "s":
            typealias F = @convention(c) (AnyObject, Selector) -> Int32
            result = String(unsafeBitCast(imp, to: F.self)(obj, sel))
        case "q", "l":
            typealias F = @convention(c) (AnyObject, Selector) -> Int
            result = String(unsafeBitCast(imp, to: F.self)(obj, sel))
        case "I", "S":
            typealias F = @convention(c) (AnyObject, Selector) -> UInt32
            result = String(unsafeBitCast(imp, to: F.self)(obj, sel))
        case "Q", "L":
            typealias F = @convention(c) (AnyObject, Selector) -> UInt
            result = String(unsafeBitCast(imp, to: F.self)(obj, sel))
        case "f":
            typealias F = @convention(c) (AnyObject, Selector) -> Float
            result = String(unsafeBitCast(imp, to: F.self)(obj, sel))
        case "d":
            typealias F = @convention(c) (AnyObject, Selector) -> Double
            result = String(unsafeBitCast(imp, to: F.self)(obj, sel))
        case "{":
            if enc.hasPrefix("{CGRect") || enc.hasPrefix("{NSRect") {
                typealias F = @convention(c) (AnyObject, Selector) -> CGRect
                let r = unsafeBitCast(imp, to: F.self)(obj, sel)
                result = "{x:\(r.origin.x) y:\(r.origin.y) w:\(r.size.width) h:\(r.size.height)}"
            } else if enc.hasPrefix("{CGPoint") || enc.hasPrefix("{NSPoint") {
                typealias F = @convention(c) (AnyObject, Selector) -> CGPoint
                let p = unsafeBitCast(imp, to: F.self)(obj, sel); result = "{x:\(p.x) y:\(p.y)}"
            } else if enc.hasPrefix("{CGSize") || enc.hasPrefix("{NSSize") {
                typealias F = @convention(c) (AnyObject, Selector) -> CGSize
                let s = unsafeBitCast(imp, to: F.self)(obj, sel); result = "{w:\(s.width) h:\(s.height)}"
            } else {
                return JSONUtil.err("eval: unsupported struct return \(enc) for \(selName)")
            }
        default:
            return JSONUtil.err("eval: unsupported return type '\(enc)' for \(selName)")
        }

        var out: [String: Any] = ["ref": ref, "selector": selName, "returns": enc, "result": result]
        if let rr = resultRef { out["resultRef"] = rr }   // hand back a ref to chain on
        return JSONUtil.ok(out)
    }

    // MARK: mutate — visible in-process changes (text + alpha/hidden/layer-text/bg)

    static func mutate(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        guard let ref = action["ref"] as? String, let obj = agent.refs.resolve(ref) as? NSObject else {
            return JSONUtil.err("native_mutate requires a valid ref (run native_tree / native_layers first)")
        }
        var applied: [String] = []
        var detail: [String: Any] = ["class": String(describing: type(of: obj))]

        // set_text — standard AppKit controls (NSTextField/NSButton/NSTextView).
        if let text = action["set_text"] as? String {
            let a = setText(obj, text)
            applied += a
            detail["text"] = text
        }
        // set_layer_text — custom-drawn UIs that render text via
        // CATextLayer; rewrites every CATextLayer under the view's / layer's tree.
        if let lt = action["set_layer_text"] as? String {
            let n = setLayerText(obj, lt)
            if n > 0 { applied.append("layer.text×\(n)"); detail["layerText"] = lt }
        }
        // set_alpha — translucency. Dramatic and safe (no view removal).
        if let alpha = numeric(action["set_alpha"]) {
            if let w = obj as? NSWindow { w.alphaValue = CGFloat(alpha); applied.append("window.alpha") }
            else if let v = obj as? NSView { v.alphaValue = CGFloat(alpha); applied.append("view.alpha") }
            detail["alpha"] = alpha
        }
        // set_hidden — hide/show a view.
        if let hidden = action["set_hidden"] as? Bool, let v = obj as? NSView {
            v.isHidden = hidden; applied.append("hidden=\(hidden)"); detail["hidden"] = hidden
        }
        // set_bg — recolor a view's layer background (#RRGGBB or #RRGGBBAA).
        if let hex = action["set_bg"] as? String, let color = colorFromHex(hex), let v = obj as? NSView {
            v.wantsLayer = true; v.layer?.backgroundColor = color.cgColor
            applied.append("bg=\(hex)"); detail["bg"] = hex
        }

        if applied.isEmpty {
            return JSONUtil.err("no mutation applied — pass one of set_text / set_layer_text / set_alpha / set_hidden / set_bg")
        }
        if let v = obj as? NSView { v.needsDisplay = true; v.window?.displayIfNeeded() }
        detail["applied"] = applied
        return JSONUtil.ok(detail)
    }

    /// Recursively rewrite every CATextLayer under a view's (or layer's) tree.
    static func setLayerText(_ obj: NSObject, _ text: String) -> Int {
        var count = 0
        func walk(_ layer: CALayer?) {
            guard let layer = layer else { return }
            if let tl = layer as? CATextLayer { tl.string = text; count += 1 }
            for s in layer.sublayers ?? [] { walk(s) }
        }
        if let tl = obj as? CATextLayer { tl.string = text; count += 1 }
        else if let v = obj as? NSView { v.wantsLayer = true; walk(v.layer) }
        else if let l = obj as? CALayer { walk(l) }
        return count
    }

    static func numeric(_ v: Any?) -> Double? {
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        if let s = v as? String { return Double(s) }
        if let n = v as? NSNumber { return n.doubleValue }
        return nil
    }

    static func colorFromHex(_ hex: String) -> NSColor? {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard let val = UInt64(s, radix: 16) else { return nil }
        let r, g, b, a: CGFloat
        if s.count == 8 {
            r = CGFloat((val >> 24) & 0xff) / 255; g = CGFloat((val >> 16) & 0xff) / 255
            b = CGFloat((val >> 8) & 0xff) / 255;  a = CGFloat(val & 0xff) / 255
        } else if s.count == 6 {
            r = CGFloat((val >> 16) & 0xff) / 255; g = CGFloat((val >> 8) & 0xff) / 255
            b = CGFloat(val & 0xff) / 255;         a = 1
        } else { return nil }
        return NSColor(srgbRed: r, green: g, blue: b, alpha: a)
    }

    // MARK: layers — dump the CALayer tree (find custom-drawn CATextLayer text)

    static func layers(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        guard let ref = action["ref"] as? String, let obj = agent.refs.resolve(ref) else {
            return JSONUtil.err("native_layers requires a valid ref (a view from native_tree)")
        }
        let root: CALayer?
        if let v = obj as? NSView { v.wantsLayer = true; root = v.layer }
        else if let l = obj as? CALayer { root = l }
        else { return JSONUtil.err("\(type(of: obj)) is not a view/layer") }
        guard let r = root else { return JSONUtil.ok(["note": "view has no backing layer"]) }
        let maxDepth = action["depth"] as? Int ?? 20
        return JSONUtil.ok(layerNode(r, depth: 0, maxDepth: maxDepth, agent: agent))
    }

    private static func layerNode(_ layer: CALayer, depth: Int, maxDepth: Int, agent: InterceptorAgent) -> [String: Any] {
        var node: [String: Any] = [
            "class": String(describing: type(of: layer)),
            "ref": agent.refs.register(layer),
            "frame": rectDict(layer.frame),
        ]
        if let tl = layer as? CATextLayer, let s = tl.string {
            node["text"] = (s as? String) ?? String(describing: s)
        }
        if depth < maxDepth, let subs = layer.sublayers, !subs.isEmpty {
            node["sublayers"] = subs.map { layerNode($0, depth: depth + 1, maxDepth: maxDepth, agent: agent) }
        }
        return node
    }

    /// Set the visible text of a control/label/textview. Branches on the
    /// concrete type because some classes respond to several setters where only
    /// one is the *visible* one — e.g. NSButton inherits `setStringValue:` from
    /// NSControl but its label is `title`.
    static func setText(_ obj: NSObject, _ text: String) -> [String] {
        var applied: [String] = []
        #if canImport(AppKit)
        if obj is NSButton {
            obj.setValue(text, forKey: "title"); applied.append("title")
            if let v = obj as? NSView { v.needsDisplay = true }
            return applied
        }
        if let tv = obj as? NSTextView {
            tv.string = text; applied.append("string"); return applied
        }
        #endif
        if obj.responds(to: Selector(("setStringValue:"))) {
            obj.setValue(text, forKey: "stringValue"); applied.append("stringValue")
        } else if obj.responds(to: Selector(("setString:"))) {
            obj.perform(Selector(("setString:")), with: text); applied.append("string")
        } else if obj.responds(to: Selector(("setTitle:"))) {
            obj.setValue(text, forKey: "title"); applied.append("title")
        }
        if let v = obj as? NSView, let layer = v.layer as? CATextLayer {
            layer.string = text; applied.append("layer.string")
        }
        return applied
    }

    // MARK: intercept — swizzle-redirect a 0-arg void selector

    private static var interceptOriginals = [String: IMP]()

    static func intercept(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        guard let className = action["class"] as? String, let cls = NSClassFromString(className) else {
            return JSONUtil.err("native_intercept requires a valid class")
        }
        guard let selName = action["selector"] as? String else {
            return JSONUtil.err("native_intercept requires a selector")
        }
        let sel = NSSelectorFromString(selName)
        guard let method = class_getInstanceMethod(cls, sel) else {
            return JSONUtil.err("\(className) has no instance method \(selName)")
        }
        let key = "\(className)-\(selName)"
        if interceptOriginals[key] != nil { return JSONUtil.ok(["already": key]) }

        let original = method_getImplementation(method)
        interceptOriginals[key] = original
        let block: @convention(block) (AnyObject) -> Void = { obj in
            agent.emit("native_intercept", ["class": className, "selector": selName])
            let orig = unsafeBitCast(original, to: (@convention(c) (AnyObject, Selector) -> Void).self)
            orig(obj, sel)
        }
        method_setImplementation(method, imp_implementationWithBlock(block))
        return JSONUtil.ok([
            "intercepted": key,
            "note": "0-arg void selectors only; calls reported as native_intercept events and forwarded to the original",
        ])
    }

    // MARK: screenshot — render the host's own layer/view in-process

    static func screenshot(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        guard let content = targetWindow(action, agent)?.contentView else {
            return JSONUtil.err("no window/contentView to capture")
        }
        guard let rep = content.bitmapImageRepForCachingDisplay(in: content.bounds) else {
            return JSONUtil.err("cannot create bitmap rep")
        }
        content.cacheDisplay(in: content.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            return JSONUtil.err("png encode failed")
        }
        return JSONUtil.ok([
            "format": "png",
            "base64": png.base64EncodedString(),
            "width": rep.pixelsWide,
            "height": rep.pixelsHigh,
        ])
    }

    private static func targetWindow(_ action: [String: Any], _ agent: InterceptorAgent) -> NSWindow? {
        if let ref = action["ref"] as? String, let obj = agent.refs.resolve(ref) {
            if let w = obj as? NSWindow { return w }
            if let v = obj as? NSView { return v.window }
        }
        return NSApplication.shared.keyWindow
            ?? NSApplication.shared.mainWindow
            ?? NSApplication.shared.windows.first
    }

    // MARK: watch — KVO stream

    private static var observers: [WatchObserver] = []

    static func watch(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        guard let ref = action["ref"] as? String, let obj = agent.refs.resolve(ref) as? NSObject else {
            return JSONUtil.err("native_watch requires a valid ref")
        }
        guard let keyPath = action["key"] as? String else {
            return JSONUtil.err("native_watch requires a key")
        }
        let obs = WatchObserver(agent: agent, ref: ref, key: keyPath)
        obj.addObserver(obs, forKeyPath: keyPath, options: [.new], context: nil)
        observers.append(obs)
        return JSONUtil.ok(["watching": keyPath, "ref": ref])
    }

    final class WatchObserver: NSObject {
        let agent: InterceptorAgent
        let ref: String
        let key: String
        init(agent: InterceptorAgent, ref: String, key: String) {
            self.agent = agent; self.ref = ref; self.key = key
        }
        override func observeValue(forKeyPath keyPath: String?, of object: Any?,
                                   change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {
            let val = change?[.newKey]
            agent.emit("native_watch", ["ref": ref, "key": key, "value": String(describing: val ?? "nil")])
        }
    }

    // MARK: net — passive URLSession hook

    private static var netInstalled = false

    static func net(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        // Turn on capture. Three layers, each a different chokepoint:
        //  - connect()/getaddrinfo()/connectx() dyld interposers (netcap.c) record
        //    endpoints for ANY stack;
        //  - fishhook rebinds an app's OWN dynamic libssl SSL_read/SSL_write;
        //  - the URLSession swizzle (Proxyman/Atlantis method) captures FULL
        //    Apple-stack HTTP plaintext — request + response + body — observationally,
        //    above TLS, for shared/custom/background sessions, with no proxy or cert.
        NetCapture.shared.enabled = true
        netInstalled = true
        interceptor_agent_install_url_capture()
        let sources = ["connect+getaddrinfo+connectx (endpoints)",
                       "app libssl SSL_read/SSL_write (fishhook)",
                       "URLSession resume/_didReceiveResponse/_didReceiveData (Apple-stack plaintext)"]
        return JSONUtil.ok(["capturing": true, "sources": sources, "note": "trigger activity, then: native net bodies"])
    }

    static func netLog(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        let clear = action["clear"] as? Bool ?? false
        let limit = action["limit"] as? Int ?? 200
        var items = NetCapture.shared.snapshot(clear: clear)
        if items.count > limit { items = Array(items.suffix(limit)) }
        return JSONUtil.ok(["count": items.count, "enabled": NetCapture.shared.enabled, "events": items])
    }

    /// FULL capture — the decrypted TLS plaintext (HTTP request/response bodies).
    static func netBodies(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        let clear = action["clear"] as? Bool ?? false
        var items = NetCapture.shared.tlsSnapshot(clear: clear)
        if let host = action["host"] as? String, !host.isEmpty {
            items = items.filter { (($0["host"] as? String) ?? "").contains(host) }
        }
        let limit = action["limit"] as? Int ?? 30
        if items.count > limit { items = Array(items.suffix(limit)) }
        return JSONUtil.ok(["count": items.count, "enabled": NetCapture.shared.enabled, "events": items])
    }

    // MARK: ax — use THIS process's Accessibility TCC grant to reach OTHER apps
    //
    // TCC permissions are bound to the host app's real code signature. If the
    // agent is loaded into an original Accessibility-granted app (no re-sign), the
    // process keeps that grant. A re-signed copy (replacement signature changed)
    // loses the grant -> AXIsProcessTrusted() == false.
    static func ax(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        let trusted = AXIsProcessTrusted()
        var out: [String: Any] = [
            "trusted": trusted,
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "app": agent.appName,
        ]

        // READ another app's window titles by pid (cross-app Accessibility read).
        if let p = numeric(action["pid"]) {
            let pid = pid_t(Int(p))
            let appEl = AXUIElementCreateApplication(pid)
            var winsRef: CFTypeRef?
            let err = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &winsRef)
            out["targetPid"] = Int(pid)
            if err == .success, let wins = winsRef as? [AXUIElement] {
                var titles: [String] = []
                for w in wins.prefix(25) {
                    var t: CFTypeRef?
                    if AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t) == .success,
                       let s = t as? String { titles.append(s) }
                }
                out["axRead"] = "success"
                out["windowTitles"] = titles
            } else {
                out["axRead"] = "error \(err.rawValue) (kAXErrorAPIDisabled=-25211 means NOT trusted)"
            }
        }

        // CONTROL: type unicode text into whatever app is frontmost (synthetic HID).
        // Posting to the HID tap is itself Accessibility-gated.
        if let text = action["text"] as? String {
            let src = CGEventSource(stateID: .hidSystemState)
            var posted = 0
            for scalar in text.unicodeScalars {
                guard scalar.value <= 0xFFFF else { continue }
                var ch = UniChar(scalar.value)
                if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) {
                    down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
                    down.post(tap: .cghidEventTap)
                }
                if let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
                    up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &ch)
                    up.post(tap: .cghidEventTap)
                }
                posted += 1
            }
            out["typed"] = posted
        }
        return JSONUtil.ok(out)
    }

    // MARK: file — read a path using the host app's file-access TCC grant
    //
    // A non-sandboxed process can read the user's own files, but TCC-protected
    // paths (Messages/Mail/Safari/other-app containers, the TCC db itself) require
    // Full Disk Access — granted to the HOST app's identity. If we re-signed a copy
    // that kept a com.apple.* bundle id holding kTCCServiceSystemPolicyAllFiles, the
    // read succeeds; otherwise it returns an "operation not permitted" error.
    static func fileRead(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        guard let path = action["path"] as? String, !path.isEmpty else {
            return JSONUtil.err("native_file requires path")
        }
        let maxN = (action["bytes"] as? Int) ?? 256
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        do {
            let fh = try FileHandle(forReadingFrom: url)
            let data = fh.readData(ofLength: maxN)
            try? fh.close()
            let preview = String(data: data, encoding: .utf8)
                ?? ("hex:" + data.prefix(80).map { String(format: "%02x", $0) }.joined())
            return JSONUtil.ok(["path": path, "ok": true, "read": data.count,
                                "preview": String(preview.prefix(220))])
        } catch {
            // The TCC denial surfaces here as "Operation not permitted".
            return JSONUtil.ok(["path": path, "ok": false, "error": "\(error.localizedDescription)"])
        }
    }

    // MARK: tcc — report THIS process's TCC authorization, WITHOUT prompting
    //
    // Each status reflects the calling process's TCC grant. Inside a re-signed copy
    // that kept a com.apple.* bundle id, these light up with whatever that Apple app
    // was granted — proving (or disproving) grant inheritance per service.
    static func tccStatus(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        // activate: actually REQUEST the permission. If the host's bundle id already
        // holds the grant, the request resolves to authorized with NO prompt; if not,
        // a prompt appears (or it denies). The result comes back as a native_tcc event.
        if let svc = action["activate"] as? String {
            func emit(_ name: String, _ status: String) {
                agent.emit("native_tcc", ["service": name, "status": status])
            }
            if svc == "speech" || svc == "all" {
                SFSpeechRecognizer.requestAuthorization { s in
                    emit("speechRecognition", ["authorized","denied","restricted","notDetermined"][min(Int(s.rawValue),3)])
                }
            }
            if svc == "camera" || svc == "all" {
                AVCaptureDevice.requestAccess(for: .video) { ok in emit("camera", ok ? "authorized" : "denied") }
            }
            if svc == "mic" || svc == "all" {
                AVCaptureDevice.requestAccess(for: .audio) { ok in emit("microphone", ok ? "authorized" : "denied") }
            }
            if svc == "contacts" || svc == "all" {
                CNContactStore().requestAccess(for: .contacts) { ok, _ in emit("contacts", ok ? "authorized" : "denied") }
            }
            if svc == "screen" || svc == "all" {
                // synchronous; prompts if not already granted, returns the result.
                let ok = CGRequestScreenCaptureAccess()
                emit("screenRecording", ok ? "authorized" : "denied")
            }
            return JSONUtil.ok(["activated": svc, "note": "requested; watch for a prompt, then re-run `native tcc`"])
        }
        func sfStr(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
            switch s { case .authorized: return "authorized"; case .denied: return "denied"
            case .restricted: return "restricted"; case .notDetermined: return "notDetermined"
            @unknown default: return "unknown" }
        }
        func avStr(_ s: AVAuthorizationStatus) -> String {
            switch s { case .authorized: return "authorized"; case .denied: return "denied"
            case .restricted: return "restricted"; case .notDetermined: return "notDetermined"
            @unknown default: return "unknown" }
        }
        func cnStr(_ s: CNAuthorizationStatus) -> String {
            switch s { case .authorized: return "authorized"; case .denied: return "denied"
            case .restricted: return "restricted"; case .notDetermined: return "notDetermined"
            @unknown default: return "unknown" }
        }
        // FDA probe: a TCC-gated file read.
        let tccDb = ("~/Library/Application Support/com.apple.TCC/TCC.db" as NSString).expandingTildeInPath
        let fda = (try? FileHandle(forReadingFrom: URL(fileURLWithPath: tccDb)))
        let fdaOK = fda != nil; try? fda?.close()

        let tcc: [String: String] = [
            "speechRecognition": sfStr(SFSpeechRecognizer.authorizationStatus()),
            "camera": avStr(AVCaptureDevice.authorizationStatus(for: .video)),
            "microphone": avStr(AVCaptureDevice.authorizationStatus(for: .audio)),
            "contacts": cnStr(CNContactStore.authorizationStatus(for: .contacts)),
            "accessibility": AXIsProcessTrusted() ? "authorized" : "no",
            "screenRecording": CGPreflightScreenCaptureAccess() ? "authorized" : "no",
            "fullDiskAccess": fdaOK ? "authorized" : "no",
        ]
        // The responsible process — whose TCC grants we actually inherit.
        let myPid = ProcessInfo.processInfo.processIdentifier
        let rpid = responsibility_get_pid_responsible_for_pid(myPid)
        var rpath = ""
        if rpid > 0 {
            var buf = [Int8](repeating: 0, count: 4096)
            if proc_pidpath(rpid, &buf, 4096) > 0 { rpath = String(cString: buf) }
        }
        return JSONUtil.ok([
            "host": agent.appName,
            "bundleId": Bundle.main.bundleIdentifier ?? "?",
            "pid": Int(myPid),
            "responsiblePid": Int(rpid),
            "responsiblePath": rpath,
            "tcc": tcc,
        ])
    }

    // MARK: draw — add styled, animated CALayers to the host app's view tree
    //
    // Adds new glowing/animated layers (rect, rounded, circle, text, gradient) as
    // sublayers of a target view/layer — overlays that weren't there, drawn from
    // inside the process onto the app's own render surface.
    private static var drawnLayers = [String: CALayer]()

    static func draw(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        let op = action["op"] as? String ?? "add"
        if op == "clear" {
            let n = drawnLayers.count
            for (_, l) in drawnLayers { l.removeFromSuperlayer() }
            drawnLayers.removeAll()
            return JSONUtil.ok(["cleared": n])
        }
        guard let ref = action["ref"] as? String, let obj = agent.refs.resolve(ref) else {
            return JSONUtil.err("native_draw requires a valid ref (target view/layer from native_tree)")
        }
        let target: CALayer
        if let v = obj as? NSView { v.wantsLayer = true; target = v.layer ?? CALayer() }
        else if let l = obj as? CALayer { target = l }
        else { return JSONUtil.err("\(type(of: obj)) is not a view/layer") }

        let shape = action["shape"] as? String ?? "rect"
        let x = CGFloat(numeric(action["x"]) ?? 0), y = CGFloat(numeric(action["y"]) ?? 0)
        let w = CGFloat(numeric(action["w"]) ?? 120), h = CGFloat(numeric(action["h"]) ?? 120)
        let frame = CGRect(x: x, y: y, width: w, height: h)
        let id = action["id"] as? String ?? "draw-\(drawnLayers.count)"
        drawnLayers[id]?.removeFromSuperlayer()   // replace if same id

        let layer: CALayer
        switch shape {
        case "text":
            let tl = CATextLayer()
            tl.string = action["text"] as? String ?? ""
            tl.fontSize = CGFloat(numeric(action["fontSize"]) ?? 32)
            tl.alignmentMode = .center
            tl.truncationMode = .none
            tl.isWrapped = true
            tl.foregroundColor = (colorFromHex(action["color"] as? String ?? "#ffffff") ?? .white).cgColor
            tl.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
            if let f = action["font"] as? String { tl.font = f as CFTypeRef }
            layer = tl
        case "circle":
            let l = CALayer(); l.cornerRadius = min(w, h) / 2; layer = l
        case "gradient":
            let g = CAGradientLayer()
            let c1 = colorFromHex(action["color"] as? String ?? "#ff00d4") ?? .magenta
            let c2 = colorFromHex(action["color2"] as? String ?? "#00ffea") ?? .cyan
            g.colors = [c1.cgColor, c2.cgColor]
            g.startPoint = CGPoint(x: 0, y: 0); g.endPoint = CGPoint(x: 1, y: 1)
            if let r = numeric(action["radius"]) { g.cornerRadius = CGFloat(r) }
            layer = g
        default:
            layer = CALayer()
            if let r = numeric(action["radius"]) { layer.cornerRadius = CGFloat(r) }
        }
        layer.frame = frame
        if shape != "text" && shape != "gradient", let bg = colorFromHex(action["color"] as? String ?? "") {
            layer.backgroundColor = bg.cgColor
        }
        if let glow = colorFromHex(action["glow"] as? String ?? "") {
            layer.shadowColor = glow.cgColor
            layer.shadowRadius = CGFloat(numeric(action["glowRadius"]) ?? 24)
            layer.shadowOpacity = 1; layer.shadowOffset = .zero; layer.masksToBounds = false
        }
        if let o = numeric(action["opacity"]) { layer.opacity = Float(o) }
        if let bw = numeric(action["border"]) {
            layer.borderWidth = CGFloat(bw)
            layer.borderColor = (colorFromHex(action["borderColor"] as? String ?? "#ffffff") ?? .white).cgColor
        }
        switch action["animate"] as? String {
        case "pulse":
            let a = CABasicAnimation(keyPath: "opacity"); a.fromValue = 1.0; a.toValue = 0.2
            a.duration = 0.8; a.autoreverses = true; a.repeatCount = .infinity; layer.add(a, forKey: "p")
        case "glow":
            let a = CABasicAnimation(keyPath: "shadowRadius"); a.fromValue = 6; a.toValue = 46
            a.duration = 1.1; a.autoreverses = true; a.repeatCount = .infinity; layer.add(a, forKey: "g")
        case "scale":
            let a = CABasicAnimation(keyPath: "transform.scale"); a.fromValue = 0.7; a.toValue = 1.25
            a.duration = 0.7; a.autoreverses = true; a.repeatCount = .infinity; layer.add(a, forKey: "s")
        case "rotate":
            let a = CABasicAnimation(keyPath: "transform.rotation.z"); a.fromValue = 0.0; a.toValue = Double.pi * 2
            a.duration = CFTimeInterval(numeric(action["spin"]) ?? 3); a.repeatCount = .infinity; layer.add(a, forKey: "r")
        default: break
        }
        target.addSublayer(layer)
        drawnLayers[id] = layer
        return JSONUtil.ok(["drawn": id, "shape": shape, "into": String(describing: type(of: obj)), "frame": rectDict(frame), "total": drawnLayers.count])
    }

    // MARK: js — inline JavaScript against the live ObjC/Cocoa runtime
    //
    // The browser surface's power is `eval --main`: arbitrary inline JS against the
    // DOM. This is the native equivalent — arbitrary inline JS against the whole
    // Objective-C runtime via a generic NSInvocation msgSend bridge (AgentJS, ObjC).
    // One persistent JSContext, so JS state persists across calls.
    static func js(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        guard let code = action["code"] as? String else {
            return JSONUtil.err("native_js requires code")
        }
        guard let cstr = code.withCString({ itc_eval_js($0) }) else {
            return JSONUtil.err("js bridge returned null")
        }
        defer { free(cstr) }
        let jsonStr = String(cString: cstr)
        if let data = jsonStr.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return JSONUtil.ok(obj)
        }
        return JSONUtil.ok(["raw": jsonStr])
    }

    // MARK: hook fabric — tiered interception + runtime domains
    //
    // Thin Swift wrappers over the ObjC hook engine (AgentJS/hookengine.m). The
    // engine returns malloc'd JSON; cresult parses + frees it.

    private static func cresult(_ c: UnsafeMutablePointer<CChar>?) -> [String: Any] {
        guard let c = c else { return JSONUtil.err("hook engine returned null") }
        defer { free(c) }
        let s = String(cString: c)
        if let d = s.data(using: .utf8),
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            return JSONUtil.ok(o)
        }
        return JSONUtil.ok(["raw": s])
    }

    static func hookInstall(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        guard let cls = action["class"] as? String, let sel = action["selector"] as? String else {
            return JSONUtil.err("native_hook requires class + selector")
        }
        let domain = action["domain"] as? String ?? "Debugger"
        return cresult(cls.withCString { c1 in sel.withCString { c2 in domain.withCString { c3 in
            itc_hook_install_d(c1, c2, c3)
        } } })
    }

    static func hookRemove(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        guard let cls = action["class"] as? String, let sel = action["selector"] as? String else {
            return JSONUtil.err("native_unhook requires class + selector")
        }
        return cresult(cls.withCString { c1 in sel.withCString { c2 in itc_hook_remove(c1, c2) } })
    }

    static func hookDrain(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        let clear = (action["clear"] as? Bool ?? false) ? 1 : 0
        let limit = Int32(action["limit"] as? Int ?? 0)
        return cresult(itc_hook_drain(Int32(clear), limit))
    }

    static func trace(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        guard let cls = action["class"] as? String else { return JSONUtil.err("native_trace requires class") }
        let maxM = Int32(action["max"] as? Int ?? 0)
        return cresult(cls.withCString { c in itc_trace_class(c, maxM) })
    }

    static func untrace(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        guard let cls = action["class"] as? String else { return JSONUtil.err("native_untrace requires class") }
        return cresult(cls.withCString { c in itc_untrace_class(c) })
    }

    static func cintercept(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        if action["list"] as? Bool == true { return cresult(itc_cintercept_list()) }
        guard let sym = action["symbol"] as? String else { return JSONUtil.err("native_cintercept requires symbol (or list:true)") }
        return cresult(sym.withCString { c in itc_cintercept_install(c) })
    }

    /// The runtime domain map for the in-process surface. Each domain lists its
    /// commands (verbs) and emitted events.
    static func domains(_ action: [String: Any], _ agent: InterceptorAgent) -> [String: Any] {
        let map: [[String: Any]] = [
            ["domain": "Runtime", "commands": ["eval", "js", "tree", "layers"], "events": []],
            ["domain": "DOM", "commands": ["tree", "layers", "mutate", "draw", "dom-watch"], "events": ["viewAdded", "viewWillDraw"]],
            ["domain": "Network", "commands": ["net", "net log", "net bodies", "cintercept"], "events": ["requestWillBeSent", "responseReceived", "cintercept"]],
            ["domain": "Debugger", "commands": ["hook", "unhook", "hooks", "trace", "untrace", "hook log", "events"], "events": ["hookHit"]],
            ["domain": "Input", "commands": ["ax --type"], "events": []],
            ["domain": "Page", "commands": ["ping", "screenshot"], "events": ["watch"]],
        ]
        return JSONUtil.ok(["domains": map, "transport": "daemon websocket", "note": "enable a domain's hooks, then drain its events via `macos runtime events`"])
    }

    // MARK: util

    static func rectDict(_ r: CGRect) -> [String: Any] {
        ["x": Int(r.origin.x), "y": Int(r.origin.y), "w": Int(r.size.width), "h": Int(r.size.height)]
    }
}
