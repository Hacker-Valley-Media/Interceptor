import {test,expect} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopSpeechActionError,desktopSpeechResultError} from '../shared/desktop-speech-validation'
import {classify,READ_VERBS} from '../cli/mcp/tiers'

test('speech parsing, bounded replies and MCP lifecycle tiers stay strict',()=>{
  const action=(...args:string[])=>desktopAction(parseMacosCommand(['desktop','listen',...args],undefined,true)!)
  expect(action()).toMatchObject({type:'desktop_listen',sub:'status'})
  expect(READ_VERBS.macos.has('listen')).toBe(true)
  expect(action('vocab','add','café')).toMatchObject({sub:'vocab',op:'add',word:'café'})
  expect(action('start','--device','pulse:exact')).toMatchObject({sub:'start',device:'pulse:exact'})
  for(const args of [['status','--device','x'],['vocab','clear','x'],['vocab','add'],['start','--device'],['start','--device','a','--device','b'],['tail','--wat']])expect(()=>action(...args)).toThrow()
  for(const row of [{type:'desktop_listen',sub:'vocab',op:'add',word:'\0'},{type:'desktop_listen',sub:'start',extra:true}])expect(desktopSpeechActionError(row)).toBeDefined()
  expect(desktopSpeechResultError(action('tail'),{listening:false,transcript:'actual output'})).toBeUndefined()
  expect(desktopSpeechResultError(action('start'),{listening:false})).toBeDefined()
  expect(desktopSpeechResultError(action('stop'),{listening:true,transcript:''})).toBeDefined()
  expect(desktopSpeechResultError(action('transcript'),'x'.repeat(65537))).toBeDefined()
  expect(desktopSpeechResultError(action('vocab','add','café'),{added:'other',total:1})).toBeDefined()
  for(const surface of ['macos','desktop'] as const){
    for(const args of [[],['status'],['transcript'],['tail'],['vocab'],['vocab','list']])expect(classify(surface,'listen',args).tier).toBe('read')
    for(const args of [['start'],['stop'],['vocab','add','x'],['vocab','clear'],['--device','status','start']])expect(classify(surface,'listen',args).tier).toBe('mutate')
  }
})
