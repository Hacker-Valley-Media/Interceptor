import AppKit

// One resolver for `--app <name>`. AccessibilityDomain, MenuDomain, and
// CompoundDomain compared `localizedName == name` (exact, locale-sensitive)
// while the input selector lowercased, so `--app finder` typed into Finder but
// `macos tree --app finder` answered "no target app found" (119 results in the
// 2026-09-10 session review). DefaultAppLauncher.matches already accepts the
// case-insensitive localized name, the .app basename, and the bundle id.
enum RunningApps {
    static func resolve(_ name: String) -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first(where: { DefaultAppLauncher.matches($0, name) })
    }
}
