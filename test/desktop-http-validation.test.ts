import {expect,test} from 'bun:test'
import {desktopHttpActionError,desktopHttpResultError} from '../shared/desktop-http-validation'
import {parseMacosCommand} from '../cli/commands/macos'
import {pickTimeoutForAction} from '../cli/transport'
import {classify} from '../cli/mcp/tiers'
const action={type:'desktop_url_fetch',url:'http://localhost/fixture',method:'GET',timeoutMs:30000}

test('HTTP requests reject malformed URLs, header injection, case duplicates, nulls and oversized bodies',()=>{
  expect(desktopHttpActionError(action)).toBeUndefined()
  for(const fields of [{url:'file:///tmp/a'},{url:'http://user:password@localhost'},{url:'relative'},{method:'GET\n'},{headers:{a:'x\r\nb:y'}},{headers:{A:'x',a:'y'}},{timeoutMs:0},{timeoutMs:100.5},{body:null},{body:'a'.repeat(4194305)},{extra:true}])expect(desktopHttpActionError({...action,...fields})).toBeString()
  for(const args of [['url','oops',action.url],['url','get',action.url,'--timeout','0'],['url','get',action.url,'--header','invalid'],['url','get',action.url,'-H','a:1','-H','A:2']])expect(()=>parseMacosCommand(['macos',...args],undefined,true)).toThrow()
  const parsed=parseMacosCommand(['macos','url','post',action.url,'--body','hello 文件','--header','X-Fixture: yes'],undefined,true)!
  expect(parsed.method).toBe('POST');expect(parsed.body).toBe('hello 文件');expect(parsed.headers).toEqual({'X-Fixture':'yes'})
  expect(pickTimeoutForAction({...action,timeoutMs:120000})).toBeGreaterThan(120000)
  expect(classify('desktop','url',['post',action.url]).tier).toBe('mutate')
})

test('HTTP result kinds have exact payload sizes and mutually exclusive fields',()=>{
  const result={status:200,headers:{'content-type':'text/plain'},contentType:'text/plain',url:action.url,body:{kind:'text',bytes:7,text:'文件a'}}
  expect(desktopHttpResultError(action,result)).toBeUndefined()
  for(const headers of [{'x-fixture':'a\r\nb'}, {'invalid header':'a'}, {'x-fixture':'a'.repeat(65537)}, Object.fromEntries(Array.from({length:129},(_,i)=>[`x-${i}`,'a']))])expect(desktopHttpResultError(action,{...result,headers})).toBeString()
  for(const fields of [{status:200.5},{status:600},{url:'file:///tmp/a'},{body:{...result.body,bytes:8}},{body:{...result.body,base64:'a'}},{body:{kind:'bytes',bytes:2,base64:'YQ=='}},{body:{kind:'bytes',bytes:1,base64:'YQ'}}])expect(desktopHttpResultError(action,{...result,...fields})).toBeString()
  const artifactId='abcdef012345';const body={kind:'bodyRef',bytes:70000,preview:'fixture',sidecarPath:`/owned/url_fetch-${artifactId}.bin`,artifactRef:{kind:'artifact',artifactId,bytes:70000,preview:'fixture',contentType:'text/plain',url:action.url}}
  expect(desktopHttpResultError(action,{...result,body})).toBeUndefined()
  const macText={...body,sidecarPath:`/owned/url_fetch-${artifactId}.txt`}
  if(process.platform==='darwin')expect(desktopHttpResultError(action,{...result,body:macText})).toBeUndefined()
  else expect(desktopHttpResultError(action,{...result,body:macText})).toBeString()
  expect(desktopHttpResultError(action,{...result,body:{...body,sidecarPath:`/owned/url_fetch-${artifactId}.png`}})).toBeString()
  expect(desktopHttpResultError(action,{...result,body:{...body,sidecarPath:`/owned/url_fetch-${artifactId}.exe`}})).toBeString()
  expect(desktopHttpResultError(action,{...result,body:{...body,artifactRef:{...body.artifactRef,bytes:69999}}})).toBeString()
})
