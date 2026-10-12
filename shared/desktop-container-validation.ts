import {isAbsolute,win32} from 'node:path'
import {DESKTOP_CONTAINER_MAX_OUTPUT_BYTES,DESKTOP_CONTAINER_MAX_TIMEOUT_MS,DESKTOP_CONTAINER_CLEANUP_MS} from './desktop-contract'
import {desktopContractShapeError} from './desktop-contract-validation'

export function desktopContainerActionError(action:Record<string,unknown>):string|undefined{
  if(action.type!=='desktop_container_run')return
  const shape=desktopContractShapeError(action,'DesktopContainerRunAction');if(shape)return shape
  const text=(value:unknown,cap:number,empty=true)=>typeof value==='string'&&(empty||value.length>0)&&!value.includes('\0')&&Buffer.byteLength(value)<=cap
  if(!text(action.image,1024,false)||!/^[A-Za-z0-9][^\s]*$/.test(String(action.image)))return 'container image requires 1..1024 bytes without whitespace or leading options'
  if(!Array.isArray(action.command)||action.command.length<1||action.command.length>128||!action.command.every(v=>text(v,32768))||action.command[0]==='')return 'container requires 1..128 exact command arguments with a nonempty executable'
  const env=action.env as Record<string,string>|undefined
  if(env&&(Object.keys(env).length>64||Object.entries(env).some(([key,value])=>!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)||!text(value,32768))))return 'container env requires at most 64 identifier keys and bounded values'
  const mounts=action.mounts as {hostPath:string;mountPath:string;mode:string}[]|undefined
  if(mounts&&(mounts.length>16||mounts.some(m=>!text(m.hostPath,32768,false)||!(process.platform==='win32'?win32.isAbsolute(m.hostPath)&&!m.hostPath.startsWith('\\'):isAbsolute(m.hostPath))||m.hostPath.includes(',')||!text(m.mountPath,32768,false)||!m.mountPath.startsWith('/')||m.mountPath.includes(',')||m.mountPath.split('/').includes('..'))))return 'container mounts require at most 16 absolute host and guest paths without comma or guest traversal'
  for(const [key,cap]of [['timeoutMs',DESKTOP_CONTAINER_MAX_TIMEOUT_MS],['maxOutputBytes',DESKTOP_CONTAINER_MAX_OUTPUT_BYTES]]as const){if(action[key]!==undefined&&(!Number.isSafeInteger(action[key])||Number(action[key])<1||Number(action[key])>cap))return `container ${key} requires an integer 1..${cap}`}
}

export function desktopContainerDeadline(action:Record<string,unknown>):number{
  return Number(action.timeoutMs??60000)+DESKTOP_CONTAINER_CLEANUP_MS+2000
}

export function desktopContainerResultError(action:Record<string,unknown>,data:unknown):string|undefined{
  if(action.type!=='desktop_container_run')return
  const shape=desktopContractShapeError(data,'DesktopContainerRunData');if(shape)return shape
  const r=data as Record<string,unknown>
  if(r.image!==action.image||JSON.stringify(r.command)!==JSON.stringify(action.command)||r.network!==(action.network??'off'))return 'container result differs from its request'
  if(!Number.isSafeInteger(r.exitCode)||Number(r.exitCode)<-1||Number(r.exitCode)>2147483647||!Number.isSafeInteger(r.durationMs)||Number(r.durationMs)<0||Number(r.durationMs)>desktopContainerDeadline(action))return 'container exit or duration exceeds its bounds'
  if(!r.provider||!r.engineVersion||!r.engineHost||Buffer.byteLength(String(r.engineHost))>256||String(r.engineHost).includes('\0')||Buffer.byteLength(String(r.engineVersion))>128||Buffer.byteLength(String(r.stdout))+Buffer.byteLength(String(r.stderr))>Number(action.maxOutputBytes??DESKTOP_CONTAINER_MAX_OUTPUT_BYTES))return 'container provenance or output exceeds its bounds'
}
