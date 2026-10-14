//! Input addresses only the retained QEMU guest. Positive QMP submission
//! does not establish that a guest driver or application consumed events.
use crate::{contract_generated::DesktopVmQmpKeyCode, failure};
use serde_json::{json, Value};
type Result<T> = std::result::Result<T, Value>;
pub(crate) const DISPLAY: &str = "itc-display";
pub(crate) const POINTER: &str = "/machine/peripheral/itc-input-pointer";
// Version-matched include/ui/input.h, not its inconsistent QAPI comment.
const ABS_MAX: f64 = 0x7FFF as f64;

pub(crate) fn chord(text: &str) -> Result<Vec<String>> {
    if text.is_empty() || text.len() > 256 || text.contains('\0') || !text.is_ascii() {
        return Err(failure("invalid_request", "guest physical chord is empty or oversized"));
    }
    let parts = text.split('+').map(|s| s.trim().to_ascii_lowercase()).collect::<Vec<_>>();
    if parts.len() > 8 || parts.iter().any(String::is_empty) {
        return Err(failure("invalid_request", "guest chord needs at most 8 nonempty keys"));
    }
    let mut keys = Vec::new();
    for part in parts {
        let key = match part.as_str() {
            "command" | "cmd" | "meta" | "super" | "win" => "meta_l",
            "control" => "ctrl", "option" => "alt",
            "enter" | "return" => "ret", "space" => "spc", "escape" => "esc",
            "pageup" => "pgup", "pagedown" => "pgdn",
            "-" => "minus", "=" => "equal", "[" => "bracket_left", "]" => "bracket_right",
            ";" => "semicolon", "'" => "apostrophe", "`" => "grave_accent", "\\" => "backslash",
            "," => "comma", "." => "dot", "/" => "slash", other => other,
        }.to_owned();
        serde_json::from_value::<DesktopVmQmpKeyCode>(json!(key)).map_err(|_| failure("invalid_request", "unknown physical QEMU key"))?;
        if keys.contains(&key) { return Err(failure("invalid_request", "duplicate guest key modifier")); }
        keys.push(key);
    }
    let modifier = |key: &str| ["shift", "alt", "ctrl", "meta_l"].contains(&key);
    if keys[..keys.len()-1].iter().any(|key| !modifier(key)) || modifier(keys.last().unwrap()) {
        return Err(failure("invalid_request", "guest chord requires modifiers followed by one physical key"));
    }
    Ok(keys)
}

pub(crate) fn keys(text: &str) -> Result<Vec<Vec<Value>>> {
    let keys = chord(text)?;
    let event = |key: &str, down: bool| json!({"type":"key","data":{"down":down,"key":{"type":"qcode","data":key}}});
    Ok(vec![keys.iter().map(|key|event(key,true)).collect(), keys.iter().rev().map(|key|event(key,false)).collect()])
}

pub(crate) fn absolute_pointer(rows: &Value) -> Result<()> {
    let rows = rows.as_array().filter(|rows| rows.len() <= 16).ok_or_else(|| failure("provider_failed", "native guest pointer inventory is invalid"))?;
    let mut indices = std::collections::BTreeSet::new();
    let mut owned = 0;
    for row in rows {
        if row.as_object().is_none_or(|m|m.len()!=4) || row["name"].as_str().is_none_or(|s|s.is_empty()||s.len()>128)
            || row["index"].as_u64().is_none_or(|n|n>i32::MAX as u64||!indices.insert(n))
            || row["absolute"].as_bool().is_none() || row["current"].as_bool().is_none() {
            return Err(failure("provider_failed", "native guest pointer inventory has missing or contradictory fields"));
        }
        if row["name"] == "QEMU HID Tablet" && row["absolute"] == true { owned += 1; }
    }
    if owned != 1 { return Err(failure("unsupported_target", "one native guest absolute HID tablet is required")); }
    Ok(())
}

pub(crate) fn click(width: u32, height: u32, x: f64, y: f64, button: &str) -> Result<Vec<Vec<Value>>> {
    if width < 2 || height < 2 || width > 16384 || height > 16384 || !x.is_finite() || !y.is_finite()
        || x < 0. || y < 0. || x >= width as f64 || y >= height as f64 || !["left","right","middle"].contains(&button) {
        return Err(failure("invalid_request", "guest click lies outside the actual bounded guest framebuffer"));
    }
    let axis = |value: f64, size: u32| (value.floor() * ABS_MAX / (size-1) as f64).round() as u32;
    let press = vec![json!({"type":"abs","data":{"axis":"x","value":axis(x,width)}}),
                    json!({"type":"abs","data":{"axis":"y","value":axis(y,height)}}),
                    json!({"type":"btn","data":{"down":true,"button":button}})];
    // QEMU syncs once per QMP list. A separate release avoids compressing
    // the press away before the guest's HID queue sees it.
    Ok(vec![press,vec![json!({"type":"btn","data":{"down":false,"button":button}})]])
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn physical_chords_preserve_modifier_order_and_reverse_release() {
        let parts=keys("cmd+shift+x").unwrap();
        assert_eq!(parts[0].iter().map(|v|v["data"]["key"]["data"].as_str().unwrap()).collect::<Vec<_>>(),["meta_l","shift","x"]);
        assert_eq!(parts[1].iter().map(|v|v["data"]["key"]["data"].as_str().unwrap()).collect::<Vec<_>>(),["x","shift","meta_l"]);
        assert!(parts[0].iter().all(|v|v["data"]["down"]==true));
        assert!(parts[1].iter().all(|v|v["data"]["down"]==false));
        assert_eq!(chord("CONTROL+OPTION+DELETE").unwrap(),["ctrl","alt","delete"]);
        for bad in ["", "+x", "ctrl++x", "ctrl+control+x", "x+y", "ctrl", "é", "f99", "ctrl+😀"] { assert!(keys(bad).is_err()); }
    }
    #[test] fn framebuffer_edges_use_the_native_absolute_range_and_separate_release() {
        let parts=click(1920,1080,1919.,1079.,"right").unwrap();
        assert_eq!(parts.iter().map(Vec::len).collect::<Vec<_>>(),[3,1]);
        assert_eq!(parts[0][0]["data"]["value"],32767);
        assert_eq!(parts[0][1]["data"]["value"],32767);
        assert_eq!(parts[0][2]["data"]["down"],true);
        assert_eq!(parts[1][0]["data"]["down"],false);
        assert!(click(1920,1080,1920.,0.,"left").is_err());
        assert!(click(1920,1080,f64::NAN,0.,"left").is_err());
        assert!(click(1,1080,0.,0.,"left").is_err());
        assert_eq!(click(1920,1080,0.,0.,"left").unwrap()[0][0]["data"]["value"],0);
    }
    #[test] fn the_actual_absolute_pointer_inventory_cannot_be_inferred_from_a_name() {
        let tablet=json!({"name":"QEMU HID Tablet","index":1,"current":false,"absolute":true});
        assert!(absolute_pointer(&json!([tablet])).is_ok());
        for invalid in [json!([]), json!([tablet,tablet]), json!([{"name":"QEMU HID Tablet","index":1,"current":true,"absolute":false}]),json!([{"name":"QEMU HID Tablet","index":1,"current":1,"absolute":true}])] { assert!(absolute_pointer(&invalid).is_err()); }
    }
}
