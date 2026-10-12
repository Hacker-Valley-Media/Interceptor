import { DESKTOP_CONTRACT_ALIASES, DESKTOP_CONTRACT_SCALARS, DESKTOP_CONTRACT_VALUE_TYPES, DESKTOP_CONTRACT_FIELDS, type DesktopContractSchema } from "./desktop-contract.generated"

export type DesktopContractRootSchema = DesktopContractSchema | `${DesktopContractSchema}[]`

/** Validate parsed native metadata against the generated declarations.
 * Framing and action dispatch retain their owners.
 */
export function desktopContractShapeError(value: unknown, schema: DesktopContractRootSchema): string | undefined {
  const aliases: Readonly<Record<string, readonly string[]>> = DESKTOP_CONTRACT_ALIASES
  const scalars: Readonly<Record<string, string>> = DESKTOP_CONTRACT_SCALARS
  const valueTypes: Readonly<Record<string, readonly string[]>> = DESKTOP_CONTRACT_VALUE_TYPES
  const structs: Readonly<Record<string, readonly { name: string; optional: boolean; type: string }[]>> = DESKTOP_CONTRACT_FIELDS
  let budget = 100_000
  const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
  const owns = (v: object, key: string) => Object.prototype.hasOwnProperty.call(v, key)
  // A top-level action field is a CLI flag: name it, and list the allowed words.
  const invalid = (path: string, allowed?: readonly string[]) => {
    const flag = /^Desktop(\w+?)Action\.(\w+)$/.exec(path)
    const name = !flag ? `invalid native contract field: ${path}` : flag[2] === "sub" ? `unknown ${flag[1].toLowerCase()} subcommand` : `invalid --${flag[2].replace(/_/g, "-")}`
    return allowed ? `${name}; expected one of ${allowed.join(", ")}` : name
  }
  const visit = (v: unknown, type: string, path: string, depth: number): string | undefined => {
    if (--budget < 0 || depth > 32) return "native contract validation limit exceeded"
    if (type === "unknown") return undefined
    if (type === "null") return v === null ? undefined : invalid(path)
    if (type === "string" || type === "boolean") return typeof v === type ? undefined : invalid(path)
    if (type === "number") return typeof v === "number" && Number.isFinite(v) ? undefined : invalid(path)
    if (owns(scalars, type)) return visit(v, scalars[type], path, depth + 1)
    if (owns(aliases, type)) return typeof v === "string" && aliases[type].includes(v) ? undefined : invalid(path, aliases[type])
    if (owns(valueTypes, type)) {
      for (const candidate of valueTypes[type]) if (!visit(v, candidate, path, depth + 1)) return undefined
      return invalid(path)
    }
    if (type.endsWith("[]")) {
      if (!Array.isArray(v)) return invalid(path)
      for (let n = 0; n < v.length; n++) {
        const error = visit(v[n], type.slice(0, -2), `${path}[${n}]`, depth + 1)
        if (error) return error
      }
      return undefined
    }
    const record = /^Record<string, (.+)>$/.exec(type)
    if (record) {
      if (!object(v)) return invalid(path)
      for (const key of Object.keys(v)) {
        const error = visit(v[key], record[1], `${path}.${key}`, depth + 1)
        if (error) return error
      }
      return undefined
    }
    if (!owns(structs, type) || !object(v)) return invalid(path)
    const fields = structs[type]
    for (const key of Object.keys(v)) if (!fields.some(f => f.name === key)) return invalid(`${path}.${key}`)
    for (const field of fields) {
      if (!owns(v, field.name)) { if (!field.optional) return invalid(`${path}.${field.name}`); continue }
      const error = visit(v[field.name], field.type, `${path}.${field.name}`, depth + 1)
      if (error) return error
    }
    return undefined
  }
  const error = visit(value, schema, schema, 0)
  return error ? Array.from(error).slice(0, 512).join("") : undefined
}
