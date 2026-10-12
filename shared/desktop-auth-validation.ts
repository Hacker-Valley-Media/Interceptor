import {desktopContractShapeError} from './desktop-contract-validation'
import {DESKTOP_AUTH_MAX_REASON_BYTES,DESKTOP_AUTH_MAX_TITLE_BYTES,DESKTOP_AUTH_DEADLINE_MS} from './desktop-contract'
import {DESKTOP_AUTH_DATA_SCHEMAS,type DesktopContractSchema} from './desktop-contract.generated'

export function desktopAuthActionError(action:Record<string,unknown>):string|undefined{
  if(action.type!=='desktop_auth')return
  const shape=desktopContractShapeError(action,'DesktopAuthAction');if(shape)return shape
  const confirm=action.sub==='confirm'
  if(!confirm&&['reason','reuse_seconds','fallback_title','cancel_title'].some(key=>action[key]!==undefined))return 'authentication prompt fields require confirm'
  if(action.sub!=='status'&&!confirm&&action.policy!==undefined)return 'authentication policy requires status or confirm'
  if(confirm&&(typeof action.reason!=='string'||!action.reason.trim()))return 'authentication confirm requires a reason'
  for(const [key,cap] of [['reason',DESKTOP_AUTH_MAX_REASON_BYTES],['fallback_title',DESKTOP_AUTH_MAX_TITLE_BYTES],['cancel_title',DESKTOP_AUTH_MAX_TITLE_BYTES]] as const){
    const value=action[key];if(typeof value==='string'&&(value.includes('\0')||Buffer.byteLength(value)>cap))return `authentication ${key} exceeds its text limit or contains NUL`
  }
  if(action.reuse_seconds!==undefined&&(!Number.isSafeInteger(action.reuse_seconds)||Number(action.reuse_seconds)<0||Number(action.reuse_seconds)>300))return 'authentication reuse requires an integer 0..300 seconds'
}

export function desktopAuthResultError(action:Record<string,unknown>,data:unknown):string|undefined{
  if(action.type!=='desktop_auth')return
  const schemas:Readonly<Record<string,DesktopContractSchema>>=DESKTOP_AUTH_DATA_SCHEMAS
  const key=String(action.sub).replaceAll('-','_'),schema=schemas[key]
  if(!schema)return 'unknown authentication result selector'
  const shape=desktopContractShapeError(data,schema);if(shape)return shape
  const result=data as Record<string,unknown>
  if(typeof result.provider!=='string'||!result.provider)return 'authentication provider is required'
  if(['status','confirm'].includes(String(action.sub))){
    if(result.policy!==(action.policy??'any')||typeof result.user!=='string'||!result.user)return 'authentication policy or user does not match the request'
  }
  if(action.sub==='confirm'){
    if(result.reason!==action.reason||!Number.isSafeInteger(result.elapsedMs)||Number(result.elapsedMs)<0||Number(result.elapsedMs)>DESKTOP_AUTH_DEADLINE_MS+5000)return 'authentication confirmation identity or elapsed time is invalid'
    if(result.ok===false&&(typeof result.error!=='string'||!result.error))return 'authentication denial requires an error'
    if(result.ok===true&&(result.error!==undefined||result.errorCode!==undefined))return 'authentication approval cannot contain an error'
  }
  if(action.sub==='status'){
    const policies=result.availablePolicies as string[]
    if(new Set(policies).size!==policies.length||result.canEvaluate!==policies.includes(String(result.policy)))return 'authentication availability is inconsistent with its policies'
  }
  if(action.sub==='domain-state'&&result.available===true&&(typeof result.state!=='string'||!result.state))return 'authentication domain state requires a value'
}
