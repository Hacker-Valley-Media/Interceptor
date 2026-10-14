//! Pinned PDFium API in a disposable, bounded native helper. No document JavaScript.
use crate::{contract_generated::*,failure,success};
use base64::{Engine as _,engine::general_purpose::STANDARD};
use pdfium_render::prelude::*;
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use std::{collections::HashSet,ffi::{c_int,c_ulong,c_void},ptr,sync::Mutex,time::{Duration,Instant}};
type Result<T>=std::result::Result<T,Value>;
const MAX_JSON:usize=1_048_576;
const MAX_OUTPUT:usize=6_000_000;
const TYPES:[&str;29]=["Unknown","Text","Link","FreeText","Line","Square","Circle","Polygon","PolyLine","Highlight","Underline","Squiggly","StrikeOut","Stamp","Caret","Ink","Popup","FileAttachment","Sound","Movie","Widget","Screen","PrinterMark","TrapNet","Watermark","3D","RichMedia","XFAWidget","Redact"];
// ponytail: one PDF helper at a time; separate engine queues if throughput needs them.
static WORK:Mutex<()>=Mutex::new(());
fn invalid(message:&str)->Value{failure("invalid_request",message)}
fn native(message:&str)->Value{failure("provider_failed",message)}
fn bounded(value:Value)->Result<Value>{if serde_json::to_vec(&value).map_or(true,|v|v.len()>MAX_JSON){Err(failure("resource_limit","PDF metadata exceeds 1 MiB"))}else{Ok(value)}}
fn page_range(text:&str,max:i32)->Result<(i32,i32)>{
    let parts=text.split('-').collect::<Vec<_>>();
    if parts.is_empty()||parts.len()>2||parts.iter().any(|v|v.is_empty()||v.len()>4||v.starts_with('0')||!v.bytes().all(|b|b.is_ascii_digit())){return Err(invalid("PDF range requires an ascending 1-based page or inclusive range"));}
    let lo=parts[0].parse::<i32>().unwrap_or(0);let hi=parts.get(1).unwrap_or(&parts[0]).parse::<i32>().unwrap_or(0);
    if lo<1||hi<lo||hi>max{return Err(invalid("PDF page range is outside the document"));}Ok((lo,hi))
}
fn validate(a:&Value)->Result<()>{
    if let Some(error)=desktop_pdf_shape_error(a){return Err(invalid(&error));}
    let sub=a["sub"].as_str().unwrap_or("");
    let extra:&[&str]=match sub{"info"|"outline"|"forms"|"images"|"attributes"|"permissions"=>&[],"text"=>&["page","range","attributed"],"annotations"=>&["page","annotation_type"],"forms_set"=>&["field","value","out"],"find"=>&["query","case_sensitive"],"annotate"=>&["page","rect","annotation_type","contents","out"],"strip"=>&["out"],"merge"=>&["paths","out"],"split"=>&["pages","out"],_=>return Err(invalid("unknown PDF operation"))};
    if a.as_object().unwrap().keys().any(|k|!matches!(k.as_str(),"type"|"sub"|"group"|"groupColor")&&!(k=="path"&&sub!="merge")&&!extra.contains(&k.as_str())){return Err(invalid("PDF field does not belong to the requested operation"));}
    if sub=="merge"{let paths=a["paths"].as_array().filter(|v|!v.is_empty()&&v.len()<=64).ok_or_else(||invalid("PDF merge requires 1..64 sources"))?;for path in paths{crate::filesystem::absolute(path.as_str().unwrap_or(""))?;}}else{crate::filesystem::absolute(a["path"].as_str().unwrap_or(""))?;}
    if let Some(path)=a.get("out"){crate::filesystem::absolute(path.as_str().unwrap_or(""))?;}
    if ["strip","merge","split"].contains(&sub)&&a.get("out").is_none(){return Err(invalid("PDF operation requires an output path"));}
    if a.get("page").is_some_and(|v|v.as_f64().is_none_or(|n|n.fract()!=0.0||!(1.0..=4096.0).contains(&n)))||a.get("page").is_some()&&a.get("range").is_some(){return Err(invalid("PDF requires a 1-based page or range"));}
    for key in ["range","pages"]{if let Some(v)=a.get(key){page_range(v.as_str().unwrap_or(""),4096)?;}}
    if sub=="split"&&a.get("pages").is_none(){return Err(invalid("PDF split requires pages"));}
    let string=|key:&str,cap:usize,empty:bool|a[key].as_str().is_some_and(|s|(empty||!s.is_empty())&&s.len()<=cap&&!s.contains('\0'));
    if sub=="find"&&!string("query",4096,false)||sub=="forms_set"&&(!string("field",4096,false)||!string("value",65536,true)){return Err(invalid("PDF search or form update requires bounded strings"));}
    for (key,cap,empty) in [("annotation_type",64,false),("contents",65536,true),("group",256,false),("groupColor",256,false)]{if a.get(key).is_some()&&!string(key,cap,empty){return Err(invalid("invalid PDF string field"));}}
    if sub=="annotate"{if a.get("page").is_none(){return Err(invalid("PDF annotation requires a page"));}rect_input(a["rect"].as_str().unwrap_or(""))?;}
    Ok(())
}
fn rect_input(s:&str)->Result<[f32;4]>{
    let v=s.split(',').map(|v|v.trim().parse::<f64>()).collect::<std::result::Result<Vec<_>,_>>().map_err(|_|invalid("PDF rect requires x,y,w,h"))?;
    if v.len()!=4||v.iter().any(|n|!n.is_finite()||n.abs()>1e7)||v[2]<=0.0||v[3]<=0.0{return Err(invalid("PDF rect requires finite coordinates and positive dimensions"));}Ok([v[0]as f32,v[1]as f32,v[2]as f32,v[3]as f32])
}
fn rect(left:f64,bottom:f64,right:f64,top:f64)->Result<Value>{
    if [left,bottom,right,top].iter().any(|v|!v.is_finite()||v.abs()>1e7)||right<left||top<bottom{return Err(native("PDF engine returned invalid bounds"));}
    Ok(json!({"x":left,"y":bottom,"w":right-left,"h":top-bottom}))
}
fn utf16(mut read:impl FnMut(*mut u16,c_ulong)->c_ulong)->Result<Option<String>>{
    let count=read(ptr::null_mut(),0)as usize;if count==0{return Ok(None);}
    if count>MAX_JSON||count%2!=0{return Err(failure("resource_limit","PDF string exceeds its UTF16 bound"));}
    let mut units=vec![0u16;count/2];if read(units.as_mut_ptr(),count as c_ulong)as usize!=count||units.last()!=Some(&0){return Err(native("PDF string changed or lacked its terminator"));}units.pop();
    String::from_utf16(&units).map(Some).map_err(|_|native("PDF string is invalid UTF16"))
}
fn pdf_date(s:&str)->Result<String>{
    let s=s.strip_prefix("D:").unwrap_or(s);if !s.is_ascii()||s.len()<4{return Err(native("PDF date is invalid"));}
    let digits=s.bytes().take_while(u8::is_ascii_digit).count();if ![4,6,8,10,12,14].contains(&digits){return Err(native("PDF date is invalid"));}
    let n=|start:usize,default:u8|->Result<u8>{if digits>=start+2{s[start..start+2].parse().map_err(|_|native("PDF date is invalid"))}else{Ok(default)}};
    let date=time::Date::from_calendar_date(s[..4].parse().map_err(|_|native("PDF year is invalid"))?,time::Month::try_from(n(4,1)?).map_err(|_|native("PDF month is invalid"))?,n(6,1)?).map_err(|_|native("PDF date is invalid"))?;
    let time=time::Time::from_hms(n(8,0)?,n(10,0)?,n(12,0)?).map_err(|_|native("PDF time is invalid"))?;
    let zone=&s[digits..];let offset=if zone.is_empty()||zone=="Z"{time::UtcOffset::UTC}else{
        let zone=zone.replace('\'',"");if zone.len()!=5||!matches!(zone.as_bytes()[0],b'+'|b'-'){return Err(native("PDF timezone is invalid"));}
        let sign=if zone.starts_with('-'){-1}else{1};time::UtcOffset::from_hms(zone[1..3].parse::<i8>().map_err(|_|native("PDF timezone is invalid"))?*sign,zone[3..5].parse::<i8>().map_err(|_|native("PDF timezone is invalid"))?*sign,0).map_err(|_|native("PDF timezone is invalid"))?
    };
    date.with_time(time).assume_offset(offset).to_offset(time::UtcOffset::UTC).format(&time::format_description::well_known::Rfc3339).map_err(|_|native("PDF date cannot be represented"))
}
#[cfg(windows)]struct DllDirectory(*mut c_void);
#[cfg(windows)]impl Drop for DllDirectory{fn drop(&mut self){unsafe{let _=windows::Win32::System::LibraryLoader::RemoveDllDirectory(self.0);}}}
struct Engine{b:Box<dyn PdfiumLibraryBindings>,#[cfg(windows)]_directory:DllDirectory}
impl Drop for Engine{fn drop(&mut self){unsafe{self.b.FPDF_DestroyLibrary();}}}
impl Engine{fn load()->Result<Self>{
    let (path,expected)=crate::native_library::pinned_spec("INTERCEPTOR_PDFIUM_LIBRARY")?;
    let bytes=crate::thumbnail::source_bytes(&path)?;let digest=Sha256::digest(bytes).iter().map(|b|format!("{b:02x}")).collect::<String>();if digest!=expected.to_ascii_lowercase(){return Err(failure("version_mismatch","PDFium runtime bytes differ from their pinned SHA256"));}
    #[cfg(windows)]let directory=unsafe{
        use std::os::windows::ffi::OsStrExt;use windows::Win32::System::LibraryLoader::*;
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS).map_err(|_|native("PDF helper DLL search policy could not be restricted"))?;
        let parent=path.parent().ok_or_else(||invalid("PDFium runtime requires a parent directory"))?.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
        let cookie=AddDllDirectory(windows::core::PCWSTR(parent.as_ptr()));
        if cookie.is_null(){return Err(native("PDF helper runtime directory could not be registered"));}
        DllDirectory(cookie)
    };
    let b=Pdfium::bind_to_library(&path).map_err(|_|failure("version_mismatch","PDFium library cannot supply the selected 7881 API"))?;
    unsafe{b.FPDF_InitLibrary();b.FPDF_SetSandBoxPolicy(0,0);}Ok(Self{b,#[cfg(windows)]_directory:directory})
}}
macro_rules! handle{($name:ident,$raw:ty,$close:ident)=>{struct $name<'a>{b:&'a dyn PdfiumLibraryBindings,raw:$raw}impl Drop for $name<'_>{fn drop(&mut self){unsafe{self.b.$close(self.raw);}}}};}
handle!(Annotation,FPDF_ANNOTATION,FPDFPage_CloseAnnot);
handle!(Text,FPDF_TEXTPAGE,FPDFText_ClosePage);
handle!(Search,FPDF_SCHHANDLE,FPDFText_FindClose);
struct Document<'a>{b:&'a dyn PdfiumLibraryBindings,raw:FPDF_DOCUMENT,_bytes:Vec<u8>,form:FPDF_FORMHANDLE,_info:Box<FPDF_FORMFILLINFO>,count:i32,sources:Vec<(std::path::PathBuf,[u8;32])>}
impl Drop for Document<'_>{fn drop(&mut self){unsafe{if !self.form.is_null(){self.b.FPDFDOC_ExitFormFillEnvironment(self.form);}self.b.FPDF_CloseDocument(self.raw);}}}
impl<'a> Document<'a>{
    fn load(b:&'a dyn PdfiumLibraryBindings,path:&str)->Result<Self>{
        let path=crate::filesystem::absolute(path)?;let bytes=crate::thumbnail::source_bytes(&path)?;let digest=Sha256::digest(&bytes).into();let mut d=Self::from_bytes(b,bytes)?;d.sources.push((path,digest));Ok(d)
    }
    fn from_bytes(b:&'a dyn PdfiumLibraryBindings,bytes:Vec<u8>)->Result<Self>{unsafe{
        let raw=b.FPDF_LoadMemDocument64(&bytes,None);if raw.is_null(){return Err(failure(match b.FPDF_GetLastError(){4|5=>"permission_denied",_=>"unsupported_target"},"PDFium refused the source; no document was modified"));}Self::owned(b,raw,bytes)
    }}
    fn owned(b:&'a dyn PdfiumLibraryBindings,raw:FPDF_DOCUMENT,bytes:Vec<u8>)->Result<Self>{unsafe{
        let mut info:Box<FPDF_FORMFILLINFO>=Box::new(std::mem::zeroed());info.version=2;info.xfa_disabled=1;
        let form=b.FPDFDOC_InitFormFillEnvironment(raw,&mut*info);let count=b.FPDF_GetPageCount(raw);
        let document=Self{b,raw,_bytes:bytes,form,_info:info,count,sources:vec![]};if !(1..=4096).contains(&count){return Err(failure("resource_limit","PDF requires 1..4096 pages"));}Ok(document)
    }}
    fn page(&self,number:i32)->Result<Page<'_>>{unsafe{if number<1||number>self.count{return Err(invalid("PDF page is outside the document"));}let raw=self.b.FPDF_LoadPage(self.raw,number-1);if raw.is_null(){return Err(native("PDF page could not be loaded"));}if !self.form.is_null(){self.b.FORM_OnAfterLoadPage(raw,self.form);}Ok(Page{b:self.b,raw,form:self.form})}}
    fn permission(&self,bit:u32)->bool{unsafe{
        let revision=self.b.FPDF_GetSecurityHandlerRevision(self.raw);if revision<0{return true;}
        let bits=self.b.FPDF_GetDocPermissions(self.raw)as u32;
        if revision==2{return bits&match bit{1024=>8,256=>32,512=>16,2048=>4,_=>bit}!=0;}
        if bit==2048{return bits&4!=0&&bits&2048!=0;}if bit==256{return bits&(32|256)!=0;}bits&bit!=0
    }}
    fn rights(&self)->Value{
        let pairs=[(32,"allowsCommenting"),(512,"allowsContentAccessibility"),(16,"allowsContentCopying"),(1024,"allowsDocumentAssembly"),(8,"allowsDocumentChanges"),(256,"allowsFormFieldEntry"),(2048,"allowsHighQualityPrinting"),(4,"allowsLowQualityPrinting")];
        json!(pairs.iter().filter_map(|(bit,name)|self.permission(*bit).then_some(*name)).collect::<Vec<_>>())
    }
    fn require(&self,bit:u32)->Result<()>{if self.permission(bit){Ok(())}else{Err(failure("permission_denied","PDF security permissions refuse this operation"))}}
    fn save(&self,path:&str)->Result<()>{unsafe{
        #[repr(C)]struct Writer{api:FPDF_FILEWRITE,bytes:Vec<u8>,failed:bool}
        unsafe extern "C" fn write(raw:*mut FPDF_FILEWRITE,data:*const c_void,size:c_ulong)->c_int{unsafe{
            if raw.is_null(){return 0;}let out=&mut*raw.cast::<Writer>();let size=size as usize;
            if size>MAX_OUTPUT.saturating_sub(out.bytes.len())||size>0&&data.is_null()||out.bytes.try_reserve(size).is_err(){out.failed=true;return 0;}
            if size>0{out.bytes.extend_from_slice(std::slice::from_raw_parts(data.cast::<u8>(),size));}1
        }}
        let mut out=Writer{api:FPDF_FILEWRITE{version:1,WriteBlock:Some(write)},bytes:vec![],failed:false};
        if self.b.FPDF_SaveAsCopy(self.raw,&mut out.api,2)==0||out.failed{return Err(failure(if out.failed{"resource_limit"}else{"provider_failed"},"PDF save failed before the destination was changed"));}
        let checked=Self::from_bytes(self.b,out.bytes.clone())?;if checked.count!=self.count{return Err(native("PDF saved page count differs from its document"));}drop(checked);
        let absolute=crate::filesystem::absolute(path)?;let mut request=json!({"type":"desktop_fs_write","path":path,"content":STANDARD.encode(out.bytes),"encoding":"base64"});
        for(source,digest)in &self.sources{if source!=&absolute{continue;}
            let metadata=std::fs::metadata(source).map_err(|_|failure("target_gone","PDF source no longer exists; destination was not changed"))?;
            let modified=metadata.modified().map_err(|_|native("PDF source modification time is unavailable"))?;
            let current=crate::thumbnail::source_bytes(source)?;let actual:[u8;32]=Sha256::digest(current).into();if &actual!=digest{return Err(invalid("PDF source changed during processing; destination was not changed"));}
            let modified=time::OffsetDateTime::from(modified).format(&time::format_description::well_known::Rfc3339).map_err(|_|native("PDF source modification time is invalid"))?;request["ifMatch"]=json!({"modified":modified});
        }
        let result=crate::filesystem::dispatch("fs_write",&request);if result["success"]!=true{return Err(result);}Ok(())
    }}
}
struct Page<'a>{b:&'a dyn PdfiumLibraryBindings,raw:FPDF_PAGE,form:FPDF_FORMHANDLE}
impl Drop for Page<'_>{fn drop(&mut self){unsafe{if !self.form.is_null(){self.b.FORM_OnBeforeClosePage(self.raw,self.form);}self.b.FPDF_ClosePage(self.raw);}}}
impl Page<'_>{
    fn annotations(&self)->Result<i32>{unsafe{let n=self.b.FPDFPage_GetAnnotCount(self.raw);if !(0..=4096).contains(&n){Err(failure("resource_limit","PDF annotation count exceeds 4096"))}else{Ok(n)}}}
    fn annotation(&self,i:i32)->Result<Annotation<'_>>{unsafe{let raw=self.b.FPDFPage_GetAnnot(self.raw,i);if raw.is_null(){Err(native("PDF annotation could not be loaded"))}else{Ok(Annotation{b:self.b,raw})}}}
    fn text(&self)->Result<Text<'_>>{unsafe{let raw=self.b.FPDFText_LoadPage(self.raw);if raw.is_null(){Err(native("PDF text could not be loaded"))}else{Ok(Text{b:self.b,raw})}}}
}
fn destination(d:&Document<'_>,dest:FPDF_DEST)->Result<Option<Value>>{unsafe{
    if dest.is_null(){return Ok(None);}let page=d.b.FPDFDest_GetDestPageIndex(d.raw,dest);if page<0||page>=d.count{return Err(native("PDF destination page is invalid"));}
    let(mut hx,mut hy,mut hz,mut x,mut y,mut z)=(0,0,0,0f32,0f32,0f32);let mut value=json!({"pageIndex":page});
    if d.b.FPDFDest_GetLocationInPage(dest,&mut hx,&mut hy,&mut hz,&mut x,&mut y,&mut z)!=0{if hx!=0{if !x.is_finite(){return Err(native("PDF destination is invalid"));}value["x"]=json!(x);}if hy!=0{if !y.is_finite(){return Err(native("PDF destination is invalid"));}value["y"]=json!(y);}}Ok(Some(value))
}}
fn choice_exports(d:&Document<'_>,number:i32,index:i32,count:i32)->Result<Vec<String>>{unsafe{
    // The public API exposes labels but no direct export-value getter. Probe
    // the native choice editor in an unsaved copy; the source stays unchanged.
    let copy=Document::from_bytes(d.b,d._bytes.clone())?;let page=copy.page(number)?;let a=page.annotation(index)?;let b=d.b;
    let flags=b.FPDFAnnot_GetFormFieldFlags(copy.form,a.raw);if flags<0||b.FPDFAnnot_SetFormFieldFlags(copy.form,a.raw,flags&!1&!(1<<21))==0{return Err(native("PDF choice probe could not read its field flags"));}
    let mut values=Vec::new();let mut bytes=0;
    for i in 0..count{
        if b.FORM_SetFocusedAnnot(copy.form,a.raw)==0||b.FORM_SetIndexSelected(copy.form,page.raw,i,1)==0||b.FORM_ForceToKillFocus(copy.form)==0{return Err(native("PDF choice probe could not select an option"));}
        let value=utf16(|p,n|b.FPDFAnnot_GetFormFieldValue(copy.form,a.raw,p,n))?.ok_or_else(||native("PDF choice probe omitted its export value"))?;bytes+=value.len();if bytes>MAX_JSON{return Err(failure("resource_limit","PDF choice export values exceed 1 MiB"));}values.push(value);
    }Ok(values)
}}
fn annotation_value(d:&Document<'_>,a:&Annotation<'_>,number:i32,index:i32)->Result<Value>{unsafe{
    let b=a.b;let subtype=b.FPDFAnnot_GetSubtype(a.raw)as usize;let kind=*TYPES.get(subtype).ok_or_else(||native("PDF annotation subtype is invalid"))?;
    let mut r:FS_RECTF=std::mem::zeroed();if b.FPDFAnnot_GetRect(a.raw,&mut r)==0{return Err(native("PDF annotation omitted its bounds"));}
    let get=|key:&str|{match b.FPDFAnnot_GetValueType(a.raw,key){0|8=>Ok(None),3|4=>utf16(|p,n|b.FPDFAnnot_GetStringValue(a.raw,key,p,n)),_=>Err(native("PDF annotation string has an incompatible object type"))}};
    let modified=get("M")?.filter(|s|!s.is_empty()).map(|s|pdf_date(&s)).transpose()?;
    let mut row=json!({"page":number,"type":kind,"bounds":rect(r.left as f64,r.bottom as f64,r.right as f64,r.top as f64)?,"contents":get("Contents")?,"userName":get("T")?,"modificationDate":modified,"isReadOnly":b.FPDFAnnot_GetFlags(a.raw)&64!=0,"isMultiline":false,"isPasswordField":false,"maximumLength":0,"hasComb":false,"isListChoice":false});
    for (color_type,key) in [(0,"color"),(1,"backgroundColor")]{let(mut r,mut g,mut blue,mut alpha)=(0,0,0,0);if b.FPDFAnnot_GetColor(a.raw,color_type,&mut r,&mut g,&mut blue,&mut alpha)!=0{if [r,g,blue,alpha].iter().any(|v|*v>255){return Err(native("PDF color is invalid"));}row[key]=json!(format!("#{r:02x}{g:02x}{blue:02x}"));}}
    if let Some(markup)=match subtype{9=>Some("highlight"),12=>Some("strikeOut"),10=>Some("underline"),28=>Some("redact"),_=>None}{row["markupType"]=json!(markup);}
    if subtype==20{
        if d.form.is_null(){return Err(native("PDF widget requires a form environment"));}
        let flags=b.FPDFAnnot_GetFormFieldFlags(d.form,a.raw);let field_type=b.FPDFAnnot_GetFormFieldType(d.form,a.raw);if flags<0||field_type<0{return Err(native("PDF widget fields could not be read"));}
        let field_name=utf16(|p,n|b.FPDFAnnot_GetFormFieldName(d.form,a.raw,p,n))?;if let Some(name)=field_name{row["fieldName"]=json!(name);}
        if let Some(value)=utf16(|p,n|b.FPDFAnnot_GetFormFieldValue(d.form,a.raw,p,n))?.filter(|s|!s.is_empty()){row["widgetStringValue"]=json!(value);}
        if let Some(kind)=match field_type{1..=3=>Some("button"),4|5=>Some("choice"),6=>Some("text"),7=>Some("signature"),_=>None}{row["widgetFieldType"]=json!(kind);}
        row["isReadOnly"]=json!(flags&1!=0);row["isMultiline"]=json!(field_type==6&&flags&4096!=0);row["isPasswordField"]=json!(field_type==6&&flags&8192!=0);row["hasComb"]=json!(field_type==6&&flags&(1<<24)!=0);row["isListChoice"]=json!(field_type==5);
        let mut at=a.raw;let mut parents=Vec::new();let mut maximum=0f32;
        for depth in 0..=32{if b.FPDFAnnot_GetNumberValue(at,"MaxLen",&mut maximum)!=0{if !maximum.is_finite()||maximum<0.0||maximum.fract()!=0.0||maximum>2147483520.0{return Err(native("PDF field length is invalid"));}row["maximumLength"]=json!(maximum as i32);break;}
            let parent=b.FPDFAnnot_GetLinkedAnnot(at,"Parent");if parent.is_null(){break;}parents.push(Annotation{b,raw:parent});at=parent;if depth==32{return Err(failure("resource_limit","PDF field parent chain exceeds 32"));}}
        if field_type==4||field_type==5{let count=b.FPDFAnnot_GetOptionCount(d.form,a.raw);if !(0..=4096).contains(&count){return Err(native("PDF choice options could not be read"));}let mut options=Vec::new();for i in 0..count{options.push(utf16(|p,n|b.FPDFAnnot_GetOptionLabel(d.form,a.raw,i,p,n))?.ok_or_else(||native("PDF choice omitted its label"))?);}if !options.is_empty(){row["values"]=json!(choice_exports(d,number,index,count)?);row["choices"]=json!(options);}}
    }
    if subtype==2{let link=b.FPDFAnnot_GetLink(a.raw);if !link.is_null(){if let Some(dest)=destination(d,b.FPDFLink_GetDest(d.raw,link))?{row["destination"]=dest;}
        let action=b.FPDFLink_GetAction(link);if !action.is_null()&&b.FPDFAction_GetType(action)==3{let count=b.FPDFAction_GetURIPath(d.raw,action,ptr::null_mut(),0)as usize;if count>4096{return Err(failure("resource_limit","PDF URL exceeds 4096 bytes"));}if count>0{let mut bytes=vec![0u8;count];if b.FPDFAction_GetURIPath(d.raw,action,bytes.as_mut_ptr().cast(),count as c_ulong)as usize!=count||bytes.pop()!=Some(0){return Err(native("PDF URL is invalid"));}row["url"]=json!(String::from_utf8(bytes).map_err(|_|native("PDF URL is not UTF8"))?);}}}}
    bounded(row)
}}
fn outline(d:&Document<'_>,parent:FPDF_BOOKMARK,seen:&mut HashSet<usize>,depth:usize)->Result<Vec<Value>>{unsafe{
    let mut at=d.b.FPDFBookmark_GetFirstChild(d.raw,parent);if at.is_null(){return Ok(vec![]);}if depth>12{return Err(failure("resource_limit","PDF outline exceeds 12 child levels"));}let mut rows=Vec::new();
    while !at.is_null(){if seen.len()>=4096||!seen.insert(at as usize){return Err(failure("resource_limit","PDF outline is cyclic or exceeds 4096 nodes"));}
        let title=utf16(|p,n|d.b.FPDFBookmark_GetTitle(at,p.cast(),n))?.unwrap_or_default();let mut value=json!({"label":title,"isOpen":d.b.FPDFBookmark_GetCount(at)>0});let mut dest=d.b.FPDFBookmark_GetDest(d.raw,at);
        if dest.is_null(){let action=d.b.FPDFBookmark_GetAction(at);if !action.is_null()&&d.b.FPDFAction_GetType(action)==1{dest=d.b.FPDFAction_GetDest(d.raw,action);}}
        if let Some(dest)=destination(d,dest)?{value["destination"]=dest;}let children=outline(d,at,seen,depth+1)?;if !children.is_empty(){value["children"]=json!(children);}rows.push(bounded(value)?);at=d.b.FPDFBookmark_GetNextSibling(d.raw,at);
    }Ok(rows)
}}
fn text_value(t:&Text<'_>,start:i32,count:i32)->Result<String>{unsafe{
    if count==0{return Ok(String::new());}
    if count<0||count>500000{return Err(failure("resource_limit","PDF text exceeds 500000 UTF16 units"));}let mut units=vec![0u16;count as usize+1];let n=t.b.FPDFText_GetText(t.raw,start,count,units.as_mut_ptr());if n<1||n as usize>units.len()||units[n as usize-1]!=0{return Err(native("PDF text is incomplete"));}units.truncate(n as usize-1);String::from_utf16(&units).map_err(|_|native("PDF text is invalid UTF16"))
}}
fn attributed(t:&Text<'_>,text:&str)->Result<Vec<Value>>{unsafe{
    let mut rows:Vec<Value>=Vec::new();for i in 0..text.encode_utf16().count(){let index=t.b.FPDFText_GetCharIndexFromTextIndex(t.raw,i as i32);let mut row=json!({"range":[i,1]});
        if index>=0{let mut flags=0;let n=t.b.FPDFText_GetFontInfo(t.raw,index,ptr::null_mut(),0,&mut flags)as usize;if n>4096{return Err(failure("resource_limit","PDF font name exceeds 4096 bytes"));}
            if n>1{let mut bytes=vec![0u8;n];if t.b.FPDFText_GetFontInfo(t.raw,index,bytes.as_mut_ptr().cast(),n as c_ulong,&mut flags)as usize!=n||bytes.pop()!=Some(0){return Err(native("PDF font name changed"));}let name=String::from_utf8(bytes).map_err(|_|native("PDF font name is not UTF8"))?;let size=t.b.FPDFText_GetFontSize(t.raw,index);if size.is_finite()&&size>0.0{row["font"]=json!({"name":name,"size":size});}}
            let(mut r,mut g,mut b,mut a)=(0,0,0,0);if t.b.FPDFText_GetFillColor(t.raw,index,&mut r,&mut g,&mut b,&mut a)!=0{if [r,g,b,a].iter().any(|n|*n>255){return Err(native("PDF font color is invalid"));}row["color"]=json!(format!("#{r:02x}{g:02x}{b:02x}"));}}
        if let Some(previous)=rows.last_mut(){if previous.get("font")==row.get("font")&&previous.get("color")==row.get("color"){previous["range"][1]=json!(previous["range"][1].as_u64().unwrap()+1);continue;}}
        if rows.len()>=4096{return Err(failure("resource_limit","PDF attributed text exceeds 4096 runs"));}rows.push(row);
    }Ok(rows)
}}
fn attributes(d:&Document<'_>)->Result<Value>{unsafe{
    let mut result=json!({});for tag in ["Title","Author","Subject","Keywords","Creator","Producer","CreationDate","ModDate"]{if let Some(value)=utf16(|p,n|d.b.FPDF_GetMetaText(d.raw,tag,p.cast(),n))?.filter(|s|!s.is_empty()){
        // Keep the native keyword string intact instead of guessing delimiters.
        result[tag]=if tag=="Keywords"{json!([value])}else{json!(if tag.ends_with("Date"){pdf_date(&value)?}else{value})};
    }}bounded(result)
}}
fn evaluate(a:&Value)->Result<Value>{unsafe{
    validate(a)?;let engine=Engine::load()?;let b=&*engine.b;let sub=a["sub"].as_str().unwrap();let path=a["path"].as_str().unwrap_or("");let out=a["out"].as_str().unwrap_or(path);
    if sub=="merge"{let raw=b.FPDF_CreateNewDocument();if raw.is_null(){return Err(native("PDF merge allocation failed"));}let mut count=0;let mut sources=Vec::new();
        let result=(||{for source in a["paths"].as_array().unwrap(){let d=Document::load(b,source.as_str().unwrap())?;d.require(1024)?;if count+d.count>4096{return Err(failure("resource_limit","PDF merge exceeds 4096 pages"));}if b.FPDF_ImportPagesByIndex_vec(raw,d.raw,(0..d.count).collect(),count)==0{return Err(native("PDF merge page import failed"));}count+=d.count;sources.extend(d.sources.clone());}Ok(())})();
        if let Err(error)=result{b.FPDF_CloseDocument(raw);return Err(error);}let mut d=Document::owned(b,raw,vec![])?;d.sources=sources;let reply=bounded(json!({"savedTo":out,"pageCount":d.count,"sources":a["paths"]}))?;d.save(out)?;return Ok(reply);
    }
    let d=Document::load(b,path)?;let encrypted=b.FPDF_GetSecurityHandlerRevision(d.raw)>=0;
    match sub{
        "info"=>Ok(json!({"path":path,"pageCount":d.count,"isLocked":false,"isEncrypted":encrypted,"allowsCopying":d.permission(16),"allowsPrinting":d.permission(4),"accessPermissions":d.rights(),"attributes":attributes(&d)?})),
        "permissions"=>Ok(json!({"path":path,"isLocked":false,"isEncrypted":encrypted,"allowsCopying":d.permission(16),"allowsPrinting":d.permission(4),"permissions":d.rights()})),
        "attributes"=>Ok(json!({"path":path,"attributes":attributes(&d)?})),
        "outline"=>Ok(json!({"path":path,"outline":outline(&d,ptr::null_mut(),&mut HashSet::new(),0)?})),
        "text"=>{d.require(16)?;let (lo,hi)=if let Some(page)=a["page"].as_f64(){page_range(&(page as i32).to_string(),d.count)?}else if let Some(range)=a["range"].as_str(){page_range(range,d.count)?}else{(1,d.count)};let mut pages=Vec::new();let mut combined=String::new();let mut total=0;
            for number in lo..=hi{let page=d.page(number)?;let text=page.text()?;let count=b.FPDFText_CountChars(text.raw);let value=text_value(&text,0,count)?;total+=unicode_segmentation::UnicodeSegmentation::graphemes(value.as_str(),true).count();let mut row=json!({"page":number,"characterCount":count,"text":value});if a["attributed"]==true{row["attributedString"]=json!(attributed(&text,row["text"].as_str().unwrap())?);}if !pages.is_empty(){combined.push('\n');}combined.push_str(row["text"].as_str().unwrap());if combined.len()>MAX_JSON{return Err(failure("resource_limit","PDF text exceeds 1 MiB"));}pages.push(row);}
            if pages.len()==1{let mut row=pages.pop().unwrap();row["path"]=json!(path);Ok(row)}else{Ok(json!({"path":path,"pageCount":d.count,"characterCount":total,"text":combined,"pages":pages}))}
        },
        "annotations"|"forms"|"images"=>{let mut rows=Vec::new();let mut image_pages=Vec::new();let mut total=0;let numbers=if let Some(page)=a["page"].as_f64(){let n=page as i32;d.page(n)?;vec![n]}else{(1..=d.count).collect()};
            for number in numbers{let page=d.page(number)?;let mut stamps=Vec::new();for i in 0..page.annotations()?{let annotation=page.annotation(i)?;let subtype=b.FPDFAnnot_GetSubtype(annotation.raw)as usize;let kind=*TYPES.get(subtype).ok_or_else(||native("PDF annotation subtype is invalid"))?;
                if sub=="forms"&&kind!="Widget"||sub=="images"&&kind!="Stamp"||a["annotation_type"].as_str().is_some_and(|s|s!=kind){continue;}total+=1;if total>4096{return Err(failure("resource_limit","PDF inventory exceeds 4096 annotations"));}let row=annotation_value(&d,&annotation,number,i)?;if sub=="images"{stamps.push(row);}else{rows.push(row);}}
                if sub=="images"{let(mut left,mut bottom,mut right,mut top)=(0f32,0f32,0f32,0f32);if b.FPDFPage_GetMediaBox(page.raw,&mut left,&mut bottom,&mut right,&mut top)==0{return Err(native("PDF page omitted its media box"));}let rotation=b.FPDFPage_GetRotation(page.raw);if !(0..=3).contains(&rotation){return Err(native("PDF page rotation is invalid"));}image_pages.push(json!({"page":number,"mediaBox":rect(left as f64,bottom as f64,right as f64,top as f64)?,"rotation":rotation*90,"stamps":stamps}));}}
            let mut result=json!({"path":path});result[match sub{"forms"=>"forms","images"=>"pages",_=>"annotations"}]=json!(if sub=="images"{image_pages}else{rows});Ok(result)
        },
        "find"=>{d.require(16)?;let query=a["query"].as_str().unwrap();let mut matches=Vec::new();for number in 1..=d.count{let page=d.page(number)?;let text=page.text()?;let raw=b.FPDFText_FindStart_str(text.raw,query,if a["case_sensitive"]==true{1}else{0},0);if raw.is_null(){return Err(native("PDF search allocation failed"));}let search=Search{b,raw};while b.FPDFText_FindNext(search.raw)!=0{if matches.len()>=4096{return Err(failure("resource_limit","PDF search exceeds 4096 matches"));}let index=b.FPDFText_GetSchResultIndex(search.raw);let count=b.FPDFText_GetSchCount(search.raw);if index<0||count<1{return Err(native("PDF search returned an invalid text span"));}let value=text_value(&text,index,count)?;let boxes=b.FPDFText_CountRects(text.raw,index,count);if boxes<1||boxes>4096{return Err(native("PDF search omitted its bounds"));}let(mut l,mut bottom,mut r,mut top)=(f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY);for i in 0..boxes{let(mut x,mut ytop,mut xright,mut y)=(0f64,0f64,0f64,0f64);if b.FPDFText_GetRect(text.raw,i,&mut x,&mut ytop,&mut xright,&mut y)==0{return Err(native("PDF search bounds could not be read"));}l=l.min(x);bottom=bottom.min(y);r=r.max(xright);top=top.max(ytop);}matches.push(json!({"page":number,"text":value,"bounds":rect(l,bottom,r,top)?}));}}Ok(json!({"path":path,"query":query,"matchCount":matches.len(),"matches":matches}))},
        "annotate"=>{d.require(32)?;let number=a["page"].as_f64().unwrap()as i32;let page=d.page(number)?;let kind=a["annotation_type"].as_str().unwrap_or("Highlight");let subtype=TYPES.iter().position(|s|*s==kind).ok_or_else(||invalid("unknown PDF annotation type"))? as i32;
            if b.FPDFAnnot_IsSupportedSubtype(subtype)==0{return Err(failure("unsupported_operation","PDFium cannot create the requested annotation subtype"));}let raw=b.FPDFPage_CreateAnnot(page.raw,subtype);if raw.is_null(){return Err(native("PDF annotation creation failed"));}let annotation=Annotation{b,raw};let [x,y,w,h]=rect_input(a["rect"].as_str().unwrap())?;let bounds=FS_RECTF{left:x,bottom:y,right:x+w,top:y+h};
            if b.FPDFAnnot_SetRect(raw,&bounds)==0||b.FPDFAnnot_SetColor(raw,0,255,255,0,128)==0{return Err(native("PDF annotation geometry or color could not be set"));}
            if [9,10,11,12].contains(&subtype){let quad=FS_QUADPOINTSF{x1:x,y1:y+h,x2:x+w,y2:y+h,x3:x,y3:y,x4:x+w,y4:y};if b.FPDFAnnot_AppendAttachmentPoints(raw,&quad)==0{return Err(native("PDF markup attachment points could not be set"));}}
            if let Some(contents)=a["contents"].as_str(){if b.FPDFAnnot_SetStringValue_str(raw,"Contents",contents)==0{return Err(native("PDF annotation contents could not be set"));}}let row=annotation_value(&d,&annotation,number,page.annotations()?-1)?;drop(annotation);drop(page);d.save(out)?;Ok(json!({"savedTo":out,"page":number,"annotation":row}))
        },
        "strip"=>{d.require(32)?;for number in 1..=d.count{let page=d.page(number)?;for i in (0..page.annotations()?).rev(){if b.FPDFPage_RemoveAnnot(page.raw,i)==0{return Err(native("PDF annotation removal failed"));}}}d.save(out)?;Ok(json!({"savedTo":out,"pageCount":d.count}))},
        "split"=>{d.require(1024)?;let(lo,hi)=page_range(a["pages"].as_str().unwrap(),d.count)?;let raw=b.FPDF_CreateNewDocument();if raw.is_null(){return Err(native("PDF split allocation failed"));}if b.FPDF_ImportPagesByIndex_vec(raw,d.raw,(lo-1..hi).collect(),0)==0{b.FPDF_CloseDocument(raw);return Err(native("PDF split page import failed"));}let mut result=Document::owned(b,raw,vec![])?;result.sources=d.sources.clone();result.save(out)?;Ok(json!({"savedTo":out,"pageCount":result.count,"source":path,"range":[lo,hi]}))},
        "forms_set"=>{d.require(256)?;let field=a["field"].as_str().unwrap();let value=a["value"].as_str().unwrap();let mut matches=0;
            for number in 1..=d.count{let page=d.page(number)?;for i in 0..page.annotations()?{let annotation=page.annotation(i)?;if b.FPDFAnnot_GetSubtype(annotation.raw)!=20{continue;}let name=utf16(|p,n|b.FPDFAnnot_GetFormFieldName(d.form,annotation.raw,p,n))?;if name.as_deref()!=Some(field){continue;}let row=annotation_value(&d,&annotation,number,i)?;if row["isReadOnly"]==true{return Err(failure("permission_denied","PDF form field is read only"));}let max=row["maximumLength"].as_u64().unwrap_or(0);if max>0&&value.encode_utf16().count()as u64>max{return Err(invalid("PDF form value exceeds its maximum length"));}
                let kind=b.FPDFAnnot_GetFormFieldType(d.form,annotation.raw);if !(2..=6).contains(&kind){return Err(failure("unsupported_target","push buttons, signatures and XFA widgets have no string-value editing operation"));}let current=utf16(|p,n|b.FPDFAnnot_GetFormFieldValue(d.form,annotation.raw,p,n))?.unwrap_or_default();
                if current==value{matches+=1;continue;}
                match kind{
                    6=>{if b.FORM_SetFocusedAnnot(d.form,annotation.raw)==0||b.FORM_SelectAllText(d.form,page.raw)==0{return Err(native("PDF text widget could not accept editing"));}let units=value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();b.FORM_ReplaceSelection(d.form,page.raw,units.as_ptr());},
                    4|5=>{
                        let values=row["values"].as_array().cloned().unwrap_or_default();let selected=values.iter().enumerate().filter(|(_,v)|v.as_str()==Some(value)).map(|(i,_)|i).collect::<Vec<_>>();
                        if b.FORM_SetFocusedAnnot(d.form,annotation.raw)==0{return Err(native("PDF choice widget could not accept editing"));}
                        if selected.is_empty()&&kind==4&&b.FPDFAnnot_GetFormFieldFlags(d.form,annotation.raw)&262144!=0{
                            if b.FORM_SelectAllText(d.form,page.raw)==0{return Err(native("PDF editable choice text could not be selected"));}let units=value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();b.FORM_ReplaceSelection(d.form,page.raw,units.as_ptr());
                        }else{
                            if selected.len()!=1{return Err(invalid("PDF choice value must name one unique export value"));}
                            if kind==5{for index in 0..values.len(){if b.FORM_SetIndexSelected(d.form,page.raw,index as i32,0)==0{return Err(native("PDF choice selection could not be cleared"));}}}
                            if b.FORM_SetIndexSelected(d.form,page.raw,selected[0]as i32,1)==0{return Err(native("PDF choice option could not be selected"));}
                        }
                    },
                    2|3=>{
                        let export=utf16(|p,n|b.FPDFAnnot_GetFormFieldExportValue(d.form,annotation.raw,p,n))?.ok_or_else(||native("PDF button omitted its export value"))?;
                        if value!=export&&value!="Off"{if kind==3{continue;}return Err(invalid("PDF button value requires its exact export value or Off"));}
                        if kind==3&&value=="Off"&&current!=export{continue;}
                        let bounds=&row["bounds"];let x=bounds["x"].as_f64().unwrap()+bounds["w"].as_f64().unwrap()/2.0;let y=bounds["y"].as_f64().unwrap()+bounds["h"].as_f64().unwrap()/2.0;
                        if b.FORM_OnLButtonDown(d.form,page.raw,0,x,y)==0||b.FORM_OnLButtonUp(d.form,page.raw,0,x,y)==0{return Err(native("PDF button widget could not accept its state change"));}
                    },
                    _=>return Err(failure("unsupported_target","push buttons, signatures and XFA widgets have no string-value editing operation")),
                }
                if b.FORM_ForceToKillFocus(d.form)==0{return Err(native("PDF widget edit did not commit"));}
                let changed=utf16(|p,n|b.FPDFAnnot_GetFormFieldValue(d.form,annotation.raw,p,n))?.unwrap_or_default();if changed!=value{return Err(native("PDF widget value differs from the requested value; destination was not changed"));}matches+=1;
            }}if matches==0{return Err(failure("target_gone","PDF form has no widget with the requested field name"));}d.save(out)?;Ok(json!({"savedTo":out,"fieldName":field,"newValue":value,"ok":true}))
        },
        _=>Err(invalid("unknown PDF operation"))
    }
}}
pub fn helper()->std::io::Result<()>{
    let bytes=crate::read_frame(&mut std::io::stdin().lock())?.ok_or_else(||std::io::Error::other("missing PDF helper request"))?;let a:Value=serde_json::from_slice(&bytes)?;
    let result=match crate::thumbnail_pdf::limit_memory().and_then(|_|evaluate(&a["action"])).and_then(bounded){Ok(data)=>success(data),Err(error)=>error};
    crate::write_frame(&mut std::io::stdout().lock(),&serde_json::to_vec(&result)?)
}
pub fn dispatch(a:&Value)->Value{
    if let Err(error)=validate(a){return error;}let _work=match WORK.try_lock(){Ok(lock)=>lock,Err(_)=>return failure("resource_limit","a PDF helper is already active; requests are not queued")};
    let mutating=["forms_set","annotate","strip","merge","split"].contains(&a["sub"].as_str().unwrap());
    crate::thumbnail::image_helper("--pdf-engine",&json!({"action":a,"save":mutating}),Instant::now()+Duration::from_secs(30)).map(success).unwrap_or_else(|error|error)
}
pub fn capability(session:&str)->Value{json!({"operation":"pdf","compiled":true,"present":true,"effective":false,"background":"semantic","permission":"not_applicable","session":session,"provider":"interceptor-desktop-rust","versions":{"contract":"1","bindings":"pdfium-render0.9.4","api":"7881"},"limits":["30s disposable helper; 512 MiB address-space/job limit; 64 MiB sources; 4096 pages/annotations; 1 MiB metadata; 6 MB saved documents.","String writes cover text, choice, checkbox and radio widgets. Push buttons, signatures and XFA are unsupported string-value targets.","Requires a pinned licensed bundled PDFium 7881 library or explicit library/hash configuration. Installed runtime and document qualification remain open."],"reason":"Source implementation is present; effective runtime qualification remains false. Missing or changed assets are refused by the actual loader."})}

#[cfg(test)]mod tests{use super::*;
    #[test]fn bounded_pdf_requests_preserve_empty_field_values_and_reject_cross_operation_fields(){
        assert_eq!(page_range("2-4",4).unwrap(),(2,4));for value in ["0","4-2","1-5","01","1-2-3","-1"]{assert!(page_range(value,4).is_err());}
        let path=std::env::temp_dir().join("interceptor-owned.pdf").to_string_lossy().into_owned();assert!(validate(&json!({"type":"desktop_pdf","sub":"forms_set","path":path,"field":"Name","value":""})).is_ok());
        assert!(validate(&json!({"type":"desktop_pdf","sub":"info","path":path,"out":path})).is_err());assert!(rect_input("0,0,100,50").is_ok());assert!(rect_input("0,0,NaN,50").is_err());assert!(rect_input("0,0,0,50").is_err());
        assert_eq!(pdf_date("D:20261007120000-05'00'").unwrap(),"2026-10-07T17:00:00Z");assert!(pdf_date("D:20260230").is_err());
    }
}
