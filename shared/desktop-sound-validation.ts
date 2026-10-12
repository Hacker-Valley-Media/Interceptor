import {desktopContractShapeError,type DesktopContractRootSchema} from './desktop-contract-validation'
import {DESKTOP_SOUND_MAX_HISTORY} from './desktop-contract'

export function desktopSoundActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_sounds')return
  const shape=desktopContractShapeError(a,'DesktopSoundAction');if(shape)return shape
  if(a.filter!==undefined&&a.sub!=='log')return 'sound filter requires log'
  for(const key of ['filter','group','groupColor'])if(a[key]!==undefined&&(typeof a[key]!=='string'||!String(a[key]).trim()||String(a[key]).includes('\0')||Buffer.byteLength(String(a[key]))>(key==='filter'?4096:256)))return 'invalid bounded sound filter/group'
}
export function desktopSoundResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_sounds')return
  const schemas:Readonly<Record<string,DesktopContractRootSchema>>={start:'DesktopSoundStarted',stop:'DesktopSoundStopped',status:'DesktopSoundStatus',tail:'DesktopSoundTail',log:'DesktopSoundClassification[]'}
  const schema=schemas[String(a.sub)];if(!schema)return 'unknown sound result selector'
  const shape=desktopContractShapeError(data,schema);if(shape)return shape
  const row=data as Record<string,unknown>
  if(a.sub==='start'&&row.classifying!==true||a.sub==='stop'&&(row.classifying!==false||!Number.isSafeInteger(row.totalClassifications)||Number(row.totalClassifications)<0||Number(row.totalClassifications)>DESKTOP_SOUND_MAX_HISTORY))return 'invalid native sound lifecycle acknowledgement'
  const entries=a.sub==='log'?data:a.sub==='tail'?row.classifications:a.sub==='status'&&row.latest!==null?[row.latest]:[]
  if(!Array.isArray(entries)||entries.length>DESKTOP_SOUND_MAX_HISTORY||Buffer.byteLength(JSON.stringify(data))>1_048_576)return 'sound history exceeds its bound'
  for(const entry of entries){
    if(!entry.label.trim()||entry.label.includes('\0')||Buffer.byteLength(entry.label)>512||entry.confidence<=0.3||entry.confidence>1||entry.timestamp<0||!Number.isFinite(entry.timestamp))return 'invalid observed sound classification'
    if(a.filter!==undefined&&!entry.label.includes(String(a.filter)))return 'sound filter does not match the returned classification'
  }
}
