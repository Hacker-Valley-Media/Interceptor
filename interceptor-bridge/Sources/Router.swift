import Foundation

final class Router: @unchecked Sendable {
    private var domains: [String: DomainHandler] = [:]
    private var lazyDomains: [String: @Sendable () -> DomainHandler] = [:]
    private let lock = NSLock()

    func register(_ prefix: String, handler: DomainHandler) {
        lock.lock()
        domains[prefix] = handler
        lock.unlock()
    }

    func registerLazy(_ prefix: String, factory: @escaping @Sendable () -> DomainHandler) {
        lock.lock()
        lazyDomains[prefix] = factory
        lock.unlock()
    }

    private func resolveHandler(for key: String) -> DomainHandler? {
        lock.lock()
        if let handler = domains[key] {
            lock.unlock()
            return handler
        }
        if let factory = lazyDomains[key] {
            let handler = factory()
            domains[key] = handler
            lazyDomains.removeValue(forKey: key)
            lock.unlock()
            return handler
        }
        lock.unlock()
        return nil
    }

    func route(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let type = action["type"] as? String else {
            completion(WireFormat.error("missing action type"))
            return
        }

        let parts = type.split(separator: "_", maxSplits: 2)
        guard parts.count >= 2, parts[0] == "macos" else {
            completion(WireFormat.error("invalid action type: \(type) — expected macos_ prefix"))
            return
        }

        let domainKey = String(parts[1])
        let command: String
        if parts.count > 2 {
            command = String(parts[2])
        } else {
            command = domainKey
        }

        if let handler = resolveHandler(for: domainKey) {
            handler.handle(command, action: action, completion: completion)
            return
        }

        lock.lock()
        let allKeys = Array(domains.keys) + Array(lazyDomains.keys)
        lock.unlock()

        for prefix in allKeys {
            if type.hasPrefix("macos_\(prefix)") {
                if let handler = resolveHandler(for: prefix) {
                    handler.handle(command, action: action, completion: completion)
                    return
                }
            }
        }

        completion(WireFormat.error("no handler for domain: \(domainKey)"))
    }
}
