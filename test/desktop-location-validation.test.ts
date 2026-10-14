import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopLocationActionError,desktopLocationCoordinates,desktopLocationResultError} from '../shared/desktop-location-validation'
import {classify} from '../cli/mcp/tiers'
import {pickTimeoutForAction} from '../cli/transport'
test('location selectors own their fields before native dispatch',()=>{
  for(const desktop of [false,true]){
    const parse=(...args:string[])=>desktopAction(parseMacosCommand(['macos','location',...args],undefined,desktop)!)
    expect(parse('current')).toEqual({type:'desktop_location',sub:'current'})
    expect(parse('monitor','start','--accuracy','threekilometers').sub).toBe('monitor_start')
    expect(parse('reverse',' 1 , -2 ','--locale','en-US').coords).toBe(' 1 , -2 ')
    for(const args of [[],['monitor'],['current','--accuracy','best'],['geocode'],['reverse','1,,2'],['request','--level','other'],['distance','--from','91,0','--to','0,0'],['geocode','x','--locale','en','--locale','fr']])expect(()=>parse(...args)).toThrow()
  }
  expect(desktopLocationCoordinates(' 1, -2 ')).toEqual([1,-2])
  for(const text of ['1,,2','91,0','0,181','NaN,0','0x1,0','1e999,0'])expect(desktopLocationCoordinates(text)).toBeUndefined()
  for(const action of [{sub:'postal-geocode',postal:'{"extra":"x"}'},{sub:'monitor_stop',accuracy:'best'},{sub:'geocode',address:'x',region:'0,0,0'}])expect(desktopLocationActionError({type:'desktop_location',...action})).toBeDefined()
  for(const surface of ['macos','local','desktop'] as const){expect(classify(surface,'location',['current']).tier).toBe('read');expect(classify(surface,'location',['monitor','tail']).tier).toBe('read');expect(classify(surface,'location',['monitor','start']).tier).toBe('mutate');expect(classify(surface,'location',['request']).tier).toBe('mutate')}
  for(const type of ['desktop_location','macos_location'])expect(pickTimeoutForAction({type,sub:'current'})).toBeGreaterThanOrEqual(40000)
})
test('location observations preserve unknown fields and refuse malformed fixes or lifecycle claims',()=>{
  const current={type:'desktop_location',sub:'current'},fix={coordinate:[1,2],altitude:null,ellipsoidalAltitude:null,horizontalAccuracy:3,verticalAccuracy:null,course:null,courseAccuracy:null,speed:null,speedAccuracy:null,timestamp:'2026-10-08T00:00:00Z',floor:null}
  expect(desktopLocationResultError(current,fix)).toBeUndefined()
  for(const changes of [{coordinate:[1,2,3]},{horizontalAccuracy:-1},{timestamp:'invalid'},{floor:0.5},{speed:Infinity}])expect(desktopLocationResultError(current,{...fix,...changes})).toBeDefined()
  expect(desktopLocationResultError({type:'desktop_location',sub:'status'},{locationServicesEnabled:null,status:'unknown',accuracyAuthorization:'unknown',providerPresent:false})).toBeUndefined()
  expect(desktopLocationResultError({type:'desktop_location',sub:'monitor_start'},{monitoring:false,accuracy:'best'})).toBeDefined()
  const reverse={type:'desktop_location',sub:'reverse',coords:'1,2'}
  expect(desktopLocationResultError(reverse,{coordinate:[1,2],placemarks:[]})).toBeUndefined()
  expect(desktopLocationResultError(reverse,{coordinate:[2,1],placemarks:[]})).toBeDefined()
  expect(desktopLocationResultError(reverse,{coordinate:[1,2],placemarks:[{name:'x\0'}]})).toBeDefined()
  expect(desktopLocationResultError(current,{...fix,extra:true})).toBeDefined()
})
