import Foundation
import EventKit
import ShareNative

// Calendar and Reminders share native admission and callback ownership.
// A timed-out synchronous call keeps admission until it returns. Native reminder
// fetch cancellation retires on the same queue because EventKit suppresses its
// original callback after cancelFetchRequest returns.
final class EventKitDomainAccess: @unchecked Sendable {
    let store = EKEventStore()
    let queue = DispatchQueue(label: "interceptor.eventkit.native")
    private let lock = NSLock()
    private var active: UUID?
    private var expired = false
    private var cancellation: (@Sendable () -> Void)?
    private var failure: (@Sendable ([String: Any]) -> Void)?
    private var nativeScopes = 0
    private var callbackPending = false
    private var completionRequested = false
    var canContinue: Bool { lock.lock(); defer { lock.unlock() }; return active != nil && !expired && !completionRequested }
    var currentRequest: UUID? { lock.lock(); defer { lock.unlock() }; return expired || completionRequested ? nil : active }
    func canContinue(_ id: UUID) -> Bool { lock.lock(); defer { lock.unlock() }; return active == id && !expired && !completionRequested }
    private func retireIfResolved(_ id: UUID) {
        // Called with the state lock held. Client completion alone does not
        // release a native call that is still running on another queue.
        if active == id && completionRequested && nativeScopes == 0 && !callbackPending {
            active = nil; cancellation = nil; failure = nil
        }
    }
    private func enterScope(_ id: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard active == id && nativeScopes < 16 else { return false }
        nativeScopes += 1; return true
    }
    private func leaveScope(_ id: UUID) {
        lock.lock(); defer { lock.unlock() }
        guard active == id && nativeScopes > 0 else { return }
        nativeScopes -= 1; retireIfResolved(id)
    }
    func beginCallback(_ id: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard active == id && !expired && !callbackPending else { return false }
        callbackPending = true; return true
    }
    func endCallback(_ id: UUID) {
        lock.lock(); defer { lock.unlock() }
        guard active == id else { return }
        callbackPending = false; retireIfResolved(id)
    }
    private func fail(_ id: UUID, _ response: [String: Any]) {
        lock.lock(); let finish = active == id ? failure : nil; lock.unlock()
        finish?(response)
    }
    /// Reuses the existing Objective-C boundary. Swift traps and arbitrary
    /// unwinding/recovery are not made safe by this wrapper and need separate
    /// qualification. A pending SDK callback survives a dispatch exception.
    @discardableResult
    func withNative(request id: UUID? = nil, mayHaveMutated: Bool = false, completion: @escaping @Sendable ([String: Any]) -> Void, operation: @escaping () -> Void) -> Bool {
        if let id, !enterScope(id) { completion(WireFormat.failure("cancelled", "EventKit native scope no longer owns its request")); return false }
        defer { if let id { leaveScope(id) } }
        if let exception = InterceptorNativeOperation("EventKit", operation) {
            var response = DesktopEventKitValidation.nativeError(exception, mayHaveMutated: mayHaveMutated)
            if let id {
                lock.lock(); let pending = active == id && (callbackPending || nativeScopes > 1); lock.unlock()
                var details = response["details"] as? [String: Any] ?? [:]; details["nativeCompletionPending"] = pending; response["details"] = details
            }
            completion(response); return false
        }
        return true
    }
    func perform(action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void, operation: @escaping @Sendable (@escaping @Sendable ([String: Any]) -> Void) -> Void) {
        let id = UUID(), once = AtomicFlag(), box = UncheckedSendableBox(action)
        lock.lock(); let admitted = active == nil; if admitted { active = id; expired = false; cancellation = nil; failure = nil; nativeScopes = 0; callbackPending = false; completionRequested = false }; lock.unlock()
        guard admitted else { completion(WireFormat.failure("resource_limit", "another EventKit request or native completion remains active; no work queued")); return }
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        let timerBox = UncheckedSendableBox(timer)
        let finish: @Sendable ([String: Any]) -> Void = { response in
            timerBox.value.cancel()
            self.lock.lock(); if self.active == id { self.completionRequested = true; self.retireIfResolved(id) }; self.lock.unlock()
            if once.set() { let error = DesktopEventKitValidation.resultError(response, action: box.value); completion(error.map { WireFormat.failure("partial_result", $0, details: ["outcomeUnknown": true]) } ?? response) }
        }
        lock.lock(); if active == id { failure = finish }; lock.unlock()
        timer.schedule(deadline: .now() + 55)
        timer.setEventHandler {
            self.lock.lock(); let current = self.active == id; if current { self.expired = true }; let cancel = current ? self.cancellation : nil; self.lock.unlock()
            guard current else { return }
            if once.set() { completion(WireFormat.failure("timeout_unknown_outcome", "EventKit completion exceeded 55 seconds; no operation was replayed; admission remains occupied until completion or native fetch cancellation")) }
            if let cancel { self.queue.async(execute: cancel) }
        }
        timer.resume()
        let sub = action["sub"] as? String ?? ""
        let mayHaveMutated = ["request", "create-calendar", "delete-calendar", "create", "update", "delete", "move", "complete", "uncomplete", "refresh-sources", "reset"].contains(sub)
        queue.async {
            if !self.canContinue(id) { finish(WireFormat.failure("cancelled", "EventKit request retired before native dispatch")); return }
            self.withNative(request: id, mayHaveMutated: mayHaveMutated, completion: finish) { operation(finish) }
        }
    }
    func fetch(_ predicate: NSPredicate, completion: @escaping @Sendable ([EKReminder]?) -> Void, cancelled: @escaping @Sendable () -> Void) {
        guard let id = currentRequest else { cancelled(); return }
        guard beginCallback(id) else { cancelled(); return }
        let token = store.fetchReminders(matching: predicate) { rows in
            let box = UncheckedSendableBox(rows)
            self.queue.async {
                self.endCallback(id)
                guard self.canContinue(id) else { cancelled(); return }
                self.withNative(request: id, completion: { response in self.fail(id, response) }) { completion(box.value) }
            }
        }
        let box = UncheckedSendableBox(token)
        let cancel: @Sendable () -> Void = {
            self.lock.lock(); let ownsRequest = self.active == id; self.lock.unlock()
            if ownsRequest {
                let returned = self.withNative(request: id, completion: { response in self.fail(id, response) }) { self.store.cancelFetchRequest(box.value) }
                // An exception does not confirm cancellation. Keep the pending
                // callback/admission until actual native completion resolves it.
                guard returned else { return }
                self.endCallback(id)
            }
            cancelled()
        }
        lock.lock(); let ownsRequest = active == id; let retire = ownsRequest && expired; if ownsRequest { cancellation = cancel }; lock.unlock()
        if retire { queue.async(execute: cancel) }
    }
}
