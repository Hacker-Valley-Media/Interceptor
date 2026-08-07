import { connectToHost, connectWsChannel, registerAlarmListener, registerSwKeepaliveListener, registerStorageContextListener } from "./background/transport"
import { registerCdpListeners } from "./background/cdp"
import { registerTabGroupListeners, ensureInterceptorGroup } from "./background/tab-group"
import { registerBrandTabGroup } from "./background/brand-tab-group"
import { registerTabLifecycle } from "./background/tab-lifecycle"
import { registerDelegationListeners } from "./background/delegation"
import { registerPowerIdleListeners } from "./background/keepawake"
import { initializeActionRouter } from "./background/router"

// Register all event listeners
initializeActionRouter()
registerCdpListeners()
registerTabGroupListeners()
registerAlarmListener()
registerSwKeepaliveListener()
registerStorageContextListener()
registerBrandTabGroup()
registerTabLifecycle()
registerDelegationListeners()
registerPowerIdleListeners()

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
