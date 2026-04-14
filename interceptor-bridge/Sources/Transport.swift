import Foundation
import Darwin.POSIX

final class Transport: @unchecked Sendable {
    private let router: Router
    private let socketPath: String
    private var serverFD: Int32 = -1
    private var running = true

    init(router: Router) throws {
        self.router = router
        self.socketPath = Platform.bridgeSocketPath

        Platform.cleanupSocket()

        serverFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard serverFD >= 0 else {
            throw NSError(domain: "Transport", code: 1, userInfo: [NSLocalizedDescriptionKey: "failed to create socket"])
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8CString)
        withUnsafeMutablePointer(to: &addr.sun_path) { sunPathPtr in
            let raw = UnsafeMutableRawPointer(sunPathPtr)
            pathBytes.withUnsafeBufferPointer { buf in
                raw.copyMemory(from: buf.baseAddress!, byteCount: min(buf.count, 104))
            }
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                bind(serverFD, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            Darwin.close(serverFD)
            throw NSError(domain: "Transport", code: 2, userInfo: [NSLocalizedDescriptionKey: "bind failed: \(String(cString: strerror(errno)))"])
        }

        guard Darwin.listen(serverFD, 5) == 0 else {
            Darwin.close(serverFD)
            throw NSError(domain: "Transport", code: 3, userInfo: [NSLocalizedDescriptionKey: "listen failed"])
        }
    }

    func start() {
        Platform.log("transport listening on \(socketPath)")
        let fd = serverFD
        let rtr = router
        let thread = Thread {
            Transport.acceptLoop(serverFD: fd, router: rtr)
        }
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    func stop() {
        running = false
        if serverFD >= 0 { Darwin.close(serverFD); serverFD = -1 }
    }

    private static func acceptLoop(serverFD: Int32, router: Router) {
        while true {
            var clientAddr = sockaddr_un()
            var clientLen = socklen_t(MemoryLayout<sockaddr_un>.size)
            let clientFD = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                    Darwin.accept(serverFD, sockPtr, &clientLen)
                }
            }
            guard clientFD >= 0 else {
                usleep(10_000)
                continue
            }

            Platform.log("client connected (fd: \(clientFD))")

            let rtr = router
            Thread.detachNewThread {
                Transport.handleClient(fd: clientFD, router: rtr)
            }
        }
    }

    private static func handleClient(fd: Int32, router: Router) {
        var buffer = Data()
        let readBuf = UnsafeMutablePointer<UInt8>.allocate(capacity: 65536)
        defer {
            readBuf.deallocate()
            Darwin.close(fd)
            Platform.log("client disconnected (fd: \(fd))")
        }

        while true {
            let bytesRead = Darwin.read(fd, readBuf, 65536)
            if bytesRead <= 0 { break }
            buffer.append(readBuf, count: bytesRead)

            while buffer.count >= 4 {
                let payloadLen: UInt32 = buffer.withUnsafeBytes { ptr in
                    ptr.loadUnaligned(as: UInt32.self)
                }
                let frameLen = 4 + Int(payloadLen)
                // Sanity check: max 10MB message
                guard payloadLen > 0, payloadLen < 10_000_000, buffer.count >= frameLen else {
                    if payloadLen == 0 || payloadLen >= 10_000_000 {
                        Platform.log("invalid frame length: \(payloadLen), dropping buffer")
                        buffer.removeAll()
                    }
                    break
                }

                let payload = Data(buffer[4..<frameLen])
                buffer = Data(buffer[frameLen...])

                guard let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
                    Transport.sendFramed(fd: fd, response: ["error": "invalid JSON"])
                    continue
                }

                let requestId = json["id"] as? String ?? UUID().uuidString
                let action = json["action"] as? [String: Any] ?? [:]
                let actionType = action["type"] as? String ?? "unknown"

                Platform.log("request \(requestId.prefix(8)) \(actionType)")

                let startTime = Date()
                let sem = DispatchSemaphore(value: 0)

                router.route(action: action) { result in
                    let duration = Date().timeIntervalSince(startTime) * 1000
                    let success = result["success"] as? Bool ?? false
                    Platform.log("response \(requestId.prefix(8)) \(success ? "ok" : "err") \(actionType) \(Int(duration))ms")

                    let response: [String: Any] = [
                        "id": requestId,
                        "result": result
                    ]
                    Transport.sendFramed(fd: fd, response: response)
                    sem.signal()
                }

                sem.wait()
            }
        }
    }

    private static func sendFramed(fd: Int32, response: [String: Any]) {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: response) else {
            Platform.log("failed to serialize response")
            return
        }
        var length = UInt32(jsonData.count)
        let header = Data(bytes: &length, count: 4)
        let frame = header + jsonData
        frame.withUnsafeBytes { ptr in
            _ = Darwin.write(fd, ptr.baseAddress!, frame.count)
        }
    }
}
