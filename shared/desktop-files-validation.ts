import {isAbsolute,normalize,win32} from 'node:path'
import {desktopContractShapeError} from './desktop-contract-validation'
import {desktopLogTimestamp} from './desktop-log-validation'
import {DESKTOP_FILES_MAX_OPEN,DESKTOP_FILES_MAX_RECENT,DESKTOP_FILES_MAX_HISTORY_BYTES,DESKTOP_FILES_MAX_HANDLES,DESKTOP_FILES_MAX_PROCESSES,type DesktopFilesOpenData,type DesktopFilesEvent} from './desktop-contract'

const paths=process.platform==='win32'?win32:{isAbsolute,normalize}
// The provider rebuilds a watched path without its trailing separator; a root (/ or C:\) keeps it.
const trailing=process.platform==='win32'?/[\\/]+$/:/\/+$/
const samePath=(a:string,b:string)=>{const key=(value:string)=>{const n=paths.normalize(value),t=n.replace(trailing,'');return t===''||/^[A-Za-z]:$/.test(t)?n:t};return key(a)===key(b)}
const path=(value:unknown)=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=32768&&!value.includes('\0')&&paths.isAbsolute(value)&&!(process.platform==='win32'&&/^\\\\[.?]\\/.test(value))

export function desktopFilesActionError(action:Record<string,unknown>):string|undefined{
  if(action.type!=='desktop_files')return
  const shape=desktopContractShapeError(action,'DesktopFilesAction');if(shape)return shape
  if(['watch','unwatch'].includes(String(action.sub))){
    if(!path(action.path)||action.limit!==undefined||action.pid!==undefined)return 'files watch/unwatch require one bounded absolute path and no inventory selectors'
  }else{
    if(action.path!==undefined)return 'files recent/open accept no path'
    const max=action.sub==='recent'?DESKTOP_FILES_MAX_RECENT:DESKTOP_FILES_MAX_OPEN
    if(action.limit!==undefined&&(!Number.isSafeInteger(action.limit)||Number(action.limit)<0||Number(action.limit)>max))return `files limit must be an integer in 0..${max}`
    if(action.pid!==undefined&&(action.sub!=='open'||!Number.isSafeInteger(action.pid)||Number(action.pid)<1||Number(action.pid)>(process.platform==='win32'?0xffffffff:0x7fffffff)))return 'files pid requires an exact positive process id on open'
  }
}

export function desktopFilesResultError(action:Record<string,unknown>,data:unknown):string|undefined{
  if(action.type!=='desktop_files')return
  const schema=action.sub==='watch'?'DesktopFilesWatchData':action.sub==='unwatch'?'DesktopFilesUnwatchData':action.sub==='recent'?'DesktopFilesRecentData':'DesktopFilesOpenData'
  const shape=desktopContractShapeError(data,schema);if(shape)return shape
  if(action.sub==='watch'||action.sub==='unwatch'){
    const r=data as Record<string,unknown>,target=r[action.sub==='watch'?'watching':'path']
    if(!path(target)||!samePath(String(target),String(action.path)))return 'files reply target differs from its request'
    if(action.sub==='watch'&&!path(r.eventPath))return 'files event log requires an absolute path'
  }else if(action.sub==='recent'){
    const rows=data as DesktopFilesEvent[]
    if(rows.length>Number(action.limit??20)||Buffer.byteLength(JSON.stringify(rows))>DESKTOP_FILES_MAX_HISTORY_BYTES)return 'files recent result exceeds its requested count or history bytes'
    let previous=-Infinity
    for(const row of rows){const timestamp=desktopLogTimestamp(row.timestamp);if(!path(row.path)||timestamp===undefined||timestamp<previous)return 'file events require bounded absolute paths and chronological RFC3339 timestamps';previous=timestamp}
  }else{
    const r=data as DesktopFilesOpenData
    if(r.scope!==(process.platform==='darwin'?'current-user':'current-user-login'))return 'open file inventory scope differs from the host boundary'
    if(!Number.isSafeInteger(r.count)||r.count!==r.files.length||r.count>Number(action.limit??DESKTOP_FILES_MAX_OPEN)||r.files.some(f=>!path(f))||new Set(r.files).size!==r.count)return 'open file inventory paths/count exceed their bounds'
    if(!Number.isSafeInteger(r.processesInspected)||r.processesInspected<0||r.processesInspected>DESKTOP_FILES_MAX_PROCESSES||!Number.isSafeInteger(r.handlesInspected)||r.handlesInspected<0||r.handlesInspected>DESKTOP_FILES_MAX_HANDLES||!Number.isSafeInteger(r.skippedProcesses)||r.skippedProcesses<0||r.skippedProcesses>DESKTOP_FILES_MAX_PROCESSES)return 'open file inventory coverage counts exceed their bounds'
    if(action.pid!==undefined&&r.processesInspected>1)return 'exact-PID inventory inspected more than its target'
    if(r.partial&&(!r.reason||Buffer.byteLength(r.reason)>4096)||!r.partial&&r.reason!==undefined)return 'partial file inventory must report a bounded reason'
  }
}
