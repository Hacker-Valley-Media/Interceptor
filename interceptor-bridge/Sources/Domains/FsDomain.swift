// native filesystem primitives — fs_read, fs_write, fs_search.
// Replaces the linux read / write / edit / grep primitives at the model
// boundary. Uses Foundation FileManager + UTType (where available) and
// NSMetadataQuery for indexed search via Spotlight.

import Foundation
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

final class FsDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        switch command {
        case "read":
            handleRead(action, completion: completion)
        case "write":
            handleWrite(action, completion: completion)
        case "search":
            handleSearch(action, completion: completion)
        default:
            completion(WireFormat.error("fs: unknown command \(command)"))
        }
    }

    // MARK: fs_read
    private func handleRead(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let absolutePath = resolvePath(action) else {
            completion(WireFormat.error("fs_read: missing path or unresolvable ref"))
            return
        }
        let encoding = (action["encoding"] as? String) ?? "utf8"
        let byteRange = action["byteRange"] as? [String: Any]

        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: absolutePath, isDirectory: &isDir) else {
            completion(WireFormat.error("fs_read: file not found: \(absolutePath)"))
            return
        }
        if isDir.boolValue {
            completion(WireFormat.error("fs_read: path is a directory: \(absolutePath)"))
            return
        }
        do {
            let attrs = try fm.attributesOfItem(atPath: absolutePath)
            let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
            let modified = (attrs[.modificationDate] as? Date)?.iso8601 ?? ""
            let url = URL(fileURLWithPath: absolutePath)
            var contentType: String = "public.data"
            #if canImport(UniformTypeIdentifiers)
            if #available(macOS 11.0, *) {
                if let type = try? url.resourceValues(forKeys: [.contentTypeKey]).contentType {
                    contentType = type.identifier
                }
            }
            #endif

            let data: Data
            if let br = byteRange {
                let start = (br["start"] as? Int) ?? 0
                let length = (br["length"] as? Int) ?? max(0, size - start)
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                try handle.seek(toOffset: UInt64(start))
                data = (try? handle.read(upToCount: length)) ?? Data()
            } else {
                data = try Data(contentsOf: url)
            }

            let content: String
            switch encoding {
            case "base64":
                content = data.base64EncodedString()
            case "raw":
                content = data.base64EncodedString() // raw bytes shipped as base64 over JSON
            default: // utf8
                content = String(data: data, encoding: .utf8) ?? data.base64EncodedString()
            }

            completion(WireFormat.success([
                "content": content,
                "encoding": encoding,
                "contentType": contentType,
                "attributes": [
                    "size": size,
                    "modified": modified,
                    "absolutePath": absolutePath
                ]
            ]))
        } catch {
            completion(WireFormat.error("fs_read failed: \(error.localizedDescription)"))
        }
    }

    // MARK: fs_write
    private func handleWrite(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let absolutePath = resolvePath(action) else {
            completion(WireFormat.error("fs_write: missing path or unresolvable ref"))
            return
        }
        guard let content = action["content"] as? String else {
            completion(WireFormat.error("fs_write: missing content"))
            return
        }
        // Defense in depth — never write to system paths regardless of permission rules.
        let denylist = ["/etc/", "/usr/", "/System/", "/private/var/"]
        for d in denylist {
            if absolutePath.hasPrefix(d) {
                completion(WireFormat.error("fs_write: refused — path is in protected denylist: \(absolutePath)"))
                return
            }
        }
        let encoding = (action["encoding"] as? String) ?? "utf8"
        let url = URL(fileURLWithPath: absolutePath)

        // Optional ifMatch precondition based on modified timestamp.
        if let ifMatch = action["ifMatch"] as? [String: Any],
           let expected = ifMatch["modified"] as? String {
            if let attrs = try? FileManager.default.attributesOfItem(atPath: absolutePath),
               let actual = (attrs[.modificationDate] as? Date)?.iso8601, actual != expected {
                completion(WireFormat.error("fs_write: ifMatch precondition failed (file modified at \(actual))"))
                return
            }
        }

        let data: Data
        switch encoding {
        case "base64":
            guard let d = Data(base64Encoded: content) else {
                completion(WireFormat.error("fs_write: content is not valid base64"))
                return
            }
            data = d
        default:
            data = content.data(using: .utf8) ?? Data()
        }

        do {
            // Ensure parent directory exists.
            let parent = (absolutePath as NSString).deletingLastPathComponent
            try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
            let attrs = try FileManager.default.attributesOfItem(atPath: absolutePath)
            let written = (attrs[.size] as? NSNumber)?.intValue ?? data.count
            let modified = (attrs[.modificationDate] as? Date)?.iso8601 ?? ""
            completion(WireFormat.success([
                "written": written,
                "absolutePath": absolutePath,
                "modified": modified
            ]))
        } catch {
            completion(WireFormat.error("fs_write failed: \(error.localizedDescription)"))
        }
    }

    // MARK: fs_search
    //
    // Wire contract (input action fields):
    //   query   String — required, substring match. "*" / "**" → wildcard listing.
    //   scope   String — alias ("everywhere" | "cwd" | "workspace" | "home" |
    //                    "granted" | "path") OR an absolute path. Default: "everywhere".
    //   paths   [String]? — only honored when scope == "path"; multi-root search.
    //   cwd     String? — when scope is "cwd" or "workspace", root the search here.
    //                     If absent, falls back to the user's home directory.
    //   kinds   [String]? — additive UTI-style filter (e.g. "public.folder",
    //                       "directory", "file"). Empty/absent means "any".
    //   limit   Int — cap match count. Default: 20.
    //
    // Behavior:
    //   - "everywhere" uses NSMetadataQueryLocalComputerScope; BFS fallback is
    //     skipped because walking / unbounded would block this thread for
    //     minutes.
    //   - "cwd"/"workspace" route through the optional cwd field.
    //   - "path" with a non-empty paths array searches that multi-root set.
    //   - Wildcard-only queries on a rooted scope return a shallow native
    //     directory listing immediately (source: "direct_listing").
    //   - An unknown scope string is treated as an absolute path; if it isn't
    //     an existing absolute path, the caller gets a structured error
    //     instead of a silent override to home.
    private func handleSearch(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let query = action["query"] as? String, !query.isEmpty else {
            completion(WireFormat.error("fs_search: missing query"))
            return
        }
        let scope = (action["scope"] as? String) ?? "everywhere"
        let limit = (action["limit"] as? Int) ?? 20
        // Deadline for the Spotlight passes. `mdfind` has no timeout flag and
        // the gather phase blocks (Apple: kMDQuerySynchronous); an unbounded
        // content search over a 1.4M-file volume ran past the CLI's 15 s
        // transport timeout and was reported as a TCC problem (2026-09-10).
        let timeoutMs = max(200, (action["timeoutMs"] as? Int) ?? 10_000)
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        let sessionCwd = action["cwd"] as? String
        let homePath = FileManager.default.homeDirectoryForCurrentUser.path
        let requestedKinds = normalizedKinds(action["kinds"] as? [String])

        // Build the list of search roots. Spotlight accepts either path
        // strings or one of the well-known scope constants (e.g.
        // NSMetadataQueryLocalComputerScope = "kMDQueryScopeComputer"). The
        // BFS fallback only walks path roots; for "everywhere" it bails since
        // walking / unbounded would block this thread for minutes.
        let mqScopes: [Any]
        let bfsRoots: [String]
        let scopeLabel: String
        switch scope {
        case "everywhere":
            mqScopes = [NSMetadataQueryLocalComputerScope]
            bfsRoots = []
            scopeLabel = "everywhere"
        case "cwd":
            let root = sessionCwd ?? homePath
            mqScopes = [root]
            bfsRoots = [root]
            scopeLabel = root
        case "workspace":
            let root = sessionCwd ?? homePath
            mqScopes = [root]
            bfsRoots = [root]
            scopeLabel = root
        case "home":
            mqScopes = [homePath]
            bfsRoots = [homePath]
            scopeLabel = homePath
        case "granted":
            // Engine layer enforces the actual permission grant; the bridge
            // scopes to home as the broadest default.
            mqScopes = [homePath]
            bfsRoots = [homePath]
            scopeLabel = homePath
        case "path":
            let paths = (action["paths"] as? [String])?.filter { !$0.isEmpty } ?? []
            if paths.isEmpty {
                completion(WireFormat.error("fs_search: scope 'path' requires a non-empty paths array"))
                return
            }
            // Validate every path; reject the request rather than silently
            // dropping unreadable entries.
            for p in paths {
                if !p.hasPrefix("/") || !FileManager.default.fileExists(atPath: p) {
                    completion(WireFormat.error("fs_search: scope 'path' entry '\(p)' is not an absolute path that exists"))
                    return
                }
            }
            mqScopes = paths
            bfsRoots = paths
            scopeLabel = paths.joined(separator: ":")
        default:
            // Treat any non-alias scope as an absolute path. Validate via
            // FileManager.fileExists before adopting; on miss, return a
            // structured error so the caller sees the rejection instead of
            // a silent override to home.
            if scope.hasPrefix("/"), FileManager.default.fileExists(atPath: scope) {
                mqScopes = [scope]
                bfsRoots = [scope]
                scopeLabel = scope
            } else {
                completion(WireFormat.error("fs_search: scope '\(scope)' is not an alias (everywhere/cwd/workspace/home/granted/path) and not an absolute path that exists"))
                return
            }
        }

        // Finder-style wildcard listing should behave like a directory listing,
        // not a literal substring search for the `*` character. For rooted
        // path scopes, skip Spotlight entirely and return a shallow native
        // listing immediately.
        if isWildcardOnlyQuery(query), !bfsRoots.isEmpty {
            var allMatches: [[String: Any]] = []
            for root in bfsRoots {
                if allMatches.count >= limit { break }
                let remaining = limit - allMatches.count
                let chunk = self.directPathListing(root: root, limit: remaining, requestedKinds: requestedKinds)
                allMatches.append(contentsOf: chunk)
            }
            completion(WireFormat.success([
                "matches": allMatches,
                "indexed": false,
                "source": "direct_listing",
                "scope": scopeLabel,
                "query": query,
                "count": allMatches.count
            ]))
            return
        }

        // Spotlight via `mdfind` (synchronous). NSMetadataQuery's async
        // DidFinishGathering delivery does NOT fire in the faceless launchd-agent
        // context — the query times out and falls back even with an
        // operationQueue set: a deployed faceless bridge was measured timing out
        // at ~2.18s and falling back, while `mdfind` from the same process
        // returned results instantly. `mdfind` is a fresh process that connects
        // to the metadata server directly and returns results synchronously
        // regardless of run-loop context. `mqScopes` is retained above for the
        // scope-resolution/validation it performs; the actual Spotlight scoping
        // now flows through `bfsRoots` as `mdfind -onlyin` roots.
        _ = mqScopes
        let spotlight = self.spotlightSearchViaMdfind(
            query: query,
            scopePaths: bfsRoots,                 // [] for "everywhere" → no -onlyin
            nameOnly: scope == "everywhere",      // content across the whole machine is unbounded
            limit: limit,
            requestedKinds: requestedKinds,
            deadline: deadline
        )
        if !spotlight.matches.isEmpty || spotlight.partial {
            var payload: [String: Any] = [
                "matches": spotlight.matches,
                "indexed": true,
                "source": "spotlight",
                "scope": scopeLabel,
                "query": query,
                "count": spotlight.matches.count,
                "partial": spotlight.partial,
                "deadlineMs": timeoutMs
            ]
            if spotlight.partial {
                payload["hint"] = "the \(timeoutMs) ms deadline cut the Spotlight \(spotlight.cutPass ?? "content") pass; results are what arrived in time. Narrow --scope, add --kinds, or raise --timeout-ms."
            }
            completion(WireFormat.success(payload))
            return
        }

        // Spotlight returned nothing (or mdfind unavailable) → breadth-first
        // fallback across the path roots (empty for "everywhere", so that scope
        // simply yields no matches rather than an unbounded walk).
        var allMatches: [[String: Any]] = []
        for root in bfsRoots {
            if allMatches.count >= limit { break }
            let remaining = limit - allMatches.count
            let chunk = self.fallbackBfsSearch(query: query, root: root, limit: remaining, requestedKinds: requestedKinds)
            allMatches.append(contentsOf: chunk)
        }
        completion(WireFormat.success([
            "matches": allMatches,
            "indexed": false,
            "source": "fallback",
            "scope": scopeLabel,
            "query": query,
            "count": allMatches.count
        ]))
    }

    /// Synchronous Spotlight search via `mdfind`. Returns enriched matches, or
    /// `[]` on no result / mdfind-unavailable (caller then runs the BFS
    /// fallback). Mirrors the old NSMetadataQuery predicate: name-only for
    /// machine-wide scope, name+content for rooted scopes. Runs one `mdfind` per
    /// scope root (mdfind takes a single `-onlyin`), or one global run when
    /// unscoped. Results are enriched with kind/size/modified in-process via
    /// URLResourceValues — no per-result subprocess.
    struct SpotlightResult {
        var matches: [[String: Any]]
        var partial: Bool
        var cutPass: String?
    }

    private func spotlightSearchViaMdfind(
        query: String,
        scopePaths: [String],
        nameOnly: Bool,
        limit: Int,
        requestedKinds: Set<String>,
        deadline: Date
    ) -> SpotlightResult {
        let esc = query
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let pat = "*\(esc)*"
        let nameExpr = "(kMDItemFSName = \"\(pat)\"cd) || (kMDItemDisplayName = \"\(pat)\"cd)"
        let contentExpr = "(kMDItemTextContent = \"\(pat)\"cd)"

        // Gather candidate paths (dedupe; a few extra to survive kinds-filtering).
        // The name pass runs first: it answers in well under a second on an
        // indexed volume, so name hits are never held hostage by the content
        // pass, which is the one the deadline usually cuts.
        let gatherCap = max(limit * 4, limit)
        var seen = Set<String>()
        var paths: [String] = []
        var partial = false
        var cutPass: String? = nil
        let runs: [String?] = scopePaths.isEmpty ? [nil] : scopePaths
        let passes: [(String, String)] = nameOnly ? [("name", nameExpr)] : [("name", nameExpr), ("content", contentExpr)]
        outer: for (passName, expr) in passes {
            for sp in runs {
                if Date() >= deadline { partial = true; cutPass = passName; break outer }
                let run = runMdfind(onlyIn: sp, queryExpr: expr, maxResults: gatherCap, deadline: deadline)
                if run.timedOut { partial = true; cutPass = passName }
                for p in run.lines {
                    if seen.insert(p).inserted {
                        paths.append(p)
                        if paths.count >= gatherCap { break outer }
                    }
                }
                if run.timedOut { break outer }
            }
        }

        let iso = ISO8601DateFormatter()
        var matches: [[String: Any]] = []
        for path in paths {
            if matches.count >= limit { break }
            let url = URL(fileURLWithPath: path)
            let vals = try? url.resourceValues(forKeys: [.contentTypeKey, .fileSizeKey, .contentModificationDateKey])
            let kindLabel = vals?.contentType?.localizedDescription
            if !self.matchesKinds(requestedKinds, at: url, kindLabel: kindLabel) { continue }
            var entry: [String: Any] = ["path": path, "name": url.lastPathComponent]
            if let kindLabel { entry["kind"] = kindLabel }
            if let size = vals?.fileSize { entry["size"] = size }
            if let modified = vals?.contentModificationDate {
                entry["modified"] = iso.string(from: modified)
            }
            matches.append(entry)
        }
        return SpotlightResult(matches: matches, partial: partial, cutPass: cutPass)
    }

    /// Run `/usr/bin/mdfind` synchronously and return result paths (one absolute
    /// path per stdout line, capped at `maxResults`). stderr is discarded
    /// (mdfind logs locale-parser chatter there). Reads incrementally and
    /// terminates mdfind once it has `maxResults` lines, so a query that matches
    /// a huge set (e.g. 11k files for "media kit") still returns the first page
    /// near-instantly instead of paying to enumerate every match. Returns `[]`
    /// if mdfind cannot be launched.
    /// `deadline`: mdfind is terminated when it passes, and `timedOut` is set so
    /// the caller can report a partial result instead of letting the CLI's
    /// transport timeout fire with an unrelated hint.
    private func runMdfind(onlyIn: String?, queryExpr: String, maxResults: Int, deadline: Date) -> (lines: [String], timedOut: Bool) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
        var args: [String] = []
        if let dir = onlyIn { args += ["-onlyin", dir] }
        args.append(queryExpr)
        proc.arguments = args
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
        } catch {
            return ([], false)
        }
        // Deadline watchdog: terminate() closes mdfind's stdout, which ends the
        // blocking availableData loop below with EOF.
        let timedOutBox = TimedOutBox()
        let remaining = max(0.01, deadline.timeIntervalSinceNow)
        let watchdog = DispatchWorkItem { [proc] in
            if proc.isRunning {
                timedOutBox.set()
                proc.terminate()
            }
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + remaining, execute: watchdog)
        defer { watchdog.cancel() }
        let handle = out.fileHandleForReading
        let cap = max(maxResults, 1)
        var buffer = Data()
        var lines: [String] = []
        while lines.count < cap {
            let chunk = handle.availableData          // blocks until data or EOF
            if chunk.isEmpty { break }                // EOF — mdfind finished
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                    lines.append(line)
                    if lines.count >= cap { break }
                }
            }
        }
        // Stop mdfind once we have enough — don't enumerate the whole match set.
        proc.terminate()
        proc.waitUntilExit()
        return (lines, timedOutBox.isSet)
    }

    /// Lock-guarded flag shared between the read loop and the watchdog.
    private final class TimedOutBox: @unchecked Sendable {
        private let lock = NSLock()
        private var flag = false
        func set() { lock.lock(); flag = true; lock.unlock() }
        var isSet: Bool { lock.lock(); defer { lock.unlock() }; return flag }
    }

    /// Breadth-first fallback that visits the workspace root's top-level
    /// children FIRST (so `Downloads` is hit before `Library` swallows the
    /// scan budget). Walks one level deep by default; matches against
    /// filename substrings (case-insensitive). Bounded at 10k items.
    private func fallbackBfsSearch(query: String, root: String, limit: Int, requestedKinds: Set<String>) -> [[String: Any]] {
        let fm = FileManager.default
        let lower = query.lowercased()
        var matches: [[String: Any]] = []
        var queue: [URL] = []
        let rootUrl = URL(fileURLWithPath: root)
        queue.append(rootUrl)
        var scanned = 0
        let maxScanned = 10_000
        let maxDepth = 4
        let isoFmt = ISO8601DateFormatter()

        func depth(of url: URL) -> Int {
            return url.pathComponents.count - rootUrl.pathComponents.count
        }

        while !queue.isEmpty && matches.count < limit && scanned < maxScanned {
            let dir = queue.removeFirst()
            let d = depth(of: dir)
            guard let children = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [
                .nameKey, .fileSizeKey, .contentModificationDateKey, .isDirectoryKey
            ], options: [.skipsHiddenFiles]) else { continue }

            for child in children {
                scanned += 1
                if scanned >= maxScanned { break }
                let name = child.lastPathComponent
                let isDir = (try? child.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
                if matchesQuery(name: name, normalizedQuery: lower) && matchesKinds(requestedKinds, at: child, kindLabel: isDir ? "directory" : "file") {
                    var entry: [String: Any] = [
                        "path": child.path,
                        "name": name,
                        "kind": isDir ? "directory" : "file"
                    ]
                    if let attrs = try? child.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) {
                        if let size = attrs.fileSize { entry["size"] = size }
                        if let modified = attrs.contentModificationDate {
                            entry["modified"] = isoFmt.string(from: modified)
                        }
                    }
                    matches.append(entry)
                    if matches.count >= limit { break }
                }
                if d < maxDepth, isDir {
                    // Skip noisy system-managed subtrees.
                    let bn = child.lastPathComponent
                    if bn == "Library" && d == 0 { continue }
                    if bn == ".Trash" || bn == "node_modules" || bn == ".git" { continue }
                    queue.append(child)
                }
            }
        }
        return matches
    }

    /// Shallow rooted listing used for wildcard path-scoped searches.
    /// This matches what users expect from Finder-style `*` searches: return
    /// the immediate contents of the folder, filtered by kind.
    private func directPathListing(root: String, limit: Int, requestedKinds: Set<String>) -> [[String: Any]] {
        let fm = FileManager.default
        let rootUrl = URL(fileURLWithPath: root)
        let isoFmt = ISO8601DateFormatter()
        guard let children = try? fm.contentsOfDirectory(
            at: rootUrl,
            includingPropertiesForKeys: [.nameKey, .fileSizeKey, .contentModificationDateKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        var out: [[String: Any]] = []
        for child in children.sorted(by: { $0.lastPathComponent.localizedCaseInsensitiveCompare($1.lastPathComponent) == .orderedAscending }) {
            if out.count >= limit { break }
            let isDir = isDirectory(at: child)
            if !matchesKinds(requestedKinds, at: child, kindLabel: isDir ? "directory" : "file") {
                continue
            }
            var entry: [String: Any] = [
                "path": child.path,
                "name": child.lastPathComponent,
                "kind": isDir ? "directory" : "file",
            ]
            if let attrs = try? child.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) {
                if let size = attrs.fileSize { entry["size"] = size }
                if let modified = attrs.contentModificationDate {
                    entry["modified"] = isoFmt.string(from: modified)
                }
            }
            out.append(entry)
        }
        return out
    }

    /// Treat shell-style wildcard-only queries like `*` / `**` as "match all"
    /// in the enumerator fallback. Spotlight's predicate language can use `*`
    /// as a wildcard, but the fallback is plain filename substring matching.
    private func matchesQuery(name: String, normalizedQuery: String) -> Bool {
        let trimmed = normalizedQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        if isWildcardOnlyQuery(trimmed) {
            return true
        }
        return name.lowercased().contains(trimmed)
    }

    private func isWildcardOnlyQuery(_ query: String) -> Bool {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.allSatisfy { $0 == "*" || $0 == "?" }
    }

    /// Normalize kind filters to a lowercase set. These filters are additive
    /// over Spotlight/fallback search and intentionally broad so callers can
    /// ask for directory/file classes or pass UTI-style labels like
    /// `public.folder`.
    private func normalizedKinds(_ kinds: [String]?) -> Set<String> {
        Set((kinds ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty })
    }

    private func matchesKinds(_ requestedKinds: Set<String>, at url: URL, kindLabel: String?) -> Bool {
        if requestedKinds.isEmpty {
            return true
        }
        let isDir = isDirectory(at: url)
        let normalizedKindLabel = kindLabel?.lowercased() ?? ""
        for requested in requestedKinds {
            switch requested {
            case "directory", "directories", "dir", "folder", "folders", "public.folder", "public.directory":
                if isDir { return true }
            case "file", "files", "public.data", "public.item":
                if !isDir { return true }
            default:
                if requested.hasSuffix(".folder") || requested.hasSuffix(".directory") {
                    if isDir { return true }
                    continue
                }
                if !normalizedKindLabel.isEmpty && normalizedKindLabel.contains(requested) {
                    return true
                }
            }
        }
        return false
    }

    private func isDirectory(at url: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
    }

    // MARK: shared helpers
    private func resolvePath(_ action: [String: Any]) -> String? {
        if let p = action["path"] as? String, !p.isEmpty {
            return (p as NSString).expandingTildeInPath
        }
        if let ref = action["ref"] as? [String: Any] {
            if let kind = ref["kind"] as? String {
                if kind == "path", let path = ref["path"] as? String {
                    return (path as NSString).expandingTildeInPath
                }
                // Bookmark resolution would happen here once the engine ships
                // the bookmarkB64 payload form; specifies the wire.
                if kind == "bookmark", let b64 = ref["bookmarkB64"] as? String,
                   let data = Data(base64Encoded: b64) {
                    var stale = false
                    if let url = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &stale) {
                        if url.startAccessingSecurityScopedResource() {
                            // NOTE: caller is responsible for ending the scope after use.
                            // For v1 we end immediately after returning the path.
                            defer { url.stopAccessingSecurityScopedResource() }
                            return url.path
                        }
                    }
                }
            }
        }
        return nil
    }
}

private extension Date {
    var iso8601: String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: self)
    }
}
