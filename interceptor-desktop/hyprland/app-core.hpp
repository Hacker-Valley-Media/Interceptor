#pragma once
#include <hyprland/src/config/shared/actions/ConfigActions.hpp>
#include <hyprland/src/render/Renderer.hpp>

// These weak references identify only windows hidden by this loaded instance.
// Revoke/unload restores them without changing the user's active window.
static std::vector<PHLWINDOWREF> hiddenApps;
static bool ownsHiddenApp(const PHLWINDOW& window){
    return std::any_of(hiddenApps.begin(),hiddenApps.end(),[&](const auto& saved){return saved.lock()==window;});
}
static void restoreHiddenApps(){
    for(const auto& saved:hiddenApps)if(const auto window=saved.lock();window && window->m_isMapped && window->isHidden()){
        window->setHidden(false);if(g_pHyprRenderer)g_pHyprRenderer->damageWindow(window,true);
    }
    hiddenApps.clear();
}
static PointerResult deliverApp(uint32_t operation,uint32_t pid,uint64_t address,int processFd,int callerSocket){
    if(operation<1 || operation>4 || !pid || pid>INT32_MAX || !address || processFd<0)return refused("invalid_request");
    if(!g_pSeatManager || !g_pInputManager || !g_pHyprRenderer || !PROTO::data || !g_pSessionLockManager ||
       g_pSessionLockManager->isSessionLocked() || PROTO::data->dndActive() || g_pSeatManager->m_seatGrab || g_pInputManager->hasHeldButtons() ||
       (menuActionScope && menuActionScope->deadline>Time::steadyNow()))return refused("input_busy");
    std::erase_if(hiddenApps,[](const auto& saved){const auto window=saved.lock();return !window || !window->m_isMapped;});
    std::vector<PHLWINDOW> windows;
    PHLWINDOW anchor;
    for(const auto& window:Desktop::viewState()->windows()){
        if(!window->m_isMapped || window->getPID()!=static_cast<pid_t>(pid))continue;
        if(window->m_isX11 || window->m_group || (window->isHidden() && !ownsHiddenApp(window)))return refused("unsupported_target");
        if(!window->wlSurface() || !window->wlSurface()->resource())return refused("target_gone");
        const auto socket=wl_client_get_fd(window->wlSurface()->resource()->client());
        if(interceptor_linux_peers_authenticated(callerSocket,socket)!=1 || interceptor_linux_target_matches(processFd,socket,pid)!=1)return refused("permission_denied");
        if(windows.size()>=64)return refused("resource_limit");
        windows.push_back(window);
        if(reinterpret_cast<uintptr_t>(window.get())==address)anchor=window;
    }
    if(windows.empty() || !anchor)return refused("target_gone");
    const auto active=Desktop::focusState()->window();
    const auto keyboard=g_pSeatManager->m_state.keyboardFocus.lock();
    const auto pointer=g_pSeatManager->m_state.pointerFocus.lock();
    const auto cursor=g_pInputManager->getMouseCoordsInternal();
    if(operation==2 || operation==4){
        if(std::find(windows.begin(),windows.end(),active)!=windows.end())return refused("input_busy");
    }
    if(operation==2 && hiddenApps.size()+windows.size()>256)return refused("resource_limit");
    // Allocate tracking space before the first effect. Existing hidden windows
    // are idempotent; no other compositor or group hiding state is overridden.
    if(operation==2)hiddenApps.reserve(hiddenApps.size()+windows.size());
    uint32_t delivered=0;
    for(const auto& window:windows){
        if(operation==2){
            if(!window->isHidden()){
                hiddenApps.push_back(window);window->setHidden(true);g_pHyprRenderer->damageWindow(window,true);++delivered;
            }
        }else if(ownsHiddenApp(window)){
            window->setHidden(false);g_pHyprRenderer->damageWindow(window,true);++delivered;
            std::erase_if(hiddenApps,[&](const auto& saved){return saved.lock()==window;});
        }
    }
    if(operation==1){
        // Actions::focus also warps the cursor. The focus-state API respects
        // modal/fullscreen restrictions without that additional pointer move.
        Desktop::focusState()->fullWindowFocus(anchor,Desktop::FOCUS_REASON_DISPATCH_FOCUSWINDOW,nullptr,false);
        ++delivered;
    }else if(operation==4){
        for(const auto& window:windows){
            if(!Config::Actions::closeWindow(window))return {false,"timeout_unknown_outcome",delivered,false,false};
            ++delivered;
        }
    }
    const bool focusUnchanged=active==Desktop::focusState()->window() && keyboard==g_pSeatManager->m_state.keyboardFocus && pointer==g_pSeatManager->m_state.pointerFocus;
    const bool cursorUnchanged=cursor==g_pInputManager->getMouseCoordsInternal();
    const bool verified=cursorUnchanged && (operation==1 ? Desktop::focusState()->window()==anchor : focusUnchanged) &&
        (operation!=2 || std::all_of(windows.begin(),windows.end(),[](const auto& window){return window->isHidden();})) &&
        (operation!=3 || std::none_of(windows.begin(),windows.end(),[](const auto& window){return window->isHidden();}));
    return {verified,verified ? "ok" : "timeout_unknown_outcome",delivered,focusUnchanged,cursorUnchanged};
}
