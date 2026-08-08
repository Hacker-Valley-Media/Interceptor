// Realm-shared, non-enumerable keys and unbranded string constants for the
// MAIN-world install guards, the canvas-observer channel, and the Trusted-Types
// policies. See issue #178.
//
// Why symbols instead of string-named properties: inject-net.ts and
// inject-canvas.ts run in the page's MAIN world, so any string-named property
// they set on `window` / `navigator` / a prototype is enumerable by the page
// (`Object.keys`, `for...in`, `JSON.stringify`, `getOwnPropertyNames`) and lets
// a site fingerprint the extension in one line. Symbol-keyed properties are
// excluded from all of those. This is hardening, not invisibility:
// `Object.getOwnPropertySymbols(window)` still lists them and exposes their
// descriptions, so the registry strings below are deliberately opaque rather
// than vendor-branded — a generic name grep no longer matches.
//
// Why `Symbol.for` (the global registry) instead of `Symbol()`: a MAIN-world
// content script can execute more than once in the same realm (re-injection,
// same-document navigation). Each execution is a fresh module instance, so the
// "already installed" guard must resolve to the SAME symbol across executions.
// `Symbol.for(s)` returns one shared symbol per string `s`, process-wide; a bare
// `Symbol()` would mint a new one each time and silently defeat every guard
// (double-wrapped prototypes, double-counted events).
//
// Cross-context note: the canvas observer and the Trusted-Types policy are also
// read/created from background code injected via `chrome.scripting.executeScript`.
// That function is serialised with `Function.prototype.toString()` and recompiled
// in the page with NO lexical scope, so an imported binding is a free identifier
// there and throws `ReferenceError`. Those call sites import the STRING constant
// (e.g. `IK_CANVAS_OBSERVER`), pass it through executeScript `args`, and re-derive
// the symbol with `Symbol.for()` inside the function body. The strings here are
// the single source of truth for both sides.

// Registry strings — opaque, stable, no vendor name.
export const IK_NET = "z9n0";
export const IK_CANVAS = "z9c0";
export const IK_WS = "z9w0";
export const IK_BROADCAST = "z9b0";
export const IK_BEACON = "z9k0";
export const IK_TT_POLICY = "z9t0";
export const IK_SINK_TT_POLICY = "z9t1";
export const IK_CANVAS_OBSERVER = "z9o0";
export const IK_CANVAS_WRAPPED = "z9r0";
export const IK_GETCTX_WRAPPED = "z9r1";

// Symbols for the files that can `import` (inject-net.ts, inject-canvas.ts).
export const K_NET = Symbol.for(IK_NET);
export const K_CANVAS = Symbol.for(IK_CANVAS);
export const K_WS = Symbol.for(IK_WS);
export const K_BROADCAST = Symbol.for(IK_BROADCAST);
export const K_BEACON = Symbol.for(IK_BEACON);
export const K_TT_POLICY = Symbol.for(IK_TT_POLICY);
export const K_CANVAS_OBSERVER = Symbol.for(IK_CANVAS_OBSERVER);
export const K_CANVAS_WRAPPED = Symbol.for(IK_CANVAS_WRAPPED);
export const K_GETCTX_WRAPPED = Symbol.for(IK_GETCTX_WRAPPED);

// Unbranded Trusted-Types policy names. Policy names are observable via CSP
// violation reports, so keep them non-attributable too.
export const TT_POLICY_NAME = "tt-e";
export const TT_NET_POLICY_NAME = "tt-n";
export const SINK_TT_POLICY_NAME = "tt-s";

// Prefix for the ephemeral staged-bytes global (binary sink). Stays a string
// because it is used as a property-name string passed across executeScript calls.
export const STAGED_BYTES_PREFIX = "z9s_";
