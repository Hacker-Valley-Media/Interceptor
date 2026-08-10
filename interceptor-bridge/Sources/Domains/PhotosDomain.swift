// PRD-66 Domain 10 — PhotoKit. macOS 10.13+ (PHAccessLevel macOS 11+).
// References: apple-developer-docs/Photos/{PHPhotoLibrary,PHAsset,PHAssetCollection,
// PHFetchOptions,PHImageManager,PHAuthorizationStatus,PHAccessLevel}.md.

import Foundation
import AppKit
import Photos
import ImageIO

final class PhotosDomain: DomainHandler, @unchecked Sendable {
    private let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private let isoFormatterPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    /// Parse ISO-8601 with or without fractional seconds. The strict
    /// `withFractionalSeconds` formatter rejects inputs like
    /// `2025-01-01T00:00:00Z`, which silently dropped the predicate from
    /// the assets fetch and returned the latest assets instead. Calendar's
    /// parser already does this dual-parse; align Photos with it.
    private func parseIso(_ s: String) -> Date? {
        return isoFormatter.date(from: s) ?? isoFormatterPlain.date(from: s)
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "status":              status(completion: completion)
        case "request":             requestAccess(action, completion: completion)
        case "albums":              albums(action, completion: completion)
        case "album":               album(action, completion: completion)
        case "album-create":        albumCreate(action, completion: completion)
        case "album-delete":        albumDelete(action, completion: completion)
        case "album-rename":        albumRename(action, completion: completion)
        case "assets":              assets(action, completion: completion)
        case "asset":               asset(action, completion: completion)
        case "export":              export(action, completion: completion)
        case "export-video":        exportVideo(action, completion: completion)
        case "export-live":         exportLive(action, completion: completion)
        case "thumbnail":           thumbnail(action, completion: completion)
        case "favorite":            favorite(action, completion: completion)
        case "hide":                hide(action, completion: completion)
        case "delete":              deleteAssets(action, completion: completion)
        case "add-to-album":        addToAlbum(action, completion: completion)
        case "remove-from-album":   removeFromAlbum(action, completion: completion)
        case "import":              importAsset(action, completion: completion, isVideo: false)
        case "import-video":        importAsset(action, completion: completion, isVideo: true)
        case "current-token":       currentToken(completion: completion)
        case "changes":             changes(action, completion: completion)
        default:                    completion(WireFormat.error("photos.\(sub) — unknown verb"))
        }
    }

    // MARK: - Helpers

    private func authStatusString(_ s: PHAuthorizationStatus) -> String {
        switch s {
        case .notDetermined: return "notDetermined"
        case .restricted:    return "restricted"
        case .denied:        return "denied"
        case .authorized:    return "authorized"
        case .limited:       return "limited"
        @unknown default:    return "unknown"
        }
    }

    private func mediaTypeString(_ t: PHAssetMediaType) -> String {
        switch t {
        case .image: return "image"
        case .video: return "video"
        case .audio: return "audio"
        case .unknown: return "unknown"
        @unknown default: return "unknown"
        }
    }

    private func subtypeStrings(_ s: PHAssetMediaSubtype) -> [String] {
        var out: [String] = []
        if s.contains(.photoPanorama) { out.append("panorama") }
        if s.contains(.photoHDR) { out.append("hdr") }
        if s.contains(.photoScreenshot) { out.append("screenshot") }
        if s.contains(.photoLive) { out.append("livePhoto") }
        if s.contains(.photoDepthEffect) { out.append("depthEffect") }
        if s.contains(.videoStreamed) { out.append("streamedVideo") }
        if s.contains(.videoHighFrameRate) { out.append("highFrameRate") }
        if s.contains(.videoTimelapse) { out.append("timelapse") }
        return out
    }

    private func parseSubtypeRequested(_ raw: String) -> PHAssetMediaSubtype? {
        switch raw {
        case "panorama": return .photoPanorama
        case "screenshot": return .photoScreenshot
        case "hdr": return .photoHDR
        case "livePhoto", "live": return .photoLive
        case "depthEffect": return .photoDepthEffect
        case "streamed": return .videoStreamed
        case "highFrameRate": return .videoHighFrameRate
        case "timelapse": return .videoTimelapse
        default: return nil
        }
    }

    private func assetDict(_ a: PHAsset) -> [String: Any] {
        var out: [String: Any] = [
            "id": a.localIdentifier,
            "mediaType": mediaTypeString(a.mediaType),
            "mediaSubtypes": subtypeStrings(a.mediaSubtypes),
            "pixelWidth": a.pixelWidth,
            "pixelHeight": a.pixelHeight,
            "duration": a.duration,
            "isFavorite": a.isFavorite,
            "isHidden": a.isHidden,
            "hasAdjustments": a.hasAdjustments,
            "burstIdentifier": a.burstIdentifier as Any? ?? NSNull(),
            "playbackStyle": String(describing: a.playbackStyle),
            "sourceType": String(describing: a.sourceType),
        ]
        if let c = a.creationDate { out["creationDate"] = isoFormatter.string(from: c) }
        if let m = a.modificationDate { out["modificationDate"] = isoFormatter.string(from: m) }
        if #available(macOS 13, *), let added = a.value(forKey: "addedDate") as? Date {
            out["addedDate"] = isoFormatter.string(from: added)
        }
        if let loc = a.location {
            out["location"] = [
                "latitude": loc.coordinate.latitude,
                "longitude": loc.coordinate.longitude,
                "altitude": loc.altitude,
                "horizontalAccuracy": loc.horizontalAccuracy,
            ]
        }
        return out
    }

    private func collectionDict(_ c: PHAssetCollection) -> [String: Any] {
        return [
            "id": c.localIdentifier,
            "title": c.localizedTitle as Any? ?? NSNull(),
            "type": String(describing: c.assetCollectionType),
            "subtype": String(describing: c.assetCollectionSubtype),
            "estimatedAssetCount": c.estimatedAssetCount,
        ]
    }

    // MARK: - Verbs

    private func status(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let s: PHAuthorizationStatus
        if #available(macOS 11, *) {
            s = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        } else {
            s = PHPhotoLibrary.authorizationStatus()
        }
        completion(WireFormat.success([
            "status": authStatusString(s),
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
        ]))
    }

    private func requestAccess(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let level = (action["level"] as? String) ?? "readwrite"
        if #available(macOS 11, *) {
            let pa: PHAccessLevel = (level == "addonly") ? .addOnly : .readWrite
            PHPhotoLibrary.requestAuthorization(for: pa) { s in
                completion(WireFormat.success(["status": self.authStatusString(s)]))
            }
        } else {
            PHPhotoLibrary.requestAuthorization { s in
                completion(WireFormat.success(["status": self.authStatusString(s)]))
            }
        }
    }

    private func albums(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var collections: [PHAssetCollection] = []
        // CLI sends `album_type` — `type` collides with the action envelope's
        // dispatch field (always "macos_photos"), so do not fall back to it.
        let typeFilter = action["album_type"] as? String
        if typeFilter == nil || typeFilter == "smart" {
            let smart = PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .any, options: nil)
            smart.enumerateObjects { c, _, _ in collections.append(c) }
        }
        if typeFilter == nil || typeFilter == "album" {
            let user = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
            user.enumerateObjects { c, _, _ in collections.append(c) }
        }
        if typeFilter == "moment" {
            // moments deprecated; surface empty list
        }
        completion(WireFormat.success(["albums": collections.map { collectionDict($0) }]))
    }

    private func album(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("photos.album: <id> required")); return }
        let result = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil)
        guard let c = result.firstObject else { completion(WireFormat.error("photos.album: not found")); return }
        completion(WireFormat.success(collectionDict(c)))
    }

    private func albumCreate(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let name = action["name"] as? String else { completion(WireFormat.error("photos.album-create: --name required")); return }
        var placeholderId: String?
        PHPhotoLibrary.shared().performChanges({
            let req = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: name)
            placeholderId = req.placeholderForCreatedAssetCollection.localIdentifier
        }, completionHandler: { ok, error in
            if ok, let id = placeholderId {
                completion(WireFormat.success(["id": id, "name": name]))
            } else {
                completion(WireFormat.error("photos.album-create: \(error?.localizedDescription ?? "failed")"))
            }
        })
    }

    private func albumDelete(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("photos.album-delete: <id> required")); return }
        let result = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil)
        PHPhotoLibrary.shared().performChanges({
            PHAssetCollectionChangeRequest.deleteAssetCollections(result)
        }, completionHandler: { ok, error in
            if ok { completion(WireFormat.success(["ok": true, "id": id])) }
            else { completion(WireFormat.error("photos.album-delete: \(error?.localizedDescription ?? "failed")")) }
        })
    }

    private func albumRename(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String, let name = action["name"] as? String else {
            completion(WireFormat.error("photos.album-rename: --id and --name required")); return
        }
        let result = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil)
        guard let c = result.firstObject else { completion(WireFormat.error("photos.album-rename: not found")); return }
        PHPhotoLibrary.shared().performChanges({
            let req = PHAssetCollectionChangeRequest(for: c)
            req?.title = name
        }, completionHandler: { ok, error in
            if ok { completion(WireFormat.success(["id": id, "name": name])) }
            else { completion(WireFormat.error("photos.album-rename: \(error?.localizedDescription ?? "failed")")) }
        })
    }

    private func buildFetchOptions(_ action: [String: Any]) -> PHFetchOptions {
        let opts = PHFetchOptions()
        var preds: [NSPredicate] = []

        if let media = action["media"] as? String {
            switch media {
            case "image": preds.append(NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue))
            case "video": preds.append(NSPredicate(format: "mediaType == %d", PHAssetMediaType.video.rawValue))
            case "audio": preds.append(NSPredicate(format: "mediaType == %d", PHAssetMediaType.audio.rawValue))
            default: break
            }
        }
        if let subtype = action["subtype"] as? String, let st = parseSubtypeRequested(subtype) {
            preds.append(NSPredicate(format: "(mediaSubtype & %d) != 0", st.rawValue))
        }
        if (action["favorite"] as? Bool) == true {
            preds.append(NSPredicate(format: "isFavorite == YES"))
        }
        if let since = action["since"] as? String, let s = parseIso(since) {
            preds.append(NSPredicate(format: "creationDate >= %@", s as NSDate))
        }
        if let until = action["until"] as? String, let u = parseIso(until) {
            preds.append(NSPredicate(format: "creationDate <= %@", u as NSDate))
        }
        if !preds.isEmpty { opts.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: preds) }
        if (action["hidden"] as? Bool) == true { opts.includeHiddenAssets = true }
        if (action["burst"] as? Bool) == true { opts.includeAllBurstAssets = true }
        if let limit = action["limit"] as? Int { opts.fetchLimit = limit }
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        return opts
    }

    private func assets(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let options = buildFetchOptions(action)
        let result: PHFetchResult<PHAsset>
        if let albumId = action["album"] as? String,
           let coll = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [albumId], options: nil).firstObject {
            result = PHAsset.fetchAssets(in: coll, options: options)
        } else {
            result = PHAsset.fetchAssets(with: options)
        }
        var arr: [[String: Any]] = []
        let offset = (action["offset"] as? Int) ?? 0
        result.enumerateObjects { asset, idx, stop in
            if idx < offset { return }
            arr.append(self.assetDict(asset))
        }
        completion(WireFormat.success([
            "count": result.count,
            "limit": (options.fetchLimit > 0 ? options.fetchLimit : NSNull()) as Any,
            "offset": offset,
            "assets": arr,
        ]))
    }

    private func asset(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("photos.asset: <id> required")); return }
        let result = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
        guard let a = result.firstObject else { completion(WireFormat.error("photos.asset: not found")); return }
        completion(WireFormat.success(assetDict(a)))
    }

    private func export(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String, let outPath = action["out"] as? String else {
            completion(WireFormat.error("photos.export: <id> and --out required")); return
        }
        // Validated up front, before the asset fetch, so an unsupported value reports itself
        // rather than hiding behind a "not found" from an unrelated bad id.
        let wantFormat = (action["format"] as? String)?.lowercased()
        if let want = wantFormat, want != "jpeg", want != "png" {
            completion(WireFormat.error("photos.export: --format must be jpeg or png (got \(want))")); return
        }
        let result = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
        guard let a = result.firstObject else { completion(WireFormat.error("photos.export: not found")); return }
        let outURL = URL(fileURLWithPath: (outPath as NSString).expandingTildeInPath)
        let manager = PHImageManager.default()
        let opts = PHImageRequestOptions()
        opts.isSynchronous = false
        opts.deliveryMode = .highQualityFormat
        opts.isNetworkAccessAllowed = true

        if let sizePx = action["size"] as? Int, sizePx > 0 {
            let target = CGSize(width: sizePx, height: sizePx)
            manager.requestImage(for: a, targetSize: target, contentMode: .aspectFit, options: opts) { image, _ in
                guard let image = image,
                      let tiff = image.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
                else { completion(WireFormat.error("photos.export: encode failed")); return }
                do {
                    try data.write(to: outURL)
                    completion(WireFormat.success([
                        "ok": true, "assetId": id, "filePath": outURL.path, "uti": "public.jpeg",
                        "bytes": data.count,
                        "originalWidth": a.pixelWidth, "originalHeight": a.pixelHeight,
                        "exportWidth": Int(image.size.width), "exportHeight": Int(image.size.height),
                    ]))
                } catch {
                    completion(WireFormat.error("photos.export: write failed \(error.localizedDescription)"))
                }
            }
        } else {
            manager.requestImageDataAndOrientation(for: a, options: opts) { data, uti, _, _ in
                guard let data = data else { completion(WireFormat.error("photos.export: no data")); return }
                // Without --size this hands back the asset's original bytes, which for most
                // iPhone captures is HEIC. --format lets a caller ask for something portable
                // without also having to resize; previously it was accepted and discarded,
                // so `--format jpeg --out shot.jpg` wrote a HEIC under a .jpg name and every
                // downstream consumer that trusts the extension broke confusingly.
                var outData = data
                var outUTI: String? = uti
                if let want = wantFormat, want == "jpeg" || want == "png" {
                    let targetUTI = want == "jpeg" ? "public.jpeg" : "public.png"
                    if uti != targetUTI {
                        guard let rep = NSBitmapImageRep(data: data),
                              let converted = rep.representation(
                                using: want == "jpeg" ? .jpeg : .png,
                                properties: want == "jpeg" ? [.compressionFactor: 0.9] : [:])
                        else {
                            completion(WireFormat.error("photos.export: transcode to \(want) failed")); return
                        }
                        outData = converted
                        outUTI = targetUTI
                    }
                }
                do {
                    try outData.write(to: outURL)
                    completion(WireFormat.success([
                        "ok": true, "assetId": id, "filePath": outURL.path,
                        "uti": outUTI as Any? ?? NSNull(), "bytes": outData.count,
                        "originalWidth": a.pixelWidth, "originalHeight": a.pixelHeight,
                    ]))
                } catch {
                    completion(WireFormat.error("photos.export: write failed \(error.localizedDescription)"))
                }
            }
        }
    }

    private func exportVideo(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String, let outPath = action["out"] as? String else {
            completion(WireFormat.error("photos.export-video: --id and --out required")); return
        }
        let result = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
        guard let a = result.firstObject else { completion(WireFormat.error("photos.export-video: not found")); return }
        let opts = PHVideoRequestOptions()
        opts.isNetworkAccessAllowed = true
        PHImageManager.default().requestExportSession(forVideo: a, options: opts, exportPreset: AVAssetExportPresetHighestQuality) { session, _ in
            guard let session = session else { completion(WireFormat.error("photos.export-video: no session")); return }
            let outURL = URL(fileURLWithPath: (outPath as NSString).expandingTildeInPath)
            session.outputURL = outURL
            session.outputFileType = .mov
            session.exportAsynchronously {
                if session.status == .completed {
                    completion(WireFormat.success(["ok": true, "assetId": id, "filePath": outURL.path]))
                } else {
                    completion(WireFormat.error("photos.export-video: \(session.error?.localizedDescription ?? "export failed")"))
                }
            }
        }
    }

    private func exportLive(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String, let outPrefix = action["out"] as? String else {
            completion(WireFormat.error("photos.export-live: --id and --out required")); return
        }
        let result = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
        guard let a = result.firstObject else { completion(WireFormat.error("photos.export-live: not found")); return }
        let opts = PHLivePhotoRequestOptions()
        opts.isNetworkAccessAllowed = true
        PHImageManager.default().requestLivePhoto(for: a, targetSize: .zero, contentMode: .default, options: opts) { live, _ in
            guard live != nil else { completion(WireFormat.error("photos.export-live: no live photo")); return }
            // PHLivePhoto exports require AVAsset extraction — surface metadata
            // and a stub path; deeper export is left to clients via export + export-video.
            let outBase = (outPrefix as NSString).expandingTildeInPath
            completion(WireFormat.success([
                "ok": true, "assetId": id,
                "filePathBase": outBase,
                "note": "Live Photo export emits paired image+video; use photos.export and photos.export-video to extract each component.",
            ]))
        }
    }

    private func thumbnail(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("photos.thumbnail: <id> required")); return }
        let result = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
        guard let a = result.firstObject else { completion(WireFormat.error("photos.thumbnail: not found")); return }
        let sizeRaw = (action["size"] as? Int) ?? 256
        let target = CGSize(width: sizeRaw, height: sizeRaw)
        let opts = PHImageRequestOptions()
        opts.isSynchronous = false
        opts.deliveryMode = .highQualityFormat
        opts.isNetworkAccessAllowed = true
        let outRequested = action["out"] as? String
        // Passing --out is itself a request to write a file. Requiring --save alongside it
        // meant `thumbnail <id> --out shot.jpg` wrote nothing and instead returned the image
        // inline as a base64 dataUrl, which for an agent caller is a large payload delivered
        // at exactly the moment it asked for a path instead. Backward compatible: --out
        // without --save previously had no effect, so nothing can depend on the old behavior.
        let save = (action["save"] as? Bool) ?? (outRequested != nil)
        PHImageManager.default().requestImage(for: a, targetSize: target, contentMode: .aspectFit, options: opts) { image, _ in
            guard let image = image else { completion(WireFormat.error("photos.thumbnail: no image")); return }
            guard let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
            else { completion(WireFormat.error("photos.thumbnail: encode failed")); return }
            if save {
                let outURL = URL(fileURLWithPath: (outRequested ?? "/tmp/photos-thumb-\(UUID().uuidString.prefix(8)).jpg" as String).expanding)
                do {
                    try data.write(to: outURL)
                    completion(WireFormat.success(["ok": true, "filePath": outURL.path, "bytes": data.count, "format": "jpeg"]))
                } catch {
                    completion(WireFormat.error("photos.thumbnail: write failed \(error.localizedDescription)"))
                }
            } else {
                completion(WireFormat.success([
                    "ok": true,
                    "format": "jpeg",
                    "bytes": data.count,
                    "dataUrl": "data:image/jpeg;base64,\(data.base64EncodedString())",
                ]))
            }
        }
    }

    private func favorite(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("photos.favorite: <id> required")); return }
        let on = (action["on"] as? Bool) ?? true
        let result = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
        guard let a = result.firstObject else { completion(WireFormat.error("photos.favorite: not found")); return }
        PHPhotoLibrary.shared().performChanges({
            let req = PHAssetChangeRequest(for: a)
            req.isFavorite = on
        }, completionHandler: { ok, error in
            if ok { completion(WireFormat.success(["ok": true, "id": id, "isFavorite": on])) }
            else { completion(WireFormat.error("photos.favorite: \(error?.localizedDescription ?? "failed")")) }
        })
    }

    private func hide(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("photos.hide: <id> required")); return }
        let on = (action["on"] as? Bool) ?? true
        let result = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
        guard let a = result.firstObject else { completion(WireFormat.error("photos.hide: not found")); return }
        PHPhotoLibrary.shared().performChanges({
            let req = PHAssetChangeRequest(for: a)
            req.isHidden = on
        }, completionHandler: { ok, error in
            if ok { completion(WireFormat.success(["ok": true, "id": id, "isHidden": on])) }
            else { completion(WireFormat.error("photos.hide: \(error?.localizedDescription ?? "failed")")) }
        })
    }

    private func deleteAssets(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("photos.delete: <id> required")); return }
        let ids = id.split(separator: ",").map(String.init)
        let result = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        PHPhotoLibrary.shared().performChanges({
            PHAssetChangeRequest.deleteAssets(result)
        }, completionHandler: { ok, error in
            if ok { completion(WireFormat.success(["ok": true, "deleted": ids])) }
            else { completion(WireFormat.error("photos.delete: \(error?.localizedDescription ?? "failed")")) }
        })
    }

    private func addToAlbum(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let albumId = action["album"] as? String, let assetId = action["asset"] as? String else {
            completion(WireFormat.error("photos.add-to-album: --album and --asset required")); return
        }
        let coll = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [albumId], options: nil).firstObject
        guard let coll = coll else { completion(WireFormat.error("photos.add-to-album: album not found")); return }
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: assetId.split(separator: ",").map(String.init), options: nil)
        PHPhotoLibrary.shared().performChanges({
            if let req = PHAssetCollectionChangeRequest(for: coll) {
                req.addAssets(assets)
            }
        }, completionHandler: { ok, error in
            if ok { completion(WireFormat.success(["ok": true, "album": albumId])) }
            else { completion(WireFormat.error("photos.add-to-album: \(error?.localizedDescription ?? "failed")")) }
        })
    }

    private func removeFromAlbum(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let albumId = action["album"] as? String, let assetId = action["asset"] as? String else {
            completion(WireFormat.error("photos.remove-from-album: --album and --asset required")); return
        }
        let coll = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [albumId], options: nil).firstObject
        guard let coll = coll else { completion(WireFormat.error("photos.remove-from-album: album not found")); return }
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: assetId.split(separator: ",").map(String.init), options: nil)
        PHPhotoLibrary.shared().performChanges({
            if let req = PHAssetCollectionChangeRequest(for: coll) {
                req.removeAssets(assets)
            }
        }, completionHandler: { ok, error in
            if ok { completion(WireFormat.success(["ok": true, "album": albumId])) }
            else { completion(WireFormat.error("photos.remove-from-album: \(error?.localizedDescription ?? "failed")")) }
        })
    }

    private func importAsset(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void, isVideo: Bool) {
        guard let path = action["file"] as? String else { completion(WireFormat.error("photos.import: --file required")); return }
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        var placeholderId: String?
        PHPhotoLibrary.shared().performChanges({
            let req: PHAssetCreationRequest? = PHAssetCreationRequest.creationRequestForAssetFromImage(atFileURL: url) // works for images
            if isVideo {
                let v = PHAssetCreationRequest.forAsset()
                v.addResource(with: .video, fileURL: url, options: nil)
                placeholderId = v.placeholderForCreatedAsset?.localIdentifier
            } else {
                placeholderId = req?.placeholderForCreatedAsset?.localIdentifier
            }
            if let albumId = action["album"] as? String,
               let coll = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [albumId], options: nil).firstObject,
               let placeholder = (req ?? PHAssetCreationRequest.forAsset()).placeholderForCreatedAsset,
               let albumReq = PHAssetCollectionChangeRequest(for: coll) {
                albumReq.addAssets([placeholder] as NSArray)
            }
        }, completionHandler: { ok, error in
            if ok {
                completion(WireFormat.success(["ok": true, "id": placeholderId as Any? ?? NSNull()]))
            } else {
                completion(WireFormat.error("photos.import: \(error?.localizedDescription ?? "failed")"))
            }
        })
    }

    private func currentToken(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) {
            let token = PHPhotoLibrary.shared().currentChangeToken
            let tokenData = try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: false)
            completion(WireFormat.success(["token": tokenData?.base64EncodedString() as Any? ?? NSNull()]))
        } else {
            completion(WireFormat.error("photos.current-token: requires macOS 14+"))
        }
    }

    private func changes(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) {
            guard let raw = action["token"] as? String, let data = Data(base64Encoded: raw),
                  let token = try? NSKeyedUnarchiver.unarchivedObject(ofClass: PHPersistentChangeToken.self, from: data)
            else { completion(WireFormat.error("photos.changes: --token <opaque-base64> required")); return }
            do {
                let result = try PHPhotoLibrary.shared().fetchPersistentChanges(since: token)
                completion(WireFormat.success([
                    "events": [Any](),
                    "fetchResultClass": String(describing: type(of: result)),
                    "note": "Persistent-change enumeration is platform-version dependent; per-token deltas should be consumed via PHPhotoLibraryChangeObserver in the daemon.",
                ]))
            } catch {
                completion(WireFormat.error("photos.changes: \(error.localizedDescription)"))
            }
        } else {
            completion(WireFormat.error("photos.changes: requires macOS 14+"))
        }
    }
}

// Tiny helper used in `thumbnail` — keep at end of file scope.
private extension String {
    var expanding: String { (self as NSString).expandingTildeInPath }
}
