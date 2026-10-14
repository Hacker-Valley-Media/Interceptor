import {desktopContractShapeError} from './desktop-contract-validation'
export const DESKTOP_CONTACT_FIELDS=['id','contactType','namePrefix','givenName','middleName','familyName','nameSuffix','nickname','phonetic','organization','emailAddresses','phoneNumbers','urlAddresses','socialProfiles','instantMessageAddresses','contactRelations','imageDataAvailable','postalAddresses','dates','birthday','thumbnailDataUrl','imageDataUrl','note','requires_entitlement'] as const
const mutable=['given','family','organization','email','phone','postal','birthday','note']
const fields:Record<string,string[]>={status:[],request:[],containers:[],'default-container':[],groups:['container'],group:['id'],'group-create':['name','container'],'group-update':['id','name'],'group-delete':['id'],'group-add-member':['id','contact'],'group-remove-member':['id','contact'],list:['limit','offset','keys','container','group'],contact:['id'],me:[],find:['query','name','email','phone'],create:[...mutable,'container'],update:['id',...mutable],delete:['id'],vcard:['id'],'import-vcard':['path','container'],'current-token':[],changes:['since','limit']}
export function desktopContactsActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_contacts')return
  const shape=desktopContractShapeError(a,'DesktopContactsAction');if(shape)return shape
  const sub=String(a.sub)
  for(const key of Object.keys(a))if(!['type','sub','groupColor','groupSoft',...fields[sub]].includes(key))return 'field does not belong to contacts '+sub
  for(const [key,value]of Object.entries(a))if(typeof value==='string'&&(Buffer.byteLength(value)>(key==='note'?65536:key==='since'?16384:4096)||value.includes('\0')||!['given','family','organization','note'].includes(key)&&!value.trim()))return 'invalid bounded contacts '+key
  for(const key of ['limit','offset'])if(a[key]!==undefined&&(!Number.isInteger(a[key])||Number(a[key])<(key==='limit'?1:0)||Number(a[key])>(key==='limit'?1000:10000)))return 'invalid integer contacts '+key
  if(['group','group-update','group-delete','group-add-member','group-remove-member','contact','update','delete','vcard'].includes(sub)&&!a.id)return 'contacts selector requires exact id'
  if(['group-create','group-update'].includes(sub)&&!a.name)return 'contacts group requires name'
  if(['group-add-member','group-remove-member'].includes(sub)&&!a.contact)return 'contacts membership requires exact contact id'
  if(['create','update'].includes(sub)&&!mutable.some(key=>a[key]!==undefined))return 'contacts mutation requires fields'
  if(sub==='find'&&['query','name','email','phone'].filter(key=>a[key]!==undefined).length!==1)return 'contacts find requires one exact query mode'
  if(sub==='list'&&a.container!==undefined&&a.group!==undefined)return 'contacts list requires one container or group scope'
  if(a.keys!==undefined){const keys=String(a.keys).split(',');if(keys.length>DESKTOP_CONTACT_FIELDS.length||new Set(keys).size!==keys.length||keys.some(key=>!DESKTOP_CONTACT_FIELDS.includes(key as any)))return 'unknown or duplicate contact output key'}
  if(['create','update'].includes(sub)){
    for(const key of ['email','phone'])if(a[key]!==undefined){const rows=String(a[key]).split(',');if(rows.length>32||rows.some(row=>{const colon=row.indexOf(':');return colon<1||Buffer.byteLength(row.slice(0,colon))>128||!row.slice(colon+1)||Buffer.byteLength(row)>4096}))return 'contacts label:value pairs required'}
    if(a.postal!==undefined){const raw=String(a.postal),colon=raw.indexOf(':');if(colon<1||Buffer.byteLength(raw.slice(0,colon))>128||raw.slice(colon+1).split(';').length!==5)return 'contacts postal requires label:street;city;state;postalCode;country'}
    if(a.birthday!==undefined){const raw=String(a.birthday);const date=new Date(raw+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(raw)||raw.startsWith('0000')||!Number.isFinite(date.valueOf())||date.toISOString().slice(0,10)!==raw)return 'invalid actual calendar birthday within years 1..9999'}
  }
  if(a.since!==undefined){const raw=String(a.since);if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)||!raw||Buffer.from(raw,'base64').toString('base64')!==raw)return 'contacts history token requires canonical base64'}
  if(sub==='import-vcard'&&(typeof a.path!=='string'||!/^(?:\/|[A-Za-z]:[\\/])/.test(a.path)))return 'contacts import requires an absolute path'
  if(Buffer.byteLength(JSON.stringify(a))>262144)return 'contacts request exceeds 256KiB'
}
export function desktopContactsResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_contacts')return
  const sub=String(a.sub),schema=sub==='status'?'Status':sub==='request'?'Requested':sub==='containers'?'Containers':sub==='default-container'?'Identity':sub==='groups'?'Groups':['group','group-create','group-update'].includes(sub)?'Group':sub==='list'?'List':sub==='find'?'Found':['group-delete','delete'].includes(sub)?'Deleted':['group-add-member','group-remove-member'].includes(sub)?'Member':sub==='vcard'?'VCard':sub==='import-vcard'?'Imported':sub==='current-token'?'Token':sub==='changes'?'Changes':'Row'
  const shape=desktopContractShapeError(data,`DesktopContacts${schema}`);if(shape)return shape
  if(Buffer.byteLength(JSON.stringify(data))>1048576)return 'contacts reply exceeds 1MiB'
  const bounded=(value:unknown,depth=0):boolean=>depth>8?false:typeof value==='string'?Buffer.byteLength(value)<=262144&&!value.includes('\0'):Array.isArray(value)?value.length<=1000&&value.every(v=>bounded(v,depth+1)):value&&typeof value==='object'?Object.values(value).every(v=>bounded(v,depth+1)):true
  if(!bounded(data))return 'unbounded contacts native result'
  const row=data as Record<string,any>
  const identity=(id:unknown)=>typeof id==='string'&&!!id.trim()&&Buffer.byteLength(id)<=4096&&!id.includes('\0')
  for(const rows of [row.containers,row.groups,row.contacts,row.matches])if(rows){if(new Set(rows.map((r:any)=>r.id)).size!==rows.length||rows.some((r:any)=>!identity(r.id)))return 'invalid or duplicate native contact identities'}
  if(['Identity','Group','Row','Deleted','VCard'].includes(schema)&&!identity(row.id))return 'contacts reply requires exact native identity'
  if(schema==='List'&&(!Number.isInteger(row.limit)||row.limit<1||row.limit>1000||row.contacts.length>row.limit||!Number.isInteger(row.offset)||row.offset<0||row.offset>10000||row.limit!==Number(a.limit??100)||row.offset!==Number(a.offset??0)))return 'invalid contacts paging receipt'
  if(['Deleted','Member'].includes(schema)&&row.ok!==true)return 'contact mutation success requires native effect'
  if(schema==='Deleted'&&a.id!==undefined&&row.id!==a.id)return 'contact deletion differs from requested identity'
  if(schema==='Member'&&(!identity(row.group)||!identity(row.contact)||row.group!==a.id||row.contact!==a.contact||row.added!==(sub==='group-add-member')))return 'contact membership differs from requested identities or effect'
  if(schema==='VCard'&&(!Number.isInteger(row.bytes)||row.bytes!==Buffer.byteLength(row.vcard)||row.bytes>262144))return 'vCard bytes differ from actual encoded content'
  if(schema==='Imported'&&(!Number.isInteger(row.imported)||row.imported!==row.ids.length||row.imported<1||row.imported>100||new Set(row.ids).size!==row.ids.length||row.ids.some((id:string)=>!identity(id))))return 'invalid actual vCard import identities'
  for(const key of ['token','currentToken'])if(typeof row[key]==='string'){const token=row[key];if(!token||Buffer.byteLength(token)>16384||Buffer.from(token,'base64').toString('base64')!==token)return 'invalid canonical native contact history token'}
  if(schema==='Changes'&&row.events.length>Number(a.limit??1000))return 'contact history exceeds requested limit'
  if(schema==='Changes')for(const event of row.events){
    const fields:Record<string,string[]>={addContact:['contactId'],updateContact:['contactId'],deleteContact:['contactId'],addGroup:['groupId'],updateGroup:['groupId'],deleteGroup:['groupId'],addMemberToGroup:['groupId','contactId'],removeMemberFromGroup:['groupId','contactId'],addSubgroup:['parent','child'],removeSubgroup:['parent','child'],dropEverything:[]}
    const required=fields[event.type];if(!required||required.some(key=>!identity(event[key]))||Object.keys(event).some(key=>key!=='type'&&!required.includes(key)))return 'contact history has an unknown event or incomplete native identities'
  }
}
