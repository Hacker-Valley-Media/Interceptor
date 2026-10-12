import {test,expect} from "bun:test"
import {parseMacosCommand} from "../cli/commands/macos"
import {desktopContractShapeError} from "../shared/desktop-contract-validation"
import {desktopCompoundResultError} from "../shared/desktop-compound-validation"

test("compound parsing preserves empty text and ownership flags without treating flags as text",()=>{
  expect(parseMacosCommand(["macos","act","e1","--pid","2"],undefined,true)).toEqual({type:"macos_act",ref:"e1",text:undefined,app:undefined,pid:2})
  expect(parseMacosCommand(["macos","act","e1","","--app","fixture"],undefined,true)).toMatchObject({type:"macos_act",ref:"e1",text:"",app:"fixture"})
  expect(parseMacosCommand(["macos","read","--pid","2"],undefined,true)).toMatchObject({type:"macos_read",pid:2,filter:"interactive",depth:10})
  expect(parseMacosCommand(["macos","inspect","--pid","2"],undefined,true)).toMatchObject({type:"macos_inspect_app",pid:2})
  expect(parseMacosCommand(["macos","inspect","--pid","2","e1"],undefined,true)).toMatchObject({type:"macos_inspect",ref:"e1",pid:2})
  for(const args of [["act"],["act","e1","a","b"],["act","e1","--pid"],["act","e1","--pid","1x"],["read","unexpected"],["read","--depth","1.5"],["read","--pid","1","--pid","2"],["inspect","--unknown","2"]])expect(()=>parseMacosCommand(["macos",...args],undefined,true)).toThrow()
  expect(parseMacosCommand(["macos","act","e1","--pid","2"])).toMatchObject({type:"macos_compound",sub:"act",text:"--pid",pid:2})
})

test("compound reply validation checks request identity, action kind and explicit unknown metadata",()=>{
  const read={tree:"fixture",app:"fixture",pid:2}
  expect(desktopContractShapeError(read,"DesktopCompoundReadData")).toBeUndefined()
  expect(desktopCompoundResultError({type:"desktop_read",pid:2},read)).toBeUndefined()
  for(const data of [{...read,pid:3},{...read,pid:0},{...read,pid:1.5}])expect(desktopCompoundResultError({type:"desktop_read",pid:2},data)).toBeDefined()
  const act={action:"typed",ref:"e1",tree:"fixture"}
  expect(desktopCompoundResultError({type:"desktop_act",ref:"e1",text:""},act)).toBeUndefined()
  expect(desktopCompoundResultError({type:"desktop_act",ref:"e2",text:""},act)).toBeDefined()
  expect(desktopCompoundResultError({type:"desktop_act",ref:"e1"},act)).toBeDefined()
  expect(desktopContractShapeError({...act,action:"unknown"},"DesktopCompoundActData")).toBeDefined()
  const app={name:"fixture",pid:2,unknownFields:["bundleId","isActive","isHidden"]},inspect={tree:"fixture",apps:[app],target:app,frontmost:app}
  expect(desktopContractShapeError(inspect,"DesktopCompoundInspectData")).toBeUndefined()
  expect(desktopCompoundResultError({type:"desktop_inspect_app",pid:2},inspect)).toBeUndefined()
  expect(desktopCompoundResultError({type:"desktop_inspect_app",pid:2},{...inspect,apps:[app,app]})).toBeDefined()
  expect(desktopCompoundResultError({type:"desktop_inspect_app"},{...inspect,target:{...app,bundleId:"invented"}})).toBeDefined()
})

test("neutral open keeps launch and target flags distinct and retains legacy parsing",()=>{
  expect(parseMacosCommand(["macos","open","--pid","2"],undefined,true)).toMatchObject({type:"macos_open",pid:2,app:undefined,activate:false})
  expect(parseMacosCommand(["macos","open","fixture","--activate","--depth","3"],undefined,true)).toMatchObject({type:"macos_open",app:"fixture",activate:true,depth:3})
  expect(parseMacosCommand(["macos","open","--app","fixture"],undefined,true)).toMatchObject({type:"macos_open",app:"fixture"})
  for(const args of [["fixture","extra"],["fixture","--app","other"],["--activate","--activate"],["--app"],["--pid","2x"],["--depth","1.5"],["--other"],["--app","a","--app","b"]])expect(()=>parseMacosCommand(["macos","open",...args],undefined,true)).toThrow()
  expect(parseMacosCommand(["macos","open","fixture"])).toMatchObject({type:"macos_compound",sub:"open",app:"fixture"})
})

test("open reply verifies process, window IDs, references and observed frames",()=>{
  const window={title:"fixture",windowId:"42",ref:"e1",frame:{x:-10,y:20,width:400,height:200}}
  const data={tree:"fixture",app:"fixture",pid:2,windows:[window]}
  expect(desktopContractShapeError(data,"DesktopCompoundOpenData")).toBeUndefined()
  expect(desktopCompoundResultError({type:"desktop_open",pid:2},data)).toBeUndefined()
  expect(desktopCompoundResultError({type:"desktop_open",pid:3},data)).toBeDefined()
  expect(desktopContractShapeError({...data,windows:[{...window,frame:{...window.frame,extra:1}}]},"DesktopCompoundOpenData")).toBeDefined()
  for(const windows of [[window,window],[{...window,windowId:"0"}],[{...window,windowId:"18446744073709551616"}],[{...window,ref:"bad"}],[{...window,frame:{...window.frame,width:-1}}],[{...window,referenceError:"unavailable",referenceErrorCode:"unsupported_target"}]])expect(desktopCompoundResultError({type:"desktop_open"},{...data,windows})).toBeDefined()
  expect(desktopContractShapeError({...data,windows:[{title:"unavailable",referenceError:"no UIA reference",referenceErrorCode:"unsupported_target"}]},"DesktopCompoundOpenData")).toBeUndefined()
})
