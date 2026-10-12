import {expect,test} from 'bun:test'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {captureShell} from './helpers/shell-capture'

test('actual daemon IPC retains neutral vault validation and the native authority refusal',()=>{
 if(process.platform==='win32')return
 const directory=mkdtempSync(join(tmpdir(),'desktop-vault-ipc-')),result=join(directory,'result.json')
 try{
  const script=`
   const {writeFileSync,readFileSync,existsSync}=await import('node:fs');
   const {createServer,createConnection}=await import('node:net');
   const root=${JSON.stringify(directory)};
   const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
   process.env.INTERCEPTOR_TEMP=root;process.env.INTERCEPTOR_BRIDGE_RUNTIME_DIR=root;process.env.INTERCEPTOR_WS_PORT=String(port);process.env.INTERCEPTOR_SECRETS_META=root+'/metadata.json';
   const delegated=[];
   const bridge=createServer(socket=>{let buffer=Buffer.alloc(0);socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE()){const length=buffer.readUInt32LE(),request=JSON.parse(buffer.subarray(4,4+length).toString());buffer=buffer.subarray(4+length);delegated.push(request.action);const body=Buffer.from(JSON.stringify({id:request.id,result:{success:true,data:{ownedDelegateFixture:true}}})),header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]));}});});await new Promise(resolve=>bridge.listen(root+'/interceptor-bridge.sock',resolve));
   const {sendCommand,sendCommandWs}=await import(${JSON.stringify(new URL('../cli/transport.ts',import.meta.url).pathname)});
   const daemonCode='process.argv.push("--standalone");Object.defineProperty(process,"platform",{value:"linux"});await import('+JSON.stringify(${JSON.stringify(new URL('../daemon/index.ts',import.meta.url).pathname)})+');';
   const child=Bun.spawn([process.execPath,'-e',daemonCode],{env:process.env,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
   const childOutput=new Response(child.stdout).text(),childError=new Response(child.stderr).text();
   const records=[],websocketRefusals=[],delegateRefusals=[],nativeCredentialRefusals=[];
   try{
    for(let i=0;i<100&&!existsSync(root+'/interceptor.sock');i++){if(child.exitCode!==null)throw Error('Owned daemon exited '+child.exitCode);await Bun.sleep(25);}
    const refused=[];
    for(const action of [{type:'desktop_secret',sub:'status'},{type:'macos_secret',sub:'status'},{type:'macos_secrets',sub:'status'},{type:'input_text',ref:'owned',secret:'absent-owned'},{type:'input_text',ref:'owned',browserLogin:{host:'owned.invalid',field:'invalid'}}])for(const vaultToken of [undefined,'0'.repeat(64),'not-a-token']){
     const response=await new Promise((resolve,reject)=>{const socket=createConnection(root+'/interceptor.sock');let buffer=Buffer.alloc(0);socket.on('connect',()=>{const body=Buffer.from(JSON.stringify({id:'owned-missing-token',action,...(vaultToken!==undefined?{vaultToken}: {})})),header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]));});socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE()){resolve(JSON.parse(buffer.subarray(4,4+buffer.readUInt32LE()).toString()).result);socket.destroy();}});socket.on('error',reject);});refused.push(response);
    }
    for(const action of [
     {type:'desktop_secret',sub:'status'},
     {type:'desktop_secret',sub:'list'},
     {type:'desktop_secret',sub:'set',name:null,value:'owned synthetic value'},
     {type:'desktop_secret',sub:'set',name:'owned',value:'owned synthetic value',extra:true},
     {type:'desktop_secret',sub:'unlock',name:'owned',forSeconds:60},
     {type:'desktop_frontmost'},
     {type:'macos_secret',sub:'status'},
    ])records.push((await sendCommand(action)).result);
    for(const action of [{type:'desktop_type',secret:'absent-owned',ref:'e42'},{type:'desktop_type',secret:'absent-owned',ref:'e42',secretLease:'forged'},{type:'desktop_type',secret:'absent-owned',secretLease:'0'.repeat(64)}])nativeCredentialRefusals.push((await sendCommand(action)).result);
    for(const action of [{type:'input_text',secret:'absent-owned',ref:'owned'},{type:'input_text',ref:'owned',browserLogin:{host:'owned.invalid',field:'invalid'}},{type:'desktop_type',secret:'absent-owned',ref:'e42',secretLease:'0'.repeat(64)}])websocketRefusals.push((await sendCommandWs(action)).result);
    async function delegate(action){return new Promise((resolve,reject)=>{const ws=new WebSocket('ws://127.0.0.1:'+port);const timer=setTimeout(()=>{ws.close();reject(Error('Owned delegate deadline'));},3000);ws.onopen=()=>ws.send(JSON.stringify({type:'delegate',id:'owned-delegate',action}));ws.onmessage=event=>{clearTimeout(timer);ws.close();resolve(JSON.parse(String(event.data)).result);};ws.onerror=()=>{clearTimeout(timer);reject(Error('Owned delegate connection failed'));};});}
    for(const action of [{type:'input_text',secret:'absent-owned',ref:'owned'},{type:'input_text',ref:'owned',browserLogin:{host:'owned.invalid',field:'invalid'}},{type:'ios_login',appleId:'owned.invalid',password:'owned synthetic value'}])delegateRefusals.push(await delegate(action));
    const plainDelegate=await delegate({type:'owned_read'});
    const metadataCreated=existsSync(root+'/metadata.json');
    writeFileSync(root+'/metadata.json',JSON.stringify({version:1,secrets:{'owned-malformed':{createdAt:'invalid timestamp',gate:'none',reuseSeconds:0,targets:['any'],releases:0,value:'synthetic metadata must not escape a neutral reply'}}}));
    const malformedList=(await sendCommand({type:'desktop_secret',sub:'list'})).result;
    writeFileSync(${JSON.stringify(result)},JSON.stringify({records,refused,websocketRefusals,delegateRefusals,nativeCredentialRefusals,plainDelegate,delegated,metadataCreated,malformedList}));
   }finally{child.kill('SIGTERM');await child.exited;await new Promise(resolve=>bridge.close(resolve));const details=await childError;const out=await childOutput;writeFileSync(root+'/daemon-stderr',details);writeFileSync(root+'/daemon-stdout',out);if(!existsSync(${JSON.stringify(result)}))process.stderr.write(details+'\\n'+out+'\\n'+(existsSync(root+'/interceptor.log')?readFileSync(root+'/interceptor.log','utf8'):''));}
  `
  const child=captureShell(process.execPath,['-e',script],{timeout:12000})
  expect(child.status,child.stderr).toBe(0)
  const evidence=JSON.parse(readFileSync(result,'utf8'))
  for(const reply of evidence.refused)expect(reply).toMatchObject({success:false,code:'permission_denied'})
  expect(evidence.records[0].success).toBe(true)
  expect(evidence.records[0].data.backend).toBe('linux-secret-service')
  expect(evidence.records[1]).toMatchObject({success:true,data:{secrets:[]}})
  for(const index of [2,3])expect(evidence.records[index]).toMatchObject({success:false,code:'invalid_request'})
  expect(evidence.records[4]).toMatchObject({success:false,code:'target_gone',error:"no secret named 'owned'"})
  expect(evidence.records[5]).toMatchObject({success:false,code:'permission_denied'})
  expect(evidence.records[6]).toMatchObject({success:false,code:'unsupported_operation'})
  for(const reply of evidence.websocketRefusals)expect(reply).toMatchObject({success:false,code:'permission_denied'})
  for(const reply of evidence.delegateRefusals)expect(reply).toMatchObject({success:false,code:'permission_denied'})
  expect(evidence.nativeCredentialRefusals[0]).toMatchObject({success:false,code:'permission_denied'})
  for(const reply of evidence.nativeCredentialRefusals.slice(1))expect(reply).toMatchObject({success:false,code:'target_denied'})
  expect(evidence.plainDelegate).toMatchObject({success:true,data:{ownedDelegateFixture:true}})
  expect(evidence.delegated).toEqual([{type:'owned_read'}])
  expect(evidence.metadataCreated).toBe(false)
  expect(evidence.malformedList.success).toBe(false)
  expect(evidence.malformedList.code).toBe('provider_failed')
  expect(evidence.malformedList.data).toBeUndefined()
  expect(JSON.stringify(evidence.malformedList)).not.toContain('synthetic metadata')
 }finally{rmSync(directory,{recursive:true,force:true})}
},15000)
