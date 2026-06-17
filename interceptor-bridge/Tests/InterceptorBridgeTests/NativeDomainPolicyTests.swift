import XCTest
@testable import interceptor_bridge

final class NativeDomainPolicyTests: XCTestCase {
    private let domain = NativeDomain()

    private func runCommand(_ command: String, action: [String: Any] = [:]) -> [String: Any] {
        let holder = TestResultHolder()
        let exp = expectation(description: "native \(command)")
        domain.handle(command, action: action) { resp in
            holder.set(resp)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5.0)
        return holder.value
    }

    func testSignidDefaultsToBringYourOwnRequired() {
        unsetenv("INTERCEPTOR_NATIVE_SIGNING_IDENTITY")
        let r = runCommand("signid")
        XCTAssertEqual(r["success"] as? Bool, true)
        let data = r["data"] as? [String: Any]
        XCTAssertEqual(data?["mode"] as? String, "bring-your-own-required")
        XCTAssertTrue((data?["note"] as? String ?? "").contains("INTERCEPTOR_NATIVE_SIGNING_IDENTITY"))
        XCTAssertTrue((data?["note"] as? String ?? "").contains("vendor certificate"))
    }

    func testSignidUsesNativeSpecificIdentityName() {
        setenv("INTERCEPTOR_NATIVE_SIGNING_IDENTITY", "Local Native Audit Identity", 1)
        defer { unsetenv("INTERCEPTOR_NATIVE_SIGNING_IDENTITY") }
        let r = runCommand("signid")
        XCTAssertEqual(r["success"] as? Bool, true)
        let data = r["data"] as? [String: Any]
        XCTAssertEqual(data?["mode"] as? String, "configured")
        XCTAssertEqual(data?["identity"] as? String, "Local Native Audit Identity")
        XCTAssertTrue((data?["note"] as? String ?? "").contains("INTERCEPTOR_NATIVE_SIGNING_IDENTITY"))
    }
}
