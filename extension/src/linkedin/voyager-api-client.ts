async function getLinkedInCsrfToken(): Promise<string | null> {
  try {
    const cookie = await chrome.cookies.get({ url: "https://www.linkedin.com", name: "JSESSIONID" })
    if (!cookie?.value) return null
    return cookie.value.replace(/^"|"$/g, "")
  } catch {
    return null
  }
}

export async function fetchLinkedInJson(url: string): Promise<unknown | null> {
  const csrfToken = await getLinkedInCsrfToken()
  const headers: Record<string, string> = {
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "x-restli-protocol-version": "2.0.0"
  }
  if (csrfToken) headers["csrf-token"] = csrfToken
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}
