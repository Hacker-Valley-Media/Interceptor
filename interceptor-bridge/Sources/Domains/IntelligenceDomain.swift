import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

final class IntelligenceDomain: DomainHandler, @unchecked Sendable {
    private var activeSession: Any? // LanguageModelSession on macOS 26+
    private var sessionHistory: [[String: String]] = []

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "status":
            checkStatus(completion: completion)
        case "prompt":
            runPrompt(action, completion: completion)
        case "session":
            handleSession(action, completion: completion)
        default:
            notImplemented(command, completion: completion)
        }
    }

    private func checkStatus(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 26.0, *) {
            completion(WireFormat.success([
                "available": true,
                "framework": "FoundationModels",
                "note": "Requires Apple Intelligence enabled in System Settings"
            ]))
        } else {
            completion(WireFormat.success([
                "available": false,
                "reason": "FoundationModels requires macOS 26.0+"
            ]))
        }
    }

    private func runPrompt(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard #available(macOS 26.0, *) else {
            completion(WireFormat.error("FoundationModels requires macOS 26.0+"))
            return
        }
        guard let prompt = action["prompt"] as? String else {
            completion(WireFormat.error("prompt requires a prompt string"))
            return
        }
        Task {
            do {
                let session = LanguageModelSession()
                let response = try await session.respond(to: prompt)
                completion(WireFormat.success(String(describing: response)))
            } catch {
                completion(WireFormat.error("FoundationModels error: \(error.localizedDescription)"))
            }
        }
    }

    private func handleSession(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard #available(macOS 26.0, *) else {
            completion(WireFormat.error("FoundationModels requires macOS 26.0+"))
            return
        }
        let op = action["op"] as? String ?? "status"
        switch op {
        case "start":
            if activeSession != nil {
                completion(WireFormat.error("session already active — end it first"))
                return
            }
            activeSession = LanguageModelSession()
            sessionHistory = []
            completion(WireFormat.success(["sessionActive": true]))

        case "send":
            guard activeSession != nil else {
                completion(WireFormat.error("no active session — call session start first"))
                return
            }
            guard let message = action["message"] as? String else {
                completion(WireFormat.error("session send requires a message"))
                return
            }
            sessionHistory.append(["role": "user", "content": message])
            #if canImport(FoundationModels)
            if let session = activeSession as? LanguageModelSession {
                Task {
                    do {
                        let response = try await session.respond(to: message)
                        let text = String(describing: response)
                        self.sessionHistory.append(["role": "assistant", "content": text])
                        completion(WireFormat.success(["response": text]))
                    } catch {
                        completion(WireFormat.error("session send failed: \(error.localizedDescription)"))
                    }
                }
            } else {
                completion(WireFormat.error("session type mismatch"))
            }
            #else
            completion(WireFormat.error("FoundationModels not available at compile time"))
            #endif

        case "history":
            completion(WireFormat.success(sessionHistory))

        case "end":
            activeSession = nil
            let history = sessionHistory
            sessionHistory = []
            completion(WireFormat.success(["sessionEnded": true, "turns": history.count]))

        default:
            notImplemented("session \(op)", completion: completion)
        }
    }
}
