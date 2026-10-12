// Accessibility reads and element actions: tree, find, inspect, value, action, focused,
// windows, text, menu. Every subcommand and flag from the CLI inventory appears below.
import { type Family, refuse, skip } from "../types"
import { contains, lacks, list, pid, waitState, windowId } from "./helpers"

export const accessibility: Family[] = [
  {
    family: "tree",
    cases: [
      { id: "tree.app", sub: "-", args: ctx => ["tree", "--app", ctx.fixture.app], flags: ["--app"], check: contains("Fixture input") },
      { id: "tree.pid-filter-all-depth", sub: "-", args: ctx => ["tree", "--pid", pid(ctx), "--filter", "all", "--depth", "6"], flags: ["--pid", "--filter", "--depth"], check: contains("Submit fixture") },
      { id: "tree.filter-interactive", sub: "-", args: ctx => ["tree", "--pid", pid(ctx), "--filter", "interactive"], flags: ["--filter"], check: contains("Submit fixture") },
      { id: "tree.budgets", sub: "-", args: ctx => ["tree", "--pid", pid(ctx), "--max-chars", "4000", "--max-nodes", "60", "--max-ms", "5000"], flags: ["--max-chars", "--max-nodes", "--max-ms"] },
      { id: "tree.window", sub: "-", args: async ctx => ["tree", "--pid", pid(ctx), "--window", await windowId(ctx)], flags: ["--window"], check: contains("Fixture input") },
      { id: "tree.background-only", sub: "-", args: ctx => ["tree", "--pid", pid(ctx), "--background-only"], flags: ["--background-only"], check: contains("Fixture input") },
      { id: "tree.bad-depth", sub: "-", args: ctx => ["tree", "--pid", pid(ctx), "--depth", "-3"], expect: { all: refuse() } },
    ],
  },
  {
    family: "find",
    cases: [
      { id: "find.app", sub: "-", args: ctx => ["find", "Submit fixture", "--app", ctx.fixture.app], flags: ["--app"], check: contains("Submit fixture") },
      { id: "find.role-pid", sub: "-", args: ctx => ["find", "fixture", "--pid", pid(ctx), "--role", "button"], flags: ["--pid", "--role"],
        check: r => list(r).length && list(r).every(x => /button/i.test(String(x.role))) ? undefined : `expected only buttons: ${JSON.stringify(r.json).slice(0, 200)}` },
      { id: "find.budgets", sub: "-", args: ctx => ["find", "fixture", "--pid", pid(ctx), "--max-nodes", "40", "--max-ms", "4000"], flags: ["--max-nodes", "--max-ms"] },
      { id: "find.no-match", sub: "-", args: ctx => ["find", "zz-no-such-parity-element", "--pid", pid(ctx)], check: r => list(r).length ? "expected no matches" : undefined },
    ],
  },
  {
    family: "inspect",
    cases: [
      { id: "inspect.ref-pid", sub: "<ref>", args: async ctx => ["inspect", await ctx.ref("Fixture input"), "--pid", pid(ctx)], flags: ["--pid"], check: contains("Fixture input") },
      { id: "inspect.ref-app", sub: "<ref>", args: async ctx => ["inspect", await ctx.ref("Submit fixture"), "--app", ctx.fixture.app], flags: ["--app"], check: contains("Submit fixture") },
      { id: "inspect.app", sub: "(no ref)", args: ctx => ["inspect", "--app", ctx.fixture.app], flags: ["--app"] },
      { id: "inspect.pid", sub: "(no ref)", args: ctx => ["inspect", "--pid", pid(ctx)], flags: ["--pid"] },
      { id: "inspect.stale-ref", sub: "<ref>", args: ctx => ["inspect", "e987654321", "--pid", pid(ctx)], expect: { all: refuse() } },
    ],
  },
  {
    family: "value",
    cases: [
      { id: "value.read", sub: "-", args: async ctx => ["value", await ctx.ref("Read-only fixture input"), "--pid", pid(ctx)], flags: ["--pid"], check: contains("UNCHANGED READ ONLY") },
      { id: "value.write", sub: "-", args: async ctx => ["value", await ctx.ref("Fixture input"), "parity value", "--pid", pid(ctx)],
        check: (_r, ctx) => waitState(ctx, s => s.input === "parity value", "input = parity value") },
      { id: "value.write-app-window", sub: "-", args: async ctx => ["value", await ctx.ref("Fixture input"), "parity window", "--app", ctx.fixture.app, "--window", await windowId(ctx)], flags: ["--app", "--window"],
        check: (_r, ctx) => waitState(ctx, s => s.input === "parity window", "input = parity window") },
      { id: "value.read-only-write", sub: "-", args: async ctx => ["value", await ctx.ref("Read-only fixture input"), "changed", "--pid", pid(ctx)], expect: { all: refuse() } },
      { id: "value.disabled-write", sub: "-", args: async ctx => ["value", await ctx.ref("Disabled fixture input"), "changed", "--pid", pid(ctx)], expect: { all: refuse() } },
      { id: "value.password-masked", sub: "-", args: async ctx => ["value", await ctx.ref("Fixture password"), "--pid", pid(ctx)], check: lacks("PARITY-SYNTHETIC-SECRET") },
    ],
  },
  {
    family: "action",
    cases: [
      { id: "action.list", sub: "-", args: async ctx => ["action", await ctx.ref("Submit fixture"), "--pid", pid(ctx)], flags: ["--pid"] },
      { id: "action.press-checkbox", sub: "-", args: async ctx => ["action", await ctx.ref("Fixture checkbox"), "press", "--pid", pid(ctx)],
        check: (_r, ctx) => waitState(ctx, s => s.checkbox === true, "checkbox checked") },
      { id: "action.press-background-only", sub: "-", args: async ctx => ["action", await ctx.ref("Submit fixture"), "press", "--pid", pid(ctx), "--background-only"], flags: ["--background-only"],
        check: (_r, ctx) => waitState(ctx, s => s.clicks >= 1, "a submit click") },
      { id: "action.app-window", sub: "-", args: async ctx => ["action", await ctx.ref("Submit fixture"), "press", "--app", ctx.fixture.app, "--window", await windowId(ctx)], flags: ["--app", "--window"],
        check: (_r, ctx) => waitState(ctx, s => s.clicks >= 2, "a second submit click") },
      { id: "action.disabled", sub: "-", args: async ctx => ["action", await ctx.ref("Disabled fixture button"), "press", "--pid", pid(ctx)], expect: { all: refuse() } },
    ],
  },
  {
    family: "focused",
    cases: [
      // On the shared Mac the system-wide focus is whatever app the person has in front; it may have no focused element.
      { id: "focused.system", sub: "-", args: ["focused"], expect: { darwin: { ok: true, orRefuse: { code: "unsupported_target", error: /^no focused element$/ } } } },
      { id: "focused.app", sub: "-", args: ctx => ["focused", "--app", ctx.fixture.app], flags: ["--app"] },
      { id: "focused.pid", sub: "-", args: ctx => ["focused", "--pid", pid(ctx)], flags: ["--pid"] },
    ],
  },
  {
    family: "windows",
    cases: [
      { id: "windows.all", sub: "-", args: ["windows"], check: r => list(r).length ? undefined : "no windows listed" },
      { id: "windows.app", sub: "-", args: ctx => ["windows", "--app", ctx.fixture.app], flags: ["--app"], check: contains("Interceptor Parity Observer") },
      { id: "windows.pid", sub: "-", args: ctx => ["windows", "--pid", pid(ctx)], flags: ["--pid"], check: contains("Interceptor Parity Fixture") },
    ],
  },
  {
    family: "text",
    cases: [
      { id: "text.full", sub: "-", args: async ctx => ["text", await ctx.ref("Selection fixture input"), "--pid", pid(ctx)], flags: ["--pid"], check: contains("Before Selected") },
      { id: "text.selection", sub: "-", args: async ctx => ["text", await ctx.ref("Selection fixture input"), "--selection", "--app", ctx.fixture.app], flags: ["--selection", "--app"], check: contains("Selected") },
      { id: "text.visible-window", sub: "-", args: async ctx => ["text", await ctx.ref("Scroll fixture input"), "--visible", "--pid", pid(ctx), "--window", await windowId(ctx)], flags: ["--visible", "--window"], check: contains("Scroll fixture line") },
      { id: "text.exclusive-modes", sub: "-", args: async ctx => ["text", await ctx.ref("Selection fixture input"), "--selection", "--visible", "--pid", pid(ctx)], expect: { all: refuse() } },
    ],
  },
  {
    family: "menu",
    cases: [
      { id: "menu.list-pid", sub: "-", args: ctx => ["menu", "--pid", pid(ctx)], flags: ["--pid"], check: (r, ctx) => contains(ctx.host === "darwin" ? "Apple" : "File")(r) },
      { id: "menu.list-app", sub: "-", args: ctx => ["menu", "--app", ctx.fixture.app], flags: ["--app"], check: (r, ctx) => contains(ctx.host === "darwin" ? "Apple" : "File")(r) },
      { id: "menu.invoke", sub: "-", args: ctx => ["menu", "File", "Mark fixture", "--pid", pid(ctx)], expect: { darwin: skip("the accessory Mac fixture has no menu bar") },
        check: (_r, ctx) => waitState(ctx, s => s.menu === "invoked", "menu invoked") },
      { id: "menu.invoke-window-background", sub: "-", expect: { darwin: skip("the accessory Mac fixture has no menu bar") }, args: async ctx => ["menu", "File", "Mark fixture", "--pid", pid(ctx), "--window", await windowId(ctx), "--background-only"], flags: ["--window", "--background-only"] },
      { id: "menu.missing-item", sub: "-", args: ctx => ["menu", "File", "No such parity item", "--pid", pid(ctx)], expect: { all: refuse("target_gone") } },
    ],
  },
]
