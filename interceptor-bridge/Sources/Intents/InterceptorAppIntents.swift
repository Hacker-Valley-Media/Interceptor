// AppIntents declarations (build-time, ship in the bundle).
// Every intent below is discoverable by Spotlight, Siri, and the Shortcuts.app
// once the .app bundle is installed and registered. References:
// apple-developer-docs/AppIntents/{AppIntent,AppEntity,AppEnum,EntityQuery,
// AppShortcut,AppShortcutsProvider,IntentDescription}.md.
//
// Each AppIntent's `perform()` calls back into the same in-process domain
// handlers via the bridge router so Shortcuts gets the same response shape
// the CLI does.

import Foundation
#if canImport(AppIntents)
import AppIntents

// MARK: - AppEnum types

@available(macOS 13, *)
public enum PriorityEnum: String, AppEnum {
    case high
    case medium
    case low
    case none
    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Priority" }
    public static var caseDisplayRepresentations: [PriorityEnum: DisplayRepresentation] {
        [.high: "High", .medium: "Medium", .low: "Low", .none: "None"]
    }
}

@available(macOS 13, *)
public enum ScreenshotFormatEnum: String, AppEnum {
    case png, jpeg, webp, heic
    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Screenshot Format" }
    public static var caseDisplayRepresentations: [ScreenshotFormatEnum: DisplayRepresentation] {
        [.png: "PNG", .jpeg: "JPEG", .webp: "WebP", .heic: "HEIC"]
    }
}

@available(macOS 13, *)
public enum LanguageEnum: String, AppEnum {
    case english = "en"
    case spanish = "es"
    case french = "fr"
    case german = "de"
    case italian = "it"
    case portuguese = "pt"
    case japanese = "ja"
    case korean = "ko"
    case chineseSimplified = "zh-Hans"
    case chineseTraditional = "zh-Hant"
    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Language" }
    public static var caseDisplayRepresentations: [LanguageEnum: DisplayRepresentation] {
        [
            .english: "English", .spanish: "Spanish", .french: "French",
            .german: "German", .italian: "Italian", .portuguese: "Portuguese",
            .japanese: "Japanese", .korean: "Korean",
            .chineseSimplified: "Chinese (Simplified)", .chineseTraditional: "Chinese (Traditional)",
        ]
    }
}

// MARK: - Bridge dispatch helper

@available(macOS 13, *)
fileprivate enum InterceptorIntentBridge {
    /// Dispatch an action through the same router the CLI uses.
    /// Wraps the [String: Any] response in a Sendable box so it can cross the
    /// CheckedContinuation boundary under Swift 6 strict concurrency.
    struct ResponseBox: @unchecked Sendable {
        let value: [String: Any]
    }
    static func dispatch(_ action: [String: Any]) async -> [String: Any] {
        let box: ResponseBox = await withCheckedContinuation { (cont: CheckedContinuation<ResponseBox, Never>) in
            guard let router = GlobalRouterRef.shared else {
                cont.resume(returning: ResponseBox(value: ["success": false, "error": "router not initialized — InterceptorAppIntents called outside the bridge"]))
                return
            }
            router.route(action: action) { resp in
                cont.resume(returning: ResponseBox(value: resp))
            }
        }
        return box.value
    }
}

// MARK: - AppEntity types

@available(macOS 13, *)
public struct InstalledAppEntity: AppEntity {
    public var id: String                                  // bundle identifier
    public var name: String

    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Installed App" }
    public var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
    nonisolated(unsafe) public static var defaultQuery = InstalledAppEntityQuery()
}

@available(macOS 13, *)
public struct InstalledAppEntityQuery: EntityQuery {
    public init() {}
    public func entities(for identifiers: [InstalledAppEntity.ID]) async throws -> [InstalledAppEntity] {
        let resp = await InterceptorIntentBridge.dispatch(["type": "macos_apps", "sub": "list"])
        guard let apps = resp["data"] as? [[String: Any]] else { return [] }
        return apps.compactMap { dict in
            guard let bid = dict["bundleId"] as? String, identifiers.contains(bid) else { return nil }
            return InstalledAppEntity(id: bid, name: (dict["name"] as? String) ?? bid)
        }
    }
    public func suggestedEntities() async throws -> [InstalledAppEntity] {
        let resp = await InterceptorIntentBridge.dispatch(["type": "macos_apps", "sub": "list"])
        guard let apps = resp["data"] as? [[String: Any]] else { return [] }
        return apps.prefix(20).compactMap { dict in
            guard let bid = dict["bundleId"] as? String else { return nil }
            return InstalledAppEntity(id: bid, name: (dict["name"] as? String) ?? bid)
        }
    }
}

@available(macOS 13, *)
public struct CalendarEntity: AppEntity {
    public var id: String
    public var title: String
    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Calendar" }
    public var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
    nonisolated(unsafe) public static var defaultQuery = CalendarEntityQuery()
}

@available(macOS 13, *)
public struct CalendarEntityQuery: EntityQuery {
    public init() {}
    public func entities(for identifiers: [CalendarEntity.ID]) async throws -> [CalendarEntity] {
        let resp = await InterceptorIntentBridge.dispatch(["type": "macos_calendar", "sub": "list"])
        guard let data = resp["data"] as? [String: Any], let cals = data["calendars"] as? [[String: Any]] else { return [] }
        return cals.compactMap {
            guard let id = $0["id"] as? String, identifiers.contains(id) else { return nil }
            return CalendarEntity(id: id, title: ($0["title"] as? String) ?? id)
        }
    }
    public func suggestedEntities() async throws -> [CalendarEntity] {
        let resp = await InterceptorIntentBridge.dispatch(["type": "macos_calendar", "sub": "list"])
        guard let data = resp["data"] as? [String: Any], let cals = data["calendars"] as? [[String: Any]] else { return [] }
        return cals.compactMap {
            guard let id = $0["id"] as? String else { return nil }
            return CalendarEntity(id: id, title: ($0["title"] as? String) ?? id)
        }
    }
}

@available(macOS 13, *)
public struct EventEntity: AppEntity {
    public var id: String
    public var title: String
    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Event" }
    public var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
    nonisolated(unsafe) public static var defaultQuery = EventEntityQuery()
}

@available(macOS 13, *)
public struct EventEntityQuery: EntityQuery {
    public init() {}
    public func entities(for identifiers: [EventEntity.ID]) async throws -> [EventEntity] {
        var out: [EventEntity] = []
        for id in identifiers {
            let resp = await InterceptorIntentBridge.dispatch(["type": "macos_calendar", "sub": "event", "id": id])
            if let data = resp["data"] as? [String: Any], let title = data["title"] as? String {
                out.append(EventEntity(id: id, title: title))
            }
        }
        return out
    }
    public func suggestedEntities() async throws -> [EventEntity] { [] }
}

@available(macOS 13, *)
public struct ReminderListEntity: AppEntity {
    public var id: String
    public var title: String
    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Reminder List" }
    public var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
    nonisolated(unsafe) public static var defaultQuery = ReminderListEntityQuery()
}

@available(macOS 13, *)
public struct ReminderListEntityQuery: EntityQuery {
    public init() {}
    public func entities(for identifiers: [ReminderListEntity.ID]) async throws -> [ReminderListEntity] {
        let resp = await InterceptorIntentBridge.dispatch(["type": "macos_reminders", "sub": "lists"])
        guard let data = resp["data"] as? [String: Any], let lists = data["lists"] as? [[String: Any]] else { return [] }
        return lists.compactMap {
            guard let id = $0["id"] as? String, identifiers.contains(id) else { return nil }
            return ReminderListEntity(id: id, title: ($0["title"] as? String) ?? id)
        }
    }
    public func suggestedEntities() async throws -> [ReminderListEntity] {
        let resp = await InterceptorIntentBridge.dispatch(["type": "macos_reminders", "sub": "lists"])
        guard let data = resp["data"] as? [String: Any], let lists = data["lists"] as? [[String: Any]] else { return [] }
        return lists.compactMap {
            guard let id = $0["id"] as? String else { return nil }
            return ReminderListEntity(id: id, title: ($0["title"] as? String) ?? id)
        }
    }
}

@available(macOS 13, *)
public struct ReminderEntity: AppEntity {
    public var id: String
    public var title: String
    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Reminder" }
    public var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
    nonisolated(unsafe) public static var defaultQuery = ReminderEntityQuery()
}
@available(macOS 13, *)
public struct ReminderEntityQuery: EntityQuery {
    public init() {}
    public func entities(for identifiers: [ReminderEntity.ID]) async throws -> [ReminderEntity] {
        identifiers.map { ReminderEntity(id: $0, title: $0) }
    }
    public func suggestedEntities() async throws -> [ReminderEntity] { [] }
}

@available(macOS 13, *)
public struct ContactEntity: AppEntity {
    public var id: String
    public var displayName: String
    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Contact" }
    public var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(displayName)") }
    nonisolated(unsafe) public static var defaultQuery = ContactEntityQuery()
}
@available(macOS 13, *)
public struct ContactEntityQuery: EntityQuery {
    public init() {}
    public func entities(for identifiers: [ContactEntity.ID]) async throws -> [ContactEntity] {
        var out: [ContactEntity] = []
        for id in identifiers {
            let resp = await InterceptorIntentBridge.dispatch(["type": "macos_contacts", "sub": "contact", "id": id])
            if let data = resp["data"] as? [String: Any] {
                let name = "\((data["givenName"] as? String) ?? "") \((data["familyName"] as? String) ?? "")".trimmingCharacters(in: .whitespaces)
                out.append(ContactEntity(id: id, displayName: name.isEmpty ? id : name))
            }
        }
        return out
    }
    public func suggestedEntities() async throws -> [ContactEntity] { [] }
}

@available(macOS 13, *)
public struct PHAssetEntity: AppEntity {
    public var id: String
    public var summary: String
    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Photo" }
    public var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(summary)") }
    nonisolated(unsafe) public static var defaultQuery = PHAssetEntityQuery()
}
@available(macOS 13, *)
public struct PHAssetEntityQuery: EntityQuery {
    public init() {}
    public func entities(for identifiers: [PHAssetEntity.ID]) async throws -> [PHAssetEntity] {
        identifiers.map { PHAssetEntity(id: $0, summary: $0) }
    }
    public func suggestedEntities() async throws -> [PHAssetEntity] { [] }
}

@available(macOS 13, *)
public struct SongEntity: AppEntity {
    public var id: String
    public var title: String
    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Song" }
    public var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
    nonisolated(unsafe) public static var defaultQuery = SongEntityQuery()
}
@available(macOS 13, *)
public struct SongEntityQuery: EntityQuery {
    public init() {}
    public func entities(for identifiers: [SongEntity.ID]) async throws -> [SongEntity] {
        var out: [SongEntity] = []
        for id in identifiers {
            let resp = await InterceptorIntentBridge.dispatch(["type": "macos_music", "sub": "song", "id": id])
            if let data = resp["data"] as? [String: Any], let title = data["title"] as? String {
                out.append(SongEntity(id: id, title: title))
            }
        }
        return out
    }
    public func suggestedEntities() async throws -> [SongEntity] { [] }
}

@available(macOS 13, *)
public struct LocaleEntity: AppEntity {
    public var id: String
    public var name: String
    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Locale" }
    public var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
    nonisolated(unsafe) public static var defaultQuery = LocaleEntityQuery()
}
@available(macOS 13, *)
public struct LocaleEntityQuery: EntityQuery {
    public init() {}
    public func entities(for identifiers: [LocaleEntity.ID]) async throws -> [LocaleEntity] {
        identifiers.map { LocaleEntity(id: $0, name: Locale(identifier: $0).localizedString(forIdentifier: $0) ?? $0) }
    }
    public func suggestedEntities() async throws -> [LocaleEntity] {
        Locale.availableIdentifiers.prefix(20).map { LocaleEntity(id: $0, name: Locale(identifier: $0).localizedString(forIdentifier: $0) ?? $0) }
    }
}

// MARK: - AppIntent types (23 intents)

@available(macOS 13, *)
public struct ActivateAppIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Activate App"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Brings the chosen application to the foreground.", categoryName: "System")
    @Parameter(title: "App") public var app: InstalledAppEntity
    public init() {}
    public func perform() async throws -> some IntentResult {
        let r = await InterceptorIntentBridge.dispatch(["type": "macos_app", "sub": "activate", "bundle": app.id])
        return .result(value: (r["success"] as? Bool) == true)
    }
}

@available(macOS 13, *)
public struct ScreenshotAppIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Screenshot App"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Captures the current window of the chosen application.", categoryName: "System")
    @Parameter(title: "App") public var app: InstalledAppEntity
    @Parameter(title: "Save to disk") public var save: Bool
    public init() {}
    public func perform() async throws -> some IntentResult {
        let r = await InterceptorIntentBridge.dispatch([
            "type": "macos_screenshot", "sub": "screenshot", "app": app.name, "save": save,
        ])
        if let data = r["data"] as? [String: Any], let path = data["filePath"] as? String {
            return .result(value: path)
        }
        return .result(value: "ok")
    }
}

@available(macOS 13, *)
public struct ScreenshotDisplayIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Screenshot Display"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Captures the entire display.", categoryName: "System")
    @Parameter(title: "Display ID") public var displayId: Int?
    public init() {}
    public func perform() async throws -> some IntentResult {
        var action: [String: Any] = ["type": "macos_screenshot", "sub": "screenshot"]
        if let id = displayId { action["display_id"] = id }
        _ = await InterceptorIntentBridge.dispatch(action)
        return .result(value: true)
    }
}

@available(macOS 13, *)
public struct ReadAppTreeIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Read App Accessibility Tree"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Returns the accessibility tree for the chosen application.", categoryName: "Accessibility")
    @Parameter(title: "App") public var app: InstalledAppEntity
    @Parameter(title: "Depth") public var depth: Int?
    public init() {}
    public func perform() async throws -> some IntentResult {
        var action: [String: Any] = ["type": "macos_tree", "sub": "tree", "app": app.name]
        if let d = depth { action["depth"] = d }
        _ = await InterceptorIntentBridge.dispatch(action)
        return .result(value: true)
    }
}

@available(macOS 13, *)
public struct ClipboardReadIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Read Clipboard"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Returns the current clipboard text.", categoryName: "System")
    public init() {}
    public func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let r = await InterceptorIntentBridge.dispatch(["type": "macos_clipboard", "sub": "read"])
        let value = (r["data"] as? String) ?? ""
        return .result(value: value)
    }
}

@available(macOS 13, *)
public struct ClipboardWriteIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Write Clipboard"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Writes the supplied text to the clipboard.", categoryName: "System")
    @Parameter(title: "Text") public var text: String
    public init() {}
    public func perform() async throws -> some IntentResult {
        _ = await InterceptorIntentBridge.dispatch(["type": "macos_clipboard", "sub": "write", "text": text])
        return .result(value: true)
    }
}

@available(macOS 13, *)
public struct DispatchAppleScriptIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Run AppleScript"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Dispatches an AppleScript snippet to the named bundle via Apple Events.", categoryName: "System")
    @Parameter(title: "Bundle Identifier") public var bundle: String
    @Parameter(title: "AppleScript") public var script: String
    public init() {}
    public func perform() async throws -> some IntentResult {
        _ = await InterceptorIntentBridge.dispatch(["type": "macos_intent", "sub": "dispatch", "bundle": bundle, "script": script])
        return .result(value: true)
    }
}

@available(macOS 13, *)
public struct OCRAppIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Read Text from App"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("OCRs the chosen application's window with Vision.", categoryName: "Vision")
    @Parameter(title: "App") public var app: InstalledAppEntity
    public init() {}
    public func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let r = await InterceptorIntentBridge.dispatch(["type": "macos_vision", "sub": "text", "app": app.name])
        let text = ((r["data"] as? [String: Any])?["text"] as? String) ?? ""
        return .result(value: text)
    }
}

@available(macOS 13, *)
public struct ExtractEntitiesIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Extract Entities"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Returns named entities from the supplied text via NaturalLanguage.", categoryName: "Language")
    @Parameter(title: "Text") public var text: String
    public init() {}
    public func perform() async throws -> some IntentResult {
        _ = await InterceptorIntentBridge.dispatch(["type": "macos_nlp", "sub": "entities", "text": text])
        return .result(value: true)
    }
}

@available(macOS 13, *)
public struct AppleIntelligencePromptIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Ask Apple Intelligence"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Sends a one-shot prompt to the on-device Apple Intelligence model.", categoryName: "AI")
    @Parameter(title: "Prompt") public var prompt: String
    public init() {}
    public func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let r = await InterceptorIntentBridge.dispatch(["type": "macos_ai", "sub": "prompt", "prompt": prompt])
        let response = ((r["data"] as? [String: Any])?["response"] as? String) ?? ""
        return .result(value: response)
    }
}

@available(macOS 13, *)
public struct StartTranscriptionIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Start Transcription"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Begins live speech-to-text via the Speech framework.", categoryName: "Speech")
    public init() {}
    public func perform() async throws -> some IntentResult {
        _ = await InterceptorIntentBridge.dispatch(["type": "macos_listen", "sub": "start"])
        return .result(value: true)
    }
}

@available(macOS 13, *)
public struct StopTranscriptionIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Stop Transcription"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Ends a running transcription and returns the captured text.", categoryName: "Speech")
    public init() {}
    public func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let r = await InterceptorIntentBridge.dispatch(["type": "macos_listen", "sub": "stop"])
        let transcript = ((r["data"] as? [String: Any])?["transcript"] as? String) ?? ""
        return .result(value: transcript)
    }
}

@available(macOS 13, *)
public struct ReadPdfIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Read PDF"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Extracts text from a PDF file.", categoryName: "Documents")
    @Parameter(title: "File") public var file: IntentFile
    public init() {}
    public func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let path = file.fileURL?.path ?? ""
        let r = await InterceptorIntentBridge.dispatch(["type": "macos_pdf", "sub": "text", "path": path])
        let text = ((r["data"] as? [String: Any])?["text"] as? String) ?? ""
        return .result(value: text)
    }
}

@available(macOS 13, *)
public struct CreateCalendarEventIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Create Calendar Event"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Adds an event to the chosen calendar.", categoryName: "Calendar")
    @Parameter(title: "Title") public var title: String
    @Parameter(title: "Start Date") public var startDate: Date
    @Parameter(title: "End Date") public var endDate: Date
    @Parameter(title: "Calendar") public var calendar: CalendarEntity?
    public init() {}
    public func perform() async throws -> some IntentResult {
        let f = ISO8601DateFormatter()
        var action: [String: Any] = [
            "type": "macos_calendar", "sub": "create",
            "title": title, "start": f.string(from: startDate), "end": f.string(from: endDate),
        ]
        if let cal = calendar { action["calendar"] = cal.id }
        _ = await InterceptorIntentBridge.dispatch(action)
        return .result(value: true)
    }
}

@available(macOS 13, *)
public struct CreateReminderIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Create Reminder"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Adds a reminder to the chosen list.", categoryName: "Reminders")
    @Parameter(title: "Title") public var title: String
    @Parameter(title: "Due Date") public var dueDate: Date?
    @Parameter(title: "List") public var list: ReminderListEntity?
    @Parameter(title: "Priority") public var priority: PriorityEnum?
    public init() {}
    public func perform() async throws -> some IntentResult {
        var action: [String: Any] = ["type": "macos_reminders", "sub": "create", "title": title]
        if let l = list { action["list"] = l.id }
        if let p = priority { action["priority"] = p.rawValue }
        if let d = dueDate { action["due"] = ISO8601DateFormatter().string(from: d) }
        _ = await InterceptorIntentBridge.dispatch(action)
        return .result(value: true)
    }
}

@available(macOS 13, *)
public struct AirDropFileIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "AirDrop File"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Sends the supplied file via AirDrop.", categoryName: "Sharing")
    @Parameter(title: "File") public var file: IntentFile
    public init() {}
    public func perform() async throws -> some IntentResult {
        let path = file.fileURL?.path ?? ""
        _ = await InterceptorIntentBridge.dispatch(["type": "macos_share", "sub": "airdrop", "items": [path]])
        return .result(value: true)
    }
}

@available(macOS 13, *)
public struct PostNotificationIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Post Notification"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Posts a banner notification.", categoryName: "System")
    @Parameter(title: "Title") public var title: String
    @Parameter(title: "Body") public var body: String
    @Parameter(title: "Play Sound") public var sound: Bool?
    public init() {}
    public func perform() async throws -> some IntentResult {
        var action: [String: Any] = ["type": "macos_notifications", "sub": "post", "title": title, "body": body]
        if (sound ?? false) { action["sound"] = "default" }
        _ = await InterceptorIntentBridge.dispatch(action)
        return .result(value: true)
    }
}

@available(macOS 13, *)
public struct BiometricConfirmIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Confirm with Touch ID"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Requires biometric confirmation before continuing.", categoryName: "Security")
    @Parameter(title: "Reason") public var reason: String
    public init() {}
    public func perform() async throws -> some IntentResult & ReturnsValue<Bool> {
        let r = await InterceptorIntentBridge.dispatch(["type": "macos_auth", "sub": "confirm", "reason": reason])
        let ok = ((r["data"] as? [String: Any])?["ok"] as? Bool) ?? false
        return .result(value: ok)
    }
}

@available(macOS 13, *)
public struct TranslateTextIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Translate Text"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Translates the supplied text via the on-device Translation framework.", categoryName: "Language")
    @Parameter(title: "Text") public var text: String
    @Parameter(title: "From") public var from: LocaleEntity?
    @Parameter(title: "To") public var to: LocaleEntity
    public init() {}
    public func perform() async throws -> some IntentResult & ReturnsValue<String> {
        var action: [String: Any] = ["type": "macos_translate", "sub": "text", "input": text, "to": to.id]
        if let f = from { action["from"] = f.id }
        let r = await InterceptorIntentBridge.dispatch(action)
        let translated = ((r["data"] as? [String: Any])?["targetText"] as? String) ?? ""
        return .result(value: translated)
    }
}

@available(macOS 13, *)
public struct ExportPhotoIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Export Photo"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Exports the chosen photo to a file path.", categoryName: "Photos")
    @Parameter(title: "Photo") public var photo: PHAssetEntity
    public init() {}
    public func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let outPath = "\(NSTemporaryDirectory())interceptor-export-\(UUID().uuidString).jpg"
        let r = await InterceptorIntentBridge.dispatch(["type": "macos_photos", "sub": "export", "id": photo.id, "out": outPath])
        let path = ((r["data"] as? [String: Any])?["filePath"] as? String) ?? outPath
        return .result(value: path)
    }
}

@available(macOS 13, *)
public struct SearchMapsIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Find Places"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Searches MapKit for the supplied query.", categoryName: "Maps")
    @Parameter(title: "Query") public var query: String
    public init() {}
    public func perform() async throws -> some IntentResult {
        _ = await InterceptorIntentBridge.dispatch(["type": "macos_maps", "sub": "search", "query": query])
        return .result(value: true)
    }
}

@available(macOS 13, *)
public struct GetCurrentLocationIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Get Current Location"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Returns the device's current latitude/longitude.", categoryName: "Location")
    public init() {}
    public func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let r = await InterceptorIntentBridge.dispatch(["type": "macos_location", "sub": "current"])
        if let data = r["data"] as? [String: Any], let coord = data["coordinate"] as? [Double] {
            return .result(value: "\(coord[0]), \(coord[1])")
        }
        return .result(value: "unavailable")
    }
}

@available(macOS 13, *)
public struct PlaySongIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Play Song"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Plays a song via ApplicationMusicPlayer.", categoryName: "Music")
    @Parameter(title: "Song") public var song: SongEntity
    public init() {}
    public func perform() async throws -> some IntentResult {
        _ = await InterceptorIntentBridge.dispatch(["type": "macos_music", "sub": "play", "song": song.id])
        return .result(value: true)
    }
}

@available(macOS 13, *)
public struct GenerateThumbnailIntent: AppIntent {
    nonisolated(unsafe) public static var title: LocalizedStringResource = "Generate Thumbnail"
    nonisolated(unsafe) public static var description: IntentDescription = IntentDescription("Generates a Quick Look thumbnail for the file.", categoryName: "Documents")
    @Parameter(title: "File") public var file: IntentFile
    @Parameter(title: "Size") public var size: Int?
    public init() {}
    public func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let path = file.fileURL?.path ?? ""
        var action: [String: Any] = ["type": "macos_thumbnail", "sub": "generate", "path": path, "save": true]
        if let s = size { action["size"] = "\(s)" }
        let r = await InterceptorIntentBridge.dispatch(action)
        let p = ((r["data"] as? [String: Any])?["filePath"] as? String) ?? ""
        return .result(value: p)
    }
}

// MARK: - AppShortcutsProvider

@available(macOS 13, *)
public struct InterceptorAppShortcuts: AppShortcutsProvider {
    public static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ScreenshotAppIntent(),
                    phrases: ["Screenshot \(.applicationName)", "Take a screenshot of \(.applicationName)"],
                    shortTitle: "Screenshot App",
                    systemImageName: "camera.viewfinder")
        AppShortcut(intent: ClipboardReadIntent(),
                    phrases: ["Read clipboard with \(.applicationName)"],
                    shortTitle: "Read Clipboard",
                    systemImageName: "doc.on.clipboard")
        AppShortcut(intent: SearchMapsIntent(),
                    phrases: ["Find places with \(.applicationName)"],
                    shortTitle: "Find Places",
                    systemImageName: "map")
        AppShortcut(intent: CreateCalendarEventIntent(),
                    phrases: ["Add to calendar with \(.applicationName)"],
                    shortTitle: "New Event",
                    systemImageName: "calendar.badge.plus")
        AppShortcut(intent: CreateReminderIntent(),
                    phrases: ["Remind me with \(.applicationName)"],
                    shortTitle: "New Reminder",
                    systemImageName: "list.bullet.clipboard")
        AppShortcut(intent: TranslateTextIntent(),
                    phrases: ["Translate with \(.applicationName)"],
                    shortTitle: "Translate",
                    systemImageName: "character.bubble")
        AppShortcut(intent: BiometricConfirmIntent(),
                    phrases: ["Confirm with \(.applicationName)"],
                    shortTitle: "Touch ID Confirm",
                    systemImageName: "touchid")
        AppShortcut(intent: AirDropFileIntent(),
                    phrases: ["AirDrop with \(.applicationName)"],
                    shortTitle: "AirDrop",
                    systemImageName: "airplayaudio")
        AppShortcut(intent: PostNotificationIntent(),
                    phrases: ["Notify with \(.applicationName)"],
                    shortTitle: "Notify",
                    systemImageName: "bell.badge")
        AppShortcut(intent: ReadPdfIntent(),
                    phrases: ["Read PDF with \(.applicationName)"],
                    shortTitle: "Read PDF",
                    systemImageName: "doc.text")
        AppShortcut(intent: GetCurrentLocationIntent(),
                    phrases: ["Where am I with \(.applicationName)"],
                    shortTitle: "Current Location",
                    systemImageName: "location")
    }
}

#endif // canImport(AppIntents)

// Global router reference used by intent perform() methods to dispatch into
// the running bridge. main.swift sets this at boot.
final class GlobalRouterRef: @unchecked Sendable {
    nonisolated(unsafe) static var shared: Router?
}
