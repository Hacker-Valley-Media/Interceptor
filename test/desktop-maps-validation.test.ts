import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopMapsActionError,desktopMapsRegion,desktopMapsResultError} from '../shared/desktop-maps-validation'
import {classify} from '../cli/mcp/tiers'
import {pickTimeoutForAction} from '../cli/transport'
test('maps rejects malformed and misplaced fields before native work',()=>{
  for(const desktop of [false,true]){
    const parse=(...args:string[])=>desktopAction(parseMacosCommand(['macos','maps',...args],undefined,desktop)!)
    expect(parse('search','coffee','--limit','3').limit).toBe(3)
    expect(parse('complete','co','--poi-categories','cafe').poi_categories).toBe('cafe')
    expect(parse('directions','--from','1,2','--to','3,4','--transport','walking').transport).toBe('walking')
    for(const args of [[],['search'],['search','x','--limit','1.5'],['search','x','--limit','0'],['search','x','--limit','33'],['search','x','--limit','2','--limit','3'],['eta','--from','91,0','--to','1,2'],['reverse','1,,2'],['reverse','1,2','--query','x'],['complete','x','--types','query'],['search','x','--address-include','country','--address-exclude','country']])expect(()=>parse(...args)).toThrow()
  }
  expect(desktopMapsRegion('1,2,3,4')).toEqual([1,2,3,4])
  for(const text of ['1,,2,3','NaN,0,1,1','91,0,1,1','0,0,0,1','0,0,1,361','0x1,0,1,1'])expect(desktopMapsRegion(text)).toBeUndefined()
  expect(desktopMapsActionError({type:'desktop_maps',sub:'complete',query:'x',from:'1,2'})).toBeDefined()
  for(const surface of ['macos','local','desktop'] as const){for(const verb of ['search','complete','directions','eta','reverse'])expect(classify(surface,'maps',[verb]).tier).toBe('read');expect(classify(surface,'maps',['mapitem-open']).tier).toBe('mutate')}
  for(const type of ['desktop_maps','macos_maps'])expect(pickTimeoutForAction({type,sub:'directions'})).toBeGreaterThanOrEqual(65000)
})
test('maps validates actual result identities, numeric observations and output bounds',()=>{
  const item={id:'B-fixture',name:null,isCurrentLocation:false,placemark:{name:null,coordinate:[1,2],attribution:'fixture attribution'}},search={type:'desktop_maps',sub:'search',query:'x',limit:1}
  expect(desktopMapsResultError(search,{query:'x',results:[item],boundingRegion:{center:[1,2],span:[0,0]}})).toBeUndefined()
  for(const data of [{query:'other',results:[]},{query:'x',results:[item,item]},{query:'x',results:[{...item,placemark:{name:null,coordinate:[91,0]}}]},{query:'x',results:[{...item,id:'x'.repeat(129)}]}])expect(desktopMapsResultError(search,data)).toBeDefined()
  const open={type:'desktop_maps',sub:'mapitem-open',id:item.id}
  expect(desktopMapsResultError(open,{ok:true,id:item.id})).toBeUndefined()
  expect(desktopMapsResultError(open,{ok:true,id:'other'})).toBeDefined()
  expect(desktopMapsResultError(open,{ok:false,id:item.id})).toBeDefined()
  const eta={transport:'walking',expectedTravelTime:60,distance:1000,expectedDepartureDate:'2026-10-08T00:00:00Z',expectedArrivalDate:'2026-10-08T00:01:00Z',dateSource:'request-clock-plus-native-route-duration',partial:true}
  expect(desktopMapsResultError({type:'desktop_maps',sub:'eta'},eta)).toBeUndefined()
  expect(desktopMapsResultError({type:'desktop_maps',sub:'eta'},{...eta,expectedTravelTime:-1})).toBeDefined()
  expect(desktopMapsResultError({type:'desktop_maps',sub:'eta'},{...eta,expectedArrivalDate:'2026-10-07T00:00:00Z'})).toBeDefined()
  expect(desktopMapsResultError({type:'desktop_maps',sub:'reverse',coords:'1,2'},{coordinate:[2,1],placemarks:[]})).toBeDefined()
})
