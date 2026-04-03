export function isVisibleElement(el: Element | null | undefined): boolean {
  if (!el) return false
  const style = getComputedStyle(el)
  if (style.visibility === "hidden" || style.display === "none") return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 || rect.height > 0
}

export function visibleText(el: Element | null | undefined): string {
  if (!el || !isVisibleElement(el)) return ""
  return ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim()
}

export function isLinkedInNoiseText(text: string): boolean {
  return /Close your conversation|Reply to conversation|Page inboxes|Compose message|Messaging overlay|Open GIF Keyboard|Open Emoji Keyboard|Search\s*$|Skip to main content|About Accessibility Help Center Privacy & Terms/i.test(text)
}
