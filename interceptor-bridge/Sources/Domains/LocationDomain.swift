// CoreLocation. macOS 10.6+; CLGeocoder/CLPlacemark
// deprecated 26.0 — guarded behind #available. References:
// apple-developer-docs/CoreLocation/{CLLocationManager,CLAuthorizationStatus,
// CLLocation,CLGeocoder,CLPlacemark}.md.

import Foundation
import CoreLocation
import Contacts

final class LocationDomain: NSObject, DomainHandler, CLLocationManagerDelegate, @unchecked Sendable {
    private let makeManager: () -> CLLocationManager
    private let requestTimeout:TimeInterval
    private var managerValue: CLLocationManager?
    private var manager: CLLocationManager {
        if let managerValue{return managerValue}
        let value=makeManager();managerValue=value;value.delegate=self;return value
    }
    private lazy var geocoder = CLGeocoder()
    private let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private struct OneShot {
        let id: UUID
        let manager: CLLocationManager
        var cleaning=false
        var completion: (@Sendable ([String:Any]) -> Void)?
    }
    private var oneShot: OneShot?
    private var geocodeRequest: (id:UUID, completion:(@Sendable ([String:Any])->Void)?)?
    private let lock = NSLock()
    private var continuous: [[String:Any]] = []
    private var continuousActive = false
    private var significantActive=false
    private var visitsActive=false
    private var monitorError: String?

    init(makeManager: @escaping () -> CLLocationManager = {CLLocationManager()},requestTimeout:TimeInterval=30) {
        self.makeManager=makeManager
        self.requestTimeout=requestTimeout
        super.init()
    }

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var canonical=action;canonical["type"]="desktop_location";canonical["sub"]=action["sub"] as? String ?? command
        if let error=Self.validationError(canonical){completion(WireFormat.failure("invalid_request",error));return}
        let box=UncheckedSendableBox(canonical)
        DispatchQueue.main.async{self.dispatch(command,action:box.value,completion:completion)}
    }
    private func dispatch(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "status":                          status(completion: completion)
        case "request":                         requestAccess(action, completion: completion)
        case "request-temporary-accuracy":      requestTemporaryAccuracy(action, completion: completion)
        case "current":                         currentLocation(completion: completion)
        case "monitor_start":                   monitorStart(action, completion: completion)
        case "monitor_stop":                    monitorStop(completion: completion)
        case "monitor_tail":                    monitorTail(completion: completion)
        case "significant_start":               significantStart(completion: completion)
        case "significant_stop":                significantStop(completion: completion)
        case "visits_start":                    visitsStart(completion: completion)
        case "visits_stop":                     visitsStop(completion: completion)
        case "heading_start":                   headingStart(completion: completion)
        case "heading_stop":                    headingStop(completion: completion)
        case "geocode":                         geocode(action, completion: completion)
        case "reverse":                         reverseGeocode(action, completion: completion)
        case "distance":                        distance(action, completion: completion)
        case "postal-geocode":                  postalGeocode(action, completion: completion)
        default:                                completion(WireFormat.error("location.\(sub) — unknown verb"))
        }
    }

    static func coordinates(_ value:Any?,region:Bool=false)->[Double]?{
        guard let text=value as? String,text.utf8.count<=128,text.range(of:"^[0-9+eE.,\\s-]+$",options:.regularExpression) != nil else{return nil}
        let pieces=text.split(separator:",",omittingEmptySubsequences:false)
        guard pieces.count==(region ? 3:2) else{return nil}
        let point=pieces.compactMap{Double($0.trimmingCharacters(in:.whitespacesAndNewlines))}
        guard point.count==pieces.count,point.allSatisfy(\.isFinite),abs(point[0])<=90,abs(point[1])<=180,!region||(point[2]>0&&point[2]<=10000000)else{return nil};return point
    }
    static func validationError(_ a:[String:Any])->String?{
        if let error=DesktopLocationShape.validationError(a){return error}
        let sub=a["sub"] as! String
        let fields:[String:[String]]=["request":["level"],"request-temporary-accuracy":["purpose"],"monitor_start":["accuracy"],"geocode":["address","locale","region"],"reverse":["coords","locale"],"distance":["from","to"],"postal-geocode":["postal","locale"]]
        let owned=fields[sub] ?? []
        for key in ["level","purpose","accuracy","address","coords","postal","region","locale","from","to"]{if a[key] != nil && !owned.contains(key){return "field does not belong to location \(sub)"}}
        func bounded(_ value:Any?,_ max:Int)->Bool{guard let text=value as? String else{return false};return !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && text.utf8.count<=max && !text.contains("\0")}
        for key in ["group","groupColor"]{if a[key] != nil && !bounded(a[key],256){return "invalid location group metadata"}}
        if sub=="request-temporary-accuracy" && !bounded(a["purpose"],128){return "temporary accuracy requires a bounded purpose"}
        if let locale=a["locale"] as? String, !bounded(locale,128)||locale.range(of:"^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$",options:.regularExpression)==nil{return "invalid location locale"}
        if sub=="geocode" && !bounded(a["address"],4096){return "geocode requires a bounded address"}
        if sub=="reverse" && coordinates(a["coords"])==nil{return "reverse requires finite latitude/longitude"}
        if sub=="distance" && (coordinates(a["from"])==nil||coordinates(a["to"])==nil){return "distance requires finite latitude/longitude pairs"}
        if a["region"] != nil && coordinates(a["region"],region:true)==nil{return "geocode region requires latitude/longitude and a positive bounded radius"}
        if sub=="postal-geocode"{
            guard bounded(a["postal"],8192),let raw=a["postal"] as? String,let dict=try? JSONSerialization.jsonObject(with:Data(raw.utf8)) as? [String:Any],!dict.isEmpty,dict.allSatisfy({["street","city","state","postalCode","country","isoCountryCode"].contains($0.key)&&bounded($0.value,1024)})else{return "invalid bounded postal address fields"}
        }
        return nil
    }

    // MARK: - Helpers

    private func authStatusString(_ s: CLAuthorizationStatus) -> String {
        switch s {
        case .notDetermined: return "notDetermined"
        case .restricted:    return "restricted"
        case .denied:        return "denied"
        case .authorized:    return "authorized"
        case .authorizedAlways:    return "authorizedAlways"
        case .authorizedWhenInUse: return "authorizedWhenInUse"
        @unknown default: return "unknown"
        }
    }

    private func locationDict(_ l: CLLocation) -> [String: Any] {
        var out: [String: Any] = [
            "coordinate": [l.coordinate.latitude, l.coordinate.longitude],
            "altitude": l.altitude,
            "ellipsoidalAltitude": l.ellipsoidalAltitude,
            "horizontalAccuracy": l.horizontalAccuracy,
            "verticalAccuracy": l.verticalAccuracy,
            "course": l.course,
            "courseAccuracy": l.courseAccuracy,
            "speed": l.speed,
            "speedAccuracy": l.speedAccuracy,
            "timestamp": isoFormatter.string(from: l.timestamp),
        ]
        out["floor"] = l.floor?.level as Any? ?? NSNull()
        return out
    }
    static func validFix(_ l:CLLocation)->Bool{
        CLLocationCoordinate2DIsValid(l.coordinate) && l.horizontalAccuracy>=0 &&
        [l.altitude,l.ellipsoidalAltitude,l.horizontalAccuracy,l.verticalAccuracy,l.course,l.courseAccuracy,l.speed,l.speedAccuracy,l.timestamp.timeIntervalSince1970].allSatisfy(\.isFinite)
    }

    private func placemarkDict(_ p: CLPlacemark) -> [String: Any] {
        var out: [String: Any] = ["name": p.name as Any? ?? NSNull()]
        if let location=p.location,CLLocationCoordinate2DIsValid(location.coordinate){out["coordinate"]=[location.coordinate.latitude,location.coordinate.longitude]}
        if let v = p.thoroughfare { out["thoroughfare"] = v }
        if let v = p.subThoroughfare { out["subThoroughfare"] = v }
        if let v = p.locality { out["locality"] = v }
        if let v = p.subLocality { out["subLocality"] = v }
        if let v = p.administrativeArea { out["administrativeArea"] = v }
        if let v = p.subAdministrativeArea { out["subAdministrativeArea"] = v }
        if let v = p.postalCode { out["postalCode"] = v }
        if let v = p.isoCountryCode { out["isoCountryCode"] = v }
        if let v = p.country { out["country"] = v }
        if let v = p.inlandWater { out["inlandWater"] = v }
        if let v = p.ocean { out["ocean"] = v }
        if let aoi = p.areasOfInterest { out["areasOfInterest"] = aoi }
        return out
    }

    // MARK: - Status / authorization

    private func status(completion: @escaping @Sendable ([String: Any]) -> Void) {
        let s = manager.authorizationStatus
        var resp: [String: Any] = [
            "status": authStatusString(s),
            "locationServicesEnabled": CLLocationManager.locationServicesEnabled(),
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        resp["accuracyAuthorization"] = NativeNames.name(manager.accuracyAuthorization.rawValue, NativeNames.accuracy)
        completion(WireFormat.success(resp))
    }

    private func requestAccess(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let level = (action["level"] as? String) ?? "whenInUse"
        DispatchQueue.main.async {
            switch level {
            case "always": self.manager.requestAlwaysAuthorization()
            default:       self.manager.requestWhenInUseAuthorization()
            }
            completion(WireFormat.success(["requested": level, "status": self.authStatusString(self.manager.authorizationStatus)]))
        }
    }

    private func requestTemporaryAccuracy(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let purpose = action["purpose"] as? String else {
            completion(WireFormat.error("location.request-temporary-accuracy: --purpose required (Info.plist purpose key)")); return
        }
        // Per Apple's requestTemporaryFullAccuracyAuthorization(withPurposeKey:completion:)
        // doc the call always fails with kCLErrorPromptDeclined (CLError 18)
        // in three cases: (a) the purposeKey is missing from
        // NSLocationTemporaryUsageDescriptionDictionary, (b) the app is
        // already at full accuracy, or (c) the app is in the background.
        // Pre-flight (a) and (c) so callers get a structured response
        // rather than an opaque "kCLErrorDomain error 18".
        let infoDict = Bundle.main.object(forInfoDictionaryKey: "NSLocationTemporaryUsageDescriptionDictionary") as? [String: Any]
        if infoDict?[purpose] == nil {
            let known = (infoDict.map { Array($0.keys) } ?? []).sorted()
            completion(WireFormat.error("location.request-temporary-accuracy: --purpose \"\(purpose)\" not in NSLocationTemporaryUsageDescriptionDictionary. Known: \(known)")); return
        }
        // macOS only exposes .authorizedAlways (and legacy .authorized);
        // .authorizedWhenInUse is iOS-only.
        let baseStatus = manager.authorizationStatus
        let hasBaseAuth: Bool = {
            switch baseStatus {
            case .authorizedAlways: return true
            case .authorized:       return true
            default:                return false
            }
        }()
        guard hasBaseAuth else {
            completion(WireFormat.error("location.request-temporary-accuracy: app lacks base location auth (status=\(authStatusString(baseStatus))). Run `location request` first; system Location Services must be on.")); return
        }
        let replied=AtomicFlag()
        DispatchQueue.global().asyncAfter(deadline:.now()+requestTimeout){if replied.set(){completion(WireFormat.failure("timeout_unknown_outcome","temporary accuracy request exceeded its reply deadline; native authorization is not replayed"))}}
        manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: purpose) { error in
            guard replied.set()else{return}
            if let nsError = error as NSError?, nsError.domain == "kCLErrorDomain" && nsError.code == 18 {
                completion(WireFormat.error("location.request-temporary-accuracy: kCLErrorPromptDeclined. Apple disallows temporary-accuracy prompts from background-only agents (LSUIElement=true)."))
            } else if let error = error {
                completion(WireFormat.error("location: \(error.localizedDescription)"))
            } else {
                completion(WireFormat.success(["accuracyAuthorization": NativeNames.name(self.manager.accuracyAuthorization.rawValue, NativeNames.accuracy)]))
            }
        }
    }

    private func currentLocation(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock()
        guard oneShot==nil else{lock.unlock();completion(WireFormat.failure("resource_limit","another current location request or native cleanup is active"));return}
        lock.unlock()
        // Admission and creation are serialized on the main run loop. Never hold
        // the callback lock while a framework constructor or delegate setter runs.
        let id=UUID(),native=makeManager()
        lock.lock()
        oneShot=OneShot(id:id,manager:native,completion:completion)
        lock.unlock()
        native.delegate=self
        DispatchQueue.global().asyncAfter(deadline:.now()+requestTimeout){
            self.lock.lock();let callback=self.oneShot?.id==id ? self.oneShot?.completion:nil
            if self.oneShot?.id==id{self.oneShot?.completion=nil};self.lock.unlock()
            callback?(WireFormat.failure("timeout_unknown_outcome","current location deadline exceeded; native cleanup remains owned and no request was replayed"))
            DispatchQueue.main.async{self.finishCurrent(id:id,result:nil)}
        }
        native.requestLocation()
    }
    private func finishCurrent(id:UUID,result:[String:Any]?){
        lock.lock();guard let request=oneShot,request.id==id,!request.cleaning else{lock.unlock();return};oneShot?.cleaning=true;lock.unlock()
        request.manager.delegate=nil;request.manager.stopUpdatingLocation()
        lock.lock();let callback=oneShot?.id==id ? oneShot?.completion:nil
        if oneShot?.id==id{oneShot=nil};lock.unlock()
        if let result{callback?(result)}
    }

    // MARK: - Monitor

    static let deniedText = "macOS location access is off for Interceptor; turn on Location Services and allow interceptor-bridge in System Settings > Privacy & Security > Location Services"
    // A monitor that cannot get a fix refuses up front instead of answering monitoring:true.
    private func monitorRefusal()->[String:Any]?{
        let status=manager.authorizationStatus
        guard !CLLocationManager.locationServicesEnabled() || status == .denied || status == .restricted else{return nil}
        return WireFormat.failure("permission_denied",Self.deniedText)
    }

    private func monitorStart(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let accuracy = (action["accuracy"] as? String) ?? "best"
        switch accuracy {
        case "best":            manager.desiredAccuracy = kCLLocationAccuracyBest
        case "nearest":         manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        case "tenmeters":       manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        case "hundredmeters":   manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        case "kilometer":       manager.desiredAccuracy = kCLLocationAccuracyKilometer
        case "threekilometers": manager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
        default:                manager.desiredAccuracy = kCLLocationAccuracyBest
        }
        if let refusal=monitorRefusal(){completion(refusal);return}
        DispatchQueue.main.async {
            self.monitorError=nil
            self.continuousActive = true
            self.manager.startUpdatingLocation()
            completion(WireFormat.success(["monitoring": true, "accuracy": accuracy]))
        }
    }

    private func monitorStop(completion: @escaping @Sendable ([String: Any]) -> Void) {
        DispatchQueue.main.async {
            self.continuousActive = false
            self.manager.stopUpdatingLocation()
            completion(WireFormat.success(["monitoring": false]))
        }
    }

    private func monitorTail(completion: @escaping @Sendable ([String: Any]) -> Void) {
        lock.lock(); let snapshot = continuous; continuous.removeAll(); lock.unlock()
        var data:[String:Any]=["locations":snapshot,"monitoring":continuousActive]
        if let monitorError{data["lastError"]=monitorError};completion(WireFormat.success(data))
    }

    private func significantStart(completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard CLLocationManager.significantLocationChangeMonitoringAvailable()else{completion(WireFormat.failure("unsupported_operation","native significant location monitoring is unavailable"));return}
        if let refusal=monitorRefusal(){completion(refusal);return}
        manager.startMonitoringSignificantLocationChanges()
        significantActive=true
        completion(WireFormat.success(["ok": true]))
    }
    private func significantStop(completion: @escaping @Sendable ([String: Any]) -> Void) {
        manager.stopMonitoringSignificantLocationChanges()
        significantActive=false
        completion(WireFormat.success(["ok": true]))
    }
    private func visitsStart(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let refusal=monitorRefusal(){completion(refusal);return}
        manager.startMonitoringVisits()
        visitsActive=true
        completion(WireFormat.success(["ok": true]))
    }
    private func visitsStop(completion: @escaping @Sendable ([String: Any]) -> Void) {
        manager.stopMonitoringVisits()
        visitsActive=false
        completion(WireFormat.success(["ok": true]))
    }
    private func headingStart(completion: @escaping @Sendable ([String: Any]) -> Void) {
        // Heading is iOS-only; on macOS this returns a structured note.
        completion(WireFormat.success(["ok": false, "note": "heading updates are iOS-only; macOS does not provide CLHeading."]))
    }
    private func headingStop(completion: @escaping @Sendable ([String: Any]) -> Void) {
        completion(WireFormat.success(["ok": true, "note": "no-op on macOS"]))
    }

    // MARK: - Geocoding

    private func geocode(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id=beginGeocode(completion)else{return}
        let address = action["address"] as! String
        let locale: Locale? = (action["locale"] as? String).map { Locale(identifier: $0) }
        if let parts=Self.coordinates(action["region"],region:true) {
                let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: parts[0], longitude: parts[1]),
                                              radius: parts[2], identifier: "interceptor-bridge")
                geocoder.geocodeAddressString(address, in: region, preferredLocale: locale) { placemarks, error in
                    self.completeGeocode(id:id,placemarks:placemarks,error:error)
                }
                return
        }
        geocoder.geocodeAddressString(address, in: nil, preferredLocale: locale) { placemarks, error in
            self.completeGeocode(id:id,placemarks:placemarks,error:error)
        }
    }

    private func reverseGeocode(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id=beginGeocode(completion)else{return}
        let parts=Self.coordinates(action["coords"])!
        let loc = CLLocation(latitude: parts[0], longitude: parts[1])
        let locale: Locale? = (action["locale"] as? String).map { Locale(identifier: $0) }
        geocoder.reverseGeocodeLocation(loc, preferredLocale: locale) { placemarks, error in
            self.completeGeocode(id:id,placemarks:placemarks,error:error,coordinate:parts)
        }
    }

    static func noMatch(_ error: Error) -> Bool { (error as NSError).domain == kCLErrorDomain && (error as NSError).code == CLError.geocodeFoundNoResult.rawValue }

    private func beginGeocode(_ completion:@escaping @Sendable ([String:Any])->Void)->UUID?{
        lock.lock();guard geocodeRequest==nil else{lock.unlock();completion(WireFormat.failure("resource_limit","another geocode request or native cleanup is active; no work queued"));return nil}
        let id=UUID();geocodeRequest=(id,completion);lock.unlock()
        DispatchQueue.global().asyncAfter(deadline:.now()+requestTimeout){
            self.lock.lock();let callback=self.geocodeRequest?.id==id ? self.geocodeRequest?.completion:nil
            if self.geocodeRequest?.id==id{self.geocodeRequest?.completion=nil};self.lock.unlock()
            callback?(WireFormat.failure("timeout_unknown_outcome","geocode deadline exceeded; native cancellation remains owned and no request was replayed"))
            DispatchQueue.main.async{self.lock.lock();let active=self.geocodeRequest?.id==id;self.lock.unlock();if active{self.geocoder.cancelGeocode()}}
        }
        return id
    }
    private func completeGeocode(id:UUID,placemarks:[CLPlacemark]?,error:Error?,coordinate:[Double]?=nil){
        let box=UncheckedSendableBox((placemarks,error))
        DispatchQueue.main.async{
            self.lock.lock();guard self.geocodeRequest?.id==id else{self.lock.unlock();return}
            let callback=self.geocodeRequest?.completion;self.geocodeRequest=nil;self.lock.unlock()
            guard let callback else{return}
            if let error=box.value.1,!Self.noMatch(error){callback(WireFormat.failure("provider_failed",String(error.localizedDescription.prefix(1000))));return}
            let marks=box.value.0 ?? []
            guard marks.count<=32 else{callback(WireFormat.failure("resource_limit","geocoder returned more than 32 placemarks"));return}
            let rows=marks.map(self.placemarkDict)
            guard rows.allSatisfy({row in row.allSatisfy{key,value in
                if key=="coordinate" || value is NSNull{return true}
                if let text=value as? String{return text.utf8.count<=4096 && !text.contains("\0")}
                if let texts=value as? [String]{return texts.count<=32 && texts.allSatisfy{$0.utf8.count<=4096 && !$0.contains("\0")}}
                return false
            }})else{callback(WireFormat.failure("resource_limit","geocoder returned invalid or oversized address fields"));return}
            var data:[String:Any]=["placemarks":rows]
            if let coordinate{data["coordinate"]=coordinate}
            guard let bytes=try? JSONSerialization.data(withJSONObject:data),bytes.count<=65536 else{callback(WireFormat.failure("resource_limit","geocoder output exceeded its bounded JSON contract"));return}
            callback(WireFormat.success(data))
        }
    }

    private func distance(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let f=Self.coordinates(action["from"])!,t=Self.coordinates(action["to"])!
        let a = CLLocation(latitude: f[0], longitude: f[1])
        let b = CLLocation(latitude: t[0], longitude: t[1])
        completion(WireFormat.success(["meters": a.distance(from: b)]))
    }

    private func postalGeocode(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id=beginGeocode(completion)else{return}
        guard let raw = action["postal"] as? String,
              let data = raw.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: String]
        else { completion(WireFormat.error("location.postal-geocode: --postal <json-postal> required")); return }
        let p = CNMutablePostalAddress()
        p.street = dict["street"] ?? ""
        p.city = dict["city"] ?? ""
        p.state = dict["state"] ?? ""
        p.postalCode = dict["postalCode"] ?? ""
        p.country = dict["country"] ?? ""
        p.isoCountryCode = dict["isoCountryCode"] ?? ""
        let locale=(action["locale"] as? String).map{Locale(identifier:$0)}
        geocoder.geocodePostalAddress(p,preferredLocale:locale) { placemarks, error in
            self.completeGeocode(id:id,placemarks:placemarks,error:error)
        }
    }

    // MARK: - Delegate

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        lock.lock();let current=oneShot;lock.unlock()
        if let request=current,manager===request.manager {
            if let location=locations.last,Self.validFix(location){
                finishCurrent(id:request.id,result:WireFormat.success(locationDict(location)))
            }else{finishCurrent(id:request.id,result:WireFormat.failure("provider_failed","native location callback did not contain a valid fix"))}
            return
        }
        guard let configured=managerValue,manager===configured else{return}
        if continuousActive||significantActive, let last = locations.last,Self.validFix(last) {
            retainObservation(locationDict(last))
        }
    }
    private func retainObservation(_ point:[String:Any]){
        lock.lock();if continuous.count==200{continuous.removeFirst()};continuous.append(point);lock.unlock()
    }
    func locationManager(_ manager:CLLocationManager,didVisit visit:CLVisit){
        guard let configured=managerValue,manager===configured,visitsActive,CLLocationCoordinate2DIsValid(visit.coordinate),visit.horizontalAccuracy.isFinite,visit.horizontalAccuracy>=0 else{return}
        let measured=visit.departureDate == Date.distantFuture ? visit.arrivalDate:visit.departureDate
        guard measured != Date.distantPast,measured != Date.distantFuture,measured.timeIntervalSince1970.isFinite else{return}
        retainObservation(["coordinate":[visit.coordinate.latitude,visit.coordinate.longitude],"altitude":NSNull(),"ellipsoidalAltitude":NSNull(),"horizontalAccuracy":visit.horizontalAccuracy,"verticalAccuracy":NSNull(),"course":NSNull(),"courseAccuracy":NSNull(),"speed":NSNull(),"speedAccuracy":NSNull(),"floor":NSNull(),"timestamp":isoFormatter.string(from:measured)])
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        lock.lock();let current=oneShot;lock.unlock()
        let nativeError=error as NSError
        if let request=current,manager===request.manager {
            let denied=nativeError.domain==kCLErrorDomain&&nativeError.code==CLError.denied.rawValue
            finishCurrent(id:request.id,result:denied ? WireFormat.failure("permission_denied",Self.deniedText) : WireFormat.failure("provider_failed",String(error.localizedDescription.prefix(1000))))
            return
        }
        if let configured=managerValue,manager===configured,continuousActive||significantActive||visitsActive{
            continuousActive=false;significantActive=false;visitsActive=false
            monitorError=nativeError.domain==kCLErrorDomain&&nativeError.code==CLError.denied.rawValue ? Self.deniedText:String(error.localizedDescription.prefix(1000))
            manager.stopUpdatingLocation();manager.stopMonitoringSignificantLocationChanges();manager.stopMonitoringVisits()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        // No-op; status is always queried fresh.
    }
}
