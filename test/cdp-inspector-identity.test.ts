import {expect,test} from 'bun:test'
import {captureShell} from './helpers/shell-capture'
import {resolve} from 'node:path'
import {parseDebugPortFromArgs} from '../shared/cdp-app'
import {CdpManager} from '../daemon/cdp/manager'

test('app detach removes routing and refuses reconnects until explicit attach',async()=>{
  const contexts=new Set(['app:owned'])
  const manager=new CdpManager({emit(){},hasExtensionContext:id=>contexts.has(id),dropExtensionContext:id=>{contexts.delete(id)},mv2ExtensionDir:()=>'/owned-test-extension'})
  expect((await manager.handle({type:'app_detach',contextId:'app:owned'})).success).toBe(true)
  expect(contexts.has('app:owned')).toBe(false)
  expect(manager.acceptsAppRegistration('app:owned')).toBe(false)
  expect(manager.acceptsAppRegistration('browser-profile')).toBe(true)
  expect((await manager.handle({type:'app_detach',contextId:'browser-profile'})).success).toBe(false)
})

test('process debug flags must be whole arguments with bounded ports',()=>{
  for(const command of ['x "--inspect=127.0.0.1:9229"','x --inspect=[::1]:9229'])expect(parseDebugPortFromArgs(command,'inspect')).toBe(9229)
  for(const command of ['x --inspect=0','x --inspect=65536','x --inspect=9229garbage','x --inspect-port=9229','x prefix--inspect=9229','x --inspect=9229.5'])expect(parseDebugPortFromArgs(command,'inspect')).toBeUndefined()
})

test('inspector injection refuses missing or mismatched process identity',()=>{
  // Native WebSocket and fetch must not inherit the shared extension DOM.
  const fixture="const {bootstrapLoadExtension}=await import(\"./daemon/cdp/inspector\");\n  const observed=[];\n  for(const reported of [undefined,process.pid+1]){\n    let injectionCalls=0\n    const server=Bun.serve({\n      port:0,hostname:'127.0.0.1',\n      fetch(request,server){\n        if(new URL(request.url).pathname==='/fixture-inspector'&&server.upgrade(request))return\n        return Response.json({Browser:'node.js/fixture',webSocketDebuggerUrl:`ws://127.0.0.1:${server.port}/fixture-inspector`})\n      },\n      websocket:{\n        message(socket,message){\n          const request=JSON.parse(String(message))\n          let result:Record<string,unknown>={}\n          if(request.method==='Runtime.evaluate'){\n            if(request.params.expression==='process.pid')result={result:{value:reported}}\n            else{injectionCalls++;result={result:{value:{ok:true}}}}\n          }\n          socket.send(JSON.stringify({id:request.id,result}))\n        },\n      },\n    })\n    try{\n      const result=await bootstrapLoadExtension({pid:process.pid,inspectPort:server.port!,extPath:'/owned-test-extension'})\n      observed.push({success:result.success,injectionCalls})\n    }finally{server.stop(true)}\n  }\nconsole.log(JSON.stringify(observed));"
  const child=captureShell(process.execPath,['-e',fixture],{cwd:resolve(import.meta.dir,'..'),timeout:4000})
  expect(child.status,child.stderr).toBe(0)
  expect(JSON.parse(child.stdout)).toEqual([{success:false,injectionCalls:0},{success:false,injectionCalls:0}])
})
