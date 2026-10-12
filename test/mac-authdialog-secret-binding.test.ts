import {afterAll,expect,test} from 'bun:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {bindMacAuthDialogTarget} from '../daemon/native-secret-delivery'
import {loadMeta,resolveSecret,storeSecret,type Vault} from '../daemon/secrets'
import {actionLogSummary,inboundLogSummary,outboundLogSummary} from '../daemon/redact'

const root=mkdtempSync(join(tmpdir(),'interceptor-authdialog-binding-'))
afterAll(()=>rmSync(root,{recursive:true,force:true}))
const token='a'.repeat(64)
const action={type:'macos_authdialog',sub:'fill',secret:'owned'}
const identity={bundle:'com.apple.SecurityAgent',uid:501,processStartSeconds:'123',processStartMicroseconds:'456',signingRequirement:'identifier "com.apple.SecurityAgent" and anchor apple'}
const response=(current=identity)=>({success:true,data:{present:true,pid:42,shape:'password',identity:current,bindingToken:token,bindingPurpose:'target-identity-only'}})

test('Mac authentication binding holds the exact process across approval and skips the vault after replacement',async()=>{
 const steps:string[]=[],metaPath=join(root,'changed.json')
 const vault:Vault={backend:'owned memory',set:async()=>{},delete:async()=>true,get:async()=>{steps.push('vault');return 'owned synthetic value'}}
 await storeSecret(vault,'owned','owned synthetic value',{metaPath,targets:['macos:com.apple.SecurityAgent'],gate:'touchid'})
 let current=identity
 const binding=await bindMacAuthDialogTarget(action,async probe=>{steps.push('status');expect(probe).toEqual({type:'macos_authdialog',sub:'status',secretBindingName:'owned',...(steps.length>1?{bindingToken:token}:{})});return response(current)})
 await expect(resolveSecret(vault,'owned',binding.target,{metaPath,beforeRead:binding.beforeRead,gate:async()=>{steps.push('gate');current={...identity,processStartMicroseconds:'457'};return {ok:true}}})).rejects.toMatchObject({code:'target_denied'})
 expect(steps).toEqual(['status','gate','status'])
 expect(loadMeta(metaPath).secrets.owned.releases).toBe(0)
})

test('Mac authentication target and gate denial skip the post-approval probe; approved identity reaches the vault once',async()=>{
 for(const scenario of ['target-denied','gate-denied','approved'] as const){
  const steps:string[]=[],metaPath=join(root,scenario+'.json')
  const vault:Vault={backend:'owned memory',set:async()=>{},delete:async()=>true,get:async()=>{steps.push('vault');return 'owned synthetic value'}}
  await storeSecret(vault,'owned','owned synthetic value',{metaPath,targets:[scenario==='target-denied'?'macos:com.example.Other':'macos:com.apple.SecurityAgent'],gate:'touchid'})
  const binding=await bindMacAuthDialogTarget(action,async()=>{steps.push('status');return response()})
  const result=resolveSecret(vault,'owned',binding.target,{metaPath,beforeRead:binding.beforeRead,gate:async()=>{steps.push('gate');return {ok:scenario!=='gate-denied'}}})
  if(scenario==='approved'){
   expect((await result).value).toBe('owned synthetic value')
   expect(binding.bindingToken).toBe(token)
   expect(steps).toEqual(['status','gate','status','vault'])
  }else{
   await expect(result).rejects.toMatchObject({code:scenario==='target-denied'?'target_denied':'gate_denied'})
   expect(steps).toEqual(scenario==='target-denied'?['status']:['status','gate'])
  }
 }
})

test('Mac authentication binding rejects unverified, malformed, absent or retargeted native proof',async()=>{
 for(const bad of [
  {success:false,code:'permission_denied' as const},
  {...response(),data:{...response().data,present:false}},
  {...response(),data:{...response().data,shape:'unknown'}},
  {...response(),data:{...response().data,pid:42.5}},
  {...response(),data:{...response().data,bindingToken:'invalid'}},
  response({...identity,bundle:'com.example.SecurityAgent'}),
  response({...identity,signingRequirement:'unsigned'}),
  response({...identity,processStartMicroseconds:'replacement'}),
  {...response(),data:{...response().data,identity:{...identity,unverified:true}}},
 ])await expect(bindMacAuthDialogTarget(action,async()=>bad)).rejects.toMatchObject({code:'target_denied'})
 let calls=0
 const binding=await bindMacAuthDialogTarget(action,async()=>({...response(),data:{...response().data,bindingToken:++calls===1?token:'b'.repeat(64)}}))
 await expect(binding.beforeRead()).rejects.toMatchObject({code:'target_denied'})
})

test('authentication bindings and resolved credentials are masked in both logging directions',()=>{
 const sensitive={...action,bindingToken:token,secretBindingName:'owned',sensitive:true,text:'owned synthetic value'}
 expect(actionLogSummary(sensitive)).not.toContain(token)
 expect(outboundLogSummary({id:'owned',action:sensitive})).not.toContain('owned synthetic value')
 expect(outboundLogSummary({id:'owned',action:{type:'macos_authdialog',sub:'fill',text:'owned synthetic value'}})).not.toContain('owned synthetic value')
 for(const summary of [inboundLogSummary,outboundLogSummary]){
  const data={bindingToken:token,secretLease:'b'.repeat(64)}
  expect(summary({id:'owned',result:{success:true,data}})).not.toContain(token)
  expect(summary({id:'owned',result:{success:true,data}})).not.toContain(data.secretLease)
 }
})
