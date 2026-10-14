import {expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopAction} from '../shared/desktop-contract'
import {desktopEventKitActionError,desktopEventKitResultError,eventKitInstant} from '../shared/desktop-eventkit-validation'
import {pickTimeoutForAction} from '../cli/transport'

test('Calendar and Reminders reject lost scope and malformed mutations before dispatch',()=>{
  for(const desktop of [false,true]){
    const parse=(family:string,...args:string[])=>desktopAction(parseMacosCommand(['macos',family,...args],undefined,desktop)!)
    expect(parse('calendar','events','--start','2026-01-01T00:00:00Z','--end','2026-01-02T00:00:00Z','--calendar','actual','--limit','2')).toMatchObject({calendar:'actual',limit:2})
    expect(parse('calendar','update','actual','--alarm','-600','--alarm','2026-01-01T00:00:00Z','--recurrence-frequency','weekly','--recurrence-interval','2')).toMatchObject({alarms:['-600','2026-01-01T00:00:00Z'],recurrence_interval:2})
    expect(parse('reminders','create','--title','fixture','--list','actual','--due','2024-02-29T12:00:00-06:00','--priority','high')).toMatchObject({list:'actual',priority:'high'})
    for(const [family,args]of [
      ['calendar',['status','extra']],['calendar',['events','--start','2026-02-30T00:00:00Z','--end','2026-03-01T00:00:00Z']],
      ['calendar',['events','--start','2026-01-01T00:00:00Z','--end','2026-01-02T00:00:00Z','--calendar','one','--calendars','two']],
      ['calendar',['events','--start','2026-01-01T00:00:00Z','--end','2026-01-02T00:00:00Z','--calendars','one,one']],
      ['calendar',['update','actual','--attendee','someone@example.test']],['calendar',['update','actual','--title','one','--title','two']],
      ['calendar',['update','actual','--recurrence-interval','2']],['calendar',['update','actual','--recurrence-frequency','daily','--recurrence-end','0']],
      ['calendar',['update','actual','--alarm','NaN']],['calendar',['update','actual','--start','2026-01-01']],['calendar',['delete','actual','--span','whatever']],
      ['calendar',['create-calendar','--title','fixture','--color','#abc']],['calendar',['request','--level','whatever']],
      ['reminders',['update','actual','--priority','urgent']],['reminders',['create','--title','fixture','--due','2026-02-30T00:00:00Z']],
      ['reminders',['completed','--since','2026-01-02T00:00:00Z','--until','2026-01-01T00:00:00Z']],['reminders',['all','--limit','1.5']],
      ['reminders',['all','--list']],['reminders',['all','--list','actual','--unknown','x']],['reminders',['update','actual']],
    ] as [string,string[]][])expect(()=>parse(family,...args)).toThrow()
  }
  for(const family of ['calendar','reminders'])for(const surface of ['desktop','macos'])expect(pickTimeoutForAction({type:surface+'_'+family,sub:'status'})).toBeGreaterThanOrEqual(63000)
})
test('EventKit dates reject normalization and preserve actual offsets',()=>{
  expect(eventKitInstant('2024-02-29T12:00:00-06:00')).toBe(Date.parse('2024-02-29T18:00:00Z'))
  for(const value of ['0000-01-01T00:00:00Z','2026-02-29T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:60Z','2026-01-01T00:00:00','2026-01-01T00:00:00+25:00'])expect(eventKitInstant(value)).toBeUndefined()
  expect(desktopEventKitActionError({type:'desktop_calendar',sub:'update',id:'actual',alarms:[]})).toBeUndefined()
})
test('EventKit native replies preserve requested pages, targets and effects',()=>{
  const event={id:'actual',calendarId:'calendar',title:'fixture',startDate:'2026-01-01T00:00:00Z',endDate:'2026-01-01T01:00:00Z',isAllDay:false,isDetached:false,status:'confirmed',availability:'busy'}
  const a={type:'desktop_calendar',sub:'events',calendar:'calendar',limit:2}
  expect(desktopEventKitResultError(a,{events:[event],limit:2,offset:0,hasMore:false})).toBeUndefined()
  expect(desktopEventKitResultError(a,{events:[{...event,calendarId:'other'}],limit:2,offset:0,hasMore:false})).toBeDefined()
  expect(desktopEventKitResultError(a,{events:[event],limit:100,offset:0,hasMore:false})).toBeDefined()
  expect(desktopEventKitResultError(a,{events:[{...event,id:''}],limit:2,offset:0,hasMore:false})).toBeDefined()
  expect(desktopEventKitResultError(a,{events:[{...event,extra:'untyped'}],limit:2,offset:0,hasMore:false})).toBeDefined()
  expect(desktopEventKitResultError({type:'desktop_calendar',sub:'move',to:'other'},event)).toBeDefined()
  expect(desktopEventKitResultError({type:'desktop_calendar',sub:'delete',id:'actual'},{ok:true,id:'wrong'})).toBeDefined()
  const r={id:'actual',listId:'list',title:'fixture',isCompleted:false,priority:'none'}
  expect(desktopEventKitResultError({type:'desktop_reminders',sub:'incomplete',list:'list'},{reminders:[r],limit:100,offset:0,hasMore:false})).toBeUndefined()
  expect(desktopEventKitResultError({type:'desktop_reminders',sub:'complete',id:'actual'},r)).toBeDefined()
  expect(desktopEventKitResultError({type:'desktop_reminders',sub:'all',list:'other'},{reminders:[r],limit:100,offset:0,hasMore:false})).toBeDefined()
  expect(desktopEventKitResultError({type:'desktop_calendar',sub:'default'},{calendar:null})).toBeUndefined()
  expect(desktopEventKitResultError({type:'desktop_calendar',sub:'status'},{events:'unknown',reminders:'unknown',provider:'linux-evolution-data-server'})).toBeUndefined()
  expect(desktopEventKitResultError({type:'desktop_calendar',sub:'tail'},{tailing:true,changeCount:-1,lastChange:null})).toBeDefined()
})
