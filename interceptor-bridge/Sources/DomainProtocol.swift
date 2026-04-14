import Foundation

protocol DomainHandler: Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void)
}

extension DomainHandler {
    func notImplemented(_ command: String, completion: @escaping @Sendable ([String: Any]) -> Void) {
        completion(WireFormat.error("\(command) not yet implemented"))
    }
}
