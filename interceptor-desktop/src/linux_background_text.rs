//! Browser-window typing through the existing AT-SPI text interfaces.
//! Native acknowledgments require subsequent observation of the page effect.
use super::*;

thread_local! {
    static UNRESOLVED: RefCell<HashMap<u32,Rc<Process>>> = RefCell::new(HashMap::new());
}
fn exited(process:&Process)->bool {
    let mut fd=libc::pollfd{fd:process.fd.as_raw_fd(),events:libc::POLLIN,revents:0};
    unsafe{libc::poll(&mut fd,1,0)>0&&fd.revents&libc::POLLIN!=0}
}
pub(super) fn blocked(pid:u32)->bool {
    UNRESOLVED.with(|entries|{let mut entries=entries.borrow_mut();entries.retain(|_,process|!exited(process));entries.contains_key(&pid)||entries.len()>=32})
}
fn uncertain(process:Rc<Process>,delivered:usize,reason:&str)->Value {
    UNRESOLVED.with(|entries|{entries.borrow_mut().insert(process.pid,process);});
    let mut result=failure("timeout_unknown_outcome",reason);
    result["details"]=json!({"delivered":delivered,"dispatched":true,"verified":false,"effectRequiresObservation":true});
    result
}
fn state(text:&Object)->Result<(c_int,c_int,Option<(c_int,c_int)>),Value>{unsafe{
    let mut error:Raw=ptr::null_mut();let location=(&raw mut error).cast();
    let count=atspi_text_get_character_count(text.0,location);
    if !error.is_null(){g_error_free(error);return Err(failure("provider_failed","native text length is unavailable"));}
    if !(0..=1048576).contains(&count){return Err(failure("resource_limit","native text length exceeds 1048576 characters"));}
    let caret=atspi_text_get_caret_offset(text.0,location);
    if !error.is_null(){g_error_free(error);return Err(failure("provider_failed","native caret is unavailable"));}
    if caret<0||caret>count{return Err(failure("provider_failed","native caret is outside its actual text length"));}
    let selections=atspi_text_get_n_selections(text.0,location);
    if !error.is_null(){g_error_free(error);return Err(failure("provider_failed","native selection inventory is unavailable"));}
    if !(0..=1).contains(&selections){return Err(failure("unsupported_target","browser text requires at most one native selection"));}
    let selection=if selections==1{
        let range=atspi_text_get_selection(text.0,0,location);
        if !error.is_null()||range.is_null(){if !range.is_null(){g_free(range.cast());}if !error.is_null(){g_error_free(error);}return Err(failure("provider_failed","native selection is unavailable"));}
        let(start,end)=((*range).start,(*range).end);g_free(range.cast());
        if start<0||end<start||end>count||caret!=start&&caret!=end{return Err(failure("unsupported_target","native caret and selection do not identify one insertion point"));}
        (start!=end).then_some((start,end))
    }else{None};
    Ok((count,caret,selection))
}}
pub(super) fn insert(a:&Value,obj:&Object,process:Rc<Process>,mut window_live:impl FnMut()->bool)->Value {
    let Some(value)=a["text"].as_str()else{return failure("invalid_request","browser background text requires a string");};
    if value.is_empty()||value.len()>32768||value.contains('\0'){return failure("invalid_request","browser background text requires 1..32768 UTF8 bytes without NUL");}
    if blocked(process.pid){return failure("background_unavailable","unresolved native text input retains its process until confirmed exit, or the 32-process admission cap is full");}
    let content=match CString::new(value){Ok(content)=>content,Err(_)=>return failure("invalid_request","embedded NUL is unsupported")};
    let started=Instant::now();let deadline=started+Duration::from_secs(4);
    let live=|window_live:&mut dyn FnMut()->bool|Instant::now()<deadline&&process.same_login()&&pid(obj)==process.pid&&!has_state(obj,6)&&has_state(obj,12)&&has_state(obj,7)&&has_state(obj,8)&&has_state(obj,24)&&window_live();
    if !live(&mut window_live){return failure("target_gone","browser text control, retained process, login or selected window changed");}
    let Some(text)=Object::from(unsafe{atspi_accessible_get_text_iface(obj.0)})else{return failure("unsupported_target","browser control exposes no native Text interface");};
    let Some(edit)=Object::from(unsafe{atspi_accessible_get_editable_text_iface(obj.0)})else{return failure("unsupported_target","browser control exposes no native EditableText interface");};
    let before=match state(&text){Ok(before)=>before,Err(error)=>return error};
    let characters=value.chars().count()as c_int;
    if before.0-before.2.map_or(0,|(start,end)|end-start)+characters>1048576{return failure("resource_limit","browser insertion would exceed the native text admission limit");}
    if !live(&mut window_live)||!matches!(state(&text),Ok(current)if current==before){return failure("target_gone","browser insertion state changed before native submission");}
    let mut delivered=0;let mut expected=before.0;let position=before.2.map_or(before.1,|(start,_)|start);
    if let Some((start,end))=before.2{
        if !live(&mut window_live){return failure("target_gone","browser target changed before native selection deletion");}
        let mut error:Raw=ptr::null_mut();let accepted=unsafe{atspi_editable_text_delete_text(edit.0,start,end,(&raw mut error).cast())};
        if !error.is_null()||accepted==0{if !error.is_null(){unsafe{g_error_free(error);}}return uncertain(process.clone(),delivered,"native selection deletion outcome is unknown; no fallback or replay was sent");}
        delivered+=1;expected-=end-start;
        if !live(&mut window_live)||!matches!(state(&text),Ok((count,caret,None))if count==expected&&caret==position){return uncertain(process.clone(),delivered,"selection deletion was acknowledged but its resulting native insertion state changed");}
    }else if !live(&mut window_live)||!matches!(state(&text),Ok(current)if current==before){return failure("target_gone","browser caret changed before native text insertion");}
    if !live(&mut window_live){return if delivered>0{uncertain(process.clone(),delivered,"browser target changed after selection deletion")}else{failure("target_gone","browser target changed before native insertion")};}
    let mut error:Raw=ptr::null_mut();
    // libatspi2.52 specifies a byte length here, while offsets are characters.
    let accepted=unsafe{atspi_editable_text_insert_text(edit.0,position,content.as_ptr(),value.len()as c_int,(&raw mut error).cast())};
    if !error.is_null()||accepted==0{if !error.is_null(){unsafe{g_error_free(error);}}return uncertain(process.clone(),delivered,"native insertion outcome is unknown; no fallback or replay was sent");}
    delivered+=1;expected+=characters;
    if !live(&mut window_live)||!matches!(state(&text),Ok((count,_,_))if count==expected){return uncertain(process.clone(),delivered,"native insertion was acknowledged but its actual text length or target changed");}
    let accepted=unsafe{atspi_text_set_caret_offset(text.0,position+characters,(&raw mut error).cast())};
    if !error.is_null()||accepted==0{if !error.is_null(){unsafe{g_error_free(error);}}return uncertain(process.clone(),delivered,"inserted text caret placement outcome is unknown; no input was replayed");}
    delivered+=1;
    if !live(&mut window_live)||!matches!(state(&text),Ok((count,caret,None))if count==expected&&caret==position+characters){return uncertain(process.clone(),delivered,"native insertion/caret acknowledgment was followed by changed target or insertion state");}
    success(json!({"method":"AT-SPI.EditableText.InsertText","background":true,"foregroundUsed":false,"delivered":delivered,"targetPid":process.pid,"elapsedMs":started.elapsed().as_millis(),"effectRequiresObservation":true}))
}
