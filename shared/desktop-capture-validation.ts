import {DESKTOP_CAPTURE_MAX_PIXELS,DESKTOP_CAPTURE_DEFAULT_LONG_EDGE,DESKTOP_MAX_RESULT_BYTES} from './desktop-contract'
import {isAbsolute,win32} from 'node:path'

/** Native portal consent is part of Linux capture admission. Existing frame
 * reads and non-Linux providers retain their usual deadlines. */
export function desktopCaptureDeadline(action:Record<string,unknown>,platform:NodeJS.Platform=process.platform):number{
  if(platform!=='linux')return 0
  return action.type==='desktop_screenshot'||action.type==='desktop_capture'&&action.sub==='start'||action.type==='desktop_stream'&&action.op==='start'?58_000:0
}

/** Extra image/state invariants beyond the generated field types. Called only
 * after shape validation, before returning an untrusted native success. */
export function desktopCaptureResultError(action:Record<string,unknown>,data:unknown):string|undefined{
  if(action.type!=='desktop_screenshot'&&action.type!=='desktop_capture')return
  if(action.type==='desktop_capture'&&['start','stop'].includes(String(action.sub)))return
  const result=data as Record<string,unknown>
  if(action.type==='desktop_capture'&&action.sub==='status'){
    if(result.hasFrame===true&&result.active!==true)return 'capture frame exists without an active stream'
    if(result.hasFrame===true? !Number.isSafeInteger(result.frameAgeMs)||Number(result.frameAgeMs)<0 : result.frameAgeMs!==undefined)return 'capture frame age does not match its frame state'
    return
  }
  const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0
  if(!['width','height','bytes'].every(key=>positive(result[key]))||Number(result.width)*Number(result.height)>DESKTOP_CAPTURE_MAX_PIXELS||Number(result.bytes)>DESKTOP_MAX_RESULT_BYTES)return 'capture image dimensions/bytes exceed their bounds'
  if(action.type==='desktop_screenshot'){
    if(!positive(result.originalWidth)||!positive(result.originalHeight)||Number(result.originalWidth)*Number(result.originalHeight)>DESKTOP_CAPTURE_MAX_PIXELS||Number(result.width)>Number(result.originalWidth)||Number(result.height)>Number(result.originalHeight))return 'capture original dimensions do not bound its image'
    const edge=Number(action.target_max_long_edge??DESKTOP_CAPTURE_DEFAULT_LONG_EDGE)
    if(edge>0&&Math.max(Number(result.width),Number(result.height))>edge)return 'capture image exceeds its requested resize bound'
    if(result.format!==(action.format??'jpeg'))return 'capture result format does not match its request'
    if(action.save===true){
      if(typeof result.filePath!=='string'||!result.filePath||result.filePath.includes('\0')||!(process.platform==='win32'?win32.isAbsolute(result.filePath):isAbsolute(result.filePath))||result.dataUrl!==undefined)return 'screenshot result does not match its save selector'
      return
    }
    if(result.filePath!==undefined)return 'inline screenshot unexpectedly contains a saved path'
  }
  const mime=result.format==='jpeg'?'image/jpeg':result.format==='png'?'image/png':'image/webp'
  const prefix=`data:${mime};base64,`
  if(typeof result.dataUrl!=='string'||!result.dataUrl.startsWith(prefix))return 'capture image URI does not match its format'
  const encoded=result.dataUrl.slice(prefix.length),bytes=Buffer.from(encoded,'base64')
  if(bytes.length!==result.bytes||bytes.toString('base64')!==encoded)return 'capture image bytes do not match its metadata'
}
