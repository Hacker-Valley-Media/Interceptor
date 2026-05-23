// swift-tools-version: 6.2
import PackageDescription

// VM management dependency layer. The Containerization Swift
// package (apple/containerization, exact 0.31.0) provides the in-process
// LinuxContainer + VZVirtualMachineManager primitives that VmDomain uses
// for Linux guests. Pinned to the same exact version Apple's `container`
// project uses (research/container/Package.swift:26), so we tail their
// validated build. macOS-on-macOS guests use raw Virtualization.framework
// (VZMacOSInstaller etc.) and do not need this package — but we link it
// once regardless because the VmDomain handler dispatches both kinds.
//
// platform bumped from .v14 to .v15 because Containerization itself
// requires macOS 15 (research/container/Package.swift:30).
let package = Package(
    name: "interceptor-bridge",
    platforms: [.macOS(.v15)],
    dependencies: [
        // Sparkle for in-app auto-update. The bridge polls the appcast,
        // prompts the user when a new pkg is available, and hands the
        // download off to the macOS installer.
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.0"),
        // : Containerization (Linux guest runtime). Pinned exact
        // to the version Apple's container project uses.
        .package(url: "https://github.com/apple/containerization.git", exact: Version(stringLiteral: "0.31.0")),
    ],
    targets: [
        .executableTarget(
            name: "interceptor-bridge",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle"),
                // : Containerization product imports. LinuxContainer
                // + VZVirtualMachineManager + BootLog + Hosts + ContainerConfiguration
                // live in `Containerization`. OCI image pull lives in
                // `ContainerizationOCI`. Misc helpers in `ContainerizationOS` +
                // `ContainerizationExtras`.
                .product(name: "Containerization", package: "containerization"),
                .product(name: "ContainerizationOCI", package: "containerization"),
                .product(name: "ContainerizationOS", package: "containerization"),
                .product(name: "ContainerizationExtras", package: "containerization"),
            ],
            path: "Sources",
            // helper subprocess lives in Sources/InterceptorVDHelper —
            // exclude from the main bridge target since it has its own
            // entry point and a separate clean-process design (Lumen pattern).
            // InterceptorD () is the in-guest agent — separate
            // target, also excluded here.
            // No SwiftPM resource bundling — see scripts/build-bridge.sh, which
            // copies model resources directly into the .app's Contents/Resources/.
            // SwiftPM-generated resource bundles (TargetName_TargetName.bundle)
            // lack an Info.plist and codesign rejects them as nested bundles
            // when the outer .app is signed.
            exclude: ["InterceptorVDHelper", "Resources"],
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("Speech"),
                .linkedFramework("SoundAnalysis"),
                .linkedFramework("Vision"),
                .linkedFramework("NaturalLanguage"),
                .linkedFramework("SensitiveContentAnalysis"),
                .linkedFramework("HealthKit"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("AppKit"),
                .linkedFramework("AVFoundation"),
                // HTML overlays (OverlayDomain WKWebView mode)
                .linkedFramework("WebKit"),
                // SpriteKit overlays (Titans + scene-script)
                .linkedFramework("SpriteKit"),
                // Apple Events / TCC consent (AEDeterminePermissionToAutomateTarget)
                .linkedFramework("Carbon"),
                // personal data and distribution surfaces.
                // PDFKit: PdfDomain (PDFDocument/PDFPage/PDFAnnotation/PDFOutline/PDFSelection).
                .linkedFramework("PDFKit"),
                // QuickLookThumbnailing: ThumbnailDomain (QLThumbnailGenerator).
                .linkedFramework("QuickLookThumbnailing"),
                // Translation: TranslateDomain (TranslationSession, LanguageAvailability — macOS 15+).
                .linkedFramework("Translation"),
                // LocalAuthentication: AuthDomain (LAContext.evaluatePolicy).
                .linkedFramework("LocalAuthentication"),
                // EventKit: CalendarDomain + RemindersDomain (EKEventStore).
                .linkedFramework("EventKit"),
                // Contacts: ContactsDomain (CNContactStore).
                .linkedFramework("Contacts"),
                // AppIntents: AppIntentDomain + InterceptorAppIntents declarations (macOS 13+).
                .linkedFramework("AppIntents"),
                // UserNotifications: NotificationsDomain UN extension (UNUserNotificationCenter).
                .linkedFramework("UserNotifications"),
                // Photos: PhotosDomain (PHPhotoLibrary, PHAsset, PHFetchOptions).
                .linkedFramework("Photos"),
                // MapKit: MapsDomain (MKLocalSearch, MKDirections).
                .linkedFramework("MapKit"),
                // CoreLocation: LocationDomain (CLLocationManager, CLGeocoder).
                .linkedFramework("CoreLocation"),
                // MusicKit: MusicDomain (catalog macOS 12+; library + ApplicationMusicPlayer macOS 14+).
                .linkedFramework("MusicKit"),
                // DataDetection: DetectDomain uses Foundation NSDataDetector by default;
                // the modern Swift surface (DDMatch* macOS 12+, DataDetector macOS 26+) lives
                // in the DataDetection module which is auto-imported on macOS 12+.
                .linkedFramework("DataDetection"),
                // : Virtualization.framework for VZVirtualMachine,
                // VZMacOSInstaller, VZMacPlatformConfiguration, vsock, and
                // every other VZ symbol VmDomain uses.
                .linkedFramework("Virtualization"),
                // : vmnet.framework for VZVmnetNetworkDeviceAttachment
                // and custom-topology network surfaces. Requires the
                // com.apple.vm.networking entitlement (scripts/entitlements.plist).
                .linkedFramework("vmnet"),
                // .app bundle layout: Contents/MacOS/<bin> needs to find
                // Contents/Frameworks/Sparkle.framework at runtime.
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
            ]
        ),
        // tiny clean-process helper that creates a CGVirtualDisplay
        // and holds it alive until SIGTERM. Lives in its own process so
        // that AppKit/SCK/etc framework state doesn't poison the
        // CGVirtualDisplay → WindowServer registration.
        .executableTarget(
            name: "interceptor-vd-helper",
            path: "Sources/InterceptorVDHelper",
            linkerSettings: [
                .linkedFramework("Foundation"),
                .linkedFramework("AppKit"),
                .linkedFramework("CoreGraphics"),
            ]
        ),
        // CL32: InterceptorD is the in-guest agent binary.
        // Same vsock JSON-RPC framing as the host bridge. Linked into
        // Containerization's vminit image for Linux guests, packaged as a
        // signed .pkg for macOS gold images. Intentionally minimal deps —
        // no Sparkle, no AppKit on the Linux build path.
        .executableTarget(
            name: "InterceptorD",
            path: "InterceptorD",
            linkerSettings: [
                .linkedFramework("Foundation"),
                .linkedFramework("Virtualization", .when(platforms: [.macOS])),
                .linkedFramework("AppKit", .when(platforms: [.macOS])),
                .linkedFramework("ApplicationServices", .when(platforms: [.macOS])),
                .linkedFramework("CoreGraphics", .when(platforms: [.macOS])),
                .linkedFramework("ScreenCaptureKit", .when(platforms: [.macOS])),
            ]
        ),
        .testTarget(
            name: "InterceptorBridgeTests",
            dependencies: ["interceptor-bridge"],
            path: "Tests/InterceptorBridgeTests"
        )
    ]
)
