import {nativeSecretExecutable,nativeSecretIdentity,sameNativeSecretIdentity} from '../shared/native-secret-target'
import {SecretError,type SecretTarget} from './secrets'
import type {DesktopAxProcessIdentity,DesktopResult} from '../shared/desktop-contract'
import {desktopContractShapeError} from '../shared/desktop-contract-validation'
import {desktopAuthDialogActionError,desktopAuthDialogResultError} from '../shared/desktop-authdialog-validation'

type NativeCall=(action:Record<string,unknown>)=>Promise<DesktopResult>
export async function bindNativeAuthDialogTarget(action:Record<string,unknown>,host:'windows'|'linux',call:NativeCall):Promise<{target:SecretTarget;identity:DesktopAxProcessIdentity;dialogRef:string;beforeRead:()=>Promise<void>}> {
  const canonical:Record<string,unknown>={...action,type:'desktop_authdialog'}
  if(canonical.sub!=='fill'||desktopAuthDialogActionError(canonical))throw new SecretError('target_denied','native authentication fill requires its exact secure field, vault name and direct graphical grant')
  const probe:Record<string,unknown>={type:'desktop_authdialog',sub:'status',ref:action.ref}
  for(const key of ['app','pid','window','dialogRef'])if(action[key]!==undefined)probe[key]=action[key]
  const read=async()=>{
    const result=await call(probe)
    if(!result.success||desktopAuthDialogResultError(probe,result.data))throw new SecretError('target_denied','verified native authentication dialog is unavailable or changed')
    const data=result.data as {present:boolean;dialogRef?:string;targetIdentity?:unknown}
    if(data.present!==true||typeof data.dialogRef!=='string')throw new SecretError('target_denied','native authentication target is absent')
    return {dialogRef:data.dialogRef,identity:nativeSecretIdentity(data.targetIdentity,host)}
  }
  const retained=await read()
  probe.dialogRef=retained.dialogRef
  const typing:Record<string,unknown>={...action,type:'desktop_type'}
  for(const key of ['sub','submit','dialogRef'])delete typing[key]
  const binding=await bindNativeSecretTarget(typing,host,call)
  if(!sameNativeSecretIdentity(retained.identity,binding.identity))throw new SecretError('target_denied','native authentication and grant identities differ')
  return {...binding,dialogRef:retained.dialogRef,beforeRead:async()=>{
    const current=await read()
    if(current.dialogRef!==retained.dialogRef||!sameNativeSecretIdentity(current.identity,retained.identity))throw new SecretError('target_denied','native authentication window changed during approval')
    await binding.beforeRead()
  }}
}
// A target binding is not approval. The existing vault target policy and gate
// still run, then beforeRead revalidates the retained native dialog.
export async function bindMacAuthDialogTarget(action:Record<string,unknown>,call:NativeCall):Promise<{target:SecretTarget;bindingToken:string;beforeRead:()=>Promise<void>}> {
  if(action.sub!=='fill'||typeof action.secret!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(action.secret))throw new SecretError('target_denied','authentication delivery requires its exact vault name')
  const name=action.secret
  const read=async(bindingToken?:string)=>{
    const result=await call({type:'macos_authdialog',sub:'status',secretBindingName:name,...(bindingToken?{bindingToken}:{})})
    const data=result.data as Record<string,unknown>|undefined
    const identity=data?.identity as Record<string,unknown>|undefined
    if(!result.success||!data||data.present!==true||!Number.isSafeInteger(data.pid)||(data.pid as number)<1||(data.pid as number)>0x7fffffff||
       !['password','touchid'].includes(String(data.shape))||typeof data.bindingToken!=='string'||!/^[a-f0-9]{64}$/.test(data.bindingToken)||
       data.bindingPurpose!=='target-identity-only'||!identity||Array.isArray(identity)||
       identity.bundle!=='com.apple.SecurityAgent'||identity.signingRequirement!=='identifier "com.apple.SecurityAgent" and anchor apple'||
       !Number.isSafeInteger(identity.uid)||(identity.uid as number)<0||
       !['processStartSeconds','processStartMicroseconds'].every(key=>typeof identity[key]==='string'&&/^\d{1,20}$/.test(identity[key] as string))||
       Object.keys(identity).some(key=>!['bundle','uid','processStartSeconds','processStartMicroseconds','signingRequirement'].includes(key))||
       bindingToken!==undefined&&data.bindingToken!==bindingToken)throw new SecretError('target_denied','verified Apple authentication dialog identity is unavailable or changed')
    return {pid:data.pid,identity,bindingToken:data.bindingToken}
  }
  const retained=await read()
  return {target:{kind:'macos',id:'com.apple.SecurityAgent'},bindingToken:retained.bindingToken,beforeRead:async()=>{
    const current=await read(retained.bindingToken)
    if(current.pid!==retained.pid||!['bundle','uid','processStartSeconds','processStartMicroseconds','signingRequirement'].every(key=>current.identity[key]===retained.identity[key]))throw new SecretError('target_denied','authentication dialog changed during vault approval')
  }}
}
export async function bindNativeSecretTarget(action:Record<string,unknown>,host:'windows'|'linux',call:NativeCall):Promise<{target:SecretTarget;identity:DesktopAxProcessIdentity;beforeRead:()=>Promise<void>}> {
  if(typeof action.ref!=='string'||!/^e\d{1,63}$/.test(action.ref))throw new SecretError('target_denied','native named-secret typing requires an exact accessibility reference')
  if(typeof action.secret!=='string'||typeof action.secretLease!=='string'||!/^[a-f0-9]{64}$/.test(action.secretLease))throw new SecretError('target_denied','native named-secret typing requires a direct graphical-session grant')
  const canonical:Record<string,unknown>={...action,text:'',sensitive:true,backgroundOnly:true}
  delete canonical.secret
  delete canonical.expectedIdentity
  if(desktopContractShapeError(canonical,'DesktopAxTypeAction')||action.windowTitle!==undefined||action.windowBounds!==undefined)throw new SecretError('target_denied','native named-secret typing requires a strict reference and application/window scope')
  // Carry every supplied scope to the same read and mutation. No frontmost or
  // broad application fallback may choose a different receiving control.
  const probe:Record<string,unknown>={type:'desktop_inspect',ref:action.ref,secretBindingName:action.secret,secretLease:action.secretLease}
  for(const key of ['app','pid','window'])if(action[key]!==undefined)probe[key]=action[key]
  const read=async()=>{
    const result=await call(probe)
    if(!result.success)throw new SecretError('target_denied','native named-secret target is no longer available')
    try{return nativeSecretIdentity((result.data as {targetIdentity?:unknown}|undefined)?.targetIdentity,host)}catch{throw new SecretError('target_denied','native named-secret target identity is unavailable')}
  }
  const identity=await read()
  return {target:{kind:host,id:nativeSecretExecutable(host,identity.executable)},identity,beforeRead:async()=>{if(!sameNativeSecretIdentity(identity,await read()))throw new SecretError('target_denied','native named-secret target changed before the vault read')}}
}
