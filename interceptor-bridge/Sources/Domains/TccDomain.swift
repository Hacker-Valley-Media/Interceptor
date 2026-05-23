import Foundation

enum TccGrantStatus: String, Sendable {
    case grantable
    case userOnly = "user_only"
    case unsupported
}

struct TccServiceRule: Sendable {
    let service: String
    let status: TccGrantStatus
    let defaultEnabled: Bool
    let note: String
}

struct TccProfileGenerator: Sendable {
    static let rules: [TccServiceRule] = [
        TccServiceRule(service: "Accessibility", status: .grantable, defaultEnabled: true, note: "AX tree reads and AX actions; profile grant is deprecated by Apple as of macOS 26.2 and scheduled for removal in macOS 27.0."),
        TccServiceRule(service: "PostEvent", status: .grantable, defaultEnabled: true, note: "CoreGraphics event posting."),
        TccServiceRule(service: "AppleEvents", status: .grantable, defaultEnabled: false, note: "Grantable only for explicit sender/receiver pairs; receiver metadata is required for a valid production payload."),
        TccServiceRule(service: "SystemPolicyAllFiles", status: .grantable, defaultEnabled: false, note: "Full Disk Access. Generate only in high-trust mode."),
        TccServiceRule(service: "SystemPolicyAppBundles", status: .grantable, defaultEnabled: false, note: "Allows supported installer/updater workflows to modify app bundles."),
        TccServiceRule(service: "SystemPolicyDesktopFolder", status: .grantable, defaultEnabled: false, note: "Desktop folder access."),
        TccServiceRule(service: "SystemPolicyDocumentsFolder", status: .grantable, defaultEnabled: false, note: "Documents folder access."),
        TccServiceRule(service: "SystemPolicyDownloadsFolder", status: .grantable, defaultEnabled: false, note: "Downloads folder access."),
        TccServiceRule(service: "SystemPolicyRemovableVolumes", status: .grantable, defaultEnabled: false, note: "Removable volume access."),
        TccServiceRule(service: "SystemPolicyNetworkVolumes", status: .grantable, defaultEnabled: false, note: "Network volume access."),
        TccServiceRule(service: "ScreenCapture", status: .userOnly, defaultEnabled: false, note: "Apple DeviceManagement docs say this service cannot be granted by profile; it can only be denied."),
        TccServiceRule(service: "ListenEvent", status: .userOnly, defaultEnabled: false, note: "Apple DeviceManagement docs say this service cannot be granted by profile; it can only be denied."),
        TccServiceRule(service: "Camera", status: .userOnly, defaultEnabled: false, note: "Apple DeviceManagement docs say camera access cannot be granted by profile; it can only be denied."),
        TccServiceRule(service: "Microphone", status: .userOnly, defaultEnabled: false, note: "Apple DeviceManagement docs say microphone access cannot be granted by profile; it can only be denied."),
    ]

    static func rule(for service: String) -> TccServiceRule? {
        rules.first { $0.service.caseInsensitiveCompare(service) == .orderedSame }
    }

    static func defaultServices(fullDisk: Bool) -> [String] {
        var services = rules
            .filter { $0.defaultEnabled && $0.status == .grantable }
            .map(\.service)
        if fullDisk {
            services.append("SystemPolicyAllFiles")
        }
        return services
    }

    static func serviceMatrix() -> [[String: Any]] {
        rules.map {
            [
                "service": $0.service,
                "profileGrantStatus": $0.status.rawValue,
                "defaultEnabled": $0.defaultEnabled,
                "note": $0.note,
            ]
        }
    }

    static func generateProfile(
        target: String,
        bundleId: String,
        appPath: String?,
        identifierType: String,
        codeRequirement: String,
        requestedServices: [String],
        includeUserOnly: Bool
    ) throws -> (xml: String, included: [[String: Any]], skipped: [[String: Any]]) {
        var included: [[String: Any]] = []
        var skipped: [[String: Any]] = []
        var servicesDict: [String: Any] = [:]

        for rawService in requestedServices {
            guard let rule = rule(for: rawService) else {
                skipped.append(["service": rawService, "reason": "unknown_service"])
                continue
            }
            guard rule.status == .grantable else {
                skipped.append([
                    "service": rule.service,
                    "reason": "not_profile_grantable",
                    "note": rule.note,
                ])
                continue
            }

            if rule.service == "AppleEvents" {
                skipped.append([
                    "service": rule.service,
                    "reason": "receiver_required",
                    "note": rule.note,
                ])
                continue
            }

            let identity = identityPayload(
                service: rule.service,
                bundleId: bundleId,
                appPath: appPath,
                identifierType: identifierType,
                codeRequirement: codeRequirement
            )
            servicesDict[rule.service] = [identity]
            included.append([
                "service": rule.service,
                "profileGrantStatus": rule.status.rawValue,
                "note": rule.note,
            ])
        }

        if includeUserOnly {
            for rule in rules where rule.status == .userOnly {
                if !skipped.contains(where: { ($0["service"] as? String) == rule.service }) {
                    skipped.append([
                        "service": rule.service,
                        "reason": "not_profile_grantable",
                        "note": rule.note,
                    ])
                }
            }
        }

        let payloadIdBase = "com.interceptor.tcc.\(target)"
        let tccPayload: [String: Any] = [
            "PayloadType": "com.apple.TCC.configuration-profile-policy",
            "PayloadVersion": 1,
            "PayloadIdentifier": "\(payloadIdBase).pppc",
            "PayloadUUID": UUID().uuidString,
            "PayloadDisplayName": "Interceptor Privacy Preferences Policy Control",
            "Services": servicesDict,
        ]

        let profile: [String: Any] = [
            "PayloadType": "Configuration",
            "PayloadVersion": 1,
            "PayloadIdentifier": payloadIdBase,
            "PayloadUUID": UUID().uuidString,
            "PayloadDisplayName": target == "guest" ? "InterceptorD Guest TCC" : "Interceptor Host TCC",
            "PayloadContent": [tccPayload],
        ]

        let data = try PropertyListSerialization.data(fromPropertyList: profile, format: .xml, options: 0)
        guard let xml = String(data: data, encoding: .utf8) else {
            throw TccDomainError.profileEncodingFailed
        }
        return (xml, included, skipped)
    }

    private static func identityPayload(
        service: String,
        bundleId: String,
        appPath: String?,
        identifierType: String,
        codeRequirement: String
    ) -> [String: Any] {
        let identifier = identifierType == "path" ? (appPath ?? bundleId) : bundleId
        return [
            "Allowed": true,
            "CodeRequirement": codeRequirement,
            "Comment": "Allow \(service) for Interceptor",
            "Identifier": identifier,
            "IdentifierType": identifierType,
        ]
    }
}

enum TccDomainError: Error, CustomStringConvertible {
    case profileEncodingFailed

    var description: String {
        switch self {
        case .profileEncodingFailed:
            return "tcc.profileEncodingFailed"
        }
    }
}

final class TccDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "status":
            completion(WireFormat.success(statusPayload(target: (action["target"] as? String) ?? "host")))
        case "profile_generate":
            generateProfile(action: action, completion: completion)
        default:
            completion(WireFormat.error("tcc: unknown verb '\(sub)'"))
        }
    }

    private func statusPayload(target: String) -> [String: Any] {
        let enrollment = mdmEnrollmentStatus()
        return [
            "target": target,
            "bundleId": defaultBundleId(),
            "bundlePath": Bundle.main.bundlePath,
            "mdm": enrollment,
            "silentProfileDeploymentAvailable": (enrollment["userApprovedMdm"] as? Bool ?? false) || (enrollment["automatedDeviceEnrollment"] as? Bool ?? false),
            "serviceMatrix": TccProfileGenerator.serviceMatrix(),
        ]
    }

    private func generateProfile(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let target = (action["target"] as? String) ?? "host"
        let fullDisk = action["fullDisk"] as? Bool ?? false
        let includeUserOnly = action["includeUserOnly"] as? Bool ?? false
        let bundleId = (action["bundleId"] as? String) ?? defaultBundleId()
        let appPath = action["appPath"] as? String ?? Bundle.main.bundlePath
        let identifierType = (action["identifierType"] as? String) ?? "bundleID"
        let requestedServices = (action["services"] as? [String]).flatMap { $0.isEmpty ? nil : $0 }
            ?? TccProfileGenerator.defaultServices(fullDisk: fullDisk)
        let codeRequirement = (action["codeRequirement"] as? String)
            ?? designatedRequirement(for: appPath)
            ?? "identifier \(bundleId)"

        do {
            let generated = try TccProfileGenerator.generateProfile(
                target: target,
                bundleId: bundleId,
                appPath: appPath,
                identifierType: identifierType,
                codeRequirement: codeRequirement,
                requestedServices: requestedServices,
                includeUserOnly: includeUserOnly
            )

            var result: [String: Any] = [
                "target": target,
                "bundleId": bundleId,
                "appPath": appPath,
                "identifierType": identifierType,
                "codeRequirement": codeRequirement,
                "included": generated.included,
                "skipped": generated.skipped,
                "requiresUserApprovedMdm": true,
                "mdm": mdmEnrollmentStatus(),
            ]

            if let out = action["out"] as? String, !out.isEmpty {
                let url = URL(fileURLWithPath: (out as NSString).expandingTildeInPath)
                try generated.xml.write(to: url, atomically: true, encoding: .utf8)
                result["path"] = url.path
            } else {
                result["profile"] = generated.xml
            }

            completion(WireFormat.success(result))
        } catch {
            completion(WireFormat.error("tcc profile generate: \(error)"))
        }
    }

    private func defaultBundleId() -> String {
        Bundle.main.bundleIdentifier ?? "com.interceptor.bridge"
    }

    private func designatedRequirement(for path: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        let output = runProcess("/usr/bin/codesign", args: ["-dr", "-", path])
        let text = [output.stdout, output.stderr].joined(separator: "\n")
        guard let markerRange = text.range(of: "designated =>") else {
            return nil
        }
        let req = text[markerRange.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        return req.isEmpty ? nil : req
    }

    private func mdmEnrollmentStatus() -> [String: Any] {
        let output = runProcess("/usr/bin/profiles", args: ["status", "-type", "enrollment"])
        let combined = [output.stdout, output.stderr].joined(separator: "\n")
        let lower = combined.lowercased()
        return [
            "checked": true,
            "command": "/usr/bin/profiles status -type enrollment",
            "exitCode": output.exitCode,
            "enrolled": lower.contains("mdm enrollment: yes") || lower.contains("enrolled via dep: yes"),
            "userApprovedMdm": lower.contains("user approved: yes"),
            "automatedDeviceEnrollment": lower.contains("enrolled via dep: yes") || lower.contains("enrolled via ade: yes"),
            "raw": combined.trimmingCharacters(in: .whitespacesAndNewlines),
        ]
    }

    private func runProcess(_ executable: String, args: [String]) -> (exitCode: Int32, stdout: String, stderr: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return (-1, "", error.localizedDescription)
        }
        let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (process.terminationStatus, stdout, stderr)
    }
}
