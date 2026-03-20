export type Action =
  | { type: "click"; index?: number; ref?: string }
  | { type: "input_text"; index?: number; ref?: string; text: string; clear?: boolean }
  | { type: "navigate"; url: string }
  | { type: "scroll"; direction: "up" | "down" | "top" | "bottom"; amount?: number }
  | { type: "select_option"; index?: number; ref?: string; value: string }
  | { type: "send_keys"; keys: string }
  | { type: "wait"; ms: number }
  | { type: "go_back" }
  | { type: "go_forward" }
  | { type: "extract_text"; index?: number; ref?: string }
  | { type: "extract_html"; index?: number; ref?: string }
  | { type: "evaluate"; code: string; world?: "MAIN" | "ISOLATED" }
  | { type: "screenshot" }
  | { type: "tab_create"; url?: string }
  | { type: "tab_close"; tabId?: number }
  | { type: "tab_switch"; tabId: number }
  | { type: "tab_list" }
  | { type: "cookies_get"; domain: string }
  | { type: "cookies_set"; cookie: Record<string, unknown> }
  | { type: "cookies_delete"; url: string; name: string }
  | { type: "network_intercept"; patterns: string[]; enabled: boolean }
  | { type: "network_log"; since?: number }
  | { type: "storage_get"; keys?: string[] }
  | { type: "storage_set"; data: Record<string, unknown> }
  | { type: "headers_modify"; rules: HeaderRule[] }
  | { type: "focus"; index?: number; ref?: string }
  | { type: "hover"; index?: number; ref?: string }
  | { type: "drag"; fromIndex: number; toIndex: number }
  | { type: "file_upload"; index?: number; ref?: string; filePath: string }
  | { type: "get_state"; full?: boolean; tabId?: number }
  | { type: "get_a11y_tree"; depth?: number; filter?: "interactive" | "all"; maxChars?: number }
  | { type: "diff" }
  | { type: "find_element"; query: string; role?: string; limit?: number }
  | { type: "dblclick"; index?: number; ref?: string }
  | { type: "rightclick"; index?: number; ref?: string }
  | { type: "check"; index?: number; ref?: string; checked?: boolean }
  | { type: "scroll_to"; index?: number; ref?: string }
  | { type: "attr_get"; index?: number; ref?: string; selector?: string; name: string }
  | { type: "attr_set"; index?: number; ref?: string; selector?: string; name: string; value: string }
  | { type: "style_get"; index?: number; ref?: string; selector?: string; property?: string }
  | { type: "rect"; index?: number; ref?: string; selector?: string }
  | { type: "selection_set"; index?: number; ref?: string; start: number; end: number }
  | { type: "status" }

export interface HeaderRule {
  operation: "set" | "remove"
  header: string
  value?: string
}

export interface ActionResult {
  success: boolean
  error?: string
  data?: unknown
}

export interface PageState {
  url: string
  title: string
  elementTree: string
  staticText: string
  scrollPosition: { y: number; height: number; viewportHeight: number }
  tabId: number
  timestamp: number
}

export interface DaemonMessage {
  id: string
  action: Action
  tabId?: number
}

export interface DaemonResponse {
  id: string
  result: ActionResult
}
