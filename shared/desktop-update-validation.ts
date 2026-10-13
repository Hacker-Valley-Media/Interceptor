import {desktopContractShapeError} from './desktop-contract-validation'
export function desktopUpdateActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_update')return
  const shape=desktopContractShapeError(a,'DesktopUpdateAction');if(shape)return shape
  if(['group','groupColor'].some(k=>a[k]!==undefined&&(typeof a[k]!=='string'||!String(a[k]).trim()||Buffer.byteLength(String(a[k]))>256||String(a[k]).includes('\0'))))return 'invalid update group metadata'
}
// HTTPS, or plain HTTP to a loopback or private lab feed (INTERCEPTOR_UPDATE_FEED); the provider
// applies the same rule before it downloads (interceptor-desktop/src/update.rs `allowed`).
const labHost=(host:string)=>host==='localhost'||host==='[::1]'||/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
// Only bytes that passed the signed digest (and Authenticode on Windows) may be called verified.
const VERIFIED_PHASES=new Set(['downloaded','ready_to_install','installing'])
export function desktopUpdateResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_update')return
  const shape=desktopContractShapeError(data,'DesktopUpdateData');if(shape)return shape
  const row=data as Record<string,unknown>
  for(const [key,value]of Object.entries(row))if(typeof value==='string'&&(!value.trim()||Buffer.byteLength(value)>4096||value.includes('\0')))return 'invalid bounded update '+key
  for(const key of ['checkInterval','sessionAgeSeconds'])if(row[key]!==undefined&&(typeof row[key]!=='number'||!Number.isFinite(row[key])||Number(row[key])<0))return 'invalid update timing'
  for(const key of ['checkStartedAt','updatedAt','cycleFinishedAt','lastCheck','nextCheckAt','lastInstallAt'])if(row[key]!==undefined&&!Number.isFinite(Date.parse(String(row[key]))))return 'invalid update timestamp'
  if(row.sessionInProgress===true&&row.concluded===true||row.outcome==='error'&&row.lastError===undefined||row.outcome==='update_available'&&row.selectedVersion===undefined)return 'update state omits its observed outcome'
  if(row.lastInstallOutcome!==undefined&&!['installed','failed'].includes(String(row.lastInstallOutcome)))return 'invalid update install outcome'
  if(row.artifactURL!==undefined){
    let url:URL;try{url=new URL(String(row.artifactURL))}catch{return 'invalid update artifact URL'}
    const asset=/^Interceptor-Full-(\d+\.\d+\.\d+)-(windows|linux)-(arm64|x64)\.(exe|tar\.gz)$/.exec(String(row.artifactName))
    const transport=url.protocol==='https:'||url.protocol==='http:'&&labHost(url.hostname)
    if(!transport||url.username||url.password||url.search||url.hash||!asset||asset[1]!==row.selectedVersion||(asset[2]==='windows'?asset[4]!=='exe':asset[4]!=='tar.gz')||!url.pathname.endsWith('/'+row.artifactName))return 'invalid update artifact identity'
    if(row.signatureVerified===true&&!VERIFIED_PHASES.has(String(row.phase)))return 'release metadata cannot establish artifact signature verification'
  }else if(row.signatureVerified===true)return 'signature verification needs a downloaded artifact'
  if(Buffer.byteLength(JSON.stringify(data))>16384)return 'update result exceeds its bound'
}
