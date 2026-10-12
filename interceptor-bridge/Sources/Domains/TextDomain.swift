import Foundation
import ApplicationServices
import AppKit

final class TextDomain: DomainHandler, @unchecked Sendable {
    private let refRegistry: RefRegistry
    // route AX calls through the transport + codec (removes the
    // `rangeValue as! AXValue` force cast) and apply central secure redaction so
    // a secure text field never returns its contents (a security correction).
    private let transport: any AXTransport
    private let pidIsLive: (pid_t) -> Bool

    init(refRegistry: RefRegistry = .shared, transport: any AXTransport = LiveAXTransport(),
         pidIsLive: @escaping (pid_t) -> Bool = InputTargetSelector.defaultPidIsLive) {
        self.refRegistry = refRegistry
        self.transport = transport
        self.pidIsLive = pidIsLive
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "text":
            readText(action, completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func readText(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let neutral = action["type"] as? String == "desktop_text"
        guard let ref = action["ref"] as? String else {
            completion(WireFormat.error("text requires a ref"))
            return
        }

        guard let element = refRegistry.resolve(ref) else {
            var error = WireFormat.error("ref \(ref) not found")
            if neutral { error["code"] = "stale_reference" }
            completion(error)
            return
        }

        if neutral {
            let (status, owner) = transport.pid(element)
            // AXUIElementGetPid can still identify a dead process from the
            // retained element. Reuse the input layer's signal-free check.
            guard status == .success, let owner, owner > 0, pidIsLive(owner),
                  refRegistry.resolveInfo(ref)?.pid.map({ $0 == owner }) ?? true else {
                completion(["success": false, "code": "stale_reference", "error": "text reference process identity is unavailable or changed"])
                return
            }
            if let pid = action["pid"] as? Int, pid != Int(owner) {
                completion(["success": false, "code": "unsupported_target", "error": "text reference belongs to a different target process"])
                return
            }
            if let name = action["app"] as? String {
                let matches = NSWorkspace.shared.runningApplications.filter { DefaultAppLauncher.matches($0, name) }
                guard matches.count == 1, matches[0].processIdentifier == owner else {
                    completion(["success": false, "code": matches.count > 1 ? "target_ambiguous" : "unsupported_target", "error": "text reference does not uniquely match the requested application"])
                    return
                }
            }
            if let window = action["window"] as? Int,
               BackgroundInput.windowID(owning: element, transport: transport).map(Int.init) != window {
                completion(["success": false, "code": "unsupported_target", "error": "text reference does not match the requested window"])
                return
            }
        }

        // Secure-field correction: never emit the contents of a password field.
        if AXSecureRedaction.isSecureElement(element, transport: transport) {
            completion(WireFormat.success(AXSecureRedaction.placeholder))
            return
        }

        let mode = action["mode"] as? String ?? "full"

        switch mode {
        case "selection":
            let (result, value) = transport.copyAttributeValue(element, kAXSelectedTextAttribute as String)
            if result == .success, let text = AXValueCodec.displayString(value) {
                completion(WireFormat.success(text))
            } else {
                completion(WireFormat.error("no selected text"))
            }
        case "visible":
            // Try visible character range, then fall back to full value
            let (rangeResult, rangeValue) = transport.copyAttributeValue(element, kAXVisibleCharacterRangeAttribute as String)
            if rangeResult == .success, var range = AXValueCodec.range(from: rangeValue) {
                // Use parameterized attribute to get text for range
                if let rangeVal = AXValueCreate(.cfRange, &range) {
                    let (textResult, textValue) = transport.copyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute as String, rangeVal)
                    if textResult == .success, let text = AXValueCodec.displayString(textValue) {
                        completion(WireFormat.success(text))
                        return
                    }
                }
            }
            // Fallback to full value
            let (fullResult, fullValue) = transport.copyAttributeValue(element, kAXValueAttribute as String)
            if fullResult == .success, let text = AXValueCodec.displayString(fullValue) {
                completion(WireFormat.success(text))
            } else {
                completion(WireFormat.error("no visible text"))
            }
        default: // "full"
            let (result, value) = transport.copyAttributeValue(element, kAXValueAttribute as String)
            if result == .success, let text = AXValueCodec.displayString(value) {
                completion(WireFormat.success(text))
            } else {
                completion(WireFormat.error("no text value"))
            }
        }
    }
}
