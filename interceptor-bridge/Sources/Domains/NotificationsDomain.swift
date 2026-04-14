import Foundation

final class NotificationsDomain: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var captured: [[String: Any]] = []
    private var observing = false

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "tail":
            startTailing(completion: completion)
        case "log":
            getLog(action, completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func startTailing(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if !observing {
            observing = true
            DistributedNotificationCenter.default().addObserver(
                forName: nil,
                object: nil,
                queue: nil
            ) { [weak self] notification in
                let entry: [String: Any] = [
                    "name": notification.name.rawValue,
                    "object": notification.object as? String ?? "",
                    "timestamp": ISO8601DateFormatter().string(from: Date())
                ]
                self?.lock.lock()
                self?.captured.append(entry)
                if (self?.captured.count ?? 0) > 1000 {
                    self?.captured.removeFirst(500)
                }
                self?.lock.unlock()
            }
        }
        completion(WireFormat.success(["tailing": true]))
    }

    private func getLog(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let limit = action["limit"] as? Int ?? 50
        let appFilter = action["app"] as? String
        lock.lock()
        var results = Array(captured.suffix(limit))
        lock.unlock()
        if let appFilter = appFilter {
            results = results.filter { entry in
                (entry["object"] as? String)?.contains(appFilter) == true ||
                (entry["name"] as? String)?.contains(appFilter) == true
            }
        }
        completion(WireFormat.success(results))
    }
}
