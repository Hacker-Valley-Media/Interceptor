use crate::failure;
use base64::Engine;
use serde_json::{Value, json};
use std::{fs, io::Read, path::Path, sync::OnceLock};

pub(crate) type Result<T> = std::result::Result<T, Value>;
pub(crate) const REQUEST_BYTES: usize = 262144;
pub(crate) const RESULT_BYTES: usize = 131072;
pub(crate) fn spec() -> &'static Value {
    static SPEC: OnceLock<Value> = OnceLock::new();
    SPEC.get_or_init(|| serde_json::from_str(include_str!("../../shared/desktop-overlay-spec.json")).expect("checked overlay specification"))
}
fn invalid(text: &str) -> Value { failure("invalid_request", text) }
pub(crate) fn id(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 64 && s.bytes().enumerate().all(|(i,b)| b.is_ascii_alphanumeric() || i > 0 && b"._-".contains(&b)))
}
fn text(v: &Value, max: usize, empty: bool) -> bool { v.as_str().is_some_and(|s| (empty || !s.is_empty()) && s.len() <= max && !s.contains('\0')) }
fn number(v: &Value, lo: f64, hi: f64, integer: bool) -> bool { v.as_f64().is_some_and(|n| n.is_finite() && n >= lo && n <= hi && (!integer || n.fract() == 0.0)) }
fn fields(v: &Value, allowed: &[&str]) -> bool { v.as_object().is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str()))) }
fn listed(v: &Value, names: &[&str]) -> bool { v.as_str().is_some_and(|s| names.contains(&s)) }
pub(crate) fn bounded(v: &Value, max: usize) -> bool {
    fn visit(v: &Value, depth: usize, budget: &mut usize) -> bool {
        if depth > 16 || *budget == 0 { return false; } *budget -= 1;
        match v {
            Value::String(s) => s.len() <= REQUEST_BYTES && !s.contains('\0'),
            Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
            Value::Array(a) => a.len() <= 4096 && a.iter().all(|v| visit(v,depth+1,budget)),
            Value::Object(o) => o.len() <= 128 && o.iter().all(|(k,v)| !k.is_empty() && k.len() <= 128 && !k.contains('\0') && visit(v,depth+1,budget)),
            _ => true
        }
    }
    visit(v,0,&mut 32768) && serde_json::to_vec(v).is_ok_and(|b| b.len() <= max)
}
pub(crate) fn emojis(v: &Value) -> Option<Vec<String>> {
    use unicode_segmentation::UnicodeSegmentation;
    let rows = if let Some(s) = v.as_str() { s.split(',').map(|s| s.trim().to_owned()).collect::<Vec<_>>() }
        else { v.as_array()?.iter().map(|v| v.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>()? };
    (!rows.is_empty() && rows.len() <= 32 && rows.iter().all(|s| !s.is_empty() && s.len() <= 128 && !s.contains('\0') && s.graphemes(true).count() <= 8)).then_some(rows)
}
fn color(v: &Value) -> bool { v.as_str().is_some_and(|s| ["red","blue","green","yellow","orange","purple","white","black"].contains(&s.to_ascii_lowercase().as_str()) || s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())) }
pub(crate) fn entity(v: &Value) -> Result<()> {
    if !fields(v,&["id","emoji","x","y","size","facing"]) || !id(&v["id"]) { return Err(invalid("scene entity requires an exact safe ID and known fields")); }
    if v.get("emoji").is_some_and(|e| emojis(&json!([e])).is_none()) { return Err(invalid("invalid scene emoji")); }
    for key in ["x","y"] { if v.get(key).is_some_and(|n| !number(n,0.0,1.0,false)) { return Err(invalid("invalid normalized scene position")); } }
    if v.get("size").is_some_and(|n| !number(n,1.0,512.0,false)) || v.get("facing").is_some_and(|s| !listed(s,&["left","right"])) { return Err(invalid("invalid entity size or facing")); }
    Ok(())
}
pub(crate) fn ops(v: &Value) -> Result<()> {
    let rows = v.as_array().filter(|a| a.len() <= 4096).ok_or_else(|| invalid("scene operations require an array of at most 4096 rows"))?;
    if !bounded(v,REQUEST_BYTES) { return Err(invalid("scene operation JSON exceeds its bound")); }
    let mut cost = 0_u64;
    for row in rows {
        let name = row["op"].as_str().ok_or_else(|| invalid("scene operation requires an exact name"))?;
        let allowed = spec()["ops"][name].as_array().ok_or_else(|| invalid("unknown scene operation"))?;
        if row.as_object().is_none_or(|o| o.keys().any(|k| k != "at" && k != "op" && !allowed.contains(&json!(k)))) { return Err(invalid("unknown scene operation field")); }
        for (key,v) in row.as_object().unwrap() {
            let key = key.as_str();
            let bound = match key {
                "at" => Some((0.0,86400.0,false)), "duration"|"lifetime" => Some((0.001,300.0,false)),
                "x"|"y"|"fromX"|"fromY"|"toX"|"toY" => Some((0.0,1.0,false)), "dx"|"dy" => Some((-1.0,1.0,false)),
                "angle" => Some((-100.0,100.0,false)), "scale" => Some((0.01,8.0,false)), "alpha"|"amount" => Some((0.0,1.0,false)),
                "amplitude"|"cornerRadius"|"magnitude" => Some((0.0,512.0,false)), "spread" => Some((0.0,4096.0,false)),
                "count" => Some((1.0,128.0,true)), "fontSize" => Some((1.0,256.0,false)), "width" => Some((0.001,1.0,false)),
                "height" => Some((0.001,if name == "jump" {4096.0} else {1.0},false)), "lineWidth" => Some((0.1,64.0,false)), _ => None
            };
            if bound.is_some_and(|(lo,hi,i)| !number(v,lo,hi,i)) { return Err(invalid("invalid finite bounded scene number")); }
            if ["color","hitColor"].contains(&key) && !color(v) || ["id","from","to"].contains(&key) && !id(v)
                || ["text","font"].contains(&key) && !text(v,if key == "font" {128} else {4096},key == "text")
                || key == "emoji" && emojis(&json!([v])).is_none() || key == "emojis" && emojis(v).is_none()
                || key == "dir" && !listed(v,&["left","right"]) || key == "easing" && !listed(v,&["linear","easeIn","easeOut","easeInOut"]) { return Err(invalid("invalid bounded scene value")); }
        }
        if let Some(target) = row.get("target") {
            let ids = if target.is_string() { vec![target] } else { target.as_array().filter(|a| !a.is_empty() && a.len() <= 128).ok_or_else(|| invalid("invalid scene target"))?.iter().collect() };
            let mut seen = std::collections::HashSet::new();
            if ids.iter().any(|v| **v != json!("all") && !id(v) || !seen.insert(v.as_str())) || ["knockout","roar","bow","despawn"].contains(&name) && (!target.is_string() || target == "all") { return Err(invalid("scene target requires exact distinct IDs")); }
        } else if allowed.contains(&json!("target")) && name != "shake" { return Err(invalid("scene operation requires a target")); }
        if name == "throw" && (row.get("from").is_none() && (row.get("fromX").is_none() || row.get("fromY").is_none()) || row.get("to").is_none() && (row.get("toX").is_none() || row.get("toY").is_none())) { return Err(invalid("throw requires source and destination entities or points")); }
        if name == "spawn" { entity(&row["entity"])?; }
        cost += if name == "burst" { row["count"].as_f64().unwrap_or(18.0) as u64 } else if ["impact","knockout"].contains(&name) {48} else {1};
        if cost > 65536 { return Err(invalid("scene effect admission exceeds 65536")); }
    }
    Ok(())
}
pub(crate) fn script(v: &Value) -> Result<()> {
    if !fields(v,&["banner","entities","timeline","background"]) || !bounded(v,REQUEST_BYTES) { return Err(invalid("scene script requires bounded known fields")); }
    if v.get("background").is_some_and(|s| s != "transparent" && !color(s)) { return Err(invalid("invalid scene background")); }
    if let Some(b) = v.get("banner") {
        if !fields(b,&["text","y","fontSize","color"]) || !text(&b["text"],4096,true)
            || b.get("y").is_some_and(|n| !number(n,0.0,1.0,false)) || b.get("fontSize").is_some_and(|n| !number(n,1.0,256.0,false)) || b.get("color").is_some_and(|s| !color(s)) { return Err(invalid("invalid scene banner")); }
    }
    if let Some(v) = v.get("entities") {
        let rows = v.as_array().filter(|a| a.len() <= 128).ok_or_else(|| invalid("scene entities exceed 128"))?;
        let mut seen = std::collections::HashSet::new();
        for row in rows { entity(row)?; if !seen.insert(row["id"].as_str()) { return Err(invalid("duplicate scene entity ID")); } }
    }
    if let Some(v) = v.get("timeline") { ops(v)?; } Ok(())
}
pub(crate) fn control(mode: &str, verb: &str, raw: &Value) -> Result<Value> {
    let mut args: Value = if let Some(s) = raw.as_str() { if s.len() > RESULT_BYTES { return Err(invalid("control JSON exceeds 128KiB")); } serde_json::from_str(s).map_err(|_| invalid("malformed control JSON"))? } else if raw.is_null() { json!({}) } else { raw.clone() };
    let allowed = spec()["controls"][mode][verb].as_array().ok_or_else(|| invalid("unknown controller verb for this mode"))?;
    if !bounded(&args,RESULT_BYTES) || args.as_object().is_none_or(|o| o.keys().any(|k| !allowed.contains(&json!(k)))) { return Err(invalid("unknown or oversized controller argument")); }
    if mode == "particles" {
        let bound = match verb { "set-density" => Some((0.0,128.0)), "set-lifetime" => Some((0.05,60.0)), "set-velocity" => Some((0.0,4096.0)), "set-scale" => Some((0.05,8.0)), _ => None };
        if bound.is_some_and(|(lo,hi)| !number(&args["value"],lo,hi,false)) || verb == "set-direction" && !listed(&args["value"],&["up","down","left","right"]) || verb == "set-emojis" && emojis(&args["value"]).is_none() || args.get("count").is_some_and(|n| !number(n,1.0,64.0,false)) { return Err(invalid("invalid bounded particle argument")); }
    }
    if mode == "scene" {
        if args.get("who").is_some_and(|s| !s.as_str().is_some_and(|s| ["kong","k","godzilla","g","gz"].contains(&s.to_ascii_lowercase().as_str()))) || args.get("emoji").is_some_and(|s| emojis(&json!([s])).is_none()) || args.get("color").is_some_and(|s| !color(s)) { return Err(invalid("invalid fighter argument")); }
        for (key,lo,hi) in [("n",1.0,100000.0),("height",0.0,4096.0),("amount",0.0,1.0)] { if args.get(key).is_some_and(|n| !number(n,lo,hi,key == "n")) { return Err(invalid("invalid finite fighter control")); } }
    }
    if verb == "say" && args.get("text").is_none() || args.get("text").is_some_and(|s| !text(s,4096,true)) { return Err(invalid("say requires bounded text")); }
    if mode == "scene-script" {
        for key in ["ops","json","entity"] { if let Some(s) = args[key].as_str() { let value = serde_json::from_str(s).map_err(|_| invalid("malformed nested scene JSON"))?; args[key] = value; } }
        match verb { "append-ops" => ops(&args["ops"])? , "append-script" => script(&args["json"])? , "spawn" => entity(&args["entity"])? , "despawn" if !id(&args["id"]) => return Err(invalid("despawn requires an exact entity ID")), _ => () }
        if args.get("relative").is_some_and(|v| !v.is_boolean()) || args.get("fps").is_some_and(|n| !number(n,1.0,30.0,false)) { return Err(invalid("invalid tracking or relative argument")); }
    }
    Ok(args)
}
pub(crate) fn validate(a: &Value) -> Result<&str> {
    if a["type"] != "desktop_overlay" || !bounded(a,REQUEST_BYTES) { return Err(invalid("overlay requires bounded desktop_overlay action")); }
    let sub = a["sub"].as_str().ok_or_else(|| invalid("overlay requires an exact selector"))?;
    let allowed = spec()["selectors"][sub].as_array().ok_or_else(|| invalid("unknown overlay selector"))?;
    if a.as_object().unwrap().keys().any(|k| !["type","sub","id","groupColor","groupSoft"].contains(&k.as_str()) && !allowed.contains(&json!(k))) { return Err(invalid("unknown overlay field")); }
    if a.get("id").is_some_and(|v| !id(v)) || sub == "list" && a.get("id").is_some() || ["eval","ctl"].contains(&sub) && !id(&a["id"]) { return Err(invalid("overlay selector requires an exact safe ID")); }
    for key in ["interactive","single_space","no_fullscreen_aux","visible","groupSoft"] { if a.get(key).is_some_and(|v| !v.is_boolean()) { return Err(invalid("overlay flags require Boolean values")); } }
    if a.get("groupColor").is_some_and(|s| !text(s,128,false)) { return Err(invalid("invalid overlay group color")); }
    if a.get("timeout_seconds").is_some_and(|n| !number(n,0.001,if sub == "eval" {30.0} else {86400.0},false)) { return Err(invalid("invalid bounded overlay timeout")); }
    if sub == "eval" && (a.get("js").is_some() == a.get("javascript").is_some() || !text(a.get("js").unwrap_or(&a["javascript"]),32768,false)) { return Err(invalid("overlay eval requires one bounded JavaScript source")); }
    if sub == "ctl" && (!text(&a["verb"],64,false) || a.get("args").is_some_and(|v| !v.is_object() && !v.is_string())) { return Err(invalid("overlay ctl requires verb and argument object")); }
    if sub != "start" { return Ok(sub); }
    let sources = ["scene","scene_script","scene_script_file","particles","html_b64","url"].into_iter().filter(|k| a.get(*k).is_some()).collect::<Vec<_>>();
    if sources.len() != 1 || !text(&a[sources[0]],if ["scene_script","html_b64"].contains(&sources[0]) {REQUEST_BYTES} else {4096},false) { return Err(invalid("overlay start requires one bounded content source")); }
    if a.get("scene").is_some_and(|s| s != "titans") || a.get("particles").is_some_and(|s| !listed(s,&["roses","hearts","petals","stars","snow","confetti","titans","fire","beams","custom"])) { return Err(invalid("unknown overlay preset")); }
    if a.get("level").is_some_and(|s| !listed(s,&["statusBar","mainMenu","floating","screenSaver"])) || a.get("anchor").is_some_and(|s| !listed(s,&["tl","tr","bl","br","top","bottom","left","right","center"])) || a.get("direction").is_some_and(|s| !listed(s,&["up","down","left","right"])) { return Err(invalid("unknown overlay placement or direction")); }
    if a.get("particles").is_none() && ["emojis","density","direction","lifetime","velocity","size_scale"].iter().any(|k| a.get(*k).is_some()) || a.get("emojis").is_some_and(|v| emojis(v).is_none()) { return Err(invalid("invalid bounded particle settings")); }
    for (key,lo,hi) in [("density",0.0,128.0),("lifetime",0.05,60.0),("velocity",0.0,4096.0),("size_scale",0.05,8.0),("width",1.0,16384.0),("height",1.0,16384.0),("display_id",1.0,9007199254740991.0)] { if a.get(key).is_some_and(|n| !number(n,lo,hi,key == "display_id")) { return Err(invalid("invalid finite bounded overlay number")); } }
    if a.get("particles").is_some() && a["density"].as_f64().unwrap_or(12.0) * a["lifetime"].as_f64().unwrap_or(5.0) > spec()["limits"]["portableParticles"].as_f64().unwrap() { return Err(failure("resource_limit","portable particle density/lifetime exceeds 1888; the renderer reserves space for bounded frame emission and bursts")); }
    if a.get("anchor").is_none() && a.get("rect").is_none() && (a.get("width").is_some() || a.get("height").is_some()) || a.get("rect").is_some() && ["anchor","width","height"].iter().any(|k| a.get(*k).is_some()) { return Err(invalid("overlay rectangle and anchor sizing are exclusive")); }
    if let Some(r) = a.get("rect") { if !fields(r,&["x","y","width","height"]) || !number(&r["width"],1.0,16384.0,false) || !number(&r["height"],1.0,16384.0,false) || ["x","y"].iter().any(|k| r.get(*k).is_some_and(|n| !number(n,-131072.0,131072.0,false))) { return Err(invalid("invalid overlay rectangle")); } }
    if let Some(s) = a["html_b64"].as_str() { let decoded = base64::engine::general_purpose::STANDARD.decode(s).map_err(|_| invalid("malformed HTML base64"))?; if decoded.len() > RESULT_BYTES || base64::engine::general_purpose::STANDARD.encode(&decoded) != s || std::str::from_utf8(&decoded).is_err() { return Err(invalid("HTML requires canonical UTF-8 base64 up to 128KiB")); } }
    if let Some(s) = a["url"].as_str() { let url = reqwest::Url::parse(s).map_err(|_| invalid("invalid overlay URL"))?; if !["http","https"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() || url.host_str().is_none() { return Err(invalid("overlay URL requires HTTP(S) without inline credentials")); } }
    if let Some(s) = a["scene_script"].as_str() { let script_value: Value = serde_json::from_str(s).map_err(|_| invalid("malformed scene script"))?; script(&script_value)?; }
    if let Some(s) = a["scene_script_file"].as_str() { if !Path::new(s).is_absolute() { return Err(invalid("scene script file requires an absolute path")); } }
    Ok(sub)
}
pub(crate) fn prepare(a: &Value) -> Result<Value> {
    validate(a)?; let mut a = a.clone();
    let parsed = if let Some(path) = a["scene_script_file"].as_str() {
        let mut opts = fs::OpenOptions::new(); opts.read(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC); }
        #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; opts.custom_flags(0x00200000); }
        let mut file = opts.open(path).map_err(|_| invalid("scene script file could not be opened"))?;
        let before = file.metadata().map_err(|_| invalid("scene script file metadata unavailable"))?;
        #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if before.file_attributes() & 0x400 != 0 { return Err(invalid("scene script reparse points are refused")); } }
        if !before.is_file() || before.len() == 0 || before.len() > REQUEST_BYTES as u64 { return Err(invalid("scene script requires a regular file up to 256KiB")); }
        let mut bytes = Vec::new(); file.by_ref().take((REQUEST_BYTES+1) as u64).read_to_end(&mut bytes).map_err(|_| invalid("scene script file read failed"))?;
        let after = file.metadata().map_err(|_| invalid("scene script file disappeared"))?;
        if bytes.len() as u64 != before.len() || after.len() != before.len() || after.modified().ok() != before.modified().ok() { return Err(invalid("scene script file changed during read")); }
        Some(serde_json::from_slice(&bytes).map_err(|_| invalid("scene script file contains invalid JSON"))?)
    } else if let Some(s) = a["scene_script"].as_str() { Some(serde_json::from_str(s).map_err(|_| invalid("scene script contains invalid JSON"))?) } else { None };
    if let Some(v) = parsed { script(&v)?; a.as_object_mut().unwrap().remove("scene_script_file"); a["scene_script"] = json!(serde_json::to_string(&v).map_err(|_| invalid("scene serialization failed"))?); }
    Ok(a)
}
