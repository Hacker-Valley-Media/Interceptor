import Foundation

/// Short-lived ref ↔ object mapping so a `native_tree` walk can hand out stable
/// `n1`/`n2` handles that a later `native_mutate`/`native_eval` can address.
/// Refs are weak — like the browser surface's `eN` refs, they go stale when the
/// view is removed; re-run `native_tree` for fresh ones.
final class RefRegistry: @unchecked Sendable {
    private final class WeakBox { weak var obj: AnyObject?; init(_ o: AnyObject) { obj = o } }
    private var counter = 0
    private var map = [String: WeakBox]()
    private let lock = NSLock()

    func register(_ obj: AnyObject) -> String {
        lock.lock(); defer { lock.unlock() }
        counter += 1
        let ref = "n\(counter)"
        map[ref] = WeakBox(obj)
        return ref
    }

    func resolve(_ ref: String) -> AnyObject? {
        lock.lock(); defer { lock.unlock() }
        return map[ref]?.obj
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        map.removeAll()
    }
}
