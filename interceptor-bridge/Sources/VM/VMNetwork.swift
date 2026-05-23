// VMNetwork
//
// Builds a `VZVirtioNetworkDeviceConfiguration` from a VMSpec.
//
// Interceptor ships **NAT only** — `VZNATNetworkDeviceAttachment`
// (apple-developer-docs/Virtualization/VZNATNetworkDeviceAttachment.md).
// NAT requires only `com.apple.security.virtualization`, which the bridge
// already carries.
//
// Bridged + vmnet attachments are intentionally not implemented. They would
// require `com.apple.vm.networking`, which Apple restricts to vetted
// virtualization-software vendors via a private allowlist. If that scope
// ever changes, the path is: re-add the entitlement to
// `scripts/entitlements-bridge.plist`, then layer the additional cases on
// top of this switch.

import Foundation
#if canImport(Virtualization)
import Virtualization
#endif

public enum VMNetworkError: Error, CustomStringConvertible, Sendable {
    case unsupportedMode(String)

    public var description: String {
        switch self {
        case .unsupportedMode(let m): return "network.unsupportedMode: \(m)"
        }
    }
}

public struct VMNetwork: Sendable {
#if canImport(Virtualization)
    /// Builds the network device list for a VMSpec. Returns an empty array
    /// when `network == .none` (e.g. for sandboxed test VMs that should
    /// have no external connectivity).
    @available(macOS 11.0, *)
    public static func buildNetworkDevices(
        for spec: VMSpec
    ) throws -> [VZVirtioNetworkDeviceConfiguration] {
        switch spec.network {
        case .none:
            return []
        case .nat:
            let dev = VZVirtioNetworkDeviceConfiguration()
            if let configured = spec.macAddress, let mac = VZMACAddress(string: configured) {
                dev.macAddress = mac
            } else {
                dev.macAddress = VZMACAddress.randomLocallyAdministered()
            }
            dev.attachment = VZNATNetworkDeviceAttachment()
            return [dev]
        }
    }
#endif
}
