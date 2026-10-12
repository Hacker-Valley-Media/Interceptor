import { expect, test } from "bun:test"
import { generateDesktopContract } from "../scripts/desktop-contract"
import { DESKTOP_ACTION_SCHEMAS, DESKTOP_CONTRACT_FIELDS } from "../shared/desktop-contract.generated"
import { desktopContractShapeError } from "../shared/desktop-contract-validation"

test("partial filesystem search replies retain the observed native guidance field", () => {
  const result = {matches: [], indexed: true, source: "spotlight", scope: "everywhere", query: "owned-absent", count: 0, partial: true, deadlineMs: 200,
    hint: "the 200ms deadline cut the Spotlight name pass; results are what arrived in time"}
  expect(desktopContractShapeError(result, "DesktopFsSearchData")).toBeUndefined()
  expect(desktopContractShapeError({...result, hint: 200}, "DesktopFsSearchData")).toContain("hint")
  expect(desktopContractShapeError({...result, unknown: true}, "DesktopFsSearchData")).toContain("unknown")
})

test("filesystem contract preserves literal operation discriminators and native identifiers", () => {
  const result = generateDesktopContract('export type DesktopFsReadOperation = "desktop_fs_read"; export interface DesktopFsReadAction { type: DesktopFsReadOperation; ref?: string }')
  expect(result.rust).toContain('#[serde(rename = "desktop_fs_read")]')
  expect(result.rust).toContain("pub r#type: DesktopFsReadOperation")
  expect(result.rust).toContain("pub r#ref: Option<String>")
  expect(result.rust).toContain("#[serde(deny_unknown_fields)]")
  expect(result.swift).toContain('case v0 = "desktop_fs_read"')
  expect(() => generateDesktopContract("export interface Bad { self: string }")).toThrow("not a native identifier")
})

test("Swift filesystem validation derives nested allowed keys and decoding from shared declarations", () => {
  const generated = generateDesktopContract(`
    export type DesktopFsReadOperation = "desktop_fs_read"
    export interface DesktopFsByteRange { start?: number; length?: number }
    export interface DesktopFsReadAction { type: DesktopFsReadOperation; path?: string; byteRange?: DesktopFsByteRange }
  `)
  expect(generated.swift).toContain("struct DesktopFsReadAction: Codable")
  expect(generated.swift).toContain('"byteRange": "DesktopFsByteRange"')
  expect(generated.swift).toContain('"DesktopFsByteRange": ["start": "number", "length": "number"]')
  expect(generated.swift).toContain("decoder.decode(DesktopFsReadAction.self")
  expect(generated.swift).toContain("unknown filesystem field")
  expect(generated.swift).toContain("value is NSNull")
  expect(() => generateDesktopContract("export interface DesktopFsBadAction { type: string }")).toThrow("one literal operation")
  expect(() => generateDesktopContract("export interface DesktopFsBad { payload: unknown }")).toThrow("Codable types")
})

test("shared accessibility declarations emit strict native shapes for every core discriminator", async () => {
  const source = await Bun.file(new URL('../shared/desktop-contract.ts', import.meta.url)).text()
  const generated = generateDesktopContract(source)
  const fixture = await Bun.file(new URL('../shared/desktop-accessibility-fixtures.json', import.meta.url)).json()
  for (const action of fixture.valid) {
    expect(generated.swift).toContain(`case "${action.type}": schema = `)
    expect(generated.rust).toContain(`"${action.type}" => serde_json::from_value::<DesktopAx`)
  }
  expect(generated.swift).toContain('enum DesktopAccessibilityShape')
  expect(generated.swift).toContain('struct DesktopAxTypeAction: Codable')
  expect(generated.rust).toContain('pub fn desktop_accessibility_shape_error')
  expect(generated.rust).toContain('accessibility fields cannot be null')
  expect(generated.rust).toContain('unknown accessibility field')
  expect(() => generateDesktopContract('export interface DesktopAxBadAction { type: string }')).toThrow('one literal operation')
  expect(() => generateDesktopContract('export interface DesktopAxBad { value: unknown }')).toThrow('Codable types')
})

test("generation refuses unvalidated or ambiguous action declarations", () => {
  expect(() => generateDesktopContract(`
    export type DesktopFutureOperation = "desktop_future"
    export interface DesktopFutureAction { type: DesktopFutureOperation; text: string }
  `)).toThrow("no native validation family")
  expect(() => generateDesktopContract(`
    export type DesktopAxFirstOperation = "desktop_fixture"
    export type DesktopAxSecondOperation = "desktop_fixture"
    export interface DesktopAxFirstAction { type: DesktopAxFirstOperation; text: string }
    export interface DesktopAxSecondAction { type: DesktopAxSecondOperation; other: number }
  `)).toThrow("duplicate action operation")
  expect(() => generateDesktopContract(`
    export type DesktopAxOperation = "desktop_fixture"
    export interface DesktopAxFixtureAction { type?: DesktopAxOperation }
  `)).toThrow("required type field")
  for (const source of [
    "export interface DesktopAxFixture { first: string } export interface DesktopAxFixture { second: number }",
    'export type DesktopAxFixture = "first"; export type DesktopAxFixture = "second"',
    "export const LIMIT = 1; export const LIMIT = 2",
  ]) expect(() => generateDesktopContract(source)).toThrow("duplicate declaration")
  expect(() => generateDesktopContract("export interface DesktopAxFixture { field: string; field: number }")).toThrow("duplicate field")
})

test("every declared action has exactly one generated Swift and Rust validation branch", async () => {
  const source = await Bun.file(new URL('../shared/desktop-contract.ts', import.meta.url)).text()
  const generated = generateDesktopContract(source)
  expect(new Set<string>(Object.values(DESKTOP_ACTION_SCHEMAS))).toEqual(new Set(Object.keys(DESKTOP_CONTRACT_FIELDS).filter(name => name.endsWith("Action"))))
  for (const [operation, schema] of Object.entries(DESKTOP_ACTION_SCHEMAS)) {
    expect(generated.swift.split(`case "${operation}": schema = "${schema}"`).length - 1).toBe(1)
    expect(generated.swift.split(`case "${operation}": _ = try decoder.decode(${schema}.self`).length - 1).toBe(1)
    expect(generated.rust.split(`"${operation}" => serde_json::from_value::<${schema}>`).length - 1).toBe(1)
  }
})

test("host result tables refuse missing, stale, optional and unknown selectors", async () => {
  const source = await Bun.file(new URL('../shared/desktop-contract.ts', import.meta.url)).text()
  for (const changed of [
    source.replace('  desktop_app: string\n', ''),
    source.replace('  desktop_app: string\n', '  desktop_app?: string\n'),
    source.replace('  desktop_app: string\n', '  desktop_missing: string\n'),
    source.replace('export interface DesktopAxLinuxResultSchemas', 'export interface MissingLinuxResultSchemas'),
    source.replace('"desktop_value"', '"desktop_value_fixture"'),
  ]) expect(() => generateDesktopContract(changed)).toThrow('result selector')
  expect(generateDesktopContract(source.replaceAll('desktop_value', 'desktop_value_fixture')).typescript).toContain('"desktop_value_fixture_read": "string"')
})
