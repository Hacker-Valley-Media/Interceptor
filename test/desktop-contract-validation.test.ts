import {expect,test} from 'bun:test'
import {desktopContractShapeError} from '../shared/desktop-contract-validation'
import {generateDesktopContract} from '../scripts/desktop-contract'
import {DESKTOP_MAX_FRAME_BYTES,DESKTOP_PROTOCOL_VERSION} from '../shared/desktop-contract'

const capability={operation:'tree',compiled:true,present:true,permission:'granted',session:'fixture',effective:true,background:'semantic',provider:'fixture',versions:{product:'1.0.25'},limits:[]}
const hello={protocolVersion:DESKTOP_PROTOCOL_VERSION,maxFrameBytes:DESKTOP_MAX_FRAME_BYTES,host:'darwin',provider:'fixture',version:'1.0.25',pid:123,session:'fixture',capabilities:[capability],accessibilityGranted:true}

test('generated common metadata accepts declared native fields and opaque domain data',()=>{
  expect(desktopContractShapeError(hello,'DesktopHello')).toBeUndefined()
  for(const data of [null,42,'text',[],{providerSpecific:{anything:[null,true,3]}}]) {
    expect(desktopContractShapeError({id:'request',result:{success:true,data}},'DesktopReply')).toBeUndefined()
  }
  expect(desktopContractShapeError({id:'request',result:{success:false,error:'AX failure',code:'permission_required',retryable:false,details:{nativeCode:'Accessibility',axError:{code:-25204}}}},'DesktopReply')).toBeUndefined()
})

test('missing, null, wrong-type, unknown and invalid-enum handshake fields fail closed',()=>{
  for(const key of Object.keys(hello).filter(k=>k!=='accessibilityGranted')) {
    const missing:Record<string,unknown>={...hello};delete missing[key]
    expect(desktopContractShapeError(missing,'DesktopHello')).toBeString()
    expect(desktopContractShapeError({...hello,[key]:null},'DesktopHello')).toBeString()
  }
  for(const fields of [{capabilities:'yes'},{pid:'123'},{host:'freebsd'},{protocolVersion:Infinity},{accessibilityGranted:'true'},{extra:true}]) {
    expect(desktopContractShapeError({...hello,...fields},'DesktopHello')).toBeString()
  }
  expect(desktopContractShapeError({...hello,capabilities:[{...capability,permission:'unknown'}]},'DesktopHello')).toBeUndefined()
  for(const fields of [{permission:'invalid-permission'},{background:'hid'},{compiled:'true'},{versions:{product:123}},{limits:[null]},{reason:null},{extra:true}]) {
    expect(desktopContractShapeError({...hello,capabilities:[{...capability,...fields}]},'DesktopHello')).toBeString()
  }
})

test('malformed reply envelopes and result metadata are rejected without interpreting domain data',()=>{
  const reply={id:'request',result:{success:true,data:'ok'}}
  for(const fields of [{id:42},{id:null},{result:null},{extra:true}])expect(desktopContractShapeError({...reply,...fields},'DesktopReply')).toBeString()
  for(const fields of [{success:'true'},{error:42},{code:'UNKNOWN'},{retryable:'false'},{details:[]},{remediation:null},{extra:true}]) {
    expect(desktopContractShapeError({...reply,result:{...reply.result,...fields}},'DesktopReply')).toBeString()
  }
  const long='🙂'.repeat(5000)
  const error=desktopContractShapeError({...hello,[long]:true},'DesktopHello')!
  expect(Buffer.byteLength(error)).toBeLessThanOrEqual(2048)
  expect(desktopContractShapeError({...hello,capabilities:Array(100_001).fill(capability)},'DesktopHello')).toContain('validation limit')
})

test('shared declaration edits change emitted common schemas and checked-in metadata is fresh',async()=>{
  const source=await Bun.file(new URL('../shared/desktop-contract.ts',import.meta.url)).text()
  const generated=generateDesktopContract(source)
  expect(generated.typescript).toBe(await Bun.file(new URL('../shared/desktop-contract.generated.ts',import.meta.url)).text())
  const changed=generateDesktopContract(source.replace('accessibilityGranted?: boolean','accessibilityGranted?: string'))
  expect(changed.typescript).not.toBe(generated.typescript)
  expect(changed.swift).not.toBe(generated.swift)
  expect(changed.rust).not.toBe(generated.rust)
})

test('recursive JSON schemas preserve nested values and reject non-JSON children and depth overflow',()=>{
  for(const value of [null,true,42,'value',[],{child:[null,{value:false},[3,'text']]}]){
    expect(desktopContractShapeError(value,'DesktopOverlayJSON')).toBeUndefined()
  }
  for(const child of [undefined,NaN,Infinity,1n,()=>true]){
    expect(desktopContractShapeError({child},'DesktopOverlayJSON')).toBeString()
  }
  let deep:unknown='leaf'
  for(let n=0;n<40;n++)deep={child:deep}
  expect(desktopContractShapeError(deep,'DesktopOverlayJSON')).toBeString()
  expect(desktopContractShapeError(['first','second'],'DesktopOverlayJSON[]')).toBeUndefined()
  expect(desktopContractShapeError(['first',undefined],'DesktopOverlayJSON[]')).toBeString()
})

test('contract generation canonicalizes recursive string index signatures without changing native wire keys',()=>{
  const prefix='export type DesktopOverlayJSON = string | number | boolean | null | '
  const suffix=' | DesktopOverlayJSON[]; export interface DesktopOverlayProbe { where: DesktopOverlayJSON }'
  const inline=generateDesktopContract(prefix+'{ [key: string]: DesktopOverlayJSON }'+suffix)
  const generic=generateDesktopContract(prefix+'Record<string, DesktopOverlayJSON>'+suffix)
  expect(inline).toEqual(generic)
  expect(inline.swift).toContain('indirect enum DesktopOverlayJSON: Codable')
  expect(inline.swift).toContain('let `where`: DesktopOverlayJSON')
  expect(inline.swift).toContain('self.`where` = try value.decode(DesktopOverlayJSON.self, forKey: .f0)')
  expect(inline.swift).toContain('case f0 = "where"')
  expect(inline.rust).toContain('pub r#where: DesktopOverlayJSON')
})

test('contract generation refuses unsupported index signatures and mixed object members',()=>{
  for(const member of [
    '{ [key: number]: string }',
    '{ readonly [key: string]: string }',
    '{ [key: string]: string; extra: string }',
    '{ [key: string, other: string]: string }',
    '{ [key: string] }',
  ])expect(()=>generateDesktopContract('export type DesktopOverlayJSON = string | '+member)).toThrow()
})
