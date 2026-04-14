import Foundation
import ApplicationServices

final class TextDomain: DomainHandler, @unchecked Sendable {
    private let refRegistry: RefRegistry

    init(refRegistry: RefRegistry = .shared) {
        self.refRegistry = refRegistry
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
        guard let ref = action["ref"] as? String else {
            completion(WireFormat.error("text requires a ref"))
            return
        }

        guard let element = refRegistry.resolve(ref) else {
            completion(WireFormat.error("ref \(ref) not found"))
            return
        }

        let mode = action["mode"] as? String ?? "full"

        switch mode {
        case "selection":
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &value) == .success,
               let text = value as? String {
                completion(WireFormat.success(text))
            } else {
                completion(WireFormat.error("no selected text"))
            }
        case "visible":
            // Try visible character range, then fall back to full value
            var rangeValue: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXVisibleCharacterRangeAttribute as CFString, &rangeValue) == .success {
                var range = CFRange(location: 0, length: 0)
                AXValueGetValue(rangeValue as! AXValue, .cfRange, &range)
                // Use parameterized attribute to get text for range
                var textValue: CFTypeRef?
                var cfRange = range
                let rangeVal = AXValueCreate(.cfRange, &cfRange)!
                if AXUIElementCopyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute as CFString, rangeVal, &textValue) == .success,
                   let text = textValue as? String {
                    completion(WireFormat.success(text))
                    return
                }
            }
            // Fallback to full value
            var fullValue: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &fullValue) == .success,
               let text = fullValue as? String {
                completion(WireFormat.success(text))
            } else {
                completion(WireFormat.error("no visible text"))
            }
        default: // "full"
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
               let text = value as? String {
                completion(WireFormat.success(text))
            } else {
                completion(WireFormat.error("no text value"))
            }
        }
    }
}
