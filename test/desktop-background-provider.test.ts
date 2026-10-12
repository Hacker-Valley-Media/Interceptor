import {expect,test} from 'bun:test'
import {callDesktopProvider} from '../daemon/desktop-provider'

test('portable background aliases reject incomplete targeting and foreground opt-out before native negotiation',async()=>{
  const frame={left:0,top:0,width:800,height:600}
  for(const prefix of ['macos','desktop'])for(const verb of ['click','type','keys','scroll','drag']){
    const action={type:`${prefix}_bginput_${verb}`,windowTitle:'Owned fixture',windowBounds:frame}
    for(const invalid of [{...action,windowTitle:undefined},{...action,windowBounds:undefined},{...action,backgroundOnly:false},{...action,windowBounds:{...frame,width:0}},{...action,windowBounds:{...frame,left:Infinity}}]){
      const result=await callDesktopProvider(invalid)
      expect(result).toMatchObject({success:false,code:'invalid_request'})
      expect(result.error).toContain('background window input requires')
    }
  }
})
