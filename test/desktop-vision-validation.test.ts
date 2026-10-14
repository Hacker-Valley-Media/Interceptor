import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopVisionActionError,desktopVisionResultError} from '../shared/desktop-vision-validation'
import {pickTimeoutForAction} from '../cli/transport'

test('desktop OCR accepts one exact source and validates bounded real regions',()=>{
  const action=desktopAction(parseMacosCommand(['macos','vision','text','--image','./fixture.png'],undefined,true)!)
  expect(desktopVisionActionError(action)).toBeUndefined()
  const data={text:'Hello',count:1,regions:[{text:'Hello',confidence:0.9,x:0.1,y:0.7,width:0.45,height:0.1}]}
  expect(desktopVisionResultError(action,data)).toBeUndefined()
  for(const changed of [{count:0},{text:'invented'}, {regions:[{...data.regions[0],x:0.9}]}])expect(desktopVisionResultError(action,{...data,...changed})).toBeDefined()
  for(const changed of [{imagePath:'relative'},{imagePath:'/fixture.png',app:'Other app'},{sub:'unrecognized'},{imagePath:null},{extra:true}])expect(desktopVisionActionError({type:'desktop_vision',sub:'text',...changed})).toBeDefined()
  expect(()=>parseMacosCommand(['macos','vision','text','--image'],undefined,true)).toThrow()
  expect(()=>parseMacosCommand(['macos','vision','text','--image','a','--image','b'],undefined,true)).toThrow()
})

test('all native Vision replies retain exact observation shapes and coordinates',()=>{
  const region={x:0.1,y:0.2,width:0.3,height:0.4,confidence:0.9},joint={x:0.1,y:0.2,confidence:0.9}
  const results={faces:{faces:[region],count:1},hands:{hands:[{joints:{wrist:joint},chirality:-1}],count:1},bodies:{bodies:[{joints:{neck:joint}}],count:1},classify:{classifications:[{label:'Native category',confidence:0.9}]},saliency:{regions:[region]}}
  for(const [sub,data]of Object.entries(results)){
    const a={type:'desktop_vision',sub}
    expect(desktopVisionResultError(a,data)).toBeUndefined()
    expect(desktopVisionResultError(a,{...data,extra:true})).toBeDefined()
    expect(desktopVisionResultError(a,{text:'wrong selector',regions:[],count:0})).toBeDefined()
  }
  expect(desktopVisionResultError({type:'desktop_vision',sub:'faces'},{faces:[{...region,x:0.9}],count:1})).toBeDefined()
  expect(desktopVisionResultError({type:'desktop_vision',sub:'hands'},{hands:[{joints:{wrist:joint},chirality:2}],count:1})).toBeDefined()
  expect(desktopVisionResultError({type:'desktop_vision',sub:'hands'},{hands:[{joints:{wrist:{...joint,confidence:null}},chirality:-1}],count:1})).toBeUndefined()
  expect(desktopVisionResultError({type:'desktop_vision',sub:'bodies'},{bodies:[{joints:{neck:{...joint,confidence:0.2}}}],count:1})).toBeDefined()
  expect(desktopVisionResultError({type:'desktop_vision',sub:'classify'},{classifications:[{label:'',confidence:0.9}]})).toBeDefined()
  expect(desktopVisionActionError({type:'desktop_vision',sub:'faces',debugDumpPath:'/fixture.png'})).toBeDefined()
})

test('macOS and neutral vision both get the shared vision deadline (a cold OCR load can exceed 15s)',()=>{
  for(const type of ['desktop_vision','macos_vision'])expect(pickTimeoutForAction({type,sub:'text',imagePath:'/tmp/parity.png'})).toBeGreaterThanOrEqual(40000)
})

test('the macOS parser action (absent --app left as an undefined key) gets the vision deadline too',async()=>{
  const {parseMacosCommand}=await import('../cli/commands/macos')
  const action=parseMacosCommand(['macos','vision','text','--image','/tmp/parity.png'])!
  expect('app' in action).toBe(true)
  expect(pickTimeoutForAction(action)).toBeGreaterThanOrEqual(40000)
})
