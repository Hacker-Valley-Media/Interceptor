import {desktopContractShapeError} from './desktop-contract-validation'
export function desktopVadActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_vad')return
  const shape=desktopContractShapeError(a,'DesktopVadAction');if(shape)return shape
  if(a.threshold!==undefined&&(a.sub!=='start'||typeof a.threshold!=='number'||!Number.isFinite(a.threshold)||a.threshold<0||a.threshold>1))return 'VAD threshold requires start and a finite value 0..1'
  for(const key of ['group','groupColor'])if(a[key]!==undefined&&(typeof a[key]!=='string'||!a[key].trim()||Buffer.byteLength(a[key])>256||a[key].includes('\0')))return 'invalid VAD group text'
}
export function desktopVadResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_vad')return
  const shape=desktopContractShapeError(data,a.sub==='status'?'DesktopVadStatus':'DesktopVadLifecycle');if(shape)return shape
  const row=data as Record<string,unknown>
  if(a.sub==='start'&&row.active!==true||a.sub==='stop'&&row.active!==false)return 'VAD lifecycle reply contradicts its operation'
  if(a.sub==='status'&&(typeof row.level!=='number'||!Number.isFinite(row.level)||row.level<0||row.active===false&&(row.speaking!==false||row.level!==0)))return 'VAD status contradicts native activity or finite PCM level'
}
