import {expect,test} from 'bun:test'
import {mkdtempSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {captureShell} from './helpers/shell-capture'

test('neutral credentials use daemon IPC while native actions retain the client route',()=>{
 if(process.platform==='win32')return
 const directory=mkdtempSync(join(tmpdir(),'desktop-vault-route-'))
 const resultPath=join(directory,'result.json'),relay=join(directory,'provider-fixture.ts')
 try{
  // This byte relay is an owned provider fixture. It tests route selection,
  // not OS authentication, which is checked against installed providers.
  writeFileSync(relay,`#!${process.execPath}\nimport {createConnection} from 'node:net';\nconst socket=createConnection(process.argv[3]);\nprocess.stdin.pipe(socket);socket.pipe(process.stdout);\nsocket.on('error',()=>process.exit(1));socket.on('close',()=>process.exit(0));\n`)
  chmodSync(relay,0o700)
  const script=`
   const {writeFileSync,unlinkSync}=await import('node:fs');
   const {createServer}=await import('node:net');
   const directory=${JSON.stringify(directory)};
   process.env.INTERCEPTOR_TEMP=directory;
   process.env.INTERCEPTOR_DESKTOP_ENDPOINT=directory+'/native.sock';
   process.env.INTERCEPTOR_DESKTOP_PROVIDER=${JSON.stringify(relay)};
   writeFileSync(directory+'/interceptor.lock',JSON.stringify({pid:process.pid,version:'owned-fixture',execPath:process.execPath,startedAt:new Date().toISOString(),socketPath:directory+'/interceptor.sock',wsPort:20382,mode:'standalone',shutdownProtocolVersion:1,shutdownToken:'1'.repeat(64)}),{mode:0o600});
   Object.defineProperty(process,'platform',{value:'linux'});
   const {sendCommand}=await import(${JSON.stringify(new URL('../cli/transport.ts',import.meta.url).pathname)});
   const {DESKTOP_MAX_FRAME_BYTES,DESKTOP_PROTOCOL_VERSION}=await import(${JSON.stringify(new URL('../shared/desktop-contract.ts',import.meta.url).pathname)});
   const daemonActions=[],nativeActions=[],authenticated=[];
   function server(path,observed,native){return new Promise((resolve,reject)=>{
    const server=createServer(socket=>{let buffer=Buffer.alloc(0);socket.on('data',chunk=>{
     buffer=Buffer.concat([buffer,chunk]);
     while(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE()){
      const size=buffer.readUInt32LE();const request=JSON.parse(buffer.subarray(4,4+size).toString());buffer=buffer.subarray(4+size);
      observed.push(request.action);
      if(!native)authenticated.push(request.vaultToken==='1'.repeat(64));
      const data=native?(request.action.type==='desktop_hello'?{host:'linux',protocolVersion:DESKTOP_PROTOCOL_VERSION,maxFrameBytes:DESKTOP_MAX_FRAME_BYTES,provider:'owned-route-fixture',version:'fixture',pid:process.pid,session:'owned',capabilities:[]}:null):{backend:'owned-daemon-fixture'};
      const bytes=Buffer.from(JSON.stringify({id:request.id,result:{success:true,data}})),header=Buffer.alloc(4);header.writeUInt32LE(bytes.length);socket.write(Buffer.concat([header,bytes]));
     }
    });});server.once('error',reject);server.listen(path,()=>resolve(server));
   });}
   const daemon=await server(directory+'/interceptor.sock',daemonActions,false),native=await server(directory+'/native.sock',nativeActions,true);
   try{
    const secret=await sendCommand({type:'desktop_secret',sub:'status'});
    const credentialActions=[{type:'macos_secret',sub:'list'},{type:'macos_secrets',sub:'get',name:'owned'},{type:'browser_creds',sub:'status'},{type:'input_text',ref:'owned',secret:'owned'},{type:'input_text',ref:'owned',browserLogin:{host:'owned.invalid',field:'pass'}},{type:'ios_login',appleId:'owned.invalid',password:'synthetic owned password'},{type:'desktop_type',text:'synthetic owned password',sensitive:true}];
    for(const action of credentialActions)await sendCommand(action);
    unlinkSync(directory+'/interceptor.lock');let missingLock;
    missingLock=(await sendCommand({type:'desktop_secret',sub:'status'})).result;
    const frontmost=await sendCommand({type:'desktop_frontmost'});
    writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({secret,frontmost,credentialActions,daemonActions,nativeActions,authenticated,missingLock}));
   }finally{await Promise.all([daemon,native].map(server=>new Promise(resolve=>server.close(resolve))));}
  `
  const child=captureShell(process.execPath,['-e',script],{timeout:8000})
  expect(child.status,child.stderr).toBe(0)
  const result=JSON.parse(readFileSync(resultPath,'utf8'))
  expect(result.secret.result).toEqual({success:true,data:{backend:'owned-daemon-fixture'}})
  expect(result.frontmost.result).toEqual({success:true,data:null})
  expect(result.daemonActions).toEqual([{type:'desktop_secret',sub:'status'},...result.credentialActions])
  expect(result.authenticated).toEqual(Array(result.daemonActions.length).fill(true))
  expect(result.missingLock.code).toBe('not_installed');expect(result.missingLock.error).toContain('daemon credential authentication is unavailable')
  expect(result.nativeActions).toEqual([{type:'desktop_hello'},{type:'desktop_frontmost'}])
 }finally{rmSync(directory,{recursive:true,force:true})}
})
