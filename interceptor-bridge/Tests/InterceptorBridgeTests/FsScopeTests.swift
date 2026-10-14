import XCTest
@testable import interceptor_bridge

// Regression: FsDomain.handleSearch
// previously coerced any non-alias scope to the user's home directory,
// silently dropping `--scope /tmp` and similar absolute paths. The fix
// honors absolute paths that exist and rejects unresolvable scopes
// with a structured error.

private final class FsResultHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: Any] = [:]
    var value: [String: Any] {
        lock.lock(); defer { lock.unlock() }; return stored
    }
    func set(_ v: [String: Any]) { lock.lock(); stored = v; lock.unlock() }
}

final class FsScopeTests: XCTestCase {
    private func dispatch(scope: String?) -> [String: Any] {
        let domain = FsDomain()
        var action: [String: Any] = [
            "type": "macos_fs_search",
            "query": "fs-scope-test-token-unlikely-to-match"
        ]
        if let scope = scope { action["scope"] = scope }
        let holder = FsResultHolder()
        let exp = expectation(description: "fs_search scope=\(scope ?? "<nil>")")
        domain.handle("search", action: action) { r in
            holder.set(r)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 8.0)
        return holder.value
    }

    func testAbsolutePathScopeIsHonored() {
        // /tmp always exists on macOS; scope should be adopted as-is.
        let r = dispatch(scope: "/tmp")
        XCTAssertNil(r["error"], "absolute /tmp scope must not error")
        let data = r["data"] as? [String: Any]
        XCTAssertEqual(data?["scope"] as? String, "/tmp", "scope field must reflect the honored path")
    }

    func testUnresolvableScopeReturnsStructuredError() {
        // /nonexistent/path/fs-scope does not exist; bridge must reject
        // explicitly instead of silently overriding to home.
        let r = dispatch(scope: "/nonexistent/path/fs-scope")
        let err = (r["error"] as? String) ?? ""
        XCTAssertTrue(err.contains("not an alias") || err.contains("not an absolute path that exists"),
                      "unresolvable scope must surface a clear error, got: \(err)")
    }

    func testHomeAliasStillWorks() {
        let r = dispatch(scope: "home")
        XCTAssertNil(r["error"], "home alias must continue to work")
    }

    func testWorkspaceAliasStillWorks() {
        let r = dispatch(scope: "workspace")
        XCTAssertNil(r["error"], "workspace alias must continue to work")
    }
}
