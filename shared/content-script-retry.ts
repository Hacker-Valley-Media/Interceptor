export function shouldRetryContentScript(error?: string): boolean {
  if (!error) return false
  return (
    error.includes("Receiving end does not exist") ||
    error.includes("Could not establish connection") ||
    error.includes("disconnected port") ||
    error.includes("message channel is closed") ||
    error.includes("no response from content script")
  )
}
