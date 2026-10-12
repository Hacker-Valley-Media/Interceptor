import {desktopContractShapeError} from './desktop-contract-validation'
import {DESKTOP_LOG_MAX_ENTRIES,DESKTOP_LOG_MAX_RESULT_BYTES} from './desktop-contract'

export type DesktopLogTerm={field:'subsystem'|'category'|'message'|'process'|'level';operator:'=='|'CONTAINS';value:string}
// The neutral surface intentionally accepts this common, literal-only subset.
// Never send arbitrary caller text to NSPredicate or interpolate it into XPath.
export function desktopLogPredicate(value:string):DesktopLogTerm[]{
  if(Buffer.byteLength(value)>4096)throw new Error('log predicate exceeds 4096 bytes')
  const terms:DesktopLogTerm[]=[]
  let rest=value.trim()
  while(rest){
    const match=/^(subsystem|category|message|process|level)\s*(==|CONTAINS)\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")/.exec(rest)
    if(!match)throw new Error('log predicate requires field == "literal" or field CONTAINS "literal", joined by AND')
    const literal:string=JSON.parse(match[3])
    if(literal.includes('\0')||terms.length>=16)throw new Error('log predicate exceeds its literal or term bounds')
    terms.push({field:match[1] as DesktopLogTerm['field'],operator:match[2] as DesktopLogTerm['operator'],value:literal})
    rest=rest.slice(match[0].length).trimStart()
    if(!rest)break
    if(!/^AND\s+/.test(rest))throw new Error('log predicate supports AND between literal comparisons')
    rest=rest.replace(/^AND\s+/,'')
    if(!rest)throw new Error('log predicate ends with AND')
  }
  return terms
}

export function desktopLogTimestamp(value:string):number|undefined{
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if(!m)return
  const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number)
  const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(hour,minute,second,0)
  if(year<1||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||hour>23||minute>59||second>59)return
  if(m[7]!=='Z'&&(Number(m[7].slice(1,3))>23||Number(m[7].slice(4,6))>59))return
  const parsed=Date.parse(value)
  return Number.isFinite(parsed)?parsed:undefined
}

export function desktopLogActionError(action:Record<string,unknown>):string|undefined{
  if(action.type!=='desktop_log_query')return
  const shape=desktopContractShapeError(action,'DesktopLogQueryAction');if(shape)return shape
  if(action.limit!==undefined&&(!Number.isInteger(action.limit)||Number(action.limit)<1||Number(action.limit)>DESKTOP_LOG_MAX_ENTRIES))return 'log limit must be an integer in 1..1000'
  if(action.since!==undefined&&desktopLogTimestamp(String(action.since))===undefined)return 'log since requires a valid RFC3339 timestamp'
  try{if(action.predicate!==undefined)desktopLogPredicate(String(action.predicate))}catch(error){return (error as Error).message}
  return
}

export function desktopLogResultError(action:Record<string,unknown>,data:unknown):string|undefined{
  if(action.type!=='desktop_log_query')return
  const shape=desktopContractShapeError(data,'DesktopLogQueryData');if(shape)return shape
  const result=data as {entries:Record<string,string>[];count:number;scope:string}
  if(!Number.isInteger(result.count)||result.count!==result.entries.length||result.count>Number(action.limit??100)||Buffer.byteLength(JSON.stringify(result))>DESKTOP_LOG_MAX_RESULT_BYTES)return 'log result count or byte bounds are invalid'
  const terms=desktopLogPredicate(String(action.predicate??''))
  let previous=-Infinity
  const since=action.since===undefined?-Infinity:desktopLogTimestamp(String(action.since))!
  for(const entry of result.entries){
    const timestamp=desktopLogTimestamp(entry.timestamp)
    if(timestamp===undefined||timestamp<previous||timestamp<since)return 'log timestamps must be valid and chronological from since'
    previous=timestamp
    if(Object.entries(entry).some(([key,value])=>key!=='message'&&key!=='timestamp'&&Buffer.byteLength(value)>4096))return 'log metadata exceeds its bounds'
    if((entry.level==='info'&&!action.includeInfo)||(entry.level==='debug'&&!action.includeDebug))return 'log result includes a excluded level'
    if(terms.some(term=>term.operator==='=='?entry[term.field]!==term.value:!entry[term.field]?.includes(term.value)))return 'log result does not match its predicate'
  }
  return
}
