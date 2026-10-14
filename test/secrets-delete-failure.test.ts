import {expect,test} from 'bun:test'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {captureShell} from './helpers/shell-capture'

// The child runs the real daemon and IPC handler with owned backend faults.
// No native credential collection is changed or locked by these fixtures.
for(const backend of ['bun','bridge'] as const){
 test(`${backend} deletion faults preserve policy metadata through actual daemon IPC`,()=>{
  if(process.platform==='win32'||backend==='bridge'&&process.platform!=='darwin')return
  const root=mkdtempSync(join(tmpdir(),'desktop-vault-delete-')),output=join(root,'result.json')
  try{
   const script=`
    const assert=await import('node:assert/strict');
    const {writeFileSync,readFileSync,existsSync}=await import('node:fs');
    const {createServer}=await import('node:net');
    const root=${JSON.stringify(root)},backend=${JSON.stringify(backend)};
    const portProbe=createServer();await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));const port=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
    process.env.INTERCEPTOR_TEMP=root;process.env.INTERCEPTOR_BRIDGE_RUNTIME_DIR=root;process.env.INTERCEPTOR_WS_PORT=String(port);process.env.INTERCEPTOR_SECRETS_META=root+'/metadata.json';process.argv.push('--standalone');
    if(backend==='bun')Object.defineProperty(process,'platform',{value:'linux'});
    let fault='engine',fallbackCalls=0,bridgeCalls=0,bridge;
    Bun.secrets={set:async()=>{},get:async()=>null,delete:async()=>{fallbackCalls++;if(fault==='engine'||fault==='fallback')throw Error('owned native service unavailable');return fault==='success';}};
    if(backend==='bridge'){
     bridge=createServer(socket=>{let buffer=Buffer.alloc(0);socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE()){const length=buffer.readUInt32LE(),request=JSON.parse(buffer.subarray(4,4+length).toString());buffer=buffer.subarray(4+length);let result;
      if(request.action.sub==='status')result={success:true,data:{dataProtection:true}};
      else if(request.action.sub==='delete'){bridgeCalls++;result=fault==='engine'?{success:false,error:'SecItemDelete failed: owned service unavailable (-25308)'}:fault==='missing'?{success:false,error:'secret \\\'owned\\\' not found'}:{success:true,data:{deleted:true}};}
      else result={success:false,error:'owned fixture unsupported operation'};
      const body=Buffer.from(JSON.stringify({id:request.id,result})),header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]));
     }});});await new Promise(resolve=>bridge.listen(root+'/interceptor-bridge.sock',resolve));
    }
    void import(${JSON.stringify(new URL('../daemon/index.ts',import.meta.url).pathname)}).catch(error=>{console.error(error);process.exit(1)});
    for(let i=0;i<100&&!existsSync(root+'/interceptor.lock');i++)await Bun.sleep(25);
    const {sendCommand}=await import(${JSON.stringify(new URL('../cli/transport.ts',import.meta.url).pathname)});
    const metadata=JSON.stringify({version:1,secrets:{owned:{createdAt:1,gate:'none',reuseSeconds:0,targets:['browser:owned.invalid'],releases:0}}});
    const records=[];
    for(const mode of backend==='bridge'?['engine','fallback','missing','success']:['engine','missing','success']){
     fault=mode;fallbackCalls=0;bridgeCalls=0;writeFileSync(root+'/metadata.json',metadata,{mode:0o600});
     const reply=(await sendCommand({type:'desktop_secret',sub:'rm',name:'owned'})).result;
     records.push({mode,reply,metadataUnchanged:readFileSync(root+'/metadata.json','utf8')===metadata,metadataPresent:!!JSON.parse(readFileSync(root+'/metadata.json','utf8')).secrets.owned,fallbackCalls,bridgeCalls});
    }
    writeFileSync(${JSON.stringify(output)},JSON.stringify(records));process.exit(0);
   `
   const child=captureShell(process.execPath,['-e',script],{timeout:15000})
   expect(child.status,child.stderr).toBe(0)
   const records=JSON.parse(readFileSync(output,'utf8'))
   for(const record of records){
    if(['engine','fallback'].includes(record.mode)){
     expect(record.reply).toMatchObject({success:false,code:'provider_failed'})
     expect(record.metadataUnchanged).toBe(true)
     expect(record.metadataPresent).toBe(true)
     if(backend==='bridge'&&record.mode==='engine')expect(record.fallbackCalls).toBe(0)
    }else{
     expect(record.reply).toMatchObject({success:true,data:{removed:true,name:'owned'}})
     expect(record.metadataPresent).toBe(false)
     expect(record.fallbackCalls).toBe(1)
    }
   }
  }finally{rmSync(root,{recursive:true,force:true})}
 },20000)
}
