import Foundation
import HealthKit

final class HealthDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "status":
            checkAvailability(completion: completion)
        default:
            completion(WireFormat.error("\(command) not available — HealthKit requires iPhone syncing health data via iCloud. standalone Mac does not have health data. Available commands: status"))
        }
    }

    private func checkAvailability(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let available = HKHealthStore.isHealthDataAvailable()
        completion(WireFormat.success([
            "available": available,
            "note": available ? "HealthKit data accessible" : "HealthKit not available — requires iPhone syncing health data via iCloud"
        ]))
    }
}
