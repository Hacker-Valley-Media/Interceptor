// InterceptorD (in-guest agent)
//
// Listens on vsock port 3294 inside a Linux or macOS guest. Speaks the
// same length-prefixed JSON framing as the host bridge (`WireFormat`
// pattern). Each inbound request looks like:
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
// vsock semantics on Linux: AF_VSOCK + SOCK_STREAM, family-specific
// address. On macOS: Darwin doesn't expose AF_VSOCK to user-space; the
// macOS guest agent therefore binds on a localhost loopback when run
// under VZ, and the host's VsockGuestAgent connects via
// VZVirtioSocketDevice.connect(toPort:) — the connection inside the
// guest is a normal SOCK_STREAM that lands here.

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
    task.waitUntilExit()
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
            "durationMs": durationMs
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

func handleType(_ action: [String: Any]) -> [String: Any] {
    guard let text = action["text"] as? String else {
        return ["success": false, "error": "type: missing 'text'"]
    }
    let source = CGEventSource(stateID: .hidSystemState)
    for char in text.unicodeScalars {
        // Use the unicode-string path so we don't need to map every key.
        let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        var u = UniChar(char.value)
        down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
        up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        usleep(10_000)
    }
    return ["success": true, "data": ["typed": text.count]]
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
    CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: pt, mouseButton: mb)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: pt, mouseButton: mb)?.post(tap: .cghidEventTap)
    return ["success": true, "data": ["x": x, "y": y, "button": button]]
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
    let systemElement = AXUIElementCreateSystemWide()
    var visited = 0
    let tree = axNode(systemElement, depth: 0, maxDepth: depth, maxNodes: maxNodes, visited: &visited)
    return ["success": true, "data": ["tree": tree, "visited": visited, "maxDepth": depth]]
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
    let result = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenRef)
    if result == .success, let children = childrenRef as? [AXUIElement], !children.isEmpty {
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

func handleTrust(_ action: [String: Any]) -> [String: Any] {
#if os(macOS)
    let accessibility = AXIsProcessTrusted()
    let screenRecording = CGPreflightScreenCaptureAccess()
    return [
        "success": true,
        "data": [
            "platform": "macos",
            "accessibility": accessibility ? "granted" : "denied",
            "screenRecording": screenRecording ? "granted" : "denied",
            "postEvent": "unknown",
            "inputMonitoring": "unknown",
            "notes": [
                "Accessibility and Screen Recording expose only boolean preflight state through public APIs here.",
                "PostEvent/Input Monitoring should be validated by attempting the requested verb and checking failure diagnostics.",
            ],
        ],
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

func isMutatingVerb(_ verb: String) -> Bool {
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
    if let requiredAuthToken, isMutatingVerb(verb) {
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

// MARK: - Loopback server (works on both Linux & macOS guests)
//
// In the macOS guest variant we bind on 127.0.0.1:<port> and rely on
// VZVirtioSocketDevice's port-mapping inside VZ to route the host
// connection. On Linux a real AF_VSOCK socket is available via the
// kernel virtio_vsock driver; we open AF_VSOCK in that case.

func serve() {
#if os(Linux)
    let AF_VSOCK_C: Int32 = 40  // Linux AF_VSOCK
    let VMADDR_CID_ANY: UInt32 = 0xFFFFFFFF
    let server = socket(AF_VSOCK_C, Int32(SOCK_STREAM.rawValue), 0)
    if server < 0 {
        fputs("InterceptorD: AF_VSOCK socket() failed\n", stderr)
        exit(1)
    }
    // sockaddr_vm layout: u16 family, u16 reserved, u32 port, u32 cid, ...
    var addr = sockaddr_vm()
    addr.svm_family = sa_family_t(AF_VSOCK_C)
    addr.svm_port = kAgentPort
    addr.svm_cid = VMADDR_CID_ANY
    let sz = socklen_t(MemoryLayout<sockaddr_vm>.size)
    let bindRes = withUnsafePointer(to: &addr) { ptr -> Int32 in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sptr in
            Darwin.bind(server, sptr, sz)
        }
    }
    if bindRes != 0 {
        fputs("InterceptorD: bind() failed: \(String(cString: strerror(errno)))\n", stderr)
        exit(1)
    }
    Darwin.listen(server, 5)
    while true {
        let client = Darwin.accept(server, nil, nil)
        if client < 0 { continue }
        Thread.detachNewThread { handleClient(fd: client) }
    }
#else
    // macOS guest path — bind on all guest interfaces. Virtualization's
    // macOS guest socket path is not reliable for every host/guest pairing,
    // so the host bridge can fall back to the guest's NAT IP.
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
    Darwin.listen(server, 5)
    while true {
        let client = Darwin.accept(server, nil, nil)
        if client < 0 { continue }
        Thread.detachNewThread { handleClient(fd: client) }
    }
#endif
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

fputs("InterceptorD starting on port \(kAgentPort)\n", stderr)
serve()
