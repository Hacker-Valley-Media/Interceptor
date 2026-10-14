import spec from './desktop-overlay-spec.json'
import {desktopContractShapeError} from './desktop-contract-validation'

type Obj=Record<string,unknown>
const object=(v:unknown):v is Obj=>typeof v==='object'&&v!==null&&!Array.isArray(v)
const bytes=(s:string)=>Buffer.byteLength(s)
const text=(v:unknown,max=4096,empty=false)=>typeof v==='string'&&(empty||v.length>0)&&bytes(v)<=max&&!v.includes('\0')
const id=(v:unknown)=>typeof v==='string'&&v.trim()===v&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v)
const num=(v:unknown,lo:number,hi:number,integer=false)=>typeof v==='number'&&Number.isFinite(v)&&v>=lo&&v<=hi&&(!integer||Number.isInteger(v))
const known=(v:unknown,list:readonly string[])=>typeof v==='string'&&list.includes(v)
const fields=(v:unknown,list:readonly string[]):v is Obj=>object(v)&&Object.keys(v).every(k=>list.includes(k))
const color=(v:unknown)=>typeof v==='string'&&(['red','blue','green','yellow','orange','purple','white','black'].includes(v.toLowerCase())||/^#[a-fA-F0-9]{6}$/.test(v))
const emoji=(v:unknown)=>{const a=typeof v==='string'?v.split(',').map(s=>s.trim()):v;return Array.isArray(a)&&a.length>0&&a.length<=32&&a.every(s=>text(s,128)&&[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(s)].length<=8)}
export function desktopOverlayBounded(v:unknown,max=spec.limits.requestBytes):boolean {
  let budget=32768
  const visit=(v:unknown,depth:number):boolean=>{
    if(--budget<0||depth>16)return false
    if(v===null||typeof v==='boolean')return true
    if(typeof v==='number')return Number.isFinite(v)
    if(typeof v==='string')return text(v,spec.limits.requestBytes,true)
    if(Array.isArray(v))return v.length<=spec.limits.operations&&v.every(v=>visit(v,depth+1))
    return object(v)&&Object.keys(v).length<=128&&Object.entries(v).every(([k,v])=>text(k,128)&&visit(v,depth+1))
  }
  try{return visit(v,0)&&bytes(JSON.stringify(v))<=max}catch{return false}
}
function entityError(v:unknown):string|undefined {
  if(!fields(v,['id','emoji','x','y','size','facing'])||!id(v.id))return 'scene entity requires an exact safe ID and known fields'
  if(v.emoji!==undefined&&!emoji([v.emoji]))return 'invalid scene emoji'
  for(const k of ['x','y'])if(v[k]!==undefined&&!num(v[k],0,1))return 'invalid normalized entity position'
  if(v.size!==undefined&&!num(v.size,1,512)||v.facing!==undefined&&!known(v.facing,['left','right']))return 'invalid entity size or facing'
}
export function desktopOverlayOpsError(v:unknown):string|undefined {
  if(!Array.isArray(v)||v.length>4096||!desktopOverlayBounded(v))return 'operations require bounded JSON array up to 4096 rows'
  let cost=0
  for(const row of v){
    if(!object(row)||typeof row.op!=='string'||!Object.hasOwn(spec.ops,row.op))return 'unknown scene operation'
    const op=row.op,allowed=(spec.ops as Record<string,string[]>)[op]
    if(Object.keys(row).some(k=>!['at','op',...allowed].includes(k)))return 'unknown scene operation field'
    const bounds:Record<string,[number,number,boolean?]>={at:[0,86400],duration:[0.001,300],lifetime:[0.001,300],x:[0,1],y:[0,1],fromX:[0,1],fromY:[0,1],toX:[0,1],toY:[0,1],dx:[-1,1],dy:[-1,1],angle:[-100,100],scale:[0.01,8],alpha:[0,1],amount:[0,1],amplitude:[0,512],cornerRadius:[0,512],magnitude:[0,512],spread:[0,4096],count:[1,128,true],fontSize:[1,256],width:[0.001,1],height:[0.001,op==='jump'?4096:1],lineWidth:[0.1,64]}
    for(const[k,value]of Object.entries(row)){
      if(bounds[k]&&!num(value,...bounds[k]))return 'invalid finite bounded scene '+k
      if(['color','hitColor'].includes(k)&&!color(value)||['id','from','to'].includes(k)&&!id(value)||['text','font'].includes(k)&&!text(value,k==='font'?128:4096,k==='text')||k==='emoji'&&!emoji([value])||k==='emojis'&&!emoji(value)||k==='dir'&&!known(value,['left','right'])||k==='easing'&&!known(value,['linear','easeIn','easeOut','easeInOut']))return 'invalid bounded scene '+k
    }
    if(row.target!==undefined){const ids=Array.isArray(row.target)?row.target:[row.target];if(!ids.length||ids.length>128||new Set(ids).size!==ids.length||ids.some(v=>v!=='all'&&!id(v))||['knockout','roar','bow','despawn'].includes(op)&&(typeof row.target!=='string'||row.target==='all'))return 'scene target requires distinct exact IDs'}
    else if(allowed.includes('target')&&op!=='shake')return 'scene operation requires a target'
    if(op==='throw'&&(row.from===undefined&&(row.fromX===undefined||row.fromY===undefined)||row.to===undefined&&(row.toX===undefined||row.toY===undefined)))return 'throw requires source and destination entities or points'
    if(op==='spawn'){const error=entityError(row.entity);if(error)return error}
    cost+=op==='burst'?Number(row.count??18):['impact','knockout'].includes(op)?48:1
    if(cost>65536)return 'scene effect admission exceeds 65536'
  }
}
export function desktopOverlayScriptError(v:unknown):string|undefined {
  if(!fields(v,['banner','entities','timeline','background'])||!desktopOverlayBounded(v))return 'scene script requires bounded known fields'
  if(v.background!==undefined&&v.background!=='transparent'&&!color(v.background))return 'invalid scene background'
  if(v.banner!==undefined){const b=v.banner;if(!fields(b,['text','y','fontSize','color'])||!text(b.text,4096,true)||b.y!==undefined&&!num(b.y,0,1)||b.fontSize!==undefined&&!num(b.fontSize,1,256)||b.color!==undefined&&!color(b.color))return 'invalid scene banner'}
  if(v.entities!==undefined){if(!Array.isArray(v.entities)||v.entities.length>128)return 'scene entity limit exceeded';const seen=new Set();for(const row of v.entities){const error=entityError(row);if(error)return error;if(seen.has(row.id))return 'duplicate entity ID';seen.add(row.id)}}
  if(v.timeline!==undefined)return desktopOverlayOpsError(v.timeline)
}
export function desktopOverlayControlError(mode:string,verb:string,raw:unknown):string|undefined {
  let args:unknown=raw??{}
  if(typeof args==='string'){if(bytes(args)>131072)return 'control JSON exceeds 128KiB';try{args=JSON.parse(args)}catch{return 'malformed control JSON'}}
  const allowed=(spec.controls as Record<string,Record<string,string[]>>)[mode]?.[verb]
  if(!allowed||!fields(args,allowed)||!desktopOverlayBounded(args,131072))return 'unknown or oversized controller argument'
  if(mode==='particles'){
    const bounds:Record<string,[number,number]>={'set-density':[0,128],'set-lifetime':[0.05,60],'set-velocity':[0,4096],'set-scale':[0.05,8]}
    if(bounds[verb]&&!num(args.value,...bounds[verb])||verb==='set-direction'&&!known(args.value,['up','down','left','right'])||verb==='set-emojis'&&!emoji(args.value)||args.count!==undefined&&!num(args.count,1,64))return 'invalid bounded particle argument'
  }
  if(mode==='scene'){
    if(args.who!==undefined&&!known(typeof args.who==='string'?args.who.toLowerCase():args.who,['kong','k','godzilla','g','gz'])||args.emoji!==undefined&&!emoji([args.emoji])||args.color!==undefined&&!color(args.color))return 'invalid fighter argument'
    for(const[k,lo,hi]of [['n',1,100000],['height',0,4096],['amount',0,1]] as const)if(args[k]!==undefined&&!num(args[k],lo,hi,k==='n'))return 'invalid finite fighter control'
  }
  if(verb==='say'&&args.text===undefined||args.text!==undefined&&!text(args.text,4096,true))return 'say requires bounded text'
  if(mode==='scene-script'){
    const parsed:Obj={...args};for(const k of ['ops','json','entity'])if(typeof parsed[k]==='string'){try{parsed[k]=JSON.parse(parsed[k] as string)}catch{return 'malformed nested scene JSON'}}
    const error=verb==='append-ops'?desktopOverlayOpsError(parsed.ops):verb==='append-script'?desktopOverlayScriptError(parsed.json):verb==='spawn'?entityError(parsed.entity):undefined
    if(error)return error
    if(verb==='despawn'&&!id(args.id)||args.relative!==undefined&&typeof args.relative!=='boolean'||args.fps!==undefined&&!num(args.fps,1,30))return 'invalid entity, relative or tracking argument'
  }
}
export function desktopOverlayActionError(a:Obj):string|undefined {
  if(a.type!=='desktop_overlay')return
  const shape=desktopContractShapeError(a,'DesktopOverlayAction');if(shape)return shape
  const sub=String(a.sub),allowed=(spec.selectors as Record<string,string[]>)[sub]
  if(!allowed||Object.keys(a).some(k=>!['type','sub','id','groupColor','groupSoft',...allowed].includes(k))||!desktopOverlayBounded(a))return 'unknown or oversized overlay request'
  if(a.id!==undefined&&!id(a.id)||sub==='list'&&a.id!==undefined||['eval','ctl'].includes(sub)&&!id(a.id))return 'overlay selector requires an exact safe ID'
  for(const k of ['interactive','single_space','no_fullscreen_aux','visible','groupSoft'])if(a[k]!==undefined&&typeof a[k]!=='boolean')return 'overlay flags require Boolean values'
  if(a.groupColor!==undefined&&!text(a.groupColor,128))return 'invalid group color'
  if(a.timeout_seconds!==undefined&&!num(a.timeout_seconds,0.001,sub==='eval'?30:86400))return 'invalid bounded overlay timeout'
  if(sub==='eval'&&((a.js!==undefined)===(a.javascript!==undefined)||!text(a.js??a.javascript,32768)))return 'eval requires one bounded JavaScript source'
  if(sub==='ctl'){
    if(typeof a.verb!=='string')return 'controller verb is required'
    const modes=Object.keys(spec.controls).filter(mode=>Object.hasOwn((spec.controls as Record<string,Record<string,string[]>>)[mode],String(a.verb)))
    if(!modes.length)return 'unknown controller verb'
    const errors=modes.map(mode=>desktopOverlayControlError(mode,String(a.verb),a.args));if(errors.every(Boolean))return errors[0]
  }
  if(sub!=='start')return
  const sources=['scene','scene_script','scene_script_file','particles','html_b64','url'].filter(k=>a[k]!==undefined)
  if(sources.length!==1||!text(a[sources[0]],['scene_script','html_b64'].includes(sources[0])?262144:4096))return 'start requires one bounded content source'
  if(a.scene!==undefined&&a.scene!=='titans'||a.particles!==undefined&&!known(a.particles,['roses','hearts','petals','stars','snow','confetti','titans','fire','beams','custom']))return 'unknown overlay preset'
  if(a.level!==undefined&&!known(a.level,['statusBar','mainMenu','floating','screenSaver'])||a.anchor!==undefined&&!known(a.anchor,['tl','tr','bl','br','top','bottom','left','right','center'])||a.direction!==undefined&&!known(a.direction,['up','down','left','right']))return 'unknown placement or direction'
  if(a.particles===undefined&&['emojis','density','direction','lifetime','velocity','size_scale'].some(k=>a[k]!==undefined)||a.emojis!==undefined&&!emoji(a.emojis))return 'invalid bounded particle settings'
  for(const[k,lo,hi]of [['density',0,128],['lifetime',0.05,60],['velocity',0,4096],['size_scale',0.05,8],['width',1,16384],['height',1,16384],['display_id',1,9007199254740991]] as const)if(a[k]!==undefined&&!num(a[k],lo,hi,k==='display_id'))return 'invalid finite bounded overlay '+k
  if(a.particles!==undefined&&Number(a.density??12)*Number(a.lifetime??5)>4096)return 'particle density/lifetime exceeds 4096'
  if(a.anchor===undefined&&a.rect===undefined&&(a.width!==undefined||a.height!==undefined)||a.rect!==undefined&&['anchor','width','height'].some(k=>a[k]!==undefined))return 'rectangle and anchor sizing are exclusive'
  if(a.rect!==undefined){const r=a.rect;if(!fields(r,['x','y','width','height'])||!num(r.width,1,16384)||!num(r.height,1,16384)||['x','y'].some(k=>r[k]!==undefined&&!num(r[k],-131072,131072)))return 'invalid overlay rectangle'}
  if(a.html_b64!==undefined){const data=Buffer.from(String(a.html_b64),'base64');if(data.toString('base64')!==a.html_b64||data.length>131072||Buffer.from(data.toString('utf8')).compare(data)!==0)return 'HTML requires canonical UTF8 base64 up to 128KiB'}
  if(a.url!==undefined){try{const u=new URL(String(a.url));if(!['http:','https:'].includes(u.protocol)||!u.hostname||u.username||u.password)return 'URL requires HTTP(S) without inline credentials'}catch{return 'invalid overlay URL'}}
  if(a.scene_script!==undefined){try{const error=desktopOverlayScriptError(JSON.parse(String(a.scene_script)));if(error)return error}catch{return 'malformed scene script'}}
  if(a.scene_script_file!==undefined&&!/^(?:\/|[A-Za-z]:[\\/])/.test(String(a.scene_script_file)))return 'scene script requires an absolute path'
}
export function desktopOverlayDeadline(a:Obj):number {
  if(!/^(?:desktop|macos)_overlay(?:_(?:start|stop|list|status|verbs|eval|ctl))?$/.test(String(a.type)))return 0
  const sub=String(a.sub??String(a.type).split('_').at(-1));return sub==='start'?40000:sub==='eval'?(typeof a.timeout_seconds==='number'&&num(a.timeout_seconds,0.001,30)?a.timeout_seconds*1000:10000)+5000:20000
}
export function desktopOverlayResultError(a:Obj,value:unknown):string|undefined {
  if(a.type!=='desktop_overlay')return
  if(!desktopOverlayBounded(value,131072))return 'overlay reply exceeds finite 128KiB JSON bound'
  const sub=String(a.sub),d=value as Obj
  const generation=(v:unknown)=>typeof v==='string'&&/^([a-f0-9]{64}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/.test(v)
  if(sub==='eval')return object(d)&&id(d.id)&&d.id===a.id&&generation(d.generation)&&Object.hasOwn(d,'result')?undefined:'overlay evaluation owner, generation or result identity differs'
  if(sub==='ctl')return object(d)&&d.ok===true?undefined:'overlay control did not acknowledge a native effect'
  if(sub==='list'&&Array.isArray(value))return validateViews(value)
  if(!object(d))return 'overlay reply requires an object'
  if(sub==='stop'){if(!Array.isArray(d.stopped)||d.stopped.some(v=>!id(v))||a.id!==undefined&&!d.stopped.includes(a.id)||!Array.isArray(d.nativeCleanupPending)||d.nativeCleanupPending.length)return 'overlay stop did not confirm owned cleanup';return}
  if(sub==='verbs'){if(!id(d.id)||a.id!==undefined&&d.id!==a.id||!Array.isArray(d.verbs)||d.verbs.some(v=>typeof v!=='string'||bytes(v)>64))return 'invalid overlay verb identities';return}
  return validateViews(sub==='list'?d.overlays:[d])
  function validateViews(rows:unknown):string|undefined {
  if(!Array.isArray(rows)||rows.length>16)return 'overlay owner inventory exceeds 16'
  const identities=new Set()
  for(const row of rows){
    if(!object(row)||!id(row.id)||!generation(row.generation)||identities.has(row.id)||a.id!==undefined&&row.id!==a.id)return 'overlay native owner identity differs'
    identities.add(row.id)
    if(row.lifecycle==='starting'||row.lifecycle==='retiring')continue
    if(!known(row.mode,['html','particles','scene','scene-script'])||!object(row.frame)||!num(row.frame.width,1,16384)||!num(row.frame.height,1,16384))return 'invalid actual overlay mode or frame'
    for(const k of ['x','y'])if(row.frame[k]!==undefined&&!num(row.frame[k],-131072,131072))return 'invalid actual overlay position'
    if(row.renderer!==undefined&&(!object(row.renderer)||row.mode!=='html'&&(!num(row.renderer.frames,0,Number.MAX_SAFE_INTEGER,true)||!num(row.renderer.nodeCount,0,2048,true))))return 'invalid renderer state readback'
  }
  }
}
