import {expect,test} from 'bun:test'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopPdfActionError,desktopPdfResultError} from '../shared/desktop-pdf-validation'
import {pickTimeoutForAction} from '../cli/transport'
import {classify,gate,parseAllow} from '../cli/mcp/tiers'

test('PDF operations keep exact fields, empty form values, bounded replies and write authority',()=>{
  const path=join(tmpdir(),'interceptor-owned.pdf'),out=join(tmpdir(),'interceptor-owned-copy.pdf')
  const forms=parseMacosCommand(['macos','pdf','forms','set',path,'--field','Name','--value',''],undefined,true)!
  expect(forms.sub).toBe('forms_set');expect(forms.value).toBe('');expect(desktopPdfActionError(forms)).toBeUndefined()
  expect(pickTimeoutForAction(forms)).toBeGreaterThanOrEqual(35000)
  expect(desktopPdfResultError(forms,{savedTo:path,fieldName:'Name',newValue:'',ok:true})).toBeUndefined()
  for(const changed of [{savedTo:out},{fieldName:'different'},{newValue:'changed'},{ok:false}])expect(desktopPdfResultError(forms,{savedTo:path,fieldName:'Name',newValue:'',ok:true,...changed})).toBeDefined()
  for(const argv of [['info',path,'--out',out],['text',path,'--page','1junk'],['text',path,'--range','4-2'],['text',path,'--page','1','--range','1-2'],['split',path,'--pages','1-2'],['info',path,'extra'],['annotate',path,'--page','1','--rect','0,0,NaN,10'],['text',path,'--attributed','--attributed']])expect(()=>parseMacosCommand(['macos','pdf',...argv],undefined,true)).toThrow()
  for(const host of ['macos','desktop'] as const){
    for(const args of [['forms','set',path,'--field','Name','--value',''],['forms_set',path],['annotate',path],['strip',path],['merge',path],['split',path]]){
      const classification=classify(host,'pdf',args);expect(classification.tier).toBe('destructive');expect(gate(classification,parseAllow(''),true).allowed).toBe(false);expect(gate(classification,parseAllow('destructive'),false).allowed).toBe(false)
    }
    expect(classify(host,'pdf',['forms',path]).tier).toBe('read')
  }
  const action={type:'desktop_pdf',sub:'text',path,page:1,attributed:true}
  const data={path,page:1,text:'Unicode 验证',characterCount:10,attributedString:[{range:[0,10],font:{name:'Helvetica',size:12}}]}
  expect(desktopPdfResultError(action,data)).toBeUndefined()
  expect(desktopPdfResultError(action,{...data,page:2})).toBeDefined()
  expect(desktopPdfResultError(action,{...data,attributedString:[{range:[0,100]}]})).toBeDefined()
})
