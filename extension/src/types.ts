export type Action =
  | { type: "click"; index: number }
  | { type: "input_text"; index: number; text: string; clear?: boolean }
  | { type: "navigate"; url: string }
  | { type: "scroll"; direction: "up" | "down" | "top" | "bottom"; amount?: number }
  | { type: "select_option"; index: number; value: string }
  | { type: "send_keys"; keys: string }
  | { type: "wait"; ms: number }
  | { type: "go_back" }
  | { type: "go_forward" }
  | { type: "extract_text"; index?: number }
  | { type: "extract_html"; index?: number }
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
  | { type: "focus"; index: number }
  | { type: "hover"; index: number }
  | { type: "drag"; fromIndex: number; toIndex: number }
  | { type: "file_upload"; index: number; filePath: string }
  | { type: "get_state"; full?: boolean; tabId?: number }
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
