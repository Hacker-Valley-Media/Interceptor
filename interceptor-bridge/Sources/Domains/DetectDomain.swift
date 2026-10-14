// Foundation supplies the baseline kinds. The public macOS DataDetector API
// supplies the five additional semantic kinds starting with macOS26.

import Foundation
import DataDetection
import Darwin

final class DetectDomain: DomainHandler, @unchecked Sendable {
    // ponytail: one detector job per bridge; a pool only if throughput requires it.
    private let detectionGate = DispatchSemaphore(value: 1)
    private let extraKinds = ["moneyAmount", "flightNumber", "shipmentTrackingNumber", "measurement", "paymentIdentifier"]
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "types":  completion(WireFormat.success(["types": availableTypes()]))
        case "run":    runDetect(action, completion: completion)
        case "file":   detectFile(action, completion: completion)
        case "stdin":  // bridge consumers set the input via action["input"] when stdin is wrapped at the CLI
                       runDetect(action, completion: completion)
        default:       completion(WireFormat.error("detect.\(sub) — unknown verb"))
        }
    }

    private func availableTypes() -> [String] {
        var t = ["link", "phoneNumber", "calendarEvent", "postalAddress", "email", "transit"]
        if #available(macOS 26, *) {
            t.append(contentsOf: extraKinds)
        }
        return t
    }

    private func runDetect(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let input = action["input"] as? String, !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !input.contains("\0"), input.utf8.count <= 65_536 else {
            completion(WireFormat.error("detect.run: requires nonempty UTF-8 input up to 64 KiB")); return
        }
        let typesArg = (action["types"] as? String) ?? "all"
        do {
            let selected = try selectedKinds(typesArg)
            guard detectionGate.wait(timeout: .now()) == .success else {
                completion(WireFormat.error("detect.run: detector busy; no work was queued")); return
            }
            let mask = compileMask(selected)
            var matches: [[String: Any]] = []
            if !mask.isEmpty {
                do {
                    let detector = try NSDataDetector(types: mask.rawValue)
                    for result in detector.matches(in: input, options: [], range: NSRange(location: 0, length: input.utf16.count)) {
                        let row = matchToDict(result, in: input)
                        if selected.contains(row["type"] as? String ?? "") { matches.append(row) }
                        if matches.count > 1024 { break }
                    }
                } catch { detectionGate.signal(); throw error }
            }
            guard matches.count <= 1024 else {
                detectionGate.signal(); completion(WireFormat.error("detect.run: more than 1024 matches")); return
            }
            if #available(macOS 26, *), !selected.isDisjoint(with: extraKinds) {
                detectModern(input, selected: selected, baseline: matches, completion: completion)
            } else {
                detectionGate.signal()
                completion(WireFormat.success(["input": input, "matches": matches]))
            }
        } catch {
            completion(WireFormat.error("detect.run: \(error.localizedDescription)"))
        }
    }

    private func detectFile(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let path = action["path"] as? String, !path.isEmpty, !path.contains("\0"), path.utf8.count <= 32_768 else { completion(WireFormat.error("detect.file: requires a bounded path without NUL")); return }
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { completion(WireFormat.error("detect.file: cannot read \(path)")); return }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_size >= 0, metadata.st_size <= 65_536 else {
            Darwin.close(descriptor); completion(WireFormat.error("detect.file: requires a regular UTF-8 file up to 64 KiB")); return
        }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? file.close() }
        guard let data = try? file.read(upToCount: 65_537), data.count <= 65_536,
              let text = String(data: data, encoding: .utf8) else {
            completion(WireFormat.error("detect.file: requires UTF-8 up to 64 KiB")); return
        }
        var fwd = action
        fwd["input"] = text
        runDetect(fwd, completion: completion)
    }

    private func selectedKinds(_ types: String) throws -> Set<String> {
        let aliases = ["url": "link", "phone": "phoneNumber", "date": "calendarEvent", "address": "postalAddress", "email": "emailAddress"]
        let available = Set(availableTypes().map { aliases[$0] ?? $0 })
        if types == "all" { return available.subtracting(["transit"]) }
        let selected = Set(types.components(separatedBy: ",").map { part in
            let name = part.trimmingCharacters(in: .whitespacesAndNewlines)
            return aliases[name] ?? name
        })
        guard types.utf8.count <= 256, !selected.isEmpty, selected.isSubset(of: available) else {
            throw NSError(domain: "detect", code: 1, userInfo: [NSLocalizedDescriptionKey: "unsupported detection type for this macOS version"])
        }
        return selected
    }

    private func compileMask(_ types: Set<String>) -> NSTextCheckingResult.CheckingType {
        var mask: NSTextCheckingResult.CheckingType = []
        for raw in types {
            switch raw {
            case "link", "emailAddress":          mask.insert(.link)
            case "phoneNumber":                   mask.insert(.phoneNumber)
            case "calendarEvent":                 mask.insert(.date)
            case "postalAddress":                 mask.insert(.address)
            case "transit":                       mask.insert(.transitInformation)
            default: break
            }
        }
        return mask
    }

    @available(macOS 26, *)
    private func detectModern(_ input: String, selected: Set<String>, baseline: [[String: Any]], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var mask: DataDetector.MatchType = []
        if selected.contains("moneyAmount") { mask.insert(.moneyAmount) }
        if selected.contains("flightNumber") { mask.insert(.flightNumber) }
        if selected.contains("shipmentTrackingNumber") { mask.insert(.shipmentTrackingNumber) }
        if selected.contains("measurement") { mask.insert(.measurement) }
        if selected.contains("paymentIdentifier") { mask.insert(.paymentIdentifier) }
        let initial = UncheckedSendableBox(baseline), kinds = mask, finished = AtomicFlag()
        let task = Task {
            defer { self.detectionGate.signal() }
            var matches = initial.value
            for await match in input.dataDetectorMatches(kinds) {
                if Task.isCancelled { return }
                guard let range = match.range else { continue }
                let span = NSRange(range, in: input)
                var row: [String: Any] = ["range": [span.location, span.length], "value": String(input[range])]
                switch match.details {
                case .moneyAmount(let value):
                    row["type"] = "moneyAmount"
                    row["components"] = ["currency": value.currency.identifier, "amount": NSDecimalNumber(decimal: value.amount).stringValue]
                case .flightNumber(let value):
                    row["type"] = "flightNumber"
                    row["components"] = ["airlineCode": value.airlineCode, "flightNumber": value.flightNumber]
                case .shipmentTrackingNumber(let value):
                    row["type"] = "shipmentTrackingNumber"
                    var components = ["carrier": value.carrier, "trackingNumber": value.trackingNumber]
                    if let url = value.trackingURL { components["trackingURL"] = url.absoluteString }
                    row["components"] = components
                case .measurement(let value):
                    row["type"] = "measurement"
                    row["components"] = ["value": value.value, "units": value.possibleDimensions.map(\.symbol)] as [String: Any]
                case .paymentIdentifier(let value):
                    row["type"] = "paymentIdentifier"
                    row["components"] = ["identifier": value.identifier, "paymentSystem": "unifiedPaymentsInterface"]
                default: continue
                }
                matches.append(row)
                guard matches.count <= 1024 else {
                    if finished.set() { completion(WireFormat.error("detect.run: more than 1024 matches")) }; return
                }
            }
            if Task.isCancelled { return }
            matches.sort { ($0["range"] as! [Int])[0] < ($1["range"] as! [Int])[0] }
            let data: [String: Any] = ["input": input, "matches": matches]
            guard let bytes = try? JSONSerialization.data(withJSONObject: data), bytes.count <= 1_048_576 else {
                if finished.set() { completion(WireFormat.error("detect.run: result exceeds 1 MiB")) }; return
            }
            if finished.set() { completion(WireFormat.success(data)) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 30) {
            if finished.set() {
                task.cancel()
                completion(WireFormat.error("detect.run: deadline exceeded; native cancellation requested"))
            }
        }
    }

    private func matchToDict(_ m: NSTextCheckingResult, in s: String) -> [String: Any] {
        let r = m.range
        let value: String = {
            guard let range = Range(r, in: s) else { return "" }
            return String(s[range])
        }()
        var dict: [String: Any] = [
            "range": [r.location, r.length],
            "value": value,
        ]
        switch m.resultType {
        case .link:
            if let url = m.url {
                if url.scheme == "mailto" {
                    dict["type"] = "emailAddress"
                    dict["components"] = ["emailAddress": url.absoluteString.replacingOccurrences(of: "mailto:", with: "")]
                } else {
                    dict["type"] = "link"
                    dict["components"] = ["url": url.absoluteString]
                }
            } else {
                dict["type"] = "link"
            }
        case .phoneNumber:
            dict["type"] = "phoneNumber"
            dict["components"] = ["phoneNumber": m.phoneNumber ?? value]
        case .date:
            dict["type"] = "calendarEvent"
            var comp: [String: Any] = [:]
            if let date = m.date { comp["startDate"] = isoFormatter.string(from: date) }
            if let dur = m.duration as Double?, dur > 0 {
                comp["duration"] = dur
                if let date = m.date { comp["endDate"] = isoFormatter.string(from: date.addingTimeInterval(dur)) }
            }
            if let tz = m.timeZone { comp["timeZone"] = tz.identifier }
            dict["components"] = comp
        case .address:
            dict["type"] = "postalAddress"
            var comp: [String: Any] = [:]
            if let parts = m.addressComponents {
                if let v = parts[.street] { comp["street"] = v }
                if let v = parts[.city] { comp["city"] = v }
                if let v = parts[.state] { comp["state"] = v }
                if let v = parts[.zip] { comp["postalCode"] = v }
                if let v = parts[.country] { comp["country"] = v }
                if let v = parts[.name] { comp["name"] = v }
                if let v = parts[.organization] { comp["organization"] = v }
            }
            dict["components"] = comp
        case .transitInformation:
            dict["type"] = "transit"
        default:
            dict["type"] = "unknown"
        }
        return dict
    }

    private let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
