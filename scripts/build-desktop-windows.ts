#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, statSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { resolve, join } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { captureSubprocessSync } from "../shared/subprocess-sync"

// ring's Windows ARM64 build selects clang's GNU driver while xwin supplies
// CL-style SDK include arguments. Preserve every other compiler argument.
// INTERCEPTOR_CLANG is the Apple clang the build resolved (xcrun --find clang unless set).
export async function runClang(raw: string[]): Promise<void> {
  const args: string[] = []
  for (const arg of raw) {
    if (arg === "/imsvc") args.push("-isystem")
    else if (arg.startsWith("/imsvc")) args.push("-isystem", arg.slice(6))
    else args.push(arg)
  }
  const child = Bun.spawn([process.env.INTERCEPTOR_CLANG!, ...args], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  })
  process.exitCode = await child.exited
}

if (import.meta.main) {
  const sourceSHA256 = createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex")
  const [architecture, operation = "build", ...options] = process.argv.slice(2)
  if (!["x64", "arm64"].includes(architecture) || !["build", "check", "test"].includes(operation)) {
    throw Error("usage: bun scripts/build-desktop-windows.ts <x64|arm64> [build|check|test] [cargo options]")
  }
  if (options.some(arg => arg.startsWith("--target") || arg.startsWith("--manifest-path"))) {
    throw Error("The build script owns the Windows target and manifest")
  }
  const root = resolve(import.meta.dir, "..")
  const target = architecture === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  const manifest = join(root, "interceptor-desktop", "Cargo.toml")
  const env = { ...process.env }
  let tools: string | undefined
  const versions: Record<string, string> = {}
  const output = (args: string[]) => {
    const result = captureSubprocessSync(args[0], args.slice(1), {
      encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
    })
    if (result.error || result.status !== 0) throw Error(result.error?.message ?? result.stderr)
    return result.stdout.trim()
  }
  const sysroot = output(["rustc", "--print", "sysroot"])
  // Link the C runtime statically so the provider starts on Windows images without the
  // Visual C++ redistributable (VCRUNTIME140.dll). cargo-xwin appends its own target flags.
  // Keep build-machine paths out of the shipped binaries: the cargo registry, the Rust
  // toolchain's library sources and this checkout.
  const remap = [[env.CARGO_HOME || join(homedir(), ".cargo"), "/cargo"], [sysroot, "/rust/toolchain"], [root, "/src/interceptor"]]
    .map(([from, to]) => `--remap-path-prefix=${from}=${to}`)
  // Cargo splits this variable on spaces, so a path with one cannot be mapped here.
  if (remap.some(flag => /\s/.test(flag))) throw Error("Path remapping needs a cargo home, toolchain and checkout path without spaces")
  const rustflagsKey = `CARGO_TARGET_${target.toUpperCase().replace(/-/g, "_")}_RUSTFLAGS`
  env[rustflagsKey] = [env[rustflagsKey], "-C target-feature=+crt-static", ...remap].filter(Boolean).join(" ")
  if (process.platform === "darwin") {
    const clang = env.INTERCEPTOR_CLANG ||= output(["xcrun", "--find", "clang"])
    versions.rust = output(["rustc", "--version"])
    versions.xwin = output(["cargo", "xwin", "--version"])
    versions.clang = output([clang, "--version"]).split("\n")[0]
    if (!versions.rust.startsWith("rustc 1.94.0 ") ||
        versions.xwin !== "cargo-xwin-xwin 0.23.1" ||
        !versions.clang.startsWith("Apple clang version 17.0.0 ")) {
      throw Error("Mac Windows cross compiler differs from the qualified toolchain")
    }
    const host = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
    const hostLinker = join(sysroot, "lib", "rustlib", host, "bin", "rust-lld")
    if (!statSync(hostLinker).isFile()) throw Error("The qualified Rust linker is missing")
    const staging = join(root, ".interceptor")
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    tools = mkdtempSync(join(staging, "windows-cross-tools-"))
    // xwin changes compiler links in its cache. Each invocation owns those
    // links and reuses only the already completed SDK inputs.
    const sdk = realpathSync(join(homedir(), "Library", "Caches", "cargo-xwin", "xwin"))
    const completed = readFileSync(join(sdk, "DONE"), "utf8").split("\n")[0].split(/\s+/)
    const sdkArch = architecture === "arm64" ? "aarch64" : "x86_64"
    if (!completed.includes(sdkArch)) throw Error("The cached Windows SDK lacks the selected architecture")
    const cache = join(tools, "cache")
    mkdirSync(cache, { mode: 0o700 })
    symlinkSync(sdk, join(cache, "xwin"))
    env.XWIN_CACHE_DIR = cache
    env.XWIN_ARCH = sdkArch
    const driver = "#!" + process.execPath + "\nimport {runClang} from " +
      JSON.stringify(import.meta.filename) + "; await runClang(process.argv.slice(2));\n"
    writeFileSync(join(tools, "clang"), driver, { flag: "wx", mode: 0o700 })
    symlinkSync(clang, join(tools, "clang-cl"))
    symlinkSync(hostLinker, join(tools, "lld-link"))
    env.PATH = tools + ":" + (env.PATH ?? "")
  } else if (process.platform !== "win32") {
    throw Error("Windows native builds require Windows or the qualified Mac cross compiler")
  }
  const command = ["cargo", ...(process.platform === "darwin" ? ["xwin"] : []),
    operation, "--locked", "--release", "--target", target, "--manifest-path", manifest, ...options]
  const child = Bun.spawn(command, { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const exit = await child.exited
  if (tools) {
    writeFileSync(join(tools, "receipt.json"), JSON.stringify({
      at: new Date().toISOString(), architecture, target, command, exit, versions,
      sourceSHA256, xwinCache: env.XWIN_CACHE_DIR,
      compilerDriverSHA256: createHash("sha256").update(readFileSync(join(tools, "clang"))).digest("hex"),
      nativeRuntimeChecked: false,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    console.log("Windows build toolchain receipt: " + readFileSync(join(tools, "receipt.json"), "utf8").replace(/\s+/g, " ").trim())
    // The tools folder only wraps the compiler for this one build; do not leave it behind.
    rmSync(tools, { recursive: true, force: true })
  }
  process.exitCode = exit
}
