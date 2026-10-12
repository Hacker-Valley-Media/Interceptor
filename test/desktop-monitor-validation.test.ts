import {expect,test} from 'bun:test'
import {desktopMonitorActionError,desktopMonitorResultError,desktopMonitorEventPayloadError} from '../shared/desktop-monitor-validation'
import payloads from '../shared/desktop-monitor-payload-fixtures.json'
import macPayloads from '../shared/desktop-monitor-macos-payload-fixtures.json'
import {DESKTOP_CONTRACT_FIELDS} from '../shared/desktop-contract.generated'
import {desktopContractShapeError} from '../shared/desktop-contract-validation'
import {parseMacosCommand} from '../cli/commands/macos'
import {callDesktopProvider} from '../daemon/desktop-provider'

test('Mac emitter payloads preserve actual optional fields and refuse malformed records',()=>{
  const header={sid:'owned123',s:0,t:1}
  const known=DESKTOP_CONTRACT_FIELDS.DesktopMonitorMacPayloadSchemas.map(field=>field.name)
  expect([...new Set(macPayloads.valid.map(row=>row.event).filter(event=>event!=='owned_extension'))].sort()).toEqual([...known].sort())
  for(const payload of macPayloads.valid){
    expect(desktopMonitorEventPayloadError({...header,...payload},'macos')).toBeUndefined()
    expect(desktopMonitorEventPayloadError({...header,...payload,unexpected:null},'macos')===undefined).toBe(payload.event==='owned_extension')
    if(process.platform==='darwin')expect(desktopMonitorResultError({type:'desktop_monitor',sub:'tail',sid:header.sid,limit:1},[{...header,...payload}])).toBeUndefined()
  }
  for(const payload of macPayloads.invalid){
    expect(desktopMonitorEventPayloadError({...header,...payload},'macos')).toBeDefined()
    if(process.platform==='darwin')expect(desktopMonitorResultError({type:'desktop_monitor',sub:'tail',sid:header.sid,limit:1},[{...header,...payload}])).toBeDefined()
  }
})

test('monitor archive and recording boundaries refuse malformed input before dispatch',async()=>{
  const malformed=[{sid:'../owned'},{sid:'owned/child'},{sid:'.'},{sid:'x\n'},{sid:null},{sid:17},
    {limit:-1},{limit:1001},{limit:1.5},{limit:null},{unexpected:true}]
  for(const fields of malformed){
    const action={type:'desktop_monitor',sub:'tail',...fields}
    expect(desktopMonitorActionError(action)).toBeDefined()
    expect((await callDesktopProvider(action)).code).toBe('invalid_request')
  }
  for(const fields of [{frames:61},{video:0},{frameQuality:101},{framePixelScale:0},{frameBudget:1.5},
    {app:'a',apps:['b']},{app:'a',allApps:true},{apps:[]},{apps:['a','a']},{include:[true]},
    {instruction:'\0'},{speechMode:'invented'},{sid:'caller-chosen'}]){
    expect(desktopMonitorActionError({type:'desktop_monitor',sub:'start',...fields})).toBeDefined()
  }
  for(const sid of ['aaa11111','task-session_12','5c60fa9b-241c-4e3f-889c-9bf8da319992']){
    expect(desktopMonitorActionError({type:'desktop_monitor',sub:'export',sid,format:'json'})).toBeUndefined()
  }
  expect(desktopMonitorActionError({type:'desktop_monitor',sub:'tail',limit:0})).toBeUndefined()
  expect(desktopMonitorActionError({type:'desktop_monitor',sub:'start',apps:['Owned fixture'],include:['files'],watchPaths:['/tmp/owned'],speechMode:'off',frameBudget:0})).toBeUndefined()
  for(const desktop of [false,true]){
    for(const args of [['export','../owned'],['tail','--sid','owned/child'],['tail','--limit','-1'],['tail','--limit','1.5'],['tail','--limit','1001']]){
      expect(()=>parseMacosCommand(['macos','monitor',...args],undefined,desktop)).toThrow()
    }
  }
  for(const args of [['start','--frames','1.5'],['start','--video','invalid'],['start','--app'],['start','--apps'],['start','--unknown'],['tail','--limit','1','--limit','2'],['start','--frames','1','--frames','2'],['status','extra'],['start','--mode','mixed'],['export','owned123','--json','--plan']])expect(()=>parseMacosCommand(['macos','monitor',...args],undefined,true)).toThrow()
})

test('monitor replies preserve exact identities, bounds and actual source coverage',()=>{
  const sid='owned123',event={sid,s:0,t:1,event:'owned_extension_fixture',nativePayload:{text:'Owned fixture'}}
  const tail={type:'desktop_monitor',sub:'tail',sid,limit:1}
  expect(desktopMonitorResultError(tail,[event])).toBeUndefined()
  for(const value of [[{...event,sid:'other'}],[{...event,s:-1}],[{...event,s:0.5}],[{...event,t:true}],[{...event,event:''}],[event,event],[{...event,s:2},{...event,s:1}]])expect(desktopMonitorResultError({...tail,limit:2},value)).toBeDefined()
  expect(desktopMonitorResultError({...tail,limit:0},[event])).toBeDefined()
  expect(desktopMonitorResultError({...tail,limit:0},[])).toBeUndefined()
  expect(desktopMonitorResultError({...tail,sub:'pause'},{sid,status:'paused'})).toBeUndefined()
  expect(desktopMonitorResultError({...tail,sub:'pause'},{sid,status:'recording'})).toBeDefined()
  expect(desktopMonitorResultError({...tail,sub:'status'},{status:'idle'})).toBeDefined()
  const start={sid,status:'recording',surface:'desktop',host:process.platform,scope:{mode:'apps',apps:['Owned fixture']},includes:[],sessionDir:'/tmp/'+sid,activeCount:1,partial:true,coverage:[{source:'input',available:false,reason:'Not implemented'}]}
  expect(desktopMonitorResultError({type:'desktop_monitor',sub:'start'},start)).toBeUndefined()
  for(const fields of [{partial:false},{host:'other'},{coverage:[]},{activeCount:0},{activeCount:17},{sessionDir:'/tmp/other'}])expect(desktopMonitorResultError({type:'desktop_monitor',sub:'start'},{...start,...fields})).toBeDefined()
  expect(desktopMonitorResultError({type:'desktop_monitor',sub:'export',sid},'x'.repeat(1048577))).toBeDefined()
})

test('Mac archive metadata preserves lifecycle and task binding fields and refuses malformed semantics',()=>{
  const action={type:'desktop_monitor',sub:'list'},sid='owned_meta'
  for(const meta of macPayloads.metadataValid)expect(desktopMonitorResultError(action,[{...meta,sid}])).toBeUndefined()
  for(const meta of macPayloads.metadataInvalid)expect(desktopMonitorResultError(action,[{...meta,sid}])).toBeDefined()
})

test('native archive metadata preserves valid lifecycle coverage and rejects malformed semantics',()=>{
  const meta={sid:'owned_native_meta',sessionId:'owned_native_meta',artifactVersion:1,surface:'desktop',host:process.platform,provider:'interceptor-desktop-rust',providerPid:123,login:'owned',startedAt:1000,endedAt:2000,status:'stopped',paused:false,counts:{evt:1,mut:0,net:0,nav:0,ax:0},attachments:[],scope:{mode:'all'},includes:[],excludes:[],coverage:[{source:'lifecycle',available:true}],partial:false}
  const action={type:'desktop_monitor',sub:'list'}
  expect(desktopMonitorResultError(action,[meta])).toBeUndefined()
  for(const fields of [{artifactVersion:2},{endedAt:999},{status:'active'},{counts:{...meta.counts,ax:2}},{scope:{mode:'apps',apps:[]}},{scope:{mode:'all',apps:['Owned']}},{providerPid:0},{login:''},{coverage:[...meta.coverage,...meta.coverage]},{coverage:[{source:'',available:true}]}])expect(desktopMonitorResultError(action,[{...meta,...fields}])).toBeDefined()
  const {endedAt,...active}={...meta,status:'active',paused:true}
  expect(desktopMonitorResultError(action,[active])).toBeUndefined()
  expect(desktopMonitorResultError(action,[{...active,coverage:[{source:'recovery',available:true}]}])).toBeDefined()
  expect(desktopMonitorResultError(action,[{...active,coverage:Array.from({length:64},(_,i)=>({source:'owned-'+i,available:true}))}])).toBeDefined()
  expect(desktopMonitorResultError(action,[{...active,coverage:Array.from({length:63},(_,i)=>({source:'owned-'+i,available:true}))}])).toBeUndefined()
})

test('native monitor source payloads preserve valid flat fields and refuse malformed identities and privacy',()=>{
  expect(desktopContractShapeError({},'DesktopMonitorNativeEmptyPayload')).toBeUndefined()
  for(const value of [null,[],true,17,'owned',{unexpected:true},{unexpected:null}])expect(desktopContractShapeError(value,'DesktopMonitorNativeEmptyPayload')).toBeDefined()
  const header={sid:'owned123',s:0,t:1,timestamp:'',taskId:'owned'},input=payloads.valid.find(row=>row.event==='input')!
  for(const payload of payloads.valid)expect(desktopMonitorEventPayloadError({...header,...payload})).toBeUndefined()
  for(const payload of payloads.invalid)expect(desktopMonitorEventPayloadError({...header,...payload})).toBeDefined()
  for(const fields of [{v:17},{v:null},{pid:0},{pid:1.5},{pid:4294967296},{source:'workspace'},{secure:true},{frame:{x:0,y:0,width:-1,height:1}},{windowId:0},{windowId:1.5},{unexpected:true}])expect(desktopMonitorEventPayloadError({...header,...input,...fields})).toBeDefined()
  const {v,...withoutValue}=input;expect(desktopMonitorEventPayloadError({...header,...withoutValue})).toBeDefined()
  for(const event of ['focus','selection','menu_open','menu_close','title_change','layout_change','ax_other'])expect(desktopMonitorEventPayloadError({...header,...withoutValue,event})).toBeUndefined()
  for(const event of ['frontmost','app_deactivate','window_min','window_demin','window_create','window_destroy'])expect(desktopMonitorEventPayloadError({...header,...withoutValue,event,source:'workspace'})).toBeUndefined()
  expect(desktopMonitorEventPayloadError({...header,...input,frame:{x:-1,y:-1,width:0,height:0},windowId:'owned-window'})).toBeUndefined()
})

test('native frame events use existing strict media models and refuse invalid artifact counters',()=>{
  const frame={event:'frame',path:'/owned/media/000001.png',w:64,h:32,bytes:128,format:'png',quality:80}
  const budget={event:'frame_budget_reached',frames:1,bytes:128,frameBudget:1,diskCapBytes:1024}
  for(const row of [frame,budget,{event:'frame_error',error:'Owned source exited'}])expect(desktopMonitorEventPayloadError(row,'native')).toBeUndefined()
  for(const row of [{...frame,path:''},{...frame,path:'owned\u0000path'},{...frame,w:0},{...frame,h:1.5},{...frame,w:10000,h:10000},{...frame,bytes:0},{...frame,bytes:-1},{...frame,quality:101},{...frame,format:'invented'},{...frame,unexpected:true},{...budget,frames:-1},{...budget,frames:2},{...budget,frameBudget:0},{...budget,diskCapBytes:0},{...budget,bytes:1025},{...budget,bytes:1.5},{event:'frame_error',error:17}])expect(desktopMonitorEventPayloadError(row,'native')).toBeDefined()
})
