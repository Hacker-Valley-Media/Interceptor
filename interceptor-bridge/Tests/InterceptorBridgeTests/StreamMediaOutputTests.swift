import XCTest
import Foundation
import Darwin
@testable import interceptor_bridge

final class StreamMediaOutputTests: XCTestCase {
    private func ownedDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("interceptor-stream-output-unit-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return url
    }
    func testSharedWriterReadsBackExactPrivateArtifactAndRefusesOverwrite() throws {
        let root = try ownedDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("owned.fixture"), bytes = Data("actual artifact fixture 🙂".utf8)
        let output = try PhotosDomain.Output(url.path)
        XCTAssertTrue(output.append(bytes)); XCTAssertEqual(try output.finish(), bytes.count)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        XCTAssertThrowsError(try PhotosDomain.Output(url.path))
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        let permissions = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
    }
    func testSharedWriterRefusesReplacementAndAdditionalLinksAtFinalization() throws {
        for linked in [true, false] {
            let root = try ownedDirectory(); defer { try? FileManager.default.removeItem(at: root) }
            let path = root.appendingPathComponent("owned.fixture").path, output = try PhotosDomain.Output(path)
            XCTAssertTrue(output.append(Data("original".utf8)))
            if linked { XCTAssertEqual(link(path, root.appendingPathComponent("extra.fixture").path), 0) }
            else {
                XCTAssertEqual(unlink(path), 0)
                try Data("replacement".utf8).write(to: URL(fileURLWithPath: path))
            }
            XCTAssertThrowsError(try output.finish())
            XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), linked ? "original" : "replacement")
        }
    }
}
