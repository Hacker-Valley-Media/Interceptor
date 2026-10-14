import XCTest
import Foundation
@testable import InterceptorD

final class GuestCaptureOwnershipTests: XCTestCase {
    func testLateNativeCompletionCannotPublishARecordAfterResponseRetirement() {
        let box = GuestCapture.ResultBox()
        XCTAssertNil(box.take(timedOut: true).0)
        let record = GuestCapture.Snapshot(id: UUID().uuidString, png: Data([1, 2, 3]), width: 1, height: 1, sha256: "unit fixture")
        var retained: GuestCapture.Snapshot?
        box.finish(record, error: nil) { retained = $0 }
        XCTAssertNil(retained)
        XCTAssertNil(box.take(timedOut: false).0)
    }
    func testRetirementRacingAnAlreadyCompletedRecordKeepsItsExactDiscardIdentity() {
        let box = GuestCapture.ResultBox(), id = UUID().uuidString
        let record = GuestCapture.Snapshot(id: id, png: Data([4, 5, 6]), width: 1, height: 1, sha256: "unit fixture")
        var retained: GuestCapture.Snapshot?
        box.finish(record, error: nil) { retained = $0 }
        let raced = box.take(timedOut: true)
        XCTAssertEqual(retained?.id, id)
        XCTAssertEqual(raced.0?.id, id)
        XCTAssertNotNil(raced.1)
    }
}
