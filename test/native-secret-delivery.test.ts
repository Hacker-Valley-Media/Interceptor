import {afterAll,expect,test} from 'bun:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {bindNativeSecretTarget} from '../daemon/native-secret-delivery'
import {nativeSecretIdentity,sameNativeSecretIdentity} from '../shared/native-secret-target'
import {loadMeta,parseTargets,resolveSecret,storeSecret,targetAllowed,type Vault} from '../daemon/secrets'
import {parseMacosCommand} from '../cli/commands/macos'
import {actionLogSummary,inboundLogSummary,isSecretBearing} from '../daemon/redact'
import {pickTimeoutForAction} from '../cli/transport'

const root=mkdtempSync(join(tmpdir(),'interceptor-native-grant-'))
afterAll(()=>rmSync(root,{recursive:true,force:true}))
const identity={host:'linux' as const,pid:42,executable:'/owned/fixture',user:'1000',session:'1:123',creation:'987',image:'device:inode:ctime'}
const lease='a'.repeat(64)
const action={type:'desktop_type',ref:'e42',pid:42,window:123,secret:'owned',secretLease:lease}

test('native policies match exact executable identities and reject broad or relative paths',()=>{
 expect(parseTargets(['windows:C:\\Owned\\Fixture.EXE','linux:/owned/fixture'])).toEqual(['windows:c:\\owned\\fixture.exe','linux:/owned/fixture'])
 expect(targetAllowed(['windows:c:\\owned\\fixture.exe'],{kind:'windows',id:'C:/Owned/Fixture.EXE'})).toBe(true)
 expect(targetAllowed(['linux:/owned/fixture'],{kind:'linux',id:'/owned/Fixture'})).toBe(false)
 expect(targetAllowed(['linux:/owned/fixture'],{kind:'linux',id:'/owned/fixture-other'})).toBe(false)
 expect(targetAllowed(['windows:c:\\owned\\fixture.exe'],{kind:'linux',id:'/owned/fixture'})).toBe(false)
 for(const policy of ['windows:fixture.exe','windows:C:\\Owned\\*','linux:fixture','linux:/owned/../fixture','linux:/owned/fixture\0'])expect(()=>parseTargets([policy])).toThrow()
})

test('native binding refuses absent grants and malformed scope before contacting a provider',async()=>{
 let calls=0
 const call=async()=>{calls++;return {success:true,data:{targetIdentity:identity}}}
 for(const bad of [{...action,secretLease:undefined},{...action,ref:undefined},{...action,extra:true},{...action,windowBounds:{left:0,top:0,width:10,height:10}}])await expect(bindNativeSecretTarget(bad,'linux',call)).rejects.toMatchObject({code:'target_denied'})
 expect(calls).toBe(0)
})

test('approval precedes target revalidation and changed targets prevent all vault reads',async()=>{
 const steps:string[]=[],metaPath=join(root,'changed.json')
 const vault:Vault={backend:'owned memory',set:async()=>{},delete:async()=>true,get:async()=>{steps.push('vault');return 'owned synthetic value'}}
 await storeSecret(vault,'owned','owned synthetic value',{metaPath,targets:['linux:/owned/fixture'],gate:'touchid'})
 let current=identity
 const binding=await bindNativeSecretTarget(action,'linux',async probe=>{steps.push('inspect');expect(probe).toEqual({type:'desktop_inspect',ref:'e42',pid:42,window:123,secretBindingName:'owned',secretLease:lease});return {success:true,data:{targetIdentity:current}}})
 await expect(resolveSecret(vault,'owned',binding.target,{metaPath,beforeRead:binding.beforeRead,gate:async()=>{steps.push('gate');current={...identity,creation:'replacement'};return {ok:true}}})).rejects.toMatchObject({code:'target_denied'})
 expect(steps).toEqual(['inspect','gate','inspect'])
 expect(loadMeta(metaPath).secrets.owned.releases).toBe(0)
})

test('allowlist and gate refusal skip post-gate reads; unchanged targets reach the vault once',async()=>{
 for(const scenario of ['target-denied','gate-denied','approved'] as const){
  const steps:string[]=[],metaPath=join(root,scenario+'.json')
  const vault:Vault={backend:'owned memory',set:async()=>{},delete:async()=>true,get:async()=>{steps.push('vault');return 'owned synthetic value'}}
  await storeSecret(vault,'owned','owned synthetic value',{metaPath,targets:[scenario==='target-denied'?'linux:/other/fixture':'linux:/owned/fixture'],gate:'touchid'})
  const binding=await bindNativeSecretTarget(action,'linux',async()=>{steps.push('inspect');return {success:true,data:{targetIdentity:identity}}})
  const result=resolveSecret(vault,'owned',binding.target,{metaPath,beforeRead:binding.beforeRead,gate:async()=>{steps.push('gate');return {ok:scenario!=='gate-denied'}}})
  if(scenario==='approved'){expect((await result).value).toBe('owned synthetic value');expect(steps).toEqual(['inspect','gate','inspect','vault'])}
  else{await expect(result).rejects.toMatchObject({code:scenario==='target-denied'?'target_denied':'gate_denied'});expect(steps).toEqual(scenario==='target-denied'?['inspect']:['inspect','gate'])}
 }
})

test('native snapshot identity binds host, creation, executable, user, session and image',()=>{
 expect(nativeSecretIdentity(identity,'linux')).toEqual(identity)
 for(const key of ['host','pid','executable','user','session','creation','image'] as const){const changed={...identity,[key]:key==='pid'?43:'changed'};expect(sameNativeSecretIdentity(identity,changed as typeof identity)).toBe(false)}
 for(const bad of [null,{...identity,extra:true},{...identity,pid:42.5},{...identity,host:'windows'},{...identity,user:''},{...identity,session:'1\0'}])expect(()=>nativeSecretIdentity(bad,'linux')).toThrow()
})

test('named native grammar requires exact refs and strict flags; grant envelopes remain masked',()=>{
 expect(parseMacosCommand(['macos','type','e42','--secret','owned','--pid','42'],new Set(),true)).toEqual({type:'macos_type',secret:'owned',ref:'e42',pid:42})
 for(const args of [['--secret','owned'],['e42','--secret','owned','--pid','42.5'],['e42','--secret','owned','--unknown','x'],['e42','--secret','owned','--secret','other']])expect(()=>parseMacosCommand(['macos','type',...args],new Set(),true)).toThrow()
 expect(isSecretBearing({type:'desktop_inspect',secretBindingName:'owned'})).toBe(true)
 expect(actionLogSummary(action)).not.toContain(lease)
 expect(inboundLogSummary({action})).not.toContain(lease)
 expect(inboundLogSummary({action})).toContain('<redacted>')
 expect(inboundLogSummary({result:{success:true,data:{secretLease:lease}}})).not.toContain(lease)
 expect(pickTimeoutForAction(action)).toBe(240000)
 expect(pickTimeoutForAction({type:'desktop_type',text:'ordinary owned input'})).toBe(15000)
})
