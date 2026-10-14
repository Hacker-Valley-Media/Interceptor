import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopSensitiveActionError,desktopSensitiveResultError} from '../shared/desktop-sensitive-validation'
import {classify} from '../cli/mcp/tiers'
import {pickTimeoutForAction} from '../cli/transport'

test('sensitive parsing owns exact monitor source fields and read/mutation tiers',()=>{
  for(const desktop of [false,true]){
    const parse=(...args:string[])=>desktopAction(parseMacosCommand(['macos','sensitive',...args],undefined,desktop)!)
    expect(parse().sub).toBe('check')
    expect(parse('check','--image','./fixture.png').imagePath).toEndWith('/fixture.png')
    expect(parse('monitor','start','--app','Owned app')).toMatchObject({sub:'monitor',op:'start',app:'Owned app'})
    expect(parse('monitor').op).toBe('status')
    for(const args of [['monitor','start'],['monitor','stop','--app','Other app'],['monitor','start','--image','a'],['check','extra'],['check','--app','App','--image','a'],['unknown'],['--wat'],['check','--app'],['check','--app','a','--app','b']])expect(()=>parse(...args)).toThrow()
    const surface=desktop?'desktop':'macos'
    for(const args of [[],['check'],['monitor'],['monitor','status']])expect(classify(surface,'sensitive',args).tier).toBe('read')
    for(const args of [['monitor','start'],['monitor','stop'],['--app','check'],['unknown']])expect(classify(surface,'sensitive',args).tier).toBe('mutate')
  }
  for(const type of ['desktop_sensitive','macos_sensitive'])expect(pickTimeoutForAction({type,sub:'check'})).toBeGreaterThanOrEqual(40000)
  expect(desktopSensitiveActionError({type:'desktop_sensitive',sub:'check',op:'start'})).toBeDefined()
})
test('sensitive results require observed analysis and honest monitor cleanup state',()=>{
  const result={policyEnabled:true,policy:'simpleInterventions',isSensitive:false,timestamp:100}
  expect(desktopSensitiveResultError({type:'desktop_sensitive',sub:'check'},result)).toBeUndefined()
  for(const changed of [{policyEnabled:false},{policy:'\0'},{timestamp:NaN},{timestamp:-1},{isSensitive:'no'},{note:'policy only'}])expect(desktopSensitiveResultError({type:'desktop_sensitive',sub:'check'},{...result,...changed})).toBeDefined()
  const monitor={monitoring:false,latest:null,checks:0,lastError:null,cleanupPending:false}
  expect(desktopSensitiveResultError({type:'desktop_sensitive',sub:'monitor',op:'status'},monitor)).toBeUndefined()
  expect(desktopSensitiveResultError({type:'desktop_sensitive',sub:'monitor',op:'start'},monitor)).toBeDefined()
  expect(desktopSensitiveResultError({type:'desktop_sensitive',sub:'monitor',op:'stop'},{...monitor,latest:result,checks:1,cleanupPending:true})).toBeUndefined()
  for(const changed of [{checks:1},{latest:result},{lastError:''},{checks:1.5}])expect(desktopSensitiveResultError({type:'desktop_sensitive',sub:'monitor'},{...monitor,...changed})).toBeDefined()
})
