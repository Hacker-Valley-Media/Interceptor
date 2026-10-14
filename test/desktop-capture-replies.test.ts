import {test,expect} from 'bun:test'
import {createServer} from 'node:net'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {callDesktopProvider} from '../daemon/desktop-provider'
import {fixtureReply} from './fixtures/desktop-reply-fixture-peer'
test.skipIf(process.platform!=='darwin')('capture and display replies reject incompatible image/state/identity fields after one delivery without replay',async()=>{
 const root=mkdtempSync(join(tmpdir(),'capture-replies-')),previous=process.env.INTERCEPTOR_DESKTOP_ENDPOINT
 const screenshot={format:'png',width:1,height:1,originalWidth:1,originalHeight:1,bytes:3,dataUrl:'data:image/png;base64,AQID'}
 const cases:[Record<string,unknown>,unknown,boolean][]=[
  [{type:'desktop_screenshot',format:'png'},screenshot,true],
  ...[{...screenshot,width:-1},{...screenshot,bytes:2},{...screenshot,format:'jpeg'},{...screenshot,originalWidth:0},{...screenshot,filePath:'/tmp/extra'},{...screenshot,dataUrl:'data:image/jpeg;base64,AQID'},{...screenshot,dataUrl:'data:image/png;base64,AQID!!!'}].map(data=>[{type:'desktop_screenshot',format:'png'},data,false] as [Record<string,unknown>,unknown,boolean]),
  [{type:'desktop_screenshot',format:'png',save:true},{...screenshot,dataUrl:undefined,filePath:'/tmp/owned.png'},true],
  [{type:'desktop_screenshot',format:'png',save:true},{...screenshot,dataUrl:undefined,filePath:'relative.png'},false],
  [{type:'desktop_capture',sub:'status'},{active:false,hasFrame:false},true],
  [{type:'desktop_capture',sub:'status'},{active:false,hasFrame:true,frameAgeMs:0},false],
  [{type:'desktop_capture',sub:'status'},{active:true,hasFrame:true},false],
  [{type:'desktop_capture',sub:'status'},{active:true,hasFrame:false,frameAgeMs:0},false],
  [{type:'desktop_capture',sub:'start'},'continuous capture started',true],
  [{type:'desktop_capture',sub:'start'},'ok',false],
  [{type:'desktop_capture',sub:'stop'},'capture stopped',true],
  [{type:'desktop_capture',sub:'frame'},{format:'jpeg',width:1,height:1,bytes:3,dataUrl:'data:image/jpeg;base64,AQID'},true],
  [{type:'desktop_capture',sub:'frame'},{format:'png',width:1,height:1,bytes:3,dataUrl:'data:image/png;base64,AQID'},false],
  [{type:'desktop_display_list'},[{id:1,width:640,height:480,x:0,y:0,isMain:true,isVirtual:false,unknownFields:['isBuiltin']}],true],
  [{type:'desktop_display_list'},[{id:1,width:0,height:480,x:0,y:0,isMain:true,isVirtual:false}],false],
  [{type:'desktop_display_list'},[{id:1,width:640,height:480,x:0,y:0,isMain:true,isVirtual:false,unexpected:true}],false],
  [{type:'desktop_display_list'},[1],false],
  [{type:'desktop_display_info',id:1},{id:1,width:640,height:480,pixelWidth:640,pixelHeight:480,isMain:true,unknownFields:['isBuiltin','rotation','refreshRate']},true],
  [{type:'desktop_display_info',id:1},{id:2,width:640,height:480,pixelWidth:640,pixelHeight:480,isMain:true},false],
  [{type:'desktop_display_info',id:1},{id:1,width:640,height:480,pixelWidth:640,pixelHeight:480,isMain:true,rotation:45},false],
  [{type:'desktop_display_info',id:1},{id:1,width:640,height:480,pixelWidth:640,pixelHeight:480,isMain:true,refreshRate:'60'},false],
  [{type:'desktop_read',pid:2},{tree:'fixture',app:'fixture',pid:2},true],
  [{type:'desktop_read',pid:2},{tree:'fixture',app:'fixture',pid:3},false],
  [{type:'desktop_act',ref:'e1',text:''},{action:'typed',ref:'e1',tree:'fixture'},true],
  [{type:'desktop_act',ref:'e1',text:''},{action:'typed',ref:'e2',tree:'fixture'},false],
  [{type:'desktop_act',ref:'e1',text:''},{action:'clicked',ref:'e1',tree:'fixture'},false],
  [{type:'desktop_inspect_app',pid:2},{tree:'fixture',apps:[{name:'fixture',pid:2}],target:{name:'fixture',pid:2},frontmost:null},true],
  [{type:'desktop_inspect_app',pid:2},{tree:'fixture',apps:[{name:'fixture',pid:2},{name:'fixture',pid:2}],target:{name:'fixture',pid:2},frontmost:null},false],
  [{type:'desktop_inspect_app',pid:2},{tree:'fixture',apps:[],target:{name:'fixture',pid:2,bundleId:'invented',unknownFields:['bundleId']},frontmost:null},false],
 ]
 try{for(let n=0;n<cases.length;n++){
  const[action,data,valid]=cases[n],endpoint=join(root,`${n}.sock`);process.env.INTERCEPTOR_DESKTOP_ENDPOINT=endpoint
  let connections=0,dispatches=0
  const server=createServer(socket=>{connections++;socket.on('error',()=>{});let bytes=Buffer.alloc(0);socket.on('data',chunk=>{
   bytes=Buffer.concat([bytes,Buffer.from(chunk)])
   while(bytes.length>=4&&bytes.length>=bytes.readUInt32LE()+4){const size=bytes.readUInt32LE(),request=JSON.parse(bytes.subarray(4,size+4).toString());bytes=bytes.subarray(size+4)
    const body=request.id==='hello'?fixtureReply('fs-read-valid',request).body:Buffer.from(JSON.stringify({id:request.id,result:{success:true,data}}))
    if(request.id!=='hello')dispatches++
    const header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]))
   }
  })})
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve)})
  try{const result=await callDesktopProvider(action,2000);expect(result.success).toBe(valid);if(!valid)expect(result.code).toBe('timeout_unknown_outcome');expect(dispatches).toBe(1);expect(connections).toBe(1)}finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
 }}finally{if(previous===undefined)delete process.env.INTERCEPTOR_DESKTOP_ENDPOINT;else process.env.INTERCEPTOR_DESKTOP_ENDPOINT=previous;rmSync(root,{recursive:true,force:true})}
})
