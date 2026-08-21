import XCTest
import AppKit
import ApplicationServices
@testable import interceptor_bridge

// Issue #222 end to end, in-process: a window owned by the test host is pressed
// through the real `LiveAXTransport` from a GCD worker (the queue the bridge's
// Transport uses). Pre-fix this exact sequence traps with EXC_BREAKPOINT "Must
// only be used from the main thread" because the button's action closes its
// NSWindow on the worker (issue #222 has the crash report for the control).
// Post-fix the action runs on the main thread and the process survives.
//
// Needs a WindowServer session (runs in the local `swift test` gate).
@MainActor
final class AXSelfTargetMainThreadTests: XCTestCase {

    private final class PressTarget: NSObject, @unchecked Sendable {
        var window: NSWindow!
        let lock = NSLock()
        private(set) var firedOnMain: Bool?
        @objc func install(_ sender: Any?) {
            lock.lock(); firedOnMain = Thread.isMainThread; lock.unlock()
            window.close()   // what Sparkle's SUUpdateAlert.endWithSelection: does
        }
        func fired() -> Bool? { lock.lock(); defer { lock.unlock() }; return firedOnMain }
    }

    private final class RecordingTextField: NSTextField, @unchecked Sendable {
        let lock = NSLock()
        private(set) var setOnMain: Bool?
        override func setAccessibilityValue(_ accessibilityValue: Any?) {
            lock.lock(); setOnMain = Thread.isMainThread; lock.unlock()
            super.setAccessibilityValue(accessibilityValue)
        }
        func recorded() -> Bool? { lock.lock(); defer { lock.unlock() }; return setOnMain }
    }

    private static var didLaunch = false

    private func makeWindow() -> NSWindow {
        if !Self.didLaunch {
            // The xctest host never runs NSApp.run(); AppKit publishes the
            // app's windows to the in-process AX server only after
            // finishLaunching.
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            app.finishLaunching()
            Self.didLaunch = true
        }
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 140),
                           styleMask: [.titled, .closable], backing: .buffered, defer: false)
        win.isReleasedWhenClosed = false
        return win
    }

    // Walk our own AX tree (no TCC needed for our own pid) to the first child
    // of the first window with the given role.
    private var lastAXError: AXError = .success
    private func ownElement(role: String, attempts: Int = 20) -> AXUIElement? {
        let appEl = AXUIElementCreateApplication(getpid())
        for _ in 0..<attempts {
            var wins: CFTypeRef?
            lastAXError = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wins)
            if lastAXError == .success,
               let windows = wins as? [AXUIElement] {
                for w in windows {
                    var kids: CFTypeRef?
                    guard AXUIElementCopyAttributeValue(w, kAXChildrenAttribute as CFString, &kids) == .success,
                          let children = kids as? [AXUIElement] else { continue }
                    for c in children {
                        var r: CFTypeRef?
                        if AXUIElementCopyAttributeValue(c, kAXRoleAttribute as CFString, &r) == .success,
                           (r as? String) == role { return c }
                    }
                }
            }
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        return nil
    }

    func testSelfTargetedPressRunsOnMainAndSurvives() throws {
        let target = PressTarget()
        let win = makeWindow()
        target.window = win
        let button = NSButton(title: "Install Update", target: target, action: #selector(PressTarget.install(_:)))
        button.frame = NSRect(x: 20, y: 50, width: 220, height: 32)
        win.contentView?.addSubview(button)
        win.orderFront(nil)
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))

        guard let element = ownElement(role: "AXButton") else {
            throw XCTSkip("own AX window not reachable in this test host (AXWindows -> \(lastAXError.rawValue), windows=\(NSApplication.shared.windows.count))")
        }
        XCTAssertEqual(AXSelfTargetPolicy.pid(of: element), getpid())

        let done = expectation(description: "press returned")
        let result = LockedBox<AXError>(.cannotComplete)
        let wasMainOnWorker = LockedBox<Bool>(true)
        DispatchQueue.global(qos: .userInitiated).async {
            wasMainOnWorker.set(Thread.isMainThread)
            result.set(LiveAXTransport().performAction(element, kAXPressAction as String))
            done.fulfill()
        }
        wait(for: [done], timeout: 5)

        XCTAssertFalse(wasMainOnWorker.get(), "the press must originate off the main thread for this test to mean anything")
        XCTAssertEqual(result.get(), .success)
        XCTAssertEqual(target.fired(), true, "button action must execute on the main thread")
        XCTAssertFalse(win.isVisible, "the action closed the window (legally, on main)")
    }

    func testSelfTargetedValueSetRunsOnMain() throws {
        let win = makeWindow()
        let field = RecordingTextField(frame: NSRect(x: 20, y: 50, width: 260, height: 24))
        field.isEditable = true
        win.contentView?.addSubview(field)
        win.orderFront(nil)
        defer { win.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))

        guard let element = ownElement(role: "AXTextField") else {
            throw XCTSkip("own AX window not reachable in this test host (AXWindows -> \(lastAXError.rawValue), windows=\(NSApplication.shared.windows.count))")
        }

        let done = expectation(description: "set returned")
        let result = LockedBox<AXError>(.cannotComplete)
        DispatchQueue.global(qos: .userInitiated).async {
            result.set(LiveAXTransport().setAttributeValue(element, kAXValueAttribute as String, "hello" as CFString))
            done.fulfill()
        }
        wait(for: [done], timeout: 5)

        XCTAssertEqual(result.get(), .success)
        // What this proves: AppKit's accessibility setter for our own field ran,
        // and ran on the main thread, although the call originated on a worker.
        // Whether NSTextField then commits the text is AppKit's business (it
        // needs a field editor / key window for that); the bridge's type path
        // already falls back to synthesized keys when a field ignores AX set.
        XCTAssertEqual(field.recorded(), true, "accessibility value set must execute on the main thread")
    }
}

/// Minimal lock box so worker-thread results cross into the test without
/// tripping Swift 6 mutable-capture diagnostics.
final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ v: T) { value = v }
    func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
    func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
}
