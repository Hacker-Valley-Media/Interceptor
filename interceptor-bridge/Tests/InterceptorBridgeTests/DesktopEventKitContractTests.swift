import XCTest
@testable import interceptor_bridge

final class DesktopEventKitContractTests: XCTestCase {
    func testMalformedScopeAndMutationFieldsFailBeforeNativeAdmission() {
        let rows: [[String: Any]] = [
            ["type": "desktop_calendar", "sub": "events", "start": "2026-01-01T00:00:00Z", "end": "2026-01-02T00:00:00Z", "calendar": "one", "calendars": "two"],
            ["type": "desktop_calendar", "sub": "update", "id": "actual", "attendees": ["someone@example.test"]],
            ["type": "desktop_calendar", "sub": "update", "id": "actual", "recurrence_interval": 2],
            ["type": "desktop_calendar", "sub": "update", "id": "actual", "alarms": ["NaN"]],
            ["type": "desktop_reminders", "sub": "create", "title": "fixture", "due": "2026-02-30T00:00:00Z"],
            ["type": "desktop_reminders", "sub": "update", "id": "actual", "priority": "urgent"],
            ["type": "desktop_reminders", "sub": "completed", "since": "2026-01-02T00:00:00Z", "until": "2026-01-01T00:00:00Z"],
        ]
        for row in rows { XCTAssertNotNil(DesktopEventKitValidation.actionError(row)) }
        XCTAssertNil(DesktopEventKitValidation.actionError(["type": "desktop_calendar", "sub": "update", "id": "actual", "alarms": []]))
    }
    func testActualISODateAndOffsetSemantics() {
        for text in ["0000-01-01T00:00:00Z", "2026-02-29T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:60Z", "2026-01-01T00:00:00"] { XCTAssertNil(DesktopEventKitValidation.date(text)) }
        XCTAssertEqual(DesktopEventKitValidation.date("2024-02-29T12:00:00-06:00"), DesktopEventKitValidation.date("2024-02-29T18:00:00Z"))
    }
    func testNativeReplyCannotBroadenScopeOrInventCompletion() {
        let event: [String: Any] = ["id": "actual", "calendarId": "wrong", "title": "fixture", "startDate": "2026-01-01T00:00:00Z", "endDate": "2026-01-01T01:00:00Z", "isAllDay": false, "isDetached": false, "status": "confirmed", "availability": "busy"]
        XCTAssertNotNil(DesktopEventKitValidation.resultError(WireFormat.success(["events": [event], "limit": 100, "offset": 0, "hasMore": false]), action: ["type": "desktop_calendar", "sub": "events", "calendar": "actual"]))
        XCTAssertNotNil(DesktopEventKitValidation.resultError(WireFormat.success(["id": "actual", "listId": "list", "title": "fixture", "isCompleted": false, "priority": "none"]), action: ["type": "desktop_reminders", "sub": "complete", "id": "actual"]))
        XCTAssertNil(DesktopEventKitValidation.resultError(WireFormat.success(["calendar": NSNull()]), action: ["type": "desktop_calendar", "sub": "default"]))
    }
    func testZeroLengthEventIsAValidRowButAReversedOneIsNot() {
        func page(_ end: String) -> [String: Any] {
            WireFormat.success(["events": [["id": "actual", "calendarId": "cal", "title": "fixture", "startDate": "2026-01-01T09:00:00Z", "endDate": end, "isAllDay": false, "isDetached": false, "status": "confirmed", "availability": "busy"]], "limit": 100, "offset": 0, "hasMore": false])
        }
        let action: [String: Any] = ["type": "desktop_calendar", "sub": "events"]
        XCTAssertNil(DesktopEventKitValidation.resultError(page("2026-01-01T09:00:00Z"), action: action))
        XCTAssertNotNil(DesktopEventKitValidation.resultError(page("2026-01-01T08:59:59Z"), action: action))
    }
}
