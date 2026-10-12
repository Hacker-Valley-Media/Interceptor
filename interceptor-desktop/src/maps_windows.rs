use crate::failure;
use serde_json::Value;
use windows::{core::HSTRING,Foundation::Uri,System::{Launcher,LaunchQuerySupportType,LaunchQuerySupportStatus},Win32::System::WinRT::{RoInitialize,RoUninitialize,RO_INIT_MULTITHREADED}};
struct Runtime;
impl Drop for Runtime{fn drop(&mut self){unsafe{RoUninitialize();}}}
pub(crate) fn open(a:&Value)->Result<(),Value>{
    unsafe{RoInitialize(RO_INIT_MULTITHREADED)}.map_err(|_|failure("provider_failed","native map URI runtime initialization failed"))?;let _runtime=Runtime;
    let uri=Uri::CreateUri(&HSTRING::from(crate::maps::coordinate_uri(&a["coordinate"])?)).map_err(|_|failure("provider_failed","native map URI construction failed"))?;
    let supported=Launcher::QueryUriSupportAsync(&uri,LaunchQuerySupportType::Uri).and_then(|operation|operation.join()).map_err(|_|failure("provider_failed","native map URI handler discovery failed"))?;
    if supported!=LaunchQuerySupportStatus::Available{return Err(failure("not_installed","a working geo URI map handler is required; retired Windows Maps is not used"));}
    let accepted=crate::share_windows::launch(&uri,"map")?;
    if accepted{Ok(())}else{Err(failure("unsupported_target","no native map URI handler accepted the retained coordinate"))}
}
