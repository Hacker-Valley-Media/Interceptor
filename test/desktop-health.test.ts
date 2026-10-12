import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopContractShapeError} from '../shared/desktop-contract-validation'
import {DESKTOP_ACTION_SCHEMAS,DESKTOP_OPERATION_DATA_SCHEMAS} from '../shared/desktop-contract.generated'
import {classify} from '../cli/mcp/tiers'

test('Health status has one bounded neutral syntax and read policy',()=>{
 for(const args of [[],['status']]){
  const action=desktopAction(parseMacosCommand(['macos','health',...args],undefined,true)!)
  expect(action).toEqual({type:'desktop_health',sub:'status'})
  expect(desktopContractShapeError(action,'DesktopHealthAction')).toBeUndefined()
  expect(classify('desktop','health',args).tier).toBe('read')
 }
 for(const args of [['get'],['status','extra'],['status','--unknown'],['--pid','1']])expect(()=>parseMacosCommand(['macos','health',...args],undefined,true)).toThrow()
 expect(DESKTOP_ACTION_SCHEMAS.desktop_health).toBe('DesktopHealthAction')
 expect(DESKTOP_OPERATION_DATA_SCHEMAS.desktop_health).toBe('DesktopHealthData')
})

test('Health schema distinguishes availability diagnostics from malformed requests and replies',()=>{
 expect(desktopContractShapeError({type:'desktop_health'},'DesktopHealthAction')).toBeUndefined()
 for(const fields of [{sub:null},{sub:1},{sub:'get'},{pid:1},{groupSoft:1}])expect(desktopContractShapeError({type:'desktop_health',...fields},'DesktopHealthAction')).toBeString()
 expect(desktopContractShapeError({available:false,note:'No configured health-data backend.'},'DesktopHealthData')).toBeUndefined()
 for(const data of [{available:'false',note:'x'},{available:false},{available:false,note:1},{available:false,note:'x',records:[]}])expect(desktopContractShapeError(data,'DesktopHealthData')).toBeString()
})
