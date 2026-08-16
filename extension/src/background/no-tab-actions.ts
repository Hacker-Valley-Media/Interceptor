export const NO_TAB_ACTIONS = new Set([
  "status", "reload_extension", "tab_create", "tab_list",
  "window_create", "window_close", "window_focus", "window_resize", "window_list", "window_get_all",
  "history_search", "history_delete_all", "bookmark_tree", "bookmark_search",
  "bookmark_create", "downloads_search", "browsing_data_remove",
  "session_list", "session_restore", "notification_create", "notification_clear",
  "search_capability", "monitor_status", "monitor_start", "monitor_pause", "monitor_resume",
  "monitor_stop", "brand_set_tab_group", "group_list", "group_close",
  "keepawake", "idle_state"
])

export function needsTab(type: string): boolean {
  return !NO_TAB_ACTIONS.has(type)
}
