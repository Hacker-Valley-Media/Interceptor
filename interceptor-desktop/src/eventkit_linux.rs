use crate::{contacts_linux::{cstring, text}, eventkit::{date, iso, page}, failure, linux::Object, native_library::Library};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, ffi::{c_char, c_int, c_void, CStr}, ptr, time::{Duration, Instant}};

type Raw = *mut c_void;
type Destroy = unsafe extern "C" fn(Raw);
#[repr(C)] struct List { data: Raw, next: *mut List, previous: *mut List }
#[repr(C)] struct SList { data: Raw, next: *mut SList }
#[repr(C)] struct Error { domain: u32, code: c_int, message: *mut c_char }
type Instance = unsafe extern "C" fn(Raw, Raw, Raw, Raw, Raw, *mut *mut Error) -> c_int;
type ResolveZone = unsafe extern "C" fn(*const c_char, Raw, Raw, *mut *mut Error) -> Raw;

// EDS 3.56.2 and libical-glib 3 public C signatures. Keep the loaded library
// alive until all source, client, time, property and component objects retire.
struct Api {
    registry_new: unsafe extern "C" fn(Raw, *mut *mut Error) -> Raw,
    sources: unsafe extern "C" fn(Raw, *const c_char) -> *mut List,
    source: unsafe extern "C" fn(Raw, *const c_char) -> Raw,
    default_calendar: unsafe extern "C" fn(Raw) -> Raw,
    default_tasks: unsafe extern "C" fn(Raw) -> Raw,
    builtin_calendar: unsafe extern "C" fn(Raw) -> Raw,
    source_new: unsafe extern "C" fn(Raw, Raw, *mut *mut Error) -> Raw,
    uid: unsafe extern "C" fn(Raw) -> *const c_char,
    name: unsafe extern "C" fn(Raw) -> *const c_char,
    parent: unsafe extern "C" fn(Raw) -> *const c_char,
    has_extension: unsafe extern "C" fn(Raw, *const c_char) -> c_int,
    extension: unsafe extern "C" fn(Raw, *const c_char) -> Raw,
    backend: unsafe extern "C" fn(Raw) -> *const c_char,
    set_backend: unsafe extern "C" fn(Raw, *const c_char),
    set_name: unsafe extern "C" fn(Raw, *const c_char),
    set_parent: unsafe extern "C" fn(Raw, *const c_char),
    set_color: unsafe extern "C" fn(Raw, *const c_char),
    color: unsafe extern "C" fn(Raw) -> *const c_char,
    removable: unsafe extern "C" fn(Raw) -> c_int,
    create_sources: unsafe extern "C" fn(Raw, *mut List, Raw, *mut *mut Error) -> c_int,
    remove_source: unsafe extern "C" fn(Raw, Raw, *mut *mut Error) -> c_int,
    connect: unsafe extern "C" fn(Raw, c_int, u32, Raw, *mut *mut Error) -> Raw,
    readonly: unsafe extern "C" fn(Raw) -> c_int,
    refresh: unsafe extern "C" fn(Raw, Raw, *mut *mut Error) -> c_int,
    refresh_supported: unsafe extern "C" fn(Raw) -> c_int,
    get: unsafe extern "C" fn(Raw, *const c_char, *const c_char, *mut Raw, Raw, *mut *mut Error) -> c_int,
    query: unsafe extern "C" fn(Raw, *const c_char, *mut *mut SList, Raw, *mut *mut Error) -> c_int,
    create: unsafe extern "C" fn(Raw, Raw, u32, *mut *mut c_char, Raw, *mut *mut Error) -> c_int,
    modify: unsafe extern "C" fn(Raw, Raw, c_int, u32, Raw, *mut *mut Error) -> c_int,
    remove: unsafe extern "C" fn(Raw, *const c_char, *const c_char, c_int, u32, Raw, *mut *mut Error) -> c_int,
    error_domain: unsafe extern "C" fn() -> u32,
    client_zone: unsafe extern "C" fn(Raw) -> Raw,
    get_zone: unsafe extern "C" fn(Raw, *const c_char, *mut Raw, Raw, *mut *mut Error) -> c_int,
    generate: unsafe extern "C" fn(Raw, Raw, Raw, Instance, Raw, ResolveZone, Raw, Raw, Raw, *mut *mut Error) -> c_int,
    component_kind: unsafe extern "C" fn(*const c_char) -> c_int,
    new_component: unsafe extern "C" fn(c_int) -> Raw,
    clone_component: unsafe extern "C" fn(Raw) -> Raw,
    summary: unsafe extern "C" fn(Raw) -> *const c_char,
    description: unsafe extern "C" fn(Raw) -> *const c_char,
    location: unsafe extern "C" fn(Raw) -> *const c_char,
    component_uid: unsafe extern "C" fn(Raw) -> *const c_char,
    as_ical: unsafe extern "C" fn(Raw) -> *mut c_char,
    set_summary: unsafe extern "C" fn(Raw, *const c_char),
    set_description: unsafe extern "C" fn(Raw, *const c_char),
    set_location: unsafe extern "C" fn(Raw, *const c_char),
    set_uid: unsafe extern "C" fn(Raw, *const c_char),
    start: unsafe extern "C" fn(Raw) -> Raw,
    end: unsafe extern "C" fn(Raw) -> Raw,
    due: unsafe extern "C" fn(Raw) -> Raw,
    set_start: unsafe extern "C" fn(Raw, Raw),
    set_end: unsafe extern "C" fn(Raw, Raw),
    set_due: unsafe extern "C" fn(Raw, Raw),
    property_kind: unsafe extern "C" fn(*const c_char) -> c_int,
    first_property: unsafe extern "C" fn(Raw, c_int) -> Raw,
    next_property: unsafe extern "C" fn(Raw, c_int) -> Raw,
    remove_property: unsafe extern "C" fn(Raw, Raw),
    add_property: unsafe extern "C" fn(Raw, Raw),
    new_property: unsafe extern "C" fn(*const c_char) -> Raw,
    property_value: unsafe extern "C" fn(Raw) -> *mut c_char,
    parameter: unsafe extern "C" fn(Raw, *const c_char) -> *mut c_char,
    remove_parameter: unsafe extern "C" fn(Raw,*const c_char),
    first_component: unsafe extern "C" fn(Raw, c_int) -> Raw,
    next_component: unsafe extern "C" fn(Raw, c_int) -> Raw,
    remove_component: unsafe extern "C" fn(Raw, Raw),
    add_component: unsafe extern "C" fn(Raw, Raw),
    time_new: unsafe extern "C" fn(libc::time_t, c_int, Raw) -> Raw,
    time_parse: unsafe extern "C" fn(*const c_char) -> Raw,
    time_valid: unsafe extern "C" fn(Raw) -> c_int,
    time_null: unsafe extern "C" fn(Raw) -> c_int,
    time_date: unsafe extern "C" fn(Raw) -> c_int,
    time_utc: unsafe extern "C" fn(Raw) -> c_int,
    time_zone: unsafe extern "C" fn(Raw) -> Raw,
    time_timet: unsafe extern "C" fn(Raw, Raw) -> libc::time_t,
    time_string: unsafe extern "C" fn(Raw) -> *mut c_char,
    utc_zone: unsafe extern "C" fn() -> Raw,
    zone_id: unsafe extern "C" fn(Raw) -> *const c_char,
    time_year: unsafe extern "C" fn(Raw) -> c_int,
    time_month: unsafe extern "C" fn(Raw) -> c_int,
    time_day: unsafe extern "C" fn(Raw) -> c_int,
    time_hour: unsafe extern "C" fn(Raw) -> c_int,
    time_minute: unsafe extern "C" fn(Raw) -> c_int,
    time_second: unsafe extern "C" fn(Raw) -> c_int,
    free: Destroy,
    unref: Destroy,
    error_free: unsafe extern "C" fn(*mut Error),
    iterate: unsafe extern "C" fn(Raw,c_int)->c_int,
    list_free: unsafe extern "C" fn(*mut List, Destroy),
    slist_free: unsafe extern "C" fn(*mut SList, Destroy),
    _library: Library,
}
impl Api {
    fn load() -> Result<Self, Value> {
        let library = Library::load(&crate::native_library::system_library("INTERCEPTOR_ECAL_LIBRARY", "libecal-2.0", "evolution-data-server")?)?;
        macro_rules! sym { ($name:literal, $kind:ty) => { unsafe { std::mem::transmute::<*mut c_void, $kind>(library.symbol(CStr::from_bytes_with_nul(concat!($name,"\0").as_bytes()).unwrap())?) } }; }
        let version = unsafe { (*library.symbol(c"eds_major_version")?.cast::<u32>(), *library.symbol(c"eds_minor_version")?.cast::<u32>(), *library.symbol(c"eds_micro_version")?.cast::<u32>()) };
        if version.0 != 3 || version < (3,56,2) { return Err(failure("version_mismatch", "Calendar/Reminders requires EDS 3.56.2+ within ABI major 3")); }
        Ok(Self {
            registry_new:sym!("e_source_registry_new_sync",unsafe extern "C" fn(Raw,*mut *mut Error)->Raw),
            sources:sym!("e_source_registry_list_sources",unsafe extern "C" fn(Raw,*const c_char)->*mut List),
            source:sym!("e_source_registry_ref_source",unsafe extern "C" fn(Raw,*const c_char)->Raw),
            default_calendar:sym!("e_source_registry_ref_default_calendar",unsafe extern "C" fn(Raw)->Raw),
            default_tasks:sym!("e_source_registry_ref_default_task_list",unsafe extern "C" fn(Raw)->Raw),
            builtin_calendar:sym!("e_source_registry_ref_builtin_calendar",unsafe extern "C" fn(Raw)->Raw),
            source_new:sym!("e_source_new",unsafe extern "C" fn(Raw,Raw,*mut *mut Error)->Raw),
            uid:sym!("e_source_get_uid",unsafe extern "C" fn(Raw)->*const c_char),
            name:sym!("e_source_get_display_name",unsafe extern "C" fn(Raw)->*const c_char),
            parent:sym!("e_source_get_parent",unsafe extern "C" fn(Raw)->*const c_char),
            has_extension:sym!("e_source_has_extension",unsafe extern "C" fn(Raw,*const c_char)->c_int),
            extension:sym!("e_source_get_extension",unsafe extern "C" fn(Raw,*const c_char)->Raw),
            backend:sym!("e_source_backend_get_backend_name",unsafe extern "C" fn(Raw)->*const c_char),
            set_backend:sym!("e_source_backend_set_backend_name",unsafe extern "C" fn(Raw,*const c_char)),
            set_name:sym!("e_source_set_display_name",unsafe extern "C" fn(Raw,*const c_char)),
            set_parent:sym!("e_source_set_parent",unsafe extern "C" fn(Raw,*const c_char)),
            set_color:sym!("e_source_selectable_set_color",unsafe extern "C" fn(Raw,*const c_char)),
            color:sym!("e_source_selectable_get_color",unsafe extern "C" fn(Raw)->*const c_char),
            removable:sym!("e_source_get_removable",unsafe extern "C" fn(Raw)->c_int),
            create_sources:sym!("e_source_registry_create_sources_sync",unsafe extern "C" fn(Raw,*mut List,Raw,*mut *mut Error)->c_int),
            remove_source:sym!("e_source_remove_sync",unsafe extern "C" fn(Raw,Raw,*mut *mut Error)->c_int),
            connect:sym!("e_cal_client_connect_sync",unsafe extern "C" fn(Raw,c_int,u32,Raw,*mut *mut Error)->Raw),
            readonly:sym!("e_client_is_readonly",unsafe extern "C" fn(Raw)->c_int),
            refresh:sym!("e_client_refresh_sync",unsafe extern "C" fn(Raw,Raw,*mut *mut Error)->c_int),
            refresh_supported:sym!("e_client_check_refresh_supported",unsafe extern "C" fn(Raw)->c_int),
            get:sym!("e_cal_client_get_object_sync",unsafe extern "C" fn(Raw,*const c_char,*const c_char,*mut Raw,Raw,*mut *mut Error)->c_int),
            query:sym!("e_cal_client_get_object_list_sync",unsafe extern "C" fn(Raw,*const c_char,*mut *mut SList,Raw,*mut *mut Error)->c_int),
            create:sym!("e_cal_client_create_object_sync",unsafe extern "C" fn(Raw,Raw,u32,*mut *mut c_char,Raw,*mut *mut Error)->c_int),
            modify:sym!("e_cal_client_modify_object_sync",unsafe extern "C" fn(Raw,Raw,c_int,u32,Raw,*mut *mut Error)->c_int),
            remove:sym!("e_cal_client_remove_object_sync",unsafe extern "C" fn(Raw,*const c_char,*const c_char,c_int,u32,Raw,*mut *mut Error)->c_int),
            error_domain:sym!("e_cal_client_error_quark",unsafe extern "C" fn()->u32),
            client_zone:sym!("e_cal_client_get_default_timezone",unsafe extern "C" fn(Raw)->Raw),
            get_zone:sym!("e_cal_client_get_timezone_sync",unsafe extern "C" fn(Raw,*const c_char,*mut Raw,Raw,*mut *mut Error)->c_int),
            generate:sym!("e_cal_recur_generate_instances_sync",unsafe extern "C" fn(Raw,Raw,Raw,Instance,Raw,ResolveZone,Raw,Raw,Raw,*mut *mut Error)->c_int),
            component_kind:sym!("i_cal_component_kind_from_string",unsafe extern "C" fn(*const c_char)->c_int),
            new_component:sym!("i_cal_component_new",unsafe extern "C" fn(c_int)->Raw),
            clone_component:sym!("i_cal_component_clone",unsafe extern "C" fn(Raw)->Raw),
            summary:sym!("i_cal_component_get_summary",unsafe extern "C" fn(Raw)->*const c_char),
            description:sym!("i_cal_component_get_description",unsafe extern "C" fn(Raw)->*const c_char),
            location:sym!("i_cal_component_get_location",unsafe extern "C" fn(Raw)->*const c_char),
            component_uid:sym!("i_cal_component_get_uid",unsafe extern "C" fn(Raw)->*const c_char),
            as_ical:sym!("i_cal_component_as_ical_string",unsafe extern "C" fn(Raw)->*mut c_char),
            set_summary:sym!("i_cal_component_set_summary",unsafe extern "C" fn(Raw,*const c_char)),
            set_description:sym!("i_cal_component_set_description",unsafe extern "C" fn(Raw,*const c_char)),
            set_location:sym!("i_cal_component_set_location",unsafe extern "C" fn(Raw,*const c_char)),
            set_uid:sym!("i_cal_component_set_uid",unsafe extern "C" fn(Raw,*const c_char)),
            start:sym!("i_cal_component_get_dtstart",unsafe extern "C" fn(Raw)->Raw),
            end:sym!("i_cal_component_get_dtend",unsafe extern "C" fn(Raw)->Raw),
            due:sym!("i_cal_component_get_due",unsafe extern "C" fn(Raw)->Raw),
            set_start:sym!("i_cal_component_set_dtstart",unsafe extern "C" fn(Raw,Raw)),
            set_end:sym!("i_cal_component_set_dtend",unsafe extern "C" fn(Raw,Raw)),
            set_due:sym!("i_cal_component_set_due",unsafe extern "C" fn(Raw,Raw)),
            property_kind:sym!("i_cal_property_kind_from_string",unsafe extern "C" fn(*const c_char)->c_int),
            first_property:sym!("i_cal_component_get_first_property",unsafe extern "C" fn(Raw,c_int)->Raw),
            next_property:sym!("i_cal_component_get_next_property",unsafe extern "C" fn(Raw,c_int)->Raw),
            remove_property:sym!("i_cal_component_remove_property",unsafe extern "C" fn(Raw,Raw)),
            add_property:sym!("i_cal_component_add_property",unsafe extern "C" fn(Raw,Raw)),
            new_property:sym!("i_cal_property_new_from_string",unsafe extern "C" fn(*const c_char)->Raw),
            property_value:sym!("i_cal_property_get_value_as_string",unsafe extern "C" fn(Raw)->*mut c_char),
            parameter:sym!("i_cal_property_get_parameter_as_string",unsafe extern "C" fn(Raw,*const c_char)->*mut c_char),
            remove_parameter:sym!("i_cal_property_remove_parameter_by_name",unsafe extern "C" fn(Raw,*const c_char)),
            first_component:sym!("i_cal_component_get_first_component",unsafe extern "C" fn(Raw,c_int)->Raw),
            next_component:sym!("i_cal_component_get_next_component",unsafe extern "C" fn(Raw,c_int)->Raw),
            remove_component:sym!("i_cal_component_remove_component",unsafe extern "C" fn(Raw,Raw)),
            add_component:sym!("i_cal_component_add_component",unsafe extern "C" fn(Raw,Raw)),
            time_new:sym!("i_cal_time_new_from_timet_with_zone",unsafe extern "C" fn(libc::time_t,c_int,Raw)->Raw),
            time_parse:sym!("i_cal_time_new_from_string",unsafe extern "C" fn(*const c_char)->Raw),
            time_valid:sym!("i_cal_time_is_valid_time",unsafe extern "C" fn(Raw)->c_int),
            time_null:sym!("i_cal_time_is_null_time",unsafe extern "C" fn(Raw)->c_int),
            time_date:sym!("i_cal_time_is_date",unsafe extern "C" fn(Raw)->c_int),
            time_utc:sym!("i_cal_time_is_utc",unsafe extern "C" fn(Raw)->c_int),
            time_zone:sym!("i_cal_time_get_timezone",unsafe extern "C" fn(Raw)->Raw),
            time_timet:sym!("i_cal_time_as_timet_with_zone",unsafe extern "C" fn(Raw,Raw)->libc::time_t),
            time_string:sym!("i_cal_time_as_ical_string",unsafe extern "C" fn(Raw)->*mut c_char),
            utc_zone:sym!("i_cal_timezone_get_utc_timezone",unsafe extern "C" fn()->Raw),
            zone_id:sym!("i_cal_timezone_get_tzid",unsafe extern "C" fn(Raw)->*const c_char),
            time_year:sym!("i_cal_time_get_year",unsafe extern "C" fn(Raw)->c_int),
            time_month:sym!("i_cal_time_get_month",unsafe extern "C" fn(Raw)->c_int),
            time_day:sym!("i_cal_time_get_day",unsafe extern "C" fn(Raw)->c_int),
            time_hour:sym!("i_cal_time_get_hour",unsafe extern "C" fn(Raw)->c_int),
            time_minute:sym!("i_cal_time_get_minute",unsafe extern "C" fn(Raw)->c_int),
            time_second:sym!("i_cal_time_get_second",unsafe extern "C" fn(Raw)->c_int),
            free:sym!("g_free",Destroy), unref:sym!("g_object_unref",Destroy),
            error_free:sym!("g_error_free",unsafe extern "C" fn(*mut Error)),
            iterate:sym!("g_main_context_iteration",unsafe extern "C" fn(Raw,c_int)->c_int),
            list_free:sym!("g_list_free_full",unsafe extern "C" fn(*mut List,Destroy)),
            slist_free:sym!("g_slist_free_full",unsafe extern "C" fn(*mut SList,Destroy)), _library:library,
        })
    }
    fn owned_text(&self, raw:*mut c_char, limit:usize) -> Result<String,Value> {
        let result=text(raw,limit); unsafe{(self.free)(raw.cast())}; result
    }
    fn optional_text(&self,raw:*const c_char,limit:usize)->Result<String,Value>{if raw.is_null(){Ok(String::new())}else{text(raw,limit)}}
    fn check(&self,ok:bool,error:*mut Error)->Result<(),Value>{
        if !error.is_null(){let error=unsafe{&*error};let message=text(error.message,4096).unwrap_or_else(|_|"native EDS error text is unavailable".into());let mut result=failure(if error.domain==unsafe{(self.error_domain)()}&&error.code==1{"target_gone"}else{"provider_failed"},message);result["details"]=json!({"nativeDomain":error.domain,"nativeCode":error.code});unsafe{(self.error_free)(error as *const Error as *mut Error)};return Err(result);}
        if ok{Ok(())}else{Err(failure("provider_failed","native EDS returned no complete result"))}
    }
    fn kind(&self,name:&CStr)->Result<c_int,Value>{let kind=unsafe{(self.property_kind)(name.as_ptr())};if kind==0{return Err(failure("version_mismatch","native iCalendar property kind is unavailable"));}Ok(kind)}
    fn properties(&self,component:Raw,name:&CStr)->Result<Vec<Object>,Value>{
        let kind=self.kind(name)?;let mut rows=Vec::new();let mut property=Object::from(unsafe{(self.first_property)(component,kind)});
        while let Some(value)=property{if rows.len()>=32{return Err(failure("resource_limit","native iCalendar property count exceeds 32"));}rows.push(value);property=Object::from(unsafe{(self.next_property)(component,kind)});}Ok(rows)
    }
    fn value(&self,component:Raw,name:&CStr)->Result<Option<String>,Value>{let values=self.properties(component,name)?;if values.len()>1{return Err(failure("unsupported_target","native scalar iCalendar property is ambiguous"));}values.first().map(|p|self.owned_text(unsafe{(self.property_value)(p.0)},65536)).transpose()}
    fn replace(&self,component:Raw,name:&CStr,value:Option<&str>)->Result<(),Value>{
        let base=cstring(name.to_string_lossy().split(';').next().unwrap())?;
        let property=if let Some(value)=value{let line=format!("{}:{}",name.to_string_lossy(),value);if line.contains(['\r','\n']){return Err(failure("invalid_request","native iCalendar property contains an injected line"));}Some(Object::from(unsafe{(self.new_property)(cstring(&line)?.as_ptr())}).ok_or_else(||failure("invalid_request","native iCalendar property parser refused the field"))?)}else{None};
        for old in self.properties(component,&base)?{unsafe{(self.remove_property)(component,old.0)}}if let Some(property)=property{unsafe{(self.add_property)(component,property.0)}}Ok(())
    }
    fn time(&self,raw:&str,all_day:bool)->Result<Object,Value>{let instant=date(raw)?.to_offset(time::UtcOffset::UTC);if instant.nanosecond()!=0||all_day&&(instant.hour()!=0||instant.minute()!=0||instant.second()!=0){return Err(failure("invalid_request","EDS dates require whole seconds; all-day boundaries require UTC midnight"));}Object::from(unsafe{(self.time_new)(instant.unix_timestamp()as libc::time_t,all_day as c_int,(self.utc_zone)())}).ok_or_else(||failure("provider_failed","native iCalendar time allocation failed"))}
    fn parsed_time(&self,raw:&str)->Result<Object,Value>{let time=Object::from(unsafe{(self.time_parse)(cstring(raw)?.as_ptr())}).ok_or_else(||failure("provider_failed","native iCalendar time parser returned null"))?;self.valid_time(time.0)?;Ok(time)}
    fn write_time(&self,component:Raw,name:&CStr,time:Raw,set:unsafe extern "C" fn(Raw,Raw))->Result<(),Value>{unsafe{set(component,time)};for property in self.properties(component,name)?{unsafe{(self.remove_parameter)(property.0,c"TZID".as_ptr())}}Ok(())}
    fn valid_time(&self,time:Raw)->Result<(),Value>{if time.is_null()||unsafe{(self.time_valid)(time)==0||(self.time_null)(time)!=0}{Err(failure("provider_failed","native calendar date is absent or invalid"))}else{Ok(())}}
    fn instant(&self,client:Raw,component:Raw,name:&CStr,time:Raw)->Result<time::OffsetDateTime,Value>{
        self.valid_time(time)?;let mut zone=unsafe{(self.time_zone)(time)};
        if unsafe{(self.time_utc)(time)!=0||(self.time_date)(time)!=0}{zone=unsafe{(self.utc_zone)()};}
        if zone.is_null(){if let Some(property)=self.properties(component,name)?.first(){let pointer=unsafe{(self.parameter)(property.0,c"TZID".as_ptr())};if !pointer.is_null(){let id=self.owned_text(pointer,4096)?;let mut error=ptr::null_mut();self.check(unsafe{(self.get_zone)(client,cstring(&id)?.as_ptr(),&mut zone,ptr::null_mut(),&mut error)}!=0,error)?;}}}
        if zone.is_null(){return Err(failure("unsupported_target","floating native event time has no explicit timezone; no timezone was inferred"));}
        time::OffsetDateTime::from_unix_timestamp(unsafe{(self.time_timet)(time,zone)}as i64).map_err(|_|failure("provider_failed","native calendar date exceeds its representable range"))
    }
    fn components(&self,component:Raw,name:&CStr,time:Raw)->Result<Value,Value>{
        self.valid_time(time)?;let mut value=unsafe{json!({"year":(self.time_year)(time),"month":(self.time_month)(time),"day":(self.time_day)(time)})};
        if unsafe{(self.time_date)(time)==0}{unsafe{value["hour"]=(self.time_hour)(time).into();value["minute"]=(self.time_minute)(time).into();value["second"]=(self.time_second)(time).into();}}
        if unsafe{(self.time_utc)(time)!=0}{value["timeZone"]="GMT".into();}else{let zone=unsafe{(self.time_zone)(time)};if !zone.is_null(){let id=self.optional_text(unsafe{(self.zone_id)(zone)},4096)?;if !id.is_empty(){value["timeZone"]=id.into();}}else if let Some(p)=self.properties(component,name)?.first(){let id=unsafe{(self.parameter)(p.0,c"TZID".as_ptr())};if !id.is_null(){value["timeZone"]=self.owned_text(id,4096)?.into();}}}Ok(value)
    }
    fn new(&self,name:&CStr)->Result<Object,Value>{Object::from(unsafe{(self.new_component)((self.component_kind)(name.as_ptr()))}).ok_or_else(||failure("provider_failed","native iCalendar component allocation failed"))}
    fn children(&self,component:Raw,name:&CStr)->Result<Vec<Object>,Value>{let kind=unsafe{(self.component_kind)(name.as_ptr())};let mut children=Vec::new();let mut next=Object::from(unsafe{(self.first_component)(component,kind)});while let Some(child)=next{if children.len()>=32{return Err(failure("resource_limit","native calendar child component bound exceeded"));}children.push(child);next=Object::from(unsafe{(self.next_component)(component,kind)});}Ok(children)}
    fn rules(&self,component:Raw)->Result<Vec<Value>,Value>{
        let mut values=Vec::new();for p in self.properties(component,c"RRULE")?{let raw=self.owned_text(unsafe{(self.property_value)(p.0)},4096)?;let fields=raw.split(';').map(|part|part.split_once('=').ok_or_else(||failure("provider_failed","invalid native recurrence pair"))).collect::<Result<BTreeMap<_,_>,Value>>()?;
            let frequency=match fields.get("FREQ").copied(){Some("DAILY")=>"daily",Some("WEEKLY")=>"weekly",Some("MONTHLY")=>"monthly",Some("YEARLY")=>"yearly",_=>return Err(failure("unsupported_operation","native recurrence frequency is outside the shared contract"))};let interval=fields.get("INTERVAL").unwrap_or(&"1").parse::<u32>().map_err(|_|failure("provider_failed","invalid native recurrence interval"))?;if interval==0||interval>10000{return Err(failure("resource_limit","native recurrence interval exceeds its bound"));}let mut row=json!({"frequency":frequency,"interval":interval});let mut end=json!({});if let Some(count)=fields.get("COUNT"){let count=count.parse::<u32>().map_err(|_|failure("provider_failed","invalid native recurrence count"))?;if count==0||count>100000{return Err(failure("resource_limit","native recurrence count exceeds its bound"));}end["occurrenceCount"]=count.into();}if let Some(raw)=fields.get("UNTIL"){let t=self.parsed_time(raw)?;if unsafe{(self.time_utc)(t.0)==0&&(self.time_date)(t.0)==0}{return Err(failure("unsupported_target","native recurrence end has an unresolved timezone"));}end["date"]=iso(time::OffsetDateTime::from_unix_timestamp(unsafe{(self.time_timet)(t.0,(self.utc_zone)())}as i64).map_err(|_|failure("provider_failed","native recurrence end exceeds date bounds"))?)?.into();}if !end.as_object().unwrap().is_empty(){row["end"]=end;}values.push(row);
        }Ok(values)
    }
    fn alarms(&self,client:Raw,component:Raw)->Result<Vec<Value>,Value>{
        let mut rows=Vec::new();for alarm in self.children(component,c"VALARM")?{let Some(raw)=self.value(alarm.0,c"TRIGGER")?else{return Err(failure("provider_failed","native alarm has no trigger"));};let kind=self.value(alarm.0,c"ACTION")?.unwrap_or_else(||"unknown".into());let trigger=self.properties(alarm.0,c"TRIGGER")?;let relation=unsafe{(self.parameter)(trigger[0].0,c"RELATED".as_ptr())};let relation=if relation.is_null(){String::new()}else{self.owned_text(relation,4096)?};let mut row=json!({"type":kind.to_ascii_lowercase(),"relativeOffset":0});
            if raw.starts_with(['P','+','-']){let offset=duration_seconds(&raw)?;let offset=if relation=="END"{let start=Object::from(unsafe{(self.start)(component)}).ok_or_else(||failure("provider_failed","native alarm start is missing"))?;let end=Object::from(unsafe{(self.end)(component)}).ok_or_else(||failure("provider_failed","native alarm end is missing"))?;offset+(self.instant(client,component,c"DTEND",end.0)?-self.instant(client,component,c"DTSTART",start.0)?).whole_seconds()}else if relation.is_empty()||relation=="START"{offset}else{return Err(failure("unsupported_target","unknown native alarm relation"));};row["relativeOffset"]=offset.into();
            }else{let t=self.parsed_time(&raw)?;row["absoluteDate"]=iso(self.instant(client,alarm.0,c"TRIGGER",t.0)?)?.into();}rows.push(row);
        }Ok(rows)
    }
}
struct SourceList<'a>{api:&'a Api,raw:*mut List}
impl Drop for SourceList<'_>{fn drop(&mut self){unsafe{(self.api.list_free)(self.raw,self.api.unref)}}}
struct ComponentList<'a>{api:&'a Api,raw:*mut SList}
impl Drop for ComponentList<'_>{fn drop(&mut self){unsafe{(self.api.slist_free)(self.raw,self.api.unref)}}}
struct Native<'a>{api:&'a Api,registry:Object,calendar:bool,deadline:Instant}
impl<'a> Native<'a>{
    fn check_deadline(&self)->Result<(),Value>{if Instant::now()>=self.deadline{Err(failure("cancelled","native calendar deadline reached; no further mutation performed"))}else{Ok(())}}
    fn extension(&self)->&'static CStr{if self.calendar{c"Calendar"}else{c"Task List"}}
    fn sources(&self)->Result<Vec<Object>,Value>{let guard=SourceList{api:self.api,raw:unsafe{(self.api.sources)(self.registry.0,self.extension().as_ptr())}};let mut p=guard.raw;let mut rows=Vec::new();while !p.is_null(){if rows.len()>=128{return Err(failure("resource_limit","native calendar store exceeds 128 sources"));}let value=unsafe{(*p).data};if value.is_null(){return Err(failure("provider_failed","native calendar registry returned a null source"));}let borrowed=std::mem::ManuallyDrop::new(Object(value));rows.push(Object::clone(&borrowed));p=unsafe{(*p).next};}Ok(rows)}
    fn source(&self,id:&str)->Result<Object,Value>{let value=Object::from(unsafe{(self.api.source)(self.registry.0,cstring(id)?.as_ptr())}).ok_or_else(||failure("target_gone","native calendar/list source does not exist; no default fallback"))?;if unsafe{(self.api.has_extension)(value.0,self.extension().as_ptr())}==0||text(unsafe{(self.api.uid)(value.0)},4096)?!=id{return Err(failure("target_gone","native source belongs to a different entity type"));}Ok(value)}
    fn default(&self)->Result<Option<Object>,Value>{let value=Object::from(unsafe{if self.calendar{(self.api.default_calendar)(self.registry.0)}else{(self.api.default_tasks)(self.registry.0)}});if let Some(value)=&value{if unsafe{(self.api.has_extension)(value.0,self.extension().as_ptr())}==0{return Err(failure("provider_failed","native default has the wrong entity type"));}}Ok(value)}
    fn client(&self,source:Raw,write:bool)->Result<Object,Value>{self.check_deadline()?;let mut error=ptr::null_mut();let client=Object::from(unsafe{(self.api.connect)(source,if self.calendar{0}else{1},crate::contacts_linux::CONNECT_WAIT_SECONDS,ptr::null_mut(),&mut error)});self.api.check(client.is_some(),error)?;let client=client.unwrap();if write&&unsafe{(self.api.readonly)(client.0)!=0}{return Err(failure("permission_denied","native calendar/list is read-only"));}Ok(client)}
    fn row(&self,source:Raw)->Result<Value,Value>{let id=text(unsafe{(self.api.uid)(source)},4096)?;let title=text(unsafe{(self.api.name)(source)},4096)?;let client=self.client(source,false)?;let writable=unsafe{(self.api.readonly)(client.0)==0};if !self.calendar{return Ok(json!({"id":id,"title":title,"allowsContentModifications":writable}));}let ext=unsafe{(self.api.extension)(source,self.extension().as_ptr())};if ext.is_null(){return Err(failure("provider_failed","native calendar extension is missing"));}let backend=self.api.optional_text(unsafe{(self.api.backend)(ext)},4096)?;let mut row=json!({"id":id,"title":title,"type":backend,"allowsContentModifications":writable});let parent=self.api.optional_text(unsafe{(self.api.parent)(source)},4096)?;if !parent.is_empty(){let parent=Object::from(unsafe{(self.api.source)(self.registry.0,cstring(&parent)?.as_ptr())}).ok_or_else(||failure("provider_failed","native calendar parent source is missing"))?;row["source"]=json!({"id":text(unsafe{(self.api.uid)(parent.0)},4096)?,"title":text(unsafe{(self.api.name)(parent.0)},4096)?,"type":backend});}Ok(row)}
    fn get(&self,client:Raw,uid:&str,rid:&str)->Result<Object,Value>{self.check_deadline()?;let mut out=ptr::null_mut();let mut error=ptr::null_mut();let uid=cstring(uid)?;let rid=cstring(rid)?;let ok=unsafe{(self.api.get)(client,uid.as_ptr(),if rid.is_empty(){ptr::null()}else{rid.as_ptr()},&mut out,ptr::null_mut(),&mut error)};let object=Object::from(out);self.api.check(ok!=0,error)?;{let object=object.ok_or_else(||failure("provider_failed","native object lookup returned null"))?;if text(unsafe{(self.api.component_uid)(object.0)},4096)?!=uid.to_str().unwrap()||self.api.value(object.0,c"RECURRENCE-ID")?.unwrap_or_default()!=rid.to_str().unwrap(){return Err(failure("target_gone","native object identity differs from the exact UID/recurrence target"));}Ok(object)}}
    fn query(&self,client:Raw)->Result<ComponentList<'a>,Value>{self.check_deadline()?;let mut out=ptr::null_mut();let mut error=ptr::null_mut();let ok=unsafe{(self.api.query)(client,c"#t".as_ptr(),&mut out,ptr::null_mut(),&mut error)};let guard=ComponentList{api:self.api,raw:out};self.api.check(ok!=0,error)?;Ok(guard)}
    fn event(&self,client:Raw,source:&str,component:Raw,instance:Option<(Raw,Raw)>)->Result<Value,Value>{
        let uid=text(unsafe{(self.api.component_uid)(component)},4096)?;let own_start=Object::from(unsafe{(self.api.start)(component)}).ok_or_else(||failure("provider_failed","native event start is missing"))?;let own_end=Object::from(unsafe{(self.api.end)(component)}).ok_or_else(||failure("provider_failed","native event end is missing"))?;let(start,end)=instance.unwrap_or((own_start.0,own_end.0));let start=self.api.instant(client,component,c"DTSTART",start)?;let end=self.api.instant(client,component,c"DTEND",end)?;if end<=start{return Err(failure("provider_failed","native event interval does not increase"));}
        let rid=self.api.value(component,c"RECURRENCE-ID")?.unwrap_or_default();let rules=self.api.rules(component)?;let instance_id=if instance.is_some()&&rid.is_empty()&&!rules.is_empty(){format!("@{}",start.unix_timestamp())}else if !rid.is_empty(){format!("@{}",self.rid_seconds(client,component)?)}else{rid.clone()};let mut row=json!({"id":identity(true,source,&uid,&instance_id),"calendarId":source,"title":self.api.optional_text(unsafe{(self.api.summary)(component)},4096)?,"startDate":iso(start)?,"endDate":iso(end)?,"isAllDay":unsafe{(self.api.time_date)(own_start.0)!=0},"status":self.api.value(component,c"STATUS")?.unwrap_or_else(||"none".into()).to_ascii_lowercase(),"availability":match self.api.value(component,c"TRANSP")?.as_deref(){Some("TRANSPARENT")=>"free",Some("OPAQUE")=>"busy",_=>"unknown"}});
        if !rid.is_empty(){row["isDetached"]=true.into();}if !instance_id.is_empty(){row["occurrenceDate"]=iso(start)?.into();}
        for(key,pointer)in[("notes",unsafe{(self.api.description)(component)}),("location",unsafe{(self.api.location)(component)})]{let value=self.api.optional_text(pointer,if key=="notes"{65536}else{4096})?;if !value.is_empty(){row[key]=value.into();}}if let Some(url)=self.api.value(component,c"URL")?{row["url"]=url.into();}let alarms=self.api.alarms(client,component)?;if !alarms.is_empty(){row["alarms"]=alarms.into();}if !rules.is_empty(){row["recurrenceRules"]=rules.into();}Ok(row)
    }
    fn reminder(&self,client:Raw,source:&str,component:Raw)->Result<Value,Value>{
        let uid=text(unsafe{(self.api.component_uid)(component)},4096)?;let rid=self.api.value(component,c"RECURRENCE-ID")?.unwrap_or_default();let status=self.api.value(component,c"STATUS")?;let completed=self.api.value(component,c"COMPLETED")?;let priority=self.api.value(component,c"PRIORITY")?.unwrap_or_else(||"0".into()).parse::<u8>().map_err(|_|failure("provider_failed","native reminder priority is invalid"))?;let priority=match priority{0=>"none",1..=4=>"high",5=>"medium",6..=9=>"low",_=>return Err(failure("provider_failed","native reminder priority exceeds RFC range"))};let mut row=json!({"id":identity(false,source,&uid,&rid),"listId":source,"title":self.api.optional_text(unsafe{(self.api.summary)(component)},4096)?,"isCompleted":status.as_deref()==Some("COMPLETED"),"priority":priority});
        if let Some(completed)=completed{let time=self.api.parsed_time(&completed)?;row["completionDate"]=iso(self.api.instant(client,component,c"COMPLETED",time.0)?)?.into();}
        for(key,name,get)in[("dueDateComponents",c"DUE",self.api.due),("startDateComponents",c"DTSTART",self.api.start)]{let time=Object::from(unsafe{get(component)});if let Some(time)=time{if unsafe{(self.api.time_null)(time.0)==0}{row[key]=self.api.components(component,name,time.0)?;}}}
        let notes=self.api.optional_text(unsafe{(self.api.description)(component)},65536)?;if !notes.is_empty(){row["notes"]=notes.into();}if let Some(url)=self.api.value(component,c"URL")?{row["url"]=url.into();}let rules=self.api.rules(component)?;if !rules.is_empty(){row["recurrenceRules"]=rules.into();}let alarms=self.api.alarms(client,component)?;if !alarms.is_empty(){row["alarms"]=alarms.into();}Ok(row)
    }
    fn mutation(&self,a:&Value)->Result<Value,Value>{
        let sub=a["sub"].as_str().unwrap();let creating=sub=="create";
        let(source,uid,rid)=if creating{let source=if let Some(id)=a[if self.calendar{"calendar"}else{"list"}].as_str(){self.source(id)?}else{self.default()?.ok_or_else(||failure("target_gone","no actual native default calendar/list"))?};(source,String::new(),String::new())}else{let(s,u,r)=decode(a["id"].as_str().unwrap(),self.calendar)?;(self.source(&s)?,u,r)};
        if rid.starts_with('@')&&!matches!(sub,"delete"|"update"){return Err(failure("unsupported_operation","one occurrence cannot move to another calendar; move the series by its id; no change was made"));}
        let client=self.client(source.0,true)?;
        // A generated occurrence id carries its start instant (@unix-seconds); its RECURRENCE-ID is that instant in
        // the series' own DTSTART form (same zone, or a date for an all-day series), per RFC 5545.
        let occurrence_start=rid.strip_prefix('@').map(|raw|raw.parse::<i64>().map_err(|_|failure("target_gone","invalid native occurrence instant"))).transpose()?;
        let rid=if let Some(seconds)=occurrence_start{let master=self.get(client.0,&uid,"")?;self.occurrence_rid(client.0,master.0,seconds)?}else{rid};let source_id=text(unsafe{(self.api.uid)(source.0)},4096)?;let component=if creating{self.api.new(if self.calendar{c"VEVENT"}else{c"VTODO"})?}else{self.get(client.0,&uid,&rid)?};
        if creating{let uid=format!("interceptor-{}",crate::secret_target::random_token().map_err(|_|failure("provider_failed","native calendar UID entropy is unavailable"))?);unsafe{(self.api.set_uid)(component.0,cstring(&uid)?.as_ptr());}}
        let recurring=!creating&&(!self.api.rules(component.0)?.is_empty()||!rid.is_empty());
        let(mut component,mut modtype,mut read_rid,mut split,mut keep)=(component,1,String::new(),None::<(String,i64)>,Vec::<Object>::new());
        if recurring&&sub=="update"&&self.calendar{
            let span=a["span"].as_str().unwrap_or("this");
            if span!="future"&&["recurrence_frequency","recurrence_interval","recurrence_end"].iter().any(|k|a.get(*k).is_some()){return Err(failure("invalid_request","one occurrence has no recurrence of its own; change the recurrence with --span future; no change was made"));}
            let master=self.get(client.0,&uid,"")?;let first=self.first_seconds(client.0,master.0)?;
            let seconds=match occurrence_start{Some(seconds)=>seconds,None if rid.is_empty()=>first,None=>self.rid_seconds(client.0,component.0)?};
            if span!="future"{
                read_rid=if rid.is_empty(){self.occurrence_rid(client.0,master.0,first)?}else{rid.clone()};if rid.is_empty(){component=self.get(client.0,&uid,&read_rid)?;}
                // EDS builds an unsaved occurrence by cloning the series and only setting RECURRENCE-ID, so it keeps the
                // series' start and rule; saved as is, the exception landed on the first day and the occurrence stayed.
                if !self.api.rules(component.0)?.is_empty(){self.as_occurrence(client.0,&master,component.0,seconds)?;}
            }
            else if seconds<=first{
                // The whole series. EDS MOD_ALL drops the edited occurrences, so they are saved again after it; a change
                // of times or recurrence would not fit them, so that refuses while any exist.
                keep=self.detached(client.0,&uid)?;
                if !keep.is_empty()&&["start","end","all_day","recurrence_frequency","recurrence_interval","recurrence_end"].iter().any(|k|a.get(*k).is_some()){return Err(failure("unsupported_operation","this series has an edited occurrence, and changing the series' times or recurrence would discard that edit; no change was made"));}
                component=master;modtype=7;
            }
            else{component=self.split_series(client.0,&uid,&master,seconds)?;split=Some((uid.clone(),seconds));}
        }else if recurring&&sub!="delete"{return Err(failure("unsupported_operation","native recurring reminder edits and moving one occurrence are not supported; no change was made"));}
        if sub=="delete"{
            // ECalObjModType: THIS=1, THIS_AND_FUTURE=4, ALL=7. A series id names its first occurrence, so
            // "future" from it is the whole series, as in EventKit; an occurrence id carries its recurrence id.
            let span=a["span"].as_str().unwrap_or("this");
            // "This and future" from a generated occurrence ends the series just before it. EDS's own
            // THIS_AND_FUTURE remove deleted the whole series on EDS 3.60, so the rule is cut instead.
            if recurring&&span=="future"&&!rid.is_empty()&&let Some(seconds)=occurrence_start{return self.end_series_before(client.0,&uid,seconds,a);}
            let(target,modtype)=if !recurring{("",1)}else if rid.is_empty(){if span=="future"{("",7)}else{return Err(failure("unsupported_operation","deleting only the first occurrence of a series needs that occurrence's id; pass --span future to delete the whole series"));}}else{(rid.as_str(),if span=="future"{4}else{1})};
            self.check_deadline()?;let mut error=ptr::null_mut();let target_rid=cstring(target)?;let ok=unsafe{(self.api.remove)(client.0,cstring(&uid)?.as_ptr(),if target.is_empty(){ptr::null()}else{target_rid.as_ptr()},modtype,1,ptr::null_mut(),&mut error)};self.api.check(ok!=0,error)?;match self.get(client.0,&uid,target){Err(error)if error["code"]=="target_gone"=>return Ok(json!({"ok":true,"id":a["id"]})),Err(error)=>return Err(committed(error)),Ok(_)=>return Err(committed(failure("provider_failed","native calendar item remains after delete")))} }
        if sub=="move"{return self.move_event(a,&source_id,client.0,component.0,&uid);}
        for(key,set)in[("title",self.api.set_summary),("notes",self.api.set_description),("location",self.api.set_location)]{if let Some(value)=a[key].as_str(){unsafe{set(component.0,cstring(value)?.as_ptr())}}}
        if let Some(url)=a["url"].as_str(){self.api.replace(component.0,c"URL",if url.is_empty(){None}else{Some(url)})?;}
        if self.calendar{let old=Object::from(unsafe{(self.api.start)(component.0)});let all_day=a["all_day"].as_bool().unwrap_or_else(||old.as_ref().is_some_and(|t|unsafe{(self.api.time_date)(t.0)!=0}));for(key,set,get,name)in[("start",self.api.set_start,self.api.start,c"DTSTART"),("end",self.api.set_end,self.api.end,c"DTEND")]{if let Some(raw)=a[key].as_str(){let time=self.api.time(raw,all_day)?;self.api.write_time(component.0,name,time.0,set)?}else if a.get("all_day").is_some(){let time=Object::from(unsafe{get(component.0)}).ok_or_else(||failure("provider_failed","native all-day conversion has no existing date"))?;let raw=iso(self.api.instant(client.0,component.0,name,time.0)?)?;let time=self.api.time(&raw,all_day)?;self.api.write_time(component.0,name,time.0,set)?}}
            if let Some(alarms)=a["alarms"].as_array(){self.apply_alarms(component.0,alarms)?;}
            if let Some(frequency)=a["recurrence_frequency"].as_str(){let mut value=format!("FREQ={};INTERVAL={}",frequency.to_ascii_uppercase(),crate::contacts::integer(&a["recurrence_interval"]).unwrap_or(1));if let Some(end)=a["recurrence_end"].as_str(){if end.bytes().all(|b|b.is_ascii_digit()){value.push_str(&format!(";COUNT={end}"));}else{let t=self.api.time(end,false)?;value.push_str(&format!(";UNTIL={}",self.api.owned_text(unsafe{(self.api.time_string)(t.0)},128)?));}}self.api.replace(component.0,c"RRULE",Some(&value))?;}
        }else{for(key,name,set)in[("start",c"DTSTART",self.api.set_start),("due",c"DUE",self.api.set_due)]{if let Some(raw)=a[key].as_str(){let time=self.api.time(raw,false)?;self.api.write_time(component.0,name,time.0,set)?}}if let Some(priority)=a["priority"].as_str(){self.api.replace(component.0,c"PRIORITY",Some(match priority{"none"=>"0","high"=>"1","medium"=>"5",_=>"9"}))?;}if sub=="complete"{let now=time::OffsetDateTime::now_utc().replace_nanosecond(0).map_err(|_|failure("provider_failed","invalid native completion clock"))?;let t=self.api.time(&iso(now)?,false)?;self.api.replace(component.0,c"COMPLETED",Some(&self.api.owned_text(unsafe{(self.api.time_string)(t.0)},128)?))?;self.api.replace(component.0,c"STATUS",Some("COMPLETED"))?;self.api.replace(component.0,c"PERCENT-COMPLETE",Some("100"))?;}if sub=="uncomplete"{self.api.replace(component.0,c"COMPLETED",None)?;self.api.replace(component.0,c"STATUS",Some("NEEDS-ACTION"))?;self.api.replace(component.0,c"PERCENT-COMPLETE",Some("0"))?;}}
        if !self.calendar{
            // EDS saves a task whose due is before its start but then cannot remove it;
            // check the merged values, so a partial update is caught too, before anything is saved.
            let at=|name:&CStr,get:unsafe extern "C" fn(Raw)->Raw|->Result<Option<time::OffsetDateTime>,Value>{match Object::from(unsafe{get(component.0)}){Some(t)if unsafe{(self.api.time_null)(t.0)==0}=>Ok(Some(self.api.instant(client.0,component.0,name,t.0)?)),_=>Ok(None)}};
            if let(Some(start),Some(due))=(at(c"DTSTART",self.api.start)?,at(c"DUE",self.api.due)?)&&due<start{return Err(failure("invalid_request","the due date is before the start date; nothing was saved"));}
        }
        // Snapshot actual native values before committing. Read the saved object
        // separately and compare every mutable value, including cleared fields.
        let expected=if self.calendar{self.event(client.0,&source_id,component.0,None)?}else{self.reminder(client.0,&source_id,component.0)?};self.check_deadline()?;let mut error=ptr::null_mut();let saved_uid=if creating||split.is_some(){let mut out=ptr::null_mut();let ok=unsafe{(self.api.create)(client.0,component.0,1,&mut out,ptr::null_mut(),&mut error)};let value=if out.is_null(){None}else{Some(self.api.owned_text(out,4096))};self.api.check(ok!=0,error)?;value.ok_or_else(||committed(failure("provider_failed","native create returned no item identity")))?.map_err(committed)?}else{let ok=unsafe{(self.api.modify)(client.0,component.0,modtype,1,ptr::null_mut(),&mut error)};self.api.check(ok!=0,error)?;uid};
        let saved=self.get(client.0,&saved_uid,&read_rid).map_err(committed)?;let actual=if self.calendar{self.event(client.0,&source_id,saved.0,None)}else{self.reminder(client.0,&source_id,saved.0)}.map_err(committed)?;verify(&expected,&actual,self.calendar)?;
        if let Some((original,seconds))=split{if let Err(error)=self.end_series_before(client.0,&original,seconds,a){let mut error=committed(error);error["details"]["newSeriesId"]=actual["id"].clone();return Err(error);}}
        for occurrence in &keep{self.check_deadline().map_err(committed)?;let mut error=ptr::null_mut();let ok=unsafe{(self.api.modify)(client.0,occurrence.0,1,1,ptr::null_mut(),&mut error)};self.api.check(ok!=0,error).map_err(committed)?;}
        Ok(actual)
    }
    fn end_series_before(&self,client:Raw,uid:&str,seconds:i64,a:&Value)->Result<Value,Value>{
        let master=self.get(client,uid,"")?;let start=Object::from(unsafe{(self.api.start)(master.0)}).ok_or_else(||failure("target_gone","recurring series has no start"))?;
        let first=self.api.instant(client,master.0,c"DTSTART",start.0)?.unix_timestamp();let date=unsafe{(self.api.time_date)(start.0)!=0};
        if seconds<=first{return Err(failure("unsupported_operation","this is the first occurrence; delete the series by its id with --span future"));}
        let rules=self.api.properties(master.0,c"RRULE")?;if rules.len()!=1{return Err(failure("unsupported_target","series must have exactly one recurrence rule"));}
        let raw=self.api.owned_text(unsafe{(self.api.property_value)(rules[0].0)},4096)?;let rule=rule_until(&raw,seconds,date)?;
        self.api.replace(master.0,c"RRULE",Some(&rule))?;self.check_deadline()?;let mut error=ptr::null_mut();
        let ok=unsafe{(self.api.modify)(client,master.0,7,1,ptr::null_mut(),&mut error)};self.api.check(ok!=0,error)?;
        let saved=self.get(client,uid,"").map_err(committed)?;let after=self.api.properties(saved.0,c"RRULE").map_err(committed)?;
        if after.len()!=1||self.api.owned_text(unsafe{(self.api.property_value)(after[0].0)},4096).map_err(committed)?!=rule{return Err(committed(failure("provider_failed","native series rule differs after ending it")));}
        Ok(json!({"ok":true,"id":a["id"]}))
    }
    fn first_seconds(&self,client:Raw,master:Raw)->Result<i64,Value>{let start=Object::from(unsafe{(self.api.start)(master)}).ok_or_else(||failure("target_gone","recurring series has no start"))?;Ok(self.api.instant(client,master,c"DTSTART",start.0)?.unix_timestamp())}
    /// The original start of a detached occurrence, from its RECURRENCE-ID (TZID parameter honored).
    fn rid_seconds(&self,client:Raw,component:Raw)->Result<i64,Value>{
        let property=self.api.properties(component,c"RECURRENCE-ID")?.into_iter().next().ok_or_else(||failure("target_gone","occurrence has no recurrence id"))?;
        let raw=self.api.owned_text(unsafe{(self.api.property_value)(property.0)},128)?;let time=self.api.parsed_time(&raw)?;Ok(self.api.instant(client,component,c"RECURRENCE-ID",time.0)?.unix_timestamp())
    }
    /// The series from the occurrence at `seconds` on, as a new item: a copy of the
    /// series that starts there, with COUNT turned into the original's last occurrence. The original is ended
    /// before it after the copy is saved. An edited occurrence after the split point would be orphaned, so that refuses.
    /// Copies of the series' saved (detached) occurrences.
    fn detached(&self,client:Raw,uid:&str)->Result<Vec<Object>,Value>{
        let list=self.query(client)?;let mut p=list.raw;let mut out=vec![];
        while !p.is_null(){let component=unsafe{(*p).data};p=unsafe{(*p).next};
            if text(unsafe{(self.api.component_uid)(component)},4096)?==uid&&!self.api.properties(component,c"RECURRENCE-ID")?.is_empty(){out.push(Object::from(unsafe{(self.api.clone_component)(component)}).ok_or_else(||failure("provider_failed","native occurrence copy failed"))?);}}
        Ok(out)
    }
    /// Turns EDS's clone of the series into the occurrence at `seconds`: its own start and end, no recurrence.
    fn as_occurrence(&self,client:Raw,master:&Object,component:Raw,seconds:i64)->Result<(),Value>{
        let start=Object::from(unsafe{(self.api.start)(master.0)}).ok_or_else(||failure("target_gone","recurring series has no start"))?;let first=self.api.instant(client,master.0,c"DTSTART",start.0)?.unix_timestamp();
        let end=Object::from(unsafe{(self.api.end)(master.0)}).map(|end|self.api.instant(client,master.0,c"DTEND",end.0).map(|t|t.unix_timestamp())).transpose()?.unwrap_or(first);
        let begin=self.occurrence_time(client,master.0,seconds)?;self.api.write_time(component,c"DTSTART",begin.0,self.api.set_start)?;
        let finish=self.occurrence_time(client,master.0,seconds+(end-first))?;self.api.write_time(component,c"DTEND",finish.0,self.api.set_end)?;
        for name in [c"RRULE",c"RDATE",c"EXDATE",c"EXRULE"]{self.api.replace(component,name,None)?;}Ok(())
    }
    fn split_series(&self,client:Raw,uid:&str,master:&Object,seconds:i64)->Result<Object,Value>{
        for occurrence in self.detached(client,uid)?{if self.rid_seconds(client,occurrence.0)?>=seconds{
                return Err(failure("unsupported_operation","an edited occurrence follows this one, and splitting the series here would lose that edit; no change was made"));}}
        let rules=self.api.properties(master.0,c"RRULE")?;if rules.len()!=1{return Err(failure("unsupported_target","series must have exactly one recurrence rule"));}
        let mut rule=self.api.owned_text(unsafe{(self.api.property_value)(rules[0].0)},4096)?;
        let start=Object::from(unsafe{(self.api.start)(master.0)}).ok_or_else(||failure("target_gone","recurring series has no start"))?;let date=unsafe{(self.api.time_date)(start.0)!=0};
        let first=self.api.instant(client,master.0,c"DTSTART",start.0)?.unix_timestamp();
        let end=Object::from(unsafe{(self.api.end)(master.0)}).map(|end|self.api.instant(client,master.0,c"DTEND",end.0).map(|t|t.unix_timestamp())).transpose()?.unwrap_or(first);
        if rule.split(';').any(|part|part.starts_with("COUNT=")){let last=self.last_seconds(client,master,seconds)?;rule=rule_until(&rule,last+if date{86400}else{1},date)?;}
        let copy=Object::from(unsafe{(self.api.clone_component)(master.0)}).ok_or_else(||failure("provider_failed","native series copy failed"))?;
        let new_uid=format!("interceptor-{}",crate::secret_target::random_token().map_err(|_|failure("provider_failed","native calendar UID entropy is unavailable"))?);unsafe{(self.api.set_uid)(copy.0,cstring(&new_uid)?.as_ptr());}
        let begin=self.occurrence_time(client,master.0,seconds)?;self.api.write_time(copy.0,c"DTSTART",begin.0,self.api.set_start)?;
        let finish=self.occurrence_time(client,master.0,seconds+(end-first))?;self.api.write_time(copy.0,c"DTEND",finish.0,self.api.set_end)?;
        self.api.replace(copy.0,c"RRULE",Some(&rule))?;Ok(copy)
    }
    /// The start of the series' last occurrence at or after `from` (the series must end).
    fn last_seconds(&self,client:Raw,master:&Object,from:i64)->Result<i64,Value>{
        let start=self.api.time(&iso(time::OffsetDateTime::from_unix_timestamp(from).map_err(|_|failure("invalid_request","occurrence instant is out of range"))?)?,false)?;let end=self.api.time("2200-01-01T00:00:00Z",false)?;
        let mut state=Instances{native:self,client,source:"",rows:Vec::new(),error:None,seen:0};let pointer=(&mut state as *mut Instances<'_, '_>).cast();let mut error=ptr::null_mut();
        let ok=unsafe{(self.api.generate)(master.0,start.0,end.0,instance,pointer,resolve_zone,pointer,(self.api.client_zone)(client),ptr::null_mut(),&mut error)};self.api.check(ok!=0,error)?;if let Some(error)=state.error{return Err(error);}
        state.rows.iter().filter_map(|row|row["startDate"].as_str().and_then(|s|date(s).ok()).map(|d|d.unix_timestamp())).max().ok_or_else(||failure("target_gone","no occurrence of the series starts at or after this one"))
    }
    fn occurrence_rid(&self,client:Raw,master:Raw,seconds:i64)->Result<String,Value>{let time=self.occurrence_time(client,master,seconds)?;let text=self.api.owned_text(unsafe{(self.api.time_string)(time.0)},64)?;if text.is_empty(){return Err(failure("provider_failed","native occurrence recurrence-ID is empty"));}Ok(text)}
    /// The instant `seconds` in the series' own DTSTART form (same zone, or a date for an all-day series).
    fn occurrence_time(&self,client:Raw,master:Raw,seconds:i64)->Result<Object,Value>{
        let start=Object::from(unsafe{(self.api.start)(master)}).ok_or_else(||failure("target_gone","recurring series has no start"))?;self.api.valid_time(start.0)?;
        let date=unsafe{(self.api.time_date)(start.0)!=0};let mut zone=unsafe{(self.api.time_zone)(start.0)};
        if zone.is_null()&&!date{if let Some(property)=self.api.properties(master,c"DTSTART")?.first(){let pointer=unsafe{(self.api.parameter)(property.0,c"TZID".as_ptr())};if !pointer.is_null(){let id=self.api.owned_text(pointer,4096)?;let mut found=ptr::null_mut();let mut error=ptr::null_mut();self.api.check(unsafe{(self.api.get_zone)(client,cstring(&id)?.as_ptr(),&mut found,ptr::null_mut(),&mut error)}!=0,error)?;zone=found;}}}
        if zone.is_null()||unsafe{(self.api.time_utc)(start.0)!=0}{zone=unsafe{(self.api.utc_zone)()};}
        Object::from(unsafe{(self.api.time_new)(seconds as libc::time_t,date as c_int,zone)}).ok_or_else(||failure("provider_failed","native occurrence time allocation failed"))
    }
    fn apply_alarms(&self,component:Raw,alarms:&[Value])->Result<(),Value>{let mut prepared=Vec::new();for raw in alarms{let raw=raw.as_str().unwrap();let alarm=self.api.new(c"VALARM")?;self.api.replace(alarm.0,c"ACTION",Some("DISPLAY"))?;self.api.replace(alarm.0,c"DESCRIPTION",Some("Reminder"))?;if date(raw).is_ok(){let t=self.api.time(raw,false)?;self.api.replace(alarm.0,c"TRIGGER;VALUE=DATE-TIME",Some(&self.api.owned_text(unsafe{(self.api.time_string)(t.0)},128)?))?;}else{let seconds=crate::eventkit::relative_alarm(raw).ok_or_else(||failure("invalid_request","invalid relative alarm"))?;if seconds.fract()!=0.0{return Err(failure("invalid_request","native iCalendar alarms require whole seconds"));}self.api.replace(alarm.0,c"TRIGGER",Some(&format!("{}PT{}S",if seconds<0.0{"-"}else{""},seconds.abs()as u64)))?;}prepared.push(alarm);}for old in self.api.children(component,c"VALARM")?{unsafe{(self.api.remove_component)(component,old.0)}}for alarm in prepared{unsafe{(self.api.add_component)(component,alarm.0)}}Ok(())}
    fn move_event(&self,a:&Value,source:&str,client:Raw,component:Raw,uid:&str)->Result<Value,Value>{
        let target_id=a["to"].as_str().unwrap();let target=self.source(target_id)?;let target_client=self.client(target.0,true)?;if target_id==source{return self.event(client,source,component,None);}
        let expected=self.event(client,source,component,None)?;self.check_deadline()?;let mut out=ptr::null_mut();let mut error=ptr::null_mut();let ok=unsafe{(self.api.create)(target_client.0,component,1,&mut out,ptr::null_mut(),&mut error)};let saved_uid=if out.is_null(){None}else{Some(self.api.owned_text(out,4096))};self.api.check(ok!=0,error)?;let saved_uid=saved_uid.ok_or_else(||committed(failure("provider_failed","native move copy lacks an identity")))?.map_err(committed)?;let copied=self.get(target_client.0,&saved_uid,"").map_err(committed)?;let actual=self.event(target_client.0,target_id,copied.0,None).map_err(committed)?;verify(&expected,&actual,true)?;
        self.check_deadline().map_err(committed)?;let ok=unsafe{(self.api.remove)(client,cstring(uid)?.as_ptr(),ptr::null(),1,1,ptr::null_mut(),&mut error)};if let Err(mut result)=self.api.check(ok!=0,error){result=committed(result);result["details"]["sourceId"]=a["id"].clone();result["details"]["targetId"]=actual["id"].clone();return Err(result);}match self.get(client,uid,""){Err(error)if error["code"]=="target_gone"=>Ok(actual),Err(error)=>Err(committed(error)),Ok(_)=>Err(committed(failure("provider_failed","move target was saved but source remains; no mutation replay")))}
    }
}
/// The RRULE with COUNT/UNTIL replaced by an UNTIL just before `seconds` (UTC date-time; a DATE for an all-day series,
/// per RFC 5545). Other parts (FREQ, INTERVAL, BYDAY, ...) are kept in order.
fn rule_until(raw:&str,seconds:i64,date:bool)->Result<String,Value>{
    let end=time::OffsetDateTime::from_unix_timestamp(seconds-if date{86400}else{1}).map_err(|_|failure("invalid_request","occurrence instant is out of range"))?;
    let until=if date{format!("{:04}{:02}{:02}",end.year(),end.month() as u8,end.day())}else{format!("{:04}{:02}{:02}T{:02}{:02}{:02}Z",end.year(),end.month() as u8,end.day(),end.hour(),end.minute(),end.second())};
    let mut parts:Vec<String>=raw.split(';').filter(|p|{let k=p.split('=').next().unwrap_or("");k!="COUNT"&&k!="UNTIL"}).map(str::to_owned).collect();
    if !parts.iter().any(|p|p.starts_with("FREQ=")){return Err(failure("provider_failed","native recurrence rule has no frequency"));}
    parts.push(format!("UNTIL={until}"));Ok(parts.join(";"))
}
fn committed(mut error:Value)->Value{error["code"]="timeout_unknown_outcome".into();if !error["details"].is_object(){error["details"]=json!({});}error["details"]["mutationCommitted"]=true.into();error}
fn verify(expected:&Value,actual:&Value,calendar:bool)->Result<(),Value>{let keys=if calendar{&["title","startDate","endDate","isAllDay","location","notes","url","alarms","recurrenceRules"][..]}else{&["title","priority","isCompleted","completionDate","notes","url","startDateComponents","dueDateComponents","alarms","recurrenceRules"][..]};for key in keys{if expected[*key]!=actual[*key]{return Err(committed(failure("provider_failed",format!("native calendar/reminder {key} differs after save"))));}}Ok(())}
fn identity(calendar:bool,source:&str,uid:&str,rid:&str)->String{use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD as E};format!("eds-{}:{}:{}:{}",if calendar{"event"}else{"task"},E.encode(source),E.encode(uid),E.encode(rid))}
fn decode(raw:&str,calendar:bool)->Result<(String,String,String),Value>{use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD as E};let prefix=if calendar{"eds-event:"}else{"eds-task:"};let parts=raw.strip_prefix(prefix).ok_or_else(||failure("target_gone","native EDS identity has the wrong entity type"))?.split(':').collect::<Vec<_>>();if parts.len()!=3{return Err(failure("target_gone","native EDS identity must retain source, UID and recurrence identity"));}let decode=|raw:&str|E.decode(raw).ok().and_then(|bytes|String::from_utf8(bytes).ok()).filter(|s|s.len()<=4096&&!s.contains('\0')&&E.encode(s)==raw).ok_or_else(||failure("target_gone","invalid canonical native EDS identity"));let tuple=(decode(parts[0])?,decode(parts[1])?,decode(parts[2])?);if tuple.0.is_empty()||tuple.1.is_empty(){return Err(failure("target_gone","native EDS identity lacks source or UID"));}Ok(tuple)}
fn duration_seconds(raw:&str)->Result<i64,Value>{
    let(sign,raw)=if let Some(s)=raw.strip_prefix('-'){(-1,s)}else{(1,raw.strip_prefix('+').unwrap_or(raw))};let raw=raw.strip_prefix('P').ok_or_else(||failure("provider_failed","invalid native iCalendar duration"))?;let(mut total,mut digits,mut time)=(0i64,String::new(),false);for c in raw.chars(){if c.is_ascii_digit(){digits.push(c);continue;}if c=='T'&&digits.is_empty()&&!time{time=true;continue;}let count=digits.parse::<i64>().map_err(|_|failure("provider_failed","invalid native alarm duration quantity"))?;let multiplier=match(c,time){('W',false)=>604800,('D',false)=>86400,('H',true)=>3600,('M',true)=>60,('S',true)=>1,_=>return Err(failure("unsupported_target","native calendar duration has unsupported units"))};total=total.checked_add(count.checked_mul(multiplier).ok_or_else(||failure("resource_limit","native alarm duration overflows"))?).ok_or_else(||failure("resource_limit","native alarm duration overflows"))?;digits.clear();}if !digits.is_empty()||raw.is_empty()||total>315576000{return Err(failure("resource_limit","native alarm duration exceeds its bound"));}Ok(sign*total)
}
struct Instances<'a,'b>{native:&'a Native<'b>,client:Raw,source:&'a str,rows:Vec<Value>,error:Option<Value>,seen:usize}
unsafe extern "C" fn resolve_zone(tzid:*const c_char,data:Raw,cancellable:Raw,error:*mut *mut Error)->Raw{let state=unsafe{&*(data.cast::<Instances<'_, '_>>())};let mut zone=ptr::null_mut();if unsafe{(state.native.api.get_zone)(state.client,tzid,&mut zone,cancellable,error)}!=0{zone}else{ptr::null_mut()}}
unsafe extern "C" fn instance(component:Raw,start:Raw,end:Raw,data:Raw,_cancel:Raw,_error:*mut *mut Error)->c_int{
    let state=unsafe{&mut*(data.cast::<Instances<'_, '_>>())};if state.error.is_some(){return 0;}if component.is_null()||start.is_null()||end.is_null(){state.error=Some(failure("provider_failed","native recurrence callback contains a null component or interval"));return 0;}state.seen+=1;let result=if state.seen>12000{Err(failure("resource_limit","native calendar expansion exceeds 12000 instances"))}else{state.native.check_deadline().and_then(|_|state.native.event(state.client,state.source,component,Some((start,end))))};match result{Ok(row)=>{state.rows.push(row);1},Err(error)=>{state.error=Some(error);0}}
}
fn events(n:&Native<'_>,a:&Value,exact:Option<&str>)->Result<Value,Value>{
    let start=n.api.time(a["start"].as_str().unwrap(),false)?;let end=n.api.time(a["end"].as_str().unwrap(),false)?;let sources=if let Some(id)=a["calendar"].as_str(){vec![n.source(id)?]}else if let Some(ids)=a["calendars"].as_str(){ids.split(',').map(|id|n.source(id)).collect::<Result<Vec<_>,_>>()?}else{n.sources()?};let mut rows=Vec::new();let mut scanned=0;
    for source in sources{let source_id=text(unsafe{(n.api.uid)(source.0)},4096)?;let client=n.client(source.0,false)?;let list=n.query(client.0)?;let mut p=list.raw;let begin=rows.len();while !p.is_null(){scanned+=1;if scanned>12000{return Err(failure("resource_limit","native calendar query exceeds 12000 components"));}n.check_deadline()?;let component=unsafe{(*p).data};if component.is_null(){return Err(failure("provider_failed","native calendar query contains a null component"));}
            // Reject unresolved floating DTSTART before the recurrence engine
            // receives its native default zone. UTC/date/TZID values are exact.
            let native_start=Object::from(unsafe{(n.api.start)(component)}).ok_or_else(||failure("provider_failed","native component DTSTART is missing"))?;n.api.instant(client.0,component,c"DTSTART",native_start.0)?;
            let mut state=Instances{native:n,client:client.0,source:&source_id,rows:Vec::new(),error:None,seen:0};let pointer=(&mut state as *mut Instances<'_, '_>).cast();let mut error=ptr::null_mut();let ok=unsafe{(n.api.generate)(component,start.0,end.0,instance,pointer,resolve_zone,pointer,(n.api.client_zone)(client.0),ptr::null_mut(),&mut error)};let native_result=n.api.check(ok!=0,error);if let Some(error)=state.error{return Err(error);}native_result?;if rows.len()+state.rows.len()>12000{return Err(failure("resource_limit","native calendar page scan exceeds 12000 instances"));}rows.extend(state.rows);p=unsafe{(*p).next};}
        let saved:BTreeSet<String>=rows[begin..].iter().filter(|r|r["isDetached"]==true).filter_map(|r|r["id"].as_str().map(str::to_owned)).collect();
        let mut index=begin;rows.retain(|r|{let keep=index<begin||r["isDetached"]==true||!r["id"].as_str().is_some_and(|id|saved.contains(id));index+=1;keep});}
    rows.sort_by(|a,b|a["startDate"].as_str().cmp(&b["startDate"].as_str()).then_with(||a["id"].as_str().cmp(&b["id"].as_str())));let mut identities=BTreeSet::new();if rows.iter().any(|r|!identities.insert((r["id"].as_str().unwrap().to_owned(),r["startDate"].as_str().unwrap().to_owned()))){return Err(failure("partial_result","native recurrence expansion returned duplicate occurrence identities"));}
    if let Some(id)=exact{let mut matching=rows.into_iter().filter(|row|row["id"]==id);let row=matching.next().ok_or_else(||failure("target_gone","exact native recurring occurrence is absent from the complete bounded scan"))?;if matching.next().is_some(){return Err(failure("target_ambiguous","native recurring occurrence identity is ambiguous"));}return Ok(row);}
    let(limit,offset)=page(a);let more=rows.len()>limit+offset;Ok(json!({"events":rows.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"limit":limit,"offset":offset,"hasMore":more}))
}
fn reminders(n:&Native<'_>,a:&Value)->Result<Value,Value>{let sources=if let Some(id)=a["list"].as_str(){vec![n.source(id)?]}else{n.sources()?};let mut rows=Vec::new();let mut scanned=0;for source in sources{let id=text(unsafe{(n.api.uid)(source.0)},4096)?;let client=n.client(source.0,false)?;let list=n.query(client.0)?;let mut p=list.raw;while !p.is_null(){scanned+=1;if scanned>12000{return Err(failure("resource_limit","native reminders query exceeds 12000 components"));}n.check_deadline()?;let component=unsafe{(*p).data};if component.is_null(){return Err(failure("provider_failed","native reminders query contains null"));}let row=n.reminder(client.0,&id,component)?;let sub=a["sub"].as_str().unwrap();let mut include=!(sub=="incomplete"&&row["isCompleted"]==true||sub=="completed"&&row["isCompleted"]!=true);
            for(lo,hi,property)in[("since","until",c"COMPLETED"),("due_start","due_end",c"DUE")]{if a.get(lo).is_some()||a.get(hi).is_some(){if let Some(raw)=n.api.value(component,property)?{let time=n.api.parsed_time(&raw)?;let instant=n.api.instant(client.0,component,property,time.0)?;if a[lo].as_str().is_some_and(|v|date(v).is_ok_and(|d|instant<d))||a[hi].as_str().is_some_and(|v|date(v).is_ok_and(|d|instant>=d)){include=false;}}else{include=false;}}}if include{rows.push(row);}p=unsafe{(*p).next};}}
    rows.sort_by(|a,b|a["id"].as_str().cmp(&b["id"].as_str()));let(limit,offset)=page(a);let more=rows.len()>limit+offset;Ok(json!({"reminders":rows.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"limit":limit,"offset":offset,"hasMore":more}))
}
/// `request` outcome from each source's open result. Read access needs every source to open; write access needs
/// at least one writable source (one read-only source must not deny write).
fn request_outcome(opened:&[Result<(),Value>],write:bool)->(bool,Option<String>){
    let text=|e:&Value,fallback:&str|e["error"].as_str().unwrap_or(fallback).to_owned();
    if opened.is_empty(){return(false,None);}
    if let Some(e)=opened.iter().filter_map(|r|r.as_ref().err()).find(|e|!(write&&e["code"]=="permission_denied")){return(false,Some(text(e,"native source access failed")));}
    if write&&!opened.iter().any(|r|r.is_ok()){return(false,Some(text(opened[0].as_ref().unwrap_err(),"native calendar/list is read-only")));}
    (true,None)
}
fn create_calendar(n:&Native<'_>,a:&Value)->Result<Value,Value>{
    if a["cal_type"].as_str().is_some_and(|t|t!="local"){return Err(failure("unsupported_operation","remote calendar creation requires native account collection provisioning; no source was created"));}
    let builtin=Object::from(unsafe{(n.api.builtin_calendar)(n.registry.0)}).ok_or_else(||failure("not_installed","native built-in calendar is unavailable"))?;let parent=text(unsafe{(n.api.parent)(builtin.0)},4096)?;if parent.is_empty(){return Err(failure("provider_failed","native built-in calendar has no parent identity"));}if a["source"].as_str().is_some_and(|s|s!=parent){return Err(failure("unsupported_operation","local calendar creation requires the actual built-in calendar parent; no account conversion inferred"));}
    let mut error=ptr::null_mut();let source=Object::from(unsafe{(n.api.source_new)(ptr::null_mut(),ptr::null_mut(),&mut error)});n.api.check(source.is_some(),error)?;let source=source.unwrap();let extension=unsafe{(n.api.extension)(source.0,c"Calendar".as_ptr())};if extension.is_null(){return Err(failure("provider_failed","native calendar extension allocation failed"));}unsafe{(n.api.set_name)(source.0,cstring(a["title"].as_str().unwrap())?.as_ptr());(n.api.set_parent)(source.0,cstring(&parent)?.as_ptr());(n.api.set_backend)(extension,c"local".as_ptr());}if let Some(color)=a["color"].as_str(){unsafe{(n.api.set_color)(extension,cstring(color)?.as_ptr())}}
    let id=text(unsafe{(n.api.uid)(source.0)},4096)?;let mut link=List{data:source.0,next:ptr::null_mut(),previous:ptr::null_mut()};n.check_deadline()?;let ok=unsafe{(n.api.create_sources)(n.registry.0,&mut link,ptr::null_mut(),&mut error)};n.api.check(ok!=0,error)?;let mut last=failure("provider_failed","native source registration readback is unavailable");loop{match n.source(&id){Ok(saved)=>{let row=n.row(saved.0).map_err(committed)?;if row["title"]!=a["title"]||row["source"]["id"]!=parent{return Err(committed(failure("provider_failed","native calendar title/parent differs after create")));}if let Some(color)=a["color"].as_str(){let extension=unsafe{(n.api.extension)(saved.0,c"Calendar".as_ptr())};if n.api.optional_text(unsafe{(n.api.color)(extension)},128)?.to_ascii_lowercase()!=color.to_ascii_lowercase(){return Err(committed(failure("provider_failed","native calendar color differs after create")));}}return Ok(row);},Err(error)=>{last=error;}}
        if Instant::now()>=n.deadline{return Err(committed(last));}for _ in 0..32{if unsafe{(n.api.iterate)(ptr::null_mut(),0)}==0{break;}}std::thread::sleep(Duration::from_millis(20));}
}
pub(crate) fn native(a:&Value)->Result<Value,Value>{
    if !crate::linux::graphical_login(){return Err(failure("no_interactive_session","Calendar/Reminders requires the retained graphical Linux login"));}
    let api=Api::load()?;let mut error=ptr::null_mut();let registry=Object::from(unsafe{(api.registry_new)(ptr::null_mut(),&mut error)});api.check(registry.is_some(),error)?;let n=Native{api:&api,registry:registry.unwrap(),calendar:a["type"]=="desktop_calendar",deadline:Instant::now()+Duration::from_secs(48)};let sub=a["sub"].as_str().unwrap();
    match sub{
        "status"=>Ok(if n.calendar{json!({"events":"unknown","reminders":"unknown","provider":"linux-evolution-data-server","scope":"per-source native access; EDS has no global EventKit permission"})}else{json!({"status":"unknown","provider":"linux-evolution-data-server","scope":"per-source native access; EDS has no global EventKit permission"})}),
        "request"=>{
            // EDS has no permission gate. Every source must open; write access needs at least one writable
            // source, since some sources are read-only by nature (the Contacts birthdays calendar, webcal feeds).
            let sources=n.sources()?;let write=n.calendar&&a["level"]=="write";
            let opened:Vec<Result<(),Value>>=sources.iter().map(|source|n.client(source.0,write).map(|_|())).collect();
            let(granted,message)=request_outcome(&opened,write);Ok(if n.calendar{json!({"level":a["level"].as_str().unwrap_or("full"),"granted":granted,"error":message})}else{json!({"granted":granted,"error":message})})},
        "list"|"lists"=>{let rows=n.sources()?.iter().map(|s|n.row(s.0)).collect::<Result<Vec<_>,_>>()?;Ok(if n.calendar{json!({"calendars":rows})}else{json!({"lists":rows})})},
        "default"=>match n.default()?{Some(source)=>n.row(source.0),None=>Ok(if n.calendar{json!({"calendar":null})}else{json!({"list":null})})},
        "sources"=>{let mut parents=BTreeMap::new();for source in n.sources()?{let row=n.row(source.0)?;if let Some(parent)=row.get("source"){let id=parent["id"].as_str().unwrap().to_owned();if let Some(prior)=parents.get(&id){if prior!=parent{return Err(failure("target_ambiguous","native parent source contains mixed calendar backends; no account type inferred"));}}parents.insert(id,parent.clone());}}Ok(json!({"sources":parents.into_values().collect::<Vec<_>>()}))},
        "create-calendar"=>create_calendar(&n,a),
        "delete-calendar"=>{let id=a["id"].as_str().unwrap();let source=n.source(id)?;n.client(source.0,true)?;if unsafe{(api.removable)(source.0)==0}{return Err(failure("permission_denied","native calendar source is not removable"));}n.check_deadline()?;let ok=unsafe{(api.remove_source)(source.0,ptr::null_mut(),&mut error)};api.check(ok!=0,error)?;let mut remaining=true;while remaining{remaining=Object::from(unsafe{(api.source)(n.registry.0,cstring(id)?.as_ptr())}).is_some();if remaining{if Instant::now()>=n.deadline{return Err(committed(failure("provider_failed","native source still exists after delete")));}for _ in 0..32{if unsafe{(api.iterate)(ptr::null_mut(),0)}==0{break;}}std::thread::sleep(Duration::from_millis(20));}}Ok(json!({"ok":true,"id":id}))},
        "events"=>events(&n,a,None),
        "event"=>{let(source,uid,rid)=decode(a["id"].as_str().unwrap(),true)?;if let Some(raw)=rid.strip_prefix('@'){let seconds=raw.parse::<i64>().map_err(|_|failure("target_gone","invalid native occurrence instant"))?;let start=time::OffsetDateTime::from_unix_timestamp(seconds).map_err(|_|failure("target_gone","native occurrence instant is outside bounds"))?;let end=start.checked_add(time::Duration::seconds(1)).ok_or_else(||failure("target_gone","native occurrence instant overflows"))?;return events(&n,&json!({"start":iso(start)?,"end":iso(end)?,"calendar":source}),Some(a["id"].as_str().unwrap()));}let source_object=n.source(&source)?;let client=n.client(source_object.0,false)?;let component=n.get(client.0,&uid,&rid)?;n.event(client.0,&source,component.0,None)},
        "event-by-external"=>{let mut rows=Vec::new();let mut scanned=0;for source in n.sources()?{let id=text(unsafe{(api.uid)(source.0)},4096)?;let client=n.client(source.0,false)?;let list=n.query(client.0)?;let mut p=list.raw;while !p.is_null(){scanned+=1;if scanned>12000{return Err(failure("resource_limit","native external UID lookup exceeds 12000 components"));}n.check_deadline()?;let component=unsafe{(*p).data};if component.is_null(){return Err(failure("provider_failed","native external UID query contains a null component"));}if text(unsafe{(api.component_uid)(component)},4096)?==a["id"].as_str().unwrap(){rows.push(n.event(client.0,&id,component,None)?);}p=unsafe{(*p).next};}}let(limit,offset)=page(a);let more=rows.len()>limit+offset;Ok(json!({"events":rows.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"limit":limit,"offset":offset,"hasMore":more}))},
        "all"|"incomplete"|"completed"=>reminders(&n,a),
        "refresh-sources"=>{for source in n.sources()?{let client=n.client(source.0,false)?;n.check_deadline()?;
            // Local sources keep no remote copy to refresh (EDS answers "Not supported"); skip them.
            if unsafe{(api.refresh_supported)(client.0)}==0{continue;}let ok=unsafe{(api.refresh)(client.0,ptr::null_mut(),&mut error)};api.check(ok!=0,error)?;}Ok(json!({"ok":true}))},
        "reset"=>Ok(json!({"ok":true})), // This owned helper drops all native clients and registry before exit.
        // macOS tail counts store changes since the first tail; EDS has no change feed, so compare
        // each source's objects (UID + RECURRENCE-ID -> digest of the iCalendar text) with a snapshot.
        "tail"=>{let mut items=crate::snapshot::Digests::new();for source in n.sources()?{let id=text(unsafe{(api.uid)(source.0)},4096)?;let client=n.client(source.0,false)?;let list=n.query(client.0)?;let mut p=list.raw;
            while !p.is_null(){n.check_deadline()?;let component=unsafe{(*p).data};p=unsafe{(*p).next};if component.is_null(){continue;}
                let uid=text(unsafe{(api.component_uid)(component)},4096).unwrap_or_default();let rid=api.value(component,c"RECURRENCE-ID")?.unwrap_or_default();
                let body=api.owned_text(unsafe{(api.as_ical)(component)},1<<20)?;items.insert(format!("{id}:{uid}:{rid}"),crate::snapshot::digest(&json!(body)));
                if items.len()>20000{return Err(failure("resource_limit","calendar tail compares at most 20000 calendar objects"));}}}
            crate::snapshot::calendar_tail(items)},
        _=>n.mutation(a),
    }
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn ending_a_series_replaces_count_or_until_and_keeps_the_rest(){
        // 2030-05-09T15:00:00Z = 1904569200
        assert_eq!(rule_until("FREQ=DAILY;INTERVAL=1;COUNT=5",1904569200,false).unwrap(),"FREQ=DAILY;INTERVAL=1;UNTIL=20300509T145959Z");
        assert_eq!(rule_until("FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20310101T000000Z",1904569200,false).unwrap(),"FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20300509T145959Z");
        assert_eq!(rule_until("FREQ=DAILY",1904515200,true).unwrap(),"FREQ=DAILY;UNTIL=20300508");
        assert!(rule_until("INTERVAL=2",1904569200,false).is_err());
    }
    #[test]fn request_write_needs_one_writable_source_not_all(){
        let ro=||Err(failure("permission_denied","native calendar/list is read-only"));let down=||Err(failure("provider_failed","source unavailable"));
        // EDS birthdays (read-only) + a local calendar: write is granted, as writes there succeed.
        assert_eq!(request_outcome(&[ro(),Ok(())],true),(true,None));
        assert_eq!(request_outcome(&[ro(),ro()],true).0,false);
        assert_eq!(request_outcome(&[ro(),Ok(())],false),(false,Some("native calendar/list is read-only".into())));
        assert_eq!(request_outcome(&[Ok(()),down()],true),(false,Some("source unavailable".into())));
        assert_eq!(request_outcome(&[],true),(false,None));
        assert_eq!(request_outcome(&[Ok(()),Ok(())],false),(true,None));
    }
    #[test]fn identities_keep_the_source_and_occurrence(){let id=identity(true,"actual-source","actual-uid","20261008T120000Z");assert_eq!(decode(&id,true).unwrap(),("actual-source".into(),"actual-uid".into(),"20261008T120000Z".into()));assert!(decode(&id,false).is_err());assert!(decode("eds-event:YQ:Yg:",true).is_ok());assert!(decode("eds-event:YQ==:Yg:",true).is_err());}
    #[test]fn alarm_durations_are_exact_and_bounded(){assert_eq!(duration_seconds("-PT5M").unwrap(),-300);assert_eq!(duration_seconds("P1DT2H").unwrap(),93600);for bad in["P","P1Y","PT1.5S","PT999999999999999999999S"]{assert!(duration_seconds(bad).is_err());}}
}
