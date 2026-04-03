import { isVisibleElement, visibleText } from "./event-page-visible-text"

export type LinkedInAttendeeModalRow = {
  profileUrl: string | null
  profileSlug: string | null
  fullName: string | null
  firstName: string | null
  lastName: string | null
  connectionDegree: string | null
  headline: string | null
  rowText: string
}

export type LinkedInAttendeeModalSnapshot = {
  isOpen: boolean
  totalCount: number | null
  rows: LinkedInAttendeeModalRow[]
  showMoreVisible: boolean
}

function splitName(fullName: string | null): { firstName: string | null; lastName: string | null } {
  if (!fullName) return { firstName: null, lastName: null }
  const cleaned = fullName.replace(/\s+/g, " ").trim()
  if (!cleaned) return { firstName: null, lastName: null }
  const parts = cleaned.split(" ")
  if (parts.length === 1) return { firstName: parts[0], lastName: null }
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") }
}

function parseConnectionDegree(text: string): string | null {
  const match = text.match(/(\d(?:st|nd|rd|th) degree connection|·\s*\d(?:st|nd|rd|th))/i)
  return match ? match[1].replace(/^·\s*/, "").trim() : null
}

function parseHeadline(lines: string[], fullName: string | null): string | null {
  const filtered = lines
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter(line => line !== fullName)
    .filter(line => !/degree connection/i.test(line))
    .filter(line => !/^Message$/i.test(line))
    .filter(line => !/^More options$/i.test(line))
  return filtered[0] || null
}

function parseRow(anchor: HTMLAnchorElement): LinkedInAttendeeModalRow {
  const row = anchor.closest('[role="listitem"], li, .artdeco-list__item, .scaffold-finite-scroll__content > div, div') as HTMLElement | null
  const rowText = visibleText(row || anchor)
  const lines = rowText.split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean)
  const fullName = visibleText(anchor).split("\n")[0]?.replace(/\s+/g, " ").trim() || null
  const { firstName, lastName } = splitName(fullName)
  const profileUrl = anchor.href || null
  const slugMatch = profileUrl?.match(/linkedin\.com\/in\/([^/?#]+)/i) || null
  return {
    profileUrl,
    profileSlug: slugMatch?.[1] || null,
    fullName,
    firstName,
    lastName,
    connectionDegree: parseConnectionDegree(rowText),
    headline: parseHeadline(lines.slice(1), fullName),
    rowText
  }
}

function findManageButton(): HTMLElement | null {
  return Array.from(document.querySelectorAll('button')).find(el => isVisibleElement(el) && /^Manage$/i.test(visibleText(el))) as HTMLElement | null
}

function findManageAttendeesAction(): HTMLElement | null {
  return Array.from(document.querySelectorAll('button, div[role="button"], li, span, a')).find(el => {
    if (!isVisibleElement(el)) return false
    const text = visibleText(el)
    return /Manage attendees/i.test(text)
  }) as HTMLElement | null
}

function findManageAttendeesDialog(): HTMLElement | null {
  return Array.from(document.querySelectorAll('[role="dialog"], dialog, .artdeco-modal')).find(el => isVisibleElement(el) && /Manage attendees/i.test(visibleText(el))) as HTMLElement | null
}

export async function openManageAttendeesModal(waitForDomStable: (debounceMs?: number, timeoutMs?: number) => Promise<{ stable: boolean; elapsed: number; mutations: number }>, dispatchClickSequence: (el: Element, atX?: number, atY?: number) => void): Promise<boolean> {
  const existing = findManageAttendeesDialog()
  if (existing) return true
  for (let attempt = 0; attempt < 3; attempt++) {
    const manageButton = findManageButton()
    if (!manageButton) return false
    dispatchClickSequence(manageButton)
    await waitForDomStable(200, 2000)
    let action: HTMLElement | null = null
    for (let poll = 0; poll < 10; poll++) {
      action = findManageAttendeesAction()
      if (action) break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!action) continue
    dispatchClickSequence(action)
    await waitForDomStable(400, 4000)
    if (findManageAttendeesDialog()) return true
  }
  return !!findManageAttendeesDialog()
}

export function extractManageAttendeesModal(): LinkedInAttendeeModalSnapshot {
  const dialog = findManageAttendeesDialog()
  if (!dialog) return { isOpen: false, totalCount: null, rows: [], showMoreVisible: false }
  const dialogText = visibleText(dialog)
  const totalMatch = dialogText.match(/(\d[\d,]*)\s+people/i)
  const anchors = Array.from(dialog.querySelectorAll('a[href*="/in/"]')).filter(el => isVisibleElement(el)) as HTMLAnchorElement[]
  const unique = new Map<string, LinkedInAttendeeModalRow>()
  for (const anchor of anchors) {
    const parsed = parseRow(anchor)
    const key = parsed.profileUrl || parsed.fullName || Math.random().toString(36)
    if (!unique.has(key)) unique.set(key, parsed)
  }
  const showMoreVisible = Array.from(dialog.querySelectorAll('button')).some(el => isVisibleElement(el) && /^Show more results$/i.test(visibleText(el)))
  return {
    isOpen: true,
    totalCount: totalMatch ? parseInt(totalMatch[1].replace(/,/g, ""), 10) : null,
    rows: Array.from(unique.values()),
    showMoreVisible
  }
}

export function clickManageAttendeesShowMore(dispatchClickSequence: (el: Element, atX?: number, atY?: number) => void): boolean {
  const dialog = findManageAttendeesDialog()
  if (!dialog) return false
  const button = Array.from(dialog.querySelectorAll('button')).find(el => isVisibleElement(el) && /^Show more results$/i.test(visibleText(el))) as HTMLElement | undefined
  if (!button) return false
  dispatchClickSequence(button)
  return true
}
