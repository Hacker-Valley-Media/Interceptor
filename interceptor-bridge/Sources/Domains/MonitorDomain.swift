import Foundation
import AppKit
import ApplicationServices
import CoreFoundation
import CoreImage
import CoreMedia
import CoreVideo
import AVFoundation
import ImageIO
import Network
import UniformTypeIdentifiers
#if canImport(OSLog)
import OSLog
#endif
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif
#if canImport(Vision)
import Vision
#endif
#if canImport(UserNotifications)
import UserNotifications
#endif
#if canImport(Speech)
import Speech
import AVFoundation
#endif

// `interceptor macos monitor` orchestrator. Concurrent multi-session via
// `runtimes: [sid: MonitorRuntime]` lets the bridge run N sessions at once,
// each with its own AX / workspace / input / tap / source state.
// The CGEventTap fallback (`--tap`) is wired through MonitorTapBridge, which
// runs at kCGSessionEventTap placement (no root, Accessibility-gated).
//
// Persistence shape mirrors the browser monitor (shared/monitor-artifacts.ts).
// Optional sources opt-in via `--include` flag (clipboard / files / network /
// log / notifications / speech) and the `--frames N` / `--vision-text` flags.
//
// TCC preflight is the first thing `start` does: AXIsProcessTrusted must be
// true before any AX observer or NSEvent global monitor is created.

final class MonitorDomain: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    // the accessibility preflight routes through the transport.
    private let axTransport: any AXTransport = LiveAXTransport()
    // Concurrent multi-session map. Each runtime owns its own AX /
    // workspace / input / tap bridges plus optional source state.
    var runtimes: [String: MonitorRuntime] = [:]

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        // Legacy and neutral routes share the archive guard before any read or
        // suffix operation. Lifecycle lookup retains its existing target errors.
        if let error = DesktopMonitorValidation.archiveError(action) {
            completion(DesktopMonitorValidation.failure(error))
            return
        }
        let sub = action["sub"] as? String ?? command
        let reply: @Sendable ([String: Any]) -> Void = { completion(DesktopMonitorValidation.bounded($0)) }
        switch sub {
        case "start":   startSession(action, completion: reply)
        case "stop", "pause", "resume":
            scheduleLifecycle(sub: sub, action: action, reason: "user_stop", completion: reply)
        case "status":  statusSession(action: action, completion: reply)
        case "tail":    tailEvents(action, completion: reply)
        case "list":    listSessions(action, completion: reply)
        case "export":  exportSession(action, completion: reply)
        default:        notImplemented(sub, completion: reply)
        }
    }

    // MARK: - lifecycle: start

    private func scheduleLifecycle(sub: String, action: [String: Any], reason: String,
                                   completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let runtime = lookupRuntime(action: action) else {
            let error = WireFormat.failure("target_gone", "no active recording matches the requested sid")
            completion(error)
            return
        }
        let actionBox = UncheckedSendableBox(action)
        runtime.captureLock.lock()
        guard runtime.pendingLifecycleRequests < 16 else {
            runtime.captureLock.unlock()
            completion(["success": false, "code": "resource_limit", "error": "monitor lifecycle queue is full"])
            return
        }
        runtime.pendingLifecycleRequests += 1
        let previous = runtime.lifecycleTask
        let (acknowledged, gate) = AsyncStream<Void>.makeStream()
        let invoke: @Sendable () -> Void = { [self, runtime] in
            let finish: @Sendable ([String: Any]) -> Void = { result in
                runtime.captureLock.withLock {
                    runtime.pendingLifecycleRequests -= 1
                    if runtime.pendingLifecycleRequests == 0 { runtime.lifecycleTask = nil }
                }
                completion(result)
                gate.finish()
            }
            switch sub {
            case "stop": stopSession(action: actionBox.value, reason: reason, completion: finish)
            case "pause": pauseSession(action: actionBox.value, completion: finish)
            default: resumeSession(action: actionBox.value, completion: finish)
            }
        }
        runtime.lifecycleTask = Task {
            await previous?.value
            if previous != nil { invoke() }
            for await _ in acknowledged {}
        }
        // Start the first operation while owning the gate. Following operations
        // wait for its acknowledgment, including asynchronous stream shutdown.
        if previous == nil { invoke() }
        runtime.captureLock.unlock()
    }

    private func startSession(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        // Accessibility preflight (shared across sessions).
        let axTrusted = axTransport.isProcessTrusted()
        if !axTrusted {
            let err = WireFormat.failure("permission_required", "monitor needs Accessibility access for interceptor-bridge; run interceptor macos trust --accessibility-prompt", details: ["remediation": "interceptor macos trust --accessibility-prompt"])
            completion(err)
            return
        }

        let instruction = action["instruction"] as? String
        let taskId = action["taskId"] as? String
        let includes = parseSet(action["include"])
        let excludes = parseSet(action["exclude"])
        let scope = parseScope(action)
        let framesPerSec = (action["frames"] as? Int) ?? 0
        let visionText = (action["visionText"] as? Bool) ?? false
        // Frame encoding knobs. Default jpeg q=80 mirrors CaptureDomain
        // ("WebP added to format union; default jpeg with q80"). Naive PNG
        // is 10-20× larger and was the wrong default — fixed in this revision.
        let frameFormat = (action["frameFormat"] as? String) ?? "jpeg"
        let frameQuality = (action["frameQuality"] as? Int) ?? 80
        let frameMaxLongEdge = (action["frameMaxLongEdge"] as? Int) ?? 1600
        let includeMouseMoved = excludes.contains("mouse-moved") == false && includes.contains("mouse-moved")
        let excludeKey = excludes.contains("key")
        let useTap = (action["tap"] as? Bool) ?? false

        // new capture config knobs.
        let speechMode = ((action["speechMode"] as? String) ?? "auto").lowercased()
        let videoFps = action["video"] as? Int            // nil = video off
        let videoMaxBytes = Int64((action["videoMaxBytes"] as? Int) ?? 0)
        let frameBudget = max(1, (action["frameBudget"] as? Int).flatMap { $0 == 0 ? nil : $0 } ?? 7200)
        let frameDiskCapBytes = Int64((action["frameDiskCap"] as? Int).flatMap { $0 == 0 ? nil : $0 } ?? 100 * 1024 * 1024)
        let framePixelScale = (action["framePixelScale"] as? Int) ?? 0
        let scrollCoalesceMs = (action["scrollCoalesceMs"] as? Int) ?? 100
        let axCoalesceMs = (action["axCoalesceMs"] as? Int) ?? 100
        let includeSystemApps = (action["includeSystemApps"] as? Bool) ?? false
        let excludeApps = parseSet(action["excludeApps"])

        let wantsMedia = framesPerSec > 0 || videoFps != nil
        var mediaPid: pid_t?
        if wantsMedia {
            var validated = action
            validated["type"] = "desktop_monitor"
            if let error = DesktopMonitorValidation.validate(validated) { completion(error); return }
            guard scope.mode == .apps, scope.apps.count == 1 else {
                completion(["success": false, "code": "unsupported", "error": "monitor media requires one explicit app; no display fallback"])
                return
            }
            guard frameDiskCapBytes <= MonitorRuntime.sessionMaxBytesPerFile else {
                completion(["success": false, "code": "invalid_request", "error": "monitor frameDiskCap cannot exceed 100 MiB"])
                return
            }
            let matched = resolveInitialPids(scope: scope)
            guard matched.count == 1 else {
                completion(["success": false, "code": "target_not_found", "error": "monitor media requires one running app matching the scope"])
                return
            }
            mediaPid = matched[0].0
        }

        // Screen recording preflight if --frames, --video, or --vision-text.
        var screenRecordingTcc: Bool? = nil
        if framesPerSec > 0 || visionText || videoFps != nil {
            #if canImport(ScreenCaptureKit)
            let granted = CGPreflightScreenCaptureAccess()
            screenRecordingTcc = granted
            if !granted {
                let err = WireFormat.failure("permission_required", "monitor needs Screen Recording access for interceptor-bridge; run interceptor macos trust --screen-prompt", details: ["remediation": "interceptor macos trust --screen-prompt"])
                completion(err)
                return
            }
            #else
            completion(WireFormat.error("screen recording requested but ScreenCaptureKit not available"))
            return
            #endif
        }

        // sid: 8-char lowercase hex.
        let sid = String(UUID().uuidString.prefix(8)).lowercased()
        let tcc = MonitorTccSnapshot(
            accessibility: axTrusted,
            screenRecording: screenRecordingTcc,
            microphone: nil
        )
        let session = MonitorSession(
            id: sid,
            taskId: taskId,
            instruction: instruction,
            startTime: Date(),
            scope: scope,
            includes: includes,
            excludes: excludes,
            tcc: tcc
        )
        let runtime = MonitorRuntime(session: session, domain: self)
        // stash capture config on the runtime.
        runtime.speechMode = speechMode
        runtime.framePixelScale = framePixelScale
        runtime.frameBudget = frameBudget
        runtime.frameDiskCapBytes = frameDiskCapBytes
        runtime.videoMaxBytes = videoMaxBytes
        runtime.scrollCoalesceMs = scrollCoalesceMs
        runtime.axCoalesceMs = axCoalesceMs
        runtime.includeSystemApps = includeSystemApps
        runtime.excludeApps = excludeApps
        runtime.axBridge.setCoalesceMs(axCoalesceMs)
        if let mediaPid {
            let app = NSRunningApplication(processIdentifier: mediaPid)
            guard !isExcludedApp(runtime: runtime, bundleId: app?.bundleIdentifier, name: app?.localizedName) else {
                completion(["success": false, "code": "unsupported", "error": "monitor media target is excluded; no archive created"])
                return
            }
            #if canImport(ScreenCaptureKit)
            runtime.capturePid = mediaPid
            runtime.restartCapture = { [weak self, weak runtime] in
                guard let self, let runtime else { return }
                self.startFrameCapture(runtime: runtime, framesPerSec: framesPerSec, videoFps: videoFps,
                    visionText: visionText, format: frameFormat, quality: frameQuality, maxLongEdge: frameMaxLongEdge)
            }
            #endif
        }

        // Wire bridge callbacks to record into THIS session.
        runtime.axBridge.setCallback { [weak self, weak runtime] event, data in
            guard let r = runtime else { return }
            self?.recordEvent(runtime: r, event: event, data: data)
        }
        runtime.workspaceBridge.setCallback { [weak self, weak runtime] event, data in
            guard let r = runtime else { return }
            self?.recordEvent(runtime: r, event: event, data: data)
        }
        runtime.workspaceBridge.setAppLifecycleHooks(
            launch: { [weak self, weak runtime] pid, bundleId, name in
                guard let self = self, let r = runtime else { return }
                if r.session.scope.mode == .all, !self.isExcludedApp(runtime: r, bundleId: bundleId, name: name) {
                    self.attachToPid(runtime: r, pid: pid, bundleId: bundleId, appName: name)
                }
            },
            terminate: { [weak runtime] pid in
                runtime?.axBridge.detach(pid: pid)
            }
        )
        let appFilter: (NSRunningApplication?) -> Bool = { [weak self, weak runtime] app in
            guard let self, let r = runtime, let app, !r.session.paused else { return false }
            return !self.isExcludedApp(runtime: r, bundleId: app.bundleIdentifier, name: app.localizedName)
        }
        runtime.inputBridge.setCallback({ [weak self, weak runtime] event, data in
            guard let r = runtime else { return }
            self?.recordEvent(runtime: r, event: event, data: data)
        }, appFilter: appFilter)
        runtime.tapBridge.setCallback({ [weak self, weak runtime] event, data in
            guard let r = runtime else { return }
            self?.recordEvent(runtime: r, event: event, data: data)
        }, appFilter: appFilter)

        // Register the runtime BEFORE kicking off bridges so concurrent
        // events arriving on async queues find the right session.
        lock.lock()
        guard runtimes.count < DESKTOP_MONITOR_MAX_SESSIONS else {
            lock.unlock()
            completion(["success": false, "code": "resource_limit", "error": "at most 16 native recordings may be active"])
            return
        }
        runtimes[sid] = runtime
        lock.unlock()

        // speech is enabled by `--include speech` OR an explicit
        // `--speech-mode live|offline`; `--speech-mode off` disables it.
        let speechEnabled = speechMode != "off" && (includes.contains("speech") || speechMode == "live" || speechMode == "offline")

        // Sendable locals so the async heavy-setup closure doesn't capture the
        // non-Sendable `action` dictionary.
        let watchPathLocal = action["watchPath"] as? String
        let watchPathsLocal = action["watchPaths"] as? [String]
        let logPredicateLocal = action["logPredicate"] as? String

        // Auto-stop timer + meta are cheap; do them before the ack.
        startAutoStopTimer(runtime: runtime)
        Platform.writeSessionMeta(sid: sid, meta: session.toMetaDict())

        var startData: [String: Any] = [
            "surface": "macos",
            "scope": scope.toDict(),
            "includes": Array(includes).sorted(),
            "speechMode": speechMode,
            "tap": useTap
        ]
        if let inst = instruction { startData["ins"] = inst }
        if let taskId = taskId { startData["taskId"] = taskId }
        recordEvent(runtime: runtime, event: "mon_start", data: startData)

        // ACK as soon as the session is registered. All heavy
        // setup (AX attach for every app under --all-apps, source timers, frame
        // / video / speech engines, and the speech-TCC prompt) runs async so the
        // start ack never blocks on capture volume or a permission prompt. This
        // makes the old "15s waiting on speech TCC" hang impossible.
        var ok: [String: Any] = [
            "sid": sid,
            "status": "recording",
            "surface": "macos",
            "tcc": tcc.toDict(),
            "speechMode": speechMode,
            "tap": useTap
        ]
        if let inst = instruction { ok["instruction"] = inst }
        if let taskId = taskId { ok["taskId"] = taskId }
        ok["scope"] = scope.toDict()
        ok["includes"] = Array(includes).sorted()
        ok["sessionDir"] = Platform.sessionDir(sid)
        ok["activeCount"] = lockedRuntimes().count
        completion(WireFormat.success(ok))

        // ── async heavy setup ──
        DispatchQueue.global(qos: .userInitiated).async { [weak self, weak runtime] in
            guard let self = self, let runtime = runtime else { return }
            runtime.captureLock.lock()
            defer { runtime.captureLock.unlock() }
            guard runtime.session.endTime == nil else { return }

            // Initial AX attachments (scope-hygiene filtered).
            let initialPids = self.resolveInitialPids(scope: scope)
            if initialPids.isEmpty && scope.mode != .all {
                self.recordEvent(runtime: runtime, event: "scope_warning", data: ["reason": "no apps matched initial scope"])
            }
            for (pid, bundleId, appName) in initialPids where !self.isExcludedApp(runtime: runtime, bundleId: bundleId, name: appName) {
                self.attachToPid(runtime: runtime, pid: pid, bundleId: bundleId, appName: appName)
            }

            runtime.workspaceBridge.start()
            runtime.inputBridge.start(includeMouseMoved: includeMouseMoved, excludeKey: excludeKey, scrollCoalesceMs: scrollCoalesceMs)

            if useTap {
                let okTap = runtime.tapBridge.start(excludeKey: excludeKey)
                runtime.tapActive = okTap
                if !okTap {
                    self.recordEvent(runtime: runtime, event: "tap_unavailable", data: [
                        "reason": "CGEventTap creation failed (Accessibility TCC may be missing or kCGSessionEventTap was rejected)"
                    ])
                }
            }

            if includes.contains("clipboard") { self.startPasteboardWatch(runtime: runtime) }
            if includes.contains("files") {
                var a: [String: Any] = [:]
                if let p = watchPathLocal { a["watchPath"] = p }
                if let ps = watchPathsLocal { a["watchPaths"] = ps }
                self.startFileWatch(runtime: runtime, action: a)
            }
            if includes.contains("network") { self.startPathMonitor(runtime: runtime) }
            if includes.contains("log") {
                var a: [String: Any] = [:]
                if let lp = logPredicateLocal { a["logPredicate"] = lp }
                self.startLogPolling(runtime: runtime, action: a)
            }
            if includes.contains("notifications") { self.startDistributedNotificationsWatch(runtime: runtime) }
            #if canImport(ScreenCaptureKit)
            if framesPerSec > 0 || videoFps != nil {
                runtime.restartCapture?()
            }
            #endif
            #if canImport(Speech)
            if speechEnabled { self.startSpeechRecognition(runtime: runtime) }
            #endif
        }
    }

    // MARK: - lifecycle: stop / pause / resume / status

    private func stopSession(action: [String: Any], reason: String, completion: @escaping @Sendable ([String: Any]) -> Void) {
        let runtime = lookupRuntime(action: action)
        guard let r = runtime else {
            let err = WireFormat.failure("target_gone", "no active recording matches the requested sid")
            completion(err)
            return
        }
        let s = r.session
        // pause-before-stop. Flip the write gate closed first so
        // an in-flight scroll/AX storm stops being written; then flush what was
        // already enqueued. This is what previously had to be done manually
        // (`pause` then `stop`) for the stop ack to land within the deadline.
        r.captureLock.lock()
        guard s.endTime == nil else {
            r.captureLock.unlock()
            let error = WireFormat.failure("target_gone", "no active recording matches the requested sid")
            completion(error)
            return
        }
        s.paused = true
        s.endTime = Date()
        s.stopReason = reason
        r.captureLock.unlock()
        MonitorEventWriter.shared.flush()
        let finish: @Sendable (String?) -> Void = { [self] mediaError in
        if mediaError != nil { s.stopReason = "capture_stop_failed" }
        let summary: [String: Any] = [
            "sid": s.id,
            "duration": s.endTime!.timeIntervalSince(s.startTime),
            "evt": s.evt, "mut": s.mut, "net": s.net, "nav": s.nav, "ax": s.ax,
            "reason": s.stopReason ?? reason
        ]
        stopAutoStopTimer(runtime: r)
        r.axBridge.detachAll()
        r.workspaceBridge.stop()
        r.inputBridge.stop()
        r.tapBridge.stop()
        stopPasteboardWatch(runtime: r)
        stopFileWatch(runtime: r)
        stopPathMonitor(runtime: r)
        stopLogPolling(runtime: r)
        stopDistributedNotificationsWatch(runtime: r)
        #if canImport(Speech)
        stopSpeechRecognition(runtime: r)
        #endif

        // Record mon_stop while the runtime is still in the map so
        // recordEvent can find it and tally counts. (mon_stop is a lifecycle
        // event so it writes through even though the session is now paused.)
        recordEvent(runtime: r, event: "mon_stop", data: summary)
        let metaSnapshot = s.toMetaDict()

        lock.lock()
        runtimes.removeValue(forKey: s.id)
        lock.unlock()

        // durably flush + release the open session file handle so
        // the snapshot/transcript pipeline reads a complete events.jsonl.
        MonitorEventWriter.shared.flush()
        MonitorEventWriter.shared.close(path: Platform.sessionEventsPath(s.id))
        Platform.writeSessionMeta(sid: s.id, meta: metaSnapshot)
        if let mediaError { completion(["success": false, "code": "provider_error", "error": mediaError]) }
        else { completion(WireFormat.success(summary)) }
        }
        #if canImport(ScreenCaptureKit)
        stopFrameCapture(runtime: r, completion: finish)
        #else
        finish(nil)
        #endif
    }

    private func pauseSession(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let r = lookupRuntime(action: action) else {
            let err = WireFormat.failure("target_gone", "no active recording matches the requested sid")
            completion(err)
            return
        }
        let paused = r.captureLock.withLock {
            guard r.session.endTime == nil else { return false }
            r.session.paused = true
            return true
        }
        guard paused else {
            let error = WireFormat.failure("target_gone", "no active recording matches the requested sid")
            completion(error)
            return
        }
        let finish: @Sendable (String?) -> Void = { [self] error in
            recordEvent(runtime: r, event: "mon_pause", data: [:])
            MonitorEventWriter.shared.flush()
            if let error { completion(["success": false, "code": "provider_error", "error": error]) }
            else { completion(WireFormat.success(["sid": r.session.id, "status": "paused"])) }
        }
        #if canImport(ScreenCaptureKit)
        stopFrameCapture(runtime: r, completion: finish)
        #else
        finish(nil)
        #endif
    }

    private func resumeSession(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let r = lookupRuntime(action: action) else {
            let err = WireFormat.failure("target_gone", "no active recording matches the requested sid")
            completion(err)
            return
        }
        let resumed = r.captureLock.withLock {
            guard r.session.endTime == nil else { return false }
            let wasPaused = r.session.paused
            r.session.paused = false
            recordEvent(runtime: r, event: "mon_resume", data: [:])
            #if canImport(ScreenCaptureKit)
            if wasPaused { r.restartCapture?() }
            #endif
            return true
        }
        guard resumed else {
            let error = WireFormat.failure("target_gone", "no active recording matches the requested sid")
            completion(error)
            return
        }
        completion(WireFormat.success(["sid": r.session.id, "status": "recording"]))
    }

    private func statusSession(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let active = lockedRuntimes()
        if action["sid"] != nil {
            guard let r = lookupRuntime(action: action) else {
                let err = WireFormat.failure("target_gone", "no active recording matches the requested sid")
                completion(err)
                return
            }
            completion(WireFormat.success(statusDictFor(runtime: r)))
            return
        }
        if active.isEmpty {
            completion(WireFormat.success(["status": "idle"]))
            return
        }
        // Without --sid, return the list of active sessions.
        let rows = active.values.map { statusDictFor(runtime: $0) }
        completion(WireFormat.success(["sessions": rows, "activeCount": rows.count]))
    }

    private func statusDictFor(runtime r: MonitorRuntime) -> [String: Any] {
        let s = r.session
        return [
            "sid": s.id,
            "surface": "macos",
            "status": s.paused ? "paused" : "recording",
            "duration": Date().timeIntervalSince(s.startTime),
            "counts": ["evt": s.evt, "mut": s.mut, "net": s.net, "nav": s.nav, "ax": s.ax],
            "attachments": s.attachments.map { $0.toDict() },
            "scope": s.scope.toDict(),
            "includes": Array(s.includes).sorted(),
            "tcc": s.tcc.toDict(),
            "tap": r.tapActive
        ]
    }

    // MARK: - read paths: tail / list / export

    private func tailEvents(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sid: String
        if let s = action["sid"] as? String { sid = s }
        else if let r = lookupRuntime(action: action) { sid = r.session.id }
        else {
            completion(WireFormat.failure("target_gone", "no active recording matches the requested sid"))
            return
        }
        let limit = (action["limit"] as? Int) ?? 50
        do { completion(WireFormat.success(try readSessionEvents(sid: sid, limit: limit))) }
        catch let error as DesktopMonitorValidation.ArchiveError { completion(error.reply) }
        catch { completion(["success": false, "code": "provider_failed", "error": "monitor archive read failed; original was preserved"]) }
    }

    private func listSessions(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let dir = Platform.monitorSessionsDir
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir) else {
            completion(WireFormat.success([]))
            return
        }
        var rows: [[String: Any]] = []
        guard entries.count <= DESKTOP_MONITOR_MAX_ENTRIES else {
            completion(["success": false, "code": "resource_limit", "error": "monitor history directory exceeds 1000 entries; originals were preserved"]); return
        }
        let limit = (action["limit"] as? Int) ?? DESKTOP_MONITOR_MAX_ENTRIES
        for sid in entries.sorted().reversed() where DesktopMonitorValidation.safeSessionId(sid) && rows.count < limit {
            do {
                let data = try DesktopMonitorValidation.readArchive(sid: sid, file: "session.json", maxBytes: DESKTOP_MONITOR_MAX_RESULT_BYTES)
                guard var meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw DesktopMonitorValidation.ArchiveError.refused("monitor archive metadata is invalid; original was preserved") }
                guard meta["surface"] as? String == "macos" else { continue }
                guard meta["sessionId"] as? String == sid else { throw DesktopMonitorValidation.ArchiveError.refused("monitor archive identity differs from its directory") }
                guard DesktopMonitorValidation.archiveMetadataError(meta, sid: sid) == nil else { throw DesktopMonitorValidation.ArchiveError.refused("monitor archive metadata is invalid; original was preserved") }
                meta["sid"] = sid
                rows.append(meta)
            } catch DesktopMonitorValidation.ArchiveError.missing { continue }
            catch let error as DesktopMonitorValidation.ArchiveError { completion(error.reply); return }
            catch { completion(["success": false, "code": "provider_failed", "error": "monitor history read failed; originals were preserved"]); return }
        }
        completion(WireFormat.success(rows))
    }

    private func exportSession(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let sid = action["sid"] as? String else {
            completion(WireFormat.error("export requires a sid"))
            return
        }
        let format = (action["format"] as? String) ?? "timeline"
        let events: [[String: Any]], meta: [String: Any]
        do {
            events = try readSessionEvents(sid: sid)
            let metaData = try DesktopMonitorValidation.readArchive(sid: sid, file: "session.json", maxBytes: DESKTOP_MONITOR_MAX_RESULT_BYTES)
            meta = (try JSONSerialization.jsonObject(with: metaData)) as? [String: Any] ?? [:]
            guard meta["sessionId"] as? String == sid, meta["surface"] as? String == "macos" else { throw DesktopMonitorValidation.ArchiveError.refused("monitor archive metadata identity is invalid") }
            guard DesktopMonitorValidation.archiveMetadataError(meta, sid: sid) == nil else { throw DesktopMonitorValidation.ArchiveError.refused("monitor archive metadata is invalid; original was preserved") }
        } catch let error as DesktopMonitorValidation.ArchiveError { completion(error.reply); return }
        catch { completion(["success": false, "code": "provider_failed", "error": "monitor export read failed; original was preserved"]); return }
        let instruction = meta["instruction"] as? String

        switch format {
        case "json":
            completion(WireFormat.success(events))
        case "plan":
            completion(WireFormat.success(MonitorReplayPlanner.generateReplayPlan(events: events, instruction: instruction)))
        default:
            completion(WireFormat.success(MonitorReplayPlanner.generateTimeline(events: events, instruction: instruction)))
        }
    }

    // MARK: - helpers

    /// Resolves the runtime for an action. Honors --sid if present; otherwise
    /// returns the single active runtime when there's exactly one, or nil.
    private func lookupRuntime(action: [String: Any]) -> MonitorRuntime? {
        let active = lockedRuntimes().filter { _, runtime in
            runtime.captureLock.withLock { runtime.session.endTime == nil }
        }
        if action["sid"] != nil {
            return (action["sid"] as? String).flatMap { active[$0] }
        }
        if active.count == 1 { return active.values.first }
        return nil
    }

    func lockedRuntimes() -> [String: MonitorRuntime] {
        lock.lock(); defer { lock.unlock() }
        return runtimes
    }

    // the highest-rate event kinds. Under sustained backpressure
    // (writer over its high-water mark) these are shed so the writer can drain;
    // everything else (clicks, focus, nav, frames, speech, lifecycle) still
    // writes. Coalescing already collapses most of these; shedding is the
    // last-resort valve so a pathological flood can never wedge the session.
    static let noisyEvents: Set<String> = ["scroll", "input", "layout_change", "move", "mouseup", "ax_other"]

    func recordEvent(runtime: MonitorRuntime, event: String, data: [String: Any]) {
        runtime.captureLock.lock()
        defer { runtime.captureLock.unlock() }
        let s = runtime.session
        if s.endTime != nil, event != "mon_stop" { return }
        let lifecycle = event == "mon_start" || event == "mon_stop" || event == "mon_pause" || event == "mon_resume"
        if s.paused, !lifecycle { return }
        if !lifecycle {
            if s.excludes.contains(event) { return }
            if data["pid"] != nil || data["app"] != nil || data["bundleId"] != nil {
                let app = data["app"] == nil && data["bundleId"] == nil
                    ? (data["pid"] as? Int).flatMap { NSRunningApplication(processIdentifier: pid_t($0)) } : nil
                if isExcludedApp(runtime: runtime, bundleId: data["bundleId"] as? String ?? app?.bundleIdentifier,
                                 name: data["app"] as? String ?? app?.localizedName) { return }
            }
        }

        // Backpressure valve: when the disk writer is saturated, drop the
        // noisiest kinds and emit a single capture_backpressure marker so the
        // transcript records that shedding happened (never a silent gap).
        if !lifecycle, MonitorDomain.noisyEvents.contains(event), MonitorEventWriter.shared.isOverHighWater {
            if !runtime.backpressureNotified {
                runtime.backpressureNotified = true
                var marker: [String: Any] = ["note": "event writer over high-water mark; shedding high-rate events (scroll/value/layout)"]
                if let taskId = s.taskId { marker["taskId"] = taskId }
                marker["s"] = s.nextSeq()
                s.tally(event: "capture_backpressure")
                Platform.appendMonitorEvent(sid: s.id, event: "capture_backpressure", data: marker)
            }
            return
        }
        // Recovered — allow a future backpressure notice if it recurs.
        if runtime.backpressureNotified, !MonitorEventWriter.shared.isOverHighWater {
            runtime.backpressureNotified = false
        }

        var enriched = data
        if let taskId = s.taskId { enriched["taskId"] = taskId }
        enriched["s"] = s.nextSeq()
        s.tally(event: event)
        Platform.appendMonitorEvent(sid: s.id, event: event, data: enriched)
    }

    private func attachToPid(runtime: MonitorRuntime, pid: pid_t, bundleId: String?, appName: String?) {
        let accepted = runtime.axBridge.attach(pid: pid)
        let attachment = MonitorAttachment(
            key: "pid:\(pid)",
            pid: pid,
            bundleIdentifier: bundleId,
            appName: appName,
            attachedAt: Int64(Date().timeIntervalSince1970 * 1000),
            detachedAt: nil,
            axNotifications: accepted,
            reason: "scope_attach"
        )
        runtime.session.attachments.append(attachment)
        if runtime.session.rootPid == nil {
            runtime.session.rootPid = pid
            runtime.session.rootBundleId = bundleId
            runtime.session.rootAppName = appName
        }
        recordEvent(runtime: runtime, event: "mon_attach", data: [
            "pid": Int(pid),
            "app": appName ?? "",
            "bundleId": bundleId ?? "",
            "ax": accepted
        ])
    }

    private func resolveInitialPids(scope: MonitorScope) -> [(pid_t, String?, String?)] {
        switch scope.mode {
        case .frontmost:
            if let app = FrontmostResolver.frontmostApplication() {
                return [(app.processIdentifier, app.bundleIdentifier, app.localizedName)]
            }
            return []
        case .apps:
            return NSWorkspace.shared.runningApplications.compactMap { app -> (pid_t, String?, String?)? in
                let name = app.localizedName ?? ""
                let bid = app.bundleIdentifier ?? ""
                if scope.apps.contains(name) || scope.apps.contains(bid) {
                    return (app.processIdentifier, app.bundleIdentifier, app.localizedName)
                }
                return nil
            }
        case .all:
            return NSWorkspace.shared.runningApplications.map { ($0.processIdentifier, $0.bundleIdentifier, $0.localizedName) }
        }
    }

    private func parseSet(_ raw: Any?) -> Set<String> {
        if let arr = raw as? [String] { return Set(arr) }
        if let s = raw as? String {
            return Set(s.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
        }
        return []
    }

    private func parseScope(_ action: [String: Any]) -> MonitorScope {
        if let allFlag = action["allApps"] as? Bool, allFlag { return .all() }
        if let apps = action["apps"] as? [String], !apps.isEmpty { return .apps(apps) }
        if let appsCsv = action["apps"] as? String, !appsCsv.isEmpty {
            return .apps(appsCsv.split(separator: ",").map { String($0) })
        }
        if let app = action["app"] as? String, !app.isEmpty { return .apps([app]) }
        return .frontmost()
    }

    // `--all-apps` scope hygiene. By default we do NOT attach an
    // AXObserver to system chrome/helpers (loginwindow, Dock, WindowServer,
    // Control Center, Spotlight, etc.) — they generate high-rate noise and
    // little workflow signal, and attaching to loginwindow was a top source of
    // the RPC-saturation timeouts. `--include-system-apps` opts back in; each
    // `--exclude-app <bundleId|name>` adds to the denylist.
    static let systemAppDenylist: Set<String> = [
        "com.apple.loginwindow",
        "com.apple.dock",
        "com.apple.WindowManager",
        "com.apple.controlcenter",
        "com.apple.systemuiserver",
        "com.apple.notificationcenterui",
        "com.apple.Spotlight",
        "com.apple.wifi.WiFiAgent",
        "com.apple.TextInputMenuAgent",
        "com.apple.TextInputSwitcher",
        "com.apple.universalcontrol",
        "com.apple.screencaptureui",
        "com.apple.coreservices.uiagent",
    ]

    private func isExcludedApp(runtime r: MonitorRuntime, bundleId: String?, name: String?) -> Bool {
        // Per-session explicit excludes always apply (match bundle id or name).
        if let b = bundleId, r.excludeApps.contains(b) { return true }
        if let n = name, r.excludeApps.contains(n) { return true }
        if (bundleId ?? "").isEmpty && (name ?? "").isEmpty { return true }
        if r.session.scope.mode == .apps,
           !r.session.scope.apps.contains(bundleId ?? ""), !r.session.scope.apps.contains(name ?? "") { return true }
        if r.includeSystemApps { return false }
        if let b = bundleId, MonitorDomain.systemAppDenylist.contains(b) { return true }
        // WindowServer / loginwindow can appear with empty/odd bundle ids; also
        // filter the obvious agent-name pattern as a backstop.
        if let n = name, MonitorDomain.systemAppDenylist.contains(n) { return true }
        return false
    }

    private func readSessionEvents(sid: String, limit: Int? = nil) throws -> [[String: Any]] {
        let metadata = try DesktopMonitorValidation.readArchive(sid: sid, file: "session.json", maxBytes: DESKTOP_MONITOR_MAX_RESULT_BYTES)
        guard let meta = try? JSONSerialization.jsonObject(with: metadata) as? [String: Any],
              DesktopMonitorValidation.archiveMetadataError(meta, sid: sid) == nil else { throw DesktopMonitorValidation.ArchiveError.refused("monitor archive metadata is invalid; original was preserved") }
        let bytes = try DesktopMonitorValidation.readArchive(sid: sid, file: "events.jsonl", maxBytes: DESKTOP_MONITOR_MAX_ARCHIVE_BYTES)
        guard let data = String(data: bytes, encoding: .utf8), bytes.isEmpty || bytes.last == 10 else { throw DesktopMonitorValidation.ArchiveError.refused("monitor archive contains invalid or interrupted events; original was preserved") }
        var out: [[String: Any]] = []
        var previous = -1
        var previousTime = -1.0
        for line in data.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            guard let bytes = trimmed.data(using: .utf8), bytes.count <= DESKTOP_MONITOR_MAX_RESULT_BYTES,
                  let row = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw DesktopMonitorValidation.ArchiveError.refused("monitor archive event is invalid; original was preserved") }
            let fields = row.filter { ["sid", "s", "t", "event", "timestamp", "taskId"].contains($0.key) }
            let header = try JSONDecoder().decode(DesktopMonitorEventHeader.self, from: JSONSerialization.data(withJSONObject: fields))
            guard header.sid == sid, header.s >= 0, header.s <= 9007199254740991, header.s.rounded() == header.s, header.s > Double(previous), header.t >= 0, header.t <= 9007199254740991, header.t.rounded() == header.t, header.t >= previousTime, !header.event.isEmpty, header.event.utf16.count <= 128 else { throw DesktopMonitorValidation.ArchiveError.refused("monitor archive event identity/order is invalid; original was preserved") }
            guard DesktopMonitorValidation.eventPayloadError(row) == nil else { throw DesktopMonitorValidation.ArchiveError.refused("monitor archive event payload is invalid; original was preserved") }
            previous = Int(header.s)
            previousTime = header.t
            out.append(row)
            if let limit = limit, out.count > limit { out.removeFirst() }
            if limit == nil, out.count > DESKTOP_MONITOR_MAX_ENTRIES { throw DesktopMonitorValidation.ArchiveError.limit("monitor export exceeds 1000 events; use the owned archive") }
        }
        return out
    }

    // MARK: - PHASE 2: clipboard / files / network (per-runtime)

    private func startPasteboardWatch(runtime r: MonitorRuntime) {
        r.lastPasteboardChangeCount = NSPasteboard.general.changeCount
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
        timer.setEventHandler { [weak self, weak r] in
            guard let self = self, let r = r else { return }
            let pb = NSPasteboard.general
            let cur = pb.changeCount
            if cur != r.lastPasteboardChangeCount {
                r.lastPasteboardChangeCount = cur
                let preview = pb.string(forType: .string).map { String($0.prefix(200)) } ?? ""
                let types = pb.types?.map { $0.rawValue } ?? []
                self.recordEvent(runtime: r, event: "clipboard", data: [
                    "changeCount": cur, "types": types, "preview": preview
                ])
            }
        }
        timer.resume()
        r.pasteboardTimer = timer
    }

    private func stopPasteboardWatch(runtime r: MonitorRuntime) {
        r.pasteboardTimer?.cancel()
        r.pasteboardTimer = nil
    }

    private func startFileWatch(runtime r: MonitorRuntime, action: [String: Any]) {
        var paths: [String] = []
        if let p = action["watchPath"] as? String, !p.isEmpty {
            paths.append(NSString(string: p).expandingTildeInPath)
        }
        if let arr = action["watchPaths"] as? [String] {
            for p in arr where !p.isEmpty { paths.append(NSString(string: p).expandingTildeInPath) }
        }
        if paths.isEmpty { return }
        r.fsPaths = paths

        var context = FSEventStreamContext()
        let unmanaged = Unmanaged.passUnretained(r)
        context.info = unmanaged.toOpaque()

        let callback: FSEventStreamCallback = { _, info, numEvents, eventPaths, _, _ in
            guard let info = info else { return }
            let runtime = Unmanaged<MonitorRuntime>.fromOpaque(info).takeUnretainedValue()
            guard let domain = runtime.domain else { return }
            let cfArray = Unmanaged<CFArray>.fromOpaque(eventPaths).takeUnretainedValue()
            for i in 0..<numEvents {
                guard let raw = CFArrayGetValueAtIndex(cfArray, i) else { continue }
                let cfStr = unsafeBitCast(raw, to: CFString.self)
                let path = cfStr as String
                domain.recordEvent(runtime: runtime, event: "file_change", data: ["path": path])
            }
        }

        let stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            paths as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.5,
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagUseCFTypes)
        )
        guard let s = stream else { return }
        FSEventStreamSetDispatchQueue(s, DispatchQueue.global(qos: .utility))
        FSEventStreamStart(s)
        r.fsStream = s
    }

    private func stopFileWatch(runtime r: MonitorRuntime) {
        if let s = r.fsStream {
            FSEventStreamStop(s)
            FSEventStreamInvalidate(s)
            FSEventStreamRelease(s)
            r.fsStream = nil
        }
        r.fsPaths.removeAll()
    }

    private func startPathMonitor(runtime r: MonitorRuntime) {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self, weak r] path in
            guard let self = self, let r = r else { return }
            self.recordEvent(runtime: r, event: "network_path", data: [
                "status": Self.pathStatusString(path.status),
                "isExpensive": path.isExpensive,
                "isConstrained": path.isConstrained,
                "supportsIPv4": path.supportsIPv4,
                "supportsIPv6": path.supportsIPv6,
                "supportsDNS": path.supportsDNS,
                "interfaces": path.availableInterfaces.map { $0.name }
            ])
        }
        monitor.start(queue: DispatchQueue.global(qos: .utility))
        r.pathMonitor = monitor
    }

    private func stopPathMonitor(runtime r: MonitorRuntime) {
        r.pathMonitor?.cancel()
        r.pathMonitor = nil
    }

    private static func pathStatusString(_ s: NWPath.Status) -> String {
        switch s {
        case .satisfied: return "satisfied"
        case .unsatisfied: return "unsatisfied"
        case .requiresConnection: return "requiresConnection"
        @unknown default: return "unknown"
        }
    }

    // MARK: - PHASE 3: log / notifications

    private func startLogPolling(runtime r: MonitorRuntime, action: [String: Any]) {
        guard #available(macOS 12.0, *) else {
            recordEvent(runtime: r, event: "log_unavailable", data: ["reason": "OSLogStore requires macOS 12+"])
            return
        }
        r.logCursorDate = Date()
        let predicate = (action["logPredicate"] as? String) ?? r.session.rootBundleId.map { "subsystem == \"\($0)\"" }
        r.logPredicate = predicate

        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + .seconds(5), repeating: .seconds(5))
        timer.setEventHandler { [weak self, weak r] in
            guard let self = self, let r = r else { return }
            self.pollLog(runtime: r)
        }
        timer.resume()
        r.logTimer = timer
    }

    @available(macOS 12.0, *)
    private func pollLog(runtime r: MonitorRuntime) {
        guard let cursor = r.logCursorDate else { return }
        do {
            let store = try OSLogStore.local()
            let position = store.position(date: cursor)
            var pred: NSPredicate? = nil
            if let p = r.logPredicate, !p.isEmpty {
                pred = NSPredicate(format: p)
            }
            let entries = try store.getEntries(at: position, matching: pred)
            for entry in entries {
                if let logEntry = entry as? OSLogEntryLog {
                    recordEvent(runtime: r, event: "log", data: [
                        "level": String(describing: logEntry.level),
                        "subsystem": logEntry.subsystem,
                        "category": logEntry.category,
                        "message": logEntry.composedMessage,
                        "process": logEntry.process
                    ])
                }
            }
            r.logCursorDate = Date()
        } catch {
            recordEvent(runtime: r, event: "log_error", data: ["error": "\(error.localizedDescription)"])
        }
    }

    private func stopLogPolling(runtime r: MonitorRuntime) {
        r.logTimer?.cancel()
        r.logTimer = nil
        r.logCursorDate = nil
        r.logPredicate = nil
    }

    private func startDistributedNotificationsWatch(runtime r: MonitorRuntime) {
        let dnc = DistributedNotificationCenter.default()
        let names = [
            "com.apple.screenIsLocked",
            "com.apple.screenIsUnlocked",
            "com.apple.screensaver.didstart",
            "com.apple.screensaver.didstop",
            "com.apple.menuExtraHostKilled",
            "com.apple.HIToolbox.beginMenuTrackingNotification",
            "com.apple.HIToolbox.endMenuTrackingNotification"
        ]
        for name in names {
            let token = dnc.addObserver(forName: NSNotification.Name(name), object: nil, queue: nil) { [weak self, weak r] note in
                guard let self = self, let r = r else { return }
                self.recordEvent(runtime: r, event: "notification", data: [
                    "name": note.name.rawValue,
                    "source": "distributed"
                ])
            }
            r.distNotificationObservers.append(token)
        }
    }

    private func stopDistributedNotificationsWatch(runtime r: MonitorRuntime) {
        let dnc = DistributedNotificationCenter.default()
        for o in r.distNotificationObservers { dnc.removeObserver(o) }
        r.distNotificationObservers.removeAll()
    }

    // MARK: - PHASE 4: frames / OCR / speech

    #if canImport(ScreenCaptureKit)
    @available(macOS 12.3, *)
    private func startFrameCapture(
        runtime r: MonitorRuntime,
        framesPerSec: Int,
        videoFps: Int?,
        visionText: Bool,
        format: String,
        quality: Int,
        maxLongEdge: Int
    ) {
        let wantFrames = framesPerSec > 0
        let wantVideo = videoFps != nil
        r.captureLock.withLock {
        guard !r.session.paused, r.session.endTime == nil else { return }
        let generation = r.captureGeneration
        let previous = r.captureTask
        r.captureTask = Task { [self, r] in
            await previous?.value
            var created: SCStream?
            do {
                let content = try await SCShareableContent.current
                let stream: SCStream? = try r.captureLock.withLock {
                guard generation == r.captureGeneration, !r.session.paused, r.session.endTime == nil else { return nil }
                guard let pid = r.capturePid, let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
                      !self.isExcludedApp(runtime: r, bundleId: app.bundleIdentifier, name: app.localizedName) else {
                    throw DesktopMonitorValidation.ArchiveError.refused("monitor capture target is gone or excluded; no display fallback")
                }
                let windows = content.windows.filter { $0.owningApplication?.processID == pid && $0.isOnScreen && $0.windowLayer == 0 && $0.frame.width > 0 && $0.frame.height > 0 }
                guard let window = r.captureWindowId.flatMap({ id in windows.first { $0.windowID == id } })
                    ?? (r.captureWindowId == nil ? windows.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height } : nil) else {
                    throw DesktopMonitorValidation.ArchiveError.refused("monitor capture has no visible owned window; no display fallback")
                }
                r.captureWindowId = window.windowID
                let filter = SCContentFilter(desktopIndependentWindow: window)
                let config = SCStreamConfiguration()
                // correct geometry. Point dims × pixel scale, with
                // scalesToFit + captureResolution + explicit pixelFormat, mirroring
                // the working CaptureDomain path. Without this SCK can hand back an
                // aspect-broken sliver (the 7680×60 bug) or drop frames.
                let pixelScale = r.framePixelScale == 0 ? max(1, Int(ceil(filter.pointPixelScale))) : r.framePixelScale
                config.width = Int(ceil(filter.contentRect.width)) * pixelScale
                config.height = Int(ceil(filter.contentRect.height)) * pixelScale
                guard config.width > 0, config.height > 0, config.width <= 16384, config.height <= 16384,
                      config.width <= 33554432 / config.height else { throw DesktopMonitorValidation.ArchiveError.limit("monitor capture exceeds its pixel budget") }
                config.ignoreShadowsSingleWindow = true
                config.scalesToFit = true
                config.showsCursor = true
                config.captureResolution = .best
                config.pixelFormat = kCVPixelFormatType_32BGRA
                let effectiveFps = max(wantFrames ? framesPerSec : 1, wantVideo ? (videoFps ?? 1) : 1)
                config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, effectiveFps)))
                config.queueDepth = 5

                let output = MonitorCaptureOutput(domain: self, runtime: r, sid: r.session.id, visionText: visionText,
                    format: format, quality: quality, maxLongEdge: maxLongEdge, frameBudget: r.frameBudget, diskCapBytes: r.frameDiskCapBytes)
                let stream = SCStream(filter: filter, configuration: config, delegate: output)
                r.captureOutput = output

                // Still frames — only when --frames was requested.
                if wantFrames {
                    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: r.captureQueue)
                }

                // Continuous video — SCRecordingOutput → recording/screen.mp4.
                if wantVideo {
                    let dir = Platform.sessionDir(r.session.id) + "/recording"
                    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
                    let mp4 = dir + "/screen-\(generation).mp4"
                    guard !FileManager.default.fileExists(atPath: mp4) else { throw DesktopMonitorValidation.ArchiveError.refused("monitor video path already exists; original preserved") }
                    let recCfg = SCRecordingOutputConfiguration()
                    recCfg.outputURL = URL(fileURLWithPath: mp4)
                    recCfg.outputFileType = .mp4
                    let recDelegate = MonitorRecordingDelegate(domain: self, runtime: r, path: mp4)
                    let recOutput = SCRecordingOutput(configuration: recCfg, delegate: recDelegate)
                    try stream.addRecordingOutput(recOutput)
                    r.recordingOutput = recOutput
                    r.recordingPath = mp4
                    r.recordingDelegate = recDelegate
                    self.recordEvent(runtime: r, event: "video_start", data: ["path": mp4, "fps": videoFps ?? 0])
                }

                r.captureStream = stream
                return stream
                }
                guard let stream else { return }
                created = stream
                try await stream.startCapture()
            } catch {
                if let created { try? await created.stopCapture() }
                r.captureLock.withLock {
                    if generation == r.captureGeneration, !r.session.paused, r.session.endTime == nil {
                        r.captureStream = nil
                        r.captureOutput = nil
                        self.recordEvent(runtime: r, event: "frame_error", data: ["error": error.localizedDescription])
                    }
                }
            }
        }
        }
    }

    @available(macOS 12.3, *)
    private func stopFrameCapture(runtime r: MonitorRuntime, completion: @escaping @Sendable (String?) -> Void) {
        r.captureLock.withLock {
        r.captureGeneration &+= 1
        let previous = r.captureTask
        r.captureTask = Task { [r] in
            await previous?.value
            let stream = r.captureLock.withLock { r.captureStream }
            var failure: String?
            if let stream {
                do { try await stream.stopCapture() }
                catch { failure = "monitor capture stop failed: \(error.localizedDescription)" }
            }
            r.captureLock.withLock {
                if failure == nil {
                    r.captureStream = nil
                    r.captureOutput = nil
                    r.recordingOutput = nil
                    r.recordingDelegate = nil
                    r.recordingPath = nil
                }
            }
            completion(failure)
        }
        }
    }
    #endif

    #if canImport(Speech)
    // speech capture that works or fails loudly,
    // never silently, and always yields a transcript when the mic is available.
    //   • mode "offline": skip live ASR, tee mic → speech.caf for offline xcribe.
    //   • mode "live":    live ASR only (no offline fallback).
    //   • mode "auto":    attempt live ASR; if denied/unavailable, fall back to
    //                     the offline .caf so the transcript is never empty.
    // The whole thing runs async (called from the async start path) so it can
    // never block the start ack.
    private func startSpeechRecognition(runtime r: MonitorRuntime) {
        let mode = r.speechMode

        if mode == "offline" {
            DispatchQueue.main.async { [weak self, weak r] in
                guard let self = self, let r = r else { return }
                self.spinUpSpeechEngine(runtime: r, recognizer: nil, writeCaf: true)
            }
            return
        }

        // runtime key-guard — Apple CRASHES if we call requestAuthorization
        // with NSSpeechRecognitionUsageDescription absent. Defensively no-op live
        // ASR if the running bundle lacks the key (older build); auto still teed.
        let hasSpeechKey = Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil
        guard hasSpeechKey else {
            recordEvent(runtime: r, event: "speech_unavailable", data: [
                "reason": "missing NSSpeechRecognitionUsageDescription in Info.plist; live ASR disabled",
                "remediation": "rebuild interceptor-bridge so the speech usage key ships",
            ])
            if mode == "auto" {
                DispatchQueue.main.async { [weak self, weak r] in
                    guard let self = self, let r = r else { return }
                    self.spinUpSpeechEngine(runtime: r, recognizer: nil, writeCaf: true)
                }
            }
            return
        }

        // actor-neutral authorization. Do NOT pass a @MainActor
        // closure to requestAuthorization: Apple does not guarantee the callback
        // runs on the main queue and a main-actor closure would crash. We only
        // hop to main to touch AVAudioEngine.
        SFSpeechRecognizer.requestAuthorization { [weak self, weak r] status in
            guard let self = self, let r = r else { return }
            if status == .authorized, let recognizer = SFSpeechRecognizer(), recognizer.isAvailable {
                DispatchQueue.main.async {
                    self.spinUpSpeechEngine(runtime: r, recognizer: recognizer, writeCaf: r.speechMode == "auto")
                }
            } else {
                self.recordEvent(runtime: r, event: "speech_unavailable", data: [
                    "reason": "authorization \(status.rawValue) (\(MonitorDomain.speechAuthName(status)))",
                    "fallback": r.speechMode == "auto" ? "offline_caf" : "none",
                    "remediation": "interceptor macos trust speech --prompt",
                ])
                if r.speechMode == "auto" {
                    DispatchQueue.main.async {
                        self.spinUpSpeechEngine(runtime: r, recognizer: nil, writeCaf: true)
                    }
                }
            }
        }
    }

    static func speechAuthName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    // One AVAudioEngine + one tap fans out to (a) the live recognizer request
    // and (b) the offline .caf writer, so audio is never captured twice and the
    // .caf is a faithful backup of exactly what the recognizer heard.
    private func spinUpSpeechEngine(runtime r: MonitorRuntime, recognizer: SFSpeechRecognizer?, writeCaf: Bool) {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)

        // offline .caf tee under the session dir (Microphone grant).
        if writeCaf {
            Platform.ensureSessionDir(r.session.id)
            let cafPath = Platform.sessionDir(r.session.id) + "/speech.caf"
            if let file = try? AVAudioFile(forWriting: URL(fileURLWithPath: cafPath), settings: format.settings) {
                r.speechAudioFile = file
                r.speechCafPath = cafPath
                recordEvent(runtime: r, event: "speech_audio", data: ["path": cafPath, "kind": "offline_caf"])
            }
        }

        // live recognizer when authorized.
        if let recognizer = recognizer {
            let req = makeSpeechRequest(recognizer: recognizer)
            r.speechRequest = req
            r.speechTask = recognizer.recognitionTask(with: req, resultHandler: makeSpeechResultHandler(runtime: r))
            r.speechRingFrameBudget = AVAudioFrameCount(format.sampleRate * 2) // ~2s replay
            scheduleSpeechRestart(runtime: r)
            scheduleSpeechSilenceFlush(runtime: r)
        }

        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self, weak r] buffer, _ in
            guard let r = r else { return }
            r.speechRequest?.append(buffer)
            if writeCaf { try? r.speechAudioFile?.write(from: buffer) }
            self?.pushSpeechRing(runtime: r, buffer: buffer)
        }

        do {
            engine.prepare()
            try engine.start()
            r.speechEngine = engine
        } catch {
            recordEvent(runtime: r, event: "speech_unavailable", data: ["reason": "engine start failed: \(error.localizedDescription)"])
        }
    }

    private func makeSpeechRequest(recognizer: SFSpeechRecognizer) -> SFSpeechAudioBufferRecognitionRequest {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        req.taskHint = .dictation
        // Apple: requiresOnDeviceRecognition is "only honored if
        // supportsOnDeviceRecognition is also true" — gate it, else it's silently
        // ignored and we'd quietly fall back to the network path.
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        return req
    }

    // Buffer-based recognition NEVER finalizes per utterance — Apple:
    // "for audio buffer–based recognition, recognition does not finish until
    // [finish()] is called" — so isFinal only fires at our own 55s restarts,
    // and on-device those finals carry EMPTY text (issue #218: 232 partials,
    // 2 empty finals at the restart boundaries). Utterance-final events are
    // therefore synthesized from the latest partial: partials update pending
    // state (emitted at most 1/s for live tailing), and boundary signals —
    // recognition metadata (arrives on utterance-complete results), a 3s
    // silence, a task restart, or stop — flush the pending text as a
    // speech_segment with isFinal: true.
    private func makeSpeechResultHandler(runtime r: MonitorRuntime) -> (SFSpeechRecognitionResult?, Error?) -> Void {
        return { [weak self, weak r] result, error in
            guard let self = self, let r = r else { return }
            if let res = result {
                let text = res.bestTranscription.formattedString
                if !text.isEmpty {
                    // Inside the post-metadata grace window the recognizer has
                    // declared the pending utterance complete; the only
                    // legitimate change is a tail revision. Anything that does
                    // not carry the pending stem forward is the next utterance
                    // beginning (on-device recognition restarts its
                    // transcription per utterance) — flush the old one first
                    // so it is never overwritten.
                    r.speechLock.lock()
                    let boundary = r.speechBoundaryPending
                    let pending = r.pendingSpeechText
                    r.speechLock.unlock()
                    if boundary, !SpeechUtteranceSegmenter.isRevision(of: pending, incoming: text) {
                        self.flushPendingUtterance(runtime: r)
                    }
                    r.speechLock.lock()
                    r.pendingSpeechText = text
                    r.pendingSpeechAt = Date()
                    let emitPartial = !res.isFinal && Date().timeIntervalSince(r.lastPartialEmitAt) >= 1.0
                    if emitPartial { r.lastPartialEmitAt = Date() }
                    r.speechLock.unlock()
                    if emitPartial {
                        self.recordEvent(runtime: r, event: "speech_segment", data: [
                            "text": text,
                            "isFinal": false,
                            "source": "live",
                        ])
                    }
                }
                if res.isFinal {
                    // finish()/endAudio() final (restart/stop teardown): no
                    // more results are coming — flush immediately.
                    self.flushPendingUtterance(runtime: r)
                } else if res.speechRecognitionMetadata != nil {
                    // utterance boundary: defer the flush one grace window so
                    // a revision arriving right behind the metadata result
                    // still lands in the final (observed: trailing words can
                    // finalize 0.5-1s after the boundary signal).
                    self.scheduleUtteranceGraceFlush(runtime: r)
                }
            }
            if let e = error {
                self.recordEvent(runtime: r, event: "speech_unavailable", data: ["reason": "\(e.localizedDescription)"])
            }
        }
    }

    // Emit the pending partial as an utterance-final speech_segment. Clearing
    // the pending text under the lock is what prevents a double flush (grace
    // timer vs. restart/stop racing on the same utterance); identical text in
    // a LATER utterance is a real repeat and is kept.
    private func flushPendingUtterance(runtime r: MonitorRuntime) {
        r.speechLock.lock()
        r.speechBoundaryPending = false
        r.speechGraceWorkItem?.cancel()
        r.speechGraceWorkItem = nil
        let text = r.pendingSpeechText.trimmingCharacters(in: .whitespacesAndNewlines)
        r.pendingSpeechText = ""
        r.speechLock.unlock()
        guard !text.isEmpty else { return }
        recordEvent(runtime: r, event: "speech_segment", data: [
            "text": text,
            "isFinal": true,
            "source": "live",
        ])
    }

    // Defer the boundary flush by one grace window. The work item reads the
    // CURRENT pending text when it fires, so any revision that arrives during
    // the window is what gets flushed; a newer boundary or an explicit flush
    // (restart/stop/reset) cancels it.
    private func scheduleUtteranceGraceFlush(runtime r: MonitorRuntime) {
        let work = DispatchWorkItem { [weak self, weak r] in
            guard let self = self, let r = r else { return }
            self.flushPendingUtterance(runtime: r)
        }
        r.speechLock.lock()
        r.speechBoundaryPending = true
        r.speechGraceWorkItem?.cancel()
        r.speechGraceWorkItem = work
        r.speechLock.unlock()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1.2, execute: work)
    }

    // ~3s of silence ends an utterance: on-device recognition keeps growing
    // one transcription across pauses, so without this a monologue collapses
    // into a single giant pending string that only flushes at the restart.
    private func scheduleSpeechSilenceFlush(runtime r: MonitorRuntime) {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + .seconds(2), repeating: .seconds(2))
        timer.setEventHandler { [weak self, weak r] in
            guard let self = self, let r = r else { return }
            guard r.session.endTime == nil, !r.session.paused else { return }
            r.speechLock.lock()
            let stale = !r.pendingSpeechText.isEmpty && Date().timeIntervalSince(r.pendingSpeechAt) >= 3.0
            r.speechLock.unlock()
            if stale { self.flushPendingUtterance(runtime: r) }
        }
        timer.resume()
        r.speechSilenceTimer = timer
    }

    // restart the recognition task before Apple's ~60s hard limit
    // ("the framework stops speech recognition tasks that last longer than one
    // minute"). The ring buffer replays the trailing ~2s so a word straddling
    // the boundary isn't lost.
    private func scheduleSpeechRestart(runtime r: MonitorRuntime) {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + .seconds(55))
        timer.setEventHandler { [weak self, weak r] in
            guard let self = self, let r = r else { return }
            guard r.session.endTime == nil, !r.session.paused else { return }
            self.restartSpeechTask(runtime: r)
        }
        timer.resume()
        r.speechRestartTimer = timer
    }

    private func restartSpeechTask(runtime r: MonitorRuntime) {
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else { return }
        // flush BEFORE finish(): the final result finish() produces is empty
        // on-device, so the pending partial is the utterance's only copy.
        flushPendingUtterance(runtime: r)
        r.speechTask?.finish()
        r.speechRequest?.endAudio()
        let req = makeSpeechRequest(recognizer: recognizer)
        r.speechLock.lock()
        let replay = r.speechRing
        r.speechLock.unlock()
        for buf in replay { req.append(buf) }
        r.speechRequest = req
        r.speechTask = recognizer.recognitionTask(with: req, resultHandler: makeSpeechResultHandler(runtime: r))
        recordEvent(runtime: r, event: "speech_restart", data: ["replayBuffers": replay.count])
        scheduleSpeechRestart(runtime: r)
    }

    private func pushSpeechRing(runtime r: MonitorRuntime, buffer: AVAudioPCMBuffer) {
        guard r.speechRingFrameBudget > 0 else { return }
        r.speechLock.lock()
        r.speechRing.append(buffer)
        var total: AVAudioFrameCount = r.speechRing.reduce(0) { $0 + $1.frameLength }
        while total > r.speechRingFrameBudget, r.speechRing.count > 1 {
            let dropped = r.speechRing.removeFirst()
            total -= dropped.frameLength
        }
        r.speechLock.unlock()
    }

    private func stopSpeechRecognition(runtime r: MonitorRuntime) {
        r.speechRestartTimer?.cancel()
        r.speechRestartTimer = nil
        r.speechSilenceTimer?.cancel()
        r.speechSilenceTimer = nil
        r.speechLock.lock()
        r.speechGraceWorkItem?.cancel()
        r.speechGraceWorkItem = nil
        r.speechLock.unlock()
        // the tail of the narration lives only in the pending partial —
        // flush it before tearing the task down (finish()'s final is empty).
        flushPendingUtterance(runtime: r)
        r.speechTask?.finish()
        r.speechRequest?.endAudio()
        r.speechEngine?.stop()
        r.speechEngine?.inputNode.removeTap(onBus: 0)
        r.speechTask = nil
        r.speechRequest = nil
        r.speechEngine = nil
        r.speechLock.lock(); r.speechRing.removeAll(); r.speechLock.unlock()
        // finalize the .caf so the offline transcriber can read it, and
        // emit a marker the snapshot/synthesis step keys on.
        if let caf = r.speechCafPath {
            r.speechAudioFile = nil // releasing AVAudioFile flushes the CAF header
            recordEvent(runtime: r, event: "speech_audio_done", data: ["path": caf])
        }
        r.speechCafPath = nil
    }
    #endif

    // MARK: - PHASE 5: retention timers (per-runtime)

    private func startAutoStopTimer(runtime r: MonitorRuntime) {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + .seconds(60), repeating: .seconds(60))
        timer.setEventHandler { [weak self, weak r] in
            guard let self = self, let r = r else { return }
            if Date().timeIntervalSince(r.session.startTime) >= MonitorRuntime.sessionMaxDurationSeconds {
                self.scheduleLifecycle(sub: "stop", action: ["sid": r.session.id], reason: "session_timeout_24h") { _ in }
                return
            }
            let path = Platform.sessionEventsPath(r.session.id)
            if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
               let size = attrs[.size] as? Int64,
               size > MonitorRuntime.sessionMaxBytesPerFile {
                self.rotateSessionEvents(sid: r.session.id, runtime: r)
            }
        }
        timer.resume()
        r.autoStopTimer = timer
    }

    private func stopAutoStopTimer(runtime r: MonitorRuntime) {
        r.autoStopTimer?.cancel()
        r.autoStopTimer = nil
    }

    private func rotateSessionEvents(sid: String, runtime r: MonitorRuntime) {
        let dir = Platform.sessionDir(sid)
        let cur = Platform.sessionEventsPath(sid)
        var idx = 1
        while FileManager.default.fileExists(atPath: dir + "/events.jsonl.\(idx)") {
            idx += 1
        }
        let archive = dir + "/events.jsonl.\(idx)"
        // Release the writer's open handle so the move targets the live file and
        // the next append re-opens the fresh events.jsonl (not the moved inode).
        MonitorEventWriter.shared.flush()
        MonitorEventWriter.shared.close(path: cur)
        do {
            try FileManager.default.moveItem(atPath: cur, toPath: archive)
            recordEvent(runtime: r, event: "rotation", data: ["archived": archive, "index": idx])
        } catch {
            Platform.log("MonitorDomain: rotation failed sid=\(sid) error=\(error.localizedDescription)")
        }
    }
}

// Frame output handler. Saves frames to <session-dir>/media/ using
// CaptureDomain's shared encoder so default jpeg q=80 produces 10-20× smaller
// files than naive PNG. Optional --frame-max-long-edge resizes at capture
// time, mirroring the existing `--target-max-long-edge` knob on
// `interceptor macos screenshot`. Optionally runs VNRecognizeTextRequest per
// frame for ocr_text events.
#if canImport(ScreenCaptureKit)
@available(macOS 12.3, *)
final class MonitorCaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    weak var domain: MonitorDomain?
    weak var runtime: MonitorRuntime?
    let sid: String
    let visionText: Bool
    let format: String      // "jpeg" | "png" | "webp"
    let quality: Int        // 0..100; ignored for png
    let maxLongEdge: Int    // 0 = no resize; otherwise scale so max(w,h) == this
    // bound disk usage so a long session can't fill /tmp.
    let frameBudget: Int
    let diskCapBytes: Int64
    let generation: UInt64

    init(
        domain: MonitorDomain?,
        runtime: MonitorRuntime?,
        sid: String,
        visionText: Bool,
        format: String = "jpeg",
        quality: Int = 80,
        maxLongEdge: Int = 0,
        frameBudget: Int = 7200,
        diskCapBytes: Int64 = 100 * 1024 * 1024
    ) {
        self.domain = domain
        self.runtime = runtime
        self.sid = sid
        self.visionText = visionText
        self.format = format.lowercased()
        self.quality = max(0, min(100, quality))
        self.maxLongEdge = max(0, maxLongEdge)
        self.frameBudget = frameBudget > 0 ? frameBudget : 7200
        self.diskCapBytes = diskCapBytes > 0 ? min(diskCapBytes, MonitorRuntime.sessionMaxBytesPerFile) : MonitorRuntime.sessionMaxBytesPerFile
        self.generation = runtime?.captureGeneration ?? 0
    }

    // The same gate protects queued samples, private artifacts and lifecycle
    // acknowledgments. No frame may create bytes after pause or stop.
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard let r = runtime, let d = domain else { return }
        r.captureLock.lock()
        defer { r.captureLock.unlock() }
        guard generation == r.captureGeneration, !r.session.paused, r.session.endTime == nil, !r.session.excludes.contains("frame"), !r.frameBudgetReached,
              r.captureOutput == nil || r.captureOutput === self,
              type == .screen, CMSampleBufferIsValid(sampleBuffer),
              let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        if let attachments = (CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
           let status = attachments[.status] as? Int, status != SCFrameStatus.complete.rawValue { return }
        let width = CVPixelBufferGetWidth(imageBuffer), height = CVPixelBufferGetHeight(imageBuffer)
        guard width > 0, height > 0, width <= 16384, height <= 16384, width <= 33554432 / height else {
            r.frameBudgetReached = true
            d.recordEvent(runtime: r, event: "frame_error", data: ["error": "monitor frame exceeds its pixel budget"])
            return
        }
        let framesDir = Platform.sessionDir(sid) + "/media"
        let ext = format == "png" ? "png" : (format == "webp" ? "webp" : "jpeg")

        let ciImage = CIImage(cvImageBuffer: imageBuffer)
        let context = CIContext()
        guard let rawCg = context.createCGImage(ciImage, from: ciImage.extent) else { return }

        // Resize if requested.
        let cg: CGImage
        if maxLongEdge > 0 {
            let longest = max(rawCg.width, rawCg.height)
            if longest > maxLongEdge {
                let scale = Double(maxLongEdge) / Double(longest)
                let newW = max(1, Int(Double(rawCg.width) * scale))
                let newH = max(1, Int(Double(rawCg.height) * scale))
                cg = CaptureDomain.resize(cgImage: rawCg, width: newW, height: newH) ?? rawCg
            } else {
                cg = rawCg
            }
        } else {
            cg = rawCg
        }

        guard let data = CaptureDomain.encode(cgImage: cg, format: format, quality: quality) else {
            // Surface encoder failures as a structured event instead of silently
            // dropping frames. Most common cause is `--frame-format webp` on a
            // macOS build where CGImageDestination rejects the WebP UTType.
            r.frameBudgetReached = true
            d.recordEvent(runtime: r, event: "frame_encode_error", data: [
                    "format": format,
                    "quality": quality,
                    "w": cg.width,
                    "h": cg.height
                ])
            return
        }

        // dedup: skip a frame byte-identical to the previous one (a still
        // screen at 1fps would otherwise write hundreds of identical frames).
        if data == r.lastFrameData { return }
        guard !data.isEmpty, data.count <= DESKTOP_MAX_RESULT_BYTES else {
            r.frameBudgetReached = true
            d.recordEvent(runtime: r, event: "frame_error", data: ["error": "encoded monitor frame exceeds its byte budget"])
            return
        }
        if r.savedFrames >= frameBudget || Int64(data.count) > diskCapBytes - r.savedFrameBytes {
            reachedBudget(runtime: r, domain: d)
            return
        }

        let name = "\(String(format: "%06d", r.savedFrames)).\(ext)"
        let path = framesDir + "/" + name
        do { try writeFrame(data, name: name, savedBytes: r.savedFrameBytes) }
        catch DesktopMonitorValidation.ArchiveError.limit { reachedBudget(runtime: r, domain: d); return }
        catch {
            r.frameBudgetReached = true
            d.recordEvent(runtime: r, event: "frame_error", data: ["error": "monitor frame was not saved: \(error.localizedDescription)"])
            return
        }
        r.savedFrames += 1
        r.savedFrameBytes += Int64(data.count)
        r.lastFrameData = data

        do {
            d.recordEvent(runtime: r, event: "frame", data: [
                "path": path,
                "w": cg.width,
                "h": cg.height,
                "bytes": data.count,
                "format": format,
                "quality": quality
            ])
            if visionText, !r.session.excludes.contains("ocr_text") { d.runOCROnImage(runtime: r, cg: cg, framePath: path) }

            // stop ONLY the frame output (not the whole session / video)
            // when a cap is hit, and say so loudly.
            if r.savedFrames >= frameBudget || r.savedFrameBytes >= diskCapBytes { reachedBudget(runtime: r, domain: d) }
        }
    }

    private func reachedBudget(runtime r: MonitorRuntime, domain d: MonitorDomain) {
        r.frameBudgetReached = true
        d.recordEvent(runtime: r, event: "frame_budget_reached", data: ["frames": r.savedFrames, "bytes": r.savedFrameBytes, "frameBudget": frameBudget, "diskCapBytes": diskCapBytes])
    }

    private func writeFrame(_ bytes: Data, name: String, savedBytes: Int64) throws {
        let root = Darwin.open(Platform.monitorSessionsDir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard root >= 0 else { throw DesktopMonitorValidation.ArchiveError.refused("unsafe monitor root") }
        defer { Darwin.close(root) }
        let directory = openat(root, sid, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw DesktopMonitorValidation.ArchiveError.refused("unsafe monitor session directory") }
        defer { Darwin.close(directory) }
        for descriptor in [root, directory] {
            var info = stat()
            guard fstat(descriptor, &info) == 0, info.st_uid == geteuid(), fchmod(descriptor, 0o700) == 0 else { throw DesktopMonitorValidation.ArchiveError.refused("monitor directories must be privately owned") }
        }
        if mkdirat(directory, "media", 0o700) != 0, errno != EEXIST { throw DesktopMonitorValidation.ArchiveError.refused("cannot create monitor media directory") }
        let media = openat(directory, "media", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard media >= 0 else { throw DesktopMonitorValidation.ArchiveError.refused("unsafe monitor media directory") }
        defer { Darwin.close(media) }
        var info = stat()
        guard fstat(media, &info) == 0, info.st_uid == geteuid(), fchmod(media, 0o700) == 0 else { throw DesktopMonitorValidation.ArchiveError.refused("monitor media directory must be privately owned") }
        MonitorEventWriter.shared.flush()
        let journal = openat(directory, "events.jsonl", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        var journalBytes: Int64 = 0
        if journal >= 0 {
            defer { Darwin.close(journal) }
            guard fstat(journal, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(), info.st_nlink == 1 else { throw DesktopMonitorValidation.ArchiveError.refused("unsafe monitor journal") }
            journalBytes = info.st_size
        } else if errno != ENOENT { throw DesktopMonitorValidation.ArchiveError.refused("unsafe monitor journal") }
        guard savedBytes + journalBytes + Int64(bytes.count) <= MonitorRuntime.sessionMaxBytesPerFile - 2 * 1024 * 1024 else { throw DesktopMonitorValidation.ArchiveError.limit("combined monitor media/journal budget reached") }
        let descriptor = openat(media, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw DesktopMonitorValidation.ArchiveError.refused("monitor frame path exists or cannot be created; original preserved") }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        do { try handle.write(contentsOf: bytes); try handle.synchronize() }
        catch { unlinkat(media, name, 0); throw error }
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        guard let r = runtime, let d = domain else { return }
        r.captureLock.withLock {
            guard r.captureStream === stream else { return }
            r.frameBudgetReached = true
            d.recordEvent(runtime: r, event: "frame_error", data: ["error": error.localizedDescription])
        }
    }
}

// receives SCRecordingOutput lifecycle callbacks and records
// them into the session so the timeline knows when video started/finished and
// how large the file is.
final class MonitorRecordingDelegate: NSObject, SCRecordingOutputDelegate, @unchecked Sendable {
    weak var domain: MonitorDomain?
    weak var runtime: MonitorRuntime?
    let path: String
    private let onStart: (@Sendable (SCRecordingOutput) -> Void)?
    private let onFinish: (@Sendable (SCRecordingOutput) -> Void)?
    private let onFailure: (@Sendable (Error) -> Void)?

    init(domain: MonitorDomain?, runtime: MonitorRuntime?, path: String,
         onStart: (@Sendable (SCRecordingOutput) -> Void)? = nil,
         onFinish: (@Sendable (SCRecordingOutput) -> Void)? = nil,
         onFailure: (@Sendable (Error) -> Void)? = nil) {
        self.domain = domain
        self.runtime = runtime
        self.path = path
        self.onStart = onStart; self.onFinish = onFinish; self.onFailure = onFailure
    }

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        onStart?(recordingOutput)
        if let r = runtime, let d = domain {
            d.recordEvent(runtime: r, event: "video_recording", data: ["path": path, "state": "started"])
        }
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        onFailure?(error)
        if let r = runtime, let d = domain {
            d.recordEvent(runtime: r, event: "video_error", data: ["path": path, "error": error.localizedDescription])
        }
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        onFinish?(recordingOutput)
        if let r = runtime, let d = domain {
            d.recordEvent(runtime: r, event: "video_finished", data: [
                "path": path,
                "bytes": recordingOutput.recordedFileSize,
                "durationSec": recordingOutput.recordedDuration.seconds,
            ])
        }
    }
}
#endif

extension MonitorDomain {
    #if canImport(Vision)
    func runOCROnImage(runtime r: MonitorRuntime, cg: CGImage, framePath: String) {
        let request = VNRecognizeTextRequest { [weak self, weak r] req, _ in
            guard let self = self, let r = r else { return }
            guard let observations = req.results as? [VNRecognizedTextObservation] else { return }
            let blocks = observations.prefix(64).map { obs -> [String: Any] in
                let top = obs.topCandidates(1).first
                return [
                    "text": top?.string ?? "",
                    "confidence": top?.confidence ?? 0,
                    "rect": [
                        "x": obs.boundingBox.origin.x, "y": obs.boundingBox.origin.y,
                        "w": obs.boundingBox.size.width, "h": obs.boundingBox.size.height
                    ]
                ]
            }
            self.recordEvent(runtime: r, event: "ocr_text", data: ["frame": framePath, "blocks": Array(blocks)])
        }
        request.recognitionLevel = .accurate
        let handler = VNImageRequestHandler(cgImage: cg, options: [:])
        try? handler.perform([request])
    }
    #endif
}
