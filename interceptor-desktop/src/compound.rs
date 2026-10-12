use crate::{failure,success,contract_generated::*};
use serde_json::{Value,json};

pub fn validate(verb:&str,action:&Value)->Result<(),Value>{
    if let Some(error)=desktop_compound_shape_error(action){return Err(failure("invalid_request",error));}
    if action["type"]!=format!("desktop_{verb}"){return Err(failure("invalid_request","compound discriminator mismatch"));}
    let mut nested=action.clone();
    nested.as_object_mut().unwrap().remove("activate");
    let operation=if verb=="act" {if action.get("text").is_some(){"type"}else{"click"}}else{"tree"};
    nested["type"]=json!(format!("desktop_{operation}"));
    crate::accessibility::validate(operation,&nested)
}

pub fn dispatch(verb:&str,action:&Value)->Value{
    if let Err(error)=validate(verb,action){return error;}
    #[cfg(windows)]{return crate::windows::dispatch(verb,action);}
    #[cfg(target_os="linux")]{return crate::linux::dispatch(verb,action);}
    #[cfg(not(any(windows,target_os="linux")))]{let _=verb;failure("unsupported_operation","macOS uses the Swift compound provider")}
}

fn app_metadata(app:&Value)->Result<Value,Value>{
    let name=app["name"].as_str().ok_or_else(||failure("provider_failed","application name unavailable"))?;
    let pid=app["pid"].as_u64().filter(|pid|*pid>0&&*pid<=i32::MAX as u64).ok_or_else(||failure("provider_failed","application process identity unavailable"))?;
    Ok(json!({"name":name,"pid":pid,"unknownFields":["bundleId","isActive","isHidden"]}))
}

// Runs nested calls on the existing apartment/AT-SPI worker, never through its
// queue again. Retained reference ownership checks remain the mutation gate.
pub fn execute(verb:&str,action:&Value,mut invoke:impl FnMut(&str,&Value)->Value)->Value{
    let started=std::time::Instant::now();let mut target=action.clone();
    let mut launched=false;
    if verb=="act"{
        let mut inspect=action.clone();inspect["type"]=json!("desktop_inspect");
        inspect.as_object_mut().unwrap().remove("text");
        let result=invoke("inspect",&inspect);
        if result["success"]!=true{return result;}
        let Some(pid)=result["data"]["pid"].as_u64().filter(|pid|*pid>0&&*pid<=i32::MAX as u64)else{return failure("provider_failed","reference process identity unavailable");};
        target["pid"]=json!(pid);
    }else if action.get("pid").is_none()&&action.get("app").is_none(){
        let result=invoke("frontmost",&json!({"type":"desktop_frontmost"}));
        if result["success"]!=true{return result;}
        let Some(pid)=result["data"]["pid"].as_u64().filter(|pid|*pid>0&&*pid<=i32::MAX as u64)else{return failure("unsupported_target","no readable frontmost application; supply an explicit app or pid");};
        target["pid"]=json!(pid);
    }
    let mut selector=json!({"type":"desktop_apps"});
    for key in ["app","pid"]{if let Some(value)=target.get(key){selector[key]=value.clone();}}
    let mut selected=invoke("apps",&selector);
    if selected["success"]!=true{return selected;}
    if verb=="open" && selected["data"].as_array().is_some_and(|apps|apps.is_empty()) && action["app"].is_string() && action.get("pid").is_none(){
        let result=invoke("__launch",action);
        if result["success"]!=true{return result;}
        let Some(pid)=result["data"]["pid"].as_u64().filter(|p|*p>0&&*p<=i32::MAX as u64)else{return failure("timeout_unknown_outcome","launch was accepted without a verifiable process identity; observe before retrying");};
        launched=result["data"]["launched"]==true;
        selector=json!({"type":"desktop_apps","pid":pid});
        // A cold start registers with UIA / AT-SPI more slowly than a macOS launch registers with
        // LaunchServices. This runs on the native worker, whose reply deadline is 10s: wait until 8s
        // after the compound began, leaving time for the activation and read that follow.
        let deadline=started+std::time::Duration::from_secs(8);
        loop{
            if launched{
                let alive=invoke("__launch_alive",&json!({"pid":pid}));
                if alive["success"]!=true || alive["data"]!=true{return json!({"success":false,"code":"timeout_unknown_outcome","error":"launched process identity is no longer live; observe before retrying","retryable":false,"details":{"dispatched":true,"pid":pid,"verified":false}});}
            }
            selected=invoke("apps",&selector);
            if selected["success"]!=true || selected["data"].as_array().is_some_and(|apps|!apps.is_empty()){break;}
            if std::time::Instant::now()>=deadline{return json!({"success":false,"code":"timeout_unknown_outcome","error":"launch process has no accessible application before its deadline; observe before retrying","retryable":false,"details":{"dispatched":launched,"pid":pid,"verified":false}});}
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if selected["success"]!=true{return json!({"success":false,"code":"timeout_unknown_outcome","error":"application selection failed after launch; observe before retrying","retryable":false,"details":{"dispatched":launched,"pid":pid,"verified":false,"readFailure":selected}});}
    }
    let Some(apps)=selected["data"].as_array()else{return failure("provider_failed","application list unavailable");};
    if apps.len()!=1{return failure(if apps.is_empty(){"target_gone"}else{"target_ambiguous"},"compound operation requires one matching application");}
    let identity=match app_metadata(&apps[0]){Ok(app)=>app,Err(error)=>return error};
    let pid=identity["pid"].clone();
    if verb=="open" && action["activate"]==true{
        let result=invoke("__activate",&json!({"pid":pid}));
        if result["success"]!=true{return result;}
    }
    let snapshot=if verb=="inspect_app"{
        let result=invoke("apps",&json!({"type":"desktop_apps"}));
        if result["success"]!=true{return result;}
        let Some(apps)=result["data"].as_array()else{return failure("provider_failed","application snapshot unavailable");};
        let mut data=Vec::new();for app in apps{match app_metadata(app){Ok(app)=>data.push(app),Err(error)=>return error}}
        json!(data)
    }else{Value::Null};
    if verb=="act"{
        let mut input=action.clone();let operation=if action.get("text").is_some(){"type"}else{"click"};
        input["type"]=json!(format!("desktop_{operation}"));input["pid"]=pid.clone();
        let result=invoke(operation,&input);
        if result["success"]!=true{return result;}
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let tree_action=json!({"type":"desktop_tree","pid":pid,"filter":action["filter"].as_str().unwrap_or("interactive"),"depth":action["depth"].as_u64().unwrap_or(10)});
    let result=invoke("tree",&tree_action);
    if result["success"]!=true||!result["data"].is_string(){
        if verb=="act" || launched{return json!({"success":false,"code":"timeout_unknown_outcome","error":"action was delivered but the following tree read failed","retryable":false,"details":{"dispatched":true,"pid":pid,"verified":false,"readFailure":result}});}
        return if result["success"]!=true{result}else{failure("provider_failed","tree result is not text")};
    }
    let tree=result["data"].clone();
    if verb=="open"{
        let result=invoke("windows",&json!({"type":"desktop_windows","pid":pid}));
        if result["success"]!=true || !result["data"].is_array(){
            return if launched{json!({"success":false,"code":"timeout_unknown_outcome","error":"window read failed after launch; observe before retrying","retryable":false,"details":{"dispatched":true,"pid":pid,"verified":false,"readFailure":result}})}else if result["success"]!=true{result}else{failure("provider_failed","window list unavailable")};
        }
        let mut windows=Vec::new();
        for window in result["data"].as_array().unwrap(){
            if window["pid"].as_u64().is_some_and(|owner|Some(owner)!=pid.as_u64()){return failure("provider_failed","window belongs to a different application");}
            let mut row=json!({"title":window["title"].as_str().unwrap_or("")});
            for key in ["ref","windowId","frame"]{if let Some(value)=window.get(key).filter(|v|!v.is_null()){row[key]=value.clone();}}
            if let Some(error)=window.get("refUnavailable"){
                row["referenceError"]=json!(error["error"].as_str().unwrap_or("native window reference unavailable"));
                row["referenceErrorCode"]=json!(error["code"].as_str().unwrap_or("unsupported_target"));
            }
            windows.push(row);
        }
        return success(json!({"tree":tree,"windows":windows,"app":identity["name"],"pid":pid}));
    }
    success(match verb{
        "act"=>json!({"action":if action.get("text").is_some(){"typed"}else{"clicked"},"ref":action["ref"],"tree":tree}),
        "inspect_app"=>{
            // The real frontmost app, not the inspected one; unscoped, they are the same.
            let frontmost=if action.get("pid").is_none()&&action.get("app").is_none(){identity.clone()}else{
                let front=invoke("frontmost",&json!({"type":"desktop_frontmost"}));
                match front["data"]["pid"].as_u64().filter(|pid|*pid>0&&*pid<=i32::MAX as u64){
                    Some(front_pid)=>snapshot.as_array().and_then(|rows|rows.iter().find(|row|row["pid"].as_u64()==Some(front_pid)).cloned()).unwrap_or_else(||json!({"name":front["data"]["name"].as_str().unwrap_or(""),"pid":front_pid})),
                    None=>Value::Null,
                }};
            json!({"tree":tree,"apps":snapshot,"target":identity,"frontmost":frontmost})
        },
        _=>json!({"tree":tree,"app":identity["name"],"pid":pid}),
    })
}

pub fn capabilities(host:&str,session:&str,graphical:bool)->Vec<Value>{
    ["read","act","inspect_app","open"].map(|operation|json!({"operation":operation,"compiled":true,"present":true,
      "permission":"not_applicable","session":session,"effective":graphical,"background":if graphical{"semantic"}else{"unavailable"},
      "provider":if host=="win32"{"UIAutomation.Compound"}else{"AT-SPI.Compound"},"versions":{"product":env!("CARGO_PKG_VERSION")},
      "limits":["requires one matching application and existing accessibility consent","act accepts only semantic reference clicks or text delivery","following tree traversal retains its existing budgets","native app metadata fields without qualified equivalents are explicit unknowns","new open launches require an absolute executable path without arguments; shell documents and packaged app IDs are not qualified","running open is a no-op unless activate is explicit; applications can choose to activate themselves outside a qualified startup scope","background Wayland cold launch requires the qualified version 4 companion, native windows in the same login and a ten-second scope limited to 64 floating startup windows; other compositor rules and later self-activation require separate qualification","explicit Linux activation uses the qualified app backend; its compositor, login and target restrictions apply","open window IDs are decimal strings; unavailable IDs and frames are omitted"],
      "reason":if graphical{"target-specific accessibility qualification required"}else{"no qualified graphical session"}})).to_vec()
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn compound_validates_before_dispatch(){
        assert!(validate("read",&json!({"type":"desktop_read","pid":1,"depth":10})).is_ok());
        assert!(validate("act",&json!({"type":"desktop_act","ref":"e1","text":""})).is_ok());
        for action in [json!({"type":"desktop_act","ref":"e1","text":null}),json!({"type":"desktop_act","ref":"1"}),json!({"type":"desktop_read","pid":0}),json!({"type":"desktop_read","depth":1.5}),json!({"type":"desktop_read","sub":"read"})]{let verb=action["type"].as_str().unwrap().strip_prefix("desktop_").unwrap();assert!(validate(verb,&action).is_err());}
    }
    #[test]fn post_mutation_read_failure_is_unknown_and_not_replayed(){
        let mut calls=Vec::new();
        let result=execute("act",&json!({"type":"desktop_act","ref":"e1","text":"hello","pid":2}),|verb,_|{
            calls.push(verb.to_owned());match verb{
                "inspect"=>success(json!({"pid":2})),"apps"=>success(json!([{"name":"fixture","pid":2}])),
                "type"=>success(json!({"method":"fixture"})),"tree"=>failure("target_gone","fixture closed"),_=>panic!("unexpected call"),
            }
        });
        assert_eq!(calls,vec!["inspect","apps","type","tree"]);
        assert_eq!(result["code"],"timeout_unknown_outcome");assert_eq!(result["retryable"],false);assert_eq!(result["details"]["dispatched"],true);
    }
    #[test]fn mismatched_owner_refuses_without_mutation(){
        let mut calls=Vec::new();let result=execute("act",&json!({"type":"desktop_act","ref":"e1","pid":3}),|verb,_|{calls.push(verb.to_owned());failure("unsupported_target","wrong owner")});
        assert_eq!(calls,vec!["inspect"]);assert_eq!(result["code"],"unsupported_target");
    }
    #[test]fn running_open_never_launches_or_activates_without_opt_in(){
        let mut calls=Vec::new();
        let result=execute("open",&json!({"type":"desktop_open","pid":2}),|verb,_|{
            calls.push(verb.to_owned());match verb{
                "apps"=>success(json!([{"name":"fixture","pid":2}])),"tree"=>success(json!("tree")),
                "windows"=>success(json!([{"title":"fixture","windowId":"42","pid":2,"ref":"e1"}])),_=>panic!("unexpected launch or activation"),
            }
        });
        assert_eq!(calls,vec!["apps","tree","windows"]);assert_eq!(result["success"],true);assert_eq!(result["data"]["windows"][0]["windowId"],"42");
    }
    #[test]fn launch_read_failure_is_not_replayed_and_reports_the_spawned_pid(){
        let mut calls=Vec::new();let mut spawned=false;
        let result=execute("open",&json!({"type":"desktop_open","app":"/owned/fixture"}),|verb,action|{
            calls.push(verb.to_owned());match verb{
                "apps" if !spawned=>success(json!([])),
                "__launch"=>{spawned=true;success(json!({"pid":2,"launched":true}))},
                "__launch_alive"=>success(json!(true)),
                "apps"=>{assert_eq!(action["pid"],2);assert!(action.get("app").is_none());success(json!([{"name":"fixture","pid":2}]))},
                "tree"=>failure("target_gone","fixture closed"),_=>panic!("unexpected retry"),
            }
        });
        assert_eq!(calls,vec!["apps","__launch","__launch_alive","apps","tree"]);assert_eq!(result["code"],"timeout_unknown_outcome");assert_eq!(result["retryable"],false);assert_eq!(result["details"]["pid"],2);
    }
    #[test]fn explicit_open_activation_uses_selected_pid_once_and_preserves_refusal(){
        for accepted in [true,false]{
            let mut calls=Vec::new();
            let result=execute("open",&json!({"type":"desktop_open","pid":2,"activate":true}),|verb,action|{
                calls.push(verb.to_owned());match verb{
                    "apps"=>success(json!([{"name":"fixture","pid":2}])),
                    "__activate"=>{assert_eq!(action["pid"],2);if accepted{success(json!({"activated":true}))}else{failure("permission_denied","different login")}},
                    "tree"=>success(json!("tree")),"windows"=>success(json!([])),_=>panic!("unexpected launch or retry"),
                }
            });
            if accepted{assert_eq!(calls,vec!["apps","__activate","tree","windows"]);assert_eq!(result["success"],true);assert_eq!(result["data"]["pid"],2);}
            else{assert_eq!(calls,vec!["apps","__activate"]);assert_eq!(result["code"],"permission_denied");}
        }
    }
    #[test]fn open_rejects_invalid_launch_fields_before_execution(){
        assert!(validate("open",&json!({"type":"desktop_open","app":"fixture","activate":false})).is_ok());
        for action in [json!({"type":"desktop_open","activate":null}),json!({"type":"desktop_open","activate":1}),json!({"type":"desktop_open","app":""}),json!({"type":"desktop_open","pid":0}),json!({"type":"desktop_open","arguments":"bad"})]{assert!(validate("open",&action).is_err());}
    }
}
