import Foundation
import ApplicationServices
import AppKit

final class MenuDomain: DomainHandler, @unchecked Sendable {
    // route menu-bar AX traversal through the transport and
    // replace the `menuBarValue as! AXUIElement` force casts with codec
    // type-checked downcasts. Behavior unchanged.
    private let transport: any AXTransport

    init(transport: any AXTransport = LiveAXTransport()) {
        self.transport = transport
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "menu":
            if let items = action["items"] as? [String], !items.isEmpty {
                invokeMenu(items: items, action: action, completion: completion)
            } else {
                listMenu(action: action, completion: completion)
            }
        default:
            notImplemented(command, completion: completion)
        }
    }

    // `--app <name>` that matches nothing is an error, not the frontmost app:
    // listing or invoking another app's menu under the requested name is the
    // same wrong-target failure the input verbs refuse.
    private func explicitAppProblem(_ action: [String: Any]) -> String? {
        guard action["pid"] == nil, let appName = action["app"] as? String, !appName.isEmpty,
              RunningApps.resolve(appName) == nil else { return nil }
        return "no running app matches '\(appName)' — names are case-insensitive and accept the .app name or bundle id; 'interceptor macos apps' lists them"
    }

    // Nothing was pressed yet, so the neutral reply is a refusal, not an unknown outcome.
    private func refusal(_ message: String, code: String) -> [String: Any] {
        ["success": false, "code": code, "error": message, "details": ["dispatched": false]]
    }

    private func targetPid(_ action: [String: Any]) -> pid_t {
        if let pid = action["pid"] as? Int32 { return pid }
        if let appName = action["app"] as? String,
           let app = RunningApps.resolve(appName) {
            return app.processIdentifier
        }
        return FrontmostResolver.resolvePID(transport: transport)?.pid ?? 0
    }

    private func listMenu(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let problem = explicitAppProblem(action) {
            completion(refusal(problem, code: "target_gone"))
            return
        }
        if let pid = action["pid"] as? Int32, NSRunningApplication(processIdentifier: pid)?.isTerminated ?? true {
            completion(refusal("no target app found", code: "target_gone"))
            return
        }
        let pid = targetPid(action)
        guard pid != 0 else {
            completion(WireFormat.error("no frontmost app"))
            return
        }

        let appElement = transport.createApplication(pid: pid)
        let (menuBarResult, menuBarValue) = transport.copyAttributeValue(appElement, kAXMenuBarAttribute as String)
        guard menuBarResult == .success, let menuBar = AXValueCodec.asElement(menuBarValue) else {
            completion(refusal("could not read menu bar", code: "unsupported_target"))
            return
        }

        let (childrenResult, childrenValue) = transport.copyAttributeValue(menuBar, kAXChildrenAttribute as String)
        guard childrenResult == .success, let children = childrenValue as? [AXUIElement] else {
            completion(WireFormat.error("could not read menu bar children"))
            return
        }

        var lines: [String] = []
        for menuItem in children {
            let (_, titleValue) = transport.copyAttributeValue(menuItem, kAXTitleAttribute as String)
            let title = AXValueCodec.displayString(titleValue) ?? "(untitled)"
            lines.append(title)

            let (submenuResult, submenuValue) = transport.copyAttributeValue(menuItem, kAXChildrenAttribute as String)
            if submenuResult == .success, let submenus = submenuValue as? [AXUIElement] {
                for submenu in submenus {
                    let (subResult, subChildrenValue) = transport.copyAttributeValue(submenu, kAXChildrenAttribute as String)
                    if subResult == .success, let subChildren = subChildrenValue as? [AXUIElement] {
                        for child in subChildren {
                            let (_, childTitle) = transport.copyAttributeValue(child, kAXTitleAttribute as String)
                            let name = AXValueCodec.displayString(childTitle) ?? ""
                            if !name.isEmpty {
                                lines.append("  \(name)")
                            }
                        }
                    }
                }
            }
        }

        completion(WireFormat.success(lines.joined(separator: "\n")))
    }

    private func invokeMenu(items: [String], action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let problem = explicitAppProblem(action) {
            completion(refusal(problem, code: "target_gone"))
            return
        }
        if let pid = action["pid"] as? Int32, NSRunningApplication(processIdentifier: pid)?.isTerminated ?? true {
            completion(refusal("no target app found", code: "target_gone"))
            return
        }
        let pid = targetPid(action)
        guard pid != 0 else {
            completion(WireFormat.error("no frontmost app"))
            return
        }

        let appElement = transport.createApplication(pid: pid)
        let (menuBarResult, menuBarValue) = transport.copyAttributeValue(appElement, kAXMenuBarAttribute as String)
        guard menuBarResult == .success, let menuBar = AXValueCodec.asElement(menuBarValue) else {
            completion(refusal("could not read menu bar", code: "unsupported_target"))
            return
        }

        var currentElement: AXUIElement = menuBar
        var path = items

        while !path.isEmpty {
            let target = path.removeFirst()
            let (childrenResult, childrenValue) = transport.copyAttributeValue(currentElement, kAXChildrenAttribute as String)
            guard childrenResult == .success, let children = childrenValue as? [AXUIElement] else {
                completion(refusal("could not read the menu items on the way to \(target); nothing was invoked", code: "unsupported_target"))
                return
            }

            var found = false
            for child in children {
                let (_, titleValue) = transport.copyAttributeValue(child, kAXTitleAttribute as String)
                let title = AXValueCodec.displayString(titleValue) ?? ""
                if title == target {
                    if path.isEmpty {
                        _ = transport.performAction(child, kAXPressAction as String)
                        completion(WireFormat.success("invoked menu: \(items.joined(separator: " → "))"))
                        return
                    } else {
                        let (submenuResult, submenuValue) = transport.copyAttributeValue(child, kAXChildrenAttribute as String)
                        if submenuResult == .success,
                           let submenus = submenuValue as? [AXUIElement], let submenu = submenus.first {
                            currentElement = submenu
                        } else {
                            currentElement = child
                        }
                        found = true
                        break
                    }
                }
            }
            if !found {
                completion(refusal("menu item not found: \(target); nothing was invoked", code: "target_gone"))
                return
            }
        }

        completion(refusal("menu path exhausted without finding the target; nothing was invoked", code: "target_gone"))
    }
}
