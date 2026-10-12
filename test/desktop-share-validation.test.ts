import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopShareActionError,desktopShareResultError} from '../shared/desktop-share-validation'
import {classify} from '../cli/mcp/tiers'
import {pickTimeoutForAction} from '../cli/transport'
test('Share preserves payloads and refuses silent field loss before native work',()=>{
  for(const desktop of [false,true]){
    const parse=(...args:string[])=>desktopAction(parseMacosCommand(['macos','share',...args],undefined,desktop)!)
    expect(parse('email','--text','Actual text','--to','a@example.test,b@example.test')).toMatchObject({text:'Actual text',recipients:['a@example.test','b@example.test']})
    expect(parse('named','email','/tmp/fixture','--subject','Actual subject')).toMatchObject({service:'email',items:['/tmp/fixture'],subject:'Actual subject'})
    for(const args of [[],['email'],['services','--body','x'],['text','value','--service','email','--items','ignored'],['email','--text','x','--to','a','--recipients','b'],['email','--text','x','--recipient','a','--to','b'],['url','javascript:alert(1)','--service','email'],['email','--text','x','--unknown','x']])expect(()=>parse(...args)).toThrow()
  }
  expect(desktopShareActionError({type:'desktop_share',sub:'email',items:Array(33).fill('/tmp/x')})).toBeDefined()
  for(const surface of ['macos','local','desktop'] as const){expect(classify(surface,'share',['services']).tier).toBe('read');for(const selector of ['airdrop','email','message','named','text','url','reading-list','desktop-picture','unknown'])expect(classify(surface,'share',[selector]).tier).toBe('destructive')}
  for(const type of ['desktop_share','macos_share'])expect(pickTimeoutForAction({type,sub:'services'})).toBeGreaterThanOrEqual(63000)
})
test('Share replies distinguish native completion from compose presentation',()=>{
  const action={type:'desktop_share',sub:'email'}
  expect(desktopShareResultError(action,{ok:true,service:'email',outcome:'compose-presented',note:'Actual native composer accepted'})).toBeUndefined()
  for(const data of [{ok:false,service:'email'},{ok:true,service:''},{ok:true,service:'email',outcome:'attempted'},{ok:true,service:'email',items:Array(33).fill('x')},{ok:true,service:'email',note:'x\0'}])expect(desktopShareResultError(action,data)).toBeDefined()
  expect(desktopShareResultError({type:'desktop_share',sub:'services'},{services:[{title:'Email',menuItemTitle:'Compose email',id:'email',canPerform:true},{title:'Email duplicate',menuItemTitle:'Compose email',id:'email',canPerform:true}]})).toBeDefined()
})
test('Share parser changes preserve VM and personal-data branches',()=>{
  expect(parseMacosCommand(['macos','vm','share','owned-fixture','/tmp/source','fixture'])).toMatchObject({type:'macos_vm_share',name:'owned-fixture',hostPath:'/tmp/source',tag:'fixture',readOnly:true})
  expect(parseMacosCommand(['macos','calendar','status'])).toMatchObject({type:'macos_calendar',sub:'status'})
  expect(parseMacosCommand(['macos','contacts','status'])).toMatchObject({type:'macos_contacts',sub:'status'})
  expect(parseMacosCommand(['macos','photos','status'])).toMatchObject({type:'macos_photos',sub:'status'})
  expect(parseMacosCommand(['macos','music','library','--type','song'])).toMatchObject({type:'macos_music',kind:'song'})
  expect(parseMacosCommand(['macos','maps','search','actual query','--limit','2'])).toMatchObject({type:'macos_maps',limit:2})
})
