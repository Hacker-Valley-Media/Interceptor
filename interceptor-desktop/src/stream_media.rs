// One native MJPEG track. Timestamps describe observed capture arrival,
// not a compositor presentation clock or an inferred audio timeline.
use crate::{contract_generated::*, failure};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::File, io::{self, Read, Seek, SeekFrom, Write}, path::PathBuf, time::Instant};

fn size(value: u64) -> io::Result<Vec<u8>> {
    for width in 1..=8 {
        if value < (1u64 << (7 * width)) - 1 {
            let encoded = value | (1u64 << (7 * width));
            return Ok(encoded.to_be_bytes()[8 - width..].to_vec());
        }
    }
    Err(io::Error::other("Matroska element exceeds its size bound"))
}
fn element(id: u32, body: &[u8]) -> io::Result<Vec<u8>> {
    let bytes = id.to_be_bytes();
    let start = bytes.iter().position(|b| *b != 0).ok_or_else(|| io::Error::other("invalid EBML identifier"))?;
    let mut result = bytes[start..].to_vec();
    result.extend(size(body.len() as u64)?); result.extend(body); Ok(result)
}
fn uint(id: u32, n: u64) -> io::Result<Vec<u8>> {
    let bytes = n.to_be_bytes(); element(id, &bytes[bytes.iter().position(|b| *b != 0).unwrap_or(7)..])
}
fn io_error(error: io::Error, path: &std::path::Path) -> Value {
    failure("partial_result", format!("stream media failed: {error}; any partial owned artifact is preserved at {}", path.display()))
}

pub(crate) struct Recording {
    path: PathBuf, sid: String, file: Option<File>, reader: Option<File>, source: Value, started: Instant, first: Option<Instant>,
    dimensions: Option<(u32, u32)>, pending: Option<(Vec<u8>, u64)>, frames: u64, bytes: u64,
    duration_position: u64, segment_position: u64, segment_start: u64,
    duration: f64, finalized: bool, digest: Option<String>, error: Option<Value>,
}
impl Recording {
    pub(crate) fn start(sid: &str, source: Value) -> Result<Self, Value> {
        let root = crate::filesystem::temp_dir().map_err(|e| failure("provider_failed", e))?;
        Self::start_in(root.join(format!("interceptor-stream-{}", crate::monitor::identifier())), sid, source)
    }
    /// A recording inside an existing private folder (monitor `--video` writes into its session).
    pub(crate) fn start_in(directory: PathBuf, sid: &str, source: Value) -> Result<Self, Value> {
        crate::monitor::private_directory(&directory, true, false).map_err(|e| failure("permission_denied", e))?;
        let path = directory.join("recording.mkv");
        if path.to_str().is_none_or(|s| s.len() > 4096) { return Err(failure("resource_limit", "stream artifact path exceeds its UTF8 bound")); }
        let mut metadata = crate::monitor::private_file(&directory.join("source.json"), true).map_err(|e| io_error(e, &path))?;
        metadata.write_all(&serde_json::to_vec(&json!({"sid":sid,"source":source,"timing":"monotonic-arrival","finalized":false})).unwrap())
            .and_then(|_|metadata.sync_all()).map_err(|e| io_error(e, &path))?;
        // The media file begins only after a real frame supplies dimensions.
        Ok(Self { path, sid: sid.into(), file: None, reader: None, source, started: Instant::now(), first: None, dimensions: None,
            pending: None, frames: 0, bytes: 0, duration_position: 0, segment_position: 0,
            segment_start: 0, duration: 0.0, finalized: false, digest: None, error: None })
    }
    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        if self.bytes + bytes.len() as u64 > DESKTOP_STREAM_MEDIA_MAX_BYTES as u64 { return Err(io::Error::new(io::ErrorKind::FileTooLarge, "stream media exceeds 100MiB")); }
        self.file.as_mut().ok_or_else(|| io::Error::other("media file is not admitted"))?.write_all(bytes)?;
        self.bytes += bytes.len() as u64; Ok(())
    }
    fn header(&mut self, width: u32, height: u32) -> io::Result<()> {
        self.file = Some(crate::monitor::private_file(&self.path, true)?);
        self.reader = Some(crate::monitor::retained_private_reader(self.file.as_ref().unwrap(),&self.path)?);
        let mut header = vec![];
        for (id, value) in [(0x4286,1),(0x42f7,1),(0x42f2,4),(0x42f3,8)] { header.extend(uint(id,value)?); }
        header.extend(element(0x4282,b"matroska")?); header.extend(uint(0x4287,4)?); header.extend(uint(0x4285,2)?);
        self.write(&element(0x1a45dfa3,&header)?)?;
        self.write(&[0x18,0x53,0x80,0x67])?; self.segment_position=self.bytes;
        self.write(&[1,255,255,255,255,255,255,255])?; self.segment_start=self.bytes;
        let mut info=uint(0x2ad7b1,1000)?;
        info.extend(element(0x4d80,b"Interceptor")?); info.extend(element(0x5741,b"Interceptor")?);
        info.extend(element(0x4489,&0f64.to_be_bytes())?);
        let info=element(0x1549a966,&info)?; self.duration_position=self.bytes+info.len()as u64-8; self.write(&info)?;
        let mut video=uint(0xb0,u64::from(width))?; video.extend(uint(0xba,u64::from(height))?);
        let mut track=uint(0xd7,1)?; track.extend(uint(0x73c5,1)?); track.extend(uint(0x83,1)?);
        track.extend(uint(0x9c,0)?); track.extend(element(0x86,b"V_MJPEG")?); track.extend(element(0xe0,&video)?);
        self.write(&element(0x1654ae6b,&element(0xae,&track)?)?)?; self.dimensions=Some((width,height)); Ok(())
    }
    fn flush_pending(&mut self, until: u64) -> io::Result<()> {
        let Some((jpeg, at))=self.pending.take() else { return Ok(()); };
        let duration=until.checked_sub(at).filter(|n|*n>0).ok_or_else(||io::Error::other("capture arrival clock did not advance"))?;
        // BlockGroup permits an observed final-frame duration without adding
        // a duplicate frame or assuming a constant frame rate.
        let mut block=vec![0x81,0,0,0]; block.extend(jpeg);
        let mut group=element(0xa1,&block)?; group.extend(uint(0x9b,duration)?);
        let mut cluster=uint(0xe7,at)?; cluster.extend(element(0xa0,&group)?);
        self.write(&element(0x1f43b675,&cluster)?)
    }
    pub(crate) fn observe(&mut self, jpeg: Vec<u8>, width: u32, height: u32, at: Instant) {
        if self.error.is_some()||self.finalized { return; }
        let result=(||->io::Result<()> {
            if self.started.elapsed().as_secs_f64()>DESKTOP_STREAM_MEDIA_MAX_SECONDS as f64||self.frames>=DESKTOP_STREAM_MEDIA_MAX_FRAMES as u64 { return Err(io::Error::other("stream media reached its one-hour or 100000-frame bound")); }
            if width==0||height==0||u64::from(width)*u64::from(height)>DESKTOP_CAPTURE_MAX_PIXELS as u64||jpeg.len()>DESKTOP_MAX_RESULT_BYTES||!jpeg.starts_with(&[255,216])||!jpeg.ends_with(&[255,217]) { return Err(io::Error::other("recording requires one actual bounded JPEG frame")); }
            if let Some(dimensions)=self.dimensions { if dimensions!=(width,height) { return Err(io::Error::other("captured dimensions changed; no fabricated scaling or replacement track")); } }
            else { self.header(width,height)?; self.first=Some(at); }
            let timestamp=at.checked_duration_since(self.first.unwrap()).ok_or_else(||io::Error::other("capture arrival clock moved backwards"))?.as_micros();
            let timestamp=u64::try_from(timestamp).map_err(io::Error::other)?;
            self.flush_pending(timestamp)?;
            // Include the pending encoded frame in admission bounds.
            if self.bytes+jpeg.len()as u64+128>DESKTOP_STREAM_MEDIA_MAX_BYTES as u64 { return Err(io::Error::other("pending stream frame exceeds 100MiB media bound")); }
            self.pending=Some((jpeg,timestamp)); self.frames+=1; Ok(())
        })();
        if let Err(e)=result { self.error=Some(io_error(e,&self.path)); self.pending=None;drop(self.reader.take());drop(self.file.take()); }
    }
    pub(crate) fn finish(&mut self) -> Result<(), Value> {
        if let Some(error)=&self.error { return Err(error.clone()); } if self.finalized { return Ok(()); }
        let result=(||->io::Result<()> {
            let first=self.first.ok_or_else(||io::Error::other("native capture delivered no recording frame"))?;
            let elapsed=first.elapsed();
            if self.started.elapsed().as_secs_f64()>DESKTOP_STREAM_MEDIA_MAX_SECONDS as f64 { return Err(io::Error::other("media finalization exceeded its one-hour bound")); }
            let end=u64::try_from(elapsed.as_micros()).map_err(io::Error::other)?; self.flush_pending(end)?;
            let file=self.file.as_mut().ok_or_else(||io::Error::other("recording file is missing"))?;
            file.seek(SeekFrom::Start(self.duration_position))?; file.write_all(&(end as f64).to_be_bytes())?;
            file.seek(SeekFrom::Start(self.segment_position))?;
            file.write_all(&((self.bytes-self.segment_start)|(1u64<<56)).to_be_bytes())?; file.sync_all()?;
            let input=self.reader.as_mut().ok_or_else(||io::Error::other("retained media reader is missing"))?;
            input.seek(SeekFrom::Start(0))?;let before=input.metadata()?;
            if before.len()!=self.bytes { return Err(io::Error::other("media file length changed before final readback")); }
            let mut hash=Sha256::new();let mut buffer=[0u8;65536];let mut count=0u64;
            loop { let n=input.read(&mut buffer)?; if n==0 { break; } count+=n as u64;
                if count>self.bytes { return Err(io::Error::other("media file grew during final readback")); } hash.update(&buffer[..n]); }
            let after=input.metadata()?;
            if count!=self.bytes||after.len()!=self.bytes||before.modified()?!=after.modified()?
                ||!crate::monitor::same_private_file(self.file.as_ref().unwrap(),input)?
                ||!crate::monitor::private_path_matches(self.file.as_ref().unwrap(),&self.path)? { return Err(io::Error::other("retained media bytes or native path identity changed during final readback")); }
            let digest=hash.finalize().iter().map(|b|format!("{b:02x}")).collect::<String>();
            if !crate::monitor::private_path_matches(self.file.as_ref().unwrap(),&self.path)? { return Err(io::Error::other("media pathname changed before receipt publication")); }
            let mut receipt=crate::monitor::private_file(&self.path.parent().unwrap().join("finalized.json"),true)?;
            receipt.write_all(&serde_json::to_vec(&json!({"sid":self.sid,"filePath":self.path,"source":self.source,"container":"matroska","videoCodec":"mjpeg","audio":"none","timing":"monotonic-arrival","finalized":true,"bytes":self.bytes,"frames":self.frames,"duration":elapsed.as_secs_f64(),"sha256":digest}))?)?;receipt.sync_all()?;
            #[cfg(unix)]File::open(self.path.parent().unwrap())?.sync_all()?;
            self.digest=Some(digest); self.duration=elapsed.as_secs_f64(); self.finalized=true;drop(self.reader.take());drop(self.file.take());Ok(())
        })();
        match result { Ok(())=>Ok(()), Err(e)=>{let error=io_error(e,&self.path);self.error=Some(error.clone());self.pending=None;drop(self.reader.take());drop(self.file.take());Err(error)} }
    }
    pub(crate) fn problem(&self)->Option<Value>{self.error.clone()}
    pub(crate) fn path(&self)->&std::path::Path{&self.path}
    pub(crate) fn bytes(&self)->u64{self.bytes}
    pub(crate) fn duration(&self)->f64{self.duration}
    pub(crate) fn abort(&mut self,reason:&str){if !self.finalized&&self.error.is_none(){self.pending=None;drop(self.reader.take());drop(self.file.take());self.error=Some(failure("partial_result",format!("stream recording stopped without finalization: {reason}; partial artifact preserved at {}",self.path.display())));}}
    pub(crate) fn active(&self)->bool{!self.finalized&&self.error.is_none()}
    pub(crate) fn expire(&mut self){if !self.finalized&&self.started.elapsed().as_secs_f64()>DESKTOP_STREAM_MEDIA_MAX_SECONDS as f64{self.abort("one-hour media deadline expired");}}
    pub(crate) fn snapshot(&self,sid:&str)->Value {
        let mut artifact=json!({"filePath":self.path,"container":"matroska","videoCodec":"mjpeg","audio":"none","timing":"monotonic-arrival","finalized":self.finalized,"bytes":self.bytes,"source":self.source});
        if let Some(digest)=&self.digest { artifact["sha256"]=json!(digest); }
        json!({"recording":!self.finalized&&self.error.is_none(),"sid":sid,"frames":self.frames,"duration":if self.finalized{self.duration}else{self.first.map(|at|at.elapsed().as_secs_f64()).unwrap_or(0.)},"artifact":artifact})
    }
}

#[cfg(test)]mod tests {
    use super::*;
    #[test]fn ebml_sizes_and_unsigned_elements_preserve_exact_boundaries(){
        assert_eq!(size(0).unwrap(),vec![0x80]);assert_eq!(size(126).unwrap(),vec![0xfe]);
        assert_eq!(size(127).unwrap(),vec![0x40,0x7f]);assert!(size((1u64<<56)-1).is_err());
        assert_eq!(uint(0xe7,256).unwrap(),vec![0xe7,0x82,1,0]);
    }
    #[test]fn recording_requires_actual_frames_and_monotonic_native_arrivals(){
        let mut record=Recording::start("owned",json!({"kind":"window","pid":1,"window":2})).unwrap();
        let path=record.path.clone();let directory=path.parent().unwrap().to_path_buf();
        assert!(record.finish().is_err());assert!(!path.exists());drop(record);std::fs::remove_dir_all(directory).unwrap();
        let mut record=Recording::start("owned",json!({"kind":"window","pid":1,"window":2})).unwrap();
        let directory=record.path.parent().unwrap().to_path_buf();let at=Instant::now();
        record.observe(vec![255,216,255,217],1,1,at); // Container fixture, not a decodable native JPEG.
        record.observe(vec![255,216,255,217],1,1,at);assert!(record.problem().is_some());
        assert!(record.finish().is_err());assert!(!record.finalized);drop(record);std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]fn finalized_container_keeps_exact_encoded_frames_and_persistent_identity(){
        let mut record=Recording::start("owned",json!({"kind":"window","pid":1,"window":2})).unwrap();
        let directory=record.path.parent().unwrap().to_path_buf();
        let pixels=image::RgbaImage::from_pixel(3,2,image::Rgba([16,32,128,255]));
        let jpeg=crate::capture::encode(&pixels,"jpeg",85).unwrap();
        let at=Instant::now()-std::time::Duration::from_millis(50);
        record.observe(jpeg.clone(),3,2,at);record.observe(jpeg.clone(),3,2,at+std::time::Duration::from_millis(20));
        record.finish().unwrap();let bytes=std::fs::read(&record.path).unwrap();
        assert!(bytes.starts_with(&[0x1a,0x45,0xdf,0xa3]));assert_eq!(bytes.windows(jpeg.len()).filter(|chunk|*chunk==jpeg.as_slice()).count(),2);
        assert!(bytes.windows(7).any(|chunk|chunk==b"V_MJPEG"));
        let decoded=image::load_from_memory(&jpeg).unwrap();assert_eq!((decoded.width(),decoded.height()),(3,2));
        let receipt:Value=serde_json::from_slice(&std::fs::read(directory.join("finalized.json")).unwrap()).unwrap();
        assert_eq!(receipt["sha256"],Sha256::digest(&bytes).iter().map(|b|format!("{b:02x}")).collect::<String>());assert_eq!(receipt["bytes"],bytes.len());
        assert_eq!(receipt["frames"],2);assert_eq!(receipt["source"]["window"],2);assert_eq!(receipt["timing"],"monotonic-arrival");
        assert_eq!(receipt["finalized"],true);drop(record);std::fs::remove_dir_all(directory).unwrap();
        // Playback and native capture timing require independent installed
        // media-player inspection; this authored format fixture is not that evidence.
    }
    #[cfg(target_os="linux")]#[test]fn changed_media_name_cannot_supply_final_readback_or_finalized_receipt(){
        let mut record=Recording::start("owned",json!({"kind":"window","pid":1,"window":2})).unwrap();
        let directory=record.path.parent().unwrap().to_path_buf();let pixels=image::RgbaImage::from_pixel(3,2,image::Rgba([17,31,97,255]));
        let jpeg=crate::capture::encode(&pixels,"jpeg",90).unwrap();let at=Instant::now()-std::time::Duration::from_millis(50);
        record.observe(jpeg,3,2,at);
        let original=record.path.with_extension("original");std::fs::rename(&record.path,&original).unwrap();
        let mut replacement=crate::monitor::private_file(&record.path,true).unwrap();replacement.write_all(b"foreign replacement").unwrap();drop(replacement);
        let error=record.finish().unwrap_err();assert_eq!(error["code"],"partial_result");assert!(!record.finalized);
        assert_eq!(std::fs::read(&record.path).unwrap(),b"foreign replacement");assert!(!directory.join("finalized.json").exists());
        assert!(std::fs::metadata(original).unwrap().len()>0);assert!(record.reader.is_none());assert!(record.file.is_none());
        drop(record);std::fs::remove_dir_all(directory).unwrap();
    }
}
