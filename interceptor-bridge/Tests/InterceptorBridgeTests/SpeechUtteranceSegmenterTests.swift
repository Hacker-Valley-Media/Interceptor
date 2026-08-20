import XCTest
@testable import interceptor_bridge

// Issue #218: inside the post-boundary grace window a partial either revises
// the pending utterance (tail words finalize behind the boundary signal) or
// begins the next one, which must flush the pending text first and never
// overwrite it. Pins the word-boundary stem rule.
final class SpeechUtteranceSegmenterTests: XCTestCase {
    func testTrailingWordRevisionStaysPending() {
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "over the lazy dog tonigh", incoming: "over the lazy dog tonight"))
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "over the lazy dog", incoming: "over the lazy dog tonight"))
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "over the lazy dog", incoming: "over the lazy dog."))
    }

    func testNextUtteranceWithTheSameFirstWordIsNotARevision() {
        XCTAssertFalse(SpeechUtteranceSegmenter.isRevision(of: "I need help", incoming: "I found it"))
        XCTAssertFalse(SpeechUtteranceSegmenter.isRevision(of: "I need help", incoming: "I"))
    }

    func testWordBoundaryNotCharacterPrefix() {
        XCTAssertFalse(SpeechUtteranceSegmenter.isRevision(of: "I need", incoming: "It works"))
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "I need", incoming: "I"))
    }

    func testSingleWordPendingUsesTheWholeWordAsStem() {
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "Yes", incoming: "Yes please"))
        XCTAssertFalse(SpeechUtteranceSegmenter.isRevision(of: "Yes", incoming: "Okay"))
    }

    func testEmptyPendingAcceptsAnything() {
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "", incoming: "Hello"))
    }
}
