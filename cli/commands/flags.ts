/**
 * cli/commands/flags.ts — shared flag-parsing helpers.
 *
 * `--trusted` is the canonical "post events from the HID source so the page
 * treats them as isTrusted: true" flag. `--os` is its retained back-compat
 * alias from v0.13.x and earlier — kept working but no longer shown in help
 * or skill docs. Emits a single stderr deprecation warning per process when
 * `--os` is used so existing pipelines keep working but new users converge
 * on `--trusted`. Removing the alias is a future release decision.
 */

export const TRUSTED_FLAG_VALUES: ReadonlyArray<string> = ["--trusted", "--os"]

export function trustedSelectorError(command: string, flags: ReadonlyArray<string>): string | undefined {
  if (command === "click" && flags.includes("--selector") && TRUSTED_FLAG_VALUES.some(flag => flags.includes(flag))) {
    return 'error: --selector does not support --trusted or --os. Run interceptor query "<css>" to get an e-ref, then interceptor click <ref> --trusted.'
  }
}

let warnedDeprecatedOs = false

export function hasTrustedFlag(filtered: ReadonlyArray<string>): boolean {
  const usesTrusted = filtered.includes("--trusted")
  const usesOs = filtered.includes("--os")
  if (usesOs && !warnedDeprecatedOs) {
    warnedDeprecatedOs = true
    console.error("warning: --os is deprecated and will be removed in a future release; use --trusted instead")
  }
  return usesTrusted || usesOs
}
