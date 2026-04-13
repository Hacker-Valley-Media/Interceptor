type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleNotificationActions(
  action: { type: string; [key: string]: unknown },
  _tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "notification_create": {
      const notifId = await chrome.notifications.create(action.notifId as string || "", {
        type: "basic",
        title: (action.title as string) || "Interceptor",
        message: (action.message as string) || "",
        iconUrl: (action.iconUrl as string) ||
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      })
      return { success: true, data: { notifId } }
    }

    case "notification_clear":
      await chrome.notifications.clear(action.notifId as string)
      return { success: true }
  }
  return { success: false, error: `unknown notification action: ${action.type}` }
}
