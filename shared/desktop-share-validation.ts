import {desktopContractShapeError} from './desktop-contract-validation'
const payload=['items','text','url','body','recipient','recipients','subject']
export function desktopShareActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_share')return
  const shape=desktopContractShapeError(a,'DesktopShareAction');if(shape)return shape
  const sub=String(a.sub),allowed=sub==='services'?['for_item']:['text','url'].includes(sub)?['service','value','recipient','recipients','subject']:sub==='named'?[...payload,'service']:payload
  for(const key of Object.keys(a))if(!['type','sub','group','groupColor','groupSoft',...allowed].includes(key))return 'field does not belong to share '+sub
  const bounded=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=max&&!v.includes('\0')
  for(const key of ['group','groupColor','service','recipient','subject'])if(a[key]!==undefined&&!bounded(a[key],key==='subject'?4096:256))return 'invalid bounded share '+key
  for(const key of ['text','body','value'])if(a[key]!==undefined&&!bounded(a[key],65536))return 'invalid bounded share '+key
  for(const key of ['url','for_item'])if(a[key]!==undefined&&!bounded(a[key],4096))return 'invalid bounded share '+key
  for(const key of ['items','recipients'])if(a[key]!==undefined&&(!Array.isArray(a[key])||!(a[key]as unknown[]).length||(a[key]as unknown[]).length>32||(a[key]as unknown[]).some(v=>!bounded(v,key==='items'?4096:256))))return 'invalid bounded share '+key
  if(a.recipient!==undefined&&a.recipients!==undefined)return 'share recipient aliases are mutually exclusive'
  if(['named','text','url'].includes(sub)&&!bounded(a.service,256))return 'share selector requires an exact service'
  if(['text','url'].includes(sub)&&!bounded(a.value,65536))return 'share selector requires its value'
  if(sub!=='services'&&!['text','url'].includes(sub)&&!payload.slice(0,4).some(key=>a[key]!==undefined))return 'share requires content'
  if(sub==='url'||a.url!==undefined){try{const url=new URL(String(sub==='url'?a.value:a.url));if(!['http:','https:'].includes(url.protocol))return 'share URL requires http or https'}catch{return 'invalid absolute share URL'}}
  if(sub==='services'&&a.for_item!==undefined&&!/^(?:\/|[A-Za-z]:[\\/])/.test(String(a.for_item)))return 'share service file probe requires an absolute path'
  if(Buffer.byteLength(JSON.stringify(a))>262144)return 'share request exceeds 256KiB'
}
export function desktopShareResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_share')return
  const shape=desktopContractShapeError(data,a.sub==='services'?'DesktopShareServices':'DesktopShareCompleted');if(shape)return shape
  const row=data as Record<string,any>
  if(Buffer.byteLength(JSON.stringify(data))>1048576)return 'share reply exceeds 1MiB'
  if(a.sub==='services'){
    if(row.services.length>128)return 'share services exceed 128'
    const seen=new Set<string>();for(const service of row.services){if(!service.title||Buffer.byteLength(service.title)>4096||Buffer.byteLength(service.menuItemTitle)>4096||seen.has(service.id??service.title))return 'invalid or duplicate native sharing service';seen.add(service.id??service.title)}
  }else if(row.ok!==true||!row.service||row.service.length>4096||row.items?.length>32||row.recipients?.length>32||row.outcome!==undefined&&!['shared','compose-presented','wallpaper-set','handler-accepted'].includes(row.outcome))return 'share success requires actual native completion and bounded metadata'
  const bounded=(v:unknown):boolean=>typeof v==='string'?Buffer.byteLength(v)<=65536&&!v.includes('\0'):Array.isArray(v)?v.every(bounded):v&&typeof v==='object'?Object.values(v).every(bounded):true
  if(!bounded(data))return 'invalid share native reply text'
}
