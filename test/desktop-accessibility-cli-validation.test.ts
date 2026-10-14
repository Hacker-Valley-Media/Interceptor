import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {generateDesktopContract,outputs} from '../scripts/desktop-contract'
import {DESKTOP_ACCESSIBILITY_OPERATIONS,DESKTOP_FILESYSTEM_OPERATIONS} from '../shared/desktop-contract.generated'
import fixtures from '../shared/desktop-accessibility-fixtures.json'
import {classify} from '../cli/mcp/tiers'

test('native CLI operation tables follow the same declarations as Swift and Rust',async()=>{
  const source=await Bun.file(new URL('../shared/desktop-contract.ts',import.meta.url)).text()
  const generated=generateDesktopContract(source)
  expect(await Bun.file(outputs.typescript).text()).toBe(generated.typescript)
  expect(new Set<string>(DESKTOP_ACCESSIBILITY_OPERATIONS)).toEqual(new Set(fixtures.valid.map(action=>action.type)))
  expect(new Set(DESKTOP_FILESYSTEM_OPERATIONS)).toEqual(new Set(['desktop_fs_read','desktop_fs_write','desktop_fs_search']))
  expect(()=>generateDesktopContract(source.replaceAll('"desktop_value"','"desktop_value_fixture"'))).toThrow('result selector')
  const changed=generateDesktopContract(source.replaceAll('desktop_value','desktop_value_fixture'))
  expect(changed.typescript).toContain('"desktop_value_fixture"')
  expect(changed.typescript).not.toContain('"desktop_value"')
})

test('neutral accessibility numbers refuse truncation and discarded flag values',()=>{
  const cases:[string[],string[]][]=[
    [['tree'],['--pid','--depth','--max-chars','--max-nodes','--max-ms']],
    [['find','fixture'],['--pid','--max-nodes','--max-ms']],
    [['focused'],['--pid']],
    [['windows'],['--pid']],
    [['type','e1','fixture'],['--pid']],
    [['click','e1'],['--pid']],
  ]
  for(const [command,flags]of cases)for(const flag of flags){
    for(const value of ['1.5','1junk','true','9007199254740992','--app',''])
      expect(()=>parseMacosCommand(['macos',...command,flag,value],undefined,true)).toThrow('safe integer')
    expect(()=>parseMacosCommand(['macos',...command,flag],undefined,true)).toThrow('safe integer')
  }
  expect(parseMacosCommand(['macos','tree','--pid','12.5','--depth','0','--max-chars','0'])).toMatchObject({pid:12,depth:10,maxChars:50000})
  expect(parseMacosCommand(['macos','tree','--pid','0','--depth','0','--max-chars','0'],undefined,true)).toMatchObject({pid:0,depth:0,maxChars:0})
  expect(parseMacosCommand(['macos','tree'],undefined,true)).toMatchObject({depth:10,maxChars:50000,filter:'interactive'})
})

test('neutral malformed window targets and missing values return catchable failures',()=>{
  for(const verb of ['click','type'])for(const value of ['1.5','1junk','0','-1','9007199254740992','9007199254740993','--app',''])
    expect(()=>parseMacosCommand(['macos',verb,'e1','fixture','--window',value],undefined,true)).toThrow('window id')
  for(const verb of ['find','value','action','text','click','type'])
    expect(()=>parseMacosCommand(['macos',verb],undefined,true)).toThrow('requires')
  expect(parseMacosCommand(['macos','type','e1',''],undefined,true)).toMatchObject({ref:'e1',text:''})
  expect(parseMacosCommand(['macos','type','e1',''])).toMatchObject({text:'e1'})
})

test('named-secret parsing retains its legacy target and vault payload',()=>{
  const command=['macos','type','e1','--secret','named-entry','--pid','42','--window','123']
  expect(parseMacosCommand(command,undefined,true)).toEqual(parseMacosCommand(command))
  expect(parseMacosCommand(command,undefined,true)).toMatchObject({type:'macos_type',secret:'named-entry',ref:'e1',pid:42,window:123})
})

test('desktop input flags preserve strict targeting and background-only choice',()=>{
  expect(parseMacosCommand(['macos','click','10,20','--pid','42','--right','--double','--background-only','--window-title','Owned fixture','--window-bounds','0,0,640,480'],undefined,true))
    .toMatchObject({coords:'10,20',pid:42,right:true,double:true,backgroundOnly:true,windowTitle:'Owned fixture',windowBounds:{left:0,top:0,width:640,height:480}})
  expect(parseMacosCommand(['macos','keys','ctrl+a','--pid','42','--background-only'],undefined,true)).toMatchObject({keys:'ctrl+a',pid:42,backgroundOnly:true})
  expect(parseMacosCommand(['macos','menu','File','Save','--window','123'],undefined,true)).toMatchObject({items:['File','Save'],window:123})
  expect(parseMacosCommand(['macos','keys','ctrl+a','--window','187651961215680'],undefined,true)).toMatchObject({window:187651961215680})
  for(const command of [['keys','ctrl+a','--pid','1.5'],['scroll','down','1.5'],['scroll','down','300','--times','2junk'],['drag','e1','e2','--pid','1.5'],['click','10,20','--window-bounds','0,0,0,100']])
    expect(()=>parseMacosCommand(['macos',...command],undefined,true)).toThrow()
})

test('desktop lifecycle targets keep flags out of app names and preserve legacy parsing',()=>{
  for(const subcommand of ['activate','hide','unhide','quit']) {
    expect(parseMacosCommand(['macos','app',subcommand,'--pid','42'],undefined,true)).toMatchObject({subcommand,app:undefined,pid:42})
    expect(parseMacosCommand(['macos','app',subcommand,'Fixture'],undefined,true)).toMatchObject({subcommand,app:'Fixture'})
    expect(parseMacosCommand(['macos','app',subcommand,'--app','Fixture'],undefined,true)).toMatchObject({subcommand,app:'Fixture'})
    for(const value of ['1.5','42junk','true','9007199254740992','--app',''])
      expect(()=>parseMacosCommand(['macos','app',subcommand,'--pid',value],undefined,true)).toThrow('safe integer')
    expect(()=>parseMacosCommand(['macos','app',subcommand,'--pid'],undefined,true)).toThrow('safe integer')
  }
  expect(parseMacosCommand(['macos','app','launch','com.example.Fixture'],undefined,true)).toMatchObject({app:undefined,bundleId:'com.example.Fixture'})
  expect(parseMacosCommand(['macos','app','launch','--bundle','com.example.Fixture'],undefined,true)).toMatchObject({app:undefined,bundleId:'com.example.Fixture'})
  expect(parseMacosCommand(['macos','app','unhide','--pid','42junk'])).toMatchObject({app:'--pid',pid:42})
  expect(parseMacosCommand(['macos','app','launch','--bundle','com.example.Fixture'])).toMatchObject({app:'--bundle',bundleId:'--bundle'})
})

test('neutral value and action selectors remain separate from literal positionals',()=>{
  const read=parseMacosCommand(['macos','value','e1','--pid','42','--app','Owned fixture','--window','123'],undefined,true)!
  expect(read).toMatchObject({type:'macos_value',ref:'e1',pid:42,app:'Owned fixture',window:123})
  expect(read.value).toBeUndefined()
  expect(parseMacosCommand(['macos','value','--pid','42','e1','Owned 🙂 文件'],undefined,true)).toMatchObject({ref:'e1',value:'Owned 🙂 文件',pid:42})
  expect(parseMacosCommand(['macos','value','e1','','--pid','42'],undefined,true)).toMatchObject({ref:'e1',value:'',pid:42})
  expect(parseMacosCommand(['macos','value','--pid','42','e1','--','--pid'],undefined,true)).toMatchObject({ref:'e1',value:'--pid',pid:42})
  expect(parseMacosCommand(['macos','action','--pid','42','e1','--window','123'],undefined,true)).toMatchObject({ref:'e1',action:'press',pid:42,window:123})
  expect(parseMacosCommand(['macos','action','e1','press','--app','Owned fixture','--background-only'],undefined,true)).toMatchObject({ref:'e1',action:'press',app:'Owned fixture',backgroundOnly:true})
  expect(parseMacosCommand(['macos','action','e1','--pid','42','--','--custom-action'],undefined,true)).toMatchObject({ref:'e1',action:'--custom-action',pid:42})
})

test('neutral value and action reject malformed selectors and extra positionals',()=>{
  for(const verb of ['value','action']){
    for(const args of [['--unknown','x'],['--pid','42','--pid','43'],['--app'],['--window','0'],['--window','1.5'],['--pid','42junk'],['first','second']])
      expect(()=>parseMacosCommand(['macos',verb,'e1',...args],undefined,true)).toThrow()
    expect(()=>parseMacosCommand(['macos',verb,'--pid','42'],undefined,true)).toThrow('requires')
  }
  expect(()=>parseMacosCommand(['macos','value','e1','--background-only'],undefined,true)).toThrow()
  expect(()=>parseMacosCommand(['macos','action','e1','--background-only','--background-only'],undefined,true)).toThrow()
  for(const flag of ['--app','--pid','--window'])
    expect(()=>parseMacosCommand(['macos','action',flag,'--background-only','Owned fixture','e1'],undefined,true)).toThrow('requires a value')
})

test('legacy ref value/action grammar and conservative MCP tiers are preserved',()=>{
  expect(parseMacosCommand(['macos','value','e1','--pid','42'])).toEqual({type:'macos_value',ref:'e1',value:'--pid'})
  expect(parseMacosCommand(['macos','action','e1','press','--pid','42'])).toEqual({type:'macos_action',ref:'e1',action:'press'})
  for(const args of [['e1'],['e1','--pid','42'],['--pid','42','e1','Owned 🙂 文件'],['e1','--','--pid']])
    expect(classify('desktop','value',args).tier).toBe('mutate')
  expect(classify('desktop','action',['e1','--pid','42']).tier).toBe('mutate')
})
