import Foundation
import CoreGraphics
import AppKit

final class DisplayDomain: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var virtualDisplays: [String: VirtualDisplayContext] = [:]

    struct VirtualDisplayContext {
        let display: AnyObject
        let displayID: CGDirectDisplayID
        let width: Int
        let height: Int
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "list":
            listDisplays(completion: completion)
        case "create":
            createVirtualDisplay(action, completion: completion)
        case "remove":
            removeVirtualDisplay(action, completion: completion)
        case "info":
            displayInfo(action, completion: completion)
        case "move-window":
            moveWindow(action, completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func listDisplays(completion: @escaping @Sendable ([String: Any]) -> Void) {
        var displays: [[String: Any]] = []
        let maxDisplays: UInt32 = 16
        var displayIDs = [CGDirectDisplayID](repeating: 0, count: Int(maxDisplays))
        var displayCount: UInt32 = 0
        CGGetActiveDisplayList(maxDisplays, &displayIDs, &displayCount)

        for i in 0..<Int(displayCount) {
            let id = displayIDs[i]
            let bounds = CGDisplayBounds(id)
            let isVirtual = lock.withLock { virtualDisplays.values.contains { $0.displayID == id } }
            displays.append([
                "id": id,
                "width": Int(bounds.width),
                "height": Int(bounds.height),
                "x": Int(bounds.origin.x),
                "y": Int(bounds.origin.y),
                "isMain": CGDisplayIsMain(id) != 0,
                "isBuiltin": CGDisplayIsBuiltin(id) != 0,
                "isVirtual": isVirtual
            ])
        }
        completion(WireFormat.success(displays))
    }

    private func createVirtualDisplay(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        // Parse resolution from action (e.g., "1920x1080" or width/height params)
        var width = action["width"] as? Int ?? 1920
        var height = action["height"] as? Int ?? 1080
        let hiDPI = action["hidpi"] as? Bool ?? false
        let refreshRate = action["hz"] as? Double ?? 60.0

        if let resolution = action["resolution"] as? String {
            let parts = resolution.lowercased().split(separator: "x")
            if parts.count == 2, let w = Int(parts[0]), let h = Int(parts[1]) {
                width = w
                height = h
            }
        }

        // Load private API classes at runtime
        guard let displayClass = NSClassFromString("CGVirtualDisplay"),
              let descriptorClass = NSClassFromString("CGVirtualDisplayDescriptor"),
              let settingsClass = NSClassFromString("CGVirtualDisplaySettings"),
              let modeClass = NSClassFromString("CGVirtualDisplayMode") else {
            completion(WireFormat.error("CGVirtualDisplay private APIs not available on this macOS version"))
            return
        }

        // Create display mode
        let modeObj: AnyObject
        do {
            let allocSel = NSSelectorFromString("alloc")
            guard let allocated = (modeClass as AnyObject).perform(allocSel)?.takeUnretainedValue() else {
                completion(WireFormat.error("failed to allocate CGVirtualDisplayMode"))
                return
            }

            let initSel = NSSelectorFromString("initWithWidth:height:refreshRate:")
            guard (allocated as AnyObject).responds(to: initSel) else {
                completion(WireFormat.error("CGVirtualDisplayMode missing initWithWidth:height:refreshRate:"))
                return
            }

            typealias InitModeIMP = @convention(c) (AnyObject, Selector, UInt32, UInt32, Double) -> Unmanaged<AnyObject>
            let imp = (allocated as AnyObject).method(for: initSel)
            let initMode = unsafeBitCast(imp, to: InitModeIMP.self)
            modeObj = initMode(allocated as AnyObject, initSel, UInt32(width), UInt32(height), refreshRate).takeRetainedValue()
        }

        // Create descriptor
        let descriptorObj: AnyObject
        do {
            guard let allocated = (descriptorClass as AnyObject).perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() else {
                completion(WireFormat.error("failed to allocate descriptor"))
                return
            }
            guard let inited = (allocated as AnyObject).perform(NSSelectorFromString("init"))?.takeUnretainedValue() else {
                completion(WireFormat.error("failed to init descriptor"))
                return
            }
            descriptorObj = inited

            // Set queue
            let setQueueSel = NSSelectorFromString("setQueue:")
            if (descriptorObj as AnyObject).responds(to: setQueueSel) {
                typealias SetQueueIMP = @convention(c) (AnyObject, Selector, DispatchQueue) -> Void
                let imp = (descriptorObj as AnyObject).method(for: setQueueSel)
                let setQueue = unsafeBitCast(imp, to: SetQueueIMP.self)
                setQueue(descriptorObj, setQueueSel, DispatchQueue.main)
            }

            // Set display name
            let setNameSel = NSSelectorFromString("setName:")
            if (descriptorObj as AnyObject).responds(to: setNameSel) {
                _ = (descriptorObj as AnyObject).perform(setNameSel, with: "Interceptor Virtual Display" as NSString)
            }

            // Set vendor & product ID
            let setVendorSel = NSSelectorFromString("setVendorID:")
            if (descriptorObj as AnyObject).responds(to: setVendorSel) {
                typealias SetUInt32IMP = @convention(c) (AnyObject, Selector, UInt32) -> Void
                let imp = (descriptorObj as AnyObject).method(for: setVendorSel)
                let setVendor = unsafeBitCast(imp, to: SetUInt32IMP.self)
                setVendor(descriptorObj, setVendorSel, 0x1234)
            }
            let setProductSel = NSSelectorFromString("setProductID:")
            if (descriptorObj as AnyObject).responds(to: setProductSel) {
                typealias SetUInt32IMP = @convention(c) (AnyObject, Selector, UInt32) -> Void
                let imp = (descriptorObj as AnyObject).method(for: setProductSel)
                let setProduct = unsafeBitCast(imp, to: SetUInt32IMP.self)
                setProduct(descriptorObj, setProductSel, 0xE000)
            }

            // Set max pixel dimensions
            let setMaxWidthSel = NSSelectorFromString("setMaxPixelsWide:")
            if (descriptorObj as AnyObject).responds(to: setMaxWidthSel) {
                typealias SetUInt32IMP = @convention(c) (AnyObject, Selector, UInt32) -> Void
                let imp = (descriptorObj as AnyObject).method(for: setMaxWidthSel)
                let setMaxWidth = unsafeBitCast(imp, to: SetUInt32IMP.self)
                setMaxWidth(descriptorObj, setMaxWidthSel, UInt32(width * (hiDPI ? 2 : 1)))
            }
            let setMaxHeightSel = NSSelectorFromString("setMaxPixelsHigh:")
            if (descriptorObj as AnyObject).responds(to: setMaxHeightSel) {
                typealias SetUInt32IMP = @convention(c) (AnyObject, Selector, UInt32) -> Void
                let imp = (descriptorObj as AnyObject).method(for: setMaxHeightSel)
                let setMaxHeight = unsafeBitCast(imp, to: SetUInt32IMP.self)
                setMaxHeight(descriptorObj, setMaxHeightSel, UInt32(height * (hiDPI ? 2 : 1)))
            }
        }

        // Create virtual display
        guard let displayAllocated = (displayClass as AnyObject).perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() else {
            completion(WireFormat.error("failed to allocate CGVirtualDisplay"))
            return
        }

        let initWithDescSel = NSSelectorFromString("initWithDescriptor:")
        guard (displayAllocated as AnyObject).responds(to: initWithDescSel),
              let display = (displayAllocated as AnyObject).perform(initWithDescSel, with: descriptorObj)?.takeUnretainedValue() else {
            completion(WireFormat.error("failed to init CGVirtualDisplay with descriptor"))
            return
        }

        // Create and apply settings with mode
        guard let settingsAllocated = (settingsClass as AnyObject).perform(NSSelectorFromString("alloc"))?.takeUnretainedValue(),
              let settings = (settingsAllocated as AnyObject).perform(NSSelectorFromString("init"))?.takeUnretainedValue() else {
            completion(WireFormat.error("failed to create settings"))
            return
        }

        // Set modes array
        let setModesSel = NSSelectorFromString("setModes:")
        if (settings as AnyObject).responds(to: setModesSel) {
            _ = (settings as AnyObject).perform(setModesSel, with: [modeObj] as NSArray)
        }

        // Set HiDPI
        let setHiDPISel = NSSelectorFromString("setHiDPI:")
        if (settings as AnyObject).responds(to: setHiDPISel) {
            typealias SetUInt32IMP = @convention(c) (AnyObject, Selector, UInt32) -> Void
            let imp = (settings as AnyObject).method(for: setHiDPISel)
            let setHiDPI = unsafeBitCast(imp, to: SetUInt32IMP.self)
            setHiDPI(settings, setHiDPISel, hiDPI ? 2 : 0)
        }

        // Apply settings
        let applySel = NSSelectorFromString("applySettings:")
        guard (display as AnyObject).responds(to: applySel) else {
            completion(WireFormat.error("CGVirtualDisplay missing applySettings:"))
            return
        }

        typealias ApplySettingsIMP = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
        let applyIMP = (display as AnyObject).method(for: applySel)
        let applySettings = unsafeBitCast(applyIMP, to: ApplySettingsIMP.self)
        let applied = applySettings(display, applySel, settings)

        guard applied else {
            completion(WireFormat.error("failed to apply settings to virtual display"))
            return
        }

        // Get display ID
        let displayIDSel = NSSelectorFromString("displayID")
        var displayID: CGDirectDisplayID = 0
        if (display as AnyObject).responds(to: displayIDSel) {
            typealias GetDisplayIDIMP = @convention(c) (AnyObject, Selector) -> UInt32
            let imp = (display as AnyObject).method(for: displayIDSel)
            let getID = unsafeBitCast(imp, to: GetDisplayIDIMP.self)
            displayID = getID(display, displayIDSel)
        }

        let sid = UUID().uuidString.prefix(8).lowercased()
        let ctx = VirtualDisplayContext(display: display, displayID: displayID, width: width, height: height)
        lock.lock()
        virtualDisplays[String(sid)] = ctx
        lock.unlock()

        Platform.log("virtual display created: \(width)x\(height) @\(refreshRate)Hz id=\(displayID) hiDPI=\(hiDPI)")

        completion(WireFormat.success([
            "id": String(sid),
            "displayID": displayID,
            "width": width,
            "height": height,
            "refreshRate": refreshRate,
            "hiDPI": hiDPI
        ]))
    }

    private func removeVirtualDisplay(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let sid = action["id"] as? String else {
            completion(WireFormat.error("remove requires an id"))
            return
        }
        lock.lock()
        let ctx = virtualDisplays.removeValue(forKey: sid)
        lock.unlock()

        if ctx != nil {
            Platform.log("virtual display removed: \(sid)")
            completion(WireFormat.success("ok"))
        } else {
            completion(WireFormat.error("virtual display not found: \(sid)"))
        }
    }

    private func displayInfo(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let idVal = action["id"] as? UInt32 ?? (action["id"] as? String).flatMap({ UInt32($0) }) else {
            completion(WireFormat.error("display info requires an id"))
            return
        }
        let bounds = CGDisplayBounds(idVal)
        let mode = CGDisplayCopyDisplayMode(idVal)
        completion(WireFormat.success([
            "id": idVal,
            "width": Int(bounds.width),
            "height": Int(bounds.height),
            "pixelWidth": mode?.pixelWidth ?? 0,
            "pixelHeight": mode?.pixelHeight ?? 0,
            "refreshRate": mode?.refreshRate ?? 0,
            "isMain": CGDisplayIsMain(idVal) != 0,
            "isBuiltin": CGDisplayIsBuiltin(idVal) != 0,
            "rotation": CGDisplayRotation(idVal)
        ]))
    }

    private func moveWindow(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let windowId = action["windowId"] as? UInt32 ?? (action["wid"] as? String).flatMap({ UInt32($0) }),
              let displayId = action["displayId"] as? UInt32 ?? (action["did"] as? String).flatMap({ UInt32($0) }) else {
            completion(WireFormat.error("move-window requires windowId and displayId"))
            return
        }

        // Use AX API to move window to target display's origin
        let displayBounds = CGDisplayBounds(displayId)
        let targetOrigin = displayBounds.origin

        // Find the window via accessibility and set its position
        let systemWide = AXUIElementCreateSystemWide()
        var focusedApp: CFTypeRef?
        AXUIElementCopyAttributeValue(systemWide, kAXFocusedApplicationAttribute as CFString, &focusedApp)

        // Try moving via CGS private API first
        typealias CGSConnectionID = UInt32
        typealias CGSGetDefaultConnectionForPIDFunc = @convention(c) (pid_t) -> CGSConnectionID
        typealias CGSMoveWindowFunc = @convention(c) (CGSConnectionID, UInt32, CGFloat, CGFloat) -> OSStatus

        if let cgsMoveWindow = dlsym(dlopen(nil, RTLD_LAZY), "CGSMoveWindow"),
           let cgsDefaultConnection = dlsym(dlopen(nil, RTLD_LAZY), "CGSMainConnectionID") {
            let getConn = unsafeBitCast(cgsDefaultConnection, to: (@convention(c) () -> CGSConnectionID).self)
            let moveWin = unsafeBitCast(cgsMoveWindow, to: CGSMoveWindowFunc.self)
            let conn = getConn()
            let status = moveWin(conn, windowId, targetOrigin.x, targetOrigin.y)
            if status == 0 {
                completion(WireFormat.success("window \(windowId) moved to display \(displayId)"))
                return
            }
        }

        completion(WireFormat.error("move-window failed — CGSMoveWindow not available"))
    }
}
