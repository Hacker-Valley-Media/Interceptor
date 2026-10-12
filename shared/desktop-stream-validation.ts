import {desktopContractShapeError} from './desktop-contract-validation'
import {DESKTOP_STREAM_MAX_SESSIONS,DESKTOP_MAX_RESULT_BYTES,DESKTOP_CAPTURE_MAX_PIXELS,DESKTOP_STREAM_MEDIA_MAX_BYTES,DESKTOP_STREAM_MEDIA_MAX_SECONDS} from './desktop-contract'
import type {DesktopContractSchema} from './desktop-contract.generated'

export function desktopStreamActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_stream')return
  const shape=desktopContractShapeError(a,'DesktopStreamAction');if(shape)return shape
  const bounded=(v:unknown,max:number)=>typeof v==='string'&&!!v.trim()&&!v.includes('\0')&&Buffer.byteLength(v)<=max
  if(a.sid!==undefined&&(!bounded(a.sid,64)||!/^[a-zA-Z0-9_-]+$/.test(String(a.sid))))return 'invalid stream session identity'
  if(a.sid!==undefined&&['start','status','list'].includes(String(a.op)))return 'this stream operation accepts no session identity'
  for(const key of ['app','window','display','virtual','format'])if(a[key]!==undefined&&a.op!=='start')return 'stream target/format fields require start'
  if(a.app!==undefined&&!bounded(a.app,512))return 'invalid bounded stream application target'
  for(const key of ['window','display'])if(a[key]!==undefined&&(!Number.isSafeInteger(a[key])||Number(a[key])<=0))return 'stream target requires a positive native window/display identity'
  if(['app','window','display','virtual'].filter(key=>a[key]!==undefined).length>1)return 'stream start requires one target selector'
  if(a.virtual!==undefined&&!bounded(a.virtual,64)||a.format!==undefined&&!['jpeg','jpg'].includes(String(a.format)))return 'invalid stream virtual target or frame format'
  const inputs=['inputType','ref','x','y','text','combo','direction','amount']
  if(a.op!=='inject'&&inputs.some(key=>a[key]!==undefined))return 'stream input fields require inject'
  if(a.op==='inject'){
    const kind=a.inputType??'click',owned=new Set(kind==='click'?['x','y']:kind==='type'?['text','ref']:kind==='keys'?['combo']:['direction','amount'])
    if(inputs.some(key=>key!=='inputType'&&a[key]!==undefined&&!owned.has(key)))return 'stream input fields contradict the input type'
    if(kind==='click'&&(!Number.isSafeInteger(a.x)||!Number.isSafeInteger(a.y)||Math.abs(Number(a.x))>1_000_000||Math.abs(Number(a.y))>1_000_000))return 'stream click requires bounded integer screen coordinates'
    if(kind==='type'&&!bounded(a.text,1_048_576)||kind==='keys'&&!bounded(a.combo,4096)||a.ref!==undefined&&!bounded(a.ref,256))return 'invalid bounded stream input text or reference'
    if(kind==='scroll'&&(a.direction===undefined||!Number.isSafeInteger(a.amount)||Number(a.amount)<1||Number(a.amount)>10000))return 'stream scroll requires direction and an integer amount 1..10000'
  }
  if(a.recordOp!==undefined&&a.op!=='record')return 'record operation requires stream record'
  if((a.media!==undefined||a.recordAudio!==undefined)&&(a.op!=='record'||a.recordOp!=='start'))return 'media and recording audio require stream record start'
  if(a.recordAudio!==undefined&&a.media!==true)return 'recording audio requires explicit media recording'
  for(const key of ['group','groupColor'])if(a[key]!==undefined&&!bounded(a[key],256))return 'invalid stream group text'
}
export function desktopStreamResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_stream')return
  const safe=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0
  const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0
  const id=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(v)
  if(a.op==='stop')return data==='ok'?undefined:'invalid stream stop acknowledgement'
  if(a.op==='inject'){
    const kind=String(a.inputType??'click')
    const schemas:Readonly<Record<string,DesktopContractSchema>>={click:'DesktopAxClickData',type:'DesktopAxTypeData',keys:'DesktopAxKeysData',scroll:'DesktopAxScrollData'}
    const schema=schemas[kind]
    return schema?desktopContractShapeError(data,schema):'invalid stream input reply kind'
  }
  if(['status','list'].includes(String(a.op))){
    if(!Array.isArray(data)||data.length>DESKTOP_STREAM_MAX_SESSIONS)return 'invalid bounded stream inventory'
    const seen=new Set<string>()
    for(const row of data){const shape=desktopContractShapeError(row,a.op==='list'?'DesktopStreamListRow':'DesktopStreamStatusRow');if(shape)return shape
      if(!id(row.sid)||seen.has(row.sid)||!safe(row.frameCount)||!finite(a.op==='list'?row.currentFPS:row.fps)||a.op==='status'&&!finite(row.duration)||a.op==='list'&&(!safe(row.width)||!safe(row.height)))return 'invalid stream inventory identity or measurements';seen.add(row.sid)
    }return
  }
  const shape=desktopContractShapeError(data,a.op==='start'?'DesktopStreamStarted':a.op==='frame'?'DesktopStreamFrame':a.op==='fps'?'DesktopStreamFPS':a.op==='resolution'?'DesktopStreamResolution':'DesktopStreamRecorded');if(shape)return shape
  const row=data as Record<string,unknown>
  if(a.op==='start'&&(!id(row.sid)||row.status!=='streaming'))return 'invalid stream admission acknowledgement'
  if(a.op==='frame'&&(!safe(row.frameCount)||Number(row.frameCount)<1||typeof row.dataUrl!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(row.dataUrl)||Buffer.byteLength(row.dataUrl)>DESKTOP_MAX_RESULT_BYTES))return 'invalid bounded native stream frame'
  if(a.op==='fps'&&!finite(row.fps)||a.op==='resolution'&&(!safe(row.width)||!safe(row.height)||Number(row.width)*Number(row.height)>DESKTOP_CAPTURE_MAX_PIXELS))return 'invalid stream measurements'
  if(a.op==='record'){
    if(row.sid!==undefined&&(!id(row.sid)||a.sid!==undefined&&row.sid!==a.sid))return 'recording reply differs from the retained stream identity'
    if((a.recordOp??'status')==='start'&&(row.recording!==true||!id(row.sid)||a.sid!==undefined&&row.sid!==a.sid))return 'invalid stream recording admission'
    if(a.recordOp==='stop'&&row.recording!==false||row.frames!==undefined&&!safe(row.frames)||row.duration!==undefined&&!finite(row.duration))return 'invalid stream recording state'
    if(a.media===true&&row.artifact===undefined)return 'media admission omitted its owned artifact'
    if(row.artifact!==undefined){
      const artifact=row.artifact as Record<string,unknown>,source=artifact.source as Record<string,unknown>
      if(typeof artifact.filePath!=='string'||!artifact.filePath.trim()||artifact.filePath.includes('\0')||Buffer.byteLength(artifact.filePath)>4096||!/^(\/|[A-Za-z]:[\\/])/.test(artifact.filePath))return 'invalid absolute stream artifact path'
      if(!safe(artifact.bytes)||Number(artifact.bytes)>DESKTOP_STREAM_MEDIA_MAX_BYTES||!finite(row.duration)||Number(row.duration)>DESKTOP_STREAM_MEDIA_MAX_SECONDS)return 'media bytes or duration exceed their bound'
      if(artifact.container==='matroska'&&(artifact.videoCodec!=='mjpeg'||artifact.timing!=='monotonic-arrival'||artifact.audio!=='none')||artifact.container==='mp4'&&(artifact.videoCodec!=='h264'||artifact.timing!=='native-media'))return 'media codec, clock or audio contradict its container'
      if(artifact.finalized?(row.recording!==false||Number(artifact.bytes)===0||Number(row.duration)===0||typeof artifact.sha256!=='string'||!/^[a-f0-9]{64}$/.test(artifact.sha256)):(row.recording!==true||artifact.sha256!==undefined||a.recordOp==='stop'))return 'media finalization is incomplete or contradictory'
      for(const key of ['pid','window','display'])if(source[key]!==undefined&&(!safe(source[key])||Number(source[key])===0))return 'invalid media source identity'
      if(source.kind==='window'&&(source.pid===undefined||source.window===undefined||source.display!==undefined)||source.kind!=='window'&&(source.pid!==undefined||source.window!==undefined)||source.kind==='portal-monitor'&&source.display!==undefined)return 'media source identity contradicts its native scope'
      if(artifact.audio==='system'&&source.kind!=='display')return 'system recording audio requires an explicitly retained display source'
      if(a.recordAudio!==undefined&&artifact.audio!==a.recordAudio)return 'media audio acknowledgement differs from admission'
    }
  }
}
