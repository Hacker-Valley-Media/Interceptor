import XCTest
@testable import interceptor_bridge

// MonitorReplayPlanner unit tests. Pure-Swift tests; no AX, no
// NSEvent, no OS-level dependencies. Each test feeds a canned event sequence
// and asserts the emitted plan matches the expected `interceptor macos *`
// invocations.

final class MonitorReplayPlannerTests: XCTestCase {
    func testReplayArgumentsStayLiteralAndCapturedCommentsCannotBecomeCommands() throws {
        let payload = "$(printf EXPANDED)`printf EXPANDED`$INTERCEPTOR_REPLAY_VAR \"quote\" \\ apostrophe' 文件\nsecond line"
        let comment = "caption\nprintf COMMENT_EXECUTED\r\ntrailer"
        let events: [[String: Any]] = [
            ["event": "key", "app": payload, "kc": payload],
            ["event": "input", "app": payload, "r": "AXTextField", "n": payload, "v": payload],
            ["event": "click", "app": payload, "r": "AXButton", "n": payload],
            ["event": "rclick", "app": payload, "x": 120, "y": 240],
            ["event": "dblclick", "app": payload, "r": "AXButton", "n": payload],
            ["event": "menu_open", "app": payload, "n": payload],
            ["event": "menu_select", "app": payload, "n": payload],
            ["event": "scroll", "app": payload, "sy": -1.0],
            ["event": "input", "r": "AXSecureTextField", "n": comment, "v": "***SECURE***"],
            ["event": "menu_select", "n": comment],
            ["event": "window_create", "app": comment],
            ["event": comment]
        ]
        let plan = MonitorReplayPlanner.generateReplayPlan(events: events, instruction: comment)
        // Window-create also produces a background open of its literal app name.
        let expected = [
            ["macos", "open", payload], ["macos", "keys", payload, "--app", payload],
            ["macos", "type", "AXTextField:" + payload, payload, "--app", payload],
            ["macos", "click", "AXButton:" + payload, "--app", payload],
            ["macos", "click", "--right", "120,240", "--app", payload],
            ["macos", "click", "--double", "AXButton:" + payload, "--app", payload],
            ["macos", "menu", payload, payload, "--app", payload],
            ["macos", "scroll", "down", "50", "--app", payload], ["macos", "open", comment]
        ]
        for shell in ["/bin/sh", "/bin/bash", "/bin/zsh"] {
            let process = Process(), output = Pipe(), errors = Pipe()
            process.executableURL = URL(fileURLWithPath: shell)
            process.arguments = ["-f", "-c", "interceptor() { printf '%s\\0' \"$@\"; printf '\\1'; }\n" + plan]
            process.environment = ProcessInfo.processInfo.environment.merging(["INTERCEPTOR_REPLAY_VAR": "EXPANDED"]) { _, new in new }
            process.standardOutput = output; process.standardError = errors
            try process.run()
            let bytes = output.fileHandleForReading.readDataToEndOfFile()
            let stderr = errors.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0, String(decoding: stderr, as: UTF8.self))
            let rows = bytes.split(separator: 1).map { row in
                row.split(separator: 0, omittingEmptySubsequences: false).dropLast().map { String(decoding: $0, as: UTF8.self) }
            }
            XCTAssertEqual(rows, expected, shell)
        }
    }

    func testEmptySequenceProducesHeaderOnly() {
        let plan = MonitorReplayPlanner.generateReplayPlan(events: [], instruction: nil)
        XCTAssertTrue(plan.contains("# Replay plan for macOS monitor session"))
    }

    func testInstructionAppearsInPlanHeader() {
        let plan = MonitorReplayPlanner.generateReplayPlan(events: [], instruction: "send hello in slack")
        XCTAssertTrue(plan.contains("# Instruction: send hello in slack"))
    }

    // The recorded user switched apps; the replay must not. An app change
    // becomes a background `open`, with or without a bundle id on the event.
    func testAppChangeOpensInTheBackgroundAndNeverTakesFocus() {
        let events: [[String: Any]] = [
            ["event": "frontmost", "app": "Slack", "bundleId": "com.tinyspeck.slackmacgap"],
            ["event": "key", "kc": "Meta+K", "app": "Slack"],
            ["event": "frontmost", "app": "Mail"],
            ["event": "click", "x": 120, "y": 240, "app": "Mail"],
            ["event": "input", "r": "AXTextField", "n": "To", "v": "sam", "app": "Mail"],
        ]
        let plan = MonitorReplayPlanner.generateReplayPlan(events: events, instruction: nil)
        XCTAssertTrue(plan.contains("interceptor macos open \"Slack\""))
        XCTAssertTrue(plan.contains("interceptor macos open \"Mail\""))
        XCTAssertFalse(plan.contains("app activate"))
        XCTAssertFalse(plan.contains("app launch"))
        XCTAssertFalse(plan.contains("--activate"))
        // Every input line names its app, so none falls back to the frontmost app.
        XCTAssertTrue(plan.contains("interceptor macos type \"AXTextField:To\" \"sam\" --app \"Mail\""))
        for line in plan.split(separator: "\n") where line.hasPrefix("interceptor macos keys") || line.hasPrefix("interceptor macos click 1") {
            XCTAssertTrue(line.contains("--app"), "no --app on: \(line)")
        }
    }

    func testOneOpenPerAppRun() {
        let events: [[String: Any]] = [
            ["event": "key", "kc": "a", "app": "Slack"],
            ["event": "key", "kc": "b", "app": "Slack"],
        ]
        let plan = MonitorReplayPlanner.generateReplayPlan(events: events, instruction: nil)
        XCTAssertEqual(plan.components(separatedBy: "interceptor macos open \"Slack\"").count - 1, 1)
    }

    func testClickWithRoleAndNameEmitsInterceptorClick() {
        let events: [[String: Any]] = [
            ["event": "frontmost", "app": "Slack"],
            ["event": "click", "r": "AXButton", "n": "Send", "app": "Slack"]
        ]
        let plan = MonitorReplayPlanner.generateReplayPlan(events: events, instruction: nil)
        XCTAssertTrue(plan.contains("interceptor macos click \"AXButton:Send\""))
    }

    func testClickWithoutRoleFallsBackToCoordinates() {
        let events: [[String: Any]] = [
            ["event": "frontmost", "app": "Mail"],
            ["event": "click", "x": 120, "y": 240, "app": "Mail"]
        ]
        let plan = MonitorReplayPlanner.generateReplayPlan(events: events, instruction: nil)
        XCTAssertTrue(plan.contains("interceptor macos click 120,240 --app \"Mail\""))
    }

    func testKeyEmitsInterceptorKeys() {
        let events: [[String: Any]] = [
            ["event": "key", "kc": "Meta+W", "app": "Brave"]
        ]
        let plan = MonitorReplayPlanner.generateReplayPlan(events: events, instruction: nil)
        XCTAssertTrue(plan.contains("interceptor macos keys \"Meta+W\""))
    }

    func testInputEmitsInterceptorType() {
        let events: [[String: Any]] = [
            ["event": "frontmost", "app": "Slack"],
            ["event": "input", "r": "AXTextArea", "n": "message", "v": "hello world", "app": "Slack"]
        ]
        let plan = MonitorReplayPlanner.generateReplayPlan(events: events, instruction: nil)
        XCTAssertTrue(plan.contains("interceptor macos type \"AXTextArea:message\" \"hello world\""))
    }

    func testSecureMaskedInputProducesCommentNotPlaintext() {
        let events: [[String: Any]] = [
            ["event": "input", "r": "AXSecureTextField", "n": "password", "v": "***SECURE***", "app": "Slack"]
        ]
        let plan = MonitorReplayPlanner.generateReplayPlan(events: events, instruction: nil)
        XCTAssertFalse(plan.contains("\"***SECURE***\""), "secure-text masked values must not appear as plaintext type args")
        XCTAssertTrue(plan.contains("# masked secure input"))
    }

    func testMenuPathEmitsInterceptorMenu() {
        let events: [[String: Any]] = [
            ["event": "menu_open", "n": "File", "app": "TextEdit"],
            ["event": "menu_select", "n": "Save…", "app": "TextEdit"]
        ]
        let plan = MonitorReplayPlanner.generateReplayPlan(events: events, instruction: nil)
        XCTAssertTrue(plan.contains("interceptor macos menu \"File\" \"Save…\""))
    }

    func testObservedOnlyEventsProduceCommentsNotInvocations() {
        let events: [[String: Any]] = [
            ["event": "file_change", "path": "/tmp/foo"],
            ["event": "network_path", "status": "satisfied"],
            ["event": "log", "message": "noise"]
        ]
        let plan = MonitorReplayPlanner.generateReplayPlan(events: events, instruction: nil)
        XCTAssertTrue(plan.contains("# observation event: file_change"))
        XCTAssertTrue(plan.contains("# observation event: network_path"))
        XCTAssertTrue(plan.contains("# observation event: log"))
    }

    func testTimelineRendersHumanReadableLines() {
        let events: [[String: Any]] = [
            ["event": "frontmost", "app": "Slack", "t": 1715000000000],
            ["event": "click", "app": "Slack", "r": "AXButton", "n": "Send", "t": 1715000001000]
        ]
        let timeline = MonitorReplayPlanner.generateTimeline(events: events, instruction: "send hello")
        XCTAssertTrue(timeline.contains("# Session: send hello"))
        XCTAssertTrue(timeline.contains("CLICK"))
        XCTAssertTrue(timeline.contains("AXButton:Send"))
    }
}
