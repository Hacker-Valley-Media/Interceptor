import {desktopContractShapeError} from './desktop-contract-validation'
import {DESKTOP_HTTP_INLINE_BYTES,DESKTOP_HTTP_MAX_RESPONSE_BYTES} from './desktop-contract'
import {isAbsolute} from 'node:path'

export function desktopHttpActionError(action:Record<string,unknown>):string|undefined{
  if(action.type!=='desktop_url_fetch')return
  const shape=desktopContractShapeError(action,'DesktopHttpFetchAction')
  if(shape)return shape
  let url:URL
  try{url=new URL(String(action.url))}catch{return 'HTTP requires an absolute HTTP(S) URL'}
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password||Buffer.byteLength(String(action.url))>16384)return 'HTTP requires a bounded absolute HTTP(S) URL without embedded credentials'
  if(action.method!==undefined&&!/^[A-Z-]{1,32}$/.test(String(action.method)))return 'HTTP method must be a bounded uppercase token'
  if(action.timeoutMs!==undefined&&(!Number.isInteger(action.timeoutMs)||Number(action.timeoutMs)<100||Number(action.timeoutMs)>120000))return 'HTTP timeoutMs must be an integer in 100..120000'
  if(action.body!==undefined&&Buffer.byteLength(String(action.body))>4194304)return 'HTTP request body exceeds 4 MiB'
  const headers=Object.entries(action.headers as Record<string,string>??{})
  if(headers.length>64||headers.reduce((sum,[key,value])=>sum+Buffer.byteLength(key)+Buffer.byteLength(value),0)>65536)return 'HTTP headers exceed their bounds'
  const names=new Set<string>()
  for(const [key,value]of headers){
    if(key.length>256||!/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(key)||Buffer.byteLength(value)>8192||/[\x00-\x08\x0a-\x1f\x7f]/.test(value)||names.has(key.toLowerCase()))return 'HTTP headers contain an invalid or duplicate name/value'
    names.add(key.toLowerCase())
  }
  return
}

export function desktopHttpResultError(action:Record<string,unknown>,data:unknown):string|undefined{
  if(action.type!=='desktop_url_fetch')return
  const shape=desktopContractShapeError(data,'DesktopHttpFetchData')
  if(shape)return shape
  const result=data as Record<string,any>,body=result.body as Record<string,any>
  const headers=Object.entries(result.headers as Record<string,string>)
  if(headers.length>128||headers.reduce((sum,[name,value])=>sum+Buffer.byteLength(name)+Buffer.byteLength(value),0)>65536||headers.some(([name,value])=>!/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(name)||/[\x00-\x08\x0a-\x1f\x7f]/.test(value)))return 'HTTP response headers exceed their bounds or contain invalid fields'
  if(!Number.isInteger(result.status)||result.status<100||result.status>599||!Number.isInteger(body.bytes)||body.bytes<0||body.bytes>DESKTOP_HTTP_MAX_RESPONSE_BYTES)return 'invalid HTTP response status or size'
  try{if(!['http:','https:'].includes(new URL(result.url).protocol))return 'invalid HTTP response URL'}catch{return 'invalid HTTP response URL'}
  const allowed=body.kind==='text'?['kind','bytes','text']:body.kind==='bytes'?['kind','bytes','base64']:['kind','bytes','preview','sidecarPath','artifactRef']
  if(Object.keys(body).some(key=>!allowed.includes(key))||allowed.some(key=>!(key in body)))return 'HTTP body fields do not match its kind'
  if(body.kind==='text'&&(Buffer.byteLength(body.text)!==body.bytes||body.bytes>DESKTOP_HTTP_INLINE_BYTES))return 'HTTP text byte count does not match its payload'
  if(body.kind==='bytes'){
    if(body.bytes>DESKTOP_HTTP_INLINE_BYTES||Buffer.from(body.base64,'base64').toString('base64')!==body.base64||Buffer.from(body.base64,'base64').length!==body.bytes)return 'HTTP binary byte count or base64 is invalid'
  }
  if(body.kind==='bodyRef'){
    const ref=body.artifactRef
    // NetDomain's installed macOS handler uses a MIME-derived extension.
    // Windows/Linux retain their exclusive binary sidecar name.
    const lower=result.contentType.toLowerCase()
    const macExtension=[['html','html'],['json','json'],['xml','xml'],['javascript','js'],['text/','txt'],['png','png'],['jpeg','jpg'],['jpg','jpg'],['pdf','pdf']].find(([match])=>match==='text/'?lower.startsWith(match):lower.includes(match))?.[1]??'bin'
    const filenameMatches=body.sidecarPath.endsWith(`url_fetch-${ref.artifactId}.bin`)||(process.platform==='darwin'&&body.sidecarPath.endsWith(`url_fetch-${ref.artifactId}.${macExtension}`))
    if(body.bytes<=DESKTOP_HTTP_INLINE_BYTES||ref.bytes!==body.bytes||ref.preview!==body.preview||ref.contentType!==result.contentType||ref.url!==action.url||Buffer.byteLength(body.preview)>12288||!/^[a-f0-9]{12,64}$/.test(ref.artifactId)||!isAbsolute(body.sidecarPath)||body.sidecarPath.includes('\0')||!filenameMatches)return 'HTTP artifact metadata does not match its response'
  }
  return
}
