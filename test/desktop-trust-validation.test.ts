import {test,expect} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopTrustActionError,desktopTrustResultError} from '../shared/desktop-trust-validation'
import {classify,READ_VERBS} from '../cli/mcp/tiers'

test('trust keeps no-prompt authority, native unknown states and exact fields',()=>{
  const action=(...args:string[])=>desktopAction(parseMacosCommand(['desktop','trust',...args],undefined,true)!)
  expect(action('--prompt','--no-prompt')).toMatchObject({noPrompt:true,prompt:false,speechPrompt:false})
  expect(action('speech','--no-prompt')).toMatchObject({noPrompt:true,speechPrompt:false})
  for(const args of [['--wat'],['--prompt','yes'],['--prompt','--prompt'],['--no-prompt','speech']])expect(()=>action(...args)).toThrow()
  for(const row of [{type:'desktop_trust',prompt:1},{type:'desktop_trust',unknown:true},{type:'desktop_trust',group:'\0'}])expect(desktopTrustActionError(row)).toBeDefined()
  const permissions=['Accessibility','Microphone','Screen Recording','Speech Recognition'].map(name=>({name,status:'unknown',required:name==='Accessibility',granted:false,path:'native operation permission diagnostic',reason:'actual target-specific fixture status'}))
  const reply={accessibility:'unknown',microphone:'unknown',screenRecording:'unknown',speechRecognition:'unknown',permissions,bundlePath:'/owned/provider',displayName:'Interceptor'}
  expect(desktopTrustResultError(action('--no-prompt'),reply)).toBeUndefined()
  expect(desktopTrustResultError(action('--no-prompt'),{...reply,opened:['Microphone']})).toBeDefined()
  expect(desktopTrustResultError(action(),{...reply,permissions:permissions.map(p=>({...p,granted:true}))})).toBeDefined()
  expect(desktopTrustResultError(action(),{...reply,permissions:[...permissions.slice(1),permissions[1]]})).toBeDefined()
  for(const surface of ['macos','desktop'] as const){
    expect(READ_VERBS[surface].has('trust')).toBe(true)
    for(const args of [[],['--no-prompt'],['--prompt','--no-prompt'],['speech','--no-prompt']])expect(classify(surface,'trust',args).tier).toBe('read')
    for(const args of [['--prompt'],['--walkthrough'],['--microphone-prompt'],['speech'],['--wat','--no-prompt']])expect(classify(surface,'trust',args).tier).toBe('mutate')
  }
})
