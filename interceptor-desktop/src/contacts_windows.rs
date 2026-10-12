use crate::failure;
use serde_json::{Value,json};
use windows::{core::{HSTRING,Interface},ApplicationModel::Contacts::*,Foundation::{IReference,PropertyValue},Security::Authorization::AppCapabilityAccess::{AppCapability,AppCapabilityAccessStatus},Storage::Streams::{DataReader,DataWriter,InMemoryRandomAccessStream,RandomAccessStreamReference},Win32::System::WinRT::{RoInitialize,RoUninitialize,RO_INIT_MULTITHREADED,RO_INIT_SINGLETHREADED}};
struct Runtime;impl Drop for Runtime{fn drop(&mut self){unsafe{RoUninitialize();}}}
fn native_error(error:windows::core::Error)->Value{let mut reply=if crate::windows::null_result(error.code().0){failure("target_gone","native Windows Contacts returned no item for this request")}else{failure("provider_failed",format!("native Windows Contacts failed: {error}"))};reply["details"]=json!({"nativeHRESULT":error.code().0});reply}
fn scope(write:bool)->Result<AppCapability,Value>{AppCapability::Create(&HSTRING::from(if write{"contactsSystem"}else{"contacts"})).map_err(native_error)}
fn status(value:AppCapabilityAccessStatus)->&'static str{match value{AppCapabilityAccessStatus::Allowed=>"authorized",AppCapabilityAccessStatus::DeniedByUser=>"denied",AppCapabilityAccessStatus::DeniedBySystem|AppCapabilityAccessStatus::NotDeclaredByApp=>"restricted",AppCapabilityAccessStatus::UserPromptRequired=>"notDetermined",_=>"unknown"}}
fn store(write:bool)->Result<ContactStore,Value>{ContactManager::RequestStoreAsyncWithAccessType(if write{ContactStoreAccessType::AppContactsReadWrite}else{ContactStoreAccessType::AllContactsReadOnly}).and_then(|op|op.join()).map_err(native_error)}
pub(crate) fn installed_identity()->Result<(),Value>{
    // Same native package/external-root checks as the existing badge helper.
    // The Contacts application has its own identity; toast activation stays
    // on the unpackaged provider executable.
    use windows::{core::PWSTR,Win32::Storage::Packaging::Appx::{GetCurrentApplicationUserModelId,GetCurrentPackagePath2,PackagePathType_EffectiveExternal}};
    unsafe{
        let mut id=[0u16;256];let mut length=id.len()as u32;
        GetCurrentApplicationUserModelId(&mut length,Some(PWSTR(id.as_mut_ptr()))).ok().map_err(|_|failure("not_installed","Contacts requires its installed sparse-package application identity"))?;
        if length==0||length as usize>id.len()||id[length as usize-1]!=0||String::from_utf16(&id[..length as usize-1]).ok().as_deref()!=Some("HackerValleyMedia.Interceptor.Desktop_4xfsjzhwq8rce!Contacts"){return Err(failure("unsupported_target","native Contacts package application identity differs"));}
        let mut external=vec![0u16;32768];let mut length=external.len()as u32;
        GetCurrentPackagePath2(PackagePathType_EffectiveExternal,&mut length,Some(PWSTR(external.as_mut_ptr()))).ok().map_err(native_error)?;
        if length==0||length as usize>external.len()||external[length as usize-1]!=0{return Err(failure("provider_failed","native Contacts package external location is invalid"));}
        let external=String::from_utf16(&external[..length as usize-1]).map_err(|_|failure("provider_failed","native Contacts package path is invalid UTF16"))?;
        let executable=std::env::current_exe().map_err(|_|failure("provider_failed","native Contacts executable identity is unavailable"))?;
        let root=executable.parent().ok_or_else(||failure("provider_failed","native Contacts helper has no installation root"))?;
        let external=std::fs::canonicalize(external).map_err(|_|failure("not_installed","native Contacts external package root is unavailable"))?;
        let root=std::fs::canonicalize(root).map_err(|_|failure("not_installed","native Contacts helper installation root is unavailable"))?;
        if external!=root||executable.file_name().and_then(|name|name.to_str())!=Some("interceptor-contacts-native.exe"){return Err(failure("unsupported_target","native Contacts package is registered outside this helper"));}
    }Ok(())
}
fn request_access()->Value{
    // Native consent must run on a UI thread. This helper's main thread is
    // STA for request only, and reuses the authentication message pump.
    let deadline=std::time::Instant::now()+std::time::Duration::from_secs(45);
    let requested=scope(false).and_then(|cap|cap.RequestAccessAsync().and_then(|operation|crate::auth_windows::await_result(&operation,deadline,None)).map_err(native_error));
    match requested{
        Ok(value)if value==AppCapabilityAccessStatus::Allowed=>match store(false){
            Ok(_)=>{let writes=scope(true).and_then(|cap|{let access=cap.CheckAccess().map_err(native_error)?;if access==AppCapabilityAccessStatus::UserPromptRequired{cap.RequestAccessAsync().and_then(|operation|crate::auth_windows::await_result(&operation,deadline,None)).map_err(native_error)}else{Ok(access)}});json!({"granted":true,"error":match writes{Ok(AppCapabilityAccessStatus::Allowed)=>None,Ok(status)=>Some(format!("read access allowed; native app-owned write capability remains{}",status.0)),Err(error)=>Some(format!("read access allowed; write capability check failed: {}",error["error"].as_str().unwrap_or("native failure")))}})},
            Err(error)=>json!({"granted":false,"error":error["error"]})
        },
        Ok(value)=>json!({"granted":false,"error":format!("native Contacts read access status{}",value.0)}),Err(error)=>json!({"granted":false,"error":error["error"]})
    }
}
fn lists(store:&ContactStore)->Result<Vec<ContactList>,Value>{let rows=store.FindContactListsAsync().and_then(|op|op.join()).map_err(native_error)?;let count=rows.Size().map_err(native_error)?;if count>128{return Err(failure("resource_limit","native Windows ContactLists exceed 128"));}(0..count).map(|index|rows.GetAt(index).map_err(native_error)).collect()}
fn selected(store:&ContactStore,a:&Value,create:bool)->Result<ContactList,Value>{
    if let Some(id)=a["container"].as_str(){return store.GetContactListAsync(&HSTRING::from(id)).and_then(|op|op.join()).map_err(native_error);}
    let rows=lists(store)?;if rows.len()==1{return Ok(rows.into_iter().next().unwrap());}
    if rows.is_empty()&&create{return store.CreateContactListAsync(&HSTRING::from("Interceptor")).and_then(|op|op.join()).map_err(native_error);}
    Err(failure("unsupported_target","native Windows Contacts requires an exact --container when zero or multiple app-owned lists exist"))
}
fn calendar_date(date:&ContactDate)->Result<Option<String>,Value>{
    macro_rules! component{($method:ident)=>{match date.$method().and_then(|value|value.Value()){Ok(value)=>Some(value),Err(error)if crate::windows::null_result(error.code().0)=>None,Err(error)=>return Err(native_error(error))}}}
    let(year,month,day)=(component!(Year),component!(Month),component!(Day));let(Some(month),Some(day))=(month,day)else{return Ok(None)};
    if month<1||month>12||day<1||day>31||year.is_some_and(|year|!(1..=9999).contains(&year)){return Err(failure("provider_failed","native Contact date has invalid calendar components"));}
    if time::Date::from_calendar_date(year.unwrap_or(2000),time::Month::try_from(month as u8).unwrap(),day as u8).is_err(){return Err(failure("provider_failed","native Contact date is not an actual calendar date"));}
    Ok(Some(year.map(|year|format!("{year:04}-{month:02}-{day:02}")).unwrap_or_else(||format!("--{month:02}-{day:02}"))))
}
fn picture(reference:windows::core::Result<windows::Storage::Streams::IRandomAccessStreamReference>,thumbnail:bool)->Result<Option<String>,Value>{
    let reference=match reference{Ok(reference)=>reference,Err(error)if crate::windows::null_result(error.code().0)=>return Ok(None),Err(error)=>return Err(native_error(error))};
    let stream=reference.OpenReadAsync().and_then(|op|op.join()).map_err(native_error)?;let size=stream.Size().map_err(native_error)?;if size==0||size>196608{return Ok(None);}
    let input=stream.GetInputStreamAt(0).map_err(native_error)?;let reader=DataReader::CreateDataReader(&input).map_err(native_error)?;if reader.LoadAsync(size as u32).and_then(|op|op.join()).map_err(native_error)?!=size as u32{return Err(failure("partial_result","native Contact picture stream is incomplete"));}let mut bytes=vec![0;size as usize];reader.ReadBytes(&mut bytes).map_err(native_error)?;
    // A picture over 192KiB or in a format the bounded decoder refuses (GIF, HEIC) leaves this row without image data; it never fails the read.
    Ok(crate::contacts::image_url(&bytes,thumbnail).ok())
}
fn row(contact:&Contact,a:&Value)->Result<Value,Value>{
    let mut emails=Vec::new();let values=contact.Emails().map_err(native_error)?;let count=values.Size().map_err(native_error)?;if count>32{return Err(failure("resource_limit","native Contact emails exceed 32"));}for index in 0..count{let entry=values.GetAt(index).map_err(native_error)?;emails.push(json!({"label":entry.Description().map_err(native_error)?.to_string(),"value":entry.Address().map_err(native_error)?.to_string()}));}
    let mut phones=Vec::new();let values=contact.Phones().map_err(native_error)?;let count=values.Size().map_err(native_error)?;if count>32{return Err(failure("resource_limit","native Contact phones exceed 32"));}for index in 0..count{let entry=values.GetAt(index).map_err(native_error)?;phones.push(json!({"label":entry.Description().map_err(native_error)?.to_string(),"value":entry.Number().map_err(native_error)?.to_string()}));}
    let mut postal=Vec::new();let values=contact.Addresses().map_err(native_error)?;let count=values.Size().map_err(native_error)?;if count>32{return Err(failure("resource_limit","native Contact addresses exceed 32"));}for index in 0..count{let entry=values.GetAt(index).map_err(native_error)?;postal.push(json!({"label":entry.Description().map_err(native_error)?.to_string(),"street":entry.StreetAddress().map_err(native_error)?.to_string(),"city":entry.Locality().map_err(native_error)?.to_string(),"state":entry.Region().map_err(native_error)?.to_string(),"postalCode":entry.PostalCode().map_err(native_error)?.to_string(),"country":entry.Country().map_err(native_error)?.to_string()}));}
    let mut value=json!({"id":contact.Id().map_err(native_error)?.to_string(),"givenName":contact.FirstName().map_err(native_error)?.to_string(),"middleName":contact.MiddleName().map_err(native_error)?.to_string(),"familyName":contact.LastName().map_err(native_error)?.to_string(),"namePrefix":contact.HonorificNamePrefix().map_err(native_error)?.to_string(),"nameSuffix":contact.HonorificNameSuffix().map_err(native_error)?.to_string(),"nickname":contact.Nickname().map_err(native_error)?.to_string(),"phonetic":{"given":contact.YomiGivenName().map_err(native_error)?.to_string(),"family":contact.YomiFamilyName().map_err(native_error)?.to_string()},"emailAddresses":emails,"phoneNumbers":phones,"postalAddresses":postal,"note":contact.Notes().map_err(native_error)?.to_string()});
    let jobs=contact.JobInfo().map_err(native_error)?;let job_count=jobs.Size().map_err(native_error)?;if job_count>1{return Err(failure("unsupported_target","native Contact has multiple jobs; one organization field cannot preserve them"));}if job_count==1{let job=jobs.GetAt(0).map_err(native_error)?;value["organization"]=json!({"name":job.CompanyName().map_err(native_error)?.to_string(),"department":job.Department().map_err(native_error)?.to_string(),"jobTitle":job.Title().map_err(native_error)?.to_string(),"phonetic":job.CompanyYomiName().map_err(native_error)?.to_string()});}
    let dates=contact.ImportantDates().map_err(native_error)?;let count=dates.Size().map_err(native_error)?;if count>32{return Err(failure("resource_limit","native Contact dates exceed 32"));}let mut others=Vec::new();let mut birthday=false;for index in 0..count{let date=dates.GetAt(index).map_err(native_error)?;let kind=date.Kind().map_err(native_error)?;let formatted=calendar_date(&date)?;if kind==ContactDateKind::Birthday{if birthday{return Err(failure("unsupported_target","native Contact contains multiple birthdays"));}birthday=true;if let Some(formatted)=formatted{value["birthday"]=json!(formatted);}}else{let description=date.Description().map_err(native_error)?.to_string();let label=if description.is_empty(){if kind==ContactDateKind::Anniversary{"anniversary".to_string()}else{format!("native-date-kind:{}",kind.0)}}else{description};others.push(json!({"label":label,"date":formatted}));}}value["dates"]=json!(others);
    let websites=contact.Websites().map_err(native_error)?;let count=websites.Size().map_err(native_error)?;if count>32{return Err(failure("resource_limit","native Contact websites exceed 32"));}let mut urls=Vec::new();for index in 0..count{let website=websites.GetAt(index).map_err(native_error)?;urls.push(json!({"label":website.Description().map_err(native_error)?.to_string(),"value":website.RawValue().map_err(native_error)?.to_string()}));}value["urlAddresses"]=json!(urls);
    let relations=contact.SignificantOthers().map_err(native_error)?;let count=relations.Size().map_err(native_error)?;if count>32{return Err(failure("resource_limit","native Contact relations exceed 32"));}let mut related=Vec::new();for index in 0..count{let relation=relations.GetAt(index).map_err(native_error)?;let description=relation.Description().map_err(native_error)?.to_string();let kind=relation.Relationship().map_err(native_error)?;let label=if description.is_empty(){match kind{ContactRelationship::Spouse=>"spouse".into(),ContactRelationship::Partner=>"partner".into(),ContactRelationship::Sibling=>"sibling".into(),ContactRelationship::Parent=>"parent".into(),ContactRelationship::Child=>"child".into(),_=>format!("native-relationship:{}",kind.0)}}else{description};related.push(json!({"label":label,"name":relation.Name().map_err(native_error)?.to_string()}));}value["contactRelations"]=json!(related);
    let image=contact.SourceDisplayPicture();value["imageDataAvailable"]=json!(match &image{Ok(_)=>true,Err(error)if crate::windows::null_result(error.code().0)=>false,Err(error)=>return Err(native_error(error.clone()))});
    if crate::contacts::image_requested(a,"thumbnailDataUrl"){if let Some(url)=picture(contact.Thumbnail(),true)?{value["thumbnailDataUrl"]=json!(url);}}
    if crate::contacts::image_requested(a,"imageDataUrl"){if let Some(url)=picture(image,false)?{value["imageDataUrl"]=json!(url);}}
    Ok(value)
}
fn mutable(contact:&Contact,a:&Value)->Result<(),Value>{
    if let Some(value)=a["given"].as_str(){contact.SetFirstName(&HSTRING::from(value)).map_err(native_error)?;}if let Some(value)=a["family"].as_str(){contact.SetLastName(&HSTRING::from(value)).map_err(native_error)?;}if let Some(value)=a["note"].as_str(){if value.encode_utf16().count()>4096{return Err(failure("resource_limit","Windows native Contact notes are limited to 4096 UTF16 code units; no save performed"));}contact.SetNotes(&HSTRING::from(value)).map_err(native_error)?;}
    if let Some(value)=a["organization"].as_str(){let jobs=contact.JobInfo().map_err(native_error)?;let count=jobs.Size().map_err(native_error)?;if count>1{return Err(failure("unsupported_target","multiple native jobs cannot be replaced by one organization field"));}let job=if count==1{jobs.GetAt(0).map_err(native_error)?}else{ContactJobInfo::new().map_err(native_error)?};job.SetCompanyName(&HSTRING::from(value)).map_err(native_error)?;if count==0{jobs.Append(&job).map_err(native_error)?;}}
    if let Some(raw)=a["email"].as_str(){let values=contact.Emails().map_err(native_error)?;values.Clear().map_err(native_error)?;for(label,value)in crate::contacts::labeled(raw)?{let entry=ContactEmail::new().map_err(native_error)?;entry.SetDescription(&HSTRING::from(label)).map_err(native_error)?;entry.SetKind(ContactEmailKind::Other).map_err(native_error)?;entry.SetAddress(&HSTRING::from(value)).map_err(native_error)?;values.Append(&entry).map_err(native_error)?;}}
    if let Some(raw)=a["phone"].as_str(){let values=contact.Phones().map_err(native_error)?;values.Clear().map_err(native_error)?;for(label,value)in crate::contacts::labeled(raw)?{let entry=ContactPhone::new().map_err(native_error)?;entry.SetDescription(&HSTRING::from(label)).map_err(native_error)?;entry.SetKind(ContactPhoneKind::Other).map_err(native_error)?;entry.SetNumber(&HSTRING::from(value)).map_err(native_error)?;values.Append(&entry).map_err(native_error)?;}}
    if let Some(raw)=a["postal"].as_str(){let(label,value)=raw.split_once(':').unwrap();let fields=value.split(';').collect::<Vec<_>>();let entry=ContactAddress::new().map_err(native_error)?;entry.SetDescription(&HSTRING::from(label)).map_err(native_error)?;entry.SetKind(ContactAddressKind::Other).map_err(native_error)?;entry.SetStreetAddress(&HSTRING::from(fields[0])).map_err(native_error)?;entry.SetLocality(&HSTRING::from(fields[1])).map_err(native_error)?;entry.SetRegion(&HSTRING::from(fields[2])).map_err(native_error)?;entry.SetPostalCode(&HSTRING::from(fields[3])).map_err(native_error)?;entry.SetCountry(&HSTRING::from(fields[4])).map_err(native_error)?;let values=contact.Addresses().map_err(native_error)?;values.Clear().map_err(native_error)?;values.Append(&entry).map_err(native_error)?;}
    if let Some(raw)=a["birthday"].as_str(){let fields=raw.split('-').map(|v|v.parse::<i32>().unwrap()).collect::<Vec<_>>();let date=ContactDate::new().map_err(native_error)?;date.SetKind(ContactDateKind::Birthday).map_err(native_error)?;let year:IReference<i32>=PropertyValue::CreateInt32(fields[0]).and_then(|v|v.cast()).map_err(native_error)?;let month:IReference<u32>=PropertyValue::CreateUInt32(fields[1]as u32).and_then(|v|v.cast()).map_err(native_error)?;let day:IReference<u32>=PropertyValue::CreateUInt32(fields[2]as u32).and_then(|v|v.cast()).map_err(native_error)?;date.SetYear(&year).map_err(native_error)?;date.SetMonth(&month).map_err(native_error)?;date.SetDay(&day).map_err(native_error)?;let dates=contact.ImportantDates().map_err(native_error)?;let count=dates.Size().map_err(native_error)?;for index in(0..count).rev(){if dates.GetAt(index).and_then(|v|v.Kind()).map_err(native_error)?==ContactDateKind::Birthday{dates.RemoveAt(index).map_err(native_error)?;}}dates.Append(&date).map_err(native_error)?;}
    Ok(())
}
fn import_contact(bytes:&[u8])->Result<Contact,Value>{
    let stream=InMemoryRandomAccessStream::new().map_err(native_error)?;let output=stream.GetOutputStreamAt(0).map_err(native_error)?;let writer=DataWriter::CreateDataWriter(&output).map_err(native_error)?;
    writer.WriteBytes(bytes).map_err(native_error)?;let stored=writer.StoreAsync().and_then(|op|op.join()).map_err(native_error)?;
    if stored as usize!=bytes.len(){return Err(failure("provider_failed","native vCard conversion stream has incomplete input; no contact saved"));}
    stream.Seek(0).map_err(native_error)?;let reference=RandomAccessStreamReference::CreateFromStream(&stream).map_err(native_error)?;let contact=ContactManager::ConvertVCardToContactAsync(&reference).and_then(|op|op.join()).map_err(native_error)?;
    contact.SetId(&HSTRING::default()).map_err(native_error)?;contact.SetRemoteId(&HSTRING::default()).map_err(native_error)?;Ok(contact)
}
fn read(store:&ContactStore,a:&Value)->Result<Value,Value>{
    if a.get("group").is_some(){return Err(failure("unsupported_operation","native Windows contact membership groups are not implemented; no scope was ignored"));}
    let reader=if a["sub"]=="find"{
        let(value,field)=if let Some(v)=a["email"].as_str(){(v,ContactQuerySearchFields::Email)}else if let Some(v)=a["phone"].as_str(){(v,ContactQuerySearchFields::Phone)}else{(a["query"].as_str().or(a["name"].as_str()).unwrap(),ContactQuerySearchFields::Name)};
        let options=ContactQueryOptions::CreateWithTextAndFields(&HSTRING::from(value),field).map_err(native_error)?;store.GetContactReaderWithOptions(&options).map_err(native_error)?
    }else if a.get("container").is_some(){selected(store,a,false)?.GetContactReader().map_err(native_error)?}else{store.GetContactReader().map_err(native_error)?};
    let offset=crate::contacts::integer(&a["offset"]).unwrap_or(0);let limit=crate::contacts::integer(&a["limit"]).unwrap_or(if a["sub"]=="find"{1000}else{100});let(mut seen,mut rows)=(0u64,Vec::new());
    loop{let batch=reader.ReadBatchAsync().and_then(|op|op.join()).map_err(native_error)?;if batch.Status().map_err(native_error)?!=ContactBatchStatus::Success{return Err(failure("provider_failed","native Windows ContactReader returned incomplete search results"));}let contacts=batch.Contacts().map_err(native_error)?;let count=contacts.Size().map_err(native_error)?;if count==0{break;}if count>1000||seen+count as u64>12000{return Err(failure("resource_limit","native Windows ContactReader exceeds its bounded inventory"));}
        for index in 0..count{let contact=contacts.GetAt(index).map_err(native_error)?;
            // A search hit is the unified contact; its raw contacts carry the ids create/contact/update use.
            let raw=if contact.IsAggregate().map_err(native_error)?{let raw=store.AggregateContactManager().and_then(|m|m.FindRawContactsAsync(&contact)).and_then(|op|op.join()).map_err(native_error)?;(0..raw.Size().map_err(native_error)?).map(|i|raw.GetAt(i).map_err(native_error)).collect::<Result<Vec<_>,_>>()?}else{vec![contact]};
            for contact in raw{let value=row(&contact,a)?;
            let matching=if let Some(query)=a["email"].as_str(){value["emailAddresses"].as_array().unwrap().iter().any(|entry|entry["value"].as_str().unwrap().eq_ignore_ascii_case(query))}else{true};
            seen+=1;if !matching||seen<=offset{continue;}if rows.len()as u64==limit{if a["sub"]=="find"{return Err(failure("resource_limit","native Contacts search exceeds 1000 matches; narrow the query"));}return Ok(json!({"limit":limit,"offset":offset,"contacts":rows}));}rows.push(crate::contacts::project(a,value));}
        }
    }
    Ok(if a["sub"]=="find"{json!({"matches":rows})}else{json!({"limit":limit,"offset":offset,"contacts":rows})})
}
pub(crate) fn native(a:&Value)->Result<Value,Value>{
    let sub=a["sub"].as_str().unwrap();unsafe{RoInitialize(if sub=="request"{RO_INIT_SINGLETHREADED}else{RO_INIT_MULTITHREADED})}.map_err(native_error)?;let _runtime=Runtime;
    if sub=="status"{let identity=installed_identity();let actual=identity.as_ref().map_err(|error|error.clone()).and_then(|_|scope(false).and_then(|cap|cap.CheckAccess().map_err(native_error)));return Ok(json!({"status":actual.map(status).unwrap_or("unknown"),"supportsLimited":false,"notesEntitlement":false,"provider":"Windows ContactStore","scope":"all-contact reads require installed Contacts identity and contacts consent; writes are limited to app-owned lists and contactsSystem access; all-contact writes require separate Microsoft provisioning"}));}
    installed_identity()?;
    if a["keys"].as_str().is_some_and(|keys|keys.split(',').any(|key|matches!(key,"contactType"|"socialProfiles"|"instantMessageAddresses"|"requires_entitlement"))){return Err(failure("unsupported_operation","selected Contact key has no implemented Windows field mapping; no requested field was silently omitted"));}
    if sub=="request"{return Ok(request_access());}
    let write=matches!(sub,"create"|"update"|"delete"|"import-vcard"|"group-create"|"group-update"|"group-delete"|"group-add-member"|"group-remove-member");
    let access=scope(write)?.CheckAccess().map_err(native_error)?;if access!=AppCapabilityAccessStatus::Allowed{return Err(failure("permission_denied","native Contacts operation capability is not allowed; no prompt or mutation was performed"));}
    let store=store(write)?;
    match sub{
        "containers"=>{let mut rows=Vec::new();for list in lists(&store)?{rows.push(json!({"id":list.Id().map_err(native_error)?.to_string(),"name":list.DisplayName().map_err(native_error)?.to_string(),"type":"native-address-book"}));}Ok(json!({"containers":rows}))},
        // Apps write only to their own lists, so an app's default container is its own list. This read
        // never creates one; the first create makes it.
        "default-container"=>Ok(json!({"id":selected(&self::store(true)?,a,false)?.Id().map_err(native_error)?.to_string()})),
        "list"|"find"=>read(&store,a),
        "me"=>{
            // With no Me card Windows returns null or an empty contact without an id.
            let me=match store.GetMeContactAsync().and_then(|op|op.join()){Ok(contact)=>Some(contact),Err(e)if crate::windows::null_result(e.code().0)=>None,Err(e)=>return Err(native_error(e))};
            let me=me.filter(|c|c.Id().is_ok_and(|id|!id.is_empty())).ok_or_else(||failure("unsupported_target","this Windows account has no Me contact"))?;row(&me,a)
        },
        "contact"=>row(&store.GetContactAsync(&HSTRING::from(a["id"].as_str().unwrap())).and_then(|op|op.join()).map_err(native_error)?,a),
        "create"|"update"=>{let contact=if sub=="create"{Contact::new().map_err(native_error)?}else{store.GetContactAsync(&HSTRING::from(a["id"].as_str().unwrap())).and_then(|op|op.join()).map_err(native_error)?};mutable(&contact,a)?;let list=if sub=="create"{selected(&store,a,true)?}else{store.GetContactListAsync(&contact.ContactListId().map_err(native_error)?).and_then(|op|op.join()).map_err(native_error)?};list.SaveContactAsync(&contact).and_then(|op|op.join()).map_err(native_error)?;let id=contact.Id().map_err(native_error)?;let saved=store.GetContactAsync(&id).and_then(|op|op.join()).map_err(|_|failure("partial_result","native Contact saved but actual readback failed; no mutation was replayed"))?;row(&saved,a)},
        "delete"=>{let id=a["id"].as_str().unwrap();let contact=store.GetContactAsync(&HSTRING::from(id)).and_then(|op|op.join()).map_err(native_error)?;let list=store.GetContactListAsync(&contact.ContactListId().map_err(native_error)?).and_then(|op|op.join()).map_err(native_error)?;list.DeleteContactAsync(&contact).and_then(|op|op.join()).map_err(native_error)?;Ok(json!({"ok":true,"id":id}))},
        "vcard"=>{let id=a["id"].as_str().unwrap();let contact=store.GetContactAsync(&HSTRING::from(id)).and_then(|op|op.join()).map_err(native_error)?;let stream=ContactManager::ConvertContactToVCardAsync(&contact).and_then(|op|op.join()).and_then(|reference|reference.OpenReadAsync()).and_then(|op|op.join()).map_err(native_error)?;let size=stream.Size().map_err(native_error)?;if size>262144{return Err(failure("resource_limit","native vCard exceeds 256KiB"));}let input=stream.GetInputStreamAt(0).map_err(native_error)?;let reader=DataReader::CreateDataReader(&input).map_err(native_error)?;let loaded=reader.LoadAsync(size as u32).and_then(|op|op.join()).map_err(native_error)?;if loaded!=size as u32{return Err(failure("partial_result","native vCard stream is incomplete"));}let mut bytes=vec![0;size as usize];reader.ReadBytes(&mut bytes).map_err(native_error)?;let text=String::from_utf8(bytes).map_err(|_|failure("provider_failed","native vCard is not UTF8"))?;Ok(json!({"id":id,"bytes":size,"vcard":text}))},
        "import-vcard"=>{
            use std::{io::Read,os::windows::fs::{OpenOptionsExt,MetadataExt}};
            let mut file=std::fs::OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000).open(a["path"].as_str().unwrap()).map_err(|_|failure("permission_denied","native vCard import file cannot be retained"))?;
            let metadata=file.metadata().map_err(|_|failure("provider_failed","vCard file metadata failed"))?;if !metadata.is_file()||metadata.file_attributes()&0x400!=0||metadata.len()>262144{return Err(failure("resource_limit","native vCard import requires a regular nonsymlink file up to 256KiB"));}
            let mut bytes=Vec::new();file.by_ref().take(262145).read_to_end(&mut bytes).map_err(|_|failure("provider_failed","retained vCard read failed"))?;
            let mut contacts=Vec::new();for text in crate::contacts::vcard_inputs(&bytes)?{contacts.push(import_contact(text.as_bytes())?);}
            let list=selected(&store,a,true)?;let mut ids=Vec::new();
            for contact in contacts{
                if let Err(error)=list.SaveContactAsync(&contact).and_then(|op|op.join()){
                    let mut reply=native_error(error);reply["code"]=json!("partial_result");reply["details"]["completedNativeIds"]=json!(ids);reply["details"]["failedSaveOutcome"]=json!("unknown; no import replayed");return Err(reply);
                }
                let id=contact.Id().map_err(|_|{let mut reply=failure("partial_result","native import saved a card but its identity receipt failed; no replay");reply["details"]=json!({"completedNativeIds":ids});reply})?.to_string();
                if id.trim().is_empty(){let mut reply=failure("partial_result","native import saved a card but returned no identity; no replay");reply["details"]=json!({"completedNativeIds":ids});return Err(reply);}ids.push(id);
            }
            Ok(json!({"imported":ids.len(),"ids":ids}))
        },
        // Tokens are saved store snapshots (Windows ContactChangeTracker consumes changes on accept,
        // so one token could not be read twice); Windows contacts have no groups.
        "current-token"|"changes"=>{let mut contacts=crate::snapshot::Digests::new();let mut offset=0u64;
            loop{let page=read(&store,&json!({"type":"desktop_contacts","sub":"list","limit":1000,"offset":offset}))?;let rows=page["contacts"].as_array().cloned().unwrap_or_default();
                for row in &rows{if let Some(id)=row["id"].as_str(){contacts.insert(id.to_owned(),crate::snapshot::digest(row));}}
                if rows.len()<1000{break;}offset+=1000;if offset>=20000{return Err(failure("resource_limit","contacts change tokens cover at most 20000 contacts"));}}
            crate::snapshot::contact_history(a,contacts,crate::snapshot::Digests::new())},
        _=>Err(failure("unsupported_operation","native Windows Contacts has no contact groups; no synthetic results were returned"))
    }
}
