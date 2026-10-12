import {expect,test} from 'bun:test'
import {desktopFilesActionError,desktopFilesResultError} from '../shared/desktop-files-validation'
import {parseMacosCommand} from '../cli/commands/macos'
import {classify} from '../cli/mcp/tiers'

test('file service trust boundary preserves zero limits and refuses misplaced selectors and forged operation replies',()=>{
  expect(parseMacosCommand(['macos','files','recent','--limit','0'],undefined,true)).toEqual({type:'macos_files',sub:'recent',limit:0})
  expect(parseMacosCommand(['macos','files','open','--pid','123','--limit','7'],undefined,true)).toEqual({type:'macos_files',sub:'open',limit:7,pid:123})
  for(const tokens of [['watch'],['watch','relative'],['watch','/tmp','--limit','1'],['recent','--pid','1'],['open','/tmp'],['open','--limit','101'],['recent','--limit','-1'],['recent','--limit','1.5'],['recent','--limit','1','--limit','2'],['open','--filter','x'],['open','--app','Finder'],['recent','--limit']])expect(()=>parseMacosCommand(['macos','files',...tokens],undefined,true)).toThrow()
  for(const patch of [{limit:-1},{limit:1001},{limit:1.5},{limit:true},{limit:null},{path:'/tmp'},{pid:1},{sub:'unknown'},{filter:'x'},{unexpected:true}])expect(desktopFilesActionError({type:'desktop_files',sub:'recent',...patch})).toBeString()
  const open={type:'desktop_files',sub:'open',pid:123,limit:1}
  const data={files:['/tmp/owned'],count:1,partial:true,scope:process.platform==='darwin'?'current-user':'current-user-login',processesInspected:1,handlesInspected:2,skippedProcesses:0,reason:'bounded descriptor inventory'}
  expect(desktopFilesActionError(open)).toBeUndefined();expect(desktopFilesResultError(open,data)).toBeUndefined()
  // A busy login has more processes than one inventory inspects; the rest are reported as skipped.
  expect(desktopFilesResultError({type:'desktop_files',sub:'open',limit:5},{...data,processesInspected:512,skippedProcesses:900})).toBeUndefined()
  for(const patch of [{count:2},{count:1.5},{files:['relative']},{files:['/tmp/a','/tmp/a'],count:2},{processesInspected:2},{handlesInspected:16385},{skippedProcesses:-1},{partial:true,reason:''},{partial:false},{scope:'invented'},{unexpected:true}])expect(desktopFilesResultError(open,{...data,...patch})).toBeString()
  expect(desktopFilesResultError(open,{watching:'/tmp/owned',eventPath:'/tmp/events'})).toBeString()
  expect(desktopFilesResultError({type:'desktop_files',sub:'recent',limit:0},[{path:'/tmp/a',timestamp:'2026-10-05T12:00:00Z',event:'change'}])).toBeString()
  expect(desktopFilesResultError({type:'desktop_files',sub:'recent'},[{path:'/tmp/a',timestamp:'invalid',event:'change'}])).toBeString()
  for(const surface of ['desktop','macos']as const){for(const sub of ['watch','unwatch'])expect(classify(surface,'files',[sub]).tier).toBe('mutate');for(const sub of ['recent','open'])expect(classify(surface,'files',[sub]).tier).toBe('read')}
})

test('watch and unwatch replies match a request that ends in a separator',()=>{
  const dir=process.platform==='win32'?'C:\\Temp':'/tmp/owned',sep=process.platform==='win32'?'\\':'/',root=process.platform==='win32'?'C:\\':'/'
  expect(desktopFilesResultError({type:'desktop_files',sub:'watch',path:dir+sep},{watching:dir,eventPath:dir+sep+'events'})).toBeUndefined()
  expect(desktopFilesResultError({type:'desktop_files',sub:'unwatch',path:dir+sep},{path:dir,removed:true})).toBeUndefined()
  expect(desktopFilesResultError({type:'desktop_files',sub:'watch',path:root},{watching:root,eventPath:dir+sep+'events'})).toBeUndefined()
  expect(desktopFilesResultError({type:'desktop_files',sub:'watch',path:dir+sep},{watching:dir+'-other',eventPath:dir+sep+'events'})).toBeString()
  expect(desktopFilesResultError({type:'desktop_files',sub:'unwatch',path:dir+sep},{path:root,removed:true})).toBeString()
})
