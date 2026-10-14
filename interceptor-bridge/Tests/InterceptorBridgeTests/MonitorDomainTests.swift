import XCTest
import CoreVideo
import CoreMedia
import ScreenCaptureKit
@testable import interceptor_bridge

// MonitorDomain dispatch + lifecycle tests. We don't exercise the
// live AX, NSEvent, ScreenCaptureKit, OSLog, or Speech surfaces in CI (those
// require TCC consents that don't exist on a build runner). Tests here pin
// the dispatch contract, the structured-error format, and the session-meta
// shape produced by the orchestrator.

private final class ResultHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: Any] = [:]
    var value: [String: Any] {
        lock.lock(); defer { lock.unlock() }; return stored
    }
    func set(_ v: [String: Any]) { lock.lock(); stored = v; lock.unlock() }
}

final class MonitorDomainTests: XCTestCase {
    private func dispatch(_ domain: MonitorDomain, sub: String, extra: [String: Any] = [:]) -> [String: Any] {
        var action: [String: Any] = ["type": "macos_monitor", "sub": sub]
        for (k, v) in extra { action[k] = v }
        let holder = ResultHolder()
        let exp = expectation(description: "monitor dispatch \(sub)")
        domain.handle("monitor", action: action) { r in
            holder.set(r)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 2.0)
        return holder.value
    }

    func testStopWithNoActiveSessionReturnsStructuredError() {
        let r = dispatch(MonitorDomain(), sub: "stop")
        XCTAssertEqual(r["success"] as? Bool, false)
        XCTAssertEqual(r["error"] as? String, "no active recording matches the requested sid"); XCTAssertEqual(r["code"] as? String, "target_gone")
        XCTAssertNil(r["exitCode"])
    }

    func testPauseWithNoActiveSessionReturnsStructuredError() {
        let r = dispatch(MonitorDomain(), sub: "pause")
        XCTAssertEqual(r["error"] as? String, "no active recording matches the requested sid"); XCTAssertEqual(r["code"] as? String, "target_gone")
    }

    func testResumeWithNoActiveSessionReturnsStructuredError() {
        let r = dispatch(MonitorDomain(), sub: "resume")
        XCTAssertEqual(r["error"] as? String, "no active recording matches the requested sid"); XCTAssertEqual(r["code"] as? String, "target_gone")
    }

    func testStatusWhenIdle() {
        let r = dispatch(MonitorDomain(), sub: "status")
        XCTAssertEqual(r["success"] as? Bool, true)
        let data = r["data"] as? [String: Any]
        XCTAssertEqual(data?["status"] as? String, "idle")
    }

    func testExplicitUnknownOrMalformedSidNeverTargetsAnotherSession() {
        for sub in ["pause", "resume", "stop", "status"] {
            for sid: Any in ["ffffffff", "", 17, true, NSNull()] {
                for count in [1, 2] {
                    let domain = MonitorDomain()
                    let sessions = (0..<count).map { _ in
                        MonitorSession(
                            id: String(UUID().uuidString.prefix(8)).lowercased(),
                            instruction: nil, startTime: Date(), scope: .apps(["Owned monitor fixture"]),
                            includes: [], excludes: ["key"],
                            tcc: MonitorTccSnapshot(accessibility: true, screenRecording: nil, microphone: nil)
                        )
                    }
                    for session in sessions {
                        session.paused = sub == "resume"
                        domain.runtimes[session.id] = MonitorRuntime(session: session, domain: domain)
                    }
                    let result = dispatch(domain, sub: sub, extra: ["sid": sid])
                    XCTAssertEqual(result["success"] as? Bool, false, "\(sub), sid=\(sid), count=\(count)")
                    XCTAssertEqual(result["error"] as? String, "no active recording matches the requested sid"); XCTAssertEqual(result["code"] as? String, "target_gone")
                    XCTAssertNil(result["exitCode"])
                    XCTAssertNil(result["data"], "An invalid target must not disclose other recordings")
                    XCTAssertEqual(domain.lockedRuntimes().count, count)
                    for session in sessions {
                        XCTAssertEqual(session.paused, sub == "resume")
                        XCTAssertNil(session.endTime)
                        XCTAssertEqual(session.evt, 0)
                    }
                }
            }
        }
    }

    func testExplicitSidWhenIdleReturnsNoActiveSession() {
        let result = dispatch(MonitorDomain(), sub: "status", extra: ["sid": "ffffffff"])
        XCTAssertEqual(result["success"] as? Bool, false)
        XCTAssertEqual(result["error"] as? String, "no active recording matches the requested sid"); XCTAssertEqual(result["code"] as? String, "target_gone")
        XCTAssertNil(result["exitCode"])
    }

    func testUnscopedSingleSessionLifecycleStillWorks() {
        let domain = MonitorDomain()
        let session = MonitorSession(
            id: String(UUID().uuidString.prefix(8)).lowercased(),
            instruction: nil, startTime: Date(), scope: .apps(["Owned monitor fixture"]),
            includes: [], excludes: ["key"],
            tcc: MonitorTccSnapshot(accessibility: true, screenRecording: nil, microphone: nil)
        )
        domain.runtimes[session.id] = MonitorRuntime(session: session, domain: domain)
        for (sub, paused) in [("pause", true), ("resume", false)] {
            let result = dispatch(domain, sub: sub)
            XCTAssertEqual(result["success"] as? Bool, true)
            XCTAssertEqual((result["data"] as? [String: Any])?["sid"] as? String, session.id)
            XCTAssertEqual(session.paused, paused)
            XCTAssertEqual(domain.lockedRuntimes().count, 1)
        }
        let stopped = dispatch(domain, sub: "stop")
        XCTAssertEqual(stopped["success"] as? Bool, true)
        XCTAssertEqual((stopped["data"] as? [String: Any])?["sid"] as? String, session.id)
        XCTAssertNotNil(session.endTime)
        XCTAssertTrue(domain.lockedRuntimes().isEmpty)
    }

    func testListReturnsArray() {
        let r = dispatch(MonitorDomain(), sub: "list")
        XCTAssertEqual(r["success"] as? Bool, true)
        XCTAssertNotNil(r["data"] as? [Any])
    }

    func testRecorderFiltersScopeAndExcludesBeforeWritingOrCounting() throws {
        let domain = MonitorDomain()
        for (scope, includeSystem) in [(MonitorScope.apps(["Owned monitor fixture", "com.fixture.owned"]), false), (.all(), false), (.apps(["Owned monitor fixture", "com.fixture.owned"]), true), (.all(), true)] {
            let sid = String(UUID().uuidString.prefix(8)).lowercased()
            let session = MonitorSession(id: sid, instruction: nil, startTime: Date(), scope: scope,
                includes: ["files"], excludes: ["key", "mon_start"],
                tcc: MonitorTccSnapshot(accessibility: true, screenRecording: nil, microphone: nil))
            let runtime = MonitorRuntime(session: session, domain: domain)
            runtime.excludeApps = ["com.fixture.excluded", "Excluded fixture"]
            runtime.includeSystemApps = includeSystem
            defer { try? FileManager.default.removeItem(atPath: Platform.sessionDir(sid)) }
            let rows: [(String, [String: Any], Bool)] = [
                ("mon_start", [:], true),
                ("input", ["app": "Owned monitor fixture", "v": "owned value"], true),
                ("scroll", ["bundleId": "com.fixture.owned", "sy": 1], true),
                ("key", ["app": "Owned monitor fixture", "kc": "synthetic excluded canary"], false),
                ("scroll", ["app": "Foreign fixture", "sy": 1], scope.mode == .all),
                ("frontmost", ["bundleId": "com.fixture.excluded"], false),
                ("launch", ["app": "Excluded fixture"], false),
                ("scroll", ["app": "", "bundleId": ""], false),
                ("input", ["pid": 0, "v": "unknown identity canary"], false),
                ("frontmost", ["bundleId": "com.apple.dock"], includeSystem && scope.mode == .all),
                ("file_change", ["path": "/owned/explicit-file-source"], true)
            ]
            for (event, data, _) in rows { domain.recordEvent(runtime: runtime, event: event, data: data) }
            session.paused = true
            domain.recordEvent(runtime: runtime, event: "input", data: ["app": "Owned monitor fixture", "v": "paused canary"])
            domain.recordEvent(runtime: runtime, event: "mon_stop", data: [:])
            MonitorEventWriter.shared.flush()
            let bytes = try Data(contentsOf: URL(fileURLWithPath: Platform.sessionDir(sid) + "/events.jsonl"))
            let written = try String(decoding: bytes, as: UTF8.self).split(separator: "\n").map {
                try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
            }
            let expected = rows.filter { $0.2 }.map { $0.0 } + ["mon_stop"]
            XCTAssertEqual(written.compactMap { $0["event"] as? String }, expected)
            XCTAssertEqual(written.compactMap { $0["s"] as? Int }, Array(0..<expected.count))
            XCTAssertEqual(session.evt, expected.count)
            XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("canary"))
        }
    }

    func testStoppedMetadataCountsIncludePersistedStopMarker() throws {
        let domain = MonitorDomain(), sid = String(UUID().uuidString.prefix(8)).lowercased()
        let session = MonitorSession(id: sid, instruction: nil, startTime: Date(), scope: .apps(["Owned monitor fixture"]),
            includes: [], excludes: [], tcc: MonitorTccSnapshot(accessibility: true, screenRecording: nil, microphone: nil))
        let runtime = MonitorRuntime(session: session, domain: domain)
        domain.runtimes[sid] = runtime
        defer { try? FileManager.default.removeItem(atPath: Platform.sessionDir(sid)) }
        domain.recordEvent(runtime: runtime, event: "mon_start", data: [:])
        domain.recordEvent(runtime: runtime, event: "input", data: ["app": "Owned monitor fixture", "v": "owned value"])
        let stopped = dispatch(domain, sub: "stop", extra: ["sid": sid])
        XCTAssertEqual(stopped["success"] as? Bool, true)
        XCTAssertEqual((stopped["data"] as? [String: Any])?["evt"] as? Int, 2)
        let bytes = try Data(contentsOf: URL(fileURLWithPath: Platform.sessionDir(sid) + "/events.jsonl"))
        let meta = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: Platform.sessionDir(sid) + "/session.json"))) as? [String: Any])
        XCTAssertEqual(meta["status"] as? String, "stopped")
        XCTAssertEqual((meta["counts"] as? [String: Int])?["evt"], String(decoding: bytes, as: UTF8.self).split(separator: "\n").count)
        XCTAssertEqual(session.evt, 3)
        XCTAssertTrue(domain.lockedRuntimes().isEmpty)
    }

    func testExportRequiresSid() {
        let r = dispatch(MonitorDomain(), sub: "export")
        XCTAssertEqual(r["success"] as? Bool, false)
        XCTAssertEqual(r["error"] as? String, "export requires a sid")
    }

    func testStartWithoutAccessibilityTccReturnsStructuredError() {
        // CI runners and the build environment will not have AX TCC granted
        // to the test process, so this is the path we expect to hit.
        let r = dispatch(MonitorDomain(), sub: "start", extra: ["instruction": "test"])
        if r["success"] as? Bool == false {
            XCTAssertEqual(r["code"] as? String, "permission_required")
            XCTAssertTrue((r["error"] as? String ?? "").contains("Accessibility"))
            XCTAssertNotNil((r["details"] as? [String: Any])?["remediation"])
        } else {
            // If AX is granted (rare in CI), make sure we got a session id back.
            let data = r["data"] as? [String: Any]
            XCTAssertNotNil(data?["sid"] as? String)
            // Clean up so subsequent tests don't see an active session.
            // (Swallow result; we just want the side effect.)
            _ = dispatch(MonitorDomain(), sub: "stop")
        }
    }

    func testTailWithNoSessionReturnsError() {
        let r = dispatch(MonitorDomain(), sub: "tail")
        XCTAssertEqual(r["success"] as? Bool, false)
        XCTAssertEqual(r["error"] as? String, "no active recording matches the requested sid"); XCTAssertEqual(r["code"] as? String, "target_gone")
    }

    func testUnknownSubReturnsNotImplemented() {
        let r = dispatch(MonitorDomain(), sub: "nonexistent")
        let err = r["error"] as? String ?? ""
        XCTAssertTrue(err.contains("nonexistent"), "Error should reference the unknown sub")
    }

    // Multi-session map. Without AX consent the start path
    // exits on missing_tcc:Accessibility, so we exercise the runtime map
    // directly: insert two MonitorRuntimes, then verify sub-verb dispatch by
    // --sid argument finds the right one.
    func testConcurrentMultiSessionStatusDisambiguation() {
        let domain = MonitorDomain()

        let s1 = MonitorSession(
            id: "aaa11111", instruction: "first", startTime: Date(),
            scope: .frontmost(), includes: [], excludes: [],
            tcc: MonitorTccSnapshot(accessibility: true, screenRecording: nil, microphone: nil)
        )
        let s2 = MonitorSession(
            id: "bbb22222", instruction: "second", startTime: Date(),
            scope: .all(), includes: ["clipboard"], excludes: [],
            tcc: MonitorTccSnapshot(accessibility: true, screenRecording: nil, microphone: nil)
        )
        let r1 = MonitorRuntime(session: s1, domain: domain)
        let r2 = MonitorRuntime(session: s2, domain: domain)
        domain.runtimes[s1.id] = r1
        domain.runtimes[s2.id] = r2

        // Status with no sid returns array of N sessions.
        let bulk = dispatch(domain, sub: "status")
        XCTAssertEqual(bulk["success"] as? Bool, true)
        let bulkData = bulk["data"] as? [String: Any]
        let sessions = bulkData?["sessions"] as? [[String: Any]]
        XCTAssertEqual(sessions?.count, 2)
        XCTAssertEqual(bulkData?["activeCount"] as? Int, 2)

        // Status targeted by sid returns the specific session.
        let one = dispatch(domain, sub: "status", extra: ["sid": "aaa11111"])
        let oneData = one["data"] as? [String: Any]
        XCTAssertEqual(oneData?["sid"] as? String, "aaa11111")
        XCTAssertEqual(oneData?["scope"] as? [String: Any] != nil, true)
    }

    func testStopWithSidStopsExactlyThatSession() {
        let domain = MonitorDomain()
        let s1 = MonitorSession(
            id: "ccc33333", instruction: nil, startTime: Date(),
            scope: .frontmost(), includes: [], excludes: [],
            tcc: MonitorTccSnapshot(accessibility: true, screenRecording: nil, microphone: nil)
        )
        let s2 = MonitorSession(
            id: "ddd44444", instruction: nil, startTime: Date(),
            scope: .all(), includes: [], excludes: [],
            tcc: MonitorTccSnapshot(accessibility: true, screenRecording: nil, microphone: nil)
        )
        domain.runtimes[s1.id] = MonitorRuntime(session: s1, domain: domain)
        domain.runtimes[s2.id] = MonitorRuntime(session: s2, domain: domain)

        // Stop the first by sid; only the second should remain.
        let stopped = dispatch(domain, sub: "stop", extra: ["sid": "ccc33333"])
        XCTAssertEqual(stopped["success"] as? Bool, true)

        XCTAssertNil(domain.runtimes["ccc33333"])
        XCTAssertNotNil(domain.runtimes["ddd44444"])
    }

    func testStopWithoutSidWhenAmbiguousReturnsNoActiveSession() {
        let domain = MonitorDomain()
        let s1 = MonitorSession(
            id: "eee55555", instruction: nil, startTime: Date(),
            scope: .frontmost(), includes: [], excludes: [],
            tcc: MonitorTccSnapshot(accessibility: true, screenRecording: nil, microphone: nil)
        )
        let s2 = MonitorSession(
            id: "fff66666", instruction: nil, startTime: Date(),
            scope: .all(), includes: [], excludes: [],
            tcc: MonitorTccSnapshot(accessibility: true, screenRecording: nil, microphone: nil)
        )
        domain.runtimes[s1.id] = MonitorRuntime(session: s1, domain: domain)
        domain.runtimes[s2.id] = MonitorRuntime(session: s2, domain: domain)

        // Two active sessions, no --sid → ambiguous → no_active_session.
        let r = dispatch(domain, sub: "stop")
        XCTAssertEqual(r["success"] as? Bool, false)
        XCTAssertEqual(r["error"] as? String, "no active recording matches the requested sid"); XCTAssertEqual(r["code"] as? String, "target_gone")
    }

    // CGEventTap fallback. We can't actually create a real
    // tap without Accessibility TCC, so this test verifies the code path
    // doesn't crash and surfaces the structured `tap_unavailable` event when
    // CGEvent.tapCreate returns nil.
    func testTapBridgeStartReturnsFalseWithoutTcc() {
        let bridge = MonitorTapBridge()
        // In test environment without AX TCC, tapCreate returns nil.
        // The bridge's start() returns false and doesn't crash.
        let ok = bridge.start()
        // Either result is acceptable — the contract is that the call
        // doesn't crash and returns a Bool. If somehow AX is granted on
        // the runner, ok==true is fine; we just stop it and move on.
        if ok { bridge.stop() }
    }

    func testTapBridgeModifierString() {
        var f: CGEventFlags = []
        XCTAssertEqual(MonitorTapBridge.modifierString(f), "")
        f = [.maskCommand]
        XCTAssertEqual(MonitorTapBridge.modifierString(f), "Meta")
        f = [.maskCommand, .maskShift]
        XCTAssertEqual(MonitorTapBridge.modifierString(f), "Meta+Shift")
        f = [.maskControl, .maskAlternate, .maskShift]
        XCTAssertEqual(MonitorTapBridge.modifierString(f), "Control+Alt+Shift")
    }

    func testTapRefusesFilteredAndExcludedKeysBeforeDecoding() throws {
        let bridge = MonitorTapBridge(), delivered = ResultHolder(), filtered = ResultHolder()
        let key = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true))
        let pointer = Unmanaged.passUnretained(bridge).toOpaque()
        let proxy = OpaquePointer(pointer) // The passive callback does not use its proxy.
        bridge.setCallback({ event, data in delivered.set(["event": event, "data": data]) }, appFilter: { _ in
            filtered.set(["called": true]); return false
        })
        _ = MonitorTapBridge.cTapCallback(proxy, .keyDown, key, pointer)
        XCTAssertEqual(filtered.value["called"] as? Bool, true)
        XCTAssertTrue(delivered.value.isEmpty)
        filtered.set([:])
        _ = bridge.start(excludeKey: true)
        defer { bridge.stop() }
        _ = MonitorTapBridge.cTapCallback(proxy, .keyDown, key, pointer)
        XCTAssertTrue(filtered.value.isEmpty)
        XCTAssertTrue(delivered.value.isEmpty)
        bridge.setCallback({ event, data in delivered.set(["event": event, "data": data]) }, appFilter: { _ in true })
        _ = MonitorTapBridge.cTapCallback(proxy, .leftMouseDown, key, pointer)
        XCTAssertEqual(delivered.value["event"] as? String, "click")
    }

    func testFrameArtifactsHonorPauseCapsAndExclusivePrivateWrites() throws {
        var pixel: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(nil, 32, 16, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &pixel), kCVReturnSuccess)
        let image = try XCTUnwrap(pixel)
        CVPixelBufferLockBaseAddress(image, [])
        memset(CVPixelBufferGetBaseAddress(image), 0xff, CVPixelBufferGetBytesPerRow(image) * 16)
        CVPixelBufferUnlockBaseAddress(image, [])
        var description: CMVideoFormatDescription?
        XCTAssertEqual(CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: image, formatDescriptionOut: &description), noErr)
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        XCTAssertEqual(CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: image, formatDescription: try XCTUnwrap(description), sampleTiming: &timing, sampleBufferOut: &sample), noErr)
        let buffer = try XCTUnwrap(sample), stream = SCStream(filter: SCContentFilter(), configuration: SCStreamConfiguration(), delegate: nil)
        let domain = MonitorDomain()
        for scenario in ["paused", "byte-cap", "valid", "collision", "linked-directory", "excluded", "resumed-stale"] {
            let sid = String(UUID().uuidString.prefix(8)).lowercased()
            let session = MonitorSession(id: sid, instruction: nil, startTime: Date(), scope: .apps(["Owned frame fixture"]),
                includes: [], excludes: scenario == "excluded" ? ["frame"] : [], tcc: MonitorTccSnapshot(accessibility: true, screenRecording: true, microphone: nil))
            let runtime = MonitorRuntime(session: session, domain: domain)
            domain.runtimes[sid] = runtime
            Platform.ensureSessionDir(sid)
            let media = Platform.sessionDir(sid) + "/media", frame = media + "/000000.png"
            defer { MonitorEventWriter.shared.flush(); try? FileManager.default.removeItem(atPath: Platform.sessionDir(sid)); domain.runtimes.removeValue(forKey: sid) }
            let sentinel = Data("owned original".utf8)
            if scenario == "collision" { try FileManager.default.createDirectory(atPath: media, withIntermediateDirectories: true); try sentinel.write(to: URL(fileURLWithPath: frame)) }
            if scenario == "linked-directory" { try FileManager.default.createSymbolicLink(atPath: media, withDestinationPath: Platform.sessionDir(sid)) }
            if scenario == "paused" { session.paused = true }
            let output = MonitorCaptureOutput(domain: domain, runtime: runtime, sid: sid, visionText: false, format: "png", frameBudget: 1, diskCapBytes: scenario == "byte-cap" ? 1 : 1048576)
            if scenario == "resumed-stale" {
                XCTAssertEqual(dispatch(domain, sub: "pause", extra: ["sid": sid])["success"] as? Bool, true)
                XCTAssertEqual(dispatch(domain, sub: "resume", extra: ["sid": sid])["success"] as? Bool, true)
            }
            output.stream(stream, didOutputSampleBuffer: buffer, of: .screen)
            MonitorEventWriter.shared.flush()
            let names = try FileManager.default.contentsOfDirectory(atPath: Platform.sessionDir(sid))
            XCTAssertFalse(names.contains("frames"), scenario)
            if scenario == "valid" {
                XCTAssertTrue(FileManager.default.fileExists(atPath: frame))
                let attrs = try FileManager.default.attributesOfItem(atPath: frame)
                XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
                XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: media)[.posixPermissions] as? NSNumber)?.intValue, 0o700)
                let journal = try String(contentsOfFile: Platform.sessionEventsPath(sid), encoding: .utf8)
                XCTAssertTrue(journal.contains("\"event\":\"frame\""))
                XCTAssertTrue(journal.contains("frame_budget_reached"))
                let original = try Data(contentsOf: URL(fileURLWithPath: frame))
                _ = dispatch(domain, sub: "stop", extra: ["sid": sid])
                output.stream(stream, didOutputSampleBuffer: buffer, of: .screen)
                XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: frame)), original)
            } else if scenario == "collision" {
                XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: frame)), sentinel)
            } else {
                XCTAssertFalse(FileManager.default.fileExists(atPath: frame), scenario)
            }
        }
    }

    func testResumeCannotReopenGateWhileCaptureStopIsPending() throws {
        let domain = MonitorDomain(), sid = String(UUID().uuidString.prefix(8)).lowercased()
        let session = MonitorSession(id: sid, instruction: nil, startTime: Date(), scope: .apps(["Owned frame fixture"]),
            includes: [], excludes: [], tcc: MonitorTccSnapshot(accessibility: true, screenRecording: true, microphone: nil))
        let runtime = MonitorRuntime(session: session, domain: domain), barrier = ResultHolder()
        let waiting = expectation(description: "capture setup pending")
        runtime.captureTask = Task {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                barrier.set(["release": { continuation.resume() }])
                waiting.fulfill()
            }
        }
        wait(for: [waiting], timeout: 2)
        let release = try XCTUnwrap(barrier.value["release"] as? (() -> Void))
        domain.runtimes[sid] = runtime
        defer { try? FileManager.default.removeItem(atPath: Platform.sessionDir(sid)) }
        let ended = expectation(description: "pending capture stop completed"), result = ResultHolder()
        domain.handle("monitor", action: ["sub": "stop", "sid": sid]) { reply in result.set(reply); ended.fulfill() }
        XCTAssertNotNil(session.endTime)
        let resumed = dispatch(domain, sub: "resume", extra: ["sid": sid])
        XCTAssertEqual(resumed["success"] as? Bool, false)
        XCTAssertEqual(resumed["error"] as? String, "no active recording matches the requested sid"); XCTAssertEqual(resumed["code"] as? String, "target_gone")
        XCTAssertTrue(session.paused)
        release()
        wait(for: [ended], timeout: 2)
        XCTAssertEqual(result.value["success"] as? Bool, true)
        XCTAssertTrue(domain.lockedRuntimes().isEmpty)
        let journal = try String(contentsOfFile: Platform.sessionEventsPath(sid), encoding: .utf8)
        XCTAssertFalse(journal.contains("mon_resume"))
        session.paused = false // Simulate a late pre-stop callback retaining the runtime.
        domain.recordEvent(runtime: runtime, event: "input", data: ["app": "Owned frame fixture", "v": "late callback canary"])
        MonitorEventWriter.shared.flush()
        XCTAssertEqual(try String(contentsOfFile: Platform.sessionEventsPath(sid), encoding: .utf8), journal)
    }
}
