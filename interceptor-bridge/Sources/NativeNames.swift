import Foundation

// Readable names for Apple enum values in JSON replies, the words the Windows and Linux providers
// use where they report the same field. String(describing:) on an Objective-C enum prints
// "EKCalendarType(rawValue: 1)". Raw values come from the macOS 27 SDK headers;
// a value this table does not list reads "unknown".
enum NativeNames {
    static func name(_ raw: Int, _ names: [Int: String]) -> String { names[raw] ?? "unknown" }

    static let calendarType = [0: "local", 1: "calDAV", 2: "exchange", 3: "subscription", 4: "birthday"]
    static let sourceType = [0: "local", 1: "exchange", 2: "calDAV", 3: "mobileMe", 4: "subscribed", 5: "birthdays"]
    static let eventStatus = [0: "none", 1: "confirmed", 2: "tentative", 3: "cancelled"]
    static let eventAvailability = [-1: "unknown", 0: "busy", 1: "free", 2: "tentative", 3: "unavailable"]
    static let participantRole = [0: "unknown", 1: "required", 2: "optional", 3: "chair", 4: "nonParticipant"]
    static let participantStatus = [0: "unknown", 1: "pending", 2: "accepted", 3: "declined", 4: "tentative", 5: "delegated", 6: "completed", 7: "inProcess"]
    static let participantType = [0: "unknown", 1: "person", 2: "room", 3: "resource", 4: "group"]
    static let alarmType = [0: "display", 1: "audio", 2: "procedure", 3: "email"]
    static let recurrenceFrequency = [0: "daily", 1: "weekly", 2: "monthly", 3: "yearly"]
    static let containerType = [0: "unassigned", 1: "local", 2: "exchange", 3: "cardDAV"]
    static let collectionType = [1: "album", 2: "smart", 3: "moment"]
    static let collectionSubtype = [2: "regular", 3: "syncedEvent", 4: "syncedFaces", 5: "syncedAlbum", 6: "imported",
        100: "myPhotoStream", 101: "cloudShared", 200: "generic", 201: "panoramas", 202: "videos", 203: "favorites",
        204: "timelapses", 205: "hidden", 206: "recentlyAdded", 207: "bursts", 208: "slomoVideos", 209: "userLibrary",
        210: "selfPortraits", 211: "screenshots", 212: "depthEffect", 213: "livePhotos", 214: "animated",
        215: "longExposures", 216: "unableToUpload", 217: "raw", 218: "cinematic", 219: "spatial", 220: "screenRecordings"]
    static let playbackStyle = [0: "unsupported", 1: "image", 2: "imageAnimated", 3: "livePhoto", 4: "video", 5: "videoLooping"]
    static let assetSource = [0: "none", 1: "userLibrary", 2: "cloudShared", 4: "iTunesSynced"]
    static let accuracy = [0: "full", 1: "reduced"]
    // The CLI's own --transport words.
    static let transport = [1: "auto", 2: "walking", 4: "transit", 8: "cycling", 0x0FFFFFFF: "any"]
    static let alertStyle = [0: "none", 1: "banner", 2: "alert"]
    static let previews = [0: "always", 1: "whenAuthenticated", 2: "never"]
    static let interruption = [0: "passive", 1: "active", 2: "timeSensitive", 3: "critical"]
    static let markup = [0: "highlight", 1: "strikeOut", 2: "underline", 3: "redact"]
    static let sensitivityPolicy = [0: "disabled", 1: "simpleInterventions", 2: "descriptiveInterventions"]
}
