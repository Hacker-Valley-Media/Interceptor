import XCTest
@testable import interceptor_bridge

// Issue #318: two `macos screenshot --save` calls in the same second produced the
// same file name and the second silently replaced the first.
final class CaptureSaveNoOverwriteTests: XCTestCase {
    func testSecondSaveInTheSameSecondGetsItsOwnFile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("capture-save-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("interceptor-macos-screenshot-1793852700.jpg")

        let first = try CaptureDomain.writeWithoutOverwriting(Data("first".utf8), to: url)
        let second = try CaptureDomain.writeWithoutOverwriting(Data("second".utf8), to: url)
        let third = try CaptureDomain.writeWithoutOverwriting(Data("third".utf8), to: url)

        XCTAssertEqual(first.lastPathComponent, "interceptor-macos-screenshot-1793852700.jpg")
        XCTAssertEqual(second.lastPathComponent, "interceptor-macos-screenshot-1793852700-2.jpg")
        XCTAssertEqual(third.lastPathComponent, "interceptor-macos-screenshot-1793852700-3.jpg")
        XCTAssertEqual(try Data(contentsOf: first), Data("first".utf8))
        XCTAssertEqual(try Data(contentsOf: second), Data("second".utf8))
        XCTAssertEqual(try Data(contentsOf: third), Data("third".utf8))
    }
}
