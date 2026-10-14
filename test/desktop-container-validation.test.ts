import {expect,test} from 'bun:test'
import {desktopContainerActionError,desktopContainerResultError} from '../shared/desktop-container-validation'
import {parseMacosCommand} from '../cli/commands/macos'
import {pickTimeoutForAction,type Action} from '../cli/transport'
import {buildFilteredArgs} from '../cli/global-flags'
import {classify,gate,parseAllow} from '../cli/mcp/tiers'
import {withGlobalFlags} from '../cli/mcp/adapter'

test('container trust boundary preserves argv and refuses malformed execution before dispatch',()=>{
  const argv=['echo','','Unicode 验证','--json','--env','X=y'],tokens=['--json','desktop','container','run','docker.io/library/alpine:3','--timeout','300000','--env','OWNED=a=b','--',...argv]
  const parsed=parseMacosCommand(['macos',...buildFilteredArgs(tokens).slice(1)],undefined,true)!
  const action:Action={...parsed,type:'desktop_container_run'}
  expect(action.command).toEqual(argv);expect(action.env).toEqual({OWNED:'a=b'});expect(pickTimeoutForAction(action)).toBe(307000)
  expect(desktopContainerActionError(action)).toBeUndefined()
  for(const patch of [{command:[]},{command:['']},{command:['x\0']},{image:'--help'},{image:'bad image'},{network:'bad'},{network:null},{env:{'BAD=KEY':'x'}},{env:{X:7}},{timeoutMs:0},{timeoutMs:1.5},{maxOutputBytes:1048577},{mounts:[{hostPath:'/tmp',mountPath:'/../x',mode:'ro'}]},{mounts:[{hostPath:'/tmp,x',mountPath:'/x',mode:'ro'}]},{mounts:[{hostPath:'/tmp',mountPath:'/x',mode:'other'}]},{extra:true}])expect(desktopContainerActionError({...action,...patch})).toBeString()
  for(const options of [['--cmd','echo','--','other'],['--timeout','0','--','echo'],['--env','X','--','echo'],['--env','X=y','--env','X=z','--','echo'],['--network','off','--network','off','--','echo'],['--volume','/tmp:/guest:bad','--','echo'],['--unknown','x','--','echo']])expect(()=>parseMacosCommand(['macos','container','run','alpine',...options],undefined,true)).toThrow()
  const mounted=parseMacosCommand(['macos','container','run','alpine','--mount',JSON.stringify({hostPath:'/tmp/with:colon',mountPath:'/data',mode:'ro'}),'--','echo'],undefined,true)!
  expect(mounted.mounts).toEqual([{hostPath:'/tmp/with:colon',mountPath:'/data',mode:'ro'}])
  const data={exitCode:7,stdout:'out',stderr:'err',durationMs:50,image:action.image,command:argv,network:'off',provider:'podman-rootless',engineVersion:'6.1.2',engineHost:'owned-engine'}
  expect(desktopContainerResultError(action,data)).toBeUndefined()
  for(const patch of [{command:['echo']},{network:'host'},{exitCode:0.5},{durationMs:307001},{provider:''},{engineVersion:''},{stdout:'x'.repeat(1048577)}])expect(desktopContainerResultError(action,{...data,...patch})).toBeString()
  const classification=classify('desktop','container',['run','alpine','--','echo'])
  expect(classification.tier).toBe('exec')
  expect(gate(classification,parseAllow(undefined),true).allowed).toBe(false)
  expect(gate(classification,parseAllow('desktop:container'),false).allowed).toBe(false)
  expect(gate(classification,parseAllow('desktop:container'),true).allowed).toBe(true)
  expect(withGlobalFlags(['desktop','container','run','alpine','--','echo','--group'],{group:'owned',context:'main'})).toEqual(['desktop','container','run','alpine','--group','owned','--context','main','--','echo','--group'])
})
