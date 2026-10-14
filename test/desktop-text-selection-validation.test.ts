import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopContractShapeError} from '../shared/desktop-contract-validation'

test('neutral text carries ownership and refuses discarded mode or selector arguments',()=>{
  const args=['macos','text','e42','--selection','--pid','42','--app','Fixture','--window','123']
  expect(parseMacosCommand(args,undefined,true)).toEqual({type:'macos_text',ref:'e42',mode:'selection',app:'Fixture',pid:42,window:123})
  expect(parseMacosCommand(args)).toEqual({type:'macos_text',ref:'e42',mode:'selection'})
  for(const tail of [['e43'],['--selection','--visible'],['--selection','--selection'],['--pid'],['--pid','1junk'],['--app'],['--app','--selection'],['--window','1.5'],['--unknown'],['--pid','42','--pid','43']])
    expect(()=>parseMacosCommand(['macos','text','e42',...tail],undefined,true)).toThrow()
  for(const mode of ['full','selection','visible'])expect(desktopContractShapeError({type:'desktop_text',ref:'e42',mode},'DesktopAxTextAction')).toBeUndefined()
  for(const mode of ['',null,true,'selected'])expect(desktopContractShapeError({type:'desktop_text',ref:'e42',mode},'DesktopAxTextAction')).toBeDefined()
})
