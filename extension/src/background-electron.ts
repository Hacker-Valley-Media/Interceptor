import { connectWsChannel, registerStorageContextListener, registerSwKeepaliveListener } from "./background/transport"

// Electron's extension host does not support Chrome native messaging or MV3
// service workers. This background page is the Path 0 app-control entrypoint:
// WebSocket transport only, with the target context id injected by app attach.
registerSwKeepaliveListener()
registerStorageContextListener()
connectWsChannel()
