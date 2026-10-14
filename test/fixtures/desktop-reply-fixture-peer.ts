import {appendFileSync} from 'node:fs'
import {DESKTOP_MAX_FRAME_BYTES,DESKTOP_PROTOCOL_VERSION} from '../../shared/desktop-contract'

// An owned protocol fixture, not an operating-system provider. This executable
// only answers framed stdio requests and records fixture dispatches in a file.
export function accessibilityReplyFixtures(host:NodeJS.Platform=process.platform):Record<string,{args:string[];data:unknown}> {
  const frame={x:1,y:2,width:400,height:200},mac=host==='darwin'
  const node={ref:'e1',role:'textfield',nativeRole:host==='win32'?50004:'entry',name:'Owned fixture',title:'Owned fixture',value:'🙂 文件',pid:42,secure:false,frame:host==='win32'?frame:null}
  const window=mac?{ref:'e1',title:'Owned fixture',windowId:42,frame}:host==='win32'?{windowId:'42',title:'Owned fixture',pid:42,name:'Owned fixture',frame,ref:'e1'}:node
  const input={method:'fixture-only success',background:true,targetPid:42,focusUnchanged:true,cursorUnchanged:true}
  const menu={title:'File',...(host==='win32'?{id:1}:{}),enabled:true,children:[{title:'Owned item',...(host==='win32'?{id:2}:{}),enabled:false,children:[]}]}
  return {
    resize:{args:['resize','e1','400','200'],data:{frame,requested:{width:400,height:200},clamped:false}},
    move:{args:['move','e1','1','2'],data:{frame,requested:{x:1,y:2},clamped:false}},
    apps:{args:['apps'],data:mac?'Mac app inventory':[{name:'Owned fixture',pid:42}]},
    app:{args:['app','hide','--pid','42'],data:mac?'hidden':{subcommand:'hide',pid:42,method:'owned fixture',accepted:true}},
    windows:{args:['windows','--pid','42'],data:[window]},
    frontmost:{args:['frontmost'],data:mac?{name:'Owned fixture',pid:42,bundleId:'com.interceptor.ownedfixture',isActive:true,source:'fixture'}:window},
    focused:{args:['focused','--pid','42'],data:mac?{ref:'e1',role:'AXTextField',name:'Owned fixture',value:'🙂 文件',frame}:node},
    find:{args:['find','Owned fixture','--pid','42'],data:[mac?{ref:'e1',role:'AXTextField',name:'Owned fixture',value:'🙂 文件',frame}:node]},
    inspect:{args:['inspect','e1'],data:mac?{AXRole:'AXTextField',AXValue:'🙂 文件',frame,actions:['AXPress']}:node},
    value_read:{args:['value','e1'],data:'🙂 文件'},
    value_write:{args:['value','e1','🙂 文件'],data:mac?'set value':input},
    type:{args:['type','e1','🙂 文件'],data:mac?'fixture-only success':input},
    click:{args:['click','e1'],data:mac?'clicked':input},
    action:{args:['action','e1','press'],data:mac?'pressed':input},
    keys:{args:['keys','ctrl+a','--pid','42'],data:mac?'keys sent':input},
    scroll:{args:['scroll','down','100','--pid','42'],data:mac?'scrolled':input},
    drag:{args:['drag','e1','e2'],data:mac?'dragged':input},
    menu_list:{args:['menu','--pid','42'],data:mac?'File\n  Owned item':[menu]},
    menu_invoke:{args:['menu','File','Owned item','--pid','42'],data:mac?'invoked':input},
  }
}

export function fixtureReply(mode:string,request:{id:string;action:{type:string}}):{body:Buffer;mutation:boolean} {
  const hello=request.action.type==='desktop_hello'
  const capability={operation:'type',compiled:true,present:true,permission:'not_applicable',session:'fixture',effective:true,background:'semantic',provider:'owned-protocol-fixture',versions:{},limits:[]}
  const metadata:any={host:process.platform,protocolVersion:mode==='version'?99:DESKTOP_PROTOCOL_VERSION,maxFrameBytes:DESKTOP_MAX_FRAME_BYTES,provider:'owned-protocol-fixture',version:'1.0.25',pid:process.pid,session:'fixture',capabilities:[capability,...['fs','clipboard','read','act','inspect_app','open','text','tree','resize','move','apps','app','windows','frontmost','focused','find','inspect','value','click','action','keys','scroll','drag','menu'].map(operation=>({...capability,operation}))]}
  if(mode==='missing-fields')for(const key of ['provider','version','pid','session','capabilities'])delete metadata[key]
  if(mode==='wrong-capabilities')metadata.capabilities='not an array'
  if(mode==='wrong-optional-field')metadata.accessibilityGranted='true'
  const result:any=hello&&mode==='denied'?{success:false,code:'permission_denied',error:'owned fixture denial'}:{success:true,data:hello?metadata:process.platform==='darwin'?'fixture-only success':{method:'fixture-only success',background:true}}
  if(!hello&&mode.startsWith('ax-')) {
    const key=mode.split('-')[1],fixture=accessibilityReplyFixtures()[key]
    if(!fixture)throw Error('unknown accessibility reply fixture')
    result.data=structuredClone(fixture.data)
    if(mode.endsWith('number-invalid'))result.data=42
    else if(mode.endsWith('array-invalid'))result.data=[42]
    else if(mode.endsWith('null-invalid')||mode.endsWith('null-valid'))result.data=null
    else if(mode.endsWith('missing-invalid'))delete result.data
    else if(mode.endsWith('empty-valid'))result.data=[]
    else if(mode.endsWith('unknown-invalid')){
      if(Array.isArray(result.data))result.data[0].unexpected=true
      else result.data=typeof result.data==='object'&&result.data!==null?{...result.data,unexpected:true}:{unexpected:true}
    }else if(mode.endsWith('nested-invalid')){
      if(key==='resize'||key==='move')result.data.requested=key==='resize'?{width:'400',height:200}:{x:'1',y:2}
      else if(key==='menu_list'&&Array.isArray(result.data))result.data[0].children[0].enabled='false'
      else if(Array.isArray(result.data))result.data[0].frame={x:1,y:2,width:400,height:'200'}
      else if(key==='inspect'&&process.platform==='darwin')result.data.actions=[42]
      else if(typeof result.data==='object'&&result.data!==null)result.data[Object.hasOwn(result.data,'background')?'background':'pid']='wrong type'
      else result.data={text:result.data}
    }
  }
  if(!hello&&mode.startsWith('fs-')) {
    const domain=mode.split('-')[1]
    result.data=domain==='read'?{content:'fixture-only content',encoding:'utf8',contentType:'text/plain',attributes:{size:20,modified:'fixture',absolutePath:'/owned/fixture'}}
      :domain==='write'?{written:20,absolutePath:'/owned/fixture',modified:'fixture'}
      :{matches:[{path:'/owned/fixture',name:'fixture',kind:'file'}],indexed:false,source:'owned-fixture',scope:'/owned',query:'fixture',count:1}
    if(mode.endsWith('-invalid')) {
      if(domain==='read')result.data.attributes.size='20'
      else if(domain==='write')result.data.written='20'
      else result.data.matches[0].unexpected=true
    }
    if(mode==='fs-read-denied'){delete result.data;result.success=false;result.code='permission_denied';result.error='owned fixture denial'}
  }
  if(!hello&&mode==='invalid-result-field')result.error=42
  if(!hello&&/^(text|tree)-/.test(mode)) {
    result.data=mode.endsWith('empty-valid')?'':mode.endsWith('unicode-valid')?'Selected 🙂 文件\nsecond line':'fixture text'
    if(mode.endsWith('null-invalid'))result.data=null
    else if(mode.endsWith('number-invalid'))result.data=42
    else if(mode.endsWith('array-invalid'))result.data=[]
    else if(mode.endsWith('object-invalid'))result.data={text:'invented'}
    else if(mode.endsWith('missing-invalid'))delete result.data
  }
  if(!hello&&mode.startsWith('clip-')) {
    const entries={readText:'fixture text',readRtf:'{\\rtf1 fixture}',readImage:'data:image/png;base64,Zml4dHVyZQ==',readFiles:['/owned/fixture'],write:'ok',clear:'ok',tail:{tailing:true,eventPath:'/owned/events.jsonl'},history:[{timestamp:'2026-10-03T00:00:00Z',changeCount:1,types:['text/plain'],preview:'fixture'}],types:['text/plain']}
    const key=mode.split('-')[1] as keyof typeof entries
    result.data=entries[key]
    if(mode.endsWith('-invalid'))result.data=key==='write'||key==='clear'?'not ok':key==='tail'?{tailing:'true'}:key==='history'?[{...entries.history[0],preview:42}]:key==='readFiles'||key==='types'?[42]:42
  }
  if(!hello&&mode.startsWith('compound-')) {
    const domain=mode.split('-')[1],app={name:'fixture',pid:2}
    result.data=domain==='read'?{tree:'fixture',app:'fixture',pid:2}:domain==='act'?{action:'typed',ref:'e1',tree:'fixture'}:{tree:'fixture',apps:[app],target:app,frontmost:app}
    if(domain==='open')result.data={tree:'fixture',app:'fixture',pid:2,windows:[{title:'fixture',windowId:'42',ref:'e1',frame:{x:1,y:2,width:400,height:200}}]}
    if(mode.endsWith('-invalid')) {
      if(domain==='read')result.data.pid=3
      else if(domain==='act') {if(mode.includes('-kind-'))result.data.action='clicked';else result.data.ref='e2'}
      else if(domain==='open'){
        const window=result.data.windows[0]
        if(mode.includes('-duplicate-'))result.data.windows=[window,window]
        else if(mode.includes('-frame-'))window.frame.width=-1
        else if(mode.includes('-ref-'))window.ref='wrong'
        else if(mode.includes('-shape-'))window.frame.unexpected=true
        else if(mode.includes('-id-'))window.windowId='0'
        else result.data.pid=3
      }
      else if(mode.includes('-unknown-'))result.data.target={...app,bundleId:'invented',unknownFields:['bundleId']}
      else if(mode.includes('-shape-'))result.data.tree=null
      else result.data.apps=[app,app]
    }
  }
  const reply={id:!hello&&mode==='wrong-result-id'?'unrelated-id':request.id,result}
  let body=Buffer.from(!hello&&mode==='malformed-result-json'?'{bad}':JSON.stringify(reply))
  if((hello&&mode==='invalid-hello-utf8')||(!hello&&mode==='invalid-result-utf8'))body[body.indexOf(hello?'owned-protocol-fixture':'fixture-only success')]=0xff
  if(hello&&mode==='hello-bom')body=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),body])
  return {body,mutation:!hello}
}

if(import.meta.main) {
  if(process.argv[2]!=='--client'||process.argv[3]!=='owned-stdio-fixture'||!process.env.INTERCEPTOR_FIXTURE_REPLY_MODE||!process.env.INTERCEPTOR_FIXTURE_REPLY_COUNTER)throw Error('owned fixture invocation required')
  let bytes=Buffer.alloc(0)
  process.stdin.on('data',chunk=>{
    bytes=Buffer.concat([bytes,Buffer.from(chunk)])
    while(bytes.length>=4&&bytes.length>=bytes.readUInt32LE()+4){
      const size=bytes.readUInt32LE();if(!size||size>DESKTOP_MAX_FRAME_BYTES)throw Error('fixture frame bound')
      const request=JSON.parse(bytes.subarray(4,size+4).toString());bytes=bytes.subarray(size+4)
      const reply=fixtureReply(process.env.INTERCEPTOR_FIXTURE_REPLY_MODE!,request)
      if(reply.mutation)appendFileSync(process.env.INTERCEPTOR_FIXTURE_REPLY_COUNTER!,request.action.type+'\n')
      const header=Buffer.alloc(4);header.writeUInt32LE(reply.body.length);process.stdout.write(Buffer.concat([header,reply.body]))
    }
  })
}
