import "./content/net-buffer"
import "./content/dom-observer"
import { extractLinkedInEventDom } from "./linkedin/event-page-dom-extraction"
import { clickManageAttendeesShowMore, extractManageAttendeesModal, openManageAttendeesModal } from "./linkedin/event-attendees-modal-dom"
import { getDomDirty, setDomDirty } from "./content/dom-observer"
import { getStaleWarning, clearStaleWarning } from "./content/ref-registry"
import { cacheSnapshot, computeSnapshotDiff } from "./content/snapshot-diff"
import { pruneStaleRefs } from "./content/ref-registry"
import { buildA11yTree } from "./content/a11y-tree"
import { getPageState } from "./content/state"
import { dispatchClickSequence, dispatchKeySequence, waitForDomStable } from "./content/input-simulation"
import { handleClick, handleDblclick, handleRightclick, handleClickAt, handleWhatAt } from "./content/actions/click"
import { handleInputText, handleSelectOption, handleCheck } from "./content/actions/type"
import { handleScroll, handleScrollAbsolute, handleScrollTo, handleGetPageDimensions } from "./content/actions/scroll"
import { handleWait, handleWaitFor, handleWaitStable } from "./content/actions/wait"
import { handleDrag } from "./content/actions/drag"
import { handleHover } from "./content/actions/hover"
import { handleFocus, handleBlur, handleGetFocus } from "./content/actions/focus"
import { handleExtractText, handleExtractHtml } from "./content/data/extract"
import { handleQuery, handleQueryOne, handleExists, handleCount, handleTableData, handleAttrGet, handleAttrSet, handleStyleGet } from "./content/data/query"
import { handleForms, handleLinks, handleImages, handleMeta, handlePageInfo } from "./content/data/forms"
import { handleStorageRead, handleStorageWrite, handleStorageDelete } from "./content/data/storage"
import { handleClipboardRead, handleClipboardWrite, handleSelectionGet, handleSelectionSet } from "./content/data/clipboard"
import { handleRect, handleRegions } from "./content/inspection/rect"
import { handleModals, handlePanels } from "./content/inspection/modals"
import { handleFindElement, handleSemanticResolve, handleFindAndClick, handleFindAndType, handleFindAndCheck } from "./content/find"

type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown; changes?: unknown }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "execute_action") {
    handleAction(msg.action)
      .then(sendResponse)
      .catch((err: Error) => sendResponse({ success: false, error: err.message }))
    return true
  }
  if (msg.type === "get_state") {
    try {
      sendResponse(getPageState(msg.full))
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message })
    }
    return true
  }
})

async function handleAction(action: Action): Promise<ActionResult> {
  const warnDirty = getDomDirty()
  clearStaleWarning()
  const wantChanges = !!(action.changes)
  if (wantChanges) cacheSnapshot()
  const result = await executeAction(action)
  const sw = getStaleWarning()
  if (sw && result.success) result.warning = sw
  else if (warnDirty && result.success) result.warning = "DOM has changed since last state read"
  if (wantChanges && result.success) {
    const diffResult = computeSnapshotDiff()
    if (diffResult.success) (result as Record<string, unknown>).changes = diffResult.data
  }
  return result
}

async function executeAction(action: Action): Promise<ActionResult> {
  try {
    switch (action.type) {
      case "get_state":           return getPageState(action.full as boolean)
      case "click":               return handleClick(action)
      case "dblclick":            return handleDblclick(action)
      case "rightclick":          return handleRightclick(action)
      case "drag":                return handleDrag(action)
      case "input_text":          return handleInputText(action)
      case "select_option":       return handleSelectOption(action)
      case "check":               return handleCheck(action)
      case "scroll":              return handleScroll(action)
      case "scroll_absolute":     return handleScrollAbsolute(action)
      case "get_page_dimensions": return handleGetPageDimensions(action)
      case "scroll_to":           return handleScrollTo(action)
      case "send_keys": {
        const keys = action.keys as string
        const target = document.activeElement || document.body
        dispatchKeySequence(target, keys)
        return { success: true }
      }
      case "wait":                return handleWait(action)
      case "wait_for":            return handleWaitFor(action)
      case "extract_text":        return handleExtractText(action)
      case "extract_html":        return handleExtractHtml(action)
      case "focus":               return handleFocus(action)
      case "blur":                return handleBlur(action)
      case "hover":               return handleHover(action)
      case "query":               return handleQuery(action)
      case "query_one":           return handleQueryOne(action)
      case "attr_get":            return handleAttrGet(action)
      case "attr_set":            return handleAttrSet(action)
      case "style_get":           return handleStyleGet(action)
      case "forms":               return handleForms(action)
      case "links":               return handleLinks(action)
      case "images":              return handleImages(action)
      case "meta":                return handleMeta(action)
      case "storage_read":        return handleStorageRead(action)
      case "storage_write":       return handleStorageWrite(action)
      case "storage_delete":      return handleStorageDelete(action)
      case "clipboard_read":      return handleClipboardRead(action)
      case "clipboard_write":     return handleClipboardWrite(action)
      case "selection_get":       return handleSelectionGet(action)
      case "selection_set":       return handleSelectionSet(action)
      case "rect":                return handleRect(action)
      case "exists":              return handleExists(action)
      case "count":               return handleCount(action)
      case "table_data":          return handleTableData(action)
      case "page_info":           return handlePageInfo(action)
      case "get_a11y_tree": {
        const maxDepth = (action.depth as number) || 15
        const filter = (action.filter as string) || "interactive"
        const maxChars = (action.maxChars as number) || 50000
        pruneStaleRefs()
        const treeOutput = buildA11yTree(document.body, 0, maxDepth, filter)
        const truncated = treeOutput.length > maxChars
          ? treeOutput.slice(0, maxChars) + "\n... (truncated)"
          : treeOutput
        cacheSnapshot()
        return { success: true, data: truncated }
      }
      case "diff": {
        if (!getDomDirty() && (await import("./content/snapshot-diff")).lastSnapshot.length > 0) {
          return { success: true, data: { changes: 0, added: [], removed: [], changed: [] } }
        }
        const diffResult = computeSnapshotDiff()
        if (diffResult.success && typeof diffResult.data === "string") {
          const lines = diffResult.data === "no changes" ? [] : (diffResult.data as string).split("\n")
          const added = lines.filter(l => l.startsWith("+ "))
          const removed = lines.filter(l => l.startsWith("- "))
          const changed = lines.filter(l => l.startsWith("~ "))
          return { success: true, data: { changes: lines.length, added, removed, changed, total: lines.length } }
        }
        return diffResult
      }
      case "find_element":        return handleFindElement(action)
      case "modals":              return handleModals(action)
      case "panels":              return handlePanels(action)
      case "click_at":            return handleClickAt(action)
      case "what_at":             return handleWhatAt(action)
      case "regions":             return handleRegions(action)
      case "get_focus":           return handleGetFocus(action)
      case "semantic_resolve":    return handleSemanticResolve(action)
      case "find_and_click":      return handleFindAndClick(action)
      case "find_and_type":       return handleFindAndType(action)
      case "find_and_check":      return handleFindAndCheck(action)
      case "linkedin_event_dom":
        return { success: true, data: await extractLinkedInEventDom(waitForDomStable, dispatchClickSequence) }
      case "linkedin_attendees_open":
        return { success: true, data: { opened: await openManageAttendeesModal(waitForDomStable, dispatchClickSequence) } }
      case "linkedin_attendees_snapshot":
        return { success: true, data: extractManageAttendeesModal() }
      case "linkedin_attendees_show_more":
        return { success: true, data: { clicked: clickManageAttendeesShowMore(dispatchClickSequence) } }
      case "wait_stable":         return handleWaitStable(action)
      case "batch": {
        const actions = action.actions as Array<Action>
        if (!actions || !Array.isArray(actions)) return { success: false, error: "batch requires actions array" }
        if (actions.length > 100) return { success: false, error: "batch limited to 100 sub-actions" }
        const stopOnError = !!(action.stopOnError)
        const batchTimeout = (action.timeout as number) || 30000
        const batchStart = Date.now()
        const results: Array<{ action: string; success: boolean; data?: unknown; error?: string; warning?: string }> = []
        for (const subAction of actions) {
          if (Date.now() - batchStart > batchTimeout) {
            results.push({ action: subAction.type, success: false, error: "batch timeout exceeded" })
            break
          }
          try {
            const subResult = await executeAction(subAction)
            results.push({ action: subAction.type, success: subResult.success, data: subResult.data, error: subResult.error, warning: subResult.warning })
            if (!subResult.success && stopOnError) break
          } catch (err) {
            results.push({ action: subAction.type, success: false, error: (err as Error).message })
            if (stopOnError) break
          }
        }
        return { success: true, data: { results, elapsed: Date.now() - batchStart } }
      }
      case "evaluate":
        return { success: false, error: "evaluate is handled by background script — this should not be reached" }
      default:
        return { success: false, error: `unknown action type: ${action.type}` }
    }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}
