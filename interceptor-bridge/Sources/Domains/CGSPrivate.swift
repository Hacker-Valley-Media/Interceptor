// Private SkyLight (CGS) APIs for capturing occluded / minimized /
// cross-Space windows.
//
// `SCScreenshotManager.captureSampleBuffer` (the public ScreenCaptureKit
// path) requires the WindowServer to have a fresh framebuffer for the
// target window. For occluded Electron / Chromium apps that pause GPU
// rendering when not visible, SCK returns a black or stale buffer.
//
// `CGSHWCaptureWindowList` is the private SkyLight API that has been used
// by AltTab, DockDoor, Loop, Raycast, and Apple's own Mission Control /
// Cmd-Tab UI for ~10 years. It captures from the WindowServer's persisted
// backing store for any window by ID — works for occluded, minimized, and
// off-Space windows.
//
// References:
//   - https://github.com/ejbills/DockDoor/blob/main/DockDoor/Utilities/PrivateApis.swift
//   - https://github.com/lwouis/alt-tab-macos/blob/master/src/api-wrappers/private-apis/SkyLight.framework.swift
//
// Caveats:
//   - Still requires Screen Recording permission (TCC enforced).
//   - Apple has *not* added a public migration path for occluded-window
//     capture. The macOS 15 release notes deprecate `CGWindowListCreateImage`
//     and `CGDisplayStream` but `CGSHWCaptureWindowList` (private SkyLight)
//     remains stable across all current macOS releases.

import ApplicationServices
import CoreGraphics
import Foundation

typealias CGSConnectionID = UInt32

struct CGSWindowCaptureOptions: OptionSet {
    let rawValue: UInt32
    /// Ignore the window's global clip shape (rounded corners, masks).
    static let ignoreGlobalClipShape = CGSWindowCaptureOptions(rawValue: 1 << 11)
    /// 1 logical px per output px (1/4 of bestResolution on retina).
    static let nominalResolution = CGSWindowCaptureOptions(rawValue: 1 << 9)
    /// 1 backing-store px per output px.
    static let bestResolution = CGSWindowCaptureOptions(rawValue: 1 << 8)
    /// Bypass Stage Manager skew so we get full window dimensions.
    static let fullSize = CGSWindowCaptureOptions(rawValue: 1 << 19)
}

@_silgen_name("CGSMainConnectionID")
func CGSMainConnectionID() -> CGSConnectionID

@_silgen_name("CGSHWCaptureWindowList")
func CGSHWCaptureWindowList(
    _ cid: CGSConnectionID,
    _ windowList: UnsafePointer<UInt32>,
    _ count: UInt32,
    _ options: CGSWindowCaptureOptions
) -> CFArray?

// MARK: - SkyLight (SLPS) — for waking occluded windows so they process input

/// Carbon-era process identifier; still required for SLPS APIs.
struct ProcessSerialNumber {
    var highLongOfPSN: UInt32 = 0
    var lowLongOfPSN: UInt32 = 0
}

@_silgen_name("GetProcessForPID")
func GetProcessForPID(_ pid: pid_t, _ psn: UnsafeMutablePointer<ProcessSerialNumber>) -> OSStatus

enum SLPSMode: UInt32 {
    case allWindows = 0x100
    case userGenerated = 0x200
    case noWindows = 0x400
}

private typealias SLPSSetFrontProcessWithOptionsType = @convention(c) (
    UnsafeMutableRawPointer, CGWindowID, UInt32
) -> CGError

private typealias SLPSPostEventRecordToType = @convention(c) (
    UnsafeMutableRawPointer, UnsafeMutablePointer<UInt8>
) -> CGError

private typealias SLEventSetIntegerValueFieldType = @convention(c) (UnsafeMutableRawPointer, UInt32, Int64) -> Void
private typealias CGEventSetWindowLocationType = @convention(c) (UnsafeMutableRawPointer, CGPoint) -> Void
private typealias SLPSGetFrontProcessType = @convention(c) (UnsafeMutableRawPointer) -> CGError
private typealias AXUIElementGetWindowType = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

private final class SkyLightLoader: @unchecked Sendable {
    static let shared = SkyLightLoader()
    let setFront: SLPSSetFrontProcessWithOptionsType?
    let postEventRecord: SLPSPostEventRecordToType?
    let setIntegerField: SLEventSetIntegerValueFieldType?
    let setWindowLocation: CGEventSetWindowLocationType?
    let getFrontProcess: SLPSGetFrontProcessType?
    let axWindowID: AXUIElementGetWindowType?
    private init() {
        let path = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
        let h = dlopen(path, RTLD_LAZY)
        // RTLD_DEFAULT covers symbols re-exported through CoreGraphics / HIServices.
        let anyImage = UnsafeMutableRawPointer(bitPattern: -2)
        func sym(_ name: String) -> UnsafeMutableRawPointer? {
            h.flatMap { dlsym($0, name) } ?? dlsym(anyImage, name)
        }
        setFront = sym("_SLPSSetFrontProcessWithOptions").map { unsafeBitCast($0, to: SLPSSetFrontProcessWithOptionsType.self) }
        postEventRecord = sym("SLPSPostEventRecordTo").map { unsafeBitCast($0, to: SLPSPostEventRecordToType.self) }
        setIntegerField = sym("SLEventSetIntegerValueField").map { unsafeBitCast($0, to: SLEventSetIntegerValueFieldType.self) }
        setWindowLocation = sym("CGEventSetWindowLocation").map { unsafeBitCast($0, to: CGEventSetWindowLocationType.self) }
        getFrontProcess = sym("_SLPSGetFrontProcess").map { unsafeBitCast($0, to: SLPSGetFrontProcessType.self) }
        axWindowID = sym("_AXUIElementGetWindow").map { unsafeBitCast($0, to: AXUIElementGetWindowType.self) }
    }
}

// MARK: - Window-addressed input (events stamped for one window + focus records)

@_silgen_name("GetProcessPID")
func GetProcessPID(_ psn: UnsafePointer<ProcessSerialNumber>, _ pid: UnsafeMutablePointer<pid_t>) -> OSStatus

/// True when every private symbol the window-addressed delivery needs resolved.
var cgsWindowInputAvailable: Bool {
    let l = SkyLightLoader.shared
    return l.setIntegerField != nil && l.setWindowLocation != nil && l.getFrontProcess != nil && l.postEventRecord != nil
}

/// Writes raw event fields and the window-relative location. WindowServer
/// routes a per-pid event by these, not by screen position.
func cgsStampEvent(_ event: CGEvent, fields: [(UInt32, Int64)], windowLocation: CGPoint) {
    let l = SkyLightLoader.shared
    guard let setField = l.setIntegerField, let setLocation = l.setWindowLocation else { return }
    let raw = Unmanaged.passUnretained(event).toOpaque()
    for (field, value) in fields { setField(raw, field, value) }
    setLocation(raw, windowLocation)
}

/// The process WindowServer currently treats as frontmost.
func cgsFrontProcess() -> ProcessSerialNumber? {
    guard let get = SkyLightLoader.shared.getFrontProcess else { return nil }
    var psn = ProcessSerialNumber()
    let status = withUnsafeMutablePointer(to: &psn) { get(UnsafeMutableRawPointer($0)) }
    return status == .success ? psn : nil
}

/// Tells `psn` that `windowID` gained (`activate`) or lost focus. The window
/// is not raised and the frontmost process does not change.
@discardableResult
func cgsPostFocusRecord(to psn: ProcessSerialNumber, windowID: CGWindowID, activate: Bool) -> Bool {
    guard let post = SkyLightLoader.shared.postEventRecord else { return false }
    var bytes = [UInt8](repeating: 0, count: 0xF8)
    bytes[0x04] = 0xF8
    bytes[0x08] = 0x0D
    withUnsafeBytes(of: UInt32(windowID).littleEndian) { src in
        for i in 0..<4 { bytes[0x3C + i] = src[i] }
    }
    bytes[0x8A] = activate ? 0x01 : 0x02
    var target = psn
    return withUnsafeMutablePointer(to: &target) { psnPtr in
        bytes.withUnsafeMutableBufferPointer { post(UnsafeMutableRawPointer(psnPtr), $0.baseAddress!) == .success }
    }
}

/// The window-server id behind an accessibility window element.
func cgsWindowID(of element: AXUIElement) -> CGWindowID? {
    guard let get = SkyLightLoader.shared.axWindowID else { return nil }
    var wid: CGWindowID = 0
    return get(element, &wid) == .success && wid != 0 ? wid : nil
}

// MARK: - SkyLight (SLS) display configuration — activate virtual displays
// in WindowServer so they appear in CGGetActiveDisplayList. Without these,
// `CGVirtualDisplay.applySettings` produces a display object that has a
// displayID but is never registered with WindowServer (Lumen's vd_helper
// pattern). The SLS family is in /System/Library/PrivateFrameworks/SkyLight,
// not on the linker's default search path, so we resolve at runtime via
// dlopen / dlsym (same trick as _SLPSSetFrontProcessWithOptions below).

private typealias SLSBeginDisplayConfigurationT = @convention(c) (UnsafeMutablePointer<CGDisplayConfigRef?>) -> Int32
private typealias SLSConfigureDisplayEnabledT = @convention(c) (CGDisplayConfigRef, CGDirectDisplayID, Bool) -> Int32
private typealias SLSConfigureDisplayOriginT = @convention(c) (CGDisplayConfigRef, CGDirectDisplayID, Int32, Int32) -> Int32
private typealias SLSCompleteDisplayConfigurationT = @convention(c) (CGDisplayConfigRef, UInt32, UInt32) -> Int32

private final class SLSDisplayLoader: @unchecked Sendable {
    static let shared = SLSDisplayLoader()
    let begin: SLSBeginDisplayConfigurationT?
    let enable: SLSConfigureDisplayEnabledT?
    let origin: SLSConfigureDisplayOriginT?
    let complete: SLSCompleteDisplayConfigurationT?
    private init() {
        let path = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
        if let h = dlopen(path, RTLD_LAZY) {
            begin = dlsym(h, "SLSBeginDisplayConfiguration").map { unsafeBitCast($0, to: SLSBeginDisplayConfigurationT.self) }
            enable = dlsym(h, "SLSConfigureDisplayEnabled").map { unsafeBitCast($0, to: SLSConfigureDisplayEnabledT.self) }
            origin = dlsym(h, "SLSConfigureDisplayOrigin").map { unsafeBitCast($0, to: SLSConfigureDisplayOriginT.self) }
            complete = dlsym(h, "SLSCompleteDisplayConfiguration").map { unsafeBitCast($0, to: SLSCompleteDisplayConfigurationT.self) }
        } else {
            begin = nil; enable = nil; origin = nil; complete = nil
        }
    }
}

/// register a CGVirtualDisplay with WindowServer + force extend
/// mode so Cocoa apps can actually be moved onto it. Pattern from
/// Lumen/Sunshine vd_helper.m.
func cgsActivateVirtualDisplay(displayID: CGDirectDisplayID, originX: Int32) -> Bool {
    let loader = SLSDisplayLoader.shared
    guard let begin = loader.begin,
          let enable = loader.enable,
          let origin = loader.origin,
          let complete = loader.complete else {
        return false
    }
    var cfg: CGDisplayConfigRef? = nil
    guard begin(&cfg) == 0, let cfg = cfg else { return false }
    _ = enable(cfg, displayID, true)
    _ = origin(cfg, displayID, originX, 0)
    // kCGConfigureForSession = 1 in <CoreGraphics/CGDisplayConfiguration.h>.
    // Lumen's vd_helper passes that exact value to SLSCompleteDisplayConfiguration.
    _ = complete(cfg, 1, 0)

    // 500 ms grace for WindowServer to settle, then force extend mode if mirrored.
    usleep(500_000)

    // Lumen vd_helper has the same logic. Up to 3 retries because macOS
    // sometimes re-mirrors the new display immediately after we un-mirror.
    for _ in 0..<3 {
        let inMirror = CGDisplayIsInMirrorSet(displayID) != 0
        let mirrorsTarget = CGDisplayMirrorsDisplay(displayID)
        let mainID = CGMainDisplayID()
        let mainMirrorsUs = CGDisplayMirrorsDisplay(mainID) == displayID

        if !inMirror && mirrorsTarget == 0 && !mainMirrorsUs { break }

        var c2: CGDisplayConfigRef? = nil
        if CGBeginDisplayConfiguration(&c2) == .success, let c2 = c2 {
            // If main is mirroring us, un-mirror main; if we're mirroring
            // someone, un-mirror ourselves.
            if mainMirrorsUs {
                CGConfigureDisplayMirrorOfDisplay(c2, mainID, kCGNullDirectDisplay)
            }
            if inMirror || mirrorsTarget != 0 {
                CGConfigureDisplayMirrorOfDisplay(c2, displayID, kCGNullDirectDisplay)
            }
            CGCompleteDisplayConfiguration(c2, .forSession)
        }
        usleep(300_000)
    }

    return true
}

/// switch a virtual display to its native 1× mode (matching the
/// requested resolution), so logical-frame == pixel-frame. By default
/// CGVirtualDisplay starts at retina 2× which clips the visible frame to
/// half the requested resolution.
func cgsSelectNativeDisplayMode(displayID: CGDirectDisplayID, width: Int, height: Int) -> Bool {
    let opts: [CFString: Any] = [kCGDisplayShowDuplicateLowResolutionModes: kCFBooleanTrue!]
    guard let modes = CGDisplayCopyAllDisplayModes(displayID, opts as CFDictionary) else { return false }
    let count = CFArrayGetCount(modes)
    for i in 0..<count {
        let mode = unsafeBitCast(CFArrayGetValueAtIndex(modes, i), to: CGDisplayMode.self)
        let lw = mode.width
        let lh = mode.height
        let pw = mode.pixelWidth
        let ph = mode.pixelHeight
        if Int(lw) == width && Int(lh) == height && pw == lw && ph == lh {
            return CGDisplaySetDisplayMode(displayID, mode, nil) == .success
        }
    }
    return false
}

/// wake an occluded Chromium / Electron window so its event loop
/// will process incoming input events. Posts a synthesized "window become
/// key" / "window resign key" event pair via SLPSPostEventRecordTo. The
/// process is *not* brought to the foreground; the user's focused app is
/// preserved. Adapted from DockDoor's `WindowUtil.makeKeyWindow` and
/// originally documented in the Hammerspoon issue tracker.
func cgsWakeWindowEventLoop(pid: pid_t, windowID: CGWindowID) -> Bool {
    var psn = ProcessSerialNumber()
    guard GetProcessForPID(pid, &psn) == noErr else { return false }
    guard let post = SkyLightLoader.shared.postEventRecord else { return false }

    var bytes = [UInt8](repeating: 0, count: 0xF8)
    bytes[0x04] = 0xF8
    bytes[0x3A] = 0x10
    var wid = UInt32(windowID)
    withUnsafeMutableBytes(of: &wid) { src in
        bytes.withUnsafeMutableBufferPointer { dst in
            memcpy(dst.baseAddress!.advanced(by: 0x3C), src.baseAddress, MemoryLayout<UInt32>.size)
        }
    }
    bytes.withUnsafeMutableBufferPointer { ptr in
        memset(ptr.baseAddress!.advanced(by: 0x20), 0xFF, 0x10)
    }

    return withUnsafeMutablePointer(to: &psn) { psnPtr in
        bytes.withUnsafeMutableBufferPointer { ptr -> Bool in
            // become-key (0x01) then resign-key (0x02). The pair wakes the
            // window's event loop without leaving it as the actual key window.
            ptr[0x08] = 0x01
            let r1 = post(UnsafeMutableRawPointer(psnPtr), ptr.baseAddress!)
            ptr[0x08] = 0x02
            let r2 = post(UnsafeMutableRawPointer(psnPtr), ptr.baseAddress!)
            return r1 == .success || r2 == .success
        }
    }
}

/// Capture a single window by CGWindowID using the private SkyLight API.
/// Returns the CGImage, or nil if capture failed (window destroyed,
/// permission denied, or stage-manager skew).
///
/// This is the only known reliable path for occluded / minimized windows.
@inline(__always)
func cgsCaptureWindow(
    windowID: CGWindowID,
    options: CGSWindowCaptureOptions = [.ignoreGlobalClipShape, .bestResolution]
) -> CGImage? {
    var wid = UInt32(windowID)
    let cid = CGSMainConnectionID()
    guard let arr = CGSHWCaptureWindowList(cid, &wid, 1, options) as? [CGImage],
          let img = arr.first else {
        return nil
    }
    return img
}
