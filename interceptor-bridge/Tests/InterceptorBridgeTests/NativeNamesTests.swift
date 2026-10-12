import XCTest
import EventKit
import Contacts
import Photos
import CoreLocation
import MapKit
import UserNotifications
import PDFKit
@testable import interceptor_bridge

// Each table entry must match the SDK's enum case, not a remembered raw value.
final class NativeNamesTests: XCTestCase {
    private func check<E: RawRepresentable>(_ cases: [(E, String)], _ table: [Int: String], file: StaticString = #filePath, line: UInt = #line) where E.RawValue: BinaryInteger {
        for (value, name) in cases { XCTAssertEqual(NativeNames.name(Int(value.rawValue), table), name, file: file, line: line) }
    }

    func testTablesMatchSdkCases() {
        check([(EKCalendarType.local, "local"), (.calDAV, "calDAV"), (.exchange, "exchange"), (.subscription, "subscription"), (.birthday, "birthday")], NativeNames.calendarType)
        check([(EKSourceType.local, "local"), (.exchange, "exchange"), (.calDAV, "calDAV"), (.mobileMe, "mobileMe"), (.subscribed, "subscribed"), (.birthdays, "birthdays")], NativeNames.sourceType)
        check([(EKEventStatus.none, "none"), (.confirmed, "confirmed"), (.tentative, "tentative"), (.canceled, "cancelled")], NativeNames.eventStatus)
        check([(EKEventAvailability.notSupported, "unknown"), (.busy, "busy"), (.free, "free"), (.tentative, "tentative"), (.unavailable, "unavailable")], NativeNames.eventAvailability)
        check([(EKParticipantRole.unknown, "unknown"), (.required, "required"), (.optional, "optional"), (.chair, "chair"), (.nonParticipant, "nonParticipant")], NativeNames.participantRole)
        check([(EKParticipantStatus.unknown, "unknown"), (.pending, "pending"), (.accepted, "accepted"), (.declined, "declined"), (.tentative, "tentative"), (.delegated, "delegated"), (.completed, "completed"), (.inProcess, "inProcess")], NativeNames.participantStatus)
        check([(EKParticipantType.unknown, "unknown"), (.person, "person"), (.room, "room"), (.resource, "resource"), (.group, "group")], NativeNames.participantType)
        check([(EKAlarmType.display, "display"), (.audio, "audio"), (.procedure, "procedure"), (.email, "email")], NativeNames.alarmType)
        check([(EKRecurrenceFrequency.daily, "daily"), (.weekly, "weekly"), (.monthly, "monthly"), (.yearly, "yearly")], NativeNames.recurrenceFrequency)
        check([(CNContainerType.unassigned, "unassigned"), (.local, "local"), (.exchange, "exchange"), (.cardDAV, "cardDAV")], NativeNames.containerType)
        check([(PHAssetCollectionType.album, "album"), (.smartAlbum, "smart")], NativeNames.collectionType)
        check([(PHAssetCollectionSubtype.albumRegular, "regular"), (.albumCloudShared, "cloudShared"), (.smartAlbumFavorites, "favorites"), (.smartAlbumAllHidden, "hidden"), (.smartAlbumVideos, "videos"), (.smartAlbumScreenshots, "screenshots"), (.smartAlbumSpatial, "spatial")], NativeNames.collectionSubtype)
        check([(PHAsset.PlaybackStyle.unsupported, "unsupported"), (.image, "image"), (.imageAnimated, "imageAnimated"), (.livePhoto, "livePhoto"), (.video, "video"), (.videoLooping, "videoLooping")], NativeNames.playbackStyle)
        check([(PHAssetSourceType.typeUserLibrary, "userLibrary"), (.typeCloudShared, "cloudShared"), (.typeiTunesSynced, "iTunesSynced")], NativeNames.assetSource)
        check([(CLAccuracyAuthorization.fullAccuracy, "full"), (.reducedAccuracy, "reduced")], NativeNames.accuracy)
        check([(MKDirectionsTransportType.automobile, "auto"), (.walking, "walking"), (.transit, "transit"), (.cycling, "cycling"), (.any, "any")], NativeNames.transport)
        check([(UNAlertStyle.none, "none"), (.banner, "banner"), (.alert, "alert")], NativeNames.alertStyle)
        check([(UNShowPreviewsSetting.always, "always"), (.whenAuthenticated, "whenAuthenticated"), (.never, "never")], NativeNames.previews)
        check([(UNNotificationInterruptionLevel.passive, "passive"), (.active, "active"), (.timeSensitive, "timeSensitive"), (.critical, "critical")], NativeNames.interruption)
        check([(PDFMarkupType.highlight, "highlight"), (.strikeOut, "strikeOut"), (.underline, "underline"), (.redact, "redact")], NativeNames.markup)
        XCTAssertEqual(NativeNames.name(1_000_000_218, NativeNames.collectionSubtype), "unknown")
    }
}

// Only a trailing "@<unix seconds>" names one occurrence; anything else is a plain id.
final class CalendarOccurrenceIdTests: XCTestCase {
    func testOccurrenceIdsSplitOnlyOnATrailingInstant() {
        for id in ["ABC:DEF@1904396400", "ABC:DEF@-60", "a@b@7"] { XCTAssertTrue(CalendarDomain.isOccurrenceId(id), id) }
        for id in ["ABC:DEF", "a@b", "x@", "@5", "x@05", "x@+5"] { XCTAssertFalse(CalendarDomain.isOccurrenceId(id), id) }
    }
}

// An all-day UTC-midnight date is that local day in EventKit and reads back unchanged.
final class CalendarAllDayTests: XCTestCase {
    func testAllDayDatesRoundTripThroughLocalDays() {
        let start = ISO8601DateFormatter().date(from: "2030-03-08T00:00:00Z")!, end = start.addingTimeInterval(86_400)
        let localStart = CalendarDomain.localDay(start, end: false)!, localEnd = CalendarDomain.localDay(end, end: true)!
        var gregorian = Calendar(identifier: .gregorian); gregorian.timeZone = .current
        XCTAssertEqual(gregorian.dateComponents([.year, .month, .day, .hour], from: localStart), DateComponents(year: 2030, month: 3, day: 8, hour: 0))
        XCTAssertEqual(gregorian.dateComponents([.year, .month, .day, .hour, .minute, .second], from: localEnd), DateComponents(year: 2030, month: 3, day: 8, hour: 23, minute: 59, second: 59))
        XCTAssertEqual(CalendarDomain.contractDay(localStart, end: false), start)
        XCTAssertEqual(CalendarDomain.contractDay(localEnd, end: true), end)
        XCTAssertNil(CalendarDomain.localDay(start.addingTimeInterval(3600), end: false))
    }
}

// An object made through perform(alloc)/perform(init) is freed once its last owner drops it.
private final class OwnershipProbe: NSObject { nonisolated(unsafe) static var freed = 0; deinit { OwnershipProbe.freed += 1 } }
final class DisplayOwnershipTests: XCTestCase {
    func testObjcInitResultIsReleasedWithItsLastOwner() {
        autoreleasepool { var object = DisplayDomain.objcInit(OwnershipProbe.self, "init"); XCTAssertNotNil(object); object = nil; _ = object }
        XCTAssertEqual(OwnershipProbe.freed, 1)
    }
}

final class CalendarDetachedIdentityTests: XCTestCase {
    func testDetachedOccurrenceMatchesItsSeries() {
        XCTAssertTrue(CalendarDomain.sameEvent("CAL:UUID/RID=925916400", "CAL:UUID"))
        XCTAssertTrue(CalendarDomain.sameEvent("CAL:UUID", "CAL:UUID"))
        XCTAssertFalse(CalendarDomain.sameEvent("CAL:UUID2", "CAL:UUID"))
    }
}
