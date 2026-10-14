import {desktopContractShapeError} from './desktop-contract-validation'
import type {DesktopContractSchema} from './desktop-contract.generated'
import {eventKitInstant} from './desktop-eventkit-validation'

export const DESKTOP_PHOTOS_FIELDS:Record<string,string[]>={status:[],request:['level'],albums:['album_type'],album:['id'],'album-create':['name'],'album-delete':['id'],'album-rename':['id','name'],assets:['album','media','subtype','since','until','where','limit','offset','favorite','hidden','burst'],asset:['id'],export:['id','out','format','size'],'export-video':['id','out'],'export-live':['id','out'],thumbnail:['id','out','size','save'],favorite:['id','on'],hide:['id','on'],delete:['id'],'add-to-album':['album','asset'],'remove-from-album':['album','asset'],import:['file','album'],'import-video':['file','album'],'current-token':[],changes:['token']}
export type PhotosPredicate={key:string;operator:string;value:number|boolean|string}
export function photosPredicates(raw:string):PhotosPredicate[]|undefined {
  const clauses=raw.split(' AND ');if(!raw||clauses.length>8)return
  const out:PhotosPredicate[]=[]
  for(const clause of clauses){
    const m=/^(isFavorite|isHidden|mediaType|pixelWidth|pixelHeight|duration|creationDate|modificationDate) (==|!=|>=|<=|>|<) (true|false|[0-9]+(?:\.[0-9]+)?|"[^"\r\n]+")$/.exec(clause)
    if(!m)return
    const [_,key,operator,text]=m
    if(['isFavorite','isHidden'].includes(key)){if(!['==','!='].includes(operator)||!['true','false'].includes(text))return;out.push({key,operator,value:text==='true'})}
    else if(key.endsWith('Date')){const value=text.slice(1,-1);if(text[0]!=='"'||eventKitInstant(value)===undefined)return;out.push({key,operator,value})}
    else{const value=Number(text);if(!Number.isFinite(value)||value<0||value>1e9||key!=='duration'&&!Number.isInteger(value)||key==='mediaType'&&value>3)return;out.push({key,operator,value})}
  }
  return out
}
export function photosIdentifiers(raw:unknown):string[]|undefined {
  if(typeof raw!=='string')return
  const ids=raw.split(',');return ids.length<=100&&new Set(ids).size===ids.length&&ids.every(x=>!!x.trim()&&x.trim()===x&&Buffer.byteLength(x)<=4096&&!x.includes('\0'))?ids:undefined
}
export function desktopPhotosActionError(a:Record<string,unknown>):string|undefined {
  if(a.type!=='desktop_photos')return
  const shape=desktopContractShapeError(a,'DesktopPhotosAction');if(shape)return shape
  const sub=String(a.sub),fields=DESKTOP_PHOTOS_FIELDS[sub];if(!fields||Object.keys(a).some(k=>!['type','sub',...fields].includes(k)))return 'field does not belong to Photos selector'
  for(const [k,v]of Object.entries(a))if(typeof v==='string'&&(!v.trim()||v.includes('\0')||Buffer.byteLength(v)>(k==='token'?65536:4096)))return 'invalid bounded Photos '+k
  const required:Record<string,string[]>={album:['id'],'album-create':['name'],'album-delete':['id'],'album-rename':['id','name'],asset:['id'],export:['id','out'],'export-video':['id','out'],'export-live':['id','out'],thumbnail:['id'],favorite:['id'],hide:['id'],delete:['id'],'add-to-album':['album','asset'],'remove-from-album':['album','asset'],import:['file'],'import-video':['file'],changes:['token']}
  if(required[sub]?.some(k=>a[k]===undefined))return 'Photos selector requires exact fields'
  for(const [k,lo,hi]of [['limit',1,1000],['offset',0,10000],['size',1,4096]] as const)if(a[k]!==undefined&&(!Number.isInteger(a[k])||Number(a[k])<lo||Number(a[k])>hi))return 'invalid Photos integer '+k
  for(const k of ['since','until'])if(a[k]!==undefined&&eventKitInstant(a[k])===undefined)return 'invalid Photos ISO8601 instant'
  if(a.since!==undefined&&a.until!==undefined&&eventKitInstant(a.until)!<eventKitInstant(a.since)!)return 'Photos interval is reversed'
  for(const [k,values]of [['level',['readwrite','addonly']],['album_type',['album','smart','moment']],['media',['image','video','audio','unknown']],['subtype',['panorama','screenshot','hdr','livePhoto','live','depthEffect','streamed','streamedVideo','highFrameRate','timelapse']],['format',['jpeg','png']]] as const)if(a[k]!==undefined&&!values.includes(String(a[k]) as never))return 'unknown Photos '+k
  if(a.where!==undefined&&!photosPredicates(String(a.where)))return 'Photos where requires at most 8 documented scalar comparisons joined by AND'
  if(a.id!==undefined&&!photosIdentifiers(a.id)||a.asset!==undefined&&!photosIdentifiers(a.asset))return 'invalid exact Photos identities'
  if(a.id!==undefined&&sub!=='delete'&&String(a.id).includes(','))return 'Photos selector requires one identity'
  if(a.token!==undefined&&(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(String(a.token))||!String(a.token).length))return 'Photos token requires canonical bounded base64'
  for(const k of ['file','out'])if(a[k]!==undefined&&!/^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(String(a[k])))return 'Photos requires an absolute or home-relative path'
  if(Buffer.byteLength(JSON.stringify(a))>131072)return 'Photos request exceeds 128KiB'
}
export function desktopPhotosResultError(a:Record<string,unknown>,value:unknown):string|undefined {
  if(a.type!=='desktop_photos')return
  const sub=String(a.sub),data=value as Record<string,unknown>
  const schemas:Record<string,DesktopContractSchema>={status:'DesktopPhotosStatus',request:'DesktopPhotosStatus',albums:'DesktopPhotosAlbums',album:'DesktopPhotosAlbum','album-create':'DesktopPhotosNamed','album-rename':'DesktopPhotosNamed','album-delete':'DesktopPhotosOK',assets:'DesktopPhotosAssets',asset:'DesktopPhotosAsset',export:'DesktopPhotosExport','export-video':'DesktopPhotosExport','export-live':'DesktopPhotosLiveExport',thumbnail:'DesktopPhotosThumbnail',favorite:'DesktopPhotosOK',hide:'DesktopPhotosOK',delete:'DesktopPhotosDeleted','add-to-album':'DesktopPhotosMembership','remove-from-album':'DesktopPhotosMembership',import:'DesktopPhotosOK','import-video':'DesktopPhotosOK','current-token':'DesktopPhotosToken',changes:'DesktopPhotosChanges'}
  if(!schemas[sub])return 'unknown Photos reply selector'
  const shape=desktopContractShapeError(value,schemas[sub]);if(shape)return shape
  if(Buffer.byteLength(JSON.stringify(data))>1048576)return 'Photos reply exceeds 1MiB'
  if(data.ok!==undefined&&data.ok!==true)return 'Photos success does not confirm effect'
  for(const k of ['id','assetId'])if(data[k]!==undefined&&(typeof data[k]!=='string'||!String(data[k]).trim()))return 'Photos reply identity is empty'
  if(a.id!==undefined&&sub!=='delete'&&data.id!==undefined&&data.id!==a.id||data.assetId!==undefined&&data.assetId!==a.id)return 'Photos reply differs from requested asset/album'
  if(sub==='favorite'&&data.isFavorite!==(a.on??true)||sub==='hide'&&data.isHidden!==(a.on??true))return 'Photos mutation readback differs'
  if(sub==='album-rename'&&data.name!==a.name)return 'Photos album name readback differs'
  for(const k of ['filePath','filePathBase'])if(a.out!==undefined&&data[k]!==undefined&&data[k]!==a.out&&!(String(a.out).startsWith('~')&&String(data[k]).startsWith('/')))return 'Photos exported path differs'
  if(sub==='assets'&&(data.limit!==(a.limit??100)||data.offset!==(a.offset??0)||!Number.isSafeInteger(data.count)||Number(data.count)<0||!Array.isArray(data.assets)||data.assets.length>Number(data.limit)||data.hasMore!==(Number(data.offset)+data.assets.length<Number(data.count))))return 'Photos page differs from native count or requested bounds'
  const rows=(sub==='assets'?data.assets:sub==='asset'?[data]:[]) as Record<string,unknown>[]
  if(new Set(rows.map(x=>x.id)).size!==rows.length)return 'duplicate Photos asset identity'
  for(const row of rows){for(const k of ['pixelWidth','pixelHeight'])if(!Number.isSafeInteger(row[k])||Number(row[k])<0)return 'invalid actual Photos pixel size';if(Number(row.duration)<0||Number(row.duration)>1e9||!['image','video','audio','unknown'].includes(String(row.mediaType)))return 'invalid actual Photos media';for(const k of ['creationDate','modificationDate','addedDate'])if(row[k]!==undefined&&eventKitInstant(row[k])===undefined)return 'invalid actual Photos date';if(a.media!==undefined&&row.mediaType!==a.media||a.favorite===true&&row.isFavorite!==true)return 'Photos asset differs from requested filter'}
  if(sub==='albums'&&(!Array.isArray(data.albums)||data.albums.length>1000))return 'Photos album result exceeds 1000'
  if(['album','albums'].includes(sub))for(const row of (sub==='albums'?data.albums:[data]) as Record<string,unknown>[])if(row.estimatedAssetCount!==null&&(!Number.isSafeInteger(row.estimatedAssetCount)||Number(row.estimatedAssetCount)<0))return 'invalid native Photos album count'
  if(['export','export-video','thumbnail'].includes(sub)&&(!Number.isSafeInteger(data.bytes)||Number(data.bytes)<1||Number(data.bytes)>134217728))return 'invalid actual Photos artifact bytes'
  if(sub==='thumbnail'&&(data.format!=='jpeg'||Boolean(data.filePath)===Boolean(data.dataUrl)||!Number.isSafeInteger(data.width)||!Number.isSafeInteger(data.height)||Number(data.width)<1||Number(data.height)<1||Number(data.width)>4096||Number(data.height)>4096||data.dataUrl!==undefined&&!String(data.dataUrl).startsWith('data:image/jpeg;base64,')))return 'invalid actual Photos thumbnail'
  if(sub==='export-live'){const rows=data.resources as Record<string,unknown>[];if(rows.length!==2||new Set(rows.map(x=>x.type)).size!==2||!rows.some(x=>x.type==='image')||!rows.some(x=>x.type==='video')||rows.some(x=>!Number.isSafeInteger(x.bytes)||Number(x.bytes)<1||Number(x.bytes)>134217728||!String(x.filePath).startsWith(String(data.filePathBase)+'.')))return 'Live Photo success requires actual paired artifacts'}
  if(sub==='delete'&&JSON.stringify(data.deleted)!==JSON.stringify(photosIdentifiers(a.id)))return 'Photos deleted identities differ'
  if(['add-to-album','remove-from-album'].includes(sub)&&(data.album!==a.album||JSON.stringify(data.assets)!==JSON.stringify(photosIdentifiers(a.asset))))return 'Photos membership identities differ'
  if(sub==='changes'){const events=data.events as Record<string,unknown>[];if(events.length>3000||events.reduce((n,x)=>n+(x.inserted as unknown[]).length+(x.updated as unknown[]).length+(x.deleted as unknown[]).length,0)>12000||events.some(x=>!['asset','assetCollection','collectionList'].includes(String(x.objectType))))return 'Photos history exceeds bounded native object changes'}
  for(const k of ['token','currentToken'])if(data[k]!==undefined&&(!String(data[k]).length||String(data[k]).length>65536||Buffer.from(String(data[k]),'base64').toString('base64')!==data[k]))return 'invalid native Photos history token'
}
