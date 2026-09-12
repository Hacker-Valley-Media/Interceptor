import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/**
 * A runner that `ios setup` built and signed must survive a change to the
 * bundled (unsigned) artifact. Restaging the bundled build over it replaced a
 * working signed runner with one iOS rejects, so every package upgrade needed a
 * fresh `ios setup`. Without the setup marker the old refresh behavior stays.
 */
test("stageRunner keeps a setup-built runner across bundled-artifact changes, refreshes an unmarked one", async () => {
  const root = mkdtempSync(join(tmpdir(), "ios-runner-keep-signed-"))
  const source = join(root, "source")
  const app = join(source, "Debug-iphoneos", "Fixture-Runner.app")
  mkdirSync(app, { recursive: true })
  writeFileSync(join(source, "Fixture.xctestrun"), "fixture")
  writeFileSync(join(app, "Fixture"), "v1")
  const modulePath = resolve("daemon/ios/tools.ts")
  const script = `
    import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
    import * as os from "node:os";
    import { mock } from "bun:test";
    import { join } from "node:path";
    const realOs = { ...os };
    mock.module("node:os", () => ({ ...realOs, homedir: () => ${JSON.stringify(join(root, "home"))} }));
    const { stageRunner } = await import(${JSON.stringify(modulePath)});
    const source = ${JSON.stringify(source)};
    const stage = ${JSON.stringify(join(root, "home", ".interceptor", "ios", "runner"))};
    const staged = () => readFileSync(join(stage, "Debug-iphoneos", "Fixture-Runner.app", "Fixture"), "utf8");
    // 1. first stage copies the bundled build
    if (stageRunner().error || staged() !== "v1") process.exit(2);
    // 2. pretend ios setup signed it: marker present, contents differ from the bundle
    writeFileSync(join(stage, ".setup-built"), "2026-09-12T00:00:00.000Z\\n");
    writeFileSync(join(stage, "Debug-iphoneos", "Fixture-Runner.app", "Fixture"), "signed-by-setup");
    // 3. the bundled artifact changes (a package upgrade)
    writeFileSync(join(source, "Debug-iphoneos", "Fixture-Runner.app", "Fixture"), "v2");
    const kept = stageRunner();
    if (kept.error || staged() !== "signed-by-setup") { console.error("setup-built runner was restaged:", staged()); process.exit(3); }
    if (!existsSync(join(stage, ".setup-built"))) process.exit(4);
    // 4. without the marker the bundled change is picked up as before
    rmSync(join(stage, ".setup-built"));
    if (stageRunner().error || staged() !== "v2") { console.error("unmarked runner was not refreshed:", staged()); process.exit(5); }
    if (existsSync(join(stage, ".setup-built"))) process.exit(6);
  `
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, INTERCEPTOR_IOS_USE_XCODE: "1", INTERCEPTOR_RUNNER_DIR: source },
    stdout: "pipe", stderr: "pipe",
  })
  const code = await child.exited
  const stderr = await new Response(child.stderr).text()
  expect(code, stderr).toBe(0)
  rmSync(root, { recursive: true, force: true })
})
