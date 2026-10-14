import {expect, test} from 'bun:test'
import {desktopProviderEndpoint} from '../shared/desktop-provider'
import {bridgeSocketPath} from '../shared/bridge-paths'
import {mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

test('Darwin neutral discovery uses the same runtime socket as the installed Swift bridge', async () => {
  if (process.platform !== 'darwin') return
  const endpoint = process.env.INTERCEPTOR_DESKTOP_ENDPOINT
  const runtime = process.env.INTERCEPTOR_BRIDGE_RUNTIME_DIR
  try {
    delete process.env.INTERCEPTOR_DESKTOP_ENDPOINT
    process.env.INTERCEPTOR_BRIDGE_RUNTIME_DIR = '/tmp/owned-provider-discovery'
    expect(await desktopProviderEndpoint()).toBe(bridgeSocketPath())
    process.env.INTERCEPTOR_DESKTOP_ENDPOINT = '/tmp/owned-explicit-provider.sock'
    expect(await desktopProviderEndpoint()).toBe('/tmp/owned-explicit-provider.sock')
  } finally {
    if(endpoint === undefined) delete process.env.INTERCEPTOR_DESKTOP_ENDPOINT
    else process.env.INTERCEPTOR_DESKTOP_ENDPOINT = endpoint
    if(runtime === undefined) delete process.env.INTERCEPTOR_BRIDGE_RUNTIME_DIR
    else process.env.INTERCEPTOR_BRIDGE_RUNTIME_DIR = runtime
  }
})

test('isolated native discovery validates descriptors and preserves failure codes before negotiation', async () => {
  if (process.platform === 'win32') return
  const directory=mkdtempSync(join(tmpdir(),'desktop-discovery-')),binary=join(directory,'native-provider')
  const endpoint=String.raw`\\.\pipe\interceptor-desktop-S-1-5-21-1001-1`
  const firstTimeout=join(directory,'first-timeout')
  const cases=[
    {name:'Windows descriptor',platform:'win32',descriptor:{endpoint,session:'1'},expected:endpoint},
    {name:'Linux descriptor',platform:'linux',descriptor:{uid:process.getuid!(),session:'owned',endpoint:'/tmp/interceptor-desktop/session-owned.sock'},expected:'/tmp/interceptor-desktop/session-owned.sock'},
    {name:'Session 0',platform:'win32',descriptor:{endpoint,session:'0'},code:'no_interactive_session'},
    {name:'invalid descriptor',platform:'win32',descriptor:{endpoint:'/wrong',session:'1'},code:'provider_failed'},
    {name:'malformed descriptor',platform:'win32',text:'{',code:'provider_failed'},
    {name:'wrong Linux uid',platform:'linux',descriptor:{uid:process.getuid!()+1,session:'owned',endpoint:'/tmp/interceptor-desktop/session-owned.sock'},code:'provider_failed'},
    {name:'failed helper',platform:'win32',script:"printf '%s\\n' 'owned identity failure' >&2\nexit 7",code:'provider_failed'},
    {name:'absent login',platform:'linux',script:"printf '%s\\n' 'no systemd login session; a GUI broker is required' >&2\nexit 1",code:'no_interactive_session'},
    {name:'oversized descriptor',platform:'win32',text:'x'.repeat(5000),code:'provider_failed'},
    {name:'identity deadline',platform:'win32',script:'exec /bin/sleep 12',code:'provider_failed',attempts:2},
    {name:'Linux identity deadline',platform:'linux',script:'exec /bin/sleep 12',code:'provider_failed'},
    {name:'timeout then valid identity',platform:'win32',script:`if [ ! -f '${firstTimeout}' ]; then touch '${firstTimeout}'; exec /bin/sleep 12; fi\nprintf '%s\\n' '${JSON.stringify({endpoint,session:'1'})}'`,expected:endpoint,attempts:2},
    {name:'native denial',platform:'win32',script:"printf '%s\\n' 'owned native permission denial' >&2\nexit 13",code:'provider_failed'},
    {name:'absent helper',platform:'win32',missing:true,code:'not_installed'},
  ]
  try {
    for(const item of cases){
      const payload='descriptor' in item?JSON.stringify(item.descriptor):'text' in item?item.text:''
      const invocationFile=join(directory,'invocations-'+cases.indexOf(item))
      writeFileSync(binary,`#!/bin/sh\nprintf '%s\\n' invocation >> '${invocationFile}'\n`+('script' in item?item.script:`printf '%s\\n' '${payload}'`)+'\n');chmodSync(binary,0o700)
      // Platform spoofing also changes Bun's console/stdio implementation.
      // Retain the result in an owned file so an empty console stream cannot
      // be mistaken for a successful discovery result.
      const resultFile=join(directory,'result-'+cases.indexOf(item)+'.json')
      const code=`const {writeFileSync}=await import('node:fs');
        Object.defineProperty(process,'platform',{value:${JSON.stringify(item.platform)}});
        delete process.env.INTERCEPTOR_DESKTOP_ENDPOINT;
        process.env.INTERCEPTOR_DESKTOP_PROVIDER=${JSON.stringify(binary+('missing' in item?'-absent':''))};
        const {desktopProviderEndpoint}=await import(${JSON.stringify(new URL('../shared/desktop-provider.ts',import.meta.url).pathname)});
        const {callDesktopProvider}=await import(${JSON.stringify(new URL('../daemon/desktop-provider.ts',import.meta.url).pathname)});
        const started=performance.now();
        const result=${'expected' in item?'await desktopProviderEndpoint()':"await callDesktopProvider({type:'desktop_hello'})"};
        writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({result,ms:performance.now()-started}));`
      const child=Bun.spawn([process.execPath,'-e',code],{stdin:'pipe',stdout:'pipe',stderr:'pipe'})
      child.stdin.end()
      const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
      expect(status,item.name+stderr).toBe(0)
      const {result,ms}=JSON.parse(readFileSync(resultFile,'utf8'))
      if(!('missing' in item))expect(readFileSync(invocationFile,'utf8').trim().split('\n').length,item.name+' invocation count').toBe(item.attempts ?? 1)
      if('expected' in item)expect(result,item.name).toBe(item.expected)
      else {
        expect(result.success,item.name).toBe(false);expect(result.code,item.name).toBe(item.code)
        if(item.name==='failed helper')expect(result.error).toContain('owned identity failure')
        if(item.name==='identity deadline'){expect(ms).toBeGreaterThanOrEqual(7900);expect(ms).toBeLessThan(9500)}
      }
      if(item.name==='Linux identity deadline'||item.name==='timeout then valid identity'){expect(ms).toBeGreaterThanOrEqual(4900);expect(ms).toBeLessThan(6500)}
    }
  } finally {rmSync(directory,{recursive:true,force:true})}
},45000)
