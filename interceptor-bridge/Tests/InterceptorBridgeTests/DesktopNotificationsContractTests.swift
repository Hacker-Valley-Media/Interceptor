import XCTest
@testable import interceptor_bridge

final class DesktopNotificationsContractTests: XCTestCase {
    private func reply(_ domain: NotificationsDomain, _ sub: String, _ fields: [String: Any] = [:]) -> [String: Any] {
        let holder = TestResultHolder(), done = expectation(description: sub)
        domain.handle("notifications", action: ["type": "desktop_notifications", "sub": sub].merging(fields) { _, value in value }) { holder.set($0); done.fulfill() }
        wait(for: [done], timeout: 2); return holder.value
    }
    func testMalformedInputsRefuseBeforeBundleGateAndNativeConstructors() {
        let domain = NotificationsDomain()
        let valid: [String: Any] = ["namespace": "owned", "seconds": 60, "repeats": true, "id": "🙂 文件", "title": "Owned"]
        XCTAssertNil(DesktopNotificationsValidation.validate(["type": "desktop_notifications", "sub": "schedule-after"].merging(valid) { _, value in value }))
        for patch: [String: Any] in [["seconds": 0], ["seconds": 59], ["seconds": 31536001], ["seconds": 1.1], ["seconds": NSNull()], ["seconds": true], ["namespace": "../foreign"], ["id": String(repeating: "x", count: 129)], ["body": String(repeating: "x", count: 32769)], ["date": "bad"], ["unknown": true], ["user_info": "[]"], ["user_info": "{\"x\":\"\\u0000\"}"], ["user_info": "{\"a\":"], ["attachment": "id=relative"]] {
            XCTAssertEqual(reply(domain, "schedule-after", valid.merging(patch) { _, value in value })["code"] as? String, "invalid_request")
        }
        for raw in ["", ",", "unknown", "alert,alert", "alert,"] { XCTAssertEqual(reply(domain, "request", ["options": raw])["code"] as? String, "invalid_request") }
        for raw in ["", "unknown=1", "hour=24", "day=0", "minute=-1", "month=2,day=30", "year=2025,month=2,day=29", "hour=1,hour=2", "minute=3,"] { XCTAssertThrowsError(try DesktopNotificationsValidation.components(raw)) }
        XCTAssertEqual(try? DesktopNotificationsValidation.components("month=2,day=29,hour=0").day, 29)
        XCTAssertTrue(DesktopNotificationsValidation.format("%u owned messages from %@", summary: true))
        XCTAssertTrue(DesktopNotificationsValidation.format("%u owned messages", summary: false))
        XCTAssertTrue(DesktopNotificationsValidation.format("100%% owned", summary: false))
        for raw in ["%n", "%d", "%u %u", "%@ %u", "%u %@ %@", "incomplete %"] { XCTAssertFalse(DesktopNotificationsValidation.format(raw, summary: true)) }
        XCTAssertFalse(DesktopNotificationsValidation.format("%u %@", summary: false))
        for raw in ["[{}]", "[{\"identifier\":\"a\",\"title\":\"x\",\"extra\":true}]", "[{\"identifier\":\"a\",\"title\":\"x\",\"options\":[\"unknown\"]}]", "[{\"identifier\":\"a\",\"title\":\"x\"},{\"identifier\":\"a\",\"title\":\"y\"}]"] { XCTAssertThrowsError(try DesktopNotificationsValidation.actions(raw)) }
        XCTAssertEqual(reply(domain, "post", ["body": "valid"])["code"] as? String, "unsupported_target", "valid native request reaches the safe bundle guard")
        XCTAssertEqual((reply(domain, "log", ["limit": 0])["data"] as? [String: Any])?["entries"] as? [String], [])
    }
    func testDistributedSubscriptionRemovalIsNamespaceScopedAndDeduplicated() {
        let domain = NotificationsDomain(), name = "com.interceptor.fixture.owned." + UUID().uuidString
        for namespace in ["one", "two"] {
            for _ in 0..<4 { XCTAssertEqual(reply(domain, "tail", ["namespace": namespace, "name": name])["success"] as? Bool, true) }
        }
        XCTAssertEqual((reply(domain, "untail", ["namespace": "one", "name": name])["data"] as? [String: Any])?["removed"] as? Bool, true)
        XCTAssertEqual((reply(domain, "untail", ["namespace": "one", "name": name])["data"] as? [String: Any])?["removed"] as? Bool, false)
        XCTAssertEqual((reply(domain, "untail", ["namespace": "two", "name": name])["data"] as? [String: Any])?["removed"] as? Bool, true)
        XCTAssertEqual(reply(domain, "tail")["code"] as? String, "invalid_request")
        for namespace in ["one", "two"] { let data = reply(domain, "log", ["namespace": namespace])["data"] as? [String: Any]; XCTAssertEqual(data?["namespace"] as? String, namespace); XCTAssertEqual((data?["entries"] as? [Any])?.count, 0) }
    }
    func testRouterValidatesBeforeCallingTheNotificationDomain() {
        let router = Router(axTrustCheck: { false }); router.register("notifications", handler: NotificationsDomain())
        let holder = TestResultHolder(), done = expectation(description: "router")
        router.route(action: ["type": "desktop_notifications", "sub": "schedule-after", "seconds": 59, "repeats": true]) { holder.set($0); done.fulfill() }
        wait(for: [done], timeout: 1); XCTAssertEqual(holder.value["code"] as? String, "invalid_request")
    }
}
