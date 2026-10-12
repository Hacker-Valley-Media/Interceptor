use crate::{failure,linux::Object,native_library::Library};
use serde_json::{Value,json};
use std::{ffi::{CStr,CString,c_char,c_int,c_void},ptr};
type Raw=*mut c_void;
type Destroy=unsafe extern "C" fn(Raw);
#[repr(C)]struct List{data:Raw,next:*mut List,previous:*mut List}
#[repr(C)]struct SList{data:Raw,next:*mut SList}
#[repr(C)]struct Error{domain:u32,code:c_int,message:*mut c_char}
// EDS3.56.2 public C ABI. Operation flags require the3.34+ signatures.
struct Api{
    registry_new:unsafe extern "C" fn(Raw,*mut *mut Error)->Raw,
    sources:unsafe extern "C" fn(Raw,*const c_char)->*mut List,
    source:unsafe extern "C" fn(Raw,*const c_char)->Raw,
    default_source:unsafe extern "C" fn(Raw)->Raw,
    builtin_source:unsafe extern "C" fn(Raw)->Raw,
    is_self:unsafe extern "C" fn(Raw)->c_int,
    uid:unsafe extern "C" fn(Raw)->*const c_char,
    name:unsafe extern "C" fn(Raw)->*const c_char,
    has_extension:unsafe extern "C" fn(Raw,*const c_char)->c_int,
    connect:unsafe extern "C" fn(Raw,u32,Raw,*mut *mut Error)->Raw,
    readonly:unsafe extern "C" fn(Raw)->c_int,
    get:unsafe extern "C" fn(Raw,*const c_char,*mut Raw,Raw,*mut *mut Error)->c_int,
    cursor:unsafe extern "C" fn(Raw,*const c_char,*const c_int,*const c_int,u32,*mut Raw,Raw,*mut *mut Error)->c_int,
    step:unsafe extern "C" fn(Raw,c_int,c_int,c_int,*mut *mut SList,Raw,*mut *mut Error)->c_int,
    add:unsafe extern "C" fn(Raw,Raw,u32,*mut *mut c_char,Raw,*mut *mut Error)->c_int,
    add_many:unsafe extern "C" fn(Raw,*mut SList,u32,*mut *mut SList,Raw,*mut *mut Error)->c_int,
    modify:unsafe extern "C" fn(Raw,Raw,u32,Raw,*mut *mut Error)->c_int,
    delete:unsafe extern "C" fn(Raw,Raw,u32,Raw,*mut *mut Error)->c_int,
    new_contact:unsafe extern "C" fn()->Raw,
    from_vcard:unsafe extern "C" fn(*const c_char)->Raw,
    query_field:unsafe extern "C" fn(c_int,c_int,*const c_char)->Raw,
    query_any:unsafe extern "C" fn(*const c_char)->Raw,
    query_text:unsafe extern "C" fn(Raw)->*mut c_char,
    query_unref:Destroy,
    field:unsafe extern "C" fn(*const c_char)->c_int,
    constant:unsafe extern "C" fn(Raw,c_int)->Raw,
    owned:unsafe extern "C" fn(Raw,c_int)->Raw,
    name_string:unsafe extern "C" fn(Raw)->*mut c_char,
    name_free:Destroy,
    photo_free:Destroy,
    photo_bytes:unsafe extern "C" fn(Raw,*mut usize)->*const u8,
    set:unsafe extern "C" fn(Raw,c_int,*const c_void),
    to_vcard:unsafe extern "C" fn(Raw,c_int)->*mut c_char,
    // EDS 3.60 removed e_contact_get/set_attributes; there the vCard functions below stand in.
    attributes:Option<unsafe extern "C" fn(Raw,c_int)->*mut List>,
    set_attributes:Option<unsafe extern "C" fn(Raw,c_int,*mut List)>,
    vcard_name:unsafe extern "C" fn(c_int)->*const c_char,
    by_name:Option<unsafe extern "C" fn(Raw,*const c_char)->*mut List>,
    attr_copy:unsafe extern "C" fn(Raw)->Raw,
    append:unsafe extern "C" fn(Raw,Raw),
    list_append:unsafe extern "C" fn(*mut List,Raw)->*mut List,
    list_shallow_free:unsafe extern "C" fn(*mut List),
    destination_new:unsafe extern "C" fn()->Raw,
    destination_contact:unsafe extern "C" fn(Raw,Raw,c_int),
    // e_destination_set_client sets the source uid; EDS 3.60 removed e_destination_set_source_uid.
    destination_client:unsafe extern "C" fn(Raw,Raw),
    destination_export:unsafe extern "C" fn(Raw,Raw),
    values:unsafe extern "C" fn(Raw)->*mut List,
    parameter:unsafe extern "C" fn(Raw,*const c_char)->*mut List,
    attr_new:unsafe extern "C" fn(*const c_char,*const c_char)->Raw,
    attr_value:unsafe extern "C" fn(Raw,*const c_char),
    param_new:unsafe extern "C" fn(*const c_char)->Raw,
    attr_param:unsafe extern "C" fn(Raw,Raw,*const c_char),
    attr_add:unsafe extern "C" fn(Raw,Raw),
    attrs_remove:unsafe extern "C" fn(Raw,*const c_char,*const c_char),
    attr_free:Destroy,unref:Destroy,free:Destroy,error_free:unsafe extern "C" fn(*mut Error),
    list_free:unsafe extern "C" fn(*mut List,Destroy),slist_free:unsafe extern "C" fn(*mut SList,Destroy),
    _library:Library,
}
impl Api{
    /// A field's vCard attributes as an owned list of copies (what e_contact_get_attributes returned).
    unsafe fn get_attrs(&self,contact:Raw,field:c_int)->*mut List{unsafe{
        if let Some(attributes)=self.attributes{return attributes(contact,field);}
        let Some(by_name)=self.by_name else{return ptr::null_mut()};
        let found=by_name(contact,(self.vcard_name)(field));let mut copies=ptr::null_mut();let mut current=found;
        while !current.is_null(){copies=(self.list_append)(copies,(self.attr_copy)((*current).data));current=(*current).next;}
        (self.list_shallow_free)(found);copies
    }}
    /// Replaces a field's attributes with copies of `list` (what e_contact_set_attributes did).
    unsafe fn set_attrs(&self,contact:Raw,field:c_int,list:*mut List){unsafe{
        if let Some(set)=self.set_attributes{return set(contact,field,list);}
        (self.attrs_remove)(contact,ptr::null(),(self.vcard_name)(field));
        let mut current=list;while !current.is_null(){(self.append)(contact,(self.attr_copy)((*current).data));current=(*current).next;}
    }}
    fn load()->Result<Self,Value>{
        let library=Library::load(&crate::native_library::system_library("INTERCEPTOR_EDS_LIBRARY","libebook-1.2","evolution-data-server")?)?;
        macro_rules! symbol{($name:literal,$kind:ty)=>{unsafe{std::mem::transmute::<*mut c_void,$kind>(library.symbol(CStr::from_bytes_with_nul(concat!($name,"\0").as_bytes()).unwrap())?)}}}
        macro_rules! optional{($name:literal,$kind:ty)=>{unsafe{library.symbol(CStr::from_bytes_with_nul(concat!($name,"\0").as_bytes()).unwrap()).ok().map(|p|std::mem::transmute::<*mut c_void,$kind>(p))}}}
        // These are exported data symbols, not function pointers.
        let version=unsafe{(*library.symbol(c"eds_major_version")?.cast::<u32>(),*library.symbol(c"eds_minor_version")?.cast::<u32>(),*library.symbol(c"eds_micro_version")?.cast::<u32>())};
        if version.0!=3||version<(3,56,2){return Err(failure("version_mismatch",format!("native Contacts requires EDS 3.56.2+ within public ABI major 3; loaded{}.{}.{}",version.0,version.1,version.2)));}
        Ok(Self{
            registry_new:symbol!("e_source_registry_new_sync",unsafe extern "C" fn(Raw,*mut *mut Error)->Raw),sources:symbol!("e_source_registry_list_sources",unsafe extern "C" fn(Raw,*const c_char)->*mut List),source:symbol!("e_source_registry_ref_source",unsafe extern "C" fn(Raw,*const c_char)->Raw),default_source:symbol!("e_source_registry_ref_default_address_book",unsafe extern "C" fn(Raw)->Raw),uid:symbol!("e_source_get_uid",unsafe extern "C" fn(Raw)->*const c_char),name:symbol!("e_source_get_display_name",unsafe extern "C" fn(Raw)->*const c_char),
            builtin_source:symbol!("e_source_registry_ref_builtin_address_book",unsafe extern "C" fn(Raw)->Raw),is_self:symbol!("e_book_client_is_self",unsafe extern "C" fn(Raw)->c_int),add_many:symbol!("e_book_client_add_contacts_sync",unsafe extern "C" fn(Raw,*mut SList,u32,*mut *mut SList,Raw,*mut *mut Error)->c_int),
            has_extension:symbol!("e_source_has_extension",unsafe extern "C" fn(Raw,*const c_char)->c_int),
            cursor:symbol!("e_book_client_get_cursor_sync",unsafe extern "C" fn(Raw,*const c_char,*const c_int,*const c_int,u32,*mut Raw,Raw,*mut *mut Error)->c_int),step:symbol!("e_book_client_cursor_step_sync",unsafe extern "C" fn(Raw,c_int,c_int,c_int,*mut *mut SList,Raw,*mut *mut Error)->c_int),
            connect:symbol!("e_book_client_connect_sync",unsafe extern "C" fn(Raw,u32,Raw,*mut *mut Error)->Raw),readonly:symbol!("e_client_is_readonly",unsafe extern "C" fn(Raw)->c_int),get:symbol!("e_book_client_get_contact_sync",unsafe extern "C" fn(Raw,*const c_char,*mut Raw,Raw,*mut *mut Error)->c_int),add:symbol!("e_book_client_add_contact_sync",unsafe extern "C" fn(Raw,Raw,u32,*mut *mut c_char,Raw,*mut *mut Error)->c_int),modify:symbol!("e_book_client_modify_contact_sync",unsafe extern "C" fn(Raw,Raw,u32,Raw,*mut *mut Error)->c_int),delete:symbol!("e_book_client_remove_contact_sync",unsafe extern "C" fn(Raw,Raw,u32,Raw,*mut *mut Error)->c_int),
            new_contact:symbol!("e_contact_new",unsafe extern "C" fn()->Raw),from_vcard:symbol!("e_contact_new_from_vcard",unsafe extern "C" fn(*const c_char)->Raw),field:symbol!("e_contact_field_id",unsafe extern "C" fn(*const c_char)->c_int),constant:symbol!("e_contact_get_const",unsafe extern "C" fn(Raw,c_int)->Raw),set:symbol!("e_contact_set",unsafe extern "C" fn(Raw,c_int,*const c_void)),to_vcard:symbol!("e_vcard_to_string",unsafe extern "C" fn(Raw,c_int)->*mut c_char),attributes:optional!("e_contact_get_attributes",unsafe extern "C" fn(Raw,c_int)->*mut List),vcard_name:symbol!("e_contact_vcard_attribute",unsafe extern "C" fn(c_int)->*const c_char),by_name:optional!("e_vcard_get_attributes_by_name",unsafe extern "C" fn(Raw,*const c_char)->*mut List),attr_copy:symbol!("e_vcard_attribute_copy",unsafe extern "C" fn(Raw)->Raw),append:symbol!("e_vcard_append_attribute",unsafe extern "C" fn(Raw,Raw)),list_append:symbol!("g_list_append",unsafe extern "C" fn(*mut List,Raw)->*mut List),list_shallow_free:symbol!("g_list_free",unsafe extern "C" fn(*mut List)),values:symbol!("e_vcard_attribute_get_values",unsafe extern "C" fn(Raw)->*mut List),parameter:symbol!("e_vcard_attribute_get_param",unsafe extern "C" fn(Raw,*const c_char)->*mut List),attr_new:symbol!("e_vcard_attribute_new",unsafe extern "C" fn(*const c_char,*const c_char)->Raw),attr_value:symbol!("e_vcard_attribute_add_value",unsafe extern "C" fn(Raw,*const c_char)),param_new:symbol!("e_vcard_attribute_param_new",unsafe extern "C" fn(*const c_char)->Raw),attr_param:symbol!("e_vcard_attribute_add_param_with_value",unsafe extern "C" fn(Raw,Raw,*const c_char)),attr_add:symbol!("e_vcard_add_attribute",unsafe extern "C" fn(Raw,Raw)),attrs_remove:symbol!("e_vcard_remove_attributes",unsafe extern "C" fn(Raw,*const c_char,*const c_char)),
            query_field:symbol!("e_book_query_field_test",unsafe extern "C" fn(c_int,c_int,*const c_char)->Raw),query_any:symbol!("e_book_query_any_field_contains",unsafe extern "C" fn(*const c_char)->Raw),query_text:symbol!("e_book_query_to_string",unsafe extern "C" fn(Raw)->*mut c_char),query_unref:symbol!("e_book_query_unref",Destroy),
            owned:symbol!("e_contact_get",unsafe extern "C" fn(Raw,c_int)->Raw),name_string:symbol!("e_contact_name_to_string",unsafe extern "C" fn(Raw)->*mut c_char),name_free:symbol!("e_contact_name_free",Destroy),
            photo_free:symbol!("e_contact_photo_free",Destroy),photo_bytes:symbol!("e_contact_photo_get_inlined",unsafe extern "C" fn(Raw,*mut usize)->*const u8),
            set_attributes:optional!("e_contact_set_attributes",unsafe extern "C" fn(Raw,c_int,*mut List)),destination_new:symbol!("e_destination_new",unsafe extern "C" fn()->Raw),destination_contact:symbol!("e_destination_set_contact",unsafe extern "C" fn(Raw,Raw,c_int)),destination_client:symbol!("e_destination_set_client",unsafe extern "C" fn(Raw,Raw)),destination_export:symbol!("e_destination_export_to_vcard_attribute",unsafe extern "C" fn(Raw,Raw)),
            attr_free:symbol!("e_vcard_attribute_free",Destroy),unref:symbol!("g_object_unref",Destroy),free:symbol!("g_free",Destroy),error_free:symbol!("g_error_free",unsafe extern "C" fn(*mut Error)),list_free:symbol!("g_list_free_full",unsafe extern "C" fn(*mut List,Destroy)),slist_free:symbol!("g_slist_free_full",unsafe extern "C" fn(*mut SList,Destroy)),_library:library,
        })
    }
    fn check(&self,ok:bool,error:*mut Error)->Result<(),Value>{
        if !error.is_null(){unsafe{let error=&*error;let text=text(error.message,4096);let mut result=failure("provider_failed",text.unwrap_or_else(|_|"native EDS error text is invalid".into()));result["details"]=json!({"nativeDomain":error.domain,"nativeCode":error.code});(self.error_free)(error as *const Error as *mut Error);return Err(result);}}
        if !ok{Err(failure("provider_failed","native Evolution Data Server returned no result"))}else{Ok(())}
    }
    fn id(&self,name:&CStr)->Result<c_int,Value>{let id=unsafe{(self.field)(name.as_ptr())};if id<=0{Err(failure("version_mismatch",format!("native EDS contact field{} is unavailable",name.to_string_lossy())))}else{Ok(id)}}
    fn string(&self,contact:Raw,name:&CStr)->Result<String,Value>{let pointer=unsafe{(self.constant)(contact,self.id(name)?)};if pointer.is_null(){Ok(String::new())}else{text(pointer.cast(),4096)}}
    fn write(&self,contact:Raw,name:&CStr,value:&str)->Result<(),Value>{let value=cstring(value)?;unsafe{(self.set)(contact,self.id(name)?,value.as_ptr().cast())};Ok(())}
    fn sync_name(&self,contact:Raw)->Result<(),Value>{
        let name=unsafe{(self.owned)(contact,self.id(c"name")?)};if name.is_null(){return self.write(contact,c"full_name","");}
        let pointer=unsafe{(self.name_string)(name)};unsafe{(self.name_free)(name)};let value=text(pointer,4096);unsafe{(self.free)(pointer.cast())};self.write(contact,c"full_name",&value?)
    }
    fn contact(&self,client:Raw,id:&str)->Result<Object,Value>{let id=cstring(id)?;let mut out=ptr::null_mut();let mut error=ptr::null_mut();let ok=unsafe{(self.get)(client,id.as_ptr(),&mut out,ptr::null_mut(),&mut error)};let contact=Object::from(out);self.check(ok!=0,error)?;contact.ok_or_else(||failure("unsupported_target","native EDS contact does not exist"))}
    fn person(&self,client:Raw,id:&str)->Result<Object,Value>{let contact=self.contact(client,id)?;if self.is_group(contact.0)?{return Err(failure("unsupported_target","native distribution lists require a Contacts group selector"));}Ok(contact)}
    fn connect_source(&self,registry:Raw,id:&str)->Result<(Object,Object),Value>{
        let source=Object::from(unsafe{(self.source)(registry,cstring(id)?.as_ptr())}).ok_or_else(||failure("unsupported_target","native Contacts member address book is absent"))?;
        if text(unsafe{(self.uid)(source.0)},4096)?!=id||unsafe{(self.has_extension)(source.0,c"Address Book".as_ptr())}==0{return Err(failure("unsupported_target","native Contacts member source identity differs"));}
        let mut error=ptr::null_mut();let client=Object::from(unsafe{(self.connect)(source.0,CONNECT_WAIT_SECONDS,ptr::null_mut(),&mut error)});self.check(client.is_some(),error)?;Ok((source,client.unwrap()))
    }
    fn is_group(&self,contact:Raw)->Result<bool,Value>{Ok(!unsafe{(self.owned)(contact,self.id(c"list")?)}.is_null())}
    fn group(&self,contact:Raw,source:&str)->Result<Value,Value>{
        if !self.is_group(contact)?{return Err(failure("unsupported_target","native EDS target is not a distribution list"));}
        Ok(json!({"id":group_identity(source,&self.string(contact,c"id")?)?,"name":self.string(contact,c"full_name")?}))
    }
    fn member_identity(&self,attr:Raw)->Result<Option<(String,String)>,Value>{
        let parameter=|name:&CStr|->Result<Option<String>,Value>{let values=unsafe{(self.parameter)(attr,name.as_ptr())};if values.is_null(){return Ok(None);}if !unsafe{(*values).next}.is_null(){return Err(failure("unsupported_target","native group member has multiple identity parameters"));}Ok(Some(text(unsafe{(*values).data.cast()},4096)?))};
        match(parameter(c"X-EVOLUTION-DEST-SOURCE-UID")?,parameter(c"X-EVOLUTION-DEST-CONTACT-UID")?){(Some(source),Some(uid))if !source.is_empty()&&!uid.is_empty()=>Ok(Some((source,uid))),_=>Ok(None)}
    }
    fn member_attributes(&self,group:Raw)->Result<OwnedList<'_>,Value>{
        if !self.is_group(group)?{return Err(failure("unsupported_target","native Contacts group identity is not a distribution list"));}
        Ok(OwnedList{api:self,raw:unsafe{self.get_attrs(group,self.id(c"email")?)},kind:0})
    }
    fn members(&self,registry:Raw,group:Raw,a:&Value)->Result<Value,Value>{
        let owned=self.member_attributes(group)?;let mut current=owned.raw;let mut identities=std::collections::HashSet::new();let mut rows=Vec::new();let offset=crate::contacts::integer(&a["offset"]).unwrap_or(0)as usize;let limit=crate::contacts::integer(&a["limit"]).unwrap_or(100)as usize;let mut scanned=0;
        while !current.is_null(){scanned+=1;if scanned>1000{return Err(failure("resource_limit","native Contacts group exceeds 1000 members"));}let(source,uid)=self.member_identity(unsafe{(*current).data})?.ok_or_else(||failure("unsupported_target","native distribution list has an address without an exact source/card link; no member was silently omitted"))?;
            let id=identity(&source,&uid)?;if identities.insert(id){if identities.len()>offset&&rows.len()<limit{let(_source,client)=self.connect_source(registry,&source)?;let contact=self.contact(client.0,&uid)?;if self.is_group(contact.0)?{return Err(failure("unsupported_target","nested native distribution lists require separate subgroup semantics"));}rows.push(crate::contacts::project(a,self.row(contact.0,&source,a)?));}}current=unsafe{(*current).next};
        }Ok(json!({"limit":limit,"offset":offset,"contacts":rows}))
    }
    fn change_member(&self,registry:Raw,client:Raw,source:&str,group:Raw,a:&Value)->Result<Value,Value>{
        let member_id=a["contact"].as_str().unwrap();let(member_source,member_uid)=target(member_id)?;let(_source,member_client)=self.connect_source(registry,&member_source)?;let contact=self.contact(member_client.0,&member_uid)?;
        if self.is_group(contact.0)?{return Err(failure("unsupported_target","native distribution-list nesting is not contact membership"));}
        let owned=self.member_attributes(group)?;let mut current=owned.raw;let mut attrs=Vec::new();let mut present=false;let add=a["sub"]=="group-add-member";let mut scanned=0;
        while !current.is_null(){scanned+=1;if scanned>1000{return Err(failure("resource_limit","native Contacts group exceeds 1000 member addresses"));}let attr=unsafe{(*current).data};let matches=self.member_identity(attr)?.is_some_and(|(s,u)|s==member_source&&u==member_uid);present|=matches;if add||!matches{attrs.push(attr);}current=unsafe{(*current).next};}
        let mut added=None;
        if add&&!present{
            if attrs.len()>=1000{return Err(failure("resource_limit","native Contacts group has no remaining member capacity"));}
            if self.labeled(contact.0,c"email")?.is_empty(){return Err(failure("unsupported_target","native EDS distribution-list membership requires a contact email address"));}
            let destination=Object::from(unsafe{(self.destination_new)()}).ok_or_else(||failure("provider_failed","native EDS destination allocation failed"))?;
            let attr=unsafe{(self.attr_new)(ptr::null(),c"EMAIL".as_ptr())};if attr.is_null(){return Err(failure("provider_failed","native EDS member attribute allocation failed"));}added=Some(OwnedAttribute{api:self,raw:attr});
            unsafe{(self.destination_contact)(destination.0,contact.0,0);(self.destination_client)(destination.0,member_client.0);(self.destination_export)(destination.0,attr);}attrs.push(attr);
        }
        if add!=present{
            let mut links=attrs.into_iter().map(|data|List{data,next:ptr::null_mut(),previous:ptr::null_mut()}).collect::<Vec<_>>();let base=links.as_mut_ptr();for index in 0..links.len(){links[index].next=if index+1<links.len(){unsafe{base.add(index+1)}}else{ptr::null_mut()};links[index].previous=if index>0{unsafe{base.add(index-1)}}else{ptr::null_mut()};}
            // set_attributes() copies the attributes. Retain the native clones
            // and the new attribute until it returns; preserve every other member.
            unsafe{self.set_attrs(group,self.id(c"email")?,if links.is_empty(){ptr::null_mut()}else{base})};
            let mut error=ptr::null_mut();let ok=unsafe{(self.modify)(client,group,1,ptr::null_mut(),&mut error)};self.check(ok!=0,error)?;
            let saved=self.contact(client,&self.string(group,c"id")?).map_err(|_|failure("partial_result","native group membership saved but readback failed; no replay"))?;self.group(saved.0,source)?;let receipt=self.member_attributes(saved.0)?;let mut current=receipt.raw;let mut found=false;let mut count=0;
            while !current.is_null(){count+=1;if count>1000{return Err(failure("partial_result","native group readback exceeds its member bound"));}found|=self.member_identity(unsafe{(*current).data})?.is_some_and(|(s,u)|s==member_source&&u==member_uid);current=unsafe{(*current).next};}
            if found!=add{return Err(failure("partial_result","native group membership readback differs from requested effect; no replay"));}
        }
        drop(added);Ok(json!({"ok":true,"group":a["id"],"contact":member_id,"added":add}))
    }
    fn labeled(&self,contact:Raw,field:&CStr)->Result<Vec<Value>,Value>{
        let raw=unsafe{self.get_attrs(contact,self.id(field)?)};let _owned=OwnedList{api:self,raw,kind:0};let mut current=raw;let mut rows=Vec::new();
        while !current.is_null(){if rows.len()>=32{return Err(failure("resource_limit","native Contact labeled values exceed 32"));}unsafe{let attr=(*current).data;let mut values=(self.values)(attr);let label=self.label(attr)?;while !values.is_null(){if rows.len()>=32{return Err(failure("resource_limit","native Contact labeled values exceed 32"));}rows.push(json!({"label":label,"value":text((*values).data.cast(),4096)?}));values=(*values).next;}current=(*current).next;}}
        Ok(rows)
    }
    fn label(&self,attr:Raw)->Result<String,Value>{let mut raw=unsafe{(self.parameter)(attr,c"TYPE".as_ptr())};let mut labels=Vec::new();while !raw.is_null(){if labels.len()>=32{return Err(failure("resource_limit","native Contact TYPE labels exceed 32"));}labels.push(text(unsafe{(*raw).data.cast()},128)?);raw=unsafe{(*raw).next};}Ok(labels.join(","))}
    fn query_string(&self,a:&Value)->Result<CString,Value>{
        // groups reads every contact and keeps the lists, as list and me do; only find carries a field.
        let raw=if matches!(a["sub"].as_str(),Some("list"|"me"|"groups")){unsafe{(self.query_any)(c"".as_ptr())}}else{
            let(field,kind,value)=if let Some(v)=a["email"].as_str(){(c"email",0,v.to_owned())}else if let Some(v)=a["phone"].as_str(){let(kind,value)=phone_query(v);(c"phone",kind,value)}else{(c"full_name",1,a["query"].as_str().or(a["name"].as_str()).unwrap().to_owned())};
            unsafe{(self.query_field)(self.id(field)?,kind,cstring(&value)?.as_ptr())}
        };
        if raw.is_null(){return Err(failure("provider_failed","native Contacts query allocation failed"));}
        let pointer=unsafe{(self.query_text)(raw)};unsafe{(self.query_unref)(raw)};let result=text(pointer,32768);unsafe{(self.free)(pointer.cast())};cstring(&result?)
    }
    fn read(&self,client:Raw,source:&str,a:&Value,remaining_offset:&mut usize,scanned:&mut usize)->Result<Value,Value>{
        let sub=a["sub"].as_str().unwrap();let query=self.query_string(a)?;let field=self.id(c"file_as")?;let mut raw=ptr::null_mut();let mut error=ptr::null_mut();let ok=unsafe{(self.cursor)(client,query.as_ptr(),&field,&0,1,&mut raw,ptr::null_mut(),&mut error)};
        let cursor=Object::from(raw);self.check(ok!=0,error)?;let cursor=cursor.ok_or_else(||failure("provider_failed","native Contacts cursor is absent"))?;
        let offset=crate::contacts::integer(&a["offset"]).unwrap_or(0)as usize;let limit=crate::contacts::integer(&a["limit"]).unwrap_or(if matches!(sub,"find"|"groups"){1000}else{100})as usize;
        let mut rows=Vec::new();let mut first=true;
        loop{
            let count=128;let mut raw=ptr::null_mut();let mut error=ptr::null_mut();let stepped=unsafe{(self.step)(cursor.0,3,if first{1}else{0},count as c_int,&mut raw,ptr::null_mut(),&mut error)};first=false;
            let _owned=OwnedList{api:self,raw:raw.cast(),kind:2};self.check(stepped>=0,error)?;let mut current=raw;let mut native_count=0;
            while !current.is_null(){native_count+=1;*scanned+=1;if native_count>count||*scanned>12000{return Err(failure("resource_limit","native Contacts cursor exceeded its bounded scan"));}let contact=unsafe{(*current).data};let is_group=self.is_group(contact)?;let matches=if sub=="groups"{is_group}else{!is_group&&(sub!="me"||unsafe{(self.is_self)(contact)}!=0)};
                if matches{if *remaining_offset>0{*remaining_offset-=1;}else{if rows.len()==limit{if matches!(sub,"find"|"groups"){return Err(failure("resource_limit","native Contacts search/group inventory exceeds 1000; narrow its scope"));}return Ok(json!({"limit":limit,"offset":offset,"contacts":rows}));}rows.push(if sub=="groups"{self.group(contact,source)?}else{crate::contacts::project(a,self.row(contact,source,a)?)});}}current=unsafe{(*current).next};}
            if sub=="list"&&rows.len()==limit{break;}if sub=="me"&&rows.len()>1{return Err(failure("unsupported_target","native existing EDS Me card is ambiguous; no card was created"));}if native_count<count{break;}
        }
        // get_self() can create and save a guessed card. is_self() is read-only.
        if sub=="me"{return if rows.len()==1{Ok(rows.remove(0))}else{Err(failure("unsupported_target","native existing EDS Me card is absent; no card was created"))};}
        Ok(if sub=="find"{json!({"matches":rows})}else if sub=="groups"{json!({"groups":rows})}else{json!({"limit":limit,"offset":offset,"contacts":rows})})
    }
    fn read_all(&self,registry:Raw,a:&Value)->Result<Value,Value>{
        let sub=a["sub"].as_str().unwrap();let offset=crate::contacts::integer(&a["offset"]).unwrap_or(0)as usize;let limit=crate::contacts::integer(&a["limit"]).unwrap_or(if matches!(sub,"find"|"groups"){1000}else{100})as usize;
        let raw=unsafe{(self.sources)(registry,c"Address Book".as_ptr())};let owned=OwnedList{api:self,raw,kind:1};let mut current=owned.raw;let mut books=0;let mut rows=Vec::new();let mut remaining_offset=offset;let mut scanned=0;let key=if sub=="find"{"matches"}else if sub=="groups"{"groups"}else{"contacts"};
        while !current.is_null(){books+=1;if books>128{return Err(failure("resource_limit","native Contacts inventory exceeds 128 address books"));}let id=text(unsafe{(self.uid)((*current).data)},4096)?;let(_source,client)=self.connect_source(registry,&id)?;
            let mut request=a.clone();request["limit"]=json!(limit.saturating_sub(rows.len()).max(1));let result=self.read(client.0,&id,&request,&mut remaining_offset,&mut scanned)?;let values=result[key].as_array().unwrap();
            if rows.len()+values.len()>limit{return Err(failure("resource_limit","native Contacts inventory exceeds its requested bound; narrow its scope"));}rows.extend(values.iter().cloned());if sub=="list"&&rows.len()==limit{break;}current=unsafe{(*current).next};
        }Ok(if sub=="find"{json!({"matches":rows})}else if sub=="groups"{json!({"groups":rows})}else{json!({"limit":limit,"offset":offset,"contacts":rows})})
    }
    fn fields(&self,contact:Raw,field:&CStr)->Result<Vec<(String,Vec<String>)>,Value>{
        let raw=unsafe{self.get_attrs(contact,self.id(field)?)};let _owned=OwnedList{api:self,raw,kind:0};let mut current=raw;let mut rows=Vec::new();
        while !current.is_null(){if rows.len()>=32{return Err(failure("resource_limit","native Contact structured values exceed 32"));}let attr=unsafe{(*current).data};let mut values=unsafe{(self.values)(attr)};let mut parts=Vec::new();while !values.is_null(){if parts.len()>=32{return Err(failure("resource_limit","native Contact structured components exceed 32"));}parts.push(text(unsafe{(*values).data.cast()},4096)?);values=unsafe{(*values).next};}rows.push((self.label(attr)?,parts));current=unsafe{(*current).next};}Ok(rows)
    }
    fn postal(&self,contact:Raw)->Result<Vec<Value>,Value>{
        self.fields(contact,c"address")?.into_iter().map(|(label,mut parts)|{if parts.len()>7{return Err(failure("unsupported_target","native vCard address has more than seven components"));}parts.resize(7,String::new());let street=parts[..3].iter().filter(|s|!s.is_empty()).cloned().collect::<Vec<_>>().join("\n");Ok(json!({"label":label,"street":street,"city":parts[3],"state":parts[4],"postalCode":parts[5],"country":parts[6]}))}).collect()
    }
    fn set_postal(&self,contact:Raw,raw:&str)->Result<(),Value>{
        let(label,value)=raw.split_once(':').unwrap();let label=cstring(label)?;let parts=value.split(';').map(cstring).collect::<Result<Vec<_>,_>>()?;
        unsafe{let attr=(self.attr_new)(ptr::null(),c"ADR".as_ptr());if attr.is_null(){return Err(failure("provider_failed","native address allocation failed"));}let param=(self.param_new)(c"TYPE".as_ptr());if param.is_null(){(self.attr_free)(attr);return Err(failure("provider_failed","native address label allocation failed"));}(self.attr_param)(attr,param,label.as_ptr());for part in [c"",c""].into_iter().chain(parts.iter().map(|p|p.as_c_str())){(self.attr_value)(attr,part.as_ptr());}(self.attrs_remove)(contact,ptr::null(),c"ADR".as_ptr());(self.attr_add)(contact,attr);}Ok(())
    }
    fn set_birthday(&self,contact:Raw,value:&str)->Result<(),Value>{
        // EDS e_contact_date_to_string() clamps years below1000. Write the
        // validated BDAY attribute through the native vCard API instead.
        let value=cstring(value)?;unsafe{let attr=(self.attr_new)(ptr::null(),c"BDAY".as_ptr());if attr.is_null(){return Err(failure("provider_failed","native birthday attribute allocation failed"));}(self.attr_value)(attr,value.as_ptr());(self.attrs_remove)(contact,ptr::null(),c"BDAY".as_ptr());(self.attr_add)(contact,attr);}Ok(())
    }
    fn set_labeled(&self,contact:Raw,name:&CStr,raw:&str)->Result<(),Value>{
        let rows=crate::contacts::labeled(raw)?;unsafe{(self.attrs_remove)(contact,ptr::null(),name.as_ptr());}
        for(label,value)in rows{let label=cstring(label)?;let value=cstring(value)?;unsafe{let attr=(self.attr_new)(ptr::null(),name.as_ptr());if attr.is_null(){return Err(failure("provider_failed","native EDS vCard attribute allocation failed"));}let param=(self.param_new)(c"TYPE".as_ptr());if param.is_null(){(self.attr_free)(attr);return Err(failure("provider_failed","native EDS vCard parameter allocation failed"));}(self.attr_param)(attr,param,label.as_ptr());(self.attr_value)(attr,value.as_ptr());(self.attr_add)(contact,attr);}}
        Ok(())
    }
    fn row(&self,contact:Raw,source:&str,a:&Value)->Result<Value,Value>{
        let pointer=unsafe{(self.constant)(contact,self.id(c"note")?)};let note=if pointer.is_null(){String::new()}else{text(pointer.cast(),65536)?};
        let names=self.fields(contact,c"name")?;if names.len()>1{return Err(failure("unsupported_target","native Contact has multiple structured names"));}let mut name=names.into_iter().next().map(|r|r.1).unwrap_or_default();if name.len()>5{return Err(failure("unsupported_target","native Contact name exceeds five components"));}name.resize(5,String::new());
        let mut row=json!({"id":identity(source,&self.string(contact,c"id")?)?,"givenName":self.string(contact,c"given_name")?,"familyName":self.string(contact,c"family_name")?,"middleName":name[2],"namePrefix":name[3],"nameSuffix":name[4],"nickname":self.string(contact,c"nickname")?,"organization":{"name":self.string(contact,c"org")?,"department":self.string(contact,c"org_unit")?,"jobTitle":self.string(contact,c"title")?},"emailAddresses":self.labeled(contact,c"email")?,"phoneNumbers":self.labeled(contact,c"phone")?,"urlAddresses":self.labeled(contact,c"homepage_url")?,"postalAddresses":self.postal(contact)?,"note":if note.is_empty(){None}else{Some(note)}});
        let dates=self.fields(contact,c"birth_date")?;if dates.len()>1{return Err(failure("unsupported_target","native Contact has multiple birthdays"));}if let Some((_,parts))=dates.first(){if parts.len()!=1{return Err(failure("unsupported_target","native Contact birthday has multiple values"));}row["birthday"]=json!(birthday(&parts[0])?);}
        let mut dates=Vec::new();for(_,parts)in self.fields(contact,c"anniversary")?{if parts.len()!=1{return Err(failure("unsupported_target","native Contact anniversary has multiple values"));}dates.push(json!({"label":"anniversary","date":birthday(&parts[0])?}));}row["dates"]=json!(dates);
        let mut relations=Vec::new();for(label,field)in[("spouse",c"spouse"),("manager",c"manager"),("assistant",c"assistant")]{let name=self.string(contact,field)?;if !name.is_empty(){relations.push(json!({"label":label,"name":name}));}}row["contactRelations"]=json!(relations);
        let mut messages=Vec::new();for(service,field)in[("AIM",c"im_aim"),("GroupWise",c"im_groupwise"),("Jabber",c"im_jabber"),("Yahoo",c"im_yahoo"),("MSN",c"im_msn"),("ICQ",c"im_icq"),("Gadu-Gadu",c"im_gadugadu"),("Skype",c"im_skype"),("Google Talk",c"im_google_talk"),("Twitter",c"im_twitter"),("Matrix",c"im_matrix")]{for entry in self.labeled(contact,field)?{if messages.len()>=32{return Err(failure("resource_limit","native Contact instant-message values exceed 32"));}messages.push(json!({"label":entry["label"],"service":service,"username":entry["value"]}));}}row["instantMessageAddresses"]=json!(messages);
        let photo=unsafe{(self.owned)(contact,self.id(c"photo")?)};row["imageDataAvailable"]=json!(!photo.is_null());
        if !photo.is_null(){let _photo=OwnedPhoto{api:self,raw:photo};let kind=unsafe{*photo.cast::<c_int>()};
            if kind==0{if crate::contacts::image_requested(a,"thumbnailDataUrl")||crate::contacts::image_requested(a,"imageDataUrl"){let mut length=0;let bytes=unsafe{(self.photo_bytes)(photo,&mut length)};if bytes.is_null()||length==0{return Err(failure("provider_failed","native Contact inline photo has no encoded bytes"));}let bytes=unsafe{std::slice::from_raw_parts(bytes,length)};
                // A photo over 192KiB or in a format the bounded decoder refuses (GIF, HEIC) leaves this row without image data; it never fails the read.
                for(key,thumbnail)in[("thumbnailDataUrl",true),("imageDataUrl",false)]{if crate::contacts::image_requested(a,key){if let Ok(url)=crate::contacts::image_url(bytes,thumbnail){row[key]=json!(url);}}}}}
            else if kind==1{if a["keys"].as_str().is_some_and(|keys|keys.split(',').any(|key|matches!(key,"thumbnailDataUrl"|"imageDataUrl"))){return Err(failure("unsupported_target","native Contact photo is a URI rather than inline bytes; no implicit file or network fetch performed"));}}
            else{return Err(failure("version_mismatch","native Contact photo discriminator is unknown"));}
        }Ok(row)
    }
}
/// Phone search as (EBookQueryTest, value). "+" input is E.164 and uses EQUALS_PHONE_NUMBER (4). Without a country
/// code EDS can parse neither that nor EQUALS_NATIONAL_PHONE_NUMBER (5) unless a phone region is configured, and the
/// cursor refuses the query, so other input matches its digits with CONTAINS (1), ignoring formatting.
fn phone_query(value:&str)->(i32,String){
    if value.trim_start().starts_with('+'){return(4,value.to_owned());}
    let digits:String=value.chars().filter(char::is_ascii_digit).collect();
    (1,if digits.is_empty(){value.to_owned()}else{digits})
}
struct OwnedList<'a>{api:&'a Api,raw:*mut List,kind:u8}
struct OwnedAttribute<'a>{api:&'a Api,raw:Raw}
impl Drop for OwnedAttribute<'_>{fn drop(&mut self){unsafe{(self.api.attr_free)(self.raw)}}}
struct OwnedPhoto<'a>{api:&'a Api,raw:Raw}
impl Drop for OwnedPhoto<'_>{fn drop(&mut self){unsafe{(self.api.photo_free)(self.raw)}}}
impl Drop for OwnedList<'_>{fn drop(&mut self){unsafe{match self.kind{2=>(self.api.slist_free)(self.raw.cast(),self.api.unref),3=>(self.api.slist_free)(self.raw.cast(),self.api.free),_=>(self.api.list_free)(self.raw,if self.kind==0{self.api.attr_free}else{self.api.unref})}}}}
pub(crate) fn cstring(value:&str)->Result<CString,Value>{CString::new(value).map_err(|_|failure("invalid_request","native value contains NUL"))}
pub(crate) fn text(pointer:*const c_char,limit:usize)->Result<String,Value>{if pointer.is_null(){return Err(failure("provider_failed","native provider returned null text"));}let length=unsafe{libc::strnlen(pointer,limit+1)};if length>limit{return Err(failure("resource_limit","native text exceeds its bound"));}unsafe{std::str::from_utf8(std::slice::from_raw_parts(pointer.cast::<u8>(),length))}.map(str::to_owned).map_err(|_|failure("provider_failed","native text is not UTF8"))}
fn identity(source:&str,uid:&str)->Result<String,Value>{
    use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD};
    if source.is_empty()||uid.is_empty()||source.contains('\0')||uid.contains('\0'){return Err(failure("partial_result","native Contacts source or card identity is missing"));}
    let id=format!("eds:{}",URL_SAFE_NO_PAD.encode(format!("{source}\0{uid}")));if id.len()>4096{return Err(failure("resource_limit","native Contacts compound identity exceeds 4096 bytes"));}Ok(id)
}
fn target(id:&str)->Result<(String,String),Value>{
    use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD};
    let fail=||failure("unsupported_target","native Contacts requires the exact EDS source/card identity returned by a read");
    let text=id.strip_prefix("eds:").and_then(|v|URL_SAFE_NO_PAD.decode(v).ok()).and_then(|bytes|String::from_utf8(bytes).ok()).ok_or_else(fail)?;
    let(source,uid)=text.split_once('\0').ok_or_else(fail)?;if uid.contains('\0')||identity(source,uid)?!=id{return Err(fail());}Ok((source.into(),uid.into()))
}
fn group_identity(source:&str,uid:&str)->Result<String,Value>{let id=identity(source,uid)?.replacen("eds:","eds-group:",1);if id.len()>4096{return Err(failure("resource_limit","native group identity exceeds 4096 bytes"));}Ok(id)}
fn group_target(id:&str)->Result<(String,String),Value>{let encoded=id.strip_prefix("eds-group:").ok_or_else(||failure("unsupported_target","native Contacts group requires the exact EDS distribution-list identity returned by a read"))?;target(&format!("eds:{encoded}"))}
fn birthday(raw:&str)->Result<String,Value>{
    let day=raw.split('T').next().unwrap();
    let value=if day.len()==8&&day.bytes().all(|b|b.is_ascii_digit()){format!("{}-{}-{}",&day[..4],&day[4..6],&day[6..])}else if day.len()==7&&day.starts_with("--"){format!("2000-{}",&day[2..])}else{day.to_string()};
    crate::contacts::validate(&json!({"type":"desktop_contacts","sub":"create","birthday":value})).map_err(|_|failure("unsupported_target","native vCard birthday does not contain valid supported calendar components"))?;
    Ok(if day.starts_with("--"){day.to_string()}else{value})
}
/// Seconds EDS waits for a backend to report itself online. Local sources often never do, so
/// 5 s cost 5 s per source on every request; 1 s still lets remote backends come up. 0 crashed.
pub(crate) const CONNECT_WAIT_SECONDS:u32=1;
pub(crate) fn native(a:&Value)->Result<Value,Value>{
    let api=Api::load()?;let mut error=ptr::null_mut();let registry=Object::from(unsafe{(api.registry_new)(ptr::null_mut(),&mut error)});api.check(registry.is_some(),error)?;let registry=registry.unwrap();let sub=a["sub"].as_str().unwrap();
    if a["keys"].as_str().is_some_and(|keys|keys.split(',').any(|key|matches!(key,"contactType"|"phonetic"|"socialProfiles"|"requires_entitlement"))){return Err(failure("unsupported_operation","selected Contact key has no implemented EDS field mapping; no requested field was silently omitted"));}
    if sub=="status"{return Ok(json!({"status":"unknown","supportsLimited":false,"notesEntitlement":false,"provider":"Evolution Data Server","scope":"native registry accessible; source-specific access and write permission remain unknown"}));}
    if sub=="containers"{let raw=unsafe{(api.sources)(registry.0,c"Address Book".as_ptr())};let _owned=OwnedList{api:&api,raw,kind:1};let mut current=raw;let mut rows=Vec::new();while !current.is_null(){if rows.len()>=128{return Err(failure("resource_limit","native EDS address books exceed 128"));}unsafe{rows.push(json!({"id":text((api.uid)((*current).data),4096)?,"name":text((api.name)((*current).data),4096)?,"type":"native-address-book"}));current=(*current).next;}}return Ok(json!({"containers":rows}));}
    if matches!(sub,"list"|"find"|"groups")&&a.get("container").is_none()&&a.get("group").is_none(){return api.read_all(registry.0,a);}
    // EDS keeps no change history: tokens are saved snapshots of every address book (contacts and groups).
    if matches!(sub,"current-token"|"changes"){
        let mut contacts=crate::snapshot::Digests::new();let mut offset=0u64;
        loop{let page=api.read_all(registry.0,&json!({"type":"desktop_contacts","sub":"list","limit":1000,"offset":offset}))?;let rows=page["contacts"].as_array().cloned().unwrap_or_default();
            for row in &rows{if let Some(id)=row["id"].as_str(){contacts.insert(id.to_owned(),crate::snapshot::digest(row));}}
            if rows.len()<1000{break;}offset+=1000;if offset>=20000{return Err(failure("resource_limit","contacts change tokens cover at most 20000 contacts"));}}
        let groups=api.read_all(registry.0,&json!({"type":"desktop_contacts","sub":"groups"}))?;
        let groups=groups["groups"].as_array().into_iter().flatten().filter_map(|g|Some((g["id"].as_str()?.to_owned(),crate::snapshot::digest(g)))).collect();
        return crate::snapshot::contact_history(a,contacts,groups);
    }
    let target=if matches!(sub,"group"|"group-update"|"group-delete"|"group-add-member"|"group-remove-member"){Some(group_target(a["id"].as_str().unwrap())?)}else if sub=="list"&&a.get("group").is_some(){Some(group_target(a["group"].as_str().unwrap())?)}else if matches!(sub,"contact"|"update"|"delete"|"vcard"){Some(target(a["id"].as_str().unwrap())?)}else{None};
    let source=if let Some((source,_))=&target{unsafe{(api.source)(registry.0,cstring(source)?.as_ptr())}}else if sub=="me"{unsafe{(api.builtin_source)(registry.0)}}else if let Some(id)=a["container"].as_str(){unsafe{(api.source)(registry.0,cstring(id)?.as_ptr())}}else{unsafe{(api.default_source)(registry.0)}};let source=Object::from(source).ok_or_else(||failure("unsupported_target","native EDS address-book identity is absent"))?;
    let source_id=text(unsafe{(api.uid)(source.0)},4096)?;
    if unsafe{(api.has_extension)(source.0,c"Address Book".as_ptr())}==0||target.as_ref().is_some_and(|(id,_)|id!=&source_id)||a["container"].as_str().is_some_and(|id|id!=source_id){return Err(failure("unsupported_target","native Contacts source identity or address-book extension does not match the requested target"));}
    if sub=="default-container"{return Ok(json!({"id":text(unsafe{(api.uid)(source.0)},4096)?}));}
    let mut error=ptr::null_mut();let client=Object::from(unsafe{(api.connect)(source.0,CONNECT_WAIT_SECONDS,ptr::null_mut(),&mut error)});let connected=api.check(client.is_some(),error);
    if sub=="request"{let granted=connected.is_ok();let message=connected.err().map(|value|value["error"].clone());return Ok(json!({"granted":granted,"error":message}));}connected?;let client=client.unwrap();
    match sub{
        "list" if a.get("group").is_some()=>api.members(registry.0,api.contact(client.0,&target.as_ref().unwrap().1)?.0,a),
        "list"|"find"|"me"|"groups"=>api.read(client.0,&source_id,a,&mut(crate::contacts::integer(&a["offset"]).unwrap_or(0)as usize),&mut 0),
        "group"=>api.group(api.contact(client.0,&target.as_ref().unwrap().1)?.0,&source_id),
        "group-create"|"group-update"=>{
            if unsafe{(api.readonly)(client.0)}!=0{return Err(failure("permission_denied","native EDS address book is read-only"));}
            let group=if sub=="group-create"{Object::from(unsafe{(api.new_contact)()}).ok_or_else(||failure("provider_failed","native distribution-list allocation failed"))?}else{let group=api.contact(client.0,&target.as_ref().unwrap().1)?;api.group(group.0,&source_id)?;group};
            let name=a["name"].as_str().unwrap();api.write(group.0,c"full_name",name)?;api.write(group.0,c"file_as",name)?;
            // e_contact_set writes the list flag each EDS version reads back: X-EVOLUTION-LIST in vCard 3.0,
            // KIND:group in the vCard 4.0 that EDS 3.60 writes (a raw X-EVOLUTION-LIST is ignored there).
            if sub=="group-create"{unsafe{(api.set)(group.0,api.id(c"list")?,1usize as *const c_void)};}
            let mut error=ptr::null_mut();let mut uid=ptr::null_mut();let ok=unsafe{if sub=="group-create"{(api.add)(client.0,group.0,1,&mut uid,ptr::null_mut(),&mut error)}else{(api.modify)(client.0,group.0,1,ptr::null_mut(),&mut error)}};
            let id=if !uid.is_null(){let id=text(uid,4096);unsafe{(api.free)(uid.cast())};Some(id)}else{None};api.check(ok!=0,error)?;let id=match id{Some(id)=>id?,None=>api.string(group.0,c"id")?};
            let saved=api.contact(client.0,&id).map_err(|_|failure("partial_result","native distribution list saved but readback failed; no replay"))?;let row=api.group(saved.0,&source_id)?;if row["name"]!=name{return Err(failure("partial_result","native distribution-list name readback differs; no replay"));}Ok(row)
        },
        "group-delete"=>{if unsafe{(api.readonly)(client.0)}!=0{return Err(failure("permission_denied","native EDS address book is read-only"));}let group=api.contact(client.0,&target.as_ref().unwrap().1)?;api.group(group.0,&source_id)?;let mut error=ptr::null_mut();let ok=unsafe{(api.delete)(client.0,group.0,1,ptr::null_mut(),&mut error)};api.check(ok!=0,error)?;Ok(json!({"ok":true,"id":a["id"]}))},
        "group-add-member"|"group-remove-member"=>{if unsafe{(api.readonly)(client.0)}!=0{return Err(failure("permission_denied","native EDS address book is read-only"));}let group=api.contact(client.0,&target.as_ref().unwrap().1)?;api.change_member(registry.0,client.0,&source_id,group.0,a)},
        "contact"=>api.row(api.person(client.0,&target.as_ref().unwrap().1)?.0,&source_id,a),
        "create"|"update"=>{
            if unsafe{(api.readonly)(client.0)}!=0{return Err(failure("permission_denied","native EDS address book is read-only"));}
            let contact=if sub=="create"{Object::from(unsafe{(api.new_contact)()}).ok_or_else(||failure("provider_failed","native EDS contact allocation failed"))?}else{api.person(client.0,&target.as_ref().unwrap().1)?};
            for(key,field)in[("given",c"given_name"),("family",c"family_name"),("organization",c"org"),("note",c"note")]{if let Some(value)=a[key].as_str(){api.write(contact.0,field,value)?;}}
            if a.get("given").is_some()||a.get("family").is_some(){api.sync_name(contact.0)?;}
            if let Some(value)=a["email"].as_str(){api.set_labeled(contact.0,c"EMAIL",value)?;}if let Some(value)=a["phone"].as_str(){api.set_labeled(contact.0,c"TEL",value)?;}
            if let Some(value)=a["postal"].as_str(){api.set_postal(contact.0,value)?;}
            if let Some(value)=a["birthday"].as_str(){api.set_birthday(contact.0,value)?;}
            let mut error=ptr::null_mut();let mut uid=ptr::null_mut();let ok=unsafe{if sub=="create"{(api.add)(client.0,contact.0,0,&mut uid,ptr::null_mut(),&mut error)}else{(api.modify)(client.0,contact.0,0,ptr::null_mut(),&mut error)}};
            let id=if sub=="create"&&!uid.is_null(){let value=text(uid,4096);unsafe{(api.free)(uid.cast())};Some(value)}else{None};api.check(ok!=0,error)?;let id=match id{Some(value)=>value?,None=>api.string(contact.0,c"id")?};
            let saved=api.contact(client.0,&id).map_err(|_|failure("partial_result","native EDS contact saved but actual readback failed; no mutation was replayed"))?;api.row(saved.0,&source_id,a)
        },
        "delete"=>{if unsafe{(api.readonly)(client.0)}!=0{return Err(failure("permission_denied","native EDS address book is read-only"));}let id=a["id"].as_str().unwrap();let contact=api.person(client.0,&target.as_ref().unwrap().1)?;let mut error=ptr::null_mut();let ok=unsafe{(api.delete)(client.0,contact.0,0,ptr::null_mut(),&mut error)};api.check(ok!=0,error)?;Ok(json!({"ok":true,"id":id}))},
        "vcard"=>{let id=a["id"].as_str().unwrap();let contact=api.person(client.0,&target.as_ref().unwrap().1)?;let pointer=unsafe{(api.to_vcard)(contact.0,1)};let value=text(pointer,262144);unsafe{(api.free)(pointer.cast())};let value=value?;Ok(json!({"id":id,"bytes":value.len(),"vcard":value}))},
        "import-vcard"=>{
            use std::{io::Read,os::unix::fs::OpenOptionsExt};
            if unsafe{(api.readonly)(client.0)}!=0{return Err(failure("permission_denied","native EDS address book is read-only"));}
            let mut file=std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW|libc::O_NONBLOCK|libc::O_CLOEXEC).open(a["path"].as_str().unwrap()).map_err(|_|failure("permission_denied","native vCard import file cannot be retained"))?;
            let metadata=file.metadata().map_err(|_|failure("provider_failed","vCard file metadata failed"))?;if !metadata.is_file()||metadata.len()>262144{return Err(failure("resource_limit","vCard import requires a regular file up to 256KiB"));}
            let mut bytes=Vec::new();file.by_ref().take(262145).read_to_end(&mut bytes).map_err(|_|failure("provider_failed","retained vCard read failed"))?;
            let mut contacts=Vec::new();for value in crate::contacts::vcard_inputs(&bytes)?{
                let contact=Object::from(unsafe{(api.from_vcard)(cstring(&value)?.as_ptr())}).ok_or_else(||failure("invalid_request","native EDS rejected an imported vCard"))?;
                // Imported cards receive fresh native store IDs. Never reuse a UID
                // supplied by the input file to address an existing contact.
                unsafe{(api.set)(contact.0,api.id(c"id")?,ptr::null())};contacts.push(contact);
            }
            let mut links=contacts.iter().map(|contact|SList{data:contact.0,next:ptr::null_mut()}).collect::<Vec<_>>();let base=links.as_mut_ptr();for index in 0..links.len()-1{links[index].next=unsafe{base.add(index+1)};}
            let mut raw=ptr::null_mut();let mut error=ptr::null_mut();let ok=unsafe{(api.add_many)(client.0,base,0,&mut raw,ptr::null_mut(),&mut error)};let _owned=OwnedList{api:&api,raw:raw.cast(),kind:3};
            api.check(ok!=0,error).map_err(|mut reply|{reply["code"]=json!("partial_result");reply["error"]=json!(format!("native EDS bulk import did not return a complete receipt; native outcome remains unknown and no import was replayed: {}",reply["error"].as_str().unwrap_or("native failure")));reply})?;
            let mut current=raw;let mut ids=Vec::new();while !current.is_null(){if ids.len()>=contacts.len(){return Err(failure("partial_result","native EDS bulk import returned excess identities after possible effect"));}ids.push(identity(&source_id,&text(unsafe{(*current).data.cast()},4096)?)?);current=unsafe{(*current).next};}
            if ids.len()!=contacts.len(){return Err(failure("partial_result","native EDS bulk import returned incomplete identities after possible effect; no replay"));}Ok(json!({"imported":ids.len(),"ids":ids}))
        },
        _=>Err(failure("unsupported_operation","Evolution Data Server keeps no contact change history, so change tokens and change feeds are unavailable on Linux"))
    }
}

#[cfg(test)]mod tests{
    #[test]fn phone_find_matches_digits_without_a_country_code(){
        for(national,digits)in[("5555550199","5555550199"),("555-555-0199","5555550199"),("(555) 555-0199","5555550199"),("15555550199","15555550199"),("0199","0199")]{assert_eq!(phone_query(national),(1,digits.to_owned()),"{national}");}
        for e164 in["+15555550199"," +1 555 555 0199","+1 (555) 555-0199"]{assert_eq!(phone_query(e164),(4,e164.to_owned()),"{e164}");}
        assert_eq!(phone_query("abc"),(1,"abc".to_owned()));
    }
    use super::*;
    #[test]fn native_card_identity_binds_the_exact_address_book(){
        let one=identity("book-one","same-native-uid").unwrap();let two=identity("book-two","same-native-uid").unwrap();assert_ne!(one,two);assert_eq!(target(&one).unwrap(),("book-one".into(),"same-native-uid".into()));
        for id in ["same-native-uid","eds:","eds:%%%%"]{assert!(target(id).is_err());}assert!(identity("","card").is_err());assert!(identity("book","card\0extra").is_err());
    }
    #[test]fn native_group_identity_cannot_address_a_person_or_another_book(){
        let person=identity("book-one","native-card").unwrap();let group=group_identity("book-one","native-card").unwrap();assert_ne!(person,group);assert_eq!(group_target(&group).unwrap(),("book-one".into(),"native-card".into()));assert!(target(&group).is_err());assert!(group_target(&person).is_err());assert_ne!(group,group_identity("book-two","native-card").unwrap());
    }
}
