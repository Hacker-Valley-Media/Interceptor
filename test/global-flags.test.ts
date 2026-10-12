import { describe, expect, test } from "bun:test"

import { parseMacosCommand } from "../cli/commands/macos"
import { buildFilteredArgs, globalGroupFlagIndex } from "../cli/global-flags"

describe("buildFilteredArgs", () => {
  test("preserves exact native Contacts membership scope alongside a leading browser group", () => {
    for (const surface of ["macos", "desktop"]) {
      const native = [surface, "contacts", "list", "--group", "native:id-with-more-than-32-characters", "--limit", "20"]
      expect(buildFilteredArgs(native)).toEqual(native)
      expect(globalGroupFlagIndex(native)).toBe(-1)
      expect(buildFilteredArgs(["--group", "browser-lane", ...native])).toEqual(native)
      expect(globalGroupFlagIndex(["--context", "main", "--group", "browser-lane", ...native])).toBe(2)
    }
    expect(buildFilteredArgs(["read", "--group", "browser-lane"])).toEqual(["read"])
    expect(globalGroupFlagIndex(["type", "e1", "--", "--group", "literal"])).toBe(-1)
  })
  test("removes --context and only its value", () => {
    expect(buildFilteredArgs(["read", "work", "--context", "work"])).toEqual(["read", "work"])
  })

  test("removes --tab and only its value", () => {
    expect(buildFilteredArgs(["read", "42", "--tab", "42"])).toEqual(["read", "42"])
  })

  test("removes standalone global transport flags", () => {
    expect(buildFilteredArgs(["read", "--ws", "--any-tab", "main"])).toEqual(["read", "main"])
  })

  test("removes global --json in leading positions", () => {
    expect(buildFilteredArgs(["--json", "status"])).toEqual(["status"])
    expect(buildFilteredArgs(["status", "--json"])).toEqual(["status"])
    expect(buildFilteredArgs(["--frame", "0", "--json", "eval", "1+1"])).toEqual(["eval", "1+1"])
  })

  test("strips the global --frame flag from native argv as well", () => {
    expect(buildFilteredArgs(["--frame", "7", "ios", "tree"])).toEqual(["ios", "tree"])
    expect(buildFilteredArgs(["macos", "tree", "--frame=7"])).toEqual(["macos", "tree"])
    expect(buildFilteredArgs(["macos", "monitor", "start", "--frames", "1"])).toEqual(["macos", "monitor", "start", "--frames", "1"])
  })

  test("preserves command-local --json outside leading global positions", () => {
    expect(buildFilteredArgs(["macos", "translate", "batch", "--json", "payload"])).toEqual(["macos", "translate", "batch", "--json", "payload"])
    expect(buildFilteredArgs(["desktop", "overlay", "ctl", "s", "append-script", "--json", "{}"])).toEqual(["desktop", "overlay", "ctl", "s", "append-script", "--json", "{}"])
    expect(buildFilteredArgs(["desktop", "monitor", "export", "s", "--json"])).toEqual(["desktop", "monitor", "export", "s", "--json"])
  })

  test("a bare trailing --json on translate and overlay is the output flag, not a payload", () => {
    for (const surface of ["macos", "desktop"]) {
      for (const argv of [[surface, "overlay", "list", "--json"], [surface, "translate", "languages", "--json"], [surface, "translate", "batch", "--json", "--from", "en"]]) {
        expect(buildFilteredArgs(argv)).toEqual(argv.filter(arg => arg !== "--json"))
      }
    }
    expect(parseMacosCommand(buildFilteredArgs(["macos", "overlay", "list", "--json"]))).toMatchObject({ type: "macos_overlay_list" })
    expect(parseMacosCommand(buildFilteredArgs(["desktop", "translate", "languages", "--json"]), undefined, true)).toMatchObject({ type: "macos_translate", sub: "languages" })
  })

  test("a trailing --json on other native families is the output flag, not a field", () => {
    for (const family of ["calendar", "reminders", "contacts", "photos", "location", "share", "maps", "vm", "container"]) {
      expect(buildFilteredArgs(["desktop", family, "status", "--json"])).toEqual(["desktop", family, "status"])
      expect(buildFilteredArgs(["macos", family, "status", "--json"])).toEqual(["macos", family, "status"])
    }
  })

  test("preserves global-looking tokens after the option terminator", () => {
    expect(buildFilteredArgs(["type", "e1", "--", "--shared-group", "--group", "literal"]))
      .toEqual(["type", "e1", "--", "--shared-group", "--group", "literal"])
    expect(buildFilteredArgs(["type", "e1", "--", "--json"]))
      .toEqual(["type", "e1", "--", "--json"])
  })
})
