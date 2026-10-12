import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'

for(const sub of ['pause','resume','stop','status','tail','export']){
 for(const args of [['--sid'],['--sid',''],['--sid','--raw'],['--sid','aaa11111','--sid','bbb22222']]){
  test(`monitor ${sub} refuses ambiguous explicit target ${JSON.stringify(args)}`,()=>{
   expect(()=>parseMacosCommand(['macos','monitor',sub,...args])).toThrow(/--sid/)
  })
 }
}

test('monitor preserves exact explicit IDs and the existing unscoped defaults',()=>{
 for(const sub of ['pause','resume','stop','status']){
  expect(parseMacosCommand(['macos','monitor',sub,'--sid','aaa11111'])?.sid).toBe('aaa11111')
  expect(parseMacosCommand(['macos','monitor',sub])?.sid).toBeUndefined()
 }
 expect(parseMacosCommand(['macos','monitor','export','aaa11111'])?.sid).toBe('aaa11111')
 expect(parseMacosCommand(['macos','monitor','export','aaa11111','--sid','bbb22222'])?.sid).toBe('bbb22222')
})
