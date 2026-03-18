chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "execute_action") {
    handleAction(msg.action).then(sendResponse)
    return true
  }
  if (msg.type === "get_state") {
    sendResponse(getPageState(msg.full))
    return true
  }
})

function getPageState(full = false) {
  const elements = getInteractiveElements()
  const tree = buildElementTree(elements)
  const scrollY = window.scrollY
  const scrollHeight = document.documentElement.scrollHeight
  const viewportHeight = window.innerHeight

  const state: Record<string, unknown> = {
    url: location.href,
    title: document.title,
    elementTree: tree,
    scrollPosition: { y: scrollY, height: scrollHeight, viewportHeight },
    timestamp: Date.now()
  }

  if (full) {
    state.staticText = document.body.innerText.slice(0, 5000)
  }

  return { success: true, data: state }
}

interface IndexedElement {
  index: number
  element: Element
  selector: string
  tag: string
  text: string
  attrs: string
}

const selectorMap = new Map<number, string>()
let nextIndex = 0

function getInteractiveElements(): IndexedElement[] {
  selectorMap.clear()
  nextIndex = 0

  const interactiveTags = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DETAILS", "SUMMARY"])
  const interactiveRoles = new Set(["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "textbox", "combobox", "listbox", "option", "slider"])

  const results: IndexedElement[] = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)

  let node: Node | null = walker.currentNode
  while (node) {
    const el = node as Element
    if (isInteractive(el, interactiveTags, interactiveRoles) && isVisible(el)) {
      const idx = nextIndex++
      const selector = buildSelector(el)
      selectorMap.set(idx, selector)

      const tag = el.tagName.toLowerCase()
      const text = (el.textContent || "").trim().slice(0, 80)
      const attrs = getRelevantAttrs(el)

      results.push({ index: idx, element: el, selector, tag, text, attrs })
    }
    node = walker.nextNode()
  }

  return results
}

function isInteractive(el: Element, tags: Set<string>, roles: Set<string>): boolean {
  if (tags.has(el.tagName)) return true
  const role = el.getAttribute("role")
  if (role && roles.has(role)) return true
  if (el.hasAttribute("onclick")) return true
  if (el.getAttribute("contenteditable") === "true") return true
  if (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") return true
  return false
}

function isVisible(el: Element): boolean {
  if (!(el as HTMLElement).offsetParent && el.tagName !== "BODY") return false
  const style = getComputedStyle(el)
  if (style.visibility === "hidden" || style.display === "none") return false
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  return true
}

function buildSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`
  const parts: string[] = []
  let current: Element | null = el
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase()
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`)
      break
    }
    const parent = current.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === current!.tagName)
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1
        selector += `:nth-of-type(${idx})`
      }
    }
    parts.unshift(selector)
    current = parent
  }
  return parts.join(" > ")
}

function getRelevantAttrs(el: Element): string {
  const attrs: string[] = []
  const tag = el.tagName.toLowerCase()

  if (tag === "a") {
    const href = el.getAttribute("href")
    if (href) attrs.push(`href="${href.slice(0, 60)}"`)
  }
  if (tag === "input") {
    const type = el.getAttribute("type")
    if (type) attrs.push(`type="${type}"`)
    const placeholder = el.getAttribute("placeholder")
    if (placeholder) attrs.push(`placeholder="${placeholder}"`)
    const value = (el as HTMLInputElement).value
    if (value) attrs.push(`value="${value.slice(0, 40)}"`)
    if ((el as HTMLInputElement).checked) attrs.push("checked")
  }
  if (tag === "select" || tag === "textarea") {
    const value = (el as HTMLSelectElement | HTMLTextAreaElement).value
    if (value) attrs.push(`value="${value.slice(0, 40)}"`)
  }
  if (tag === "img") {
    const src = el.getAttribute("src")
    if (src) attrs.push(`src="${src.slice(0, 60)}"`)
    const alt = el.getAttribute("alt")
    if (alt) attrs.push(`alt="${alt.slice(0, 40)}"`)
  }
  const ariaLabel = el.getAttribute("aria-label")
  if (ariaLabel) attrs.push(`aria-label="${ariaLabel.slice(0, 40)}"`)
  const cls = el.getAttribute("class")
  if (cls) attrs.push(`class="${cls.split(" ").slice(0, 3).join(" ")}"`)

  return attrs.join(" ")
}

function buildElementTree(elements: IndexedElement[]): string {
  return elements.map(e => {
    const attrStr = e.attrs ? ` ${e.attrs}` : ""
    const text = e.text ? e.text : ""
    return `[${e.index}]<${e.tag}${attrStr}>${text}</${e.tag}>`
  }).join("\n")
}

async function handleAction(action: { type: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string; data?: unknown }> {
  try {
    switch (action.type) {
      case "get_state":
        return getPageState(action.full as boolean)

      case "click": {
        const el = resolveElement(action.index as number)
        if (!el) return { success: false, error: `element [${action.index}] not found (run slop state to refresh)` }
        scrollIntoViewIfNeeded(el)
        dispatchClickSequence(el)
        return { success: true, data: `clicked [${action.index}]` }
      }

      case "dblclick": {
        const el = resolveElement(action.index as number)
        if (!el) return { success: false, error: `element [${action.index}] not found` }
        scrollIntoViewIfNeeded(el)
        dispatchClickSequence(el)
        const rect = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }))
        return { success: true }
      }

      case "rightclick": {
        const el = resolveElement(action.index as number)
        if (!el) return { success: false, error: `element [${action.index}] not found` }
        scrollIntoViewIfNeeded(el)
        const rect = el.getBoundingClientRect()
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }))
        return { success: true }
      }

      case "input_text": {
        const el = resolveElement(action.index as number) as HTMLInputElement | HTMLTextAreaElement | null
        if (!el) return { success: false, error: `element [${action.index}] not found` }
        el.focus()
        if (action.clear) {
          el.value = ""
          el.dispatchEvent(new Event("input", { bubbles: true }))
        }
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          "value"
        )?.set
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, (action.clear ? "" : el.value) + (action.text as string))
        } else {
          el.value = (action.clear ? "" : el.value) + (action.text as string)
        }
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
        return { success: true }
      }

      case "select_option": {
        const el = resolveElement(action.index as number) as HTMLSelectElement | null
        if (!el) return { success: false, error: `element [${action.index}] not found` }
        el.value = action.value as string
        el.dispatchEvent(new Event("change", { bubbles: true }))
        return { success: true }
      }

      case "check": {
        const el = resolveElement(action.index as number) as HTMLInputElement | null
        if (!el) return { success: false, error: `element [${action.index}] not found` }
        const target = action.checked !== undefined ? !!(action.checked) : !el.checked
        if (el.checked !== target) {
          el.checked = target
          el.dispatchEvent(new Event("change", { bubbles: true }))
          el.dispatchEvent(new Event("input", { bubbles: true }))
        }
        return { success: true, data: { checked: el.checked } }
      }

      case "scroll": {
        const dir = action.direction as string
        const amount = (action.amount as number) || window.innerHeight * 0.8
        switch (dir) {
          case "up": window.scrollBy(0, -amount); break
          case "down": window.scrollBy(0, amount); break
          case "top": window.scrollTo(0, 0); break
          case "bottom": window.scrollTo(0, document.documentElement.scrollHeight); break
        }
        return { success: true }
      }

      case "evaluate": {
        const code = action.code as string
        const resultId = "__slop_" + Math.random().toString(36).slice(2)
        const container = document.createElement("div")
        container.id = resultId
        container.style.display = "none"
        document.documentElement.appendChild(container)
        const s = document.createElement("script")
        s.textContent = `
          (function() {
            var c = document.getElementById("${resultId}");
            try {
              var __r = ${code};
              c.setAttribute("data-result", JSON.stringify({ success: true, data: (typeof __r === 'object' && __r !== null) ? JSON.parse(JSON.stringify(__r)) : __r }));
            } catch(e) {
              c.setAttribute("data-result", JSON.stringify({ success: false, error: e.message }));
            }
          })();
        `
        document.documentElement.appendChild(s)
        s.remove()
        const result = container.getAttribute("data-result")
        container.remove()
        if (result) {
          try { return JSON.parse(result) } catch { return { success: true, data: result } }
        }
        return { success: false, error: "eval produced no result" }
      }

      case "scroll_to": {
        const el = resolveElement(action.index as number)
        if (!el) return { success: false, error: `element [${action.index}] not found` }
        el.scrollIntoView({ block: "center", behavior: "instant" })
        return { success: true }
      }

      case "send_keys": {
        const keys = action.keys as string
        const target = document.activeElement || document.body
        dispatchKeySequence(target, keys)
        return { success: true }
      }

      case "wait":
        await new Promise(r => setTimeout(r, action.ms as number))
        return { success: true }

      case "wait_for": {
        const selector = action.selector as string
        const timeout = (action.timeout as number) || 10000
        const el = await waitForElement(selector, timeout)
        return el
          ? { success: true, data: `found: ${selector}` }
          : { success: false, error: `timeout waiting for: ${selector}` }
      }

      case "extract_text": {
        if (action.index !== undefined) {
          const el = resolveElement(action.index as number)
          if (!el) return { success: false, error: `element [${action.index}] not found` }
          return { success: true, data: (el.textContent || "").trim() }
        }
        return { success: true, data: document.body.innerText.slice(0, 10000) }
      }

      case "extract_html": {
        if (action.index !== undefined) {
          const el = resolveElement(action.index as number)
          if (!el) return { success: false, error: `element [${action.index}] not found` }
          return { success: true, data: el.outerHTML.slice(0, 10000) }
        }
        return { success: true, data: document.documentElement.outerHTML.slice(0, 50000) }
      }

      case "focus": {
        const el = resolveElement(action.index as number) as HTMLElement | null
        if (!el) return { success: false, error: `element [${action.index}] not found` }
        el.focus()
        return { success: true }
      }

      case "blur": {
        (document.activeElement as HTMLElement)?.blur()
        return { success: true }
      }

      case "hover": {
        const el = resolveElement(action.index as number)
        if (!el) return { success: false, error: `element [${action.index}] not found` }
        dispatchHoverSequence(el)
        return { success: true }
      }

      case "query": {
        const selector = action.selector as string
        const els = document.querySelectorAll(selector)
        return {
          success: true, data: {
            count: els.length,
            elements: Array.from(els).slice(0, 20).map((el, i) => ({
              index: i,
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || "").trim().slice(0, 80),
              id: el.id || undefined,
              classes: el.className || undefined
            }))
          }
        }
      }

      case "query_one": {
        const el = document.querySelector(action.selector as string)
        if (!el) return { success: false, error: `no element matching: ${action.selector}` }
        return {
          success: true, data: {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || "").trim().slice(0, 200),
            html: el.outerHTML.slice(0, 500),
            id: el.id || undefined,
            rect: el.getBoundingClientRect()
          }
        }
      }

      case "attr_get": {
        const el = resolveElement(action.index as number) || document.querySelector(action.selector as string)
        if (!el) return { success: false, error: "element not found" }
        const name = action.name as string
        return { success: true, data: el.getAttribute(name) }
      }

      case "attr_set": {
        const el = resolveElement(action.index as number) || document.querySelector(action.selector as string)
        if (!el) return { success: false, error: "element not found" }
        el.setAttribute(action.name as string, action.value as string)
        return { success: true }
      }

      case "style_get": {
        const el = resolveElement(action.index as number) || document.querySelector(action.selector as string)
        if (!el) return { success: false, error: "element not found" }
        const computed = getComputedStyle(el)
        if (action.property) {
          return { success: true, data: computed.getPropertyValue(action.property as string) }
        }
        const props = ["display", "visibility", "color", "backgroundColor", "fontSize", "position", "width", "height", "margin", "padding"]
        const styles: Record<string, string> = {}
        for (const p of props) styles[p] = computed.getPropertyValue(p)
        return { success: true, data: styles }
      }

      case "forms": {
        const forms = document.querySelectorAll("form")
        return {
          success: true, data: Array.from(forms).map((f, i) => ({
            index: i,
            action: f.action,
            method: f.method,
            id: f.id || undefined,
            fields: Array.from(f.elements).map(el => ({
              tag: el.tagName.toLowerCase(),
              type: (el as HTMLInputElement).type,
              name: (el as HTMLInputElement).name,
              value: (el as HTMLInputElement).value?.slice(0, 40),
              placeholder: (el as HTMLInputElement).placeholder
            }))
          }))
        }
      }

      case "links": {
        const links = document.querySelectorAll("a[href]")
        return {
          success: true, data: Array.from(links).slice(0, 100).map(a => ({
            href: (a as HTMLAnchorElement).href,
            text: (a.textContent || "").trim().slice(0, 60)
          }))
        }
      }

      case "images": {
        const imgs = document.querySelectorAll("img")
        return {
          success: true, data: Array.from(imgs).slice(0, 50).map(img => ({
            src: (img as HTMLImageElement).src,
            alt: (img as HTMLImageElement).alt,
            width: (img as HTMLImageElement).naturalWidth,
            height: (img as HTMLImageElement).naturalHeight
          }))
        }
      }

      case "meta": {
        const metas = document.querySelectorAll("meta")
        const data: Record<string, string> = {}
        metas.forEach(m => {
          const key = m.getAttribute("name") || m.getAttribute("property") || m.getAttribute("http-equiv")
          const val = m.getAttribute("content")
          if (key && val) data[key] = val.slice(0, 200)
        })
        data["title"] = document.title
        data["canonical"] = (document.querySelector('link[rel="canonical"]') as HTMLLinkElement)?.href || ""
        data["lang"] = document.documentElement.lang || ""
        return { success: true, data }
      }

      case "storage_read": {
        const storageType = (action.storageType as string) === "session" ? sessionStorage : localStorage
        if (action.key) {
          return { success: true, data: storageType.getItem(action.key as string) }
        }
        const all: Record<string, string> = {}
        for (let i = 0; i < storageType.length; i++) {
          const key = storageType.key(i)!
          all[key] = storageType.getItem(key)!.slice(0, 200)
        }
        return { success: true, data: all }
      }

      case "storage_write": {
        const storageType = (action.storageType as string) === "session" ? sessionStorage : localStorage
        storageType.setItem(action.key as string, action.value as string)
        return { success: true }
      }

      case "storage_delete": {
        const storageType = (action.storageType as string) === "session" ? sessionStorage : localStorage
        storageType.removeItem(action.key as string)
        return { success: true }
      }

      case "clipboard_read": {
        const text = await navigator.clipboard.readText()
        return { success: true, data: text }
      }

      case "clipboard_write":
        await navigator.clipboard.writeText(action.text as string)
        return { success: true }

      case "selection_get": {
        const sel = window.getSelection()
        return { success: true, data: sel?.toString() || "" }
      }

      case "selection_set": {
        const el = resolveElement(action.index as number) as HTMLInputElement | HTMLTextAreaElement | null
        if (!el) return { success: false, error: `element [${action.index}] not found` }
        el.setSelectionRange(action.start as number, action.end as number)
        return { success: true }
      }

      case "rect": {
        const el = resolveElement(action.index as number) || document.querySelector(action.selector as string)
        if (!el) return { success: false, error: "element not found" }
        const r = el.getBoundingClientRect()
        return { success: true, data: { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom, right: r.right } }
      }

      case "exists": {
        const el = document.querySelector(action.selector as string)
        return { success: true, data: !!el }
      }

      case "count": {
        const els = document.querySelectorAll(action.selector as string)
        return { success: true, data: els.length }
      }

      case "table_data": {
        const table = (action.index !== undefined ? resolveElement(action.index as number) : document.querySelector(action.selector as string || "table")) as HTMLTableElement | null
        if (!table) return { success: false, error: "table not found" }
        const rows: string[][] = []
        table.querySelectorAll("tr").forEach(tr => {
          const cells: string[] = []
          tr.querySelectorAll("td, th").forEach(cell => cells.push((cell.textContent || "").trim()))
          rows.push(cells)
        })
        return { success: true, data: rows }
      }

      case "page_info": {
        return {
          success: true, data: {
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            doctype: document.doctype?.name,
            charset: document.characterSet,
            referrer: document.referrer,
            contentType: document.contentType,
            lastModified: document.lastModified,
            domain: document.domain,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            scroll: { x: window.scrollX, y: window.scrollY, maxX: document.documentElement.scrollWidth, maxY: document.documentElement.scrollHeight }
          }
        }
      }

      default:
        return { success: false, error: `unknown action type: ${action.type}` }
    }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

function resolveElement(index: number): Element | null {
  const selector = selectorMap.get(index)
  if (!selector) return null
  return document.querySelector(selector)
}

function scrollIntoViewIfNeeded(el: Element) {
  const rect = el.getBoundingClientRect()
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    el.scrollIntoView({ block: "center", behavior: "instant" })
  }
}

function dispatchClickSequence(el: Element) {
  const rect = el.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }

  el.dispatchEvent(new PointerEvent("pointerover", opts))
  el.dispatchEvent(new MouseEvent("mouseover", opts))
  el.dispatchEvent(new PointerEvent("pointerdown", opts))
  el.dispatchEvent(new MouseEvent("mousedown", opts))
  if ((el as HTMLElement).focus) (el as HTMLElement).focus()
  el.dispatchEvent(new PointerEvent("pointerup", opts))
  el.dispatchEvent(new MouseEvent("mouseup", opts))
  el.dispatchEvent(new MouseEvent("click", opts))
}

function dispatchHoverSequence(el: Element) {
  const rect = el.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y }

  el.dispatchEvent(new PointerEvent("pointerover", opts))
  el.dispatchEvent(new MouseEvent("mouseover", opts))
  el.dispatchEvent(new PointerEvent("pointermove", opts))
  el.dispatchEvent(new MouseEvent("mousemove", opts))
}

function dispatchKeySequence(target: Element, combo: string) {
  const parts = combo.split("+")
  const key = parts[parts.length - 1]
  const modifiers = {
    ctrlKey: parts.includes("Control"),
    shiftKey: parts.includes("Shift"),
    altKey: parts.includes("Alt"),
    metaKey: parts.includes("Meta")
  }

  const keyOpts = { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true, ...modifiers }

  target.dispatchEvent(new KeyboardEvent("keydown", keyOpts))
  target.dispatchEvent(new KeyboardEvent("keypress", keyOpts))
  target.dispatchEvent(new KeyboardEvent("keyup", keyOpts))
}

function waitForElement(selector: string, timeout: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector)
    if (existing) { resolve(existing); return }

    const timer = setTimeout(() => {
      observer.disconnect()
      resolve(null)
    }, timeout)

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector)
      if (el) {
        clearTimeout(timer)
        observer.disconnect()
        resolve(el)
      }
    })

    observer.observe(document.body, { childList: true, subtree: true })
  })
}
