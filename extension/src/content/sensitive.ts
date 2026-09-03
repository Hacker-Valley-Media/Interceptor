/**
 * extension/src/content/sensitive.ts — fields that received a vault secret.
 *
 * issue #244: when the daemon delivers a `--secret` value through `input_text`,
 * the action carries `sensitive: true`. The typed element is remembered here
 * so the content monitor masks its value even when the field is not
 * `type=password` (passcode sheets are often `type=text` or numeric).
 */

const sensitiveElements = new WeakSet<Element>()

export function markSensitive(el: Element): void {
  sensitiveElements.add(el)
}

export function isSensitive(el: Element): boolean {
  return sensitiveElements.has(el)
}

export const SECURE_MASK = "***SECURE***"
