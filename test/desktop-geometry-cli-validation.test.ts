import {expect, test} from "bun:test"
import {parseMacosCommand} from "../cli/commands/macos"

test("neutral geometry retains zero flags and signed positions without changing legacy defaults", () => {
  const command = ["macos", "move", "e1", "40", "50", "--x", "0", "--y", "0"]
  expect(parseMacosCommand(command, undefined, true)).toMatchObject({x:0,y:0})
  expect(parseMacosCommand(command)).toMatchObject({x:40,y:50})
  expect(parseMacosCommand(["macos","move","e1","-30","0"],undefined,true)).toMatchObject({x:-30,y:0})
  expect(parseMacosCommand(["macos","move","e1"],undefined,true)).toMatchObject({x:0,y:0})
  expect(parseMacosCommand(["macos","resize","e1","--width","0","--height","480"],undefined,true)).toMatchObject({width:0,height:480})
})

test("neutral geometry rejects malformed integer flags, positionals and selectors before transport", () => {
  for (const verb of ["move","resize"]) {
    const flags = verb === "move" ? ["--x","--y"] : ["--width","--height"]
    for (const flag of [...flags,"--pid"]) {
      for (const value of ["1.5","1junk","true","9007199254740992","--app"]) {
        expect(() => parseMacosCommand(["macos",verb,"e1",flag,value],undefined,true)).toThrow()
      }
      expect(() => parseMacosCommand(["macos",verb,"e1",flag],undefined,true)).toThrow()
    }
    for(const value of ["1.5","1junk","true","9007199254740992"]) {
      expect(() => parseMacosCommand(["macos",verb,"e1",value,"2"],undefined,true)).toThrow()
    }
    expect(() => parseMacosCommand(["macos",verb,"e1","1","2","3"],undefined,true)).toThrow()
    expect(() => parseMacosCommand(["macos",verb,"e1","--app"],undefined,true)).toThrow()
    expect(() => parseMacosCommand(["macos",verb,"e1","--app","--pid","42"],undefined,true)).toThrow()
  }
})
