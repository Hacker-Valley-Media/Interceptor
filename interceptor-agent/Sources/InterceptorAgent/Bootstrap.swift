import Foundation

// dyld invokes every function pointer in the `__DATA,__mod_init_func` section at
// image load. Placing this closure there (enabled by the SymbolLinkageMarkers
// experimental feature) runs the agent the moment the dylib is loaded, before the
// host app's own code, with no Objective-C `+load` shim.
@_used
@_section("__DATA,__mod_init_func")
let interceptorAgentModInit: @convention(c) () -> Void = {
    InterceptorAgent.shared.bootstrap()
}

/// Exported fallback entry. An own-build target (rung 1) or a loader can call
/// `interceptor_agent_start()` directly if the mod-init path is ever stripped.
/// Idempotent — `bootstrap()` guards against double starts.
@_cdecl("interceptor_agent_start")
public func interceptor_agent_start() {
    InterceptorAgent.shared.bootstrap()
}
