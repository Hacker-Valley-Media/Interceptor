// Owned native journal fixture for installed resource qualification.
// Uses the same Rust/libsystemd integration as the Linux provider.
#[cfg(target_os="linux")]
fn main(){
 use std::{ffi::c_int,time::{SystemTime,UNIX_EPOCH}};
 #[link(name="systemd")]
 unsafe extern "C"{fn sd_journal_sendv(fields:*const libc::iovec,count:c_int)->c_int;}
 let token=std::env::args().nth(1).expect("owned event token required");
 let mode=std::env::args().nth(2).expect("levels or oversize required");
 let mut emitted=Vec::new();
 let priorities:Vec<(&str,String)>=match mode.as_str(){
  "levels"=>vec![("3",format!("{token} ERROR 文件 café 😀")),("6",format!("{token} INFO 文件")),("7",format!("{token} DEBUG 文件"))],
  "oversize"=>vec![("3",format!("{token} {}", "X".repeat(1_048_577)))],
  _=>panic!("unknown owned fixture mode")
 };
 for (priority,message) in priorities{
  let fields=[format!("MESSAGE={message}"),format!("PRIORITY={priority}"),"SYSLOG_IDENTIFIER=InterceptorLogFixture".to_owned()];
  let vectors:Vec<libc::iovec>=fields.iter().map(|f|libc::iovec{iov_base:f.as_ptr().cast_mut().cast(),iov_len:f.len()}).collect();
  let status=unsafe{sd_journal_sendv(vectors.as_ptr(),vectors.len() as c_int)};
  assert_eq!(status,0,"native journal emission failed");
  let digest=<sha2::Sha256 as sha2::Digest>::digest(message.as_bytes()).iter().map(|byte|format!("{byte:02x}")).collect::<String>();
  emitted.push(serde_json::json!({"priority":priority,"messageBytes":message.len(),"sha256":digest}));
 }
 println!("{}",serde_json::json!({"token":token,"mode":mode,"unixMs":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis(),"emitted":emitted}));
}
#[cfg(not(target_os="linux"))]
fn main(){panic!("owned journal fixture requires Linux");}
