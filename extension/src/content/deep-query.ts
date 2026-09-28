import { getShadowRoot } from "./element-discovery"

/**
 * Shadow-piercing CSS selector resolution.
 *
 * The gap this closes: `document.querySelectorAll` does not descend into shadow
 * roots, so every CSS-selector verb (`query`, `query one`, `exists`, `count`,
 * `click --selector`) was structurally blind to any element inside a web
 * component. That is not an edge case — a chat widget shipped as
 * `<assembled-chat-launcher>` puts its only button inside an open shadow root,
 * and `query 'button[aria-label="Chat Launcher"]'` answered `0 matches` while
 * the button was plainly on screen. The a11y-tree verbs (`read`, `find`) already
 * pierce, via `walkWithShadow`; the selector verbs did not, so which half of the
 * CLI saw a web component depended on which verb you happened to reach for.
 *
 * Ordering is the non-regression contract: roots are visited breadth-first from
 * the light DOM outward, so every match that `document.querySelectorAll` would
 * have returned still comes back first, in its original document order. Shadow
 * matches are appended after. A caller that resolves `nth: 0` on a page with no
 * shadow hosts gets byte-identical behaviour to before; a caller on a page with
 * shadow hosts gets strictly more matches, never a different first one.
 *
 * Closed roots are included: `getShadowRoot` prefers `chrome.dom.
 * openOrClosedShadowRoot`, which an extension content script is allowed to use
 * and which a page cannot detect. Piercing closed roots matters precisely
 * because a vendor who closed the root is the vendor whose widget you cannot
 * otherwise reach.
 */

/**
 * Upper bound on roots visited in one resolution.
 *
 * Every root costs one `querySelectorAll("*")` to find its hosts, so an
 * unbounded walk on a page that renders thousands of custom elements (a virtual
 * list of web components is the realistic shape) turns a `count` into a
 * multi-second stall. Stopping at a bound returns a partial answer late rather
 * than no answer at all; 2000 roots is far past any real widget nesting and
 * still bounded work.
 */
const MAX_ROOTS = 2000

/**
 * Every root to search: the starting root, then each shadow root beneath it,
 * transitively. Iterative rather than recursive — shadow nesting is attacker-
 * and framework-controlled, and a deep tree should degrade at MAX_ROOTS rather
 * than overflow the stack.
 */
export function collectRoots(root: ParentNode = document): ParentNode[] {
  const roots: ParentNode[] = [root]
  for (let i = 0; i < roots.length && roots.length < MAX_ROOTS; i++) {
    const current = roots[i]!
    let hosts: Element[]
    try { hosts = Array.from(current.querySelectorAll("*")) }
    catch { continue }
    for (const host of hosts) {
      const shadow = getShadowRoot(host)
      if (shadow) {
        roots.push(shadow)
        if (roots.length >= MAX_ROOTS) break
      }
    }
  }
  return roots
}

/**
 * All elements matching `selector`, light DOM first, then shadow roots.
 *
 * An invalid selector throws from the very first root, before any traversal, so
 * callers keep the same `try`/`catch` shape they had around
 * `document.querySelectorAll`.
 */
export function queryAllDeep(selector: string, root: ParentNode = document): Element[] {
  // Validate against the starting root first: this both preserves the existing
  // throw-on-invalid-selector contract and avoids paying for a full root walk
  // to discover a typo.
  const direct = Array.from(root.querySelectorAll(selector))
  const roots = collectRoots(root)
  if (roots.length === 1) return direct

  const seen = new Set<Element>(direct)
  const out: Element[] = [...direct]
  for (let i = 1; i < roots.length; i++) {
    let matches: Element[]
    try { matches = Array.from(roots[i]!.querySelectorAll(selector)) }
    catch { continue }
    for (const el of matches) {
      if (seen.has(el)) continue
      seen.add(el)
      out.push(el)
    }
  }
  return out
}

/**
 * First element matching `selector`, light DOM first.
 *
 * Short-circuits on the light DOM so the overwhelmingly common case (the
 * element is not in a shadow root) costs exactly one `querySelector` and no
 * traversal at all.
 */
export function queryOneDeep(selector: string, root: ParentNode = document): Element | null {
  const direct = root.querySelector(selector)
  if (direct) return direct
  const roots = collectRoots(root)
  for (let i = 1; i < roots.length; i++) {
    let match: Element | null
    try { match = roots[i]!.querySelector(selector) }
    catch { continue }
    if (match) return match
  }
  return null
}
