import {expect,test} from 'bun:test'
import {createServer} from 'node:net'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {desktopAuthActionError,desktopAuthResultError} from '../shared/desktop-auth-validation'
import {parseMacosCommand} from '../cli/commands/macos'
import {callDesktopProvider} from '../daemon/desktop-provider'
import {DESKTOP_MAX_FRAME_BYTES} from '../shared/desktop-contract'
import {pickTimeoutForAction} from '../cli/transport'

const action={type:'desktop_auth',sub:'confirm',reason:'Owned authentication 验证',policy:'any'}
const approved={ok:true,policy:'any',provider:'owned-fixture',user:'owned-current-user',reason:action.reason,elapsedMs:25,biometryType:'unspecified'}
test('neutral authentication rejects invalid prompts before native initialization',()=>{
  expect(desktopAuthActionError(action)).toBeUndefined()
  for(const fields of [{sub:'unknown'},{reason:''},{reason:'  '},{reason:'a\0b'},{reason:'界'.repeat(683)},{reuse_seconds:0.5},{reuse_seconds:-1},{reuse_seconds:301},{policy:'unknown'},{policy:null},{fallback_title:'x'.repeat(129)},{cancel_title:null},{extra:true}])expect(desktopAuthActionError({...action,...fields})).toBeString()
  for(const sub of ['status','invalidate','domain-state']){
    expect(desktopAuthActionError({type:'desktop_auth',sub})).toBeUndefined()
    expect(desktopAuthActionError({type:'desktop_auth',sub,reason:'a'})).toBeString()
  }
  expect(pickTimeoutForAction(action)).toBe(180000)
})
test('neutral auth parser rejects duplicate flags, missing values and extra positionals',()=>{
  for(const values of [[],['unknown'],['status','extra'],['confirm'],['confirm','x','extra'],['confirm','x','--reuse','1.5'],['confirm','x','--policy','any','--policy','any'],['confirm','x','--unknown','a'],['confirm','x','--cancel-title']])expect(()=>parseMacosCommand(['macos','auth',...values],undefined,true)).toThrow()
  expect(parseMacosCommand(['macos','auth','confirm','--policy','any',action.reason,'--reuse','0'],undefined,true)).toEqual({type:'macos_auth',sub:'confirm',reason:action.reason,policy:'any',reuse_seconds:0})
  expect(parseMacosCommand(['macos','auth','confirm','legacy','--policy','legacy-unknown'])?.policy).toBe('legacy-unknown')
})
test('authentication replies cannot invent approval from a denial or a different policy',()=>{
  expect(desktopAuthResultError(action,approved)).toBeUndefined()
  expect(desktopAuthResultError(action,{...approved,ok:false,error:'Owned cancellation'})).toBeUndefined()
  for(const fields of [{ok:'true'},{ok:false},{policy:'biometry'},{reason:'another request'},{elapsedMs:-1},{elapsedMs:175001},{elapsedMs:0.5},{user:''},{provider:''},{error:'cancelled'},{errorCode:7},{extra:true}])expect(desktopAuthResultError(action,{...approved,...fields})).toBeString()
  const status={canEvaluate:true,policy:'any',provider:'owned',user:'owner',biometryType:'unspecified',availablePolicies:['any']}
  expect(desktopAuthResultError({type:'desktop_auth',sub:'status'},status)).toBeUndefined()
  expect(desktopAuthResultError({type:'desktop_auth',sub:'status'},{...status,availablePolicies:[]})).toBeString()
  expect(desktopAuthResultError({type:'desktop_auth',sub:'status'},{...status,availablePolicies:['any','any']})).toBeString()
})
test('native authentication client rejects forged replies without replaying a prompt',async()=>{
  const root=mkdtempSync(join(tmpdir(),'desktop-auth-')),endpoint=join(root,'p.sock'),prior=process.env.INTERCEPTOR_DESKTOP_ENDPOINT
  process.env.INTERCEPTOR_DESKTOP_ENDPOINT=endpoint
  let result:unknown=approved,mutations=0
  const server=createServer(socket=>{let buffer=Buffer.alloc(0);socket.on('data',chunk=>{buffer=Buffer.concat([buffer,Buffer.from(chunk)]);while(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE()){
    const size=buffer.readUInt32LE(),request=JSON.parse(buffer.subarray(4,4+size).toString());buffer=buffer.subarray(4+size)
    const hello=request.action.type==='desktop_hello';if(!hello)mutations++
    const data=hello?{host:process.platform,protocolVersion:1,maxFrameBytes:DESKTOP_MAX_FRAME_BYTES,provider:'fixture',version:'fixture',pid:process.pid,session:'fixture',capabilities:[]}:result
    const body=Buffer.from(JSON.stringify({id:request.id,result:{success:true,data}})),header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]))
  }})})
  await new Promise<void>(resolve=>server.listen(endpoint,resolve))
  try{
    expect((await callDesktopProvider(action,2000)).data).toEqual(approved)
    for(const fields of [{policy:'biometry'},{ok:false},{reason:'wrong request'}]){result={...approved,...fields};expect((await callDesktopProvider(action,2000)).code).toBe('timeout_unknown_outcome')}
    expect(mutations).toBe(4)
    expect((await callDesktopProvider({...action,reason:''},2000)).code).toBe('invalid_request');expect(mutations).toBe(4)
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));if(prior===undefined)delete process.env.INTERCEPTOR_DESKTOP_ENDPOINT;else process.env.INTERCEPTOR_DESKTOP_ENDPOINT=prior;rmSync(root,{recursive:true,force:true})
  }
})
