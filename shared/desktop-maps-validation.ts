import {desktopContractShapeError} from './desktop-contract-validation'
import type {DesktopContractSchema} from './desktop-contract.generated'
import {desktopLocationCoordinates,desktopLocationResultError} from './desktop-location-validation'
export function desktopMapsRegion(value:unknown):number[]|undefined{
  if(typeof value!=='string'||Buffer.byteLength(value)>128||!/^[\d+eE.,\s-]+$/.test(value))return
  const raw=value.split(',');if(raw.length!==4||raw.some(s=>!s.trim()))return
  const p=raw.map(Number);if(p.some(n=>!Number.isFinite(n))||Math.abs(p[0])>90||Math.abs(p[1])>180||p[2]<=0||p[2]>180||p[3]<=0||p[3]>360)return
  return p
}
export function desktopMapsActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_maps')return
  const shape=desktopContractShapeError(a,'DesktopMapsAction');if(shape)return shape
  const bounded=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=max&&!v.includes('\0')
  const sub=String(a.sub),owned=sub==='search'||sub==='complete'?['query','region','types','poi_categories','address_include','address_exclude','limit']:sub==='reverse'?['coords']:sub==='mapitem-open'?['id']:['from','to','transport',...(sub==='directions'?['requests_alternates']:[])]
  for(const key of ['query','coords','id','region','types','poi_categories','address_include','address_exclude','limit','from','to','transport','requests_alternates'])if(a[key]!==undefined&&!owned.includes(key))return 'field does not belong to maps '+sub
  for(const key of ['group','groupColor'])if(a[key]!==undefined&&!bounded(a[key],256))return 'invalid maps group metadata'
  if(['search','complete'].includes(sub)&&!bounded(a.query,4096))return 'maps requires a bounded query'
  if(a.region!==undefined&&!desktopMapsRegion(a.region))return 'maps region requires latitude/longitude and positive bounded spans'
  if(a.limit!==undefined&&(!Number.isSafeInteger(a.limit)||Number(a.limit)<1||Number(a.limit)>32))return 'maps limit must be an integer in 1..32'
  if(a.types!==undefined&&(typeof a.types!=='string'||a.types.split(',').some(s=>!['address','pointOfInterest','physicalFeature'].includes(s.trim()))))return 'invalid maps result types'
  for(const key of ['poi_categories','address_include','address_exclude'])if(a[key]!==undefined&&(!bounded(a[key],4096)||String(a[key]).split(',').length>64||String(a[key]).split(',').some(s=>!s.trim())))return 'invalid bounded map filter'
  if(a.address_include!==undefined&&a.address_exclude!==undefined)return 'map address include/exclude are mutually exclusive'
  if(sub==='reverse'&&!desktopLocationCoordinates(a.coords))return 'maps reverse requires finite latitude/longitude'
  if(sub==='mapitem-open'&&!bounded(a.id,128))return 'maps open requires one retained map item id'
  for(const key of sub==='directions'||sub==='eta'?['from','to']:[]){if(!bounded(a[key],4096))return 'maps route requires bounded source and destination';const s=String(a[key]);if(s.includes(',')&&/^[\d+eE.,\s-]+$/.test(s)&&!desktopLocationCoordinates(s))return 'maps route has malformed numeric coordinates'}
}
export function desktopMapsResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_maps')return
  const sub=String(a.sub),schema=({search:'DesktopMapsSearch',complete:'DesktopMapsCompleted',directions:'DesktopMapsDirections',eta:'DesktopMapsETA','mapitem-open':'DesktopMapsOpened',reverse:'DesktopMapsReverse'}as Record<string,DesktopContractSchema>)[sub]
  const shape=desktopContractShapeError(data,schema);if(shape)return shape
  const row=data as Record<string,any>
  const coordinate=(p:any)=>Array.isArray(p)&&p.length===2&&p.every((n:any)=>typeof n==='number'&&Number.isFinite(n))&&Math.abs(p[0])<=90&&Math.abs(p[1])<=180
  const item=(p:Record<string,any>)=>typeof p.id==='string'&&p.id.length>0&&p.id.length<=128&&coordinate(p.placemark.coordinate)&&!desktopLocationResultError({type:'desktop_location',sub:'geocode'},{placemarks:[p.placemark]})
  if(['search','complete'].includes(sub)&&row.query!==a.query)return 'map result query does not match its request'
  if(sub==='search'&&(row.results.length>Number(a.limit??32)||row.results.some((p:Record<string,any>)=>!item(p))))return 'invalid bounded map search items'
  if(sub==='complete'&&(row.completions.length>Number(a.limit??32)))return 'map completion result exceeds its requested bound'
  if(row.boundingRegion&&(!coordinate(row.boundingRegion.center)||row.boundingRegion.span.length!==2||row.boundingRegion.span.some((n:number,i:number)=>n<0||n>(i===0?180:360))))return 'invalid observed map bounding region'
  if(sub==='directions'&&(row.routes.length>3||!item(row.source)||!item(row.destination)||row.routes.some((r:Record<string,any>)=>r.distance<0||r.expectedTravelTime<0||r.steps.length>4096||r.advisoryNotices.length>64||r.steps.some((s:Record<string,any>)=>s.distance<0))))return 'invalid bounded observed routes'
  if(sub==='eta'&&(row.distance<0||row.expectedTravelTime<0||!Number.isFinite(Date.parse(row.expectedDepartureDate))||!Number.isFinite(Date.parse(row.expectedArrivalDate))||Date.parse(row.expectedArrivalDate)<Date.parse(row.expectedDepartureDate)))return 'invalid observed travel estimates'
  if(sub==='mapitem-open'&&(row.ok!==true||row.id!==a.id))return 'map launch receipt does not match its retained target'
  if(sub==='reverse'){const error=desktopLocationResultError({type:'desktop_location',sub:'reverse',coords:a.coords},data);if(error)return error}
  const texts:unknown[]=[]
  const visit=(v:unknown)=>{if(typeof v==='string')texts.push(v);else if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')Object.values(v).forEach(visit)};visit(data)
  if(texts.some(v=>Buffer.byteLength(String(v))>4096||String(v).includes('\0')))return 'map output contains invalid bounded text'
  if(Buffer.byteLength(JSON.stringify(data))>1_048_576)return 'map result exceeds 1MiB'
}
