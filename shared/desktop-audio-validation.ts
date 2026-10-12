import {isAbsolute,win32} from 'node:path'
import {desktopContractShapeError} from './desktop-contract-validation'
import type {DesktopContractSchema} from './desktop-contract.generated'

const text=(v:unknown,cap=4096):v is string=>typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=cap&&!v.includes('\0')
const path=(v:unknown)=>text(v,32768)&&(isAbsolute(v)||win32.isAbsolute(v))
const integer=(v:unknown,min:number,max:number)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max
const rate=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=1_000_000
export function desktopAudioActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_audio')return
  const shape=desktopContractShapeError(a,'DesktopAudioAction');if(shape)return shape
  for(const [key,cap]of[['app',4096],['device',4096],['group',256],['groupColor',256]] as const)if(a[key]!==undefined&&!text(a[key],cap))return 'invalid audio target or group text'
  if(a.op!=='start'&&(a.app!==undefined||a.device!==undefined||a.save===true)||a.sub==='input'&&a.app!==undefined)return 'audio target and save options require the appropriate start channel'
}
export function desktopAudioResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_audio')return
  const shape=(value:unknown,schema:DesktopContractSchema)=>desktopContractShapeError(value,schema)
  const rows=(value:unknown,role:string):string|undefined=>{
    const error=shape(value,'DesktopAudioDevice[]' as DesktopContractSchema);if(error)return error
    const list=value as Record<string,unknown>[];const ids=new Set<unknown>()
    if(list.length>512)return 'audio device inventory exceeds 512 entries'
    for(const row of list){
      if(!text(row.uniqueID)||ids.has(row.uniqueID)||!text(row.localizedName)||!text(row.deviceType)||row.role!==role||!integer(row.channels,1,64)||row.sampleRate!==null&&!rate(row.sampleRate)||typeof row.deviceID==='number'&&!integer(row.deviceID,1,0xffffffff)||typeof row.deviceID==='string'&&!text(row.deviceID)||row.manufacturer!==null&&!text(row.manufacturer)||row.modelID!==null&&!text(row.modelID))return 'invalid native audio device identity or format'
      ids.add(row.uniqueID)
    }
    if(list.filter(row=>row.isDefault===true).length>1)return 'audio devices contain multiple native defaults'
  }
  const level=(value:unknown):string|undefined=>{
    const error=shape(value,'DesktopAudioLevel');if(error)return error
    const row=value as Record<string,unknown>
    if(!integer(row.frames,0,262144)||row.channels!==undefined&&!integer(row.channels,1,64)||row.sampleRate!==undefined&&!rate(row.sampleRate)||row.timestamp!==undefined&&(typeof row.timestamp!=='number'||row.timestamp<=0)||row.filePath!==undefined&&!path(row.filePath)||row.error!==undefined&&!text(row.error))return 'invalid native audio level metadata'
    if(row.frames===0&&(row.level!==null||row.peak!==null)||row.frames!==0&&(typeof row.level!=='number'||row.level<0||typeof row.peak!=='number'||row.peak+Math.max(1,Math.abs(row.peak))*1e-12<row.level||row.channels===undefined||row.sampleRate===undefined||row.timestamp===undefined)||Number(row.frames)*Number(row.channels??1)>1_048_576)return 'audio levels are not consistent with real PCM frame metadata'
  }
  if(a.op==='level'){
    if(a.sub!=='both')return level(data)
    const error=shape(data,'DesktopAudioBothLevel');if(error)return error
    const row=data as Record<string,unknown>;return level(row.input)??level(row.output)
  }
  if(a.op==='devices'){
    if(a.sub==='output')return rows(data,'output')
    if(a.sub==='both'){
      const error=shape(data,'DesktopAudioBothDevices');if(error)return error
      const row=data as Record<string,unknown>;return rows(row.input,'input')??rows(row.output,'output')
    }
    const error=shape(data,'DesktopAudioInputDevices');if(error)return error
    const row=data as Record<string,unknown>,devices=row.devices as Record<string,unknown>[]
    const invalid=rows(devices,'input');if(invalid)return invalid
    const selected=devices.find(device=>device.isDefault===true)
    const native=row.defaultInput as Record<string,unknown>|null
    if(row.count!==devices.length||(selected?(native===null||native.channels!==selected.channels||native.sampleRate!==selected.sampleRate):native!==null))return 'default audio input differs from the enumerated native device'
    return
  }
  if(a.sub==='both'){
    if(a.op==='stop')return data==='stopped both'?undefined:'invalid both-channel stop acknowledgement'
    const error=shape(data,'DesktopAudioBothStarted');if(error)return error
    const row=data as Record<string,unknown>
    if(row.input!=='started'||row.output!=='started'||a.save===true&&(!path(row.inputFilePath)||!path(row.outputFilePath))||a.save!==true&&(row.inputFilePath!==undefined||row.outputFilePath!==undefined))return 'invalid both-channel start or saved-file receipt'
    return
  }
  // Only an output start may answer with a bare string; an input start always reports its format.
  if(typeof data==='string')return data===(a.op==='stop'?`no active ${a.sub} capture`:a.sub==='output'?'audio output capture started':undefined)&&a.save!==true?undefined:'invalid audio acknowledgement'
  const error=shape(data,'DesktopAudioStarted');if(error)return error
  const row=data as Record<string,unknown>
  if(a.op==='start'&&a.sub==='input'){
    if(!integer(row.channels,1,64)||!integer(row.sampleRate,1,1_000_000)||row.message!==`audio input capture started (${row.sampleRate}Hz)`)return 'invalid input capture format or start receipt'
  }else if(row.message!==`audio ${a.sub} capture ${a.op==='stop'?'stopped':'started'}`||row.channels!==undefined||row.sampleRate!==undefined)return 'invalid audio start/stop receipt'
  if(row.filePath!==undefined&&!path(row.filePath)||a.op==='start'&&(a.save===true)!==(row.filePath!==undefined))return 'audio saved-file receipt differs from its request'
}
