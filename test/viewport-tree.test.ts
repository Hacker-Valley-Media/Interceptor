// --viewport keeps only on-screen refs and counts the rest.
import { beforeEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

try { GlobalRegistrator.register() } catch { /* shared test DOM already registered */ }

const { buildA11yTree } = await import("../extension/src/content/a11y-tree")

// happy-dom has no layout: give each button a box and a parent so the real isVisible() passes.
function place(el: Element, top: number, left = 10) {
  Object.defineProperty(el, "offsetParent", { configurable: true, get: () => document.body })
  ;(el as HTMLElement).getBoundingClientRect = () => ({ top, bottom: top + 20, left, right: left + 80, width: 80, height: 20, x: left, y: top, toJSON() {} }) as DOMRect
}

beforeEach(() => {
  document.body.innerHTML = `<button id="up">Up</button><button id="here">Here</button><button id="down">Down</button><button id="side">Side</button>`
  place(document.getElementById("up")!, -200)
  place(document.getElementById("here")!, 100)
  place(document.getElementById("down")!, innerHeight + 500)
  place(document.getElementById("side")!, 100, innerWidth + 50)
})

test("viewport mode lists only the on-screen button and counts the others", () => {
  const out = buildA11yTree(document.body, 0, 15, "interactive", false, "verbose", { viewport: true })
  expect(out).toContain('button "Here"')
  expect(out).not.toContain('"Up"')
  expect(out).not.toContain('"Down"')
  expect(out).not.toContain('"Side"')
  expect(out.split("\n").at(-1)).toBe("(viewport only: 1 above, 1 below, 1 beside the visible area; scroll, or drop --viewport for the whole page)")
})

test("without --viewport every button is listed and no count line is added", () => {
  const out = buildA11yTree(document.body, 0, 15, "interactive")
  for (const name of ["Up", "Here", "Down", "Side"]) expect(out).toContain(`"${name}"`)
  expect(out).not.toContain("viewport only")
})

test("a button scrolled out of its overflow container is not on screen, even inside the window", () => {
  document.body.innerHTML = `<div id="box" style="overflow-x: hidden; overflow-y: auto"><button id="seen">Seen</button><button id="clipped">Clipped</button></div>`
  const box = document.getElementById("box")!
  Object.defineProperty(box, "offsetParent", { configurable: true, get: () => document.body })
  box.getBoundingClientRect = () => ({ top: 50, bottom: 150, left: 0, right: 300, width: 300, height: 100, x: 0, y: 50, toJSON() {} }) as DOMRect
  place(document.getElementById("seen")!, 80)
  place(document.getElementById("clipped")!, 300)
  const out = buildA11yTree(document.body, 0, 15, "interactive", false, "verbose", { viewport: true })
  expect(out).toContain('"Seen"')
  expect(out).not.toContain('"Clipped"')
  expect(out.split("\n").at(-1)).toContain("1 below")
})
