import {desktopContractShapeError} from './desktop-contract-validation'
import type {DesktopContractSchema} from './desktop-contract.generated'
import {eventKitInstant} from './desktop-eventkit-validation'
import {DESKTOP_VM_COPY_MAX_BYTES} from './desktop-contract'
import {DESKTOP_CONTRACT_ALIASES} from './desktop-contract.generated'
import {isIPv4} from 'node:net'
import {isAbsolute,resolve} from 'node:path'
import {homedir} from 'node:os'
import type {DesktopVmAxNode,DesktopVmAxSnapshot,DesktopVmLogs,DesktopVmMounted,DesktopVmTrust} from './desktop-contract'

export const DESKTOP_VM_FIELDS:Record<string,string[]>={
  create:['kind','cpu','memorySize','diskSize','image','imageFormat','network','rosetta','shares'],adopt:['sourcePath','kind','provider','mode','installAgent','waitForAgent','imageFormat'],clone:['src','dst'],install:['ipsw','fromLatest'],pull:['image'],list:[],get:[],inspect:[],start:['headless','waitForAgent','waitForVsock','detach'],stop:['force','timeout'],pause:[],resume:[],reset:[],delete:['force','keepDisk'],exec:['command','env','user','workdir','tty','timeout'],snapshot:['tag','snapshotOp','diskOnly','pausedStateOnly'],restore:['tag','diskOnly','pausedStateOnly','headless'],cp:['src','dst','timeout'],share:['hostPath','tag','readOnly'],mount:['tag','path','timeout'],port_forward:['hostAddress','hostPort','guestPort'],screenshot:['out','timeout'],type:['text','timeout'],click:['x','y','button','timeout'],keys:['keys','timeout'],read_ax:['max_depth','app','timeout'],console:['write','maxBytes','timeout'],logs:['limit','timeout'],trust:['noPrompt','prompt','walkthrough','accessibilityPrompt','screenPrompt','resetDenied','timeout'],tcc_profile_generate:['services','out','bundleId','appPath','identifierType','codeRequirement','fullDisk','includeUserOnly']
}
const named=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(s)
// VM names follow VMSpec.validateStatic, which also allows '.' (ubuntu-24.04).
const vmNamed=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s)
export function desktopVmQmpChord(text:string):string[]|undefined {
  if(!text.length||Buffer.byteLength(text)>256||text.includes('\0')||/[^\x00-\x7F]/.test(text))return
  const parts=text.split('+').map(x=>x.trim().toLowerCase())
  if(parts.length>8||parts.some(x=>!x))return
  const aliases:Record<string,string>={command:'meta_l',cmd:'meta_l',meta:'meta_l',super:'meta_l',win:'meta_l',control:'ctrl',option:'alt',enter:'ret',return:'ret',space:'spc',escape:'esc',pageup:'pgup',pagedown:'pgdn','-':'minus','=':'equal','[':'bracket_left',']':'bracket_right',';':'semicolon',"'":'apostrophe','`':'grave_accent','\\':'backslash',',':'comma','.':'dot','/':'slash'}
  const keys=parts.map(x=>Object.hasOwn(aliases,x)?aliases[x]:x),modifiers=['shift','alt','ctrl','meta_l']
  if(keys.some(x=>!DESKTOP_CONTRACT_ALIASES.DesktopVmQmpKeyCode.includes(x as never))||keys.slice(0,-1).some(x=>!modifiers.includes(x))||modifiers.includes(keys.at(-1)!)||new Set(keys).size!==keys.length)return
  return keys
}
export function desktopVmCopySelection(src:string,dst:string):{name:string;direction:'host-to-guest'|'guest-to-host'}|undefined {
  const guest=(s:string)=>/^[A-Za-z]:[\\/]/.test(s)?undefined:/^([A-Za-z0-9][A-Za-z0-9._-]{0,63}):(.+)$/.exec(s)?.[1]
  const source=guest(src),destination=guest(dst)
  if(Boolean(source)===Boolean(destination))return
  return {name:(destination??source)!,direction:destination?'host-to-guest':'guest-to-host'}
}
export function desktopVmActionError(a:Record<string,unknown>):string|undefined {
  if(a.type!=='desktop_vm')return
  const shape=desktopContractShapeError(a,'DesktopVmAction');if(shape)return shape
  const sub=String(a.sub),fields=DESKTOP_VM_FIELDS[sub]
  if(!fields||Object.keys(a).some(k=>!['type','sub','stateDir','name',...fields].includes(k)))return 'field does not belong to VM selector'
  if(['list','pull','clone'].includes(sub)?a.name!==undefined:!vmNamed(a.name))return 'VM selector requires one safe exact name'
  for(const[k,v]of Object.entries(a))if(typeof v==='string'&&(v.includes('\0')||Buffer.byteLength(v)>(['text','write'].includes(k)?32768:4096)||(!['text','write'].includes(k)&&!v.length)))return 'invalid bounded VM '+k
  const required:Record<string,string[]>={adopt:['sourcePath'],clone:['src','dst'],pull:['image'],exec:['command'],restore:['tag'],cp:['src','dst'],share:['hostPath','tag'],mount:['tag','path'],port_forward:['guestPort'],type:['text'],click:['x','y'],keys:['keys']}
  if(required[sub]?.some(k=>a[k]===undefined))return 'VM selector requires exact fields'
  if(sub==='cp'){
    const selection=desktopVmCopySelection(String(a.src),String(a.dst))
    if(!selection||selection.name!==a.name)return 'VM copy requires exactly one named guest path and one host path'
    const host=String(selection.direction==='host-to-guest'?a.src:a.dst),guest=String(selection.direction==='host-to-guest'?a.dst:a.src).slice(String(a.name).length+1)
    if(!/^(?:\/|~[\\/]|[A-Za-z]:[\\/])/.test(host)||guest.split('/').some(p=>p==='.'||p==='..'))return 'VM copy requires absolute paths without guest dot traversal'
  }
  for(const[k,lo,hi]of [['cpu',1,32],['memorySize',268435456,34359738368],['diskSize',1048576,68719476736],['timeout',1,50],['maxBytes',1,65536],['limit',1,1000],['max_depth',1,64],['hostPort',0,65535],['guestPort',1,65535]] as const)if(a[k]!==undefined&&(!Number.isSafeInteger(a[k])||Number(a[k])<lo||Number(a[k])>hi))return 'invalid bounded VM '+k
  if(a.memorySize!==undefined&&Number(a.memorySize)%1048576!==0)return 'VM memory requires whole MiB in bytes'
  for(const k of ['x','y'])if(a[k]!==undefined&&(typeof a[k]!=='number'||!Number.isFinite(a[k])||Number(a[k])<0||Number(a[k])>16383))return 'VM coordinates must be finite physical guest pixels'
  for(const k of ['stateDir','sourcePath','image','ipsw','hostPath','out','path'])if(a[k]!==undefined&&!(k==='image'&&sub==='pull')&&!/^(?:\/|~[\\/]|[A-Za-z]:[\\/])/.test(String(a[k])))return 'VM requires absolute or home-relative '+k
  for(const[k,values]of [['kind',['linux','macos']],['network',['none','nat']],['provider',['auto','qemu']],['mode',['clone','move','reference']],['imageFormat',['raw','qcow2']],['snapshotOp',['create','list','delete','restore']],['button',['left','right','middle']]] as const)if(a[k]!==undefined&&!values.includes(String(a[k]) as never))return 'invalid VM '+k
  if(sub==='clone'&&(!vmNamed(a.src)||!vmNamed(a.dst)||a.src===a.dst))return 'VM clone requires different safe names'
  if(a.tag!==undefined&&!named(a.tag))return 'VM tag requires a safe exact name'
  if(a.hostAddress!==undefined&&a.hostAddress!=='127.0.0.1')return 'VM forwards require IPv4 loopback'
  if(sub==='snapshot'&&a.snapshotOp!=='list'&&!named(a.tag))return 'VM snapshot requires an exact tag'
  if(a.diskOnly===true&&a.pausedStateOnly===true)return 'VM snapshot modes are mutually exclusive'
  if(a.command!==undefined&&(!Array.isArray(a.command)||a.command.length<1||a.command.length>128||a.command.some((x,i)=>typeof x!=='string'||x.includes('\0')||Buffer.byteLength(x)>32768||i===0&&!x.length)))return 'VM exec requires bounded exact argv'
  if(a.env!==undefined){const env=a.env as Record<string,string>;if(Object.keys(env).length>64||Object.entries(env).some(([k,v])=>!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)||typeof v!=='string'||v.includes('\0')||Buffer.byteLength(v)>32768))return 'invalid VM environment'}
  if(a.shares!==undefined){const rows=a.shares as Record<string,unknown>[];if(rows.length>16||new Set(rows.map(x=>x.tag)).size!==rows.length||rows.some(x=>!named(x.tag)||typeof x.hostPath!=='string'||!/^(?:\/|[A-Za-z]:[\\/])/.test(x.hostPath)||x.hostPath.includes('\0')||Buffer.byteLength(x.hostPath)>4096))return 'invalid VM directory shares'}
  if(Buffer.byteLength(JSON.stringify(a))>131072)return 'VM request exceeds 128KiB'
}
export function desktopVmResultError(a:Record<string,unknown>,value:unknown):string|undefined {
  if(a.type!=='desktop_vm')return
  const sub=String(a.sub),d=value as Record<string,unknown>
  const schemas:Record<string,DesktopContractSchema>={create:'DesktopVmCreated',adopt:'DesktopVmCreated',clone:'DesktopVmCloned',list:'DesktopVmList',get:'DesktopVmView',inspect:'DesktopVmView',start:'DesktopVmTransition',stop:'DesktopVmTransition',pause:'DesktopVmTransition',resume:'DesktopVmTransition',reset:'DesktopVmTransition',delete:'DesktopVmTransition',exec:'DesktopVmExecution',cp:'DesktopVmCopied',restore:'DesktopVmSnapshot',console:'DesktopVmConsole',port_forward:'DesktopVmForward',screenshot:'DesktopVmScreenshot',type:'DesktopVmInput',keys:'DesktopVmInput',click:'DesktopVmInput',read_ax:'DesktopVmAxSnapshot',logs:'DesktopVmLogs',mount:'DesktopVmMounted',trust:'DesktopVmTrust'}
  const schema=sub==='snapshot'?(a.snapshotOp==='list'?'DesktopVmSnapshots':a.snapshotOp==='delete'?'DesktopVmSnapshotDeleted':'DesktopVmSnapshot'):schemas[sub]
  if(!schema)return 'VM selector has no qualified reply schema'
  const error=desktopContractShapeError(value,schema);if(error)return error
  if(Buffer.byteLength(JSON.stringify(d))>1048576)return 'VM reply exceeds 1MiB'
  if(d.name!==undefined&&d.name!==(sub==='clone'?a.dst:a.name))return 'VM reply name differs'
  if(d.tag!==undefined&&d.tag!==a.tag)return 'VM snapshot identity differs'
  if(['read_ax','logs','mount','trust'].includes(sub)){
    if(Buffer.byteLength(JSON.stringify(d))>131072)return 'VM read reply exceeds 128KiB'
    const error=desktopVmReadResultError(a,d);if(error)return error
  }
  if(sub==='cp'){
    const src=String(a.src),dst=String(a.dst),selection=desktopVmCopySelection(src,dst)
    if(!selection||selection.name!==a.name||d.direction!==selection.direction||d.source!==src||d.path!==dst)return 'VM copy source, destination or direction differs'
    if(!Number.isSafeInteger(d.bytes)||Number(d.bytes)<0||Number(d.bytes)>DESKTOP_VM_COPY_MAX_BYTES||typeof d.sha256!=='string'||!/^[a-f0-9]{64}$/.test(d.sha256)||d.verified!==true||d.overwrite!==false)return 'VM copy needs bounded verified bytes and an exclusive destination'
  }
  if(sub==='exec'&&(!Number.isSafeInteger(d.exitCode)||Number(d.exitCode)<-2147483648||Number(d.exitCode)>2147483647||!Number.isSafeInteger(d.durationMs)||Number(d.durationMs)<0||Number(d.durationMs)>58000||Buffer.byteLength(String(d.stdout))+Buffer.byteLength(String(d.stderr))>131072))return 'invalid bounded actual VM execution'
  if(['type','keys','click'].includes(sub)){
    if(d.operation!==sub||!Number.isSafeInteger(d.submittedEvents)||Number(d.submittedEvents)<0||Number(d.submittedEvents)>65536||d.guestEffectVerified!==false)return 'VM input needs bounded actual submission without invented guest effects'
    if(sub==='type'){
      if(d.textUTF8Bytes!==Buffer.byteLength(String(a.text))||d.keys!==undefined||d.x!==undefined||d.y!==undefined||d.button!==undefined)return 'VM type receipt differs from exact requested text'
      if(d.transport==='coregraphics'&&d.submittedEvents!==Array.from(String(a.text)).length*2)return 'VM Unicode event count differs'
    }else if(sub==='keys'){
      const native=d.transport==='qmp'?desktopVmQmpChord(String(a.keys)):undefined
      if(d.transport==='qmp'&&!native||d.keys!==a.keys||d.submittedEvents!==(d.transport==='qmp'?native!.length*2:2)||d.textUTF8Bytes!==undefined||d.x!==undefined||d.y!==undefined||d.button!==undefined)return 'VM physical chord receipt differs'
    }else if(d.x!==a.x||d.y!==a.y||d.button!==(a.button??'left')||d.submittedEvents!==(d.transport==='qmp'?4:2)||d.textUTF8Bytes!==undefined||d.keys!==undefined)return 'VM click receipt differs'
  }
  if(sub==='port_forward'){
    if(d.hostAddress!=='127.0.0.1'||!Number.isSafeInteger(d.hostPort)||Number(d.hostPort)<1||Number(d.hostPort)>65535||Number(a.hostPort??0)!==0&&d.hostPort!==a.hostPort||d.guestPort!==a.guestPort)return 'VM listener does not match the exact loopback and port request'
    if(typeof d.guestAddress!=='string'||!isIPv4(d.guestAddress)||d.guestAddress==='0.0.0.0'||Number(d.guestAddress.split('.')[0])>=224)return 'VM listener needs an actual unicast guest IPv4 target'
  }
  const states=['created','ready','running','paused','stopped','error','deleted']
  if(d.state!==undefined&&!states.includes(String(d.state)))return 'invalid actual VM state'
  if(sub==='pause'&&d.state!=='paused'||['start','resume'].includes(sub)&&d.state!=='running'||sub==='stop'&&d.state!=='stopped'||sub==='delete'&&d.state!=='deleted')return 'VM effect readback differs'
  const views=sub==='list'?d.vms:sub==='get'||sub==='inspect'?[d]:[]
  if(!Array.isArray(views)||views.length>128||new Set(views.map(x=>(x as Record<string,unknown>).id)).size!==views.length)return 'invalid VM inventory identities'
  for(const v of views as Record<string,unknown>[]){if(!vmNamed(v.name)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(String(v.id))||!states.includes(String(v.status))||eventKitInstant(v.createdAt)===undefined||v.startedAt!==undefined&&eventKitInstant(v.startedAt)===undefined)return 'invalid VM native inventory';for(const k of ['cpu','memorySize','diskSize'])if(!Number.isSafeInteger(v[k])||Number(v[k])<1)return 'invalid VM resource readback'}
  if(sub==='snapshot'&&a.snapshotOp==='delete'&&d.deleted!==true)return 'VM snapshot deletion not confirmed'
  if(sub==='console'){if(a.write!==undefined){if(d.bytesWritten!==Buffer.byteLength(String(a.write))||d.bytes!==undefined||d.dataBase64!==undefined)return 'VM console write differs'}else{if(typeof d.dataBase64!=='string'||typeof d.text!=='string'||Buffer.from(d.dataBase64,'base64').toString('base64')!==d.dataBase64||Buffer.from(d.dataBase64,'base64').length!==d.bytes||Buffer.byteLength(d.text)!==d.bytes||Number(d.bytes)>Number(a.maxBytes??4096))return 'invalid actual VM console bytes'}}
  if(sub==='screenshot'){
    if(!Number.isSafeInteger(d.width)||!Number.isSafeInteger(d.height)||Number(d.width)<1||Number(d.height)<1||Number(d.width)>16384||Number(d.height)>16384||Number(d.width)*Number(d.height)>33554432||!Number.isSafeInteger(d.bytes)||Number(d.bytes)<1||Number(d.bytes)>67108864||Boolean(d.filePath)===Boolean(d.dataUrl)||d.format!=='png')return 'invalid actual VM screenshot'
    if(a.out!==undefined){
      const target=String(a.out),expanded=/^~[\\/]/.test(target)?homedir()+target.slice(1):target
      if(typeof d.filePath!=='string'||d.filePath.includes('\0')||!isAbsolute(d.filePath)||resolve(d.filePath)!==resolve(expanded)||d.dataUrl!==undefined)return 'VM screenshot host output differs from the exact destination'
    }else{
      if(d.filePath!==undefined||typeof d.dataUrl!=='string'||!d.dataUrl.startsWith('data:image/png;base64,'))return 'VM inline screenshot omitted its actual PNG bytes'
      const encoded=d.dataUrl.slice('data:image/png;base64,'.length),png=Buffer.from(encoded,'base64')
      if(png.length!==d.bytes||png.length>700000||png.toString('base64')!==encoded||png.length<45||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.readUInt32BE(8)!==13||png.toString('ascii',12,16)!=='IHDR'||png.readUInt32BE(16)!==d.width||png.readUInt32BE(20)!==d.height)return 'VM PNG byte count, canonical encoding or header dimensions differ'
    }
  }
}

function desktopVmReadResultError(a:Record<string,unknown>,data:Record<string,unknown>):string|undefined {
  const bounded=(s:string,max=4096)=>!s.includes('\0')&&Buffer.byteLength(s)<=max
  if(a.sub==='read_ax'){
    const d=data as unknown as DesktopVmAxSnapshot
    if(d.selector!==a.app||!bounded(d.app)||!bounded(d.bundleIdentifier)||!Number.isSafeInteger(d.pid)||d.pid<1||d.pid>2147483647||d.maxDepth!==(a.max_depth??4)||!Number.isSafeInteger(d.visited)||d.visited<1||d.visited>500||d.refsActionable||d.reasons.length>16||new Set(d.reasons).size!==d.reasons.length||d.reasons.some(x=>!/^[a-z_]{1,64}$/.test(x))||d.partial!==Boolean(d.reasons.length))return 'VM AX target, counts or partial metadata differ'
    let count=0,size=0;const refs=new Set<string>()
    const node=(v:DesktopVmAxNode,depth:number):string|undefined=>{
      if(++count>500||depth>Math.min(d.maxDepth,12)||!/^ax[1-9][0-9]{0,2}$/.test(v.ref)||refs.has(v.ref)||!v.role||(v.children?.length??0)>50)return 'VM AX node identities or traversal bounds differ'
      refs.add(v.ref)
      for(const text of [v.role,v.subrole,v.value,v.title,v.description])if(text!==undefined){if(!bounded(text,2048)||Array.from(text).length>512)return 'VM AX node text is oversized';size+=Buffer.byteLength(text)}
      if(size>32768)return 'VM AX aggregate text exceeds 32KiB'
      const secure=v.role==='AXSecureTextField'||v.subrole==='AXSecureTextField'
      if(v.secure!==secure||secure&&(v.valueState!=='redacted'||v.value!=='•••'))return 'VM secure AX value escaped redaction'
      if(!secure){if(v.role==='AXTextField'&&v.subrole===undefined){if(v.valueState!=='withheld'||v.value!==undefined)return 'VM unclassified text-field value was fetched'}else if(v.valueState!==(v.value===undefined?'unavailable':'read'))return 'VM AX value availability differs'}
      if(v.frame&&([v.frame.x,v.frame.y,v.frame.width,v.frame.height].some(x=>!Number.isFinite(x)||Math.abs(x)>1e9)||v.frame.width<0||v.frame.height<0))return 'invalid VM AX frame'
      for(const child of v.children??[]){const error=node(child,depth+1);if(error)return error}
    }
    const error=node(d.tree,0);if(error)return error
    if(count>d.visited||count!==d.visited&&!d.partial)return 'VM AX visited count differs'
  }else if(a.sub==='logs'){
    const d=data as unknown as DesktopVmLogs,paths=['/tmp/InterceptorD.err.log','/tmp/InterceptorD.out.log']
    if(d.logs.length!==2||d.logs.some((x,i)=>x.path!==paths[i]))return 'VM logs refer to unexpected guest files'
    let size=0,partial=false
    for(const row of d.logs){
      if(row.lines.length>Number(a.limit??200))return 'VM log line count exceeds the request'
      for(const text of row.lines){if(!bounded(text,2048)||Array.from(text).length>512)return 'VM log line is oversized';size+=Buffer.byteLength(text)}
      if(row.state==='unavailable'){if(row.lines.length||row.truncated||!row.error||!bounded(row.error))return 'VM unavailable log has invented content';partial=true}else if(row.error!==undefined)return 'VM read log has a conflicting error'
      partial=partial||row.truncated
    }
    if(size>65536||d.partial!==partial)return 'VM log aggregate or partial metadata differs'
  }else if(a.sub==='mount'){
    const d=data as unknown as DesktopVmMounted
    if(d.path!==a.path||d.tag!==a.tag||!d.nativeMountPath.startsWith('/')||!bounded(d.nativeMountPath)||d.fileSystem!=='virtiofs'||d.mounted!==true)return 'VM actual mount scope or readback differs'
  }else if(a.sub==='trust'){
    const d=data as unknown as DesktopVmTrust
    if(d.platform!=='macos'||[d.accessibility,d.screenRecording,d.postEvent,d.inputMonitoring].some(x=>!['granted','denied'].includes(x))||d.notes.length>16||d.notes.some(x=>!bounded(x))||(d.action_required?.length??0)>8||d.action_required?.some(x=>!bounded(x)))return 'VM guest permission preflight is invalid'
    const no=a.noPrompt===true,ax=!no&&(a.prompt===true||a.walkthrough===true||a.accessibilityPrompt===true),screen=!no&&(a.prompt===true||a.walkthrough===true||a.screenPrompt===true)
    const prompts=[...(ax?['Accessibility']:[]),...(screen?['Screen Recording']:[])]
    if(JSON.stringify(d.prompted??[])!==JSON.stringify(prompts)||(d.opened?.length??0)>1||d.opened?.some(x=>!['Accessibility','Screen Recording'].includes(x))||d.opened!==undefined&&(no||a.walkthrough!==true))return 'VM permission prompt or pane scope differs'
    const services=!no&&a.resetDenied===true?[...(ax?['Accessibility']:[]),...(screen?['ScreenCapture']:[])]:[]
    if(JSON.stringify((d.reset??[]).map(x=>x.service))!==JSON.stringify(services))return 'VM native TCC reset services differ'
    for(const row of d.reset??[]){
      if(row.exitCode!==undefined){if(!Number.isSafeInteger(row.exitCode)||row.exitCode< -2147483648||row.exitCode>2147483647||row.ok!==(row.exitCode===0)||typeof row.stdout!=='string'||typeof row.stderr!=='string'||!bounded(row.stdout,16384)||!bounded(row.stderr,16384)||!Number.isSafeInteger(row.durationMs)||Number(row.durationMs)<0||Number(row.durationMs)>58000||row.truncated===undefined||row.error!==undefined||row.outcomeUnknown!==undefined)return 'VM TCC reset native exit receipt is inconsistent'}else if(row.ok||!row.error||!bounded(row.error)||row.outcomeUnknown!==true||row.stdout!==undefined||row.stderr!==undefined||row.durationMs!==undefined||row.truncated!==undefined)return 'VM unknown TCC reset invented a native exit'
    }
  }
}
