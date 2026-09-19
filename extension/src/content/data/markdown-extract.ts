import { isVisible } from "../element-discovery"
import { isSensitive, safeText, SECURE_MASK } from "../sensitive"

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE"])
const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "FORM", "FIELDSET", "DETAILS", "SUMMARY", "FIGURE", "FIGCAPTION", "ADDRESS", "DD", "DT", "DL"])

export function renderMarkdown(root: Element): string {
  const out = walkNode(root)
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "")
}

function walkNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || "").replace(/\s+/g, " ")
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ""

  const el = node as Element
  const tag = el.tagName

  if (SKIP_TAGS.has(tag)) return ""
  if (!isVisible(el) && tag !== "BODY") return ""
  if (isSensitive(el)) return el.textContent ? SECURE_MASK : ""

  switch (tag) {
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
      const level = parseInt(tag[1])
      const content = inlineChildren(el)
      return content ? `\n\n${"#".repeat(level)} ${content}\n\n` : ""
    }
    case "P": {
      const content = inlineChildren(el)
      return content ? `\n\n${content}\n\n` : ""
    }
    case "BR":
      return "\n"
    case "HR":
      return "\n\n---\n\n"
    case "PRE":
      return renderPre(el)
    case "BLOCKQUOTE":
      return renderBlockquote(el)
    case "UL":
      return renderList(el, "ul", 0)
    case "OL":
      return renderList(el, "ol", 0)
    case "TABLE":
      return renderTable(el)
    case "STRONG": case "B": {
      const c = inlineChildren(el)
      return c ? `**${c}**` : ""
    }
    case "EM": case "I": {
      const c = inlineChildren(el)
      return c ? `*${c}*` : ""
    }
    case "CODE": {
      if (el.closest("pre")) return safeText(el)
      const c = safeText(el).trim()
      return c ? `\`${c}\`` : ""
    }
    case "A": {
      const href = el.getAttribute("href") || ""
      const text = inlineChildren(el)
      if (!text) return ""
      if (!href || href.startsWith("javascript:") || href === "#" || href.startsWith("#")) return text
      return `[${text}](${href})`
    }
    case "IMG": {
      const alt = (el.getAttribute("alt") || "").trim()
      const src = el.getAttribute("src") || ""
      if (!alt && !src) return ""
      return `![${alt}](${src})`
    }
  }

  let out = ""
  for (const child of el.childNodes) out += walkNode(child)

  if (BLOCK_TAGS.has(tag) && out.trim()) {
    if (!out.startsWith("\n")) out = "\n" + out
    if (!out.endsWith("\n")) out = out + "\n"
  }
  return out
}

function inlineChildren(el: Element): string {
  if (isSensitive(el)) return el.textContent ? SECURE_MASK : ""
  let out = ""
  for (const child of el.childNodes) out += walkNode(child)
  return out.replace(/\s+/g, " ").trim()
}

function renderPre(el: Element): string {
  const code = safeText(el).replace(/^\n+|\n+$/g, "")
  if (!code) return ""
  const codeEl = el.querySelector("code")
  const lang = codeEl?.className.match(/language-(\S+)/)?.[1] || ""
  return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`
}

function renderBlockquote(el: Element): string {
  let inner = ""
  for (const child of el.childNodes) inner += walkNode(child)
  inner = inner.replace(/\n{3,}/g, "\n\n").trim()
  if (!inner) return ""
  const quoted = inner.split("\n").map(l => l ? `> ${l}` : ">").join("\n")
  return `\n\n${quoted}\n\n`
}

function renderList(el: Element, kind: "ul" | "ol", indent: number): string {
  const items: string[] = []
  let idx = 1
  for (const child of el.children) {
    const childTag = child.tagName
    if (childTag !== "LI") continue
    if (!isVisible(child)) continue
    const parts = renderListItem(child, kind, idx, indent)
    if (parts) items.push(parts)
    if (kind === "ol") idx++
  }
  if (!items.length) return ""
  return `\n\n${items.join("\n")}\n\n`
}

function renderListItem(el: Element, kind: "ul" | "ol", index: number, indent: number): string {
  const pad = "  ".repeat(indent)
  const bullet = kind === "ul" ? "-" : `${index}.`
  if (isSensitive(el)) return el.textContent ? `${pad}${bullet} ${SECURE_MASK}` : ""
  let mainLine = ""
  const nested: string[] = []
  for (const child of el.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const c = child as Element
      if (c.tagName === "UL") {
        const sub = renderList(c, "ul", indent + 1).trim()
        if (sub) nested.push(sub)
        continue
      }
      if (c.tagName === "OL") {
        const sub = renderList(c, "ol", indent + 1).trim()
        if (sub) nested.push(sub)
        continue
      }
    }
    mainLine += walkNode(child)
  }
  mainLine = mainLine.replace(/\s+/g, " ").trim()
  if (!mainLine && !nested.length) return ""
  const head = `${pad}${bullet} ${mainLine}`.trimEnd()
  return nested.length ? `${head}\n${nested.join("\n")}` : head
}

function renderTable(el: Element): string {
  const rows = Array.from(el.querySelectorAll("tr"))
  if (!rows.length) return ""

  const matrix: string[][] = []
  let headerIdx = -1
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!isVisible(row)) continue
    const cells: string[] = []
    let hasTh = false
    for (const cell of Array.from(row.children)) {
      if (cell.tagName !== "TH" && cell.tagName !== "TD") continue
      if (cell.tagName === "TH") hasTh = true
      const text = inlineChildren(cell).replace(/\|/g, "\\|").replace(/\n/g, " ")
      cells.push(text)
    }
    if (!cells.length) continue
    matrix.push(cells)
    if (hasTh && headerIdx === -1) headerIdx = matrix.length - 1
  }
  if (!matrix.length) return ""

  const width = Math.max(...matrix.map(r => r.length))
  for (const r of matrix) while (r.length < width) r.push("")

  let header: string[]
  let body: string[][]
  if (headerIdx === 0) {
    header = matrix[0]
    body = matrix.slice(1)
  } else {
    header = Array.from({ length: width }, (_, i) => `Col ${i + 1}`)
    body = matrix
  }

  const sep = Array.from({ length: width }, () => "---")
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...body.map(r => `| ${r.join(" | ")} |`)
  ]
  return `\n\n${lines.join("\n")}\n\n`
}
