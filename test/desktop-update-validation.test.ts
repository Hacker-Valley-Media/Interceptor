import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopUpdateActionError,desktopUpdateResultError} from '../shared/desktop-update-validation'
import {classify} from '../cli/mcp/tiers'
import {pickTimeoutForAction} from '../cli/transport'
test('update selectors refuse fields and preserve read/install boundaries',()=>{
  for(const desktop of [false,true]){
    const parse=(...args:string[])=>desktopAction(parseMacosCommand(['macos','update',...args],undefined,desktop)!)
    expect(parse()).toEqual({type:'desktop_update',sub:'status'})
    expect(parse('check').sub).toBe('check')
    for(const args of [['install'],['--app','check'],['check','extra']])expect(()=>parse(...args)).toThrow()
  }
  for(const surface of ['local','macos','desktop'] as const){for(const args of [[],['check'],['status']])expect(classify(surface,'update',args).tier).toBe('read');expect(classify(surface,'update',['install']).tier).toBe('destructive')}
  expect(desktopUpdateActionError({type:'desktop_update',sub:'status',url:'https://other.invalid'})).toBeDefined()
  for(const type of ['macos_update','desktop_update'])expect(pickTimeoutForAction({type,sub:'check'})).toBeGreaterThanOrEqual(20000)
})
test('update metadata cannot masquerade as artifact verification or a finished active session',()=>{
  const status={phase:'idle',outcome:'none',concluded:true,feed:'https://api.github.com/repos/Hacker-Valley-Media/Interceptor/releases/latest',automaticChecks:false,checkInterval:0,canCheckForUpdates:true,sessionInProgress:false,currentVersion:'1.0.26'}
  const action={type:'desktop_update',sub:'status'}
  expect(desktopUpdateResultError(action,status)).toBeUndefined()
  for(const changes of [{sessionInProgress:true},{checkInterval:-1},{lastCheck:'not a timestamp'},{outcome:'error'},{outcome:'update_available'},{artifactURL:'https://unsafe.invalid/setup.exe',artifactName:'setup.exe',signatureVerified:false},{message:'bad\0text'}])expect(desktopUpdateResultError(action,{...status,...changes})).toBeDefined()
  const available={...status,phase:'update_available',outcome:'update_available',selectedVersion:'1.0.27',artifactName:'Interceptor-Full-1.0.27-windows-arm64.exe',artifactURL:'https://github.com/Hacker-Valley-Media/Interceptor/releases/download/v1.0.27/Interceptor-Full-1.0.27-windows-arm64.exe',signatureVerified:false}
  expect(desktopUpdateResultError(action,available)).toBeUndefined();expect(desktopUpdateResultError(action,{...available,signatureVerified:true})).toBeDefined()
  for(const changes of [{selectedVersion:'1.0.28'},{artifactURL:available.artifactURL+'?redirect=other'},{artifactName:'Interceptor-Full-1.0.27-windows-arm64.tar.gz'}])expect(desktopUpdateResultError(action,{...available,...changes})).toBeDefined()
})
