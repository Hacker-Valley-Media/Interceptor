#pragma once
#include <stdint.h>

// Implemented by src/lib.rs using the existing Linux PIDfd/logind resolver.
// Connected sockets are borrowed. Authentication never consumes their data.
#ifdef __cplusplus
extern "C" {
#endif
int32_t interceptor_linux_login_initialize(void);
int32_t interceptor_linux_login_valid(void);
int32_t interceptor_linux_peers_authenticated(int32_t caller_socket, int32_t target_socket);
// Bind a target connection to the caller-retained process handle and login.
// All arguments are borrowed; the protocol callback owns its received fd.
int32_t interceptor_linux_target_matches(int32_t process_fd, int32_t target_socket, uint32_t pid);
#ifdef __cplusplus
}
#endif
