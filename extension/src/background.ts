import { connectToHost, connectWsChannel, registerAlarmListener, registerSwKeepaliveListener } from "./background/transport"
import { registerCdpListeners } from "./background/cdp"
import { registerTabGroupListeners, ensureSlopGroup } from "./background/tab-group"

// Register all event listeners
registerCdpListeners()
registerTabGroupListeners()
registerAlarmListener()
registerSwKeepaliveListener()

// Startup connections
chrome.runtime.onInstalled.addListener(() => {
  connectToHost()
  connectWsChannel()
  ensureSlopGroup()
})
chrome.runtime.onStartup.addListener(() => {
  connectToHost()
  connectWsChannel()
  ensureSlopGroup()
})

connectToHost()
connectWsChannel()
