import Foundation
import SpriteKit

// Any overlay view that can accept verb-driven commands from the CLI.
// `perform` must be called on the main thread — OverlayDomain handles that.
@MainActor
protocol OverlayControllable: AnyObject {
    func perform(verb: String, args: [String: Any]) -> [String: Any]
    var supportedVerbs: [String] { get }
    var nativeStatus: [String: Any] { get }
    var hasPendingNativeWork: Bool { get }
    func shutdown()
}

@MainActor
enum OverlayNativeCleanup {
    static func retire(_ node: SKNode) {
        node.isPaused = true
        node.removeAllActions()
        for child in node.children { retire(child) }
        node.removeAllChildren()
    }
}
