import XCTest
@testable import interceptor_bridge

final class DesktopAccessibilityReplyTests: XCTestCase {
    private func roundTrip<T: Codable>(_ type: T.Type, _ value: Any) throws {
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
        let decoded = try JSONDecoder().decode(type, from: bytes)
        let result = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded), options: .fragmentsAllowed)
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed, .sortedKeys]), bytes)
    }

    // The live app list decodes as the neutral {name, pid} rows, not a text blob.
    func testAppsListDecodesAsNeutralRows() throws {
        let exp = expectation(description: "apps")
        nonisolated(unsafe) var reply: [String: Any] = [:]
        AppsDomain().handle("apps", action: [:]) { reply = $0; exp.fulfill() }
        wait(for: [exp], timeout: 5)
        let bytes = try JSONSerialization.data(withJSONObject: try XCTUnwrap(reply["data"] as? [[String: Any]]))
        XCTAssertNoThrow(try JSONDecoder().decode(DesktopAxAppsData.self, from: bytes))
    }

    // A menu target that does not exist is target_gone, never an unknown outcome.
    func testMenuOnMissingTargetIsTargetGone() {
        for action: [String: Any] in [["pid": Int32(99_999_999)], ["pid": Int32(99_999_999), "items": ["File"]], ["app": "NoSuchAppInterceptorQA"]] {
            let exp = expectation(description: "menu")
            nonisolated(unsafe) var reply: [String: Any] = [:]
            MenuDomain().handle("menu", action: action) { reply = $0; exp.fulfill() }
            wait(for: [exp], timeout: 5)
            XCTAssertEqual(DesktopAccessibilityResult.normalize(reply, type: "desktop_menu")["code"] as? String, "target_gone")
        }
    }

    func testHostUnionsPreserveUntaggedNativePayloads() throws {
        let frame: [String: Any] = ["x": 1, "y": 2, "width": 400, "height": 200]
        let linux: [String: Any] = ["ref": "e1", "role": "textfield", "nativeRole": "entry", "name": "Owned fixture", "title": "Owned fixture", "value": "🙂 文件", "pid": 42, "secure": false, "frame": NSNull()]
        var windows = linux; windows["nativeRole"] = 50004; windows["frame"] = frame
        try roundTrip(DesktopAxAppsData.self, [["name": "Finder", "pid": 42, "bundleId": "com.apple.finder", "active": false, "hidden": true]])
        try roundTrip(DesktopAxAppsData.self, [["name": "Owned fixture", "pid": 42]])
        try roundTrip(DesktopAxWindowsData.self, [["ref": "e1", "title": "Owned fixture", "windowId": 42, "frame": frame]])
        try roundTrip(DesktopAxFindData.self, [linux])
        try roundTrip(DesktopAxFindData.self, [windows])
        try roundTrip(DesktopAxFocusedData.self, NSNull())
        try roundTrip(DesktopAxFrontmostData.self, NSNull())
        try roundTrip(DesktopAxInspectData.self, ["AXRole": "AXTextField", "AXValue": "🙂 文件", "frame": frame, "actions": ["AXPress"]])
        try roundTrip(DesktopAxTypeData.self, "typed")
        try roundTrip(DesktopAxTypeData.self, ["method": "owned fixture", "background": true, "targetPid": 42])
        try roundTrip(DesktopAxMenuData.self, [["title": "File", "enabled": true, "children": [["title": "Owned item", "enabled": false, "children": []]]]])
        try roundTrip(DesktopAxMenuData.self, [["title": "File", "id": 1, "enabled": true, "children": []]])
        try roundTrip(DesktopAxAppData.self, ["subcommand": "hide", "pid": 42, "method": "owned fixture", "window": "42"])
        try roundTrip(DesktopAxResizeData.self, ["frame": frame, "requested": ["width": 400, "height": 200], "clamped": false])
    }

    func testNativeReplyDecodingRejectsUnknownNullAndWrongNestedFields() throws {
        for value: [String: Any] in [
            ["method": "owned fixture", "background": true, "unexpected": true],
            ["method": "owned fixture", "background": true, "targetPid": NSNull()],
            ["method": "owned fixture", "background": "true"],
            ["method": "owned fixture"],
        ] {
            let data = try JSONSerialization.data(withJSONObject: value)
            XCTAssertThrowsError(try JSONDecoder().decode(DesktopAxNativeInputData.self, from: data))
            XCTAssertThrowsError(try JSONDecoder().decode(DesktopAxTypeData.self, from: data))
        }
        for value: [String: Any] in [
            ["ref": "e1", "title": "Owned fixture", "frame": ["x": 1, "y": 2, "width": 3, "height": 4, "unexpected": true]],
            ["ref": "e1", "title": "Owned fixture", "windowId": NSNull()],
        ] {
            XCTAssertThrowsError(try JSONDecoder().decode(DesktopAxDarwinWindow.self, from: JSONSerialization.data(withJSONObject: value)))
        }
        XCTAssertThrowsError(try JSONDecoder().decode(DesktopAxLinuxMenuEntry.self, from: Data(#"{"title":"File","enabled":true,"children":[{"title":"bad","enabled":"true","children":[]}]}"#.utf8)))
    }
}
