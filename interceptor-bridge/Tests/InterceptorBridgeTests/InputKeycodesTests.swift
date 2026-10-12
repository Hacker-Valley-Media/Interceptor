import XCTest
import InputKeycodes

final class InputKeycodesTests: XCTestCase {
    func testPhysicalChordsResolveKnownKeysAndModifierAliases() {
        let chord = InputKeycodes.macChord("Cmd+Shift+X")
        XCTAssertEqual(chord?.code, 7)
        XCTAssertEqual(chord?.modifiers, ["command", "shift"])
        XCTAssertEqual(InputKeycodes.macChord("ctrl+return")?.code, 36)
        XCTAssertEqual(InputKeycodes.macChord("option+f12")?.code, 111)
        XCTAssertEqual(InputKeycodes.mac["delete"], 117)
        XCTAssertEqual(InputKeycodes.mac["arrowleft"], 123)
    }
    func testUnknownEmptyAndRepeatedModifiersCannotBecomeLiteralTyping() {
        for value in ["", "+x", "cmd++x", "other+x", "ctrl+control+x", "cmd+command+x", "cmd+unknown", "cmd+", "shift+shift+x"] {
            XCTAssertNil(InputKeycodes.macChord(value), value)
        }
    }
}
