//! Actual read-only SQLite results; SQL authorization applies to every statement.
use crate::{failure,native_library::Library};
use serde_json::{Value,json,Map};
use std::{ffi::{CStr,CString,c_char,c_int,c_void},path::PathBuf,ptr,time::Instant};
type Raw=*mut c_void;
type Result<T>=std::result::Result<T,Value>;

unsafe extern "C" fn authorize(_:Raw,operation:c_int,a:*const c_char,b:*const c_char,_:*const c_char,_:*const c_char)->c_int{
    match operation{
        20|21|33=>0, // READ, SELECT, RECURSIVE.
        31=>if b.is_null()||unsafe{CStr::from_ptr(b)}.to_bytes().eq_ignore_ascii_case(b"load_extension")||unsafe{CStr::from_ptr(b)}.to_bytes().eq_ignore_ascii_case(b"writefile")||unsafe{CStr::from_ptr(b)}.to_bytes().eq_ignore_ascii_case(b"readfile"){1}else{0},
        19=>if !a.is_null()&&[b"table_info".as_slice(),b"table_xinfo",b"index_list",b"index_info",b"index_xinfo",b"foreign_key_list",b"database_list",b"compile_options"].iter().any(|name|unsafe{CStr::from_ptr(a)}.to_bytes().eq_ignore_ascii_case(name)){0}else{1},
        _=>1, // DENY writes, ATTACH/DETACH, transactions and mutable PRAGMAs.
    }
}
unsafe extern "C" fn progress(deadline:Raw)->c_int{(Instant::now()>=unsafe{*deadline.cast::<Instant>()})as c_int}

fn library_path()->Result<PathBuf>{
    if let Ok(path)=std::env::var("INTERCEPTOR_SQLITE_LIBRARY"){return crate::filesystem::absolute(&path);}
    #[cfg(windows)]let candidates=vec![PathBuf::from(std::env::var_os("SystemRoot").ok_or_else(||failure("not_installed","Windows system directory is unavailable"))?).join("System32/winsqlite3.dll")];
    #[cfg(target_os="linux")]let candidates=["/usr/lib/x86_64-linux-gnu/libsqlite3.so.0","/usr/lib/aarch64-linux-gnu/libsqlite3.so.0","/usr/lib64/libsqlite3.so.0","/usr/lib/libsqlite3.so.0"].map(PathBuf::from).to_vec();
    #[cfg(target_os="macos")]let candidates=vec![PathBuf::from("/usr/lib/libsqlite3.dylib")];
    candidates.into_iter().find(|p|p.is_file()||cfg!(target_os="macos")).ok_or_else(||failure("not_installed","configure an absolute INTERCEPTOR_SQLITE_LIBRARY for SQLite 3.41 or newer"))
}

pub(crate) fn query(path:&str,sql:&str,deadline:Instant)->Result<Value>{unsafe{
    let path=crate::filesystem::absolute(path)?;
    if !std::fs::metadata(&path).is_ok_and(|m|m.is_file()){return Err(failure("unsupported_target","SQLite input requires an existing regular file"));}
    if sql.len()>65536||sql.contains('\0'){return Err(failure("invalid_request","SQLite requires bounded SQL without NUL"));}
    let library=Library::load(&library_path()?)?;
    macro_rules! symbol{($name:literal,$type:ty)=>{std::mem::transmute::<Raw,$type>(library.symbol(CStr::from_bytes_with_nul(concat!($name,"\0").as_bytes()).unwrap())?)}}
    let version=symbol!("sqlite3_libversion_number",unsafe extern "C" fn()->c_int);
    if version()<3041000{return Err(failure("version_mismatch","SQLite 3.41 or newer is required for bounded prepare progress callbacks"));}
    let open=symbol!("sqlite3_open_v2",unsafe extern "C" fn(*const c_char,*mut Raw,c_int,*const c_char)->c_int);
    let close=symbol!("sqlite3_close",unsafe extern "C" fn(Raw)->c_int);
    let readonly=symbol!("sqlite3_db_readonly",unsafe extern "C" fn(Raw,*const c_char)->c_int);
    let authorizer=symbol!("sqlite3_set_authorizer",unsafe extern "C" fn(Raw,Option<unsafe extern "C" fn(Raw,c_int,*const c_char,*const c_char,*const c_char,*const c_char)->c_int>,Raw)->c_int);
    let set_progress=symbol!("sqlite3_progress_handler",unsafe extern "C" fn(Raw,c_int,Option<unsafe extern "C" fn(Raw)->c_int>,Raw));
    let limit=symbol!("sqlite3_limit",unsafe extern "C" fn(Raw,c_int,c_int)->c_int);
    let prepare=symbol!("sqlite3_prepare_v2",unsafe extern "C" fn(Raw,*const c_char,c_int,*mut Raw,*mut *const c_char)->c_int);
    let finalize=symbol!("sqlite3_finalize",unsafe extern "C" fn(Raw)->c_int);
    let step=symbol!("sqlite3_step",unsafe extern "C" fn(Raw)->c_int);
    let count=symbol!("sqlite3_column_count",unsafe extern "C" fn(Raw)->c_int);
    let name=symbol!("sqlite3_column_name",unsafe extern "C" fn(Raw,c_int)->*const c_char);
    let kind=symbol!("sqlite3_column_type",unsafe extern "C" fn(Raw,c_int)->c_int);
    let integer=symbol!("sqlite3_column_int64",unsafe extern "C" fn(Raw,c_int)->i64);
    let real=symbol!("sqlite3_column_double",unsafe extern "C" fn(Raw,c_int)->f64);
    let text=symbol!("sqlite3_column_text",unsafe extern "C" fn(Raw,c_int)->*const u8);
    let size=symbol!("sqlite3_column_bytes",unsafe extern "C" fn(Raw,c_int)->c_int);
    struct Db(Raw,unsafe extern "C" fn(Raw)->c_int);impl Drop for Db{fn drop(&mut self){unsafe{(self.1)(self.0);}}}
    struct Statement(Raw,unsafe extern "C" fn(Raw)->c_int);impl Drop for Statement{fn drop(&mut self){unsafe{(self.1)(self.0);}}}
    let filename=CString::new(path.to_str().ok_or_else(||failure("unsupported_target","SQLite path is not UTF8"))?).unwrap();
    let mut db=ptr::null_mut();let opened=open(filename.as_ptr(),&mut db,1|0x8000|0x40000,ptr::null()); // READONLY, NOMUTEX, PRIVATECACHE.
    if db.is_null(){return Err(failure("provider_failed","SQLite connection allocation failed"));}let db=Db(db,close);
    if opened!=0||readonly(db.0,c"main".as_ptr())!=1{return Err(failure("permission_denied","SQLite could not open a read-only connection"));}
    if authorizer(db.0,Some(authorize),ptr::null_mut())!=0{return Err(failure("provider_failed","SQLite SQL authorization could not be installed"));}
    set_progress(db.0,1000,Some(progress),(&raw const deadline).cast_mut().cast());
    for (id,value)in[(0,1048576),(1,65536),(2,256),(3,128),(4,100),(5,1000000),(7,0),(9,128)]{limit(db.0,id,value);}
    let sql=CString::new(sql).unwrap();let mut cursor=sql.as_ptr();let end=cursor.add(sql.as_bytes().len());let mut results=vec![];let mut result_bytes=2;let mut statements=0;
    while cursor<end{
        if Instant::now()>=deadline{return Err(failure("resource_limit","SQLite query deadline expired"));}
        let mut statement=ptr::null_mut();let mut tail=ptr::null();
        let status=prepare(db.0,cursor,(end.offset_from(cursor)+1)as c_int,&mut statement,&mut tail);
        let statement=(!statement.is_null()).then(||Statement(statement,finalize));
        if status!=0{return Err(failure(if status==23{"permission_denied"}else if status==9{"resource_limit"}else{"provider_failed"},"SQLite refused or interrupted the SQL statement"));}
        if tail.is_null()||tail<=cursor||tail>end{return Err(failure("provider_failed","SQLite returned an invalid statement boundary"));}cursor=tail;
        let Some(statement)=statement else{continue};statements+=1;
        if statements>128{return Err(failure("resource_limit","SQLite exceeds 128 statements"));}
        let columns=count(statement.0);if !(0..=256).contains(&columns){return Err(failure("resource_limit","SQLite column count exceeds its bound"));}
        let mut names=vec![];
        for col in 0..columns{
            let raw=name(statement.0,col);if raw.is_null(){return Err(failure("provider_failed","SQLite omitted a column name"));}
            let name=CStr::from_ptr(raw).to_str().map_err(|_|failure("unsupported_target","SQLite column name is not UTF8"))?.to_owned();
            if name.len()>1024||names.contains(&name){return Err(failure("unsupported_target","SQLite columns need distinct bounded names; use SQL aliases"));}names.push(name);
        }
        loop{
            match step(statement.0){
                101=>break,
                100=>{
                    if results.len()>=4096{return Err(failure("resource_limit","SQLite result exceeds 4096 rows"));}
                    let mut row=Map::new();
                    for col in 0..columns{
                        let value=match kind(statement.0,col){
                            1=>{let n=integer(statement.0,col);if !(-9007199254740991..=9007199254740991).contains(&n){return Err(failure("unsupported_target","SQLite integer exceeds exact JavaScript precision; cast it to text"));}json!(n)},
                            2=>{let n=real(statement.0,col);if !n.is_finite(){return Err(failure("unsupported_target","SQLite returned a nonfinite number"));}json!(n)},
                            3=>{let bytes=text(statement.0,col);let length=size(statement.0,col);if bytes.is_null()||!(0..=1048576).contains(&length){return Err(failure("resource_limit","SQLite text storage is unavailable or too large"));}let text=std::str::from_utf8(std::slice::from_raw_parts(bytes,length as usize)).map_err(|_|failure("unsupported_target","SQLite text is not UTF8"))?;json!(text)},
                            5=>Value::Null,
                            _=>return Err(failure("unsupported_target","SQLite binary columns require an explicit SQL text encoding")),
                        };row.insert(names[col as usize].clone(),value);
                    }
                    result_bytes+=serde_json::to_vec(&row).map_err(|_|failure("provider_failed","SQLite result serialization failed"))?.len()+1;
                    if result_bytes>1048576{return Err(failure("resource_limit","SQLite result exceeds 1 MiB"));}results.push(Value::Object(row));
                }
                9=>return Err(failure("resource_limit","SQLite query deadline expired")),
                _=>return Err(failure("provider_failed","SQLite did not finish the query; no partial rows returned")),
            }
        }
    }
    Ok(Value::Array(results))
}}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn sql_authorizer_blocks_writes_and_attachment(){unsafe{
        for operation in [1,9,18,22,23,24,25,26,28]{assert_eq!(authorize(ptr::null_mut(),operation,ptr::null(),ptr::null(),ptr::null(),ptr::null()),1);}
        for operation in [20,21,33]{assert_eq!(authorize(ptr::null_mut(),operation,ptr::null(),ptr::null(),ptr::null(),ptr::null()),0);}
        assert_eq!(authorize(ptr::null_mut(),31,ptr::null(),c"load_extension".as_ptr(),ptr::null(),ptr::null()),1);
    }}
}
