import XCTest
@testable import interceptor_bridge

// MonitorReplayPlanner unit tests. Pure-Swift tests; no AX, no
// NSEvent, no OS-level dependencies. Each test feeds a canned event sequence
// and asserts the emitted plan matches the expected `interceptor macos *`
// invocations.

final class MonitorReplayPlannerTests: XCTestCase {
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
