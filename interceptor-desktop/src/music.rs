//! User-owned local music through a private MPD0.24.5 process. No existing
//! player, remote library or Apple Music account is selected implicitly.
use crate::{contract_generated::*,failure,success};
use serde_json::{Value,json};
use std::{collections::VecDeque,fs,io::{self,Read,Write},path::{Path,PathBuf},process::{Command,Stdio},sync::Mutex,time::{Duration,Instant}};
type Result<T>=std::result::Result<T,Value>;
type Fields=Vec<(String,String)>;
struct Session{media:Option<crate::audio::AudioSession>,scratch:PathBuf}
impl Drop for Session{fn drop(&mut self){drop(self.media.take());let _=fs::remove_dir_all(&self.scratch);}}
static SESSION:Mutex<Option<Session>>=Mutex::new(None);
/// Contract reply for a system-player repeat/shuffle change the player accepted: the accepted
/// mode, exactly the DesktopMusicRepeat/DesktopMusicShuffle shape the Mac returns.
pub(crate) fn mode_reply(a:&Value)->Option<Value>{match a["sub"].as_str()?{"repeat"=>Some(json!({"repeatMode":a["mode"]})),"shuffle"=>Some(json!({"shuffleMode":a["mode"]})),_=>None}}
fn bounded(v:&Value,max:usize)->bool{v.as_str().is_some_and(|s|!s.trim().is_empty()&&s.len()<=max&&!s.contains('\0'))}
fn validate(a:&Value)->Result<()>{
    if let Some(error)=desktop_music_shape_error(a){return Err(failure("invalid_request",error));}
    // The Apple Music catalog is reached only through Apple's MusicKit framework.
    if let Some(sub)=a["sub"].as_str().filter(|s|matches!(*s,"search"|"search-suggest"|"charts"|"recommendations"|"song"|"album"|"artist"|"playlist")){
        return Err(failure("unsupported_operation",format!("music {sub} reads the Apple Music catalog, which only Apple's MusicKit on macOS can reach; nothing was requested. On this host use music library or library-search for your local library")));
    }
    let fields:&[&str]=match a["sub"].as_str().unwrap(){
        "library"=>&["kind","limit","offset","filter","sort","ascending","include_tracks"],"library-search"=>&["term","types","limit","top","include_tracks"],"play"=>&["song","album","playlist"],"seek"=>&["time"],"repeat"|"shuffle"=>&["mode"],"now-playing"=>&["include_system"],_=>&[]};
    for key in ["kind","limit","offset","filter","sort","ascending","include_tracks","term","types","top","song","album","playlist","time","mode","include_system"]{if a.get(key).is_some()&&!fields.contains(&key){return Err(failure("invalid_request","Music field does not belong to its selector"));}}
    for key in ["group","groupColor"]{if a.get(key).is_some_and(|v|!bounded(v,256)){return Err(failure("invalid_request","invalid Music group text"));}}
    for key in ["term","filter"]{if a.get(key).is_some_and(|v|!bounded(v,4096)){return Err(failure("invalid_request","invalid bounded Music query"));}}
    for(key,min,max)in[("limit",1.0,100.0),("offset",0.0,10000.0),("time",0.0,604800.0)]{if a.get(key).is_some_and(|v|v.as_f64().is_none_or(|n|!n.is_finite()||n<min||n>max||key!="time"&&n.fract()!=0.0)){return Err(failure("invalid_request","invalid numeric Music field"));}}
    if a["sub"]=="seek"&&a.get("time").is_none()||a["sub"]=="library-search"&&!bounded(&a["term"],4096){return Err(failure("invalid_request","Music selector requires its time or query"));}
    if a.get("types").is_some_and(|v|!bounded(v,128)||v.as_str().unwrap().split(',').any(|s|!matches!(s.trim(),"song"|"album"|"artist"|"playlist"))){return Err(failure("invalid_request","unknown Music search type"));}
    let kind=a["kind"].as_str().unwrap_or("song");
    if a.get("sort").is_some_and(|v|if matches!(kind,"artist"|"playlist"){v!="name"}else{v!="title"&&v!="artistName"})||a.get("ascending").is_some()&&a.get("sort").is_none(){return Err(failure("invalid_request","Music sort does not belong to its library kind"));}
    if a["sub"]=="library"&&a["include_tracks"]==true&&!matches!(kind,"album"|"playlist"){return Err(failure("invalid_request","Music track expansion requires album or playlist"));}
    if a["sub"]=="play"{let keys=["song","album","playlist"].into_iter().filter(|k|a.get(k).is_some()).collect::<Vec<_>>();if keys.len()!=1||!bounded(&a[keys[0]],1024){return Err(failure("invalid_request","Music play requires exactly one retained library id"));}}
    if a["sub"]=="repeat"&&!matches!(a["mode"].as_str(),Some("off"|"one"|"all"))||a["sub"]=="shuffle"&&!matches!(a["mode"].as_str(),Some("off"|"songs")){return Err(failure("invalid_request","unknown Music repeat/shuffle mode"));}
    Ok(())
}
pub fn dispatch(a:&Value)->Value{
    if let Err(error)=validate(a){return error;}
    let deadline=Instant::now()+Duration::from_secs(32);
    let Ok(mut state)=SESSION.try_lock()else{return failure("resource_limit","another Music request is active; no work queued");};
    if a["sub"]=="now-playing"{
        let mut request=a.clone();request.as_object_mut().unwrap().remove("include_system");
        let mut data=if let Some(session)=state.as_mut(){
            match session.media.as_mut().unwrap().request(&request,Duration::from_secs(25)){
                Ok(result)if result["success"]==true=>result["data"].clone(),Ok(error)=>return error,Err(error)=>{state.take();return error;},
            }
        }else{json!({"status":"notInitialized","playbackRate":null,"playbackTime":null,"repeatMode":"unknown","shuffleMode":"unknown","queueLength":0,"note":"No application music player has been initialized by this provider."})};
        if a["include_system"]==true{
            match crate::thumbnail::image_helper("--music-system-engine",a,deadline.min(Instant::now()+Duration::from_secs(8))){Ok(system)=>data["system"]=system,Err(error)=>return error}
        }
        return success(data);
    }
    // Without an owned MPD player, transport controls act on the system player (MPRIS on Linux,
    // GlobalSystemMediaTransportControls on Windows), and status reports what is available.
    let transport=matches!(a["sub"].as_str(),Some("pause"|"resume"|"stop"|"next"|"previous"|"seek"|"repeat"|"shuffle"));
    let library=crate::native_library::pinned_spec("INTERCEPTOR_MPD_EXECUTABLE").is_ok();
    if state.is_none()&&!library&&a["sub"]=="status"{
        return success(json!({"authorization":"authorized","frameworkAvailable":true,"applicationPlayerAvailable":false,"libraryAvailable":false,"provider":if cfg!(windows){"Windows.Media.Control system player; library playback needs the mpd engine"}else{"MPRIS system player; library playback needs the mpd engine"}}));
    }
    if state.is_none()&&!library&&a["sub"]=="request"{return success(json!({"authorization":"authorized"}));}
    if state.is_none()&&transport{
        return match crate::thumbnail::image_helper("--music-system-engine",a,deadline.min(Instant::now()+Duration::from_secs(8))){Ok(data)=>success(data),Err(error)=>error};
    }
    if state.is_none(){
        let scratch=match crate::filesystem::temp_dir(){Ok(root)=>root.join(format!("interceptor-music-{}",crate::monitor::identifier())),Err(e)=>return failure("provider_failed",e)};
        if let Err(e)=crate::monitor::private_directory(&scratch,true,false){return failure("permission_denied",e);}
        let mut session=Session{media:None,scratch};
        match crate::audio::AudioSession::start_owned(&json!({"action":{"type":"desktop_music","sub":"status"},"scratch":session.scratch}),"--music-engine"){
            Ok((media,_))=>session.media=Some(media),Err(error)=>return error,
        }
        *state=Some(session);
    }
    let result=state.as_mut().unwrap().media.as_mut().unwrap().request(a,Duration::from_secs(25).min(deadline.saturating_duration_since(Instant::now())));
    match result{
        Ok(reply)=>{if state.as_ref().unwrap().media.as_ref().unwrap().terminal.is_some(){state.take();}reply},
        Err(error)=>{state.take();failure("timeout_unknown_outcome",format!("owned Music player failed or exceeded its deadline; it was killed and reaped, no control was replayed; receipt: {error}"))},
    }
}
pub fn shutdown()->Value{
    let Ok(mut state)=SESSION.try_lock()else{return failure("resource_limit","Music request still owns its player");};
    let Some(mut session)=state.take()else{return success(json!({"ok":true}));};
    session.media.take().unwrap().stop_with(&json!({"type":"desktop_music","sub":"_shutdown"}))
}
pub(crate) fn poll_exits(){if let Ok(mut state)=SESSION.try_lock(){if let Some(session)=state.as_mut(){session.media.as_mut().unwrap().poll_exit();}}}
fn quote(text:&str)->Result<String>{
    if text.len()>4096||text.contains(['\0','\n','\r']){return Err(failure("invalid_request","native Music argument exceeds its text boundary"));}
    Ok(format!("\"{}\"",text.replace('\\',"\\\\").replace('"',"\\\"")))
}
// A colon is an ordinary file name character ("Live: 01.flac"); only a scheme or a drive prefix leaves the library.
fn local_uri(text:&str)->bool{
    !text.is_empty()&&text.len()<=4096&&!text.contains(['\0','\r','\n','\\'])&&!text.contains("://")&&!(text.as_bytes()[0].is_ascii_alphabetic()&&text.as_bytes().get(1)==Some(&b':'))&&!text.starts_with('/')&&text.split('/').all(|v|!v.is_empty()&&v!="."&&v!="..")
}
fn field<'a>(rows:&'a Fields,key:&str)->Option<&'a str>{rows.iter().find(|(k,_)|k==key).map(|(_,v)|v.as_str())}
fn count(rows:&Fields,key:&str)->Result<usize>{field(rows,key).and_then(|v|v.parse::<usize>().ok()).filter(|n|*n<=2000).ok_or_else(||failure("provider_failed",format!("native Music {key} is absent or exceeds 2000")))}
fn songs(rows:Fields)->Result<Vec<Fields>>{
    let mut out=Vec::new();let mut current=Fields::new();
    for(key,value)in rows{
        if matches!(key.as_str(),"file"|"directory"|"playlist"){
            if !current.is_empty(){out.push(std::mem::take(&mut current));}
            if key=="file"{if !local_uri(&value){return Err(failure("unsupported_target","Music database contains a non-local or unsafe URI"));}current.push((key,value));}
        }else if !current.is_empty(){current.push((key,value));}
        if out.len()>2000{return Err(failure("resource_limit","Music metadata exceeds 2000 native songs"));}
    }
    if !current.is_empty(){out.push(current);}if out.len()>2000{return Err(failure("resource_limit","Music metadata exceeds 2000 native songs"));}Ok(out)
}
fn song_data(row:&Fields,id:&str)->Result<Value>{
    let uri=field(row,"file").ok_or_else(||failure("provider_failed","native Music item lacks a URI"))?;
    let title=field(row,"Title").filter(|v|!v.is_empty()).unwrap_or_else(||uri.rsplit('/').next().unwrap());
    let mut data=json!({"id":id,"title":title});if let Some(artist)=field(row,"Artist"){data["artistName"]=json!(artist);}Ok(data)
}
#[cfg(target_os="linux")]type Socket=std::os::unix::net::UnixStream;
#[cfg(windows)]type Socket=std::net::TcpStream;
#[cfg(not(any(windows,target_os="linux")))]type Socket=std::net::TcpStream;
#[cfg(target_os="linux")]type Identity=crate::linux::CaptureIdentity;
#[cfg(windows)]type Identity=crate::windows::CaptureIdentity;
#[cfg(not(any(windows,target_os="linux")))]struct Identity;
#[cfg(not(any(windows,target_os="linux")))]impl Identity{fn alive(&self)->bool{false}}
struct Client{socket:Socket,pending:Vec<u8>,identity:Identity,healthy:bool}
impl Client{
    fn line(&mut self,deadline:Instant)->Result<String>{
        loop{
            if !self.identity.alive(){return Err(failure("target_gone","retained native Music process or login ended"));}
            if Instant::now()>=deadline{return Err(failure("timeout_unknown_outcome","native Music protocol exceeded its deadline; no command replay"));}
            if let Some(at)=self.pending.iter().position(|b|*b==b'\n'){
                let line=self.pending.drain(..=at).collect::<Vec<_>>();
                if at>8192{return Err(failure("resource_limit","native Music line exceeds 8192 bytes"));}
                return String::from_utf8(line[..at].to_vec()).map_err(|_|failure("provider_failed","native Music response is not UTF8"));
            }
            if self.pending.len()>8192{return Err(failure("resource_limit","native Music line exceeds 8192 bytes"));}
            let mut buffer=[0u8;4096];match self.socket.read(&mut buffer){
                Ok(0)=>return Err(failure("target_gone","owned native Music connection ended")),Ok(n)=>self.pending.extend_from_slice(&buffer[..n]),
                Err(e)if matches!(e.kind(),io::ErrorKind::WouldBlock|io::ErrorKind::TimedOut|io::ErrorKind::Interrupted)=>(),Err(_)=>return Err(failure("provider_failed","native Music protocol read failed")),
            }
        }
    }
    fn command(&mut self,command:&str,deadline:Instant)->Result<Fields>{
        if !self.identity.alive()||Instant::now()>=deadline{return Err(failure("target_gone","native Music target/request ended before dispatch"));}
        self.healthy=false;
        self.socket.write_all(command.as_bytes()).and_then(|_|self.socket.write_all(b"\n")).map_err(|_|failure("timeout_unknown_outcome","native Music write failed; outcome is unknown and was not replayed"))?;
        let mut rows=Vec::new();let mut bytes=0;
        loop{
            let line=self.line(deadline)?;bytes+=line.len();if bytes>4_194_304||rows.len()>32768{return Err(failure("resource_limit","native Music response exceeds 4MiB or 32768 fields"));}
            if line=="OK"{self.healthy=true;return Ok(rows);}
            if line.starts_with("ACK "){self.healthy=true;return Err(failure(if line.starts_with("ACK [4@"){"permission_denied"}else{"provider_failed"},format!("native Music command refused: {}",line.chars().take(800).collect::<String>())));}
            let(key,value)=line.split_once(": ").ok_or_else(||failure("provider_failed","native Music response field is malformed"))?;
            if key.is_empty()||key.len()>128||value.len()>4096||line.contains('\0'){return Err(failure("resource_limit","native Music metadata field exceeds bounds"));}rows.push((key.into(),value.into()));
        }
    }
}
fn fingerprint(rows:&[Fields])->Result<String>{use sha2::{Digest,Sha256};let bytes=serde_json::to_vec(rows).map_err(|_|failure("provider_failed","native Music metadata cannot be fingerprinted"))?;Ok(Sha256::digest(bytes).iter().map(|b|format!("{b:02x}")).collect())}
#[derive(Clone,PartialEq)]enum Target{Song(String,String),Album(String,String,String),Artist(String),Playlist(String,String)}
struct Retained{id:String,at:Instant,target:Target}
struct Player{client:Client,_process:crate::auth::AuthChild,items:VecDeque<Retained>}
impl Player{
    fn retain(&mut self,target:Target)->Result<String>{
        let now=Instant::now();self.items.retain(|i|now.duration_since(i.at)<=Duration::from_secs(300));
        if let Some(item)=self.items.iter().find(|i|i.target==target){return Ok(item.id.clone());}
        let id=format!("M-{}",crate::secret_target::random_token().map_err(|_|failure("provider_failed","native Music identity generation failed"))?);
        if self.items.len()==8192{self.items.pop_front();}self.items.push_back(Retained{id:id.clone(),at:now,target});Ok(id)
    }
    fn database(&mut self,deadline:Instant)->Result<Vec<Fields>>{
        self.client.command("update",deadline)?;
        while field(&self.client.command("status",deadline)?,"updating_db").is_some(){std::thread::sleep(Duration::from_millis(50));}
        songs(self.client.command("listallinfo",deadline)?)
    }
    fn playlist(&mut self,name:&str,deadline:Instant)->Result<Vec<Fields>>{songs(self.client.command(&format!("listplaylistinfo {}",quote(name)?),deadline)?)}
    fn library(&mut self,kind:&str,database:&[Fields],deadline:Instant)->Result<Vec<Value>>{
        let mut items=Vec::new();
        match kind{
            "song"|"track"=>for row in database{let id=self.retain(Target::Song(field(row,"file").unwrap().into(),fingerprint(std::slice::from_ref(row))?))?;items.push(song_data(row,&id)?);},
            "album"=>{
                let mut albums:std::collections::BTreeMap<(String,String),Vec<Fields>>=std::collections::BTreeMap::new();
                for row in database{if let Some(title)=field(row,"Album").filter(|v|!v.is_empty()){let artist=field(row,"AlbumArtist").or_else(||field(row,"Artist")).unwrap_or("");albums.entry((title.into(),artist.into())).or_default().push(row.clone());}}
                for((title,artist),rows)in albums{let id=self.retain(Target::Album(title.clone(),artist.clone(),fingerprint(&rows)?))?;let mut item=json!({"id":id,"title":title});if !artist.is_empty(){item["artistName"]=json!(artist);}items.push(item);}
            },
            "artist"=>{
                let mut artists=std::collections::BTreeSet::new();for row in database{for(key,value)in row{if key=="Artist"&&!value.is_empty(){artists.insert(value.clone());}}}
                for name in artists{let id=self.retain(Target::Artist(name.clone()))?;items.push(json!({"id":id,"name":name}));}
            },
            "playlist"=>{
                let rows=self.client.command("listplaylists",deadline)?;let names=rows.into_iter().filter(|(k,_)|k=="playlist").map(|(_,v)|v).collect::<Vec<_>>();
                if names.len()>100{return Err(failure("resource_limit","Music stored playlists exceed 100"));}
                for name in names{
                    let rows=self.playlist(&name,deadline)?;
                    if rows.iter().any(|row|!database.iter().any(|known|field(known,"file")==field(row,"file"))){return Err(failure("unsupported_target","native playlist contains a track outside the local music database"));}
                    let id=self.retain(Target::Playlist(name.clone(),fingerprint(&rows)?))?;items.push(json!({"id":id,"name":name}));
                }
            },_=>return Err(failure("invalid_request","unknown Music library kind")),
        }
        Ok(items)
    }
    fn track_rows(&mut self,rows:&[Fields])->Result<Vec<Value>>{rows.iter().map(|row|{let id=self.retain(Target::Song(field(row,"file").unwrap().into(),fingerprint(std::slice::from_ref(row))?))?;song_data(row,&id)}).collect()}
    fn expand(&mut self,items:&mut[Value],database:&[Fields],deadline:Instant)->Result<()>{
        let mut bytes=0;
        for item in items{
            let target=self.items.iter().find(|row|item["id"].as_str()==Some(row.id.as_str())).map(|row|row.target.clone()).ok_or_else(||failure("stale_reference","native Music item expired during track expansion"))?;
            let rows=match target{
                Target::Album(title,artist,digest)=>{let rows=database.iter().filter(|row|field(row,"Album")==Some(title.as_str())&&field(row,"AlbumArtist").or_else(||field(row,"Artist")).unwrap_or("")==artist).cloned().collect::<Vec<_>>();if fingerprint(&rows)?!=digest{return Err(failure("stale_reference","native album metadata changed during expansion"));}Some(rows)},
                Target::Playlist(name,digest)=>{let rows=self.playlist(&name,deadline)?;if fingerprint(&rows)?!=digest{return Err(failure("stale_reference","native playlist metadata changed during expansion"));}Some(rows)},_=>None,
            };
            if let Some(rows)=rows{item["tracks"]=json!(self.track_rows(&rows)?);}
            bytes+=serde_json::to_vec(&*item).map_err(|_|failure("provider_failed","native expanded Music metadata is invalid"))?.len();
            if bytes>1_048_000{return Err(failure("resource_limit","requested Music track expansion exceeds 1MiB; request fewer library items"));}
        }
        Ok(())
    }
    fn snapshot(&mut self,deadline:Instant)->Result<Value>{
        let status=self.client.command("status",deadline)?;
        if let Some(error)=field(&status,"error"){return Err(failure("provider_failed",format!("native Music playback failed: {error}")));}
        let state=match field(&status,"state"){Some("play")=>"playing",Some("pause")=>"paused",Some("stop")=>"stopped",_=>return Err(failure("provider_failed","native Music playback state is missing or unknown"))};
        let repeat=match(field(&status,"repeat"),field(&status,"single")){(Some("0"),_)=>"off",(Some("1"),Some("1"))=>"one",(Some("1"),Some("0"))=>"all",_=>return Err(failure("provider_failed","native Music repeat state is unknown"))};
        let shuffle=match field(&status,"random"){Some("0")=>"off",Some("1")=>"songs",_=>return Err(failure("provider_failed","native Music shuffle state is unknown"))};
        let position=observed_elapsed(field(&status,"elapsed"))?;
        let mut data=json!({"status":state,"playbackRate":null,"playbackTime":position,"repeatMode":repeat,"shuffleMode":shuffle,"queueLength":count(&status,"playlistlength")?,"note":"Owned local MPD player; native elapsed is null when absent. MPD does not expose playback-rate measurement or cloud Apple Music subscription. Top results use deterministic local title/name matching."});
        let rows=songs(self.client.command("currentsong",deadline)?)?;
        if let Some(row)=rows.first(){let id=self.retain(Target::Song(field(row,"file").unwrap().into(),fingerprint(std::slice::from_ref(row))?))?;data["currentEntry"]=song_data(row,&id)?;}Ok(data)
    }
    fn action(&mut self,a:&Value,deadline:Instant)->Result<Value>{
        validate(a)?;
        match a["sub"].as_str().unwrap(){
            "status"=>{self.client.command("status",deadline)?;Ok(json!({"authorization":"filesystem-access","frameworkAvailable":true,"applicationPlayerAvailable":true,"libraryAvailable":true,"provider":"owned-local-MPD0.24.5"}))},
            "request"=>{self.client.command("status",deadline)?;Ok(json!({"authorization":"filesystem-access"}))},
            "subscription"=>Ok(json!({"canBecomeSubscriber":false,"canPlayCatalogContent":false,"hasCloudLibraryEnabled":false})),
            "library"|"library-search"=>{
                let database=self.database(deadline)?;let limit=a["limit"].as_f64().unwrap_or(32.0)as usize;
                if a["sub"]=="library"{
                    let mut rows=self.library(a["kind"].as_str().unwrap_or("song"),&database,deadline)?;
                    if let Some(query)=a["filter"].as_str(){let term=query.to_lowercase();rows.retain(|r|["title","name","artistName"].iter().any(|k|r[*k].as_str().is_some_and(|v|v.to_lowercase().contains(&term))));}
                    if let Some(sort)=a["sort"].as_str(){rows.sort_by(|x,y|x[sort].as_str().unwrap_or("").to_lowercase().cmp(&y[sort].as_str().unwrap_or("").to_lowercase()));if a["ascending"]==false{rows.reverse();}}
                    let mut rows=rows.into_iter().skip(a["offset"].as_f64().unwrap_or(0.0)as usize).take(limit).collect::<Vec<_>>();
                    if a["include_tracks"]==true{self.expand(&mut rows,&database,deadline)?;}Ok(json!({"items":rows}))
                }else{
                    let term=a["term"].as_str().unwrap().to_lowercase();let types=a["types"].as_str().unwrap_or("song,album,artist,playlist").split(',').map(str::trim).collect::<Vec<_>>();
                    let mut result=json!({"term":a["term"],"songs":[],"albums":[],"artists":[],"playlists":[]});let mut top=Vec::new();
                    for kind in["song","album","artist","playlist"]{if !types.contains(&kind){continue;}
                        let mut rows=self.library(kind,&database,deadline)?;rows.retain(|r|["title","name","artistName"].iter().any(|k|r[*k].as_str().is_some_and(|v|v.to_lowercase().contains(&term))));
                        rows.sort_by_key(|r|{let text=r["title"].as_str().or_else(||r["name"].as_str()).unwrap_or("").to_lowercase();(text!=term,!text.starts_with(&term),text)});rows.truncate(limit);
                        if a["include_tracks"]==true{self.expand(&mut rows,&database,deadline)?;}top.extend(rows.clone());result[format!("{kind}s")]=json!(rows);
                        if serde_json::to_vec(&result).map_or(true,|v|v.len()>1_048_000){return Err(failure("resource_limit","expanded Music search exceeds 1MiB; request fewer items"));}
                    }
                    if a["top"]==true{top.sort_by_key(|r|{let text=r["title"].as_str().or_else(||r["name"].as_str()).unwrap_or("").to_lowercase();(text!=term,!text.starts_with(&term),text)});top.truncate(limit);result["topResults"]=json!(top);}Ok(result)
                }
            },
            "queue"=>{let status=self.client.command("status",deadline)?;count(&status,"playlistlength")?;let rows=songs(self.client.command("playlistinfo",deadline)?)?;let entries=self.track_rows(&rows)?;Ok(json!({"count":entries.len(),"entries":entries}))},
            "now-playing"=>self.snapshot(deadline),
            "play"=>{
                let key=["song","album","playlist"].into_iter().find(|k|a.get(k).is_some()).unwrap();let id=a[key].as_str().unwrap();
                let target=self.items.iter().find(|i|i.id==id&&i.at.elapsed()<=Duration::from_secs(300)).map(|i|i.target.clone()).ok_or_else(||failure("stale_reference","Music item expired, was evicted or belongs to another provider; read the library again"))?;
                let database=self.database(deadline)?;
                let rows=match target{
                    Target::Song(uri,digest)if key=="song"=>{let row=database.iter().find(|row|field(row,"file")==Some(uri.as_str())).ok_or_else(||failure("stale_reference","native Music song left the database"))?;if fingerprint(std::slice::from_ref(row))?!=digest{return Err(failure("stale_reference","retained native song metadata changed"));}vec![row.clone()]},
                    Target::Album(title,artist,digest)if key=="album"=>{let current=database.iter().filter(|row|field(row,"Album")==Some(title.as_str())&&field(row,"AlbumArtist").or_else(||field(row,"Artist")).unwrap_or("")==artist).cloned().collect::<Vec<_>>();if fingerprint(&current)?!=digest{return Err(failure("stale_reference","retained native album metadata changed"));}current},
                    Target::Playlist(name,digest)if key=="playlist"=>{let current=self.playlist(&name,deadline)?;if fingerprint(&current)?!=digest||current.iter().any(|r|!database.iter().any(|known|field(known,"file")==field(r,"file"))){return Err(failure("stale_reference","retained native playlist changed or contains non-local tracks"));}current},
                    _=>return Err(failure("stale_reference","Music item kind or native metadata changed before playback")),
                };
                if rows.is_empty()||rows.len()>2000{return Err(failure("unsupported_target","native Music target has no bounded local tracks"));}
                self.client.command("clear",deadline)?;
                for row in rows{self.client.command(&format!("add {}",quote(field(&row,"file").unwrap())?),deadline)?;}
                self.client.command("play",deadline)?;let observed=self.snapshot(deadline)?;
                if observed["status"]!="playing"{return Err(failure("timeout_unknown_outcome","native Music accepted play but active playback was not observed; no replay"));}Ok(json!({"ok":true,"playbackStatus":observed["status"]}))
            },
            "repeat"=>{
                let mode=a["mode"].as_str().unwrap();self.client.command(if mode=="one"{"single 1"}else{"single 0"},deadline)?;self.client.command(if mode=="off"{"repeat 0"}else{"repeat 1"},deadline)?;Ok(json!({"repeatMode":self.snapshot(deadline)?["repeatMode"]}))
            },
            "shuffle"=>{self.client.command(if a["mode"]=="songs"{"random 1"}else{"random 0"},deadline)?;Ok(json!({"shuffleMode":self.snapshot(deadline)?["shuffleMode"]}))},
            sub=>{
                let command=match sub{"pause"=>"pause 1".into(),"resume"=>"pause 0".into(),"stop"=>"stop".into(),"next"=>"next".into(),"previous"=>"previous".into(),"seek"=>format!("seekcur {}",a["time"].as_f64().unwrap()),_=>return Err(failure("invalid_request","unknown Music control"))};
                self.client.command(&command,deadline)?;let observed=self.snapshot(deadline)?;
                if matches!(sub,"pause"|"resume"|"stop")&&observed["status"]!=match sub{"pause"=>"paused","resume"=>"playing",_=>"stopped"}{return Err(failure("timeout_unknown_outcome","native Music accepted control but requested state was not observed; no replay"));}
                let mut result=json!({"ok":true,"playbackStatus":observed["status"]});if sub=="seek"{if !observed["playbackTime"].is_number(){return Err(failure("provider_failed","native Music seek has no observed elapsed position"));}result["playbackTime"]=observed["playbackTime"].clone();}Ok(result)
            },
        }
    }
}
fn observed_elapsed(value:Option<&str>)->Result<Option<f64>>{value.map(|v|v.parse::<f64>().ok().filter(|v|v.is_finite()&&*v>=0.0).ok_or_else(||failure("provider_failed","native Music elapsed position is invalid"))).transpose()}

#[cfg(any(windows,target_os="linux"))]fn start(root:&Path,deadline:Instant)->Result<Player>{
    let(path,bytes)=crate::native_library::pinned_bytes("INTERCEPTOR_MPD_EXECUTABLE",64*1024*1024)?;let _=path;
    let music=std::env::var("INTERCEPTOR_MUSIC_ROOT").map_err(|_|failure("not_installed","local music requires an explicit user-owned INTERCEPTOR_MUSIC_ROOT"))?;
    let music=crate::filesystem::absolute(&music)?;let metadata=fs::symlink_metadata(&music).map_err(|_|failure("permission_denied","native music directory is inaccessible"))?;
    if !metadata.is_dir()||metadata.file_type().is_symlink(){return Err(failure("invalid_request","native music requires a local regular directory"));}
    fs::read_dir(&music).map_err(|_|failure("permission_denied","native music directory cannot be read by the current GUI user"))?;
    #[cfg(target_os="linux")]{use std::os::unix::fs::MetadataExt;if metadata.uid()!=unsafe{libc::geteuid()}{return Err(failure("permission_denied","native music directory must belong to the current GUI user"));}}
    let executable=root.join(if cfg!(windows){"mpd.exe"}else{"mpd"});let mut binary=crate::monitor::private_file(&executable,true).map_err(|_|failure("permission_denied","private Music runtime could not be created"))?;
    binary.write_all(&bytes).and_then(|_|binary.sync_all()).map_err(|_|failure("provider_failed","private Music runtime could not be written"))?;drop(binary);
    #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;fs::set_permissions(&executable,fs::Permissions::from_mode(0o700)).map_err(|_|failure("permission_denied","private Music runtime is not executable"))?;}
    let mut version=Command::new(&executable);version.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]{use std::os::windows::process::CommandExt;version.creation_flags(0x08000000);}
    let mut version=crate::auth::AuthChild(version.spawn().map_err(|_|failure("not_installed","pinned MPD runtime could not start"))?);let mut output=version.0.stdout.take().unwrap();let mut text=Vec::new();
    loop{let mut buffer=[0u8;4096];match crate::auth::ready_read(&mut output,&mut buffer){Ok(0)=>break,Ok(n)=>{text.extend_from_slice(&buffer[..n]);if text.len()>65536{return Err(failure("resource_limit","MPD version output exceeds 64KiB"));}},Err(e)if e.kind()==io::ErrorKind::WouldBlock=>{if Instant::now()>=deadline{return Err(failure("resource_limit","MPD version check exceeded startup deadline"));}std::thread::sleep(Duration::from_millis(10));},Err(_)=>return Err(failure("provider_failed","MPD version query failed"))}}
    if !String::from_utf8(text).ok().and_then(|s|s.lines().next().map(str::to_owned)).is_some_and(|line|line=="Music Player Daemon 0.24.5"||line.starts_with("Music Player Daemon 0.24.5 (")){return Err(failure("version_mismatch","local music requires MPD0.24.5; the protocol greeting is not an executable version"));}
    let password=crate::secret_target::random_token().map_err(|_|failure("provider_failed","Music protocol token generation failed"))?;
    #[cfg(target_os="linux")]let address=root.join("socket").to_str().ok_or_else(||failure("invalid_request","native Music socket path is not UTF8"))?.to_owned();
    #[cfg(windows)]let port={let reserve=std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,0)).map_err(|_|failure("provider_failed","private Music port reservation failed"))?;reserve.local_addr().map_err(|_|failure("provider_failed","private Music port discovery failed"))?.port()};
    #[cfg(windows)]let address=format!("127.0.0.1:{port}");
    let string=|path:&Path|path.to_str().ok_or_else(||failure("invalid_request","Music path requires UTF8")).and_then(quote);
    let config=format!("music_directory {}\nplaylist_directory {}\nbind_to_address {}\ndatabase {{\n plugin \"simple\"\n path {}\n}}\nfollow_inside_symlinks \"no\"\nfollow_outside_symlinks \"no\"\nzeroconf_enabled \"no\"\ndefault_permissions \"\"\nlocal_permissions \"\"\npassword {}\nmax_playlist_length \"2000\"\nmax_output_buffer_size \"4096\"\nmax_command_list_size \"256\"\naudio_output {{\n type \"{}\"\n name \"Interceptor owned local music\"\n}}\n",string(&music)?,string(&music)?,quote(&address)?,string(&root.join("database"))?,quote(&format!("{password}@read,add,player,control,admin"))?,if cfg!(windows){"wasapi"}else{"pulse"});
    let configuration=root.join("mpd.conf");let mut file=crate::monitor::private_file(&configuration,true).map_err(|_|failure("permission_denied","private Music configuration unavailable"))?;file.write_all(config.as_bytes()).and_then(|_|file.sync_all()).map_err(|_|failure("provider_failed","Music configuration write failed"))?;drop(file);
    let mut command=Command::new(&executable);command.args(["--no-daemon","--stderr"]).arg(&configuration).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(target_os="linux")]unsafe{use std::os::unix::process::CommandExt;let parent=std::process::id();command.pre_exec(move||{if libc::prctl(libc::PR_SET_PDEATHSIG,libc::SIGKILL)!=0||libc::getppid()as u32!=parent{return Err(io::Error::other("Music helper parent changed"));}Ok(())});}
    #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    let mut process=crate::auth::AuthChild(command.spawn().map_err(|_|failure("provider_failed","owned MPD launch failed"))?);
    #[cfg(target_os="linux")]let identity=crate::linux::capture_identity(process.0.id())?;
    #[cfg(windows)]let identity=crate::windows::capture_identity(process.0.id())?;
    let socket=loop{
        if !identity.alive()||!matches!(process.0.try_wait(),Ok(None)){return Err(failure("provider_failed","owned MPD exited before authenticated startup"));}
        #[cfg(target_os="linux")]let connected=Socket::connect(&address);
        #[cfg(windows)]let connected=Socket::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(),Duration::from_millis(100));
        match connected{Ok(socket)=>break socket,Err(_)=>{if Instant::now()>=deadline{return Err(failure("resource_limit","owned MPD startup deadline exceeded"));}std::thread::sleep(Duration::from_millis(20));}}
    };
    #[cfg(target_os="linux")]unsafe{use std::os::fd::AsRawFd;let mut credential:libc::ucred=std::mem::zeroed();let mut length=std::mem::size_of::<libc::ucred>()as libc::socklen_t;if libc::getsockopt(socket.as_raw_fd(),libc::SOL_SOCKET,libc::SO_PEERCRED,(&raw mut credential).cast(),&mut length)!=0||length as usize!=std::mem::size_of::<libc::ucred>()||credential.pid as u32!=process.0.id()||credential.uid!=libc::geteuid(){return Err(failure("permission_denied","Music socket does not belong to the retained owned process"));}}
    #[cfg(windows)]crate::music_windows::verify_connection(&socket,process.0.id())?;
    socket.set_read_timeout(Some(Duration::from_millis(100))).and_then(|_|socket.set_write_timeout(Some(Duration::from_millis(500)))).map_err(|_|failure("provider_failed","Music protocol deadlines could not be established"))?;
    let mut client=Client{socket,pending:Vec::new(),identity,healthy:true};let greeting=client.line(deadline)?;
    if !greeting.starts_with("OK MPD 0.24."){return Err(failure("version_mismatch","owned native Music protocol is incompatible"));}
    client.command(&format!("password {}",quote(&password)?),deadline)?;
    Ok(Player{client,_process:process,items:VecDeque::new()})
}
#[cfg(any(windows,target_os="linux"))]pub fn helper(parent:u32)->io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    let initial:Value=serde_json::from_slice(&crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("Music helper requires its initial frame"))?)?;
    let reply=|r:&Value|{let bytes=serde_json::to_vec(r)?;if bytes.len()>1_048_576{crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(&failure("resource_limit","Music reply exceeds 1MiB"))?)}else{crate::write_frame(&mut io::stdout().lock(),&bytes)}};
    let initialized=(||->Result<Player>{
        if initial.as_object().is_none_or(|o|o.len()!=2)||initial.get("action").is_none(){return Err(failure("invalid_request","Music helper requires its exact owned initialization"));}
        validate(&initial["action"])?;
        let root=crate::filesystem::absolute(initial["scratch"].as_str().unwrap_or(""))?;crate::monitor::private_directory(&root,false,false).map_err(|_|failure("permission_denied","Music helper requires its private owned directory"))?;
        start(&root,Instant::now()+Duration::from_secs(8))
    })();
    let mut player=match initialized{Ok(player)=>player,Err(error)=>return reply(&error)};
    let status=match player.action(&initial["action"],Instant::now()+Duration::from_secs(1)){Ok(data)=>success(data),Err(error)=>error};reply(&status)?;
    let(commands,received)=std::sync::mpsc::sync_channel(2);
    std::thread::spawn(move||{let mut input=io::stdin().lock();loop{let result=crate::read_frame(&mut input);let end=!matches!(&result,Ok(Some(_)));if commands.send(result).is_err()||end{break;}}});
    loop{
        if !player.client.identity.alive(){reply(&failure("target_gone","retained Music process or GUI login ended; owned playback was revoked"))?;break;}
        let bytes=match received.recv_timeout(Duration::from_millis(100)){
            Ok(Ok(Some(bytes)))=>bytes,Ok(Ok(None))|Err(std::sync::mpsc::RecvTimeoutError::Disconnected)=>break,Ok(Err(error))=>return Err(error),Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>continue,
        };let action:Value=serde_json::from_slice(&bytes)?;
        if action==json!({"type":"desktop_music","sub":"_shutdown"}){let result=player.client.command("stop",Instant::now()+Duration::from_secs(1)).map(|_|success(json!({"ok":true}))).unwrap_or_else(|e|e);drop(player);reply(&result)?;return Ok(());}
        let result=match player.action(&action,Instant::now()+Duration::from_secs(23)){Ok(data)=>success(data),Err(error)=>{
            if matches!(action["sub"].as_str(),Some("play"|"pause"|"resume"|"stop"|"next"|"previous"|"seek"|"repeat"|"shuffle"))&&error["code"]=="provider_failed"{failure("partial_result",format!("native Music control failed; inspect current queue/state before retrying: {error}"))}else{error}
        }};reply(&result)?;
        if !player.client.healthy{break;}
    }
    Ok(())
}
#[cfg(not(any(windows,target_os="linux")))]pub fn helper(_:u32)->io::Result<()>{Err(io::Error::other("portable Music requires Windows or Linux"))}
pub fn system_helper(parent:u32)->io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    let action:Value=serde_json::from_slice(&crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("Music system observer requires its request"))?)?;
    let result=(||->Result<Value>{
        validate(&action)?;
        if matches!(action["sub"].as_str(),Some("pause"|"resume"|"stop"|"next"|"previous"|"seek"|"repeat"|"shuffle")){
            #[cfg(windows)]return crate::music_windows::system_control(&action);
            #[cfg(target_os="linux")]return crate::music_linux::system_control(&action);
        }
        if action["sub"]!="now-playing"||action["include_system"]!=true{return Err(failure("invalid_request","Music system observer requires explicit now-playing include-system"));}
        #[cfg(windows)]return crate::music_windows::system_snapshot();
        #[cfg(target_os="linux")]return crate::music_linux::system_snapshot();
        #[cfg(not(any(windows,target_os="linux")))]Err(failure("unsupported_operation","system music requires its native host provider"))
    })();
    let result=match result{Ok(data)=>success(data),Err(error)=>error};let bytes=serde_json::to_vec(&result)?;
    if bytes.len()>1_048_576{crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(&failure("resource_limit","system Music reply exceeds 1MiB"))?)}else{crate::write_frame(&mut io::stdout().lock(),&bytes)}
}
pub fn capability(session:&str)->Value{json!({"operation":"music","compiled":cfg!(any(windows,target_os="linux")),"present":cfg!(any(windows,target_os="linux")),"effective":false,"background":"semantic","permission":"unknown","session":session,"provider":"owned-local-MPD","versions":{"contract":"1","mpd":"0.24.5"},"limits":["Explicit readable local user music directory and SHA256-pinned static MPD runtime; native metadata, playlists and actual WASAPI or PulseAudio output. Playback never adopts an existing player or implies cloud subscription or permissions.","One owned player helper; 8-second initialization; 23-second native action; 2000 songs/queue entries; 100 stored playlists; 8192 opaque identities with 300-second leases; 4MiB protocol/1MiB reply bounds; provider/login/native process revocation.","Library filters and top results derive from actual local metadata; exact/prefix/substring title ordering is explicit. Absent elapsed/rate measurements remain null. Explicit system-player reads use an independent 8-second helper, native Windows media-session permission or one retained same-login Linux MPRIS player; multiple Linux players refuse ambiguity. Observer timeout does not stop owned playback.","Native assets, licenses/codecs, audio output, architectures, system-player permission, installed CLI/MCP, resource and parity qualification remain open."]})}

#[cfg(test)]mod tests{use super::*;
    #[test]fn strict_fields_and_command_quoting_precede_native_work(){for a in[json!({"type":"desktop_music","sub":"seek","time":"3"}),json!({"type":"desktop_music","sub":"play","song":"x","album":"y"}),json!({"type":"desktop_music","sub":"pause","song":"x"}),json!({"type":"desktop_music","sub":"library","kind":"artist","sort":"title"})]{assert!(validate(&a).is_err());}assert_eq!(quote("a\"b\\c").unwrap(),"\"a\\\"b\\\\c\"");assert!(quote("x\nclear").is_err());for uri in["../x","https://example.test/x","/etc/passwd","a\\b","a//b","C:/x","file:///outside"]{assert!(!local_uri(uri));}assert!(local_uri("Artist/Live: 01.flac"));}
    #[test]fn native_database_metadata_is_preserved_without_invented_labels(){let rows=vec![("directory".into(),"Artists".into()),("file".into(),"Artists/real.flac".into()),("Title".into(),"Actual title".into()),("Artist".into(),"Actual artist".into()),("file".into(),"untagged.wav".into())];let rows=songs(rows).unwrap();assert_eq!(rows.len(),2);assert_eq!(song_data(&rows[0],"id").unwrap()["title"],"Actual title");assert_eq!(song_data(&rows[1],"id").unwrap(),json!({"id":"id","title":"untagged.wav"}));assert!(songs(vec![("file".into(),"file:///outside".into())]).is_err());}
    #[test]fn missing_native_elapsed_remains_unavailable(){assert_eq!(observed_elapsed(None).unwrap(),None);for value in["NaN","Infinity","-1","bad"]{assert!(observed_elapsed(Some(value)).is_err());}assert_eq!(observed_elapsed(Some("3.25")).unwrap(),Some(3.25));}
}
