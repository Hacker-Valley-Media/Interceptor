import {afterAll,expect,test} from 'bun:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {bindNativeAuthDialogTarget} from '../daemon/native-secret-delivery'
import {loadMeta,resolveSecret,storeSecret,type Vault} from '../daemon/secrets'

const root=mkdtempSync(join(tmpdir(),'interceptor-native-authdialog-'))
afterAll(()=>rmSync(root,{recursive:true,force:true}))
const identity={host:'linux' as const,pid:42,executable:'/usr/lib/polkit-gnome/polkit-gnome-authentication-agent-1',user:'1000',session:'1:123',creation:'987',image:'device:inode:ctime'}
const lease='a'.repeat(64)
const action={type:'desktop_authdialog',sub:'fill',ref:'e42',pid:42,window:123,secret:'owned',secretLease:lease,submit:true}
const status=(current=identity,dialogRef='e41')=>({success:true,data:{present:true,shape:'password',provider:'linux-polkit-dialog',pid:42,title:'Owned native fixture',message:'Owned approval',buttons:['Cancel','Authenticate'],username:'',hasSecureField:true,dialogRef,secureRef:'e42',targetIdentity:current}})

test('native authentication preserves direct grants and the exact window across approval',async()=>{
 const steps:string[]=[],metaPath=join(root,'approved.json')
 const vault:Vault={backend:'owned memory',set:async()=>{},delete:async()=>true,get:async()=>{steps.push('vault');return 'owned synthetic value'}}
 await storeSecret(vault,'owned','owned synthetic value',{metaPath,targets:['linux:'+identity.executable],gate:'touchid'})
 const binding=await bindNativeAuthDialogTarget(action,'linux',async probe=>{
  steps.push(String(probe.type))
  if(probe.type==='desktop_authdialog'){
   expect(probe).toEqual({type:'desktop_authdialog',sub:'status',ref:'e42',pid:42,window:123,...(steps.length>2?{dialogRef:'e41'}:{})});return status()
  }
  expect(probe).toEqual({type:'desktop_inspect',ref:'e42',pid:42,window:123,secretBindingName:'owned',secretLease:lease})
  return {success:true,data:{targetIdentity:identity,secretLease:lease}}
 })
 expect(binding.dialogRef).toBe('e41')
 expect((await resolveSecret(vault,'owned',binding.target,{metaPath,beforeRead:binding.beforeRead,gate:async()=>{steps.push('gate');return {ok:true}}})).value).toBe('owned synthetic value')
 expect(steps).toEqual(['desktop_authdialog','desktop_inspect','gate','desktop_authdialog','desktop_inspect','vault'])
})

test('a moved native password field or replaced process prevents all post-approval vault reads',async()=>{
 for(const scenario of ['window','creation'] as const){
  const steps:string[]=[],metaPath=join(root,scenario+'.json')
  const vault:Vault={backend:'owned memory',set:async()=>{},delete:async()=>true,get:async()=>{steps.push('vault');return 'owned synthetic value'}}
  await storeSecret(vault,'owned','owned synthetic value',{metaPath,targets:['linux:'+identity.executable],gate:'touchid'})
  let approved=false
  const binding=await bindNativeAuthDialogTarget(action,'linux',async probe=>{
   steps.push(String(probe.type))
   if(probe.type==='desktop_authdialog')return status(approved&&scenario==='creation'?{...identity,creation:'988'}:identity,approved&&scenario==='window'?'e43':'e41')
   return {success:true,data:{targetIdentity:identity}}
  })
  await expect(resolveSecret(vault,'owned',binding.target,{metaPath,beforeRead:binding.beforeRead,gate:async()=>{steps.push('gate');approved=true;return {ok:true}}})).rejects.toMatchObject({code:'target_denied'})
  expect(steps).toEqual(['desktop_authdialog','desktop_inspect','gate','desktop_authdialog'])
  expect(loadMeta(metaPath).secrets.owned.releases).toBe(0)
 }
})

test('authentication binding refuses absent grants and mismatched native identity before release',async()=>{
 let calls=0
 await expect(bindNativeAuthDialogTarget({...action,secretLease:undefined},'linux',async()=>{calls++;return status()})).rejects.toMatchObject({code:'target_denied'})
 expect(calls).toBe(0)
 await expect(bindNativeAuthDialogTarget(action,'linux',async probe=>probe.type==='desktop_authdialog'?status():{success:true,data:{targetIdentity:{...identity,creation:'replaced'}}})).rejects.toMatchObject({code:'target_denied'})
 await expect(bindNativeAuthDialogTarget(action,'windows',async()=>status())).rejects.toThrow()
})
