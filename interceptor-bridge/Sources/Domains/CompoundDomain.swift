import Foundation
import AppKit

final class CompoundDomain: DomainHandler, @unchecked Sendable {
    private let router: Router

    init(router: Router) {
        self.router = router
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "open":
            handleOpen(action, completion: completion)
        case "read":
            handleRead(action, completion: completion)
        case "act":
            handleAct(action, completion: completion)
        case "inspect":
            handleInspect(action, completion: completion)
        default:
            notImplemented(sub, completion: completion)
        }
    }

    private func handleOpen(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let appName = action["app"] as? String
        if let appName = appName {
            let apps = NSWorkspace.shared.runningApplications
            if let app = apps.first(where: { $0.localizedName == appName }) {
                app.activate()
                usleep(300_000)
            } else {
                NSWorkspace.shared.launchApplication(appName)
                usleep(500_000)
            }
        }

        let filter = action["filter"] as? String ?? "interactive"
        let depth = action["depth"] as? Int ?? 10
        let treeAction: [String: Any] = buildAction("macos_tree", app: appName, extra: ["filter": filter, "depth": depth])

        router.route(action: treeAction) { [router, appName] treeResult in
            let treeData: String = (treeResult["data"] as? String) ?? ""
            let windowsAction: [String: Any] = ["type": "macos_windows"]
            router.route(action: windowsAction) { windowsResult in
                let frontApp = NSWorkspace.shared.frontmostApplication
                completion(WireFormat.success([
                    "tree": treeData,
                    "windows": (windowsResult["data"] as? [[String: Any]]) ?? [] as [[String: Any]],
                    "app": frontApp?.localizedName ?? appName ?? "unknown",
                    "pid": frontApp?.processIdentifier ?? 0
                ]))
            }
        }
    }

    private func handleRead(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let appName = action["app"] as? String
        let filter = action["filter"] as? String ?? "interactive"
        let depth = action["depth"] as? Int ?? 10
        let treeAction = buildAction("macos_tree", app: appName, extra: ["filter": filter, "depth": depth])

        router.route(action: treeAction) { treeResult in
            let frontApp = NSWorkspace.shared.frontmostApplication
            completion(WireFormat.success([
                "tree": treeResult["data"] ?? "",
                "app": frontApp?.localizedName ?? "unknown",
                "pid": frontApp?.processIdentifier ?? 0
            ]))
        }
    }

    private func handleAct(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let ref = action["ref"] as? String ?? ""
        let text = action["text"] as? String
        let appName = action["app"] as? String

        let inputAction: [String: Any]
        if let text = text {
            inputAction = ["type": "macos_type", "ref": ref, "text": text]
        } else {
            inputAction = ["type": "macos_click", "ref": ref]
        }

        router.route(action: inputAction) { [router, ref, text, appName] actionResult in
            guard actionResult["success"] as? Bool == true else {
                completion(actionResult)
                return
            }

            usleep(200_000)

            let treeAction: [String: Any] = ["type": "macos_tree", "filter": "interactive", "depth": 10]
            router.route(action: treeAction) { treeResult in
                completion(WireFormat.success([
                    "action": text != nil ? "typed" : "clicked",
                    "ref": ref,
                    "tree": treeResult["data"] ?? ""
                ]))
            }
        }
    }

    private func handleInspect(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let appName = action["app"] as? String
        let treeAction = buildAction("macos_tree", app: appName, extra: ["filter": "interactive", "depth": 10])

        router.route(action: treeAction) { [router] treeResult in
            let treeData: String = (treeResult["data"] as? String) ?? ""
            let appsAction: [String: Any] = ["type": "macos_apps"]
            router.route(action: appsAction) { appsResult in
                let frontApp = NSWorkspace.shared.frontmostApplication
                completion(WireFormat.success([
                    "tree": treeData,
                    "apps": (appsResult["data"] as? [[String: Any]]) ?? [] as [[String: Any]],
                    "frontmost": [
                        "name": frontApp?.localizedName ?? "unknown",
                        "pid": frontApp?.processIdentifier ?? 0,
                        "bundleId": frontApp?.bundleIdentifier ?? ""
                    ]
                ]))
            }
        }
    }

    private func buildAction(_ type: String, app: String?, extra: [String: Any] = [:]) -> [String: Any] {
        var action: [String: Any] = ["type": type]
        if let app = app { action["app"] = app }
        for (k, v) in extra { action[k] = v }
        return action
    }
}
