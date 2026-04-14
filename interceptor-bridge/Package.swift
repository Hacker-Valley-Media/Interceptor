// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "interceptor-bridge",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "interceptor-bridge",
            path: "Sources",
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
            ]
        )
    ]
)
