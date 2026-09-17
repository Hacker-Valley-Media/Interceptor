//
//  SafariWebExtensionHandler.swift
//  InterceptorSafari Extension
//
//  Part of the Interceptor Safari containing app.
//

import SafariServices
import os.log

private actor SafariDaemonRelay {
    private let session: URLSession
    private var socket: URLSessionWebSocketTask?
    private var contextIdentifier: String?
    private var receiveTask: Task<Void, Never>?
    private var inbound: [Any] = []
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 60
        session = URLSession(configuration: configuration)
    }

    func exchange(contextId: String, outbound: [Any], waitMilliseconds: Int) async -> [String: Any] {
        do {
            try await ensureConnected(contextId: contextId)
            guard let socket else { throw RelayError.disconnected }
            for message in outbound {
                try await send(message, over: socket)
            }

            await waitForInbound(milliseconds: max(100, min(waitMilliseconds, 5_000)))
            let messages = inbound
            inbound.removeAll(keepingCapacity: true)
            return [
                "connected": self.socket === socket,
                "messages": messages,
            ]
        } catch {
            resetConnection()
            return [
                "connected": false,
                "messages": [],
                "error": error.localizedDescription,
            ]
        }
    }

    private func ensureConnected(contextId: String) async throws {
        if socket != nil, contextIdentifier == contextId { return }
        resetConnection()

        // Per-user daemon port (shared/platform.ts derivePorts): uid 501 keeps 19222.
        let slot = ((Int(getuid()) - 501) % 500 + 500) % 500
        guard let url = URL(string: "ws://127.0.0.1:\(19222 + 2 * slot)") else {
            throw RelayError.invalidURL
        }
        let task = session.webSocketTask(with: url)
        socket = task
        contextIdentifier = contextId
        task.resume()
        receiveTask = Task { [weak self] in
            await self?.receiveMessages(from: task)
        }
        try await send(["type": "extension", "contextId": contextId], over: task)
    }

    private func send(_ object: Any, over socket: URLSessionWebSocketTask) async throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let string = String(data: data, encoding: .utf8) else {
            throw RelayError.invalidJSON
        }
        try await socket.send(.string(string))
    }

    private func receiveMessages(from task: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                guard socket === task else { return }
                let data: Data
                switch message {
                case .string(let string):
                    guard let encoded = string.data(using: .utf8) else { continue }
                    data = encoded
                case .data(let value):
                    data = value
                @unknown default:
                    continue
                }
                let object = try JSONSerialization.jsonObject(with: data)
                inbound.append(object)
                resumeAllWaiters()
            } catch {
                guard socket === task else { return }
                os_log(.error, "Safari daemon relay receive failed: %{public}@", error.localizedDescription)
                socket = nil
                contextIdentifier = nil
                receiveTask = nil
                resumeAllWaiters()
                return
            }
        }
    }

    private func waitForInbound(milliseconds: Int) async {
        if !inbound.isEmpty || socket == nil { return }
        let id = UUID()
        await withCheckedContinuation { continuation in
            waiters[id] = continuation
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(milliseconds) * 1_000_000)
                await self?.resumeWaiter(id)
            }
        }
    }

    private func resumeWaiter(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume()
    }

    private func resumeAllWaiters() {
        let pending = waiters.values
        waiters.removeAll()
        for waiter in pending { waiter.resume() }
    }

    private func resetConnection() {
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        contextIdentifier = nil
        inbound.removeAll(keepingCapacity: true)
        resumeAllWaiters()
    }

    private enum RelayError: LocalizedError {
        case disconnected
        case invalidJSON
        case invalidURL

        var errorDescription: String? {
            switch self {
            case .disconnected: return "Safari daemon relay disconnected"
            case .invalidJSON: return "Safari daemon relay could not encode JSON"
            case .invalidURL: return "Safari daemon relay URL is invalid"
            }
        }
    }
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let daemonRelay = SafariDaemonRelay()

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        if let relayMessage = message as? [String: Any],
           relayMessage["type"] as? String == "interceptor_safari_relay" {
            let contextId = relayMessage["contextId"] as? String ?? "safari"
            let outbound = relayMessage["outbound"] as? [Any] ?? []
            let waitMilliseconds = relayMessage["waitMilliseconds"] as? Int ?? 1_000
            Task {
                let reply = await Self.daemonRelay.exchange(
                    contextId: contextId,
                    outbound: outbound,
                    waitMilliseconds: waitMilliseconds
                )
                let response = NSExtensionItem()
                response.userInfo = [SFExtensionMessageKey: reply]
                context.completeRequest(returningItems: [response], completionHandler: nil)
            }
            return
        }

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@ (profile: %@)", String(describing: message), profile?.uuidString ?? "none")

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [ SFExtensionMessageKey: [ "echo": message ] ]
        } else {
            response.userInfo = [ "message": [ "echo": message ] ]
        }

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

}
