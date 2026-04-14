import Foundation
import ApplicationServices
import AppKit

final class MenuDomain: DomainHandler, @unchecked Sendable {
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

    private func frontmostPid(_ action: [String: Any]) -> pid_t {
        if let pid = action["pid"] as? Int32 { return pid }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    }

    private func listMenu(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let pid = frontmostPid(action)
        guard pid != 0 else {
            completion(WireFormat.error("no frontmost app"))
            return
        }

        let appElement = AXUIElementCreateApplication(pid)
        var menuBarValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXMenuBarAttribute as CFString, &menuBarValue) == .success else {
            completion(WireFormat.error("could not read menu bar"))
            return
        }
        let menuBar = menuBarValue as! AXUIElement

        var childrenValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(menuBar, kAXChildrenAttribute as CFString, &childrenValue) == .success,
              let children = childrenValue as? [AXUIElement] else {
            completion(WireFormat.error("could not read menu bar children"))
            return
        }

        var lines: [String] = []
        for menuItem in children {
            var titleValue: CFTypeRef?
            AXUIElementCopyAttributeValue(menuItem, kAXTitleAttribute as CFString, &titleValue)
            let title = titleValue as? String ?? "(untitled)"
            lines.append(title)

            var submenuValue: CFTypeRef?
            if AXUIElementCopyAttributeValue(menuItem, kAXChildrenAttribute as CFString, &submenuValue) == .success,
               let submenus = submenuValue as? [AXUIElement] {
                for submenu in submenus {
                    var subChildrenValue: CFTypeRef?
                    if AXUIElementCopyAttributeValue(submenu, kAXChildrenAttribute as CFString, &subChildrenValue) == .success,
                       let subChildren = subChildrenValue as? [AXUIElement] {
                        for child in subChildren {
                            var childTitle: CFTypeRef?
                            AXUIElementCopyAttributeValue(child, kAXTitleAttribute as CFString, &childTitle)
                            let name = childTitle as? String ?? ""
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
        let pid = frontmostPid(action)
        guard pid != 0 else {
            completion(WireFormat.error("no frontmost app"))
            return
        }

        let appElement = AXUIElementCreateApplication(pid)
        var menuBarValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXMenuBarAttribute as CFString, &menuBarValue) == .success else {
            completion(WireFormat.error("could not read menu bar"))
            return
        }

        var currentElement: AXUIElement = menuBarValue as! AXUIElement
        var path = items

        while !path.isEmpty {
            let target = path.removeFirst()
            var childrenValue: CFTypeRef?
            guard AXUIElementCopyAttributeValue(currentElement, kAXChildrenAttribute as CFString, &childrenValue) == .success,
                  let children = childrenValue as? [AXUIElement] else {
                completion(WireFormat.error("could not traverse menu to: \(target)"))
                return
            }

            var found = false
            for child in children {
                var titleValue: CFTypeRef?
                AXUIElementCopyAttributeValue(child, kAXTitleAttribute as CFString, &titleValue)
                let title = titleValue as? String ?? ""
                if title == target {
                    if path.isEmpty {
                        AXUIElementPerformAction(child, kAXPressAction as CFString)
                        completion(WireFormat.success("invoked menu: \(items.joined(separator: " → "))"))
                        return
                    } else {
                        var submenuValue: CFTypeRef?
                        if AXUIElementCopyAttributeValue(child, kAXChildrenAttribute as CFString, &submenuValue) == .success,
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
