import {afterEach,beforeEach,expect,test} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {DESKTOP_ACTION_SCHEMAS,DESKTOP_SECRET_DATA_SCHEMAS,DESKTOP_CONTRACT_ALIASES,type DesktopContractSchema} from '../shared/desktop-contract.generated'
import {actionLogSummary,inboundLogSummary,isSecretBearing} from '../daemon/redact'
import {classify} from '../cli/mcp/tiers'
import {desktopSecretActionError,desktopSecretResultError} from '../shared/desktop-secret-validation'
import {desktopContractShapeError} from '../shared/desktop-contract-validation'
import {generateDesktopContract} from '../scripts/desktop-contract'
import replyFixtures from '../shared/desktop-secret-reply-fixtures.json'
import {pickTimeoutForAction,isGenericBrowserAction,timeoutMessage} from '../cli/transport'

const exit=process.exit,error=console.error
beforeEach(()=>{process.exit=((code:number)=>{throw Error('exit '+code)}) as never;console.error=()=>{}})
afterEach(()=>{process.exit=exit;console.error=error})

test('all vault reply selectors retain host formats and reject malformed or unrelated data',()=>{
 expect(Object.keys(DESKTOP_SECRET_DATA_SCHEMAS)).toEqual([...DESKTOP_CONTRACT_ALIASES.DesktopSecretVerb])
 const schemas:Readonly<Record<string,DesktopContractSchema>>=DESKTOP_SECRET_DATA_SCHEMAS
 for(const fixture of replyFixtures.cases){
  expect(!desktopContractShapeError(fixture.data,schemas[fixture.action.sub]),fixture.name).toBe(fixture.shapeValid)
  expect(!desktopSecretResultError(fixture.action,fixture.data),fixture.name).toBe(fixture.valid)
 }
 expect(desktopSecretResultError({type:'macos_secret',sub:'list'},{legacy:'unchanged'})).toBeUndefined()
 expect(desktopSecretResultError({type:'desktop_secret',sub:'unknown'},{})).toBeString()
})

test('the generator refuses missing or optional vault reply selectors',async()=>{
 const source=await Bun.file(new URL('../shared/desktop-contract.ts',import.meta.url)).text()
 for(const changed of [source.replace('  set: DesktopSecretStoredData\n',''),source.replace('  set: DesktopSecretStoredData','  set?: DesktopSecretStoredData')])expect(()=>generateDesktopContract(changed)).toThrow('vault result selector')
})

test('neutral secret values are classified and redacted before action/envelope logging',()=>{
 const action={type:'desktop_secret',sub:'set',name:'owned-test',value:'synthetic private value'}
 expect(isSecretBearing(action)).toBe(true)
 expect(actionLogSummary(action)).not.toContain(action.value)
 expect(actionLogSummary(action)).toContain('<redacted>')
 expect(inboundLogSummary({id:'owned',action})).not.toContain(action.value)
 expect(inboundLogSummary({id:'owned',action,vaultToken:'synthetic token must never be logged'})).not.toContain('synthetic token must never be logged')
 expect((DESKTOP_ACTION_SCHEMAS as Record<string,string>).desktop_secret).toBe('DesktopSecretAction')
})

test('neutral secret grammar refuses unknown, duplicated, misplaced and malformed fields',()=>{
 const parse=(args:string[])=>parseMacosCommand(['macos','secret',...args],new Set(),true)
 for(const args of [
  ['status','unexpected'],['list','--stdin'],['status','--unknown'],['rm','owned','--gate','none'],
  ['set','owned','--gate','invalid'],['set','owned','--reuse','-1'],['set','owned','--reuse','1.5'],
  ['set','owned','--reuse','1','--reuse','2'],['set','owned','--stdin','--stdin'],
  ['set','owned','--target','invalid:target'],['set','owned','--target',''],['set','owned','--target','browser:x.invalid,'],['set','owned','literal-on-argv'],['set','has space','--stdin'],
 ])expect(()=>parse(args)).toThrow()
 expect(parse(['set','owned','--stdin','--gate','none','--target','browser:Example.COM','--target','ios','--reuse','300']))
  .toEqual({type:'macos_secret',sub:'set',name:'owned',stdin:true,gate:'none',targets:['browser:example.com','ios'],reuseSeconds:300})
 expect(parse(['lock'])).toEqual({type:'macos_secret',sub:'lock'})
 expect(parse(['status'])).toEqual({type:'macos_secret',sub:'status'})
})

test('wire validation refuses malformed credentials before a native vault can be accessed',()=>{
 const base={type:'desktop_secret',sub:'set',name:'owned',value:'synthetic credential'}
 expect(desktopSecretActionError(base)).toBeUndefined()
 for(const fields of [{name:null},{value:null},{value:''},{gate:'invalid'},{targets:[42]},{targets:[]},{targets:['']},{targets:['browser:x.invalid,']},{reuseSeconds:1.5},{reuseSeconds:-1},{reuseSeconds:86401},{stdin:true},{stdin:false},{forSeconds:60},{extra:true}])expect(desktopSecretActionError({...base,...fields})).toBeString()
 for(const sub of ['status','list','register','rm','unlock','lock','reveal'])expect(desktopSecretActionError({...base,sub})).toBeString()
 expect(desktopSecretActionError({type:'desktop_secret',sub:'unlock',name:'owned',forSeconds:60})).toBeUndefined()
 expect(desktopSecretActionError({type:'desktop_secret',sub:'unlock',name:'owned',forSeconds:0})).toBeString()
 expect(desktopSecretActionError({type:'desktop_secret',sub:'register',name:'owned',gate:'touchid',targets:['browser:x.invalid']})).toBeUndefined()
 expect(desktopSecretActionError({type:'desktop_secret',sub:'set',name:'owned',stdin:true},'cli')).toBeUndefined()
 expect(desktopSecretActionError(base,'cli')).toBeString()
})

test('neutral secret MCP tiers preserve the operator-controlled vault boundary',()=>{
 expect(classify('desktop','secret',['status']).tier).toBe('read')
 expect(classify('desktop','secret',['list']).tier).toBe('read')
 expect(classify('desktop','secret',['set','owned','--stdin']).tier).toBe('mutate')
 expect(classify('desktop','secret',['rm','owned']).tier).toBe('destructive')
 expect(classify('desktop','secret',['reveal','owned']).tier).toBe('exec')
 expect(classify('desktop','secret',['unknown']).tier).toBe('destructive')
})

test('neutral vault authentication retains its deadline and does not probe a browser on timeout',()=>{
 expect(pickTimeoutForAction({type:'desktop_secret',sub:'register'})).toBe(pickTimeoutForAction({type:'macos_secret',sub:'register'}))
 expect(isGenericBrowserAction('desktop_secret')).toBe(false)
 expect(isGenericBrowserAction('read')).toBe(true)
 expect(timeoutMessage('desktop_secret',620000)).toContain('outcome is unknown')
 expect(timeoutMessage('desktop_secret',620000)).not.toContain('Chrome')
})
