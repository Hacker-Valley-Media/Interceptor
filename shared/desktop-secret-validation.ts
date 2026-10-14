import {desktopContractShapeError} from './desktop-contract-validation'
import {assertName,parseTargets,parseGate} from '../daemon/secrets'
import {DESKTOP_SECRET_DATA_SCHEMAS,type DesktopContractSchema} from './desktop-contract.generated'
import {desktopAuthResultError} from './desktop-auth-validation'

export function desktopSecretActionError(action:Record<string,unknown>,phase:'cli'|'wire'='wire'):string|undefined{
  if(action.type!=='desktop_secret')return
  const shape=desktopContractShapeError(action,'DesktopSecretAction');if(shape)return shape
  const storing=action.sub==='set'||action.sub==='register'
  try{
    if(action.name!==undefined)assertName(action.name)
    if(['register','set','rm','unlock','reveal'].includes(String(action.sub))&&action.name===undefined)return 'secret operation requires a name'
    if(['status','list'].includes(String(action.sub))&&action.name!==undefined)return 'secret status/list do not accept a name'
    if(action.gate!==undefined)parseGate(action.gate)
    if(action.targets!==undefined){if(!Array.isArray(action.targets)||action.targets.length===0||action.targets.length>64||action.targets.some(value=>typeof value!=='string'||value.split(',').some(part=>!part.trim())))return 'secret requires 1..64 nonempty target policies';parseTargets(action.targets)}
  }catch(error){return error instanceof Error?error.message:'invalid secret policy'}
  if(!storing&&['gate','targets','reuseSeconds'].some(key=>action[key]!==undefined))return 'secret storage policy fields require set or register'
  if(action.reuseSeconds!==undefined&&(!Number.isSafeInteger(action.reuseSeconds)||Number(action.reuseSeconds)<0||Number(action.reuseSeconds)>86400))return 'secret reuse requires an integer 0..86400 seconds'
  if(action.forSeconds!==undefined&&(action.sub!=='unlock'||!Number.isSafeInteger(action.forSeconds)||Number(action.forSeconds)<1||Number(action.forSeconds)>86400))return 'secret unlock requires an integer 1..86400 seconds'
  if(action.sub==='unlock'&&action.forSeconds===undefined)return 'secret unlock requires a duration'
  if(action.stdin!==undefined&&(phase!=='cli'||action.sub!=='set'||action.stdin!==true))return 'secret stdin is a CLI-only set option'
  if(phase==='cli'&&action.value!==undefined)return 'secret values must not appear on argv'
  if(phase==='wire'&&action.sub==='set'&&(typeof action.value!=='string'||action.value.length===0))return 'secret set requires a value from stdin or a hidden prompt'
  if(action.sub!=='set'&&action.value!==undefined)return 'only secret set accepts a value'
}

export function desktopSecretResultError(action:Record<string,unknown>,data:unknown):string|undefined{
  if(action.type!=='desktop_secret')return
  const schemas:Readonly<Record<string,DesktopContractSchema>>=DESKTOP_SECRET_DATA_SCHEMAS
  const schema=Object.hasOwn(schemas,String(action.sub))?schemas[String(action.sub)]:undefined
  if(!schema)return 'unknown vault result selector'
  const shape=desktopContractShapeError(data,schema);if(shape)return shape
  const result=data as Record<string,unknown>
  if(result.name!==undefined&&result.name!==action.name)return 'vault reply name does not match the request'
  if(result.backend!==undefined&&!result.backend)return 'vault reply requires its storage backend'
  const acknowledgement=action.sub==='register'||action.sub==='set'?'stored':action.sub==='rm'?'removed':action.sub==='unlock'?'unlocked':undefined
  if(acknowledgement&&result[acknowledgement]!==true)return 'vault success requires a positive acknowledgement'
  try{
    if(result.targets!==undefined){
      const targets=parseTargets(result.targets)
      if(JSON.stringify(targets)!==JSON.stringify(result.targets))return 'vault target policies are not canonical'
      // The Mac registration panel lets the person edit release policy.
      if(action.sub==='set'&&(result.gate!==parseGate(action.gate)||JSON.stringify(targets)!==JSON.stringify(parseTargets(action.targets))))return 'stored vault policy does not match the request'
    }
    if(action.sub==='list'){
      const names=new Set<string>()
      for(const entry of result.secrets as Record<string,unknown>[]){
        const name=assertName(entry.name);if(names.has(name))return 'vault inventory contains duplicate names';names.add(name)
        for(const key of ['createdAt','updatedAt','lastReleasedAt','reuseSeconds','releases'])if(entry[key]!==undefined&&(!Number.isSafeInteger(entry[key])||Number(entry[key])<0))return 'vault metadata requires nonnegative integers'
        if(JSON.stringify(parseTargets(entry.targets))!==JSON.stringify(entry.targets))return 'vault inventory contains noncanonical target policies'
      }
    }
    if(action.sub==='lock'){
      const names=result.locked as string[];for(const name of names)assertName(name)
      if(new Set(names).size!==names.length||action.name!==undefined&&names.some(name=>name!==action.name))return 'vault lock reply contains unrelated or duplicate names'
    }
    if(action.sub==='status'){
      if(!Number.isSafeInteger(result.secrets)||Number(result.secrets)<0||!result.metadata)return 'vault status requires a count and metadata path'
      const names=new Set<string>()
      for(const entry of result.unlocked as {name:string;until:string}[]){assertName(entry.name);if(names.has(entry.name)||!Number.isFinite(Date.parse(entry.until)))return 'vault unlock inventory is invalid';names.add(entry.name)}
      const bridge=result.bridge as Record<string,unknown>
      if(bridge.count!==undefined&&(!Number.isSafeInteger(bridge.count)||Number(bridge.count)<0))return 'vault bridge count is invalid'
      const auth=result.auth as Record<string,unknown>
      if(auth.provider!==undefined){const error=desktopAuthResultError({type:'desktop_auth',sub:'status'},auth);if(error)return error}
    }
  }catch{return 'vault reply contains invalid names or target policies'}
  if(action.sub==='unlock'&&(result.seconds!==action.forSeconds||!Number.isFinite(Date.parse(String(result.until)))))return 'vault unlock duration or expiry does not match the request'
  if(action.sub==='reveal'&&!result.value)return 'vault reveal requires a nonempty value'
}
