#pragma once
#include "session-auth.h"
// Qualified Hyprland pointer resources and scoped popup callbacks.
// Hyprland's plugin ABI requires C++, matching the compositor compiler/headers.
#include <hyprland/src/plugins/PluginAPI.hpp>
#include <hyprland/src/desktop/state/ViewState.hpp>
#include <hyprland/src/desktop/state/FocusState.hpp>
#include <hyprland/src/desktop/view/WLSurface.hpp>
#include <hyprland/src/managers/SeatManager.hpp>
#include <hyprland/src/managers/input/InputManager.hpp>
#include <hyprland/src/managers/SessionLockManager.hpp>
#include <hyprland/src/protocols/core/Seat.hpp>
#include <hyprland/src/protocols/core/Compositor.hpp>
#include <hyprland/src/protocols/core/DataDevice.hpp>
#include <hyprland/src/helpers/time/Time.hpp>
#include <hyprland/src/Compositor.hpp>
#include <hyprland/src/protocols/XDGShell.hpp>
#include <iostream>
#include <deque>
#include <sstream>
#include <stdexcept>
#include <unistd.h>
#include <chrono>

static wl_protocol_logger* protocolLogger = nullptr;
static PHLWINDOWREF injectingWindow;
struct BackgroundSerial { uint32_t serial; PHLWINDOWREF window; };
static std::deque<BackgroundSerial> backgroundSerials;
struct MenuActionScope { const void* owner; PHLWINDOWREF window; std::chrono::steady_clock::time_point deadline; };
static std::optional<MenuActionScope> menuActionScope;
static void clearMenuAction(const void* owner){if(menuActionScope && menuActionScope->owner==owner)menuActionScope.reset();}
// Version-qualified generated-resource callback access. Retain the exact
// compositor callback so unloading never leaves a function in this plugin.
struct PopupRequestsTag { friend auto privateRequests(PopupRequestsTag); };
template<auto Pointer> struct PopupRequestsAccess {
    friend auto privateRequests(PopupRequestsTag) { return Pointer; }
};
template struct PopupRequestsAccess<&CXdgPopup::requests>;
struct BackgroundPopup {
    WP<CXDGPopupResource> popup;
    CXdgPopup* wrapper;
    std::function<void(CXdgPopup*,wl_resource*,uint32_t)> original;
};
static std::vector<BackgroundPopup> backgroundPopups;
static void protocolTrace(void*, wl_protocol_logger_type direction, const wl_protocol_logger_message* message) {
    const std::string_view klass=wl_resource_get_class(message->resource), name=message->message->name;
    if (direction==WL_PROTOCOL_LOGGER_EVENT && klass=="wl_pointer" && name=="button" && injectingWindow && message->arguments_count==4 && message->arguments[3].u==WL_POINTER_BUTTON_STATE_PRESSED) {
        backgroundSerials.push_back({message->arguments[0].u,injectingWindow});
        if(backgroundSerials.size()>128)backgroundSerials.pop_front();
        return;
    }
    if(direction!=WL_PROTOCOL_LOGGER_REQUEST || klass!="xdg_popup" || name!="grab" || message->arguments_count!=2)return;
    const auto serial=message->arguments[1].u;
    const auto popup=CXDGPopupResource::fromResource(message->resource);
    if(!popup)return;
    auto parent=popup->m_parent.lock();
    for(unsigned depth=0;parent && depth<64;++depth) {
        if(parent->m_toplevel)break;
        const auto parentPopup=parent->m_popup.lock();
        parent=parentPopup ? parentPopup->m_parent.lock() : nullptr;
    }
    const auto target=parent && parent->m_toplevel ? parent->m_toplevel->m_window.lock() : nullptr;
    if(!target || !target->m_isMapped || !target->wlSurface() || !target->wlSurface()->resource() ||
       target->wlSurface()->resource()->client()!=wl_resource_get_client(message->resource))return;
    bool scoped=menuActionScope && menuActionScope->deadline>Time::steadyNow() && menuActionScope->window.lock()==target;
    for(const auto& issued:backgroundSerials)if(issued.serial==serial && issued.window.lock()==target)scoped=true;
    if(scoped) {
        auto wrapper=static_cast<CXdgPopup*>(wl_resource_get_user_data(message->resource));
        std::erase_if(backgroundPopups,[](const auto& p){return !p.popup;});
        if(std::none_of(backgroundPopups.begin(),backgroundPopups.end(),[&](const auto& p){return p.popup.lock()==popup;}))
            backgroundPopups.push_back({popup,wrapper,(wrapper->*privateRequests(PopupRequestsTag{})).grab});
        wrapper->setGrab([](CXdgPopup*,wl_resource*,uint32_t){});
        return;
    }
}
struct PointerResult{bool success=false;const char* code="provider_failed";uint32_t delivered=0;bool focusUnchanged=false;bool cursorUnchanged=false;};
static PointerResult refused(const char* code){return {.code=code};}
static PointerResult deliverPointer(const std::string& request,int callerSocket,const void* scopeOwner,uint32_t version) {
    if(request.empty()||request.size()>512)return refused("invalid_request");
    std::istringstream stream(request);
    std::string op, extra;
    uint64_t address = 0;
    uint32_t pid = 0;
    int32_t x = 0, y = 0, qx = 0, qy = 0;
    stream >> op >> address >> pid >> x >> y >> qx >> qy;
    if (!stream || (stream >> extra) || !address || !pid || pid>INT32_MAX ||
        (op != "click" && op != "right" && op != "double" && op != "drag" && op != "down" && op != "up" && op != "left" && op != "right-scroll" && op != "menu-guard"))
        return refused("invalid_request");
    if (!g_pSeatManager || !g_pInputManager || !PROTO::data || !g_pSessionLockManager ||
        g_pSessionLockManager->isSessionLocked() || PROTO::data->dndActive() || g_pSeatManager->m_seatGrab || g_pInputManager->hasHeldButtons())
        return refused("input_busy");
    PHLWINDOW target;
    for (const auto& window : Desktop::viewState()->windows()) {
        if (reinterpret_cast<uintptr_t>(window.get()) != address) continue;
        target = window; break;
    }
    if (!target || !target->m_isMapped || target->m_isX11 || target->isHidden() || target->getPID() != static_cast<pid_t>(pid)) return refused("target_gone");
    if(!target->wlSurface()||!target->wlSurface()->resource())return refused("target_gone");
    const auto client=target->wlSurface()->resource()->client();
    if(interceptor_linux_peers_authenticated(callerSocket,wl_client_get_fd(client))!=1)return refused("permission_denied");
    std::erase_if(backgroundPopups,[](const auto& p){return !p.popup;});
    if(backgroundPopups.size()>=128)return refused("resource_limit");
    if(op=="menu-guard"){
        if(version<2 || !scopeOwner || x || y || qx || qy)return refused("invalid_request");
        if(menuActionScope && menuActionScope->deadline>Time::steadyNow() && menuActionScope->owner!=scopeOwner)return refused("input_busy");
        menuActionScope=MenuActionScope{scopeOwner,target,Time::steadyNow()+std::chrono::milliseconds(750)};
        return {true,"ok",0,true,true};
    }
    Vector2D local;
    const auto surface = Desktop::viewState()->hitTest().windowSurfaceAt({x,y},target,local);
    if (!surface || surface->client() != target->wlSurface()->resource()->client()) return refused("unsupported_target");
    Vector2D endLocal;
    if (op == "drag" && Desktop::viewState()->hitTest().windowSurfaceAt({qx,qy},target,endLocal) != surface) return refused("unsupported_target");
    const auto seat = g_pSeatManager->seatResourceForClient(surface->client());
    if (!seat || seat->m_pointers.empty()) return refused("unsupported_target");
    if(seat->m_pointers.size()>4)return refused("resource_limit");
    const auto active = Desktop::focusState()->window();
    const auto keyboard = g_pSeatManager->m_state.keyboardFocus.lock();
    const auto realPointer = g_pSeatManager->m_state.pointerFocus.lock();
    const auto cursor = g_pInputManager->getMouseCoordsInternal();
    const auto realView = realPointer ? Desktop::View::CWLSurface::fromResource(realPointer) : nullptr;
    const auto realBox = realView ? realView->getSurfaceBoxGlobal() : std::nullopt;
    if (realPointer && realPointer->client() == surface->client() && !realBox) return refused("unsupported_target");
    const uint32_t stamp = Time::millis(Time::steadyNow());
    uint32_t delivered = 0;
    injectingWindow=target;
    for (const auto& weak : seat->m_pointers) {
        const auto pointer = weak.lock(); if (!pointer || !pointer->good()) continue;
        pointer->sendEnter(surface,local); pointer->sendMotion(stamp,local); pointer->sendFrame();
        if (op == "down" || op == "up" || op == "left" || op == "right-scroll") {
            const bool horizontal = op == "left" || op == "right-scroll";
            const int sign = op == "up" || op == "left" ? -1 : 1;
            const auto axis = horizontal ? WL_POINTER_AXIS_HORIZONTAL_SCROLL : WL_POINTER_AXIS_VERTICAL_SCROLL;
            pointer->sendAxisSource(WL_POINTER_AXIS_SOURCE_WHEEL);
            pointer->sendAxis(stamp,axis,sign*15.0);
            if (pointer->version() >= 8) pointer->sendAxisValue120(axis,sign*120); else pointer->sendAxisDiscrete(axis,sign);
            pointer->sendFrame(); ++delivered;
        } else {
            const uint32_t button = op == "right" ? 273 : 272;
            for (int click=0;click<(op == "double" ? 2 : 1);++click) {
                pointer->sendButton(stamp+click*100,button,WL_POINTER_BUTTON_STATE_PRESSED); pointer->sendFrame(); ++delivered;
                if (op == "drag") for (int step=1;step<=32;++step) {
                    pointer->sendMotion(stamp+step,local+(endLocal-local)*(step/32.0)); pointer->sendFrame(); ++delivered;
                }
                pointer->sendButton(stamp+click*100+40,button,WL_POINTER_BUTTON_STATE_RELEASED); pointer->sendFrame(); ++delivered;
            }
        }
        pointer->sendLeave();
        if (realPointer && realPointer->client() == surface->client()) pointer->sendEnter(realPointer,cursor-realBox->pos());
        pointer->sendFrame();
    }
    injectingWindow.reset();
    const bool focusUnchanged = active == Desktop::focusState()->window() && keyboard == g_pSeatManager->m_state.keyboardFocus && realPointer == g_pSeatManager->m_state.pointerFocus;
    const bool cursorUnchanged = cursor == g_pInputManager->getMouseCoordsInternal();
    const bool completed=focusUnchanged && cursorUnchanged && delivered;
    return {completed,completed ? "ok" : "timeout_unknown_outcome",delivered,focusUnchanged,cursorUnchanged};
}

static void restoreBackgroundPopups(){
    for(auto& popup:backgroundPopups)if(popup.popup && popup.popup->good())popup.wrapper->setGrab(std::move(popup.original));
    backgroundPopups.clear();backgroundSerials.clear();injectingWindow.reset();menuActionScope.reset();
}
