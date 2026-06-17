import Foundation
import Network
import AppKit
import Sparkle

Platform.log("interceptor-bridge starting")
Platform.cleanupSocket()
Platform.writePID()

let router = Router()

// expose the router to AppIntents perform() callbacks so declared
// intents can dispatch into the same domain handlers the CLI uses.
GlobalRouterRef.shared = router

// Register all domains
let accessibilityDomain = AccessibilityDomain()
let appsDomain = AppsDomain()
let inputDomain = InputDomain()
let captureDomain = CaptureDomain()
let speechDomain = SpeechDomain()
let soundDomain = SoundDomain()
let visionDomain = VisionDomain()
let nlpDomain = NLPDomain()
let intelligenceDomain = IntelligenceDomain()
let sensitiveDomain = SensitiveDomain()
let healthDomain = HealthDomain()
let filesDomain = FilesDomain()
let notificationsDomain = NotificationsDomain()
let clipboardDomain = ClipboardDomain()
let displayDomain = DisplayDomain()
let audioDomain = AudioDomain()
let streamDomain = StreamDomain()
let monitorDomain = MonitorDomain()
let trustDomain = TrustDomain()
let tccDomain = TccDomain()
let menuDomain = MenuDomain()
let textDomain = TextDomain()
let compoundDomain = CompoundDomain(router: router)

// native filesystem, networking, log, app intent, container, and overlay
// domains. See docs/native/README.md for the full surface.
let overlayDomain = OverlayDomain()
let fsDomain = FsDomain()
let netDomain = NetDomain()
let logDomain = LogDomain()
let intentDomain = IntentDomain()
let containerDomain = ContainerDomain()

// Runtime Agent surface: discover/enable/disable/status for injecting
// the InterceptorAgent dylib into native apps. `macos_native_<cmd>` routes here.
let nativeDomain = NativeDomain()

// VM management. Registered against `vm` so `macos_vm_<verb>`
// actions route here. Lives alongside ContainerDomain (which keeps
// running the existing `macos_container_run` shell-out path).
let vmDomain = VmDomain()

// personal data and distribution domains. Each handler reads
// `action["sub"]` per the dispatch invariant and is registered
// against the two-segment action type `macos_<key>_<verb>` below.
let pdfDomain = PdfDomain()
let detectDomain = DetectDomain()
let translateDomain = TranslateDomain()
let thumbnailDomain = ThumbnailDomain()
let authDomain = AuthDomain()
let calendarDomain = CalendarDomain()
let remindersDomain = RemindersDomain()
let contactsDomain = ContactsDomain()
let appIntentDomain = AppIntentDomain()
let photosDomain = PhotosDomain()
let mapsDomain = MapsDomain()
let locationDomain = LocationDomain()
let musicDomain = MusicDomain()
let shareDomain = ShareDomain()

router.register("tree", handler: accessibilityDomain)
router.register("find", handler: accessibilityDomain)
router.register("inspect", handler: accessibilityDomain)
router.register("value", handler: accessibilityDomain)
router.register("action", handler: accessibilityDomain)
router.register("focused", handler: accessibilityDomain)
router.register("windows", handler: accessibilityDomain)
router.register("resize", handler: accessibilityDomain)
router.register("move", handler: accessibilityDomain)
router.register("apps", handler: appsDomain)
router.register("app", handler: appsDomain)
router.register("frontmost", handler: appsDomain)
router.register("click", handler: inputDomain)
router.register("type", handler: inputDomain)
router.register("keys", handler: inputDomain)
router.register("scroll", handler: inputDomain)
router.register("drag", handler: inputDomain)
router.register("screenshot", handler: captureDomain)
router.register("capture", handler: captureDomain)
router.register("listen", handler: speechDomain)
router.register("vad", handler: speechDomain)
router.register("sounds", handler: soundDomain)
router.register("vision", handler: visionDomain)
router.register("nlp", handler: nlpDomain)
router.register("ai", handler: intelligenceDomain)
router.register("sensitive", handler: sensitiveDomain)
router.register("health", handler: healthDomain)
router.register("files", handler: filesDomain)
router.register("notifications", handler: notificationsDomain)
router.register("clipboard", handler: clipboardDomain)
router.register("display", handler: displayDomain)
router.register("audio", handler: audioDomain)
router.register("stream", handler: streamDomain)
router.register("monitor", handler: monitorDomain)
router.register("trust", handler: trustDomain)
router.register("tcc", handler: tccDomain)
router.register("menu", handler: menuDomain)
router.register("text", handler: textDomain)
router.register("compound", handler: compoundDomain)

// register the six new domain prefixes. Wire format is
// `macos_<prefix>_<command>` so e.g. `macos_overlay_start` routes here.
router.register("overlay", handler: overlayDomain)
router.register("fs", handler: fsDomain)
router.register("url", handler: netDomain)
router.register("log", handler: logDomain)
router.register("script", handler: intentDomain)
router.register("intent", handler: intentDomain)
router.register("container", handler: containerDomain)
// Runtime Agent surface: `macos_native_<cmd>` → NativeDomain.
router.register("native", handler: nativeDomain)
// register the new `vm` domain.
router.register("vm", handler: vmDomain)

// register the 14 new domain keys.
router.register("pdf", handler: pdfDomain)
router.register("detect", handler: detectDomain)
router.register("translate", handler: translateDomain)
router.register("thumbnail", handler: thumbnailDomain)
router.register("auth", handler: authDomain)
router.register("calendar", handler: calendarDomain)
router.register("reminders", handler: remindersDomain)
router.register("contacts", handler: contactsDomain)
router.register("appintent", handler: appIntentDomain)
router.register("photos", handler: photosDomain)
router.register("maps", handler: mapsDomain)
router.register("location", handler: locationDomain)
router.register("music", handler: musicDomain)
router.register("share", handler: shareDomain)

do {
    let transport = try Transport(router: router)
    transport.start()
} catch {
    Platform.log("failed to start transport: \(error)")
    exit(1)
}

Platform.log("interceptor-bridge ready on \(Platform.bridgeSocketPath)")
Platform.emitEvent("bridge_started")

// ensure overlays do not outlive the bridge process. On
// SIGINT/SIGTERM, signal handlers below trigger overlay teardown via a
// stored global reference. `signal()` requires a C-callable function
// pointer that cannot capture Swift state, so the overlayDomain instance
// is exposed through a global variable and dispatched on the main thread
// (overlays are AppKit objects). The per-overlay `timeout_seconds` knob
// + the panic hotkey + the engine-side per-session cleanup are the other
// layers of the safety net.
GlobalOverlayDomainRef.shared = overlayDomain

signal(SIGINT) { _ in
    Platform.log("SIGINT received — shutting down")
    GlobalOverlayDomainRef.shared?.handle("stop", action: ["sub": "stop"]) { _ in }
    Thread.sleep(forTimeInterval: 0.1)
    Platform.cleanup()
    exit(0)
}

signal(SIGTERM) { _ in
    Platform.log("SIGTERM received — shutting down")
    GlobalOverlayDomainRef.shared?.handle("stop", action: ["sub": "stop"]) { _ in }
    Thread.sleep(forTimeInterval: 0.1)
    Platform.cleanup()
    exit(0)
}

// AppKit initialization is required for APIs like NSEvent global monitors, but
// NSApplication.run() exits immediately in our helper context. Keep the helper
// resident on the main run loop instead.
let app = NSApplication.shared
app.setActivationPolicy(.accessory) // No dock icon, no menu bar

// Install an NSApplicationDelegate so AppKit's default Apple-Event
// handling routes Sparkle's `kAEQuitApplication` (sent at stage 2 of an
// install) through `applicationShouldTerminate`. Without this, the install
// flow hangs because the bridge never exits to let Sparkle replace the
// bundle. See AppDelegate.swift for the full rationale.
let bridgeAppDelegate = BridgeAppDelegate()
app.delegate = bridgeAppDelegate

// Sparkle auto-update. SUFeedURL + SUPublicEDKey + scheduled-check settings
// live in the bundled Info.plist (see scripts/build-bridge.sh). Holding a
// strong reference here for the lifetime of the process; Sparkle handles its
// own polling, prompts, and the hand-off to the macOS installer for the .pkg.
//
// `sparkleUserDriverDelegate` adopts SPUStandardUserDriverDelegate to
// surface update alerts in front of other apps. Without it, our LSUIElement
// bridge silently shows alerts in the background and the user never sees
// them (Sparkle itself logs an Error-level warning to confirm). See
// SparkleUserDriverDelegate.swift for the full rationale and the gentle-
// reminders contract. Held strongly here so it lives the lifetime of the
// process — Sparkle weakly references its delegate.
let sparkleUpdaterDelegate = SparkleUpdaterDelegate()
let sparkleUserDriverDelegate = SparkleUserDriverDelegate()
let updaterController = SPUStandardUpdaterController(
    startingUpdater: true,
    updaterDelegate: sparkleUpdaterDelegate,
    userDriverDelegate: sparkleUserDriverDelegate
)

// `interceptor macos update *` thin wrapper around SPUUpdater so the CLI
// can drive a user-initiated update check directly. Useful both for agents
// and for verifying the activation-policy dialog path (since automatic
// checks for LSUIElement apps may silently download rather than surface).
let updateDomain = UpdateDomain(updaterController: updaterController)
router.register("update", handler: updateDomain)
Platform.log("sparkle updater started; feed: \(updaterController.updater.feedURL?.absoluteString ?? "unset")")

// Extension Fabric: after EVERY built-in domain has registered (so the
// collision check sees the full reserved set, including `update` above), scan
// ~/.interceptor/extensions/*/manifest.json, verify + dlopen each operator-placed
// bridge dylib, and register its prefix. Absent any extension this is a no-op and
// the bridge is exactly the capability-blind host. Failures are isolated + logged.
ExtensionFabric.loadAll(into: router)

// Switched from `RunLoop.main.run()` to `app.run()`.
// `RunLoop.main.run()` only spins the underlying CFRunLoop and does NOT
// invoke NSApplication's Cocoa event loop. That was fine for the bridge
// when no AppKit windows were ever shown (LSUIElement headless daemon
// mode). The moment Sparkle's `SPUStandardUserDriver` puts up its modal
// "A new version of Interceptor is available!" alert window, that window
// needs the full NSApp event pump to receive mouse/keyboard events; under
// `RunLoop.main.run()` the window appears but the main thread doesn't
// process its UI events, so macOS marks the bridge "Not Responding" and
// the user can't click any of the alert's buttons.
//
// `NSApp.run()` invokes `finishLaunching` and starts the standard Cocoa
// event loop. It only returns when the app terminates. With our
// `BridgeAppDelegate.applicationShouldTerminateAfterLastWindowClosed`
// returning `false`, the bridge stays alive after the Sparkle alert is
// dismissed; with `applicationShouldTerminate` running cleanup and
// returning `.terminateNow`, Sparkle's stage-2 quit event lets the install
// proceed cleanly. This also means our SIGINT/SIGTERM signal handlers
// above continue to work — they call `Platform.cleanup()` + `exit(0)`
// before NSApp.run() ever sees them.
app.run()
