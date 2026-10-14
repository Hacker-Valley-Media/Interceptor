use crate::failure;
use serde_json::Value;
use image::RgbaImage;
use windows::{core::{Interface,BOOL},Graphics::{Capture::{GraphicsCaptureItem,GraphicsCaptureSession,Direct3D11CaptureFramePool},DirectX::{DirectXPixelFormat,Direct3D11::IDirect3DDevice}},Win32::{
    Foundation::{HANDLE,HWND,HMODULE,LPARAM,RECT,CloseHandle,WAIT_TIMEOUT},
    Graphics::{Direct3D::{D3D_DRIVER_TYPE_HARDWARE,D3D_DRIVER_TYPE_WARP},Direct3D11::*,Dxgi::IDXGIDevice,Gdi::{EnumDisplayMonitors,HDC,HMONITOR}},
    System::{Threading::{OpenProcess,PROCESS_QUERY_LIMITED_INFORMATION,PROCESS_SYNCHRONIZE,WaitForSingleObject},WinRT::{Graphics::Capture::IGraphicsCaptureItemInterop,Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice,IDirect3DDxgiInterfaceAccess}}},
    UI::WindowsAndMessaging::{GetWindowThreadProcessId,IsWindow,IsIconic,GetWindowDisplayAffinity}
}};
struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle{fn drop(&mut self){unsafe{let _=CloseHandle(self.0);}}}
struct WindowIdentity{hwnd:HWND,pid:u32,process:OwnedHandle}
pub struct Source{pool:Direct3D11CaptureFramePool,session:GraphicsCaptureSession,device:ID3D11Device,winrt:IDirect3DDevice,context:ID3D11DeviceContext,window:Option<WindowIdentity>,size:windows::Graphics::SizeInt32}
impl Drop for Source{fn drop(&mut self){let _=self.session.Close();let _=self.pool.Close();}}
unsafe extern "system" fn monitor_callback(monitor:HMONITOR,_:HDC,_:*mut RECT,arg:LPARAM)->BOOL{
    unsafe{(*(arg.0 as *mut Vec<HMONITOR>)).push(monitor);}true.into()
}
fn native_error(error:windows::core::Error)->Value{
    let code=if error.code().0==0x80070005u32 as i32{"permission_denied"}else{"provider_failed"};
    failure(code,format!("Windows capture API failed: {error}"))
}
pub fn monitors()->Result<Vec<HMONITOR>,Value>{
    let mut monitors=Vec::<HMONITOR>::new();
    if !unsafe{EnumDisplayMonitors(None,None,Some(monitor_callback),LPARAM((&mut monitors as *mut Vec<HMONITOR>)as isize))}.as_bool(){return Err(failure("provider_failed","monitor enumeration failed"));}
    Ok(monitors)
}
impl Source{
    pub(crate) fn owner(&self)->Option<u32>{self.window.as_ref().map(|window|window.pid)}
    pub(crate) fn window_id(&self)->Option<u64>{self.window.as_ref().map(|window|window.hwnd.0 as usize as u64)}
    pub fn open(action:&Value,continuous:bool)->Result<Self,Value>{unsafe{
        if !GraphicsCaptureSession::IsSupported().map_err(native_error)?{return Err(failure("unsupported_operation","Windows.Graphics.Capture is not supported on this device"));}
        let interop:IGraphicsCaptureItemInterop=windows::core::factory::<GraphicsCaptureItem,IGraphicsCaptureItemInterop>().map_err(native_error)?;
        let display=action["mode"]=="display"||(!action["window"].is_number()&&!action["app"].is_string()&&(action["display"].is_number()||continuous));
        let (item,window)=if display {
            let monitors=monitors()?;
            let monitor=monitors.iter().find(|m|action["display"].as_f64().is_none_or(|id|id==m.0 as usize as f64)).copied()
                .ok_or_else(||failure("unsupported_target","requested capture display is not present"))?;
            (interop.CreateForMonitor::<GraphicsCaptureItem>(monitor).map_err(native_error)?,None)
        }else{
            let (hwnd,pid)=crate::windows::capture_window(action)?;
            if IsIconic(hwnd).as_bool(){return Err(failure("background_unavailable","minimized windows cannot supply a qualified background frame"));}
            let mut affinity=0;
            if GetWindowDisplayAffinity(hwnd,&mut affinity).is_ok()&&affinity!=0{return Err(failure("capture_protected","target window excludes capture"));}
            let process=OwnedHandle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|PROCESS_SYNCHRONIZE,false,pid).map_err(native_error)?);
            let mut current=0;GetWindowThreadProcessId(hwnd,Some(&mut current));
            if current!=pid||WaitForSingleObject(process.0,0)!=WAIT_TIMEOUT{return Err(failure("target_gone","capture target exited or changed owner"));}
            (interop.CreateForWindow::<GraphicsCaptureItem>(hwnd).map_err(native_error)?,Some(WindowIdentity{hwnd,pid,process}))
        };
        let size=item.Size().map_err(native_error)?;
        crate::capture::pixel_size(size.Width.max(0)as u32,size.Height.max(0)as u32)?;
        let (mut device,mut context)=(None,None);
        if D3D11CreateDevice(None,D3D_DRIVER_TYPE_HARDWARE,HMODULE::default(),D3D11_CREATE_DEVICE_BGRA_SUPPORT,None,D3D11_SDK_VERSION,Some(&mut device),None,Some(&mut context)).is_err(){
            D3D11CreateDevice(None,D3D_DRIVER_TYPE_WARP,HMODULE::default(),D3D11_CREATE_DEVICE_BGRA_SUPPORT,None,D3D11_SDK_VERSION,Some(&mut device),None,Some(&mut context)).map_err(native_error)?;
        }
        let device=device.ok_or_else(||failure("provider_failed","capture graphics device unavailable"))?;
        let context=context.ok_or_else(||failure("provider_failed","capture graphics context unavailable"))?;
        let dxgi:IDXGIDevice=device.cast().map_err(native_error)?;
        let winrt:IDirect3DDevice=CreateDirect3D11DeviceFromDXGIDevice(&dxgi).map_err(native_error)?.cast().map_err(native_error)?;
        let pool=Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt,DirectXPixelFormat::B8G8R8A8UIntNormalized,2,size).map_err(native_error)?;
        let session=pool.CreateCaptureSession(&item).map_err(native_error)?;
        // Keep the OS capture indicator. Borderless permission is never requested.
        session.SetIsCursorCaptureEnabled(false).map_err(native_error)?;
        session.StartCapture().map_err(native_error)?;
        Ok(Self{pool,session,device,winrt,context,window,size})
    }}
    pub fn next_frame(&mut self)->Result<Option<RgbaImage>,Value>{unsafe{
        if let Some(target)=&self.window{
            let mut current=0;GetWindowThreadProcessId(target.hwnd,Some(&mut current));
            if !IsWindow(Some(target.hwnd)).as_bool()||current!=target.pid||WaitForSingleObject(target.process.0,0)!=WAIT_TIMEOUT{return Err(failure("target_gone","capture window identity no longer matches its retained process"));}
            if IsIconic(target.hwnd).as_bool(){return Err(failure("background_unavailable","capture target is minimized"));}
            let mut affinity=0;if GetWindowDisplayAffinity(target.hwnd,&mut affinity).is_ok()&&affinity!=0{return Err(failure("capture_protected","capture target now excludes capture"));}
        }
        // TryGetNextFrame succeeds with a null interface while its pool is
        // empty. windows-core 0.62.2 maps that nullable return to Error::empty
        // (HRESULT 0). Real failing HRESULTs remain native failures.
        let frame=match self.pool.TryGetNextFrame(){Ok(frame)=>frame,Err(error)if error.code().0==0=>return Ok(None),Err(error)=>return Err(native_error(error))};
        let result=(||{
            let size=frame.ContentSize().map_err(native_error)?;
            let access:IDirect3DDxgiInterfaceAccess=frame.Surface().map_err(native_error)?.cast().map_err(native_error)?;
            let texture:ID3D11Texture2D=access.GetInterface().map_err(native_error)?;
            let mut descriptor=D3D11_TEXTURE2D_DESC::default();texture.GetDesc(&mut descriptor);
            let width=descriptor.Width.min(size.Width.max(0)as u32);let height=descriptor.Height.min(size.Height.max(0)as u32);
            let count=crate::capture::pixel_size(width,height)?;
            descriptor.BindFlags=0;descriptor.MiscFlags=0;descriptor.CPUAccessFlags=D3D11_CPU_ACCESS_READ.0 as u32;descriptor.Usage=D3D11_USAGE_STAGING;
            let mut staging=None;self.device.CreateTexture2D(&descriptor,None,Some(&mut staging)).map_err(native_error)?;
            let staging=staging.ok_or_else(||failure("provider_failed","capture staging texture unavailable"))?;
            self.context.CopyResource(&staging,&texture);
            let mut mapped=D3D11_MAPPED_SUBRESOURCE::default();self.context.Map(&staging,0,D3D11_MAP_READ,0,Some(&mut mapped)).map_err(native_error)?;
            let mut pixels=vec![0u8;count];
            if mapped.pData.is_null()||mapped.RowPitch<(width*4){self.context.Unmap(&staging,0);return Err(failure("provider_failed","capture texture stride is invalid"));}
            for y in 0..height as usize{
                let row=std::slice::from_raw_parts(mapped.pData.cast::<u8>().add(y*mapped.RowPitch as usize),width as usize*4);
                for x in 0..width as usize{let source=x*4;let dest=(y*width as usize+x)*4;pixels[dest..dest+4].copy_from_slice(&[row[source+2],row[source+1],row[source],255]);}
            }
            self.context.Unmap(&staging,0);
            Ok((RgbaImage::from_raw(width,height,pixels).ok_or_else(||failure("provider_failed","capture image buffer is invalid"))?,size))
        })();
        let _=frame.Close();
        let (pixels,size)=result?;
        if size!=self.size{self.pool.Recreate(&self.winrt,DirectXPixelFormat::B8G8R8A8UIntNormalized,2,size).map_err(native_error)?;self.size=size;}
        Ok(Some(pixels))
    }}
}
