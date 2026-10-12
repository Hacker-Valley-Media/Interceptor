// Personal data stores: contacts, calendar, reminders, photos. Every subcommand and flag
// from the CLI inventory appears below. Reads of the real stores run everywhere; every
// mutation (and every read of an item this run created) is disruptive, so it runs on the
// Windows/Linux VMs only. Owned items are named "Interceptor Parity ..." and removed in
// later cases and again in teardown.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Case, type Ctx, type Exclusion, type Family, type Res, macOnly, refuse, skip } from "../types"
import { contains, list } from "./helpers"

type Part = string | ((ctx: Ctx) => string | Promise<string>)
/** Args resolved right before the case runs; the literal --flags are recorded for coverage. */
const t = (...parts: Part[]): Pick<Case, "args" | "flags"> => ({
  args: ctx => Promise.all(parts.map(p => typeof p === "string" ? p : p(ctx))),
  flags: parts.filter((p): p is string => typeof p === "string" && p.startsWith("--")),
})
const D = { disruptive: true } as const
/// Families that are Out on this host never create ids; their cases still send this one and must refuse.
const OUT_ID = "interceptor-parity-out"
/** An id created by an earlier case of this family. */
const v = (key: string) => (ctx: Ctx) => {
  if (!ctx.vars[key] && ctx.vars.outOnHost) return OUT_ID
  if (!ctx.vars[key]) throw new Error(`no ${key}: the case that creates it failed or was skipped`)
  return String(ctx.vars[key])
}
/** Keeps the created id for later cases (successful results only). */
const keep = (key: string, pick: (j: any) => unknown = j => j?.id) => (r: Res, ctx: Ctx) => {
  if (r.exit !== 0) return
  const x = pick(r.json)
  if (!x) return `no id in result: ${r.stdout.slice(0, 200)}`
  ctx.vars[key] = x
}
const drop = (...keys: string[]) => (r: Res, ctx: Ctx) => { if (r.exit === 0) for (const k of keys) delete ctx.vars[k] }
/** The result mentions the id kept under `key` (skipped when optional and nothing was created, e.g. on the Mac). */
const has = (key: string, optional = false) => (r: Res, ctx: Ctx) =>
  ctx.vars[key] ? contains(String(ctx.vars[key]))(r) : optional ? undefined : `no ${key} to look for`
const both = (...checks: ((r: Res, ctx: Ctx) => string | void | undefined)[]) => (r: Res, ctx: Ctx) => {
  for (const c of checks) { const f = c(r, ctx); if (f) return f }
}
/** Reads an existing id once (default list, first calendar, ...) and caches it in ctx.vars. */
async function lookup(ctx: Ctx, key: string, args: string[], pick: (j: any) => unknown): Promise<string> {
  if (ctx.vars[key]) return String(ctx.vars[key])
  const r = await ctx.run(args)
  const x = pick(r.json)
  if (!x && ctx.vars.outOnHost) return OUT_ID
  if (!x) throw new Error(`${args.join(" ")} returned no id: ${r.stdout.slice(0, 200)}`)
  return (ctx.vars[key] = String(x))
}
/** A path under the scratch dir, written first when content is given. */
const file = (name: string, content?: string | Buffer) => (ctx: Ctx) => {
  const path = join(ctx.dir, name)
  if (content !== undefined) writeFileSync(path, content)
  return path
}
const iso = (offsetMs: number) => () => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d+Z$/, "Z")
async function cleanup(ctx: Ctx, steps: string[][]) {
  for (const [key, ...args] of steps) if (ctx.vars[key]) await ctx.run([...args, String(ctx.vars[key])]).catch(() => {})
}

// Small real media (64x64 JPEG with a capture date, 64x64 PNG, 1 s 64x64 H.264 MP4) and one vCard.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD/4QDARXhpZgAATU0AKgAAAAgABQEaAAUAAAABAAAASgEbAAUAAAABAAAAUgEoAAMAAAABAAEAAAITAAMAAAABAAEAAIdpAAQAAAABAAAAWgAAAAAAAAABAAAAAQAAAAEAAAABAAWQAAAHAAAABDAyMzKQAwACAAAAFAAAAJyQEQACAAAABwAAALCRAQAHAAAABAECAwCgAQADAAAAAf//AAAAAAAAMjAyNjowMTowMiAwMzowNDowNQArMDA6MDAAAP/+ABBMYXZjNjIuMTEuMTAwAP/bAEMACBAQExATFhYWFhYWGhgaGxsbGhoaGhsbGx0dHSIiIh0dHRsbHR0gICIiJSYlIyMiIyYmKCgoMDAuLjg4OkVFU//EAEwAAQEAAAAAAAAAAAAAAAAAAAAFAQEBAAAAAAAAAAAAAAAAAAAABhABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAEAAQAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIIC7TgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//Z", "base64")
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAZElEQVR4nO3PQQ3AIADAQEgQhCrEomoieFyW9BS08549/mzpgFcNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaB97IAJexaPpFQAAAABJRU5ErkJggg==", "base64")
const MP4 = Buffer.from("AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANUbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAqN0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAQAAABAAAAAAIbbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAKABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABxm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAYZzdGJsAAAAwnN0c2QAAAAAAAAAAQAAALJhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOGF2Y0MBZAAK/+EAGmdkAAqscgREJsBEAAADAAQAAAMAKDxIlhGAAQAHaOhDgZSyLP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAYEAAAAngAAAAYc3R0cwAAAAAAAAABAAAABQAACAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAADhjdHRzAAAAAAAAAAUAAAABAAAQAAAAAAEAACgAAAAAAQAAEAAAAAABAAAAAAAAAAEAAAgAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAFAAAAAQAAAChzdHN6AAAAAAAAAAAAAAAFAAAAGwAAAA0AAAANAAAADQAAAA0AAAAUc3RjbwAAAAAAAAABAAADhAAAAD11ZHRhAAAANW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAACGlsc3QAAAAIZnJlZQAAAFdtZGF0AAAAF2WIgQACXxbnH4NtE4qu7Z+geYAscu0TAAAACUGaCI2If/8dUAAAAAlBnhBHEEP/bsEAAAAJAZ4YJoh//3LAAAAACQGeGG1If/9ywQ==", "base64")
const VCARD = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Interceptor Parity Imported\r\nN:Parity Imported;Interceptor;;;\r\nEMAIL;TYPE=WORK:parity-import@example.com\r\nEND:VCARD\r\n"

// Lazily read ids of existing containers (real stores are read, never written).
const container = (ctx: Ctx) => lookup(ctx, "container", ["contacts", "default-container"], j => j?.id)
  .catch(() => lookup(ctx, "container", ["contacts", "containers"], j => j?.containers?.[0]?.id))
/// Change tokens, change feeds and calendar tail refuse on Linux (Evolution Data Server keeps no change
/// history) and on Windows (not implemented over the WinRT change trackers).
const NO_CHANGE_HISTORY = {}
/// WinRT contacts have no membership groups, so every group subcommand refuses on Windows.
const NO_WIN_GROUPS = { win32: refuse("unsupported_operation") }
const contactsToken = (ctx: Ctx) => ctx.vars.token ?? "AAAA"
const anyCalendar = (ctx: Ctx) => ctx.vars.cal ?? lookup(ctx, "anyCal", ["calendar", "list"], j => j?.calendars?.[0]?.id)
const localSource = (ctx: Ctx) => lookup(ctx, "source", ["calendar", "sources"], j => (j?.sources?.find((s: any) => s.type === "local") ?? j?.sources?.[0])?.id)
  .catch(() => "interceptor-parity-no-source")
const reminderList = (ctx: Ctx) => lookup(ctx, "list", ["reminders", "default"], j => j?.id)
  .catch(() => lookup(ctx, "list", ["reminders", "lists"], j => (j?.lists?.find((l: any) => l.allowsContentModifications) ?? j?.lists?.[0])?.id))
/** A list owned reminders can be written to (the default, else one allowing modifications), cached as `list`. */
async function writableList(ctx: Ctx): Promise<boolean> {
  if (ctx.vars.list && ctx.vars.listWritable) return true
  const d = await ctx.run(["reminders", "default"])
  const lists = (await ctx.run(["reminders", "lists"])).json?.lists ?? []
  const id = d.json?.id ?? lists.find((l: any) => l.allowsContentModifications)?.id
  if (id) { ctx.vars.list = id; ctx.vars.listWritable = true }
  return Boolean(id)
}
const anyAlbum = (ctx: Ctx) => ctx.vars.album ?? lookup(ctx, "anyAlbum", ["photos", "albums"], j => j?.albums?.[0]?.id)
const anyAsset = (ctx: Ctx) => ctx.vars.asset ?? lookup(ctx, "anyAsset", ["photos", "assets", "--limit", "1"], j => j?.assets?.[0]?.id)

// Fixed future window for owned events and reminders (2030), clear of real data.
const S = "2030-01-01T00:00:00Z", E = "2030-02-01T00:00:00Z"

export const personal: Family[] = [
  {
    family: "contacts",
    // No group is ever created on Windows; its group cases send the placeholder and must refuse.
    async setup(ctx) { if (ctx.host === "win32") ctx.vars.group = OUT_ID },
    cases: [
      { id: "contacts.status", sub: "status", args: ["contacts", "status"] },
      { id: "contacts.request", sub: "request", args: ["contacts", "request"], ...D },
      { id: "contacts.containers", sub: "containers", args: ["contacts", "containers"] },
      // EDS has no self card on a fresh login; macOS and Windows return the Me card.
      { id: "contacts.me", sub: "me", args: ["contacts", "me"], expect: { linux: refuse("unsupported_target", /Me card is absent/), win32: refuse("unsupported_target", /no Me contact/) } },
      { id: "contacts.list-page-keys", sub: "list", args: ["contacts", "list", "--limit", "2", "--offset", "0", "--keys", "id,givenName,familyName,emailAddresses"] },
      { id: "contacts.current-token", sub: "current-token", args: ["contacts", "current-token"], expect: NO_CHANGE_HISTORY, check: keep("token", j => j?.token) },
      { id: "contacts.create", sub: "create", ...D, check: keep("contact"),
        ...t("contacts", "create", "--given", "Interceptor", "--family", "Parity Contact", "--organization", "Interceptor Parity Org", "--email", "work:parity@example.com",
          "--phone", "mobile:+15555550100", "--postal", "home:1 Parity Way;Parity City;CA;94000;US", "--birthday", "1990-01-02") },
      // Windows only has an app-owned list after the first create, so the default is read here.
      { id: "contacts.default-container", sub: "default-container", args: ["contacts", "default-container"], check: keep("container") },
      { id: "contacts.create-note-container", sub: "create", ...D, expect: { darwin: refuse() }, check: keep("contact2"),
        ...t("contacts", "create", "--given", "Interceptor", "--family", "Parity Second", "--email", "home:parity2@example.com", "--note", "Interceptor parity note", "--container", container) },
      { id: "contacts.contact", sub: "contact", ...D, ...t("contacts", "contact", v("contact")), check: contains("Parity Contact") },
      { id: "contacts.find-query", sub: "find", args: ["contacts", "find", "Interceptor"], check: has("contact", true) },
      { id: "contacts.find-name", sub: "find", args: ["contacts", "find", "--name", "Interceptor"], check: has("contact", true) },
      { id: "contacts.find-email", sub: "find", args: ["contacts", "find", "--email", "parity@example.com"], check: has("contact", true) },
      { id: "contacts.find-phone", sub: "find", args: ["contacts", "find", "--phone", "+15555550100"], check: has("contact", true) },
      { id: "contacts.list-container", sub: "list", ...t("contacts", "list", "--container", container, "--limit", "5", "--keys", "id,givenName") },
      { id: "contacts.update", sub: "update", ...D, check: contains("Parity Contact Updated"),
        ...t("contacts", "update", v("contact"), "--given", "Interceptor", "--family", "Parity Contact Updated", "--organization", "Interceptor Parity Org 2", "--email", "work:parity-updated@example.com",
          "--phone", "work:+15555550101", "--postal", "work:2 Parity Way;Parity City;CA;94001;US", "--birthday", "1991-03-04") },
      // macOS refuses notes without Apple's notes entitlement.
      { id: "contacts.update-note", sub: "update", ...D, expect: { darwin: refuse() }, ...t("contacts", "update", v("contact2"), "--note", "Interceptor parity note updated") },
      { id: "contacts.vcard", sub: "vcard", ...D, ...t("contacts", "vcard", v("contact")), check: contains("BEGIN:VCARD") },
      { id: "contacts.import-vcard", sub: "import-vcard", ...D, ...t("contacts", "import-vcard", file("interceptor-parity.vcf", VCARD), "--container", container), check: keep("imported", j => j?.ids?.[0]) },
      { id: "contacts.group-create", sub: "group-create", expect: NO_WIN_GROUPS, ...D, ...t("contacts", "group-create", "--name", "Interceptor Parity Group", "--container", container), check: keep("group") },
      { id: "contacts.groups", sub: "groups", expect: NO_WIN_GROUPS, ...t("contacts", "groups", "--container", container), check: has("group", true) },
      { id: "contacts.group", sub: "group", expect: NO_WIN_GROUPS, ...D, ...t("contacts", "group", v("group")), check: contains("Interceptor Parity Group") },
      { id: "contacts.group-update", sub: "group-update", expect: NO_WIN_GROUPS, ...D, ...t("contacts", "group-update", v("group"), "--name", "Interceptor Parity Group Renamed"), check: contains("Interceptor Parity Group Renamed") },
      { id: "contacts.group-add-member", sub: "group-add-member", expect: NO_WIN_GROUPS, ...D, ...t("contacts", "group-add-member", v("group"), "--contact", v("contact")) },
      { id: "contacts.list-group", sub: "list", expect: NO_WIN_GROUPS, ...D, ...t("contacts", "list", "--group", v("group"), "--limit", "10"), check: has("contact") },
      { id: "contacts.group-remove-member", sub: "group-remove-member", expect: NO_WIN_GROUPS, ...D, ...t("contacts", "group-remove-member", v("group"), "--contact", v("contact")) },
      { id: "contacts.group-delete", sub: "group-delete", expect: NO_WIN_GROUPS, ...D, ...t("contacts", "group-delete", v("group")), check: drop("group") },
      { id: "contacts.changes", sub: "changes", expect: NO_CHANGE_HISTORY, ...t("contacts", "changes", "--since", contactsToken, "--limit", "50") },
      { id: "contacts.delete", sub: "delete", ...D, ...t("contacts", "delete", v("contact")), check: drop("contact") },
      { id: "contacts.delete-second", sub: "delete", ...D, ...t("contacts", "delete", v("contact2")), check: drop("contact2") },
      { id: "contacts.delete-imported", sub: "delete", ...D, ...t("contacts", "delete", v("imported")), check: drop("imported") },
      { id: "contacts.bad-birthday", sub: "create", args: ["contacts", "create", "--given", "Interceptor", "--birthday", "2026-02-30"], expect: { all: refuse() } },
      { id: "contacts.bad-keys", sub: "list", args: ["contacts", "list", "--keys", "notAContactKey"], expect: { all: refuse() } },
    ],
    teardown: ctx => cleanup(ctx, [["group", "contacts", "group-delete"], ["contact", "contacts", "delete"], ["contact2", "contacts", "delete"], ["imported", "contacts", "delete"]]),
  },
  {
    family: "calendar",
    cases: [
      { id: "calendar.status", sub: "status", args: ["calendar", "status"] },
      { id: "calendar.request-full", sub: "request", args: ["calendar", "request", "--level", "full"], ...D },
      { id: "calendar.request-write", sub: "request", args: ["calendar", "request", "--level", "write"], ...D },
      { id: "calendar.list", sub: "list", args: ["calendar", "list"] },
      // Before any owned calendar exists (Windows reports a default only when one app calendar exists).
      { id: "calendar.default", sub: "default", args: ["calendar", "default"] },
      { id: "calendar.sources", sub: "sources", args: ["calendar", "sources"] },
      { id: "calendar.events-window", sub: "events", args: ["calendar", "events", "--start", S, "--end", E] },
      // Event rows carry no external identifier, so only the unknown-id path is reachable from the CLI.
      { id: "calendar.event-by-external", sub: "event-by-external", args: ["calendar", "event-by-external", "--id", "interceptor-parity-no-such-external-id", "--limit", "5", "--offset", "0"],
        check: r => list(r).length ? "expected no events for an unknown external id" : undefined },
      { id: "calendar.tail", sub: "tail", expect: NO_CHANGE_HISTORY, args: ["calendar", "tail"] },
      { id: "calendar.refresh-sources", sub: "refresh-sources", args: ["calendar", "refresh-sources"], timeoutMs: 60_000 },
      { id: "calendar.reset", sub: "reset", args: ["calendar", "reset"] },
      { id: "calendar.create-calendar", sub: "create-calendar", ...D, args: ["calendar", "create-calendar", "--title", "Interceptor Parity Calendar", "--color", "#3366CC", "--type", "local"], check: keep("cal") },
      { id: "calendar.create-calendar-move-target", sub: "create-calendar", ...D, args: ["calendar", "create-calendar", "--title", "Interceptor Parity Calendar Move"], check: keep("cal2") },
      // The local source: On My Mac, Linux's built-in parent, Interceptor's own account on Windows.
      { id: "calendar.create-calendar-source", sub: "create-calendar", ...D,
        check: both(keep("cal3"), (r, ctx) => r.json?.source?.id === ctx.vars.source ? undefined : `calendar was not created in source ${ctx.vars.source}: ${JSON.stringify(r.json?.source)}`),
        ...t("calendar", "create-calendar", "--title", "Interceptor Parity Calendar Source", "--source", localSource) },
      { id: "calendar.delete-calendar-source", sub: "delete-calendar", ...D, ...t("calendar", "delete-calendar", v("cal3")), check: drop("cal3") },
      // Windows writes only its own account (AppAccountsReadWrite / AppCalendarsReadWrite, winrt-api docs).
      { id: "calendar.create-calendar-foreign-source", sub: "create-calendar", args: ["calendar", "create-calendar", "--title", "Interceptor Parity Calendar Foreign", "--source", "interceptor-parity-foreign-source"],
        expect: { all: refuse(), win32: refuse("unsupported_operation", /current app's user data accounts/) } },
      { id: "calendar.bad-color", sub: "create-calendar", args: ["calendar", "create-calendar", "--title", "Interceptor Parity Calendar Bad", "--color", "red"], expect: { all: refuse() } },
      { id: "calendar.create", sub: "create", ...D, check: both(keep("event"), contains("Interceptor Parity Event")),
        ...t("calendar", "create", "--calendar", v("cal"), "--title", "Interceptor Parity Event", "--start", "2030-01-07T15:00:00Z", "--end", "2030-01-07T16:00:00Z",
          "--location", "Interceptor Parity Room", "--notes", "Interceptor parity notes", "--url", "https://example.com/interceptor-parity", "--alarm", "-900") },
      { id: "calendar.create-all-day-recurring", sub: "create", ...D, check: keep("recurring"),
        ...t("calendar", "create", "--calendar", v("cal"), "--title", "Interceptor Parity Recurring", "--start", "2030-01-08T00:00:00Z", "--end", "2030-01-09T00:00:00Z", "--all-day",
          "--recurrence-frequency", "weekly", "--recurrence-interval", "2", "--recurrence-end", "3", "--alarm", "2030-01-07T09:00:00Z") },
      { id: "calendar.create-series", sub: "create", ...D, check: keep("series"),
        ...t("calendar", "create", "--calendar", v("cal"), "--title", "Interceptor Parity Series", "--start", "2030-01-14T15:00:00Z", "--end", "2030-01-14T16:00:00Z") },
      // Attendees are read-only: any value refuses before a mutation.
      { id: "calendar.create-attendee", sub: "create", expect: { all: refuse() },
        args: ["calendar", "create", "--calendar", "interceptor-parity-none", "--title", "Interceptor Parity Attendee", "--start", "2030-01-07T15:00:00Z", "--end", "2030-01-07T16:00:00Z", "--attendee", "parity@example.com"] },
      { id: "calendar.event", sub: "event", ...D, ...t("calendar", "event", "--id", v("event")), check: contains("Interceptor Parity Event") },
      { id: "calendar.events-calendar", sub: "events", ...D, ...t("calendar", "events", "--start", S, "--end", E, "--calendar", v("cal")), check: has("event") },
      { id: "calendar.events-calendars-page", sub: "events", ...t("calendar", "events", "--start", S, "--end", E, "--calendars", anyCalendar, "--limit", "10", "--offset", "0") },
      { id: "calendar.update", sub: "update", ...D, check: contains("Interceptor Parity Event Updated"),
        ...t("calendar", "update", v("event"), "--span", "this", "--title", "Interceptor Parity Event Updated", "--start", "2030-01-07T17:00:00Z", "--end", "2030-01-07T18:00:00Z",
          "--location", "Interceptor Parity Room 2", "--notes", "Interceptor parity notes updated", "--url", "https://example.com/interceptor-parity-updated", "--alarm", "-600") },
      { id: "calendar.update-all-day", sub: "update", ...D, ...t("calendar", "update", "--id", v("event"), "--all-day", "--start", "2030-01-10T00:00:00Z", "--end", "2030-01-11T00:00:00Z") },
      { id: "calendar.update-recurrence", sub: "update", ...D, check: contains("daily"),
        ...t("calendar", "update", v("series"), "--recurrence-frequency", "daily", "--recurrence-interval", "2", "--recurrence-end", "2030-02-01T00:00:00Z") },
      { id: "calendar.update-attendee", sub: "update", args: ["calendar", "update", "interceptor-parity-no-such-event", "--attendee", "parity@example.com"], expect: { all: refuse() } },
      // Linux event ids carry the calendar, so the moved id replaces the old one.
      { id: "calendar.move", sub: "move", ...D, ...t("calendar", "move", "--id", v("event"), "--to", v("cal2")),
        check: both(keep("event"), (r, ctx) => r.json?.calendarId === ctx.vars.cal2 ? undefined : `event not in the move target: ${r.stdout.slice(0, 200)}`) },
      { id: "calendar.delete", sub: "delete", ...D, ...t("calendar", "delete", "--id", v("event"), "--span", "this"), check: drop("event") },
      { id: "calendar.delete-recurring-future", sub: "delete", ...D, ...t("calendar", "delete", v("recurring"), "--span", "future"), check: drop("recurring") },
      { id: "calendar.delete-calendar-move-target", sub: "delete-calendar", ...D, ...t("calendar", "delete-calendar", v("cal2")), check: drop("cal2") },
      { id: "calendar.delete-calendar", sub: "delete-calendar", ...D, ...t("calendar", "delete-calendar", "--id", v("cal")), check: drop("cal") },
    ],
    teardown: ctx => cleanup(ctx, [["cal3", "calendar", "delete-calendar"], ["cal2", "calendar", "delete-calendar"], ["cal", "calendar", "delete-calendar"]]),
  },
  {
    family: "reminders",
    cases: [
      { id: "reminders.status", sub: "status", args: ["reminders", "status"] },
      { id: "reminders.request", sub: "request", args: ["reminders", "request"], ...D },
      { id: "reminders.lists", sub: "lists", args: ["reminders", "lists"] },
      { id: "reminders.default", sub: "default", args: ["reminders", "default"] },
      { id: "reminders.all", sub: "all", ...t("reminders", "all", "--list", reminderList, "--limit", "1", "--offset", "0") },
      { id: "reminders.incomplete", sub: "incomplete", ...t("reminders", "incomplete", "--list", reminderList, "--due-start", S, "--due-end", E, "--limit", "1", "--offset", "0") },
      { id: "reminders.completed", sub: "completed", ...t("reminders", "completed", "--list", reminderList, "--since", S, "--until", E, "--limit", "1", "--offset", "0") },
      // The CLI has no list-creation selector, so owned reminders live in the default (or first writable) list.
      // A fresh Windows account has no app-owned task list (apps write only to their own), so create
      // runs without --list there and makes Interceptor's list; later owned cases follow its listId.
      { id: "reminders.create", sub: "create", ...D, check: both(keep("rem"), keep("list", j => j?.listId), contains("Interceptor Parity Reminder")),
        flags: ["--list", "--title", "--start", "--due", "--priority", "--notes"],
        args: async ctx => ["reminders", "create", ...(await writableList(ctx) ? ["--list", String(ctx.vars.list)] : []), "--title", "Interceptor Parity Reminder", "--start", "2030-01-07T09:00:00Z", "--due", "2030-01-07T17:00:00Z", "--priority", "high", "--notes", "Interceptor parity notes"] },
      // Windows tasks have no URL field and no "none" priority: UserDataTask exposes completedDate, details, dueDate,
      // priority, reminder, subject, ... and no URL; UserDataTaskPriority is High/Normal/Low (winrt-api
      // windows.applicationmodel.userdatatasks). The delete-link skip below follows that OS refusal: nothing exists to delete.
      { id: "reminders.create-url", sub: "create", ...D, expect: { win32: refuse("unsupported_operation") }, check: keep("rem2"),
        ...t("reminders", "create", "--list", reminderList, "--title", "Interceptor Parity Reminder Link", "--url", "https://example.com/interceptor-parity", "--priority", "none") },
      { id: "reminders.bad-priority", sub: "create", args: ["reminders", "create", "--title", "Interceptor Parity Reminder Bad", "--priority", "urgent"], expect: { all: refuse() } },
      { id: "reminders.all-owned", sub: "all", ...D, ...t("reminders", "all", "--list", reminderList, "--limit", "1000"), check: has("rem") },
      { id: "reminders.update", sub: "update", ...D, check: contains("Interceptor Parity Reminder Updated"),
        ...t("reminders", "update", v("rem"), "--title", "Interceptor Parity Reminder Updated", "--start", "2030-01-08T09:00:00Z", "--due", "2030-01-08T17:00:00Z", "--priority", "low", "--notes", "Interceptor parity notes updated") },
      { id: "reminders.update-url", sub: "update", ...D, expect: { win32: refuse("unsupported_operation") }, ...t("reminders", "update", "--id", v("rem"), "--url", "https://example.com/interceptor-parity-updated") },
      { id: "reminders.complete", sub: "complete", ...D, ...t("reminders", "complete", "--id", v("rem")), check: r => r.json?.isCompleted === true ? undefined : "reminder not completed" },
      { id: "reminders.completed-owned", sub: "completed", ...D, ...t("reminders", "completed", "--list", reminderList, "--since", iso(-3_600_000), "--until", iso(3_600_000)), check: has("rem") },
      { id: "reminders.uncomplete", sub: "uncomplete", ...D, ...t("reminders", "uncomplete", "--id", v("rem")), check: r => r.json?.isCompleted === false ? undefined : "reminder still completed" },
      { id: "reminders.incomplete-owned", sub: "incomplete", ...D, ...t("reminders", "incomplete", "--list", reminderList, "--due-start", S, "--due-end", E), check: has("rem") },
      { id: "reminders.delete", sub: "delete", ...D, ...t("reminders", "delete", "--id", v("rem")), check: drop("rem") },
      { id: "reminders.delete-link", sub: "delete", ...D, expect: { win32: skip("Windows refused the link reminder, so none exists") }, ...t("reminders", "delete", v("rem2")), check: drop("rem2") },
    ],
    teardown: ctx => cleanup(ctx, [["rem", "reminders", "delete"], ["rem2", "reminders", "delete"]]),
  },
  {
    family: "photos",
    cases: [
      { id: "photos.status", sub: "status", args: ["photos", "status"] },
      // On Windows/Linux an explicit request initializes the owned folder library, so it runs first.
      { id: "photos.request-readwrite", sub: "request", args: ["photos", "request", "--level", "readwrite"], ...D },
      { id: "photos.request-addonly", sub: "request", args: ["photos", "request", "--level", "addonly"], ...D },
      { id: "photos.albums", sub: "albums", args: ["photos", "albums"] },
      { id: "photos.albums-album", sub: "albums", args: ["photos", "albums", "--type", "album"] },
      { id: "photos.albums-smart", sub: "albums", args: ["photos", "albums", "--type", "smart"] },
      { id: "photos.albums-moment", sub: "albums", args: ["photos", "albums", "--type", "moment"], expect: { all: refuse("unsupported_operation"), darwin: refuse(undefined, /moments are unavailable/) } },
      { id: "photos.bad-album-type", sub: "albums", args: ["photos", "albums", "--type", "folder"], expect: { all: refuse() } },
      { id: "photos.current-token", sub: "current-token", args: ["photos", "current-token"], check: keep("token", j => j?.token) },
      { id: "photos.assets-page", sub: "assets", args: ["photos", "assets", "--media", "image", "--limit", "1", "--offset", "0"] },
      { id: "photos.assets-flags", sub: "assets", args: ["photos", "assets", "--favorite", "--hidden", "--burst", "--limit", "1"] },
      { id: "photos.assets-where", sub: "assets", args: ["photos", "assets", "--since", "2000-01-01T00:00:00Z", "--until", "2100-01-01T00:00:00Z", "--where", "pixelWidth >= 1 AND mediaType == 1", "--limit", "1"] },
      { id: "photos.assets-live", sub: "assets", args: ["photos", "assets", "--subtype", "livePhoto", "--limit", "1"] },
      // Apple's computed classifications (panorama, screenshot, HDR...) have no folder-library equivalent.
      { id: "photos.assets-panorama", sub: "assets", args: ["photos", "assets", "--subtype", "panorama", "--limit", "1"], expect: macOnly("unsupported_operation") },
      { id: "photos.album-create", sub: "album-create", ...D, args: ["photos", "album-create", "--name", "Interceptor Parity Album"], check: keep("album") },
      { id: "photos.album-rename", sub: "album-rename", ...D, ...t("photos", "album-rename", v("album"), "--name", "Interceptor Parity Album Renamed"), check: contains("Interceptor Parity Album Renamed") },
      { id: "photos.import", sub: "import", ...D, timeoutMs: 60_000, ...t("photos", "import", "--file", file("interceptor-parity-photo.jpg", JPEG), "--album", v("album")), check: keep("asset") },
      { id: "photos.import-png", sub: "import", ...D, timeoutMs: 60_000, ...t("photos", "import", "--file", file("interceptor-parity-photo.png", PNG)), check: keep("asset2") },
      { id: "photos.import-video", sub: "import-video", ...D, timeoutMs: 60_000, ...t("photos", "import-video", "--file", file("interceptor-parity-video.mp4", MP4), "--album", v("album")), check: keep("video") },
      { id: "photos.album", sub: "album", ...t("photos", "album", anyAlbum) },
      { id: "photos.assets-album", sub: "assets", ...t("photos", "assets", "--album", anyAlbum, "--limit", "5"), check: has("asset", true) },
      { id: "photos.asset", sub: "asset", ...t("photos", "asset", anyAsset) },
      { id: "photos.export-png", sub: "export", ...D, timeoutMs: 60_000, ...t("photos", "export", v("asset"), "--out", file("interceptor-parity-export.png"), "--format", "png", "--size", "32") },
      { id: "photos.export-original", sub: "export", ...D, ...t("photos", "export", v("asset"), "--out", file("interceptor-parity-original.jpg")) },
      { id: "photos.export-video", sub: "export-video", ...D, timeoutMs: 60_000, ...t("photos", "export-video", v("video"), "--out", file("interceptor-parity-export.mp4")) },
      // A plain still is not a Live Photo pair: refused on every host (positive path excluded below).
      { id: "photos.export-live-not-live", sub: "export-live", ...D, expect: { all: refuse() }, ...t("photos", "export-live", v("asset"), "--out", file("interceptor-parity-live")) },
      { id: "photos.thumbnail-out", sub: "thumbnail", ...D, ...t("photos", "thumbnail", v("asset"), "--out", file("interceptor-parity-thumb.jpg"), "--size", "64") },
      { id: "photos.thumbnail-save", sub: "thumbnail", ...D, ...t("photos", "thumbnail", v("asset"), "--save", "--size", "32") },
      { id: "photos.favorite-on", sub: "favorite", ...D, ...t("photos", "favorite", v("asset"), "--on"), check: r => r.json?.isFavorite === true ? undefined : "asset not favorite" },
      { id: "photos.favorite-off", sub: "favorite", ...D, ...t("photos", "favorite", v("asset"), "--off"), check: r => r.json?.isFavorite === false ? undefined : "asset still favorite" },
      { id: "photos.hide-on", sub: "hide", ...D, ...t("photos", "hide", v("asset"), "--on"), check: r => r.json?.isHidden === true ? undefined : "asset not hidden" },
      { id: "photos.hide-off", sub: "hide", ...D, ...t("photos", "hide", v("asset"), "--off"), check: r => r.json?.isHidden === false ? undefined : "asset still hidden" },
      { id: "photos.add-to-album", sub: "add-to-album", ...D, ...t("photos", "add-to-album", "--album", v("album"), "--asset", v("asset2")) },
      { id: "photos.remove-from-album", sub: "remove-from-album", ...D, ...t("photos", "remove-from-album", "--album", v("album"), "--asset", v("asset2")) },
      { id: "photos.changes", sub: "changes", ...t("photos", "changes", "--token", ctx => ctx.vars.token ?? "AAAA") },
      { id: "photos.bad-export-format", sub: "export", expect: { all: refuse() }, ...t("photos", "export", "interceptor-parity-missing", "--out", file("interceptor-parity-never.gif"), "--format", "gif") },
      { id: "photos.delete", sub: "delete", ...D, check: drop("asset", "asset2", "video"),
        ...t("photos", "delete", ctx => ["asset", "asset2", "video"].map(k => ctx.vars[k]).filter(Boolean).join(",") || v("asset")(ctx)) },
      { id: "photos.album-delete", sub: "album-delete", ...D, ...t("photos", "album-delete", v("album")), check: drop("album") },
    ],
    teardown: ctx => cleanup(ctx, [["asset", "photos", "delete"], ["asset2", "photos", "delete"], ["video", "photos", "delete"], ["album", "photos", "album-delete"]]),
  },
]

export const personalExclusions: Exclusion[] = [
  { family: "photos", sub: "export-live", reason: "A positive Live Photo export needs a JPEG and MOV pair sharing an Apple MakerNotes ContentIdentifier, which a small fixture cannot synthesize; only the refusal for a plain still runs (it covers --out)." },
]
