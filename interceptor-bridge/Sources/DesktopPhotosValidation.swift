import Foundation
import CoreFoundation

enum DesktopPhotosValidation {
    static let fields: [String: [String]] = ["status": [], "request": ["level"], "albums": ["album_type"], "album": ["id"], "album-create": ["name"], "album-delete": ["id"], "album-rename": ["id", "name"], "assets": ["album", "media", "subtype", "since", "until", "where", "limit", "offset", "favorite", "hidden", "burst"], "asset": ["id"], "export": ["id", "out", "format", "size"], "export-video": ["id", "out"], "export-live": ["id", "out"], "thumbnail": ["id", "out", "size", "save"], "favorite": ["id", "on"], "hide": ["id", "on"], "delete": ["id"], "add-to-album": ["album", "asset"], "remove-from-album": ["album", "asset"], "import": ["file", "album"], "import-video": ["file", "album"], "current-token": [], "changes": ["token"]]
    static let required: [String: [String]] = ["album": ["id"], "album-create": ["name"], "album-delete": ["id"], "album-rename": ["id", "name"], "asset": ["id"], "export": ["id", "out"], "export-video": ["id", "out"], "export-live": ["id", "out"], "thumbnail": ["id"], "favorite": ["id"], "hide": ["id"], "delete": ["id"], "add-to-album": ["album", "asset"], "remove-from-album": ["album", "asset"], "import": ["file"], "import-video": ["file"], "changes": ["token"]]
    static func ids(_ value: Any?) -> [String]? {
        guard let raw = value as? String else { return nil }
        let ids = raw.components(separatedBy: ",")
        return ids.count <= 100 && Set(ids).count == ids.count && ids.allSatisfy { !$0.isEmpty && $0.trimmingCharacters(in: .whitespacesAndNewlines) == $0 && $0.utf8.count <= 4096 && !$0.contains("\0") } ? ids : nil
    }
    static func comparisons(_ raw: String) -> [(String, String, NSObject)]? {
        let clauses = raw.components(separatedBy: " AND ")
        guard !raw.isEmpty, clauses.count <= 8, let regex = try? NSRegularExpression(pattern: "^(isFavorite|isHidden|mediaType|pixelWidth|pixelHeight|duration|creationDate|modificationDate) (==|!=|>=|<=|>|<) (true|false|[0-9]+(?:\\.[0-9]+)?|\"[^\"\\r\\n]+\")$") else { return nil }
        var rows: [(String, String, NSObject)] = []
        for clause in clauses {
            let text = clause as NSString
            guard let match = regex.firstMatch(in: clause, range: NSRange(location: 0, length: text.length)) else { return nil }
            let key = text.substring(with: match.range(at: 1)), op = text.substring(with: match.range(at: 2)), value = text.substring(with: match.range(at: 3))
            if ["isFavorite", "isHidden"].contains(key) {
                guard ["==", "!="].contains(op), ["true", "false"].contains(value) else { return nil }; rows.append((key, op, NSNumber(value: value == "true")))
            } else if key.hasSuffix("Date") {
                guard value.hasPrefix("\""), let date = DesktopEventKitValidation.date(String(value.dropFirst().dropLast())) else { return nil }; rows.append((key, op, date as NSDate))
            } else {
                guard let n = Double(value), n.isFinite, n >= 0, n <= 1e9, key == "duration" || n.rounded(.towardZero) == n, key != "mediaType" || n <= 3 else { return nil }; rows.append((key, op, NSNumber(value: n)))
            }
        }
        return rows
    }
    static func actionError(_ a: [String: Any]) -> String? {
        if let error = DesktopPhotosShape.validationError(a) { return error }
        guard let sub = a["sub"] as? String, let keys = fields[sub] else { return "unknown Photos selector" }
        if a.keys.contains(where: { !(["type", "sub"] + keys).contains($0) }) { return "field does not belong to Photos selector" }
        if (required[sub] ?? []).contains(where: { a[$0] == nil }) { return "Photos selector requires exact fields" }
        for (key, value) in a { if let text = value as? String, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.contains("\0") || text.utf8.count > (key == "token" ? 65536 : 4096) { return "invalid bounded Photos text" } }
        for (key, low, high) in [("limit", 1.0, 1000.0), ("offset", 0.0, 10000.0), ("size", 1.0, 4096.0)] {
            if let value = a[key] { guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, n.doubleValue.rounded(.towardZero) == n.doubleValue, n.doubleValue >= low, n.doubleValue <= high else { return "invalid Photos integer" } }
        }
        for key in ["favorite", "hidden", "burst", "save", "on"] { if let value = a[key], !(value is NSNumber && CFGetTypeID(value as! NSNumber) == CFBooleanGetTypeID()) { return "invalid Photos Boolean" } }
        for key in ["since", "until"] { if a[key] != nil && DesktopEventKitValidation.date(a[key]) == nil { return "invalid Photos ISO8601 instant" } }
        if let start = DesktopEventKitValidation.date(a["since"]), let end = DesktopEventKitValidation.date(a["until"]), end < start { return "Photos interval is reversed" }
        for (key, values) in [("level", ["readwrite", "addonly"]), ("album_type", ["album", "smart", "moment"]), ("media", ["image", "video", "audio", "unknown"]), ("subtype", ["panorama", "screenshot", "hdr", "livePhoto", "live", "depthEffect", "streamed", "streamedVideo", "highFrameRate", "timelapse"]), ("format", ["jpeg", "png"])] { if let raw = a[key] as? String, !values.contains(raw) { return "unknown Photos enum" } }
        if let raw = a["where"] as? String, comparisons(raw) == nil { return "Photos where requires at most 8 documented scalar comparisons joined by AND" }
        for key in ["id", "asset"] { if a[key] != nil && ids(a[key]) == nil { return "invalid exact Photos identities" } }
        if sub != "delete", let raw = a["id"] as? String, raw.contains(",") { return "Photos selector requires one identity" }
        if let raw = a["token"] as? String, Data(base64Encoded: raw)?.base64EncodedString() != raw { return "Photos token requires canonical bounded base64" }
        for key in ["file", "out"] { if let raw = a[key] as? String, !raw.hasPrefix("/") && !raw.hasPrefix("~/") { return "Photos requires an absolute or home-relative path" } }
        guard let bytes = try? JSONSerialization.data(withJSONObject: a), bytes.count <= 131072 else { return "Photos request exceeds 128KiB" }
        return nil
    }
    static func resultError(_ response: [String: Any], action: [String: Any]) -> String? {
        guard response["success"] as? Bool == true else { return nil }
        guard let data = response["data"] as? [String: Any], let bytes = try? JSONSerialization.data(withJSONObject: data), bytes.count <= 1048576 else { return "Photos reply exceeds 1MiB" }
        let sub = action["sub"] as! String, decoder = JSONDecoder()
        do {
            switch sub {
            case "status", "request": _ = try decoder.decode(DesktopPhotosStatus.self, from: bytes)
            case "albums": _ = try decoder.decode(DesktopPhotosAlbums.self, from: bytes)
            case "album": _ = try decoder.decode(DesktopPhotosAlbum.self, from: bytes)
            case "album-create", "album-rename": _ = try decoder.decode(DesktopPhotosNamed.self, from: bytes)
            case "assets": _ = try decoder.decode(DesktopPhotosAssets.self, from: bytes)
            case "asset": _ = try decoder.decode(DesktopPhotosAsset.self, from: bytes)
            case "export", "export-video": _ = try decoder.decode(DesktopPhotosExport.self, from: bytes)
            case "export-live": _ = try decoder.decode(DesktopPhotosLiveExport.self, from: bytes)
            case "thumbnail": _ = try decoder.decode(DesktopPhotosThumbnail.self, from: bytes)
            case "delete": _ = try decoder.decode(DesktopPhotosDeleted.self, from: bytes)
            case "add-to-album", "remove-from-album": _ = try decoder.decode(DesktopPhotosMembership.self, from: bytes)
            case "current-token": _ = try decoder.decode(DesktopPhotosToken.self, from: bytes)
            case "changes": _ = try decoder.decode(DesktopPhotosChanges.self, from: bytes)
            default: _ = try decoder.decode(DesktopPhotosOK.self, from: bytes)
            }
        } catch { return "invalid native Photos result: \(error.localizedDescription)" }
        if data["ok"] != nil && data["ok"] as? Bool != true { return "Photos success does not confirm effect" }
        if let id = action["id"] as? String, sub != "delete", let actual = (data["id"] ?? data["assetId"]) as? String, id != actual { return "Photos reply differs from requested identity" }
        if sub == "favorite", data["isFavorite"] as? Bool != ((action["on"] as? Bool) ?? true) { return "Photos favorite readback differs" }
        if sub == "hide", data["isHidden"] as? Bool != ((action["on"] as? Bool) ?? true) { return "Photos hidden readback differs" }
        if sub == "album-rename", data["name"] as? String != action["name"] as? String { return "Photos album name readback differs" }
        if sub == "assets" {
            guard let rows = data["assets"] as? [[String: Any]], let count = data["count"] as? Int, let limit = data["limit"] as? Int, let offset = data["offset"] as? Int, count >= 0, limit == ((action["limit"] as? Int) ?? 100), offset == ((action["offset"] as? Int) ?? 0), rows.count <= limit, data["hasMore"] as? Bool == (offset + rows.count < count), Set(rows.compactMap { $0["id"] as? String }).count == rows.count else { return "Photos page differs from native count or bounds" }
        }
        let rows = sub == "asset" ? [data] : (data["assets"] as? [[String: Any]] ?? [])
        for row in rows { for key in ["creationDate", "modificationDate", "addedDate"] { if row[key] != nil && DesktopEventKitValidation.date(row[key]) == nil { return "invalid native Photos date" } }; if (row["pixelWidth"] as? Int ?? -1) < 0 || (row["pixelHeight"] as? Int ?? -1) < 0 || (row["duration"] as? Double ?? -1) < 0 { return "invalid native Photos dimensions or duration" } }
        if ["export", "export-video", "thumbnail"].contains(sub), let n = data["bytes"] as? Int, !(1...134217728).contains(n) { return "invalid actual Photos artifact bytes" }
        if sub == "export-live" { guard let rows = data["resources"] as? [[String: Any]], rows.count == 2, Set(rows.compactMap { $0["type"] as? String }) == Set(["image", "video"]), rows.allSatisfy({ (1...134217728).contains($0["bytes"] as? Int ?? 0) }) else { return "Live Photo success requires paired artifacts" } }
        if sub == "thumbnail", (data["filePath"] != nil) == (data["dataUrl"] != nil) { return "Photos thumbnail requires exactly one byte source" }
        if sub == "delete", data["deleted"] as? [String] != ids(action["id"]) { return "Photos deleted identities differ" }
        if ["add-to-album", "remove-from-album"].contains(sub), data["album"] as? String != action["album"] as? String || data["assets"] as? [String] != ids(action["asset"]) { return "Photos membership identities differ" }
        return nil
    }
}
