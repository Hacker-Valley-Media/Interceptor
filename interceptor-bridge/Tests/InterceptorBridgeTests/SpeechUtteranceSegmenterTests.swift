import XCTest
@testable import interceptor_bridge

// Issue #218: inside the post-boundary grace window a partial either revises
// the pending utterance (tail words finalize behind the boundary signal) or
// begins the next one, which must flush the pending text first and never
// overwrite it. Pins the boundary rule, including the review's adjacent
// same-first-word and same-stem sequences.
final class SpeechUtteranceSegmenterTests: XCTestCase {
    func testTailRevisionsStayPending() {
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "over the lazy dog tonigh", incoming: "over the lazy dog tonight"))
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "over the lazy dog", incoming: "over the lazy dog tonight"))
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "over the lazy dog", incoming: "over the lazy dog."))
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "over the lazy dog tonite", incoming: "over the lazy dog tonight"))
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "Thank you", incoming: "Thank you"))
    }

    func testNextUtteranceWithTheSameFirstWordFlushesFirst() {
        XCTAssertFalse(SpeechUtteranceSegmenter.isRevision(of: "I need help", incoming: "I found it"))
        XCTAssertFalse(SpeechUtteranceSegmenter.isRevision(of: "I need help", incoming: "I"))
    }

    func testNextUtteranceRepeatingTheStemFlushesFirst() {
        XCTAssertFalse(SpeechUtteranceSegmenter.isRevision(of: "Thank you", incoming: "Thank goodness"))
        XCTAssertFalse(SpeechUtteranceSegmenter.isRevision(of: "Thank you", incoming: "Thank"))
    }

    func testWordBoundaryNotCharacterPrefix() {
        XCTAssertFalse(SpeechUtteranceSegmenter.isRevision(of: "I need", incoming: "It works"))
        // shrinking to the stem is a next utterance's first partial, not a revision
        XCTAssertFalse(SpeechUtteranceSegmenter.isRevision(of: "I need", incoming: "I"))
    }

    func testSingleWordPending() {
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "Yes", incoming: "Yes please"))
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "Yes", incoming: "Yes."))
        XCTAssertFalse(SpeechUtteranceSegmenter.isRevision(of: "Yes", incoming: "Okay"))
    }

    func testEmptyPendingAcceptsAnything() {
        XCTAssertTrue(SpeechUtteranceSegmenter.isRevision(of: "", incoming: "Hello"))
    }
}
