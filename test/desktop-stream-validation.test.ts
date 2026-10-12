import {test,expect} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopStreamActionError,desktopStreamResultError} from '../shared/desktop-stream-validation'
import {classify} from '../cli/mcp/tiers'

test('stream parser preserves native selectors, real input fields and record defaults',()=>{
  for(const desktop of [true,false]){
    const parse=(...args:string[])=>parseMacosCommand([desktop?'desktop':'macos','stream',...args],undefined,desktop)!
    expect(parse('inject','keys','owned_123','--combo','ctrl+a')).toMatchObject({sid:'owned_123',inputType:'keys',combo:'ctrl+a'})
    expect(parse('inject','type','--sid','owned_123','--text','fixture')).toMatchObject({sid:'owned_123',inputType:'type',text:'fixture'})
    expect(parse('record')).toMatchObject({recordOp:'status'})
    expect(parse('record','stop','owned_123')).toMatchObject({sid:'owned_123',recordOp:'stop'})
    expect(parse('record','start','owned_123','--media','--record-audio','none')).toMatchObject({sid:'owned_123',recordOp:'start',media:true,recordAudio:'none'})
    for(const args of [['record','status','--media'],['record','stop','--media'],['record','start','--record-audio','system'],['record','start','--media','--media'],['record','start','--media','--record-audio','invented'],['record','start','--record-audio','--media','none'],['start','--media']])expect(()=>parse(...args)).toThrow()
    expect(parse('start','--window','123')).toMatchObject({window:123})
    for(const args of [['inject','keys'],['start','--app','fixture','--window','123'],['frame','../outside'],['inject','click','--x','1.5','--y','2'],['record','delete'],['frame','--wat','x'],['fps','--sid','one','--sid','two']])expect(()=>parse(...args)).toThrow()
    for(const args of [[],['status'],['frame','owned'],['record'],['record','status','owned']])expect(classify(desktop?'desktop':'macos','stream',args).tier).toBe('read')
    for(const args of [['start'],['stop'],['inject','keys','owned','--combo','ctrl+a'],['record','start'],['--sid','status']])expect(classify(desktop?'desktop':'macos','stream',args).tier).toBe('mutate')
  }
  expect(()=>parseMacosCommand(['desktop','stream','start','--display','0'],undefined,true)).toThrow()
  expect(parseMacosCommand(['macos','stream','start','--display','0'])).toMatchObject({display:0})
  expect(desktopStreamActionError({type:'desktop_stream',op:'status',unexpected:true})).toBeDefined()
  expect(desktopStreamActionError({type:'desktop_stream',op:'inject',inputType:'scroll',direction:'down',amount:10001})).toBeDefined()
  expect(desktopStreamResultError({type:'desktop_stream',op:'inject',inputType:'keys'},{method:'owned-background-worker',background:true})).toBeUndefined()
  expect(desktopStreamResultError({type:'desktop_stream',op:'record'},{recording:false,frames:0,duration:0})).toBeUndefined()
  expect(desktopStreamResultError({type:'desktop_stream',op:'record',recordOp:'start',sid:'owned'},{recording:true,sid:'other'})).toBeDefined()
  expect(desktopStreamResultError({type:'desktop_stream',op:'resolution'},{width:10000,height:10000})).toBeDefined()
  expect(desktopStreamResultError({type:'desktop_stream',op:'status'},[{sid:'owned',frameCount:1,fps:NaN,duration:0}])).toBeDefined()
})

test('media receipts require actual finalization, matching codec clocks and owned source identity',()=>{
  const action={type:'desktop_stream',op:'record',recordOp:'start',sid:'owned',media:true,recordAudio:'none'}
  const artifact={filePath:'/owned/recording.mkv',container:'matroska',videoCodec:'mjpeg',audio:'none',timing:'monotonic-arrival',finalized:false,bytes:0,source:{kind:'window',pid:42,window:123}}
  const admitted={recording:true,sid:'owned',frames:0,duration:0,artifact}
  expect(desktopStreamResultError(action,admitted)).toBeUndefined()
  expect(desktopStreamResultError(action,{recording:true,sid:'owned'})).toBeDefined()
  const stop={type:'desktop_stream',op:'record',recordOp:'stop'}
  const finalized={...admitted,recording:false,frames:2,duration:0.25,artifact:{...artifact,finalized:true,bytes:1234,sha256:'a'.repeat(64)}}
  expect(desktopStreamResultError(stop,finalized)).toBeUndefined()
  expect(desktopStreamResultError(stop,admitted)).toBeDefined()
  for(const changes of [{sha256:undefined},{bytes:0},{bytes:104857601},{bytes:1.5},{filePath:'relative.mkv'},{container:'mp4'},{timing:'native-media'},{audio:'system'},{source:{kind:'window',window:123}},{source:{kind:'portal-monitor',pid:42}},{source:{kind:'display',display:0}},{source:{kind:'window',pid:42,window:123,display:1}},{unexpected:true}]){
    expect(desktopStreamResultError(stop,{...finalized,artifact:{...finalized.artifact,...changes}})).toBeDefined()
  }
  for(const changes of [{duration:0},{duration:3601},{duration:NaN},{recording:true},{sid:'../outside'}])expect(desktopStreamResultError(stop,{...finalized,...changes})).toBeDefined()
  const mac={recording:false,sid:'owned',duration:0.25,artifact:{...finalized.artifact,container:'mp4',videoCodec:'h264',timing:'native-media',audio:'system',source:{kind:'display',display:1}}}
  expect(desktopStreamResultError(stop,mac)).toBeUndefined() // Schema fixture, no native recording claim.
  expect(desktopStreamResultError(stop,{...mac,artifact:{...mac.artifact,source:{kind:'window',pid:42,window:123}}})).toBeDefined()
})
