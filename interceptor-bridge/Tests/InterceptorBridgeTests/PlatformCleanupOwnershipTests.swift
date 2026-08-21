import XCTest
import Foundation
@testable import interceptor_bridge

// Issue #222: an exiting bridge may only unlink the socket path and pid file
// when the pid file names it. Otherwise a late-exiting orphan takes down the
// live, launchd-owned bridge's files.
final class PlatformCleanupOwnershipTests: XCTestCase {
    private func tempDir() -> String {
        let dir = NSTemporaryDirectory() + "bridge-cleanup-" + UUID().uuidString
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }

    func testOwnerRemovesBothFiles() throws {
        let dir = tempDir()
        let sock = dir + "/bridge.sock", pid = dir + "/bridge.pid"
        FileManager.default.createFile(atPath: sock, contents: Data())
        try "\(ProcessInfo.processInfo.processIdentifier)\n".write(toFile: pid, atomically: true, encoding: .utf8)
        Platform.cleanup(socketPath: sock, pidPath: pid, lockPath: dir + "/bridge.lock")
        XCTAssertFalse(FileManager.default.fileExists(atPath: sock))
        XCTAssertFalse(FileManager.default.fileExists(atPath: pid))
    }

    func testNonOwnerLeavesBothFiles() throws {
        let dir = tempDir()
        let sock = dir + "/bridge.sock", pid = dir + "/bridge.pid"
        FileManager.default.createFile(atPath: sock, contents: Data())
        try "1\n".write(toFile: pid, atomically: true, encoding: .utf8)   // launchd's pid, never ours
        Platform.cleanup(socketPath: sock, pidPath: pid, lockPath: dir + "/bridge.lock")
        XCTAssertTrue(FileManager.default.fileExists(atPath: sock), "a non-owner must not unlink the live socket path")
        XCTAssertTrue(FileManager.default.fileExists(atPath: pid), "a non-owner must not unlink the live pid file")
    }

    func testMissingPidFileCountsAsOwner() {
        let dir = tempDir()
        let sock = dir + "/bridge.sock", pid = dir + "/bridge.pid"
        FileManager.default.createFile(atPath: sock, contents: Data())
        Platform.cleanup(socketPath: sock, pidPath: pid, lockPath: dir + "/bridge.lock")
        XCTAssertFalse(FileManager.default.fileExists(atPath: sock))
    }

    func testCleanupSkipsWhileAnotherHolderOwnsTheLifecycleLock() throws {
        let dir = tempDir()
        let sock = dir + "/bridge.sock", pid = dir + "/bridge.pid", lock = dir + "/bridge.lock"
        FileManager.default.createFile(atPath: sock, contents: Data())
        try "\(ProcessInfo.processInfo.processIdentifier)\n".write(toFile: pid, atomically: true, encoding: .utf8)
        // A "starting instance" holds the lock; the exiting instance must give up
        // without touching the files rather than block or race.
        let holder = try XCTUnwrap(Platform.acquireLifecycleLock(path: lock, timeout: 1.0))
        defer { Platform.releaseLifecycleLock(holder) }
        let t0 = Date()
        Platform.cleanup(socketPath: sock, pidPath: pid, lockPath: lock)
        XCTAssertLessThan(Date().timeIntervalSince(t0), 4.0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: sock))
        XCTAssertTrue(FileManager.default.fileExists(atPath: pid))
    }

    func testOwnershipPredicate() throws {
        let dir = tempDir()
        let pid = dir + "/bridge.pid"
        try "4242\n".write(toFile: pid, atomically: true, encoding: .utf8)
        XCTAssertTrue(Platform.ownsBridgeFiles(pidPath: pid, selfPid: 4242))
        XCTAssertFalse(Platform.ownsBridgeFiles(pidPath: pid, selfPid: 4243))
    }
}
