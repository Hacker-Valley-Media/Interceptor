import { describe, expect, test } from "bun:test"
import {
  appContextId,
  appSlug,
  cdpContextId,
  isAppContextId,
  isCdpContextId,
  isElectronMainProcessArgs,
  jsonShape,
  parseDebugPortFromArgs,
  parseJsonTargets,
  pickPageTarget,
  redactHeaders,
} from "../shared/cdp-app"
import { electronAppMatches, existingRemoteDebuggingPortFallback, relaunchPath } from "../daemon/cdp/manager"

describe("parseJsonTargets", () => {
  test("normalizes and filters /json entries", () => {
    const targets = parseJsonTargets([
      { id: "A", type: "page", title: "Main", url: "https://web.descript.com/x", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/A" },
      { id: "B", type: "service_worker", title: "sw", url: "chrome://sw", /* no ws url */ },
      { id: "C", type: "weird-type", title: "t", url: "u", webSocketDebuggerUrl: "ws://x/C" },
    ])
    expect(targets.length).toBe(2)
    expect(targets[0].targetId).toBe("A")
    expect(targets[0].type).toBe("page")
    expect(targets[1].type).toBe("other") // unknown type normalized
  })

  test("non-array returns empty", () => {
    expect(parseJsonTargets(null)).toEqual([])
    expect(parseJsonTargets({})).toEqual([])
  })
})

describe("pickPageTarget", () => {
  const targets = parseJsonTargets([
    { id: "win", type: "page", title: "aux", url: "https://aux.example/", webSocketDebuggerUrl: "ws://x/win" },
    { id: "main", type: "page", title: "main", url: "https://web.descript.com/edit", webSocketDebuggerUrl: "ws://x/main" },
    { id: "wk", type: "worker", title: "w", url: "u", webSocketDebuggerUrl: "ws://x/wk" },
  ])

  test("prefers a page whose url matches the hint", () => {
    expect(pickPageTarget(targets, "web.descript.com")?.targetId).toBe("main")
  })
  test("falls back to the first page", () => {
    expect(pickPageTarget(targets)?.targetId).toBe("win")
  })
  test("falls back to the first target when no page", () => {
    const onlyWorker = parseJsonTargets([{ id: "w", type: "worker", title: "", url: "", webSocketDebuggerUrl: "ws://x/w" }])
    expect(pickPageTarget(onlyWorker)?.targetId).toBe("w")
  })
})

describe("parseDebugPortFromArgs", () => {
  test("reads --remote-debugging-port", () => {
    expect(parseDebugPortFromArgs("/x/Slack --remote-debugging-port=9222 --foo", "remote-debugging-port")).toBe(9222)
  })
  test("reads --inspect=host:port", () => {
    expect(parseDebugPortFromArgs("/x/Code --inspect=127.0.0.1:9229", "inspect")).toBe(9229)
  })
  test("reads --inspect=port", () => {
    expect(parseDebugPortFromArgs("/x/Code --inspect=4000", "inspect")).toBe(4000)
  })
  test("absent switch → undefined", () => {
    expect(parseDebugPortFromArgs("/x/Slack --foo", "remote-debugging-port")).toBeUndefined()
  })
})

describe("isElectronMainProcessArgs", () => {
  test("main process (no --type) with electron markers → true", () => {
    expect(isElectronMainProcessArgs("/Applications/Slack.app/Contents/MacOS/Slack --enable-features=Foo")).toBe(true)
  })
  test("renderer (--type=) → false", () => {
    expect(isElectronMainProcessArgs("/Applications/Slack.app/Contents/MacOS/Slack --type=renderer --enable-features=Foo")).toBe(false)
  })
  test("main relaunched with only --remote-debugging-port (minimal args) → candidate true", () => {
    // Apps relaunched via `macos cdp launch` carry no Chromium switches; the .app main
    // is still a candidate (framework check confirms Electron downstream).
    expect(isElectronMainProcessArgs("/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9222")).toBe(true)
  })
  test("plain non-electron process → false", () => {
    expect(isElectronMainProcessArgs("/usr/bin/ssh -L 9222:localhost:9222 host")).toBe(false)
  })
})

describe("context id helpers", () => {
  test("appSlug normalizes", () => {
    expect(appSlug("Visual Studio Code")).toBe("visual-studio-code")
    expect(appSlug("Descript.app")).toBe("descript")
  })
  test("cdp/app prefixes", () => {
    expect(cdpContextId("Slack")).toBe("cdp:slack")
    expect(appContextId("Slack")).toBe("app:slack")
    expect(isCdpContextId("cdp:slack")).toBe(true)
    expect(isAppContextId("app:slack")).toBe(true)
    expect(isCdpContextId("app:slack")).toBe(false)
  })
})

describe("app attach safety", () => {
  test("refuses Path 0 SIGUSR1 when an Electron app already has a CDP port", () => {
    const result = existingRemoteDebuggingPortFallback({
      pid: 1234,
      appName: "Slack",
      command: "/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9222",
      remoteDebuggingPort: 9222,
    })
    expect(result?.success).toBe(false)
    expect(result?.error).toContain("refusing Path 0 SIGUSR1")
    expect(result?.error).toContain("macos cdp connect 9222")
    expect(result?.data).toEqual({
      fallback: "cdp",
      reason: "existing_remote_debugging_port",
      remoteDebuggingPort: 9222,
      contextId: "cdp:slack",
    })
  })

  test("does not block Path 0 when no existing CDP port is present", () => {
    expect(existingRemoteDebuggingPortFallback({
      pid: 1234,
      appName: "Slack",
      command: "/Applications/Slack.app/Contents/MacOS/Slack",
    })).toBeUndefined()
  })
})

describe("redactHeaders", () => {
  test("redacts sensitive header values (object shape)", () => {
    const out = redactHeaders({ authorization: "Bearer x", "x-foo": "bar", cookie: "sid=1" }) as Record<string, string>
    expect(out.authorization).toBe("[redacted]")
    expect(out.cookie).toBe("[redacted]")
    expect(out["x-foo"]).toBe("bar")
  })
  test("redacts array shape", () => {
    const out = redactHeaders([{ name: "Authorization", value: "x" }, { name: "Accept", value: "*/*" }]) as Array<{ name: string; value: string }>
    expect(out[0].value).toBe("[redacted]")
    expect(out[1].value).toBe("*/*")
  })
})

describe("jsonShape", () => {
  test("preserves keys, types scalars", () => {
    expect(jsonShape({ a: 1, b: "x", c: [{ d: true }] })).toEqual({ a: "<number>", b: "<string>", c: [{ d: "<boolean>" }] })
  })
})

describe("Electron app selection and relaunch path", () => {
  const proc = (pid: number, appName: string) => ({ pid, appName, command: `/apps/${appName}` })
  test("a unique exact name wins over apps whose names contain it", () => {
    const procs = [proc(1, "Notion"), proc(2, "Notion Calendar")]
    expect(electronAppMatches(procs, "notion").map(p => p.pid)).toEqual([1])
    expect(electronAppMatches(procs, "calendar").map(p => p.pid)).toEqual([2])
    expect(electronAppMatches(procs, "not").length).toBe(2)
    expect(electronAppMatches([proc(1, "Notion"), proc(3, "Notion")], "Notion").length).toBe(2)
  })
  test("an AppImage relaunches from its image file, not the mount that ends with the app", () => {
    const target = { pid: 7, executable: "/tmp/.mount_OwnedX1/owned-app" }
    expect(relaunchPath(target, "HOME=/h\0APPIMAGE=/opt/Owned.AppImage\0APPDIR=/tmp/.mount_OwnedX1\0")).toBe("/opt/Owned.AppImage")
    expect(relaunchPath(target, "HOME=/h\0APPIMAGE=/opt/Owned.AppImage\0APPDIR=/tmp/.mount_Other\0")).toBe(target.executable)
    expect(relaunchPath({ pid: 8, executable: "/opt/owned/owned-app" }, "HOME=/h\0")).toBe("/opt/owned/owned-app")
  })
})
