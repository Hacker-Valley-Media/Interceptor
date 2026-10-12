use crate::{failure,clipboard::bounded};
use serde_json::{Value,json};
use base64::Engine;
use std::{cell::Cell,ffi::{CStr,CString,c_char,c_int,c_void},ptr,sync::atomic::{AtomicU64,Ordering}};
type Raw=*mut c_void;
#[link(name="gtk-3")]unsafe extern "C"{
    fn gtk_init_check(argc:*mut c_int,argv:*mut *mut *mut c_char)->c_int;
    fn gtk_clipboard_get(selection:Raw)->Raw;
    fn gtk_clipboard_set_text(clipboard:Raw,text:*const c_char,len:c_int);
    fn gtk_clipboard_clear(clipboard:Raw);
    fn gtk_clipboard_wait_for_text(clipboard:Raw)->*mut c_char;
    fn gtk_clipboard_wait_for_targets(clipboard:Raw,targets:*mut *mut Raw,n_targets:*mut c_int)->c_int;
    fn gtk_clipboard_wait_for_contents(clipboard:Raw,target:Raw)->Raw;
    fn gtk_clipboard_wait_for_image(clipboard:Raw)->Raw;
    fn gtk_clipboard_wait_for_uris(clipboard:Raw)->*mut *mut c_char;
    fn gtk_selection_data_get_length(data:Raw)->c_int;
    fn gtk_selection_data_get_format(data:Raw)->c_int;
    fn gtk_selection_data_get_data(data:Raw)->*const u8;
    fn gtk_selection_data_free(data:Raw);
}
#[link(name="gdk-3")]unsafe extern "C"{fn gdk_atom_intern(name:*const c_char,only_if_exists:c_int)->Raw;fn gdk_atom_name(atom:Raw)->*mut c_char;}
#[link(name="glib-2.0")]unsafe extern "C"{fn g_free(pointer:Raw);fn g_strfreev(strings:*mut *mut c_char);fn g_filename_from_uri(uri:*const c_char,hostname:*mut *mut c_char,error:Raw)->*mut c_char;}
#[link(name="gobject-2.0")]unsafe extern "C"{fn g_object_unref(object:Raw);fn g_signal_connect_data(instance:Raw,signal:*const c_char,callback:unsafe extern "C" fn(Raw,Raw,Raw),data:Raw,destroy:Raw,flags:u32)->u64;}
#[link(name="gdk_pixbuf-2.0")]unsafe extern "C"{fn gdk_pixbuf_get_width(pixbuf:Raw)->c_int;fn gdk_pixbuf_get_height(pixbuf:Raw)->c_int;fn gdk_pixbuf_save_to_bufferv(pixbuf:Raw,buffer:*mut *mut c_char,size:*mut usize,format:*const c_char,keys:*mut *mut c_char,values:*mut *mut c_char,error:Raw)->c_int;}
static CHANGES:AtomicU64=AtomicU64::new(0);
thread_local!{static INITIALIZED:Cell<bool>=const{Cell::new(false)};}
unsafe extern "C" fn owner_changed(_:Raw,_:Raw,_:Raw){CHANGES.fetch_add(1,Ordering::Relaxed);}
struct Allocation(Raw);impl Drop for Allocation{fn drop(&mut self){unsafe{g_free(self.0);}}}
struct Selection(Raw);impl Drop for Selection{fn drop(&mut self){unsafe{gtk_selection_data_free(self.0);}}}
struct Object(Raw);impl Drop for Object{fn drop(&mut self){unsafe{g_object_unref(self.0);}}}
struct Strings(*mut *mut c_char);impl Drop for Strings{fn drop(&mut self){unsafe{g_strfreev(self.0);}}}
unsafe fn atom(name:&CStr)->Raw{unsafe{gdk_atom_intern(name.as_ptr(),0)}}
unsafe fn clipboard()->Option<Raw>{
    INITIALIZED.with(|ready|{
        if !ready.get()&&unsafe{gtk_init_check(ptr::null_mut(),ptr::null_mut())}==0{return None;}
        let clipboard=unsafe{gtk_clipboard_get(atom(c"CLIPBOARD"))};if clipboard.is_null(){return None;}
        if !ready.get(){unsafe{g_signal_connect_data(clipboard,c"owner-change".as_ptr(),owner_changed,ptr::null_mut(),ptr::null_mut(),0)};ready.set(true);}
        Some(clipboard)
    })
}
unsafe fn text(clipboard:Raw)->Option<String>{
    // GTK's convenience text conversion replaces CRLF with LF. Prefer the
    // owner's UTF-8 bytes so native reads and previews preserve the text.
    for target in [c"UTF8_STRING",c"text/plain;charset=utf-8",c"text/plain"] {
        let raw=unsafe{gtk_clipboard_wait_for_contents(clipboard,atom(target))};
        if raw.is_null(){continue;}let _selection=Selection(raw);
        let length=unsafe{gtk_selection_data_get_length(raw)};
        if length<0||length as usize>crate::contract_generated::DESKTOP_MAX_RESULT_BYTES||unsafe{gtk_selection_data_get_format(raw)}!=8{return None;}
        if length==0{return Some(String::new());}
        let pointer=unsafe{gtk_selection_data_get_data(raw)};if pointer.is_null(){return None;}
        return std::str::from_utf8(unsafe{std::slice::from_raw_parts(pointer,length as usize)}).ok().map(str::to_owned);
    }
    let raw=unsafe{gtk_clipboard_wait_for_text(clipboard)};if raw.is_null(){return None;}let _memory=Allocation(raw.cast());
    let bytes=unsafe{CStr::from_ptr(raw)}.to_bytes();if bytes.len()>crate::contract_generated::DESKTOP_MAX_RESULT_BYTES{return None;}
    std::str::from_utf8(bytes).ok().map(str::to_owned)
}
unsafe fn types(clipboard:Raw)->Vec<String>{
    let mut targets=ptr::null_mut();let mut count=0;
    if unsafe{gtk_clipboard_wait_for_targets(clipboard,&mut targets,&mut count)}==0||targets.is_null(){return Vec::new();}
    let _memory=Allocation(targets.cast());
    if !(0..=4096).contains(&count){return Vec::new();}
    let mut names=Vec::new();
    for atom in unsafe{std::slice::from_raw_parts(targets,count as usize)}{
        let raw=unsafe{gdk_atom_name(*atom)};if raw.is_null(){continue;}let _memory=Allocation(raw.cast());
        names.push(unsafe{CStr::from_ptr(raw)}.to_string_lossy().into_owned());
    }
    names
}
unsafe fn rich_text(clipboard:Raw)->Option<String>{
    for name in [c"text/rtf",c"application/rtf"]{
        let raw=unsafe{gtk_clipboard_wait_for_contents(clipboard,atom(name))};if raw.is_null(){continue;}let _selection=Selection(raw);
        let length=unsafe{gtk_selection_data_get_length(raw)};let pointer=unsafe{gtk_selection_data_get_data(raw)};
        if length<0||length as usize>crate::contract_generated::DESKTOP_MAX_RESULT_BYTES||pointer.is_null(){continue;}
        if let Ok(text)=std::str::from_utf8(unsafe{std::slice::from_raw_parts(pointer,length as usize)}){return Some(text.to_owned());}
    }
    None
}
pub fn local_file_path(uri:&str)->Result<String,Value>{
    let uri=CString::new(uri).map_err(|_|failure("unsupported_target","clipboard file URI contains NUL"))?;
    unsafe{
        let mut hostname=ptr::null_mut();let filename=g_filename_from_uri(uri.as_ptr(),&mut hostname,ptr::null_mut());
        let _host=Allocation(hostname.cast());
        if filename.is_null(){return Err(failure("unsupported_target","clipboard contains a URI without a local filesystem path"));}
        let _name=Allocation(filename.cast());
        if !hostname.is_null()&&!CStr::from_ptr(hostname).to_bytes().is_empty()&&CStr::from_ptr(hostname).to_bytes()!=b"localhost"{return Err(failure("unsupported_target","remote clipboard URI is not a local file"));}
        CStr::from_ptr(filename).to_str().map(str::to_owned).map_err(|_|failure("unsupported_target","clipboard filename is not UTF-8"))
    }
}
pub fn execute(verb:&str,action:&Value)->Value{
    unsafe{
        let Some(clipboard)=clipboard()else{return failure("provider_failed","GTK session clipboard initialization failed");};
        if verb=="__clipboard_snapshot"{return bounded(json!({"changeCount":CHANGES.load(Ordering::Relaxed),"types":types(clipboard),"preview":crate::clipboard::preview(&text(clipboard).unwrap_or_default())}));}
        match action["sub"].as_str().unwrap_or(""){
            "types"=>bounded(json!(types(clipboard))),
            "write"=>{let text=action["text"].as_str().unwrap_or("");if text.len()>crate::contract_generated::DESKTOP_MAX_RESULT_BYTES{return failure("resource_limit","clipboard text exceeds limit");}let text=CString::new(text).unwrap();gtk_clipboard_set_text(clipboard,text.as_ptr(),text.as_bytes().len()as c_int);bounded(json!("ok"))},
            "clear"=>{gtk_clipboard_set_text(clipboard,c"".as_ptr(),0);gtk_clipboard_clear(clipboard);bounded(json!("ok"))},
            "read"=>{
                let data=match action["contentType"].as_str().unwrap_or("text"){
                    "text"=>text(clipboard).map(|s|json!(s)),
                    "rtf"=>rich_text(clipboard).map(|s|json!(s)),
                    "image"=>{
                        let raw=gtk_clipboard_wait_for_image(clipboard);if raw.is_null(){None}else{
                            let _image=Object(raw);let width=gdk_pixbuf_get_width(raw);let height=gdk_pixbuf_get_height(raw);
                            if width<=0||height<=0||i64::from(width)*i64::from(height)>40_000_000{return failure("resource_limit","clipboard image dimensions exceed limit");}
                            let mut buffer=ptr::null_mut();let mut size=0;
                            if gdk_pixbuf_save_to_bufferv(raw,&mut buffer,&mut size,c"png".as_ptr(),ptr::null_mut(),ptr::null_mut(),ptr::null_mut())==0||buffer.is_null(){None}else{
                                let _memory=Allocation(buffer.cast());if size>crate::contract_generated::DESKTOP_MAX_RESULT_BYTES{return failure("resource_limit","clipboard image exceeds limit");}
                                let bytes=std::slice::from_raw_parts(buffer.cast::<u8>(),size);Some(json!(format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))))
                            }
                        }
                    },
                    "files"=>{
                        let raw=gtk_clipboard_wait_for_uris(clipboard);if raw.is_null(){None}else{
                            let _strings=Strings(raw);let mut paths=Vec::new();let mut cursor=raw;
                            while !(*cursor).is_null(){if paths.len()>=4096{return failure("resource_limit","clipboard file list exceeds limit");}
                                let uri=match CStr::from_ptr(*cursor).to_str(){Ok(v)=>v,Err(_)=>return failure("unsupported_target","clipboard URI is not UTF-8")};
                                match local_file_path(uri){Ok(path)=>paths.push(path),Err(e)=>return e};cursor=cursor.add(1);
                            }Some(json!(paths))
                        }
                    },
                    _=>unreachable!(),
                };
                data.map(bounded).unwrap_or_else(||failure("unsupported_target","requested clipboard format is absent or invalid"))
            },
            _=>failure("invalid_request","unknown clipboard subcommand"),
        }
    }
}
