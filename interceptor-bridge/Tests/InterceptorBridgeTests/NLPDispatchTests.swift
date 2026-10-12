import XCTest
@testable import interceptor_bridge

// Regression: NLPDomain.handle previously switched on
// `command` (which the router passes as the literal "nlp" for two-segment
// action types) instead of action["sub"], so every NLP call fell through
// to `notImplemented` despite a fully-implemented NaturalLanguage backend.
// These tests pin the dispatch contract — they assert the verb reaches
// its handler, not the per-handler output (the NaturalLanguage framework
// itself is Apple-tested).

private final class NLPResultHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: Any] = [:]
    var value: [String: Any] {
        lock.lock(); defer { lock.unlock() }; return stored
    }
    func set(_ v: [String: Any]) { lock.lock(); stored = v; lock.unlock() }
}

final class NLPDispatchTests: XCTestCase {
    private func dispatch(sub: String, extra: [String: Any] = [:]) -> [String: Any] {
        let domain = NLPDomain()
        var action: [String: Any] = ["type": "macos_nlp", "sub": sub]
        for (k, v) in extra { action[k] = v }
        let holder = NLPResultHolder()
        let exp = expectation(description: "nlp dispatch \(sub)")
        // Match how Router.swift calls handle: command is the domain prefix
        // ("nlp") for two-segment types, and the verb is in action["sub"].
        domain.handle("nlp", action: action) { r in
            holder.set(r)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5.0)
        return holder.value
    }

    private func errorMessage(_ result: [String: Any]) -> String? {
        result["error"] as? String
    }

    private func isNotImplemented(_ result: [String: Any]) -> Bool {
        let err = errorMessage(result) ?? ""
        return err.contains("not yet implemented") || err.contains("not implemented")
    }

    private func isMissingTextError(_ result: [String: Any]) -> Bool {
        let err = errorMessage(result) ?? ""
        return err.contains("requires a text string")
    }

    // Each verb without `text` falls through to its handler, which then
    // returns the per-handler "requires a text string" error — proving the
    // dispatch reached the right branch (NOT the not-implemented sentinel).

    func testEntitiesIsRoutedFromSub() {
        let r = dispatch(sub: "entities")
        XCTAssertFalse(isNotImplemented(r), "entities sub must reach the entities handler")
        XCTAssertTrue(isMissingTextError(r), "entities handler must surface the text-required error when no text given")
    }

    func testLanguageIsRoutedFromSub() {
        let r = dispatch(sub: "language")
        XCTAssertFalse(isNotImplemented(r), "language sub must reach the language handler")
        XCTAssertTrue(isMissingTextError(r))
    }

    func testSentimentIsRoutedFromSub() {
        let r = dispatch(sub: "sentiment")
        XCTAssertFalse(isNotImplemented(r), "sentiment sub must reach the sentiment handler")
        XCTAssertTrue(isMissingTextError(r))
    }

    func testTokensIsRoutedFromSub() {
        let r = dispatch(sub: "tokens")
        XCTAssertFalse(isNotImplemented(r), "tokens sub must reach the tokens handler")
        XCTAssertTrue(isMissingTextError(r))
    }

    func testSimilarIsRoutedFromSub() {
        let r = dispatch(sub: "similar")
        XCTAssertFalse(isNotImplemented(r), "similar sub must reach the similar handler")
        // similar requires word1 + word2 — its missing-args error is different
        let err = errorMessage(r) ?? ""
        XCTAssertTrue(err.contains("similar requires word1 and word2"))
    }

    func testEmbedIsRoutedFromSub() {
        let r = dispatch(sub: "embed")
        XCTAssertFalse(isNotImplemented(r), "embed sub must reach the embed handler")
        XCTAssertTrue(isMissingTextError(r))
    }

    // End-to-end happy path: passing real text proves the handler is wired
    // to NaturalLanguage and returns a structured result. We don't check the
    // exact entity list — that's NLTagger's contract — only that we got a
    // non-error response with the expected key shape.

    func testEntitiesEndToEndProducesStructuredOutput() {
        let r = dispatch(sub: "entities", extra: ["text": "Apple is in Cupertino."])
        XCTAssertNil(errorMessage(r))
        XCTAssertNotNil(r["data"], "successful entities call returns a wrapped data array")
    }

    func testLanguageEndToEndIdentifiesEnglish() {
        let r = dispatch(sub: "language", extra: ["text": "The quick brown fox jumps over the lazy dog."])
        XCTAssertNil(errorMessage(r))
        let data = r["data"] as? [String: Any]
        XCTAssertEqual(data?["dominant"] as? String, "en")
    }

    func testTokensEndToEndProducesArray() {
        let r = dispatch(sub: "tokens", extra: ["text": "one two three"])
        XCTAssertNil(errorMessage(r))
        let tokens = r["data"] as? [String]
        XCTAssertEqual(tokens?.count, 3)
    }
}
