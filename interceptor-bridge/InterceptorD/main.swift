// InterceptorD (in-guest agent)
//
// Guests listen on AF_VSOCK port 3294 by default. Apple documents
// VZVirtioSocketDevice as a host-to-guest port connection, and the macOS SDK
// exposes AF_VSOCK / sockaddr_vm for the guest-side listener. A normal TCP
// listener is available only as an explicit diagnostic fallback.
// Both paths speak the same length-prefixed JSON framing as the host bridge
// (`WireFormat` pattern). Each inbound request looks like:
//
//   { "id": "<uuid>", "action": { "verb": "exec", ... } }
//
// And every response looks like:
//
//   { "id": "<uuid>", "result": { "success": true, "data": {...} } }
//   { "id": "<uuid>", "result": { "success": false, "error": "..." } }
//
// Verbs:
//   exec        — fork/exec argv inside the guest; capture stdout/stderr
//   get_ip      — read primary interface IPv4 (ip -j addr on Linux, ifconfig en0 on macOS)
//   screenshot  — CGDisplayCreateImage (macOS) / `grim` or `scrot` (Linux)
//   type        — CGEventCreateKeyboardEvent + CGEventPost (macOS) / xdotool|wtype (Linux)
//   click       — CGEventCreateMouseEvent + CGEventPost (macOS)
//   keys        — keychord injection (macOS)
//   read_ax     — AXUIElementCreateApplication walk (macOS); AT-SPI not implemented
//   mount       — invoke `mount -t virtiofs <tag> <path>` inside the guest
//   cp_in       — receive bytes into a guest path (host pushes)
//   cp_out      — read a guest path and return bytes (host pulls)
//
// vsock semantics: AF_VSOCK + SOCK_STREAM, family-specific address bound to
// VMADDR_CID_ANY and the Interceptor agent port.

import Foundation
import Darwin

#if os(macOS)
import AppKit
import ApplicationServices
import CoreGraphics
#endif

// MARK: - Constants

let kAgentPort: UInt32 = 3294
let requiredAuthToken = ProcessInfo.processInfo.environment["INTERCEPTOR_GUEST_TOKEN"]

// MARK: - JSON helpers

func jsonData(_ obj: [String: Any]) -> Data? {
    return try? JSONSerialization.data(withJSONObject: obj, options: [])
}

func writeFrame(fd: Int32, _ obj: [String: Any]) {
    guard let data = jsonData(obj) else { return }
    var length = UInt32(data.count).littleEndian
    var frame = Data(bytes: &length, count: 4)
    frame.append(data)
    _ = frame.withUnsafeBytes { ptr in
        Darwin.write(fd, ptr.baseAddress!, frame.count)
    }
}

func successResult(_ id: String, data: [String: Any]) -> [String: Any] {
    return ["id": id, "result": ["success": true, "data": data]]
}

func errorResult(_ id: String, _ message: String) -> [String: Any] {
    return ["id": id, "result": ["success": false, "error": message]]
}

// MARK: - Verb handlers

func handleExec(_ action: [String: Any]) -> [String: Any] {
    guard let argv = action["argv"] as? [String], !argv.isEmpty else {
        return ["success": false, "error": "exec: missing argv"]
    }
    let workdir = action["workdir"] as? String
    let env = action["env"] as? [String: String] ?? [:]
    let timeout: TimeInterval = {
        switch action["timeout"] {
        case let number as NSNumber:
            return max(0, number.doubleValue)
        case let double as Double:
            return max(0, double)
        case let int as Int:
            return max(0, TimeInterval(int))
        case let string as String:
            return max(0, TimeInterval(string) ?? 0)
        default:
            return 0
        }
    }()

    let task = Process()
    task.executableURL = URL(fileURLWithPath: argv[0])
    task.arguments = Array(argv.dropFirst())
    if let wd = workdir { task.currentDirectoryURL = URL(fileURLWithPath: wd) }
    var fullEnv = ProcessInfo.processInfo.environment
    for (k, v) in env { fullEnv[k] = v }
    task.environment = fullEnv

    let outPipe = Pipe()
    let errPipe = Pipe()
    task.standardOutput = outPipe
    task.standardError = errPipe
    task.standardInput = FileHandle.nullDevice

    let started = Date()
    do {
        try task.run()
    } catch {
        return ["success": false, "error": "exec: spawn failed: \(error.localizedDescription)"]
    }
    let sem = DispatchSemaphore(value: 0)
    task.terminationHandler = { _ in sem.signal() }
    var timedOut = false
    if timeout > 0 {
        timedOut = sem.wait(timeout: .now() + timeout) == .timedOut
        if timedOut {
            task.terminate()
            if sem.wait(timeout: .now() + 2) == .timedOut {
                kill(task.processIdentifier, SIGKILL)
                _ = sem.wait(timeout: .now() + 2)
            }
        }
    } else {
        task.waitUntilExit()
    }
    let durationMs = Int(Date().timeIntervalSince(started) * 1000)

    let stdoutData = outPipe.fileHandleForReading.readDataToEndOfFile()
    let stderrData = errPipe.fileHandleForReading.readDataToEndOfFile()
    let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
    let stderr = String(data: stderrData, encoding: .utf8) ?? ""

    return [
        "success": true,
        "data": [
            "exitCode": task.terminationStatus,
            "stdout": stdout,
            "stderr": stderr,
            "durationMs": durationMs,
            "timedOut": timedOut
        ] as [String: Any]
    ]
}

func handleGetIP() -> [String: Any] {
#if os(macOS)
    // ifconfig en0 → grep inet
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/sbin/ifconfig")
    task.arguments = ["en0"]
    let pipe = Pipe()
    task.standardOutput = pipe
    do { try task.run() } catch {
        return ["success": false, "error": "get_ip: ifconfig failed: \(error.localizedDescription)"]
    }
    task.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let text = String(data: data, encoding: .utf8) ?? ""
    for line in text.split(separator: "\n") {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("inet ") && !trimmed.contains("127.0.0.1") {
            let parts = trimmed.split(separator: " ")
            if parts.count >= 2 {
                return ["success": true, "data": ["ipAddress": String(parts[1])]]
            }
        }
    }
    return ["success": true, "data": ["ipAddress": NSNull()]]
#else
    // Linux: parse /proc/net/route or `ip -j addr`. Keep it dependency-free.
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    task.arguments = ["sh", "-c", "ip -j addr 2>/dev/null || ifconfig"]
    let pipe = Pipe()
    task.standardOutput = pipe
    do { try task.run() } catch {
        return ["success": false, "error": "get_ip: ip failed: \(error.localizedDescription)"]
    }
    task.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let text = String(data: data, encoding: .utf8) ?? ""
    // Best-effort regex for the first non-loopback IPv4.
    if let range = text.range(of: #"\b(?!127\.0\.0\.1)\d+\.\d+\.\d+\.\d+\b"#, options: .regularExpression) {
        return ["success": true, "data": ["ipAddress": String(text[range])]]
    }
    return ["success": true, "data": ["ipAddress": NSNull()]]
#endif
}

#if os(macOS)
import ScreenCaptureKit

// macOS 15 deprecated CGDisplayCreateImage. ScreenCaptureKit is the
// supported path: SCShareableContent.current.displays → SCContentFilter
// for the display → SCScreenshotManager.captureImage(contentFilter:configuration:).
// We use a sync wrapper around the async ScreenCaptureKit API.
@available(macOS 14.0, *)
func sckCaptureMainDisplay() async throws -> CGImage {
    let content = try await SCShareableContent.current
    guard let display = content.displays.first else {
        throw NSError(domain: "InterceptorD", code: 1, userInfo: [NSLocalizedDescriptionKey: "no displays available"])
    }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let config = SCStreamConfiguration()
    config.width = display.width
    config.height = display.height
    config.showsCursor = true
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
}

// Sendable holder. We serialize all access through a dedicated dispatch
// queue rather than NSLock because Swift 6 disallows NSLock.lock() from
// async contexts.
final class ImageBox: @unchecked Sendable {
    private let queue = DispatchQueue(label: "interceptord.imagebox")
    private var _image: CGImage?
    private var _error: String?
    func set(image: CGImage?, error: String?) {
        queue.sync { self._image = image; self._error = error }
    }
    func snapshot() -> (CGImage?, String?) {
        queue.sync { (self._image, self._error) }
    }
}

func handleScreenshot(_ action: [String: Any]) -> [String: Any] {
    let box = ImageBox()
    let sem = DispatchSemaphore(value: 0)
    if #available(macOS 14.0, *) {
        Task.detached {
            do {
                let img = try await sckCaptureMainDisplay()
                box.set(image: img, error: nil)
            } catch {
                box.set(image: nil, error: error.localizedDescription)
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 10.0)
    } else {
        box.set(image: nil, error: "macOS < 14.0 unsupported")
    }
    let (cgImageOpt, errMsg) = box.snapshot()
    guard let cgImage = cgImageOpt else {
        return ["success": false, "error": "screenshot: ScreenCaptureKit: \(errMsg ?? "no image returned")"]
    }
    let out = (action["out"] as? String) ?? "/tmp/interceptord-screenshot.png"
    let url = URL(fileURLWithPath: out)
    let rep = NSBitmapImageRep(cgImage: cgImage)
    guard let png = rep.representation(using: .png, properties: [:]) else {
        return ["success": false, "error": "screenshot: PNG encode failed"]
    }
    do { try png.write(to: url) } catch {
        return ["success": false, "error": "screenshot: write \(out): \(error.localizedDescription)"]
    }
    return ["success": true, "data": ["path": out, "width": cgImage.width, "height": cgImage.height, "bytes": png.count]]
}

func appMatches(_ app: NSRunningApplication, query: String) -> Bool {
    let q = query.lowercased()
    let candidates = [
        app.localizedName,
        app.bundleIdentifier,
        app.bundleURL?.deletingPathExtension().lastPathComponent,
        app.executableURL?.lastPathComponent,
    ].compactMap { $0?.lowercased() }
    return candidates.contains(q) || candidates.contains { $0.contains(q) }
}

func resolveRunningApp(_ query: String?) -> NSRunningApplication? {
    let trimmed = query?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let trimmed, !trimmed.isEmpty {
        return NSWorkspace.shared.runningApplications.first { appMatches($0, query: trimmed) }
    }
    return liveFrontmostApplication()
}

// Live frontmost pull (issues #168, #198): NSWorkspace.frontmostApplication
// is a main-run-loop push cache that freezes in daemon processes like this
// one, and the system-wide focused-application attribute has nothing to
// return for a frontmost app with zero windows. Ask the AX server, then scan
// per-app AXFrontmost (the System Events algorithm), then the window server,
// before trusting the cache. Inline copy of the host bridge's
// FrontmostResolver — separate SwiftPM target, intentionally minimal deps.
func liveFrontmostApplication() -> NSRunningApplication? {
    var focused: CFTypeRef?
    if AXUIElementCopyAttributeValue(
        AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &focused) == .success,
        let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() {
        var pid: pid_t = 0
        if AXUIElementGetPid(unsafeDowncast(focused, to: AXUIElement.self), &pid) == .success, pid > 0 {
            return NSRunningApplication(processIdentifier: pid)
        }
    }
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.25)
        var flag: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXFrontmostAttribute as CFString, &flag) == .success,
           let flag = flag as? Bool, flag {
            return NSRunningApplication(processIdentifier: app.processIdentifier)
        }
    }
    if let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
        for window in list {
            guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
                  let pid = window[kCGWindowOwnerPID as String] as? Int
            else { continue }
            return NSRunningApplication(processIdentifier: pid_t(pid))
        }
    }
    return NSWorkspace.shared.frontmostApplication
}

func eventTargetPID(_ action: [String: Any]) -> pid_t? {
    guard let app = action["app"] as? String, !app.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return nil
    }
    return resolveRunningApp(app)?.processIdentifier
}

func postEvent(_ event: CGEvent?, targetPID: pid_t?) {
    guard let event else { return }
    if let targetPID {
        event.postToPid(targetPID)
    } else {
        event.post(tap: .cghidEventTap)
    }
}

func handleType(_ action: [String: Any]) -> [String: Any] {
    guard let text = action["text"] as? String else {
        return ["success": false, "error": "type: missing 'text'"]
    }
    let source = CGEventSource(stateID: .hidSystemState)
    let pid = eventTargetPID(action)
    for char in text.unicodeScalars {
        // Use the unicode-string path so we don't need to map every key.
        let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        var u = UniChar(char.value)
        down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
        up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
        postEvent(down, targetPID: pid)
        postEvent(up, targetPID: pid)
        usleep(10_000)
    }
    return ["success": true, "data": ["typed": text.count, "targetPID": pid as Any? ?? NSNull()]]
}

func handleClick(_ action: [String: Any]) -> [String: Any] {
    let x = (action["x"] as? Double) ?? Double((action["x"] as? Int) ?? 0)
    let y = (action["y"] as? Double) ?? Double((action["y"] as? Int) ?? 0)
    let button = (action["button"] as? String) ?? "left"
    let source = CGEventSource(stateID: .hidSystemState)
    let mb: CGMouseButton
    let down: CGEventType
    let up: CGEventType
    switch button {
    case "right": mb = .right; down = .rightMouseDown; up = .rightMouseUp
    case "middle": mb = .center; down = .otherMouseDown; up = .otherMouseUp
    default: mb = .left; down = .leftMouseDown; up = .leftMouseUp
    }
    let pt = CGPoint(x: x, y: y)
    let pid = eventTargetPID(action)
    postEvent(CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: pt, mouseButton: mb), targetPID: pid)
    postEvent(CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: pt, mouseButton: mb), targetPID: pid)
    return ["success": true, "data": ["x": x, "y": y, "button": button, "targetPID": pid as Any? ?? NSNull()]]
}

func handleKeys(_ action: [String: Any]) -> [String: Any] {
    guard let chord = action["keys"] as? String else {
        return ["success": false, "error": "keys: missing 'keys'"]
    }
    // Minimal mapping: just handle the chord as a literal sequence via type.
    // Full chord mapping (cmd+shift+x) is v2; for v0 the host can use osascript fallback.
    return handleType(["text": chord])
}

func handleReadAX(_ action: [String: Any]) -> [String: Any] {
    let depth = (action["max_depth"] as? Int) ?? 4
    let maxNodes = (action["max_nodes"] as? Int) ?? 500
    guard let app = resolveRunningApp(action["app"] as? String) else {
        return ["success": false, "error": "read_ax: no target app found"]
    }

    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    var visited = 0
    let tree = axNode(appElement, depth: 0, maxDepth: depth, maxNodes: maxNodes, visited: &visited)
    return [
        "success": true,
        "data": [
            "app": app.localizedName ?? "",
            "bundleIdentifier": app.bundleIdentifier ?? "",
            "pid": app.processIdentifier,
            "tree": tree,
            "visited": visited,
            "maxDepth": depth
        ] as [String: Any]
    ]
}

func axString(_ el: AXUIElement, _ attr: CFString) -> String? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(el, attr, &value)
    guard result == .success, let value else { return nil }
    if let s = value as? String { return s }
    if CFGetTypeID(value) == AXUIElementGetTypeID() { return nil }
    let described = String(describing: value)
    return described.isEmpty ? nil : described
}

func axPoint(_ value: CFTypeRef?) -> CGPoint? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    if AXValueGetValue((value as! AXValue), .cgPoint, &point) { return point }
    return nil
}

func axSize(_ value: CFTypeRef?) -> CGSize? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    if AXValueGetValue((value as! AXValue), .cgSize, &size) { return size }
    return nil
}

func axFrame(_ el: AXUIElement) -> [String: Any]? {
    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef)
    AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef)
    guard let point = axPoint(posRef), let size = axSize(sizeRef) else { return nil }
    return [
        "x": point.x,
        "y": point.y,
        "width": size.width,
        "height": size.height,
    ]
}

func axNode(_ el: AXUIElement, depth: Int, maxDepth: Int, maxNodes: Int, visited: inout Int) -> [String: Any] {
    visited += 1
    var node: [String: Any] = [
        "ref": "ax\(visited)",
        "role": axString(el, kAXRoleAttribute as CFString) ?? (depth == 0 ? "AXSystem" : "?"),
    ]
    if let title = axString(el, kAXTitleAttribute as CFString), !title.isEmpty { node["title"] = title }
    if let value = axString(el, kAXValueAttribute as CFString), !value.isEmpty { node["value"] = value }
    if let desc = axString(el, kAXDescriptionAttribute as CFString), !desc.isEmpty { node["description"] = desc }
    if let frame = axFrame(el) { node["frame"] = frame }

    guard depth < maxDepth, visited < maxNodes else { return node }
    var childrenRef: CFTypeRef?
    var children: [AXUIElement] = []
    let result = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenRef)
    if result == .success, let axChildren = childrenRef as? [AXUIElement], !axChildren.isEmpty {
        children = axChildren
    } else {
        var windowsRef: CFTypeRef?
        let windowsResult = AXUIElementCopyAttributeValue(el, kAXWindowsAttribute as CFString, &windowsRef)
        if windowsResult == .success, let windows = windowsRef as? [AXUIElement], !windows.isEmpty {
            children = windows
        }
    }
    if !children.isEmpty {
        var childNodes: [[String: Any]] = []
        for child in children.prefix(50) {
            if visited >= maxNodes { break }
            childNodes.append(axNode(child, depth: depth + 1, maxDepth: maxDepth, maxNodes: maxNodes, visited: &visited))
        }
        node["children"] = childNodes
    }
    return node
}
#else
// Linux stubs — defer the rich verbs to the Linux variant (CL31 / v2).
func handleScreenshot(_ action: [String: Any]) -> [String: Any] {
    return ["success": false, "error": "screenshot: linux variant requires grim/scrot — implement in v2"]
}
func handleType(_ action: [String: Any]) -> [String: Any] {
    return ["success": false, "error": "type: linux variant requires xdotool/wtype — implement in v2"]
}
func handleClick(_ action: [String: Any]) -> [String: Any] {
    return ["success": false, "error": "click: linux variant — v2"]
}
func handleKeys(_ action: [String: Any]) -> [String: Any] {
    return ["success": false, "error": "keys: linux variant — v2"]
}
func handleReadAX(_ action: [String: Any]) -> [String: Any] {
    return ["success": false, "error": "read_ax: linux AT-SPI variant — v2"]
}
#endif

func handleMount(_ action: [String: Any]) -> [String: Any] {
    guard let tag = action["tag"] as? String, let path = action["path"] as? String else {
        return ["success": false, "error": "mount: missing 'tag' or 'path'"]
    }
    // mkdir -p the mount point then mount.
    let mkdir = Process()
    mkdir.executableURL = URL(fileURLWithPath: "/bin/mkdir")
    mkdir.arguments = ["-p", path]
    try? mkdir.run(); mkdir.waitUntilExit()

    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/sbin/mount")
    task.arguments = ["-t", "virtiofs", tag, path]
    let errPipe = Pipe()
    task.standardError = errPipe
    do { try task.run() } catch {
        return ["success": false, "error": "mount: \(error.localizedDescription)"]
    }
    task.waitUntilExit()
    if task.terminationStatus != 0 {
        let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return ["success": false, "error": "mount failed: \(err)"]
    }
    return ["success": true, "data": ["tag": tag, "path": path]]
}

func handleCopyIn(_ action: [String: Any]) -> [String: Any] {
    guard let path = action["path"] as? String, let b64 = action["dataBase64"] as? String else {
        return ["success": false, "error": "cp_in: missing 'path' or 'dataBase64'"]
    }
    guard let data = Data(base64Encoded: b64) else {
        return ["success": false, "error": "cp_in: dataBase64 is invalid"]
    }
    let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
    do {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        if let mode = action["mode"] as? String, let modeInt = Int(mode, radix: 8) {
            chmod(url.path, mode_t(modeInt))
        }
        return ["success": true, "data": ["path": url.path, "bytes": data.count]]
    } catch {
        return ["success": false, "error": "cp_in: \(error.localizedDescription)"]
    }
}

func handleCopyOut(_ action: [String: Any]) -> [String: Any] {
    guard let path = action["path"] as? String else {
        return ["success": false, "error": "cp_out: missing 'path'"]
    }
    let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
    do {
        let data = try Data(contentsOf: url)
        return [
            "success": true,
            "data": [
                "path": url.path,
                "bytes": data.count,
                "dataBase64": data.base64EncodedString(),
            ],
        ]
    } catch {
        return ["success": false, "error": "cp_out: \(error.localizedDescription)"]
    }
}

func handleLogs(_ action: [String: Any]) -> [String: Any] {
    let limit = (action["limit"] as? Int) ?? 200
    let paths = ["/tmp/InterceptorD.err.log", "/tmp/InterceptorD.out.log"]
    var entries: [[String: Any]] = []
    for path in paths {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let tail = lines.suffix(limit).map(String.init)
        entries.append(["path": path, "lines": tail])
    }
    return ["success": true, "data": ["logs": entries]]
}

func boolFlag(_ action: [String: Any], _ key: String) -> Bool {
    return action[key] as? Bool ?? false
}

#if os(macOS)
func resetTCC(service: String) -> [String: Any] {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
    task.arguments = ["reset", service]
    let stdout = Pipe()
    let stderr = Pipe()
    task.standardOutput = stdout
    task.standardError = stderr
    do {
        try task.run()
    } catch {
        return [
            "service": service,
            "ok": false,
            "error": error.localizedDescription,
        ]
    }
    task.waitUntilExit()
    let stdoutText = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let stderrText = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return [
        "service": service,
        "ok": task.terminationStatus == 0,
        "exitCode": task.terminationStatus,
        "stdout": stdoutText,
        "stderr": stderrText,
    ]
}

func checkAccessibility(prompt: Bool) -> Bool {
    if prompt {
        let key = "AXTrustedCheckOptionPrompt" as CFString
        let options = [key: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }
    return AXIsProcessTrusted()
}

func checkScreenRecording(prompt: Bool) -> Bool {
    if !prompt {
        return CGPreflightScreenCaptureAccess()
    }
    if CGPreflightScreenCaptureAccess() {
        return true
    }
    return CGRequestScreenCaptureAccess()
}

func openPrivacyPane(_ anchor: String) -> Bool {
    guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else {
        return false
    }
    return NSWorkspace.shared.open(url)
}
#endif

func handleTrust(_ action: [String: Any]) -> [String: Any] {
#if os(macOS)
    let noPrompt = boolFlag(action, "noPrompt")
    let prompt = !noPrompt && boolFlag(action, "prompt")
    let walkthrough = !noPrompt && boolFlag(action, "walkthrough")
    let accessibilityPrompt = !noPrompt && boolFlag(action, "accessibilityPrompt")
    let screenPrompt = !noPrompt && boolFlag(action, "screenPrompt")
    let resetDenied = !noPrompt && boolFlag(action, "resetDenied")

    let shouldPromptAccessibility = prompt || walkthrough || accessibilityPrompt
    let shouldPromptScreen = prompt || walkthrough || screenPrompt

    var resetResults: [[String: Any]] = []
    if resetDenied {
        if shouldPromptAccessibility {
            resetResults.append(resetTCC(service: "Accessibility"))
        }
        if shouldPromptScreen {
            resetResults.append(resetTCC(service: "ScreenCapture"))
        }
    }

    let accessibility = checkAccessibility(prompt: shouldPromptAccessibility)
    let screenRecording = checkScreenRecording(prompt: shouldPromptScreen)

    var opened: [String] = []
    if walkthrough {
        if !accessibility {
            if openPrivacyPane("Privacy_Accessibility") {
                opened.append("Accessibility")
            }
        } else if !screenRecording {
            if openPrivacyPane("Privacy_ScreenCapture") {
                opened.append("Screen Recording")
            }
        }
    }

    var prompted: [String] = []
    if shouldPromptAccessibility { prompted.append("Accessibility") }
    if shouldPromptScreen { prompted.append("Screen Recording") }

    var actionRequired: [String] = []
    if !accessibility {
        actionRequired.append("System Settings -> Privacy & Security -> Accessibility -> Enable InterceptorD")
    }
    if !screenRecording {
        actionRequired.append("System Settings -> Privacy & Security -> Screen Recording -> Enable InterceptorD")
    }

    var data: [String: Any] = [
        "platform": "macos",
        "accessibility": accessibility ? "granted" : "denied",
        "screenRecording": screenRecording ? "granted" : "denied",
        "postEvent": "unknown",
        "inputMonitoring": "unknown",
        "notes": [
            "Accessibility and Screen Recording expose only boolean preflight state through public APIs here.",
            "PostEvent/Input Monitoring should be validated by attempting the requested verb and checking failure diagnostics.",
            "On unmanaged macOS guests, prompts still require user approval in the guest UI; SSH cannot silently grant TCC.",
        ],
    ]
    if !prompted.isEmpty {
        data["prompted"] = prompted
    }
    if !opened.isEmpty {
        data["opened"] = opened
    }
    if !resetResults.isEmpty {
        data["reset"] = resetResults
    }
    if !actionRequired.isEmpty {
        data["action_required"] = actionRequired
    }
    return [
        "success": true,
        "data": data,
    ]
#else
    return [
        "success": true,
        "data": [
            "platform": "linux",
            "accessibility": "not_applicable",
            "screenRecording": "not_applicable",
        ],
    ]
#endif
}

func isMutatingVerb(_ verb: String, action: [String: Any]) -> Bool {
    if verb == "trust" {
        return boolFlag(action, "prompt")
            || boolFlag(action, "walkthrough")
            || boolFlag(action, "accessibilityPrompt")
            || boolFlag(action, "screenPrompt")
            || boolFlag(action, "resetDenied")
    }
    switch verb {
    case "ping", "get_ip", "trust", "read_ax", "screenshot", "logs":
        return false
    default:
        return true
    }
}

// MARK: - Request dispatcher

func dispatch(request: [String: Any]) -> [String: Any] {
    let id = (request["id"] as? String) ?? UUID().uuidString
    guard let action = request["action"] as? [String: Any] else {
        return errorResult(id, "missing action")
    }
    guard let verb = action["verb"] as? String else {
        return errorResult(id, "missing action.verb")
    }
    if let requiredAuthToken, isMutatingVerb(verb, action: action) {
        guard action["authToken"] as? String == requiredAuthToken else {
            return errorResult(id, "auth: invalid or missing authToken")
        }
    }
    let result: [String: Any]
    switch verb {
    case "exec":       result = handleExec(action)
    case "get_ip":     result = handleGetIP()
    case "screenshot": result = handleScreenshot(action)
    case "type":       result = handleType(action)
    case "click":      result = handleClick(action)
    case "keys":       result = handleKeys(action)
    case "read_ax":    result = handleReadAX(action)
    case "mount":      result = handleMount(action)
    case "cp_in":      result = handleCopyIn(action)
    case "cp_out":     result = handleCopyOut(action)
    case "trust":      result = handleTrust(action)
    case "logs":       result = handleLogs(action)
    case "ping":       result = ["success": true, "data": ["pong": true]]
    default:           result = ["success": false, "error": "unknown verb: \(verb)"]
    }
    return ["id": id, "result": result]
}

// MARK: - Guest-agent server
//
// macOS exposes AF_VSOCK and sockaddr_vm in sys/socket.h and sys/vsock.h.
// Use literal fallbacks so the source remains clear if Swift's imported
// constants vary by SDK.

let AF_VSOCK_C: Int32 = 40
let VMADDR_CID_ANY_C: UInt32 = 0xFFFFFFFF

func serveAcceptedClients(server: Int32) -> Never {
    Darwin.listen(server, 5)
    while true {
        let client = Darwin.accept(server, nil, nil)
        if client < 0 { continue }
        Thread.detachNewThread { handleClient(fd: client) }
    }
}

func openVsockServer() -> Int32? {
#if os(Linux)
    let streamType = Int32(SOCK_STREAM.rawValue)
#else
    let streamType = SOCK_STREAM
#endif
    let server = socket(AF_VSOCK_C, streamType, 0)
    if server < 0 {
        fputs("InterceptorD: AF_VSOCK socket() failed: \(String(cString: strerror(errno)))\n", stderr)
        return nil
    }
    var addr = sockaddr_vm()
#if os(macOS)
    addr.svm_len = UInt8(MemoryLayout<sockaddr_vm>.size)
#endif
    addr.svm_family = sa_family_t(AF_VSOCK_C)
    addr.svm_port = kAgentPort
    addr.svm_cid = VMADDR_CID_ANY_C
    let sz = socklen_t(MemoryLayout<sockaddr_vm>.size)
    let bindRes = withUnsafePointer(to: &addr) { ptr -> Int32 in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sptr in
            Darwin.bind(server, sptr, sz)
        }
    }
    if bindRes != 0 {
        fputs("InterceptorD: bind() failed: \(String(cString: strerror(errno)))\n", stderr)
        Darwin.close(server)
        return nil
    }
    return server
}

func serveVsock() -> Never {
    while true {
        if let server = openVsockServer() {
            serveAcceptedClients(server: server)
        }
        fputs("InterceptorD: waiting for VSOCK device on port \(kAgentPort)\n", stderr)
        Darwin.sleep(5)
    }
}

func serveTcpDiagnosticFallback() -> Never {
    let server = socket(AF_INET, SOCK_STREAM, 0)
    if server < 0 {
        fputs("InterceptorD: socket() failed\n", stderr)
        exit(1)
    }
    var yes: Int32 = 1
    setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = UInt16(kAgentPort).bigEndian
    addr.sin_addr.s_addr = INADDR_ANY
    let sz = socklen_t(MemoryLayout<sockaddr_in>.size)
    let bindRes = withUnsafePointer(to: &addr) { ptr -> Int32 in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sptr in
            Darwin.bind(server, sptr, sz)
        }
    }
    if bindRes != 0 {
        fputs("InterceptorD: bind() failed: \(String(cString: strerror(errno)))\n", stderr)
        exit(1)
    }
    serveAcceptedClients(server: server)
}

func serve() -> Never {
    if ProcessInfo.processInfo.environment["INTERCEPTOR_GUEST_TCP_LISTEN"] == "1" {
        serveTcpDiagnosticFallback()
    }
    serveVsock()
}

func handleClient(fd: Int32) {
    defer { Darwin.close(fd) }
    var buffer = Data()
    var buf = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
        let n = buf.withUnsafeMutableBufferPointer { Darwin.read(fd, $0.baseAddress, $0.count) }
        if n <= 0 { return }
        buffer.append(buf, count: n)
        while buffer.count >= 4 {
            let length: UInt32 = buffer.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
            if length == 0 || length > 50_000_000 { buffer.removeAll(); break }
            let total = 4 + Int(length)
            if buffer.count < total { break }
            let payload = buffer.subdata(in: 4..<total)
            buffer.removeSubrange(0..<total)
            guard let req = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
                continue
            }
            let response = dispatch(request: req)
            writeFrame(fd: fd, response)
        }
    }
}

// MARK: - Entry point

let transport = ProcessInfo.processInfo.environment["INTERCEPTOR_GUEST_TCP_LISTEN"] == "1" ? "tcp-diagnostic" : "vsock"
fputs("InterceptorD starting on \(transport) port \(kAgentPort)\n", stderr)
serve()
