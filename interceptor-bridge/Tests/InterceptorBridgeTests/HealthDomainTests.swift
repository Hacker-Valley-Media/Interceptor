import XCTest
import HealthKit
@testable import interceptor_bridge

final class HealthDomainTests: XCTestCase {
    func testPublicSubAndTypedDefaultReachActualAvailability() {
        let router = Router(axTrustCheck: { false })
        router.register("health", handler: HealthDomain())
        for action: [String: Any] in [
            ["type": "macos_health", "sub": "status"],
            ["type": "macos_health_status"],
            ["type": "desktop_health"],
            ["type": "desktop_health", "sub": "status", "group": "owned", "groupSoft": true],
        ] {
            let holder = TestResultHolder()
            router.route(action: action) { holder.set($0) }
            XCTAssertEqual(holder.value["success"] as? Bool, true)
            let data = holder.value["data"] as? [String: Any]
            XCTAssertEqual(data?["available"] as? Bool, HKHealthStore.isHealthDataAvailable())
            XCTAssertEqual(data?["note"] as? String, HKHealthStore.isHealthDataAvailable()
                ? "HealthKit is available on this device." : "HealthKit is not available on this device.")
        }
    }

    func testMalformedOrUnsupportedRequestsRefuse() {
        let router = Router(axTrustCheck: { false })
        router.register("health", handler: HealthDomain())
        for extra: [String: Any] in [
            ["sub": "get"], ["sub": NSNull()], ["sub": 1],
            ["pid": 1], ["groupSoft": 1], ["group": NSNull()],
        ] {
            var action: [String: Any] = ["type": "desktop_health"]
            action.merge(extra) { _, new in new }
            let holder = TestResultHolder()
            router.route(action: action) { holder.set($0) }
            XCTAssertEqual(holder.value["success"] as? Bool, false)
            XCTAssertEqual(holder.value["code"] as? String, "invalid_request")
        }
    }
}
