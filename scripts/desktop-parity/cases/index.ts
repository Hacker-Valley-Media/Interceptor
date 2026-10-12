// Every family the parity runner knows, in run order: reads first, then mutations, and
// the focus-moving app/open families last so they cannot disturb earlier cases.
import { type Exclusion, type Family, ok, refuse } from "../types"
import { accessibility } from "./accessibility"
import { input, inputExclusions } from "./input"
import { apps, appsExclusions } from "./apps"
import { screen, screenExclusions } from "./screen"
import { data, dataExclusions } from "./data"
import { system, systemExclusions } from "./system"
import { automation, automationExclusions } from "./automation"
import { security, securityExclusions } from "./security"
import { media, mediaExclusions } from "./media"
import { personal, personalExclusions } from "./personal"
import { services, servicesExclusions } from "./services"

const focusMovers = new Set(["app", "open"])
const all = [...accessibility, ...input, ...screen, ...data, ...system, ...automation, ...security, ...media, ...personal, ...services, ...apps]

// The Windows/Linux product scope, applied in one place: families that are out of scope there refuse
// there (only their status/list reads succeed), and so do monitor sources that need engines
// or global input.
const outOnNative: Record<string, string[]> = { photos: ["status"], vm: ["list"] }
const nativeRefusals = /^monitor\.start\.(speech-live|tap)$/
for (const f of all) if (outOnNative[f.family]) {
  const setup = f.setup
  f.setup = async ctx => { if (ctx.host === "darwin") return setup?.(ctx); ctx.vars.outOnHost = true }
}
for (const f of all) for (const c of f.cases) {
  const keep = outOnNative[f.family]
  if (keep) c.expect = keep.includes(c.sub) ? { ...c.expect, win32: ok, linux: ok } : { ...c.expect, win32: refuse(), linux: refuse() }
  if (nativeRefusals.test(c.id)) c.expect = { ...c.expect, win32: refuse("unsupported_operation"), linux: refuse("unsupported_operation") }
}
export const families: Family[] = [...all.filter(f => !focusMovers.has(f.family)), ...all.filter(f => focusMovers.has(f.family))]

export const exclusions: Exclusion[] = [
  { family: "(extension prefix)", reason: "operator-installed extension verbs are outside the shipped product (capability-blind tree)" },
 ...inputExclusions, ...appsExclusions, ...screenExclusions, ...dataExclusions, ...systemExclusions,
  ...automationExclusions, ...securityExclusions, ...mediaExclusions, ...personalExclusions, ...servicesExclusions]
