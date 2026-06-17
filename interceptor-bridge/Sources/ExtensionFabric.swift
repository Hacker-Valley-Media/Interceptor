import Foundation
import Security

// Extension Fabric — the capability-blind loader.
//
// The shipped bridge knows how to DISCOVER an operator-placed extension, verify
// its dylib's signature in software (because hardened-runtime library validation
// is disabled on the bridge — see scripts/entitlements-bridge.plist), dlopen it,
// adapt its C entry point to a `DomainHandler`, and register its prefix. It does
// NOT know what any extension does. All capability-specific code lives inside the
// extension, which is neither in the .pkg nor in the commit tree.
//
// Discovery is filesystem-only (no network fetch, ever). The TS resolver
// (shared/extensions.ts) mirrors the root path + precedence used here.

// MARK: - C-ABI contract (see docs/extensions/bridge-abi.md)
//
// An extension bridge dylib exports:
//   uint32_t itc_ext_abi_version(void);                       // must equal ITC_EXT_ABI_VERSION
//   char*    <entry>(const char* commandJSON, const char* actionJSON);  // malloc'd JSON result
//   void     itc_ext_free(char*);                             // OPTIONAL — frees <entry>'s result
//
// `commandJSON` is the envelope {"command":"<verb>"}; `actionJSON` is the full
// action object. The entry returns a malloc'd NUL-terminated JSON object string
// (the bridge result envelope, e.g. {"success":true,"data":...}). Ownership: the
// bridge frees the returned pointer with itc_ext_free if exported, else free().

let ITC_EXT_ABI_VERSION: UInt32 = 1

private typealias ItcExtHandleFn = @convention(c) (UnsafePointer<CChar>?, UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?
private typealias ItcExtAbiVersionFn = @convention(c) () -> UInt32
private typealias ItcExtFreeFn = @convention(c) (UnsafeMutablePointer<CChar>?) -> Void

// MARK: - Manifest (Codable mirror of shared/extensions.ts)

private struct ExtBridgeDomain: Codable { let prefix: String; let dylib: String; let entry: String }
private struct ExtCliVerb: Codable { let verb: String; let actionPrefix: String }
private struct ExtManifest: Codable {
    let name: String
    let version: String
    let bridgeDomains: [ExtBridgeDomain]?
    let cliVerbs: [ExtCliVerb]?
    let agent: [String: String]?
    let skill: String?
    let capabilities: [String]?
}

// MARK: - Adapter: a vended C entry point presented as a Swift DomainHandler

final class ExtensionDomainAdapter: DomainHandler, @unchecked Sendable {
    let prefix: String
    private let handleFn: ItcExtHandleFn
    private let freeFn: ItcExtFreeFn?

    fileprivate init(prefix: String, handleFn: ItcExtHandleFn, freeFn: ItcExtFreeFn?) {
        self.prefix = prefix
        self.handleFn = handleFn
        self.freeFn = freeFn
    }

    // The DomainHandler completion is @escaping, but the C entry is synchronous —
    // so we adopt the BLOCKING-ON-A-BACKGROUND-QUEUE adapter (documented choice in
    // bridge-abi.md): run the C call off the bridge's pump, then complete. This
    // mirrors NativeDomain's existing global-queue dispatch.
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            completion(self.invoke(command: command, action: action))
        }
    }

    private func invoke(command: String, action: [String: Any]) -> [String: Any] {
        // commandJSON envelope carries the verb (Router delivers it as `command`,
        // NOT action["sub"]).
        guard
            let cmdData = try? JSONSerialization.data(withJSONObject: ["command": command], options: []),
            let commandJSON = String(data: cmdData, encoding: .utf8)
        else {
            return WireFormat.error("extension \(prefix): could not serialize command")
        }
        guard
            JSONSerialization.isValidJSONObject(action),
            let actionData = try? JSONSerialization.data(withJSONObject: action, options: []),
            let actionJSON = String(data: actionData, encoding: .utf8)
        else {
            return WireFormat.error("extension \(prefix): could not serialize action")
        }
        let resultPtr: UnsafeMutablePointer<CChar>? = commandJSON.withCString { cmdC in
            actionJSON.withCString { actC in
                self.handleFn(cmdC, actC)
            }
        }
        guard let resultPtr = resultPtr else {
            return WireFormat.error("extension \(prefix): handler returned null")
        }
        let resultStr = String(cString: resultPtr)
        if let freeFn = freeFn { freeFn(resultPtr) } else { free(resultPtr) }
        guard
            let resultData = resultStr.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: resultData),
            let dict = obj as? [String: Any]
        else {
            return WireFormat.error("extension \(prefix): handler returned non-object JSON")
        }
        return dict
    }
}

// MARK: - Loader

enum ExtensionFabric {

    /// Discovery root — `INTERCEPTOR_EXTENSIONS_DIR` override, else
    /// `~/.interceptor/extensions`. MUST match shared/extensions.ts. Reads via
    /// getenv() (not the cached ProcessInfo snapshot) so an in-process override
    /// (tests) is honored.
    static func extensionsRoot() -> String {
        if let c = getenv("INTERCEPTOR_EXTENSIONS_DIR") {
            let s = String(cString: c)
            if !s.isEmpty { return s }
        }
        return (NSHomeDirectory() as NSString).appendingPathComponent(".interceptor/extensions")
    }

    private struct TrustConfig { let teamIds: [String]; let allowUnsigned: Bool }

    /// Operator-pinned trust policy for extension dylibs. Read from
    /// `~/.interceptor/extension-trust.json` ({ "teamIds": [...], "allowUnsigned": false })
    /// with env overrides `INTERCEPTOR_EXT_TEAM_IDS` (comma-separated) and
    /// `INTERCEPTOR_EXT_ALLOW_UNSIGNED=1` (the `--allow-unsigned-extensions` opt-in).
    private static func loadTrustConfig() -> TrustConfig {
        var teamIds: [String] = []
        var allowUnsigned = false
        let path = (NSHomeDirectory() as NSString).appendingPathComponent(".interceptor/extension-trust.json")
        if let data = FileManager.default.contents(atPath: path),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let ids = obj["teamIds"] as? [String] { teamIds = ids }
            if let au = obj["allowUnsigned"] as? Bool { allowUnsigned = au }
        }
        let env = ProcessInfo.processInfo.environment
        if let ids = env["INTERCEPTOR_EXT_TEAM_IDS"], !ids.isEmpty {
            teamIds = ids.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        if env["INTERCEPTOR_EXT_ALLOW_UNSIGNED"] == "1" { allowUnsigned = true }
        return TrustConfig(teamIds: teamIds, allowUnsigned: allowUnsigned)
    }

    /// Software re-imposition of library validation. Because the
    /// hardened runtime's own library validation is disabled on the bridge, verify
    /// each foreign dylib BEFORE dlopen:
    ///   1. integrity — SecStaticCodeCheckValidity with kSecCSCheckAllArchitectures
    ///      (a fat dylib could otherwise pass on an ad-hoc/unsigned slice — Apple doc);
    ///   2. provenance — Team Identifier must be in the operator allowlist (if any).
    /// Unsigned dylibs return errSecCSUnsigned; loaded only under the opt-in.
    private static func validateSignature(path: String, trust: TrustConfig) -> (ok: Bool, reason: String) {
        let url = URL(fileURLWithPath: path) as CFURL
        var staticCode: SecStaticCode?
        let createStatus = SecStaticCodeCreateWithPath(url, SecCSFlags(rawValue: 0), &staticCode)
        guard createStatus == errSecSuccess, let code = staticCode else {
            return (false, "could not create static code object (OSStatus \(createStatus))")
        }
        let checkFlags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures)
        let checkStatus = SecStaticCodeCheckValidity(code, checkFlags, nil)
        if checkStatus == errSecCSUnsigned {
            return trust.allowUnsigned
                ? (true, "unsigned (loaded via allowUnsigned opt-in)")
                : (false, "dylib is unsigned; sign it or set extension-trust allowUnsigned / INTERCEPTOR_EXT_ALLOW_UNSIGNED=1")
        }
        if checkStatus != errSecSuccess {
            return (false, "code signature invalid (OSStatus \(checkStatus))")
        }
        if !trust.teamIds.isEmpty {
            var infoCF: CFDictionary?
            let infoStatus = SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &infoCF)
            guard infoStatus == errSecSuccess, let info = infoCF as? [String: Any] else {
                return (false, "could not read signing information (OSStatus \(infoStatus))")
            }
            let team = info[kSecCodeInfoTeamIdentifier as String] as? String
            guard let team = team, trust.teamIds.contains(team) else {
                return (false, "signing team \(team ?? "<none>") not in operator allowlist")
            }
        }
        return (true, "valid")
    }

    private static let prefixRegex = try? NSRegularExpression(pattern: "^[a-z][a-z0-9]*$")

    private static func isValidPrefix(_ s: String) -> Bool {
        guard let re = prefixRegex else { return false }
        return re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// Scan, validate, dlopen, and register every extension bridge domain. Runs
    /// AFTER all built-in `router.register(...)` calls in main.swift so the
    /// reserved-prefix check (router.isRegistered) sees the full built-in set.
    /// Every failure is isolated + logged; nothing here is ever fatal to the bridge.
    static func loadAll(into router: Router) {
        let root = extensionsRoot()
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: root) else {
            return // no extensions installed — capability-blind core runs as-is
        }
        let trust = loadTrustConfig()
        for name in names.sorted() {
            let dir = (root as NSString).appendingPathComponent(name)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue else { continue }
            let manifestPath = (dir as NSString).appendingPathComponent("manifest.json")
            guard fm.fileExists(atPath: manifestPath) else { continue }
            guard let data = fm.contents(atPath: manifestPath) else {
                Platform.log("extension \(name): cannot read manifest.json — skipped"); continue
            }
            guard let manifest = try? JSONDecoder().decode(ExtManifest.self, from: data) else {
                Platform.log("extension \(name): invalid manifest.json shape — skipped"); continue
            }
            for domain in manifest.bridgeDomains ?? [] {
                loadDomain(name: name, dir: dir, domain: domain, trust: trust, router: router)
            }
        }
    }

    private static func loadDomain(name: String, dir: String, domain: ExtBridgeDomain, trust: TrustConfig, router: Router) {
        guard isValidPrefix(domain.prefix) else {
            Platform.log("extension \(name): prefix '\(domain.prefix)' is not a single lowercase token — skipped"); return
        }
        guard !router.isRegistered(domain.prefix) else {
            Platform.log("extension \(name): prefix '\(domain.prefix)' collides with a registered domain — skipped"); return
        }
        let dylibPath = (dir as NSString).appendingPathComponent(domain.dylib)
        guard FileManager.default.fileExists(atPath: dylibPath) else {
            Platform.log("extension \(name): bridge dylib not found at \(domain.dylib) — skipped"); return
        }
        let verdict = validateSignature(path: dylibPath, trust: trust)
        guard verdict.ok else {
            Platform.log("extension \(name) domain '\(domain.prefix)': signature check failed — \(verdict.reason); skipped"); return
        }
        guard let handle = dlopen(dylibPath, RTLD_NOW) else {
            let err = String(cString: dlerror())
            Platform.log("extension \(name): dlopen failed for \(domain.dylib): \(err) — skipped"); return
        }
        guard let verSym = dlsym(handle, "itc_ext_abi_version") else {
            Platform.log("extension \(name): missing itc_ext_abi_version — skipped"); return
        }
        let abiVersion = unsafeBitCast(verSym, to: ItcExtAbiVersionFn.self)()
        guard abiVersion == ITC_EXT_ABI_VERSION else {
            Platform.log("extension \(name): ABI version \(abiVersion) != \(ITC_EXT_ABI_VERSION) — skipped"); return
        }
        guard let entrySym = dlsym(handle, domain.entry) else {
            Platform.log("extension \(name): entry symbol '\(domain.entry)' not found — skipped"); return
        }
        let handleFn = unsafeBitCast(entrySym, to: ItcExtHandleFn.self)
        let freeFn: ItcExtFreeFn? = dlsym(handle, "itc_ext_free").map { unsafeBitCast($0, to: ItcExtFreeFn.self) }
        let adapter = ExtensionDomainAdapter(prefix: domain.prefix, handleFn: handleFn, freeFn: freeFn)
        router.register(domain.prefix, handler: adapter)
        Platform.log("extension \(name): registered bridge domain '\(domain.prefix)' (entry \(domain.entry))")
        Platform.emitEvent("extension_loaded", data: ["name": name, "prefix": domain.prefix])
    }
}
