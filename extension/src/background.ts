import { connectToHost, connectWsChannel, registerAlarmListener, registerSwKeepaliveListener } from "./background/transport"
import { registerCdpListeners } from "./background/cdp"
import { registerTabGroupListeners, ensureInterceptorGroup } from "./background/tab-group"

// Register all event listeners
registerCdpListeners()
registerTabGroupListeners()
registerAlarmListener()
registerSwKeepaliveListener()

// Startup connections
chrome.runtime.onInstalled.addListener(() => {
  connectToHost()
  connectWsChannel()
  ensureInterceptorGroup()
})
chrome.runtime.onStartup.addListener(() => {
  connectToHost()
  connectWsChannel()
  ensureInterceptorGroup()
})

connectToHost()
connectWsChannel()
