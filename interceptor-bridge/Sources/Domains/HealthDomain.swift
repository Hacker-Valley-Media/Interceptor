import Foundation
import HealthKit

final class HealthDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? (command == "health" ? "status" : command)
        var request = action
        request["type"] = "desktop_health"
        request["sub"] = action["sub"] ?? sub
        if let error = DesktopHealthShape.validationError(request) {
            completion(["success": false, "code": "invalid_request", "error": error])
            return
        }
        switch sub {
        case "status":
            checkAvailability(completion: completion)
        default:
            completion(WireFormat.error("health: unknown operation '\(sub)'; available operation: status"))
        }
    }

    private func checkAvailability(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let available = HKHealthStore.isHealthDataAvailable()
        completion(WireFormat.success([
            "available": available,
            "note": available ? "HealthKit is available on this device." : "HealthKit is not available on this device."
        ]))
    }
}
