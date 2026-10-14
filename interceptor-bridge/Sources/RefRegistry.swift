import Foundation
import ApplicationServices

final class RefRegistry: @unchecked Sendable {
    static let shared = RefRegistry()

    struct Entry {
        let element: AXUIElement
        let pid: pid_t?
    }

    private let lock = NSLock()
    private var refs: [String: Entry] = [:]
    private var byHash: [CFHashCode: [String]] = [:]
    private var order: [String] = []
    private var counter: Int = 0
    // ponytail: FIFO bound; the oldest refs go first once an agent has read this many elements.
    static let limit = 50_000

    // Refs are unique for the bridge lifetime: `clear()` drops the entries so
    // an old ref fails as "not found", but never rewinds the counter. The
    // rewind reissued `e1` to a different app's element while an agent still
    // held the old `e1` (native-ref probe, reliability review 2026-09-10).
    func clear() {
        lock.lock()
        refs.removeAll(); byHash.removeAll(); order.removeAll()
        lock.unlock()
    }

    // A ref lives until its element is destroyed, not until the next tree/find read, and the
    // same element keeps the same ref across reads.
    func register(_ element: AXUIElement, pid: pid_t? = nil) -> String {
        lock.lock(); defer { lock.unlock() }
        let hash = CFHash(element)
        if let existing = byHash[hash]?.first(where: { refs[$0].map { CFEqual($0.element, element) && $0.pid == pid } ?? false }) { return existing }
        counter += 1
        let ref = "e\(counter)"
        refs[ref] = Entry(element: element, pid: pid)
        byHash[hash, default: []].append(ref)
        order.append(ref)
        if order.count > Self.limit {
            for old in order.prefix(Self.limit / 10) { drop(old) }
            order.removeFirst(Self.limit / 10)
        }
        return ref
    }

    /// Drops the refs of a destroyed element; other refs stay valid.
    func remove(_ element: AXUIElement) {
        lock.lock(); defer { lock.unlock() }
        for ref in byHash[CFHash(element)] ?? [] where refs[ref].map({ CFEqual($0.element, element) }) ?? false { drop(ref) }
    }

    private func drop(_ ref: String) {
        guard let entry = refs.removeValue(forKey: ref) else { return }
        let hash = CFHash(entry.element)
        byHash[hash]?.removeAll { $0 == ref }
        if byHash[hash]?.isEmpty == true { byHash[hash] = nil }
    }

    func resolve(_ ref: String) -> AXUIElement? {
        lock.lock()
        let element = refs[ref]?.element
        lock.unlock()
        return element
    }

    func resolveInfo(_ ref: String) -> Entry? {
        lock.lock()
        let entry = refs[ref]
        lock.unlock()
        return entry
    }

    func resolvePID(_ ref: String) -> pid_t? {
        lock.lock()
        let pid = refs[ref]?.pid
        lock.unlock()
        return pid
    }

    func currentCount() -> Int {
        lock.lock()
        let c = counter
        lock.unlock()
        return c
    }

    var count: Int {
        lock.lock()
        let c = refs.count
        lock.unlock()
        return c
    }
}
