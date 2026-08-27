import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const readScript = (name: string) =>
  readFileSync(resolve(root, "scripts", name), "utf8")

describe("release source-path sanitization", () => {
  test("maps SwiftPM dependency paths in the native bridge build", () => {
    const source = readScript("build-bridge.sh")

    expect(source).toContain(
      "-ffile-prefix-map=$BRIDGE_DIR/.build/checkouts=/src/interceptor-deps",
    )
    expect(source).toContain('swift build -c release "${SWIFT_FLAGS[@]}"')
  })

  test("maps C and Swift source paths in the bundled iOS runner", () => {
    const source = readScript("release.sh")

    expect(source).toContain('PUBLIC_SOURCE_ROOT="/src/interceptor"')
    expect(source).toContain(
      '"OTHER_CFLAGS=-ffile-prefix-map=$REPO_ROOT=$PUBLIC_SOURCE_ROOT',
    )
    expect(source).toContain(
      '"OTHER_SWIFT_FLAGS=-file-prefix-map $REPO_ROOT=$PUBLIC_SOURCE_ROOT',
    )
    expect(source).toContain(
      "-file-compilation-dir $PUBLIC_SOURCE_ROOT/ios/InterceptorRunner",
    )
    expect(source).toContain('RUNNER_XCTESTRUN_REL="${RUNNER_XCTESTRUN#')
    expect(source).toContain('RUNNER_APP_REL="${RUNNER_APP#')
    expect(source).toContain(
      '"$RUNNER_XCTESTRUN_REL" "$RUNNER_APP_REL"',
    )
    expect(source).toContain("tar --uid 0 --gid 0 --uname root --gname wheel")
    expect(source).not.toContain("tar --exclude='*.dSYM'")
  })

  test("maps C and Swift source paths in the Safari app build", () => {
    const source = readScript("build-safari.sh")

    expect(source).toContain('PUBLIC_SOURCE_ROOT="/src/interceptor"')
    expect(source).toContain(
      '"OTHER_CFLAGS=-ffile-prefix-map=$REPO_ROOT=$PUBLIC_SOURCE_ROOT',
    )
    expect(source).toContain(
      '"OTHER_SWIFT_FLAGS=-file-prefix-map $REPO_ROOT=$PUBLIC_SOURCE_ROOT',
    )
    expect(source).toContain(
      "-file-compilation-dir $PUBLIC_SOURCE_ROOT/safari/InterceptorSafari",
    )
  })
})
