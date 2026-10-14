import XCTest
@testable import interceptor_bridge

final class DesktopContainerContractTests: XCTestCase {
    func testStrictContainerRequestAndNoAccessibilityGate() {
        let base: [String: Any] = ["type": "desktop_container_run", "image": "docker.io/library/alpine:3", "command": ["echo", "", "Unicode 验证"]]
        XCTAssertNil(DesktopContainerValidation.validate(base))
        let router = Router(axTrustCheck: { false }); router.register("container", handler: ContainerDomain())
        for fields: [String: Any] in [["command": []], ["command": [""]], ["command": ["x\0"]], ["image": "--help"], ["network": "other"], ["env": ["BAD=KEY": "x"]], ["env": ["X": NSNull()]], ["timeoutMs": 0], ["timeoutMs": 1.5], ["timeoutMs": true], ["maxOutputBytes": 1048577], ["mounts": [["hostPath": "/tmp", "mountPath": "/../x", "mode": "ro"]]], ["extra": true]] {
            let holder = TestResultHolder(), replied = expectation(description: "invalid container request")
            router.route(action: base.merging(fields) { _, right in right }) { result in holder.set(result); replied.fulfill() }
            wait(for: [replied], timeout: 1)
            XCTAssertEqual(holder.value["code"] as? String, "invalid_request", "\(fields)")
        }
    }
}
