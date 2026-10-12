// MusicKit. Catalog macOS 12+; library + ApplicationMusicPlayer
// macOS 14+. SystemMusicPlayer is iOS-only — bridge surfaces a structured note.
// References: apple-developer-docs/MusicKit/{MusicCatalogSearchRequest,
// MusicLibraryRequest,ApplicationMusicPlayer,MusicAuthorization,Song,Album,...}.md.

import Foundation
import AppKit
import Carbon
#if canImport(MusicKit)
import MusicKit
#endif

final class MusicDomain: DomainHandler, @unchecked Sendable {
    private let requestLock=NSLock()
    private var requestId:UUID?
    private var requestRevoked=false
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var canonical=action;canonical["type"]="desktop_music";canonical["sub"]=action["sub"] as? String ?? command
        if let error=Self.validationError(canonical){completion(WireFormat.failure("invalid_request",error));return}
        let id=UUID()
        requestLock.lock();let admitted = requestId==nil;if admitted{requestId=id;requestRevoked=false};requestLock.unlock()
        guard admitted else{completion(WireFormat.failure("resource_limit","another Music request or its native completion is active; no work queued"));return}
        let once=AtomicFlag(),box=UncheckedSendableBox(canonical)
        let finish:@Sendable ([String:Any])->Void={result in
            let invalid=Self.resultError(result,action:box.value)
            self.requestLock.lock();if self.requestId==id{self.requestId=nil};self.requestLock.unlock()
            if once.set(){completion(invalid.map{WireFormat.failure("provider_failed",$0)} ?? result)}
        }
        DispatchQueue.global().asyncAfter(deadline:.now()+30){
            self.requestLock.lock();if self.requestId==id{self.requestRevoked=true};self.requestLock.unlock()
            if once.set(){completion(WireFormat.failure("timeout_unknown_outcome","Music exceeded its reply deadline; native work remains owned until actual completion and was not replayed"))}
        }
        DispatchQueue.main.async{
            guard !self.isRevoked()else{finish(WireFormat.failure("cancelled","Music request was revoked before native dispatch"));return}
            self.dispatch(command,action:box.value,completion:finish)
        }
    }
    private func isRevoked()->Bool{requestLock.lock();defer{requestLock.unlock()};return requestId==nil || requestRevoked}
    static func resultError(_ response:[String:Any],action:[String:Any])->String?{
        guard response["success"] as? Bool == true else{return nil}
        guard let data=response["data"] as? [String:Any],let bytes=try? JSONSerialization.data(withJSONObject:data),bytes.count<=1_048_576 else{return "Music response exceeds finite 1MiB JSON"}
        do{
            let d=JSONDecoder()
            if data["available"] != nil{_ = try d.decode(DesktopMusicUnavailable.self,from:bytes)}else{
                switch action["sub"] as? String{
                case "status":_ = try d.decode(DesktopMusicStatus.self,from:bytes)
                case "request":_ = try d.decode(DesktopMusicAuthorization.self,from:bytes)
                case "subscription":_ = try d.decode(DesktopMusicSubscription.self,from:bytes)
                case "library":_ = try d.decode(DesktopMusicLibrary.self,from:bytes)
                case "library-search","search":_ = try d.decode(DesktopMusicSearch.self,from:bytes)
                case "search-suggest":_ = try d.decode(DesktopMusicSuggestions.self,from:bytes)
                case "charts":_ = try d.decode(DesktopMusicCharts.self,from:bytes)
                case "recommendations":_ = try d.decode(DesktopMusicRecommendations.self,from:bytes)
                case "song","album","artist","playlist":_ = try d.decode(DesktopMusicItem.self,from:bytes)
                case "queue":_ = try d.decode(DesktopMusicQueue.self,from:bytes)
                case "repeat":_ = try d.decode(DesktopMusicRepeat.self,from:bytes)
                case "shuffle":_ = try d.decode(DesktopMusicShuffle.self,from:bytes)
                case "now-playing":_ = try d.decode(DesktopMusicPlaying.self,from:bytes)
                default:_ = try d.decode(DesktopMusicAck.self,from:bytes)
                }
            }
        }catch{return "native Music response does not match its typed contract"}
        func valid(_ value:Any,key:String="")->Bool{
            if value is NSNull{return ["playbackTime","playbackRate"].contains(key)}
            if let text=value as? String{return text.utf8.count<=(key=="id" ? 1024:4096) && !text.contains("\0")}
            if let n=value as? NSNumber{return n.doubleValue.isFinite && (!["playbackTime","playbackRate","queueLength"].contains(key)||n.doubleValue>=0)}
            if let list=value as? [Any]{let max=["items","songs","albums","artists","playlists","topResults"].contains(key) ? (action["limit"] as? Int ?? 32):2000;return list.count<=max && list.allSatisfy{valid($0)}}
            if let object=value as? [String:Any]{
                if let id=object["id"] as? String,id.isEmpty || !(object["title"] is String || object["name"] is String){return false}
                return object.allSatisfy{valid($0.value,key:$0.key)}
            }
            return false
        }
        guard valid(data)else{return "Music output exceeds valid text, collection or numeric bounds"}
        if data["available"] != nil,data["available"] as? Bool != false{return "unavailable Music reply cannot claim availability"}
        if data["ok"] != nil,data["ok"] as? Bool != true{return "successful Music control reply requires native acceptance"}
        if let entries=data["entries"] as? [Any],data["count"] as? Int != entries.count{return "Music queue count does not match actual entries"}
        if let count=data["queueLength"] as? Double,count.rounded() != count || count>2000{return "invalid bounded Music queue length"}
        if ["library-search","search"].contains(action["sub"] as? String ?? ""),data["term"] != nil,data["term"] as? String != action["term"] as? String{return "Music search receipt does not match its term"}
        return nil
    }
    static func validationError(_ a:[String:Any])->String?{
        if let error=DesktopMusicShape.validationError(a){return error}
        let sub=a["sub"] as! String
        let fields:[String:[String]]=["status":[],"request":[],"subscription":[],"library":["kind","limit","offset","filter","sort","ascending","include_tracks"],"library-search":["term","types","limit","top","include_tracks"],"play":["song","album","playlist"],"pause":[],"resume":[],"stop":[],"next":[],"previous":[],"seek":["time"],"queue":[],"repeat":["mode"],"shuffle":["mode"],"now-playing":["include_system"],"search":["term","types","limit","offset","top"],"search-suggest":["term"],"charts":["limit"],"recommendations":[],"song":["id"],"album":["id"],"artist":["id"],"playlist":["id"]]
        let allowed=["type","sub","group","groupColor","groupSoft"]+(fields[sub] ?? [])
        if a.keys.contains(where:{!allowed.contains($0)}){return "field does not belong to this Music selector"}
        func bounded(_ value:Any?,_ max:Int)->Bool{guard let text=value as? String else{return false};return !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && text.utf8.count<=max && !text.contains("\0")}
        for key in ["group","groupColor"]{if a[key] != nil && !bounded(a[key],256){return "invalid bounded Music group metadata"}}
        for key in ["term","filter"]{if a[key] != nil && !bounded(a[key],4096){return "invalid bounded Music query"}}
        if ["library-search","search","search-suggest"].contains(sub) && !bounded(a["term"],4096){return "Music \(sub) requires its term"}
        if ["song","album","artist","playlist"].contains(sub) && !bounded(a["id"],1024){return "Music \(sub) requires its Apple Music catalog id"}
        for (key,min,max) in [("limit",1.0,100.0),("offset",0.0,10000.0),("time",0.0,604800.0)]{
            if let value=a[key]{guard let number=value as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID(),number.doubleValue.isFinite,number.doubleValue>=min,number.doubleValue<=max,key=="time" || number.doubleValue.rounded()==number.doubleValue else{return "invalid bounded numeric Music field"}}
        }
        if sub=="seek" && a["time"]==nil{return "Music seek requires its time"}
        if let types=a["types"] as? String,types.utf8.count>128 || types.split(separator:",",omittingEmptySubsequences:false).contains(where:{!["song","album","artist","playlist"].contains($0.trimmingCharacters(in:.whitespacesAndNewlines))}){return "unknown Music search types"}
        if let sort=a["sort"] as? String,!["title","name","artistName"].contains(sort){return "unknown Music sort field"}
        if sub=="library",let sort=a["sort"] as? String,(["artist","playlist"].contains(a["kind"] as? String ?? "song") ? sort != "name":!["title","artistName"].contains(sort)){return "Music sort does not belong to its library kind"}
        if sub=="library",a["include_tracks"] as? Bool == true,!["album","playlist"].contains(a["kind"] as? String ?? "song"){return "Music include-tracks requires an album or playlist library"}
        if a["ascending"] != nil && a["sort"]==nil{return "Music ascending requires its sort field"}
        if sub=="play"{let targets=["song","album","playlist"].filter{a[$0] != nil};if targets.count != 1 || !bounded(a[targets.first ?? ""],1024){return "Music play requires exactly one library item id"}}
        if sub=="repeat" && !["off","one","all"].contains(a["mode"] as? String ?? ""){return "invalid Music repeat mode"}
        if sub=="shuffle" && !["off","songs"].contains(a["mode"] as? String ?? ""){return "invalid Music shuffle mode"}
        return nil
    }
    private func dispatch(_ command:String,action:[String:Any],completion:@escaping @Sendable ([String:Any])->Void){
        let sub = action["sub"] as? String ?? command
        if #available(macOS 12, *) {
            switch sub {
            case "status":              status(completion: completion)
            case "request":              requestAuth(completion: completion)
            case "subscription":        subscription(completion: completion)
            // Catalog verbs: MusicKit generates the developer token itself once the MusicKit App
            // Service is enabled on this App ID; catalogFailure says when it is not.
            case "search":              search(action, completion: completion)
            case "search-suggest":      searchSuggest(action, completion: completion)
            case "charts":              charts(action, completion: completion)
            case "recommendations":     recommendations(completion: completion)
            case "song", "album", "artist", "playlist": fetchById(action, completion: completion, kind: sub)
            case "library":             library(action, completion: completion)
            case "library-search":      librarySearch(action, completion: completion)
            case "play":                play(action, completion: completion)
            case "pause":               pause(completion: completion)
            case "resume":              resume(completion: completion)
            case "stop":                stopPlayback(completion: completion)
            case "next":                next(completion: completion)
            case "previous":            previous(completion: completion)
            case "seek":                seek(action, completion: completion)
            case "queue":               queueSnapshot(completion: completion)
            case "repeat":              setRepeat(action, completion: completion)
            case "shuffle":             setShuffle(action, completion: completion)
            case "now-playing":         nowPlaying(includeSystem:action["include_system"] as? Bool ?? false,completion: completion)
            default:                    completion(WireFormat.error("music.\(sub) — unknown verb"))
            }
        } else {
            completion(WireFormat.success([
                "available": false,
                "framework": "MusicKit",
                "note": "MusicKit catalog requires macOS 12.0+ (library + ApplicationMusicPlayer macOS 14+).",
            ]))
        }
    }

    // MARK: - Auth / status

    @available(macOS 12, *)
    private func status(completion: @escaping @Sendable ([String: Any]) -> Void) {
        var resp: [String: Any] = [
            "authorization": Self.authorizationName(MusicAuthorization.currentStatus),
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
            "frameworkAvailable": true,
        ]
        if #available(macOS 14, *) {
            resp["applicationPlayerAvailable"] = true
            resp["libraryAvailable"] = true
        } else {
            resp["applicationPlayerAvailable"] = false
            resp["libraryAvailable"] = false
        }
        completion(WireFormat.success(resp))
    }

    // The word, not Swift's ".authorized".
    @available(macOS 12, *)
    static func authorizationName(_ status: MusicAuthorization.Status) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        @unknown default: return "unknown"
        }
    }

    @available(macOS 12, *)
    static func playbackName(_ status: MusicPlayer.PlaybackStatus) -> String {
        switch status {
        case .stopped: return "stopped"
        case .playing: return "playing"
        case .paused: return "paused"
        case .interrupted: return "interrupted"
        case .seekingForward: return "seekingForward"
        case .seekingBackward: return "seekingBackward"
        @unknown default: return "unknown"
        }
    }

    @available(macOS 12, *)
    private func requestAuth(completion: @escaping @Sendable ([String: Any]) -> Void) {
        Task {
            guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music request was revoked before native async work"));return}
            let s = await MusicAuthorization.request()
            completion(WireFormat.success(["authorization": Self.authorizationName(s)]))
        }
    }

    @available(macOS 12, *)
    private func subscription(completion: @escaping @Sendable ([String: Any]) -> Void) {
        Task {
            guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music request was revoked before native async work"));return}
            do {
                let sub = try await MusicSubscription.current
                completion(WireFormat.success([
                    "canBecomeSubscriber": sub.canBecomeSubscriber,
                    "canPlayCatalogContent": sub.canPlayCatalogContent,
                    "hasCloudLibraryEnabled": sub.hasCloudLibraryEnabled,
                ]))
            } catch {
                completion(Self.catalogFailure("subscription",error))
            }
        }
    }

    // MARK: - Search

    @available(macOS 12, *)
    static func catalogFailure(_ sub:String,_ error:Error)->[String:Any]{
        switch error as? MusicSubscription.Error{
        case .privacyAcknowledgementRequired?:return catalogFailure(sub,MusicTokenRequestError.privacyAcknowledgementRequired)
        case .permissionDenied?:return catalogFailure(sub,MusicTokenRequestError.permissionDenied)
        default:break
        }
        switch error as? MusicTokenRequestError{
        case .developerTokenRequestFailed?:
            return WireFormat.failure("permission_required","music \(sub): MusicKit could not get an Apple Music developer token for com.interceptor.bridge, so nothing was requested. MusicKit makes that token itself only when the MusicKit App Service is enabled on that App ID (team TPWBZD35WW: Certificates, Identifiers & Profiles > Identifiers > com.interceptor.bridge > App Services > MusicKit); no rebuild is needed after it is enabled")
        case .permissionDenied?,.userTokenRevoked?:
            return WireFormat.failure("permission_denied","music \(sub): Apple Music access is off for Interceptor; allow interceptor-bridge in System Settings > Privacy & Security > Media & Apple Music")
        case .privacyAcknowledgementRequired?:
            return WireFormat.failure("permission_required","music \(sub): Apple Music privacy acknowledgement required: accept Apple Music's latest privacy policy in the Music app on this Mac first")
        case .userNotSignedIn?:
            return WireFormat.failure("permission_required","music \(sub): no Apple Account is signed in to Apple Music on this Mac")
        default:
            return WireFormat.failure("provider_failed","music \(sub): \(String(error.localizedDescription.prefix(1000)))")
        }
    }

    @available(macOS 12, *)
    private func parseTypes(_ raw: String?) -> [any MusicCatalogSearchable.Type] {
        let defaults: [any MusicCatalogSearchable.Type] = [Song.self, Album.self, Artist.self, Playlist.self]
        guard let raw = raw else { return defaults }
        var out: [any MusicCatalogSearchable.Type] = []
        for t in raw.split(separator: ",") {
            switch t.trimmingCharacters(in: .whitespaces) {
            case "song":     out.append(Song.self)
            case "album":    out.append(Album.self)
            case "artist":   out.append(Artist.self)
            case "playlist": out.append(Playlist.self)
            case "curator":  out.append(Curator.self)
            // `Genre` does not conform to MusicCatalogSearchable on macOS;
            // omitted to keep the set type-correct.
            default: break
            }
        }
        return out.isEmpty ? defaults : out
    }

    @available(macOS 12, *)
    private func search(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let term = action["term"] as? String else { completion(WireFormat.error("music.search: <term> required")); return }
        var request = MusicCatalogSearchRequest(term: term, types: parseTypes(action["types"] as? String))
        if let limit = action["limit"] as? Int { request.limit = limit }
        if let offset = action["offset"] as? Int { request.offset = offset }
        if (action["top"] as? Bool) == true { request.includeTopResults = true }
        Task {
            guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music request was revoked before native async work"));return}
            do {
                let response = try await request.response()
                completion(WireFormat.success([
                    "term": term,
                    "songs":     response.songs.map { ["id": $0.id.rawValue, "title": $0.title, "artistName": $0.artistName] },
                    "albums":    response.albums.map { ["id": $0.id.rawValue, "title": $0.title, "artistName": $0.artistName] },
                    "artists":   response.artists.map { ["id": $0.id.rawValue, "name": $0.name] },
                    "playlists": response.playlists.map { ["id": $0.id.rawValue, "name": $0.name] },
                ]))
            } catch {
                completion(Self.catalogFailure("search",error))
            }
        }
    }

    @available(macOS 12, *)
    private func searchSuggest(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let term = action["term"] as? String else { completion(WireFormat.error("music.search-suggest: <term> required")); return }
        let request = MusicCatalogSearchSuggestionsRequest(term: term, includingTopResultsOfTypes: [Song.self, Album.self, Artist.self])
        Task {
            guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music request was revoked before native async work"));return}
            do {
                let response = try await request.response()
                completion(WireFormat.success([
                    "term": term,
                    "suggestions": response.suggestions.map { $0.displayTerm },
                ]))
            } catch {
                completion(Self.catalogFailure("search-suggest",error))
            }
        }
    }

    @available(macOS 12, *)
    private func charts(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        var request = MusicCatalogChartsRequest(kinds: [.mostPlayed], types: [Song.self, Album.self])
        let limit = (action["limit"] as? Int) ?? 32
        request.limit = limit
        Task {
            guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music request was revoked before native async work"));return}
            do {
                let response = try await request.response()
                completion(WireFormat.success([
                    "songCharts": response.songCharts.map { ["title": $0.title, "items": $0.items.prefix(limit).map { ["id": $0.id.rawValue, "title": $0.title, "artistName": $0.artistName] }] },
                    "albumCharts": response.albumCharts.map { ["title": $0.title, "items": $0.items.prefix(limit).map { ["id": $0.id.rawValue, "title": $0.title, "artistName": $0.artistName] }] },
                ]))
            } catch {
                completion(Self.catalogFailure("charts",error))
            }
        }
    }

    @available(macOS 12, *)
    private func recommendations(completion: @escaping @Sendable ([String: Any]) -> Void) {
        Task {
            guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music request was revoked before native async work"));return}
            do {
                let request = MusicPersonalRecommendationsRequest()
                let response = try await request.response()
                completion(WireFormat.success([
                    "recommendations": response.recommendations.map { ["id": $0.id.rawValue, "title": $0.title ?? ""] },
                ]))
            } catch {
                completion(Self.catalogFailure("recommendations",error))
            }
        }
    }

    // MARK: - Library

    @available(macOS 14, *)
    private func libraryItem(_ item:any MusicItem,includeTracks:Bool) async throws->[String:Any]{
        guard !isRevoked()else{throw NSError(domain:"InterceptorMusic",code:1,userInfo:[NSLocalizedDescriptionKey:"Music metadata request was revoked"])}
        var row:[String:Any],tracks:MusicItemCollection<Track>?
        switch item{
        case let value as Song:row=["id":value.id.rawValue,"title":value.title,"artistName":value.artistName]
        case let value as Album:
            row=["id":value.id.rawValue,"title":value.title,"artistName":value.artistName]
            if includeTracks{tracks=try await value.with([.tracks],preferredSource:.library).tracks}
        case let value as Artist:row=["id":value.id.rawValue,"name":value.name]
        case let value as Playlist:
            row=["id":value.id.rawValue,"name":value.name]
            if includeTracks{tracks=try await value.with([.tracks],preferredSource:.library).tracks}
        case let value as Track:row=["id":value.id.rawValue,"title":value.title]
        case let value as MusicVideo:row=["id":value.id.rawValue,"title":value.title,"artistName":value.artistName]
        case let value as MusicLibrarySearchResponse.TopResult:
            switch value{
            case .album(let item):return try await libraryItem(item,includeTracks:includeTracks)
            case .artist(let item):return try await libraryItem(item,includeTracks:includeTracks)
            case .musicVideo(let item):return try await libraryItem(item,includeTracks:includeTracks)
            case .playlist(let item):return try await libraryItem(item,includeTracks:includeTracks)
            case .song(let item):return try await libraryItem(item,includeTracks:includeTracks)
            @unknown default:throw NSError(domain:"InterceptorMusic",code:2,userInfo:[NSLocalizedDescriptionKey:"Unknown native Music item"])
            }
        default:throw NSError(domain:"InterceptorMusic",code:2,userInfo:[NSLocalizedDescriptionKey:"Unknown native Music item"])
        }
        if includeTracks && (item is Album || item is Playlist){
            guard let tracks,tracks.count<=2000 else{throw NSError(domain:"InterceptorMusic",code:3,userInfo:[NSLocalizedDescriptionKey:"Native Music track relationship is absent or exceeds 2000 entries"])}
            row["tracks"]=tracks.map{["id":$0.id.rawValue,"title":$0.title]}
        }
        return row
    }
    @available(macOS 14, *)
    private func libraryRows<Item:MusicItem>(_ collection:MusicItemCollection<Item>,limit:Int,includeTracks:Bool) async throws->[[String:Any]]{
        var rows:[[String:Any]]=[],trackCount=0
        for item in collection.prefix(limit){let row=try await libraryItem(item,includeTracks:includeTracks);trackCount+=(row["tracks"] as? [Any])?.count ?? 0
            guard trackCount<=2000 else{throw NSError(domain:"InterceptorMusic",code:3,userInfo:[NSLocalizedDescriptionKey:"Native Music reply exceeds 2000 track entries"])};rows.append(row)}
        return rows
    }

    @available(macOS 14, *)
    private func libraryV14(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let type = (action["kind"] as? String) ?? "song"
        let limit = (action["limit"] as? Int) ?? 32
        let offset = (action["offset"] as? Int) ?? 0
        let filter = action["filter"] as? String
        let includeTracks = (action["include_tracks"] as? Bool) ?? false
        let sort=action["sort"] as? String,ascending=(action["ascending"] as? Bool) ?? true
        if let sort,(["artist","playlist"].contains(type) ? sort != "name":!["title","artistName"].contains(sort)){completion(WireFormat.failure("invalid_request","Music sort field does not belong to its library kind"));return}
        Task {
            guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music request was revoked before native async work"));return}
            do {
                switch type {
                case "song":
                    var req = MusicLibraryRequest<Song>()
                    if sort=="title"{req.sort(by:\.title,ascending:ascending)}else if sort=="artistName"{req.sort(by:\.artistName,ascending:ascending)}
                    req.limit = limit
                    req.offset = offset
                    if let text=filter{req.filter(text:text)}
                    let response = try await req.response()
                    let items=try await self.libraryRows(response.items,limit:limit,includeTracks:includeTracks)
                    completion(WireFormat.success(["items":items]))
                case "album":
                    var req = MusicLibraryRequest<Album>()
                    if sort=="title"{req.sort(by:\.title,ascending:ascending)}else if sort=="artistName"{req.sort(by:\.artistName,ascending:ascending)}
                    req.limit = limit
                    req.offset = offset
                    if let text=filter{req.filter(text:text)}
                    let response = try await req.response()
                    let items=try await self.libraryRows(response.items,limit:limit,includeTracks:includeTracks)
                    completion(WireFormat.success(["items":items]))
                case "artist":
                    var req = MusicLibraryRequest<Artist>()
                    if sort=="name"{req.sort(by:\.name,ascending:ascending)}
                    req.limit = limit
                    req.offset = offset
                    if let text=filter{req.filter(text:text)}
                    let response = try await req.response()
                    let items=try await self.libraryRows(response.items,limit:limit,includeTracks:includeTracks)
                    completion(WireFormat.success(["items":items]))
                case "playlist":
                    var req = MusicLibraryRequest<Playlist>()
                    if sort=="name"{req.sort(by:\.name,ascending:ascending)}
                    req.limit = limit
                    req.offset = offset
                    if let text=filter{req.filter(text:text)}
                    let response = try await req.response()
                    let items=try await self.libraryRows(response.items,limit:limit,includeTracks:includeTracks)
                    completion(WireFormat.success(["items":items]))
                case "track":
                    var req = MusicLibraryRequest<Track>()
                    if sort=="title"{req.sort(by:\.title,ascending:ascending)}else if sort=="artistName"{req.sort(by:\.artistName,ascending:ascending)}
                    req.limit = limit
                    req.offset = offset
                    if let text=filter{req.filter(text:text)}
                    let response = try await req.response()
                    let items=try await self.libraryRows(response.items,limit:limit,includeTracks:includeTracks)
                    completion(WireFormat.success(["items":items]))
                default:
                    completion(WireFormat.error("music.library: unknown --type"))
                }
            } catch {
                completion(WireFormat.error("music.library: \(error.localizedDescription)"))
            }
        }
    }

    @available(macOS 12, *)
    private func library(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) { libraryV14(action, completion: completion); return }
        completion(WireFormat.success(["available": false, "note": "MusicLibraryRequest requires macOS 14+"]))
    }

    @available(macOS 14, *)
    private func librarySearchV14(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let term = action["term"] as? String else { completion(WireFormat.error("music.library-search: <term> required")); return }
        var types:[any MusicLibrarySearchable.Type]=[]
        for token in ((action["types"] as? String) ?? "song,album,artist,playlist").split(separator:","){
            switch token.trimmingCharacters(in:.whitespacesAndNewlines){case "song":types.append(Song.self);case "album":types.append(Album.self);case "artist":types.append(Artist.self);case "playlist":types.append(Playlist.self);default:break}
        }
        var request = MusicLibrarySearchRequest(term: term, types: types)
        let limit=(action["limit"] as? Int) ?? 32
        let tracks=(action["include_tracks"] as? Bool) ?? false
        let includeTopResults=(action["top"] as? Bool) ?? false
        request.limit = limit
        request.includeTopResults = includeTopResults
        Task {
            guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music request was revoked before native async work"));return}
            do {
                let response = try await request.response()
                var data:[String:Any]=[
                    "term":term,
                    "songs":try await self.libraryRows(response.songs,limit:limit,includeTracks:tracks),
                    "albums":try await self.libraryRows(response.albums,limit:limit,includeTracks:tracks),
                    "artists":try await self.libraryRows(response.artists,limit:limit,includeTracks:tracks),
                    "playlists":try await self.libraryRows(response.playlists,limit:limit,includeTracks:tracks)]
                if includeTopResults{data["topResults"]=try await self.libraryRows(response.topResults,limit:limit,includeTracks:tracks)}
                completion(WireFormat.success(data))
            } catch {
                completion(WireFormat.error("music.library-search: \(error.localizedDescription)"))
            }
        }
    }

    @available(macOS 12, *)
    private func librarySearch(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) { librarySearchV14(action, completion: completion); return }
        completion(WireFormat.success(["available": false, "note": "MusicLibrarySearchRequest requires macOS 14+"]))
    }

    // MARK: - Resource fetch by id

    @available(macOS 12, *)
    private func fetchById(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void, kind: String) {
        guard let id = action["id"] as? String else { completion(WireFormat.error("music.\(kind): <id> required")); return }
        Task {
            guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music request was revoked before native async work"));return}
            do {
                switch kind {
                case "song":
                    let req = MusicCatalogResourceRequest<Song>(matching: \.id, equalTo: MusicItemID(id))
                    let resp = try await req.response()
                    if let s = resp.items.first {
                        var row: [String: Any] = ["id": s.id.rawValue, "title": s.title, "artistName": s.artistName, "genreNames": s.genreNames]
                        if let v = s.albumTitle { row["albumTitle"] = v }
                        if let v = s.duration { row["duration"] = v }
                        if let v = s.isrc { row["isrc"] = v }
                        completion(WireFormat.success(row))
                    } else { completion(WireFormat.failure("target_gone", "music song: no catalog song has id \(id)")) }
                case "album":
                    let req = MusicCatalogResourceRequest<Album>(matching: \.id, equalTo: MusicItemID(id))
                    let resp = try await req.response()
                    if let a = resp.items.first {
                        completion(WireFormat.success(["id": a.id.rawValue, "title": a.title, "artistName": a.artistName]))
                    } else { completion(WireFormat.failure("target_gone", "music album: no catalog album has id \(id)")) }
                case "artist":
                    let req = MusicCatalogResourceRequest<Artist>(matching: \.id, equalTo: MusicItemID(id))
                    let resp = try await req.response()
                    if let a = resp.items.first {
                        completion(WireFormat.success(["id": a.id.rawValue, "name": a.name]))
                    } else { completion(WireFormat.failure("target_gone", "music artist: no catalog artist has id \(id)")) }
                case "playlist":
                    let req = MusicCatalogResourceRequest<Playlist>(matching: \.id, equalTo: MusicItemID(id))
                    let resp = try await req.response()
                    if let p = resp.items.first {
                        completion(WireFormat.success(["id": p.id.rawValue, "name": p.name]))
                    } else { completion(WireFormat.failure("target_gone", "music playlist: no catalog playlist has id \(id)")) }
                default:
                    completion(WireFormat.error("music: unknown kind \(kind)"))
                }
            } catch {
                completion(Self.catalogFailure(kind,error))
            }
        }
    }

    // MARK: - Playback

    @available(macOS 14, *)
    private func playV14(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let songId = action["song"] as? String
        let albumId = action["album"] as? String
        let playlistId = action["playlist"] as? String
        Task {
            guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music request was revoked before native async work"));return}
            let player = ApplicationMusicPlayer.shared
            do {
                if let songId = songId {
                    var req = MusicLibraryRequest<Song>()
                    req.filter(matching: \.id,equalTo:MusicItemID(songId));req.limit=1
                    let resp = try await req.response()
                    guard let song = resp.items.first else { completion(WireFormat.error("music.play: song not found")); return }
                    guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music queue request was revoked before native assignment"));return}
                    player.queue = [song]
                } else if let albumId = albumId {
                    var req = MusicLibraryRequest<Album>()
                    req.filter(matching: \.id,equalTo:MusicItemID(albumId));req.limit=1
                    let resp = try await req.response()
                    guard let album = resp.items.first else { completion(WireFormat.error("music.play: album not found")); return }
                    guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music queue request was revoked before native assignment"));return}
                    player.queue = [album]
                } else if let playlistId = playlistId {
                    var req = MusicLibraryRequest<Playlist>()
                    req.filter(matching: \.id,equalTo:MusicItemID(playlistId));req.limit=1
                    let resp = try await req.response()
                    guard let p = resp.items.first else { completion(WireFormat.error("music.play: playlist not found")); return }
                    guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music queue request was revoked before native assignment"));return}
                    player.queue = [p]
                } else {
                    completion(WireFormat.error("music.play: --song / --album / --playlist required")); return
                }
                guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music playback was revoked before native play"));return}
                try await player.play()
                completion(WireFormat.success(["ok": true, "playbackStatus": Self.playbackName(player.state.playbackStatus)]))
            } catch {
                completion(WireFormat.error("music.play: \(error.localizedDescription)"))
            }
        }
    }

    @available(macOS 12, *)
    private func play(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) { playV14(action, completion: completion); return }
        completion(WireFormat.success(["available": false, "note": "ApplicationMusicPlayer requires macOS 14+"]))
    }

    @available(macOS 14, *)
    private func playerV14() -> ApplicationMusicPlayer { ApplicationMusicPlayer.shared }

    @available(macOS 12, *)
    private func pause(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) { playerV14().pause(); completion(WireFormat.success(["ok": true])); return }
        completion(WireFormat.success(["available": false]))
    }

    @available(macOS 12, *)
    private func resume(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) { Task { guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music playback was revoked before native dispatch"));return};do{try await playerV14().play(); completion(WireFormat.success(["ok": true]))}catch{completion(WireFormat.failure("provider_failed",String(error.localizedDescription.prefix(1000))))} }; return }
        completion(WireFormat.success(["available": false]))
    }

    @available(macOS 12, *)
    private func stopPlayback(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) { playerV14().stop(); completion(WireFormat.success(["ok": true])); return }
        completion(WireFormat.success(["available": false]))
    }

    @available(macOS 12, *)
    private func next(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) { Task { guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music playback was revoked before native dispatch"));return};do{try await playerV14().skipToNextEntry(); completion(WireFormat.success(["ok": true]))}catch{completion(WireFormat.failure("provider_failed",String(error.localizedDescription.prefix(1000))))} }; return }
        completion(WireFormat.success(["available": false]))
    }

    @available(macOS 12, *)
    private func previous(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) { Task { guard !self.isRevoked()else{completion(WireFormat.failure("cancelled","Music playback was revoked before native dispatch"));return};do{try await playerV14().skipToPreviousEntry(); completion(WireFormat.success(["ok": true]))}catch{completion(WireFormat.failure("provider_failed",String(error.localizedDescription.prefix(1000))))} }; return }
        completion(WireFormat.success(["available": false]))
    }

    @available(macOS 12, *)
    private func seek(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        guard let t = action["time"] as? Double else { completion(WireFormat.error("music.seek: --time <seconds> required")); return }
        if #available(macOS 14, *) {
            let p=playerV14();p.playbackTime = t
            completion(WireFormat.success(["ok": true, "playbackTime": p.playbackTime]))
        } else {
            completion(WireFormat.success(["available": false]))
        }
    }

    @available(macOS 12, *)
    private func queueSnapshot(completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) {
            let q = playerV14().queue
            guard q.entries.count<=2000 else{completion(WireFormat.failure("resource_limit","native Music queue exceeds 2000 entries"));return}
            let entries = q.entries.map { e -> [String: Any] in
                ["id": String(describing:e.id), "title": e.title]
            }
            completion(WireFormat.success(["entries": entries, "count": entries.count]))
        } else {
            completion(WireFormat.success(["available": false]))
        }
    }

    @available(macOS 12, *)
    private func setRepeat(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) {
            let mode = (action["mode"] as? String) ?? "off"
            let p = playerV14()
            switch mode {
            case "off": p.state.repeatMode = MusicPlayer.RepeatMode.none
            case "one": p.state.repeatMode = .one
            case "all": p.state.repeatMode = .all
            default: break
            }
            guard let observed=p.state.repeatMode else{completion(WireFormat.failure("provider_failed","native Music player has no observed repeat state"));return}
            completion(WireFormat.success(["repeatMode": observed == .none ? "off":observed == .one ? "one":"all"]))
        } else {
            completion(WireFormat.success(["available": false]))
        }
    }

    @available(macOS 12, *)
    private func setShuffle(_ action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) {
            let mode = (action["mode"] as? String) ?? "off"
            let p = playerV14()
            switch mode {
            case "off":   p.state.shuffleMode = .off
            case "songs": p.state.shuffleMode = .songs
            default: break
            }
            guard let observed=p.state.shuffleMode else{completion(WireFormat.failure("provider_failed","native Music player has no observed shuffle state"));return}
            completion(WireFormat.success(["shuffleMode": observed == .off ? "off":"songs"]))
        } else {
            completion(WireFormat.success(["available": false]))
        }
    }

    @available(macOS 12, *)
    private func nowPlaying(includeSystem:Bool,completion: @escaping @Sendable ([String: Any]) -> Void) {
        if #available(macOS 14, *) {
            let p = playerV14()
            var resp: [String: Any] = [
                "status": Self.playbackName(p.state.playbackStatus),
                "playbackRate": p.state.playbackRate,
                "playbackTime": p.playbackTime,
                "repeatMode": p.state.repeatMode.map{$0 == .none ? "off":$0 == .one ? "one":"all"} ?? "unknown",
                "shuffleMode": p.state.shuffleMode.map{$0 == .off ? "off":"songs"} ?? "unknown",
                "queueLength": p.queue.entries.count,
            ]
            if let entry = p.queue.currentEntry {
                resp["currentEntry"] = ["id": String(describing:entry.id), "title": entry.title]
            }
            if includeSystem{
                do{resp["system"]=try systemSnapshot()}catch{let code=(error as NSError).code;completion(WireFormat.failure(code == -1743 ? "permission_denied":code == -600 ? "target_gone":code == -1712 ? "timeout_unknown_outcome":"provider_failed",String(error.localizedDescription.prefix(1000))));return}
            }
            resp["note"] = "ApplicationMusicPlayer is owned by the bridge; explicitly requested system state uses PID-addressed read-only Apple Events without prompting, launching or activating Music."
            completion(WireFormat.success(resp))
        } else {
            completion(WireFormat.success(["available": false, "note": "macOS 14+ required for ApplicationMusicPlayer"]))
        }
    }

    // Property codes come from the installed Music.app scripting dictionary.
    private func systemSnapshot()throws->[String:Any]{
        let apps=NSRunningApplication.runningApplications(withBundleIdentifier:"com.apple.Music").filter{!$0.isTerminated}
        guard apps.count<=1 else{throw NSError(domain:"Music",code:1,userInfo:[NSLocalizedDescriptionKey:"multiple native Music processes; no system target selected"])}
        guard let app=apps.first else{return ["running":false]}
        let target=NSAppleEventDescriptor(processIdentifier:app.processIdentifier)
        guard let pointer=target.aeDesc else{throw NSError(domain:"Music",code:2)}
        var address=pointer.pointee
        let permission=AEDeterminePermissionToAutomateTarget(&address,kAECoreSuite,kAEGetData,false)
        guard permission==noErr else{throw NSError(domain:"Music",code:Int(permission),userInfo:[NSLocalizedDescriptionKey:"system Music observation requires existing Apple Events consent (native status \(permission)); no prompt issued"])}
        func object(_ code:OSType,container:NSAppleEventDescriptor=NSAppleEventDescriptor.null())->NSAppleEventDescriptor?{
            let d=NSAppleEventDescriptor.record()
            d.setDescriptor(NSAppleEventDescriptor(typeCode:OSType(cProperty)),forKeyword:AEKeyword(keyAEDesiredClass))
            d.setDescriptor(container,forKeyword:AEKeyword(keyAEContainer))
            d.setDescriptor(NSAppleEventDescriptor(enumCode:OSType(formPropertyID)),forKeyword:AEKeyword(keyAEKeyForm))
            d.setDescriptor(NSAppleEventDescriptor(typeCode:code),forKeyword:AEKeyword(keyAEKeyData))
            return d.coerce(toDescriptorType:typeObjectSpecifier)
        }
        func read(_ code:OSType,container:NSAppleEventDescriptor=NSAppleEventDescriptor.null())throws->NSAppleEventDescriptor{
            guard !self.isRevoked(),!app.isTerminated,NSRunningApplication(processIdentifier:app.processIdentifier)?.launchDate==app.launchDate,let property=object(code,container:container)else{throw NSError(domain:"Music",code:-600,userInfo:[NSLocalizedDescriptionKey:"retained Music process or request ended"])}
            let event=NSAppleEventDescriptor(eventClass:kAECoreSuite,eventID:kAEGetData,targetDescriptor:target,returnID:AEReturnID(kAutoGenerateReturnID),transactionID:AETransactionID(kAnyTransactionID))
            event.setParam(property,forKeyword:keyDirectObject)
            let reply=try event.sendEvent(options:[.waitForReply,.neverInteract,.dontRecord],timeout:2)
            if let error=reply.paramDescriptor(forKeyword:keyErrorNumber),error.int32Value != 0{throw NSError(domain:"Music",code:Int(error.int32Value),userInfo:[NSLocalizedDescriptionKey:reply.paramDescriptor(forKeyword:keyErrorString)?.stringValue ?? "native Music property read failed"])}
            guard let data=reply.paramDescriptor(forKeyword:keyDirectObject)else{throw NSError(domain:"Music",code:3,userInfo:[NSLocalizedDescriptionKey:"native Music property reply lacks data"])}
            return data
        }
        let state=try read(0x70506c53).enumCodeValue
        let states:[OSType:String]=[0x6b505353:"stopped",0x6b505350:"playing",0x6b505370:"paused",0x6b505346:"fastForwarding",0x6b505352:"rewinding"]
        let repeats:[OSType:String]=[0x6b52704f:"off",0x6b527031:"one",0x6b416c6c:"all"]
        let shuffles:[OSType:String]=[0x6b536853:"songs",0x6b536841:"albums",0x6b536847:"groupings"]
        guard let status=states[state],let repeatMode=repeats[try read(0x70527074).enumCodeValue]else{throw NSError(domain:"Music",code:4,userInfo:[NSLocalizedDescriptionKey:"unrecognized native Music enumeration"])}
        let enabled=try read(0x70536845).booleanValue
        var row:[String:Any]=["running":true,"status":status,"playbackTime":try read(0x70506f73).doubleValue,"repeatMode":repeatMode,"shuffleMode":enabled ? (shuffles[try read(0x7053684d).enumCodeValue] ?? "unknown"):"off"]
        if status != "stopped",let track=object(0x7054726b){
            let id=try read(0x70504953,container:track).stringValue,title=try read(0x706e616d,container:track).stringValue
            guard let id,!id.isEmpty,let title else{throw NSError(domain:"Music",code:5,userInfo:[NSLocalizedDescriptionKey:"native current Music track lacks identity/title"])}
            row["currentEntry"]=["id":id,"title":title]
        }
        return row
    }
}
