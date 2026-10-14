import Foundation
import ApplicationServices
@testable import interceptor_bridge

// deterministic AX transport double for unit tests.
//
// It fabricates only real, constructible CF values (CFString, CFNumber,
// AXValue via AXValueCreate, kCFNull, AXUIElementCreateSystemWide) so tests need
// no live application. It models the branches the AX transport contract requires: per-slot bulk
// values/nulls/errors, a recorded call count (delay stand-in), and an
// "action happened but returned cannotComplete" fixture.
final class FakeAXTransport: AXTransport, @unchecked Sendable {
    // Attribute name (raw AX constant string, e.g. "AXRole") → value.
    var attributeResponses: [String: CFTypeRef] = [:]
    var settable: [String: Bool] = [:]
    var multiAttributeResponse: [CFTypeRef]?
    var parameterizedResponses: [String: CFTypeRef] = [:]

    var performResult: AXError = .success
    var setResult: AXError = .success
    var performedActions: [String] = []
    var setAttributes: [(String, CFTypeRef)] = []

    // cannotComplete-after-effect fixture: performAction returns .cannotComplete
    // yet the effect is recorded, so verify-before-retry logic (G3) is testable.
    var actionEffectHappened = false

    private(set) var callCount = 0

    private func tick() { callCount += 1 }

    func createApplication(pid: pid_t) -> AXUIElement { AXUIElementCreateSystemWide() }
    func createSystemWide() -> AXUIElement { AXUIElementCreateSystemWide() }

    func copyAttributeValue(_ element: AXUIElement, _ attribute: String) -> (AXError, CFTypeRef?) {
        tick()
        if let v = attributeResponses[attribute] { return (.success, v) }
        return (.noValue, nil)
    }

    func copyMultipleAttributeValues(_ element: AXUIElement, _ attributes: [String], stopOnError: Bool) -> (AXError, [CFTypeRef]?) {
        tick()
        if let fixed = multiAttributeResponse { return (.success, fixed) }
        let values = attributes.map { attributeResponses[$0] ?? (kCFNull as CFTypeRef) }
        return (.success, values)
    }

    func copyAttributeNames(_ element: AXUIElement) -> (AXError, [String]?) {
        tick()
        return (.success, Array(attributeResponses.keys))
    }

    func attributeValueCount(_ element: AXUIElement, _ attribute: String) -> (AXError, Int?) {
        tick()
        if let arr = attributeResponses[attribute] as? [CFTypeRef] { return (.success, arr.count) }
        return (.noValue, nil)
    }

    func copyAttributeValues(_ element: AXUIElement, _ attribute: String, index: Int, maxValues: Int) -> (AXError, [CFTypeRef]?) {
        tick()
        guard let arr = attributeResponses[attribute] as? [CFTypeRef] else { return (.noValue, nil) }
        let end = min(index + maxValues, arr.count)
        guard index < end else { return (.success, []) }
        return (.success, Array(arr[index..<end]))
    }

    func isAttributeSettable(_ element: AXUIElement, _ attribute: String) -> (AXError, Bool?) {
        tick()
        return (.success, settable[attribute] ?? false)
    }

    func setAttributeValue(_ element: AXUIElement, _ attribute: String, _ value: CFTypeRef) -> AXError {
        tick()
        setAttributes.append((attribute, value))
        return setResult
    }

    func copyParameterizedAttributeNames(_ element: AXUIElement) -> (AXError, [String]?) {
        tick()
        return (.success, Array(parameterizedResponses.keys))
    }

    func copyParameterizedAttributeValue(_ element: AXUIElement, _ attribute: String, _ parameter: CFTypeRef) -> (AXError, CFTypeRef?) {
        tick()
        if let v = parameterizedResponses[attribute] { return (.success, v) }
        return (.noValue, nil)
    }

    func copyActionNames(_ element: AXUIElement) -> (AXError, [String]?) {
        tick()
        return (.success, ["AXPress"])
    }

    func copyActionDescription(_ element: AXUIElement, _ action: String) -> (AXError, String?) {
        tick()
        return (.success, "perform \(action)")
    }

    func performAction(_ element: AXUIElement, _ action: String) -> AXError {
        tick()
        performedActions.append(action)
        if performResult == .cannotComplete && actionEffectHappened {
            // effect happened, but the API still reported cannotComplete
            return .cannotComplete
        }
        return performResult
    }

    func copyElementAtPosition(_ application: AXUIElement, x: Float, y: Float) -> (AXError, AXUIElement?) {
        tick()
        return (.success, AXUIElementCreateSystemWide())
    }

    var processID: pid_t = 4242
    func pid(_ element: AXUIElement) -> (AXError, pid_t?) {
        tick()
        return (.success, processID)
    }

    func setMessagingTimeout(_ element: AXUIElement, seconds: Float) -> AXError {
        tick()
        return .success
    }

    func observerCreate(pid: pid_t, callback: @escaping AXObserverCallback) -> (AXError, AXObserver?) {
        tick()
        return (.cannotComplete, nil)   // observers are not exercised by unit tests
    }

    func observerAddNotification(_ observer: AXObserver, _ element: AXUIElement, _ notification: String, _ refcon: UnsafeMutableRawPointer?) -> AXError {
        .cannotComplete
    }

    func observerRemoveNotification(_ observer: AXObserver, _ element: AXUIElement, _ notification: String) -> AXError {
        .cannotComplete
    }

    func observerGetRunLoopSource(_ observer: AXObserver) -> CFRunLoopSource {
        var ctx = CFRunLoopSourceContext()
        ctx.perform = { _ in }
        return CFRunLoopSourceCreate(nil, 0, &ctx)!
    }

    var trusted = true
    func isProcessTrusted() -> Bool { trusted }
    func isProcessTrustedWithOptions(_ options: CFDictionary) -> Bool { trusted }
}

// Test helpers to fabricate real CF/AX values without a live app.
enum FakeAX {
    static func string(_ s: String) -> CFTypeRef { s as CFString }
    static func number(_ n: NSNumber) -> CFTypeRef { n as CFTypeRef }
    static func point(_ x: CGFloat, _ y: CGFloat) -> CFTypeRef {
        var p = CGPoint(x: x, y: y)
        return AXValueCreate(.cgPoint, &p)!
    }
    static func size(_ w: CGFloat, _ h: CGFloat) -> CFTypeRef {
        var s = CGSize(width: w, height: h)
        return AXValueCreate(.cgSize, &s)!
    }
    static func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CFTypeRef {
        var r = CGRect(x: x, y: y, width: w, height: h)
        return AXValueCreate(.cgRect, &r)!
    }
    static func range(_ loc: Int, _ len: Int) -> CFTypeRef {
        var r = CFRange(location: loc, length: len)
        return AXValueCreate(.cfRange, &r)!
    }
    static func axError(_ e: AXError) -> CFTypeRef {
        var err = e
        return AXValueCreate(.axError, &err)!
    }
    static func url(_ s: String) -> CFTypeRef { URL(string: s)! as CFURL }
    static func attributed(_ s: String) -> CFTypeRef {
        CFAttributedStringCreate(nil, s as CFString, nil)!
    }
    static func element() -> CFTypeRef { AXUIElementCreateSystemWide() }
    static func array(_ items: [CFTypeRef]) -> CFTypeRef { items as CFArray }
    static var null: CFTypeRef { kCFNull }
}
