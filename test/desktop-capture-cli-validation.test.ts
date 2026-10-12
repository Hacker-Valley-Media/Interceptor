import {test,expect} from 'bun:test'
import {parseMacosCommand} from '../cli/commands/macos'
import {desktopContractShapeError} from '../shared/desktop-contract-validation'
import {DESKTOP_CAPTURE_DATA_SCHEMAS} from '../shared/desktop-contract.generated'
test('capture CLI retains zero/defaults and rejects numeric or missing target arguments before delivery',()=>{
  expect(parseMacosCommand(['macos','screenshot','--quality','0','--target-max-long-edge','0'],undefined,true)).toMatchObject({quality:0,target_max_long_edge:0,format:'jpeg',save:false})
  expect(parseMacosCommand(['macos','screenshot','--quality','0'])).toMatchObject({quality:80})
  expect(parseMacosCommand(['macos','capture'],undefined,true)).toMatchObject({sub:'frame'})
  expect(parseMacosCommand(['macos','capture','frame','--timeout-ms','0'],undefined,true)).toMatchObject({timeoutMs:0})
  for(const [verb,flags]of [['screenshot',['--window','--display','--quality','--target-max-long-edge']],['capture',['--timeout-ms']]] as const){
    for(const flag of flags)for(const value of ['1.5','1x','NaN','Infinity','9007199254740992',''])expect(()=>parseMacosCommand(['macos',verb,flag,...(value?[value]:[])],undefined,true)).toThrow()
  }
  for(const flag of ['--app','--format','--element','--mode'])expect(()=>parseMacosCommand(['macos','screenshot',flag],undefined,true)).toThrow()
  expect(()=>parseMacosCommand(['macos','capture','start','--app'],undefined,true)).toThrow()
})
test('generated capture result selectors retain the existing primitive and object payloads',()=>{
  expect(DESKTOP_CAPTURE_DATA_SCHEMAS).toEqual({start:'DesktopCaptureStartAck',stop:'DesktopCaptureStopAck',frame:'DesktopCaptureFrameData',status:'DesktopCaptureStatusData'})
  expect(desktopContractShapeError('continuous capture started','DesktopCaptureStartAck')).toBeUndefined()
  expect(desktopContractShapeError('ok','DesktopCaptureStartAck')).toBeDefined()
  expect(desktopContractShapeError({active:false,hasFrame:false},'DesktopCaptureStatusData')).toBeUndefined()
  expect(desktopContractShapeError({active:true,hasFrame:true,frameAgeMs:'old'},'DesktopCaptureStatusData')).toBeDefined()
  expect(desktopContractShapeError({format:'jpeg',bytes:12,width:10,height:10,dataUrl:'data:image/jpeg;base64,fixture'},'DesktopCaptureFrameData')).toBeUndefined()
  expect(desktopContractShapeError({format:'png',bytes:12,width:10,height:10,dataUrl:'fixture'},'DesktopCaptureFrameData')).toBeDefined()
})
