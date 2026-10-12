import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopContactsActionError,desktopContactsResultError} from '../shared/desktop-contacts-validation'
import {pickTimeoutForAction} from '../cli/transport'
import {buildFilteredArgs} from '../cli/global-flags'
test('Contacts preserve one query mode and exact typed fields before native work',()=>{
  for(const desktop of [false,true]){
    const parse=(...args:string[])=>desktopAction(parseMacosCommand(['macos','contacts',...args],undefined,desktop)!)
    expect(parse('find','Actual name')).toEqual({type:'desktop_contacts',sub:'find',query:'Actual name'})
    expect(parse('import-vcard','/tmp/owned.vcf','--container','native-id')).toEqual({type:'desktop_contacts',sub:'import-vcard',path:'/tmp/owned.vcf',container:'native-id'})
    expect(parse('list','--group','native-group','--limit','20','--offset','4','--keys','id,givenName')).toMatchObject({group:'native-group',limit:20,offset:4,keys:'id,givenName'})
    const surface=desktop?'desktop':'macos'
    const native=buildFilteredArgs(['--group','browser-lane',surface,'contacts','list','--group','native:id','--limit','20'])
    expect(desktopAction(parseMacosCommand(['macos',...native.slice(1)],undefined,desktop)!)).toMatchObject({type:'desktop_contacts',sub:'list',group:'native:id',limit:20})
    expect(()=>parseMacosCommand(['macos',...buildFilteredArgs([surface,'contacts','status','--group','native:id']).slice(1)],undefined,desktop)).toThrow()
    for(const args of [[],['find','name','--email','other'],['list','--limit','0'],['list','--limit','1.5'],['list','--limit','2','--limit','3'],['list','--keys','givenName,givenName'],['list','--keys','unknown'],['list','--container','c','--group','g'],['status','extra'],['create','--birthday','2026-02-30'],['create','--postal','home:street;city'],['create','--email','unlabelled'],['create','--unknown','x'],['changes','--since','not-base64!'],['import-vcard','relative.vcf']])expect(()=>parse(...args)).toThrow()
  }
  const valid={type:'desktop_contacts',sub:'update',id:'actual-native-id',given:'',family:'Actual',birthday:'2024-02-29',postal:'home:street;;state;;country'}
  expect(desktopContactsActionError(valid)).toBeUndefined()
  for(const type of ['desktop_contacts','macos_contacts'])expect(pickTimeoutForAction({type,sub:'status'})).toBeGreaterThanOrEqual(63000)
})
test('Contacts replies require actual identities, page bounds and native bytes',()=>{
  const result=(sub:string,data:unknown)=>desktopContactsResultError({type:'desktop_contacts',sub,...(sub==='list'?{limit:2}:{})},data)
  expect(result('list',{limit:2,offset:0,contacts:[{id:'one',givenName:'Actual'}]})).toBeUndefined()
  expect(result('list',{limit:1,offset:0,contacts:[{id:'one'},{id:'two'}]})).toBeDefined()
  expect(result('list',{limit:2,offset:0,contacts:[{id:'one'},{id:'one'}]})).toBeDefined()
  expect(result('vcard',{id:'one',vcard:'é',bytes:1})).toBeDefined()
  expect(result('vcard',{id:'one',vcard:'é',bytes:2})).toBeUndefined()
  expect(result('import-vcard',{imported:2,ids:['one']})).toBeDefined()
  expect(result('delete',{ok:false,id:'one'})).toBeDefined()
  expect(result('changes',{currentToken:'YWN0dWFs',events:[{type:'deleteContact',contactId:'one'}]})).toBeUndefined()
  expect(result('changes',{currentToken:'YWN0dWFs',events:[],note:'No native enumeration happened'})).toBeDefined()
  expect(result('current-token',{token:'%%%'})).toBeDefined()
  expect(result('import-vcard',{imported:1,ids:[' ']})).toBeDefined()
  expect(desktopContactsActionError({type:'desktop_contacts',sub:'update',id:'actual',email:'é'.repeat(65)+':value'})).toBeDefined()
  expect(desktopContactsActionError({type:'desktop_contacts',sub:'create',birthday:'0000-01-01'})).toBeDefined()
  expect(desktopContactsResultError({type:'desktop_contacts',sub:'group-add-member',id:'g',contact:'c'},{ok:true,group:'other',contact:'c',added:true})).toBeDefined()
})
