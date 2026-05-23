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
// per Spec 9 when the recovery is well-known (no
// com.apple.security.virtualization entitlement, macOS < 15, etc.).

import Foundation
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
    /// Cache of running VM instances keyed by name. Created on `vm start`,
    /// dropped on `vm stop` / `vm delete`. The actor inside each entry
    /// serializes per-VM verbs.
    private let lock = NSLock()
    private var instances: [String: VMInstance] = [:]

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = (action["sub"] as? String ?? command).replacingOccurrences(of: "-", with: "_")
        // [String: Any] isn't Sendable; wrap in the same UncheckedSendableBox
        // pattern Transport.swift uses (Transport.swift:234).
        let boxed = VmActionBox(action: action)
        Task.detached { [weak self] in
            guard let self = self else { return }
            await self.dispatch(sub: sub, action: boxed.action, completion: completion)
        }
    }

    private func dispatch(sub: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async {
        do {
            switch sub {
            case "create":  try await handleCreate(action, completion: completion)
            case "adopt":   try await handleAdopt(action, completion: completion)
            case "list":    try handleList(action, completion: completion)
            case "get":     try handleGet(action, completion: completion)
            case "inspect": try handleInspect(action, completion: completion)
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
            case "screenshot": try await handleGuestVerb("screenshot", action: action, completion: completion)
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
            case "console", "port_forward":
                completion(WireFormat.error("vm \(sub): pending v2 — console/port-forward require VM runtime device wiring"))
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

    private func instance(for name: String) -> VMInstance? {
        lock.lock(); defer { lock.unlock() }
        return instances[name]
    }

    private func putInstance(_ inst: VMInstance, name: String) {
        lock.lock(); instances[name] = inst; lock.unlock()
    }

    private func dropInstance(name: String) {
        lock.lock(); instances.removeValue(forKey: name); lock.unlock()
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
            shares: shares, rosetta: rosetta
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

    private func handleList(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) throws {
        let reg = try registry(from: action)
        Task {
            let specs = try await reg.list()
            let runningNames: Set<String> = {
                lock.lock(); defer { lock.unlock() }
                return Set(instances.keys)
            }()
            var vms: [[String: Any]] = []
            for spec in specs {
                let st: VMStatus = runningNames.contains(spec.name) ? .running : .stopped
                vms.append(successView(for: spec, status: st))
            }
            completion(WireFormat.success(["vms": vms]))
        }
    }

    private func handleGet(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) throws {
        guard let name = action["name"] as? String else {
            completion(WireFormat.error("vm get: missing 'name'")); return
        }
        let reg = try registry(from: action)
        Task {
            do {
                let spec = try await reg.get(name)
                let inst = instance(for: name)
                let st: VMStatus = await (inst?.status) ?? .stopped
                let ip: String? = await inst?.ipAddress
                completion(WireFormat.success(successView(for: spec, status: st, ip: ip)))
            } catch {
                completion(WireFormat.error("vm get: \(error)"))
            }
        }
    }

    private func handleInspect(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) throws {
        guard let name = action["name"] as? String else {
            completion(WireFormat.error("vm inspect: missing 'name'")); return
        }
        let reg = try registry(from: action)
        Task {
            do {
                let spec = try await reg.get(name)
                let inst = instance(for: name)
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
        let waitForVsock = (action["waitForVsock"] as? Bool) ?? false
        let reg = try registry(from: action)
        let spec = try await reg.get(name)
        let bundle = await reg.bundle(for: name)
        if let existing = instance(for: name) {
            let st = await existing.status
            if st == .running {
                completion(WireFormat.error("vm start: '\(name)' already running"))
                return
            }
        }
        let inst = VMInstance(spec: spec, bundle: bundle, status: .ready)
        putInstance(inst, name: name)
        do {
            let r = try await inst.start(headless: headless, waitForVsock: waitForVsock)
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
            dropInstance(name: name)
            completion(WireFormat.error("vm start: \(error)"))
        }
    }

    private func handleStop(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String else {
            completion(WireFormat.error("vm stop: missing 'name'")); return
        }
        let force = (action["force"] as? Bool) ?? false
        let timeout = timeInterval(from: action["timeout"], default: 60)
        guard let inst = instance(for: name) else {
            completion(WireFormat.success(["state": VMStatus.stopped.rawValue, "transitionMs": 0]))
            return
        }
        do {
            try await inst.stop(force: force, timeout: timeout)
            dropInstance(name: name)
            completion(WireFormat.success(["state": VMStatus.stopped.rawValue, "transitionMs": 0]))
        } catch {
            completion(WireFormat.error("vm stop: \(error)"))
        }
    }

    private func handlePause(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String, let inst = instance(for: name) else {
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
        guard let name = action["name"] as? String, let inst = instance(for: name) else {
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
        // Stop first if running.
        if let inst = instance(for: name) {
            let st = await inst.status
            if st == .running || st == .paused {
                try? await inst.stop(force: true, timeout: 30)
            }
            dropInstance(name: name)
        }
        let reg = try registry(from: action)
        do {
            try await reg.delete(name, keepDisk: keepDisk)
            completion(WireFormat.success(["state": VMStatus.deleted.rawValue]))
        } catch {
            completion(WireFormat.error("vm delete: \(error)"))
        }
    }

    private func handleExec(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String, let inst = instance(for: name) else {
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
        let timeout = timeInterval(from: action["timeout"], default: 60)
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
        guard let inst = instance(for: name) else {
            completion(WireFormat.error("vm \(verb): '\(name)' not running"))
            return nil
        }
        return (name, inst)
    }

    private func sanitizedGuestParams(from action: [String: Any], verb: String) -> [String: Any] {
        var params = action
        for key in ["type", "sub", "name", "stateDir", "timeout"] {
            params.removeValue(forKey: key)
        }
        params["verb"] = verb
        return params
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
            completion(WireFormat.success((result["data"] as? [String: Any]) ?? result))
        } catch {
            completion(WireFormat.error("vm \(verb): \(error)"))
        }
    }

    private func handleCp(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let resolved = guestInstance(from: action, verb: "cp", completion: completion) else { return }
        guard let src = action["src"] as? String, let dst = action["dst"] as? String else {
            completion(WireFormat.error("vm cp: missing 'src' or 'dst'"))
            return
        }
        let timeout = timeInterval(from: action["timeout"], default: 60)
        let guestPrefix = "\(resolved.name):"
        do {
            if dst.hasPrefix(guestPrefix) {
                let guestPath = String(dst.dropFirst(guestPrefix.count))
                let srcURL = URL(fileURLWithPath: (src as NSString).expandingTildeInPath)
                let data = try Data(contentsOf: srcURL)
                let result = try await resolved.inst.requestGuest(action: GuestAgentDict([
                    "verb": "cp_in",
                    "path": guestPath,
                    "dataBase64": data.base64EncodedString(),
                ]), timeout: timeout).dict
                let success = result["success"] as? Bool ?? false
                if !success {
                    completion(WireFormat.error("vm cp: \(result["error"] as? String ?? "guest cp_in failed")"))
                    return
                }
                completion(WireFormat.success((result["data"] as? [String: Any]) ?? result))
                return
            }
            if src.hasPrefix(guestPrefix) {
                let guestPath = String(src.dropFirst(guestPrefix.count))
                let result = try await resolved.inst.requestGuest(action: GuestAgentDict([
                    "verb": "cp_out",
                    "path": guestPath,
                ]), timeout: timeout).dict
                let success = result["success"] as? Bool ?? false
                if !success {
                    completion(WireFormat.error("vm cp: \(result["error"] as? String ?? "guest cp_out failed")"))
                    return
                }
                guard
                    let dataDict = result["data"] as? [String: Any],
                    let b64 = dataDict["dataBase64"] as? String,
                    let data = Data(base64Encoded: b64)
                else {
                    completion(WireFormat.error("vm cp: guest cp_out returned no dataBase64"))
                    return
                }
                let dstURL = URL(fileURLWithPath: (dst as NSString).expandingTildeInPath)
                try data.write(to: dstURL, options: .atomic)
                completion(WireFormat.success([
                    "path": dstURL.path,
                    "bytes": data.count,
                    "source": guestPath,
                ]))
                return
            }
            completion(WireFormat.error("vm cp: one side must be \(resolved.name):<path>"))
        } catch {
            completion(WireFormat.error("vm cp: \(error)"))
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
            let running = instance(for: name) != nil
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
        // Drop any in-memory instance so the next start rebuilds from the spec.
        dropInstance(name: name)
        completion(WireFormat.success(["state": VMStatus.ready.rawValue, "name": name]))
    }

    private func handleSnapshot(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        let snapSub = action["sub"] as? String  // outer dispatch already pulled this
        // Real outer "sub" is "snapshot"; inner sub here would be passed
        // through `snapshotSub`. CLI sends both: `sub: "snapshot"`,
        // `snapshotOp: "create|list|delete|restore"`.
        let op = (action["snapshotOp"] as? String) ?? "create"
        _ = snapSub
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
        default:
            // create — requires the VM to be paused for paused-state snapshots.
            guard let tag = action["tag"] as? String else {
                completion(WireFormat.error("vm snapshot create: missing 'tag'")); return
            }
            let diskOnly = action["diskOnly"] as? Bool ?? false
            let pausedStateOnly = action["pausedStateOnly"] as? Bool ?? false
            if !diskOnly, let inst = instance(for: name) {
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
            // Disk-only snapshot — clonefile of Disk.img.
            let snapDir = bundle.snapshotDir(tag: tag)
            if FileManager.default.fileExists(atPath: snapDir.path) {
                completion(WireFormat.error("vm snapshot create: tag '\(tag)' already exists"))
                return
            }
            do {
                try FileManager.default.createDirectory(at: snapDir, withIntermediateDirectories: true)
                if FileManager.default.fileExists(atPath: bundle.diskPath.path) {
                    let dst = snapDir.appendingPathComponent("Disk.img")
                    try FileManager.default.copyItem(at: bundle.diskPath, to: dst)
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
        }
    }

    private func handleRestore(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) async throws {
        guard let name = action["name"] as? String, let tag = action["tag"] as? String else {
            completion(WireFormat.error("vm restore: missing 'name' or 'tag'")); return
        }
        let reg = try registry(from: action)
        let bundle = await reg.bundle(for: name)
        let snapDir = bundle.snapshotDir(tag: tag)
        let snapDisk = snapDir.appendingPathComponent("Disk.img")
        guard FileManager.default.fileExists(atPath: snapDisk.path) else {
            completion(WireFormat.error("vm restore: snapshot '\(tag)' has no Disk.img"))
            return
        }
        // Stop the VM first if running.
        if let inst = instance(for: name) {
            try? await inst.stop(force: true, timeout: 10)
            dropInstance(name: name)
        }
        let parked = bundle.bundlePath.appendingPathComponent("Disk.img.pre-restore-\(Int(Date().timeIntervalSince1970))")
        do {
            if FileManager.default.fileExists(atPath: bundle.diskPath.path) {
                try FileManager.default.moveItem(at: bundle.diskPath, to: parked)
            }
            try FileManager.default.copyItem(at: snapDisk, to: bundle.diskPath)
            try? FileManager.default.removeItem(at: parked)
            completion(WireFormat.success(["tag": tag, "restored": "disk"]))
        } catch {
            // best-effort rollback
            try? FileManager.default.moveItem(at: parked, to: bundle.diskPath)
            completion(WireFormat.error("vm restore: \(error)"))
        }
    }
}
