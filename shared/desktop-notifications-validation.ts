import {isAbsolute} from 'node:path'
import {desktopContractShapeError} from './desktop-contract-validation'
import {desktopLogTimestamp} from './desktop-log-validation'
import {DESKTOP_NOTIFICATION_MAX_CONTENT_BYTES,DESKTOP_NOTIFICATION_MAX_ENTRIES,DESKTOP_NOTIFICATION_MAX_RESULT_BYTES,DESKTOP_NOTIFICATION_MAX_SECONDS,type DesktopNotificationEntry,type DesktopNotificationEvent,type DesktopNotificationActionDefinition} from './desktop-contract'
import type {DesktopContractSchema} from './desktop-contract.generated'

const common=['type','sub','namespace','group','groupColor','groupSoft']
const content=['title','subtitle','body','sound','badge','category','thread','user_info','interruption','attachment','id']
const fields:Record<string,string[]>={tail:['name'],untail:['name'],log:['limit','app'],status:[],settings:[],request:['options'],post:content,'schedule-after':[...content,'seconds','repeats'],'schedule-at':[...content,'date','repeats'],'schedule-cron':[...content,'components','repeats'],cancel:['id'],'cancel-all':[],pending:['limit'],delivered:['limit'],dismiss:['id'],'dismiss-all':[],categories:['verb','identifier','actions','intent_identifiers','summary_format','hidden_placeholder'],badge:['count','clear']}
const bound=(v:unknown,max:number,empty=true)=>typeof v==='string'&&(empty||v.length>0)&&Buffer.byteLength(v)<=max&&!v.includes('\0')
const integer=(v:unknown,min:number,max:number)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max
export const desktopNotificationIdentifier=(v:unknown)=>bound(v,128,false)
export const desktopNotificationNamespace=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(v)
export function desktopNotificationFormat(raw:string,summary:boolean):boolean{
  let count=false,list=false
  for(let i=0;i<raw.length;i++)if(raw[i]==='%'){
    const spec=raw[++i]
    if(spec==='%')continue
    if(spec==='u'&&!count&&!list){count=true;continue}
    if(spec==='@'&&summary&&count&&!list){list=true;continue}
    return false
  }
  return true
}
export function desktopNotificationJSON(raw:string):Record<string,unknown>{
  if(!bound(raw,16384,false))throw new Error('notification user-info requires a JSON object of at most 16384 bytes')
  const value:unknown=JSON.parse(raw);let budget=2048
  const visit=(v:unknown,depth:number)=>{
    if(--budget<0||depth>8)throw new Error('notification user-info exceeds depth 8 or 2048 values')
    if(typeof v==='string'&&v.includes('\0'))throw new Error('notification user-info contains NUL')
    if(v&&typeof v==='object')for(const [key,item]of Object.entries(v)){if(key.includes('\0'))throw new Error('notification user-info key contains NUL');visit(item,depth+1)}
  }
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('notification user-info requires a JSON object')
  visit(value,0);return value as Record<string,unknown>
}
export function desktopNotificationComponents(raw:string):Record<string,number>{
  if(!bound(raw,512,false))throw new Error('notification components require a bounded key=integer list')
  const ranges:Record<string,[number,number]>={year:[1,9999],month:[1,12],day:[1,31],weekday:[1,7],hour:[0,23],minute:[0,59],second:[0,59]},result:Record<string,number>={}
  for(const item of raw.split(',')){
    const m=/^(year|month|day|weekday|hour|minute|second)=([0-9]{1,4})$/.exec(item.trim())
    if(!m||Object.hasOwn(result,m[1]))throw new Error('notification components contain an unknown, duplicate or malformed key')
    const n=Number(m[2]),[min,max]=ranges[m[1]];if(n<min||n>max)throw new Error('notification calendar component is outside its native range')
    result[m[1]]=n
  }
  if(result.month!==undefined&&result.day!==undefined){const d=new Date(0);d.setUTCFullYear(result.year??2000,result.month-1,result.day);if(d.getUTCMonth()!==result.month-1)throw new Error('notification calendar date does not exist')}
  return result
}
export function desktopNotificationActions(raw:string):DesktopNotificationActionDefinition[]{
  if(!bound(raw,16384,false))throw new Error('notification category actions exceed 16384 bytes')
  const entries:unknown=JSON.parse(raw)
  if(!Array.isArray(entries)||entries.length>8)throw new Error('notification categories allow at most 8 actions')
  const seen=new Set<string>()
  for(const entry of entries){
    const shape=desktopContractShapeError(entry,'DesktopNotificationActionDefinition');if(shape)throw new Error(shape)
    const row=entry as DesktopNotificationActionDefinition
    if(!desktopNotificationIdentifier(row.identifier)||seen.has(row.identifier)||!bound(row.title,256,false)||row.options&&(new Set(row.options).size!==row.options.length||row.options.length>3))throw new Error('notification action identity/title/options are invalid or duplicated')
    seen.add(row.identifier)
  }
  return entries as DesktopNotificationActionDefinition[]
}
export function desktopNotificationsActionError(action:Record<string,unknown>):string|undefined{
  if(action.type!=='desktop_notifications')return
  const shape=desktopContractShapeError(action,'DesktopNotificationAction');if(shape)return shape
  const sub=String(action.sub),allowed=fields[sub]
  if(Object.keys(action).some(k=>!common.includes(k)&&!allowed.includes(k)))return 'notification field is not valid for this operation'
  if(action.namespace!==undefined&&!desktopNotificationNamespace(action.namespace))return 'notification namespace requires 1..64 ASCII letters, digits, underscore or hyphen'
  if(action.limit!==undefined&&!integer(action.limit,0,DESKTOP_NOTIFICATION_MAX_ENTRIES))return 'notification limit must be an integer in 0..1000'
  for(const key of ['id','identifier','category','thread'])if(action[key]!==undefined&&!desktopNotificationIdentifier(action[key]))return 'notification identifiers require 1..128 UTF-8 bytes without NUL'
  if(['cancel','dismiss'].includes(sub)&&action.id===undefined)return 'notification removal requires an exact public identifier'
  if(['tail','untail'].includes(sub)&&!bound(action.name,512,false))return 'notification tail/untail require an exact bounded distributed name'
  if(action.app!==undefined&&!bound(action.app,512,false))return 'notification log filter requires 1..512 bytes'
  for(const key of ['title','subtitle'])if(action[key]!==undefined&&!bound(action[key],4096))return 'notification title/subtitle exceed 4096 bytes or contain NUL'
  if(action.body!==undefined&&!bound(action.body,32768))return 'notification body exceeds 32768 bytes or contains NUL'
  for(const key of ['sound','summary_format','hidden_placeholder'])if(action[key]!==undefined&&!bound(action[key],2048,false))return 'notification option exceeds 2048 bytes or contains NUL'
  for(const key of ['summary_format','hidden_placeholder'])if(action[key]!==undefined&&!desktopNotificationFormat(String(action[key]),key==='summary_format'))return 'notification category formats allow one %u, followed by an optional %@ in summaries, and escaped %%'
  for(const key of ['badge','count'])if(action[key]!==undefined&&!integer(action[key],0,9999))return 'notification badge must be an integer in 0..9999'
  if(sub==='badge'&&(action.clear===undefined&&action.count===undefined||action.clear!==undefined&&action.clear!==true||action.clear&&action.count!==undefined))return 'notification badge requires a count or clear, without conflicting selectors'
  if(sub==='schedule-after'&&!integer(action.seconds,1,DESKTOP_NOTIFICATION_MAX_SECONDS))return 'notification seconds require an integer in 1..31536000'
  if(sub==='schedule-after'&&action.repeats===true&&Number(action.seconds)<60)return 'repeating notification intervals require at least 60 seconds'
  if(sub==='schedule-at'){
    const date=typeof action.date==='string'?desktopLogTimestamp(action.date):undefined
    if(date===undefined||date<=Date.now()||date>Date.now()+DESKTOP_NOTIFICATION_MAX_SECONDS*1000)return 'notification date requires a future RFC3339 instant within 365 days'
    if(action.repeats===true)return 'schedule-at is a one-time instant; use schedule-cron for recurrence'
  }
  try{
    if(action.user_info!==undefined)desktopNotificationJSON(String(action.user_info))
    if(sub==='schedule-cron')desktopNotificationComponents(String(action.components??''))
    if(action.attachment!==undefined){
      if(!bound(action.attachment,32768,false))return 'notification attachments exceed 32768 bytes'
      const attachments=String(action.attachment).split(',');if(attachments.length>8)return 'notifications allow at most 8 attachments'
      const ids=new Set<string>()
      for(const item of attachments){const parts=item.split('=');const path=parts.length===2?parts[1]:parts[0];if(parts.length>2||!isAbsolute(path)||!bound(path,4096,false)||parts.length===2&&(!desktopNotificationIdentifier(parts[0])||ids.has(parts[0])))return 'notification attachments require bounded absolute paths and distinct optional identifiers';if(parts.length===2)ids.add(parts[0])}
    }
    if(sub==='request'){
      const options=String(action.options??'alert,sound,badge').split(',').map(s=>s.trim())
      if(options.length===0||options.length>6||new Set(options).size!==options.length||options.some(s=>!['alert','sound','badge','criticalAlert','provisional','providesAppNotificationSettings'].includes(s)))return 'notification authorization options are unknown, empty or duplicated'
    }
    if(sub==='categories'){
      const verb=action.verb??'list'
      if(verb==='register'){
        if(!desktopNotificationIdentifier(action.identifier)||action.actions===undefined)return 'notification category register requires identifier and actions JSON'
        desktopNotificationActions(String(action.actions))
        if(action.intent_identifiers!==undefined){const ids=String(action.intent_identifiers).split(',');if(ids.length>8||new Set(ids).size!==ids.length||ids.some(s=>!desktopNotificationIdentifier(s)))return 'notification intent identifiers must be at most 8 distinct bounded strings'}
      }else if(Object.keys(action).some(k=>!common.includes(k)&&!['verb'].includes(k)))return 'notification category list/clear accept no registration fields'
    }
  }catch(error){return (error as Error).message}
  if(Buffer.byteLength(JSON.stringify(action))>DESKTOP_NOTIFICATION_MAX_CONTENT_BYTES)return 'notification content exceeds 65536 bytes'
}
const schemas:Record<string,DesktopContractSchema>={status:'DesktopNotificationStatusData',settings:'DesktopNotificationStatusData',request:'DesktopNotificationRequestData',post:'DesktopNotificationReceiptData','schedule-after':'DesktopNotificationReceiptData','schedule-at':'DesktopNotificationReceiptData','schedule-cron':'DesktopNotificationReceiptData',cancel:'DesktopNotificationRemovalData','cancel-all':'DesktopNotificationRemovalData',dismiss:'DesktopNotificationRemovalData','dismiss-all':'DesktopNotificationRemovalData',pending:'DesktopNotificationInventoryData',delivered:'DesktopNotificationInventoryData',tail:'DesktopNotificationTailData',untail:'DesktopNotificationTailData',log:'DesktopNotificationLogData',badge:'DesktopNotificationBadgeData'}
export function desktopNotificationsResultError(action:Record<string,unknown>,data:unknown):string|undefined{
  if(action.type!=='desktop_notifications')return
  const sub=String(action.sub),schema=sub==='categories'?(action.verb??'list')==='list'?'DesktopNotificationCategoriesData':'DesktopNotificationCategoryMutationData':schemas[sub]
  const shape=desktopContractShapeError(data,schema);if(shape)return shape
  const r=data as Record<string,unknown>,ns=String(action.namespace??'default')
  if(Buffer.byteLength(JSON.stringify(r))>DESKTOP_NOTIFICATION_MAX_RESULT_BYTES)return 'notification result exceeds 1MiB'
  if(r.namespace!==undefined&&r.namespace!==ns)return 'notification reply namespace differs from its request'
  if(r.ok!==undefined&&r.ok!==true)return 'notification success receipt must report ok=true'
  if(r.remaining!==undefined&&!integer(r.remaining,0,DESKTOP_NOTIFICATION_MAX_ENTRIES))return 'notification remaining count exceeds its bound'
  if(['tail','untail'].includes(sub)&&(r.name!==action.name||r.tailing!==(sub==='tail')||sub==='untail'&&typeof r.removed!=='boolean'))return 'notification subscription result differs from its exact request'
  if(['post','schedule-after','schedule-at','schedule-cron'].includes(sub)){
    if(!desktopNotificationIdentifier(r.identifier)||!bound(r.nativeIdentifier,512,false)||action.id!==undefined&&r.identifier!==action.id||r.categoryIdentifier!==(action.category??''))return 'notification receipt identity differs from its request'
    const trigger=r.trigger as Record<string,unknown>,repeats=action.repeats??(sub==='schedule-cron')
    if(trigger.repeats!==repeats||trigger.type!==(sub==='post'?'immediate':sub==='schedule-after'?'timeInterval':'calendar')||sub==='schedule-after'&&trigger.seconds!==action.seconds)return 'notification trigger differs from its request'
    if(process.platform==='darwin'&&r.nativeIdentifier!==`interceptor.notifications.v1.${ns}.${r.identifier}`)return 'notification native receipt identity differs from its namespace'
  }
  if(['cancel','dismiss','cancel-all','dismiss-all'].includes(sub)){
    if(['cancel','dismiss'].includes(sub)&&r.id!==action.id||['cancel-all','dismiss-all'].includes(sub)&&r.id!==undefined)return 'notification removal identity differs from its request'
    const removed=r.removed as string[];if(removed.length>1000||new Set(removed).size!==removed.length||removed.some(x=>!desktopNotificationIdentifier(x)||action.id!==undefined&&x!==action.id))return 'notification removal includes invalid or unrelated identifiers'
  }
  if(['pending','delivered'].includes(sub)){
    const rows=r.entries as DesktopNotificationEntry[]
    if(rows.length>Number(action.limit??100)||r.coverage!==(sub==='pending'?(process.platform==='linux'?'owned-scheduled':'native-pending'):process.platform==='linux'?'owned-accepted':'native-delivered')||process.platform==='linux'&&r.partial!==true)return 'notification inventory count/coverage is invalid'
    for(const row of rows){
      if(!desktopNotificationIdentifier(row.identifier)||!bound(row.nativeIdentifier,512,false)||!bound(row.title,4096)||!bound(row.subtitle,4096)||!bound(row.body,32768)||row.attachments.length>8||row.deliveryDate!==undefined&&desktopLogTimestamp(row.deliveryDate)===undefined)return 'notification entry metadata exceeds its native bounds'
      try{desktopNotificationJSON(row.userInfoJSON)}catch{return 'notification user-info result is invalid'}
      if(process.platform==='darwin'&&row.nativeIdentifier!==`interceptor.notifications.v1.${ns}.${row.identifier}`||row.categoryIdentifier!==''&&!desktopNotificationIdentifier(row.categoryIdentifier)||row.threadIdentifier!==''&&!desktopNotificationIdentifier(row.threadIdentifier)||row.badge!==undefined&&!integer(row.badge,0,9999)||row.sound!==null&&!bound(row.sound,512)||row.interruptionLevel!==undefined&&!bound(row.interruptionLevel,512))return 'notification entry identity or feature metadata is invalid'
      for(const attachment of row.attachments)if(!desktopNotificationIdentifier(attachment.identifier)||!bound(attachment.url,32768,false)||attachment.type!==null&&!bound(attachment.type,512))return 'notification attachment metadata is invalid'
      if(row.trigger?.seconds!==undefined&&!integer(row.trigger.seconds,1,DESKTOP_NOTIFICATION_MAX_SECONDS))return 'notification entry interval is invalid'
      if(row.trigger?.components!==undefined){try{desktopNotificationComponents(Object.entries(row.trigger.components).map(([key,value])=>key+'='+value).join(','))}catch{return 'notification native calendar components are invalid'}}
      if(row.trigger?.nextTriggerDate!==undefined&&row.trigger.nextTriggerDate!==null&&desktopLogTimestamp(row.trigger.nextTriggerDate)===undefined)return 'notification native next trigger date is invalid'
    }
    if(new Set(rows.map(x=>x.identifier)).size!==rows.length)return 'notification inventory contains duplicate public identifiers'
  }
  if(sub==='log'){
    const rows=r.entries as DesktopNotificationEvent[];if(rows.length>Number(action.limit??50)||!['distributed-names','owned-events'].includes(String(r.coverage)))return 'notification event count/coverage is invalid'
    let last=-Infinity;for(const row of rows){const stamp=desktopLogTimestamp(row.timestamp);if(stamp===undefined||stamp<last||row.name!==undefined&&!bound(row.name,512,false)||row.object!==undefined&&!bound(row.object,2048)||row.identifier!==undefined&&!desktopNotificationIdentifier(row.identifier)||row.reason!==undefined&&!integer(row.reason,0,4)||row.actionIdentifier!==undefined&&!bound(row.actionIdentifier,512,false))return 'notification event metadata is invalid';last=stamp}
  }
  if(sub==='badge'&&(r.count!==(action.clear?0:action.count)||r.scope!=='application'||r.presentation!=='native-api-accepted'))return 'notification badge result does not describe its actual application scope'
  if(sub==='categories'&&(action.verb??'list')==='list'){
    const rows=r.categories as {identifier:string;actions:DesktopNotificationActionDefinition[];intentIdentifiers:string[];options:number;summaryFormat?:string;hiddenPlaceholder?:string}[]
    if(rows.length>64||new Set(rows.map(x=>x.identifier)).size!==rows.length)return 'notification category result exceeds its count/identity bound'
    for(const row of rows){try{if(!desktopNotificationIdentifier(row.identifier)||row.intentIdentifiers.length>8||!integer(row.options,0,65535)||row.summaryFormat!==undefined&&!bound(row.summaryFormat,2048)||row.hiddenPlaceholder!==undefined&&!bound(row.hiddenPlaceholder,2048))return 'notification category metadata is invalid';desktopNotificationActions(JSON.stringify(row.actions))}catch{return 'notification category actions are invalid'}}
  }
  if(sub==='categories'&&action.verb==='register'&&r.identifier!==action.identifier)return 'notification category receipt differs from its request'
  if(['status','settings'].includes(sub)&&(!bound(r.provider,256,false)||r.scope!=='application'||Object.keys(r.settings as object).some(k=>!['alert','sound','badge','lockScreen','notificationCenter','criticalAlert'].includes(k))))return 'notification status has invalid provider/application scope or settings'
  if(sub==='request'){
    const expected=String(action.options??'alert,sound,badge').split(',').map(s=>s.trim())
    if(JSON.stringify(r.options)!==JSON.stringify(expected)||r.error!==null&&!bound(r.error,4096))return 'notification authorization reply options/error differ from their bounds'
  }
}
