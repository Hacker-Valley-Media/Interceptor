use crate::failure;
#[cfg(windows)]use crate::contract_generated::DESKTOP_MAX_RESULT_BYTES;
use image::RgbaImage;
use serde_json::Value;

pub fn dimensions(width:f64,height:f64,bounds:(u32,u32))->Result<(u32,u32),Value>{
    if !width.is_finite()||!height.is_finite()||width<=0.0||height<=0.0{
        return Err(failure("unsupported_target","PDF page has invalid dimensions"));
    }
    let scale=(bounds.0 as f64/width).min(bounds.1 as f64/height);
    if !scale.is_finite()||scale<=0.0{return Err(failure("unsupported_target","PDF page scale is invalid"));}
    let size=((width*scale).round().max(1.0).min(bounds.0 as f64)as u32,
              (height*scale).round().max(1.0).min(bounds.1 as f64)as u32);
    crate::capture::pixel_size(size.0,size.1)?;
    Ok(size)
}

// Applied only inside the disposable PDF helper, never to the shared provider.
pub fn limit_memory()->Result<(),Value>{
    #[cfg(unix)]{
        let limit=libc::rlimit{rlim_cur:512*1024*1024,rlim_max:512*1024*1024};
        if unsafe{libc::setrlimit(libc::RLIMIT_AS,&limit)}!=0{return Err(failure("provider_failed","PDF helper memory limit could not be applied"));}
    }
    #[cfg(windows)]unsafe{
        use windows::Win32::{Foundation::CloseHandle,System::{JobObjects::*,Threading::GetCurrentProcess}};
        let job=CreateJobObjectW(None,None).map_err(|_|failure("provider_failed","PDF helper job could not be created"))?;
        let mut limits=JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.ProcessMemoryLimit=512*1024*1024;
        let result=SetInformationJobObject(job,JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),std::mem::size_of_val(&limits)as u32)
            .and_then(|_|AssignProcessToJobObject(job,GetCurrentProcess()));
        // The process retains its job association and limit until it exits.
        let _=CloseHandle(job);
        result.map_err(|_|failure("provider_failed","PDF helper memory limit could not be applied"))?;
    }
    Ok(())
}

#[cfg(windows)]
pub fn render(bytes:&[u8],bounds:(u32,u32))->Result<RgbaImage,Value>{
    use windows::{Data::Pdf::{PdfDocument,PdfPageRenderOptions},Storage::Streams::{DataReader,DataWriter,InMemoryRandomAccessStream},Win32::System::WinRT::{RoInitialize,RoUninitialize,RO_INIT_MULTITHREADED}};
    let native_error=|error:windows::core::Error|failure(match error.code().0 as u32{
        0x8007052b|0x80070005=>"permission_denied",
        0x80040154=>"unsupported_operation",
        _=>"unsupported_target",
    },format!("Windows PDF renderer refused the source (HRESULT {:08x}); no document pixels were returned",error.code().0 as u32));
    unsafe{RoInitialize(RO_INIT_MULTITHREADED)}.map_err(native_error)?;
    let result=(||->windows::core::Result<Result<RgbaImage,Value>>{
        let input=InMemoryRandomAccessStream::new()?;
        let writer=DataWriter::CreateDataWriter(&input.GetOutputStreamAt(0)?)?;
        writer.WriteBytes(bytes)?;writer.StoreAsync()?.join()?;writer.DetachStream()?;
        let document=PdfDocument::LoadFromStreamAsync(&input)?.join()?;
        if document.PageCount()?==0{return Ok(Err(failure("unsupported_target","PDF source has no pages")));}
        let page=document.GetPage(0)?;
        let rendered=(||->windows::core::Result<Result<RgbaImage,Value>>{
            let original=page.Size()?;
            let (width,height)=match dimensions(original.Width as f64,original.Height as f64,bounds){Ok(size)=>size,Err(error)=>return Ok(Err(error))};
            let options=PdfPageRenderOptions::new()?;options.SetDestinationWidth(width)?;options.SetDestinationHeight(height)?;
            let output=InMemoryRandomAccessStream::new()?;
            page.RenderWithOptionsToStreamAsync(&output,&options)?.join()?;
            let count=output.Size()?;
            if count==0||count>DESKTOP_MAX_RESULT_BYTES as u64{return Ok(Err(failure("resource_limit","PDF render exceeds the image byte bound")));}
            let reader=DataReader::CreateDataReader(&output.GetInputStreamAt(0)?)?;
            if reader.LoadAsync(count as u32)?.join()?!=count as u32{return Ok(Err(failure("provider_failed","PDF render stream was incomplete")));}
            let mut bytes=vec![0u8;count as usize];reader.ReadBytes(&mut bytes)?;
            let pixels=match image::load_from_memory(&bytes){Ok(image)=>image.to_rgba8(),Err(_)=>return Ok(Err(failure("provider_failed","Windows PDF render was not a readable image")))};
            if pixels.dimensions()!=(width,height){return Ok(Err(failure("provider_failed","Windows PDF render dimensions differ from the requested page bounds")));}
            Ok(Ok(pixels))
        })();
        let _=page.Close();rendered
    })();
    unsafe{RoUninitialize();}
    result.map_err(native_error)?
}

#[cfg(target_os="linux")]
pub fn render(bytes:&[u8],bounds:(u32,u32))->Result<RgbaImage,Value>{unsafe{
    use std::{ffi::{c_char,c_int,c_void},ptr};
    type Raw=*mut c_void;
    #[repr(C)]struct GError{domain:u32,code:c_int,message:*mut c_char}
    struct Library(Raw);impl Drop for Library{fn drop(&mut self){unsafe{libc::dlclose(self.0);}}}
    let library=libc::dlopen(c"libpoppler-glib.so.8".as_ptr(),libc::RTLD_NOW|libc::RTLD_LOCAL);
    if library.is_null(){return Err(failure("unsupported_operation","PDF thumbnails require the Poppler GLib runtime (libpoppler-glib.so.8)"));}
    let _library=Library(library);
    macro_rules! symbol{($name:literal,$type:ty)=>{{
        let raw=libc::dlsym(library,concat!($name,"\0").as_ptr().cast());
        if raw.is_null(){return Err(failure("unsupported_operation",concat!("PDF runtime is missing ",$name)));}
        std::mem::transmute::<Raw,$type>(raw)
    }}}
    let new_bytes=symbol!("g_bytes_new",unsafe extern "C" fn(*const u8,usize)->Raw);
    let unref_bytes=symbol!("g_bytes_unref",unsafe extern "C" fn(Raw));
    let unref=symbol!("g_object_unref",unsafe extern "C" fn(Raw));
    let error_free=symbol!("g_error_free",unsafe extern "C" fn(*mut GError));
    let load=symbol!("poppler_document_new_from_bytes",unsafe extern "C" fn(Raw,*const c_char,*mut *mut GError)->Raw);
    let get_page=symbol!("poppler_document_get_page",unsafe extern "C" fn(Raw,c_int)->Raw);
    let page_size=symbol!("poppler_page_get_size",unsafe extern "C" fn(Raw,*mut f64,*mut f64));
    let page_render=symbol!("poppler_page_render",unsafe extern "C" fn(Raw,Raw));
    let surface_new=symbol!("cairo_image_surface_create",unsafe extern "C" fn(c_int,c_int,c_int)->Raw);
    let surface_status=symbol!("cairo_surface_status",unsafe extern "C" fn(Raw)->c_int);
    let surface_flush=symbol!("cairo_surface_flush",unsafe extern "C" fn(Raw));
    let surface_destroy=symbol!("cairo_surface_destroy",unsafe extern "C" fn(Raw));
    let image_data=symbol!("cairo_image_surface_get_data",unsafe extern "C" fn(Raw)->*mut u8);
    let image_stride=symbol!("cairo_image_surface_get_stride",unsafe extern "C" fn(Raw)->c_int);
    let create=symbol!("cairo_create",unsafe extern "C" fn(Raw)->Raw);
    let status=symbol!("cairo_status",unsafe extern "C" fn(Raw)->c_int);
    let destroy=symbol!("cairo_destroy",unsafe extern "C" fn(Raw));
    let rgb=symbol!("cairo_set_source_rgb",unsafe extern "C" fn(Raw,f64,f64,f64));
    let paint=symbol!("cairo_paint",unsafe extern "C" fn(Raw));
    let scale=symbol!("cairo_scale",unsafe extern "C" fn(Raw,f64,f64));
    let data=new_bytes(bytes.as_ptr(),bytes.len());
    if data.is_null(){return Err(failure("resource_limit","PDF source allocation failed"));}
    let mut error=ptr::null_mut();let document=load(data,ptr::null(),&mut error);
    if document.is_null(){
        let encrypted=!error.is_null()&&(*error).code==1;
        if !error.is_null(){error_free(error);}unref_bytes(data);
        return Err(failure(if encrypted{"permission_denied"}else{"unsupported_target"},"Poppler refused the PDF source; no document pixels were returned"));
    }
    if !error.is_null(){error_free(error);}
    let page=get_page(document,0);
    let result=if page.is_null(){Err(failure("unsupported_target","PDF source has no first page"))}else{( ||{
        let mut original_width=0.0;let mut original_height=0.0;page_size(page,&mut original_width,&mut original_height);
        let (width,height)=dimensions(original_width,original_height,bounds)?;
        let surface=surface_new(0,width as c_int,height as c_int); // CAIRO_FORMAT_ARGB32
        if surface.is_null(){return Err(failure("resource_limit","PDF image allocation failed"));}
        let context=create(surface);
        let result=(||{
            if context.is_null()||surface_status(surface)!=0||status(context)!=0{return Err(failure("resource_limit","PDF image allocation failed"));}
            rgb(context,1.0,1.0,1.0);paint(context);scale(context,width as f64/original_width,height as f64/original_height);
            page_render(page,context);surface_flush(surface);
            if status(context)!=0||surface_status(surface)!=0{return Err(failure("provider_failed","Poppler could not render the PDF page"));}
            let pixels=image_data(surface);let stride=image_stride(surface);
            if pixels.is_null()||stride<width as c_int*4{return Err(failure("provider_failed","PDF image storage is invalid"));}
            let mut output=RgbaImage::new(width,height);
            for y in 0..height{for x in 0..width{
                let address=pixels.add(y as usize*stride as usize+x as usize*4);
                let argb=u32::from_ne_bytes(ptr::read_unaligned(address.cast::<[u8;4]>()));
                output.put_pixel(x,y,image::Rgba([(argb>>16)as u8,(argb>>8)as u8,argb as u8,(argb>>24)as u8]));
            }}
            Ok(output)
        })();
        if !context.is_null(){destroy(context);}surface_destroy(surface);result
    })()};
    if !page.is_null(){unref(page);}unref(document);unref_bytes(data);result
}}

#[cfg(not(any(windows,target_os="linux")))]
pub fn render(_bytes:&[u8],_bounds:(u32,u32))->Result<RgbaImage,Value>{Err(failure("unsupported_operation","macOS uses QuickLook in its signed bridge"))}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn vector_page_bounds_preserve_orientation_and_reject_invalid_sizes(){
        assert_eq!(dimensions(200.0,100.0,(256,192)).unwrap(),(256,128));
        assert_eq!(dimensions(100.0,200.0,(256,192)).unwrap(),(96,192));
        for size in [(0.0,1.0),(f64::NAN,1.0),(1.0,f64::INFINITY),(-1.0,1.0)]{assert!(dimensions(size.0,size.1,(256,192)).is_err());}
    }
}
