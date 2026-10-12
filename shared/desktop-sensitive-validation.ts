import {desktopContractShapeError} from './desktop-contract-validation'
import {desktopVisionActionError} from './desktop-vision-validation'
import {desktopAction} from './desktop-contract'

export function desktopSensitiveActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_sensitive')return
  const shape=desktopContractShapeError(a,'DesktopSensitiveAction');if(shape)return shape
  if(a.sub==='check'&&a.op!==undefined)return 'sensitive check has no monitor operation'
  if(a.sub==='monitor'){
    const op=a.op??'status'
    if(op!=='start'&&(a.app!==undefined||a.imagePath!==undefined))return `sensitive monitor ${op} takes no --app or --image`
    if(a.imagePath!==undefined)return 'sensitive monitor requires a live app, not a file'
    if(op==='start'&&a.app===undefined)return 'sensitive monitor start requires an explicit app'
  }
  const source=desktopVisionActionError(desktopAction({type:'desktop_vision',sub:'text',app:a.app,imagePath:a.imagePath,group:a.group,groupColor:a.groupColor,groupSoft:a.groupSoft}));if(source)return source.replace(/^vision /,'sensitive ')
}
export function desktopSensitiveResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_sensitive')return
  const shape=desktopContractShapeError(data,a.sub==='check'?'DesktopSensitiveCheck':'DesktopSensitiveMonitor');if(shape)return shape
  const row=data as Record<string,unknown>
  const samples=a.sub==='check'?[row]:row.latest===null?[]:[row.latest as Record<string,unknown>]
  for(const sample of samples)if(sample.policyEnabled!==true||!String(sample.policy).trim()||Buffer.byteLength(String(sample.policy))>128||String(sample.policy).includes('\0')||typeof sample.timestamp!=='number'||!Number.isFinite(sample.timestamp)||sample.timestamp<0)return 'sensitive results require actual enabled policy and observed time'
  if(a.sub==='monitor'&&(!Number.isSafeInteger(row.checks)||Number(row.checks)<0||row.latest===null&&row.checks!==0||row.latest!==null&&Number(row.checks)<1||typeof row.lastError==='string'&&(!row.lastError.trim()||row.lastError.includes('\0')||Buffer.byteLength(row.lastError)>4096)||a.op==='start'&&row.monitoring!==true||a.op==='stop'&&row.monitoring!==false))return 'invalid sensitive monitor measurement/lifecycle state'
  if(Buffer.byteLength(JSON.stringify(data))>16384)return 'sensitive result exceeds its bound'
}
