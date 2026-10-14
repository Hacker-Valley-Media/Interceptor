import Foundation
import AppKit
import Photos
import ImageIO
import UniformTypeIdentifiers
import CryptoKit
import Darwin
import ShareNative

final class PhotosDomain: DomainHandler, @unchecked Sendable {
    private let queue = DispatchQueue(label: "interceptor.photos.native")
    private let admission = NSLock()
    private var active: Request?
    // A request that times out is given up once (its download is cancelled and its
    // file removed) so later Photos calls are not blocked while the cancellation finishes.
    private var abandoned: UUID?
    private final class Request: @unchecked Sendable {
        let id = UUID()
        private let lock = NSLock()
        private var expired = false
        private var downloadCancelled = false
        private var cancellations: [@Sendable () -> Void] = []
        var live: Bool { lock.lock(); defer { lock.unlock() }; return !expired }
        func cancelWith(_ callback: @escaping @Sendable () -> Void) { lock.lock(); let now = expired || downloadCancelled; if !now { cancellations.append(callback) }; lock.unlock(); if now { callback() } }
        func cancelDownloads() { lock.lock(); downloadCancelled = true; let callbacks = cancellations; cancellations.removeAll(); lock.unlock(); callbacks.forEach { $0() } }
        func expire() { lock.lock(); expired = true; let callbacks = cancellations; cancellations.removeAll(); lock.unlock(); callbacks.forEach { $0() } }
        func retire() { lock.lock(); expired = true; cancellations.removeAll(); lock.unlock() }
    }
    private struct NativeFailure: Error, @unchecked Sendable { let response: [String: Any] }
    private func fail(_ code: String, _ message: String, details: [String: Any]? = nil) -> NativeFailure { NativeFailure(response: WireFormat.failure(code, message, details: details)) }
    private func native(_ error: any Error, committed: Bool = false) -> [String: Any] {
        if let error = error as? NativeFailure {
            var response = error.response
            if committed { var details = (response["details"] as? [String: Any]) ?? [:]; details["mutationCommitted"] = true; details["outcomeUnknown"] = true; response["details"] = details; if response["code"] as? String == "invalid_target" { response["code"] = "partial_result" } }
            return response
        }
        let n = error as NSError
        return WireFormat.failure(committed ? "timeout_unknown_outcome" : "provider_failed", String(n.localizedDescription.prefix(4096)), details: ["nativeDomain": n.domain, "nativeCode": n.code, "mutationCommitted": committed])
    }
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var canonical = action; canonical["type"] = "desktop_photos"; canonical["sub"] = action["sub"] ?? command
        if let error = DesktopPhotosValidation.actionError(canonical) { completion(WireFormat.failure("invalid_request", error)); return }
        let request = Request(), once = AtomicFlag(), box = UncheckedSendableBox(canonical)
        admission.lock(); let accepted = active == nil; if accepted { active = request }; admission.unlock()
        guard accepted else { completion(WireFormat.failure("resource_limit", "another Photos operation is still running, or an earlier timed-out one has not finished cancelling; nothing queued")); return }
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global()), timerBox: UncheckedSendableBox<any DispatchSourceTimer>
        timerBox = UncheckedSendableBox(timer)
        let finish: @Sendable ([String: Any]) -> Void = { response in
            timerBox.value.cancel(); request.retire()
            self.admission.lock(); if self.active?.id == request.id { self.active = nil }; if self.abandoned == request.id { self.abandoned = nil }; self.admission.unlock()
            if once.set() { if let error = DesktopPhotosValidation.resultError(response, action: box.value) { completion(WireFormat.failure("partial_result", error, details: ["outcomeUnknown": true])) } else { completion(response) } }
        }
        timer.schedule(deadline: .now() + 55)
        timer.setEventHandler {
            guard request.live else { return }; request.expire()
            self.admission.lock(); let gaveUp = self.active?.id == request.id && self.abandoned == nil; if gaveUp { self.abandoned = request.id; self.active = nil }; self.admission.unlock()
            if once.set() { completion(WireFormat.failure("timeout_unknown_outcome", "Photos did not finish within 55 seconds (an iCloud original or video may still have been downloading); the request was cancelled, any unfinished --out file was removed, and no mutation was replayed" + (gaveUp ? "" : "; Photos calls are refused until an earlier cancelled request finishes"))) }
        }
        timer.resume()
        queue.async {
            guard request.live else { finish(WireFormat.failure("cancelled", "Photos request expired before dispatch")); return }
            if let exception = InterceptorNativeOperation("Photos", {
                do { try self.perform(box.value, request: request, finish: finish) } catch { finish(self.native(error)) }
            }) { finish(self.native(exception)) }
        }
    }
    private func statusName(_ status: PHAuthorizationStatus) -> String {
        switch status { case .notDetermined: return "notDetermined"; case .restricted: return "restricted"; case .denied: return "denied"; case .authorized: return "authorized"; case .limited: return "limited"; @unknown default: return "unknown" }
    }
    private func mediaName(_ media: PHAssetMediaType) -> String {
        switch media { case .image: return "image"; case .video: return "video"; case .audio: return "audio"; case .unknown: return "unknown"; @unknown default: return "unknown" }
    }
    private let subtypes: [String: PHAssetMediaSubtype] = ["panorama": .photoPanorama, "hdr": .photoHDR, "screenshot": .photoScreenshot, "livePhoto": .photoLive, "depthEffect": .photoDepthEffect, "streamedVideo": .videoStreamed, "highFrameRate": .videoHighFrameRate, "timelapse": .videoTimelapse]
    private func assetRow(_ a: PHAsset) -> [String: Any] {
        var row: [String: Any] = ["id": a.localIdentifier, "mediaType": mediaName(a.mediaType), "mediaSubtypes": subtypes.keys.sorted().filter { a.mediaSubtypes.contains(subtypes[$0]!) }, "pixelWidth": a.pixelWidth, "pixelHeight": a.pixelHeight, "duration": a.duration, "isFavorite": a.isFavorite, "isHidden": a.isHidden, "hasAdjustments": a.hasAdjustments, "burstIdentifier": a.burstIdentifier as Any? ?? NSNull(), "playbackStyle": NativeNames.name(a.playbackStyle.rawValue, NativeNames.playbackStyle), "sourceType": NativeNames.name(Int(a.sourceType.rawValue), NativeNames.assetSource)]
        for (key, date) in [("creationDate", a.creationDate), ("modificationDate", a.modificationDate)] { if let date { row[key] = DesktopEventKitValidation.iso(date) } }
        // `addedDate` is `Date` in the macOS 26 SDK and `Date?` in the macOS 27 SDK; the cast compiles against both.
        if #available(macOS 26, *), let added = a.addedDate as Date? { row["addedDate"] = DesktopEventKitValidation.iso(added) }
        if let loc = a.location { row["location"] = ["latitude": loc.coordinate.latitude, "longitude": loc.coordinate.longitude, "altitude": loc.altitude, "horizontalAccuracy": loc.horizontalAccuracy] }
        return row
    }
    private func albumRow(_ c: PHAssetCollection) -> [String: Any] {
        ["id": c.localIdentifier, "title": c.localizedTitle as Any? ?? NSNull(), "type": NativeNames.name(c.assetCollectionType.rawValue, NativeNames.collectionType), "subtype": NativeNames.name(c.assetCollectionSubtype.rawValue, NativeNames.collectionSubtype), "estimatedAssetCount": c.estimatedAssetCount == NSNotFound ? NSNull() : c.estimatedAssetCount as Any]
    }
    private func album(_ id: String, edit: PHCollectionEditOperation? = nil) throws -> PHAssetCollection {
        let result = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil)
        guard result.count == 1, let row = result.firstObject, row.localIdentifier == id else { throw fail("invalid_target", "exact Photos album does not exist or is inaccessible") }
        if let edit, !row.canPerform(edit) { throw fail("unsupported_target", "Photos album does not allow the requested edit") }
        return row
    }
    private func fetchAssets(_ ids: [String], edit: PHAssetEditOperation? = nil) throws -> PHFetchResult<PHAsset> {
        let options = PHFetchOptions(); options.includeHiddenAssets = true; options.includeAllBurstAssets = true
        let result = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: options)
        guard result.count == ids.count else { throw fail("invalid_target", "one or more exact Photos assets are absent or inaccessible; no partial mutation") }
        var found = Set<String>(); result.enumerateObjects { asset, _, _ in found.insert(asset.localIdentifier) }
        guard found == Set(ids) else { throw fail("invalid_target", "Photos asset identity differs from exact request") }
        if let edit { for index in 0..<result.count { if !result.object(at: index).canPerform(edit) { throw fail("unsupported_target", "Photos asset does not allow the requested edit") } } }
        return result
    }
    private func asset(_ id: String, edit: PHAssetEditOperation? = nil) throws -> PHAsset { try fetchAssets([id], edit: edit).object(at: 0) }
    private func options(_ a: [String: Any]) -> PHFetchOptions {
        let options = PHFetchOptions(); var predicates: [NSPredicate] = []
        if let raw = a["media"] as? String { let media: [String: Int] = ["unknown": 0, "image": 1, "video": 2, "audio": 3]; predicates.append(NSPredicate(format: "mediaType == %d", media[raw]!)) }
        if let raw = a["subtype"] as? String { let key = raw == "live" ? "livePhoto" : raw == "streamed" ? "streamedVideo" : raw; predicates.append(NSPredicate(format: "(mediaSubtypes & %d) != 0", subtypes[key]!.rawValue)) }
        if a["favorite"] as? Bool == true { predicates.append(NSPredicate(format: "isFavorite == YES")) }
        for (key, op) in [("since", ">="), ("until", "<=")] { if let date = DesktopEventKitValidation.date(a[key]) { predicates.append(NSPredicate(format: "creationDate \(op) %@", date as NSDate)) } }
        if let raw = a["where"] as? String { for (key, op, value) in DesktopPhotosValidation.comparisons(raw)! { predicates.append(NSPredicate(format: "%K \(op) %@", key, value)) } }
        if !predicates.isEmpty { options.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates) }
        options.includeHiddenAssets = a["hidden"] as? Bool == true; options.includeAllBurstAssets = a["burst"] as? Bool == true
        // PhotoKit rejects localIdentifier as a sort key ("Unsupported sort descriptor"), so creationDate alone orders pages.
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        return options
    }
    private func changes(request: Request, block: @escaping @Sendable () throws -> Void, readback: @escaping @Sendable () throws -> [String: Any], finish: @escaping @Sendable ([String: Any]) -> Void) {
        let errorBox = MutationError()
        PHPhotoLibrary.shared().performChanges({
            guard request.live else { return }
            if let error = InterceptorNativeOperation("Photos", { do { try block() } catch { errorBox.set(error) } }) { errorBox.set(error) }
        }) { ok, error in
            self.queue.async {
                guard request.live else { finish(WireFormat.failure("cancelled", "Photos completion retired after deadline; outcome unknown")); return }
                if let error = errorBox.value ?? error { finish(self.native(error, committed: ok)); return }
                guard ok else { finish(WireFormat.failure("provider_failed", "native Photos change failed without an error")); return }
                if let exception = InterceptorNativeOperation("Photos", { do { finish(WireFormat.success(try readback())) } catch { finish(self.native(error, committed: true)) } }) { finish(self.native(exception, committed: true)) }
            }
        }
    }
    private final class MutationError: @unchecked Sendable {
        private let lock = NSLock(); private var error: (any Error)?
        func set(_ value: any Error) { lock.lock(); error = value; lock.unlock() }
        var value: (any Error)? { lock.lock(); defer { lock.unlock() }; return error }
    }
    private final class CreatedIdentity: @unchecked Sendable {
        private let lock = NSLock(); private var identity: String?
        func set(_ value: String?) { lock.lock(); identity = value; lock.unlock() }
        var value: String? { lock.lock(); defer { lock.unlock() }; return identity }
    }
    private func perform(_ a: [String: Any], request: Request, finish: @escaping @Sendable ([String: Any]) -> Void) throws {
        let sub = a["sub"] as! String
        if sub == "status" { finish(WireFormat.success(["status": statusName(PHPhotoLibrary.authorizationStatus(for: .readWrite)), "macOS": ProcessInfo.processInfo.operatingSystemVersionString])); return }
        if sub == "request" {
            let level: PHAccessLevel = a["level"] as? String == "addonly" ? .addOnly : .readWrite
            let key = level == .addOnly ? "NSPhotoLibraryAddUsageDescription" : "NSPhotoLibraryUsageDescription"
            guard let reason = Bundle.main.object(forInfoDictionaryKey: key) as? String, !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw fail("not_installed", "Photos consent purpose key is missing") }
            DispatchQueue.main.async { guard request.live else { finish(WireFormat.failure("cancelled", "Photos consent retired before dispatch")); return }; PHPhotoLibrary.requestAuthorization(for: level) { status in finish(WireFormat.success(["status": self.statusName(status)])) } }; return
        }
        let auth = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard auth == .authorized || auth == .limited else { throw fail("permission_denied", "Photos requires existing read/write access for native reads and independent mutation readback; explicit photos request asks for consent") }
        switch sub {
        case "albums":
            if a["album_type"] as? String == "moment" { throw fail("unsupported_operation", "PhotoKit moments are unavailable on macOS") }
            var rows: [[String: Any]] = []
            for type: PHAssetCollectionType in [.smartAlbum, .album] { if let selected = a["album_type"] as? String, selected != (type == .album ? "album" : "smart") { continue }
                let result = PHAssetCollection.fetchAssetCollections(with: type, subtype: .any, options: nil)
                guard rows.count + result.count <= 1000 else { throw fail("resource_limit", "Photos collection result exceeds 1000; no truncated success") }
                for index in 0..<result.count { guard request.live else { throw fail("cancelled", "Photos album enumeration retired") }; rows.append(albumRow(result.object(at: index))) }
            }
            finish(WireFormat.success(["albums": rows]))
        case "album": finish(WireFormat.success(albumRow(try album(a["id"] as! String))))
        case "assets":
            let options = options(a), result: PHFetchResult<PHAsset>
            if let id = a["album"] as? String { result = PHAsset.fetchAssets(in: try album(id), options: options) } else { result = PHAsset.fetchAssets(with: options) }
            let limit = (a["limit"] as? Int) ?? 100, offset = (a["offset"] as? Int) ?? 0
            var rows: [[String: Any]] = []
            if offset < result.count { for index in offset..<min(result.count, offset + limit) { guard request.live else { throw fail("cancelled", "Photos asset enumeration retired") }; rows.append(assetRow(result.object(at: index))) } }
            finish(WireFormat.success(["count": result.count, "limit": limit, "offset": offset, "hasMore": offset + rows.count < result.count, "assets": rows]))
        case "asset": finish(WireFormat.success(assetRow(try asset(a["id"] as! String))))
        case "album-create":
            let name = a["name"] as! String, created = CreatedIdentity()
            changes(request: request, block: { created.set(PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: name).placeholderForCreatedAssetCollection.localIdentifier) }, readback: {
                guard let id = created.value else { throw self.fail("partial_result", "Photos created album identifier is missing") }; let row = try self.album(id); guard row.localizedTitle == name else { throw self.fail("partial_result", "Photos created album name readback differs", details: ["id": id]) }; return ["id": id, "name": name]
            }, finish: finish)
        case "album-rename", "album-delete":
            let id = a["id"] as! String, collection = try album(id, edit: sub == "album-delete" ? .delete : .rename), box = UncheckedSendableBox(collection), name = a["name"] as? String
            changes(request: request, block: {
                if sub == "album-delete" { PHAssetCollectionChangeRequest.deleteAssetCollections([box.value] as NSArray) }
                else { guard let change = PHAssetCollectionChangeRequest(for: box.value) else { throw self.fail("unsupported_target", "Photos album change request is unavailable") }; change.title = name! }
            }, readback: {
                if sub == "album-delete" { guard PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil).count == 0 else { throw self.fail("partial_result", "Photos album remains after delete") }; return ["ok": true, "id": id] }
                guard try self.album(id).localizedTitle == name else { throw self.fail("partial_result", "Photos album rename readback differs") }; return ["id": id, "name": name!]
            }, finish: finish)
        case "favorite", "hide":
            let id = a["id"] as! String, on = (a["on"] as? Bool) ?? true, box = UncheckedSendableBox(try asset(id, edit: .properties))
            changes(request: request, block: { let change = PHAssetChangeRequest(for: box.value); if sub == "favorite" { change.isFavorite = on } else { change.isHidden = on } }, readback: {
                let row = try self.asset(id), observed = sub == "favorite" ? row.isFavorite : row.isHidden
                guard observed == on else { throw self.fail("partial_result", "Photos flag readback differs") }; return ["ok": true, "id": id, sub == "favorite" ? "isFavorite" : "isHidden": observed]
            }, finish: finish)
        case "delete":
            let ids = DesktopPhotosValidation.ids(a["id"])!, box = UncheckedSendableBox(try fetchAssets(ids, edit: .delete))
            changes(request: request, block: { PHAssetChangeRequest.deleteAssets(box.value) }, readback: {
                let options = PHFetchOptions(); options.includeHiddenAssets = true; options.includeAllBurstAssets = true
                guard PHAsset.fetchAssets(withLocalIdentifiers: ids, options: options).count == 0 else { throw self.fail("partial_result", "one or more Photos assets remain after delete") }; return ["ok": true, "deleted": ids]
            }, finish: finish)
        case "add-to-album", "remove-from-album":
            let id = a["album"] as! String, ids = DesktopPhotosValidation.ids(a["asset"])!, collection = UncheckedSendableBox(try album(id, edit: sub == "add-to-album" ? .addContent : .removeContent)), assets = UncheckedSendableBox(try fetchAssets(ids))
            changes(request: request, block: {
                guard let change = PHAssetCollectionChangeRequest(for: collection.value) else { throw self.fail("unsupported_target", "Photos album membership change request is unavailable") }
                if sub == "add-to-album" { change.addAssets(assets.value) } else { change.removeAssets(assets.value) }
            }, readback: { try self.verifyMembership(id, ids: ids, present: sub == "add-to-album"); return ["ok": true, "album": id, "assets": ids] }, finish: finish)
        case "import", "import-video":
            let path = a["file"] as! String, data = try readFile(path), created = CreatedIdentity(), collection = try (a["album"] as? String).map { try album($0, edit: .addContent) }, coll = UncheckedSendableBox(collection)
            let type: PHAssetResourceType = sub == "import-video" ? .video : .photo
            let resourceOptions = PHAssetResourceCreationOptions(); resourceOptions.originalFilename = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).lastPathComponent
            let resourceBox = UncheckedSendableBox(resourceOptions)
            changes(request: request, block: {
                let change = PHAssetCreationRequest.forAsset(); change.addResource(with: type, data: data, options: resourceBox.value)
                guard let placeholder = change.placeholderForCreatedAsset else { throw self.fail("partial_result", "Photos import placeholder is missing") }; created.set(placeholder.localIdentifier)
                if let collection = coll.value { guard let albumChange = PHAssetCollectionChangeRequest(for: collection) else { throw self.fail("unsupported_target", "Photos import album change request is unavailable") }; albumChange.addAssets([placeholder] as NSArray) }
            }, readback: {
                guard let id = created.value else { throw self.fail("partial_result", "Photos import identifier is missing") }; let asset = try self.asset(id)
                guard asset.mediaType == (sub == "import-video" ? .video : .image) else { throw self.fail("partial_result", "Photos imported media type differs", details: ["id": id]) }
                if let collection = coll.value { try self.verifyMembership(collection.localIdentifier, ids: [id], present: true) }; return ["ok": true, "id": id]
            }, finish: finish)
        case "current-token":
            let bytes = try NSKeyedArchiver.archivedData(withRootObject: PHPhotoLibrary.shared().currentChangeToken, requiringSecureCoding: true)
            guard !bytes.isEmpty, bytes.count <= 49152 else { throw fail("resource_limit", "Photos token exceeds 48KiB") }; finish(WireFormat.success(["token": bytes.base64EncodedString()]))
        case "changes":
            let data = Data(base64Encoded: a["token"] as! String)!
            guard let token = try NSKeyedUnarchiver.unarchivedObject(ofClass: PHPersistentChangeToken.self, from: data) else { throw fail("invalid_request", "Photos history token is not a native persistent token") }
            let result = InterceptorPhotoHistory(PHPhotoLibrary.shared(), token, 12000)
            if let error = result["nativeError"] as? NSError { finish(native(error)) } else { finish(WireFormat.success(result)) }
        case "export", "export-video", "export-live", "thumbnail": try export(a, request: request, finish: finish)
        default: throw fail("invalid_request", "unknown Photos selector")
        }
    }
    private func verifyMembership(_ albumId: String, ids: [String], present: Bool) throws {
        let options = PHFetchOptions(); options.includeHiddenAssets = true; options.includeAllBurstAssets = true; options.predicate = NSPredicate(format: "localIdentifier IN %@", ids)
        let count = PHAsset.fetchAssets(in: try album(albumId), options: options).count
        guard count == (present ? ids.count : 0) else { throw fail("partial_result", "Photos album membership readback differs") }
    }
    // VM file copy composes this retained reader with a smaller explicit cap.
    func readFile(_ path: String, maxBytes: Int = 134217728, allowEmpty: Bool = false) throws -> Data {
        let expanded = (path as NSString).expandingTildeInPath, fd = Darwin.open(expanded, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw fail("invalid_target", "Photos input cannot be opened as a retained regular file") }; defer { Darwin.close(fd) }
        var before = stat(); guard maxBytes > 0, maxBytes <= 134217728, fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_size >= 0, allowEmpty || before.st_size > 0, before.st_size <= maxBytes else { throw fail("resource_limit", "Native input must be a retained regular file within its explicit byte cap") }
        var data = Data(), chunk = [UInt8](repeating: 0, count: 65536)
        while true { let n = Darwin.read(fd, &chunk, chunk.count); if n < 0 { if errno == EINTR { continue }; throw fail("provider_failed", "Photos input read failed") }; if n == 0 { break }; guard data.count + n <= maxBytes else { throw fail("resource_limit", "Native input grew beyond its explicit byte cap") }; data.append(contentsOf: chunk.prefix(n)) }
        var after = stat(); guard fstat(fd, &after) == 0, before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec, data.count == Int(after.st_size) else { throw fail("invalid_target", "Photos input changed during retained read") }
        return data
    }
    // Also used by native stream finalization, with the same exclusive file,
    // retained identity, digest readback and sync checks.
    final class Output: @unchecked Sendable {
        let path: String
        private let lock = NSLock()
        private let directory: Int32, descriptor: Int32
        private let name: String
        private var count = 0, digest = SHA256(), error: String?, finished = false
        init(_ path: String) throws {
            let expanded = (path as NSString).expandingTildeInPath, url = URL(fileURLWithPath: expanded).standardizedFileURL
            self.path = url.path; name = url.lastPathComponent
            // Open into locals: a throw after every stored property is set runs deinit, which would close them again.
            let parent = Darwin.open(url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard parent >= 0, name != ".", name != "..", !name.isEmpty else { if parent >= 0 { Darwin.close(parent) }; throw NSError(domain: "InterceptorPhotosOutput", code: 1, userInfo: [NSLocalizedDescriptionKey: "Photos output parent must exist and be a retained directory"]) }
            let file = openat(parent, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard file >= 0 else { Darwin.close(parent); throw NSError(domain: "InterceptorPhotosOutput", code: 2, userInfo: [NSLocalizedDescriptionKey: "Photos output exists or cannot be created exclusively; no existing file was replaced"]) }
            directory = parent; descriptor = file
        }
        deinit { Darwin.close(descriptor); Darwin.close(directory) }
        func append(_ data: Data) -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard error == nil, count + data.count <= 134217728 else { error = error ?? "Photos resource exceeds 128MiB"; return false }
            let ok = data.withUnsafeBytes { bytes -> Bool in var offset = 0; while offset < bytes.count { let n = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset); if n < 0 && errno == EINTR { continue }; if n <= 0 { return false }; offset += n }; return true }
            guard ok else { error = "Photos resource write failed; partial file preserved"; return false }; count += data.count; digest.update(data: data); return true
        }
        // Removes an unfinished output (same file still at the name), so a failed or cancelled export
        // leaves nothing behind at --out.
        func discard() {
            lock.lock(); defer { lock.unlock() }
            guard !finished else { return }; finished = true
            var info = stat(), named = stat()
            if fstat(descriptor, &info) == 0, fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0, info.st_dev == named.st_dev, info.st_ino == named.st_ino { unlinkat(directory, name, 0) }
        }
        func finish(allowEmpty: Bool = false) throws -> Int {
            lock.lock(); defer { lock.unlock() }
            if let error { throw NSError(domain: "InterceptorPhotosOutput", code: 3, userInfo: [NSLocalizedDescriptionKey: error, "filePath": path]) }
            var info = stat(), named = stat()
            guard allowEmpty || count > 0, fsync(descriptor) == 0, fstat(descriptor, &info) == 0, fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0, info.st_size == count, info.st_dev == named.st_dev, info.st_ino == named.st_ino, info.st_nlink == 1, info.st_mode & 0o777 == 0o600 else { throw NSError(domain: "InterceptorPhotosOutput", code: 4, userInfo: [NSLocalizedDescriptionKey: "Photos output identity, size or sync differs", "filePath": path]) }
            var observed = SHA256(), offset = 0, bytes = [UInt8](repeating: 0, count: 65536)
            while offset < count { let n = pread(descriptor, &bytes, min(bytes.count, count - offset), off_t(offset)); if n < 0 && errno == EINTR { continue }; guard n > 0 else { throw NSError(domain: "InterceptorPhotosOutput", code: 5, userInfo: [NSLocalizedDescriptionKey: "Photos output readback failed"]) }; observed.update(data: Data(bytes.prefix(n))); offset += n }
            guard observed.finalize() == digest.finalize(), fsync(directory) == 0 else { throw NSError(domain: "InterceptorPhotosOutput", code: 6, userInfo: [NSLocalizedDescriptionKey: "Photos output digest or directory sync differs"]) }
            finished = true
            return count
        }
    }
    private func writeResource(_ resource: PHAssetResource, path: String, kind: String, request: Request, completion: @escaping @Sendable (Result<[String: Any], any Error>) -> Void) throws {
        let output = try Output(path), resourceBox = UncheckedSendableBox(resource), manager = PHAssetResourceManager.default(), options = PHAssetResourceRequestOptions(); options.isNetworkAccessAllowed = true
        let id = manager.requestData(for: resourceBox.value, options: options, dataReceivedHandler: { bytes in if request.live && !output.append(bytes) { request.cancelDownloads() } }, completionHandler: { error in
            self.queue.async {
                guard request.live else { output.discard(); completion(.failure(self.fail("cancelled", "Photos resource request was cancelled; the unfinished output was removed", details: ["filePath": output.path]))); return }
                if let error { output.discard(); completion(.failure(error)); return }
                do { completion(.success(["filePath": output.path, "uti": resourceBox.value.uniformTypeIdentifier, "bytes": try output.finish(), "type": kind])) } catch { output.discard(); completion(.failure(error)) }
            }
        })
        request.cancelWith { manager.cancelDataRequest(id); output.discard() }
    }
    private func resource(_ asset: PHAsset, type: PHAssetResourceType) throws -> PHAssetResource {
        let rows = PHAssetResource.assetResources(for: asset).filter { $0.type == type }
        guard rows.count == 1, rows[0].assetLocalIdentifier == asset.localIdentifier else { throw fail("unsupported_target", "Photos requires one exact native resource of the requested type") }; return rows[0]
    }
    private func export(_ a: [String: Any], request: Request, finish: @escaping @Sendable ([String: Any]) -> Void) throws {
        let sub = a["sub"] as! String, id = a["id"] as! String, asset = try asset(id)
        if sub == "export-live" {
            guard asset.mediaSubtypes.contains(.photoLive) else { throw fail("unsupported_target", "Photos asset is not a Live Photo") }
            let image = try resource(asset, type: asset.hasAdjustments ? .fullSizePhoto : .photo), video = try resource(asset, type: asset.hasAdjustments ? .fullSizePairedVideo : .pairedVideo)
            guard let imageExt = UTType(image.uniformTypeIdentifier)?.preferredFilenameExtension, let videoExt = UTType(video.uniformTypeIdentifier)?.preferredFilenameExtension, imageExt != videoExt, [imageExt, videoExt].allSatisfy({ $0.range(of: "^[A-Za-z0-9]{1,12}$", options: .regularExpression) != nil }) else { throw fail("unsupported_target", "Live Photo native resource extensions are unavailable or ambiguous") }
            let base = (a["out"] as! NSString).expandingTildeInPath, videoBox = UncheckedSendableBox(video)
            try writeResource(image, path: base + "." + imageExt, kind: "image", request: request) { first in
                switch first {
                case .failure(let error): finish(self.native(error))
                case .success(let imageRow):
                    let imageBox = UncheckedSendableBox(imageRow)
                    do { try self.writeResource(videoBox.value, path: base + "." + videoExt, kind: "video", request: request) { second in
                        switch second { case .success(let videoRow): finish(WireFormat.success(["ok": true, "assetId": id, "filePathBase": base, "resources": [imageBox.value, videoRow]])); case .failure(let error): finish(WireFormat.failure("partial_result", (error as NSError).localizedDescription, details: ["writtenResources": [imageBox.value], "outcomeUnknown": true])) }
                    } } catch { finish(WireFormat.failure("partial_result", (error as NSError).localizedDescription, details: ["writtenResources": [imageRow], "outcomeUnknown": true])) }
                }
            }; return
        }
        if sub == "export-video" || sub == "export" && a["format"] == nil && a["size"] == nil {
            guard asset.mediaType == (sub == "export-video" ? .video : .image) else { throw fail("unsupported_target", "Photos resource export media type differs") }
            let type: PHAssetResourceType = sub == "export-video" ? (asset.hasAdjustments ? .fullSizeVideo : .video) : (asset.hasAdjustments ? .fullSizePhoto : .photo)
            try writeResource(try resource(asset, type: type), path: a["out"] as! String, kind: sub == "export-video" ? "video" : "image", request: request) { result in
                switch result { case .failure(let error): finish(self.native(error)); case .success(var row): row.removeValue(forKey: "type"); row["ok"] = true; row["assetId"] = id; row["originalWidth"] = asset.pixelWidth; row["originalHeight"] = asset.pixelHeight; finish(WireFormat.success(row)) }
            }; return
        }
        guard asset.mediaType == .image || sub == "thumbnail" && asset.mediaType == .video else { throw fail("unsupported_target", "Photos raster export requires an image or video thumbnail") }
        let target = (a["size"] as? Int) ?? (sub == "thumbnail" ? 256 : max(asset.pixelWidth, asset.pixelHeight))
        guard target > 0, target <= 16384, sub == "thumbnail" || a["size"] != nil || asset.pixelWidth > 0 && asset.pixelHeight > 0 && asset.pixelWidth <= 33554432 / asset.pixelHeight else { throw fail("resource_limit", "Photos raster export exceeds 32M pixels; request an explicit bounded size") }
        let options = PHImageRequestOptions(); options.isNetworkAccessAllowed = true; options.deliveryMode = .highQualityFormat; options.resizeMode = .exact
        let manager = PHImageManager.default(), action = UncheckedSendableBox(a)
        let nativeId = manager.requestImage(for: asset, targetSize: CGSize(width: target, height: target), contentMode: .aspectFit, options: options) { image, info in
            let imageBox = UncheckedSendableBox(image), infoBox = UncheckedSendableBox(info)
            self.queue.async {
                guard request.live else { finish(WireFormat.failure("cancelled", "Photos raster completion retired")); return }
                if infoBox.value?[PHImageResultIsDegradedKey] as? Bool == true { return }
                if let error = infoBox.value?[PHImageErrorKey] as? NSError { finish(self.native(error)); return }
                if infoBox.value?[PHImageCancelledKey] as? Bool == true { finish(WireFormat.failure("cancelled", "native Photos image request cancelled")); return }
                guard let image = imageBox.value, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil), cg.width > 0, cg.height > 0, cg.width <= 33554432 / cg.height else { finish(WireFormat.failure("resource_limit", "native Photos raster is missing or exceeds 32M pixels")); return }
                let edge = min(target, max(cg.width, cg.height)), ratio = min(1.0, Double(edge) / Double(max(cg.width, cg.height))), width = max(1, Int(Double(cg.width) * ratio)), height = max(1, Int(Double(cg.height) * ratio))
                guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { finish(WireFormat.failure("provider_failed", "Photos raster allocation failed")); return }
                context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height)); guard let raster = context.makeImage() else { finish(WireFormat.failure("provider_failed", "Photos raster resizing failed")); return }
                let format = (action.value["format"] as? String) ?? "jpeg", uti = format == "png" ? "public.png" : "public.jpeg", encoded = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(encoded, uti as CFString, 1, nil) else { finish(WireFormat.failure("provider_failed", "Photos raster encoder missing")); return }
                CGImageDestinationAddImage(destination, raster, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
                guard CGImageDestinationFinalize(destination), encoded.length > 0, encoded.length <= 134217728 else { finish(WireFormat.failure("resource_limit", "Photos encoded raster is missing or exceeds 128MiB")); return }
                do {
                    let bytes = encoded as Data, write = sub != "thumbnail" || action.value["out"] != nil || action.value["save"] as? Bool == true
                    if write {
                        let path = (action.value["out"] as? String) ?? NSTemporaryDirectory() + "interceptor-photos-" + UUID().uuidString + ".jpg", output = try Output(path)
                        guard output.append(bytes) else { throw self.fail("provider_failed", "Photos raster write failed; partial output preserved") }; let count = try output.finish()
                        if sub == "thumbnail" { finish(WireFormat.success(["ok": true, "filePath": output.path, "format": "jpeg", "bytes": count, "width": width, "height": height])) }
                        else { finish(WireFormat.success(["ok": true, "assetId": id, "filePath": output.path, "uti": uti, "bytes": count, "originalWidth": asset.pixelWidth, "originalHeight": asset.pixelHeight, "exportWidth": width, "exportHeight": height])) }
                    } else { guard bytes.count <= 700000 else { throw self.fail("resource_limit", "inline Photos thumbnail exceeds 700000 bytes; use --out") }; finish(WireFormat.success(["ok": true, "format": "jpeg", "bytes": bytes.count, "width": width, "height": height, "dataUrl": "data:image/jpeg;base64," + bytes.base64EncodedString()])) }
                } catch { finish(self.native(error)) }
            }
        }
        request.cancelWith { manager.cancelImageRequest(nativeId) }
    }
}
