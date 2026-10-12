//! `thumbnail --types icon`: the file's icon as the desktop shows it. Windows asks the shell
//! (IShellItemImageFactory, icon only); Linux takes the GIO content-type icon names, finds them
//! in the icon theme and renders them with gdk-pixbuf (SVG through librsvg).
use crate::failure;
use serde_json::Value;
use std::path::Path;
type Result<T>=std::result::Result<T,Value>;

#[cfg(windows)]
pub(crate) fn file_icon(path:&Path,edge:u32)->Result<image::RgbaImage>{
    use std::os::windows::ffi::OsStrExt;
    let wide:Vec<u16>=path.as_os_str().encode_wide().chain([0]).collect();
    // Shell items want a single-threaded apartment; the provider's own threads may be multithreaded.
    std::thread::spawn(move||unsafe{
        use windows::{core::PCWSTR,Win32::{Foundation::SIZE,Graphics::Gdi::*,System::Com::{CoInitializeEx,CoUninitialize,COINIT_APARTMENTTHREADED},UI::Shell::*}};
        let error=|e:windows::core::Error|failure("provider_failed",format!("Windows shell icon failed: {e}"));
        CoInitializeEx(None,COINIT_APARTMENTTHREADED).ok().map_err(error)?;
        struct Apartment;impl Drop for Apartment{fn drop(&mut self){unsafe{CoUninitialize();}}}let _apartment=Apartment;
        let factory:IShellItemImageFactory=SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()),None).map_err(|_|failure("target_gone","icon source is unavailable"))?;
        let bitmap=factory.GetImage(SIZE{cx:edge as i32,cy:edge as i32},SIIGBF_ICONONLY|SIIGBF_BIGGERSIZEOK).map_err(error)?;
        struct Bitmap(HBITMAP);impl Drop for Bitmap{fn drop(&mut self){unsafe{let _=DeleteObject(self.0.into());}}}let bitmap=Bitmap(bitmap);
        let mut info=BITMAP::default();
        if GetObjectW(bitmap.0.into(),std::mem::size_of::<BITMAP>()as i32,Some((&mut info as *mut BITMAP).cast()))==0||info.bmWidth<=0||info.bmHeight<=0{return Err(failure("provider_failed","Windows shell icon has no pixels"));}
        let(width,height)=(info.bmWidth as u32,info.bmHeight as u32);
        let mut header=BITMAPINFO{bmiHeader:BITMAPINFOHEADER{biSize:std::mem::size_of::<BITMAPINFOHEADER>()as u32,biWidth:width as i32,biHeight:-(height as i32),biPlanes:1,biBitCount:32,biCompression:BI_RGB.0,..Default::default()},..Default::default()};
        let mut bgra=vec![0u8;width as usize*height as usize*4];
        let dc=GetDC(None);
        let rows=GetDIBits(dc,bitmap.0,0,height,Some(bgra.as_mut_ptr().cast()),&mut header,DIB_RGB_COLORS);
        ReleaseDC(None,dc);
        if rows!=height as i32{return Err(failure("provider_failed","Windows shell icon pixels were not readable"));}
        // Premultiplied BGRA to straight RGBA.
        let mut rgba=Vec::with_capacity(bgra.len());
        for p in bgra.chunks_exact(4){let a=p[3];let un=|c:u8|if a==0{0}else{((c as u16*255+a as u16/2)/a as u16).min(255)as u8};rgba.extend([un(p[2]),un(p[1]),un(p[0]),a]);}
        image::RgbaImage::from_raw(width,height,rgba).ok_or_else(||failure("provider_failed","Windows shell icon size is inconsistent"))
    }).join().map_err(|_|failure("provider_failed","Windows shell icon thread failed"))?
}

#[cfg(target_os="linux")]
pub(crate) fn file_icon(path:&Path,edge:u32)->Result<image::RgbaImage>{unsafe{
    use std::ffi::{CStr,CString,c_char,c_int,c_void};
    use crate::native_library::{Library,system_library};
    let gio=Library::load(&system_library("INTERCEPTOR_GIO_LIBRARY","libgio-2.0","glib2")?)?;
    let pixbuf=Library::load(&system_library("INTERCEPTOR_GDK_PIXBUF_LIBRARY","libgdk_pixbuf-2.0","gdk-pixbuf2")?)?;
    let gobject=Library::load(&system_library("INTERCEPTOR_GOBJECT_LIBRARY","libgobject-2.0","glib2")?)?;
    macro_rules! f{($lib:expr,$name:literal,$type:ty)=>{std::mem::transmute::<*mut c_void,$type>($lib.symbol(CStr::from_bytes_with_nul(concat!($name,"\0").as_bytes()).unwrap())?)}}
    let guess=f!(gio,"g_content_type_guess",unsafe extern "C" fn(*const c_char,*const u8,usize,*mut c_int)->*mut c_char);
    let get_icon=f!(gio,"g_content_type_get_icon",unsafe extern "C" fn(*const c_char)->*mut c_void);
    let generic=f!(gio,"g_content_type_get_generic_icon_name",unsafe extern "C" fn(*const c_char)->*mut c_char);
    let names=f!(gio,"g_themed_icon_get_names",unsafe extern "C" fn(*mut c_void)->*const *const c_char);
    let unref=f!(gobject,"g_object_unref",unsafe extern "C" fn(*mut c_void));
    let g_free=f!(gio,"g_free",unsafe extern "C" fn(*mut c_void));
    // Content type from the name and the first bytes, as file managers do.
    let directory=path.is_dir();
    // O_NONBLOCK: opening a FIFO for its first bytes must not wait for a writer.
    let head=if directory{vec![]}else{
        let mut file={use std::os::unix::fs::OpenOptionsExt;std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK|libc::O_CLOEXEC).open(path)}.map_err(|_|failure("target_gone","icon source is unavailable"))?;
        if !file.metadata().is_ok_and(|m|m.is_file()){return Err(failure("unsupported_target","icon source must be a regular file or directory"));}
        let mut b=vec![0u8;4096];let n=std::io::Read::read(&mut file,&mut b).unwrap_or(0);b.truncate(n);b};
    let name=CString::new(path.to_string_lossy().as_bytes()).map_err(|_|failure("invalid_request","icon path is invalid"))?;
    let kind=if directory{CString::new("inode/directory").unwrap()}else{let raw=guess(name.as_ptr(),head.as_ptr(),head.len(),std::ptr::null_mut());if raw.is_null(){CString::new("application/octet-stream").unwrap()}else{let s=CStr::from_ptr(raw).to_owned();g_free(raw.cast());s}};
    let mut wanted:Vec<String>=vec![];
    let icon=get_icon(kind.as_ptr());
    if !icon.is_null(){let list=names(icon);if !list.is_null(){let mut i=0;while !(*list.add(i)).is_null(){wanted.push(CStr::from_ptr(*list.add(i)).to_string_lossy().into_owned());i+=1;}}unref(icon);}
    let raw=generic(kind.as_ptr());if !raw.is_null(){wanted.push(CStr::from_ptr(raw).to_string_lossy().into_owned());g_free(raw.cast());}
    wanted.extend(["text-x-generic","application-x-generic"].map(String::from));
    wanted.retain(|n|!n.ends_with("-symbolic"));
    let file=lookup(&wanted,edge).ok_or_else(||failure("not_installed",format!("no icon theme provides {} (install an icon theme such as adwaita-icon-theme)",wanted.first().map_or("a file icon",String::as_str))))?;
    let load=f!(pixbuf,"gdk_pixbuf_new_from_file_at_scale",unsafe extern "C" fn(*const c_char,c_int,c_int,c_int,*mut *mut c_void)->*mut c_void);
    let(w,h,stride,channels,alpha,pixels)=(f!(pixbuf,"gdk_pixbuf_get_width",unsafe extern "C" fn(*mut c_void)->c_int),f!(pixbuf,"gdk_pixbuf_get_height",unsafe extern "C" fn(*mut c_void)->c_int),f!(pixbuf,"gdk_pixbuf_get_rowstride",unsafe extern "C" fn(*mut c_void)->c_int),f!(pixbuf,"gdk_pixbuf_get_n_channels",unsafe extern "C" fn(*mut c_void)->c_int),f!(pixbuf,"gdk_pixbuf_get_has_alpha",unsafe extern "C" fn(*mut c_void)->c_int),f!(pixbuf,"gdk_pixbuf_get_pixels",unsafe extern "C" fn(*mut c_void)->*const u8));
    let file_name=CString::new(file.to_string_lossy().as_bytes()).unwrap();
    let mut error=std::ptr::null_mut();
    let image=load(file_name.as_ptr(),edge as c_int,edge as c_int,1,&mut error);
    if image.is_null(){return Err(failure("provider_failed",format!("gdk-pixbuf could not render {}",file.display())));}
    struct Owned(*mut c_void,unsafe extern "C" fn(*mut c_void));impl Drop for Owned{fn drop(&mut self){unsafe{(self.1)(self.0);}}}let image=Owned(image,unref);
    let(width,height,stride,channels,alpha)=(w(image.0)as u32,h(image.0)as u32,stride(image.0)as usize,channels(image.0)as usize,alpha(image.0)!=0);
    if width==0||height==0||!(3..=4).contains(&channels){return Err(failure("provider_failed","rendered icon has an unsupported pixel layout"));}
    let base=pixels(image.0);let mut rgba=Vec::with_capacity(width as usize*height as usize*4);
    for y in 0..height as usize{let row=std::slice::from_raw_parts(base.add(y*stride),width as usize*channels);for p in row.chunks_exact(channels){rgba.extend([p[0],p[1],p[2],if alpha{p[3]}else{255}]);}}
    image::RgbaImage::from_raw(width,height,rgba).ok_or_else(||failure("provider_failed","rendered icon size is inconsistent"))
}}

/// Freedesktop icon-theme lookup, simplified: the first theme and name with a scalable icon or
/// the smallest raster at least `edge` pixels (else the largest) wins.
#[cfg(target_os="linux")]
fn lookup(names:&[String],edge:u32)->Option<std::path::PathBuf>{
    let home=std::env::var("HOME").unwrap_or_default();
    let data=std::env::var("XDG_DATA_DIRS").ok().filter(|s|!s.is_empty()).unwrap_or("/usr/local/share:/usr/share".into());
    let mut bases=vec![format!("{home}/.local/share/icons"),format!("{home}/.icons")];bases.extend(data.split(':').map(|d|format!("{d}/icons")));
    let configured=std::process::Command::new("gsettings").args(["get","org.gnome.desktop.interface","icon-theme"]).output().ok().map(|o|String::from_utf8_lossy(&o.stdout).trim().trim_matches('\'').to_owned()).filter(|s|!s.is_empty());
    let themes:Vec<String>=configured.into_iter().chain(["Adwaita","AdwaitaLegacy","hicolor"].map(String::from)).collect();
    for name in names{for theme in &themes{
        let mut best:Option<(u32,std::path::PathBuf)>=None;
        for base in &bases{
            let root=Path::new(base).join(theme);let Ok(sizes)=std::fs::read_dir(&root)else{continue};
            for size in sizes.flatten(){
                let label=size.file_name().to_string_lossy().into_owned();
                let px=if label=="scalable"{u32::MAX}else{label.split(['x','@']).next().and_then(|n|n.parse().ok()).unwrap_or(0)};
                let Ok(contexts)=std::fs::read_dir(size.path())else{continue};
                for context in contexts.flatten(){for ext in ["svg","png"]{
                    let file=context.path().join(format!("{name}.{ext}"));
                    if !file.is_file(){continue;}
                    let rank=if px>=edge{px-edge}else{u32::MAX/2+(edge-px)};
                    if best.as_ref().is_none_or(|(r,_)|rank<*r){best=Some((rank,file));}
                }}
            }
        }
        if let Some((_,file))=best{return Some(file);}
    }}
    names.iter().map(|n|Path::new("/usr/share/pixmaps").join(format!("{n}.png"))).find(|p|p.is_file())
}
