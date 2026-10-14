//! Retained native QEMU PNG files. Unknown native work keeps its descriptor
//! in Runtime so a proc-fd number cannot be reused by a late screendump.
use super::{error,failure,Result};
use std::{fs::{self,File},io::{Read,Seek,SeekFrom,Write},path::{Path,PathBuf}};
pub(super) const MAX_BYTES:usize=64*1024*1024;
pub(super) const INLINE_BYTES:usize=700000;

fn same_file(first:&File,second:&File)->Result<bool>{
    crate::monitor::same_private_file(first,second).map_err(error)
}
fn retained_reader(writer:&File,path:&Path)->Result<File>{
    crate::monitor::retained_private_reader(writer,path).map_err(error)
}
fn bytes(file:&mut File)->Result<Vec<u8>>{
    let before=file.metadata().map_err(error)?;
    if !before.is_file()||before.len()==0||before.len()>MAX_BYTES as u64{return Err(failure("resource_limit","native VM PNG requires 1..64MiB of actual regular-file bytes"));}
    file.seek(SeekFrom::Start(0)).map_err(error)?;
    let mut bytes=Vec::new();Read::by_ref(file).take(MAX_BYTES as u64+1).read_to_end(&mut bytes).map_err(error)?;
    let after=file.metadata().map_err(error)?;
    if bytes.len()>MAX_BYTES{return Err(failure("resource_limit","native VM PNG grew beyond 64MiB"));}
    if before.len()!=after.len()||bytes.len()as u64!=after.len()||before.modified().map_err(error)?!=after.modified().map_err(error)?{return Err(failure("unsupported_target","retained VM PNG changed during its bounded read"));}
    Ok(bytes)
}
pub(super) fn decode(bytes:&[u8])->Result<image::RgbaImage>{
    if bytes.is_empty()||bytes.len()>MAX_BYTES{return Err(failure("resource_limit","VM PNG bytes exceed 64MiB"));}
    if image::guess_format(bytes).ok()!=Some(image::ImageFormat::Png){return Err(failure("unsupported_target","native screendump must contain actual PNG bytes"));}
    crate::thumbnail::decode_raster(bytes)
}
pub(super) struct Frame {path:PathBuf,file:Option<File>}
impl Frame {
    pub(super) fn prepare(bundle:&Path)->Result<Self>{
        #[cfg(not(any(target_os="linux",windows)))]return Err(failure("unsupported_operation","native QEMU capture requires the Linux or Windows provider"));
        crate::monitor::private_directory(bundle,false,false).map_err(error)?;
        let path=bundle.join(format!("frame-{}.png",crate::secret_target::random_token().map_err(error)?));
        let writer=crate::monitor::private_file(&path,true).map_err(error)?;
        let file=retained_reader(&writer,&path)?;drop(writer);
        Ok(Self{path,file:Some(file)})
    }
    pub(super) fn native_path(&self)->Result<String>{
        let file=self.file.as_ref().ok_or_else(||failure("unsupported_target","native capture descriptor is already closed"))?;
        #[cfg(target_os="linux")]return {use std::os::fd::AsRawFd;Ok(format!("/proc/{}/fd/{}",std::process::id(),file.as_raw_fd()))};
        #[cfg(windows)]return self.path.to_str().map(str::to_owned).ok_or_else(||failure("unsupported_target","native capture path is not Unicode"));
        #[cfg(not(any(target_os="linux",windows)))]{let _=file;Err(failure("unsupported_operation","native capture path is unavailable"))}
    }
    pub(super) fn pixels(&mut self)->Result<image::RgbaImage>{
        let source=bytes(self.file.as_mut().ok_or_else(||failure("unsupported_target","native capture descriptor is closed"))?)?;
        decode(&source)
    }
    // Call only after a matching successful QMP completion and decode. Failed
    // or unknown capture stays retained with its exact Runtime until stop.
    pub(super) fn retire(&mut self)->Result<()>{
        let file=self.file.as_ref().ok_or_else(||failure("unsupported_target","native capture descriptor is closed"))?;
        #[cfg(windows)]let current=crate::windows::private_input_sharing(&self.path,true).map_err(error)?;
        #[cfg(not(windows))]let current=crate::monitor::private_file(&self.path,false).map_err(error)?;
        if !same_file(file,&current)?{return Err(failure("unsupported_target","native capture name changed; artifacts and retained descriptor preserved"));}
        drop(current);
        // Windows intentionally denies delete sharing for the retained read.
        #[cfg(windows)]drop(self.file.take());
        fs::remove_file(&self.path).map_err(error)?;
        drop(self.file.take());Ok(())
    }
}
pub(super) fn output(path:&Path,png:&[u8])->Result<()>{
    if png.is_empty()||png.len()>MAX_BYTES{return Err(failure("resource_limit","VM screenshot output exceeds 64MiB"));}
    let mut writer=crate::monitor::private_file(path,true).map_err(error)?;
    let mut reader=retained_reader(&writer,path)?;
    writer.write_all(png).and_then(|_|writer.sync_all()).map_err(error)?;
    if bytes(&mut reader)?!=png||!same_file(&writer,&reader)?{return Err(failure("partial_result","VM screenshot retained output readback differs; partial artifact preserved"));}
    #[cfg(target_os="linux")]File::open(path.parent().unwrap()).and_then(|p|p.sync_all()).map_err(error)?;
    Ok(())
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn actual_png_decoder_preserves_pixels_and_refuses_other_formats_or_corrupt_bytes(){
        let mut pixels=image::RgbaImage::new(3,2);
        for (x,y,pixel)in pixels.enumerate_pixels_mut(){*pixel=image::Rgba([(x*71)as u8,(y*113)as u8,191,255]);}
        let png=crate::capture::encode(&pixels,"png",100).unwrap();
        let decoded=decode(&png).unwrap();assert_eq!(decoded.as_raw(),pixels.as_raw());assert_eq!(decoded.dimensions(),(3,2));
        let jpeg=crate::capture::encode(&pixels,"jpeg",90).unwrap();assert_eq!(decode(&jpeg).unwrap_err()["code"],"unsupported_target");
        assert!(decode(&png[..png.len()/2]).is_err());assert!(decode(b"not an image").is_err());
        let mut corrupt=png;corrupt[16]=255;assert!(decode(&corrupt).is_err());
    }
    #[cfg(target_os="linux")]#[test]fn retained_proc_descriptor_refuses_a_replaced_path_without_reading_the_replacement(){
        let root=std::env::temp_dir().join(format!("itc-vm-frame-{}",crate::monitor::identifier()));crate::monitor::private_directory(&root,true,false).unwrap();
        let mut frame=Frame::prepare(&root).unwrap();
        let original=frame.path.with_extension("original");fs::rename(&frame.path,&original).unwrap();
        let mut replacement=crate::monitor::private_file(&frame.path,true).unwrap();replacement.write_all(b"replacement").unwrap();drop(replacement);
        let pixels=image::RgbaImage::from_pixel(2,2,image::Rgba([19,43,97,255]));let png=crate::capture::encode(&pixels,"png",100).unwrap();
        let mut native=fs::OpenOptions::new().write(true).truncate(true).open(frame.native_path().unwrap()).unwrap();native.write_all(&png).unwrap();native.sync_all().unwrap();drop(native);
        assert_eq!(frame.pixels().unwrap().as_raw(),pixels.as_raw());assert_eq!(frame.retire().unwrap_err()["code"],"unsupported_target");
        assert_eq!(fs::read(&frame.path).unwrap(),b"replacement");assert!(frame.file.is_some());drop(frame);fs::remove_dir_all(root).unwrap();
    }
    #[cfg(any(windows,target_os="linux"))]#[test]fn exclusive_output_preserves_preexisting_files_and_reads_back_actual_png_bytes(){
        let root=std::env::temp_dir().join(format!("itc-vm-output-{}",crate::monitor::identifier()));crate::monitor::private_directory(&root,true,false).unwrap();let path=root.join("output.png");
        let pixels=image::RgbaImage::from_pixel(2,2,image::Rgba([19,43,97,255]));let png=crate::capture::encode(&pixels,"png",100).unwrap();output(&path,&png).unwrap();
        assert!(output(&path,b"replacement").is_err());assert_eq!(fs::read(path).unwrap(),png);fs::remove_dir_all(root).unwrap();
    }
}
