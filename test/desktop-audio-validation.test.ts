import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopAudioActionError,desktopAudioResultError} from '../shared/desktop-audio-validation'
import {desktopContractShapeError} from '../shared/desktop-contract-validation'
import {classify,READ_VERBS} from '../cli/mcp/tiers'

test('audio validates exact channels, native formats, defaults, PCM levels and saved receipts',()=>{
  const a=desktopAction(parseMacosCommand(['macos','audio','both','start','--save'],undefined,true)!)
  expect(desktopAudioActionError(a)).toBeUndefined()
  expect(desktopAudioResultError(a,{input:'started',output:'started',inputFilePath:'/tmp/input.wav',outputFilePath:'/tmp/output.wav'})).toBeUndefined()
  const device={uniqueID:'wasapi:device',deviceID:'wasapi:device',localizedName:'Microphone',manufacturer:null,modelID:null,deviceType:'wasapi',isConnected:true,role:'input',channels:2,sampleRate:48000,isDefault:true}
  const devices={defaultInput:{sampleRate:48000,channels:2},devices:[device],count:1}
  const read={type:'desktop_audio',sub:'input',op:'devices'}
  expect(desktopAudioResultError(read,devices)).toBeUndefined()
  const level={active:true,level:Math.sqrt(0.3125),peak:0.75,frames:4,channels:2,sampleRate:48000,timestamp:1_700_000_000}
  const levels={type:'desktop_audio',sub:'input',op:'level'}
  expect(desktopAudioResultError(levels,level)).toBeUndefined()
  expect(desktopAudioResultError(levels,{active:false,level:null,peak:null,frames:0})).toBeUndefined()
  for(const change of[{frames:0},{peak:0.1},{sampleRate:0},{channels:0},{level:NaN},{frames:262145},{filePath:'relative'},{extra:true}])expect(desktopAudioResultError(levels,{...level,...change})).toBeDefined()
  for(const change of[{count:0},{defaultInput:null},{devices:[device,device]},{devices:[{...device,role:'output'}]},{devices:[{...device,isConnected:'yes'}]}])expect(desktopAudioResultError(read,{...devices,...change})).toBeDefined()
  expect(desktopAudioResultError(a,{input:'started',output:'started',inputFilePath:'/tmp/input.wav'})).toBeDefined()
  for(const change of[{sub:'bad'},{op:'bad'},{save:1},{extra:true},{groupSoft:1}])expect(desktopAudioActionError({...a,...change})).toBeDefined()
  for(const args of[['input','start','--app','App'],['input','start','--device'],['input','start','--device','one','--device','two'],['output','level','--save'],['output','start','extra'],['output','start','--other']])expect(()=>parseMacosCommand(['macos','audio',...args],undefined,true)).toThrow()
  expect(desktopAudioResultError({type:'desktop_audio',sub:'input',op:'start',save:true},{message:'audio input capture started (48000Hz)',sampleRate:48000,channels:2,filePath:'/tmp/input.wav'})).toBeUndefined()
  const capability={operation:'audio',compiled:true,present:true,permission:'unknown',session:'fixture',effective:false,background:'semantic',provider:'WASAPI',versions:{contract:'1',cpal:'0.18.2'},limits:[]}
  expect(desktopContractShapeError(capability,'DesktopCapability')).toBeUndefined()
  expect(desktopContractShapeError({...capability,permission:'invented'},'DesktopCapability')).toBeDefined()
  for(const surface of ['macos','desktop'] as const){
    expect(READ_VERBS[surface].has('audio')).toBe(true)
    for(const channel of ['input','output','both'])for(const op of ['level','devices'])expect(classify(surface,'audio',[channel,op]).tier).toBe('read')
    for(const args of [['input','start'],['both','stop'],['--group','input','output','start'],['input','unknown']])expect(classify(surface,'audio',args).tier).toBe('mutate')
  }
})

test('a bare start acknowledgement belongs to the channel that was started',()=>{
  const start=(sub:string)=>({type:'desktop_audio',sub,op:'start'})
  expect(desktopAudioResultError(start('output'),'audio output capture started')).toBeUndefined()
  expect(desktopAudioResultError(start('input'),'audio output capture started')).toBeDefined()
  expect(desktopAudioResultError(start('input'),'audio input capture started')).toBeDefined()
  expect(desktopAudioResultError({type:'desktop_audio',sub:'input',op:'stop'},'no active input capture')).toBeUndefined()
  expect(desktopAudioResultError({type:'desktop_audio',sub:'input',op:'stop'},'no active output capture')).toBeDefined()
})
