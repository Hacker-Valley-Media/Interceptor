// Universal network capture via dyld function interposition.
//
// The in-process URLSession hook only sees apps that use Foundation networking.
// Many native apps (runtime-hosted native sides, libcurl/BoringSSL clients)
// use their own stack — so we interpose the libSystem primitives EVERY network
// stack ends up calling: connect() (the IP:port it dials) and getaddrinfo() (the
// hostname it resolves). This captures the endpoints an app talks to regardless
// of its TLS library. Bodies/plaintext would need a TLS-layer hook (separate).
//
// The replacements always forward to the original (dyld resolves the by-name
// call to the real function inside an interposing image, so no recursion) and
// hand the endpoint to the Swift sink, which gates on whether capture is on.

#define _DARWIN_C_SOURCE 1
#include <sys/socket.h>
#include <netinet/in.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <string.h>
#include <sys/uio.h>

// Implemented in Swift (@_cdecl). Gating happens Swift-side.
extern void interceptor_agent_net_host(const char *host, const char *service);
extern void interceptor_agent_net_connect(const char *addr);

static void itc_note_sockaddr(const struct sockaddr *addr) {
    if (!addr) return;
    char buf[140];
    buf[0] = '\0';
    if (addr->sa_family == AF_INET) {
        const struct sockaddr_in *a = (const struct sockaddr_in *)addr;
        char ip[INET_ADDRSTRLEN];
        if (inet_ntop(AF_INET, &a->sin_addr, ip, sizeof ip))
            snprintf(buf, sizeof buf, "%s:%d", ip, ntohs(a->sin_port));
    } else if (addr->sa_family == AF_INET6) {
        const struct sockaddr_in6 *a = (const struct sockaddr_in6 *)addr;
        char ip[INET6_ADDRSTRLEN];
        if (inet_ntop(AF_INET6, &a->sin6_addr, ip, sizeof ip))
            snprintf(buf, sizeof buf, "[%s]:%d", ip, ntohs(a->sin6_port));
    }
    if (buf[0]) interceptor_agent_net_connect(buf);
}

// BSD sockets (libcurl, classic stacks)
static int itc_connect(int s, const struct sockaddr *addr, socklen_t len) {
    itc_note_sockaddr(addr);
    return connect(s, addr, len);
}
static int itc_getaddrinfo(const char *node, const char *service,
                           const struct addrinfo *hints, struct addrinfo **res) {
    if (node) interceptor_agent_net_host(node, service ? service : "");
    return getaddrinfo(node, service, hints, res);
}

// Apple connectx() — used by Network.framework (nw_connection) for TCP. This is
// where modern apps on NWConnection/URLSession-over-nw connect.
extern int connectx(int, const sa_endpoints_t *, sae_associd_t, unsigned int,
                    const struct iovec *, unsigned int, size_t *, sae_connid_t *);
static int itc_connectx(int s, const sa_endpoints_t *eps, sae_associd_t aid, unsigned int flags,
                        const struct iovec *iov, unsigned int iovcnt, size_t *len, sae_connid_t *cid) {
    if (eps && eps->sae_dstaddr) itc_note_sockaddr(eps->sae_dstaddr);
    return connectx(s, eps, aid, flags, iov, iovcnt, len, cid);
}

extern void interceptor_agent_tls(int dir, const void *ssl, const char *host, const void *buf, int len);

// dyld __interpose of SSL_read/SSL_write. Two-level namespace binds these to the
// SYSTEM /usr/lib/libboringssl.dylib — which is exactly the copy Apple's
// CFNetwork/Network.framework uses. __interpose ALSO works on chained-fixup
// images where fishhook can't. So: __interpose covers the system stack; fishhook
// (below) covers an app's OWN bundled libssl.
extern int SSL_read(void *ssl, void *buf, int num);
extern int SSL_write(void *ssl, const void *buf, int num);
static int itc_SSL_read(void *ssl, void *buf, int num) {
    int r = SSL_read(ssl, buf, num);
    if (r > 0) interceptor_agent_tls(0, ssl, (const char *)0, buf, r);
    return r;
}
static int itc_SSL_write(void *ssl, const void *buf, int num) {
    if (buf && num > 0) interceptor_agent_tls(1, ssl, (const char *)0, buf, num);
    return SSL_write(ssl, buf, num);
}

// Apple stack: Network.framework's application-data boundary. For an nw_connection
// with a TLS protocol, the app hands PLAINTEXT to nw_connection_send (Network.framework
// encrypts below). This is where URLSession/CFNetwork plaintext flows when the app
// doesn't go through the exported boringssl SSL_read/SSL_write.
#include <dispatch/dispatch.h>
typedef void *nw_connection_t;
typedef void *nw_content_context_t;
typedef void (^nw_send_completion_t)(void *error);
extern void nw_connection_send(nw_connection_t, dispatch_data_t, nw_content_context_t, _Bool, nw_send_completion_t);

static void itc_nw_connection_send(nw_connection_t c, dispatch_data_t content,
                                   nw_content_context_t ctx, _Bool is_complete, nw_send_completion_t completion) {
    if (content) {
        dispatch_data_apply(content, ^bool(dispatch_data_t region, size_t offset, const void *buf, size_t size) {
            (void)region; (void)offset;
            if (buf && size > 0) interceptor_agent_tls(1, c, (const char *)0, buf, (int)(size > 8192 ? 8192 : size));
            return true;
        });
    }
    nw_connection_send(c, content, ctx, is_complete, completion);
}

__attribute__((used))
static const struct { const void *replacement; const void *original; }
_itc_net_interposers[] __attribute__((section("__DATA,__interpose"))) = {
    { (const void *)itc_connect,            (const void *)connect },
    { (const void *)itc_getaddrinfo,        (const void *)getaddrinfo },
    { (const void *)itc_connectx,           (const void *)connectx },
    { (const void *)itc_SSL_read,           (const void *)SSL_read },
    { (const void *)itc_SSL_write,          (const void *)SSL_write },
    { (const void *)itc_nw_connection_send, (const void *)nw_connection_send },
};

// FULL capture: the TLS plaintext boundary. The target's HTTP stack (for example,
// libcurl with bundled libssl.dylib/OpenSSL, or another dynamic TLS stack) calls
// SSL_read/SSL_write. dyld two-level __interpose can't catch a foreign dylib's
// own SSL_read, so we GOT-rebind by NAME with fishhook: SSL_write's buffer is the
// plaintext we SEND; after SSL_read returns, its buffer holds what we RECEIVED.
// Captures the decrypted application bytes (HTTP text, HTTP/2 frames, websocket,
// custom protocols) — no proxy, no MITM cert.
#include "fishhook.h"
#include <mach-o/dyld.h>

extern void interceptor_agent_tls(int dir, const void *ssl, const char *host, const void *buf, int len);

static int (*orig_SSL_read)(void *, void *, int);
static int (*orig_SSL_write)(void *, const void *, int);

static int hook_SSL_read(void *ssl, void *buf, int num) {
    int r = orig_SSL_read ? orig_SSL_read(ssl, buf, num) : -1;
    if (r > 0) interceptor_agent_tls(0, ssl, (const char *)0, buf, r);
    return r;
}
static int hook_SSL_write(void *ssl, const void *buf, int num) {
    if (buf && num > 0) interceptor_agent_tls(1, ssl, (const char *)0, buf, num);
    return orig_SSL_write ? orig_SSL_write(ssl, buf, num) : -1;
}

static struct rebinding _itc_tls_rebindings[2];

// Rebind SSL_read/SSL_write in each image as it loads. dyld invokes this for
// every already-loaded image at registration and for each future one, so it
// catches libssl/curl64 whenever the app pulls them in. Once per image → the
// saved originals point at the real functions, never at our hooks.
static void _itc_image_added(const struct mach_header *mh, intptr_t slide) {
    rebind_symbols_image((void *)mh, slide, _itc_tls_rebindings, 2);
}

void interceptor_install_tls_hooks(void) {
    _itc_tls_rebindings[0] = (struct rebinding){ "SSL_read",  (void *)hook_SSL_read,  (void **)&orig_SSL_read };
    _itc_tls_rebindings[1] = (struct rebinding){ "SSL_write", (void *)hook_SSL_write, (void **)&orig_SSL_write };
    _dyld_register_func_for_add_image(_itc_image_added);
}
