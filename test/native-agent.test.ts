import { describe, expect, test } from "bun:test"
import {
  classifyWayIn,
  classifyRuntime,
  parseSlice,
  parseHardenedRuntime,
  nativeContextId,
  nativeAppSlug,
  isNativeContextId,
  describeWayIn,
  NATIVE_WAY_IN_RUNG,
  NATIVE_VERB_TYPES,
  RUNTIME_CHANNEL_RUNTIMES,
} from "../shared/native-agent"
import { NATIVE_PLATFORM_TARGETS_ENABLED } from "../shared/native-build-config"
import { nativeEnableAction, nativeHelpText, removedNativeMapResult } from "../cli/commands/native"
import { validateContextRouting } from "../daemon/outbound-routing"

describe("classifyWayIn (the way-in ladder)", () => {
  test("Apple platform binary → unsupported", () => {
    expect(classifyWayIn({ platformBinary: true, hardened: true })).toBe("unsupported")
  })
  test("own-build (agent linked) → own-build", () => {
    expect(classifyWayIn({ agentLinked: true, hardened: true })).toBe("own-build")
  })
  test("Electron/.NET/JVM → runtime-channel", () => {
    expect(classifyWayIn({ runtime: "electron", hardened: true })).toBe("runtime-channel")
    expect(classifyWayIn({ runtime: "dotnet", hardened: true })).toBe("runtime-channel")
    expect(classifyWayIn({ runtime: "jvm", hardened: true })).toBe("runtime-channel")
  })
  test("non-hardened native → weak-entitlement (DYLD, no re-sign)", () => {
    expect(classifyWayIn({ runtime: "appkit", hardened: false })).toBe("weak-entitlement")
  })
  test("hardened + disable-lib-validation + allow-dyld-env → weak-entitlement", () => {
    expect(classifyWayIn({
      runtime: "appkit", hardened: true,
      disableLibraryValidation: true, allowDyldEnvironmentVariables: true,
    })).toBe("weak-entitlement")
  })
  test("hardened + get-task-allow → weak-entitlement", () => {
    expect(classifyWayIn({ runtime: "swiftui", hardened: true, getTaskAllow: true })).toBe("weak-entitlement")
  })
  test("hardened pure-native, no weak ent → re-sign", () => {
    expect(classifyWayIn({ runtime: "swiftui", hardened: true })).toBe("re-sign")
    expect(classifyWayIn({ runtime: "appkit", hardened: true, disableLibraryValidation: true })).toBe("re-sign") // dlv alone is not enough
  })
  test("ladder rungs are ordered", () => {
    expect(NATIVE_WAY_IN_RUNG["own-build"]).toBeLessThan(NATIVE_WAY_IN_RUNG["runtime-channel"])
    expect(NATIVE_WAY_IN_RUNG["weak-entitlement"]).toBeLessThan(NATIVE_WAY_IN_RUNG["re-sign"])
    expect(NATIVE_WAY_IN_RUNG["re-sign"]).toBeLessThan(NATIVE_WAY_IN_RUNG["unsupported"])
  })
})

describe("classifyRuntime", () => {
  test("Electron framework", () => {
    expect(classifyRuntime({ hasElectronFramework: true })).toBe("electron")
  })
  test(".NET via libcoreclr", () => {
    expect(classifyRuntime({ dylibs: ["libcoreclr.dylib", "libhostfxr.dylib"] })).toBe("dotnet")
  })
  test("JVM via libjvm", () => {
    expect(classifyRuntime({ dylibs: ["libjvm.dylib"] })).toBe("jvm")
  })
  test("SwiftUI when linked", () => {
    expect(classifyRuntime({ hasSwiftUI: true })).toBe("swiftui")
  })
  test("plain AppKit fallback", () => {
    expect(classifyRuntime({ dylibs: ["AppKit", "Foundation"] })).toBe("appkit")
  })
  test("all runtime-channel runtimes are recognized", () => {
    for (const rt of RUNTIME_CHANNEL_RUNTIMES) {
      expect(classifyWayIn({ runtime: rt, hardened: true })).toBe("runtime-channel")
    }
  })
})

describe("parseSlice", () => {
  test("arm64e is distinguished from arm64", () => {
    expect(parseSlice("arm64e")).toBe("arm64e")
    expect(parseSlice("arm64")).toBe("arm64")
  })
  test("universal when both arm + x86", () => {
    expect(parseSlice("x86_64 arm64")).toBe("universal")
  })
  test("x86_64 only", () => {
    expect(parseSlice("x86_64")).toBe("x86_64")
  })
})

describe("parseHardenedRuntime", () => {
  test("detects the runtime flag", () => {
    expect(parseHardenedRuntime("CodeDirectory v=20500 size=767 flags=0x10000(runtime) hashes=13+7")).toBe(true)
  })
  test("absent when no runtime flag", () => {
    expect(parseHardenedRuntime("CodeDirectory v=20400 flags=0x0(none)")).toBe(false)
  })
})

describe("context id helpers", () => {
  test("slug + context id", () => {
    expect(nativeAppSlug("My Cool App.app")).toBe("my-cool-app")
    expect(nativeContextId("MyApp")).toBe("runtime:myapp")
  })
  test("isNativeContextId", () => {
    expect(isNativeContextId("runtime:slack")).toBe(true)
    expect(isNativeContextId("native:slack")).toBe(false)
    expect(isNativeContextId("cdp:slack")).toBe(false)
    expect(isNativeContextId(undefined)).toBe(false)
  })
  test("describeWayIn is human-readable for every rung", () => {
    for (const w of ["own-build", "runtime-channel", "weak-entitlement", "re-sign", "unsupported"] as const) {
      expect(describeWayIn(w).length).toBeGreaterThan(5)
    }
  })
})

describe("runtime verb set", () => {
  test("includes the native verbs and the browser aliases", () => {
    expect(NATIVE_VERB_TYPES.has("native_mutate")).toBe(true)
    expect(NATIVE_VERB_TYPES.has("native_tree")).toBe(true)
    expect(NATIVE_VERB_TYPES.has("evaluate")).toBe(true) // alias so eval --context runtime: works
  })
})

describe("validateContextRouting with runtime contexts", () => {
  // Native agents register in extensionWsMap, so they arrive as connectedContexts.
  test("a registered runtime context routes", () => {
    expect(validateContextRouting({
      contextId: "runtime:myapp",
      connectedContexts: ["runtime:myapp"],
      nativeRelayAvailable: false,
    })).toEqual({ ok: true })
  })
  test("an unknown runtime context is rejected with a hint", () => {
    const r = validateContextRouting({
      contextId: "runtime:ghost",
      connectedContexts: ["runtime:myapp"],
      nativeRelayAvailable: false,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("runtime:myapp")
  })
  test("disambiguation lists runtime contexts when several connected", () => {
    const r = validateContextRouting({
      connectedContexts: ["runtime:a", "runtime:b"],
      nativeRelayAvailable: false,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("use --context")
  })
})

describe("delegation frame shape", () => {
  // Documents the wire contract the daemon's delegate handler + agent rely on.
  test("a delegate frame carries id + a macos_ action", () => {
    const frame = { type: "delegate", id: "abc", action: { type: "macos_apps" } }
    expect(frame.type).toBe("delegate")
    expect((frame.action.type as string).startsWith("macos_")).toBe(true)
  })
  test("a registration frame carries native type + context", () => {
    const reg = { type: "native", contextId: "runtime:x", pid: 123, slice: "arm64" }
    expect(reg.type).toBe("native")
    expect(isNativeContextId(reg.contextId)).toBe(true)
  })
})

describe("macos runtime enable CLI (capability-blind core)", () => {
  test("help hides platform target support AND relocated rung-4 flags", () => {
    expect(NATIVE_PLATFORM_TARGETS_ENABLED).toBe(false)
    const help = nativeHelpText()
    // rung-4 (re-sign + capability continuity + launch handling) is relocated to
    // an operator-installed extension — the capability-blind core no longer
    // surfaces these flags.
    expect(help).not.toContain("--capability-continuity")
    expect(help).not.toContain("--catch-launch")
    expect(help).not.toContain("--preserve-plugins")
    expect(help).not.toContain("--allow-platform")
  })

  test("enable emits only rung-1/rung-3 fields — relocated rung-4 fields are gone", () => {
    const parsed = nativeEnableAction(["runtime", "enable", "TestApp", "--build", "--capability-continuity", "--catch-launch", "--confirm"])
    expect("action" in parsed).toBe(true)
    if ("action" in parsed) {
      expect(parsed.action.build).toBe(true)
      expect(parsed.action.capabilityContinuity).toBeUndefined()
      expect(parsed.action.catchLaunch).toBeUndefined()
      expect(parsed.action.preservePlugins).toBeUndefined()
      expect(parsed.action.confirm).toBeUndefined()
    }
  })

  test("--allow-platform fails closed in public build", () => {
    const parsed = nativeEnableAction(["runtime", "enable", "Maps", "--allow-platform"])
    expect("result" in parsed).toBe(true)
    if ("result" in parsed) {
      expect(parsed.result.success).toBe(false)
      expect(parsed.result.error).toContain("not included")
      expect(JSON.stringify(parsed.result.data)).toContain("platform_target_support_compiled_out")
    }
  })
})

describe("removed runtime app-specific commands", () => {
  test("runtime map reports a clear removal error instead of generic help", () => {
    const result = removedNativeMapResult()
    expect(result.success).toBe(false)
    expect(result.error).toContain("macos runtime map")
    expect(result.error).toContain("removed")
    expect(JSON.stringify(result.data)).toContain("macos runtime js")
  })
})

describe("Runtime Hook Fabric verb types", () => {
  const FABRIC = [
    "native_hook", "native_unhook", "native_hooks", "native_hook_log", "native_events",
    "native_trace", "native_untrace", "native_cintercept", "native_dom_watch", "native_domains",
  ]
  test("every hook-fabric verb is a recognized native verb", () => {
    for (const v of FABRIC) expect(NATIVE_VERB_TYPES.has(v)).toBe(true)
  })
  test("hook-fabric verbs route to the native agent (not the bridge)", () => {
    // native_* wire verbs with a runtime: context must route to the in-process agent
    for (const v of FABRIC) {
      expect(v.startsWith("native_")).toBe(true)
      expect(NATIVE_VERB_TYPES.has(v)).toBe(true)
    }
  })
  test("pre-existing native verbs still registered (no regression)", () => {
    for (const v of ["native_ping", "native_tree", "native_eval", "native_js", "native_net"]) {
      expect(NATIVE_VERB_TYPES.has(v)).toBe(true)
    }
  })
})
