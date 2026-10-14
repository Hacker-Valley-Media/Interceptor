// Contacts. macOS 10.11+; CNChangeHistoryFetchRequest macOS 10.15+.
// References: apple-developer-docs/Contacts/{CNContactStore,CNContact,CNContactFetchRequest,
// CNSaveRequest,CNGroup,CNAuthorizationStatus,CNChangeHistoryFetchRequest,...}.md.

import Foundation
import Contacts
import ImageIO
import UniformTypeIdentifiers
import ShareNative
import Darwin

final class ContactsDomain: DomainHandler, @unchecked Sendable {
    private let requestLock = NSLock()
    private var currentStore = CNContactStore()
    private var store: CNContactStore { requestLock.lock(); defer { requestLock.unlock() }; return currentStore }
    private var requestQueue = DispatchQueue(label: "interceptor.contacts.native")
    private var active: (id: UUID, sub: String, since: Date, timedOut: Bool)?
    // A native call macOS never returns (a group save sat in the kernel's access() on
    // AddressBook's metadata lock file for 90 minutes) is given up at the 55 s deadline: later calls
    // get a fresh queue and store. At most one call is given up at a time, so a second stuck call
    // keeps the family refusing (with what is stuck and how to recover) instead of piling up threads.
    private var abandoned: (id: UUID, sub: String, since: Date)?
    // Tests shorten the deadline and stand in for the native call.
    var deadline: TimeInterval = 55
    var nativeForTesting: ((@escaping @Sendable ([String: Any]) -> Void) -> Void)?

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var input = action; input["type"] = "desktop_contacts"; input["sub"] = action["sub"] as? String ?? command
        if let error = DesktopContactsValidation.actionError(input) { completion(WireFormat.failure("invalid_request", error)); return }
        if input["note"] != nil { completion(WireFormat.failure("permission_denied", "Contacts notes require the Apple notes entitlement; no mutation was performed")); return }
        if input["sub"] as? String == "status" { status(completion: completion); return }
        if input["sub"] as? String != "request" {
            let authorization = CNContactStore.authorizationStatus(for: .contacts)
            guard authorization == .authorized else {
                completion(WireFormat.failure("permission_denied", "Contacts access is \(authStatusString(authorization)); only the explicit request selector may request consent")); return
            }
        }
        let id = UUID(), once = AtomicFlag(), box = UncheckedSendableBox(input), sub = input["sub"] as? String ?? command
        requestLock.lock(); let busy = active; if busy == nil { active = (id, sub, Date(), false) }; let queue = requestQueue; requestLock.unlock()
        if let busy {
            let message = busy.timedOut
                ? "a Contacts \(busy.sub) call started at \(DesktopEventKitValidation.iso(busy.since)) is still blocked inside macOS Contacts, and an earlier stuck call has not returned either; no work queued. If it does not recover, restart the bridge: launchctl kickstart -k gui/\(getuid())/com.interceptor.bridge"
                : "another Contacts request (\(busy.sub)) is still running; no work queued"
            completion(WireFormat.failure("resource_limit", message)); return
        }
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        let timerBox = UncheckedSendableBox(timer)
        let finish: @Sendable ([String: Any]) -> Void = { result in
            timerBox.value.cancel()
            let error = DesktopContactsValidation.resultError(result, sub: box.value["sub"] as! String, action: box.value)
            self.requestLock.lock(); if self.active?.id == id { self.active = nil }; if self.abandoned?.id == id { self.abandoned = nil }; self.requestLock.unlock()
            if once.set() { completion(error.map { WireFormat.failure("partial_result", $0) } ?? result) }
        }
        timer.schedule(deadline: .now() + deadline)
        timer.setEventHandler {
            self.requestLock.lock()
            var gaveUp = false
            if let current = self.active, current.id == id {
                if self.abandoned == nil {
                    self.abandoned = (id, current.sub, current.since); self.active = nil; gaveUp = true
                    self.requestQueue = DispatchQueue(label: "interceptor.contacts.native"); self.currentStore = CNContactStore()
                } else { self.active?.timedOut = true }
            }
            self.requestLock.unlock()
            if once.set() { completion(WireFormat.failure("timeout_unknown_outcome", gaveUp
                ? "Contacts native completion exceeded 55 seconds; macOS has not returned the call, so it was given up and later Contacts calls use a fresh store. Its outcome is unknown and nothing was replayed"
                : "Contacts native completion exceeded 55 seconds while an earlier call is still stuck; Contacts calls are refused until one returns. Its outcome is unknown and nothing was replayed")) }
        }
        timer.resume()
        queue.async {
            self.requestLock.lock(); let revoked = self.active?.id != id || self.active?.timedOut == true; self.requestLock.unlock()
            if revoked { finish(WireFormat.failure("cancelled", "Contacts request retired before native dispatch")); return }
            if let native = self.nativeForTesting { native(finish); return }
            if let error = InterceptorContactOperation({ self.dispatch(command, action: box.value, completion: finish) }) {
                let native = error as NSError
                finish(WireFormat.failure("provider_failed", native.localizedDescription, details: ["nativeDomain": native.domain, "nativeCode": native.code, "nativeException": native.userInfo["exceptionName"] as? String ?? "unknown"]))
            }
        }
    }

    private func dispatch(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "status":               status(completion: completion)
        case "request":              requestAccess(completion: completion)
        case "containers":           containers(completion: completion)
        case "default-container":    defaultContainer(completion: completion)
        case "groups":               groups(action, completion: completion)
        case "group":                groupGet(action, completion: completion)
        case "group-create":         groupCreate(action, completion: completion)
        case "group-update":         groupUpdate(action, completion: completion)
        case "group-delete":         groupDelete(action, completion: completion)
        case "group-add-member":     groupMember(action, completion: completion, add: true)
        case "group-remove-member":  groupMember(action, completion: completion, add: false)
        case "list":                 listContacts(action, completion: completion)
        case "contact":              getContact(action, completion: completion)
        case "me":                   meContact(completion: completion)
        case "find":                 findContacts(action, completion: completion)
        case "create":               createContact(action, completion: completion)
        case "update":               updateContact(action, completion: completion)
        case "delete":               deleteContact(action, completion: completion)
        case "vcard":                vcard(action, completion: completion)
        case "import-vcard":         importVcard(action, completion: completion)
        case "current-token":        currentToken(completion: completion)
        case "changes":              changes(action, completion: completion)
        default:                     completion(WireFormat.error("contacts.\(sub) — unknown verb"))
        }
    }

    // MARK: - Helpers

    private func authStatusString(_ s: CNAuthorizationStatus) -> String {
        switch s {
        case .notDetermined: return "notDetermined"
        case .restricted:    return "restricted"
        case .denied:        return "denied"
        case .authorized:    return "authorized"
        @unknown default:    return "unknown"
        }
    }

    private func defaultKeys() -> [CNKeyDescriptor] {
        let keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactMiddleNameKey as CNKeyDescriptor,
            CNContactNamePrefixKey as CNKeyDescriptor,
            CNContactNameSuffixKey as CNKeyDescriptor,
            CNContactNicknameKey as CNKeyDescriptor,
            // contactDict reads the four phonetic-name properties. They must
            // be in keysToFetch — otherwise CNContact throws
            // CNPropertyNotFetchedException on first access and crashes the
            // bridge mid-serialization.
            CNContactPhoneticGivenNameKey as CNKeyDescriptor,
            CNContactPhoneticMiddleNameKey as CNKeyDescriptor,
            CNContactPhoneticFamilyNameKey as CNKeyDescriptor,
            CNContactPhoneticOrganizationNameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactDepartmentNameKey as CNKeyDescriptor,
            CNContactJobTitleKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactPostalAddressesKey as CNKeyDescriptor,
            CNContactUrlAddressesKey as CNKeyDescriptor,
            CNContactSocialProfilesKey as CNKeyDescriptor,
            CNContactInstantMessageAddressesKey as CNKeyDescriptor,
            CNContactBirthdayKey as CNKeyDescriptor,
            CNContactNonGregorianBirthdayKey as CNKeyDescriptor,
            CNContactDatesKey as CNKeyDescriptor,
            CNContactImageDataAvailableKey as CNKeyDescriptor,
            CNContactThumbnailImageDataKey as CNKeyDescriptor,
            CNContactRelationsKey as CNKeyDescriptor,
            CNContactTypeKey as CNKeyDescriptor,
        ]
        return keys
    }

    static func imageDataURL(_ data: Data) throws -> String {
        guard !data.isEmpty, data.count <= 196608,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let identifier = CGImageSourceGetType(source),
              let type = UTType(identifier as String), type.conforms(to: .image),
              let mime = type.preferredMIMEType,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 16384, height <= 16384,
              width <= DESKTOP_THUMBNAIL_MAX_PIXELS / height else {
            throw NSError(domain: "InterceptorContactsImage", code: 1, userInfo: [NSLocalizedDescriptionKey: "native Contact image is invalid or exceeds encoded/pixel bounds; select fields without image data"])
        }
        let value = "data:\(mime);base64,\(data.base64EncodedString())"
        guard value.utf8.count <= 262144 else {
            throw NSError(domain: "InterceptorContactsImage", code: 2, userInfo: [NSLocalizedDescriptionKey: "native Contact image URL exceeds 256KiB; select fields without image data"])
        }
        return value
    }

    private func contactDict(_ c: CNContact, includeImage: Bool = false, includeThumbnail: Bool = true) throws -> [String: Any] {
        var out: [String: Any] = [
            "id": c.identifier,
            "contactType": c.contactType == .person ? "person" : "organization",
            "namePrefix": c.namePrefix,
            "givenName": c.givenName,
            "middleName": c.middleName,
            "familyName": c.familyName,
            "nameSuffix": c.nameSuffix,
            "nickname": c.nickname,
            "phonetic": [
                "given": c.phoneticGivenName,
                "middle": c.phoneticMiddleName,
                "family": c.phoneticFamilyName,
            ],
            "organization": [
                "name": c.organizationName,
                "department": c.departmentName,
                "jobTitle": c.jobTitle,
                "phonetic": c.phoneticOrganizationName,
            ],
            "emailAddresses": c.emailAddresses.map { ["label": labelString($0.label), "value": $0.value as String] },
            "phoneNumbers": c.phoneNumbers.map { ["label": labelString($0.label), "value": $0.value.stringValue] },
            "urlAddresses": c.urlAddresses.map { ["label": labelString($0.label), "value": $0.value as String] },
            "socialProfiles": c.socialProfiles.map { lp -> [String: Any] in
                ["label": labelString(lp.label),
                 "service": lp.value.service,
                 "username": lp.value.username,
                 "url": lp.value.urlString]
            },
            "instantMessageAddresses": c.instantMessageAddresses.map { lp -> [String: Any] in
                ["label": labelString(lp.label),
                 "service": lp.value.service,
                 "username": lp.value.username]
            },
            "contactRelations": c.contactRelations.map { lp -> [String: Any] in
                ["label": labelString(lp.label), "name": lp.value.name]
            },
            "imageDataAvailable": c.imageDataAvailable,
        ]
        out["postalAddresses"] = c.postalAddresses.map { lp -> [String: Any] in
            let p = lp.value
            return [
                "label": labelString(lp.label),
                "street": p.street,
                "city": p.city,
                "state": p.state,
                "postalCode": p.postalCode,
                "country": p.country,
                "isoCountryCode": p.isoCountryCode,
            ]
        }
        out["dates"] = c.dates.map { lp -> [String: Any] in
            ["label": labelString(lp.label), "date": Self.calendarDate(lp.value as DateComponents) as Any? ?? NSNull()]
        }
        if let bday = c.birthday, let value = Self.calendarDate(bday) {
            out["birthday"] = value
        }
        if includeThumbnail, let data = c.thumbnailImageData {
            out["thumbnailDataUrl"] = try Self.imageDataURL(data)
        }
        if includeImage, let data = c.imageData {
            out["imageDataUrl"] = try Self.imageDataURL(data)
        }
        out["note"] = NSNull()
        out["requires_entitlement"] = "com.apple.developer.contacts.notes"
        return out
    }

    private func labelString(_ raw: String?) -> String {
        guard let raw = raw else { return "" }
        return CNLabeledValue<NSString>.localizedString(forLabel: raw)
    }

    static func calendarDate(_ components: DateComponents) -> String? {
        guard let month = components.month, let day = components.day else { return nil }
        let year = components.year
        var calendar = components.calendar ?? Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let candidate = DateComponents(calendar: calendar, timeZone: calendar.timeZone, year: year ?? 2000, month: month, day: day)
        guard let date = calendar.date(from: candidate) else { return nil }
        let checked = calendar.dateComponents([.year, .month, .day], from: date)
        guard checked.year == candidate.year, checked.month == month, checked.day == day else { return nil }
        if year == nil { return String(format: "--%02d-%02d", month, day) }
        guard calendar.identifier == .gregorian, let year, (1...9999).contains(year) else { return nil }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    // MARK: - Verbs

    private func status(completion: @escaping @Sendable ([String: Any]) -> Void) {
        completion(WireFormat.success([
            "status": authStatusString(CNContactStore.authorizationStatus(for: .contacts)),
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
            "supportsLimited": true,
            "notesEntitlement": false,
        ]))
    }

    private func requestAccess(completion: @escaping @Sendable ([String: Any]) -> Void) {
        store.requestAccess(for: .contacts) { granted, error in
            completion(WireFormat.success([
                "granted": granted,
                "error": error?.localizedDescription as Any? ?? NSNull(),
            ]))
        }
    }

    private func containers(completion: @escaping @Sendable ([String: Any]) -> Void) {
        do {
            let result = try store.containers(matching: nil)
            let arr = result.map { c -> [String: Any] in
                ["id": c.identifier, "name": c.name, "type": NativeNames.name(c.type.rawValue, NativeNames.containerType)]
            }
            completion(WireFormat.success(["containers": arr]))
        } catch {
            completion(WireFormat.error("contacts.containers: \(error.localizedDescription)"))
        }
    }

    private func defaultContainer(completion: @escaping @Sendable ([String: Any]) -> Void) {
        completion(WireFormat.success(["id": store.defaultContainerIdentifier()]))
    }

    private func groups(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let pred: NSPredicate? = {
            if let cid = action["container"] as? String {
                return CNGroup.predicateForGroupsInContainer(withIdentifier: cid)
            }
            return nil
        }()
        do {
            if let container = action["container"] as? String {
                guard try store.containers(matching: CNContainer.predicateForContainers(withIdentifiers: [container])).contains(where: { $0.identifier == container }) else {
                    completion(WireFormat.failure("unsupported_target", "Contacts container identity does not exist")); return
                }
            }
            let result = try store.groups(matching: pred)
            let arr = result.map { ["id": $0.identifier, "name": $0.name] }
            completion(WireFormat.success(["groups": arr]))
        } catch {
            completion(WireFormat.error("contacts.groups: \(error.localizedDescription)"))
        }
    }

    private func groupGet(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("contacts.group: <id> required")); return }
        do {
            let groups = try store.groups(matching: CNGroup.predicateForGroups(withIdentifiers: [id]))
            guard let g = groups.first else { completion(WireFormat.error("contacts.group: not found")); return }
            completion(WireFormat.success(["id": g.identifier, "name": g.name]))
        } catch {
            completion(WireFormat.error("contacts.group: \(error.localizedDescription)"))
        }
    }

    private func groupCreate(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let name = action["name"] as? String else { completion(WireFormat.error("contacts.group-create: --name required")); return }
        let g = CNMutableGroup()
        g.name = name
        let saveRequest = CNSaveRequest()
        let containerId = action["container"] as? String
        saveRequest.add(g, toContainerWithIdentifier: containerId)
        do {
            try store.execute(saveRequest)
            completion(WireFormat.success(["id": g.identifier, "name": g.name]))
        } catch {
            completion(WireFormat.error("contacts.group-create: \(error.localizedDescription)"))
        }
    }

    private func groupUpdate(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String, let name = action["name"] as? String else {
            completion(WireFormat.error("contacts.group-update: <id> and --name required")); return
        }
        do {
            let groups = try store.groups(matching: CNGroup.predicateForGroups(withIdentifiers: [id]))
            guard let g = groups.first?.mutableCopy() as? CNMutableGroup else {
                completion(WireFormat.error("contacts.group-update: not found")); return
            }
            g.name = name
            let saveRequest = CNSaveRequest()
            saveRequest.update(g)
            try store.execute(saveRequest)
            completion(WireFormat.success(["id": g.identifier, "name": g.name]))
        } catch {
            completion(WireFormat.error("contacts.group-update: \(error.localizedDescription)"))
        }
    }

    private func groupDelete(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("contacts.group-delete: <id> required")); return }
        do {
            let groups = try store.groups(matching: CNGroup.predicateForGroups(withIdentifiers: [id]))
            guard let g = groups.first?.mutableCopy() as? CNMutableGroup else {
                completion(WireFormat.error("contacts.group-delete: not found")); return
            }
            let req = CNSaveRequest()
            req.delete(g)
            try store.execute(req)
            completion(WireFormat.success(["ok": true, "id": id]))
        } catch {
            completion(WireFormat.error("contacts.group-delete: \(error.localizedDescription)"))
        }
    }

    private func groupMember(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void, add: Bool) {
        guard let gid = action["id"] as? String, let cid = action["contact"] as? String else {
            completion(WireFormat.error("contacts.group-add-member/remove-member: --id <group> --contact <id> required")); return
        }
        do {
            let groups = try store.groups(matching: CNGroup.predicateForGroups(withIdentifiers: [gid]))
            guard let g = groups.first else { completion(WireFormat.error("group not found")); return }
            let contacts = try store.unifiedContacts(matching: CNContact.predicateForContacts(withIdentifiers: [cid]), keysToFetch: defaultKeys())
            guard let c = contacts.first else { completion(WireFormat.failure("target_gone", "contact not found")); return }
            let listed = { () throws -> Bool in try self.store.unifiedContacts(matching: CNContact.predicateForContactsInGroup(withIdentifier: gid), keysToFetch: [CNContactIdentifierKey as CNKeyDescriptor]).contains { $0.identifier == cid } }
            if !add, try !listed() { completion(WireFormat.failure("target_gone", "that contact is not a member of the group")); return }
            let req = CNSaveRequest()
            if add { req.addMember(c, to: g) } else { req.removeMember(c, from: g) }
            try store.execute(req)
            // Read the membership back before reporting ok. On macOS 27 an iCloud group kept the member
            // after a removal that returned no error (the member card, mutable copies and a
            // fresh store all behaved the same), and the reply said ok.
            guard try listed() == add else { completion(WireFormat.failure("provider_failed", "macOS Contacts accepted the request but the group still \(add ? "lacks" : "lists") the contact; nothing else was changed")); return }
            completion(WireFormat.success(["ok": true, "group": gid, "contact": cid, "added": add]))
        } catch {
            completion(WireFormat.error("contacts.group-member: \(error.localizedDescription)"))
        }
    }

    private func parseKeys(_ s: String?) -> [CNKeyDescriptor] {
        var keys = defaultKeys()
        if s?.components(separatedBy: ",").contains("imageDataUrl") == true { keys.append(CNContactImageDataKey as CNKeyDescriptor) }
        return keys
    }

    // Default rows carry a base64 thumbnail, and a full page of them passes the 1MiB reply cap.
    // Thumbnails that would cross the budget are left out (optional in the contract; imageDataAvailable
    // still reports the photo), so every row and the paging stay intact. Explicit --keys rows are unchanged.
    static func fitDefaultThumbnails(_ rows: [[String: Any]], budget: Int = 1_000_000) -> [[String: Any]] {
        var remaining = budget
        return rows.map { row in
            var row = row
            var size = (try? JSONSerialization.data(withJSONObject: row).count) ?? 0
            if size > remaining, row.removeValue(forKey: "thumbnailDataUrl") != nil { size = (try? JSONSerialization.data(withJSONObject: row).count) ?? 0 }
            remaining -= size
            return row
        }
    }

    private func listContacts(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let keys = parseKeys(action["keys"] as? String)
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.unifyResults = true
        if let group = action["group"] as? String { request.predicate = CNContact.predicateForContactsInGroup(withIdentifier: group) }
        else if let container = action["container"] as? String { request.predicate = CNContact.predicateForContactsInContainer(withIdentifier: container) }
        let limit = action["limit"] as? Int ?? 100
        let offset = (action["offset"] as? Int) ?? 0
        var results: [CNContact] = []
        var visited = 0
        do {
            if let group = action["group"] as? String {
                guard try store.groups(matching: CNGroup.predicateForGroups(withIdentifiers: [group])).contains(where: { $0.identifier == group }) else {
                    completion(WireFormat.failure("unsupported_target", "Contacts group identity does not exist")); return
                }
            } else if let container = action["container"] as? String {
                guard try store.containers(matching: CNContainer.predicateForContainers(withIdentifiers: [container])).contains(where: { $0.identifier == container }) else {
                    completion(WireFormat.failure("unsupported_target", "Contacts container identity does not exist")); return
                }
            }
            try store.enumerateContacts(with: request) { c, stop in
                visited += 1
                if visited <= offset { return }
                results.append(c)
                if results.count >= limit { stop.pointee = true }
            }
            let selected = (action["keys"] as? String)?.components(separatedBy: ",")
            let rows = try results.map { contact in
                let row = try self.contactDict(contact, includeImage: selected?.contains("imageDataUrl") == true, includeThumbnail: selected == nil || selected!.contains("thumbnailDataUrl"))
                guard let selected else { return row }
                var allowed = Set(selected); allowed.insert("id")
                if allowed.contains("note") { allowed.insert("requires_entitlement") }
                return row.filter { allowed.contains($0.key) }
            }
            completion(WireFormat.success([
                "limit": limit,
                "offset": offset,
                "contacts": selected == nil ? Self.fitDefaultThumbnails(rows) : rows,
            ]))
        } catch {
            completion(WireFormat.error("contacts.list: \(error.localizedDescription)"))
        }
    }

    private func getContact(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("contacts.contact: <id> required")); return }
        do {
            let contacts = try store.unifiedContacts(
                matching: CNContact.predicateForContacts(withIdentifiers: [id]),
                keysToFetch: defaultKeys()
            )
            guard let c = contacts.first else { completion(WireFormat.error("contacts.contact: not found")); return }
            completion(WireFormat.success(try contactDict(c)))
        } catch {
            completion(WireFormat.error("contacts.contact: \(error.localizedDescription)"))
        }
    }

    private func meContact(completion: @escaping @Sendable ([String: Any]) -> Void) {
        do {
            let me = try store.unifiedMeContactWithKeys(toFetch: defaultKeys())
            completion(WireFormat.success(try contactDict(me)))
        } catch {
            completion(WireFormat.error("contacts.me: \(error.localizedDescription)"))
        }
    }

    private func findContacts(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        do {
            let pred: NSPredicate
            if let phone = action["phone"] as? String {
                pred = CNContact.predicateForContacts(matching: CNPhoneNumber(stringValue: phone))
            } else if let email = action["email"] as? String {
                pred = CNContact.predicateForContacts(matchingEmailAddress: email)
            } else if let name = action["name"] as? String {
                pred = CNContact.predicateForContacts(matchingName: name)
            } else if let q = action["query"] as? String {
                pred = CNContact.predicateForContacts(matchingName: q)
            } else {
                completion(WireFormat.error("contacts.find: <query>, --name, --email, or --phone required"))
                return
            }
            let contacts = try store.unifiedContacts(matching: pred, keysToFetch: defaultKeys())
            guard contacts.count <= 1000 else { completion(WireFormat.failure("resource_limit", "Contacts search exceeds 1000 native matches; narrow the query")); return }
            completion(WireFormat.success(["matches": try contacts.map { try self.contactDict($0) }]))
        } catch {
            completion(WireFormat.error("contacts.find: \(error.localizedDescription)"))
        }
    }

    private func makeMutable(_ action: [String: Any], existing: CNMutableContact? = nil) -> CNMutableContact {
        let m = existing ?? CNMutableContact()
        if let v = action["given"] as? String { m.givenName = v }
        if let v = action["family"] as? String { m.familyName = v }
        if let v = action["organization"] as? String { m.organizationName = v }
        if let raw = action["email"] as? String {
            m.emailAddresses = parseLabeled(raw).map { CNLabeledValue(label: $0.0, value: $0.1 as NSString) }
        }
        if let raw = action["phone"] as? String {
            m.phoneNumbers = parseLabeled(raw).map { CNLabeledValue(label: $0.0, value: CNPhoneNumber(stringValue: $0.1)) }
        }
        if let raw = action["postal"] as? String {
            // home:"1 Apple Park Way;Cupertino;CA;95014;USA"
            let parts = raw.split(separator: ":", maxSplits: 1)
            if parts.count == 2 {
                let parts2 = String(parts[1]).split(separator: ";", omittingEmptySubsequences: false).map(String.init)
                let p = CNMutablePostalAddress()
                if parts2.count >= 1 { p.street = parts2[0] }
                if parts2.count >= 2 { p.city = parts2[1] }
                if parts2.count >= 3 { p.state = parts2[2] }
                if parts2.count >= 4 { p.postalCode = parts2[3] }
                if parts2.count >= 5 { p.country = parts2[4] }
                m.postalAddresses = [CNLabeledValue(label: String(parts[0]), value: p)]
            }
        }
        if let raw = action["birthday"] as? String {
            let parts = raw.split(separator: "-").compactMap { Int($0) }
            m.birthday = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        }
        return m
    }

    private func parseLabeled(_ raw: String) -> [(String, String)] {
        // accept comma-separated label:value pairs
        var out: [(String, String)] = []
        for item in raw.split(separator: ",") {
            let parts = item.split(separator: ":", maxSplits: 1)
            if parts.count == 2 { out.append((String(parts[0]), String(parts[1]))) }
        }
        return out
    }

    private func createContact(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let m = makeMutable(action)
        let req = CNSaveRequest()
        req.add(m, toContainerWithIdentifier: action["container"] as? String)
        do {
            try store.execute(req)
            let saved = try store.unifiedContacts(matching: CNContact.predicateForContacts(withIdentifiers: [m.identifier]), keysToFetch: defaultKeys())
            guard saved.count == 1 else { completion(WireFormat.failure("partial_result", "native Contact saved but exact readback is absent or ambiguous; no mutation was replayed")); return }
            completion(WireFormat.success(try contactDict(saved[0])))
        } catch {
            completion(WireFormat.error("contacts.create: \(error.localizedDescription)"))
        }
    }

    private func updateContact(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("contacts.update: <id> required")); return }
        do {
            let contacts = try store.unifiedContacts(
                matching: CNContact.predicateForContacts(withIdentifiers: [id]),
                keysToFetch: defaultKeys()
            )
            guard let m = contacts.first?.mutableCopy() as? CNMutableContact else {
                completion(WireFormat.error("contacts.update: not found")); return
            }
            _ = makeMutable(action, existing: m)
            let req = CNSaveRequest()
            req.update(m)
            try store.execute(req)
            let saved = try store.unifiedContacts(matching: CNContact.predicateForContacts(withIdentifiers: [m.identifier]), keysToFetch: defaultKeys())
            guard saved.count == 1 else { completion(WireFormat.failure("partial_result", "native Contact updated but exact readback is absent or ambiguous; no mutation was replayed")); return }
            completion(WireFormat.success(try contactDict(saved[0])))
        } catch {
            completion(WireFormat.error("contacts.update: \(error.localizedDescription)"))
        }
    }

    private func deleteContact(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("contacts.delete: <id> required")); return }
        do {
            let contacts = try store.unifiedContacts(
                matching: CNContact.predicateForContacts(withIdentifiers: [id]),
                keysToFetch: defaultKeys()
            )
            guard let m = contacts.first?.mutableCopy() as? CNMutableContact else {
                completion(WireFormat.error("contacts.delete: not found")); return
            }
            let req = CNSaveRequest()
            req.delete(m)
            try store.execute(req)
            completion(WireFormat.success(["ok": true, "id": id]))
        } catch {
            completion(WireFormat.error("contacts.delete: \(error.localizedDescription)"))
        }
    }

    private func vcard(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("contacts.vcard: <id> required")); return }
        do {
            let contacts = try store.unifiedContacts(
                matching: CNContact.predicateForContacts(withIdentifiers: [id]),
                keysToFetch: [CNContactVCardSerialization.descriptorForRequiredKeys()]
            )
            let data = try CNContactVCardSerialization.data(with: contacts)
            guard data.count <= 262144, let text = String(data: data, encoding: .utf8) else { completion(WireFormat.failure("resource_limit", "Contacts vCard requires UTF8 up to 256KiB")); return }
            completion(WireFormat.success([
                "id": id,
                "vcard": text,
                "bytes": data.count,
            ]))
        } catch {
            completion(WireFormat.error("contacts.vcard: \(error.localizedDescription)"))
        }
    }

    private func importVcard(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String else { completion(WireFormat.error("contacts.import-vcard: <path> required")); return }
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { completion(WireFormat.failure("permission_denied", "Contacts import file cannot be retained")); return }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? file.close() }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG, metadata.st_size >= 0, metadata.st_size <= 262144 else { completion(WireFormat.failure("resource_limit", "Contacts import requires a regular nonsymlink file up to 256KiB")); return }
        do {
            guard let data = try file.read(upToCount: 262145), data.count <= 262144, String(data: data, encoding: .utf8) != nil else { completion(WireFormat.failure("resource_limit", "Contacts import requires UTF8 up to 256KiB")); return }
            let imported = try CNContactVCardSerialization.contacts(with: data)
            guard !imported.isEmpty, imported.count <= 100 else { completion(WireFormat.failure("resource_limit", "Contacts import requires 1..100 native contacts")); return }
            let req = CNSaveRequest()
            // Hold the mutables so we can read their identifiers after save.
            // CNSaveRequest.add() assigns the identifier on save, and the
            // mutable's identifier reflects that assignment in-place.
            var mutables: [CNMutableContact] = []
            for c in imported {
                guard let m = c.mutableCopy() as? CNMutableContact else { completion(WireFormat.failure("provider_failed", "Native imported contact could not be made mutable; no save performed")); return }
                req.add(m, toContainerWithIdentifier: action["container"] as? String)
                mutables.append(m)
            }
            try store.execute(req)
            completion(WireFormat.success([
                "imported": mutables.count,
                "ids": mutables.map { $0.identifier },
            ]))
        } catch {
            completion(WireFormat.error("contacts.import-vcard: \(error.localizedDescription)"))
        }
    }

    private func currentToken(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 10.15, *) {
            let token = store.currentHistoryToken
            completion(WireFormat.success([
                "token": token?.base64EncodedString() as Any? ?? NSNull(),
            ]))
        } else {
            completion(WireFormat.error("contacts.current-token: requires macOS 10.15+"))
        }
    }

    private func changes(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 10.15, *) {
            let request = CNChangeHistoryFetchRequest()
            if let raw = action["since"] as? String, let data = Data(base64Encoded: raw) {
                request.startingToken = data
            }
            request.includeGroupChanges = true
            let result = InterceptorContactHistory(store, request, UInt(action["limit"] as? Int ?? 1000))
            if let error = result["nativeError"] as? NSError { completion(WireFormat.failure("provider_failed", error.localizedDescription, details: ["nativeDomain": error.domain, "nativeCode": error.code])); return }
            if let code = result["code"] as? String { completion(WireFormat.failure(code, result["error"] as? String ?? "Native Contacts history failed")); return }
            guard let events = result["events"] as? [CNChangeHistoryEvent] else { completion(WireFormat.failure("provider_failed", "Native Contacts history returned invalid events")); return }
            let encoded = events.compactMap(eventDict)
            guard encoded.count == events.count else { completion(WireFormat.failure("unsupported_operation", "Native Contacts history contains an unknown event type; the history token was not advanced")); return }
            completion(WireFormat.success([
                "currentToken": result["currentToken"] ?? NSNull(),
                "events": encoded,
            ]))
        } else {
            completion(WireFormat.error("contacts.changes: requires macOS 10.15+"))
        }
    }

    @available(macOS 10.15, *)
    private func eventDict(_ e: CNChangeHistoryEvent) -> [String: Any]? {
        switch e {
        case let e as CNChangeHistoryAddContactEvent:
            return ["type": "addContact", "contactId": e.contact.identifier]
        case let e as CNChangeHistoryUpdateContactEvent:
            return ["type": "updateContact", "contactId": e.contact.identifier]
        case let e as CNChangeHistoryDeleteContactEvent:
            return ["type": "deleteContact", "contactId": e.contactIdentifier]
        case let e as CNChangeHistoryAddGroupEvent:
            return ["type": "addGroup", "groupId": e.group.identifier]
        case let e as CNChangeHistoryUpdateGroupEvent:
            return ["type": "updateGroup", "groupId": e.group.identifier]
        case let e as CNChangeHistoryDeleteGroupEvent:
            return ["type": "deleteGroup", "groupId": e.groupIdentifier]
        case let e as CNChangeHistoryAddMemberToGroupEvent:
            return ["type": "addMemberToGroup", "groupId": e.group.identifier, "contactId": e.member.identifier]
        case let e as CNChangeHistoryRemoveMemberFromGroupEvent:
            return ["type": "removeMemberFromGroup", "groupId": e.group.identifier, "contactId": e.member.identifier]
        case let e as CNChangeHistoryAddSubgroupToGroupEvent:
            return ["type": "addSubgroup", "parent": e.group.identifier, "child": e.subgroup.identifier]
        case let e as CNChangeHistoryRemoveSubgroupFromGroupEvent:
            return ["type": "removeSubgroup", "parent": e.group.identifier, "child": e.subgroup.identifier]
        case _ as CNChangeHistoryDropEverythingEvent:
            return ["type": "dropEverything"]
        default:
            return nil
        }
    }
}
