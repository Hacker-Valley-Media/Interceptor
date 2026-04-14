import Foundation
import AppKit
import ApplicationServices

final class MonitorDomain: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var sessions: [String: MonitorSession] = [:]
    private var activeSessionId: String?
    private var globalMonitor: Any?
    private var workspaceObservers: [NSObjectProtocol] = []
    private let refRegistry: RefRegistry

    init(refRegistry: RefRegistry = .shared) {
        self.refRegistry = refRegistry
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "start":
            startSession(action, completion: completion)
        case "stop":
            stopSession(completion: completion)
        case "status":
            getStatus(completion: completion)
        case "pause":
            pauseSession(completion: completion)
        case "resume":
            resumeSession(completion: completion)
        case "tail":
            tailEvents(action, completion: completion)
        case "list":
            listSessions(completion: completion)
        case "export":
            exportSession(action, completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func startSession(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sid = UUID().uuidString.prefix(8).lowercased()
        let instruction = action["instruction"] as? String

        let session = MonitorSession(
            id: String(sid),
            instruction: instruction,
            startTime: Date()
        )

        lock.lock()
        sessions[String(sid)] = session
        activeSessionId = String(sid)
        lock.unlock()

        // Start global event monitoring
        startGlobalMonitoring()
        // Start workspace notifications
        startWorkspaceMonitoring()

        Platform.emitEvent("mon_start", data: ["sid": sid])

        completion(WireFormat.success([
            "sid": sid,
            "instruction": instruction ?? "",
            "status": "recording"
        ]))
    }

    private func stopSession(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        guard let sid = activeSessionId, let session = sessions[sid] else {
            lock.unlock()
            completion(WireFormat.error("no active session"))
            return
        }
        session.endTime = Date()
        activeSessionId = nil
        lock.unlock()

        stopGlobalMonitoring()
        stopWorkspaceMonitoring()

        Platform.emitEvent("mon_stop", data: ["sid": sid])

        let duration = session.endTime!.timeIntervalSince(session.startTime)
        completion(WireFormat.success([
            "sid": sid,
            "duration": duration,
            "eventCount": session.events.count,
            "status": "stopped"
        ]))
    }

    private func getStatus(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        if let sid = activeSessionId, let session = sessions[sid] {
            lock.unlock()
            completion(WireFormat.success([
                "sid": sid,
                "status": session.paused ? "paused" : "recording",
                "eventCount": session.events.count,
                "duration": Date().timeIntervalSince(session.startTime)
            ]))
        } else {
            lock.unlock()
            completion(WireFormat.success(["status": "idle"]))
        }
    }

    private func pauseSession(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        if let sid = activeSessionId, let session = sessions[sid] {
            session.paused = true
            lock.unlock()
            completion(WireFormat.success(["sid": sid, "status": "paused"]))
        } else {
            lock.unlock()
            completion(WireFormat.error("no active session"))
        }
    }

    private func resumeSession(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        if let sid = activeSessionId, let session = sessions[sid] {
            session.paused = false
            lock.unlock()
            completion(WireFormat.success(["sid": sid, "status": "recording"]))
        } else {
            lock.unlock()
            completion(WireFormat.error("no active session"))
        }
    }

    private func tailEvents(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        let sid = activeSessionId ?? action["sid"] as? String ?? ""
        let session = sessions[sid]
        let limit = action["limit"] as? Int ?? 50
        let events = session.map { Array($0.events.suffix(limit)) } ?? []
        lock.unlock()
        completion(WireFormat.success(events))
    }

    private func listSessions(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        let list = sessions.map { (sid, session) -> [String: Any] in
            return [
                "sid": sid,
                "instruction": session.instruction ?? "",
                "eventCount": session.events.count,
                "duration": (session.endTime ?? Date()).timeIntervalSince(session.startTime),
                "status": session.endTime != nil ? "stopped" : (session.paused ? "paused" : "recording")
            ]
        }
        lock.unlock()
        completion(WireFormat.success(list))
    }

    private func exportSession(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let sid = action["sid"] as? String else {
            completion(WireFormat.error("export requires a sid"))
            return
        }
        lock.lock()
        guard let session = sessions[sid] else {
            lock.unlock()
            completion(WireFormat.error("session not found: \(sid)"))
            return
        }
        let events = session.events
        let instruction = session.instruction
        lock.unlock()

        let format = action["format"] as? String ?? "timeline"

        switch format {
        case "json":
            completion(WireFormat.success(events))
        case "plan":
            let plan = generateReplayPlan(events: events)
            completion(WireFormat.success(plan))
        default: // "timeline"
            let timeline = generateTimeline(events: events, instruction: instruction)
            completion(WireFormat.success(timeline))
        }
    }

    // MARK: - Global Event Monitoring

    private func startGlobalMonitoring() {
        DispatchQueue.main.async { [weak self] in
            self?.globalMonitor = NSEvent.addGlobalMonitorForEvents(
                matching: [.leftMouseDown, .rightMouseDown, .keyDown, .scrollWheel]
            ) { [weak self] event in
                self?.handleGlobalEvent(event)
            }
        }
    }

    private func stopGlobalMonitoring() {
        DispatchQueue.main.async { [weak self] in
            if let monitor = self?.globalMonitor {
                NSEvent.removeMonitor(monitor)
                self?.globalMonitor = nil
            }
        }
    }

    private func handleGlobalEvent(_ event: NSEvent) {
        lock.lock()
        guard let sid = activeSessionId, let session = sessions[sid], !session.paused else {
            lock.unlock()
            return
        }
        lock.unlock()

        let seq = session.nextSeq()
        let app = NSWorkspace.shared.frontmostApplication
        var entry: [String: Any] = [
            "t": Int(Date().timeIntervalSince1970 * 1000),
            "s": seq,
            "sid": session.id,
            "app": app?.localizedName ?? "unknown",
            "tr": true
        ]

        switch event.type {
        case .leftMouseDown, .rightMouseDown:
            entry["k"] = event.type == .rightMouseDown ? "rightclick" : "click"
            entry["x"] = Int(event.locationInWindow.x)
            entry["y"] = Int(event.locationInWindow.y)
            // Try to correlate with AX element at click location
            if let runApp = app {
                let axApp = AXUIElementCreateApplication(runApp.processIdentifier)
                var element: AXUIElement?
                let point = CGPoint(x: NSEvent.mouseLocation.x, y: (NSScreen.main?.frame.height ?? 0) - NSEvent.mouseLocation.y)
                if AXUIElementCopyElementAtPosition(axApp, Float(point.x), Float(point.y), &element) == .success,
                   let axEl = element {
                    var role: CFTypeRef?
                    var title: CFTypeRef?
                    AXUIElementCopyAttributeValue(axEl, kAXRoleAttribute as CFString, &role)
                    AXUIElementCopyAttributeValue(axEl, kAXTitleAttribute as CFString, &title)
                    entry["r"] = (role as? String) ?? ""
                    entry["n"] = (title as? String) ?? ""
                }
            }
        case .keyDown:
            entry["k"] = "key"
            let modifiers = event.modifierFlags
            var combo = ""
            if modifiers.contains(.command) { combo += "Meta+" }
            if modifiers.contains(.control) { combo += "Control+" }
            if modifiers.contains(.option) { combo += "Alt+" }
            if modifiers.contains(.shift) { combo += "Shift+" }
            combo += event.charactersIgnoringModifiers ?? ""
            entry["kc"] = combo
        case .scrollWheel:
            entry["k"] = "scroll"
            entry["dx"] = event.scrollingDeltaX
            entry["dy"] = event.scrollingDeltaY
        default:
            break
        }

        lock.lock()
        session.events.append(entry)
        lock.unlock()
    }

    // MARK: - Workspace Monitoring

    private func startWorkspaceMonitoring() {
        let nc = NSWorkspace.shared.notificationCenter
        let activateObs = nc.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { [weak self] notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.recordAppSwitch(to: app)
        }
        workspaceObservers.append(activateObs)
    }

    private func stopWorkspaceMonitoring() {
        for obs in workspaceObservers {
            NSWorkspace.shared.notificationCenter.removeObserver(obs)
        }
        workspaceObservers.removeAll()
    }

    private func recordAppSwitch(to app: NSRunningApplication) {
        lock.lock()
        guard let sid = activeSessionId, let session = sessions[sid], !session.paused else {
            lock.unlock()
            return
        }
        lock.unlock()

        let seq = session.nextSeq()
        let entry: [String: Any] = [
            "t": Int(Date().timeIntervalSince1970 * 1000),
            "s": seq,
            "k": "app_switch",
            "sid": session.id,
            "app": app.localizedName ?? "unknown",
            "bundleId": app.bundleIdentifier ?? "",
            "tr": true
        ]

        lock.lock()
        session.events.append(entry)
        lock.unlock()
    }

    // MARK: - Export Generators

    private func generateTimeline(events: [[String: Any]], instruction: String?) -> String {
        var lines: [String] = []
        if let instruction = instruction {
            lines.append("# Session: \(instruction)")
            lines.append("")
        }
        for event in events {
            let ts = event["t"] as? Int ?? 0
            let kind = event["k"] as? String ?? "?"
            let app = event["app"] as? String ?? ""
            let name = event["n"] as? String ?? ""
            let role = event["r"] as? String ?? ""
            let date = Date(timeIntervalSince1970: Double(ts) / 1000)
            let formatter = DateFormatter()
            formatter.dateFormat = "HH:mm:ss.SSS"
            let timeStr = formatter.string(from: date)

            switch kind {
            case "click", "rightclick":
                lines.append("\(timeStr)  \(kind.uppercased())  \(app)  \(role):\(name)")
            case "key":
                let kc = event["kc"] as? String ?? ""
                lines.append("\(timeStr)  KEY       \(app)  \(kc)")
            case "scroll":
                lines.append("\(timeStr)  SCROLL    \(app)")
            case "app_switch":
                lines.append("\(timeStr)  APP       → \(app)")
            default:
                lines.append("\(timeStr)  \(kind)  \(app)")
            }
        }
        return lines.joined(separator: "\n")
    }

    private func generateReplayPlan(events: [[String: Any]]) -> String {
        var lines: [String] = []
        var lastApp = ""

        for event in events {
            let kind = event["k"] as? String ?? ""
            let app = event["app"] as? String ?? ""
            let name = event["n"] as? String ?? ""
            let role = event["r"] as? String ?? ""

            if app != lastApp && !app.isEmpty {
                lines.append("interceptor macos app activate \"\(app)\"")
                lastApp = app
            }

            switch kind {
            case "click":
                if !role.isEmpty && !name.isEmpty {
                    lines.append("interceptor macos click \"\(role):\(name)\"")
                } else {
                    let x = event["x"] as? Int ?? 0
                    let y = event["y"] as? Int ?? 0
                    lines.append("interceptor macos click \(x),\(y)")
                }
            case "rightclick":
                if !role.isEmpty && !name.isEmpty {
                    lines.append("interceptor macos click \"\(role):\(name)\" --right")
                }
            case "key":
                let kc = event["kc"] as? String ?? ""
                lines.append("interceptor macos keys \"\(kc)\"")
            case "input":
                let value = event["v"] as? String ?? ""
                if !role.isEmpty {
                    lines.append("interceptor macos type \"\(role):\(name)\" \"\(value)\"")
                }
            default:
                break
            }
        }
        return lines.joined(separator: "\n")
    }
}

final class MonitorSession: @unchecked Sendable {
    let id: String
    let instruction: String?
    let startTime: Date
    var endTime: Date?
    var paused: Bool = false
    var events: [[String: Any]] = []
    private var seqCounter: Int = 0
    private let seqLock = NSLock()

    init(id: String, instruction: String?, startTime: Date) {
        self.id = id
        self.instruction = instruction
        self.startTime = startTime
    }

    func nextSeq() -> Int {
        seqLock.lock()
        let seq = seqCounter
        seqCounter += 1
        seqLock.unlock()
        return seq
    }
}
