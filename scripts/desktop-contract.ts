#!/usr/bin/env bun
// TreasureScreen's restricted TS declarations -> native compiler pattern, using
// the existing wire envelope. No RPC library or second action parser.
import ts from "typescript"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
export const outputs = {
  swift: join(root, "interceptor-bridge/Sources/DesktopContract.generated.swift"),
  rust: join(root, "interceptor-desktop/src/contract_generated.rs"),
  typescript: join(root, "shared/desktop-contract.generated.ts"),
}
type Field = { name: string; optional: boolean; type: string }
const families = [["DesktopNotification", "notifications", "DesktopNotificationShape"], ["DesktopFs", "filesystem", "DesktopFilesystemShape"], ["DesktopFiles", "files", "DesktopFilesShape"], ["DesktopAx", "accessibility", "DesktopAccessibilityShape"], ["DesktopClipboard", "clipboard", "DesktopClipboardShape"], ["DesktopCapture", "capture", "DesktopCaptureShape"], ["DesktopDisplay", "display", "DesktopDisplayShape"], ["DesktopCompound", "compound", "DesktopCompoundShape"], ["DesktopHttp", "http", "DesktopHttpShape"], ["DesktopLog", "log", "DesktopLogShape"], ["DesktopThumbnail", "thumbnail", "DesktopThumbnailShape"], ["DesktopSecret", "secret", "DesktopSecretShape"], ["DesktopAuth", "auth", "DesktopAuthShape"], ["DesktopAuthDialog", "authdialog", "DesktopAuthDialogShape"], ["DesktopContainer", "container", "DesktopContainerShape"], ["DesktopHealth", "health", "DesktopHealthShape"], ["DesktopMonitor", "monitor", "DesktopMonitorShape"], ["DesktopLanguage", "language", "DesktopLanguageShape"], ["DesktopVision", "vision", "DesktopVisionShape"], ["DesktopScript", "script", "DesktopScriptShape"], ["DesktopPdf", "pdf", "DesktopPdfShape"], ["DesktopAudio", "audio", "DesktopAudioShape"], ["DesktopVad", "vad", "DesktopVadShape"], ["DesktopSpeech", "speech", "DesktopSpeechShape"], ["DesktopTrust", "trust", "DesktopTrustShape"], ["DesktopStream", "stream", "DesktopStreamShape"], ["DesktopSound", "sound", "DesktopSoundShape"], ["DesktopSensitive", "sensitive", "DesktopSensitiveShape"], ["DesktopUpdate", "update", "DesktopUpdateShape"], ["DesktopLocation", "location", "DesktopLocationShape"], ["DesktopMaps", "maps", "DesktopMapsShape"], ["DesktopMusic", "music", "DesktopMusicShape"], ["DesktopShare", "share", "DesktopShareShape"], ["DesktopContacts", "contacts", "DesktopContactsShape"], ["DesktopCalendar", "calendar", "DesktopCalendarShape"], ["DesktopReminders", "reminders", "DesktopRemindersShape"], ["DesktopPhotos", "photos", "DesktopPhotosShape"], ["DesktopVm", "vm", "DesktopVmShape"], ["DesktopOverlay", "overlay", "DesktopOverlayShape"]] as const

export function generateDesktopContract(source: string): { swift: string; rust: string; typescript: string } {
  const orderedFamilies = [...families].sort((a, b) => b[0].length - a[0].length)
  const familyFor = (name: string) => orderedFamilies.find(([prefix]) => name.startsWith(prefix))
  const ast = ts.createSourceFile("desktop-contract.ts", source, ts.ScriptTarget.Latest, true)
  const aliases = new Map<string, string[]>()
  const scalars = new Map<string, string>()
  const valueTypes = new Map<string, string[]>()
  const structs = new Map<string, Field[]>()
  const constants = new Map<string, number>()
  const declarations = new Set<string>()
  for (const node of ast.statements) {
    const names = ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) ? [node.name.text]
      : ts.isVariableStatement(node) ? node.declarationList.declarations.filter(d => ts.isIdentifier(d.name)).map(d => (d.name as ts.Identifier).text) : []
    for (const name of names) {
      if (declarations.has(name)) throw new Error(`contract: duplicate declaration ${name}`)
      declarations.add(name)
    }
    if (ts.isTypeAliasDeclaration(node)) {
      const primitive = node.type.kind === ts.SyntaxKind.StringKeyword ? "string" : node.type.kind === ts.SyntaxKind.BooleanKeyword ? "boolean" : node.type.kind === ts.SyntaxKind.NumberKeyword ? "number" : undefined
      if (primitive) { scalars.set(node.name.text, primitive); continue }
      const members = ts.isUnionTypeNode(node.type) ? node.type.types : [node.type]
      if (members.every(t => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal))) {
        aliases.set(node.name.text, members.map(t => ((t as ts.LiteralTypeNode).literal as ts.StringLiteral).text))
      } else {
        const jsonRecord = (t: ts.TypeNode): string | undefined => {
          if (!ts.isTypeLiteralNode(t) || t.members.length !== 1) return undefined
          const field = t.members[0]
          if (!ts.isIndexSignatureDeclaration(field) || field.modifiers?.length || !field.type || field.parameters.length !== 1) return undefined
          const key = field.parameters[0]
          if (!ts.isIdentifier(key.name) || key.type?.kind !== ts.SyntaxKind.StringKeyword || key.questionToken || key.dotDotDotToken || key.initializer) return undefined
          return `Record<string, ${field.type.getText(ast)}>`
        }
        if (!members.every(t => ts.isTypeReferenceNode(t) || ts.isArrayTypeNode(t)
          || [ts.SyntaxKind.StringKeyword, ts.SyntaxKind.BooleanKeyword, ts.SyntaxKind.NumberKeyword].includes(t.kind)
          || jsonRecord(t) !== undefined
          || ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword)) {
          throw new Error(`contract: ${node.name.text} requires supported JSON value types`)
        }
        valueTypes.set(node.name.text, members.map(t => jsonRecord(t) ?? t.getText(ast)))
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      if (node.heritageClauses?.length) throw new Error("contract: inheritance is not supported")
      const fieldNames = new Set<string>()
      structs.set(node.name.text, node.members.map(m => {
        if (!ts.isPropertySignature(m) || !m.type || !ts.isIdentifier(m.name)) throw new Error("contract: plain fields required")
        if (["self", "Self", "super", "crate"].includes(m.name.text)) throw new Error("contract: field is not a native identifier")
        if (fieldNames.has(m.name.text)) throw new Error(`contract: duplicate field ${node.name.text}.${m.name.text}`)
        fieldNames.add(m.name.text)
        return { name: m.name.text, optional: !!m.questionToken, type: m.type.getText(ast) }
      }))
    } else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isNumericLiteral(d.initializer)) throw new Error("contract: numeric constants required")
        constants.set(d.name.text, Number(d.initializer.text.replaceAll("_", "")))
      }
    } else if (!ts.isFunctionDeclaration(node)) throw new Error("contract: unsupported declaration")
  }
  const kind = (s: string, lang: "swift" | "rust"): string => {
    const primitives = lang === "swift" ? { string: "String", boolean: "Bool", number: "Double", unknown: "Any" }
      : { string: "String", boolean: "bool", number: "f64", unknown: "serde_json::Value" }
    if (s in primitives) return primitives[s as keyof typeof primitives]
    if (s.endsWith("[]")) return lang === "swift" ? `[${kind(s.slice(0, -2), lang)}]` : `Vec<${kind(s.slice(0, -2), lang)}>`
    const rec = /^Record<string, (.+)>$/.exec(s)
    if (rec) return lang === "swift" ? `[String: ${kind(rec[1], lang)}]` : `std::collections::BTreeMap<String, ${kind(rec[1], lang)}>`
    if (aliases.has(s) || scalars.has(s) || valueTypes.has(s) || structs.has(s)) return s
    throw new Error(`contract: unsupported type ${s}`)
  }
  const heading = "// Generated by bun scripts/desktop-contract.ts. Do not edit.\n"
  // Swift already uses JSONSerialization for arbitrary domain data. Do not add
  // a competing JSON value type or change its wire encoding.
  let swift = heading + `import Foundation

private struct DesktopContractCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}
`
  let rust = heading + `#![allow(dead_code, non_snake_case)]
use serde::{Deserialize, Serialize};

fn desktop_contract_optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where D: serde::Deserializer<'de>, T: Deserialize<'de> {
    T::deserialize(deserializer).map(Some)
}
`
  let typescript = heading
  typescript += `export const DESKTOP_CONTRACT_ALIASES = ${JSON.stringify(Object.fromEntries(aliases), null, 2)} as const\n`
  typescript += `export const DESKTOP_CONTRACT_SCALARS = ${JSON.stringify(Object.fromEntries(scalars), null, 2)} as const\n`
  typescript += `export const DESKTOP_CONTRACT_VALUE_TYPES = ${JSON.stringify(Object.fromEntries(valueTypes), null, 2)} as const\n`
  typescript += `export const DESKTOP_CONTRACT_FIELDS = ${JSON.stringify(Object.fromEntries(structs), null, 2)} as const\n`
  const actionSchemas = new Map<string, string>()
  const dataSchemas = new Map<string, string>()
  for (const [name, fields] of structs) {
    if (!name.endsWith("Action")) continue
    const family = familyFor(name)
    if (!family) throw new Error(`contract: ${name} has no native validation family`)
    const discriminator = fields.find(f => f.name === "type")
    const operations = aliases.get(discriminator?.type ?? "")
    if (discriminator?.optional || operations?.length !== 1) throw new Error(`contract: ${name} requires one literal operation in a required type field`)
    if (actionSchemas.has(operations[0])) throw new Error(`contract: duplicate action operation ${operations[0]}`)
    actionSchemas.set(operations[0], name)
    const dataName = name.slice(0, -"Action".length) + "Data"
    if (!structs.has(dataName) && !scalars.has(dataName) && !aliases.has(dataName) && !valueTypes.has(dataName)) continue
    dataSchemas.set(operations[0], dataName)
  }
  typescript += `export const DESKTOP_ACTION_SCHEMAS = ${JSON.stringify(Object.fromEntries(actionSchemas), null, 2)} as const\n`
  typescript += `export const DESKTOP_OPERATION_DATA_SCHEMAS = ${JSON.stringify(Object.fromEntries(dataSchemas), null, 2)} as const\n`
  const clipboardSchemas = structs.get("DesktopClipboardResultSchemas") ?? []
  typescript += `export const DESKTOP_CLIPBOARD_DATA_SCHEMAS = ${JSON.stringify(Object.fromEntries(clipboardSchemas.map(f => [f.name, f.type])), null, 2)} as const\n`
  const captureSchemas = structs.get("DesktopCaptureResultSchemas") ?? []
  typescript += `export const DESKTOP_CAPTURE_DATA_SCHEMAS = ${JSON.stringify(Object.fromEntries(captureSchemas.map(f => [f.name, f.type])), null, 2)} as const\n`
  const displaySchemas = structs.get("DesktopDisplayResultSchemas") ?? []
  typescript += `export const DESKTOP_DISPLAY_DATA_SCHEMAS = ${JSON.stringify(Object.fromEntries(displaySchemas.map(f => [f.name, f.type])), null, 2)} as const\n`
  const authSchemas = structs.get("DesktopAuthResultSchemas") ?? []
  typescript += `export const DESKTOP_AUTH_DATA_SCHEMAS = ${JSON.stringify(Object.fromEntries(authSchemas.map(f => [f.name, f.type])), null, 2)} as const\n`
  const authDialogSchemas = structs.get("DesktopAuthDialogResultSchemas") ?? []
  typescript += `export const DESKTOP_AUTHDIALOG_DATA_SCHEMAS = ${JSON.stringify(Object.fromEntries(authDialogSchemas.map(f => [f.name, f.type])), null, 2)} as const\n`
  const secretSchemas = structs.get("DesktopSecretResultSchemas") ?? []
  if (structs.has("DesktopSecretResultSchemas")) {
    const selectors = aliases.get("DesktopSecretVerb") ?? []
    if (!selectors.length || secretSchemas.length !== selectors.length || secretSchemas.some(field => field.optional || !selectors.includes(field.name))) {
      throw new Error("contract: DesktopSecretResultSchemas must cover every declared vault result selector")
    }
  }
  typescript += `export const DESKTOP_SECRET_DATA_SCHEMAS = ${JSON.stringify(Object.fromEntries(secretSchemas.map(f => [f.name, f.type])), null, 2)} as const\n`
  const accessibilityHosts = [["darwin", "DesktopAxDarwinResultSchemas"], ["win32", "DesktopAxWin32ResultSchemas"], ["linux", "DesktopAxLinuxResultSchemas"]] as const
  if (accessibilityHosts.some(([, name]) => structs.has(name))) {
    const selectors = [...dataSchemas].filter(([operation, schema]) => actionSchemas.get(operation)!.startsWith("DesktopAx") && !scalars.has(schema))
      .flatMap(([operation]) => actionSchemas.get(operation) === "DesktopAxValueAction" ? [operation + "_read", operation + "_write"]
        : actionSchemas.get(operation) === "DesktopAxMenuAction" ? [operation + "_list", operation + "_invoke"] : [operation])
    for (const [, name] of accessibilityHosts) {
      const fields = structs.get(name)
      if (!fields || fields.length !== selectors.length || fields.some(field => field.optional || !selectors.includes(field.name))) {
        throw new Error(`contract: ${name} must cover every declared accessibility result selector`)
      }
    }
  }
  const accessibilitySchemas = Object.fromEntries(accessibilityHosts.map(([host, name]) => [host, Object.fromEntries((structs.get(name) ?? []).map(f => [f.name, f.type]))]))
  typescript += `export const DESKTOP_ACCESSIBILITY_DATA_SCHEMAS = ${JSON.stringify(accessibilitySchemas, null, 2)} as const\n`
  typescript += 'type DesktopAccessibilitySchemas = typeof DESKTOP_ACCESSIBILITY_DATA_SCHEMAS[keyof typeof DESKTOP_ACCESSIBILITY_DATA_SCHEMAS]\n'
  typescript += 'export type DesktopContractSchema = keyof typeof DESKTOP_CONTRACT_FIELDS | keyof typeof DESKTOP_CONTRACT_ALIASES | keyof typeof DESKTOP_CONTRACT_SCALARS | keyof typeof DESKTOP_CONTRACT_VALUE_TYPES | DesktopAccessibilitySchemas[keyof DesktopAccessibilitySchemas] | typeof DESKTOP_CLIPBOARD_DATA_SCHEMAS[keyof typeof DESKTOP_CLIPBOARD_DATA_SCHEMAS] | typeof DESKTOP_DISPLAY_DATA_SCHEMAS[keyof typeof DESKTOP_DISPLAY_DATA_SCHEMAS]\n'
  for (const [name, n] of constants) {
    swift += `let ${name} = ${n}\n`
    rust += `pub const ${name}: usize = ${n};\n`
  }
  for (const [name, values] of aliases) {
    swift += `\nenum ${name}: String, Codable {\n${values.map((v, i) => `    case v${i} = ${JSON.stringify(v)}`).join("\n")}\n}\n`
    rust += `\n#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]\npub enum ${name} {\n${values.map((v, i) => `    #[serde(rename = ${JSON.stringify(v)})]\n    V${i},`).join("\n")}\n}\n`
  }
  for (const [name, type] of scalars) {
    swift += `\ntypealias ${name} = ${kind(type, "swift")}\n`
    rust += `\npub type ${name} = ${kind(type, "rust")};\n`
  }
  for (const [name, types] of valueTypes) {
    if (types.length === 1 && types[0] !== "null") {
      swift += `\ntypealias ${name} = ${kind(types[0], "swift")}\n`
      rust += `\npub type ${name} = ${kind(types[0], "rust")};\n`
      continue
    }
    const recursive = types.some(type => new RegExp("\\b" + name + "\\b").test(type))
    swift += `\n${recursive ? "indirect " : ""}enum ${name}: Codable {\n${types.map((type, n) => `    case v${n}${type === "null" ? "" : `(${kind(type, "swift")})`}`).join("\n")}\n    init(from decoder: Decoder) throws {\n        let value = try decoder.singleValueContainer()\n${types.map((type, n) => type === "null" ? `        if value.decodeNil() { self = .v${n}; return }` : `        if let decoded = try? value.decode(${kind(type, "swift")}.self) { self = .v${n}(decoded); return }`).join("\n")}\n        throw DecodingError.typeMismatch(${name}.self, .init(codingPath: decoder.codingPath, debugDescription: "invalid ${name}"))\n    }\n    func encode(to encoder: Encoder) throws {\n        var value = encoder.singleValueContainer()\n        switch self {\n${types.map((type, n) => type === "null" ? `        case .v${n}: try value.encodeNil()` : `        case .v${n}(let decoded): try value.encode(decoded)`).join("\n")}\n        }\n    }\n}\n`
    rust += `\n#[derive(Debug, Clone, Serialize, Deserialize)]\n#[serde(untagged)]\npub enum ${name} {\n${types.map((type, n) => `    V${n}${type === "null" ? "" : `(${kind(type, "rust")})`},`).join("\n")}\n}\n`
  }
  const nativeTypes = new Set<string>()
  const pendingTypes = [...structs.keys(), ...valueTypes.keys()].filter(name => families.some(([prefix]) => name.startsWith(prefix)))
  while (pendingTypes.length) {
    const name = pendingTypes.pop()!
    if (nativeTypes.has(name)) continue
    nativeTypes.add(name)
    for (const type of structs.get(name)?.map(field => field.type) ?? valueTypes.get(name) ?? []) {
      for (const reference of type.match(/[A-Za-z_]\w*/g) ?? []) if (structs.has(reference) || valueTypes.has(reference)) pendingTypes.push(reference)
    }
  }
  for (const [name, fields] of structs) {
    const strict = nativeTypes.has(name)
    if (strict && fields.some(f => f.type.includes("unknown"))) throw new Error("contract: native action fields require Codable types")
    swift += `\nstruct ${name}${strict ? ": Codable" : ""} {\n${fields.map(f => `    let \`${f.name}\`: ${kind(f.type, "swift")}${f.optional ? "?" : ""}`).join("\n")}\n}\n`
    if (strict && fields.length === 0) swift += `
extension ${name} {
    init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: DesktopContractCodingKey.self)
        if let key = keys.allKeys.first {
            throw DecodingError.dataCorruptedError(forKey: key, in: keys, debugDescription: "unknown ${name} field")
        }
    }
    func encode(to encoder: Encoder) throws {
        _ = encoder.container(keyedBy: DesktopContractCodingKey.self)
    }
}
`
    else if (strict) swift += `
extension ${name} {
    private enum CodingKeys: String, CodingKey {
${fields.map((f, n) => `        case f${n} = ${JSON.stringify(f.name)}`).join("\n")}
    }
    init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: DesktopContractCodingKey.self)
        for key in keys.allKeys where CodingKeys(rawValue: key.stringValue) == nil {
            throw DecodingError.dataCorruptedError(forKey: key, in: keys, debugDescription: "unknown ${name} field")
        }
        let value = try decoder.container(keyedBy: CodingKeys.self)
${fields.map((f, n) => `        self.\`${f.name}\` = ${f.optional ? `value.contains(.f${n}) ? try value.decode(${kind(f.type, "swift")}.self, forKey: .f${n}) : nil` : `try value.decode(${kind(f.type, "swift")}.self, forKey: .f${n})`}`).join("\n")}
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.container(keyedBy: CodingKeys.self)
${fields.map((f, n) => `        try value.${f.optional ? "encodeIfPresent" : "encode"}(self.\`${f.name}\`, forKey: .f${n})`).join("\n")}
    }
}
`
    rust += `\n#[derive(Debug, Clone, Serialize, Deserialize)]\n${strict ? '#[serde(deny_unknown_fields)]\n' : ''}pub struct ${name} {\n${fields.map(f => `${f.optional ? `    #[serde(default, skip_serializing_if = "Option::is_none"${strict ? ', deserialize_with = "desktop_contract_optional_non_null"' : ''})]\n` : ""}    pub r#${f.name}: ${f.optional ? `Option<${kind(f.type, "rust")}>` : kind(f.type, "rust")},`).join("\n")}\n}\n`
  }
  for (const [prefix, family, shape] of families) {
  const schemas = [...structs].filter(([name]) => familyFor(name)?.[0] === prefix)
  const actions = schemas.filter(([name]) => name.endsWith("Action")).map(([name, fields]) => {
    const operation = aliases.get(fields.find(f => f.name === "type")?.type ?? "")
    if (operation?.length !== 1) throw new Error(`contract: ${family} action requires one literal operation`)
    return {name, operation: operation[0]}
  })
  if (actions.length) {
    typescript += `export const DESKTOP_${family.toUpperCase()}_OPERATIONS = [${actions.map(a => JSON.stringify(a.operation)).join(", ")}] as const\n`
    swift += `\n// JSONDecoder supplies field types and required-field checks. These generated\n// key tables additionally reject unknown fields and explicit nulls.\nenum ${shape} {\n    static let operations: Set<String> = [${actions.map(a => JSON.stringify(a.operation)).join(", ")}]\n    private static let schemas: [String: [String: String]] = [\n${schemas.map(([name, fields]) => `        ${JSON.stringify(name)}: [${fields.length ? fields.map(f => `${JSON.stringify(f.name)}: ${JSON.stringify(f.type)}`).join(", ") : ":"}],`).join("\n")}\n    ]\n    static func validationError(_ action: [String: Any]) -> String? {\n        let type = action["type"] as? String ?? ""\n        let schema: String\n        switch type {\n${actions.map(a => `        case ${JSON.stringify(a.operation)}: schema = ${JSON.stringify(a.name)}`).join("\n")}\n        default: return "unknown ${family} operation"\n        }\n        if let error = validateKeys(action, schema: schema) { return error }\n        do {\n            let data = try JSONSerialization.data(withJSONObject: action)\n            let decoder = JSONDecoder()\n            switch type {\n${actions.map(a => `            case ${JSON.stringify(a.operation)}: _ = try decoder.decode(${a.name}.self, from: data)`).join("\n")}\n            default: return "unknown ${family} operation"\n            }\n        } catch { return "invalid ${family} fields: \\(error.localizedDescription)" }\n        return nil\n    }\n    private static func validateKeys(_ value: Any, schema: String) -> String? {\n        if value is NSNull { return "${family} fields cannot be null" }\n        if schema.hasSuffix("[]"), let array = value as? [Any] {\n            for item in array { if let error = validateKeys(item, schema: String(schema.dropLast(2))) { return error } }\n        }\n        guard let fields = schemas[schema], let object = value as? [String: Any] else { return nil }\n        for key in object.keys.sorted() {\n            guard let child = fields[key] else { return "unknown ${family} field: \\(key)" }\n            if let error = validateKeys(object[key]!, schema: child) { return error }\n        }\n        return nil\n    }\n}\n`
    if (family === "monitor" && structs.has("DesktopMonitorMacPayloadSchemas")) {
      const payloads = structs.get("DesktopMonitorMacPayloadSchemas")!
      swift += `\nextension ${shape} {\n    static let macPayloadEvents: Set<String> = [${payloads.map(f => JSON.stringify(f.name)).join(", ")}]\n    static func macPayloadShapeError(_ row: [String: Any]) -> String? {\n        let event = row["event"] as? String ?? ""\n        guard macPayloadEvents.contains(event) else { return nil }\n        let payload = row.filter { !["sid", "s", "t", "event", "timestamp", "taskId"].contains($0.key) }\n        do {\n            let data = try JSONSerialization.data(withJSONObject: payload), decoder = JSONDecoder()\n            switch event {\n${payloads.map(f => `            case ${JSON.stringify(f.name)}: _ = try decoder.decode(${f.type}.self, from: data)`).join("\n")}\n            default: return nil\n            }\n        } catch { return "invalid monitor payload fields: \\(error.localizedDescription)" }\n        return nil\n    }\n}\n`
    }
    rust += `
pub const DESKTOP_${family.toUpperCase()}_OPERATIONS: &[&str] = &[${actions.map(a => JSON.stringify(a.operation)).join(", ")}];
pub fn desktop_${family}_shape_error(action: &serde_json::Value) -> Option<String> {
    fn validate_keys(value: &serde_json::Value, schema: &str) -> Option<String> {
        if value.is_null() { return Some("${family} fields cannot be null".into()); }
        if let Some(item_schema) = schema.strip_suffix("[]") {
            if let Some(items) = value.as_array() { for item in items { if let Some(error) = validate_keys(item, item_schema) { return Some(error); } } }
        }
        let fields: &[(&str, &str)] = match schema {
${schemas.map(([name, fields]) => `            ${JSON.stringify(name)} => &[${fields.map(f => `(${JSON.stringify(f.name)}, ${JSON.stringify(f.type)})`).join(", ")}],`).join("\n")}
            _ => return None,
        };
        if let Some(object) = value.as_object() { for (key, child) in object {
            let Some((_, child_schema)) = fields.iter().find(|(field, _)| *field == key) else { return Some(format!("unknown ${family} field: {}", key.chars().take(512).collect::<String>())); };
            if let Some(error) = validate_keys(child, child_schema) { return Some(error); }
        } }
        None
    }
    let action_type = action["type"].as_str().unwrap_or("");
    let schema = match action_type {
${actions.map(a => `        ${JSON.stringify(a.operation)} => ${JSON.stringify(a.name)},`).join("\n")}
        _ => return Some("unknown ${family} operation".into()),
    };
    if let Some(error) = validate_keys(action, schema) { return Some(error.chars().take(512).collect()); }
    let result = match action_type {
${actions.map(a => `        ${JSON.stringify(a.operation)} => serde_json::from_value::<${a.name}>(action.clone()).map(|_| ()),`).join("\n")}
        _ => unreachable!(),
    };
    result.err().map(|error| error.to_string().chars().take(512).collect())
}
`
  }
  }
  return { swift, rust, typescript }
}

if (import.meta.main) {
  const generated = generateDesktopContract(await Bun.file(join(root, "shared/desktop-contract.ts")).text())
  for (const lang of ["swift", "rust", "typescript"] as const) {
    const file = Bun.file(outputs[lang])
    if (process.argv.includes("--check")) {
      if (!await file.exists() || await file.text() !== generated[lang]) throw new Error(`stale contract: ${outputs[lang]}`)
    } else await Bun.write(file, generated[lang])
  }
}
