// MacRuntime
//
// Raw Virtualization framework wrapper for macOS-on-macOS guests. Drops
// the entire Apple sample recipe from
// `apple-developer-docs/Virtualization/running-macos-in-a-virtual-machine-on-apple-silicon.md`
// and `apple-developer-docs/Virtualization/installing-macos-on-a-virtual-machine.md:14-46`
// into one type that VMInstance owns.
//
// Apple's container project does NOT support macOS guests (verified by
// `rg 'VZMacOSInstaller' research/container/Sources` → no matches), so
// MacRuntime drives VZMacOSInstaller directly. Bundle layout follows
// Apple's `VM.bundle` spec: Disk.img, AuxiliaryStorage, MachineIdentifier,
// HardwareModel, RestoreImage.ipsw.

import Foundation
#if canImport(Virtualization)
import Virtualization
#endif

public enum MacRuntimeError: Error, CustomStringConvertible, Sendable {
    case configRequirementsNil(String)
    case installFailed(String)
    case startFailed(String)
    case stopFailed(String)
    case diskCreateFailed(String)
    case missingFile(String)
    case unsupportedHost(String)

    public var description: String {
        switch self {
        case .configRequirementsNil(let m): return "macruntime.configRequirementsNil: \(m)"
        case .installFailed(let m): return "macruntime.installFailed: \(m)"
        case .startFailed(let m): return "macruntime.startFailed: \(m)"
        case .stopFailed(let m): return "macruntime.stopFailed: \(m)"
        case .diskCreateFailed(let m): return "macruntime.diskCreateFailed: \(m)"
        case .missingFile(let m): return "macruntime.missingFile: \(m)"
        case .unsupportedHost(let m): return "macruntime.unsupportedHost: \(m)"
        }
    }
}

#if canImport(Virtualization)
/// Holder for a running macOS VM. Created by `MacRuntime.run(...)` once
/// install has completed (or skipped, if a prior install put the bundle
/// on disk).
@available(macOS 13.0, *)
public final class MacRunningVM: @unchecked Sendable {
    public let vm: VZVirtualMachine
    public let queue: DispatchQueue
    public let delegate: MacVMDelegate
    public let macAddress: String?

    init(vm: VZVirtualMachine, queue: DispatchQueue, delegate: MacVMDelegate, macAddress: String?) {
        self.vm = vm
        self.queue = queue
        self.delegate = delegate
        self.macAddress = macAddress
    }
}

/// VZVirtualMachineDelegate that surfaces stop / failure events to the
/// VMInstance via a continuation channel.
@available(macOS 13.0, *)
public final class MacVMDelegate: NSObject, VZVirtualMachineDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var stopCallback: ((Error?) -> Void)?

    public func onStop(_ cb: @escaping (Error?) -> Void) {
        lock.lock(); stopCallback = cb; lock.unlock()
    }

    public func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        lock.lock(); let cb = stopCallback; stopCallback = nil; lock.unlock()
        cb?(nil)
    }

    public func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        lock.lock(); let cb = stopCallback; stopCallback = nil; lock.unlock()
        cb?(error)
    }
}
#endif

public struct MacRuntime: Sendable {

#if canImport(Virtualization)
    /// Install macOS into `bundle` using the restore image at `ipswURL`.
    /// Steps from
    /// `apple-developer-docs/Virtualization/installing-macos-on-a-virtual-machine.md`:
    ///   1. Load VZMacOSRestoreImage from local URL.
    ///   2. Pick the most-featureful hardware model.
    ///   3. Create VZMacAuxiliaryStorage with that hardware model.
    ///   4. Create VZMacPlatformConfiguration (hardwareModel + auxiliaryStorage + machineIdentifier).
    ///   5. Create a VZVirtualMachineConfiguration with the platform + boot loader +
    ///      disk (block-device attachment), validate, and create the VM.
    ///   6. Run VZMacOSInstaller.install() and await completion.
    @available(macOS 13.0, *)
    public static func install(
        spec: VMSpec,
        bundle: VMBundle,
        ipswURL: URL
    ) async throws {
        // Step 1: load the restore image.
        let restore: VZMacOSRestoreImage
        do {
            restore = try await VZMacOSRestoreImage.image(from: ipswURL)
        } catch {
            throw MacRuntimeError.missingFile("VZMacOSRestoreImage.image(\(ipswURL.path)): \(error.localizedDescription)")
        }

        // Step 2: pick the configuration requirements for the host.
        guard let reqs = restore.mostFeaturefulSupportedConfiguration else {
            throw MacRuntimeError.unsupportedHost("host supports none of the hardware models in this IPSW")
        }

        // Bump cpu/memory to the minimums the requirements demand if the
        // spec asked for less.
        let cpu = max(spec.cpu, reqs.minimumSupportedCPUCount)
        let memory = max(spec.memorySize, reqs.minimumSupportedMemorySize)

        // Step 3: AuxiliaryStorage (create new, sized by the hardware model).
        if FileManager.default.fileExists(atPath: bundle.auxStoragePath.path) {
            try? FileManager.default.removeItem(at: bundle.auxStoragePath)
        }
        do {
            _ = try VZMacAuxiliaryStorage(
                creatingStorageAt: bundle.auxStoragePath,
                hardwareModel: reqs.hardwareModel,
                options: []
            )
        } catch {
            throw MacRuntimeError.installFailed("VZMacAuxiliaryStorage create: \(error.localizedDescription)")
        }

        // Persist HardwareModel and MachineIdentifier so subsequent boots
        // (and clones) reuse the same identity.
        try (reqs.hardwareModel.dataRepresentation).write(to: bundle.hardwareModelPath, options: .atomic)
        let machineId = VZMacMachineIdentifier()
        try machineId.dataRepresentation.write(to: bundle.machineIdPath, options: .atomic)

        // Step 4: VZMacPlatformConfiguration
        let platform = VZMacPlatformConfiguration()
        platform.hardwareModel = reqs.hardwareModel
        platform.machineIdentifier = machineId
        let aux: VZMacAuxiliaryStorage
        do {
            aux = try VZMacAuxiliaryStorage(contentsOf: bundle.auxStoragePath)
        } catch {
            throw MacRuntimeError.installFailed("VZMacAuxiliaryStorage reload: \(error.localizedDescription)")
        }
        platform.auxiliaryStorage = aux

        // Step 5: Create Disk.img if not present.
        if !FileManager.default.fileExists(atPath: bundle.diskPath.path) {
            try createSparseDisk(at: bundle.diskPath, size: spec.diskSize)
        }
        let attachment: VZDiskImageStorageDeviceAttachment
        do {
            attachment = try VZDiskImageStorageDeviceAttachment(url: bundle.diskPath, readOnly: false)
        } catch {
            throw MacRuntimeError.installFailed("VZDiskImageStorageDeviceAttachment: \(error.localizedDescription)")
        }
        let blockDevice = VZVirtioBlockDeviceConfiguration(attachment: attachment)

        let config = VZVirtualMachineConfiguration()
        config.platform = platform
        config.bootLoader = VZMacOSBootLoader()
        config.cpuCount = cpu
        config.memorySize = memory
        config.storageDevices = [blockDevice]
        // Minimal networking + graphics for install. Real spec gets
        // applied during `run()`.
        if let networkDev = try? VMNetwork.buildNetworkDevices(for: spec) {
            config.networkDevices = networkDev
        }
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]

        do { try config.validate() }
        catch { throw MacRuntimeError.installFailed("VZVirtualMachineConfiguration.validate: \(error.localizedDescription)") }

        // Step 6: Run the installer.
        let queue = DispatchQueue(label: "interceptor.vm.\(spec.name).install")
        let vm = VZVirtualMachine(configuration: config, queue: queue)
        let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: ipswURL)
        try await withCheckedThrowingContinuation { (cc: CheckedContinuation<Void, Error>) in
            installer.install { result in
                switch result {
                case .success:
                    cc.resume(returning: ())
                case .failure(let err):
                    cc.resume(throwing: MacRuntimeError.installFailed("VZMacOSInstaller.install: \(err.localizedDescription)"))
                }
            }
        }
    }

    /// Run an already-installed macOS guest. Returns a `MacRunningVM`
    /// holding the live `VZVirtualMachine`. Caller awaits `vm.start()`.
    @available(macOS 13.0, *)
    public static func run(
        spec: VMSpec,
        bundle: VMBundle,
        headless: Bool
    ) async throws -> MacRunningVM {
        // Reload platform from disk.
        let hwData = try Data(contentsOf: bundle.hardwareModelPath)
        guard let hw = VZMacHardwareModel(dataRepresentation: hwData) else {
            throw MacRuntimeError.missingFile("HardwareModel data is invalid")
        }
        let midData = try Data(contentsOf: bundle.machineIdPath)
        guard let mid = VZMacMachineIdentifier(dataRepresentation: midData) else {
            throw MacRuntimeError.missingFile("MachineIdentifier data is invalid")
        }
        let aux: VZMacAuxiliaryStorage
        do {
            aux = try VZMacAuxiliaryStorage(contentsOf: bundle.auxStoragePath)
        } catch {
            throw MacRuntimeError.missingFile("AuxiliaryStorage reload: \(error.localizedDescription)")
        }
        let platform = VZMacPlatformConfiguration()
        platform.hardwareModel = hw
        platform.machineIdentifier = mid
        platform.auxiliaryStorage = aux

        let attachment: VZDiskImageStorageDeviceAttachment
        do {
            attachment = try VZDiskImageStorageDeviceAttachment(url: bundle.diskPath, readOnly: false)
        } catch {
            throw MacRuntimeError.startFailed("VZDiskImageStorageDeviceAttachment: \(error.localizedDescription)")
        }
        let blockDevice = VZVirtioBlockDeviceConfiguration(attachment: attachment)

        let config = VZVirtualMachineConfiguration()
        config.platform = platform
        config.bootLoader = VZMacOSBootLoader()
        config.cpuCount = max(spec.cpu, 1)
        config.memorySize = spec.memorySize
        config.storageDevices = [blockDevice]
        let networkDevices = (try? VMNetwork.buildNetworkDevices(for: spec)) ?? []
        config.networkDevices = networkDevices
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]  // for guest agent
        if let shares = try? VMShare.buildDirectorySharingDevices(for: spec) {
            config.directorySharingDevices = shares
        }
        // Graphics: only attach when not headless (to allow framebuffer capture).
        if !headless {
            let graphics = VZMacGraphicsDeviceConfiguration()
            graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1920, heightInPixels: 1080, pixelsPerInch: 220)]
            config.graphicsDevices = [graphics]
            config.keyboards = [VZMacKeyboardConfiguration()]
            config.pointingDevices = [VZMacTrackpadConfiguration()]
        }

        do { try config.validate() }
        catch { throw MacRuntimeError.startFailed("VZVirtualMachineConfiguration.validate: \(error.localizedDescription)") }

        let queue = DispatchQueue(label: "interceptor.vm.\(spec.name).run")
        let vm = VZVirtualMachine(configuration: config, queue: queue)
        let delegate = MacVMDelegate()
        vm.delegate = delegate

        return MacRunningVM(vm: vm, queue: queue, delegate: delegate, macAddress: networkDevices.first?.macAddress.string)
    }

    /// Create a sparse-file-backed disk image of the given size. The
    /// truncate-to-size trick is how Apple's own macOSVirtualMachineSampleApp
    /// does it.
    static func createSparseDisk(at url: URL, size: UInt64) throws {
        FileManager.default.createFile(atPath: url.path, contents: nil, attributes: nil)
        let handle: FileHandle
        do { handle = try FileHandle(forWritingTo: url) }
        catch { throw MacRuntimeError.diskCreateFailed("open Disk.img: \(error.localizedDescription)") }
        do {
            try handle.truncate(atOffset: size)
            try handle.close()
        } catch {
            throw MacRuntimeError.diskCreateFailed("truncate Disk.img to \(size): \(error.localizedDescription)")
        }
    }
#endif
}
