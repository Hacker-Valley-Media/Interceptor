use crate::{failure,success,contract_generated::*};
use serde_json::{Value,json};

pub fn validate(action:&Value)->Result<(),Value>{
    if let Some(error)=desktop_display_shape_error(action){return Err(failure("invalid_request",error));}
    if let Some(id)=action.get("id") {
        if id.as_f64().is_none_or(|n|!n.is_finite()||n.fract()!=0.0||n<1.0||n>9007199254740991.0){return Err(failure("invalid_request","display ID requires a positive safe integer"));}
    }
    Ok(())
}
pub fn dispatch(verb:&str,action:&Value)->Value{
    if let Err(error)=validate(action){return error;}
    #[cfg(windows)]{return crate::windows::dispatch(verb,action);}
    #[cfg(target_os="linux")]{return crate::linux::dispatch(verb,action);}
    #[cfg(not(any(windows,target_os="linux")))]{let _=verb;failure("unsupported_operation","macOS uses the Swift display provider")}
}
pub fn execute(verb:&str,action:&Value)->Value{
    let id=if verb=="display_info"{Some(action["id"].as_f64().unwrap()as u64)}else{None};
    match records(id){Ok(data)=>success(data),Err(error)=>error}
}
/// Display rows from the session's backend: Win32, Wayland (Hyprland) or X11.
pub(crate) fn records(id:Option<u64>)->Result<Value,Value>{
    #[cfg(windows)]{crate::display_windows::read(id)}
    #[cfg(target_os="linux")]{if std::env::var_os("WAYLAND_DISPLAY").is_some(){crate::display_wayland::read(id)}else{crate::linux_x11::display_records(id)}}
    #[cfg(not(any(windows,target_os="linux")))]{let _=id;Err(failure("unsupported_operation","no display backend"))}
}
pub fn capabilities(host:&str,session:&str,graphical:bool)->Vec<Value>{
    ["display_list","display_info"].map(|operation|json!({"operation":operation,"compiled":true,"present":true,
      "permission":"not_applicable","session":session,"effective":graphical,"background":if graphical{"semantic"}else{"unavailable"},
      "provider":if host=="win32"{"Win32.Monitor"}else if std::env::var_os("WAYLAND_DISPLAY").is_some(){"Wayland.wl_output/xdg-output"}else{"X11.RandR"},"versions":{"product":env!("CARGO_PKG_VERSION")},
      "limits":["read-only monitor metadata; unknown fields are explicit","Wayland IDs include authenticated compositor socket/process and output lifetimes; primary/virtual/builtin classification is unavailable from core protocols","virtual display creation/removal is not implemented","other display topology/DPI/compositor qualification remains open"],
      "reason":if graphical{"native API and topology qualification required"}else{"no qualified graphical session"}})).to_vec()
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn display_ids_and_shapes_refuse_before_dispatch(){
        assert!(validate(&json!({"type":"desktop_display_list"})).is_ok());
        for id in [1.0,1e3,9007199254740991.0]{assert!(validate(&json!({"type":"desktop_display_info","id":id})).is_ok());}
        for id in [json!(0),json!(-1),json!(1.5),json!(true),json!("1"),Value::Null,json!(9007199254740992.0)]{assert!(validate(&json!({"type":"desktop_display_info","id":id})).is_err());}
        assert!(validate(&json!({"type":"desktop_display_list","id":1})).is_err());
        assert!(validate(&json!({"type":"desktop_display_info"})).is_err());
    }
}
