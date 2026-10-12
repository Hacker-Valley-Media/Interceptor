// AppIntentDomain runtime verbs. Build-time AppIntent
// declarations live in Sources/Intents/InterceptorAppIntents.swift; this
// domain surfaces a runtime introspection + donation API. References:
// apple-developer-docs/AppIntents/{AppIntent,AppShortcut,AppShortcutsProvider}.md.

import Foundation
#if canImport(AppIntents)
import AppIntents
#endif

final class AppIntentDomain: DomainHandler, @unchecked Sendable {
    // Hand-maintained registry of declared intents. Mirrors the entries in
    // InterceptorAppIntents.swift so `appintent registered` returns ground-truth.
    nonisolated(unsafe) private static let declaredIntents: [(String, String, String)] = [
        // (name, category, systemImage)
        ("ActivateAppIntent", "System", "app.fill"),
        ("ScreenshotAppIntent", "System", "camera.viewfinder"),
        ("ScreenshotDisplayIntent", "System", "rectangle.on.rectangle"),
        ("ReadAppTreeIntent", "Accessibility", "list.bullet.indent"),
        ("ClipboardReadIntent", "System", "doc.on.clipboard"),
        ("ClipboardWriteIntent", "System", "doc.on.clipboard"),
        ("DispatchAppleScriptIntent", "System", "applescript"),
        ("OCRAppIntent", "Vision", "text.viewfinder"),
        ("ExtractEntitiesIntent", "Language", "tag"),
        ("AppleIntelligencePromptIntent", "AI", "sparkles"),
        ("StartTranscriptionIntent", "Speech", "waveform"),
        ("StopTranscriptionIntent", "Speech", "waveform"),
        ("ReadPdfIntent", "Documents", "doc.text"),
        ("CreateCalendarEventIntent", "Calendar", "calendar.badge.plus"),
        ("CreateReminderIntent", "Reminders", "list.bullet.clipboard"),
        ("AirDropFileIntent", "Sharing", "airplayaudio"),
        ("PostNotificationIntent", "System", "bell.badge"),
        ("BiometricConfirmIntent", "Security", "touchid"),
        ("TranslateTextIntent", "Language", "character.bubble"),
        ("ExportPhotoIntent", "Photos", "photo.on.rectangle"),
        ("SearchMapsIntent", "Maps", "map"),
        ("GetCurrentLocationIntent", "Location", "location"),
        ("PlaySongIntent", "Music", "music.note"),
        ("GenerateThumbnailIntent", "Documents", "photo"),
    ]

    // Phrase metadata for the AppShortcutsProvider — kept in sync with
    // InterceptorAppShortcuts.appShortcuts in InterceptorAppIntents.swift.
    nonisolated(unsafe) private static let appShortcuts: [[String: Any]] = [
        ["intentName": "ScreenshotAppIntent", "shortTitle": "Screenshot App", "phrases": ["Screenshot ${app}", "Take a screenshot of ${app}"], "systemImage": "camera.viewfinder"],
        ["intentName": "ClipboardReadIntent", "shortTitle": "Read Clipboard", "phrases": ["Read clipboard"], "systemImage": "doc.on.clipboard"],
        ["intentName": "SearchMapsIntent", "shortTitle": "Find Places", "phrases": ["Find ${query} nearby"], "systemImage": "map"],
        ["intentName": "CreateCalendarEventIntent", "shortTitle": "New Event", "phrases": ["Add ${title} to calendar"], "systemImage": "calendar.badge.plus"],
        ["intentName": "CreateReminderIntent", "shortTitle": "New Reminder", "phrases": ["Remind me to ${title}"], "systemImage": "list.bullet.clipboard"],
        ["intentName": "TranslateTextIntent", "shortTitle": "Translate", "phrases": ["Translate ${text} to ${to}"], "systemImage": "character.bubble"],
        ["intentName": "BiometricConfirmIntent", "shortTitle": "Touch ID Confirm", "phrases": ["Confirm with Touch ID"], "systemImage": "touchid"],
        ["intentName": "AirDropFileIntent", "shortTitle": "AirDrop", "phrases": ["AirDrop ${file}"], "systemImage": "airplayaudio"],
        ["intentName": "PostNotificationIntent", "shortTitle": "Notify", "phrases": ["Notify ${title}"], "systemImage": "bell.badge"],
        ["intentName": "ReadPdfIntent", "shortTitle": "Read PDF", "phrases": ["Read text from ${file}"], "systemImage": "doc.text"],
        ["intentName": "GetCurrentLocationIntent", "shortTitle": "Current Location", "phrases": ["Where am I"], "systemImage": "location"],
    ]

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "list":               listShortcuts(completion: completion)
        case "registered":         listIntents(completion: completion)
        case "donate":             donate(action, completion: completion)
        case "update-parameters":  updateParameters(completion: completion)
        case "supports":           supports(completion: completion)
        default:                   completion(WireFormat.error("appintent.\(sub) — unknown verb"))
        }
    }

    private func listShortcuts(completion: @escaping @Sendable ([String: Any]) -> Void) {
        completion(WireFormat.success(["shortcuts": Self.appShortcuts]))
    }

    private func listIntents(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let arr = Self.declaredIntents.map { tup -> [String: Any] in
            ["intentName": tup.0, "category": tup.1, "systemImage": tup.2]
        }
        completion(WireFormat.success(["intents": arr, "count": arr.count]))
    }

    private func donate(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let intentId = action["intent_id"] as? String else {
            completion(WireFormat.error("appintent.donate: <intent-id> required")); return
        }
        // The declared-intent set is hand-maintained; we don't have a runtime
        // factory to produce arbitrary intents. Surface an "ack" + the matched
        // intent name; consumers that want true IntentDonationManager
        // donations should call from inside the intent's perform() (which is
        // where Apple expects donations to happen).
        let matched = Self.declaredIntents.contains { $0.0 == intentId }
        if matched {
            completion(WireFormat.success([
                "ok": true,
                "intentId": intentId,
                "note": "Live donation hooks fire from inside each intent's perform() — Shortcuts / Spotlight will surface the intent within ~24h of first use.",
            ]))
        } else {
            completion(WireFormat.error("appintent.donate: \(intentId) is not a declared intent"))
        }
    }

    private func updateParameters(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 13, *) {
            #if canImport(AppIntents)
            InterceptorAppShortcuts.updateAppShortcutParameters()
            completion(WireFormat.success(["ok": true]))
            return
            #endif
        }
        completion(WireFormat.success(["ok": false, "note": "AppIntents requires macOS 13+"]))
    }

    private func supports(completion: @escaping @Sendable ([String: Any]) -> Void) {
        var resp: [String: Any] = [
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
            "frameworkAvailable": false,
            "intentCount": Self.declaredIntents.count,
            "shortcutCount": Self.appShortcuts.count,
        ]
        if #available(macOS 13, *) {
            #if canImport(AppIntents)
            resp["frameworkAvailable"] = true
            #endif
        }
        completion(WireFormat.success(resp))
    }
}
