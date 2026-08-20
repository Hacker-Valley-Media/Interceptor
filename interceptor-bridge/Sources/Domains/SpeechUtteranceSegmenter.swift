import Foundation

// Pure decision behind MonitorDomain's live speech segmentation (issue #218),
// kept free of runtime state so the boundary rule is unit-testable.
enum SpeechUtteranceSegmenter {
    /// Inside the post-boundary grace window, decide whether `incoming` revises
    /// the pending utterance or begins the next one (the caller must flush
    /// `pending` first, never overwrite it).
    ///
    /// A revision never loses words — behind the boundary signal the recognizer
    /// only finalizes or extends the tail — so `incoming` must be at least as
    /// long, keep every pending word but the last verbatim, and put a revision
    /// of that last word in its slot ("tonigh" → "tonight", "dog" → "dog.",
    /// "tonite" → "tonight"). Anything else is the next utterance, including a
    /// result that merely repeats the stem: "Thank you" → "Thank goodness" and
    /// "I need help" → "I found it" both flush first, and a next utterance's
    /// usual one-word first partial is shorter than any pending text.
    ///
    /// ponytail: a single-word pending followed inside the window by an
    /// utterance whose first word extends it ("Yes" → "Yesterday was fine")
    /// still reads as a revision; splitting that needs recognition timing, and
    /// the silence/restart flushes bound the damage to one merged segment.
    static func isRevision(of pending: String, incoming: String) -> Bool {
        let pWords = pending.split(separator: " ")
        guard let pLast = pWords.last else { return true }
        let iWords = incoming.split(separator: " ")
        guard iWords.count >= pWords.count else { return false }
        let stemCount = pWords.count - 1
        guard Array(iWords.prefix(stemCount)) == Array(pWords.prefix(stemCount)) else { return false }
        return related(String(pLast), String(iWords[stemCount]))
    }

    // The word standing where the pending last word stood must be a revision of
    // it: one a prefix of the other, or a shared stem of at least two letters,
    // compared case- and punctuation-insensitively. "you" vs "goodness" shares
    // nothing and is a new utterance.
    private static func related(_ a: String, _ b: String) -> Bool {
        let x = a.lowercased().trimmingCharacters(in: .punctuationCharacters)
        let y = b.lowercased().trimmingCharacters(in: .punctuationCharacters)
        if x.isEmpty || y.isEmpty { return true }
        if x.hasPrefix(y) || y.hasPrefix(x) { return true }
        return zip(x, y).prefix(while: { $0.0 == $0.1 }).count >= 2
    }
}
