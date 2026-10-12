// PDFKit. macOS 10.4+; full read/write/annotation surface.
// References: apple-developer-docs/PDFKit/{PDFDocument,PDFPage,PDFAnnotation,
// PDFOutline,PDFSelection,PDFDocumentAttribute,PDFAccessPermissions}.md.
// Dispatch invariant: read action["sub"], not command.

import Foundation
import AppKit
import PDFKit
import CoreGraphics

final class PdfDomain: DomainHandler, @unchecked Sendable {
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "info":         info(action, completion: completion)
        case "text":         text(action, completion: completion)
        case "outline":      outline(action, completion: completion)
        case "annotations":  annotations(action, completion: completion)
        case "forms":        forms(action, completion: completion)
        case "forms_set":    formsSet(action, completion: completion)
        case "images":       images(action, completion: completion)
        case "find":         find(action, completion: completion)
        case "attributes":   attributes(action, completion: completion)
        case "permissions":  permissions(action, completion: completion)
        case "annotate":     annotate(action, completion: completion)
        case "strip":        strip(action, completion: completion)
        case "merge":        merge(action, completion: completion)
        case "split":        split(action, completion: completion)
        default:             completion(WireFormat.error("pdf.\(sub) — unknown verb"))
        }
    }

    // MARK: - Helpers

    // A missing file is target_gone and any other unreadable file unsupported_target, as on Windows and Linux.
    private func openFailure(_ message: String, _ path: String) -> [String: Any] {
        WireFormat.failure(FileManager.default.fileExists(atPath: (path as NSString).expandingTildeInPath) ? "unsupported_target" : "target_gone", message)
    }

    private func loadDocument(_ path: String) -> PDFDocument? {
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        return PDFDocument(url: url)
    }

    private func iso8601(_ date: Date?) -> String? {
        guard let date else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }

    private func rect(_ r: CGRect) -> [String: Any] {
        ["x": r.origin.x, "y": r.origin.y, "w": r.width, "h": r.height]
    }

    private func parseRange(_ s: String, max maxPage: Int) -> (Int, Int) {
        let parts = s.split(separator: "-", maxSplits: 1).map { Int($0) ?? 0 }
        let lo = Swift.max(parts.first ?? 1, 1)
        let hi = parts.count > 1 ? Swift.min(parts[1], maxPage) : Swift.min(lo, maxPage)
        return (lo - 1, hi - 1)
    }

    private func annotationDict(_ a: PDFAnnotation, page: Int) -> [String: Any] {
        var d: [String: Any] = [
            "page": page,
            "type": a.type ?? "Unknown",
            "bounds": rect(a.bounds),
            "contents": a.contents as Any? ?? NSNull(),
            "userName": a.userName as Any? ?? NSNull(),
            "modificationDate": iso8601(a.modificationDate) as Any? ?? NSNull(),
        ]
        if let url = a.url { d["url"] = url.absoluteString }
        if let dest = a.destination, let p = dest.page, let parent = p.document {
            d["destination"] = ["pageIndex": parent.index(for: p), "x": dest.point.x, "y": dest.point.y]
        }
        // Markup-specific fields: PDFKit reports markupType 0 (highlight) on every annotation
        if ["Highlight", "StrikeOut", "Underline", "Redact"].contains(a.type ?? "") { d["markupType"] = NativeNames.name(a.markupType.rawValue, NativeNames.markup) }
        d["color"] = colorString(a.color)
        if let bg = a.backgroundColor { d["backgroundColor"] = colorString(bg) }
        // Widget-specific fields
        let widget = a.type == "Widget"
        if widget { d["widgetFieldType"] = [PDFAnnotationWidgetSubtype.button: "button", .choice: "choice", .signature: "signature", .text: "text"][a.widgetFieldType] ?? a.widgetFieldType.rawValue }
        if !(a.widgetStringValue?.isEmpty ?? true) { d["widgetStringValue"] = a.widgetStringValue }
        if let fn = a.fieldName { d["fieldName"] = fn }
        d["isReadOnly"] = a.isReadOnly
        d["isMultiline"] = a.isMultiline
        d["isPasswordField"] = a.isPasswordField
        d["maximumLength"] = a.maximumLength
        d["hasComb"] = a.hasComb
        if let choices = a.choices, !choices.isEmpty { d["choices"] = choices }
        if let values = a.values, !values.isEmpty { d["values"] = values }
        d["isListChoice"] = widget && a.widgetFieldType == .choice && a.isListChoice
        return d
    }

    private func colorString(_ color: NSColor) -> String {
        let c = color.usingColorSpace(.deviceRGB) ?? color
        let r = Int(c.redComponent * 255)
        let g = Int(c.greenComponent * 255)
        let b = Int(c.blueComponent * 255)
        return String(format: "#%02x%02x%02x", r, g, b)
    }

    // MARK: - Verbs

    private func info(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String else { completion(WireFormat.error("pdf.info: missing path")); return }
        guard let doc = loadDocument(path) else { completion(openFailure("pdf.info: cannot open document at \(path)", path)); return }
        var perms: [String] = []
        // PDFAccessPermissions is exposed as an OptionSet-shaped struct on
        // some SDKs and an enum on others. Use the enum-style equality check
        // and walk the documented case set.
        let p = doc.accessPermissions
        let allCases: [(PDFAccessPermissions, String)] = [
            (.allowsCommenting, "allowsCommenting"),
            (.allowsContentAccessibility, "allowsContentAccessibility"),
            (.allowsContentCopying, "allowsContentCopying"),
            (.allowsDocumentAssembly, "allowsDocumentAssembly"),
            (.allowsDocumentChanges, "allowsDocumentChanges"),
            (.allowsFormFieldEntry, "allowsFormFieldEntry"),
            (.allowsHighQualityPrinting, "allowsHighQualityPrinting"),
            (.allowsLowQualityPrinting, "allowsLowQualityPrinting"),
        ]
        for (val, name) in allCases where val == p { perms.append(name) }

        var attrs: [String: Any] = [:]
        if let raw = doc.documentAttributes {
            for (k, v) in raw { attrs[String(describing: k)] = describe(v) }
        }
        let resp: [String: Any] = [
            "path": path,
            "pageCount": doc.pageCount,
            "isLocked": doc.isLocked,
            "isEncrypted": doc.isEncrypted,
            "allowsCopying": doc.allowsCopying,
            "allowsPrinting": doc.allowsPrinting,
            "accessPermissions": perms,
            "attributes": attrs,
        ]
        completion(WireFormat.success(resp))
    }

    private func describe(_ v: Any) -> Any {
        if let d = v as? Date, let s = iso8601(d) { return s }
        if v is NSNull { return NSNull() }
        return v
    }

    private func text(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String else { completion(WireFormat.error("pdf.text: missing path")); return }
        guard let doc = loadDocument(path) else { completion(openFailure("pdf.text: cannot open document at \(path)", path)); return }
        let attributed = (action["attributed"] as? Bool) ?? false

        var pageIndices: [Int] = []
        if let p = action["page"] as? Int {
            pageIndices = [p - 1]
        } else if let r = action["range"] as? String {
            let (lo, hi) = parseRange(r, max: doc.pageCount)
            pageIndices = Array(lo...hi)
        } else {
            pageIndices = Array(0..<doc.pageCount)
        }

        var pages: [[String: Any]] = []
        var concatenated = ""
        var totalChars = 0
        for idx in pageIndices {
            guard idx >= 0, idx < doc.pageCount, let page = doc.page(at: idx) else { continue }
            let s = page.string ?? ""
            totalChars += s.count
            concatenated += (concatenated.isEmpty && pages.isEmpty ? "" : "\n") + s
            var entry: [String: Any] = [
                "page": idx + 1,
                "characterCount": page.numberOfCharacters,
                "text": s,
            ]
            if attributed, let attr = page.attributedString {
                entry["attributedString"] = attributedRuns(attr)
            }
            pages.append(entry)
        }

        if pages.count == 1, let first = pages.first {
            var out: [String: Any] = ["path": path]
            for (k, v) in first { out[k] = v }
            completion(WireFormat.success(out))
        } else {
            completion(WireFormat.success([
                "path": path,
                "pageCount": doc.pageCount,
                "characterCount": totalChars,
                "text": concatenated,
                "pages": pages,
            ]))
        }
    }

    private func attributedRuns(_ s: NSAttributedString) -> [[String: Any]] {
        var runs: [[String: Any]] = []
        s.enumerateAttributes(in: NSRange(location: 0, length: s.length)) { attrs, range, _ in
            var dict: [String: Any] = ["range": [range.location, range.length]]
            if let font = attrs[.font] as? NSFont {
                dict["font"] = ["name": font.fontName, "size": font.pointSize]
            }
            if let color = attrs[.foregroundColor] as? NSColor {
                dict["color"] = colorString(color)
            }
            runs.append(dict)
        }
        return runs
    }

    private func outline(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String else { completion(WireFormat.error("pdf.outline: missing path")); return }
        guard let doc = loadDocument(path) else { completion(openFailure("pdf.outline: cannot open document", path)); return }
        guard let root = doc.outlineRoot else { completion(WireFormat.success(["path": path, "outline": [Any]()])); return }
        let tree = walkOutline(root, doc: doc)
        completion(WireFormat.success(["path": path, "outline": tree]))
    }

    private func walkOutline(_ node: PDFOutline, doc: PDFDocument) -> [[String: Any]] {
        var children: [[String: Any]] = []
        for i in 0..<node.numberOfChildren {
            guard let child = node.child(at: i) else { continue }
            var entry: [String: Any] = [
                "label": child.label ?? "",
                "isOpen": child.isOpen,
            ]
            if let d = child.destination, let page = d.page {
                entry["destination"] = ["pageIndex": doc.index(for: page), "x": d.point.x, "y": d.point.y]
            }
            if child.numberOfChildren > 0 { entry["children"] = walkOutline(child, doc: doc) }
            children.append(entry)
        }
        return children
    }

    private func annotations(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String else { completion(WireFormat.error("pdf.annotations: missing path")); return }
        guard let doc = loadDocument(path) else { completion(openFailure("pdf.annotations: cannot open document", path)); return }
        let onlyPage = action["page"] as? Int
        let typeFilter = action["annotation_type"] as? String
        var out: [[String: Any]] = []
        for i in 0..<doc.pageCount {
            if let onlyPage = onlyPage, i != onlyPage - 1 { continue }
            guard let page = doc.page(at: i) else { continue }
            for a in page.annotations {
                if let typeFilter = typeFilter, a.type != typeFilter { continue }
                out.append(annotationDict(a, page: i + 1))
            }
        }
        completion(WireFormat.success(["path": path, "annotations": out]))
    }

    private func forms(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String else { completion(WireFormat.error("pdf.forms: missing path")); return }
        guard let doc = loadDocument(path) else { completion(openFailure("pdf.forms: cannot open document", path)); return }
        var out: [[String: Any]] = []
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            for a in page.annotations where a.type == "Widget" {
                out.append(annotationDict(a, page: i + 1))
            }
        }
        completion(WireFormat.success(["path": path, "forms": out]))
    }

    private func formsSet(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String,
              let field = action["field"] as? String,
              let value = action["value"] as? String
        else { completion(WireFormat.error("pdf.forms_set: requires path, field, value")); return }
        guard let doc = loadDocument(path) else { completion(openFailure("pdf.forms_set: cannot open document", path)); return }
        var matched = false
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            for a in page.annotations where a.type == "Widget" {
                if a.fieldName == field {
                    a.widgetStringValue = value
                    matched = true
                }
            }
        }
        if !matched { completion(WireFormat.error("pdf.forms_set: no widget with fieldName=\(field)")); return }
        let outPath = (action["out"] as? String) ?? path
        let outURL = URL(fileURLWithPath: (outPath as NSString).expandingTildeInPath)
        guard doc.write(to: outURL) else {
            completion(WireFormat.error("pdf.forms_set: write to \(outPath) failed")); return
        }
        completion(WireFormat.success([
            "savedTo": outPath, "fieldName": field, "newValue": value, "ok": true,
        ]))
    }

    private func images(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String else { completion(WireFormat.error("pdf.images: missing path")); return }
        guard let doc = loadDocument(path) else { completion(openFailure("pdf.images: cannot open document", path)); return }
        var imageInventory: [[String: Any]] = []
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            let bounds = page.bounds(for: .mediaBox)
            imageInventory.append([
                "page": i + 1,
                "mediaBox": rect(bounds),
                "rotation": page.rotation,
                // Per-image extraction requires CGPDFOperatorTable parsing which
                // is non-trivial; surface page-level page geometry + annotation
                // pixel-image stamps as the image inventory.
                "stamps": page.annotations.filter { $0.type == "Stamp" }.map { annotationDict($0, page: i + 1) },
            ])
        }
        completion(WireFormat.success(["path": path, "pages": imageInventory]))
    }

    private func find(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String,
              let query = action["query"] as? String
        else { completion(WireFormat.error("pdf.find: requires path and query")); return }
        guard let doc = loadDocument(path) else { completion(openFailure("pdf.find: cannot open document", path)); return }
        let opts: NSString.CompareOptions = (action["case_sensitive"] as? Bool) == true ? [] : .caseInsensitive
        let selections = doc.findString(query, withOptions: opts)
        var results: [[String: Any]] = []
        for sel in selections {
            for page in sel.pages {
                let pageIdx = doc.index(for: page)
                results.append([
                    "page": pageIdx + 1,
                    "text": sel.string ?? "",
                    "bounds": rect(sel.bounds(for: page)),
                ])
            }
        }
        completion(WireFormat.success(["path": path, "query": query, "matchCount": results.count, "matches": results]))
    }

    private func attributes(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String else { completion(WireFormat.error("pdf.attributes: missing path")); return }
        guard let doc = loadDocument(path) else { completion(openFailure("pdf.attributes: cannot open document", path)); return }
        var out: [String: Any] = [:]
        if let raw = doc.documentAttributes {
            for (k, v) in raw { out[String(describing: k)] = describe(v) }
        }
        completion(WireFormat.success(["path": path, "attributes": out]))
    }

    private func permissions(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String else { completion(WireFormat.error("pdf.permissions: missing path")); return }
        guard let doc = loadDocument(path) else { completion(openFailure("pdf.permissions: cannot open document", path)); return }
        var perms: [String] = []
        // PDFAccessPermissions is exposed as an OptionSet-shaped struct on
        // some SDKs and an enum on others. Use the enum-style equality check
        // and walk the documented case set.
        let p = doc.accessPermissions
        let allCases: [(PDFAccessPermissions, String)] = [
            (.allowsCommenting, "allowsCommenting"),
            (.allowsContentAccessibility, "allowsContentAccessibility"),
            (.allowsContentCopying, "allowsContentCopying"),
            (.allowsDocumentAssembly, "allowsDocumentAssembly"),
            (.allowsDocumentChanges, "allowsDocumentChanges"),
            (.allowsFormFieldEntry, "allowsFormFieldEntry"),
            (.allowsHighQualityPrinting, "allowsHighQualityPrinting"),
            (.allowsLowQualityPrinting, "allowsLowQualityPrinting"),
        ]
        for (val, name) in allCases where val == p { perms.append(name) }
        completion(WireFormat.success([
            "path": path,
            "permissions": perms,
            "isLocked": doc.isLocked,
            "isEncrypted": doc.isEncrypted,
            "allowsCopying": doc.allowsCopying,
            "allowsPrinting": doc.allowsPrinting,
        ]))
    }

    private func annotate(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String,
              let pageNum = action["page"] as? Int,
              let rectStr = action["rect"] as? String
        else { completion(WireFormat.error("pdf.annotate: requires path, --page, --rect")); return }
        let parts = rectStr.split(separator: ",").compactMap { Double($0) }
        guard parts.count == 4 else { completion(WireFormat.error("pdf.annotate: --rect must be x,y,w,h")); return }
        guard let doc = loadDocument(path) else { completion(openFailure("pdf.annotate: cannot open document", path)); return }
        guard pageNum >= 1, pageNum <= doc.pageCount, let page = doc.page(at: pageNum - 1)
        else { completion(WireFormat.error("pdf.annotate: invalid page \(pageNum)")); return }
        let typeStr = (action["annotation_type"] as? String) ?? "Highlight"
        let bounds = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
        let subtype = NSString(string: typeStr)
        let ann = PDFAnnotation(bounds: bounds, forType: PDFAnnotationSubtype(rawValue: subtype as String), withProperties: nil)
        ann.contents = action["contents"] as? String
        page.addAnnotation(ann)
        let outPath = (action["out"] as? String) ?? path
        let outURL = URL(fileURLWithPath: (outPath as NSString).expandingTildeInPath)
        guard doc.write(to: outURL) else { completion(WireFormat.error("pdf.annotate: write failed")); return }
        completion(WireFormat.success([
            "savedTo": outPath, "page": pageNum, "annotation": annotationDict(ann, page: pageNum),
        ]))
    }

    private func strip(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String,
              let outPath = action["out"] as? String
        else { completion(WireFormat.error("pdf.strip: requires path and --out")); return }
        guard let doc = loadDocument(path) else { completion(openFailure("pdf.strip: cannot open", path)); return }
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            for a in page.annotations { page.removeAnnotation(a) }
        }
        let outURL = URL(fileURLWithPath: (outPath as NSString).expandingTildeInPath)
        guard doc.write(to: outURL) else { completion(WireFormat.error("pdf.strip: write failed")); return }
        completion(WireFormat.success(["savedTo": outPath, "pageCount": doc.pageCount]))
    }

    private func merge(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let paths = action["paths"] as? [String], let outPath = action["out"] as? String, !paths.isEmpty
        else { completion(WireFormat.error("pdf.merge: requires <paths> and --out")); return }
        let merged = PDFDocument()
        var pageCount = 0
        for p in paths {
            guard let d = loadDocument(p) else { completion(openFailure("pdf.merge: cannot open \(p)", p)); return }
            for i in 0..<d.pageCount {
                if let page = d.page(at: i) {
                    merged.insert(page, at: pageCount)
                    pageCount += 1
                }
            }
        }
        let outURL = URL(fileURLWithPath: (outPath as NSString).expandingTildeInPath)
        guard merged.write(to: outURL) else { completion(WireFormat.error("pdf.merge: write failed")); return }
        completion(WireFormat.success(["savedTo": outPath, "pageCount": pageCount, "sources": paths]))
    }

    private func split(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String,
              let pages = action["pages"] as? String,
              let outPath = action["out"] as? String
        else { completion(WireFormat.error("pdf.split: requires path, --pages, --out")); return }
        guard let doc = loadDocument(path) else { completion(openFailure("pdf.split: cannot open", path)); return }
        let (lo, hi) = parseRange(pages, max: doc.pageCount)
        let out = PDFDocument()
        var idx = 0
        for i in lo...hi {
            guard let page = doc.page(at: i) else { continue }
            // PDFPage instances are owned by their document; copy to detach safely.
            if let copy = page.copy() as? PDFPage {
                out.insert(copy, at: idx)
                idx += 1
            }
        }
        let outURL = URL(fileURLWithPath: (outPath as NSString).expandingTildeInPath)
        guard out.write(to: outURL) else { completion(WireFormat.error("pdf.split: write failed")); return }
        completion(WireFormat.success(["savedTo": outPath, "pageCount": idx, "source": path, "range": [lo + 1, hi + 1]]))
    }
}
