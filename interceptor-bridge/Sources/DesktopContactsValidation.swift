import Foundation

enum DesktopContactsValidation {
    static let outputKeys = Set(["id", "contactType", "namePrefix", "givenName", "middleName", "familyName", "nameSuffix", "nickname", "phonetic", "organization", "emailAddresses", "phoneNumbers", "urlAddresses", "socialProfiles", "instantMessageAddresses", "contactRelations", "imageDataAvailable", "postalAddresses", "dates", "birthday", "thumbnailDataUrl", "imageDataUrl", "note", "requires_entitlement"])
    static let mutable = ["given", "family", "organization", "email", "phone", "postal", "birthday", "note"]
    static func actionError(_ a: [String: Any]) -> String? {
        if let error = DesktopContactsShape.validationError(a) { return error }
        let fields: [String: [String]] = ["status": [], "request": [], "containers": [], "default-container": [], "groups": ["container"], "group": ["id"], "group-create": ["name", "container"], "group-update": ["id", "name"], "group-delete": ["id"], "group-add-member": ["id", "contact"], "group-remove-member": ["id", "contact"], "list": ["limit", "offset", "keys", "container", "group"], "contact": ["id"], "me": [], "find": ["query", "name", "email", "phone"], "create": mutable + ["container"], "update": ["id"] + mutable, "delete": ["id"], "vcard": ["id"], "import-vcard": ["path", "container"], "current-token": [], "changes": ["since", "limit"]]
        let sub = a["sub"] as! String
        if a.keys.contains(where: { !(["type", "sub", "groupColor", "groupSoft"] + fields[sub]!).contains($0) }) { return "contacts field does not belong to selector" }
        for (key, value) in a {
            if let text = value as? String, text.utf8.count > (key == "note" ? 65536 : key == "since" ? 16384 : 4096) || text.contains("\0") || (!["given", "family", "organization", "note"].contains(key) && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) { return "invalid bounded contacts text" }
        }
        for key in ["limit", "offset"] {
            if let n = a[key] as? NSNumber, !n.doubleValue.isFinite || n.doubleValue.rounded(.towardZero) != n.doubleValue || n.doubleValue < (key == "limit" ? 1 : 0) || n.doubleValue > (key == "limit" ? 1000 : 10000) { return "invalid integer contacts paging" }
        }
        if ["group", "group-update", "group-delete", "group-add-member", "group-remove-member", "contact", "update", "delete", "vcard"].contains(sub), a["id"] == nil { return "contacts requires exact id" }
        if ["group-create", "group-update"].contains(sub), a["name"] == nil { return "contacts group requires name" }
        if ["group-add-member", "group-remove-member"].contains(sub), a["contact"] == nil { return "contacts membership requires contact" }
        if ["create", "update"].contains(sub), !mutable.contains(where: { a[$0] != nil }) { return "contacts mutation requires fields" }
        if sub == "find", ["query", "name", "email", "phone"].filter({ a[$0] != nil }).count != 1 { return "contacts find requires one exact query mode" }
        if sub == "list", a["container"] != nil && a["group"] != nil { return "contacts requires one container or group scope" }
        if let raw = a["keys"] as? String {
            let keys = raw.components(separatedBy: ",")
            if keys.count > outputKeys.count || Set(keys).count != keys.count || !Set(keys).isSubset(of: outputKeys) { return "unknown or duplicate contact output key" }
        }
        if ["create", "update"].contains(sub) {
            for key in ["email", "phone"] {
                if let raw = a[key] as? String {
                    let rows = raw.components(separatedBy: ",")
                    if rows.count > 32 || rows.contains(where: { row in let parts = row.components(separatedBy: ":"); return parts.count < 2 || parts[0].isEmpty || parts[0].utf8.count > 128 || parts.dropFirst().joined(separator: ":").isEmpty }) { return "contacts label:value pairs required" }
                }
            }
            if let raw = a["postal"] as? String {
                let parts = raw.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
                if parts.count != 2 || parts[0].isEmpty || parts[0].utf8.count > 128 || parts[1].split(separator: ";", omittingEmptySubsequences: false).count != 5 { return "contacts postal requires label:street;city;state;postalCode;country" }
            }
            if let raw = a["birthday"] as? String {
                let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
                guard raw.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil, !raw.hasPrefix("0000"), let date = formatter.date(from: raw), formatter.string(from: date) == raw else { return "invalid actual calendar birthday within years 1..9999" }
            }
        }
        if let token = a["since"] as? String, Data(base64Encoded: token)?.base64EncodedString() != token { return "contacts requires canonical base64 history token" }
        if sub == "import-vcard", !(a["path"] as? String ?? "").hasPrefix("/") { return "contacts import requires absolute path" }
        guard let bytes = try? JSONSerialization.data(withJSONObject: a), bytes.count <= 262144 else { return "contacts request exceeds 256KiB" }
        return nil
    }
    static func resultError(_ response: [String: Any], sub: String, action: [String: Any]) -> String? {
        guard response["success"] as? Bool == true else { return nil }
        guard let data = response["data"] as? [String: Any], let bytes = try? JSONSerialization.data(withJSONObject: data), bytes.count <= 1048576 else { return "contacts native reply exceeds 1MiB" }
        let decoder = JSONDecoder()
        do {
            switch sub {
            case "status": _ = try decoder.decode(DesktopContactsStatus.self, from: bytes)
            case "request": _ = try decoder.decode(DesktopContactsRequested.self, from: bytes)
            case "containers": _ = try decoder.decode(DesktopContactsContainers.self, from: bytes)
            case "default-container": _ = try decoder.decode(DesktopContactsIdentity.self, from: bytes)
            case "groups": _ = try decoder.decode(DesktopContactsGroups.self, from: bytes)
            case "group", "group-create", "group-update": _ = try decoder.decode(DesktopContactsGroup.self, from: bytes)
            case "list": let row = try decoder.decode(DesktopContactsList.self, from: bytes); guard row.limit == Double(action["limit"] as? Int ?? 100), row.offset == Double(action["offset"] as? Int ?? 0), row.limit >= 1, row.limit <= 1000, row.offset >= 0, row.offset <= 10000, Double(row.contacts.count) <= row.limit else { return "invalid contacts paging receipt" }
            case "find": _ = try decoder.decode(DesktopContactsFound.self, from: bytes)
            case "group-delete", "delete": guard try decoder.decode(DesktopContactsDeleted.self, from: bytes).ok else { return "contacts deletion has no native effect receipt" }
            case "group-add-member", "group-remove-member": guard try decoder.decode(DesktopContactsMember.self, from: bytes).ok else { return "contacts membership has no native effect receipt" }
            case "vcard": let row = try decoder.decode(DesktopContactsVCard.self, from: bytes); guard row.bytes == Double(row.vcard.utf8.count), row.bytes <= 262144 else { return "invalid actual vCard byte count" }
            case "import-vcard": let row = try decoder.decode(DesktopContactsImported.self, from: bytes); guard row.imported >= 1, row.imported <= 100, row.imported == Double(row.ids.count), Set(row.ids).count == row.ids.count else { return "invalid native import identities" }
            case "current-token": _ = try decoder.decode(DesktopContactsToken.self, from: bytes)
            case "changes": let row = try decoder.decode(DesktopContactsChanges.self, from: bytes); guard row.events.count <= (action["limit"] as? Int ?? 1000) else { return "contacts history exceeds requested limit" }
            default: _ = try decoder.decode(DesktopContactsRow.self, from: bytes)
            }
        } catch { return "contacts native reply violates contract" }
        func bounded(_ value: Any, depth: Int = 0) -> Bool {
            if depth > 8 { return false }
            if let text = value as? String { return text.utf8.count <= 262144 && !text.contains("\0") }
            if let values = value as? [Any] { return values.count <= 1000 && values.allSatisfy { bounded($0, depth: depth + 1) } }
            if let fields = value as? [String: Any] { return fields.values.allSatisfy { bounded($0, depth: depth + 1) } }
            return value is NSNumber || value is NSNull
        }
        if !bounded(data) { return "invalid bounded contacts native result" }
        for key in ["containers", "groups", "contacts", "matches"] {
            if let rows = data[key] as? [[String: Any]] {
                let ids = rows.compactMap { $0["id"] as? String }
                if ids.count != rows.count || Set(ids).count != ids.count || ids.contains(where: { $0.isEmpty || $0.utf8.count > 4096 }) { return "invalid or duplicate native contact identities" }
            }
        }
        func identity(_ value: Any?) -> Bool { guard let id = value as? String else { return false }; return !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && id.utf8.count <= 4096 && !id.contains("\0") }
        if data["id"] != nil, !identity(data["id"]) { return "missing native contact identity" }
        if ["group-delete", "delete"].contains(sub), let id = action["id"] as? String, data["id"] as? String != id { return "Contacts deletion differs from requested identity" }
        if ["group-add-member", "group-remove-member"].contains(sub), !identity(data["group"]) || !identity(data["contact"]) || data["group"] as? String != action["id"] as? String || data["contact"] as? String != action["contact"] as? String || data["added"] as? Bool != (sub == "group-add-member") { return "Contacts membership differs from requested identities or effect" }
        if let ids = data["ids"] as? [String], ids.contains(where: { !identity($0) }) { return "invalid imported native Contacts identities" }
        for key in ["token", "currentToken"] {
            if let token = data[key] as? String, token.isEmpty || token.utf8.count > 16384 || Data(base64Encoded: token)?.base64EncodedString() != token { return "invalid canonical native Contacts history token" }
        }
        if let events = data["events"] as? [[String: Any]] {
            let fields = ["addContact": ["contactId"], "updateContact": ["contactId"], "deleteContact": ["contactId"], "addGroup": ["groupId"], "updateGroup": ["groupId"], "deleteGroup": ["groupId"], "addMemberToGroup": ["groupId", "contactId"], "removeMemberFromGroup": ["groupId", "contactId"], "addSubgroup": ["parent", "child"], "removeSubgroup": ["parent", "child"], "dropEverything": []]
            for event in events {
                guard let type = event["type"] as? String, let required = fields[type], required.allSatisfy({ identity(event[$0]) }), event.keys.allSatisfy({ $0 == "type" || required.contains($0) }) else { return "Contacts history has an unknown event or incomplete native identities" }
            }
        }
        return nil
    }
}
