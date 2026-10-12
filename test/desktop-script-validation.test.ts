import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopScriptActionError,desktopScriptResultError} from '../shared/desktop-script-validation'
import {pickTimeoutForAction} from '../cli/transport'
import {classify,gate,parseAllow} from '../cli/mcp/tiers'

test('portable script fields, runtime results and MCP execution authority stay exact',()=>{
  for(const [family,operation]of [['script','run'],['intent','dispatch']]){
    const argv=['macos',family,operation,'--jsc','({z:1,a:"Unicode 验证"})','--args','["exact"]','--jsc-host','env,sqlite']
    const action=desktopAction(parseMacosCommand(argv,undefined,true)!)
    expect(desktopScriptActionError(action)).toBeUndefined()
    expect(pickTimeoutForAction(action)).toBeGreaterThanOrEqual(35000)
    const data={result:{a:'Unicode 验证',z:1},raw:'{"z":1,"a":"Unicode 验证"}',script:action.jsc,language:'JavaScript',engine:'QuickJS',arguments:['exact'],host:{capabilities:['env','sqlite']}}
    expect(desktopScriptResultError(action,data)).toBeUndefined()
    for(const changed of [{script:'another script'},{raw:'{"a":"different","z":1}'},{engine:'another engine'},{arguments:['different']},{host:{capabilities:['env','fs','sqlite']}},{result:{number:Infinity}}])expect(desktopScriptResultError(action,{...data,...changed})).toBeDefined()
    expect(classify('desktop',family,[operation]).tier).toBe('exec')
    expect(gate(classify('desktop',family,[operation]),parseAllow(''),false).allowed).toBe(false)
    expect(gate(classify('desktop',family,[operation]),parseAllow('arbitrary-exec'),false).allowed).toBe(false)
  }
  const bare=desktopAction(parseMacosCommand(['macos','script','run','--jsc','typeof host'],undefined,true)!)
  expect(desktopScriptResultError(bare,{result:'undefined',raw:'"undefined"',script:bare.jsc,language:'JavaScript',engine:'QuickJS'})).toBeUndefined()
  for(const argv of [
    ['--jsc','1','--jsc','2'],['--jsc','1','extra'],['--jsc','1','--unknown','v'],['--jsc','1','--args','[1]'],
    ['--jsc','1','--args','null'],['--jsc','1','--args','not JSON'],['--jsc','1','--jsc-host','osa'],['--jsc'],['--script','AppleScript'],
  ])expect(()=>parseMacosCommand(['macos','script','run',...argv],undefined,true)).toThrow()
  for(const changed of [{jsc:''},{jsc:'x'.repeat(65537)},{args:Array(129).fill('x')},{args:['nul\0']},{jscHost:null},{extra:true}])expect(desktopScriptActionError({...bare,...changed})).toBeDefined()
  expect(parseMacosCommand(['macos','script','run','--jsc','1','--jsc-host'],undefined,true)!.jscHost).toBe('all')
  expect(parseMacosCommand(['macos','script','run','--jsc','1','--jsc-host','env','--jsc-unsafe-native'],undefined,true)!.jscHost).toBe('env')
})
