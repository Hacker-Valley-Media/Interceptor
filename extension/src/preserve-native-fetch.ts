/** Hosts whose page bootstrap requires an unmodified window.fetch. */
export const NATIVE_FETCH_HOSTS = new Set(["upwork.com", "www.upwork.com"])

export function shouldPreserveNativeFetch(hostname: string): boolean {
  return NATIVE_FETCH_HOSTS.has(hostname)
}
