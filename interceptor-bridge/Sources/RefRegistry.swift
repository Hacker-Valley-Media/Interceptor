import Foundation
import ApplicationServices

final class RefRegistry: @unchecked Sendable {
    static let shared = RefRegistry()

    private let lock = NSLock()
    private var refs: [String: AXUIElement] = [:]
    private var counter: Int = 0

    func clear() {
        lock.lock()
        refs.removeAll()
        counter = 0
        lock.unlock()
    }

    func register(_ element: AXUIElement) -> String {
        lock.lock()
        counter += 1
        let ref = "e\(counter)"
        refs[ref] = element
        lock.unlock()
        return ref
    }

    func resolve(_ ref: String) -> AXUIElement? {
        lock.lock()
        let element = refs[ref]
        lock.unlock()
        return element
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
