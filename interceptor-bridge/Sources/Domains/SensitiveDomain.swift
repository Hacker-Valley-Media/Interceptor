import Foundation
import AppKit
import SensitiveContentAnalysis

final class SensitiveDomain: DomainHandler, @unchecked Sendable {
    private let lock = NSLock()
    private let vision = VisionDomain()
    private var operation: UUID?
    private var generation: UUID?
    private var timer: DispatchSourceTimer?
    private var owner: NSRunningApplication?
    private var monitoring = false
    private var latest: [String: Any]?
    private var checks = 0
    private var lastError: String?

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var canonical = action
        let sub = action["sub"] as? String ?? (command == "sensitive" ? "check" : command)
        canonical["type"] = "desktop_sensitive"; canonical["sub"] = sub
        if let error = DesktopSensitiveShape.validationError(canonical) ?? VisionDomain.sourceError(canonical) { completion(failure("invalid_request", error)); return }
        let op = action["op"] as? String ?? "status"
        if sub == "check" {
            guard action["op"] == nil else { completion(failure("invalid_request", "sensitive check has no monitor operation")); return }
            analyze(canonical, owner: nil, completion: completion)
            return
        }
        guard action["imagePath"] == nil, op == "start" || action["app"] == nil else { completion(failure("invalid_request", "sensitive monitor source belongs only to live app start")); return }
        switch op {
        case "start": start(canonical, completion: completion)
        case "stop":
            lock.withLock { generation = nil; monitoring = false; timer?.cancel(); timer = nil; owner = nil }
            completion(WireFormat.success(snapshot()))
        default: completion(WireFormat.success(snapshot()))
        }
    }

    private func snapshot() -> [String: Any] {
        lock.withLock { ["monitoring": monitoring, "latest": latest as Any? ?? NSNull(), "checks": checks,
                        "lastError": lastError as Any? ?? NSNull(), "cleanupPending": operation != nil] }
    }
    private func failure(_ code: String, _ message: String) -> [String: Any] { ["success": false, "code": code, "error": String(message.prefix(512))] }

    private func analyze(_ action: [String: Any], owner: NSRunningApplication?, completion: @escaping @Sendable ([String: Any]) -> Void) {
        let id = UUID(), finished = AtomicFlag(), deadline = DispatchTime.now() + 30, input = UncheckedSendableBox(action), retainedOwner = UncheckedSendableBox(owner)
        guard lock.withLock({ () -> Bool in if operation != nil { return false }; operation = id; return true }) else { completion(failure("resource_limit", "sensitive native analysis is busy; no work was queued")); return }
        // ponytail: the SDK has no hard cancellation; retain admission until its callback returns.
        DispatchQueue.global().asyncAfter(deadline: deadline) {
            if finished.set() { completion(self.failure("timeout_unknown_outcome", "sensitive native analysis exceeded thirty seconds; late results are revoked and cleanup may still be pending")) }
        }
        let finish: @Sendable ([String: Any]) -> Void = { result in
            self.lock.withLock { if self.operation == id { self.operation = nil } }
            if finished.set() { completion(DispatchTime.now() < deadline ? result : self.failure("timeout_unknown_outcome", "sensitive native analysis completed after its deadline; late results were revoked")) }
        }
        DispatchQueue.global().async {
            guard #available(macOS 14.0, *) else { finish(self.failure("unsupported_operation", "SensitiveContentAnalysis requires macOS 14+")); return }
            let analyzer = SCSensitivityAnalyzer(), policy = analyzer.analysisPolicy
            guard policy != .disabled else { finish(self.failure("permission_denied", "Sensitive Content Analysis is disabled for this app or device; no image was analyzed. Check the signed capability and native user policy.")); return }
            self.vision.acquireImage(action: input.value, owner: retainedOwner.value) { image in
                guard let image, retainedOwner.value?.isTerminated != true else { finish(self.failure("target_gone", "sensitive image source is unavailable or ambiguous; no other target was captured")); return }
                analyzer.analyzeImage(image) { [analyzer, image] result, error in
                    defer { withExtendedLifetime((analyzer, image)) {} }
                    if let error { finish(self.failure("provider_failed", "native sensitive analysis failed: \(error.localizedDescription)")); return }
                    guard let result, retainedOwner.value?.isTerminated != true else { finish(self.failure("target_gone", "native sensitive analysis lost its source or returned no result")); return }
                    finish(WireFormat.success(["policyEnabled": true, "policy": NativeNames.name(policy.rawValue, NativeNames.sensitivityPolicy), "isSensitive": result.isSensitive, "timestamp": Date().timeIntervalSince1970]))
                }
            }
        }
    }

    private func start(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let name = action["app"] as? String else { completion(failure("invalid_request", "sensitive monitor start requires an explicit app")); return }
        let apps = NSWorkspace.shared.runningApplications.filter { $0.localizedName == name || $0.bundleIdentifier == name }
        guard apps.count == 1, let app = apps.first, let actualName = app.localizedName, !app.isTerminated else { completion(failure("target_gone", "sensitive monitor requires exactly one running app")); return }
        let id = UUID()
        guard lock.withLock({ () -> Bool in
            guard generation == nil, operation == nil else { return false }
            generation = id; owner = app; latest = nil; checks = 0; lastError = nil; return true
        }) else { completion(failure("resource_limit", "sensitive monitor or native cleanup is already active")); return }
        let source: [String: Any] = ["app": actualName, "type": "desktop_sensitive", "sub": "check"]
        let input = UncheckedSendableBox(source), retainedOwner = UncheckedSendableBox(app)
        analyze(source, owner: app) { result in
            guard self.record(result, generation: id) else { completion(result["success"] as? Bool == true ? self.failure("target_gone", "sensitive monitor startup was revoked") : result); return }
            let timer = DispatchSource.makeTimerSource(queue: .global())
            timer.schedule(deadline: .now() + 5, repeating: 5)
            timer.setEventHandler { [weak self] in
                guard let self, self.lock.withLock({ self.generation == id && self.operation == nil }) else { return }
                self.analyze(input.value, owner: retainedOwner.value) { _ = self.record($0, generation: id) }
            }
            let admitted = self.lock.withLock { () -> Bool in
                guard self.generation == id else { return false }
                self.monitoring = true; self.timer = timer; timer.resume(); return true
            }
            if !admitted { timer.setEventHandler {}; timer.resume(); timer.cancel() }
            completion(admitted ? WireFormat.success(self.snapshot()) : self.failure("target_gone", "sensitive monitor startup was revoked"))
        }
    }

    private func record(_ result: [String: Any], generation id: UUID) -> Bool {
        lock.withLock {
            guard generation == id else { return false }
            guard result["success"] as? Bool == true, let data = result["data"] as? [String: Any], checks < 9_007_199_254_740_991 else {
                lastError = String(((result["error"] as? String) ?? "sensitive result/count is invalid").prefix(512))
                generation = nil; monitoring = false; timer?.cancel(); timer = nil; owner = nil; return false
            }
            latest = data; checks += 1; return true
        }
    }
}
