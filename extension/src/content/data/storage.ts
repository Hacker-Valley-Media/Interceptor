type Action = { type: string; [key: string]: unknown }
type ActionResult = { success: boolean; error?: string; warning?: string; data?: unknown }

export async function handleStorageRead(action: Action): Promise<ActionResult> {
  const storageType = (action.storageType as string) === "session" ? sessionStorage : localStorage
  if (action.key) {
    return { success: true, data: storageType.getItem(action.key as string) }
  }
  const all: Record<string, string> = {}
  for (let i = 0; i < storageType.length; i++) {
    const key = storageType.key(i)!
    all[key] = storageType.getItem(key)!.slice(0, 200)
  }
  return { success: true, data: all }
}

export async function handleStorageWrite(action: Action): Promise<ActionResult> {
  const storageType = (action.storageType as string) === "session" ? sessionStorage : localStorage
  storageType.setItem(action.key as string, action.value as string)
  return { success: true }
}

export async function handleStorageDelete(action: Action): Promise<ActionResult> {
  const storageType = (action.storageType as string) === "session" ? sessionStorage : localStorage
  storageType.removeItem(action.key as string)
  return { success: true }
}
