import {desktopContractShapeError} from './desktop-contract-validation'
import {DESKTOP_MONITOR_MAX_ENTRIES,DESKTOP_MONITOR_MAX_RESULT_BYTES,DESKTOP_MONITOR_MAX_SESSIONS,DESKTOP_MONITOR_MAX_ARCHIVE_BYTES,DESKTOP_CAPTURE_MAX_PIXELS,DESKTOP_MAX_RESULT_BYTES} from './desktop-contract'
import {DESKTOP_CONTRACT_FIELDS,type DesktopContractSchema} from './desktop-contract.generated'

// IDs name one archive directory, never a path. Browser and native IDs remain
// compatible; a requested ID cannot escape its provider's recording root.
export function desktopMonitorSessionId(value:unknown):value is string{
  return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}
export function desktopMonitorArchiveError(action:Record<string,unknown>):string|undefined{
  if(action.sid!==undefined&&!desktopMonitorSessionId(action.sid))return 'monitor --sid requires a safe archive identifier'
  if(action.limit!==undefined&&(!Number.isSafeInteger(action.limit)||Number(action.limit)<0||Number(action.limit)>DESKTOP_MONITOR_MAX_ENTRIES))return 'monitor --limit requires an integer in 0..1000'
}
export function desktopMonitorActionError(action:Record<string,unknown>):string|undefined{
  if(action.type!=='desktop_monitor')return
  const shape=desktopContractShapeError(Object.fromEntries(Object.entries(action).filter(([,value])=>value!==undefined)),'DesktopMonitorAction');if(shape)return shape
  const archive=desktopMonitorArchiveError(action);if(archive)return archive
  const sub=String(action.sub)
  if(sub==='export'&&action.sid===undefined)return 'monitor export requires --sid'
  if(action.limit!==undefined&&!['tail','list'].includes(sub))return 'monitor --limit requires tail or list'
  if(sub==='start'&&action.sid!==undefined)return 'monitor start creates its own session identifier'
  if([action.app,action.apps,action.allApps===true?true:undefined].filter(v=>v!==undefined).length>1)return 'monitor app, apps and all-apps scopes are mutually exclusive'
  const bounds:Record<string,[number,number]>={frames:[0,60],frameQuality:[0,100],frameMaxLongEdge:[0,16384],video:[1,60],videoMaxBytes:[0,10737418240],frameBudget:[0,1000000],frameDiskCap:[0,10737418240],framePixelScale:[1,16],scrollCoalesceMs:[0,60000],axCoalesceMs:[0,60000]}
  for(const [key,[min,max]]of Object.entries(bounds))if(action[key]!==undefined&&(!Number.isSafeInteger(action[key])||Number(action[key])<min||Number(action[key])>max))return `monitor ${key} requires an integer in ${min}..${max}`
  for(const key of ['app','instruction','watchPath','logPredicate','taskId','taskRef','retentionPolicyId','guardPolicyId','verifierPolicyId']){
    const value=action[key];if(typeof value==='string'&&(!value.trim()||value.includes('\0')||Buffer.byteLength(value)>32768))return `monitor ${key} requires bounded nonempty text without NUL`
  }
  for(const key of ['apps','include','exclude','watchPaths','excludeApps']){
    const values=action[key] as string[]|undefined
    if(values&&(values.length===0||values.length>64||new Set(values).size!==values.length||values.some(v=>!v.trim()||v.includes('\0')||Buffer.byteLength(v)>32768)))return `monitor ${key} requires 1..64 unique bounded nonempty values`
  }
  const startKeys=['instruction','app','apps','allApps','include','exclude','frames','visionText','frameFormat','frameQuality','frameMaxLongEdge','tap','watchPath','watchPaths','logPredicate','speechMode','video','videoMaxBytes','frameBudget','frameDiskCap','framePixelScale','scrollCoalesceMs','axCoalesceMs','includeSystemApps','excludeApps','taskId','taskMode','retentionPolicyId','guardPolicyId','verifierPolicyId']
  if(sub!=='start'&&startKeys.some(key=>action[key]!==undefined))return 'monitor recording options require start'
}

export function desktopMonitorResultError(action:Record<string,unknown>,data:unknown):string|undefined{
  if(action.type!=='desktop_monitor')return
  if(Buffer.byteLength(JSON.stringify(data)??'')>DESKTOP_MONITOR_MAX_RESULT_BYTES)return 'monitor reply exceeds 1MiB'
  const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
  const counter=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
  const identity=(r:Record<string,unknown>)=>desktopMonitorSessionId(r.sid)&&(action.sid===undefined||action.sid===r.sid)
  const coverage=(r:Record<string,unknown>)=>r.surface==='macos'&&process.platform==='darwin'||r.surface==='desktop'&&r.host===process.platform&&typeof r.partial==='boolean'&&Array.isArray(r.coverage)&&r.coverage.length>0&&r.coverage.length<=64&&r.partial===r.coverage.some((v:unknown)=>object(v)&&v.available===false)
  const counts=(r:Record<string,unknown>)=>object(r.counts)&&Object.values(r.counts).every(counter)
  const recording=(r:Record<string,unknown>)=>identity(r)&&coverage(r)&&counts(r)&&typeof r.duration==='number'&&r.duration>=0
  const sub=String(action.sub)
  if(sub==='tail'||sub==='export'&&(action.format??'timeline')==='json'){
    if(!Array.isArray(data)||data.length>Number(sub==='tail'?action.limit??50:DESKTOP_MONITOR_MAX_ENTRIES))return 'monitor event count exceeds its requested bound'
    let previous=-1,previousTime=-Infinity,sid:unknown
    for(const row of data){
      if(!object(row))return 'monitor event must be an object'
      const header=Object.fromEntries(['sid','s','t','event','timestamp','taskId'].filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]]))
      const error=desktopContractShapeError(header,'DesktopMonitorEventHeader');if(error)return error
      if(!identity(row)||!counter(row.s)||!counter(row.t)||Number(row.s)<=previous||Number(row.t)<previousTime||!row.event||String(row.event).length>128||sid!==undefined&&sid!==row.sid)return 'monitor event identity/order is invalid'
      const payloadError=desktopMonitorEventPayloadError(row,process.platform==='darwin'?'macos':'native');if(payloadError)return payloadError
      previous=Number(row.s);previousTime=Number(row.t);sid=row.sid
    }
    return
  }
  if(sub==='export')return typeof data==='string'?undefined:'monitor timeline/plan requires text'
  if(sub==='list'){
    if(!Array.isArray(data)||data.length>Number(action.limit??DESKTOP_MONITOR_MAX_ENTRIES))return 'monitor history count exceeds its requested bound'
    const ids=new Set<unknown>()
    for(const row of data){const error=desktopContractShapeError(row,'DesktopMonitorArchiveData');if(error)return error
      if(!object(row)||!identity(row)||row.sessionId!==row.sid||ids.has(row.sid)||!counter(row.startedAt)||!counter(row.artifactVersion)||!counts(row)||!coverage(row))return 'monitor archive identity/coverage is invalid';ids.add(row.sid)
      {
        const text=(v:unknown)=>typeof v==='string'&&!!v.trim()&&!v.includes('\0')&&Buffer.byteLength(v)<=32768
        const names=(v:unknown)=>Array.isArray(v)&&v.length<=64&&new Set(v).size===v.length&&v.every(text)
        const scope=row.scope as Record<string,unknown>,apps=scope.apps??[],attachments=row.attachments as Record<string,unknown>[]
        if(row.artifactVersion!==1||row.surface==='macos'&&!object(row.tcc)||row.endedAt!==undefined&&(!counter(row.endedAt)||Number(row.endedAt)<Number(row.startedAt))||row.status==='active'&&(row.endedAt!==undefined||row.stopReason!==undefined)||row.status==='stopped'&&row.endedAt===undefined)return 'monitor archive lifecycle is invalid'
        if(Object.values(row.counts as Record<string,unknown>).some(value=>Number(value)>Number((row.counts as Record<string,unknown>).evt)))return 'monitor archive counters are invalid'
        if(!names(apps)||scope.mode==='apps'&&(apps as unknown[]).length===0||scope.mode!=='apps'&&(apps as unknown[]).length>0||!names(row.includes)||!names(row.excludes))return 'monitor archive scope is invalid'
        const pid=(v:unknown)=>counter(v)&&Number(v)>0&&Number(v)<=(row.surface==='macos'?2147483647:4294967295)
        if(row.rootPid!==undefined&&!pid(row.rootPid)||attachments.length>DESKTOP_MONITOR_MAX_ENTRIES||attachments.some(v=>!pid(v.pid)||v.key!=='pid:'+v.pid||!counter(v.attachedAt)||v.detachedAt!==undefined&&(!counter(v.detachedAt)||Number(v.detachedAt)<Number(v.attachedAt))||!names(v.axNotifications)))return 'monitor archive attachments are invalid'
        if(['instruction','taskId','taskActorAtAttach','taskSourceSnapshotRoot','stopReason'].some(key=>row[key]!==undefined&&!text(row[key])))return 'monitor archive text is invalid'
        if(row.taskAttachedAt!==undefined&&!counter(row.taskAttachedAt)||row.taskDetachedAt!==undefined&&(!counter(row.taskDetachedAt)||row.taskAttachedAt===undefined||Number(row.taskDetachedAt)<Number(row.taskAttachedAt)))return 'monitor archive task timestamps are invalid'
        if(row.surface==='desktop'){
          const entries=row.coverage as Record<string,unknown>[]
          if(row.provider!=='interceptor-desktop-rust'||!pid(row.providerPid)||!text(row.login)||entries.some(value=>!text(value.source))||new Set(entries.map(value=>value.source)).size!==entries.length||row.status==='active'&&(entries.length>63||entries.some(value=>value.source==='recovery')))return 'monitor native archive provider/coverage is invalid'
        }
      }
    }
    return
  }
  let schema:DesktopContractSchema=sub==='start'?'DesktopMonitorStartData':sub==='stop'?'DesktopMonitorStopData':'DesktopMonitorPauseData'
  if(sub==='status')schema=object(data)&&data.status==='idle'?'DesktopMonitorIdleData':object(data)&&Array.isArray(data.sessions)?'DesktopMonitorSessionsData':'DesktopMonitorStatusData'
  const error=desktopContractShapeError(data,schema);if(error)return error
  const r=data as Record<string,unknown>
  if(schema==='DesktopMonitorIdleData')return action.sid===undefined?undefined:'explicit monitor status cannot return idle'
  if(schema==='DesktopMonitorSessionsData'){
    const rows=r.sessions as Record<string,unknown>[]
    if(action.sid!==undefined||!counter(r.activeCount)||r.activeCount!==rows.length||rows.length>DESKTOP_MONITOR_MAX_SESSIONS||new Set(rows.map(v=>v.sid)).size!==rows.length||rows.some(v=>!recording(v)))return 'monitor active sessions identity/count is invalid'
    return
  }
  if(!identity(r))return 'monitor reply sid differs from its request'
  if(sub==='start'&&(r.status!=='recording'||!coverage(r)||!counter(r.activeCount)||Number(r.activeCount)<1||Number(r.activeCount)>DESKTOP_MONITOR_MAX_SESSIONS||typeof r.sessionDir!=='string'||!r.sessionDir.endsWith(String(r.sid))))return 'monitor start identity/coverage/count is invalid'
  if(sub==='status'&&!recording(r))return 'monitor recording status is invalid'
  if(sub==='pause'&&r.status!=='paused'||sub==='resume'&&r.status!=='recording')return 'monitor lifecycle state differs from its request'
  if(sub==='stop'&&(['evt','mut','net','nav','ax'].some(k=>!counter(r[k]))||Number(r.duration)<0||!r.reason))return 'monitor stop summary is invalid'
}

export function desktopMonitorEventPayloadError(row:Record<string,unknown>,surface:'native'|'macos'='native'):string|undefined{
  const registry=surface==='macos'?DESKTOP_CONTRACT_FIELDS.DesktopMonitorMacPayloadSchemas:DESKTOP_CONTRACT_FIELDS.DesktopMonitorNativePayloadSchemas
  const schema=registry.find(field=>field.name===row.event)?.type as DesktopContractSchema|undefined
  if(!schema)return
  const payload=Object.fromEntries(Object.entries(row).filter(([key])=>!['sid','s','t','event','timestamp','taskId'].includes(key)))
  const error=desktopContractShapeError(payload,schema);if(error)return error
  const counter=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
  if(surface==='macos'){
    for(const key of ['evt','mut','net','nav','ax','changeCount','sl','samples','coalesced','replayBuffers','index','bytes','frames','frameBudget','diskCapBytes','quality','w','h','fps'])if(typeof row[key]==='number'&&(!counter(row[key])||['samples','coalesced','index','w','h','fps'].includes(key)&&Number(row[key])===0))return 'monitor Mac payload counter is invalid'
    for(const key of ['duration','durationSec'])if(typeof row[key]==='number'&&Number(row[key])<0)return 'monitor Mac payload duration is invalid'
    for(const key of ['path','archived'])if(typeof row[key]==='string'&&(!row[key].trim()||row[key].includes('\0')))return 'monitor Mac payload path is invalid'
    if(row.pid!==undefined&&(!counter(row.pid)||Number(row.pid)===0||Number(row.pid)>2147483647))return 'monitor Mac payload pid is invalid'
    if(row.event==='mon_start'){
      const scope=row.scope as Record<string,unknown>
      if(scope.mode==='apps'&&(!Array.isArray(scope.apps)||!scope.apps.length)||Array.isArray(scope.apps)&&scope.apps.some(v=>typeof v!=='string'||!v.trim()||v.includes('\0')))return 'monitor Mac payload scope is invalid'
    }
    if(schema==='DesktopMonitorMacAxPayload'){
      const frame=row.frame as Record<string,number>|undefined
      if(row.v!==undefined&&row.event!=='input'||row.sl!==undefined&&row.event!=='selection'||row.coalesced!==undefined&&!['input','layout_change'].includes(String(row.event))||row.notification!==undefined&&row.event!=='ax_other'||row.event==='ax_other'&&typeof row.notification!=='string'||['window_create','window_move','window_resize'].includes(String(row.event))!==Object.hasOwn(row,'frame')||frame&&(Object.values(frame).some(v=>!Number.isSafeInteger(v))||frame.w<0||frame.h<0)||row.event==='input'&&(row.r==='AXSecureTextField'||row.sr==='AXSecureTextField')&&row.v!=='***SECURE***')return 'monitor Mac AX payload identity/privacy is invalid'
    }
    if(schema==='DesktopMonitorMacWorkspacePayload'&&['app','bundleId','pid'].some(key=>Object.hasOwn(row,key))&&!['app','bundleId','pid'].every(key=>Object.hasOwn(row,key)))return 'monitor Mac workspace identity is incomplete'
    if(Object.hasOwn(row,'tr')&&(row.tr!==true||!row.app&&!row.bundleId||row.tap!==undefined&&row.tap!==true||row.tap===true&&(!Object.hasOwn(row,'x')||!Object.hasOwn(row,'y'))||['x','y'].some(key=>row[key]!==undefined&&!Number.isSafeInteger(row[key]))))return 'monitor Mac input identity/coordinates are invalid'
    if(typeof row.quality==='number'&&row.quality>100||row.event==='video_start'&&Number(row.fps)>60)return 'monitor Mac media options are invalid'
    if(row.event==='ocr_text'){
      const blocks=row.blocks as {confidence:number;rect:Record<string,number>}[]
      if(!String(row.frame).trim()||String(row.frame).includes('\0')||blocks.length>64||blocks.some(b=>b.confidence<0||b.confidence>1||Object.values(b.rect).some(v=>v<0||v>1)))return 'monitor Mac OCR payload is invalid'
    }
    return
  }
  if(['frame','frame_budget_reached','frame_error'].includes(String(row.event))){
    for(const key of ['w','h','bytes','quality','frames','frameBudget','diskCapBytes'])if(row[key]!==undefined&&(!counter(row[key])||['w','h'].includes(key)&&Number(row[key])===0))return 'monitor native frame counter is invalid'
    if(row.path!==undefined&&(typeof row.path!=='string'||!row.path.trim()||row.path.includes('\0'))||Number(row.quality)>100)return 'monitor native frame path/options are invalid'
    if(row.event==='frame'&&(Number(row.bytes)===0||Number(row.bytes)>DESKTOP_MAX_RESULT_BYTES||Number(row.w)*Number(row.h)>DESKTOP_CAPTURE_MAX_PIXELS)||row.event==='frame_budget_reached'&&(Number(row.frameBudget)<1||Number(row.frameBudget)>1000000||Number(row.frames)>Number(row.frameBudget)||Number(row.diskCapBytes)<1||Number(row.diskCapBytes)>DESKTOP_MONITOR_MAX_ARCHIVE_BYTES||Number(row.bytes)>Number(row.diskCapBytes)))return 'monitor native frame budget/dimensions are invalid'
  }else if(row.event==='mon_start'){
    const coverage=row.coverage as Record<string,unknown>[],scope=row.scope as Record<string,unknown>
    if(!coverage.length||coverage.length>64||row.partial!==coverage.some(r=>r.available===false)||scope.mode==='apps'&&(!Array.isArray(scope.apps)||!scope.apps.length))return 'monitor start payload coverage/scope is invalid'
  }else if(row.event==='file_change'){
    if(!(row.path as string).trim()||(row.path as string).includes('\0'))return 'monitor file payload path is invalid'
  }else if(row.event==='clipboard_change'){
    if(!counter(row.changeCount))return 'monitor clipboard payload change identity is invalid'
  }else if(schema==='DesktopMonitorNativeObservationPayload'){
    const ax=['input','focus','selection','menu_open','menu_close','title_change','layout_change','ax_other'].includes(String(row.event))
    const frame=row.frame as Record<string,number>|undefined
    if(row.source!==(ax?'ax':'workspace')||!counter(row.pid)||Number(row.pid)===0||Number(row.pid)>4294967295||!row.r||row.event==='input'!==Object.hasOwn(row,'v')||row.secure===true&&(row.n!=='***SECURE***'||row.event==='input'&&row.v!=='***SECURE***')||frame&&(frame.width<0||frame.height<0)||typeof row.windowId==='number'&&(!counter(row.windowId)||row.windowId===0)||typeof row.windowId==='string'&&!row.windowId)return 'monitor observation payload identity/privacy is invalid'
  }else if(row.event==='source_error'){
    if(row.source==='native_observation'?!counter(row.dropped)||Number(row.dropped)===0:(row.error as Record<string,unknown>).success!==false)return 'monitor source error payload is invalid'
  }
}
