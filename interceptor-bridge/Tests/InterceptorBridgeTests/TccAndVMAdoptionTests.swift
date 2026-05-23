import XCTest
@testable import interceptor_bridge

final class TccProfileGeneratorTests: XCTestCase {
    func testProfileGeneratorIncludesGrantableAndSkipsUserOnlyServices() throws {
        let generated = try TccProfileGenerator.generateProfile(
            target: "host",
            bundleId: "com.interceptor.bridge",
            appPath: "/Applications/Interceptor.app",
            identifierType: "bundleID",
            codeRequirement: "identifier com.interceptor.bridge",
            requestedServices: ["Accessibility", "PostEvent", "ScreenCapture"],
            includeUserOnly: true
        )

        let includedServices = generated.included.compactMap { $0["service"] as? String }
        let skippedServices = generated.skipped.compactMap { $0["service"] as? String }
        XCTAssertTrue(includedServices.contains("Accessibility"))
        XCTAssertTrue(includedServices.contains("PostEvent"))
        XCTAssertTrue(skippedServices.contains("ScreenCapture"))
        XCTAssertTrue(generated.xml.contains("com.apple.TCC.configuration-profile-policy"))
    }
}

final class VMAdoptionTests: XCTestCase {
    private func tempDir(_ name: String) -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
    }

    func testDetectsAndAdoptsLumeBundleShape() async throws {
        let source = tempDir("lume-source")
        let state = tempDir("lume-state")
        defer {
            try? FileManager.default.removeItem(at: source)
            try? FileManager.default.removeItem(at: state)
        }
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)

        try Data("disk".utf8).write(to: source.appendingPathComponent("disk.img"))
        try Data("nvram".utf8).write(to: source.appendingPathComponent("nvram.bin"))
        let hw = Data("hardware-model".utf8).base64EncodedString()
        let mid = Data("machine-id".utf8).base64EncodedString()
        let config = """
        {
          "diskSize": 107374182400,
          "memorySize": 17179869184,
          "machineIdentifier": "\(mid)",
          "cpuCount": 8,
          "os": "macOS",
          "hardwareModel": "\(hw)",
          "networkMode": "nat"
        }
        """
        try Data(config.utf8).write(to: source.appendingPathComponent("config.json"))

        XCTAssertEqual(VMAdoption.detectProvider(source: source, requested: "auto"), .lume)

        let registry = try VMRegistry(stateDir: state)
        let result = try await VMAdoption.adopt(
            source: source,
            name: "gold",
            kind: .macos,
            requestedProvider: "auto",
            mode: .clone,
            registry: registry
        )

        XCTAssertEqual(result.provider, .lume)
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.bundle.diskPath.path))
        XCTAssertEqual(try Data(contentsOf: result.bundle.hardwareModelPath), Data("hardware-model".utf8))
        XCTAssertEqual(try Data(contentsOf: result.bundle.machineIdPath), Data("machine-id".utf8))
    }
}
