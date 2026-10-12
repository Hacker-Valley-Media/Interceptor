import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process'
import {desktopProviderBinary} from '../shared/desktop-provider'
import {assertNoInstallMaintenance} from '../shared/install-maintenance'
import type {DesktopResult} from '../shared/desktop-contract'

export interface NativeRegistrationRequest{name:string;gate:string;targets:string[];session:string}
const MAX_REPLY_BYTES=65536
let pending=false

/** Private child stdout contains a credential. Never log or return it to CLI/MCP.
 * The caller stores the value and returns metadata. No public provider verb.
 */
export function readNativeRegistration(child:ChildProcessWithoutNullStreams,request:NativeRegistrationRequest,timeoutMs=600_000):Promise<DesktopResult>{
 return new Promise(resolve=>{
  let buffer=Buffer.alloc(0),settled=false
  const finish=(result:DesktopResult)=>{
   if(settled)return;settled=true;clearTimeout(timer);buffer.fill(0);buffer=Buffer.alloc(0)
   child.stdout.destroy();child.stderr.destroy();child.stdin.destroy()
   if(child.exitCode===null&&child.signalCode===null){child.once('close',()=>resolve(result));child.kill('SIGKILL')}else resolve(result)
  }
  const refused=()=>finish({success:false,code:'provider_failed',error:'Native secure registration failed; no value was stored.'})
  const timer=setTimeout(()=>finish({success:false,code:'cancelled',error:'Native secure registration deadline expired; no value was stored.'}),timeoutMs)
  child.stderr.resume() // Native diagnostics can contain entered data; discard them.
  child.on('error',refused);child.stdin.on('error',refused);child.stdout.on('error',refused)
  child.stdout.on('data',chunk=>{
   if(settled)return
   if(buffer.length+chunk.length>MAX_REPLY_BYTES+4){refused();return}
   const previous=buffer;buffer=Buffer.concat([previous,chunk]);previous.fill(0)
   if(buffer.length>=4&&(buffer.readUInt32LE()===0||buffer.readUInt32LE()>MAX_REPLY_BYTES||buffer.length>buffer.readUInt32LE()+4))refused()
  })
  child.on('close',code=>{
   if(settled)return
   if(code!==0||buffer.length<4||buffer.length!==buffer.readUInt32LE()+4){refused();return}
   try{
    const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(4)))
    if(!result||typeof result!=='object'||Array.isArray(result)||typeof result.success!=='boolean'){refused();return}
    if(result.success===false){finish({success:false,code:result.code==='no_interactive_session'?'no_interactive_session':result.code==='permission_denied'?'permission_denied':'provider_failed',error:'Native secure registration was refused; no value was stored.'});return}
    const data=result.data
    if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.cancelled!=='boolean'||Object.keys(result).some(key=>!['success','data'].includes(key))||Object.keys(data).some(key=>!['cancelled','value'].includes(key))){refused();return}
    if(data.cancelled){if(data.value!==undefined){refused();return}finish({success:true,data:{cancelled:true}});return}
    if(typeof data.value!=='string'||!data.value||Buffer.byteLength(data.value)>8192||data.value.includes('\0')){refused();return}
    finish({success:true,data:{cancelled:false,value:data.value}})
   }catch{refused()}
  })
  const body=Buffer.from(JSON.stringify(request)),header=Buffer.alloc(4);header.writeUInt32LE(body.length)
  child.stdin.end(Buffer.concat([header,body]))
 })
}

export async function callNativeRegistration(request:NativeRegistrationRequest):Promise<DesktopResult>{
 if(pending)return{success:false,code:'resource_limit',error:'Another native secret registration is pending.'}
 pending=true
 try{
  assertNoInstallMaintenance();const binary=desktopProviderBinary()
  if(!binary)return{success:false,code:'not_installed',error:'Native secure registration requires the installed desktop provider.'}
  // This executable is a GUI subsystem application on Windows. Startup-hide
  // also hides its secure form, so reserve that flag for other hosts.
  return await readNativeRegistration(spawn(binary,['--secret-ui'],{stdio:['pipe','pipe','pipe'],windowsHide:process.platform!=='win32'}),request)
 }catch{return{success:false,code:'provider_failed',error:'Native secure registration failed; no value was stored.'}}
 finally{pending=false}
}
