// Hyprland's plugin ABI requires the compositor's C++ compiler and headers.
#include "pointer-core.hpp"
#include "app-core.hpp"
extern "C" {
#include "interceptor-background-pointer-v1-server.h"
}
#include <unordered_map>
#include <cstring>
#include <hyprland/src/event/EventBus.hpp>

namespace {
struct LaunchWindow{PHLWINDOWREF window;bool noInitialFocus;bool suppressActivation;};
struct Client{uint32_t lastRequest=0;std::string launchToken;std::chrono::steady_clock::time_point launchDeadline;std::vector<LaunchWindow> launchWindows;};
static wl_global* global=nullptr;
static wl_event_source* loginWatch=nullptr;
static std::unordered_map<wl_resource*,Client> clients;
static CHyprSignalListener launchWatch;
static CHyprSignalListener earlyLaunchWatch;

static void clearLaunch(Client& client){
    for(const auto& saved:client.launchWindows)if(const auto window=saved.window.lock()){
        window->m_noInitialFocus=saved.noInitialFocus;
        if(!saved.suppressActivation)window->m_suppressedEvents&=~Desktop::View::SUPPRESS_ACTIVATE;
    }
    client.launchWindows.clear();client.launchToken.clear();
}
static PointerResult prepareLaunch(wl_resource* resource,const std::string& command){
    constexpr std::string_view prefix="launch-guard ";
    const auto token=command.substr(prefix.size());
    if(wl_resource_get_version(resource)<4)return refused("background_unavailable");
    if(token.size()!=64 || !std::all_of(token.begin(),token.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');}))return refused("invalid_request");
    if(!g_pSessionLockManager || g_pSessionLockManager->isSessionLocked())return refused("input_busy");
    auto& client=clients.at(resource);
    if(!client.launchToken.empty() && client.launchDeadline>Time::steadyNow())return refused("input_busy");
    for(const auto& [other,saved]:clients)if(other!=resource && saved.launchToken==token && saved.launchDeadline>Time::steadyNow())return refused("invalid_request");
    clearLaunch(client);client.launchWindows.reserve(64);client.launchToken=token;
    client.launchDeadline=Time::steadyNow()+std::chrono::seconds(10);
    return {true,"ok",0,true,true};
}
static void guardLaunch(const PHLWINDOW& window){
    if(interceptor_linux_login_valid()!=1 || !window || window->m_isX11 || !window->wlSurface() || !window->wlSurface()->resource())return;
    try{
        const auto env=window->getEnv();const auto token=env.find("HL_EXEC_RULE_TOKEN");
        if(token==env.end() || token->second.size()!=64)return;
        for(auto& [resource,client]:clients){
            if(client.launchToken!=token->second || client.launchDeadline<=Time::steadyNow())continue;
            const auto caller=wl_client_get_fd(wl_resource_get_client(resource));
            const auto target=wl_client_get_fd(window->wlSurface()->resource()->client());
            if(interceptor_linux_peers_authenticated(caller,target)!=1)return;
            if(std::none_of(client.launchWindows.begin(),client.launchWindows.end(),[&](const auto& saved){return saved.window.lock()==window;})){
                if(client.launchWindows.size()>=64)return;
                client.launchWindows.push_back({window,window->m_noInitialFocus,static_cast<bool>(window->m_suppressedEvents&Desktop::View::SUPPRESS_ACTIVATE)});
            }
            // Guard before layout, then reassert before the new-window focus call.
            // A background launch must not retile the user's existing windows.
            // Keep its normal floating placement after the startup scope ends.
            window->m_isFloating=true;window->m_requestsFloat=true;
            window->m_noInitialFocus=true;window->m_suppressedEvents|=Desktop::View::SUPPRESS_ACTIVATE;
            return;
        }
    }catch(...){/* Never unwind a client environment read through the compositor. */}
}

static void release(wl_resource* resource){clearMenuAction(resource);if(const auto found=clients.find(resource);found!=clients.end())clearLaunch(found->second);clients.erase(resource);}
static void destroy(wl_client*,wl_resource* resource){wl_resource_destroy(resource);}
static void execute(wl_client* client,wl_resource* resource,uint32_t id,const char* command){
    const auto found=clients.find(resource);
    if(found==clients.end())return;
    if(!id||id<=found->second.lastRequest){
        wl_resource_post_error(resource,INTERCEPTOR_BACKGROUND_POINTER_V1_ERROR_INVALID_REQUEST,"request ids must be nonzero and strictly increase");return;
    }
    found->second.lastRequest=id;
    PointerResult result;
    try{
        if(interceptor_linux_login_valid()!=1)result=refused("permission_denied");
        else if(!command||strnlen(command,513)>512)result=refused("invalid_request");
        else if(std::string_view(command).starts_with("launch-guard "))result=prepareLaunch(resource,command);
        else result=deliverPointer(command,wl_client_get_fd(client),resource,wl_resource_get_version(resource));
    }catch(...){injectingWindow.reset();clearMenuAction(resource);result={false,"timeout_unknown_outcome",0,false,false};}
    interceptor_background_pointer_v1_send_result(resource,id,result.success?1:0,result.code,result.delivered,result.focusUnchanged?1:0,result.cursorUnchanged?1:0);
}
static void app(wl_client* client,wl_resource* resource,uint32_t id,uint32_t operation,uint32_t pid,uint32_t addressHi,uint32_t addressLo,int32_t processFd){
    const auto found=clients.find(resource);
    if(found==clients.end()){if(processFd>=0)close(processFd);return;}
    if(!id || id<=found->second.lastRequest){
        if(processFd>=0)close(processFd);
        wl_resource_post_error(resource,INTERCEPTOR_BACKGROUND_POINTER_V1_ERROR_INVALID_REQUEST,"request ids must be nonzero and strictly increase");return;
    }
    found->second.lastRequest=id;
    PointerResult result;
    try{
        if(interceptor_linux_login_valid()!=1)result=refused("permission_denied");
        else result=deliverApp(operation,pid,(static_cast<uint64_t>(addressHi)<<32)|addressLo,processFd,wl_client_get_fd(client));
    }catch(...){result={false,"timeout_unknown_outcome",0,false,false};}
    if(processFd>=0)close(processFd);
    interceptor_background_pointer_v1_send_result(resource,id,result.success?1:0,result.code,result.delivered,result.focusUnchanged?1:0,result.cursorUnchanged?1:0);
}
static const struct interceptor_background_pointer_v1_interface implementation={destroy,execute,app};
static void bind(wl_client* client,void*,uint32_t version,uint32_t id){
    auto resource=wl_resource_create(client,&interceptor_background_pointer_v1_interface,std::min(version,4u),id);
    if(!resource){wl_client_post_no_memory(client);return;}
    const auto socket=wl_client_get_fd(client);
    if(interceptor_linux_peers_authenticated(socket,socket)!=1){
        wl_resource_post_error(resource,INTERCEPTOR_BACKGROUND_POINTER_V1_ERROR_PERMISSION_DENIED,"pointer caller requires the retained user and login session");
        wl_resource_destroy(resource);return;
    }
    if(clients.size()>=64){
        wl_resource_post_error(resource,INTERCEPTOR_BACKGROUND_POINTER_V1_ERROR_RESOURCE_LIMIT,"pointer object limit");wl_resource_destroy(resource);return;
    }
    try{clients.emplace(resource,Client{});}catch(...){wl_resource_destroy(resource);wl_client_post_no_memory(client);return;}
    wl_resource_set_implementation(resource,&implementation,nullptr,release);
}
static void revoke(){
    launchWatch.reset();
    earlyLaunchWatch.reset();
    if(global){wl_global_remove(global);wl_global_destroy(global);global=nullptr;}
    while(!clients.empty())wl_resource_destroy(clients.begin()->first);
    restoreBackgroundPopups();
    restoreHiddenApps();
}
static int checkLogin(void*){
    if(interceptor_linux_login_valid()!=1){revoke();return 0;}
    for(auto& [_,client]:clients)if(!client.launchToken.empty() && client.launchDeadline<=Time::steadyNow())clearLaunch(client);
    wl_event_source_timer_update(loginWatch,500);return 0;
}
static void cleanup(){
    if(loginWatch)wl_event_source_remove(loginWatch);loginWatch=nullptr;
    if(protocolLogger)wl_protocol_logger_destroy(protocolLogger);protocolLogger=nullptr;
    revoke();
}
}
APICALL EXPORT std::string PLUGIN_API_VERSION(){return HYPRLAND_API_VERSION;}
APICALL EXPORT PLUGIN_DESCRIPTION_INFO PLUGIN_INIT(HANDLE){
    if(std::string(__hyprland_api_get_hash())!=__hyprland_api_get_client_hash())throw std::runtime_error("Interceptor pointer plugin ABI mismatch");
    if(interceptor_linux_login_initialize()!=1)throw std::runtime_error("Interceptor pointer plugin requires one retained graphical login");
    try{
        protocolLogger=wl_display_add_protocol_logger(g_pCompositor->m_wlDisplay,protocolTrace,nullptr);
        launchWatch=Event::bus()->m_events.window.open.listen(guardLaunch);
        earlyLaunchWatch=Event::bus()->m_events.window.openEarly.listen(guardLaunch);
        global=wl_global_create(g_pCompositor->m_wlDisplay,&interceptor_background_pointer_v1_interface,4,nullptr,bind);
        loginWatch=wl_event_loop_add_timer(wl_display_get_event_loop(g_pCompositor->m_wlDisplay),checkLogin,nullptr);
        if(!protocolLogger||!global||!loginWatch||wl_event_source_timer_update(loginWatch,500)<0)throw std::runtime_error("Interceptor pointer protocol setup failed");
    }catch(...){cleanup();throw;}
    return {"interceptor-background-pointer","Authenticated native Wayland pointer delivery","Interceptor","1"};
}
APICALL EXPORT void PLUGIN_EXIT(){cleanup();}
