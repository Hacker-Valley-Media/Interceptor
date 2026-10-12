use super::*;
use std::fs::{self,OpenOptions};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        if fs::read_to_string(self.0.join("owned.txt")).is_ok_and(|text|text=="Interceptor native file lifecycle") {
            let _=fs::remove_dir_all(&self.0);
        }
    }
}

fn resources()->usize {
    #[cfg(target_os="linux")]{fs::read_dir("/proc/self/fd").unwrap().count()}
    #[cfg(windows)]{let mut count=0;unsafe{windows::Win32::System::Threading::GetProcessHandleCount(windows::Win32::System::Threading::GetCurrentProcess(),&mut count).unwrap();}count as usize}
}

fn changed(watch:&mut native::Watch)->bool {
    for _ in 0..100 { if watch.poll().unwrap(){return true;}std::thread::sleep(Duration::from_millis(10)); }false
}

#[cfg(windows)]
#[test]
fn inventory_helper_deadline_kills_and_reaps_its_windows_child() {
    use windows::Win32::{Foundation::*,System::Threading::*};
    let mut child=crate::auth::AuthChild(Command::new("powershell.exe").args(["-NoProfile","-Command","Start-Sleep -Seconds 5"]).stdout(Stdio::piped()).spawn().unwrap());
    let retained=crate::windows::OwnedHandle(unsafe{OpenProcess(PROCESS_SYNCHRONIZE,false,child.0.id()).unwrap()});
    let mut output=child.0.stdout.take().unwrap();let started=Instant::now();
    let error=crate::auth::bounded_child_result(|out|crate::auth::ready_read(&mut output,out),started+Duration::from_millis(30),DESKTOP_FILES_MAX_HISTORY_BYTES).unwrap_err();
    assert_eq!(error.kind(),io::ErrorKind::TimedOut);drop(child);
    assert_eq!(unsafe{WaitForSingleObject(retained.0,1000)},WAIT_OBJECT_0,"owned inventory helper must be killed and reaped");
    assert!(started.elapsed()<Duration::from_secs(2));
}

#[test]
fn native_original_object_watch_lifecycle_and_resource_cleanup() {
    // Process-wide handle/fd counts are exact only without sibling test threads, so rerun alone.
    if std::env::var_os("INTERCEPTOR_ISOLATED_RESOURCE_TEST").is_none() {
        let run=Command::new(std::env::current_exe().unwrap()).args(["--exact","files::native_tests::native_original_object_watch_lifecycle_and_resource_cleanup","--test-threads=1"])
            .env("INTERCEPTOR_ISOLATED_RESOURCE_TEST","1").output().unwrap();
        let stdout=String::from_utf8_lossy(&run.stdout);
        assert!(run.status.success()&&stdout.contains("test result: ok. 1 passed"),"isolated native watch lifecycle run failed:\n{stdout}\n{}",String::from_utf8_lossy(&run.stderr));
        return;
    }
    let nonce=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let fixture=Fixture(std::env::temp_dir().join(format!("interceptor-files-unit-{}-{nonce}",std::process::id())));
    fs::create_dir(&fixture.0).unwrap();fs::write(fixture.0.join("owned.txt"),"Interceptor native file lifecycle").unwrap();
    let directory=fixture.0.join("watched");fs::create_dir(&directory).unwrap();
    let path=directory.join("held.txt");let mut held=OpenOptions::new().create_new(true).write(true).read(true).open(&path).unwrap();held.write_all(b"initial").unwrap();held.sync_all().unwrap();
    let before=resources();
    let file_resources=if cfg!(windows){3}else{2};
    let mut file_watch=native::Watch::new(&path).unwrap();let one=resources();assert_eq!(one,before+file_resources);
    for _ in 0..64 { file_watch=native::Watch::new(&path).unwrap(); }
    assert_eq!(resources(),one,"64 replacements must not leak native descriptors/handles");
    let mut directory_watch=native::Watch::new(&directory).unwrap();assert_eq!(resources(),before+file_resources+2);
    held.write_all(b"first change").unwrap();held.sync_all().unwrap();
    assert!(changed(&mut file_watch),"original-file write must be observed");assert!(changed(&mut directory_watch),"direct child write must be observed");
    // A closed writer can replace bytes without changing the file length.
    // Keep its last-write timestamp fixed to exercise notification deduplication.
    #[cfg(windows)] {
        use windows::Win32::{Storage::FileSystem::*,Foundation::HANDLE};
        use std::os::windows::io::AsRawHandle;
        let handle=HANDLE(held.as_raw_handle());let mut info=FILE_BASIC_INFO::default();
        unsafe{GetFileInformationByHandleEx(handle,FileBasicInfo,(&raw mut info).cast(),std::mem::size_of::<FILE_BASIC_INFO>()as u32).unwrap();}
        held.seek(SeekFrom::Start(0)).unwrap();held.write_all(b"CHANGED").unwrap();held.sync_all().unwrap();
        unsafe{SetFileInformationByHandle(handle,FileBasicInfo,(&raw const info).cast(),std::mem::size_of::<FILE_BASIC_INFO>()as u32).unwrap();}
        assert!(changed(&mut file_watch),"same-length write must not disappear when its last-write and change timestamps are unchanged");
    }
    let renamed=directory.join("renamed.txt");fs::rename(&path,&renamed).unwrap();
    assert!(changed(&mut file_watch),"original-file rename must be observed");assert!(changed(&mut directory_watch),"child rename must be observed");
    fs::write(&path,b"replacement inode").unwrap();std::thread::sleep(Duration::from_millis(100));
    // Drain the parent's notification without rebinding the retained file.
    let _=file_watch.poll().unwrap();let _=directory_watch.poll().unwrap();
    fs::write(&path,b"replacement modified").unwrap();std::thread::sleep(Duration::from_millis(100));
    assert!(!file_watch.poll().unwrap(),"replacement pathname must not rebind the original file watch");
    held.write_all(b"original modified after rename").unwrap();held.sync_all().unwrap();assert!(changed(&mut file_watch));
    let _=directory_watch.poll().unwrap();
    drop(file_watch);drop(directory_watch);assert_eq!(resources(),before,"cancellation must close all owned native resources");
    drop(held);
    // Windows refuses a directory rename while a child file remains open,
    // independently of the notification API. Qualify the directory object
    // separately so the original-file retention does not block the fixture.
    let directory=fixture.0.join("directory-object");fs::create_dir(&directory).unwrap();
    let directory_before=resources();let mut directory_watch=native::Watch::new(&directory).unwrap();assert_eq!(resources(),directory_before+2);
    let old_directory=fixture.0.join("renamed-directory");fs::rename(&directory,&old_directory).unwrap();fs::create_dir(&directory).unwrap();
    std::thread::sleep(Duration::from_millis(100));let _=directory_watch.poll().unwrap();
    fs::write(directory.join("new-target.txt"),b"new directory").unwrap();std::thread::sleep(Duration::from_millis(100));
    assert!(!directory_watch.poll().unwrap(),"replacement directory must not become the watched object");
    fs::write(old_directory.join("original-target.txt"),b"original directory").unwrap();assert!(changed(&mut directory_watch));
    drop(directory_watch);assert_eq!(resources(),directory_before,"directory cancellation must close its two owned native resources");
}
