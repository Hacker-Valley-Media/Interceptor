import Foundation

// Pure decision behind MonitorDomain's live speech segmentation (issue #218),
// kept free of runtime state so the boundary rule is unit-testable.
enum SpeechUtteranceSegmenter {
    /// Inside the post-boundary grace window, decide whether `incoming` revises
    /// the pending utterance or begins the next one. A revision carries the
    /// pending text forward and may only change its last word (the recognizer
    /// finalizes trailing words behind the boundary signal); anything else is
    /// a new utterance and the caller must flush `pending` first.
    ///
    /// Word-boundary prefix, not character prefix: a pending "I need" must not
    /// swallow an incoming "It works". ponytail: a next utterance that repeats
    /// the whole pending stem inside the grace window (pending "Thank you",
    /// incoming "Thank goodness") still reads as a revision; narrowing that
    /// needs timing data this decision does not have.
    static func isRevision(of pending: String, incoming: String) -> Bool {
        let words = pending.split(separator: " ")
        guard !words.isEmpty else { return true }
        let stem = words.count > 1 ? words.dropLast().joined(separator: " ") : String(words[0])
        return incoming == stem || incoming.hasPrefix(stem + " ")
    }
}
