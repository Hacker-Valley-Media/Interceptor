import{expect,test}from'bun:test'
import{parseMacosCommand}from'../cli/commands/macos'
test('neutral clipboard history rejects malformed limits before native dispatch while preserving zero and legacy parsing',()=>{
  for(const value of ['0.5','1junk','-1','501','9007199254740992'])expect(()=>parseMacosCommand(['macos','clipboard','history','--limit',value],undefined,true)).toThrow()
  expect(parseMacosCommand(['macos','clipboard','history','--limit','0'],undefined,true)?.limit).toBe(0)
  expect(parseMacosCommand(['macos','clipboard','history','--limit','1.5'])?.limit).toBe(1)
  expect(parseMacosCommand(['macos','clipboard'],undefined,true)?.sub).toBe('read')
})
