import {expect,test} from 'bun:test'
import {desktopLogActionError,desktopLogPredicate,desktopLogResultError,desktopLogTimestamp} from '../shared/desktop-log-validation'
import {parseMacosCommand} from '../cli/commands/macos'
import {toResult} from '../cli/mcp/output'

const action={type:'desktop_log_query',predicate:'subsystem == "fixture" AND message CONTAINS "文件"',since:'2026-10-04T00:00:00Z',limit:2}
const entry={timestamp:'2026-10-04T18:00:00.001Z',message:'文件 fixture',subsystem:'fixture',category:'test',process:'owned',level:'error'}
test('log predicates cannot inject native expressions and escaped literals retain their values',()=>{
  expect(desktopLogActionError(action)).toBeUndefined()
  expect(desktopLogPredicate('message == "quote\\\" AND 文件"')[0].value).toBe('quote" AND 文件')
  for(const predicate of ["message == 'a'",'message == "a" OR process == "b"','message == "a" AND','message == "a"ANDmessage == "b"','message == "\\u0000"','unknown == "a"','message == "a" AND '.repeat(17)+'message == "a"'])expect(desktopLogActionError({...action,predicate})).toBeString()
  for(const fields of [{limit:0},{limit:1001},{limit:1.5},{includeInfo:null},{since:'2026-02-30T00:00:00Z'},{predicate:'a'.repeat(4097)},{extra:true}])expect(desktopLogActionError({...action,...fields})).toBeString()
})
test('log timestamps reject calendar rollover, leap seconds and non-RFC3339 shortcuts',()=>{
  for(const value of ['2024-02-29T18:00:00.123456789+05:30','2026-10-04T00:00:00Z'])expect(desktopLogTimestamp(value)).toBeNumber()
  for(const value of ['2026-02-29T18:00:00Z','2026-01-01t00:00:00z','2026-01-01T00:00:60Z','2026-01-01T00:00:00+25:00','0000-01-01T00:00:00Z'])expect(desktopLogTimestamp(value)).toBeUndefined()
})
test('neutral parser is strict and legacy Mac defaults remain available',()=>{
  for(const args of [['log','wrong'],['log','query','--limit','0'],['log','query','--limit','1.5'],['log','query','--since','yesterday'],['log','query','--limit','2','--limit','3'],['log','query','--include-info','--include-info'],['log','query','--unknown','x'],['log','query','extra'],['log','query','--predicate','message == "a"','--subsystem','x']])expect(()=>parseMacosCommand(['macos',...args],undefined,true)).toThrow()
  expect(parseMacosCommand(['macos','log','query','--subsystem','quote" 文件','--category','line\\x'],undefined,true)?.predicate).toBe('subsystem == "quote\\\" 文件" AND category == "line\\\\x"')
  expect(parseMacosCommand(['macos','log','query','--limit','0'])?.limit).toBe(100)
  expect(parseMacosCommand(['macos','log','query','--since','yesterday'])?.since).toBe('yesterday')
})
test('log reply checks catch reordered, fabricated, excessive and unfiltered entries',async()=>{
  const data={entries:[entry],count:1,scope:'local'}
  expect(desktopLogResultError(action,data)).toBeUndefined()
  for(const result of [{...data,count:2},{...data,scope:'remote'},{...data,extra:1},{...data,entries:[{...entry,level:'debug'}]},{...data,entries:[{...entry,subsystem:'other'}]},{...data,entries:[{...entry,timestamp:'2026-10-03T00:00:00Z'}]},{...data,entries:[{...entry,message:'文件'.repeat(400000)}]}])expect(desktopLogResultError(action,result)).toBeString()
  expect(desktopLogResultError(action,{entries:[entry,{...entry,timestamp:'2026-10-04T18:00:00.000Z'}],count:2,scope:'local'})).toBeString()
  const mcp=await toResult({surface:'desktop',verb:'log',run:{stdout:JSON.stringify(data),stderr:'',code:0},fenceEnabled:true})
  expect(mcp.content[0]).toMatchObject({type:'text'});expect((mcp.content[0]as {text:string}).text).toContain('UNTRUSTED');expect(mcp.structuredContent).toEqual(data)
})
