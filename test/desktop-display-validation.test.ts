import {test,expect} from "bun:test"
import {parseMacosCommand} from "../cli/commands/macos"
import {desktopContractShapeError} from "../shared/desktop-contract-validation"
import {desktopDisplayResultError} from "../shared/desktop-display-validation"

test("neutral display reads have strict IDs and preserve legacy display arguments",()=>{
  expect(parseMacosCommand(["macos","display"],undefined,true)).toEqual({type:"macos_display_list"})
  expect(parseMacosCommand(["macos","display","list"],undefined,true)).toEqual({type:"macos_display_list"})
  for(const args of [["info","1"],["info","--id","1"]])expect(parseMacosCommand(["macos","display",...args],undefined,true)).toEqual({type:"macos_display_info",id:1})
  for(const value of ["0","-1","1.2","1x","1e0","NaN","9007199254740992"]){expect(()=>parseMacosCommand(["macos","display","info",value],undefined,true)).toThrow()}
  for(const args of [["info"],["info","--id"],["info","1","2"],["list","--id","1"],["info","--id","1","--id","2"]])expect(()=>parseMacosCommand(["macos","display",...args],undefined,true)).toThrow()
  expect(parseMacosCommand(["macos","display","info","1"])).toMatchObject({type:"macos_display",sub:"info",id:"1",resolution:"1",hidpi:false})
})

test("display replies reject stale IDs, impossible geometry and invented metadata",()=>{
  const list={id:1,width:640,height:480,x:-640,y:0,isMain:true,isVirtual:false,unknownFields:["isBuiltin"]}
  const info={id:1,width:640,height:480,pixelWidth:640,pixelHeight:480,isMain:true,unknownFields:["isBuiltin","rotation","refreshRate"]}
  const action={type:"desktop_display_info",id:1}
  expect(desktopContractShapeError([list],"DesktopDisplayEntry[]")).toBeUndefined()
  expect(desktopDisplayResultError({type:"desktop_display_list"},[list])).toBeUndefined()
  expect(desktopContractShapeError(info,"DesktopDisplayInfoData")).toBeUndefined()
  expect(desktopDisplayResultError(action,info)).toBeUndefined()
  for(const row of [{...info,id:2},{...info,width:0},{...info,pixelHeight:0},{...info,id:1.5},{...info,isBuiltin:false},{...info,rotation:45,unknownFields:["isBuiltin","refreshRate"]},{...info,refreshRate:-1,unknownFields:["isBuiltin","rotation"]},{...info,unknownFields:["isBuiltin","isBuiltin"]},{...info,unknownFields:["invented"]}])expect(desktopDisplayResultError(action,row)).toBeDefined()
  expect(desktopDisplayResultError({type:"desktop_display_list"},[list,list])).toBeDefined()
  expect(desktopDisplayResultError({type:"desktop_display_list"},[{...list,x:1.5}])).toBeDefined()
  expect(desktopContractShapeError({...info,id:"1"},"DesktopDisplayInfoData")).toBeDefined()
})
