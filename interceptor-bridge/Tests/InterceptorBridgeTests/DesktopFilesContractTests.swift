import XCTest
import Darwin
@testable import interceptor_bridge

final class DesktopFilesContractTests: XCTestCase {
    func testSharedInventoryCaptureKillsAndReapsDeadlineAndOutputLimitChildren() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("interceptor-fixture-files-capture-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        for (name, binary, limit, expectedTimeout) in [("deadline", "/bin/sleep 5", 1024, true), ("output", "/usr/bin/yes", 256, false)] {
            let pidFile = root.appendingPathComponent(name), started = DispatchTime.now().uptimeNanoseconds
            let result = ContainerDomain.capture("/bin/sh", ["-c", "echo $$ > \"$1\"; exec " + binary, "owned-file-inventory-child", pidFile.path], deadline: started + 100_000_000, limit: limit)
            guard case .failure(let error) = result else { return XCTFail("owned helper must reach its bound") }
            switch error { case .timeout: XCTAssertTrue(expectedTimeout); case .limit: XCTAssertFalse(expectedTimeout); case .failed(let message): XCTFail(message) }
            XCTAssertLessThan(DispatchTime.now().uptimeNanoseconds - started, 1_000_000_000)
            let pid = try XCTUnwrap(Int32(String(contentsOf: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)))
            for _ in 0..<100 { if kill(pid, 0) != 0 { break }; Thread.sleep(forTimeInterval: 0.01) }
            XCTAssertEqual(kill(pid, 0), -1, "owned capture child must be killed and reaped")
            XCTAssertEqual(errno, ESRCH)
        }
    }
    private func reply(_ domain: FilesDomain, _ sub: String, _ fields: [String: Any] = [:]) -> [String: Any] {
        let result = TestResultHolder(), done = expectation(description: sub)
        domain.handle("files", action: ["type": "desktop_files", "sub": sub].merging(fields) { _, right in right }) { value in result.set(value); done.fulfill() }
        wait(for: [done], timeout: 7); return result.value
    }
    private func descriptorCount(_ path: String) -> Int {
        var count = 0
        for fd: Int32 in 0..<4096 {
            var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
            if fcntl(fd, F_GETPATH, &buffer) == 0, String(cString: buffer) == path { count += 1 }
        }
        return count
    }
    func testMalformedRequestsAndNegativeLegacyHistoryAreSafe() {
        let domain = FilesDomain()
        for fields: [String: Any] in [["limit": -1], ["limit": 1001], ["limit": 1.5], ["limit": true], ["limit": NSNull()], ["path": "/tmp"], ["pid": 1], ["extra": true]] {
            XCTAssertEqual(reply(domain, "recent", fields)["code"] as? String, "invalid_request")
        }
        let holder = TestResultHolder(), done = expectation(description: "negative legacy history")
        domain.handle("files", action: ["type": "macos_files", "sub": "recent", "limit": -1]) { value in holder.set(value); done.fulfill() }
        wait(for: [done], timeout: 1); XCTAssertEqual(holder.value["code"] as? String, "invalid_request")
        XCTAssertEqual((reply(domain, "recent", ["limit": 0])["data"] as? [Any])?.count, 0)
    }
    func testRealWatchReplacementCancellationAndExactProcessInventory() throws {
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".interceptor-fixture-files-unit-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("owned.txt"), renamed = root.appendingPathComponent("renamed.txt")
        try Data("initial".utf8).write(to: file)
        let domain = FilesDomain(runtimeDir: root.path)
        XCTAssertEqual(descriptorCount(file.path), 0)
        let watched = reply(domain, "watch", ["path": file.path]); XCTAssertEqual(watched["success"] as? Bool, true)
        for _ in 0..<64 { XCTAssertEqual(reply(domain, "watch", ["path": file.path])["success"] as? Bool, true) }
        for _ in 0..<100 { if descriptorCount(file.path) == 1 { break }; Thread.sleep(forTimeInterval: 0.01) }
        XCTAssertEqual(descriptorCount(file.path), 1, "replaced watch descriptors must close")
        let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
        let inventory = reply(domain, "open", ["pid": getpid()])["data"] as? [String: Any]
        XCTAssertTrue((inventory?["files"] as? [String])?.contains(file.path) == true)
        XCTAssertEqual(inventory?["partial"] as? Bool, true); XCTAssertEqual(inventory?["scope"] as? String, "current-user")
        try Data("first change".utf8).write(to: file)
        var recent: [[String: Any]] = []
        for _ in 0..<100 { recent = reply(domain, "recent")["data"] as? [[String: Any]] ?? []; if !recent.isEmpty { break }; Thread.sleep(forTimeInterval: 0.01) }
        XCTAssertEqual(recent.first?["path"] as? String, file.path); XCTAssertEqual(recent.first?["event"] as? String, "change")
        try FileManager.default.moveItem(at: file, to: renamed); try Data("replacement inode".utf8).write(to: file)
        Thread.sleep(forTimeInterval: 0.2)
        let afterRename = (reply(domain, "recent")["data"] as? [Any])?.count
        try Data("new inode change".utf8).write(to: file); Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual((reply(domain, "recent")["data"] as? [Any])?.count, afterRename, "a watch must not silently rebind to a replacement inode")
        try Data("original inode change".utf8).write(to: renamed)
        for _ in 0..<100 { if (reply(domain, "recent")["data"] as? [Any])?.count != afterRename { break }; Thread.sleep(forTimeInterval: 0.01) }
        XCTAssertGreaterThan((reply(domain, "recent")["data"] as? [Any])?.count ?? 0, afterRename ?? 0)
        XCTAssertEqual((reply(domain, "unwatch", ["path": file.path])["data"] as? [String: Any])?["removed"] as? Bool, true)
        XCTAssertEqual((reply(domain, "unwatch", ["path": file.path])["data"] as? [String: Any])?["removed"] as? Bool, false)
        Thread.sleep(forTimeInterval: 0.1)
        let cancelledCount = (reply(domain, "recent")["data"] as? [Any])?.count
        try Data("cancelled change".utf8).write(to: renamed); Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual((reply(domain, "recent")["data"] as? [Any])?.count, cancelledCount)
        let log = root.appendingPathComponent("interceptor-files-events.jsonl")
        let permissions = try FileManager.default.attributesOfItem(atPath: log.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
        let events = try String(contentsOf: log, encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(events.count, cancelledCount)
    }
    func testExactProcessInventoryDistinguishesKernelPermissionRefusal() throws {
        guard getuid() != 0 else { throw XCTSkip("requires an ordinary user") }
        XCTAssertEqual(reply(FilesDomain(), "open", ["pid": 1, "limit": 0])["code"] as? String, "permission_denied")
    }
}
