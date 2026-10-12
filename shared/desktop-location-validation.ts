import {desktopContractShapeError} from './desktop-contract-validation'
export function desktopLocationCoordinates(value:unknown,region=false):number[]|undefined{
  if(typeof value!=='string'||Buffer.byteLength(value)>128||!/^[\d+eE.,\s-]+$/.test(value))return
  const parts=value.split(',');if(parts.length!==(region?3:2)||parts.some(p=>!p.trim()))return
  const point=parts.map(Number)
  if(point.some(n=>!Number.isFinite(n))||Math.abs(point[0])>90||Math.abs(point[1])>180||region&&(point[2]<=0||point[2]>10000000))return
  return point
}
export function desktopLocationActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_location')return
  const shape=desktopContractShapeError(a,'DesktopLocationAction');if(shape)return shape
  const bounded=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=max&&!v.includes('\0')
  const fields:Record<string,string[]>={request:['level'],'request-temporary-accuracy':['purpose'],monitor_start:['accuracy'],geocode:['address','locale','region'],reverse:['coords','locale'],distance:['from','to'],'postal-geocode':['postal','locale']}
  const owned=fields[String(a.sub)]??[]
  for(const key of ['level','purpose','accuracy','address','coords','postal','region','locale','from','to'])if(a[key]!==undefined&&!owned.includes(key))return 'field does not belong to location '+a.sub
  for(const key of ['group','groupColor'])if(a[key]!==undefined&&!bounded(a[key],256))return 'invalid location group metadata'
  if(a.sub==='request-temporary-accuracy'&&!bounded(a.purpose,128))return 'temporary accuracy requires a bounded purpose key'
  if(a.locale!==undefined&&(!bounded(a.locale,128)||!/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/.test(String(a.locale))))return 'invalid location locale'
  if(a.sub==='geocode'&&!bounded(a.address,4096))return 'geocode requires a bounded address'
  for(const key of ['coords','from','to'])if((key==='coords'&&a.sub==='reverse'||['from','to'].includes(key)&&a.sub==='distance')&&!desktopLocationCoordinates(a[key]))return 'location '+key+' requires finite latitude/longitude'
  if(a.region!==undefined&&!desktopLocationCoordinates(a.region,true))return 'location region requires latitude/longitude and positive bounded radius'
  if(a.sub==='postal-geocode'){
    if(!bounded(a.postal,8192))return 'postal-geocode requires bounded postal JSON'
    let postal:Record<string,unknown>;try{postal=JSON.parse(String(a.postal))}catch{return 'postal JSON is malformed'}
    if(!postal||Array.isArray(postal)||typeof postal!=='object'||Object.keys(postal).length===0||Object.entries(postal).some(([key,value])=>!['street','city','state','postalCode','country','isoCountryCode'].includes(key)||!bounded(value,1024)))return 'invalid postal address fields'
  }
}
export function desktopLocationResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_location')return
  const sub=String(a.sub),schema=sub==='current'?'DesktopLocationPoint':sub==='status'?'DesktopLocationStatus':sub==='request'?'DesktopLocationRequest':sub==='request-temporary-accuracy'?'DesktopLocationTemporary':sub==='monitor_start'?'DesktopLocationMonitorStart':sub==='monitor_stop'?'DesktopLocationMonitorStop':sub==='monitor_tail'?'DesktopLocationTail':sub==='distance'?'DesktopLocationDistance':['geocode','reverse','postal-geocode'].includes(sub)?'DesktopLocationGeocoded':'DesktopLocationAck'
  const shape=desktopContractShapeError(data,schema);if(shape)return shape
  const row=data as Record<string,any>,coordinate=(point:unknown)=>Array.isArray(point)&&point.length===2&&point.every(n=>typeof n==='number'&&Number.isFinite(n))&&Math.abs(point[0])<=90&&Math.abs(point[1])<=180
  const boundedText=(value:unknown):boolean=>value===null||typeof value==='string'&&Buffer.byteLength(value)<=4096&&!value.includes('\0')
  const texts:unknown[]=[row.status,row.accuracyAuthorization,row.macOS,row.lastError,row.note].filter(v=>v!==undefined)
  const points=sub==='current'?[row]:sub==='monitor_tail'?row.locations:[]
  if(points.length>200||points.some((p:Record<string,any>)=>!coordinate(p.coordinate)||!Number.isFinite(Date.parse(p.timestamp))||p.horizontalAccuracy<0||p.floor!==null&&!Number.isSafeInteger(p.floor)))return 'invalid observed location fix'
  if(sub==='distance'&&(row.meters<0||row.meters>21000000))return 'invalid geodesic distance'
  if(sub==='request'&&row.requested!==(a.level??'whenInUse')||sub==='monitor_start'&&(row.monitoring!==true||row.accuracy!==(a.accuracy??'best'))||sub==='monitor_stop'&&row.monitoring!==false)return 'location lifecycle result contradicts its request'
  if(row.placemarks&&(row.placemarks.length>32||row.placemarks.some((p:Record<string,any>)=>p.coordinate!==undefined&&!coordinate(p.coordinate)||p.areasOfInterest&&p.areasOfInterest.length>32)))return 'invalid bounded geocoder observations'
  for(const p of row.placemarks??[])for(const [key,value] of Object.entries(p))if(key==='areasOfInterest')texts.push(...value as unknown[]);else if(key!=='coordinate')texts.push(value)
  if(texts.some(value=>!boundedText(value)))return 'invalid bounded location result text'
  if(row.coordinate!==undefined&&!coordinate(row.coordinate)||sub==='reverse'&&JSON.stringify(row.coordinate)!==JSON.stringify(desktopLocationCoordinates(a.coords)))return 'location result has invalid or mismatched coordinates'
  if(Buffer.byteLength(JSON.stringify(data))>65536)return 'location result exceeds its bound'
}
