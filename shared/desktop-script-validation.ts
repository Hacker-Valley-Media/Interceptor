import {desktopContractShapeError} from './desktop-contract-validation'
import {isDeepStrictEqual} from 'node:util'
const operations=['desktop_script_run','desktop_intent_dispatch']
const all=['env','fs','shell','sqlite']
export function desktopScriptCapabilities(value:unknown):string[]|undefined{
  if(value===undefined)return []
  if(typeof value!=='string'||Buffer.byteLength(value)>256)return
  const text=value.trim().toLowerCase()
  if(['none','false'].includes(text))return []
  if(['all','true','native','unsafe'].includes(text))return [...all]
  const values=text.split(/[,\s]+/).filter(Boolean)
  if(!values.length||values.some(value=>!all.includes(value)))return
  return [...new Set(values)].sort()
}
export function desktopScriptActionError(a:Record<string,unknown>):string|undefined{
  if(!operations.includes(String(a.type)))return
  const shape=desktopContractShapeError(a,a.type==='desktop_script_run'?'DesktopScriptRunAction':'DesktopScriptIntentAction');if(shape)return shape
  const valid=(value:unknown,cap:number)=>typeof value==='string'&&!value.includes('\0')&&Buffer.byteLength(value)<=cap
  if(!valid(a.jsc,65536)||!a.jsc)return 'script requires 1..65536 UTF8 bytes without NUL'
  if(a.args!==undefined&&(!Array.isArray(a.args)||a.args.length>128||a.args.some(value=>!valid(value,32768))||Buffer.byteLength(JSON.stringify(a.args))>65536))return 'script arguments exceed their exact string bounds'
  if(desktopScriptCapabilities(a.jscHost)===undefined)return 'portable script host capabilities are env, fs, shell and sqlite; OSA requires macOS'
  if(['group','groupColor'].some(key=>a[key]!==undefined&&(!valid(a[key],256)||!a[key])))return 'invalid native request group metadata'
}
export function desktopScriptResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(!operations.includes(String(a.type)))return
  if(!data||typeof data!=='object'||Array.isArray(data))return 'script result requires an object'
  const r=data as Record<string,unknown>
  if(Object.keys(r).some(key=>!['result','raw','script','language','engine','arguments','host'].includes(key))||!Object.hasOwn(r,'result')||typeof r.raw!=='string'||r.script!==a.jsc||r.language!=='JavaScript'||r.engine!=='QuickJS')return 'script result fields, source or runtime differ from the request'
  if((a.args!==undefined)!==Object.hasOwn(r,'arguments')||a.args!==undefined&&JSON.stringify(r.arguments)!==JSON.stringify(a.args))return 'script result arguments differ from the request'
  const caps=desktopScriptCapabilities(a.jscHost)
  if(!caps)return 'script result has invalid requested host capabilities'
  if(caps.length){const host=r.host as Record<string,unknown>|undefined;if(!host||typeof host!=='object'||Array.isArray(host)||Object.keys(host).length!==1||JSON.stringify(host.capabilities)!==JSON.stringify(caps))return 'script host capabilities differ from the request'}else if(r.host!==undefined)return 'script returned a host that was not enabled'
  let budget=4096
  const json=(value:unknown,depth=0):boolean=>{
    if(--budget<0||depth>32)return false
    if(value===null||typeof value==='string'||typeof value==='boolean')return true
    if(typeof value==='number')return Number.isFinite(value)
    if(Array.isArray(value))return value.every(child=>json(child,depth+1))
    return !!value&&typeof value==='object'&&Object.values(value).every(child=>json(child,depth+1))
  }
  if(!json(r.result)||Buffer.byteLength(JSON.stringify(r))>1048576)return 'script result exceeds its JSON, depth or byte bounds'
  if(r.result!==null&&!(typeof r.result==='string'&&r.raw===r.result)){try{if(!isDeepStrictEqual(JSON.parse(r.raw),r.result))return 'script raw value differs from the JSON result'}catch{return 'script raw value is not JSON'}}
}
