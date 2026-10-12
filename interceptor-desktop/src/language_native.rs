//! `nlp language` through the operating system: Windows Extended Linguistic Services
//! (Microsoft Language Detection) and Linux libexttextcat. Both rank languages by
//! relevance without a score, so every hypothesis carries confidence null.
use crate::failure;
use serde_json::{Value,json};
type Result<T>=std::result::Result<T,Value>;

fn detection(ranked:Vec<String>,valid:impl Fn(&str)->bool)->Result<Value>{
    let ranked:Vec<String>=ranked.into_iter().filter(|tag|valid(tag)).take(5).collect();
    let dominant=ranked.first().cloned().ok_or_else(||failure("provider_failed","could not detect language"))?;
    Ok(json!({"dominant":dominant,"hypotheses":ranked.iter().map(|tag|json!({"language":tag,"confidence":Value::Null})).collect::<Vec<_>>()}))
}

#[cfg(windows)]
pub(crate) fn detect(text:&str,valid:impl Fn(&str)->bool)->Result<Value>{unsafe{
    use windows::{core::GUID,Win32::Globalization::*};
    // ELS_GUID_LANGUAGE_DETECTION (elssrvc.h): win32/desktop-src/Intl/microsoft-language-detection.md
    let mut guid=GUID::from_u128(0xCF7E00B1_909B_4D95_A8F4_611F7C377702);
    let options=MAPPING_ENUM_OPTIONS{Size:std::mem::size_of::<MAPPING_ENUM_OPTIONS>(),pGuid:&mut guid,..Default::default()};
    let mut services:*mut MAPPING_SERVICE_INFO=std::ptr::null_mut();let mut count=0u32;
    MappingGetServices(Some(&options),&mut services,&mut count).map_err(|e|failure("not_installed",format!("Windows language detection service is unavailable: {e}")))?;
    struct Services(*mut MAPPING_SERVICE_INFO);impl Drop for Services{fn drop(&mut self){unsafe{let _=MappingFreeServices(self.0);}}}
    let services=Services(services);if count==0{return Err(failure("not_installed","Windows language detection service is unavailable"));}
    let wide:Vec<u16>=text.encode_utf16().collect();
    let mut bag=MAPPING_PROPERTY_BAG{Size:std::mem::size_of::<MAPPING_PROPERTY_BAG>(),..Default::default()};
    MappingRecognizeText(services.0,&wide,0,None,&mut bag).map_err(|e|failure("provider_failed",format!("Windows language detection failed: {e}")))?;
    struct Bag(MAPPING_PROPERTY_BAG);impl Drop for Bag{fn drop(&mut self){unsafe{let _=MappingFreePropertyBag(&self.0);}}}
    let bag=Bag(bag);
    if bag.0.dwRangesCount==0||bag.0.prgResultRanges.is_null(){return Err(failure("provider_failed","could not detect language"));}
    // A double-null-terminated UTF-16 list sorted by relevance.
    let range=&*bag.0.prgResultRanges;
    let units=std::slice::from_raw_parts(range.pData as *const u16,range.dwDataSize as usize/2);
    let ranked=units.split(|u|*u==0).filter(|s|!s.is_empty()).map(String::from_utf16_lossy).collect();
    detection(ranked,valid)
}}

#[cfg(target_os="linux")]
pub(crate) fn detect(text:&str,valid:impl Fn(&str)->bool)->Result<Value>{unsafe{
    use std::ffi::{CStr,c_char,c_void};
    let path=crate::native_library::system_library("INTERCEPTOR_TEXTCAT_LIBRARY","libexttextcat-2.0","libexttextcat")?;
    let library=crate::native_library::Library::load(&path)?;
    let init=std::mem::transmute::<*mut c_void,unsafe extern "C" fn(*const c_char,*const c_char)->*mut c_void>(library.symbol(c"special_textcat_Init")?);
    let classify=std::mem::transmute::<*mut c_void,unsafe extern "C" fn(*mut c_void,*const c_char,usize)->*const c_char>(library.symbol(c"textcat_Classify")?);
    let done=std::mem::transmute::<*mut c_void,unsafe extern "C" fn(*mut c_void)>(library.symbol(c"textcat_Done")?);
    let root=["/usr/share/libexttextcat","/usr/local/share/libexttextcat"].into_iter().find(|d|std::path::Path::new(d).join("fpdb.conf").is_file())
        .ok_or_else(||failure("not_installed","libexttextcat language profiles are missing; reinstall libexttextcat"))?;
    let conf=std::ffi::CString::new(format!("{root}/fpdb.conf")).unwrap();let prefix=std::ffi::CString::new(format!("{root}/")).unwrap();
    let handle=init(conf.as_ptr(),prefix.as_ptr());if handle.is_null(){return Err(failure("provider_failed","libexttextcat did not load its language profiles"));}
    struct Handle(*mut c_void,unsafe extern "C" fn(*mut c_void));impl Drop for Handle{fn drop(&mut self){unsafe{(self.1)(self.0);}}}
    let handle=Handle(handle,done);
    let raw=classify(handle.0,text.as_ptr().cast(),text.len());
    let answer=if raw.is_null(){String::new()}else{CStr::from_ptr(raw).to_string_lossy().into_owned()};
    // "[fr][it]" in relevance order; "SHORT" and "UNKNOWN" mean no answer.
    // Each guess is "lang[-country]-encoding" (e.g. "fr--utf8"); the BCP47 tag is the first segment.
    let ranked:Vec<String>=answer.split(['[',']']).filter(|s|!s.trim().is_empty()&&!s.contains(',')).filter_map(|s|s.split('-').next().filter(|t|!t.is_empty()).map(str::to_owned)).collect();
    if ranked.is_empty(){return Err(failure("provider_failed",if answer=="SHORT"{"text is too short to detect its language"}else{"could not detect language"}));}
    detection(ranked,valid)
}}
