import type {DesktopAxProcessIdentity} from './desktop-contract'
import {desktopContractShapeError} from './desktop-contract-validation'

/** Exact executable policies, rather than display names or numeric PIDs. */
export function nativeSecretExecutable(host:'windows'|'linux',path:unknown):string {
  if(typeof path!=='string'||!path||Buffer.byteLength(path)>4096||/[\0\r\n*?]/.test(path))throw new Error('native secret target requires a bounded absolute executable path')
  const normalized=host==='windows'?path.replaceAll('/','\\').toLowerCase():path
  const parts=normalized.split(host==='windows'?'\\':'/')
  if(parts.some(part=>part==='.'||part==='..')||!parts.at(-1))throw new Error('native secret target requires a canonical executable path')
  if(host==='windows'?!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/.test(normalized):!normalized.startsWith('/'))throw new Error('native secret target requires an absolute executable path')
  return normalized
}

export function nativeSecretIdentity(value:unknown,host:'windows'|'linux'):DesktopAxProcessIdentity {
  if(desktopContractShapeError(value,'DesktopAxProcessIdentity'))throw new Error('native target identity is unavailable')
  const identity=value as DesktopAxProcessIdentity
  if(identity.host!==host||!Number.isSafeInteger(identity.pid)||identity.pid<1||identity.pid>0x7fffffff)throw new Error('native target identity does not match the host')
  nativeSecretExecutable(host,identity.executable)
  for(const field of ['user','session','creation','image'] as const)if(!identity[field]||Buffer.byteLength(identity[field])>1024||/[\0\r\n]/.test(identity[field]))throw new Error('native target identity is incomplete')
  return identity
}

export function sameNativeSecretIdentity(first:DesktopAxProcessIdentity,second:DesktopAxProcessIdentity):boolean {
  return (['host','pid','executable','user','session','creation','image'] as const).every(field=>first[field]===second[field])
}
