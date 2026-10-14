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
    for(const args of [['--app','check'],['check','extra'],['install','now'],['download']])expect(()=>parse(...args)).toThrow()
    // Like Sparkle on the Mac, every OS installs from the update window: no install verb anywhere.
    expect(()=>parse('install')).toThrow(/Install Update in its update window/)
  }
  for(const surface of ['local','macos','desktop'] as const){for(const args of [[],['check'],['status']])expect(classify(surface,'update',args).tier).toBe('read');expect(classify(surface,'update',['install']).tier).toBe('destructive')}
  expect(desktopUpdateActionError({type:'desktop_update',sub:'status',url:'https://other.invalid'})).toBeDefined()
  expect(desktopUpdateActionError({type:'desktop_update',sub:'install'})).toBeDefined()
  for(const type of ['macos_update','desktop_update'])expect(pickTimeoutForAction({type,sub:'check'})).toBeGreaterThanOrEqual(20000)
})
test('update metadata cannot masquerade as artifact verification or a finished active session',()=>{
  const status={phase:'idle',outcome:'none',concluded:true,feed:'https://updates.hackervalley.media/windows/latest.json',automaticChecks:true,checkInterval:86400,canCheckForUpdates:true,sessionInProgress:false,currentVersion:'2.1.0'}
  const action={type:'desktop_update',sub:'status'}
  expect(desktopUpdateResultError(action,status)).toBeUndefined()
  for(const changes of [{sessionInProgress:true},{checkInterval:-1},{lastCheck:'not a timestamp'},{nextCheckAt:'soon'},{outcome:'error'},{outcome:'update_available'},{artifactURL:'https://unsafe.invalid/setup.exe',artifactName:'setup.exe',signatureVerified:false},{message:'bad\0text'},{signatureVerified:true},{lastInstallOutcome:'maybe'}])expect(desktopUpdateResultError(action,{...status,...changes})).toBeDefined()
  expect(desktopUpdateResultError(action,{...status,lastInstallVersion:'2.0.99',lastInstallOutcome:'installed',lastInstallAt:'2026-10-12T20:00:00Z',nextCheckAt:'2026-10-12T20:15:00Z'})).toBeUndefined()
  const url='https://updates.hackervalley.media/windows/Interceptor-Full-2.2.0-windows-arm64.exe'
  const available={...status,phase:'update_available',outcome:'update_available',selectedVersion:'2.2.0',artifactName:'Interceptor-Full-2.2.0-windows-arm64.exe',artifactURL:url,signatureVerified:false}
  expect(desktopUpdateResultError(action,available)).toBeUndefined()
  // A check reads signed metadata only; verified describes downloaded bytes.
  expect(desktopUpdateResultError(action,{...available,signatureVerified:true})).toBeDefined()
  for(const phase of ['downloaded','ready_to_install','installing'])expect(desktopUpdateResultError(action,{...available,phase,outcome:phase==='installing'?'installing':'install_chosen',sessionInProgress:true,concluded:false,signatureVerified:true})).toBeUndefined()
  // Remind Me Later after the download: verified bytes stay on disk, but the state no longer claims them.
  expect(desktopUpdateResultError(action,{...available,phase:'deferred',outcome:'deferred',signatureVerified:true})).toBeDefined()
  for(const changes of [{selectedVersion:'2.2.1'},{artifactURL:url+'?redirect=other'},{artifactName:'Interceptor-Full-2.2.0-windows-arm64.tar.gz'},{artifactURL:'http://updates.hackervalley.media/windows/Interceptor-Full-2.2.0-windows-arm64.exe'},{artifactURL:'https://updates.hackervalley.media/windows/other.exe'}])expect(desktopUpdateResultError(action,{...available,...changes})).toBeDefined()
  // A lab feed on a private address may use plain HTTP; the provider still checks the signature and digest.
  expect(desktopUpdateResultError(action,{...available,artifactURL:'http://192.168.64.1:8099/windows/Interceptor-Full-2.2.0-windows-arm64.exe'})).toBeUndefined()
})
