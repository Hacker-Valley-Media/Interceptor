import {desktopContractShapeError} from './desktop-contract-validation'

export function desktopTrustActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_trust')return
  const shape=desktopContractShapeError(a,'DesktopTrustAction');if(shape)return shape
  for(const key of ['group','groupColor'])if(a[key]!==undefined&&(typeof a[key]!=='string'||!a[key].trim()||Buffer.byteLength(a[key])>256||a[key].includes('\0')))return 'invalid trust group text'
}
export function desktopTrustResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_trust')return
  const shape=desktopContractShapeError(data,'DesktopTrustData');if(shape)return shape
  const row=data as Record<string,unknown>,permissions=row.permissions as Record<string,unknown>[]
  if(permissions.length!==4||!row.bundlePath||!row.displayName)return 'trust requires four native permission diagnostics and provider identity'
  const fields=[['Accessibility','accessibility'],['Microphone','microphone'],['Screen Recording','screenRecording'],['Speech Recognition','speechRecognition']]
  for(const [name,key] of fields){const matching=permissions.filter(p=>p.name===name);if(matching.length!==1||matching[0].status!==row[key]||matching[0].granted!==(matching[0].status==='granted')||typeof matching[0].reason!=='string'||!matching[0].reason)return 'trust permission identity or grant contradicts its status'}
  for(const p of permissions)for(const key of ['path','reason','limitation','nativeStatus'])if(p[key]!==undefined&&(typeof p[key]!=='string'||Buffer.byteLength(p[key])>8192||p[key].includes('\0')))return 'invalid bounded trust permission detail'
  for(const key of ['bundlePath','displayName'])if(typeof row[key]!=='string'||Buffer.byteLength(row[key])>32768||row[key].includes('\0'))return 'invalid bounded trust provider identity'
  for(const key of ['warnings','action_required','prompted','opened','pending_user_action'])if(Array.isArray(row[key])&&(row[key].length>16||row[key].some(v=>typeof v!=='string'||!v||Buffer.byteLength(v)>8192||v.includes('\0'))))return 'invalid trust diagnostic list'
  if(a.noPrompt===true&&['prompted','opened','pending_user_action'].some(key=>Array.isArray(row[key])&&row[key].length))return 'read-only trust reported a permission mutation'
  if(Buffer.byteLength(JSON.stringify(data))>65536)return 'trust diagnostic exceeds 64KiB'
}
