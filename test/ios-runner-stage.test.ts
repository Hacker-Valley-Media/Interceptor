import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("ios login fails before reading a password or contacting the daemon", () => {
  const result = Bun.spawnSync([
    process.execPath,
    resolve("cli/index.ts"),
    "ios", "login", "--apple-id", "nobody@example.invalid", "--stdin",
  ], { stdin: Buffer.from("must-not-be-read\n") })
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain("ios login is unavailable")
  expect(result.stderr.toString()).toContain("interceptor ios setup")
  expect(result.stderr.toString()).not.toContain("password")
})

test("ios install refuses an unsigned release runner before device access", async () => {
  const root = mkdtempSync(join(tmpdir(), "ios-runner-unsigned-"))
  const source = join(root, "source")
  const app = join(source, "Debug-iphoneos", "Fixture-Runner.app")
  mkdirSync(app, { recursive: true })
  writeFileSync(join(source, "Fixture.xctestrun"), "fixture")
  writeFileSync(join(app, "Info.plist"), "fixture")
  const modulePath = resolve("daemon/ios/tools.ts")
  const script = `
    import * as os from "node:os";
    import { mock } from "bun:test";
    const realOs = { ...os };
    mock.module("node:os", () => ({ ...realOs, homedir: () => ${JSON.stringify(join(root, "home"))} }));
    const { installRunnerApp } = await import(${JSON.stringify(modulePath)});
    const result = await installRunnerApp("fixture");
    if (result.ok || !result.error?.includes("interceptor ios setup fixture")) process.exit(2);
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

test("stageRunner refreshes a cached runner when the source artifact changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ios-runner-stage-"))
  const source = join(root, "source")
  const app = join(source, "Debug-iphoneos", "Fixture-Runner.app")
  mkdirSync(app, { recursive: true })
  writeFileSync(join(source, "Fixture.xctestrun"), "fixture")
  writeFileSync(join(app, "Fixture"), "v1")
  const modulePath = resolve("daemon/ios/tools.ts")
  const script = `
    import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
    import * as os from "node:os";
    import { mock } from "bun:test";
    import { join } from "node:path";
    const realOs = { ...os };
    mock.module("node:os", () => ({ ...realOs, homedir: () => ${JSON.stringify(join(root, "home"))} }));
    const { stageRunner, buildRunnerWithXcode, installRunnerApp } = await import(${JSON.stringify(modulePath)});
    const source = ${JSON.stringify(source)};
    const staged = () => join(${JSON.stringify(join(root, "home", ".interceptor", "ios", "runner"))}, "Debug-iphoneos", "Fixture-Runner.app", "Fixture");
    if (stageRunner().error || readFileSync(staged(), "utf8") !== "v1") process.exit(2);
    writeFileSync(join(source, "Debug-iphoneos", "Fixture-Runner.app", "Fixture"), "v2");
    if (stageRunner().error || readFileSync(staged(), "utf8") !== "v2") process.exit(3);
    const derived = ${JSON.stringify(join(root, "derived"))};
    // Replace only external Xcode/install processes; exercise real build staging
    // and installer selection without touching a device or signing identity.
    let buildArgs = [];
    let expiration = new Date(Date.now() + 86_400_000).toISOString();
    Bun.spawnSync = ((args, opts) => {
      if (args.includes("build-for-testing")) {
        buildArgs = args;
        const products = join(derived, "Build", "Products");
        const app = join(products, "Debug-iphoneos", "Fixture-Runner.app");
        mkdirSync(join(app, "PlugIns", "Fixture.xctest"), { recursive: true });
        writeFileSync(join(app, "Fixture"), "xcode-signed");
        writeFileSync(join(app, "Info.plist"), "fixture");
        writeFileSync(join(app, "embedded.mobileprovision"), "fixture");
        writeFileSync(join(products, "Fixture.xctestrun"), "xcode-launch");
      }
      const command = String(args[0]);
      const ok = (stdout = "", stderr = "") => ({ success: true, exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
      if (command.endsWith("plutil") && args.includes("-extract")) {
        const key = args[2];
        if (key === "CFBundleIdentifier") return ok('com.interceptor.runner.fixture.xctrunner\\n');
        if (key === "TeamIdentifier") return ok(JSON.stringify(["FIXTURE"]));
        if (key === "ProvisionedDevices") return ok(JSON.stringify(["fixture"]));
        if (key === "Entitlements.application-identifier") return ok("FIXTURE.*");
        if (key === "ExpirationDate") return ok(expiration);
      }
      if (command.endsWith("security")) return ok("PROFILE");
      if (command.endsWith("plutil") && args.includes("json")) {
        const input = opts?.stdin ? Buffer.from(opts.stdin).toString("utf8") : "";
        if (input.includes("<?xml")) return ok(JSON.stringify({
          "application-identifier": "FIXTURE.com.interceptor.runner.fixture.xctrunner",
          "com.apple.developer.team-identifier": "FIXTURE",
          "get-task-allow": true,
        }));
      }
      if (command.endsWith("codesign") && args.includes("--entitlements")) return ok('<?xml version="1.0"?><plist/>');
      if (command.endsWith("codesign") && args.includes("-dvvv")) return ok('', 'TeamIdentifier=FIXTURE\\n');
      if (args.includes("install") && readFileSync(join(args.at(-1), "Fixture"), "utf8") !== "xcode-signed") throw new Error("installed unsigned bundle");
      return ok();
    });
    const built = buildRunnerWithXcode("fixture", { teamId: "FIXTURE", projectPath: source, derivedDataPath: derived });
    if (!buildArgs.includes("PRODUCT_BUNDLE_IDENTIFIER=com.interceptor.runner.fixture")) throw new Error("derived bundle id was not passed to Xcode");
    if (built.bundleId !== "com.interceptor.runner.fixture.xctrunner") throw new Error("actual bundle id was not returned");
    if (!(await installRunnerApp("fixture", built.bundleId, true)).ok) throw new Error("install failed");
    expiration = "2000-01-01T00:00:00Z";
    const expired = await installRunnerApp("fixture", built.bundleId, true);
    if (expired.ok || !expired.error?.includes("profile has expired")) throw new Error("expired profile reached device install");
    expiration = "";
    const undated = await installRunnerApp("fixture", built.bundleId, true);
    if (undated.ok || !undated.error?.includes("no valid expiration date")) throw new Error("undated profile reached device install");
    if (stageRunner().error || readFileSync(staged(), "utf8") !== "xcode-signed") throw new Error("launch replaced prepared runner");
    if (readFileSync(built.xctestrunPath, "utf8") !== "xcode-launch") throw new Error("launch descriptor replaced");
    writeFileSync(join(source, "Debug-iphoneos", "Fixture-Runner.app", "Fixture"), "v3");
    if (stageRunner().error || readFileSync(staged(), "utf8") !== "v3") throw new Error("stale source was retained");
  `
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, INTERCEPTOR_IOS_USE_XCODE: "1", INTERCEPTOR_RUNNER_DIR: source },
    stdout: "pipe", stderr: "pipe",
  })
  const code = await child.exited
  const stderr = await new Response(child.stderr).text()
  expect(code, stderr).toBe(0)
  expect(readFileSync(join(root, "home", ".interceptor", "ios", "runner", "Debug-iphoneos", "Fixture-Runner.app", "Fixture"), "utf8")).toBe("v3")
  rmSync(root, { recursive: true, force: true })
})
