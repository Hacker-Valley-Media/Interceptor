// Shared physical keycodes. Preserve the existing bridge table exactly.
import Foundation
public enum InputKeycodes {
    public struct Chord: Equatable, Sendable {
        public let code: UInt16
        public let modifiers: [String]
    }
    public static func macChord(_ text: String) -> Chord? {
        let parts = text.split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        guard !parts.isEmpty, parts.count <= 8, parts.allSatisfy({ !$0.isEmpty }), let key = parts.last, let code = mac[key] else { return nil }
        let aliases = ["shift": "shift", "control": "control", "ctrl": "control", "alt": "option", "option": "option", "meta": "command", "command": "command", "cmd": "command", "win": "command", "super": "command"]
        var modifiers: [String] = []
        for part in parts.dropLast() {
            guard let modifier = aliases[part], !modifiers.contains(modifier) else { return nil }
            modifiers.append(modifier)
        }
        return Chord(code: code, modifiers: modifiers)
    }
    public static let mac: [String: UInt16] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
        "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
        "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
        "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
        "enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "delete": 117,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "up": 126, "down": 125, "left": 123, "right": 124, "arrowup": 126, "arrowdown": 125, "arrowleft": 123, "arrowright": 124,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]
}
