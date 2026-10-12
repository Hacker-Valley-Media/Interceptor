import {desktopContractShapeError} from './desktop-contract-validation'
import type {DesktopContractSchema} from './desktop-contract.generated'

const eventFields=['title','start','end','all_day','location','notes','url','alarms','attendees','recurrence_frequency','recurrence_interval','recurrence_end']
export const DESKTOP_CALENDAR_FIELDS:Record<string,string[]>={status:[],request:['level'],list:[],default:[],sources:[],'create-calendar':['title','color','cal_type','source'],'delete-calendar':['id'],events:['start','end','calendar','calendars','limit','offset'],event:['id'],'event-by-external':['id','limit','offset'],create:[...eventFields,'calendar'],update:['id','span',...eventFields],delete:['id','span'],move:['id','to'],'refresh-sources':[],reset:[],tail:[]}
const reminderFields=['title','due','start','priority','notes','url']
export const DESKTOP_REMINDERS_FIELDS:Record<string,string[]>={status:[],request:[],lists:[],default:[],all:['list','limit','offset'],incomplete:['list','due_start','due_end','limit','offset'],completed:['list','since','until','limit','offset'],create:['list',...reminderFields],update:['id',...reminderFields],complete:['id'],uncomplete:['id'],delete:['id']}

export function eventKitInstant(text:unknown):number|undefined {
  if(typeof text!=='string')return
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(text)
  if(!m)return
  const [y,mo,d,h,mi,se]=m.slice(1,7).map(Number), leap=y%4===0&&(y%100!==0||y%400===0)
  if(y<1||mo<1||mo>12||d<1||d>[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][mo-1]||h>23||mi>59||se>59)return
  if(m[7]!=='Z'&&(Number(m[7].slice(1,3))>23||Number(m[7].slice(4))>59))return
  const n=Date.parse(text);return Number.isFinite(n)?n:undefined
}
export function desktopEventKitActionError(a:Record<string,unknown>):string|undefined {
  const calendar=a.type==='desktop_calendar';if(!calendar&&a.type!=='desktop_reminders')return
  const shape=desktopContractShapeError(a,calendar?'DesktopCalendarAction':'DesktopRemindersAction');if(shape)return shape
  const sub=String(a.sub),allowed=(calendar?DESKTOP_CALENDAR_FIELDS:DESKTOP_REMINDERS_FIELDS)[sub]
  if(Object.keys(a).some(k=>!['type','sub',...allowed].includes(k)))return 'field does not belong to '+(calendar?'calendar ':'reminders ')+sub
  for(const [k,v]of Object.entries(a))if(typeof v==='string'&&(Buffer.byteLength(v)>(k==='notes'?65536:4096)||v.includes('\0')||!['notes','location','url'].includes(k)&&!v.trim()))return 'invalid or oversized '+k
  for(const k of ['limit','offset','recurrence_interval'])if(a[k]!==undefined&&(!Number.isInteger(a[k])||Number(a[k])<(k==='offset'?0:1)||Number(a[k])>(k==='limit'?1000:10000)))return k+' must be an integer from '+(k==='offset'?0:1)+' to '+(k==='limit'?1000:10000)
  const required=calendar?(['delete-calendar','event','event-by-external','update','delete','move'].includes(sub)?['id']:sub==='create'?['title','start','end']:sub==='events'?['start','end']:sub==='create-calendar'?['title']:[]):(['update','complete','uncomplete','delete'].includes(sub)?['id']:sub==='create'?['title']:sub==='completed'?['since','until']:[])
  if(required.some(k=>a[k]===undefined)||calendar&&sub==='move'&&a.to===undefined)return 'missing required '+[...required.filter(k=>a[k]===undefined),...(calendar&&sub==='move'&&a.to===undefined?['to']:[])].map(k=>'--'+k.replace(/_/g,'-')).join(', ')
  if(sub==='update'&&!(calendar?eventFields:reminderFields).some(k=>a[k]!==undefined))return 'update requires at least one field to change'
  for(const k of ['start','end','due','due_start','due_end','since','until'])if(a[k]!==undefined&&eventKitInstant(a[k])===undefined)return 'invalid actual ISO8601 instant '+k
  if(!calendar&&a.start!==undefined&&a.due!==undefined&&eventKitInstant(a.due)!<eventKitInstant(a.start)!)return 'the due date is before the start date'
  for(const [lo,hi]of [['start','end'],['due_start','due_end'],['since','until']])if(a[lo]!==undefined&&a[hi]!==undefined){const x=eventKitInstant(a[lo])!,y=eventKitInstant(a[hi])!;if(y<=x||y-x>1461*86400000)return 'the end must be after the start, within 1461 days'}
  if(a.level!==undefined&&!['full','write'].includes(String(a.level)))return 'calendar level requires full or write'
  if(a.span!==undefined&&!['this','future'].includes(String(a.span)))return 'calendar span requires this or future'
  if(a.cal_type!==undefined&&!['local','calDAV','exchange','subscribed'].includes(String(a.cal_type)))return 'unknown calendar source type'
  if(a.color!==undefined&&!/^#[0-9a-fA-F]{6}$/.test(String(a.color)))return 'calendar color requires #RRGGBB'
  if(a.priority!==undefined&&!['none','high','medium','low'].includes(String(a.priority)))return 'unknown reminder priority'
  if(a.calendar!==undefined&&a.calendars!==undefined)return 'one exact calendar scope required'
  if(a.calendars!==undefined){const ids=String(a.calendars).split(',');if(ids.length>128||ids.some(x=>!x.trim()||x.trim()!==x)||new Set(ids).size!==ids.length)return 'invalid exact calendar identities'}
  if(a.url!==undefined&&a.url!==''){try{if(!new URL(String(a.url)).protocol)return 'absolute URL required'}catch{return 'absolute URL required'}}
  if(a.attendees!==undefined&&(!Array.isArray(a.attendees)||a.attendees.length))return 'attendees are read-only; no change was made'
  if(a.alarms!==undefined&&(!Array.isArray(a.alarms)||a.alarms.length>32||a.alarms.some(x=>typeof x!=='string'||eventKitInstant(x)===undefined&&(!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(x)||!Number.isFinite(Number(x))||Math.abs(Number(x))>315576000))))return 'invalid bounded absolute or relative alarm'
  if(a.recurrence_frequency!==undefined&&!['daily','weekly','monthly','yearly'].includes(String(a.recurrence_frequency)))return 'unknown recurrence frequency'
  if((a.recurrence_interval!==undefined||a.recurrence_end!==undefined)&&a.recurrence_frequency===undefined)return 'recurrence fields require frequency'
  if(a.recurrence_end!==undefined&&eventKitInstant(a.recurrence_end)===undefined&&(!/^[1-9]\d{0,5}$/.test(String(a.recurrence_end))||Number(a.recurrence_end)>100000))return 'recurrence end requires an instant or an occurrence count from 1 to 100000'
  if(Buffer.byteLength(JSON.stringify(a))>262144)return 'calendar/reminders request exceeds 256 KiB'
}

export function desktopEventKitResultError(a:Record<string,unknown>,value:unknown):string|undefined {
  const calendar=a.type==='desktop_calendar';if(!calendar&&a.type!=='desktop_reminders')return
  const sub=String(a.sub),data=value as Record<string,unknown>
  const schema=calendar?({status:'DesktopCalendarStatus',request:'DesktopCalendarRequested',list:'DesktopCalendarList',default:data?.calendar===null?'DesktopCalendarNoDefault':'DesktopCalendarRow',sources:'DesktopCalendarSources','create-calendar':'DesktopCalendarRow','delete-calendar':'DesktopCalendarDeleted',events:'DesktopCalendarEvents',event:'DesktopCalendarEvent','event-by-external':'DesktopCalendarEvents',create:'DesktopCalendarEvent',update:'DesktopCalendarEvent',delete:'DesktopCalendarDeleted',move:'DesktopCalendarEvent','refresh-sources':'DesktopCalendarOK',reset:'DesktopCalendarOK',tail:'DesktopCalendarTail'}[sub]):({status:'DesktopRemindersStatus',request:'DesktopRemindersRequested',lists:'DesktopRemindersLists',default:data?.list===null?'DesktopRemindersNoDefault':'DesktopRemindersList',all:'DesktopRemindersRows',incomplete:'DesktopRemindersRows',completed:'DesktopRemindersRows',create:'DesktopRemindersRow',update:'DesktopRemindersRow',complete:'DesktopRemindersRow',uncomplete:'DesktopRemindersRow',delete:'DesktopCalendarDeleted'}[sub])
  if(!schema)return 'unknown calendar/reminders result selector'
  const shape=desktopContractShapeError(value,schema as DesktopContractSchema);if(shape)return shape
  if(Buffer.byteLength(JSON.stringify(data))>1048576)return 'calendar/reminders reply exceeds 1 MiB'
  const bounded=(v:unknown,depth=0):boolean=>depth<=8&&(typeof v==='string'?Buffer.byteLength(v)<=65536&&!v.includes('\0'):typeof v==='number'?Number.isFinite(v):Array.isArray(v)?v.length<=1000&&v.every(x=>bounded(x,depth+1)):v!==null&&typeof v==='object'?Object.values(v).every(x=>bounded(x,depth+1)):v===null||typeof v==='boolean')
  if(!bounded(value))return 'calendar/reminders reply exceeds its nested bounds'
  if(data.ok!==undefined&&data.ok!==true)return 'calendar/reminders reply lacks an effect receipt'
  if(sub==='delete'||sub==='delete-calendar')if(data.id!==a.id)return 'calendar/reminders deletion identity differs'
  for(const key of ['calendars','lists','sources','events','reminders'])if(Array.isArray(data[key])){const rows=data[key] as Record<string,unknown>[];if(rows.some(r=>typeof r.id!=='string'||!r.id.trim()||Buffer.byteLength(r.id)>4096))return 'missing actual native calendar/reminders identity'}
  if(data.id!==undefined&&(typeof data.id!=='string'||!data.id.trim()||Buffer.byteLength(data.id)>4096))return 'missing native calendar/reminders identity'
  if(calendar&&sub==='event'&&data.id!==a.id)return 'native event read differs from the exact requested identity'
  if(!calendar&&['update','complete','uncomplete'].includes(sub)&&data.id!==a.id)return 'native reminder mutation differs from the exact requested identity'
  if(data.limit!==undefined){const rows=(data.events??data.reminders) as unknown[];if(data.limit!==(a.limit??100)||data.offset!==(a.offset??0)||rows.length>Number(data.limit)||typeof data.hasMore!=='boolean')return 'calendar/reminders page differs from the requested bounds'}
  const events=calendar?(Array.isArray(data.events)?data.events:data.calendarId!==undefined?[data]:[]):[]
  for(const row of events as Record<string,unknown>[]){if(typeof row.calendarId!=='string'||!row.calendarId.trim()||eventKitInstant(row.startDate)===undefined||eventKitInstant(row.endDate)===undefined||eventKitInstant(row.endDate)!<eventKitInstant(row.startDate)!)return 'invalid native event interval or calendar';if(a.calendar!==undefined&&row.calendarId!==a.calendar||a.calendars!==undefined&&!String(a.calendars).split(',').includes(String(row.calendarId))||sub==='move'&&row.calendarId!==a.to)return 'native event differs from exact calendar scope'}
  const reminders=!calendar?(Array.isArray(data.reminders)?data.reminders:data.listId!==undefined?[data]:[]):[]
  for(const row of reminders as Record<string,unknown>[]){if(typeof row.listId!=='string'||!row.listId.trim()||!['none','high','medium','low'].includes(String(row.priority)))return 'invalid native reminder list or priority';if(a.list!==undefined&&row.listId!==a.list||sub==='incomplete'&&row.isCompleted!==false||['complete','completed'].includes(sub)&&row.isCompleted!==true||sub==='uncomplete'&&row.isCompleted!==false)return 'native reminder differs from requested state or list';if(row.completionDate!==undefined&&eventKitInstant(row.completionDate)===undefined)return 'invalid native reminder completion instant'}
  if(sub==='tail'&&(!Number.isSafeInteger(data.changeCount)||Number(data.changeCount)<0||data.tailing!==true||data.lastChange!==null&&eventKitInstant(data.lastChange)===undefined))return 'invalid native Calendar change counter'
}
