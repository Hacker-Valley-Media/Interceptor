// AgentJS — in-process JavaScriptCore bridge for the Runtime Agent surface.
//
// Gives the native agent the SAME primitive the browser surface has: run inline
// JavaScript one-liners that drive the host app. The browser's `eval --main`
// executes arbitrary JS against the DOM; this executes arbitrary JS against the
// live Objective-C / Cocoa runtime via a generic msgSend bridge built on
// NSInvocation (unavailable from Swift — hence this ObjC target).
//
// One persistent JSContext per process, so JS variables/state survive across calls
// just like a page's JS state persists across browser evals.

#ifndef AGENTJS_H
#define AGENTJS_H

#ifdef __cplusplus
extern "C" {
#endif

// Evaluate `codeUTF8` in the persistent context. Returns a malloc'd UTF-8 JSON
// string {"result": <stringified return>, "logs": [...]} — caller must free().
// Never returns NULL for valid input (returns an error JSON instead).
char *itc_eval_js(const char *codeUTF8);

// ── Runtime Hook Fabric ─────────────────────────────────────────────
// All return a malloc'd UTF-8 JSON string; caller must free().
char *itc_hook_install(const char *className, const char *selName);                 // domain=Debugger
char *itc_hook_install_d(const char *className, const char *selName, const char *domain);
char *itc_hook_remove(const char *className, const char *selName);
char *itc_hook_list(void);                                                          // installed hooks
char *itc_hook_drain(int clear, int limit);                                         // captured hits
char *itc_trace_class(const char *className, int maxMethods);                       // Tier-2 class trace
char *itc_untrace_class(const char *className);
char *itc_dom_watch(void);                                                          // DOM view lifecycle
char *itc_cintercept_install(const char *symbol);                                   // Tier-3 fishhook
char *itc_cintercept_list(void);

#ifdef __cplusplus
}
#endif

#endif
