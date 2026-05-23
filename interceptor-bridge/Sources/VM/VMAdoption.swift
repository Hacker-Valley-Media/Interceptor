import Foundation

public enum VMAdoptionError: Error, CustomStringConvertible, Sendable {
    case unsupportedProvider(String)
    case unsupportedMode(String)
    case missingFile(String)
    case invalidConfig(String)
    case ioFailure(String)

    public var description: String {
        switch self {
        case .unsupportedProvider(let m): return "adoption.unsupportedProvider: \(m)"
        case .unsupportedMode(let m): return "adoption.unsupportedMode: \(m)"
        case .missingFile(let m): return "adoption.missingFile: \(m)"
        case .invalidConfig(let m): return "adoption.invalidConfig: \(m)"
        case .ioFailure(let m): return "adoption.ioFailure: \(m)"
        }
    }
}

struct LumeConfig: Codable, Sendable {
    var diskSize: UInt64?
    var memorySize: UInt64?
    var display: String?
    var machineIdentifier: String?
    var cpuCount: Int?
    var os: String?
    var macAddress: String?
    var hardwareModel: String?
    var networkMode: String?
}

public struct VMAdoptionResult: Sendable {
    public var spec: VMSpec
    public var bundle: VMBundle
    public var provider: VMProviderKind
    public var copiedFiles: [String]

    public var asDictionary: [String: Any] {
        [
            "name": spec.name,
            "id": spec.id,
            "kind": spec.kind.rawValue,
            "provider": provider.rawValue,
            "bundlePath": bundle.bundlePath.path,
            "copiedFiles": copiedFiles,
            "status": VMStatus.ready.rawValue,
        ]
    }
}

public struct VMAdoption: Sendable {
    public static func detectProvider(source: URL, requested: String) -> VMProviderKind? {
        if requested != "auto" {
            return VMProviderKind(rawValue: requested)
        }
        let fm = FileManager.default
        if fm.fileExists(atPath: source.appendingPathComponent("config.json").path),
           fm.fileExists(atPath: source.appendingPathComponent("disk.img").path),
           fm.fileExists(atPath: source.appendingPathComponent("nvram.bin").path) {
            return .lume
        }
        if fm.fileExists(atPath: source.appendingPathComponent("Disk.img").path),
           fm.fileExists(atPath: source.appendingPathComponent("AuxiliaryStorage").path),
           fm.fileExists(atPath: source.appendingPathComponent("HardwareModel").path),
           fm.fileExists(atPath: source.appendingPathComponent("MachineIdentifier").path) {
            return .appleVZ
        }
        return nil
    }

    public static func adopt(
        source: URL,
        name: String,
        kind: VMKind,
        requestedProvider: String,
        mode: VMAdoptMode,
        registry: VMRegistry
    ) async throws -> VMAdoptionResult {
        guard FileManager.default.fileExists(atPath: source.path) else {
            throw VMAdoptionError.missingFile(source.path)
        }
        guard mode == .clone || mode == .move else {
            throw VMAdoptionError.unsupportedMode("reference mode is not supported until VMSpec can point runtime files outside the Interceptor bundle")
        }
        guard let provider = detectProvider(source: source, requested: requestedProvider) else {
            throw VMAdoptionError.unsupportedProvider("could not detect provider at \(source.path)")
        }
        switch provider {
        case .lume:
            return try await adoptLume(source: source, name: name, kind: kind, mode: mode, registry: registry)
        case .appleVZ:
            return try await adoptAppleVZ(source: source, name: name, kind: kind, mode: mode, registry: registry)
        default:
            throw VMAdoptionError.unsupportedProvider("provider \(provider.rawValue) has no native adoption importer yet")
        }
    }

    private static func adoptLume(
        source: URL,
        name: String,
        kind: VMKind,
        mode: VMAdoptMode,
        registry: VMRegistry
    ) async throws -> VMAdoptionResult {
        guard kind == .macos else {
            throw VMAdoptionError.invalidConfig("Lume adoption currently supports macOS bundles only")
        }
        let configURL = source.appendingPathComponent("config.json")
        let diskURL = source.appendingPathComponent("disk.img")
        let nvramURL = source.appendingPathComponent("nvram.bin")
        let config: LumeConfig
        do {
            config = try JSONDecoder().decode(LumeConfig.self, from: Data(contentsOf: configURL))
        } catch {
            throw VMAdoptionError.invalidConfig("decode config.json: \(error.localizedDescription)")
        }
        guard let hwB64 = config.hardwareModel, let hwData = Data(base64Encoded: hwB64) else {
            throw VMAdoptionError.invalidConfig("config.json missing base64 hardwareModel")
        }
        guard let midB64 = config.machineIdentifier, let midData = Data(base64Encoded: midB64) else {
            throw VMAdoptionError.invalidConfig("config.json missing base64 machineIdentifier")
        }

        let spec = VMSpec(
            name: name,
            kind: .macos,
            cpu: config.cpuCount ?? 4,
            memorySize: config.memorySize ?? UInt64(8 * 1024 * 1024 * 1024),
            diskSize: config.diskSize ?? UInt64(64 * 1024 * 1024 * 1024),
            image: "latest",
            network: (config.networkMode == "none") ? .none : .nat,
            provider: .lume,
            sourcePath: source.path,
            adoptMode: mode,
            macAddress: config.macAddress
        )
        let bundle = try await registry.create(spec)
        var copied: [String] = []
        do {
            try transfer(diskURL, to: bundle.diskPath, mode: mode); copied.append("Disk.img")
            try transfer(nvramURL, to: bundle.auxStoragePath, mode: mode); copied.append("AuxiliaryStorage")
            try hwData.write(to: bundle.hardwareModelPath, options: .atomic); copied.append("HardwareModel")
            try midData.write(to: bundle.machineIdPath, options: .atomic); copied.append("MachineIdentifier")
        } catch {
            try? await registry.delete(name)
            throw VMAdoptionError.ioFailure("copy Lume bundle files: \(error.localizedDescription)")
        }
        return VMAdoptionResult(spec: spec, bundle: bundle, provider: .lume, copiedFiles: copied)
    }

    private static func adoptAppleVZ(
        source: URL,
        name: String,
        kind: VMKind,
        mode: VMAdoptMode,
        registry: VMRegistry
    ) async throws -> VMAdoptionResult {
        guard kind == .macos else {
            throw VMAdoptionError.invalidConfig("Apple VZ adoption currently supports macOS bundles only")
        }
        let spec = VMSpec(
            name: name,
            kind: .macos,
            cpu: 4,
            memorySize: UInt64(8 * 1024 * 1024 * 1024),
            diskSize: UInt64(64 * 1024 * 1024 * 1024),
            image: "latest",
            provider: .appleVZ,
            sourcePath: source.path,
            adoptMode: mode
        )
        let bundle = try await registry.create(spec)
        let pairs: [(String, URL)] = [
            ("Disk.img", bundle.diskPath),
            ("AuxiliaryStorage", bundle.auxStoragePath),
            ("HardwareModel", bundle.hardwareModelPath),
            ("MachineIdentifier", bundle.machineIdPath),
        ]
        var copied: [String] = []
        do {
            for (filename, dst) in pairs {
                try transfer(source.appendingPathComponent(filename), to: dst, mode: mode)
                copied.append(filename)
            }
        } catch {
            try? await registry.delete(name)
            throw VMAdoptionError.ioFailure("copy Apple VZ bundle files: \(error.localizedDescription)")
        }
        return VMAdoptionResult(spec: spec, bundle: bundle, provider: .appleVZ, copiedFiles: copied)
    }

    private static func transfer(_ src: URL, to dst: URL, mode: VMAdoptMode) throws {
        guard FileManager.default.fileExists(atPath: src.path) else {
            throw VMAdoptionError.missingFile(src.path)
        }
        switch mode {
        case .clone:
            try FileManager.default.copyItem(at: src, to: dst)
        case .move:
            try FileManager.default.moveItem(at: src, to: dst)
        case .reference:
            throw VMAdoptionError.unsupportedMode("reference")
        }
    }
}
