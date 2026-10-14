import {test,expect} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopSoundActionError,desktopSoundResultError} from '../shared/desktop-sound-validation'
import {classify} from '../cli/mcp/tiers'

test('sounds preserves actual observations and separates native lifecycle mutations',()=>{
  for(const desktop of [true,false]){
    const parse=(...args:string[])=>parseMacosCommand([desktop?'desktop':'macos','sounds',...args],undefined,desktop)!
    expect(parse()).toMatchObject({sub:'status'})
    expect(parse('log','--filter','Bird')).toMatchObject({sub:'log',filter:'Bird'})
    for(const args of [['start','--filter','Bird'],['log','--filter','\0'],['log','--filter'],['log','--filter','a','--filter','b'],['--wat','x'],['unknown']])expect(()=>parse(...args)).toThrow()
    for(const args of [[],['status'],['tail'],['log','--filter','Bird']])expect(classify(desktop?'desktop':'macos','sounds',args).tier).toBe('read')
    for(const args of [['start'],['stop'],['--filter','status'],['unknown']])expect(classify(desktop?'desktop':'macos','sounds',args).tier).toBe('mutate')
  }
  expect(desktopSoundActionError({type:'desktop_sounds',sub:'status',filter:'extra'})).toBeDefined()
  const row={label:'Bird',confidence:0.9,timestamp:100}
  expect(desktopSoundResultError({type:'desktop_sounds',sub:'status'},{classifying:false,latest:null})).toBeUndefined()
  expect(desktopSoundResultError({type:'desktop_sounds',sub:'tail'},{classifying:true,classifications:[row]})).toBeUndefined()
  expect(desktopSoundResultError({type:'desktop_sounds',sub:'log',filter:'Bird'},[row])).toBeUndefined()
  expect(desktopSoundResultError({type:'desktop_sounds',sub:'start'},{classifying:false})).toBeDefined()
  expect(desktopSoundResultError({type:'desktop_sounds',sub:'log',filter:'Speech'},[row])).toBeDefined()
  for(const confidence of [NaN,-1,0.3,1.1])expect(desktopSoundResultError({type:'desktop_sounds',sub:'log'},[{...row,confidence}])).toBeDefined()
  expect(desktopSoundResultError({type:'desktop_sounds',sub:'tail'},{classifying:true,classifications:Array(501).fill(row)})).toBeDefined()
})
