import Foundation
import ApplicationServices
import AVFoundation
import Contacts
import CoreLocation
import EventKit
import MusicKit
import Photos
import SensitiveContentAnalysis
import Speech
import UserNotifications

/// Discovery shares the existing registry and transport. It never initializes a
/// lazy domain, requests permission, activates an app, or claims qualification.
final class DesktopDomain: DomainHandler, @unchecked Sendable {
    private weak var router: Router?
    init(router: Router) { self.router = router }
    func handle(_ command: String, action: [String: Any], completion: @escaping @Sendable ([String: Any]) -> Void) {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "source"
        let session = String(getuid())
        let capabilities = (router?.registeredPrefixes() ?? []).filter { $0 != "desktop" }.map { operation -> [String: Any] in
            if operation == "photos" {
                return ["operation": operation, "compiled": true, "present": true, "effective": false,
                    "permission": "unknown", "session": session, "background": "semantic", "provider": "PhotoKit native resources and persistent history",
                    "versions": ["product": version, "contract": "1"],
                    "limits": ["Twenty-two strict selectors; one 55-second native request, with unresolved completion retaining admission",
                        "Read/write authorization required for actual mutation readback; only explicit request asks for consent",
                        "Native asset paging 1..1000 and offset 0..10000;1000 albums; 1MiB replies; 128MiB per private exclusive export resource",
                        "Live Photo export writes both native paired resources; video export preserves actual resource bytes and UTI",
                        "Persistent history enumerates native object changes; overflow refuses without token advancement; moments unavailable on macOS",
                        "Discovery initializes no photo query or consent; current grouped build and installed qualification remain open"]]
            }
            if ["calendar", "reminders"].contains(operation) {
                return ["operation": operation, "compiled": true, "present": true, "effective": false,
                    "permission": "unknown", "session": session, "background": "semantic", "provider": "EventKit native store with retained requests",
                    "versions": ["product": version, "contract": "1"],
                    "limits": ["Seventeen Calendar and twelve Reminders selectors; strict dates, exact store identity and no invalid-target fallback",
                        "One 55-second native request per domain, including unresolved completion; reminder fetch cancellation uses native handles",
                        "Full authorization required for native readback; only explicit request asks for consent; attendees are read-only",
                        "Paging 1..1000, offset 0..10000;1MiB replies; Calendar tail is a store-change counter, not item history",
                        "Current grouped builds, permission/store/lifecycle checks and installed qualification remain open"]]
            }
            if operation == "stream" {
                return ["operation": operation, "compiled": true, "present": true, "permission": "unknown", "session": session, "effective": false,
                    "background": "window", "provider": "ScreenCaptureKit / existing window input handlers",
                    "versions": ["product": version, "os": ProcessInfo.processInfo.operatingSystemVersionString, "contract": "1"],
                    "limits": ["Four owned sessions including pending startup/cleanup; native complete frames only; bounded JPEG/latest-frame cache",
                        "Input requires the captured process/window; display streams cannot deliver global input",
                        "Record counts actual screen frames/time; virtual outputs and audio/video artifacts require their media backend",
                        "Discovery requests no permission and establishes no native or installed qualification"]]
            }
            if ["vision", "sensitive"].contains(operation) {
                return ["operation": operation, "compiled": true, "present": true,
                    "permission": "unknown", "session": session, "effective": false,
                    "background": "semantic", "provider": "Apple Vision / SensitiveContentAnalysis",
                    "versions": ["product": version, "os": ProcessInfo.processInfo.operatingSystemVersionString, "contract": "1"],
                    "limits": ["Six native Vision selectors; bounded oriented file/native capture sources; explicit app targets do not fall back",
                        "Sensitive results require enabled signed native policy and actual analysis; monitor samples one retained app every 5s",
                        "Sensitive stop revokes publication; cleanupPending retains uninterruptible in-process work",
                        "Discovery changes no permission and establishes no current native or installed qualification"]]
            }
            if operation == "update" {
                return ["operation":operation,"compiled":true,"present":true,"permission":"not_applicable","session":session,"effective":false,
                    "background":"semantic","provider":"Sparkle callback-observed update lifecycle","versions":["product":version,"contract":"1"],
                    "limits":["Strict check/status fields; background check retains actual updater scheduling, selected release and error state", "Discovery starts no update check and establishes no current installed qualification"]]
            }
            if operation == "location" {
                return ["operation":operation,"compiled":true,"present":true,"permission":"unknown","session":session,"effective":false,
                    "background":"semantic","provider":"CoreLocation / CLGeocoder on main run loop","versions":["product":version,"contract":"1"],
                    "limits":["Seventeen exact selectors and bounded coordinates/postal fields; actual permissions and measurement timestamps",
                        "Current requests retain a separate manager; overlapping requests refuse; thirty-second reply budget and owned cleanup",
                        "Geocode requests retain callback identity until actual completion/cancellation; bounded 32 placemarks and 64KiB replies",
                        "Discovery requests no permission, creates no location manager and establishes no current installed qualification"]]
            }
            if operation == "maps" {
                return ["operation":operation,"compiled":true,"present":true,"permission":"unknown","session":session,"effective":false,
                    "background":"semantic","provider":"MapKit / retained CLGeocoder","versions":["product":version,"contract":"1"],
                    "limits":["Six exact selectors and actual native search/completion filters; four requests including owned cancellation cleanup",
                        "Fifty-five-second reply deadline; 32 search/completion/placemark results, 3 routes and 1MiB replies",
                        "128 random map item identities expire after 300s; stale ids do not rebind; native open reports actual acceptance",
                        "Discovery initializes no MapKit request, opens no application and establishes no current installed qualification"]]
            }
            if operation == "contacts" {
                return ["operation":operation,"compiled":true,"present":true,"permission":"unknown","session":session,"effective":false,
                    "background":"semantic","provider":"CNContactStore / native Objective-C history enumerator","versions":["product":version,"contract":"1"],
                    "limits":["Twenty-two exact selectors; one retained native request and 55-second reply budget; status does not request access",
                        "Paging 1..1000, default 100, offset 0..10000; actual group/container filters and output keys",
                        "Native history includes group changes; overflow refuses without advancing the token; no fabricated empty history",
                        "UTF8 vCards up to 256KiB and 1..100 import contacts; 1MiB reply; note mutation requires unavailable Apple notes entitlement",
                        "Native permissions, history/store lifecycle, focused UI and current source/installed qualification remain open"]]
            }
            if operation == "share" {
                return ["operation":operation,"compiled":true,"present":true,"permission":"unknown","session":session,"effective":false,
                    "background":"semantic","provider":"NSSharingService native completion","versions":["product":version,"contract":"1"],
                    "limits":["Nine strict selectors; four retained native requests including unresolved timeout; 55-second reply budget",
                        "Native sharing UI may present a composer or sheet; no activation call is inserted by the bridge",
                        "Success follows didShareItems; failures and native exceptions remain failures; timeout supplies no cancellation or replay",
                        "Discovery sends no content, opens no share UI and establishes no current installed qualification"]]
            }
            if operation == "music" {
                return ["operation":operation,"compiled":true,"present":true,"permission":"unknown","session":session,"effective":false,
                    "background":"semantic","provider":"MusicKit library / ApplicationMusicPlayer","versions":["product":version,"contract":"1"],
                    "limits":["Sixteen selectors with strict fields; one admitted native request including unresolved completion; thirty-second reply budget",
                        "Playback resolves actual user library ids; catalog developer authentication is not used by the public player",
                        "Discovery requests no authorization, initializes no player and establishes no current installed qualification"]]
            }
            if ["audio", "vad", "listen", "trust", "sounds"].contains(operation) {
                return ["operation": operation, "compiled": true, "present": true,
                    "permission": "unknown", "session": session, "effective": false,
                    "background": "semantic", "provider": "interceptor-bridge-swift",
                    "versions": ["product": version, "os": ProcessInfo.processInfo.operatingSystemVersionString, "contract": "1"],
                    "limits": ["Strict generated request/reply contract; actual native permissions and hardware are checked by the requested operation.",
                        "Discovery does not open the microphone or establish installed qualification."]]
            }
            if operation == "notifications" {
                return ["operation": operation, "compiled": true, "present": true,
                    "permission": "not_applicable", "session": session, "effective": false,
                    "background": "semantic", "provider": "UNUserNotificationCenter/DistributedNotificationCenter",
                    "versions": ["product": version, "os": ProcessInfo.processInfo.operatingSystemVersionString, "contract": "1"],
                    "limits": ["Neutral namespace selects application-owned state, not an authenticated agent identity",
                        "Exact named distributed subscriptions only; 32 registrations; 1000 history entries/1MiB; 2048-byte object snapshots",
                        "Owned IDs/categories use a collision-free namespace prefix; bulk removal preserves other namespaces and legacy IDs",
                        "64 categories/8 actions; 65536-byte content; 8 attachments/16MiB each/32MiB total; intervals 1..31536000/repeats>=60",
                        "Status reports actual authorization separately from observed delivery; badge scope is the whole bridge application",
                        "Native response events and owned acceptance/removal events only; no complete delivery/failure event stream",
                        "Mac native category summary/hidden-preview formats; inspect target-specific permission/presentation replies"],
                    "reason": "Contract 1 is implemented; native posting permission and visible presentation need operation-specific qualification."]
            }
            if operation == "files" {
                return ["operation": operation, "compiled": true, "present": true,
                    "permission": "not_applicable", "session": session, "effective": true,
                    "background": "semantic", "provider": "Darwin file sources/lsof current-user inventory",
                    "versions": ["product": version, "os": ProcessInfo.processInfo.operatingSystemVersionString, "contract": "1"],
                    "limits": ["watch/recent/open/unwatch; individual paths remain subject to filesystem permissions",
                        "64 original-object nonrecursive watches; events may coalesce; cancellation prevents new records",
                        "1000 history entries/1MiB; private 4MiB rolling event log; history ends with provider exit",
                        "Current-user kernel UID scope, not graphical-login scope; accessible user-relevant lsof paths only",
                        "512 processes/16384 handles/100 paths; five-second helper deadline; explicit partial coverage"]]
            }
            if operation == "monitor" {
                return ["operation": operation, "compiled": true, "present": true,
                    "permission": "not_applicable", "session": session, "effective": false,
                    "background": "semantic", "provider": "interceptor-bridge-swift",
                    "versions": ["product": version, "os": ProcessInfo.processInfo.operatingSystemVersionString, "contract": "1"],
                    "limits": ["Safe archive identifiers; 0..1000 requested history entries; 1MiB replies",
                        "Recording source permissions and coverage require operation-specific qualification"],
                    "reason": "The typed request boundary does not establish complete recording source coverage."]
            }
            return ["operation": operation, "compiled": true, "present": true,
             "permission": "not_applicable", "session": session, "effective": false,
             "background": "unavailable", "provider": "interceptor-bridge-swift",
             "versions": ["product": version, "os": ProcessInfo.processInfo.operatingSystemVersionString],
             "limits": ["Domain registration is discovery evidence, not per-operation qualification."],
             "reason": "Inspect this operation's target-specific permission and availability result."]
        }.map { row -> [String: Any] in
            var row = row; let ready = Self.readiness(row["operation"] as? String ?? "")
            row["effective"] = ready.effective; row["reason"] = ready.reason
            if let permission = ready.permission { row["permission"] = permission }
            return row
        }
        completion(WireFormat.success([
            "protocolVersion": DESKTOP_PROTOCOL_VERSION, "maxFrameBytes": DESKTOP_MAX_FRAME_BYTES,
            "host": "darwin", "provider": "interceptor-bridge-swift", "version": version,
            "pid": getpid(), "session": session, "capabilities": capabilities,
            "accessibilityGranted": AXIsProcessTrusted()
        ]))
    }

    /// Whether this session can run the operation now, read from the permission state the
    /// operation itself checks, without prompting. `permission` carries the grant; rows that need nothing
    /// beyond the session are effective. Location and notifications stay effective without their grant:
    /// geocoding, distance, history, categories and pending requests need none.
    static func readiness(_ operation: String) -> (effective: Bool, reason: String?, permission: String?) {
        func gate(_ state: String, _ what: String, partial: Bool = false) -> (effective: Bool, reason: String?, permission: String?) {
            state == "granted" || partial ? (true, nil, state) : (false, "\(what) is \(state == "prompt_required" ? "not yet requested" : state) for interceptor-bridge", state)
        }
        func granted(_ ok: Bool) -> String { ok ? "granted" : "denied" }
        func eventKit(_ type: EKEntityType) -> String {
            switch EKEventStore.authorizationStatus(for: type) { case .fullAccess: "granted"; case .notDetermined: "prompt_required"; case .restricted: "restricted"; default: "denied" }
        }
        func microphone() -> String {
            switch AVCaptureDevice.authorizationStatus(for: .audio) { case .authorized: "granted"; case .notDetermined: "prompt_required"; case .restricted: "restricted"; default: "denied" }
        }
        switch operation {
        case "tree", "find", "inspect", "value", "action", "focused", "windows", "resize", "move", "click", "type", "keys", "scroll", "drag", "menu", "text", "compound", "authdialog":
            return gate(granted(AXIsProcessTrusted()), "Accessibility permission")
        case "screenshot", "capture", "stream": return gate(granted(CGPreflightScreenCaptureAccess()), "Screen Recording permission")
        case "calendar": return gate(eventKit(.event), "Calendar full access")
        case "reminders": return gate(eventKit(.reminder), "Reminders full access")
        case "contacts":
            let state: String = switch CNContactStore.authorizationStatus(for: .contacts) { case .authorized: "granted"; case .notDetermined: "prompt_required"; case .restricted: "restricted"; default: "denied" }
            return gate(state, "Contacts access")
        case "photos":
            let state: String = switch PHPhotoLibrary.authorizationStatus(for: .readWrite) { case .authorized, .limited: "granted"; case .notDetermined: "prompt_required"; case .restricted: "restricted"; default: "denied" }
            return gate(state, "Photos access")
        case "location":
            let state: String = switch CLLocationManager.authorizationStatus() { case .authorizedAlways: "granted"; case .notDetermined: "prompt_required"; case .restricted: "restricted"; default: "denied" }
            return gate(state, "Location access", partial: true)
        case "audio", "vad", "sounds": return gate(microphone(), "Microphone access")
        case "listen":
            let speech = SFSpeechRecognizer.authorizationStatus() == .authorized
            return gate(microphone() == "granted" && !speech ? "denied" : microphone(), "Microphone and Speech Recognition access")
        case "music":
            let state: String = switch MusicAuthorization.currentStatus { case .authorized: "granted"; case .notDetermined: "prompt_required"; case .restricted: "restricted"; default: "denied" }
            return gate(state, "Media & Apple Music access")
        case "sensitive": return SCSensitivityAnalyzer().analysisPolicy == .disabled ? (false, "Sensitive Content Warning is off in System Settings", nil) : (true, nil, nil)
        case "notifications":
            guard NotificationsDomain.hasAppBundle else { return (false, "notifications need the bridge to run from its app bundle", nil) }
            let box = NotificationAuthorization(), done = DispatchSemaphore(value: 0)
            UNUserNotificationCenter.current().getNotificationSettings { box.status = $0.authorizationStatus; done.signal() }
            _ = done.wait(timeout: .now() + 2)
            let state: String = switch box.status { case .authorized, .provisional, .ephemeral: "granted"; case .notDetermined: "prompt_required"; default: "denied" }
            return gate(state, "Notification permission", partial: true)
        case "container":
            guard let binary = ContainerDomain.resolveBinary() else { return (false, "Apple container is not installed", nil) }
            if case .success(let (code, _, _)) = ContainerDomain.capture(binary, ["system", "status"], deadline: DispatchTime.now().uptimeNanoseconds + 3_000_000_000, limit: 65536), code == 0 { return (true, nil, nil) }
            return (false, "the Apple container system service is not running (container system start)", nil)
        default: return (true, nil, nil)
        }
    }
}

private final class NotificationAuthorization: @unchecked Sendable { var status: UNAuthorizationStatus = .notDetermined }
