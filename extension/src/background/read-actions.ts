// Tab-targeted action types that only read the page.
// When an agent's soft session group is empty, these may still fall back to
// the tab the user is viewing; every other type refuses, so a type missing
// from this list is treated as input. Keyed by action type, not CLI verb, so
// the decision works with every CLI version.
export const READ_ACTIONS = new Set([
  // content script
  "get_a11y_tree", "extract_text", "extract_html", "extract_markdown", "page_info",
  "query", "query_one", "count", "exists", "table_data", "find_element", "forms",
  "links", "images", "meta", "modals", "panels", "regions", "rect", "what_at",
  "get_focus", "get_page_dimensions", "get_state", "attr_get", "style_get",
  "selection_get", "semantic_resolve", "diff", "wait", "wait_for", "wait_stable",
  "dom_screenshot", "storage_read", "clipboard_read",
  "scene_list", "scene_selected", "scene_text", "scene_profile", "scene_hit",
  "scene_slide_list", "scene_slide_current", "scene_notes", "scene_render", "scene_cursor",
  // background
  "screenshot", "screenshot_background", "page_capture", "ocr",
  "canvas_list", "canvas_read", "canvas_status", "canvas_log", "canvas_objects",
  "canvas_model", "canvas_routes", "canvas_ocr", "canvas_diff",
  "cookies_get", "net_log", "net_headers", "sse_log", "sse_streams", "sse_chunk",
  "page_comm_log", "page_comm_status", "network_log",
  "frames_list", "frames_read_tree", "frames_find", "tab_zoom_get", "capabilities", "cdp_tree",
])

export function isReadAction(type: string): boolean {
  return READ_ACTIONS.has(type)
}
