import XCTest
import Darwin.POSIX
@testable import interceptor_bridge

private final class FilesystemContractHandler: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return calls }
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock(); calls += 1; lock.unlock()
        completion(WireFormat.success(action))
    }
}

final class DesktopFilesystemContractTests: XCTestCase {
    func testNeutralWriteFailuresCarryCodesAndLegacyFailuresPreserveTheirShape() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("held.txt")
        let original = Data("preserved Unicode 🙂".utf8)
        try original.write(to: file)
        let router = Router(axTrustCheck: { false })
        router.register("fs", handler: FsDomain())
        for (fields, code) in [
            (["path": file.path, "content": "MUST NOT CHANGE", "ifMatch": ["modified": "stale"]] as [String: Any], "invalid_request"),
            (["path": "/etc/Interceptor-fixture-must-not-write", "content": "MUST NOT CHANGE"], "restricted_by_os"),
            (["path": file.appendingPathComponent("child.txt").path, "content": "MUST NOT CHANGE"], "provider_failed"),
        ] {
            for discriminator in ["desktop_fs_write", "macos_fs_write"] {
                let replied = expectation(description: "typed neutral failure with legacy compatibility")
                router.route(action: fields.merging(["type": discriminator]) { _, new in new }) { result in
                    XCTAssertEqual(result["success"] as? Bool, false)
                    XCTAssertNotNil(result["error"] as? String)
                    if discriminator == "desktop_fs_write" {
                        XCTAssertEqual(result["code"] as? String, code)
                    } else {
                        XCTAssertEqual(Set(result.keys), ["success", "error"])
                    }
                    replied.fulfill()
                }
                wait(for: [replied], timeout: 1)
                XCTAssertEqual(try Data(contentsOf: file), original)
            }
        }
    }

    func testNeutralMalformedFieldDiagnosticIsBoundedBeforeDispatch() {
        let handler = FilesystemContractHandler()
        let router = Router(axTrustCheck: { false })
        router.register("fs", handler: handler)
        for key in [String(repeating: "x", count: 5000), "x" + String(repeating: "\u{301}", count: 5000)] {
            let replied = expectation(description: "bounded malformed field diagnostic")
            router.route(action: ["type": "desktop_fs_read", "path": "/tmp/f", key: true]) { result in
                XCTAssertEqual(result["success"] as? Bool, false)
                XCTAssertEqual(result["code"] as? String, "invalid_request")
                XCTAssertLessThanOrEqual((result["error"] as? String)?.utf8.count ?? Int.max, 2048)
                replied.fulfill()
            }
            wait(for: [replied], timeout: 1)
        }
        XCTAssertEqual(handler.count, 0)
    }

    func testNeutralReadRejectsFifoWithoutWaitingForAWriter() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let fifo = root.appendingPathComponent("fifo")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        let router = Router(axTrustCheck: { false })
        router.register("fs", handler: FsDomain())
        let replied = expectation(description: "refuse nonregular file")
        DispatchQueue.global().async {
            router.route(action: ["type": "desktop_fs_read", "path": fifo.path]) { result in
                XCTAssertEqual(result["success"] as? Bool, false)
                XCTAssertEqual(result["code"] as? String, "unsupported_target")
                replied.fulfill()
            }
        }
        wait(for: [replied], timeout: 2)
    }

    func testNeutralReadRejectsOversizedFileAndEscapedReplyWhileLegacyReadStillWorks() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let large = root.appendingPathComponent("large.txt")
        try Data(repeating: 65, count: DESKTOP_MAX_FRAME_BYTES + 1).write(to: large)
        let escaped = root.appendingPathComponent("escaped.txt")
        try Data(repeating: 0, count: 2_000_000).write(to: escaped)
        let router = Router(axTrustCheck: { false })
        router.register("fs", handler: FsDomain())
        for path in [large, escaped] {
            let replied = expectation(description: "bound neutral filesystem reply")
            router.route(action: ["type": "desktop_fs_read", "path": path.path]) { result in
                XCTAssertEqual(result["success"] as? Bool, false)
                XCTAssertEqual(result["code"] as? String, "resource_limit")
                replied.fulfill()
            }
            wait(for: [replied], timeout: 5)
        }
        let replied = expectation(description: "legacy filesystem read")
        router.route(action: ["type": "macos_fs_read", "path": large.path]) { result in
            XCTAssertEqual(result["success"] as? Bool, true)
            XCTAssertEqual(((result["data"] as? [String: Any])?["content"] as? String)?.utf8.count, DESKTOP_MAX_FRAME_BYTES + 1)
            replied.fulfill()
        }
        wait(for: [replied], timeout: 5)
    }

    func testNeutralReadPreservesRangesBinaryEncodingAndTypedMissingFileError() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("bytes.bin")
        try Data([0, 1, 2, 255]).write(to: file)
        let router = Router(axTrustCheck: { false })
        router.register("fs", handler: FsDomain())
        for (range, expected) in [(["start": 1, "length": 2], "AQI="), (["length": 0], ""), (["start": 99], "")] {
            let replied = expectation(description: "bounded byte range")
            router.route(action: ["type": "desktop_fs_read", "path": file.path, "encoding": "base64", "byteRange": range]) { result in
                XCTAssertEqual(result["success"] as? Bool, true)
                XCTAssertEqual((result["data"] as? [String: Any])?["content"] as? String, expected)
                replied.fulfill()
            }
            wait(for: [replied], timeout: 1)
        }
        let replied = expectation(description: "typed missing file error")
        router.route(action: ["type": "desktop_fs_read", "path": root.appendingPathComponent("absent").path]) { result in
            XCTAssertEqual(result["success"] as? Bool, false)
            XCTAssertEqual(result["code"] as? String, "target_gone")
            replied.fulfill()
        }
        wait(for: [replied], timeout: 1)
    }

    func testMalformedNeutralFilesystemFieldsCannotReachAHandler() {
        let handler = FilesystemContractHandler()
        let router = Router(axTrustCheck: { false })
        router.register("fs", handler: handler)
        let invalid: [[String: Any]] = [
            ["type": "desktop_fs_read"],
            ["type": "desktop_fs_read", "path": "relative"],
            ["type": "desktop_fs_read", "path": "/tmp/f", "encoding": NSNull()],
            ["type": "desktop_fs_read", "path": "/tmp/f", "encoding": "unknown"],
            ["type": "desktop_fs_read", "path": "/tmp/f", "extra": true],
            ["type": "desktop_fs_read", "path": "/tmp/f", "_desktopContract": true],
            ["type": "desktop_fs_read", "ref": ["kind": "path", "path": "/tmp/f", "extra": true]],
            ["type": "desktop_fs_read", "path": "/tmp/f", "byteRange": ["start": -1]],
            ["type": "desktop_fs_read", "path": "/tmp/f", "byteRange": ["start": 0.5]],
            ["type": "desktop_fs_read", "path": "/tmp/f", "byteRange": ["start": true]],
            ["type": "desktop_fs_read", "path": "/tmp/f", "byteRange": ["length": NSNull()]],
            ["type": "desktop_fs_read", "path": "/tmp/f", "byteRange": ["start": 9_007_199_254_740_992.0]],
            ["type": "desktop_fs_write", "path": "/tmp/f", "content": NSNull()],
            ["type": "desktop_fs_write", "path": "/tmp/f", "content": true],
            ["type": "desktop_fs_write", "path": "/tmp/f", "content": "x", "ifMatch": ["modified": "x", "extra": true]],
            ["type": "desktop_fs_write", "path": "/tmp/f", "content": "%%%%", "encoding": "base64"],
            ["type": "desktop_fs_search", "query": ""],
            ["type": "desktop_fs_search", "query": "x", "scope": "path", "paths": []],
            ["type": "desktop_fs_search", "query": "x", "scope": "/tmp", "limit": -1],
            ["type": "desktop_fs_search", "query": "x", "scope": "/tmp", "limit": true],
            ["type": "desktop_fs_search", "query": "x", "scope": "/tmp", "limit": 0.5],
            ["type": "desktop_fs_search", "query": "x", "scope": "/tmp", "limit": 10_001],
            ["type": "desktop_fs_search", "query": "x", "scope": "/tmp", "timeoutMs": 10_001],
            ["type": "desktop_fs_search", "query": "x", "scope": "/tmp", "kinds": [NSNull()]],
        ]
        for action in invalid {
            let description = String(describing: action)
            let replied = expectation(description: "refuse malformed filesystem action")
            router.route(action: action) { result in
                XCTAssertEqual(result["success"] as? Bool, false, description)
                XCTAssertEqual(result["code"] as? String, "invalid_request", description)
                replied.fulfill()
            }
            wait(for: [replied], timeout: 1)
        }
        XCTAssertEqual(handler.count, 0)
    }

    func testValidNeutralFilesystemFieldsReachExistingHandlersWithoutAccessibility() {
        let handler = FilesystemContractHandler()
        let router = Router(axTrustCheck: { false })
        router.register("fs", handler: handler)
        for action: [String: Any] in [
            ["type": "desktop_fs_read", "ref": ["kind": "path", "path": "/tmp/f"], "encoding": "raw", "byteRange": ["start": 0, "length": 0]],
            ["type": "desktop_fs_write", "path": "/tmp/f", "content": "🙂", "group": "fixture", "groupSoft": true],
            ["type": "desktop_fs_write", "path": "/tmp/f", "content": "AAEC/w==", "encoding": "base64", "append": false, "ifMatch": ["modified": "now"]],
            ["type": "desktop_fs_search", "query": "*", "scope": "path", "paths": ["/tmp"], "kinds": ["file"], "limit": 50, "timeoutMs": 200],
        ] {
            let expectedType = action["type"] as! String
            let replied = expectation(description: "route valid filesystem action")
            router.route(action: action) { result in
                XCTAssertEqual(result["success"] as? Bool, true)
                let forwarded = result["data"] as? [String: Any]
                XCTAssertEqual(forwarded?["type"] as? String, expectedType)
                replied.fulfill()
            }
            wait(for: [replied], timeout: 1)
        }
        XCTAssertEqual(handler.count, 4)
    }

    func testNeutralUnsupportedVariantsRefuseBeforeHandlersAndLegacyPayloadsRemainUnchanged() {
        let handler = FilesystemContractHandler()
        let router = Router(axTrustCheck: { false })
        router.register("fs", handler: handler)
        for action: [String: Any] in [
            ["type": "desktop_fs_read", "ref": ["kind": "bookmark", "bookmarkB64": "x"]],
            ["type": "desktop_fs_write", "path": "/tmp/f", "content": "x", "append": true],
            ["type": "desktop_fs_unknown"],
        ] {
            let replied = expectation(description: "unsupported neutral filesystem variant")
            router.route(action: action) { result in
                XCTAssertEqual(result["success"] as? Bool, false)
                XCTAssertEqual(result["code"] as? String, "unsupported_operation")
                replied.fulfill()
            }
            wait(for: [replied], timeout: 1)
        }
        XCTAssertEqual(handler.count, 0)
        let legacy: [String: Any] = ["type": "macos_fs_write", "path": "/tmp/f", "content": "legacy", "extra": true, "append": true]
        let replied = expectation(description: "preserve legacy action")
        router.route(action: legacy) { result in
            XCTAssertEqual(result["success"] as? Bool, true)
            let action = result["data"] as? [String: Any]
            XCTAssertEqual(action?["type"] as? String, "macos_fs_write")
            XCTAssertEqual(action?["extra"] as? Bool, true)
            XCTAssertEqual(action?["append"] as? Bool, true)
            replied.fulfill()
        }
        wait(for: [replied], timeout: 1)
        XCTAssertEqual(handler.count, 1)
    }
}
