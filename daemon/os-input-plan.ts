/** Claim an extension's delivery plan once, including automatic click escalation. */
export function claimOsInputPlan(pending: { actionType: string; osDelivering?: boolean }, data: Record<string, unknown>): string | undefined {
  const autoClick = ["click", "click_selector", "scene_click"].includes(pending.actionType)
    && (data.escalated as { to?: string } | undefined)?.to === "os_click"
  if (pending.osDelivering || data.method !== "os_event" || (!autoClick && !pending.actionType.startsWith("os_"))) return
  pending.osDelivering = true
  return autoClick ? "os_click" : pending.actionType
}
