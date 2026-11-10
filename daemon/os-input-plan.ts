/** Claim explicit native input once; a synthetic click never admits OS delivery. */
export function claimOsInputPlan(pending: { actionType: string; osDelivering?: boolean; osRequested?: boolean }, data: Record<string, unknown>): string | undefined {
  const explicitScene = pending.actionType === "scene_click" && pending.osRequested === true
  if (pending.osDelivering || data.method !== "os_event" || (!explicitScene && !pending.actionType.startsWith("os_"))) return
  pending.osDelivering = true
  return explicitScene ? "os_click" : pending.actionType
}
