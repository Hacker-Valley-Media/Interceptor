//! Actual Linux protocol qualification client. No display or target fixtures.
#[cfg(target_os="linux")]
fn main(){
    use interceptor_desktop::linux_pointer::PointerConnection;
    use std::os::unix::net::UnixStream;
    let mut args=std::env::args().skip(1);
    let display=args.next().expect("owned display socket");
    let command=args.next().expect("bounded pointer command");
    let result=UnixStream::connect(display).map_err(|error|serde_json::json!({"success":false,"code":"background_unavailable","error":error.to_string(),"dispatched":false}))
        .and_then(|stream|PointerConnection::connect(stream).map_err(|error|serde_json::to_value(error).unwrap()))
        .and_then(|mut connection|connection.execute(&command).map_err(|error|serde_json::to_value(error).unwrap()));
    match result{
        Ok(reply)=>println!("{}",serde_json::to_string(&reply).unwrap()),
        Err(mut error)=>{error["success"]=serde_json::json!(false);println!("{error}");}
    }
}
#[cfg(not(target_os="linux"))]
fn main(){panic!("Linux native protocol qualification requires Linux");}
