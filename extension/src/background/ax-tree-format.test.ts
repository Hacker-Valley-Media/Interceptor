import { expect, test } from "bun:test"
import { formatAXTree } from "./ax-tree-format"
import { SECURE_MASK } from "../content/sensitive"

const canary = "CANARY-ax-0123"
const node = (nodeId: string, role: string, name: string, childIds: string[] = [], editable = false) =>
  ({ nodeId, role: { value: role }, name: { value: name }, childIds, properties: editable ? [{ name: "editable" }] : [] })

test("text inside an editable field is masked, labels and page text are not", () => {
  const out = formatAXTree([
    node("1", "RootWebArea", "Fixture", ["2", "3", "6"]),
    node("2", "textbox", "Password", ["4"], true),
    node("4", "generic", "", ["5"], true),
    node("5", "StaticText", canary, ["-7"]),
    node("-7", "InlineTextBox", canary),
    node("3", "textbox", "Empty", [], true),
    node("6", "StaticText", "ordinary page text"),
  ])
  expect(out).not.toContain("CANARY")
  expect(out).toContain(`[5] StaticText "${SECURE_MASK}"`)
  expect(out).toContain(`[-7] InlineTextBox "${SECURE_MASK}"`)
  expect(out).toContain(`[2] textbox "Password"`)
  expect(out).toContain(`[3] textbox "Empty"`)
  expect(out).toContain(`[6] StaticText "ordinary page text"`)
})
