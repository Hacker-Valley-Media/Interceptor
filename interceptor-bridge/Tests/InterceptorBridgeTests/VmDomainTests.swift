// VmDomainTests
//
// Unit tests that exercise the pure-data layer of VmDomain without
// actually instantiating VZVirtualMachine (which would require the
// com.apple.security.virtualization entitlement at test runtime and
// would be both slow and non-deterministic).
//
// We test:
//   - VMSpec.validateStatic() boundary conditions
//   - VMRegistry create/get/list/delete/clone round-trips in a tmp state dir
//   - VMRegistry.resolveStateDir() precedence order
//   - WireFormat success/error shapes returned by VmDomain
//
// VMInstance live-boot and MacRuntime install paths are integration
// concerns and live in `test/vm-lifecycle.test.ts` (CL34).

import XCTest
@testable import interceptor_bridge

// Sendable wrapper so we can hand `[String: Any]` across an
// XCTest CheckedContinuation under Swift 6 strict concurrency.
struct TestDictBox: @unchecked Sendable {
    let d: [String: Any]
}

final class VMSpecValidationTests: XCTestCase {

    func test_validateStatic_acceptsMinimalLinux() throws {
        let spec = VMSpec(
            name: "lin1",
            kind: .linux,
            cpu: 2,
            memorySize: 1 * 1024 * 1024 * 1024,
            diskSize: 4 * 1024 * 1024 * 1024,
            image: "docker.io/library/alpine:3"
        )
        XCTAssertNoThrow(try spec.validateStatic())
    }

    func test_validateStatic_rejectsEmptyName() {
        let spec = VMSpec(name: "", kind: .linux, cpu: 1, memorySize: 1<<30, diskSize: 1<<30, image: "alpine:3")
        XCTAssertThrowsError(try spec.validateStatic())
    }

    func test_validateStatic_rejectsBadNameChars() {
        let spec = VMSpec(name: "lin 1", kind: .linux, cpu: 1, memorySize: 1<<30, diskSize: 1<<30, image: "alpine:3")
        XCTAssertThrowsError(try spec.validateStatic())
    }

    func test_validateStatic_rejectsCpuOutOfRange() {
        let s1 = VMSpec(name: "x", kind: .linux, cpu: 0, memorySize: 1<<30, diskSize: 1<<30, image: "alpine:3")
        let s2 = VMSpec(name: "x", kind: .linux, cpu: 65, memorySize: 1<<30, diskSize: 1<<30, image: "alpine:3")
        XCTAssertThrowsError(try s1.validateStatic())
        XCTAssertThrowsError(try s2.validateStatic())
    }

    func test_validateStatic_rejectsTinyMemory() {
        let spec = VMSpec(name: "x", kind: .linux, cpu: 1, memorySize: 1024, diskSize: 1<<30, image: "alpine:3")
        XCTAssertThrowsError(try spec.validateStatic())
    }

    func test_validateStatic_rejectsTinyDisk() {
        let spec = VMSpec(name: "x", kind: .linux, cpu: 1, memorySize: 1<<30, diskSize: 1024, image: "alpine:3")
        XCTAssertThrowsError(try spec.validateStatic())
    }

    func test_validateStatic_macosRequiresIpswOrLatest() {
        let bad = VMSpec(name: "m", kind: .macos, cpu: 4, memorySize: 8<<30, diskSize: 32<<30, image: "alpine:3")
        let okPath = VMSpec(name: "m", kind: .macos, cpu: 4, memorySize: 8<<30, diskSize: 32<<30, image: "/tmp/restore.ipsw")
        let okLatest = VMSpec(name: "m", kind: .macos, cpu: 4, memorySize: 8<<30, diskSize: 32<<30, image: "latest")
        XCTAssertThrowsError(try bad.validateStatic())
        XCTAssertNoThrow(try okPath.validateStatic())
        XCTAssertNoThrow(try okLatest.validateStatic())
    }

    func test_validateStatic_rosettaOnlyOnLinux() {
        let s = VMSpec(name: "m", kind: .macos, cpu: 4, memorySize: 8<<30, diskSize: 32<<30, image: "latest", rosetta: true)
        XCTAssertThrowsError(try s.validateStatic())
    }
}

final class VMRegistryTests: XCTestCase {

    private func makeTmpStateDir() -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("interceptor-vm-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func test_resolveStateDir_precedence() {
        let dir = "/tmp/explicit"
        let resolved = VMRegistry.resolveStateDir(actionOverride: dir)
        XCTAssertEqual(resolved.path, dir)
    }

    func test_resolveStateDir_envFallback() {
        setenv("INTERCEPTOR_VM_STATE_DIR", "/tmp/from-env", 1)
        defer { unsetenv("INTERCEPTOR_VM_STATE_DIR") }
        let resolved = VMRegistry.resolveStateDir(actionOverride: nil)
        XCTAssertEqual(resolved.path, "/tmp/from-env")
    }

    func test_resolveStateDir_cwdDefault() {
        let resolved = VMRegistry.resolveStateDir(actionOverride: nil)
        XCTAssertTrue(resolved.path.hasSuffix("/.interceptor"))
    }

    func test_create_then_get_roundtrip() async throws {
        let stateDir = makeTmpStateDir()
        defer { try? FileManager.default.removeItem(at: stateDir) }
        let reg = try VMRegistry(stateDir: stateDir)
        let spec = VMSpec(name: "lin1", kind: .linux, cpu: 2, memorySize: 1<<30, diskSize: 1<<30, image: "docker.io/library/alpine:3")
        _ = try await reg.create(spec)
        let got = try await reg.get("lin1")
        XCTAssertEqual(got.name, "lin1")
        XCTAssertEqual(got.kind, .linux)
        XCTAssertEqual(got.cpu, 2)
    }

    func test_create_duplicate_throws() async throws {
        let stateDir = makeTmpStateDir()
        defer { try? FileManager.default.removeItem(at: stateDir) }
        let reg = try VMRegistry(stateDir: stateDir)
        let spec = VMSpec(name: "dup", kind: .linux, cpu: 2, memorySize: 1<<30, diskSize: 1<<30, image: "alpine:3")
        _ = try await reg.create(spec)
        await self.expectAsyncThrow(try await reg.create(spec))
    }

    func test_list_returns_all_created() async throws {
        let stateDir = makeTmpStateDir()
        defer { try? FileManager.default.removeItem(at: stateDir) }
        let reg = try VMRegistry(stateDir: stateDir)
        for n in ["a", "b", "c"] {
            let s = VMSpec(name: n, kind: .linux, cpu: 1, memorySize: 1<<30, diskSize: 1<<30, image: "alpine:3")
            _ = try await reg.create(s)
        }
        let all = try await reg.list()
        XCTAssertEqual(all.map { $0.name }.sorted(), ["a", "b", "c"])
    }

    func test_delete_removes_from_index_and_bundle() async throws {
        let stateDir = makeTmpStateDir()
        defer { try? FileManager.default.removeItem(at: stateDir) }
        let reg = try VMRegistry(stateDir: stateDir)
        let spec = VMSpec(name: "delme", kind: .linux, cpu: 1, memorySize: 1<<30, diskSize: 1<<30, image: "alpine:3")
        let bundle = try await reg.create(spec)
        XCTAssertTrue(FileManager.default.fileExists(atPath: bundle.specPath.path))
        try await reg.delete("delme")
        XCTAssertFalse(FileManager.default.fileExists(atPath: bundle.bundlePath.path))
        await self.expectAsyncThrow(try await reg.get("delme"))
    }

    func test_clone_rebrands_and_resets_id() async throws {
        let stateDir = makeTmpStateDir()
        defer { try? FileManager.default.removeItem(at: stateDir) }
        let reg = try VMRegistry(stateDir: stateDir)
        let src = VMSpec(name: "gold", kind: .linux, cpu: 2, memorySize: 1<<30, diskSize: 1<<30, image: "alpine:3")
        _ = try await reg.create(src)
        let bundle = try await reg.clone(from: "gold", to: "test1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: bundle.specPath.path))
        let cloned = try await reg.get("test1")
        XCTAssertEqual(cloned.name, "test1")
        XCTAssertNotEqual(cloned.id, src.id)
    }

    // Helper: XCTest doesn't have an async-throws variant out of the box.
    private func expectAsyncThrow<T>(_ expr: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await expr()
            XCTFail("expected throw", file: file, line: line)
        } catch {
            // ok
        }
    }
}

final class VmDomainDispatchTests: XCTestCase {

    func test_unknownVerb_returnsError() async {
        let domain = VmDomain()
        let action: [String: Any] = ["type": "macos_vm_xyzzy", "sub": "xyzzy"]
        let result = await withCheckedContinuation { (cc: CheckedContinuation<TestDictBox, Never>) in
            domain.handle("xyzzy", action: action) { result in
                cc.resume(returning: TestDictBox(d: result))
            }
        }.d
        XCTAssertEqual(result["success"] as? Bool, false)
        XCTAssertTrue((result["error"] as? String ?? "").contains("unknown verb"))
    }

    func test_create_missingName_returnsError() async {
        let domain = VmDomain()
        let action: [String: Any] = ["type": "macos_vm_create", "sub": "create", "kind": "linux"]
        let result = await withCheckedContinuation { (cc: CheckedContinuation<TestDictBox, Never>) in
            domain.handle("create", action: action) { result in
                cc.resume(returning: TestDictBox(d: result))
            }
        }.d
        XCTAssertEqual(result["success"] as? Bool, false)
    }

    func test_pull_resolvesPathDeterministically() async throws {
        let stateDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("interceptor-vm-pull-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        let url1 = try await VMImage.resolveOCIImage(ref: "docker.io/library/alpine:3", stateDir: stateDir)
        let url2 = try await VMImage.resolveOCIImage(ref: "docker.io/library/alpine:3", stateDir: stateDir)
        XCTAssertEqual(url1.path, url2.path)
    }
}
