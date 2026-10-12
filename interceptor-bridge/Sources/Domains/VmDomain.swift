// VmDomain
//
// Domain handler for every `macos_vm_<verb>` action. Follows the dispatch
// invariant from `ARCHITECTURE.md:234-238` — read `action["sub"] ?? command`
// and switch on `sub`. The Router (`Router.swift:43-55`) splits
// `macos_vm_create` into `(domainKey="vm", command="create")`; if a CLI
// parser sets `action["sub"]` it overrides.
//
// Verb coverage (design notes):
//   v0: create, list, get, inspect, start, stop, pause, resume, delete,
//       exec, clone, pull, reset
//   v1: install
//   v2: snapshot, restore, share, mount, port-forward, screenshot, type,
//       click, keys, read-ax, console, logs, cp
//
// Each verb returns either `WireFormat.success(payload)` or
// `WireFormat.error(message)`. Errors include a `setup_required` envelope
// when the recovery is well-known (no
// com.apple.security.virtualization entitlement, macOS < 15, etc.).

import Foundation
import GuestWire
import CryptoKit
import Darwin
import ImageIO
#if canImport(Virtualization)
import Virtualization
#endif

// Sendable wrapper around `[String: Any]` so we can hand the action across
// Task boundaries without strict-concurrency violations. Same pattern as
// Transport.swift:234.
struct VmActionBox: @unchecked Sendable {
    let action: [String: Any]
}

final class VmDomain: DomainHandler, @unchecked Sendable {
    /// Ownership is scoped to the canonical registry root and exact name.
    /// Entries survive native failures until shutdown has been confirmed.
    private let lock = NSLock()
    private var instances: [String: VMInstance] = [:]
    private var mutationActive = false

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = (action["sub"] as? String ?? command).replacingOccurrences(of: "-", with: "_")
        if let error = DesktopVmValidation.validationError(action, sub: sub) {
            completion(WireFormat.error("vm: \(error)")); return
        }
        let mutation = !["list", "get", "inspect", "read_ax", "logs"].contains(sub)
        if mutation && !admitMutation() {
            completion(WireFormat.error("vm: another native VM operation is still pending; its ownership has been retained")); return
        }
        // [String: Any] isn't Sendable; wrap in the same UncheckedSendableBox
        // pattern Transport.swift uses (Transport.swift:234).
        let boxed = VmActionBox(action: action)
        Task.detached { [weak self] in
            guard let self = self else {
                completion(WireFormat.error("vm: provider is shutting down")); return
            }
            defer { if mutation { self.releaseMutation() } }
            await self.dispatch(sub: sub, action: boxed.action, completion: completion)
        }
    }

    private func dispatch(sub: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async {
        do {
            switch sub {
            case "create":  try await handleCreate(action, completion: completion)
            case "adopt":   try await handleAdopt(action, completion: completion)
            case "list":    try await handleList(action, completion: completion)
            case "get":     try await handleGet(action, completion: completion)
            case "inspect": try await handleInspect(action, completion: completion)
            case "start":   try await handleStart(action, completion: completion)
            case "stop":    try await handleStop(action, completion: completion)
            case "pause":   try await handlePause(action, completion: completion)
            case "resume":  try await handleResume(action, completion: completion)
            case "delete":  try await handleDelete(action, completion: completion)
            case "exec":    try await handleExec(action, completion: completion)
            case "clone":   try await handleClone(action, completion: completion)
            case "pull":    try await handlePull(action, completion: completion)
            case "install": try await handleInstall(action, completion: completion)
            case "reset":   try await handleReset(action, completion: completion)
            case "snapshot": try await handleSnapshot(action, completion: completion)
            case "restore": try await handleRestore(action, completion: completion)
            case "screenshot": try await handleGuestScreenshot(action, completion: completion)
            case "type":       try await handleGuestVerb("type", action: action, completion: completion)
            case "click":      try await handleGuestVerb("click", action: action, completion: completion)
            case "keys":       try await handleGuestVerb("keys", action: action, completion: completion)
            case "read_ax":    try await handleGuestVerb("read_ax", action: action, completion: completion)
            case "mount":      try await handleGuestVerb("mount", action: action, completion: completion)
            case "logs":       try await handleGuestVerb("logs", action: action, completion: completion)
            case "trust":      try await handleGuestVerb("trust", action: action, completion: completion)
            case "cp":         try await handleCp(action, completion: completion)
            case "share":      try await handleShare(action, completion: completion)
            case "tcc_profile_generate": try await handleTccProfileGenerate(action, completion: completion)
            case "console":    try await handleConsole(action, completion: completion)
            case "port_forward": try await handlePortForward(action, completion: completion)
            default:
                completion(WireFormat.error("vm: unknown verb '\(sub)'"))
            }
        } catch {
            completion(WireFormat.error("vm \(sub): \(error)"))
        }
    }

    // MARK: - helpers

    private func stateDir(from action: [String: Any]) -> URL {
        VMRegistry.resolveStateDir(actionOverride: action["stateDir"] as? String)
    }

    private func registry(from action: [String: Any]) throws -> VMRegistry {
        let dir = stateDir(from: action)
        return try VMRegistry(stateDir: dir)
    }

    private func timeInterval(from value: Any?, default defaultValue: TimeInterval) -> TimeInterval {
        switch value {
        case let number as NSNumber:
            return number.doubleValue
        case let double as Double:
            return double
        case let int as Int:
            return TimeInterval(int)
        case let string as String:
            return TimeInterval(string) ?? defaultValue
        default:
            return defaultValue
        }
    }

    private func intValue(from value: Any?) -> Int? {
        switch value {
        case let number as NSNumber:
            return number.intValue
        case let int as Int:
            return int
        case let double as Double:
            return Int(double)
        case let string as String:
            return Int(string)
        default:
            return nil
        }
    }

    private func ensureMacOSCapability() -> [String: Any]? {
        #if canImport(Virtualization)
        if #available(macOS 15.0, *) { return nil }
        return [
            "reason": "host macOS < 15.0; VM management requires macOS 15+",
            "command": "softwareupdate --install",
            "docs": "https://developer.apple.com/documentation/virtualization"
        ]
        #else
        return [
            "reason": "Virtualization framework not linked",
            "command": "rebuild bridge",
            "docs": "https://developer.apple.com/documentation/virtualization"
        ]
        #endif
    }

    private func admitMutation() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !mutationActive else { return false }
        mutationActive = true
        return true
    }

    private func releaseMutation() {
        lock.lock(); mutationActive = false; lock.unlock()
    }

    private func instanceKey(name: String, action: [String: Any]) -> String {
        stateDir(from: action).standardizedFileURL.resolvingSymlinksInPath().path + "\0" + name
    }

    private func instance(for name: String, action: [String: Any]) -> VMInstance? {
        let key = instanceKey(name: name, action: action)
        lock.lock(); defer { lock.unlock() }
        return instances[key]
    }

    private func putInstance(_ inst: VMInstance, name: String, action: [String: Any]) {
        let key = instanceKey(name: name, action: action)
        lock.lock(); instances[key] = inst; lock.unlock()
    }

    private func dropInstance(name: String, action: [String: Any]) {
        let key = instanceKey(name: name, action: action)
        lock.lock(); instances.removeValue(forKey: key); lock.unlock()
    }

    private func stopOwnedInstance(name: String, action: [String: Any], timeout: TimeInterval) async throws {
        guard let inst = instance(for: name, action: action) else { return }
        try await inst.stop(force: true, timeout: timeout)
        guard await inst.status == .stopped, !(await inst.ownsRuntime) else {
            throw VMInstanceError.invalidTransition("shutdown has not been confirmed for '\(name)'")
        }
        dropInstance(name: name, action: action)
    }

    private func successView(for spec: VMSpec, status: VMStatus, ip: String? = nil) -> [String: Any] {
        VMPublicView(spec: spec, status: status, ipAddress: ip).asDictionary
    }

    // MARK: - verb impls

    private func handleCreate(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String, !name.isEmpty else {
            completion(WireFormat.error("vm create: missing 'name'")); return
        }
        guard let kindStr = action["kind"] as? String, let kind = VMKind(rawValue: kindStr) else {
            completion(WireFormat.error("vm create: 'kind' must be 'linux' or 'macos'")); return
        }
        let cpu = (action["cpu"] as? Int) ?? 2
        let memory = (action["memorySize"] as? UInt64) ?? UInt64((action["memorySize"] as? Int) ?? 1024 * 1024 * 1024)
        let disk = (action["diskSize"] as? UInt64) ?? UInt64((action["diskSize"] as? Int) ?? 4 * 1024 * 1024 * 1024)
        let image = (action["image"] as? String) ?? "latest"
        let networkStr = (action["network"] as? String) ?? "nat"
        let network = VMNetworkMode(rawValue: networkStr) ?? .nat
        let rosetta = (action["rosetta"] as? Bool) ?? false
        let shares: [VMShareSpec] = (action["shares"] as? [[String: Any]] ?? []).compactMap { item in
            guard let host = item["hostPath"] as? String, let tag = item["tag"] as? String else { return nil }
            let ro = (item["readOnly"] as? Bool) ?? true
            return VMShareSpec(hostPath: host, tag: tag, readOnly: ro)
        }
        let spec = VMSpec(
            name: name, kind: kind, cpu: cpu, memorySize: memory, diskSize: disk,
            image: image, network: network,
            shares: shares, rosetta: rosetta,
            agent: VMGuestAgentSpec(
                enabled: true,
                transport: .vsock,
                port: kInterceptorGuestAgentPort,
                trustStatus: kind == .macos ? "transport_unverified" : "unknown"
            )
        )
        let reg = try registry(from: action)
        let bundle = try await reg.create(spec)
        completion(WireFormat.success([
            "name": name,
            "id": spec.id,
            "kind": kind.rawValue,
            "status": VMStatus.created.rawValue,
            "bundlePath": bundle.bundlePath.path
        ]))
    }

    private func handleAdopt(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String, !name.isEmpty else {
            completion(WireFormat.error("vm adopt: missing 'name'")); return
        }
        guard let sourcePath = action["sourcePath"] as? String, !sourcePath.isEmpty else {
            completion(WireFormat.error("vm adopt: missing 'sourcePath'")); return
        }
        guard let kindStr = action["kind"] as? String, let kind = VMKind(rawValue: kindStr) else {
            completion(WireFormat.error("vm adopt: 'kind' must be 'linux' or 'macos'")); return
        }
        let provider = (action["provider"] as? String) ?? "auto"
        let modeStr = (action["mode"] as? String) ?? "clone"
        guard let mode = VMAdoptMode(rawValue: modeStr) else {
            completion(WireFormat.error("vm adopt: --mode must be clone, move, or reference")); return
        }
        let installAgent = (action["installAgent"] as? Bool) ?? false
        let waitForAgent = (action["waitForAgent"] as? Bool) ?? false
        if installAgent || waitForAgent {
            completion([
                "success": false,
                "error": "vm adopt: unsupported-transport: --install-agent/--wait-for-agent require a configured macOS guest bootstrap transport; current VZ adoption cannot install or trust-probe InterceptorD safely",
                "setup_required": [
                    "reason": "adopt-time guest-agent install/readiness is fail-closed until macOS guest transport is explicitly configured",
                    "command": "adopt without --install-agent/--wait-for-agent, install InterceptorD inside the guest image, then run `interceptor macos vm start \(name) --wait-for-agent`",
                    "docs": "reports/macos-vm-agent-transport-background-2026-05-27.md",
                ],
            ])
            return
        }
        let source = URL(fileURLWithPath: (sourcePath as NSString).expandingTildeInPath)
        let reg = try registry(from: action)
        do {
            let result = try await VMAdoption.adopt(
                source: source,
                name: name,
                kind: kind,
                requestedProvider: provider,
                mode: mode,
                registry: reg
            )
            completion(WireFormat.success(result.asDictionary))
        } catch {
            completion(WireFormat.error("vm adopt: \(error)"))
        }
    }

    private func handleList(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        let reg = try registry(from: action)
        do {
            let specs = try await reg.list()
            var vms: [[String: Any]] = []
            for spec in specs {
                let inst = instance(for: spec.name, action: action)
                let st = await inst?.status ?? .stopped
                let ip = await inst?.ipAddress
                vms.append(successView(for: spec, status: st, ip: ip))
            }
            completion(WireFormat.success(["vms": vms]))
        } catch {
            completion(WireFormat.error("vm list: \(error)"))
        }
    }

    private func handleGet(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String else {
            completion(WireFormat.error("vm get: missing 'name'")); return
        }
        let reg = try registry(from: action)
        do {
            let spec = try await reg.get(name)
            let inst = instance(for: name, action: action)
            let st: VMStatus = await (inst?.status) ?? .stopped
            let ip: String? = await inst?.ipAddress
            completion(WireFormat.success(successView(for: spec, status: st, ip: ip)))
        } catch {
            completion(WireFormat.error("vm get: \(error)"))
        }
    }

    private func handleInspect(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String else {
            completion(WireFormat.error("vm inspect: missing 'name'")); return
        }
        let reg = try registry(from: action)
        do {
            let spec = try await reg.get(name)
            let inst = instance(for: name, action: action)
            let st: VMStatus = await (inst?.status) ?? .stopped
            let lastError: String? = await inst?.lastError
            var data: [String: Any] = successView(for: spec, status: st)
            data["bundlePath"] = await reg.bundle(for: name).bundlePath.path
            if let e = lastError { data["lastError"] = e }
            completion(WireFormat.success(data))
        } catch {
            completion(WireFormat.error("vm inspect: \(error)"))
        }
    }

    private func handleStart(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        if let setup = ensureMacOSCapability() {
            completion(["success": false, "error": "vm start: macOS 15+ required", "setup_required": setup])
            return
        }
        guard let name = action["name"] as? String else {
            completion(WireFormat.error("vm start: missing 'name'")); return
        }
        let headless = (action["headless"] as? Bool) ?? false
        let waitForAgent = (action["waitForAgent"] as? Bool) ?? (action["waitForVsock"] as? Bool) ?? false
        let reg = try registry(from: action)
        let spec = try await reg.get(name)
        let bundle = await reg.bundle(for: name)
        if let existing = instance(for: name, action: action) {
            let st = await existing.status
            if await existing.ownsRuntime || ![VMStatus.stopped, .ready, .error].contains(st) {
                completion(WireFormat.error("vm start: '\(name)' still owns a native runtime or is in state \(st.rawValue); confirm shutdown first"))
                return
            }
        }
        let inst = VMInstance(spec: spec, bundle: bundle, status: .ready)
        putInstance(inst, name: name, action: action)
        do {
            let r = try await inst.start(headless: headless, waitForAgent: waitForAgent)
            // Persist startedAt
            var updated = spec
            updated.startedAt = Date()
            try? await reg.update(updated)
            completion(WireFormat.success([
                "state": r.status.rawValue,
                "transitionMs": r.transitionMs,
                "ipAddress": r.ipAddress as Any
            ]))
        } catch {
            if !(await inst.ownsRuntime) { dropInstance(name: name, action: action) }
            completion(WireFormat.error("vm start: \(error)"))
        }
    }

    private func handleStop(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String else {
            completion(WireFormat.error("vm stop: missing 'name'")); return
        }
        let force = (action["force"] as? Bool) ?? false
        let timeout = timeInterval(from: action["timeout"], default: 60)
        guard let inst = instance(for: name, action: action) else {
            completion(WireFormat.success(["state": VMStatus.stopped.rawValue, "transitionMs": 0]))
            return
        }
        do {
            try await inst.stop(force: force, timeout: timeout)
            dropInstance(name: name, action: action)
            completion(WireFormat.success(["state": VMStatus.stopped.rawValue, "transitionMs": 0]))
        } catch {
            completion(WireFormat.error("vm stop: \(error)"))
        }
    }

    private func handlePause(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String, let inst = instance(for: name, action: action) else {
            completion(WireFormat.error("vm pause: not running")); return
        }
        do {
            try await inst.pause()
            completion(WireFormat.success(["state": VMStatus.paused.rawValue]))
        } catch {
            completion(WireFormat.error("vm pause: \(error)"))
        }
    }

    private func handleResume(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String, let inst = instance(for: name, action: action) else {
            completion(WireFormat.error("vm resume: not running")); return
        }
        do {
            try await inst.resume()
            completion(WireFormat.success(["state": VMStatus.running.rawValue]))
        } catch {
            completion(WireFormat.error("vm resume: \(error)"))
        }
    }

    private func handleDelete(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String else {
            completion(WireFormat.error("vm delete: missing 'name'")); return
        }
        let keepDisk = (action["keepDisk"] as? Bool) ?? false
        try await stopOwnedInstance(name: name, action: action, timeout: 30)
        let reg = try registry(from: action)
        do {
            try await reg.delete(name, keepDisk: keepDisk)
            completion(WireFormat.success(["state": VMStatus.deleted.rawValue]))
        } catch {
            completion(WireFormat.error("vm delete: \(error)"))
        }
    }

    private func handleExec(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard action["user"] == nil else {
            completion(WireFormat.failure("unsupported_operation", "vm exec user selection is unavailable in the retained guest adapters; no field was ignored")); return
        }
        guard let name = action["name"] as? String, let inst = instance(for: name, action: action) else {
            completion(WireFormat.error("vm exec: '\(action["name"] as? String ?? "?")' not running"))
            return
        }
        let argv = (action["command"] as? [String]) ?? []
        if argv.isEmpty {
            completion(WireFormat.error("vm exec: 'command' must be a non-empty argv array"))
            return
        }
        let env = (action["env"] as? [String: String]) ?? [:]
        let workdir = action["workdir"] as? String
        let tty = (action["tty"] as? Bool) ?? false
        let timeout = timeInterval(from: action["timeout"], default: 50)
        do {
            let r = try await inst.exec(argv: argv, env: env, workdir: workdir, tty: tty, timeout: timeout)
            completion(WireFormat.success([
                "exitCode": r.exitCode,
                "stdout": r.stdout,
                "stderr": r.stderr,
                "durationMs": r.durationMs
            ]))
        } catch {
            completion(WireFormat.error("vm exec: \(error)"))
        }
    }

    private func guestInstance(from action: [String: Any], verb: String, completion: @escaping @Sendable ([String: Any]) -> Void) -> (name: String, inst: VMInstance)? {
        guard let name = action["name"] as? String, !name.isEmpty else {
            completion(WireFormat.error("vm \(verb): missing 'name'"))
            return nil
        }
        guard let inst = instance(for: name, action: action) else {
            completion(WireFormat.error("vm \(verb): '\(name)' not running"))
            return nil
        }
        return (name, inst)
    }

    private func sanitizedGuestParams(from action: [String: Any], verb: String) -> [String: Any] {
        var params = action
        for key in ["type", "sub", "name", "stateDir"] {
            params.removeValue(forKey: key)
        }
        params["verb"] = verb
        return params
    }

    private func handleGuestScreenshot(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let resolved = guestInstance(from: action, verb: "screenshot", completion: completion) else { return }
        let deadline = try GuestWire.Deadline(seconds: min(50, timeInterval(from: action["timeout"], default: 30)))
        let ping = try await resolved.inst.requestGuest(action: GuestAgentDict(["verb": "ping"]), timeout: try deadline.remaining()).dict
        try GuestWire.requireSnapshot(ping)
        let captureBudget = try deadline.remaining()
        let started = try await resolved.inst.requestGuest(action: GuestAgentDict(["verb": "screenshot", "timeout": captureBudget]), timeout: captureBudget).dict
        let receipt = try GuestWire.SnapshotReceipt(started)
        if action["out"] == nil && receipt.bytes > 700_000 {
            let release = try await resolved.inst.requestGuest(action: GuestAgentDict(["verb": "screenshot_release", "snapshotId": receipt.id]), timeout: try deadline.remaining()).dict
            try receipt.released(release)
            completion(WireFormat.failure("resource_limit", "guest PNG exceeds inline reply capacity; request a host --out path")); return
        }
        var png = Data(); png.reserveCapacity(receipt.bytes)
        while png.count < receipt.bytes {
            let offset = png.count, length = min(GuestWire.snapshotChunkBytes, receipt.bytes - offset)
            let result = try await resolved.inst.requestGuest(action: GuestAgentDict(["verb": "screenshot_chunk", "snapshotId": receipt.id, "offset": offset, "length": length]), timeout: try deadline.remaining()).dict
            png.append(try receipt.chunk(result, offset: offset, length: length))
        }
        try receipt.verify(png)
        guard let source = CGImageSourceCreateWithData(png as CFData, nil), CGImageSourceGetCount(source) == 1,
              CGImageSourceGetType(source) as String? == "public.png",
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary),
              image.width == receipt.width, image.height == receipt.height else { throw GuestAgentError.framing("guest bytes are not one decodable PNG with the recorded physical dimensions") }
        _ = try deadline.remaining()
        let release = try await resolved.inst.requestGuest(action: GuestAgentDict(["verb": "screenshot_release", "snapshotId": receipt.id]), timeout: try deadline.remaining()).dict
        try receipt.released(release)
        var payload: [String: Any] = ["width": receipt.width, "height": receipt.height, "bytes": receipt.bytes, "format": "png"]
        if let path = action["out"] as? String {
            _ = try deadline.remaining()
            // Reuse the retained exclusive output and actual readback used by
            // Photos and VM copy. Do not overwrite or remove a failed output.
            let output = try PhotosDomain.Output(path)
            guard output.append(png), try output.finish() == png.count else { throw GuestAgentError.framing("host screenshot output write or readback failed; a partial file may remain") }
            _ = try deadline.remaining()
            payload["filePath"] = output.path
        } else { payload["dataUrl"] = "data:image/png;base64," + png.base64EncodedString() }
        completion(WireFormat.success(payload))
    }

    private func handleGuestVerb(_ verb: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let resolved = guestInstance(from: action, verb: verb, completion: completion) else { return }
        let timeout = timeInterval(from: action["timeout"], default: 30)
        do {
            let result = try await resolved.inst.requestGuest(action: GuestAgentDict(sanitizedGuestParams(from: action, verb: verb)), timeout: timeout).dict
            let success = result["success"] as? Bool ?? false
            if !success {
                completion(WireFormat.error("vm \(verb): \(result["error"] as? String ?? "guest verb failed")"))
                return
            }
            if ["type", "click", "keys"].contains(verb) {
                guard var payload = result["data"] as? [String: Any] else {
                    completion(WireFormat.failure("partial_result", "vm input omitted its actual submission receipt; inspect guest state before retrying")); return
                }
                payload["name"] = resolved.name; payload["operation"] = verb
                do {
                    let bytes = try JSONSerialization.data(withJSONObject: payload)
                    let receipt = try JSONDecoder().decode(DesktopVmInput.self, from: bytes)
                    guard receipt.transport.rawValue == "coregraphics", receipt.submittedEvents.isFinite,
                          receipt.submittedEvents.rounded(.towardZero) == receipt.submittedEvents,
                          (0...65536).contains(receipt.submittedEvents), !receipt.guestEffectVerified else { throw GuestAgentError.framing("input needs actual bounded native submission without invented guest effects") }
                    if verb == "type" {
                        guard let text = action["text"] as? String, receipt.textUTF8Bytes == Double(text.utf8.count), receipt.submittedEvents == Double(text.unicodeScalars.count * 2), receipt.keys == nil, receipt.x == nil, receipt.y == nil, receipt.button == nil else { throw GuestAgentError.framing("guest Unicode submission differs") }
                    } else if verb == "keys" {
                        guard receipt.keys == (action["keys"] as? String), receipt.submittedEvents == 2, receipt.textUTF8Bytes == nil, receipt.x == nil, receipt.y == nil, receipt.button == nil else { throw GuestAgentError.framing("guest chord submission differs") }
                    } else {
                        guard receipt.x == (action["x"] as? NSNumber)?.doubleValue, receipt.y == (action["y"] as? NSNumber)?.doubleValue, receipt.button == (action["button"] as? String ?? "left"), receipt.submittedEvents == 2, receipt.textUTF8Bytes == nil, receipt.keys == nil else { throw GuestAgentError.framing("guest click submission differs") }
                    }
                    completion(WireFormat.success(payload))
                } catch { completion(WireFormat.failure("partial_result", "vm input receipt failed validation: \(error); inspect guest state before retrying")) }
                return
            }
            guard let raw = result["data"] as? [String: Any] else { throw GuestAgentError.framing("guest read omitted its payload") }
            let payload = try GuestReadValidation.payload(raw, verb: verb, action: action, name: resolved.name)
            completion(WireFormat.success(payload))
        } catch {
            completion(WireFormat.error("vm \(verb): \(error)"))
        }
    }

    private func handleCp(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let resolved = guestInstance(from: action, verb: "cp", completion: completion) else { return }
        guard let src = action["src"] as? String, let dst = action["dst"] as? String else {
            completion(WireFormat.failure("invalid_request", "vm cp requires source and destination"))
            return
        }
        let guestPrefix = "\(resolved.name):"
        let incoming = dst.hasPrefix(guestPrefix), outgoing = src.hasPrefix(guestPrefix)
        let guestPath = String((incoming ? dst : src).dropFirst(guestPrefix.count))
        let hostPath = ((incoming ? src : dst) as NSString).expandingTildeInPath
        guard incoming != outgoing, hostPath.hasPrefix("/"), !hostPath.contains("\0"), guestPath.hasPrefix("/"), !guestPath.contains("\0"),
              !guestPath.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else {
            completion(WireFormat.failure("invalid_request", "vm cp requires one exact absolute guest path and one absolute host file")); return
        }
        let clock = ContinuousClock(), timeout = min(50, timeInterval(from: action["timeout"], default: 50))
        let deadline = clock.now.advanced(by: .seconds(timeout))
        func remaining() throws -> TimeInterval {
            let delta = clock.now.duration(to: deadline).components
            let seconds = Double(delta.seconds) + Double(delta.attoseconds) / 1e18
            guard seconds > 0 else { throw GuestAgentError.timeout("copy deadline expired; inspect exact destination before retrying") }
            return seconds
        }
        func guestBytes(_ reply: [String: Any]) throws -> Data { try GuestWire.copyBytes(reply, path: guestPath) }
        var admitted = false
        do {
            // Old agents silently replace destinations. Check the actual
            // implementation protocol before submitting either copy verb.
            let probe = try await resolved.inst.requestGuest(action: GuestAgentDict(["verb": "ping"]), timeout: remaining()).dict
            try GuestWire.requireExclusiveCopy(probe)
            let data: Data
            if incoming {
                data = try PhotosDomain().readFile(hostPath, maxBytes: 1_048_576, allowEmpty: true)
                admitted = true
                let result = try await resolved.inst.requestGuest(action: GuestAgentDict([
                    "verb": "cp_in",
                    "path": guestPath,
                    "dataBase64": data.base64EncodedString(),
                    "timeout": try remaining(),
                ]), timeout: remaining()).dict
                guard result["success"] as? Bool == true else { throw GuestAgentError.remote(result["error"] as? String ?? "guest copy failed") }
                try GuestWire.verifyCopied(result, path: guestPath, data: data)
                let readback = try await resolved.inst.requestGuest(action: GuestAgentDict(["verb": "cp_out", "path": guestPath, "timeout": try remaining()]), timeout: remaining()).dict
                guard try guestBytes(readback) == data else { throw GuestAgentError.framing("guest copy readback differs; destination preserved") }
            } else {
                var metadata = stat()
                guard lstat(hostPath, &metadata) != 0, errno == ENOENT else { throw GuestAgentError.remote("host destination already exists or cannot be checked; nothing replaced") }
                let result = try await resolved.inst.requestGuest(action: GuestAgentDict(["verb": "cp_out", "path": guestPath, "timeout": try remaining()]), timeout: remaining()).dict
                data = try guestBytes(result)
                _ = try remaining()
                let output = try PhotosDomain.Output(hostPath)
                admitted = true
                guard output.append(data), try output.finish(allowEmpty: true) == data.count else { throw GuestAgentError.ioFailure("host output did not pass retained byte readback") }
            }
            _ = try remaining()
            let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            completion(WireFormat.success(["name": resolved.name, "direction": incoming ? "host-to-guest" : "guest-to-host", "source": src, "path": dst,
                                           "bytes": data.count, "sha256": hash, "verified": true, "overwrite": false]))
        } catch {
            completion(WireFormat.failure(admitted ? "partial_result" : "provider_failed", "vm cp: \(error)", details: ["source": src, "destination": dst, "mutationSubmitted": admitted, "partialArtifactPossible": admitted, "observeBeforeRetry": admitted]))
        }
    }

    private func handleTccProfileGenerate(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        let name = action["name"] as? String ?? "guest"
        let fullDisk = action["fullDisk"] as? Bool ?? false
        let includeUserOnly = action["includeUserOnly"] as? Bool ?? false
        let bundleId = (action["bundleId"] as? String) ?? "com.interceptor.guest"
        let appPath = (action["appPath"] as? String) ?? "/Library/PrivilegedHelperTools/InterceptorD"
        let identifierType = (action["identifierType"] as? String) ?? "bundleID"
        let requestedServices = (action["services"] as? [String]).flatMap { $0.isEmpty ? nil : $0 }
            ?? TccProfileGenerator.defaultServices(fullDisk: fullDisk)
        let codeRequirement = (action["codeRequirement"] as? String) ?? "identifier \(bundleId)"
        do {
            let generated = try TccProfileGenerator.generateProfile(
                target: "guest-\(name)",
                bundleId: bundleId,
                appPath: appPath,
                identifierType: identifierType,
                codeRequirement: codeRequirement,
                requestedServices: requestedServices,
                includeUserOnly: includeUserOnly
            )
            var result: [String: Any] = [
                "name": name,
                "target": "guest",
                "bundleId": bundleId,
                "appPath": appPath,
                "included": generated.included,
                "skipped": generated.skipped,
                "requiresUserApprovedMdm": true,
            ]
            if let out = action["out"] as? String, !out.isEmpty {
                let url = URL(fileURLWithPath: (out as NSString).expandingTildeInPath)
                try generated.xml.write(to: url, atomically: true, encoding: .utf8)
                result["path"] = url.path
            } else {
                result["profile"] = generated.xml
            }
            completion(WireFormat.success(result))
        } catch {
            completion(WireFormat.error("vm tcc profile generate: \(error)"))
        }
    }

    private func handleShare(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String else {
            completion(WireFormat.error("vm share: missing 'name'")); return
        }
        guard let hostPath = action["hostPath"] as? String, let tag = action["tag"] as? String else {
            completion(WireFormat.error("vm share: missing 'hostPath' or 'tag'")); return
        }
        let readOnly = action["readOnly"] as? Bool ?? true
        let reg = try registry(from: action)
        do {
            var spec = try await reg.get(name)
            spec.shares.removeAll { $0.tag == tag }
            spec.shares.append(VMShareSpec(hostPath: hostPath, tag: tag, readOnly: readOnly))
            try await reg.update(spec)
            let running = instance(for: name, action: action) != nil
            completion(WireFormat.success([
                "name": name,
                "tag": tag,
                "hostPath": hostPath,
                "readOnly": readOnly,
                "requiresRestart": running,
                "note": running ? "Share was added to the persisted spec; restart the VM for Virtualization.framework to attach it." : "Share will attach on next start.",
            ]))
        } catch {
            completion(WireFormat.error("vm share: \(error)"))
        }
    }

    private func handleClone(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let src = action["src"] as? String, let dst = action["dst"] as? String else {
            completion(WireFormat.error("vm clone: missing 'src' or 'dst'")); return
        }
        let reg = try registry(from: action)
        do {
            if let inst = instance(for: src, action: action), await inst.ownsRuntime {
                throw VMInstanceError.invalidTransition("clone requires a stopped source VM")
            }
            let sourceBundle = await reg.bundle(for: src)
            try VMSnapshot.requireStableStorage(bundle: sourceBundle)
            let bundle = try await reg.clone(from: src, to: dst)
            completion(WireFormat.success([
                "name": dst,
                "bundlePath": bundle.bundlePath.path,
                "status": VMStatus.ready.rawValue
            ]))
        } catch {
            completion(WireFormat.error("vm clone: \(error)"))
        }
    }

    private func handlePull(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let image = action["image"] as? String else {
            completion(WireFormat.error("vm pull: missing 'image' OCI ref")); return
        }
        let stateD = stateDir(from: action)
        do {
            let url = try await VMImage.resolveOCIImage(ref: image, stateDir: stateD)
            completion(WireFormat.success(["image": image, "path": url.path]))
        } catch {
            completion(WireFormat.error("vm pull: \(error)"))
        }
    }

    private func handleInstall(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        if let setup = ensureMacOSCapability() {
            completion(["success": false, "error": "vm install: macOS 15+ required", "setup_required": setup])
            return
        }
        guard let name = action["name"] as? String else {
            completion(WireFormat.error("vm install: missing 'name'")); return
        }
        let imageOverride = action["ipsw"] as? String
        let fromLatest = (action["fromLatest"] as? Bool) ?? false
        let stateD = stateDir(from: action)
        let reg = try registry(from: action)
        let spec = try await reg.get(name)
        guard spec.kind == .macos else {
            completion(WireFormat.error("vm install: '\(name)' is kind=\(spec.kind.rawValue); install is macOS-only"))
            return
        }
        let bundle = await reg.bundle(for: name)
        try await stopOwnedInstance(name: name, action: action, timeout: 30)
        try VMSnapshot.requireStableStorage(bundle: bundle)

        #if canImport(Virtualization)
        if #available(macOS 13.0, *) {
            do {
                let imageSpec: String = imageOverride ?? (fromLatest ? "latest" : spec.image)
                let ipswURL = try await VMImage.resolveMacOSImage(spec: imageSpec, stateDir: stateD)
                try await MacRuntime.install(spec: spec, bundle: bundle, ipswURL: ipswURL)
                completion(WireFormat.success([
                    "name": name,
                    "ipsw": ipswURL.path,
                    "status": VMStatus.ready.rawValue
                ]))
            } catch {
                completion(WireFormat.error("vm install: \(error)"))
            }
            return
        }
        #endif
        completion(WireFormat.error("vm install: requires macOS 13+ host with Virtualization.framework"))
    }

    private func handleReset(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String else {
            completion(WireFormat.error("vm reset: missing 'name'")); return
        }
        let reg = try registry(from: action)
        _ = try await reg.get(name)
        try await stopOwnedInstance(name: name, action: action, timeout: 30)
        completion(WireFormat.success(["state": VMStatus.ready.rawValue, "name": name]))
    }

    private func handleSnapshot(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        let op = (action["snapshotOp"] as? String) ?? "create"
        if op == "restore" {
            try await handleRestore(action, completion: completion)
            return
        }
        guard ["create", "list", "delete"].contains(op) else {
            completion(WireFormat.failure("invalid_request", "vm snapshot: unknown snapshot operation '\(op)'"))
            return
        }
        guard let name = action["name"] as? String else {
            completion(WireFormat.error("vm snapshot: missing 'name'")); return
        }
        let reg = try registry(from: action)
        let bundle = await reg.bundle(for: name)
        switch op {
        case "list":
            let tags = VMSnapshot.list(bundle: bundle)
            completion(WireFormat.success(["snapshots": tags]))
        case "delete":
            guard let tag = action["tag"] as? String else {
                completion(WireFormat.error("vm snapshot delete: missing 'tag'")); return
            }
            do {
                try VMSnapshot.delete(bundle: bundle, tag: tag)
                completion(WireFormat.success(["tag": tag, "deleted": true]))
            } catch {
                completion(WireFormat.error("vm snapshot delete: \(error)"))
            }
        case "create":
            // create — requires the VM to be paused for paused-state snapshots.
            guard let tag = action["tag"] as? String else {
                completion(WireFormat.error("vm snapshot create: missing 'tag'")); return
            }
            let diskOnly = action["diskOnly"] as? Bool ?? false
            let pausedStateOnly = action["pausedStateOnly"] as? Bool ?? false
            if !diskOnly, let inst = instance(for: name, action: action) {
                let mode: VMSnapshot.Mode = pausedStateOnly ? .pausedStateOnly : .both
                do {
                    let manifest = try await inst.createSnapshot(tag: tag, mode: mode)
                    completion(WireFormat.success([
                        "tag": manifest.tag,
                        "kind": manifest.kind,
                        "hasPausedState": manifest.hasPausedState,
                        "hasDiskClone": manifest.hasDiskClone,
                    ]))
                } catch {
                    completion(WireFormat.error("vm snapshot create: \(error)"))
                }
                return
            }
            if pausedStateOnly {
                completion(WireFormat.error("vm snapshot create: paused-state snapshot requires a running paused VM"))
                return
            }
            if let inst = instance(for: name, action: action), await inst.ownsRuntime {
                throw VMInstanceError.invalidTransition("disk-only snapshot requires a stopped VM")
            }
            // Disk-only snapshot — clonefile of Disk.img.
            let snapDir = bundle.snapshotDir(tag: tag)
            if FileManager.default.fileExists(atPath: snapDir.path) {
                completion(WireFormat.error("vm snapshot create: tag '\(tag)' already exists"))
                return
            }
            do {
                try FileManager.default.createDirectory(at: snapDir, withIntermediateDirectories: true)
                guard FileManager.default.fileExists(atPath: bundle.diskPath.path) else { throw VMSnapshotError.missing("snapshot has no actual Disk.img") }
                let dst = snapDir.appendingPathComponent("Disk.img")
                try FileManager.default.copyItem(at: bundle.diskPath, to: dst)
                if FileManager.default.fileExists(atPath: bundle.auxStoragePath.path) {
                    try FileManager.default.copyItem(at: bundle.auxStoragePath, to: snapDir.appendingPathComponent("AuxiliaryStorage"))
                }
                let m = VMSnapshotManifest(tag: tag, kind: "disk-only", createdAt: Date(), hasPausedState: false, hasDiskClone: true, notes: nil)
                let enc = JSONEncoder()
                enc.outputFormatting = [.prettyPrinted, .sortedKeys]
                enc.dateEncodingStrategy = .iso8601
                let data = try enc.encode(m)
                try data.write(to: bundle.snapshotManifest(tag: tag), options: .atomic)
                completion(WireFormat.success(["tag": tag, "kind": "disk-only"]))
            } catch {
                completion(WireFormat.error("vm snapshot create: \(error)"))
            }
        default:
            completion(WireFormat.failure("invalid_request", "vm snapshot: unknown snapshot operation '\(op)'"))
        }
    }

    private func handleRestore(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String, let tag = action["tag"] as? String else {
            completion(WireFormat.error("vm restore: missing 'name' or 'tag'")); return
        }
        let reg = try registry(from: action)
        let bundle = await reg.bundle(for: name)
        let spec = try await reg.get(name)
        let diskOnly = action["diskOnly"] as? Bool ?? false
        let pausedStateOnly = action["pausedStateOnly"] as? Bool ?? false
        let headless = action["headless"] as? Bool ?? true
        try await stopOwnedInstance(name: name, action: action, timeout: 10)
        let inst = VMInstance(spec: spec, bundle: bundle, status: .stopped)
        putInstance(inst, name: name, action: action)
        do {
            let manifest = try await inst.restoreSnapshot(
                tag: tag,
                diskOnly: diskOnly,
                pausedStateOnly: pausedStateOnly,
                headless: headless
            )
            let status = await inst.status
            if !(await inst.ownsRuntime) { dropInstance(name: name, action: action) }
            completion(WireFormat.success([
                "tag": manifest.tag,
                "state": status.rawValue,
                "kind": manifest.kind,
                "hasPausedState": manifest.hasPausedState,
                "hasDiskClone": manifest.hasDiskClone,
                "restored": status == .paused ? "paused-state" : "disk",
            ]))
        } catch {
            if !(await inst.ownsRuntime) { dropInstance(name: name, action: action) }
            completion(WireFormat.error("vm restore: \(error)"))
        }
    }

    private func handleConsole(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let resolved = guestInstance(from: action, verb: "console", completion: completion) else { return }
        let timeout = timeInterval(from: action["timeout"], default: 1)
        do {
            if let text = action["write"] as? String {
                let bytes = try await resolved.inst.consoleWrite(text)
                completion(WireFormat.success(["bytesWritten": bytes]))
                return
            }
            let maxBytes = intValue(from: action["maxBytes"]) ?? 4096
            let data = try await resolved.inst.consoleRead(maxBytes: maxBytes, timeout: timeout)
            completion(WireFormat.success([
                "bytes": data.count,
                "text": String(data: data, encoding: .utf8) ?? "",
                "dataBase64": data.base64EncodedString(),
            ]))
        } catch {
            completion(WireFormat.error("vm console: \(error)"))
        }
    }

    private func handlePortForward(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let resolved = guestInstance(from: action, verb: "port-forward", completion: completion) else { return }
        let hostAddress = action["hostAddress"] as? String ?? "127.0.0.1"
        let hostPort = intValue(from: action["hostPort"]) ?? 0
        guard let guestPort = intValue(from: action["guestPort"]) else {
            completion(WireFormat.error("vm port-forward: missing guest port; use <hostPort>:<guestPort> or <hostAddress>:<hostPort>:<guestPort>"))
            return
        }
        guard (0...65535).contains(hostPort), (1...65535).contains(guestPort) else {
            completion(WireFormat.error("vm port-forward: ports must be in range"))
            return
        }
        do {
            let result = try await resolved.inst.portForward(hostAddress: hostAddress, hostPort: hostPort, guestPort: guestPort)
            completion(WireFormat.success([
                "hostAddress": result.hostAddress,
                "hostPort": result.hostPort,
                "guestAddress": result.guestAddress,
                "guestPort": result.guestPort,
            ]))
        } catch {
            completion(WireFormat.error("vm port-forward: \(error)"))
        }
    }
}
