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
import InputKeycodes
import GuestWire
import CoreFoundation
import NativeAX

#if os(macOS)
import AppKit
import ApplicationServices
import CoreGraphics
#endif

// MARK: - Constants

let kAgentPort: UInt32 = 3294
let requiredAuthToken = ProcessInfo.processInfo.environment["INTERCEPTOR_GUEST_TOKEN"]

// MARK: - JSON helpers

func successResult(_ id: String, data: [String: Any]) -> [String: Any] {
    return ["id": id, "result": ["success": true, "data": data]]
}

func errorResult(_ id: String, _ message: String) -> [String: Any] {
    return ["id": id, "result": ["success": false, "error": message]]
}

// MARK: - Verb handlers

func handleExec(_ action: [String: Any]) -> [String: Any] {
    GuestExecution.execute(action)
}

func handleGetIP() -> [String: Any] {
    var first: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&first) == 0 else { return ["success": false, "error": "get_ip: native interface inventory failed"] }
    defer { if let first { freeifaddrs(first) } }
    var cursor = first, count = 0, seen = Set<UInt>(), addresses = Set<String>()
    let deadline: GuestWire.Deadline
    do { deadline = try .init(seconds: 5) } catch { return ["success": false, "error": "get_ip: invalid budget"] }
    while let item = cursor {
        do { _ = try deadline.remaining() } catch { return ["success": false, "error": "get_ip: interface traversal deadline expired"] }
        count += 1
        guard count <= 512, seen.insert(UInt(bitPattern: item)).inserted else {
            return ["success": false, "error": "get_ip: native interface inventory is oversized or cyclic"]
        }
        let interface = item.pointee
        cursor = interface.ifa_next
        guard let name = interface.ifa_name, String(cString: name) == "en0",
              interface.ifa_flags & UInt32(IFF_UP) != 0, interface.ifa_flags & UInt32(IFF_LOOPBACK) == 0,
              let address = interface.ifa_addr, Int32(address.pointee.sa_family) == AF_INET else { continue }
        var value = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
        let number = UInt32(bigEndian: value.s_addr)
        guard number != 0, number >> 24 != 127, number >> 24 < 224 else { continue }
        var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        guard inet_ntop(AF_INET, &value, &buffer, socklen_t(buffer.count)) != nil else {
            return ["success": false, "error": "get_ip: native address conversion failed"]
        }
        addresses.insert(String(cString: buffer))
    }
    guard addresses.count <= 1 else {
        return ["success": false, "error": "get_ip: en0 has multiple actual IPv4 addresses; no first-address fallback was chosen"]
    }
    return ["success": true, "data": ["ipAddress": addresses.first.map { $0 as Any } ?? NSNull()]]
}

#if os(macOS)
import ScreenCaptureKit

func handleScreenshot(_ action: [String: Any]) -> [String: Any] { GuestCapture.shared.begin(action) }

private let guestInputAdmission = DispatchSemaphore(value: 1)

func eventTargetPID(_ action: [String: Any]) -> pid_t? {
    guard let query = action["app"] as? String, !query.isEmpty else { return nil }
    let exact = query.lowercased()
    let matches = NSWorkspace.shared.runningApplications.filter { app in
        !app.isTerminated && [app.localizedName, app.bundleIdentifier, app.bundleURL?.deletingPathExtension().lastPathComponent, app.executableURL?.lastPathComponent].compactMap { $0?.lowercased() }.contains(exact)
    }
    return matches.count == 1 ? matches[0].processIdentifier : nil
}

func postEvent(_ event: CGEvent, targetPID: pid_t?) {
    if let targetPID {
        // Per-pid delivery skips the WindowServer, which stamps a tap-posted
        // event. Unstamped, the app reads a time from just after boot, and
        // Chromium traps on such a click when it starts a same-document navigation.
        event.timestamp = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        event.postToPid(targetPID)
    } else { event.post(tap: .cghidEventTap) }
}

func handleType(_ action: [String: Any]) -> [String: Any] {
    guard let text = action["text"] as? String, !text.contains("\0"), text.utf8.count <= 32_768 else { return ["success": false, "error": "type requires bounded text without NUL"] }
    guard guestInputAdmission.wait(timeout: .now()) == .success else { return ["success": false, "error": "guest input still owns delivery"] }
    defer { guestInputAdmission.signal() }
    let pid = eventTargetPID(action)
    guard action["app"] == nil || pid != nil else { return ["success": false, "error": "type requires one exact running app; no global input was substituted"] }
    guard CGPreflightPostEventAccess(), let source = CGEventSource(stateID: .privateState) else { return ["success": false, "error": "type requires guest native event permission"] }
    var events: [CGEvent] = []
    for scalar in text.unicodeScalars {
        let units = Array(String(scalar).utf16)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true), let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { return ["success": false, "error": "type event construction failed before delivery"] }
        units.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        down.flags = []; up.flags = []; events.append(down); events.append(up)
    }
    for event in events { postEvent(event, targetPID: pid) }
    return ["success": true, "data": ["transport": "coregraphics", "submittedEvents": events.count, "guestEffectVerified": false, "textUTF8Bytes": text.utf8.count]]
}

func handleClick(_ action: [String: Any]) -> [String: Any] {
    guard let nx = action["x"] as? NSNumber, let ny = action["y"] as? NSNumber,
          CFGetTypeID(nx) != CFBooleanGetTypeID(), CFGetTypeID(ny) != CFBooleanGetTypeID(), nx.doubleValue.isFinite, ny.doubleValue.isFinite else { return ["success": false, "error": "click requires actual finite guest pixel coordinates"] }
    let x = nx.doubleValue, y = ny.doubleValue, button = action["button"] as? String ?? "left"
    guard ["left", "right", "middle"].contains(button) else { return ["success": false, "error": "unknown guest pointer button"] }
    let display = CGMainDisplayID(), frame = CGDisplayBounds(display)
    let width = CGDisplayPixelsWide(display), height = CGDisplayPixelsHigh(display)
    guard width > 0, height > 0, frame.width > 0, frame.height > 0, x >= 0, y >= 0, x < Double(width), y < Double(height) else { return ["success": false, "error": "click is outside the actual guest main display"] }
    guard guestInputAdmission.wait(timeout: .now()) == .success else { return ["success": false, "error": "guest input still owns delivery"] }
    defer { guestInputAdmission.signal() }
    let pid = eventTargetPID(action)
    guard action["app"] == nil || pid != nil else { return ["success": false, "error": "click requires one exact running app; no global input was substituted"] }
    guard CGPreflightPostEventAccess(), let source = CGEventSource(stateID: .privateState) else { return ["success": false, "error": "click requires guest native event permission"] }
    let mouse: CGMouseButton = button == "right" ? .right : button == "middle" ? .center : .left
    let downType: CGEventType = button == "right" ? .rightMouseDown : button == "middle" ? .otherMouseDown : .leftMouseDown
    let upType: CGEventType = button == "right" ? .rightMouseUp : button == "middle" ? .otherMouseUp : .leftMouseUp
    let point = CGPoint(x: frame.minX + x * frame.width / Double(width), y: frame.minY + y * frame.height / Double(height))
    guard let down = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: mouse), let up = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: mouse) else { return ["success": false, "error": "click event construction failed before delivery"] }
    postEvent(down, targetPID: pid); postEvent(up, targetPID: pid)
    return ["success": true, "data": ["transport": "coregraphics", "submittedEvents": 2, "guestEffectVerified": false, "x": x, "y": y, "button": button]]
}

func handleKeys(_ action: [String: Any]) -> [String: Any] {
    guard let text = action["keys"] as? String, text.utf8.count <= 4096, let chord = InputKeycodes.macChord(text) else { return ["success": false, "error": "keys requires one supported physical chord without unknown or duplicate modifiers"] }
    guard guestInputAdmission.wait(timeout: .now()) == .success else { return ["success": false, "error": "guest input still owns delivery"] }
    defer { guestInputAdmission.signal() }
    let pid = eventTargetPID(action)
    guard action["app"] == nil || pid != nil else { return ["success": false, "error": "keys requires one exact running app; no global input was substituted"] }
    guard CGPreflightPostEventAccess(), let source = CGEventSource(stateID: .privateState), let down = CGEvent(keyboardEventSource: source, virtualKey: chord.code, keyDown: true), let up = CGEvent(keyboardEventSource: source, virtualKey: chord.code, keyDown: false) else { return ["success": false, "error": "keys requires guest permission and actual native events"] }
    var flags: CGEventFlags = []
    for modifier in chord.modifiers {
        switch modifier { case "shift": flags.insert(.maskShift); case "control": flags.insert(.maskControl); case "option": flags.insert(.maskAlternate); case "command": flags.insert(.maskCommand); default: break }
    }
    down.flags = flags; up.flags = flags
    postEvent(down, targetPID: pid); postEvent(up, targetPID: pid)
    return ["success": true, "data": ["transport": "coregraphics", "submittedEvents": 2, "guestEffectVerified": false, "keys": text]]
}

func handleReadAX(_ action: [String: Any]) -> [String: Any] { GuestAX.read(action) }

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

func handleMount(_ action: [String: Any]) -> [String: Any] { GuestMount.mount(action) }

func handleCopyIn(_ action: [String: Any]) -> [String: Any] { GuestFiles.copyIn(action) }

func handleCopyOut(_ action: [String: Any]) -> [String: Any] { GuestFiles.copyOut(action) }

func handleLogs(_ action: [String: Any]) -> [String: Any] {
    guard let number = (action["limit"] ?? 200) as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.rounded(.towardZero) == number.doubleValue, (1...1000).contains(number.doubleValue) else {
        return ["success": false, "error": "logs: limit must be an integer1...1000"]
    }
    let limit = number.intValue, paths = ["/tmp/InterceptorD.err.log", "/tmp/InterceptorD.out.log"]
    var entries: [[String: Any]] = [], remaining = 65_536, partial = false
    let deadline: GuestWire.Deadline
    do { deadline = try .init(seconds: min(5, GuestWire.requestBudget(action, defaultSeconds: 5))) } catch { return ["success": false, "error": "logs: invalid budget"] }
    for path in paths {
        do {
            let data = try GuestFiles.File(path: path, create: false).read(deadline: deadline)
            guard let text = String(data: data, encoding: .utf8) else { throw GuestWire.Failure.framing("log is not complete UTF8") }
            var lines: [String] = [], truncated = false
            // Walk from the end, retaining at most the requested line count.
            // Unicode scalar clipping cannot split a surrogate/UTF8 sequence.
            for line in text.split(separator: "\n", omittingEmptySubsequences: false).suffix(limit).reversed() {
                let clipped = String(String.UnicodeScalarView(line.unicodeScalars.prefix(512)))
                guard clipped.utf8.count <= remaining else { truncated = true; break }
                remaining -= clipped.utf8.count
                if clipped != line { truncated = true }
                lines.append(clipped)
            }
            partial = partial || truncated
            entries.append(["path": path, "lines": Array(lines.reversed()), "state": "read", "truncated": truncated])
        } catch {
            partial = true
            entries.append(["path": path, "lines": [String](), "state": "unavailable", "truncated": false, "error": "retained log read failed or changed: \(error)"])
        }
    }
    return ["success": true, "data": ["logs": entries, "partial": partial]]
}

func boolFlag(_ action: [String: Any], _ key: String) -> Bool {
    guard let value = action[key] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
    return value.boolValue
}

#if os(macOS)
func resetTCC(service: String, timeout: Double) -> [String: Any] {
    let result = GuestExecution.execute(["argv": ["/usr/bin/tccutil", "reset", service], "timeout": min(10, timeout)])
    guard result["success"] as? Bool == true, let data = result["data"] as? [String: Any], let code = data["exitCode"] as? NSNumber,
          let out = data["stdout"] as? String, let err = data["stderr"] as? String, let duration = data["durationMs"] as? NSNumber else {
        return ["service": service, "ok": false, "outcomeUnknown": true, "error": "owned TCC reset failed or its outcome is unknown: \(result["error"] as? String ?? "missing native exit")"]
    }
    let clippedOut = String(String.UnicodeScalarView(out.unicodeScalars.prefix(4096))), clippedErr = String(String.UnicodeScalarView(err.unicodeScalars.prefix(4096)))
    return ["service": service, "ok": code.intValue == 0, "exitCode": code, "stdout": clippedOut, "stderr": clippedErr, "durationMs": duration, "truncated": clippedOut != out || clippedErr != err]
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

private let guestTrustAdmission = DispatchSemaphore(value: 1)

func handleTrust(_ action: [String: Any]) -> [String: Any] {
#if os(macOS)
    for key in ["noPrompt", "prompt", "walkthrough", "accessibilityPrompt", "screenPrompt", "resetDenied"] {
        if let raw = action[key] { guard let value = raw as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return ["success": false, "error": "trust flags require actual Booleans; no prompt or reset was performed"] } }
    }
    let deadline: GuestWire.Deadline
    do { deadline = try .init(seconds: GuestWire.requestBudget(action, defaultSeconds: 30)) }
    catch { return ["success": false, "error": "trust: invalid request budget; no prompt or reset was performed"] }
    guard guestTrustAdmission.wait(timeout: .now()) == .success else { return ["success": false, "error": "trust: another native permission query, prompt or reset still owns admission"] }
    defer { guestTrustAdmission.signal() }
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
        do {
            if shouldPromptAccessibility { resetResults.append(resetTCC(service: "Accessibility", timeout: try deadline.remaining())) }
            if shouldPromptScreen { resetResults.append(resetTCC(service: "ScreenCapture", timeout: try deadline.remaining())) }
        } catch {
            return ["success": false, "error": "trust: native reset exhausted the request deadline; inspect guest permission state before retrying"]
        }
    }
    guard (try? deadline.remaining()) != nil else { return ["success": false, "error": "trust: deadline expired before permission queries or prompts"] }
    let accessibility = checkAccessibility(prompt: shouldPromptAccessibility)
    guard (try? deadline.remaining()) != nil else { return ["success": false, "error": "trust: native Accessibility query or prompt exceeded the deadline; no screen prompt followed"] }
    let screenRecording = checkScreenRecording(prompt: shouldPromptScreen)
    guard (try? deadline.remaining()) != nil else { return ["success": false, "error": "trust: native screen query or prompt exceeded the deadline; observe guest state before retrying"] }

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
        "postEvent": CGPreflightPostEventAccess() ? "granted" : "denied",
        "inputMonitoring": CGPreflightListenEventAccess() ? "granted" : "denied",
        "notes": [
            "Accessibility and Screen Recording expose only boolean preflight state through public APIs here.",
            "PostEvent and Input Monitoring report their actual public boolean preflight state.",
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
    case "ping", "get_ip", "trust", "read_ax", "screenshot", "screenshot_chunk", "screenshot_release", "logs":
        return false
    default:
        return true
    }
}

// MARK: - Request dispatcher

func dispatch(request: [String: Any]) -> [String: Any] {
    let id: String
    do { id = try GuestWire.requestID(request) }
    catch { return errorResult(request["id"] as? String ?? "", "invalid guest request envelope") }
    guard let action = request["action"] as? [String: Any] else {
        return errorResult(id, "missing action")
    }
    guard let verb = action["verb"] as? String else {
        return errorResult(id, "missing action.verb")
    }
    let fields: [String: Set<String>] = [
        "ping": [], "get_ip": [], "exec": ["argv", "env", "workdir", "user", "tty", "timeout"],
        "screenshot": ["timeout"], "screenshot_chunk": ["snapshotId", "offset", "length"], "screenshot_release": ["snapshotId"],
        "type": ["text", "app", "timeout"], "click": ["x", "y", "button", "app", "timeout"], "keys": ["keys", "app", "timeout"],
        "read_ax": ["app", "max_depth", "timeout"], "mount": ["tag", "path", "timeout"],
        "cp_in": ["path", "dataBase64", "mode", "timeout"], "cp_out": ["path", "timeout"], "logs": ["limit", "timeout"],
        "trust": ["noPrompt", "prompt", "walkthrough", "accessibilityPrompt", "screenPrompt", "resetDenied", "timeout"]
    ]
    guard let allowed = fields[verb], Set(action.keys).isSubset(of: allowed.union(["verb", "authToken"])) else {
        return errorResult(id, "unknown guest verb or field; no native operation was submitted")
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
    case "screenshot_chunk": result = GuestCapture.shared.chunk(action)
    case "screenshot_release": result = GuestCapture.shared.release(action)
    case "type":       result = handleType(action)
    case "click":      result = handleClick(action)
    case "keys":       result = handleKeys(action)
    case "read_ax":    result = handleReadAX(action)
    case "mount":      result = handleMount(action)
    case "cp_in":      result = handleCopyIn(action)
    case "cp_out":     result = handleCopyOut(action)
    case "trust":      result = handleTrust(action)
    case "logs":       result = handleLogs(action)
    case "ping":       result = ["success": true, "data": ["pong": true, "protocolVersion": GuestWire.protocolVersion, "features": [GuestWire.exclusiveCopyFeature, GuestWire.snapshotFeature]]]
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

let guestConnectionAdmission = DispatchSemaphore(value: 8)

func serveAcceptedClients(server: Int32) -> Never {
    guard Darwin.listen(server, 5) == 0 else {
        fputs("InterceptorD: listen failed\n", stderr)
        Darwin.close(server)
        exit(1)
    }
    while true {
        let client = Darwin.accept(server, nil, nil)
        if client < 0 { if errno != EINTR { Thread.sleep(forTimeInterval: 0.01) }; continue }
        guard guestConnectionAdmission.wait(timeout: .now()) == .success else { Darwin.close(client); continue }
        Thread.detachNewThread {
            defer { guestConnectionAdmission.signal() }
            handleClient(fd: client)
        }
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
    do {
        // Exactly one frame and reply per connection. Invalid or partial
        // framing closes the connection rather than resynchronizing it.
        let deadline = try GuestWire.Deadline(seconds: 58)
        let request = try GuestWire.read(fd: fd, deadline: deadline)
        _ = try GuestWire.requestID(request)
        let response = dispatch(request: request)
        let frame = try GuestWire.encode(response)
        try GuestWire.write(fd: fd, frame: frame, deadline: deadline)
    } catch {
        // No result is fabricated and no request is replayed after a lost
        // response. Native handler effects can remain and require observation.
        fputs("InterceptorD: guest exchange closed: \(error)\n", stderr)
    }
}

// MARK: - Entry point

let transport = ProcessInfo.processInfo.environment["INTERCEPTOR_GUEST_TCP_LISTEN"] == "1" ? "tcp-diagnostic" : "vsock"
fputs("InterceptorD starting on \(transport) port \(kAgentPort)\n", stderr)
#if os(macOS)
// Native frameworks can dispatch completions to the main queue. The socket
// accept loop must not hold it forever. This agent has no activating UI.
let guestApplication = NSApplication.shared
guestApplication.setActivationPolicy(.prohibited)
DispatchQueue.global(qos: .userInitiated).async { serve() }
guestApplication.run()
exit(1)
#else
serve()
#endif
