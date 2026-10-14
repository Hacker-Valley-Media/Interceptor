//! Native map opening reuses the exact authenticated portal request owner.
use crate::native_bus::*;
use serde_json::Value;
use std::{ffi::{CString,c_char},time::Duration};
pub(crate) fn open(a:&Value)->Result<(),Value>{
    let uri=CString::new(crate::maps::coordinate_uri(&a["coordinate"])?).unwrap();
    portal_request(c"org.freedesktop.portal.OpenURI",c"OpenURI",Duration::from_secs(6),|message|unsafe{
        portal_check(sd_bus_message_append(message,c"ss".as_ptr(),c"".as_ptr(),uri.as_ptr()))?;
        portal_check(sd_bus_message_open_container(message,b'a' as c_char,c"{sv}".as_ptr()))
    })
}
