import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopVadActionError,desktopVadResultError} from '../shared/desktop-vad-validation'
import {classify,READ_VERBS} from '../cli/mcp/tiers'
test('VAD routes strict calibrated actions and preserves real native RMS status',()=>{
  const action=desktopAction(parseMacosCommand(['macos','vad','start','--threshold','0.03'],undefined,true)!)
  expect(action).toEqual({type:'desktop_vad',sub:'start',threshold:0.03})
  expect(desktopVadActionError(action)).toBeUndefined()
  expect(desktopVadResultError(action,{active:true})).toBeUndefined()
  const status={type:'desktop_vad',sub:'status'}
  expect(desktopVadResultError(status,{active:true,speaking:true,level:0.1})).toBeUndefined()
  expect(desktopVadResultError(status,{active:false,speaking:false,level:0})).toBeUndefined()
  for(const data of[{active:false,speaking:true,level:0.1},{active:false,speaking:false,level:0.1},{active:true,speaking:false,level:NaN},{active:true,speaking:false,level:-1},{listening:false}])expect(desktopVadResultError(status,data)).toBeDefined()
  for(const extra of[{threshold:-1},{threshold:2},{threshold:true},{unknown:true}])expect(desktopVadActionError({...action,...extra})).toBeDefined()
  for(const args of[['start','--threshold','NaN'],['start','--threshold',''],['start','--threshold'],['start','--threshold','0.02','--threshold','0.03'],['status','--threshold','0.02'],['start','--unknown'],['unknown']])expect(()=>parseMacosCommand(['macos','vad',...args],undefined,true)).toThrow()
  expect(desktopAction(parseMacosCommand(['macos','vad'],undefined,true)!)).toEqual(status)
  expect(desktopVadResultError({type:'desktop_vad',sub:'stop'},{active:true})).toBeDefined()
  for(const surface of ['macos','desktop'] as const){
    expect(READ_VERBS[surface].has('vad')).toBe(true)
    expect(classify(surface,'vad',[]).tier).toBe('read')
    expect(classify(surface,'vad',['status']).tier).toBe('read')
    for(const args of [['start'],['stop'],['--threshold','status','start']])expect(classify(surface,'vad',args).tier).toBe('mutate')
  }
})
