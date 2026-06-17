/**
 * Build-time defaults for the Runtime Agent surface.
 *
 * scripts/build.sh stamps this file for compiled release artifacts and restores
 * it afterward. Source/dev defaults are the public profile: platform target
 * support and bundled agent dylibs are off unless an explicit research build
 * enables them.
 */
export const NATIVE_PLATFORM_TARGETS_ENABLED = false
export const NATIVE_AGENT_DYLIBS_BUNDLED = false
