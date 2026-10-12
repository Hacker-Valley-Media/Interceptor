// Shared Sendable result holder for the new domain tests.
// Swift 6 strict concurrency rejects capturing `var` of a non-Sendable type
// across `@Sendable` closures, so test bodies wrap their result in this class.

import Foundation

final class TestResultHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: Any] = [:]
    var value: [String: Any] {
        lock.lock(); defer { lock.unlock() }; return stored
    }
    func set(_ v: [String: Any]) {
        lock.lock(); stored = v; lock.unlock()
    }
}
