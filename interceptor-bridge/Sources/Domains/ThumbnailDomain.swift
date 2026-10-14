// QuickLookThumbnailing. macOS 10.15+. Implements all 8
// CLI verbs (info / generate / batch + flags). References:
// apple-developer-docs/QuickLookThumbnailing/QLThumbnailGenerator.md.

import Foundation
import AppKit
import QuickLookThumbnailing
import UniformTypeIdentifiers
import ImageIO

final class ThumbnailDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let error = DesktopThumbnailValidation.validate(action) { completion(error); return }
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "generate":  generate(action, completion: completion)
        case "batch":     batch(action, completion: completion)
        default:          completion(WireFormat.error("thumbnail.\(sub) — unknown verb"))
        }
    }

    private func parseSize(_ s: String?) -> CGSize {
        guard let s = s else { return CGSize(width: 256, height: 256) }
        if s.contains("x") {
            let parts = s.split(separator: "x").compactMap { Double($0) }
            if parts.count == 2 { return CGSize(width: parts[0], height: parts[1]) }
        }
        if let n = Double(s) { return CGSize(width: n, height: n) }
        return CGSize(width: 256, height: 256)
    }

    private func parseTypes(_ s: String?) -> QLThumbnailGenerator.Request.RepresentationTypes {
        guard let s = s else { return .all }
        var mask: QLThumbnailGenerator.Request.RepresentationTypes = []
        for raw in s.split(separator: ",") {
            switch raw.trimmingCharacters(in: .whitespaces) {
            case "icon": mask.insert(.icon)
            case "thumbnail": mask.insert(.thumbnail)
            case "lowQuality", "lowQualityThumbnail": mask.insert(.lowQualityThumbnail)
            case "all": mask = .all
            default: break
            }
        }
        return mask.isEmpty ? .all : mask
    }

    private func format(_ s: String?) -> (String, CFString, String) {
        switch (s ?? "png").lowercased() {
        case "jpeg", "jpg": return ("jpeg", "public.jpeg" as CFString, "jpeg")
        case "heic": return ("heic", "public.heic" as CFString, "heic")
        default: return ("png", "public.png" as CFString, "png")
        }
    }

    private func generate(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if action["type"] as? String == "desktop_thumbnail" {
            generateNeutral(action, completion: completion)
            return
        }
        guard let path = action["path"] as? String else { completion(WireFormat.error("thumbnail: missing path")); return }
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        let size = parseSize(action["size"] as? String)
        let scale = (action["scale"] as? Int).map { CGFloat($0) } ?? 2
        let types = parseTypes(action["types"] as? String)
        let request = QLThumbnailGenerator.Request(fileAt: url, size: size, scale: scale, representationTypes: types)
        let save = (action["save"] as? Bool) ?? false
        let outRequested = action["out"] as? String
        let (formatName, contentType, ext) = format(action["format"] as? String)

        if save {
            let outURL: URL = {
                if let o = outRequested { return URL(fileURLWithPath: (o as NSString).expandingTildeInPath) }
                return url.appendingPathExtension("thumb.\(ext)")
            }()
            QLThumbnailGenerator.shared.saveBestRepresentation(for: request, to: outURL, contentType: contentType as String) { error in
                if let error = error {
                    completion(WireFormat.error("thumbnail.save: \(error.localizedDescription)"))
                    return
                }
                let attrs = (try? FileManager.default.attributesOfItem(atPath: outURL.path)) ?? [:]
                let bytes = (attrs[.size] as? Int) ?? 0
                completion(WireFormat.success([
                    "path": path, "type": "thumbnail", "filePath": outURL.path,
                    "format": formatName, "bytes": bytes,
                    "width": Int(size.width * scale), "height": Int(size.height * scale), "scale": Int(scale),
                ]))
            }
        } else {
            QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { thumbnail, error in
                if let error = error {
                    completion(WireFormat.error("thumbnail: \(error.localizedDescription)"))
                    return
                }
                guard let thumbnail = thumbnail else {
                    completion(WireFormat.error("thumbnail: no representation"))
                    return
                }
                let nsImage = thumbnail.nsImage
                guard let data = self.encode(nsImage, format: formatName) else {
                    completion(WireFormat.error("thumbnail: encode failed"))
                    return
                }
                let dataUrl = "data:image/\(formatName);base64,\(data.base64EncodedString())"
                completion(WireFormat.success([
                    "path": path, "type": "thumbnail",
                    "width": Int(thumbnail.cgImage.width), "height": Int(thumbnail.cgImage.height),
                    "scale": Int(scale), "format": formatName, "bytes": data.count,
                    "dataUrl": dataUrl,
                ]))
            }
        }
    }

    private func encode(_ image: NSImage, format: String) -> Data? {
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        switch format {
        case "jpeg": return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
        case "heic":
            // ImageIO heic export
            guard let cg = rep.cgImage else { return nil }
            let mutable = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(mutable, "public.heic" as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else { return nil }
            return mutable as Data
        default:
            return rep.representation(using: .png, properties: [:])
        }
    }

    private func batch(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if action["type"] as? String == "desktop_thumbnail" {
            batchNeutral(action, index: 0, results: [], completion: completion)
            return
        }
        guard let paths = action["paths"] as? [String], !paths.isEmpty else {
            completion(WireFormat.error("thumbnail.batch: requires <paths>")); return
        }
        // Accumulate via a Sendable box so Swift 6 concurrency is satisfied.
        final class Accumulator: @unchecked Sendable {
            let lock = NSLock()
            var results: [[String: Any]]
            init(count: Int) { results = [[String: Any]](repeating: [:], count: count) }
        }
        let acc = Accumulator(count: paths.count)
        let group = DispatchGroup()
        for (idx, p) in paths.enumerated() {
            group.enter()
            var fwd = action
            fwd["path"] = p
            generate(fwd) { resp in
                acc.lock.lock()
                acc.results[idx] = ["path": p, "ok": (resp["success"] as? Bool) ?? false, "result": resp]
                acc.lock.unlock()
                group.leave()
            }
        }
        group.notify(queue: .global()) {
            completion(WireFormat.success(["results": acc.results]))
        }
    }

    private func generateNeutral(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let path = action["path"] as! String
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL
        let fail = DesktopThumbnailValidation.failure
        do {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentTypeKey])
            guard values.isRegularFile == true else { completion(fail("unsupported_target", "thumbnail requires a regular file")); return }
            guard (values.fileSize ?? 0) <= DESKTOP_THUMBNAIL_MAX_SOURCE_BYTES else { completion(fail("resource_limit", "thumbnail source exceeds 64 MiB")); return }
            let source = CGImageSourceCreateWithURL(url as CFURL, nil)
            let decodedType = source.flatMap { CGImageSourceGetType($0) }.flatMap { UTType($0 as String) }
            if values.contentType?.conforms(to: .pdf) == true || decodedType?.conforms(to: .pdf) == true {
                guard let document = CGPDFDocument(url as CFURL) else {
                    completion(fail("unsupported_target", "PDF source has no readable document")); return
                }
                guard !document.isEncrypted || document.isUnlocked else {
                    completion(fail("permission_denied", "PDF source requires a password; no document pixels were rendered")); return
                }
                guard document.numberOfPages > 0 else {
                    completion(fail("unsupported_target", "PDF source has no pages")); return
                }
            } else if let source {
                guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
                      let width = properties[kCGImagePropertyPixelWidth as String] as? NSNumber,
                      let height = properties[kCGImagePropertyPixelHeight as String] as? NSNumber,
                      width.doubleValue > 0, height.doubleValue > 0
                else { completion(fail("unsupported_target", "image header has no valid pixel dimensions")); return }
                if width.doubleValue * height.doubleValue > Double(DESKTOP_THUMBNAIL_MAX_PIXELS) {
                    completion(fail("resource_limit", "thumbnail source exceeds 32 megapixels")); return
                }
            } else if values.contentType?.conforms(to: .image) == true {
                completion(fail("unsupported_target", "image source has no readable header")); return
            }
        } catch {
            let ns = error as NSError
            completion(fail(ns.code == NSFileNoSuchFileError || ns.code == NSFileReadNoSuchFileError ? "target_gone" : ns.code == NSFileReadNoPermissionError ? "permission_denied" : "provider_failed", ns.localizedDescription))
            return
        }
        let size = parseSize(action["size"] as? String)
        let scale = (action["scale"] as? Int) ?? 2
        let saving = action["save"] as? Bool == true
        let (formatName, _, ext) = format(action["format"] as? String)
        let destination = URL(fileURLWithPath: ((action["out"] as? String ?? url.path + ".thumb.\(ext)") as NSString).expandingTildeInPath).standardizedFileURL
        if saving && destination.resolvingSymlinksInPath() == url.resolvingSymlinksInPath() {
            completion(fail("invalid_request", "thumbnail output must not replace its source image")); return
        }
        let request = QLThumbnailGenerator.Request(fileAt: url, size: size, scale: CGFloat(scale), representationTypes: parseTypes(action["types"] as? String))
        QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { representation, error in
            if let error { completion(fail("provider_failed", error.localizedDescription)); return }
            // An icon renders at its own size (up to 1024 px) whatever was requested, and its nsImage carries every
            // resolution, so encode the rendered cgImage fitted to the requested pixel bounds.
            guard let representation else { completion(fail("provider_failed", "thumbnail representation could not be encoded")); return }
            var rendered = representation.cgImage
            let maxWidth = Int(size.width) * scale, maxHeight = Int(size.height) * scale
            if rendered.width > maxWidth || rendered.height > maxHeight {
                let fit = min(Double(maxWidth) / Double(rendered.width), Double(maxHeight) / Double(rendered.height))
                if let fitted = CaptureDomain.resize(cgImage: rendered, width: max(1, Int(Double(rendered.width) * fit)), height: max(1, Int(Double(rendered.height) * fit))) { rendered = fitted }
            }
            guard let encoded = self.encode(NSImage(cgImage: rendered, size: NSSize(width: rendered.width, height: rendered.height)), format: formatName),
                  let source = CGImageSourceCreateWithData(encoded as CFData, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
            else { completion(fail("provider_failed", "thumbnail representation could not be encoded")); return }
            guard image.width > 0, image.height > 0, image.width * image.height <= DESKTOP_THUMBNAIL_MAX_PIXELS,
                  image.width <= Int(size.width) * scale, image.height <= Int(size.height) * scale,
                  encoded.count <= DESKTOP_MAX_RESULT_BYTES
            else { completion(fail("resource_limit", "thumbnail image exceeds its dimensions or byte bound")); return }
            var data: [String: Any] = ["path": path, "type": "thumbnail", "width": image.width, "height": image.height,
                "scale": scale, "format": formatName, "bytes": encoded.count]
            if saving {
                let dataBox = UncheckedSendableBox(data)
                FsDomain().handle("write", action: ["type": "desktop_fs_write", "path": destination.path, "content": encoded.base64EncodedString(), "encoding": "base64"]) { written in
                    guard written["success"] as? Bool == true else {
                        completion(fail("provider_failed", written["error"] as? String ?? "thumbnail save failed")); return
                    }
                    var saved = dataBox.value
                    saved["filePath"] = destination.path
                    completion(DesktopThumbnailValidation.bounded(WireFormat.success(saved), saving: true))
                }
            } else {
                data["dataUrl"] = "data:image/\(formatName);base64,\(encoded.base64EncodedString())"
                completion(DesktopThumbnailValidation.bounded(WireFormat.success(data), saving: false))
            }
        }
    }

    private func batchNeutral(_ action: [String: Any], index: Int, results: [[String: Any]], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let paths = action["paths"] as! [String]
        guard index < paths.count else { completion(WireFormat.success(["results": results])); return }
        var single = action
        single.removeValue(forKey: "paths")
        single["path"] = paths[index]
        single["sub"] = "generate"
        let input = UncheckedSendableBox((action: action, results: results))
        generateNeutral(single) { result in
            let rows = input.value.results + [["path": paths[index], "ok": result["success"] as? Bool ?? false, "result": result]]
            let bounded = DesktopThumbnailValidation.bounded(WireFormat.success(["results": rows]), saving: input.value.action["save"] as? Bool == true)
            guard bounded["success"] as? Bool == true else { completion(bounded); return }
            self.batchNeutral(input.value.action, index: index + 1, results: rows, completion: completion)
        }
    }
}
