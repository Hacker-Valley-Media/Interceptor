import XCTest
@testable import interceptor_bridge

private final class NoopDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) { completion([:]) }
}

final class DesktopHelloContractTests: XCTestCase {
    // The daemon refuses the whole hello when one capability carries a value
    // outside the contract (daemon/desktop-provider.ts), so check every one.
    func testEveryAdvertisedBackgroundIsAContractValue() throws {
        let mainURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Sources/main.swift").standardized
        let main = try String(contentsOf: mainURL, encoding: .utf8)
        let pattern = try NSRegularExpression(pattern: #"register(?:Lazy)?\("([a-z_]+)""#)
        let prefixes = Set(pattern.matches(in: main, range: NSRange(main.startIndex..., in: main))
            .compactMap { Range($0.range(at: 1), in: main).map { String(main[$0]) } })
        XCTAssertGreaterThan(prefixes.count, 40)
        let router = Router(axTrustCheck: { false })
        for prefix in prefixes { router.register(prefix, handler: NoopDomain()) }
        let holder = TestResultHolder(), replied = expectation(description: "desktop hello")
        DesktopDomain(router: router).handle("hello", action: [:]) { holder.set($0); replied.fulfill() }
        wait(for: [replied], timeout: 2)
        let capabilities = try XCTUnwrap((holder.value["data"] as? [String: Any])?["capabilities"] as? [[String: Any]])
        XCTAssertEqual(capabilities.count, prefixes.subtracting(["desktop"]).count)
        for capability in capabilities {
            let background = capability["background"] as? String ?? "<missing>"
            XCTAssertNotNil(DesktopBackground(rawValue: background), "\(capability["operation"] ?? "?") background \(background)")
        }
    }
}
