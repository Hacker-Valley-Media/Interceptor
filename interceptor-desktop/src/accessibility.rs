use crate::failure;
use serde_json::{Value, json};
use std::sync::OnceLock;
#[cfg(not(windows))] use std::io::Read;

static REF_EPOCH: OnceLock<u128> = OnceLock::new();
pub fn initialize_refs() -> std::io::Result<()> {
    #[cfg(windows)] let epoch = unsafe { windows::Win32::System::Com::CoCreateGuid() }
        .map_err(std::io::Error::other)?.to_u128();
    #[cfg(not(windows))] let epoch = {
        let mut bytes = [0; 16]; std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?; u128::from_le_bytes(bytes)
    };
    REF_EPOCH.set(epoch).map_err(|_| std::io::Error::other("reference epoch already initialized"))
}
pub fn reference(serial: u64) -> String {
    format!("e{:039}{serial:020}", REF_EPOCH.get().expect("reference epoch initialized before serving"))
}

// JSON has one number type. Canonicalize integral decimal/exponent forms so
// validation and native integer accessors agree without truncating fractions.
pub fn normalize_integer_fields(action: &mut Value) {
    let Some(fields) = action.as_object_mut() else { return; };
    for key in ["width", "height", "x", "y", "pid", "window", "depth", "maxChars", "maxNodes", "maxMs", "amount", "times", "intervalMs"] {
        let Some(value) = fields.get_mut(key) else { continue; };
        if value.as_i64().is_some() { continue; }
        if let Some(number) = value.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0) {
            *value = json!(number as i64);
        }
    }
}

// These checks run before either OS worker receives a request. Unsupported
// variants cannot fall through to a broader target or a legacy macOS handler.
pub fn validate(verb: &str, action: &Value) -> Result<(), Value> {
    let operation = format!("desktop_{verb}");
    if !crate::contract_generated::DESKTOP_ACCESSIBILITY_OPERATIONS.contains(&operation.as_str()) {
        return Err(failure("unsupported_operation", format!("desktop operation {verb} is not implemented")));
    }
    if let Some(error) = crate::contract_generated::desktop_accessibility_shape_error(action) {
        return Err(failure("invalid_request", error));
    }
    if action["type"] != operation { return Err(failure("invalid_request", "action discriminator does not match operation")); }
    for (key, value) in action.as_object().ok_or_else(|| failure("invalid_request", "action must be an object"))? {
        let valid = match key.as_str() {
            "width" | "height" => value.as_i64().is_some_and(|n| n > 0 && n <= i32::MAX as i64),
            "x" | "y" => value.as_i64().is_some_and(|n| i32::try_from(n).is_ok()),
            "pid" => value.as_u64().is_some_and(|n| n > 0 && n <= i32::MAX as u64),
            "window" => value.as_u64().is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991),
            "depth" | "maxChars" | "maxNodes" | "maxMs" => value.as_u64().is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991),
            "double" | "right" | "groupSoft" | "sensitive" | "backgroundOnly" => value.is_boolean(),
            "amount" | "times" => value.as_u64().is_some_and(|n| n > 0 && n <= 10000),
            "intervalMs" => value.as_u64().is_some_and(|n| n <= 1000),
            "items" => value.as_array().is_some_and(|items| items.len() <= 16 && items.iter().all(|v| v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 256 && !s.contains('\0')))),
            "ref" | "from" | "to" => value.as_str().is_some_and(|s| s.len() > 1 && s.len() <= 64 && s.starts_with('e') && s[1..].bytes().all(|b| b.is_ascii_digit())),
            "app" | "bundleId" | "query" | "role" | "action" | "filter" | "mode" | "sub" | "windowTitle" => value.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0')),
            "coords" | "fromCoords" | "toCoords" => value.as_str().is_some_and(|s| {
                let parts: Vec<_> = s.split(',').collect();
                parts.len() == 2 && parts.iter().all(|p| p.parse::<i32>().is_ok())
            }),
            "windowBounds" => value.as_object().is_some_and(|bounds| bounds.iter().all(|(field, value)| value.as_f64().is_some_and(|n|
                n.is_finite() && n.abs() <= 9_007_199_254_740_991.0 && (!["width", "height"].contains(&field.as_str()) || n > 0.0)))),
            "expectedIdentity" => crate::secret_target::valid(value),
            "secretBindingName" => value.as_str().is_some_and(|name|!name.is_empty()&&name.len()<=64&&name.bytes().enumerate().all(|(index,byte)|byte.is_ascii_alphanumeric()||(index>0&&b"._-".contains(&byte)))),
            "secretLease" => value.as_str().is_some_and(|token|token.len()==64&&token.bytes().all(|byte|byte.is_ascii_hexdigit())),
            _ => value.as_str().is_some_and(|s| !s.contains('\0')),
        };
        // Name the allowed range where there is one.
        if !valid { return Err(failure("invalid_request", match key.as_str() { "amount" | "times" => format!("invalid {key} field; expected an integer from 1 to 10000"), "intervalMs" => "invalid intervalMs field; expected an integer from 0 to 1000".to_owned(), _ => format!("invalid {key} field") })); }
    }
    if verb == "app" {
        if action["subcommand"].as_str().unwrap_or("activate") == "launch" {
            if action.get("bundleId").is_none() || action.get("app").is_some() || action.get("pid").is_some() {
                return Err(failure("invalid_request", "app launch requires only a bundleId target"));
            }
        } else if action.get("app").is_some() == action.get("pid").is_some() || action.get("bundleId").is_some() {
            return Err(failure("invalid_request", "app lifecycle requires exactly one app or pid target"));
        }
    }
    if action.get("expectedIdentity").is_some()&&(verb!="type"||action["ref"].as_str().is_none()||action["sensitive"]!=true||action["backgroundOnly"]!=true||action.get("secretLease").is_none()||action.get("secretBindingName").is_none()){
        return Err(failure("invalid_request","identity-bound text requires a sensitive background-only reference target"));
    }
    if action.get("secretLease").is_some()&&action.get("secretBindingName").is_none()||verb=="type"&&action.get("secretBindingName").is_some()&&action.get("expectedIdentity").is_none(){return Err(failure("invalid_request","native credential grant fields require a complete binding"));}
    if verb == "click" && action.get("ref").is_none() && action.get("coords").is_none() {
        return Err(failure("invalid_request", "click requires a ref or coordinates"));
    }
    if action["backgroundOnly"]==true&&["click","type","keys","scroll","drag"].contains(&verb)
        &&["app","pid","window","ref","from"].iter().all(|key|action.get(*key).is_none())
        &&!(action["windowTitle"].is_string()&&action["windowBounds"].is_object()){
        return Err(failure("invalid_request","background input requires an explicit native target or an exact title and frame"));
    }
    if verb == "drag" && !((action.get("from").is_some() && action.get("to").is_some() && action.get("fromCoords").is_none() && action.get("toCoords").is_none()) ||
        (action.get("fromCoords").is_some() && action.get("toCoords").is_some() && action.get("from").is_none() && action.get("to").is_none())) {
        return Err(failure("invalid_request", "drag requires two refs or two coordinate pairs"));
    }
    if verb == "click" && action.get("ref").is_some() && action.get("coords").is_some() {
        return Err(failure("invalid_request", "click requires exactly one ref or coordinate pair"));
    }
    if verb == "keys" && action["keys"].as_str().is_none_or(|s| s.is_empty() || s.len()>128) {
        return Err(failure("invalid_request", "keys requires a bounded key combination"));
    }
    if verb == "scroll" && action["times"].as_u64().unwrap_or(1).saturating_mul(action["intervalMs"].as_u64().unwrap_or(0)) > 2000 {
        return Err(failure("invalid_request", "scroll repetitions exceed the two second delivery budget"));
    }
    Ok(())
}

pub fn display_role(role: &str) -> String { role.strip_prefix("AX").unwrap_or(role).to_lowercase() }

// Match the existing Swift geometry reply using the observed outer frame.
pub fn geometry_response(frame: Value, verb: &str, action: &Value) -> Value {
    let fields = if verb == "resize" { ["width", "height"] } else { ["x", "y"] };
    let requested: serde_json::Map<String, Value> = fields.into_iter().map(|key| (key.to_owned(), action[key].clone())).collect();
    let clamped = requested.iter().any(|(key, value)| frame[key].as_i64() != value.as_i64());
    json!({"frame":frame,"requested":requested,"clamped":clamped})
}

pub fn tree_line(node: &Value, depth: usize, filter: &str) -> Option<String> {
    let role = node["role"].as_str().unwrap_or("unknown");
    let interactive = ["button", "textfield", "textarea", "checkbox", "radiobutton", "popupbutton", "combobox", "slider",
        "menu", "menuitem", "menubutton", "link", "tab", "tabgroup", "toolbar", "list", "table", "outline",
        "disclosuretriangle", "incrementor", "colorwell", "segmentedcontrol", "switch", "toggle", "datepicker", "stepper", "searchfield"].contains(&role);
    let landmark = ["heading", "group", "scrollarea", "splitgroup", "window", "sheet", "drawer"].contains(&role);
    if (filter == "interactive" && !interactive) || (filter == "all" && !(interactive || landmark)) { return None; }
    let mut line = format!("{}[{}] {}", "  ".repeat(depth), node["ref"].as_str().unwrap_or(""), role);
    let label = node["name"].as_str().unwrap_or("");
    if !label.is_empty() { line.push_str(&format!(" {label:?}")); }
    if let Some(value) = node["value"].as_str().filter(|v| !v.is_empty() && *v != label) { line.push_str(&format!(" value={value:?}")); }
    line.push('\n'); Some(line)
}

pub fn matches(node: &Value, action: &Value) -> bool {
    let query = action["query"].as_str().unwrap_or("").to_lowercase();
    let role = node["role"].as_str().unwrap_or("");
    let searchable = format!("{} {} {role}", node["name"].as_str().unwrap_or(""), node["value"].as_str().unwrap_or("")).to_lowercase();
    searchable.contains(&query) && action["role"].as_str().is_none_or(|r| role.contains(&display_role(r)))
}

#[cfg(test)] mod tests {
    #[test] fn background_input_never_implicitly_selects_the_frontmost_window(){
        use super::*;
        for action in [json!({"type":"desktop_type","text":"fixture","backgroundOnly":true}),json!({"type":"desktop_keys","keys":"Enter","backgroundOnly":true}),json!({"type":"desktop_click","coords":"1,2","backgroundOnly":true}),json!({"type":"desktop_scroll","direction":"down","amount":10,"backgroundOnly":true})]{
            let verb=action["type"].as_str().unwrap().strip_prefix("desktop_").unwrap();
            assert_eq!(validate(verb,&action).unwrap_err()["code"],"invalid_request");
            let mut targeted=action.clone();targeted["windowTitle"]=json!("Owned fixture");targeted["windowBounds"]=json!({"left":0,"top":0,"width":800,"height":600});
            assert!(validate(verb,&targeted).is_ok());
        }
    }
    #[test] fn native_reply_models_preserve_untagged_values_and_refuse_malformed_fields() {
        use crate::contract_generated::*;
        use serde::{Serialize, de::DeserializeOwned};
        fn round_trip<T: DeserializeOwned + Serialize>(value: serde_json::Value) {
            let decoded: T = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), value);
        }
        let frame = json!({"x":1.0,"y":2.0,"width":400.0,"height":200.0});
        let linux = json!({"ref":"e1","role":"textfield","nativeRole":"entry","name":"Owned fixture","title":"Owned fixture","value":"🙂 文件","pid":42.0,"secure":false,"frame":null});
        let mut windows = linux.clone(); windows["nativeRole"] = json!(50004.0); windows["frame"] = frame.clone();
        round_trip::<DesktopAxAppsData>(json!([{"name":"Finder","pid":42.0,"bundleId":"com.apple.finder","active":false,"hidden":true}]));
        round_trip::<DesktopAxAppsData>(json!([{"name":"Owned fixture","pid":42.0}]));
        round_trip::<DesktopAxWindowsData>(json!([{"ref":"e1","title":"Owned fixture","windowId":42.0,"frame":frame}]));
        round_trip::<DesktopAxFindData>(json!([linux]));
        round_trip::<DesktopAxFindData>(json!([windows]));
        round_trip::<DesktopAxFocusedData>(json!(null));
        round_trip::<DesktopAxFrontmostData>(json!(null));
        round_trip::<DesktopAxInspectData>(json!({"AXRole":"AXTextField","AXValue":"🙂 文件","frame":frame,"actions":["AXPress"]}));
        round_trip::<DesktopAxTypeData>(json!("typed"));
        round_trip::<DesktopAxTypeData>(json!({"method":"owned fixture","background":true,"targetPid":42.0}));
        round_trip::<DesktopAxMenuData>(json!([{"title":"File","enabled":true,"children":[{"title":"Owned item","enabled":false,"children":[]}]}]));
        round_trip::<DesktopAxMenuData>(json!([{"title":"File","id":1.0,"enabled":true,"children":[]}]));
        round_trip::<DesktopAxAppData>(json!({"subcommand":"hide","pid":42.0,"method":"owned fixture","window":"42"}));
        round_trip::<DesktopAxResizeData>(json!({"frame":frame,"requested":{"width":400.0,"height":200.0},"clamped":false}));
        for value in [
            json!({"method":"owned fixture","background":true,"unexpected":true}),
            json!({"method":"owned fixture","background":true,"targetPid":null}),
            json!({"method":"owned fixture","background":"true"}),
            json!({"method":"owned fixture"}),
        ] {
            assert!(serde_json::from_value::<DesktopAxNativeInputData>(value.clone()).is_err());
            assert!(serde_json::from_value::<DesktopAxTypeData>(value).is_err());
        }
        assert!(serde_json::from_value::<DesktopAxDarwinWindow>(json!({"ref":"e1","title":"Owned fixture","frame":{"x":1,"y":2,"width":3,"height":4,"unexpected":true}})).is_err());
        assert!(serde_json::from_value::<DesktopAxDarwinWindow>(json!({"ref":"e1","title":"Owned fixture","windowId":null})).is_err());
        assert!(serde_json::from_value::<DesktopAxLinuxMenuEntry>(json!({"title":"File","enabled":true,"children":[{"title":"bad","enabled":"true","children":[]}]})).is_err());
    }
    #[test] fn selected_text_keeps_strict_modes_and_selectors() {
        use super::*;
        for mode in ["full", "selection", "visible"] {
            assert!(validate("text", &json!({"type":"desktop_text","ref":"e42","mode":mode,"pid":42})).is_ok());
        }
        for action in [json!({"type":"desktop_text","ref":"e42","mode":null}), json!({"type":"desktop_text","ref":"e42","mode":"selected"}), json!({"type":"desktop_text","ref":"e42","pid":1.5})] {
            assert_eq!(validate("text", &action).unwrap_err()["code"], "invalid_request");
        }
    }
    use super::*; use serde_json::json;
    #[test] fn integral_json_forms_reach_native_integer_accessors_without_truncation() {
        for raw in [
            r#"{"type":"desktop_windows","pid":42.0}"#,
            r#"{"type":"desktop_tree","pid":42e0,"depth":2.0,"maxNodes":1000e0,"maxChars":9007199254740991.0,"maxMs":2000.0}"#,
            r#"{"type":"desktop_resize","ref":"e1","width":500.0,"height":3.32e2}"#,
            r#"{"type":"desktop_move","ref":"e1","x":-100.0,"y":-0.0}"#,
        ] {
            let mut action: Value = serde_json::from_str(raw).unwrap();
            normalize_integer_fields(&mut action);
            let verb = action["type"].as_str().unwrap().strip_prefix("desktop_").unwrap();
            assert!(validate(verb, &action).is_ok(), "{raw}: {action}");
            for (key, value) in action.as_object().unwrap() {
                if value.is_number() { assert!(value.as_i64().is_some(), "{key}: {raw}"); }
            }
            if verb == "tree" { assert_eq!(action["maxChars"].as_u64(), Some(9_007_199_254_740_991)); }
            if verb == "move" { assert_eq!(action["x"].as_i64(), Some(-100)); assert_eq!(action["y"].as_i64(), Some(0)); }
        }
        for raw in [
            r#"{"type":"desktop_windows","pid":42.5}"#,
            r#"{"type":"desktop_windows","pid":true}"#,
            r#"{"type":"desktop_windows","pid":"42.0"}"#,
            r#"{"type":"desktop_windows","pid":9007199254740992.0}"#,
            r#"{"type":"desktop_move","ref":"e1","x":2147483648.0,"y":0.0}"#,
            r#"{"type":"desktop_resize","ref":"e1","width":-0.0,"height":100.0}"#,
        ] {
            let mut action: Value = serde_json::from_str(raw).unwrap();
            normalize_integer_fields(&mut action);
            let verb = action["type"].as_str().unwrap().strip_prefix("desktop_").unwrap();
            assert_eq!(validate(verb, &action).unwrap_err()["code"], "invalid_request", "{raw}");
        }
    }
    #[test] fn geometry_reply_reports_observed_frame_and_exact_requested_axes() {
        let frame = json!({"x":100,"y":100,"width":602,"height":505});
        let result = geometry_response(frame.clone(), "resize", &json!({"width":600,"height":480,"x":999}));
        assert_eq!(result["frame"],frame);
        assert_eq!(result["requested"],json!({"width":600,"height":480}));
        assert_eq!(result["clamped"],true);
        let result = geometry_response(frame.clone(), "move", &json!({"x":100,"y":100}));
        assert_eq!(result["frame"],frame);
        assert_eq!(result["requested"],json!({"x":100,"y":100}));
        assert_eq!(result["clamped"],false);
    }
    #[test] fn shared_accessibility_fixtures_reject_before_native_dispatch() {
        let fixture: Value = serde_json::from_str(include_str!("../../shared/desktop-accessibility-fixtures.json")).unwrap();
        for action in fixture["valid"].as_array().unwrap() {
            let verb = action["type"].as_str().unwrap().strip_prefix("desktop_").unwrap();
            assert!(validate(verb, action).is_ok(), "{action}");
        }
        for record in fixture["invalid"].as_array().unwrap() {
            let action = &record["action"];
            let verb = action["type"].as_str().unwrap().strip_prefix("desktop_").unwrap();
            let result = validate(verb, action).expect_err(&action.to_string());
            assert_eq!(result["code"], "invalid_request", "{action}");
        }
        for action in fixture["supportedVariants"].as_array().unwrap() {
            let verb = action["type"].as_str().unwrap().strip_prefix("desktop_").unwrap();
            assert!(validate(verb, action).is_ok(), "{action}");
        }
        let key = "x".repeat(5000);
        let result = validate("value", &json!({"type":"desktop_value","ref":"e1",key:true})).unwrap_err();
        assert_eq!(result["code"], "invalid_request");
        assert!(result["error"].as_str().unwrap().len() <= 2048);
    }
    #[test] fn malformed_selectors_and_unsupported_fields_never_reach_a_worker() {
        assert!(validate("type", &json!({"type":"desktop_type","ref":"e1","text":"a🙂","pid":42})).is_ok());
        for action in [json!({"pid":"42"}), json!({"pid":null}), json!({"pid":0}), json!({"window":-1}),
            json!({"pid":1.5}), json!({"app":""}), json!({"app":"a\u{0000}b"}), json!({"ref":"e1","text":"x","secret":"vault"})] {
            assert!(validate("type", &action).is_err());
        }
        assert!(validate("type", &json!({"type":"desktop_type","ref":"e1","text":""})).is_ok());
        assert!(validate("text", &json!({"ref":"e1","mode":"selection"})).is_err());
        assert!(validate("click", &json!({"type":"desktop_click","ref":"e1","right":false,"double":false})).is_ok());
        assert!(validate("click", &json!({"ref":"e1","right":"false"})).is_err());
        assert!(validate("runtime", &json!({})).is_err());
        let node=json!({"ref":"e1","role":"textfield","name":"Input","value":"hello"});
        assert_eq!(tree_line(&node,1,"interactive").unwrap(), "  [e1] textfield \"Input\" value=\"hello\"\n");
        assert!(matches(&node,&json!({"query":"hello","role":"AXTextField"})));
        assert!(!matches(&node,&json!({"query":"hello","role":"button"})));
    }
    #[test] fn references_preserve_cli_syntax_and_do_not_reuse_a_counter() {
        initialize_refs().unwrap();
        let first=reference(1); let second=reference(2);
        assert_ne!(first, second); assert_eq!(first.len(),60);
        assert!(validate("value", &json!({"type":"desktop_value","ref":first})).is_ok());
    }
}
