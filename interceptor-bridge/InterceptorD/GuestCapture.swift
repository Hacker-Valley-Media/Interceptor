import Foundation
import AppKit
import CoreGraphics
import ScreenCaptureKit
import CryptoKit
import GuestWire

/// Only one native capture or retained snapshot exists at a time. A timed-out
/// native operation keeps its lease until its actual task returns.
final class GuestCapture: @unchecked Sendable {
    static let shared = GuestCapture()
    struct Snapshot: Sendable {
        let id: String, png: Data, width: Int, height: Int, sha256: String
        let created = ContinuousClock.now
    }
    final class ResultBox: @unchecked Sendable {
        let semaphore = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var snapshot: Snapshot?, error: String?, retired = false
        func finish(_ value: Snapshot?, error: String?, complete: (Snapshot?) -> Void) {
            lock.lock(); defer { lock.unlock() }
            if !retired { snapshot = value; self.error = error }
            complete(retired ? nil : value)
            semaphore.signal()
        }
        func take(timedOut: Bool) -> (Snapshot?, String?) {
            lock.lock(); defer { lock.unlock() }
            retired = true
            if timedOut { return (snapshot, "native capture deadline expired; its lease remains owned until completion") }
            return (snapshot, error)
        }
    }
    private let lock = NSLock()
    private var busy = false, retained: Snapshot?
    private func prune() {
        if let retained, retained.created.duration(to: .now) >= .seconds(120) { self.retained = nil }
    }
    private func acquire() -> Bool {
        lock.lock(); defer { lock.unlock() }; prune()
        guard !busy, retained == nil else { return false }; busy = true; return true
    }
    private func completed(_ snapshot: Snapshot?) {
        lock.lock(); retained = snapshot; busy = false; lock.unlock()
    }
    private func find(_ id: String) -> Snapshot? {
        lock.lock(); defer { lock.unlock() }; prune()
        guard retained?.id == id else { return nil }; return retained
    }
    private static func capture() async throws -> Snapshot {
        guard CGPreflightScreenCaptureAccess() else { throw GuestWire.Failure.io("guest Screen Recording permission denied") }
        let id = CGMainDisplayID(), width = CGDisplayPixelsWide(id), height = CGDisplayPixelsHigh(id)
        guard (1...16384).contains(width), (1...16384).contains(height), width <= 33_554_432 / height else { throw GuestWire.Failure.framing("actual guest display exceeds 32M physical pixels") }
        let content = try await SCShareableContent.current
        let displays = content.displays.filter { $0.displayID == id }
        guard displays.count == 1 else { throw GuestWire.Failure.io("actual main display is missing or ambiguous") }
        let filter = SCContentFilter(display: displays[0], excludingWindows: [])
        let configuration = SCStreamConfiguration()
        // SCDisplay.width/height are points. Input addresses physical pixels.
        configuration.width = width; configuration.height = height; configuration.showsCursor = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        guard CGMainDisplayID() == id, CGDisplayPixelsWide(id) == width, CGDisplayPixelsHigh(id) == height,
              image.width == width, image.height == height else { throw GuestWire.Failure.io("display identity or dimensions changed during capture") }
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), !png.isEmpty, png.count <= GuestWire.snapshotMaxBytes else { throw GuestWire.Failure.framing("native PNG encoding failed or exceeds 64MiB") }
        return Snapshot(id: UUID().uuidString, png: png, width: width, height: height,
                        sha256: SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined())
    }
    func begin(_ action: [String: Any]) -> [String: Any] {
        // A host destination is never interpreted as a path inside the guest.
        guard action["out"] == nil else { return ["success": false, "error": "guest screenshot does not accept host output paths"] }
        let seconds: Double
        do { seconds = min(10, try GuestWire.requestBudget(action, defaultSeconds: 10)) }
        catch { return ["success": false, "error": "screenshot: invalid native budget"] }
        guard acquire() else { return ["success": false, "error": "native capture or a retained snapshot still owns admission"] }
        let box = ResultBox(), started = ContinuousClock.now
        Task.detached { [self] in
            do {
                let snapshot = try await Self.capture()
                guard started.duration(to: .now) < .seconds(seconds) else { box.finish(nil, error: "native capture returned after its deadline", complete: completed); return }
                box.finish(snapshot, error: nil, complete: completed)
            } catch { box.finish(nil, error: "native capture failed: \(error)", complete: completed) }
        }
        let timedOut = box.semaphore.wait(timeout: .now() + seconds) == .timedOut
        let (snapshot, error) = box.take(timedOut: timedOut)
        if timedOut {
            // A completion racing the deadline may already have retained its
            // record. Discard only that owned generation, never a later one.
            if let snapshot { _ = release(["snapshotId": snapshot.id]) }
            return ["success": false, "error": "screenshot: \(error ?? "native timeout")"]
        }
        guard let snapshot else { return ["success": false, "error": "screenshot: \(error ?? "no native image returned")"] }
        return ["success": true, "data": ["snapshotId": snapshot.id, "width": snapshot.width, "height": snapshot.height,
                                           "bytes": snapshot.png.count, "sha256": snapshot.sha256, "format": "png"]]
    }
    func chunk(_ action: [String: Any]) -> [String: Any] {
        guard let id = action["snapshotId"] as? String, let snapshot = find(id),
              let offset = GuestWire.snapshotInteger(action["offset"], maximum: GuestWire.snapshotMaxBytes),
              let length = GuestWire.snapshotInteger(action["length"], maximum: GuestWire.snapshotChunkBytes), length > 0,
              offset < snapshot.png.count, length <= snapshot.png.count - offset else {
            return ["success": false, "error": "snapshot chunk requires its retained identity and exact bounded range"]
        }
        let data = snapshot.png.subdata(in: offset..<(offset + length))
        return ["success": true, "data": ["snapshotId": id, "offset": offset, "bytes": length, "dataBase64": data.base64EncodedString()]]
    }
    func release(_ action: [String: Any]) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }; prune()
        guard let id = action["snapshotId"] as? String, retained?.id == id else { return ["success": false, "error": "snapshot identity is absent, expired or differs"] }
        retained = nil
        return ["success": true, "data": ["snapshotId": id, "released": true]]
    }
}
