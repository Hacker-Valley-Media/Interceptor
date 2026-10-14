use crate::{failure,success};
use serde_json::{Value,json};
use std::{ffi::{CStr,CString,c_char,c_int,c_void},os::unix::fs::MetadataExt,ptr,time::Instant};
type Raw=*mut c_void;
#[link(name="gtk-3")]unsafe extern "C"{
    fn gtk_init_check(argc:*mut c_int,argv:*mut *mut *mut c_char)->c_int;
    fn gtk_dialog_new()->Raw;
    fn gtk_window_set_title(window:Raw,title:*const c_char);
    fn gtk_window_set_default_size(window:Raw,width:c_int,height:c_int);
    fn gtk_dialog_get_content_area(dialog:Raw)->Raw;
    fn gtk_dialog_add_button(dialog:Raw,text:*const c_char,response:c_int)->Raw;
    fn gtk_dialog_run(dialog:Raw)->c_int;
    fn gtk_box_pack_start(container:Raw,child:Raw,expand:c_int,fill:c_int,padding:u32);
    fn gtk_label_new(text:*const c_char)->Raw;
    fn gtk_label_set_line_wrap(label:Raw,wrap:c_int);
    fn gtk_entry_new()->Raw;
    fn gtk_entry_set_visibility(entry:Raw,visible:c_int);
    fn gtk_entry_set_max_length(entry:Raw,length:c_int);
    fn gtk_entry_get_text(entry:Raw)->*const c_char;
    fn gtk_entry_set_text(entry:Raw,text:*const c_char);
    fn gtk_widget_show_all(widget:Raw);
    fn gtk_widget_destroy(widget:Raw);
}
#[repr(C)]struct Message{style:c_int,text:*const c_char}
#[repr(C)]struct Response{text:*mut c_char,code:c_int}
#[repr(C)]struct Conversation{callback:unsafe extern "C" fn(c_int,*const *const Message,*mut *mut Response,Raw)->c_int,data:Raw}
type Start=unsafe extern "C" fn(*const c_char,*const c_char,*const Conversation,*mut Raw)->c_int;
type Authenticate=unsafe extern "C" fn(Raw,c_int)->c_int;
type GetItem=unsafe extern "C" fn(Raw,c_int,*mut *const c_void)->c_int;
type End=unsafe extern "C" fn(Raw,c_int)->c_int;
struct Pam{library:Raw,start:Start,authenticate:Authenticate,account:Authenticate,item:GetItem,end:End}
impl Drop for Pam{fn drop(&mut self){unsafe{libc::dlclose(self.library);}}}
impl Pam{
    fn load()->Option<Self>{unsafe{
        let library=libc::dlopen(c"libpam.so.0".as_ptr(),libc::RTLD_NOW|libc::RTLD_LOCAL);if library.is_null(){return None;}
        let symbols=[c"pam_start",c"pam_authenticate",c"pam_acct_mgmt",c"pam_get_item",c"pam_end"].map(|name|libc::dlsym(library,name.as_ptr()));
        if symbols.iter().any(|symbol|symbol.is_null()){libc::dlclose(library);return None;}
        Some(Self{library,start:std::mem::transmute::<Raw,Start>(symbols[0]),authenticate:std::mem::transmute::<Raw,Authenticate>(symbols[1]),account:std::mem::transmute::<Raw,Authenticate>(symbols[2]),item:std::mem::transmute::<Raw,GetItem>(symbols[3]),end:std::mem::transmute::<Raw,End>(symbols[4])})
    }}
}
fn username()->Option<CString>{unsafe{
    if libc::getuid()==0||libc::getuid()!=libc::geteuid(){return None;}
    let mut info=std::mem::zeroed::<libc::passwd>();let mut buffer=vec![0u8;16384];let mut result=ptr::null_mut();
    if libc::getpwuid_r(libc::getuid(),&mut info,buffer.as_mut_ptr().cast(),buffer.len(),&mut result)!=0||result.is_null()||info.pw_name.is_null(){return None;}
    Some(CStr::from_ptr(info.pw_name).to_owned())
}}
fn policy_available()->bool{
    std::fs::metadata("/etc/pam.d/login").is_ok_and(|meta|meta.is_file()&&meta.uid()==0&&meta.mode()&0o022==0)
}
struct Prompt{reason:CString,cancel:CString,cancelled:bool,count:usize}
unsafe fn ask(prompt:&mut Prompt,message:&CStr,hidden:bool)->Option<Vec<u8>>{unsafe{
    prompt.count+=1;if prompt.count>8||message.to_bytes().len()>2048{return None;}
    let dialog=gtk_dialog_new();if dialog.is_null(){return None;}
    gtk_window_set_title(dialog,c"Authenticate for Interceptor".as_ptr());gtk_window_set_default_size(dialog,480,180);
    let container=gtk_dialog_get_content_area(dialog);
    for text in [prompt.reason.as_c_str(),message]{let label=gtk_label_new(text.as_ptr());gtk_label_set_line_wrap(label,1);gtk_box_pack_start(container,label,0,1,8);}
    let entry=gtk_entry_new();gtk_entry_set_visibility(entry,i32::from(!hidden));gtk_entry_set_max_length(entry,512);gtk_box_pack_start(container,entry,0,1,8);
    gtk_dialog_add_button(dialog,prompt.cancel.as_ptr(),-6);gtk_dialog_add_button(dialog,c"Authenticate".as_ptr(),-5);gtk_widget_show_all(dialog);
    let response=gtk_dialog_run(dialog);
    let value=if response == -5{let text=gtk_entry_get_text(entry);if text.is_null(){None}else{let bytes=CStr::from_ptr(text).to_bytes();(bytes.len()<=512&&!bytes.is_empty()).then(||bytes.to_vec())}}else{prompt.cancelled=true;None};
    gtk_entry_set_text(entry,c"".as_ptr());gtk_widget_destroy(dialog);value
}}
unsafe fn free_responses(rows:*mut Response,count:usize){unsafe{
    for index in 0..count{let text=(*rows.add(index)).text;if !text.is_null(){let size=CStr::from_ptr(text).to_bytes().len();for offset in 0..size{ptr::write_volatile(text.add(offset),0);}libc::free(text.cast());}}
    libc::free(rows.cast());
}}
unsafe extern "C" fn conversation(count:c_int,messages:*const *const Message,responses:*mut *mut Response,data:Raw)->c_int{unsafe{
    if !(1..=8).contains(&count)||messages.is_null()||responses.is_null()||data.is_null(){return 19;}
    *responses=ptr::null_mut();let rows=libc::calloc(count as usize,std::mem::size_of::<Response>()).cast::<Response>();if rows.is_null(){return 5;}
    let prompt=&mut *data.cast::<Prompt>();
    for index in 0..count as usize{
        let message=*messages.add(index);if message.is_null()||(*message).text.is_null(){free_responses(rows,count as usize);return 19;}
        match (*message).style{
            1|2=>{
                let Some(mut bytes)=ask(prompt,CStr::from_ptr((*message).text),(*message).style==1)else{free_responses(rows,count as usize);return 19;};
                let text=libc::malloc(bytes.len()+1).cast::<c_char>();if text.is_null(){bytes.fill(0);free_responses(rows,count as usize);return 5;}
                ptr::copy_nonoverlapping(bytes.as_ptr(),text.cast::<u8>(),bytes.len());*text.add(bytes.len())=0;for byte in &mut bytes{ptr::write_volatile(byte,0);}(*rows.add(index)).text=text;
            },
            3|4=>(),
            _=>{free_responses(rows,count as usize);return 19;},
        }
    }
    *responses=rows;0
}}
pub fn execute(action:&Value,identity:&Value)->Value{
    let provider="linux-pam";let policy=action["policy"].as_str().unwrap_or("any");
    if action["sub"]=="invalidate"{return success(json!({"invalidated":true,"provider":provider}));}
    if action["sub"]=="domain-state"{return success(json!({"available":false,"provider":provider,"reason":"PAM authentication does not expose a biometric enrollment domain state"}));}
    if action.get("fallback_title").is_some(){return failure("unsupported_operation","PAM has no interchangeable biometric fallback button");}
    let Some(user)=username()else{return failure("permission_denied","PAM authentication requires the current unprivileged graphical user");};
    let pam=Pam::load();let ready=pam.is_some()&&policy_available()&&unsafe{gtk_init_check(ptr::null_mut(),ptr::null_mut())!=0};
    if action["sub"]=="status"{
        let policies=if ready{vec!["any"]}else{vec![]};let mut data=json!({"canEvaluate":policies.contains(&policy),"policy":policy,"provider":provider,"user":identity["uid"].to_string(),"biometryType":"unspecified","availablePolicies":policies});
        if !policies.contains(&policy){data["error"]=json!(if policy!="any"{"PAM login policy cannot prove biometric-only or watch approval"}else{"PAM library, root-owned login policy or GTK graphical session is unavailable"});}
        return success(data);
    }
    if policy!="any"{return failure("unsupported_operation","PAM login approval cannot satisfy a biometric-only or watch policy");}
    if !ready{return failure("permission_denied","PAM library, root-owned login policy or GTK graphical session is unavailable");}
    let pam=pam.unwrap();let mut prompt=Prompt{reason:CString::new(action["reason"].as_str().unwrap()).unwrap(),cancel:CString::new(action["cancel_title"].as_str().unwrap_or("Cancel")).unwrap(),cancelled:false,count:0};
    let conv=Conversation{callback:conversation,data:(&raw mut prompt).cast()};let mut handle=ptr::null_mut();let started=Instant::now();
    let mut code=unsafe{(pam.start)(c"login".as_ptr(),user.as_ptr(),&conv,&mut handle)};
    if code==0&&!handle.is_null(){unsafe{
        code=(pam.authenticate)(handle,1); // PAM_DISALLOW_NULL_AUTHTOK
        if code==0{code=(pam.account)(handle,0);}
        if code==0{let mut actual=ptr::null();if (pam.item)(handle,2,&mut actual)!=0||actual.is_null()||CStr::from_ptr(actual.cast())!=user.as_c_str(){code=6;}}
    }}else if code==0{code=4;}
    if !handle.is_null(){unsafe{(pam.end)(handle,code);}}
    let mut data=json!({"ok":code==0&&!prompt.cancelled,"policy":policy,"provider":provider,"user":identity["uid"].to_string(),"reason":action["reason"],"elapsedMs":started.elapsed().as_millis()as u64,"biometryType":"unspecified"});
    if data["ok"]!=true{data["errorCode"]=json!(code);data["error"]=json!(if prompt.cancelled{"authentication cancelled"}else{"native login authentication or account policy refused approval"});}
    success(data)
}

pub fn register(request:&crate::secret_registration::Registration)->Value{unsafe{
    if gtk_init_check(ptr::null_mut(),ptr::null_mut())==0{return failure("no_interactive_session","secure registration requires GTK in the current graphical login");}
    let dialog=gtk_dialog_new();if dialog.is_null(){return failure("provider_failed","secure registration window could not be created");}
    gtk_window_set_title(dialog,c"Store a secret for Interceptor".as_ptr());gtk_window_set_default_size(dialog,560,300);
    let container=gtk_dialog_get_content_area(dialog);let policy=CString::new(request.policy_text()).unwrap();
    for text in [policy.as_c_str(),c"Stored in the current user's native credential service. Value and confirmation remain hidden. Maximum 8192 UTF-8 bytes."]{let label=gtk_label_new(text.as_ptr());gtk_label_set_line_wrap(label,1);gtk_box_pack_start(container,label,0,1,8);}
    let mut fields=Vec::new();for label in [c"Value",c"Confirm value"]{gtk_box_pack_start(container,gtk_label_new(label.as_ptr()),0,1,4);let entry=gtk_entry_new();gtk_entry_set_visibility(entry,0);gtk_entry_set_max_length(entry,8192);gtk_box_pack_start(container,entry,0,1,4);fields.push(entry);}
    let status=gtk_label_new(c"".as_ptr());gtk_box_pack_start(container,status,0,1,4);gtk_dialog_add_button(dialog,c"Cancel".as_ptr(),-6);gtk_dialog_add_button(dialog,c"Save".as_ptr(),-5);gtk_widget_show_all(dialog);
    struct Timeout{dialog:Raw,fired:bool}
    unsafe extern "C" fn timed_out(data:Raw)->c_int{unsafe{let state=&mut *data.cast::<Timeout>();state.fired=true;unsafe extern "C"{fn gtk_dialog_response(dialog:Raw,response:c_int);}gtk_dialog_response(state.dialog,-6);0}}
    unsafe extern "C"{fn g_timeout_add(interval:u32,callback:unsafe extern "C" fn(Raw)->c_int,data:Raw)->u32;fn g_source_remove(source:u32)->c_int;}
    let mut timeout=Timeout{dialog,fired:false};let timer=g_timeout_add(590000,timed_out,(&raw mut timeout).cast());
    let result=loop{
        if gtk_dialog_run(dialog)!=-5{break crate::secret_registration::cancelled();}
        let mut values=fields.iter().map(|entry|{let text=gtk_entry_get_text(*entry);if text.is_null(){Vec::new()}else{CStr::from_ptr(text).to_bytes().to_vec()}}).collect::<Vec<_>>();
        let valid=std::str::from_utf8(&values[0]).ok().zip(std::str::from_utf8(&values[1]).ok()).is_some_and(|(value,confirm)|crate::secret_registration::value_matches(value,confirm));
        let result=if valid{Some(crate::secret_registration::registered(String::from_utf8(values[0].clone()).unwrap()))}else{None};
        for value in &mut values{for byte in value{ptr::write_volatile(byte,0);}}
        if let Some(result)=result{break result;}
        gtk_entry_set_text(fields[1],c"".as_ptr());
        // Reuse GTK's label setter without replacing password controls.
        unsafe extern "C"{fn gtk_label_set_text(label:Raw,text:*const c_char);}
        gtk_label_set_text(status,c"Enter matching nonempty values within 8192 UTF-8 bytes.".as_ptr());
    };
    if !timeout.fired&&timer!=0{g_source_remove(timer);}for entry in fields{gtk_entry_set_text(entry,c"".as_ptr());}gtk_widget_destroy(dialog);result
}}
