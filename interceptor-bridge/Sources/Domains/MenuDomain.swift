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

    private func targetPid(_ action: [String: Any]) -> pid_t {
        if let pid = action["pid"] as? Int32 { return pid }
        if let appName = action["app"] as? String,
           let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == appName }) {
            return app.processIdentifier
        }
        return FrontmostResolver.resolvePID(transport: transport)?.pid ?? 0
    }

    private func listMenu(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let pid = targetPid(action)
        guard pid != 0 else {
            completion(WireFormat.error("no frontmost app"))
            return
        }

        let appElement = transport.createApplication(pid: pid)
        let (menuBarResult, menuBarValue) = transport.copyAttributeValue(appElement, kAXMenuBarAttribute as String)
        guard menuBarResult == .success, let menuBar = AXValueCodec.asElement(menuBarValue) else {
            completion(WireFormat.error("could not read menu bar"))
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
        let pid = targetPid(action)
        guard pid != 0 else {
            completion(WireFormat.error("no frontmost app"))
            return
        }

        let appElement = transport.createApplication(pid: pid)
        let (menuBarResult, menuBarValue) = transport.copyAttributeValue(appElement, kAXMenuBarAttribute as String)
        guard menuBarResult == .success, let menuBar = AXValueCodec.asElement(menuBarValue) else {
            completion(WireFormat.error("could not read menu bar"))
            return
        }

        var currentElement: AXUIElement = menuBar
        var path = items

        while !path.isEmpty {
            let target = path.removeFirst()
            let (childrenResult, childrenValue) = transport.copyAttributeValue(currentElement, kAXChildrenAttribute as String)
            guard childrenResult == .success, let children = childrenValue as? [AXUIElement] else {
                completion(WireFormat.error("could not traverse menu to: \(target)"))
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
                completion(WireFormat.error("menu item not found: \(target)"))
                return
            }
        }

        completion(WireFormat.error("menu path exhausted without finding target"))
    }
}
