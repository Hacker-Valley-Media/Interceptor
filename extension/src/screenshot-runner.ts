// screenshot-runner.ts
//
// Bundle entry that vendors html-to-image into the extension and exposes it on
// globalThis for content.js to call. Loaded on demand via
// chrome.scripting.executeScript({ files: ["screenshot-runner.js"] }) — NOT as
// a content_scripts entry, so pages that never get screenshotted pay no cost.
//
// Runs in the ISOLATED world (per scripting.executeScript world: "ISOLATED"),
// so it shares globalThis with the rest of the extension's content scripts on
// the same frame. content.ts's `case "dom_screenshot":` reads
// `globalThis.__interceptor_h2i` to call the library.

import * as h2i from "html-to-image"

;(globalThis as unknown as { __interceptor_h2i?: typeof h2i; __interceptor_h2i_loaded?: boolean }).__interceptor_h2i = h2i
;(globalThis as unknown as { __interceptor_h2i?: typeof h2i; __interceptor_h2i_loaded?: boolean }).__interceptor_h2i_loaded = true
