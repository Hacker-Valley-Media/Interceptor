// swift-tools-version: 5.9
//
// InterceptorAgent — the in-process agent dylib for the Runtime Agent surface
//. Built as a .dynamic library and loaded into a native audit target via
// DYLD_INSERT_LIBRARIES (own-build / weak-entitlement) or a local re-sign.
//
// Two entry mechanisms, both pointing at the same idempotent bootstrap:
//   1. AgentLoader (C) — `__attribute__((constructor))` runs on dylib load. This
//      is the linker-reliable auto-start that fires the moment the dylib is
//      loaded (modern linkers record it in __TEXT,__init_offsets).
//   2. A Swift `@_section("__DATA,__mod_init_func")` entry (SymbolLinkageMarkers)
//      as a secondary, plus the exported `interceptor_agent_start()` cdecl that
//      an own-build target can call directly.
import PackageDescription

let package = Package(
    name: "InterceptorAgent",
    platforms: [.macOS(.v12)],
    products: [
        .library(name: "InterceptorAgent", type: .dynamic, targets: ["InterceptorAgent", "AgentLoader", "AgentJS"]),
    ],
    targets: [
        .target(
            name: "InterceptorAgent",
            dependencies: ["AgentJS"],
            swiftSettings: [
                .unsafeFlags(["-enable-experimental-feature", "SymbolLinkageMarkers"]),
            ]
        ),
        // ObjC (ARC) — the JavaScriptCore ⇄ ObjC-runtime bridge. NSInvocation is
        // unavailable from Swift, so the general dynamic-dispatch surface lives here.
        .target(
            name: "AgentJS",
            cSettings: [
                .unsafeFlags(["-fobjc-arc"]),
            ],
            // NOTE: JavaScriptCore is intentionally NOT linked — it is dlopen'd lazily
            // on first `macos runtime js` (see jsbridge.m). Loading JSC at process startup
            // can perturb host-app launch (CFPreferences container setup).
            linkerSettings: [
                .linkedFramework("Foundation"),
                .linkedFramework("CoreGraphics"),
            ]
        ),
        .target(
            name: "AgentLoader",
            dependencies: ["InterceptorAgent"],
            // SSL_read/SSL_write are referenced by the dyld __interpose path and
            // resolve at load from the system /usr/lib/libboringssl.dylib (a
            // private dylib with no link stub) — allow them as undefined.
            // Security + CoreFoundation are available to AgentLoader C sources for
            // code-signing / CoreFoundation helpers.
            linkerSettings: [
                .linkedFramework("CoreFoundation"),
                .linkedFramework("Security"),
                .unsafeFlags([
                    "-Xlinker", "-U", "-Xlinker", "_SSL_read",
                    "-Xlinker", "-U", "-Xlinker", "_SSL_write",
                    "-Xlinker", "-U", "-Xlinker", "_nw_connection_send",
                ])
            ]
        ),
        .testTarget(
            name: "InterceptorAgentTests",
            dependencies: ["InterceptorAgent", "AgentJS"]
        ),
    ]
)
