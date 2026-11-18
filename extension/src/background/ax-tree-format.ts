import { SECURE_MASK } from "../content/sensitive"

type AXValue = { value?: unknown; sources?: Array<{ type?: string; value?: { value?: unknown }; superseded?: boolean }> }
export type AXNode = { nodeId?: string; role?: AXValue; name?: AXValue; childIds?: string[]; properties?: Array<{ name?: string }> }

/**
 * Format Accessibility.getFullAXTree nodes one per line. Text under an
 * editable node is that field's value: Chrome bullets only type=password, so a
 * revealed password, a credential-autocomplete field, or a vault-filled text
 * field would print in clear. That text is masked; the field's label is not.
 */
export function formatAXTree(nodes: AXNode[]): string {
  const byId = new Map(nodes.map(n => [n.nodeId, n]))
  const insideEditable = new Set<string>()
  const markInside = (id: string): void => {
    if (insideEditable.has(id)) return
    insideEditable.add(id)
    for (const child of byId.get(id)?.childIds || []) markInside(child)
  }
  for (const n of nodes) {
    if (!n.properties?.some(p => p.name === "editable")) continue
    for (const child of n.childIds || []) markInside(child)
    if (n.nodeId && n.name?.sources?.some(s => s.type === "contents" && s.value && !s.superseded)) insideEditable.add(n.nodeId)
  }
  return nodes.map(n => {
    const role = String(n.role?.value || "")
    const name = String(n.name?.value || "")
    const nodeId = n.nodeId || ""
    return `[${nodeId}] ${role} "${name && insideEditable.has(nodeId) ? SECURE_MASK : name}"`
  }).join("\n")
}
