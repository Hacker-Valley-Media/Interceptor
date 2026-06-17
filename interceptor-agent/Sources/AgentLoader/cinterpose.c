// cinterpose.c — Tier-3 C-symbol interception via dyld __interpose.
//
// Runtime fishhook of libsystem symbols corrupts the host on modern macOS (writes
// to __DATA_CONST locked after bind / chained fixups). The robust path is dyld
// __interpose: dyld swaps these tuples at BIND time (before lockdown), so calls to
// open()/getaddrinfo() from any image route to our replacement — which just calls
// the real function (interpose never re-applies to the interposing image) and, when
// the operator has enabled recording via `macos runtime cintercept <sym>`, pushes one event
// into the hook buffer. Gated by itc_cintercept_mask, so it's a near-free pass-through
// (one branch) until enabled — and never writes memory at runtime, so it can't crash.

#include <fcntl.h>
#include <stdarg.h>
#include <netdb.h>
#include <sys/types.h>

// Defined in AgentJS/hookengine.m (so the unit-test target, which links AgentJS but
// not AgentLoader, still resolves it). Set by itc_cintercept_install.
extern unsigned itc_cintercept_mask;
#define ITC_CIN_OPEN 1u
#define ITC_CIN_GAI  2u

// C-friendly recorder implemented in AgentJS/hookengine.m (same dylib).
extern void itc_hook_record_c(const char *domain, const char *event,
                              const char *fn, const char *s1, long n1);

static int itc_i_open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) { va_list ap; va_start(ap, flags); mode = (mode_t)va_arg(ap, int); va_end(ap); }
    int r = open(path, flags, mode);   // same image -> NOT interposed -> the real open
    if (itc_cintercept_mask & ITC_CIN_OPEN) itc_hook_record_c("File", "cintercept", "open", path, (long)r);
    return r;
}

static int itc_i_getaddrinfo(const char *node, const char *service,
                             const struct addrinfo *hints, struct addrinfo **res) {
    int r = getaddrinfo(node, service, hints, res);
    if (itc_cintercept_mask & ITC_CIN_GAI) itc_hook_record_c("Network", "cintercept", "getaddrinfo", node, (long)r);
    return r;
}

__attribute__((used))
static const struct { const void *replacement; const void *original; }
_itc_cin_interposers[] __attribute__((section("__DATA,__interpose"))) = {
    { (const void *)itc_i_open,        (const void *)open },
    { (const void *)itc_i_getaddrinfo, (const void *)getaddrinfo },
};
