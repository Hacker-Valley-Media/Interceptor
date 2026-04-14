import Foundation
import Network
import AppKit

Platform.log("interceptor-bridge starting")
Platform.cleanupSocket()
Platform.writePID()

let router = Router()

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
let menuDomain = MenuDomain()
let textDomain = TextDomain()
let compoundDomain = CompoundDomain(router: router)

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
router.register("menu", handler: menuDomain)
router.register("text", handler: textDomain)
router.register("compound", handler: compoundDomain)

do {
    let transport = try Transport(router: router)
    transport.start()
} catch {
    Platform.log("failed to start transport: \(error)")
    exit(1)
}

Platform.log("interceptor-bridge ready on \(Platform.bridgeSocketPath)")
Platform.emitEvent("bridge_started")

signal(SIGINT) { _ in
    Platform.log("SIGINT received — shutting down")
    Platform.cleanup()
    exit(0)
}

signal(SIGTERM) { _ in
    Platform.log("SIGTERM received — shutting down")
    Platform.cleanup()
    exit(0)
}

// NSApplication is required for NSEvent.addGlobalMonitorForEvents (MonitorDomain)
// Using NSApplication.shared.run() instead of RunLoop.main.run()
let app = NSApplication.shared
app.setActivationPolicy(.accessory) // No dock icon, no menu bar
app.run()
