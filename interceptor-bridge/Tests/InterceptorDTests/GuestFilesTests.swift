import XCTest
import Foundation
import Darwin
import CryptoKit
import GuestWire
@testable import InterceptorD

final class GuestFilesTests: XCTestCase {
    private func directory() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("interceptor-guest-files-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        addTeardownBlock { try FileManager.default.removeItem(at: url) }
        return url
    }
    private func copy(_ data: Data, to path: String) -> [String: Any] {
        GuestFiles.copyIn(["path": path, "dataBase64": data.base64EncodedString(), "timeout": 5])
    }

    func testBinaryAndEmptyFilesHaveActualExclusiveRetainedReadback() throws {
        let dir = try directory()
        for bytes in [Data(), Data([0, 255, 1, 0, 128])] {
            let path = dir.appendingPathComponent(UUID().uuidString).path
            let result = copy(bytes, to: path)
            XCTAssertEqual(result["success"] as? Bool, true)
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), bytes)
            let receipt = result["data"] as? [String: Any]
            XCTAssertEqual(receipt?["path"] as? String, path)
            XCTAssertEqual(receipt?["bytes"] as? Int, bytes.count)
            XCTAssertEqual(receipt?["overwrite"] as? Bool, false)
            XCTAssertEqual(receipt?["verified"] as? Bool, true)
            XCTAssertEqual(receipt?["sha256"] as? String, SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
            XCTAssertNoThrow(try GuestWire.verifyCopied(result, path: path, data: bytes))
            let read = GuestFiles.copyOut(["path": path, "timeout": 5])
            XCTAssertEqual(read["success"] as? Bool, true)
            XCTAssertEqual((read["data"] as? [String: Any])?["dataBase64"] as? String, bytes.base64EncodedString())
            XCTAssertEqual(try GuestWire.copyBytes(read, path: path), bytes)
            var metadata = stat()
            XCTAssertEqual(Darwin.lstat(path, &metadata), 0)
            XCTAssertEqual(metadata.st_mode & 0o7777, 0o600)
        }
    }

    func testExistingFileAndFinalSymlinkArePreserved() throws {
        let dir = try directory(), original = Data("original".utf8)
        let path = dir.appendingPathComponent("existing").path, link = dir.appendingPathComponent("link").path
        try original.write(to: URL(fileURLWithPath: path))
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: path)
        for destination in [path, link] {
            let result = copy(Data("replacement".utf8), to: destination)
            XCTAssertEqual(result["success"] as? Bool, false)
            XCTAssertEqual(result["mutationSubmitted"] as? Bool, false)
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), original)
        }
        XCTAssertEqual(GuestFiles.copyOut(["path": link])["success"] as? Bool, false)
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: link), path)
    }

    func testMissingParentAndInvalidOrOversizedBytesCreateNothing() throws {
        let dir = try directory(), missing = dir.appendingPathComponent("missing/new").path
        XCTAssertEqual(copy(Data(), to: missing)["success"] as? Bool, false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("missing").path))
        for text in ["YQ==\n", "YQ", Data(repeating: 1, count: GuestFiles.maxBytes + 1).base64EncodedString()] {
            let path = dir.appendingPathComponent(UUID().uuidString).path
            XCTAssertEqual(GuestFiles.copyIn(["path": path, "dataBase64": text])["success"] as? Bool, false)
            XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        }
    }

    func testFIFOAndOversizedSourceAreRefusedWithoutReadingThem() throws {
        let dir = try directory(), fifo = dir.appendingPathComponent("fifo").path, large = dir.appendingPathComponent("large").path
        XCTAssertEqual(Darwin.mkfifo(fifo, 0o600), 0)
        XCTAssertEqual(GuestFiles.copyOut(["path": fifo])["success"] as? Bool, false)
        try Data(repeating: 1, count: GuestFiles.maxBytes + 1).write(to: URL(fileURLWithPath: large))
        XCTAssertEqual(GuestFiles.copyOut(["path": large])["success"] as? Bool, false)
    }

    func testInvalidModesAndBudgetsRefuseBeforeDestinationCreation() throws {
        let dir = try directory()
        for change in [["mode": "4755"], ["mode": 600], ["timeout": true], ["timeout": 0], ["timeout": 51]] as [[String: Any]] {
            let path = dir.appendingPathComponent(UUID().uuidString).path
            let request: [String: Any] = ["path": path, "dataBase64": ""]
            XCTAssertEqual(GuestFiles.copyIn(request.merging(change) { _, replacement in replacement })["success"] as? Bool, false)
            XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        }
    }

    func testReplacingTheOutputNamePreservesTheReplacementAndRefusesSuccess() throws {
        let dir = try directory(), path = dir.appendingPathComponent("target").path
        let parked = dir.appendingPathComponent("retained").path
        let held = try GuestFiles.File(path: path, create: true)
        try FileManager.default.moveItem(atPath: path, toPath: parked)
        let observer = Data("replacement owned by someone else".utf8)
        try observer.write(to: URL(fileURLWithPath: path))
        let intended = Data("bytes for the retained file".utf8)
        XCTAssertThrowsError(try held.write(intended, mode: 0o600, deadline: .init(seconds: 5)))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), observer)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: parked)), intended)
    }

    func testReplacingTheParentPreservesTheNewDirectoryDestination() throws {
        let dir = try directory(), parent = dir.appendingPathComponent("parent", isDirectory: true)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
        let path = parent.appendingPathComponent("target").path
        let held = try GuestFiles.File(path: path, create: true)
        let parked = dir.appendingPathComponent("parked", isDirectory: true)
        try FileManager.default.moveItem(at: parent, to: parked)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
        let observer = Data("new directory destination".utf8)
        try observer.write(to: URL(fileURLWithPath: path))
        let intended = Data("old retained directory".utf8)
        XCTAssertThrowsError(try held.write(intended, mode: 0o600, deadline: .init(seconds: 5)))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), observer)
        XCTAssertEqual(try Data(contentsOf: parked.appendingPathComponent("target")), intended)
    }

    func testReplacingTheRetainedSourceNameCannotProduceSuccessfulDifferentBytes() throws {
        let dir = try directory(), path = dir.appendingPathComponent("source").path
        let original = Data("retained source".utf8), replacement = Data("different source".utf8)
        try original.write(to: URL(fileURLWithPath: path))
        let held = try GuestFiles.File(path: path, create: false)
        try FileManager.default.moveItem(atPath: path, toPath: dir.appendingPathComponent("old").path)
        try replacement.write(to: URL(fileURLWithPath: path))
        XCTAssertThrowsError(try held.read(deadline: .init(seconds: 5)))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), replacement)
    }
}
