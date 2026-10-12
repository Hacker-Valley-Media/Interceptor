import XCTest
import AppKit
@testable import interceptor_bridge

// MonitorInputBridge unit tests. These exercise the pure helpers
// (key-combo string formation, modifier-string formation). The full NSEvent
// global-monitor path requires Accessibility TCC and a live screen; that's
// covered by the live integration script, not here.

final class MonitorInputBridgeTests: XCTestCase {
    func testKeyComboStringWithoutModifiers() {
        let event = NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "a",
            charactersIgnoringModifiers: "a",
            isARepeat: false,
            keyCode: 0
        )
        guard let event = event else { return XCTFail("could not synthesize event") }
        XCTAssertEqual(MonitorInputBridge.keyComboString(event), "a")
    }

    func testKeyComboStringWithMeta() {
        let event = NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.command],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "w",
            charactersIgnoringModifiers: "w",
            isARepeat: false,
            keyCode: 13
        )
        guard let event = event else { return XCTFail("could not synthesize event") }
        XCTAssertEqual(MonitorInputBridge.keyComboString(event), "Meta+w")
    }

    func testKeyComboStringWithMultipleModifiers() {
        let event = NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [.command, .shift, .option],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "S",
            charactersIgnoringModifiers: "S",
            isARepeat: false,
            keyCode: 1
        )
        guard let event = event else { return XCTFail("could not synthesize event") }
        XCTAssertEqual(MonitorInputBridge.keyComboString(event), "Meta+Alt+Shift+S")
    }

    func testModifierStringFormation() {
        XCTAssertEqual(MonitorInputBridge.modifierString([]), "")
        XCTAssertEqual(MonitorInputBridge.modifierString([.command]), "Meta")
        XCTAssertEqual(MonitorInputBridge.modifierString([.command, .shift]), "Meta+Shift")
        XCTAssertEqual(MonitorInputBridge.modifierString([.control, .option, .shift]), "Control+Alt+Shift")
        XCTAssertEqual(MonitorInputBridge.modifierString([.capsLock, .function]), "CapsLock+Fn")
    }
}
