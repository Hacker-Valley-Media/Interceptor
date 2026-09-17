import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const root = new URL("..", import.meta.url).pathname
const safariEntry = readFileSync(`${root}/extension/src/background-safari.ts`, "utf-8")
const router = readFileSync(`${root}/extension/src/background/router.ts`, "utf-8")
const verifier = readFileSync(`${root}/scripts/verify-safari-extension.swift`, "utf-8")
const buildScript = readFileSync(`${root}/scripts/build.sh`, "utf-8")
const safariPackagingScript = readFileSync(`${root}/scripts/build-safari.sh`, "utf-8")
const safariPostinstall = readFileSync(`${root}/scripts/release/postinstall-safari`, "utf-8")
const containingAppPage = readFileSync(
  `${root}/safari/InterceptorSafari/InterceptorSafari/Resources/Base.lproj/Main.html`,
  "utf-8",
)
const safariNativeHandler = readFileSync(
  `${root}/safari/InterceptorSafari/InterceptorSafari Extension/SafariWebExtensionHandler.swift`,
  "utf-8",
)

describe("Safari background bootstrap guardrails", () => {
  test("configures the Safari native relay before opening the control-plane channel", () => {
    const configureAt = safariEntry.indexOf('configureTransport({ contextId: "safari", safariNativeRelay: true })')
    const connectAt = safariEntry.indexOf("\nconnectSafariNativeRelayChannel()", configureAt)

    expect(configureAt).toBeGreaterThan(0)
    expect(connectAt).toBeGreaterThan(configureAt)
  })

  test("shared router imports do not touch browser APIs", () => {
    expect(router).toContain("export function initializeActionRouter(): void")
    expect(router).not.toMatch(/^registerMonitorListeners\(\)$/m)
    expect(router).not.toMatch(/^restorePageCommCaptureConfig\(\)$/m)
  })

  test("Safari startup isolates optional capabilities from the control plane", () => {
    expect(safariEntry).toContain('runOptionalStartupStep("action router", initializeActionRouter)')
    expect(safariEntry).toContain('runOptionalStartupStep("alarm keepalive", registerAlarmListener)')
    expect(safariEntry.indexOf("\nconnectSafariNativeRelayChannel()")).toBeLessThan(
      safariEntry.indexOf('runOptionalStartupStep("action router"'),
    )
  })

  test("native appex owns the daemon WebSocket for Safari Path B", () => {
    expect(safariNativeHandler).toContain('URL(string: "ws://127.0.0.1:\\(19222 + 2 * slot)")')
    expect(safariNativeHandler).toContain("getuid()")
    expect(safariNativeHandler).toContain('"type": "extension", "contextId": contextId')
    expect(safariNativeHandler).toContain('"interceptor_safari_relay"')
  })

  test("packaging has a WebKit-engine bootstrap verifier", () => {
    expect(verifier).toContain("WKWebExtension(resourceBaseURL:")
    expect(verifier).toContain("WKWebExtension(appExtensionBundle:")
    expect(verifier).toContain("loadBackgroundContent")
    expect(verifier).toContain('value(forKey: "errors")')
  })

  test("Safari extension CSP explicitly permits the daemon WebSocket", () => {
    expect(buildScript).toContain("connect-src ws://127.0.0.1:* ws://localhost:*")
  })

  test("unnotarized Safari packages cannot masquerade as release artifacts", () => {
    expect(safariPackagingScript).toContain("Interceptor-Safari-$VER-UNNOTARIZED.pkg")
    expect(safariPackagingScript).toContain("spctl --assess --type execute")
    expect(safariPackagingScript).toContain("Safari can reject this app")
    expect(safariPackagingScript).toContain('pluginkit -r "$APP/Contents/PlugIns/InterceptorSafari Extension.appex"')
  })

  test("Safari packaging rebuilds web-extension bytes before signing", () => {
    expect(safariPackagingScript).toContain('bash "$SCRIPT_DIR/build.sh"')
    expect(safariPackagingScript).toContain("INTERCEPTOR_SKIP_BASE_BUILD")
  })

  test("Gatekeeper assesses the same staged app bytes that pkgbuild consumes", () => {
    expect(safariPackagingScript).toContain("/private/tmp/interceptor-safari-assess.XXXXXX")
    expect(safariPackagingScript).toContain('spctl --assess --type execute --verbose=4 "$ASSESS_APP"')
    expect(safariPackagingScript).toContain('pkgbuild --component "$ASSESS_APP"')
  })

  test("Safari installer removes verified legacy duplicates from LaunchServices", () => {
    expect(safariPackagingScript).toContain('--scripts "$PKG_SCRIPTS_DIR"')
    expect(safariPostinstall).toContain("/Applications/.InterceptorSafari-*.noindex")
    expect(safariPostinstall).toContain('= "$APP_ID"')
    expect(safariPostinstall).toContain('= "$EXTENSION_ID"')
    expect(safariPostinstall).toContain('pluginkit -r "$legacy_appex"')
    expect(safariPostinstall).toContain('recovery/safari')
    expect(safariPostinstall).toContain('/bin/mv "$legacy_app" "$target"')
    expect(safariPostinstall).not.toContain("rm -rf")
  })

  test("containing app explains the user enablement gate", () => {
    expect(containingAppPage).toContain("interceptor contexts")
    expect(containingAppPage).toContain("Safari requires you to approve")
  })
})
