import XCTest
@testable import interceptor_bridge

final class DesktopAuthContractTests: XCTestCase {
    func testVaultReplyDeclarationsDecodeSharedHostAndMalformedFixtures() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let document = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("shared/desktop-secret-reply-fixtures.json"))) as? [String: Any]
        let fixtures = try XCTUnwrap(document?["cases"] as? [[String: Any]])
        for fixture in fixtures {
            let action = try XCTUnwrap(fixture["action"] as? [String: Any])
            let sub = try XCTUnwrap(action["sub"] as? String)
            let data = try JSONSerialization.data(withJSONObject: XCTUnwrap(fixture["data"]))
            var decoded = false
            do {
                switch sub {
                case "status": _ = try JSONDecoder().decode(DesktopSecretStatusData.self, from: data)
                case "list": _ = try JSONDecoder().decode(DesktopSecretListData.self, from: data)
                case "register", "set": _ = try JSONDecoder().decode(DesktopSecretStoredData.self, from: data)
                case "rm": _ = try JSONDecoder().decode(DesktopSecretRemovedData.self, from: data)
                case "unlock": _ = try JSONDecoder().decode(DesktopSecretUnlockedData.self, from: data)
                case "lock": _ = try JSONDecoder().decode(DesktopSecretLockedData.self, from: data)
                case "reveal": _ = try JSONDecoder().decode(DesktopSecretRevealedData.self, from: data)
                default: XCTFail("unknown vault fixture selector"); continue
                }
                decoded = true
            } catch {}
            XCTAssertEqual(decoded, try XCTUnwrap(fixture["shapeValid"] as? Bool), fixture["name"] as? String ?? sub)
        }
    }
    private func invoke(_ action: [String: Any]) -> [String: Any] {
        let holder = TestResultHolder(), replied = expectation(description: "authentication result")
        let router = Router(axTrustCheck: { false }); router.register("auth", handler: AuthDomain())
        router.route(action: action) { result in holder.set(result); replied.fulfill() }
        wait(for: [replied], timeout: 10); return holder.value
    }
    func testInvalidNeutralPromptsRefuseBeforeAuthenticationAndWithoutAXTrust() {
        let action: [String: Any] = ["type": "desktop_auth", "sub": "confirm", "reason": "Owned 验证"]
        for fields: [String: Any] in [["sub": "unknown"], ["reason": ""], ["reason": " "], ["reason": "a\0b"], ["reason": String(repeating: "界", count: 683)], ["reuse_seconds": 0.5], ["reuse_seconds": 301], ["policy": NSNull()], ["policy": "unknown"], ["extra": true], ["cancel_title": String(repeating: "x", count: 129)]] {
            let result = invoke(action.merging(fields) { _, right in right })
            XCTAssertEqual(result["success"] as? Bool, false); XCTAssertEqual(result["code"] as? String, "invalid_request", "\(result)")
        }
        for sub in ["status", "invalidate", "domain-state"] {
            XCTAssertEqual(invoke(["type": "desktop_auth", "sub": sub, "reason": "unexpected"])["code"] as? String, "invalid_request")
        }
    }
    func testNeutralStatusAndContextStateKeepTheValidatedContract() throws {
        for requested in ["any", "biometry", "watch", "biometry-or-watch"] {
            let result = invoke(["type": "desktop_auth", "sub": "status", "policy": requested])
            XCTAssertEqual(result["success"] as? Bool, true)
            let data = try XCTUnwrap(result["data"] as? [String: Any])
            XCTAssertEqual(data["policy"] as? String, requested)
            XCTAssertEqual(data["provider"] as? String, "local-authentication")
            XCTAssertEqual(data["user"] as? String, String(getuid()))
            XCTAssertEqual(data["canEvaluate"] as? Bool, (data["availablePolicies"] as? [String])?.contains(requested))
            XCTAssertNoThrow(try JSONDecoder().decode(DesktopAuthStatusData.self, from: JSONSerialization.data(withJSONObject: data)))
        }
        let invalidated = try XCTUnwrap(invoke(["type": "desktop_auth", "sub": "invalidate"])["data"] as? [String: Any])
        XCTAssertEqual(invalidated["invalidated"] as? Bool, true)
        let state = try XCTUnwrap(invoke(["type": "desktop_auth", "sub": "domain-state"])["data"] as? [String: Any])
        XCTAssertEqual(state["available"] as? Bool, false); XCTAssertNil(state["state"])
    }
}
