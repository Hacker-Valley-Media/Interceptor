// MapKit. macOS 10.9+. References:
// apple-developer-docs/MapKit/{MKLocalSearch,MKDirections,MKMapItem,MKPlacemark}.md.

import Foundation
import MapKit
import CoreLocation
import Contacts

final class MapsDomain: DomainHandler, @unchecked Sendable {
    private let mapItemCache = MapItemCache()
    private var flights:[UUID:MapsWork]=[:]

    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var canonical=action;canonical["type"]="desktop_maps";canonical["sub"]=action["sub"] as? String ?? command
        if let error=Self.validationError(canonical){completion(WireFormat.failure("invalid_request",error));return}
        let box=UncheckedSendableBox(canonical)
        DispatchQueue.main.async{
            guard self.flights.count<4 else{completion(WireFormat.failure("resource_limit","four map requests or their native cleanup are active; no work queued"));return}
            let work=MapsWork(completion:completion);self.flights[work.id]=work
            DispatchQueue.global().asyncAfter(deadline:.now()+55){
                if work.reply(WireFormat.failure("timeout_unknown_outcome","map request exceeded its deadline; owned native cancellation remains pending and no request was replayed")){
                    DispatchQueue.main.async{work.cancel();self.retire(work)}
                }
            }
            self.dispatch(command,action:box.value,work:work){result in
                let resultBox=UncheckedSendableBox(result)
                DispatchQueue.main.async{
                    let error=Self.resultError(resultBox.value,action:box.value)
                    work.reply(error.map{WireFormat.failure("provider_failed",$0)} ?? resultBox.value)
                    work.cancel();self.retire(work)
                }
            }
        }
    }
    private func retire(_ work:MapsWork){
        guard flights[work.id]===work else{return}
        if work.busy(){DispatchQueue.main.asyncAfter(deadline:.now()+0.05){self.retire(work)};return}
        work.clear();flights.removeValue(forKey:work.id)
    }
    private func dispatch(_ command:String,action:[String:Any],work:MapsWork,completion:@escaping @Sendable ([String:Any])->Void){
        let sub = action["sub"] as? String ?? command
        switch sub {
        case "search":         search(action, work:work,completion: completion)
        case "complete":       complete(action, work:work,completion: completion)
        case "directions":     directions(action, work:work,completion: completion)
        case "eta":            eta(action, work:work,completion: completion)
        case "mapitem-open":   mapItemOpen(action,work:work,completion: completion)
        case "reverse":        reverse(action, work:work,completion: completion)
        default:               completion(WireFormat.error("maps.\(sub) — unknown verb"))
        }
    }
    static func regionValues(_ value:Any?)->[Double]?{
        guard let text=value as? String,text.utf8.count<=128,text.range(of:"^[0-9+eE.,\\s-]+$",options:.regularExpression) != nil else{return nil}
        let raw=text.split(separator:",",omittingEmptySubsequences:false);guard raw.count==4 else{return nil}
        let p=raw.compactMap{Double($0.trimmingCharacters(in:.whitespacesAndNewlines))}
        guard p.count==4,p.allSatisfy(\.isFinite),abs(p[0])<=90,abs(p[1])<=180,p[2]>0,p[2]<=180,p[3]>0,p[3]<=360 else{return nil};return p
    }
    static func validationError(_ a:[String:Any])->String?{
        if let error=DesktopMapsShape.validationError(a){return error}
        let sub=a["sub"] as! String
        let owned:[String]=["search","complete"].contains(sub) ? ["query","region","types","poi_categories","address_include","address_exclude","limit"]:sub=="reverse" ? ["coords"]:sub=="mapitem-open" ? ["id"]:["from","to","transport"]+(sub=="directions" ? ["requests_alternates"]:[])
        for key in ["query","coords","id","region","types","poi_categories","address_include","address_exclude","limit","from","to","transport","requests_alternates"]{if a[key] != nil && !owned.contains(key){return "field does not belong to maps \(sub)"}}
        func bounded(_ v:Any?,_ max:Int)->Bool{guard let s=v as? String else{return false};return !s.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && s.utf8.count<=max && !s.contains("\0")}
        for key in ["group","groupColor"]{if a[key] != nil && !bounded(a[key],256){return "invalid maps group metadata"}}
        if ["search","complete"].contains(sub) && !bounded(a["query"],4096){return "maps requires a bounded query"}
        if a["region"] != nil && regionValues(a["region"])==nil{return "invalid bounded maps region"}
        if let limit=a["limit"] as? NSNumber,CFGetTypeID(limit)==CFBooleanGetTypeID() || !limit.doubleValue.isFinite || limit.doubleValue.rounded() != limit.doubleValue || limit.doubleValue<1 || limit.doubleValue>32{return "maps limit must be an integer in 1..32"}
        if let types=a["types"] as? String,types.split(separator:",",omittingEmptySubsequences:false).contains(where:{!["address","pointOfInterest","physicalFeature"].contains($0.trimmingCharacters(in:.whitespacesAndNewlines))}){return "invalid maps result types"}
        for key in ["poi_categories","address_include","address_exclude"]{if a[key] != nil{guard bounded(a[key],4096),let text=a[key] as? String else{return "invalid map filter"};let parts=text.split(separator:",",omittingEmptySubsequences:false);if parts.count>64 || parts.contains(where:{$0.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty}){return "invalid map filter"}}}
        if a["address_include"] != nil && a["address_exclude"] != nil{return "map address include/exclude are mutually exclusive"}
        if sub=="reverse" && LocationDomain.coordinates(a["coords"])==nil{return "maps reverse requires finite latitude/longitude"}
        if sub=="mapitem-open" && !bounded(a["id"],128){return "maps open requires a retained map item id"}
        if ["directions","eta"].contains(sub){for key in ["from","to"]{guard bounded(a[key],4096),let text=a[key] as? String else{return "maps route requires bounded source/destination"};if text.contains(","),text.range(of:"^[0-9+eE.,\\s-]+$",options:.regularExpression) != nil,LocationDomain.coordinates(text)==nil{return "malformed numeric route coordinate"}}}
        return nil
    }

    private func parseRegion(_ s: String?) -> MKCoordinateRegion? {
        guard let parts=Self.regionValues(s)else{return nil}
        let center = CLLocationCoordinate2D(latitude: parts[0], longitude: parts[1])
        let span = MKCoordinateSpan(latitudeDelta: parts[2], longitudeDelta: parts[3])
        return MKCoordinateRegion(center: center, span: span)
    }

    static func resultError(_ response:[String:Any],action:[String:Any])->String?{
        guard response["success"] as? Bool == true else{return nil}
        guard let data=response["data"] as? [String:Any],let bytes=try? JSONSerialization.data(withJSONObject:data),bytes.count<=1_048_576 else{return "map response is not finite bounded JSON"}
        do{
            let decoder=JSONDecoder()
            switch action["sub"] as? String{
            case "search":_ = try decoder.decode(DesktopMapsSearch.self,from:bytes)
            case "complete":_ = try decoder.decode(DesktopMapsCompleted.self,from:bytes)
            case "directions":_ = try decoder.decode(DesktopMapsDirections.self,from:bytes)
            case "eta":_ = try decoder.decode(DesktopMapsETA.self,from:bytes)
            case "mapitem-open":_ = try decoder.decode(DesktopMapsOpened.self,from:bytes)
            case "reverse":_ = try decoder.decode(DesktopMapsReverse.self,from:bytes)
            default:return "unknown map response selector"
            }
        }catch{return "native map response does not match its typed contract"}
        func valid(_ value:Any,key:String="")->Bool{
            if let text=value as? String{return text.utf8.count<=4096 && !text.contains("\0")}
            if let number=value as? NSNumber{return number.doubleValue.isFinite && (!["distance","expectedTravelTime"].contains(key) || number.doubleValue>=0)}
            if let list=value as? [Any]{
                if ["coordinate","center"].contains(key){guard let p=list as? [Double],p.count==2,abs(p[0])<=90,abs(p[1])<=180 else{return false}}
                if key=="span"{guard let p=list as? [Double],p.count==2,p[0]>=0,p[0]<=180,p[1]>=0,p[1]<=360 else{return false}}
                let bound=["results":action["limit"] as? Int ?? 32,"completions":action["limit"] as? Int ?? 32,"placemarks":32,"routes":3,"steps":4096,"advisoryNotices":64][key]
                return (bound==nil || list.count<=bound!) && list.allSatisfy{valid($0)}
            }
            if let object=value as? [String:Any]{return object.allSatisfy{valid($0.value,key:$0.key)}}
            return value is NSNull
        }
        guard valid(data)else{return "native map output exceeds coordinate, text or collection bounds"}
        if ["search","complete"].contains(action["sub"] as? String ?? ""),data["query"] as? String != action["query"] as? String{return "map query receipt does not match its request"}
        if action["sub"] as? String == "mapitem-open",data["ok"] as? Bool != true || data["id"] as? String != action["id"] as? String{return "map launch receipt does not match its retained item"}
        if action["sub"] as? String == "eta"{
            let f=ISO8601DateFormatter()
            guard let from=data["expectedDepartureDate"] as? String,let to=data["expectedArrivalDate"] as? String,let start=f.date(from:from),let end=f.date(from:to),end>=start else{return "native map estimate omitted valid ordered dates"}
        }
        return nil
    }

    static func poiFilter(_ value:String?)->MKPointOfInterestFilter?{
        guard let value else{return nil}
        var categories:[String:MKPointOfInterestCategory]=[
            "airport":.airport,"amusementPark":.amusementPark,"aquarium":.aquarium,"atm":.atm,
            "bakery":.bakery,"bank":.bank,"beach":.beach,"brewery":.brewery,"cafe":.cafe,
            "campground":.campground,"carRental":.carRental,"evCharger":.evCharger,"fireStation":.fireStation,
            "fitnessCenter":.fitnessCenter,"foodMarket":.foodMarket,"gasStation":.gasStation,"hospital":.hospital,
            "hotel":.hotel,"laundry":.laundry,"library":.library,"marina":.marina,"movieTheater":.movieTheater,
            "museum":.museum,"nationalPark":.nationalPark,"nightlife":.nightlife,"park":.park,"parking":.parking,
            "pharmacy":.pharmacy,"police":.police,"postOffice":.postOffice,"publicTransport":.publicTransport,
            "restaurant":.restaurant,"restroom":.restroom,"school":.school,"stadium":.stadium,"store":.store,
            "theater":.theater,"university":.university,"winery":.winery,"zoo":.zoo]
        if #available(macOS 15, *){
            categories.merge(["animalService":.animalService,"automotiveRepair":.automotiveRepair,"baseball":.baseball,
                "basketball":.basketball,"beauty":.beauty,"bowling":.bowling,"castle":.castle,"conventionCenter":.conventionCenter,
                "distillery":.distillery,"fairground":.fairground,"fishing":.fishing,"fortress":.fortress,"golf":.golf,
                "goKart":.goKart,"hiking":.hiking,"kayaking":.kayaking,"landmark":.landmark,"mailbox":.mailbox,"miniGolf":.miniGolf,
                "musicVenue":.musicVenue,"nationalMonument":.nationalMonument,"planetarium":.planetarium,
                "rockClimbing":.rockClimbing,"rvPark":.rvPark,"skatePark":.skatePark,"skating":.skating,"skiing":.skiing,
                "soccer":.soccer,"spa":.spa,"surfing":.surfing,"swimming":.swimming,"tennis":.tennis,"volleyball":.volleyball]){a,_ in a}
        }
        let tokens=value.split(separator:",").map{$0.trimmingCharacters(in:.whitespacesAndNewlines)}
        let selected=tokens.compactMap{token in categories[token] ?? categories.values.first(where:{$0.rawValue==token})}
        guard selected.count==tokens.count else{return nil}
        return MKPointOfInterestFilter(including:selected)
    }
    @available(macOS 15, *)
    static func addressFilter(_ a:[String:Any])->MKAddressFilter?{
        guard let value=(a["address_include"] ?? a["address_exclude"]) as? String else{return nil}
        let options:[String:MKAddressFilter.Options]=["country":.country,"administrativeArea":.administrativeArea,"subAdministrativeArea":.subAdministrativeArea,"locality":.locality,"subLocality":.subLocality,"postalCode":.postalCode]
        var selected:MKAddressFilter.Options=[]
        for token in value.split(separator:","){guard let option=options[token.trimmingCharacters(in:.whitespacesAndNewlines)]else{return nil};selected.formUnion(option)}
        return a["address_include"] != nil ? MKAddressFilter(including:selected):MKAddressFilter(excluding:selected)
    }
    private func filterError(_ a:[String:Any])->[String:Any]?{
        if let value=a["poi_categories"] as? String,Self.poiFilter(value)==nil{return WireFormat.failure("unsupported_operation","unknown or unavailable native point-of-interest category")}
        if a["address_include"] != nil || a["address_exclude"] != nil{
            if #available(macOS 15, *){if Self.addressFilter(a)==nil{return WireFormat.failure("invalid_request","unknown address filter option")}}
            else{return WireFormat.failure("unsupported_operation","address filters require macOS 15 or newer")}
        }
        if (a["types"] as? String)?.split(separator:",").contains(where:{$0.trimmingCharacters(in:.whitespacesAndNewlines)=="physicalFeature"}) == true{
            if #available(macOS 15, *){}else{return WireFormat.failure("unsupported_operation","physical-feature results require macOS 15 or newer")}
        }
        return nil
    }

    private func placemarkDict(_ p: MKPlacemark) -> [String: Any] {
        var out: [String: Any] = [
            "name":p.name as Any? ?? NSNull(),
            "coordinate": [p.coordinate.latitude, p.coordinate.longitude],
        ]
        if let v = p.thoroughfare { out["thoroughfare"] = v }
        if let v = p.subThoroughfare { out["subThoroughfare"] = v }
        if let v = p.locality { out["locality"] = v }
        if let v = p.subLocality { out["subLocality"] = v }
        if let v = p.administrativeArea { out["administrativeArea"] = v }
        if let v = p.subAdministrativeArea { out["subAdministrativeArea"] = v }
        if let v = p.postalCode { out["postalCode"] = v }
        if let v = p.country { out["country"] = v }
        if let v = p.isoCountryCode { out["isoCountryCode"] = v }
        return out
    }

    private func mapItemDict(_ item: MKMapItem) -> [String: Any] {
        let id = mapItemCache.put(item)
        var out: [String: Any] = [
            "id": id,
            "name": item.name as Any? ?? NSNull(),
            "isCurrentLocation": item.isCurrentLocation,
            "placemark": placemarkDict(item.placemark),
        ]
        if let tz = item.timeZone { out["timeZone"] = tz.identifier }
        if let url = item.url { out["url"] = url.absoluteString }
        if let phone = item.phoneNumber { out["phoneNumber"] = phone }
        if let cat = item.pointOfInterestCategory { out["pointOfInterestCategory"] = cat.rawValue }
        return out
    }

    private func search(_ action: [String: Any], work:MapsWork,completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let error=filterError(action){completion(error);return}
        guard let query = action["query"] as? String else {
            completion(WireFormat.error("maps.search: missing query")); return
        }
        let req = MKLocalSearch.Request()
        req.naturalLanguageQuery = query
        if let region = parseRegion(action["region"] as? String) {
            req.region = region
        }
        req.pointOfInterestFilter=Self.poiFilter(action["poi_categories"] as? String)
        if #available(macOS 15, *){req.addressFilter=Self.addressFilter(action)}
        if let typesArg = action["types"] as? String {
            var types: MKLocalSearch.ResultType = []
            for raw in typesArg.split(separator: ",") {
                switch raw.trimmingCharacters(in: .whitespaces) {
                case "address": types.insert(.address)
                case "pointOfInterest": types.insert(.pointOfInterest)
                case "physicalFeature":
                    if #available(macOS 15, *) { types.insert(.physicalFeature) }
                default: break
                }
            }
            if !types.isEmpty { req.resultTypes = types }
        }
        let limit = (action["limit"] as? Int) ?? 32

        let search = MKLocalSearch(request: req)
        work.keep(search,cancel:{search.cancel()},busy:{search.isSearching})
        guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map search was revoked before native dispatch"));return}
        search.start { resp, error in
            guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map search reply was revoked"));return}
            if let error = error {
                if (error as NSError).domain == MKErrorDomain, (error as NSError).code == Int(MKError.placemarkNotFound.rawValue) { completion(WireFormat.success(["query": query, "results": [[String: Any]]()])); return }
                completion(WireFormat.failure("provider_failed",String(error.localizedDescription.prefix(1000))))
                return
            }
            guard let resp = resp else {
                completion(WireFormat.failure("provider_failed","native map search supplied neither a response nor an error"))
                return
            }
            let results = resp.mapItems.prefix(limit).map { self.mapItemDict($0) }
            completion(WireFormat.success([
                "query": query,
                "boundingRegion": [
                    "center": [resp.boundingRegion.center.latitude, resp.boundingRegion.center.longitude],
                    "span":   [resp.boundingRegion.span.latitudeDelta, resp.boundingRegion.span.longitudeDelta],
                ],
                "results": results,
            ]))
        }
    }

    private func complete(_ action: [String: Any], work:MapsWork,completion: @escaping @Sendable ([String: Any]) -> Void) {
        if let error=filterError(action){completion(error);return}
        guard let query = action["query"] as? String else {
            completion(WireFormat.error("maps.complete: missing query")); return
        }
        let limit = (action["limit"] as? Int) ?? 32
        let region = action["region"] as? String
        let poiCategories = action["poi_categories"] as? String
        let addressInclude = action["address_include"] as? String
        let addressExclude = action["address_exclude"] as? String
        let resultTypes = action["types"] as? String
        DispatchQueue.main.async {
            guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map completion was revoked before native dispatch"));return}
            let completer = MKLocalSearchCompleter()
            let delegate = CompleterDelegate { suggestions,error in
                guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map completion reply was revoked"));return}
                if let error{completion(WireFormat.failure("provider_failed",String(error.localizedDescription.prefix(1000))));return}
                completion(WireFormat.success([
                    "query": query,
                    "completions": Array(suggestions.prefix(limit)).map { ["title": $0.title, "subtitle": $0.subtitle] },
                ]))
            }
            completer.delegate = delegate
            if let region=self.parseRegion(region){completer.region=region}
            completer.pointOfInterestFilter=Self.poiFilter(poiCategories)
            if #available(macOS 15, *){
                var filters:[String:Any]=[:]
                if let addressInclude{filters["address_include"]=addressInclude}
                if let addressExclude{filters["address_exclude"]=addressExclude}
                completer.addressFilter=Self.addressFilter(filters)
            }
            if let raw=resultTypes{
                var types:MKLocalSearchCompleter.ResultType=[]
                for token in raw.split(separator:","){
                    switch token.trimmingCharacters(in:.whitespacesAndNewlines){
                    case "address":types.insert(.address)
                    case "pointOfInterest":types.insert(.pointOfInterest)
                    case "physicalFeature":if #available(macOS 15, *){types.insert(.physicalFeature)}
                    default:break
                    }
                }
                completer.resultTypes=types
            }
            work.keep(delegate,cancel:{},busy:{false})
            work.keep(completer,cancel:{completer.cancel();completer.delegate=nil},busy:{completer.isSearching})
            guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map completion was revoked before native query"));return}
            completer.queryFragment = query
        }
    }

    private func directions(_ action: [String: Any], work:MapsWork,completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let from = action["from"] as? String,
              let to = action["to"] as? String
        else { completion(WireFormat.error("maps.directions: requires --from and --to")); return }
        let transport = transportType((action["transport"] as? String) ?? "auto")
        let alts = (action["requests_alternates"] as? Bool) ?? false
        Task { @MainActor in
            let src = await self.resolveAsync(from,work:work)
            let dst = await self.resolveAsync(to,work:work)
            guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map route was revoked before native dispatch"));return}
            guard let src = src else { completion(WireFormat.error("maps.directions: cannot resolve --from")); return }
            guard let dst = dst else { completion(WireFormat.error("maps.directions: cannot resolve --to")); return }
            let req = MKDirections.Request()
            req.source = src
            req.destination = dst
            req.transportType = transport
            req.requestsAlternateRoutes = alts
            let mk = MKDirections(request: req)
            work.keep(mk,cancel:{mk.cancel()},busy:{mk.isCalculating})
            guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map route was revoked before native calculation"));return}
            do {
                let response = try await mk.calculate()
                guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map route reply was revoked"));return}
                guard response.routes.prefix(3).allSatisfy({$0.steps.count<=4096 && $0.advisoryNotices.count<=64})else{completion(WireFormat.failure("resource_limit","native route instructions exceed their bounds"));return}
                let routes: [[String: Any]] = response.routes.prefix(3).map { r in
                    [
                        "name": r.name,
                        "distance": r.distance,
                        "expectedTravelTime": r.expectedTravelTime,
                        "transportType": NativeNames.name(Int(r.transportType.rawValue), NativeNames.transport),
                        "advisoryNotices": r.advisoryNotices,
                        "hasTolls": r.hasTolls,
                        "steps": r.steps.map { ["instructions": $0.instructions, "distance": $0.distance] },
                    ]
                }
                completion(WireFormat.success([
                    "transport": NativeNames.name(Int(transport.rawValue), NativeNames.transport),
                    "routes": routes,
                    "source": self.mapItemDict(src),
                    "destination": self.mapItemDict(dst),
                    "partial":response.routes.count>3,
                ]))
            } catch {
                completion(WireFormat.error("maps.directions: \(error.localizedDescription)"))
            }
        }
    }

    private func eta(_ action: [String: Any], work:MapsWork,completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let from = action["from"] as? String,
              let to = action["to"] as? String
        else { completion(WireFormat.error("maps.eta: requires --from and --to")); return }
        let transport = transportType((action["transport"] as? String) ?? "auto")
        Task { @MainActor in
            let src = await self.resolveAsync(from,work:work)
            let dst = await self.resolveAsync(to,work:work)
            guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map estimate was revoked before native dispatch"));return}
            guard let src = src else { completion(WireFormat.error("maps.eta: cannot resolve --from")); return }
            guard let dst = dst else { completion(WireFormat.error("maps.eta: cannot resolve --to")); return }
            let req = MKDirections.Request()
            req.source = src
            req.destination = dst
            req.transportType = transport
            let mk = MKDirections(request: req)
            // isCalculating stays true after calculateETA() has returned, so each eta kept its admission slot
            // until four filled and every maps call refused (live check, macOS 27). Once the call has returned
            // there is nothing left to wait for.
            let returned = AtomicFlag()
            work.keep(mk,cancel:{mk.cancel()},busy:{!returned.isSet && mk.isCalculating})
            guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map estimate was revoked before native calculation"));return}
            do {
                defer { _ = returned.set() }
                let response = try await mk.calculateETA()
                guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map estimate reply was revoked"));return}
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime]
                completion(WireFormat.success([
                    "transport": NativeNames.name(Int(transport.rawValue), NativeNames.transport),
                    "expectedTravelTime": response.expectedTravelTime,
                    "distance": response.distance,
                    "expectedDepartureDate": f.string(from: response.expectedDepartureDate),
                    "expectedArrivalDate":   f.string(from: response.expectedArrivalDate),
                ]))
            } catch {
                completion(WireFormat.error("maps.eta: \(error.localizedDescription)"))
            }
        }
    }

    @MainActor
    private func resolveAsync(_ value: String,work:MapsWork) async -> MKMapItem? {
        guard work.awaitingReply else{return nil}
        if let item = mapItemCache.get(value) { return item }
        if value.range(of:"^B-([0-9]+|[0-9A-Fa-f-]{36}|[0-9A-Fa-f]{64})$",options:.regularExpression) != nil{return nil}
        if let parts=LocationDomain.coordinates(value){
            let coord = CLLocationCoordinate2D(latitude: parts[0], longitude: parts[1])
            return MKMapItem(placemark: MKPlacemark(coordinate: coord))
        }
        let geocoder=CLGeocoder()
        work.keep(geocoder,cancel:{geocoder.cancelGeocode()},busy:{geocoder.isGeocoding})
        guard work.awaitingReply else{return nil}
        return await withCheckedContinuation { (cont: CheckedContinuation<MKMapItem?, Never>) in
            geocoder.geocodeAddressString(value) { placemarks, _ in
                if work.awaitingReply,let p = placemarks?.first, let c = p.location?.coordinate,CLLocationCoordinate2DIsValid(c) {
                    let mk = MKPlacemark(coordinate: c, addressDictionary: nil)
                    cont.resume(returning: MKMapItem(placemark: mk))
                } else {
                    cont.resume(returning: nil)
                }
            }
        }
    }

    private func transportType(_ s: String) -> MKDirectionsTransportType {
        switch s {
        case "walking": return .walking
        case "transit": return .transit
        case "any":     return .any
        default:        return .automobile
        }
    }

    private func mapItemOpen(_ action: [String: Any],work:MapsWork,completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let id = action["id"] as? String, let item = mapItemCache.get(id) else {
            completion(WireFormat.error("maps.mapitem-open: unknown id (call maps search first)")); return
        }
        DispatchQueue.main.async {
            guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map launch was revoked before native dispatch"));return}
            if item.openInMaps(launchOptions:nil){completion(WireFormat.success(["ok":true,"id":id]))}else{completion(WireFormat.failure("provider_failed","native Maps application refused the retained map item"))}
        }
    }

    private func reverse(_ action: [String: Any], work:MapsWork,completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let coords = action["coords"] as? String else {
            completion(WireFormat.error("maps.reverse: requires <lat,lng>")); return
        }
        guard let parts=LocationDomain.coordinates(coords)else{
            completion(WireFormat.error("maps.reverse: --coords must be lat,lng")); return
        }
        let loc = CLLocation(latitude: parts[0], longitude: parts[1])
        let geocoder=CLGeocoder()
        work.keep(geocoder,cancel:{geocoder.cancelGeocode()},busy:{geocoder.isGeocoding})
        guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map reverse was revoked before native dispatch"));return}
        geocoder.reverseGeocodeLocation(loc) { placemarks, error in
            guard work.awaitingReply else{completion(WireFormat.failure("cancelled","map reverse reply was revoked"));return}
            if let error = error, !LocationDomain.noMatch(error) { completion(WireFormat.failure("provider_failed",String(error.localizedDescription.prefix(1000)))); return }
            let pms = (placemarks ?? []).prefix(32).map { (cp: CLPlacemark) -> [String: Any] in
                var out: [String: Any] = [
                    "name": cp.name as Any? ?? NSNull(),
                ]
                if let coordinate=cp.location?.coordinate{out["coordinate"]=[coordinate.latitude,coordinate.longitude]}
                if let v = cp.thoroughfare { out["thoroughfare"] = v }
                if let v = cp.subThoroughfare { out["subThoroughfare"] = v }
                if let v = cp.locality { out["locality"] = v }
                if let v = cp.subLocality { out["subLocality"] = v }
                if let v = cp.administrativeArea { out["administrativeArea"] = v }
                if let v = cp.subAdministrativeArea { out["subAdministrativeArea"] = v }
                if let v = cp.postalCode { out["postalCode"] = v }
                if let v = cp.isoCountryCode { out["isoCountryCode"] = v }
                if let v = cp.country { out["country"] = v }
                return out
            }
            completion(WireFormat.success([
                "coordinate": [parts[0], parts[1]],
                "placemarks": pms,
            ]))
        }
    }
}

final class MapsWork:@unchecked Sendable{
    let id=UUID()
    private let lock=NSLock()
    private var completion:(@Sendable ([String:Any])->Void)?
    private var objects:[AnyObject]=[]
    private var cancelers:[()->Void]=[]
    private var observers:[()->Bool]=[]
    init(completion:@escaping @Sendable ([String:Any])->Void){self.completion=completion}
    var awaitingReply:Bool{lock.lock();defer{lock.unlock()};return completion != nil}
    @discardableResult func reply(_ result:[String:Any])->Bool{lock.lock();let callback=completion;completion=nil;lock.unlock();callback?(result);return callback != nil}
    func keep(_ object:AnyObject,cancel:@escaping ()->Void,busy:@escaping ()->Bool){objects.append(object);cancelers.append(cancel);observers.append(busy)}
    func cancel(){for cancel in cancelers{cancel()}}
    func busy()->Bool{observers.contains{$0()}}
    func clear(){cancelers.removeAll();observers.removeAll();objects.removeAll()}
}

final class MapItemCache: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: (item:MKMapItem,at:TimeInterval)] = [:]
    private var order:[String]=[]
    private let clock:()->TimeInterval
    init(clock:@escaping ()->TimeInterval={ProcessInfo.processInfo.systemUptime}){self.clock=clock}
    func put(_ item: MKMapItem) -> String {
        lock.lock(); defer { lock.unlock() }
        let now=clock()
        order.removeAll{now-(items[$0]?.at ?? 0)>300};items=items.filter{order.contains($0.key)}
        if order.count==128{items.removeValue(forKey:order.removeFirst())}
        let id = "B-\(UUID().uuidString)"
        items[id] = (item,now);order.append(id)
        return id
    }
    func get(_ id: String) -> MKMapItem? {
        lock.lock(); defer { lock.unlock() }
        guard let entry=items[id],clock()-entry.at<=300 else{items.removeValue(forKey:id);order.removeAll{$0==id};return nil}
        return entry.item
    }
}

final class CompleterDelegate: NSObject, MKLocalSearchCompleterDelegate, @unchecked Sendable {
    private let onResult: ([MKLocalSearchCompletion],Error?) -> Void
    private let fired=AtomicFlag()
    init(onResult: @escaping ([MKLocalSearchCompletion],Error?) -> Void) { self.onResult = onResult }
    func fire(with results: [MKLocalSearchCompletion],error:Error?=nil) {
        guard fired.set()else{return}
        onResult(results,error)
    }
    func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        fire(with: completer.results)
    }
    func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
        fire(with: [],error:error)
    }
}
