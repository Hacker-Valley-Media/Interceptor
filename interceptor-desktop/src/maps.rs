//! Local Photon search/completion and Valhalla routes. Native launch uses a
//! retained helper; missing services/data are failures, never synthetic places.
use crate::{contract_generated::*,failure,success};
use serde_json::{Value,json};
use std::{collections::VecDeque,io::{self,Read},sync::{Mutex,OnceLock,atomic::{AtomicUsize,Ordering}},time::{Duration,Instant}};
type Result<T>=std::result::Result<T,Value>;
static ACTIVE:AtomicUsize=AtomicUsize::new(0);
struct Permit;
impl Drop for Permit{fn drop(&mut self){ACTIVE.fetch_sub(1,Ordering::AcqRel);}}
struct Cache{items:VecDeque<(String,Instant,Value)>}
static CACHE:OnceLock<Mutex<Cache>>=OnceLock::new();
fn cache()->&'static Mutex<Cache>{CACHE.get_or_init(||Mutex::new(Cache{items:VecDeque::new()}))}
fn item(mut mark:Value)->Result<Value>{
    if crate::location::coordinates(&json!(format!("{},{}",mark["coordinate"][0],mark["coordinate"][1])),false).is_none(){return Err(failure("provider_failed","map item lacks valid WGS84 coordinates"));}
    let id=format!("B-{}",crate::secret_target::random_token().map_err(|_|failure("provider_failed","map item identity generation failed"))?);
    if mark.get("name").is_none(){mark["name"]=Value::Null;}
    let data=json!({"id":id,"name":mark["name"],"isCurrentLocation":false,"placemark":mark});
    let mut c=cache().lock().unwrap();let now=Instant::now();c.items.retain(|(_,at,_)|now.duration_since(*at)<=Duration::from_secs(300));
    if c.items.len()==128{c.items.pop_front();}c.items.push_back((id,now,data.clone()));Ok(data)
}
fn retained(id:&str)->Option<Value>{let mut c=cache().lock().unwrap();let now=Instant::now();c.items.retain(|(_,at,_)|now.duration_since(*at)<=Duration::from_secs(300));c.items.iter().find(|(key,_,_)|key==id).map(|(_,_,v)|v.clone())}
fn bounded(v:&Value,max:usize)->bool{v.as_str().is_some_and(|s|!s.trim().is_empty()&&s.len()<=max&&!s.contains('\0'))}
pub(crate) fn coordinate_uri(p:&Value)->Result<String>{
    let lat=p[0].as_f64().filter(|n|n.is_finite()&&n.abs()<=90.0).ok_or_else(||failure("invalid_request","map URI requires finite WGS84 latitude"))?;
    let lon=p[1].as_f64().filter(|n|n.is_finite()&&n.abs()<=180.0).ok_or_else(||failure("invalid_request","map URI requires finite WGS84 longitude"))?;
    // f64 Display emits decimal coordinates, while JSON may emit exponents.
    Ok(format!("geo:{lat},{lon}"))
}
fn region(v:&Value)->Option<Vec<f64>>{
    let s=v.as_str()?;if s.len()>128||!s.bytes().all(|c|c.is_ascii_whitespace()||b"0123456789+eE.,-".contains(&c)){return None;}
    let p=s.split(',').map(|s|s.trim().parse::<f64>().ok()).collect::<Option<Vec<_>>>()?;
    if p.len()!=4||p.iter().any(|n|!n.is_finite())||p[0].abs()>90.0||p[1].abs()>180.0||!(0.0..=180.0).contains(&p[2])||p[2]==0.0||!(0.0..=360.0).contains(&p[3])||p[3]==0.0{return None;}Some(p)
}
fn tokens<'a>(a:&'a Value,key:&str)->Vec<&'a str>{a[key].as_str().map(|s|s.split(',').map(str::trim).collect()).unwrap_or_default()}
fn validate(a:&Value)->Result<()>{
    if let Some(error)=desktop_maps_shape_error(a){return Err(failure("invalid_request",error));}
    let sub=a["sub"].as_str().unwrap();let owned:&[&str]=match sub{"search"|"complete"=>&["query","region","types","poi_categories","address_include","address_exclude","limit"],"reverse"=>&["coords"],"mapitem-open"=>&["id"],"directions"=>&["from","to","transport","requests_alternates"],_=>&["from","to","transport"]};
    for key in ["query","region","types","poi_categories","address_include","address_exclude","limit","coords","id","from","to","transport","requests_alternates"]{if a.get(key).is_some()&&!owned.contains(&key){return Err(failure("invalid_request","map field does not belong to its selector"));}}
    for key in ["group","groupColor"]{if a.get(key).is_some_and(|v|!bounded(v,256)){return Err(failure("invalid_request","invalid map group metadata"));}}
    if ["search","complete"].contains(&sub)&&!bounded(&a["query"],4096){return Err(failure("invalid_request","map query must contain 1..4096 bounded bytes"));}
    if a.get("region").is_some()&&region(&a["region"]).is_none(){return Err(failure("invalid_request","invalid finite map region"));}
    if a.get("limit").is_some_and(|v|v.as_f64().is_none_or(|n|!n.is_finite()||n.fract()!=0.0||!(1.0..=32.0).contains(&n))){return Err(failure("invalid_request","map limit must be an integer in 1..32"));}
    if tokens(a,"types").iter().any(|s|!["address","pointOfInterest","physicalFeature"].contains(s)){return Err(failure("invalid_request","unknown map result type"));}
    for key in ["poi_categories","address_include","address_exclude"]{if a.get(key).is_some()&&(!bounded(&a[key],4096)||tokens(a,key).len()>64||tokens(a,key).iter().any(|s|s.is_empty())){return Err(failure("invalid_request","invalid bounded map filter"));}}
    if a.get("address_include").is_some()&&a.get("address_exclude").is_some(){return Err(failure("invalid_request","map address include/exclude are mutually exclusive"));}
    if sub=="reverse"&&crate::location::coordinates(&a["coords"],false).is_none(){return Err(failure("invalid_request","map reverse requires finite latitude/longitude"));}
    if sub=="mapitem-open"&&!bounded(&a["id"],128){return Err(failure("invalid_request","map launch requires a retained id"));}
    if ["directions","eta"].contains(&sub){for key in ["from","to"]{if !bounded(&a[key],4096){return Err(failure("invalid_request","map route requires bounded source/destination"));}let s=a[key].as_str().unwrap();if s.contains(',')&&s.bytes().all(|c|c.is_ascii_whitespace()||b"0123456789+eE.,-".contains(&c))&&crate::location::coordinates(&a[key],false).is_none(){return Err(failure("invalid_request","malformed numeric route target"));}}}Ok(())
}
fn local_json(variable:&str,path:&str,query:&[(String,String)],deadline:Instant)->Result<Value>{
    let raw=std::env::var(variable).map_err(|_|failure("not_installed",format!("maps requires configured {variable} and local data; no query was sent")))?;
    let mut url=crate::http::local_origin(&raw,true)?;url.set_path(path);{let mut q=url.query_pairs_mut();for(k,v)in query{q.append_pair(k,v);}}
    let budget=deadline.checked_duration_since(Instant::now()).filter(|n|!n.is_zero()).ok_or_else(||failure("timeout_unknown_outcome","map deadline expired before dispatch"))?.min(Duration::from_secs(20));
    let client=reqwest::blocking::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never()).connect_timeout(budget.min(Duration::from_secs(3))).timeout(budget).build().map_err(|_|failure("provider_failed","local maps client initialization failed"))?;
    let mut response=client.get(url).header("User-Agent",concat!("Interceptor/",env!("CARGO_PKG_VERSION"))).send().map_err(|_|failure("timeout_unknown_outcome","local map request failed after dispatch; no replay"))?;
    if response.status()!=reqwest::StatusCode::OK{return Err(failure("provider_failed",format!("local map service returned HTTP{}; body withheld",response.status().as_u16())));}
    let mut bytes=Vec::new();response.by_ref().take(4_194_305).read_to_end(&mut bytes).map_err(|_|failure("provider_failed","local map response was interrupted"))?;
    if bytes.len()>4_194_304{return Err(failure("resource_limit","local map response exceeds 4MiB"));}
    serde_json::from_slice(&bytes).map_err(|_|failure("provider_failed","local map service returned malformed JSON"))
}
// With nothing configured, name the services first; blaming the data credit read as if one were set.
fn attribution()->Result<String>{let v=std::env::var("INTERCEPTOR_MAPS_ATTRIBUTION").map_err(|_|failure("not_installed",if ["INTERCEPTOR_PHOTON_URL","INTERCEPTOR_VALHALLA_URL"].iter().all(|k|std::env::var_os(k).is_none()){"maps needs self-hosted map services: set INTERCEPTOR_PHOTON_URL (search, complete) and INTERCEPTOR_VALHALLA_URL (directions, eta), plus INTERCEPTOR_MAPS_ATTRIBUTION with the credit line for that map data"}else{"set INTERCEPTOR_MAPS_ATTRIBUTION to the credit line for the configured map data (for example \"© OpenStreetMap contributors\")"}))?;if !bounded(&json!(v),4096){return Err(failure("invalid_request","map data attribution must be bounded text"));}Ok(v)}
fn poi_tag(category:&str)->Option<&'static str>{match category{
    "airport"=>Some("aeroway:aerodrome"),"amusementPark"=>Some("tourism:theme_park"),"aquarium"=>Some("tourism:aquarium"),"atm"=>Some("amenity:atm"),"bakery"=>Some("shop:bakery"),"bank"=>Some("amenity:bank"),"beach"=>Some("natural:beach"),"brewery"=>Some("craft:brewery"),"cafe"=>Some("amenity:cafe"),"campground"=>Some("tourism:camp_site"),"carRental"=>Some("amenity:car_rental"),"evCharger"=>Some("amenity:charging_station"),"fireStation"=>Some("amenity:fire_station"),"fitnessCenter"=>Some("leisure:fitness_centre"),"foodMarket"=>Some("amenity:marketplace"),"gasStation"=>Some("amenity:fuel"),"hospital"=>Some("amenity:hospital"),"hotel"=>Some("tourism:hotel"),"laundry"=>Some("shop:laundry"),"library"=>Some("amenity:library"),"marina"=>Some("leisure:marina"),"movieTheater"=>Some("amenity:cinema"),"museum"=>Some("tourism:museum"),"nightlife"=>Some("amenity:nightclub"),"park"=>Some("leisure:park"),"parking"=>Some("amenity:parking"),"pharmacy"=>Some("amenity:pharmacy"),"police"=>Some("amenity:police"),"postOffice"=>Some("amenity:post_office"),"restaurant"=>Some("amenity:restaurant"),"restroom"=>Some("amenity:toilets"),"school"=>Some("amenity:school"),"stadium"=>Some("leisure:stadium"),"theater"=>Some("amenity:theatre"),"university"=>Some("amenity:university"),"winery"=>Some("craft:winery"),"zoo"=>Some("tourism:zoo"),_=>None}}
fn address_layers(option:&str)->Option<&'static [&'static str]>{match option{"country"=>Some(&["country"]),"administrativeArea"=>Some(&["state"]),"subAdministrativeArea"=>Some(&["county"]),"locality"=>Some(&["city","locality"]),"subLocality"=>Some(&["district"]),_=>None}}
fn photon(a:&Value,deadline:Instant)->Result<Value>{
    let credit=attribution()?;let limit=a["limit"].as_f64().unwrap_or(32.0)as usize;
    let mut query=vec![("q".into(),a["query"].as_str().unwrap().into()),("limit".into(),"32".into())];
    if let Some(p)=region(&a["region"]){query.push(("lat".into(),p[0].to_string()));query.push(("lon".into(),p[1].to_string()));
        let west=p[1]-p[3]/2.0;let east=p[1]+p[3]/2.0;
        if west< -180.0||east>180.0{return Err(failure("unsupported_operation","configured Photon bounding boxes cannot encode a region crossing the antimeridian"));}
        query.push(("bbox".into(),format!("{},{},{},{}",west,(p[0]-p[2]/2.0).max(-90.0),east,(p[0]+p[2]/2.0).min(90.0))));
    }
    for category in tokens(a,"poi_categories"){let tag=poi_tag(category).ok_or_else(||failure("unsupported_operation",format!("no qualified Photon principal-tag mapping for category {category}")))?;query.push(("osm_tag".into(),tag.into()));}
    let include=tokens(a,"address_include");let exclude=tokens(a,"address_exclude");
    for option in include.iter().chain(exclude.iter()){if address_layers(option).is_none(){return Err(failure("unsupported_operation","Photon has no equivalent postalCode address layer; unknown address filters refuse"));}}
    let allowed:Vec<&str>=["house","street","locality","district","city","county","state","country","other"].into_iter().filter(|layer|(include.is_empty()||include.iter().any(|o|address_layers(o).unwrap().contains(layer)))&&!exclude.iter().any(|o|address_layers(o).unwrap().contains(layer))).collect();
    for layer in allowed{query.push(("layer".into(),layer.into()));}
    let raw=local_json("INTERCEPTOR_PHOTON_URL","/api",&query,deadline)?;
    normalize_photon(a,&raw,&credit,limit)
}
fn normalize_photon(a:&Value,raw:&Value,credit:&str,limit:usize)->Result<Value>{
    let features=raw["features"].as_array().filter(|r|r.len()<=32).ok_or_else(||failure("provider_failed","Photon returned no bounded feature array"))?;
    let mut results=Vec::new();let mut completions=Vec::new();let types=tokens(a,"types");
    for feature in features{
        if feature["type"]!="Feature"||feature["geometry"]["type"]!="Point"{return Err(failure("provider_failed","Photon result is not an actual point feature"));}
        let coordinate=feature["geometry"]["coordinates"].as_array().filter(|v|v.len()==2).ok_or_else(||failure("provider_failed","Photon point has invalid coordinates"))?;
        let lon=coordinate[0].as_f64().filter(|n|n.is_finite()&&n.abs()<=180.0);let lat=coordinate[1].as_f64().filter(|n|n.is_finite()&&n.abs()<=90.0);
        let(Some(lon),Some(lat))=(lon,lat)else{return Err(failure("provider_failed","Photon point has invalid WGS84 coordinates"));};
        let p=&feature["properties"];let key=p["osm_key"].as_str().ok_or_else(||failure("provider_failed","Photon omitted its principal OSM key"))?;
        let kind=if ["natural","waterway","water","mountain_pass"].contains(&key){"physicalFeature"}else if ["place","highway","boundary","building"].contains(&key){"address"}else{"pointOfInterest"};
        if !types.is_empty()&&!types.contains(&kind){continue;}
        let mut mark=json!({"name":p["name"].as_str(),"coordinate":[lat,lon],"attribution":credit});
        for(from,to)in[("street","thoroughfare"),("housenumber","subThoroughfare"),("city","locality"),("district","subLocality"),("state","administrativeArea"),("county","subAdministrativeArea"),("postcode","postalCode"),("country","country"),("countrycode","isoCountryCode")]{if let Some(v)=p.get(from){if !bounded(v,4096){return Err(failure("provider_failed","Photon address field is invalid bounded text"));}mark[to]=v.clone();}}
        if mark["name"].as_str().is_some_and(|s|s.len()>4096||s.contains('\0')){return Err(failure("provider_failed","Photon name exceeds its bounds"));}
        if a["sub"]=="complete"{
            let title=p["name"].as_str().or_else(||p["street"].as_str()).ok_or_else(||failure("provider_failed","Photon completion omitted its actual label"))?;
            let subtitle=["housenumber","street","city","state","country"].iter().filter_map(|k|p[k].as_str()).collect::<Vec<_>>().join(", ");
            if subtitle.len()>4096{return Err(failure("resource_limit","Photon completion address exceeds 4096 bytes"));}
            completions.push(json!({"title":title,"subtitle":subtitle}));if completions.len()==limit{break;}
        }else{results.push(item(mark)?);if results.len()==limit{break;}}
    }
    Ok(if a["sub"]=="complete"{json!({"query":a["query"],"completions":completions})}else{json!({"query":a["query"],"results":results})})
}
fn resolve(value:&Value,deadline:Instant)->Result<Value>{
    let s=value.as_str().unwrap();if let Some(v)=retained(s){return Ok(v);}
    if s.strip_prefix("B-").is_some_and(|id|id.len()==64&&id.bytes().all(|c|c.is_ascii_hexdigit())||id.len()==36&&id.bytes().enumerate().all(|(i,c)|if [8,13,18,23].contains(&i){c==b'-'}else{c.is_ascii_hexdigit()})){return Err(failure("stale_reference","map item expired, was evicted or belongs to another provider; read search again"));}
    if let Some(p)=crate::location::coordinates(value,false){return item(json!({"name":null,"coordinate":p}));}
    let result=crate::location::geocode(&json!({"type":"desktop_location","sub":"geocode","address":s}),deadline)?;
    item(result["placemarks"].as_array().and_then(|p|p.first()).cloned().ok_or_else(||failure("unsupported_target","local geocoder resolved no route endpoint"))?)
}
fn normalize_route(trip:&Value,mode:&str,credit:&str)->Result<Value>{
    if trip["status"].as_u64()!=Some(0)||trip["units"]!="kilometers"{return Err(failure("provider_failed","Valhalla route status or requested units were not confirmed"));}
    let summary=&trip["summary"];let length=summary["length"].as_f64().filter(|n|n.is_finite()&&*n>=0.0&&*n<=100000.0);let seconds=summary["time"].as_f64().filter(|n|n.is_finite()&&*n>=0.0&&*n<=31_536_000.0);
    let(Some(length),Some(seconds))=(length,seconds)else{return Err(failure("provider_failed","Valhalla omitted valid observed route totals"));};
    let legs=trip["legs"].as_array().filter(|v|!v.is_empty()&&v.len()<=64).ok_or_else(||failure("provider_failed","Valhalla omitted bounded route legs"))?;let mut steps=Vec::new();
    for leg in legs{let maneuvers=leg["maneuvers"].as_array().ok_or_else(||failure("provider_failed","Valhalla omitted native route instructions"))?;if maneuvers.len()>4096-steps.len(){return Err(failure("resource_limit","Valhalla route exceeds 4096 instructions"));}
        for m in maneuvers{let text=m["instruction"].as_str().filter(|s|s.len()<=4096&&!s.contains('\0')).ok_or_else(||failure("provider_failed","Valhalla instruction text is invalid"))?;let distance=m["length"].as_f64().filter(|n|n.is_finite()&&*n>=0.0&&*n<=100000.0).ok_or_else(||failure("provider_failed","Valhalla instruction distance is invalid"))?;steps.push(json!({"instructions":text,"distance":distance*1000.0}));}
    }
    Ok(json!({"name":format!("Valhalla {mode} route"),"distance":length*1000.0,"expectedTravelTime":seconds,"transportType":mode,"advisoryNotices":[],"hasTolls":summary["has_toll"].as_bool(),"steps":steps,"attribution":credit}))
}
fn route(a:&Value,deadline:Instant)->Result<Value>{
    let credit=attribution()?;let source=resolve(&a["from"],deadline)?;let destination=resolve(&a["to"],deadline)?;
    let modes:&[&str]=match a["transport"].as_str().unwrap_or("auto"){"any"=>&["auto","walking","transit"],"walking"=>&["walking"],"transit"=>&["transit"],_=>&["auto"]};
    let departure=time::OffsetDateTime::now_utc();let mut routes=Vec::new();let mut last_error=None;
    for mode in modes{
        let costing=match *mode{"walking"=>"pedestrian","transit"=>"multimodal",_=>"auto"};
        let from=&source["placemark"]["coordinate"];let to=&destination["placemark"]["coordinate"];
        let mut request=json!({"locations":[{"lat":from[0],"lon":from[1]},{"lat":to[0],"lon":to[1]}],"costing":costing,"units":"kilometers","alternates":if a["requests_alternates"]==true{2}else{0}});
        if *mode=="transit"{request["date_time"]=json!({"type":0});if a["requests_alternates"]==true{return Err(failure("unsupported_operation","Valhalla time-dependent transit does not support alternate routes"));}}
        let response=local_json("INTERCEPTOR_VALHALLA_URL","/route",&[("json".into(),request.to_string())],deadline);
        match response{
            Err(e)=>last_error=Some(e),Ok(raw)=>{
                let r=normalize_route(&raw["trip"],mode,&credit);match r{Err(e)=>{last_error=Some(e);continue;},Ok(r)=>routes.push(r)}
                if let Some(alternates)=raw["alternates"].as_array(){if alternates.len()>2{return Err(failure("resource_limit","Valhalla returned more alternates than requested"));}for alternate in alternates{routes.push(normalize_route(&alternate["trip"],mode,&credit)?);}}
            }
        }
    }
    if routes.is_empty(){return Err(last_error.unwrap_or_else(||failure("provider_failed","local router returned no usable route")));}
    routes.sort_by(|a,b|a["expectedTravelTime"].as_f64().unwrap().total_cmp(&b["expectedTravelTime"].as_f64().unwrap()));
    if a["sub"]=="eta"{
        let best=&routes[0];let seconds=best["expectedTravelTime"].as_f64().unwrap();let arrival=departure+time::Duration::milliseconds((seconds*1000.0).round()as i64);
        return Ok(json!({"transport":best["transportType"],"expectedTravelTime":seconds,"distance":best["distance"],"expectedDepartureDate":departure.format(&time::format_description::well_known::Rfc3339).map_err(|_|failure("provider_failed","departure date serialization failed"))?,"expectedArrivalDate":arrival.format(&time::format_description::well_known::Rfc3339).map_err(|_|failure("provider_failed","arrival date serialization failed"))?,"attribution":credit,"dateSource":"request-clock-plus-native-route-duration","partial":last_error.is_some()}));
    }
    let partial=routes.len()>3||last_error.is_some();routes.truncate(3);Ok(json!({"transport":a["transport"].as_str().unwrap_or("auto"),"routes":routes,"source":source,"destination":destination,"partial":partial}))
}
pub fn dispatch(a:&Value)->Value{
    if let Err(e)=validate(a){return e;}
    if ACTIVE.fetch_update(Ordering::AcqRel,Ordering::Acquire,|n|(n<4).then_some(n+1)).is_err(){return failure("resource_limit","four map requests or their cleanup are active; no work queued");}let _permit=Permit;
    let deadline=Instant::now()+Duration::from_secs(55);
    let result=match a["sub"].as_str().unwrap(){
        "search"|"complete"=>photon(a,deadline),"directions"|"eta"=>route(a,deadline),
        "reverse"=>crate::location::geocode(&json!({"type":"desktop_location","sub":"reverse","coords":a["coords"]}),deadline),
        "mapitem-open"=>match retained(a["id"].as_str().unwrap()){
            None=>Err(failure("stale_reference","map launch requires an unexpired item returned by this provider")),
            Some(target)=>crate::thumbnail::image_helper("--maps-open-engine",&json!({"coordinate":target["placemark"]["coordinate"],"id":target["id"]}),deadline.min(Instant::now()+Duration::from_secs(10)))
        },_=>Err(failure("invalid_request","unknown maps operation"))
    };
    match result{Err(e)=>e,Ok(data)=>if serde_json::to_vec(&data).is_ok_and(|v|v.len()<=1_048_576){success(data)}else{failure("resource_limit","normalized map result exceeds 1MiB")}}
}
pub(crate) fn open_helper(parent:u32)->io::Result<()>{
    crate::thumbnail::retain_provider(parent)?;
    let bytes=crate::read_frame(&mut io::stdin().lock())?.ok_or_else(||io::Error::other("map launch helper requires one retained target"))?;let a:Value=serde_json::from_slice(&bytes)?;
    let result=if a.as_object().is_none_or(|o|o.len()!=2||!o.contains_key("id")||!o.contains_key("coordinate"))||!bounded(&a["id"],128)||a["coordinate"].as_array().is_none_or(|p|p.len()!=2)||crate::location::coordinates(&json!(format!("{},{}",a["coordinate"][0],a["coordinate"][1])),false).is_none(){failure("invalid_request","map launch helper requires the exact retained coordinate/id pair")}else{
        #[cfg(windows)]let result=crate::maps_windows::open(&a);
        #[cfg(target_os="linux")]let result=crate::maps_linux::open(&a);
        #[cfg(not(any(windows,target_os="linux")))]let result=Err(failure("unsupported_operation","macOS uses MapKit"));
        match result{Ok(())=>success(json!({"ok":true,"id":a["id"]})),Err(e)=>e}
    };crate::write_frame(&mut io::stdout().lock(),&serde_json::to_vec(&result)?)
}
pub fn capability(session:&str)->Value{json!({"operation":"maps","compiled":true,"present":true,"effective":false,"permission":"unknown","session":session,"background":"semantic","provider":"local Photon / Nominatim / Valhalla and retained native URI helper","versions":{"contract":"1"},"limits":["Six selectors; four requests including cleanup; shared 55s request deadline; local HTTP connect 3s/request 20s, 4MiB upstream and 1MiB normalized replies; no proxies, redirects, cookies or replay","Search and prefix completion use configured numeric-loopback INTERCEPTOR_PHOTON_URL; routes use INTERCEPTOR_VALHALLA_URL; address targets/reverse reuse INTERCEPTOR_GEOCODER_URL; installed map-data attribution is required","128 random retained item identities expire after 300s; expired/foreign ids never rebind; native launch requires the exact cached coordinate","Photon principal-tag categories and address layers have declared provider differences; postalCode filter and antimeridian boxes currently refuse","Valhalla auto/pedestrian/multimodal observed routes; any compares available actual profiles; ETA dates derive from UTC request time plus native route duration, not undocumented local-time offsets","Service versions/data/licenses, complete filter parity, URI handlers, native behavior and installed packages remain unqualified"]})}
#[cfg(test)]mod tests{use super::*;
    #[test]fn map_uri_coordinates_use_decimal_wgs84(){assert_eq!(coordinate_uri(&json!([1e-8,-1e-8])).unwrap(),"geo:0.00000001,-0.00000001");assert!(coordinate_uri(&json!([91,0])).is_err());assert!(coordinate_uri(&json!(["1",0])).is_err());}
    #[test]fn invalid_requests_and_regions_refuse_before_effects(){for a in[json!({"type":"desktop_maps","sub":"search","query":"x","limit":"3"}),json!({"type":"desktop_maps","sub":"eta","from":"91,0","to":"0,0"}),json!({"type":"desktop_maps","sub":"reverse","coords":"1,,2"}),json!({"type":"desktop_maps","sub":"search","query":"x","coords":"1,2"})]{assert!(validate(&a).is_err());}assert!(region(&json!("0,0,1,1")).is_some());assert!(region(&json!("0,0,0,1")).is_none());}
    #[test]fn photon_uses_geojson_order_and_actual_labels(){let a=json!({"type":"desktop_maps","sub":"complete","query":"Be","limit":1});let raw=json!({"features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[13.4,52.5]},"properties":{"name":"Berlin","country":"Germany","osm_key":"place","osm_value":"city"}}]});let r=normalize_photon(&a,&raw,"fixture attribution",1).unwrap();assert_eq!(r["completions"][0]["title"],"Berlin");assert_eq!(r["completions"][0]["subtitle"],"Germany");let mut bad=raw;bad["features"][0]["geometry"]["coordinates"]=json!([181,0]);assert!(normalize_photon(&a,&bad,"fixture attribution",1).is_err());}
    #[test]fn valhalla_uses_native_seconds_and_kilometers(){let trip=json!({"status":0,"units":"kilometers","summary":{"length":1.25,"time":60,"has_toll":false},"legs":[{"maneuvers":[{"instruction":"native instruction","length":1.25}]}]});let r=normalize_route(&trip,"walking","fixture attribution").unwrap();assert_eq!(r["distance"],1250.0);assert_eq!(r["expectedTravelTime"],60.0);assert_eq!(r["steps"][0]["distance"],1250.0);assert_eq!(r["hasTolls"],false);let mut bad=trip;bad["units"]=json!("miles");assert!(normalize_route(&bad,"walking","fixture attribution").is_err());assert!(serde_json::from_value::<DesktopCapability>(capability("fixture")).is_ok());}
}
