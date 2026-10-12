use crate::{failure,clipboard::bounded};
use serde_json::{Value,json};
use base64::Engine;
use std::{cell::RefCell,time::{Duration,Instant}};
use windows::{core::{w,PCWSTR},Win32::{
    Foundation::{HANDLE,HGLOBAL,HWND,GlobalFree},
    System::{DataExchange::*,Memory::*,Com::{CoCreateInstance,CLSCTX_INPROC_SERVER,STATSTG,STATFLAG_NONAME,StructuredStorage::{CreateStreamOnHGlobal,GetHGlobalFromStream}}},
    Graphics::{Gdi::{HBITMAP,HPALETTE},Imaging::*},
    UI::{WindowsAndMessaging::*,Shell::{DragQueryFileW,HDROP}},
}};

struct HiddenWindow(HWND);
impl Drop for HiddenWindow {fn drop(&mut self){unsafe{let _=DestroyWindow(self.0);}}}
thread_local!{static WINDOW:RefCell<Option<HiddenWindow>>=const{RefCell::new(None)};}
struct Clipboard;
impl Drop for Clipboard {fn drop(&mut self){unsafe{let _=CloseClipboard();}}}
struct Locked(HGLOBAL,*mut core::ffi::c_void);
impl Locked {
    unsafe fn open(handle:HANDLE)->windows::core::Result<Self>{
        let handle=HGLOBAL(handle.0);let pointer=unsafe{GlobalLock(handle)};
        if pointer.is_null(){Err(windows::core::Error::from_thread())}else{Ok(Self(handle,pointer))}
    }
    unsafe fn bytes(&self)->windows::core::Result<&[u8]>{
        let size=unsafe{GlobalSize(self.0)};
        if size==0||size>crate::contract_generated::DESKTOP_MAX_RESULT_BYTES {return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8007007au32 as i32)));}
        Ok(unsafe{std::slice::from_raw_parts(self.1.cast(),size)})
    }
}
impl Drop for Locked {fn drop(&mut self){unsafe{let _=GlobalUnlock(self.0);}}}
unsafe fn open()->windows::core::Result<Clipboard>{
    WINDOW.with(|slot|{
        let mut slot=slot.borrow_mut();
        if slot.is_none(){*slot=Some(HiddenWindow(unsafe{CreateWindowExW(WINDOW_EX_STYLE(0),w!("STATIC"),w!("Interceptor clipboard"),WINDOW_STYLE(0),0,0,0,0,Some(HWND_MESSAGE),None,None,None)?}));}
        let hwnd=slot.as_ref().unwrap().0;let start=Instant::now();
        loop {match unsafe{OpenClipboard(Some(hwnd))}{Ok(())=>return Ok(Clipboard),Err(e)if start.elapsed()>=Duration::from_millis(300)=>return Err(e),Err(_)=>std::thread::sleep(Duration::from_millis(10))}}
    })
}
unsafe fn format(name:&str)->u32{let wide:Vec<u16>=name.encode_utf16().chain([0]).collect();unsafe{RegisterClipboardFormatW(PCWSTR(wide.as_ptr()))}}
unsafe fn types()->Vec<String>{
    let mut output=Vec::new();let mut previous=0;
    for _ in 0..4096 {
        let next=unsafe{EnumClipboardFormats(previous)};if next==0{break;}previous=next;
        let mut wide=[0_u16;256];let n=unsafe{GetClipboardFormatNameW(next,&mut wide)};
        output.push(if n>0{String::from_utf16_lossy(&wide[..n as usize])}else{match next{1=>"CF_TEXT".into(),2=>"CF_BITMAP".into(),8=>"CF_DIB".into(),13=>"CF_UNICODETEXT".into(),15=>"CF_HDROP".into(),17=>"CF_DIBV5".into(),_=>format!("CF_{next}")}});
    }
    output
}
unsafe fn text()->windows::core::Result<String>{
    let memory=unsafe{Locked::open(GetClipboardData(13)?)?};let bytes=unsafe{memory.bytes()?};
    if bytes.len()%2!=0{return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8007000du32 as i32)));}
    let units:Vec<u16>=bytes.chunks_exact(2).map(|b|u16::from_le_bytes([b[0],b[1]])).collect();
    let length=units.iter().position(|n|*n==0).ok_or_else(||windows::core::Error::from_hresult(windows::core::HRESULT(0x8007000du32 as i32)))?;
    String::from_utf16(&units[..length]).map_err(|_|windows::core::Error::from_hresult(windows::core::HRESULT(0x8007000du32 as i32)))
}
unsafe fn files()->windows::core::Result<Vec<String>>{
    let invalid=||windows::core::Error::from_hresult(windows::core::HRESULT(0x8007000du32 as i32));
    let limit=||windows::core::Error::from_hresult(windows::core::HRESULT(0x8007007au32 as i32));
    let handle=unsafe{GetClipboardData(15)?};let memory=unsafe{Locked::open(handle)?};let bytes=unsafe{memory.bytes()?};
    // Validate the DROPFILES header and bounded double-NUL list before asking
    // the Shell to interpret offsets or convert an ANSI clipboard code page.
    if bytes.len()<20{return Err(invalid());}
    let offset=u32::from_le_bytes(bytes[..4].try_into().unwrap())as usize;
    if offset<20||offset>=bytes.len(){return Err(invalid());}
    let wide=u32::from_le_bytes(bytes[16..20].try_into().unwrap())!=0;
    let payload=&bytes[offset..];let expected;
    if wide {
        if offset%2!=0||payload.len()%2!=0{return Err(invalid());}
        let units:Vec<u16>=payload.chunks_exact(2).map(|b|u16::from_le_bytes([b[0],b[1]])).collect();
        let end=units.windows(2).position(|u|u==[0,0]).ok_or_else(invalid)?;
        let names:Vec<&[u16]>=if end==0{Vec::new()}else{units[..end].split(|u|*u==0).collect()};
        if names.len()>4096||names.iter().any(|n|n.len()>32767){return Err(limit());}
        for name in &names{if name.is_empty()||String::from_utf16(name).is_err(){return Err(invalid());}}
        expected=names.len();
    }else{
        let end=payload.windows(2).position(|b|b==[0,0]).ok_or_else(invalid)?;
        let names:Vec<&[u8]>=if end==0{Vec::new()}else{payload[..end].split(|b|*b==0).collect()};
        if names.len()>4096||names.iter().any(|n|n.len()>32767){return Err(limit());}
        if names.iter().any(|n|n.is_empty()){return Err(invalid());}expected=names.len();
    }
    let drop=HDROP(handle.0);let count=unsafe{DragQueryFileW(drop,u32::MAX,None)};
    if count as usize!=expected{return Err(invalid());}
    let mut paths=Vec::with_capacity(expected);
    for index in 0..count{
        let n=unsafe{DragQueryFileW(drop,index,None)};
        if n==0{return Err(invalid());}if n>32767{return Err(limit());}
        let mut path=vec![0_u16;n as usize+1];let copied=unsafe{DragQueryFileW(drop,index,Some(&mut path))};
        if copied!=n||path[n as usize]!=0{return Err(invalid());}
        paths.push(String::from_utf16(&path[..n as usize]).map_err(|_|invalid())?);
    }
    Ok(paths)
}
fn png_length(bytes:&[u8])->Option<usize>{
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n"){return None;}let mut offset=8;
    while offset+12<=bytes.len(){let size=u32::from_be_bytes(bytes[offset..offset+4].try_into().ok()?)as usize;let end=offset.checked_add(12)?.checked_add(size)?;if end>bytes.len(){return None;}if &bytes[offset+4..offset+8]==b"IEND"{return (size==0).then_some(end);}offset=end;}None
}
unsafe fn validate_png(factory:&IWICImagingFactory,bytes:&[u8])->windows::core::Result<()> {
    let stream=unsafe{factory.CreateStream()?};
    unsafe{stream.InitializeFromMemory(bytes)?};
    let decoder=unsafe{factory.CreateDecoderFromStream(&stream,std::ptr::null(),WICDecodeMetadataCacheOnLoad)?};
    let frame=unsafe{decoder.GetFrame(0)?};let mut width=0;let mut height=0;
    unsafe{frame.GetSize(&mut width,&mut height)?};
    let stride=width.checked_mul(4).unwrap_or(u32::MAX);
    if width==0||height==0||u64::from(width)*u64::from(height)>40_000_000||stride as usize>crate::contract_generated::DESKTOP_MAX_RESULT_BYTES {
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8007007au32 as i32)));
    }
    let converted=unsafe{factory.CreateFormatConverter()?};
    unsafe{converted.Initialize(&frame,&GUID_WICPixelFormat32bppBGRA,WICBitmapDitherTypeNone,None,0.0,WICBitmapPaletteTypeCustom)?};
    // Decode every row. Metadata alone does not establish valid image bytes.
    // A bounded stripe avoids retaining an additional full decoded bitmap.
    let rows=(1_048_576/stride).max(1).min(height);
    let mut pixels=vec![0_u8;stride as usize*rows as usize];let mut y=0;
    while y<height {let n=rows.min(height-y);let rectangle=WICRect{X:0,Y:y as i32,Width:width as i32,Height:n as i32};
        unsafe{converted.CopyPixels(&rectangle,stride,&mut pixels[..stride as usize*n as usize])?};y+=n;
    }
    Ok(())
}
unsafe fn image()->windows::core::Result<Vec<u8>>{
    let png=unsafe{format("PNG")};
    let factory:IWICImagingFactory=unsafe{CoCreateInstance(&CLSID_WICImagingFactory,None,CLSCTX_INPROC_SERVER)?};
    if unsafe{IsClipboardFormatAvailable(png)}.is_ok(){
        let memory=unsafe{Locked::open(GetClipboardData(png)?)?};let bytes=unsafe{memory.bytes()?};
        if let Some(length)=png_length(bytes){unsafe{validate_png(&factory,&bytes[..length])?};return Ok(bytes[..length].to_vec());}
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8007000du32 as i32)));
    }
    let bitmap=unsafe{GetClipboardData(2)?};
    let source=unsafe{factory.CreateBitmapFromHBITMAP(HBITMAP(bitmap.0),HPALETTE::default(),WICBitmapIgnoreAlpha)?};
    let mut width=0;let mut height=0;unsafe{source.GetSize(&mut width,&mut height)?};
    if width==0||height==0||u64::from(width)*u64::from(height)>40_000_000{return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8007007au32 as i32)));}
    let stream=unsafe{CreateStreamOnHGlobal(HGLOBAL::default(),true)?};
    let encoder=unsafe{factory.CreateEncoder(&GUID_ContainerFormatPng,std::ptr::null())?};
    unsafe{encoder.Initialize(&stream,WICBitmapEncoderNoCache)?};
    let mut frame=None;let mut properties=None;unsafe{encoder.CreateNewFrame(&mut frame,&mut properties)?};
    let frame=frame.ok_or_else(windows::core::Error::from_thread)?;
    unsafe{frame.Initialize(properties.as_ref())?;frame.SetSize(width,height)?;let mut pixel=GUID_WICPixelFormat32bppBGRA;frame.SetPixelFormat(&mut pixel)?;frame.WriteSource(&source,std::ptr::null())?;frame.Commit()?;encoder.Commit()?;}
    let mut stat=STATSTG::default();unsafe{stream.Stat(&mut stat,STATFLAG_NONAME)?};
    if stat.cbSize>crate::contract_generated::DESKTOP_MAX_RESULT_BYTES as u64{return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x8007007au32 as i32)));}
    let handle=unsafe{GetHGlobalFromStream(&stream)?};let memory=unsafe{Locked::open(HANDLE(handle.0))?};let bytes=unsafe{memory.bytes()?};
    Ok(bytes[..stat.cbSize as usize].to_vec())
}
pub(crate) fn sequence()->u64{unsafe{GetClipboardSequenceNumber() as u64}}
pub fn execute(verb:&str,action:&Value)->Value{
    unsafe{
        let _clipboard=match open(){Ok(v)=>v,Err(e)=>return failure("provider_failed",format!("clipboard is unavailable or held by another process: {e}"))};
        if verb=="__clipboard_snapshot"{return bounded(json!({"changeCount":GetClipboardSequenceNumber(),"types":types(),"preview":crate::clipboard::preview(&text().unwrap_or_default())}));}
        match action["sub"].as_str().unwrap_or(""){
            "types"=>bounded(json!(types())),
            "clear"=>match EmptyClipboard(){Ok(())=>bounded(json!("ok")),Err(e)=>failure("provider_failed",e)},
            "write"=>{
                let text=action["text"].as_str().unwrap_or("");let wide:Vec<u16>=text.encode_utf16().chain([0]).collect();
                if wide.len()*2>crate::contract_generated::DESKTOP_MAX_RESULT_BYTES{return failure("resource_limit","clipboard text exceeds limit");}
                let memory=match GlobalAlloc(GMEM_MOVEABLE,wide.len()*2){Ok(v)=>v,Err(e)=>return failure("provider_failed",e)};
                let pointer=GlobalLock(memory);if pointer.is_null(){let _=GlobalFree(Some(memory));return failure("provider_failed","clipboard memory could not be locked");}
                std::ptr::copy_nonoverlapping(wide.as_ptr(),pointer.cast(),wide.len());let _=GlobalUnlock(memory);
                if let Err(e)=EmptyClipboard(){let _=GlobalFree(Some(memory));return failure("provider_failed",e);}
                match SetClipboardData(13,Some(HANDLE(memory.0))){Ok(_)=>bounded(json!("ok")),Err(e)=>{let _=GlobalFree(Some(memory));failure("partial_result",format!("clipboard cleared but text was not set: {e}; observe before retrying"))}}
            },
            "read"=>{
                let result:windows::core::Result<Value>=(||match action["contentType"].as_str().unwrap_or("text"){
                    "text"=>Ok(json!(text()?)),
                    "rtf"=>{let m=Locked::open(GetClipboardData(format("Rich Text Format"))?)?;let bytes=m.bytes()?;let length=bytes.iter().position(|b|*b==0).unwrap_or(bytes.len());Ok(json!(std::str::from_utf8(&bytes[..length]).map_err(|_|windows::core::Error::from_hresult(windows::core::HRESULT(0x8007000du32 as i32)))?))},
                    "image"=>Ok(json!(format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(image()?)))),
                    "files"=>Ok(json!(files()?)),
                    _=>unreachable!(),
                })();
                match result{Ok(data)=>bounded(data),Err(e)if e.code().0==0x8007007au32 as i32=>failure("resource_limit","clipboard format exceeds limit"),Err(e)=>failure("unsupported_target",format!("requested clipboard format is absent or invalid: {e}"))}
            },
            _=>failure("invalid_request","unknown clipboard subcommand"),
        }
    }
}
