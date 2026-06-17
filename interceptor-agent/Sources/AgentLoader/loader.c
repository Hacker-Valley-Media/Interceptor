#include "AgentLoader.h"
#include <stdlib.h>

/* The Swift agent's exported entry point (@_cdecl). */
extern void interceptor_agent_start(void);
/* Installs the fishhook GOT rebinding for SSL_read/SSL_write (netcap.c). */
extern void interceptor_install_tls_hooks(void);

/* Runs automatically when the dylib is loaded into the host process — i.e. the
 * instant DYLD_INSERT_LIBRARIES (or a re-signed bundle) loads us, before the
 * app's own code. This is the linker-reliable auto-start for the Runtime Agent
 * surface. bootstrap() is idempotent, so it is safe even if the Swift
 * __mod_init_func entry also fires. */
__attribute__((constructor))
static void interceptor_agent_loader(void) {
    interceptor_install_tls_hooks();
    interceptor_agent_start();
}
