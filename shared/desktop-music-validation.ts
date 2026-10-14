import {desktopContractShapeError} from './desktop-contract-validation'
import type {DesktopContractSchema} from './desktop-contract.generated'
const fields:Record<string,string[]>={status:[],request:[],subscription:[],library:['kind','limit','offset','filter','sort','ascending','include_tracks'],'library-search':['term','types','limit','top','include_tracks'],play:['song','album','playlist'],pause:[],resume:[],stop:[],next:[],previous:[],seek:['time'],queue:[],repeat:['mode'],shuffle:['mode'],'now-playing':['include_system'],search:['term','types','limit','offset','top'],'search-suggest':['term'],charts:['limit'],recommendations:[],song:['id'],album:['id'],artist:['id'],playlist:['id']}
export function desktopMusicActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_music')return
  const shape=desktopContractShapeError(a,'DesktopMusicAction');if(shape)return shape
  const sub=String(a.sub),allowed=fields[sub]
  const bounded=(value:unknown,max:number)=>typeof value==='string'&&value.trim().length>0&&Buffer.byteLength(value)<=max&&!value.includes('\0')
  for(const key of Object.keys(a))if(!['type','sub','group','groupColor','groupSoft',...allowed].includes(key))return 'field does not belong to music '+sub
  for(const key of ['group','groupColor'])if(a[key]!==undefined&&!bounded(a[key],256))return 'invalid music group metadata'
  for(const key of ['term','filter'])if(a[key]!==undefined&&!bounded(a[key],4096))return 'invalid bounded music search text'
  if(['library-search','search','search-suggest'].includes(sub)&&!bounded(a.term,4096))return 'music '+sub+' requires its term'
  if(['song','album','artist','playlist'].includes(sub)&&!bounded(a.id,1024))return 'music '+sub+' requires its Apple Music catalog id'
  for(const [key,min,max]of [['limit',1,100],['offset',0,10000],['time',0,604800]]as const)if(a[key]!==undefined&&(typeof a[key]!=='number'||!Number.isFinite(a[key])||a[key]<min||a[key]>max||(key!=='time'&&!Number.isSafeInteger(a[key]))))return 'invalid bounded numeric music '+key
  if(sub==='seek'&&a.time===undefined)return 'music seek requires a numeric time'
  if(a.types!==undefined&&(typeof a.types!=='string'||Buffer.byteLength(a.types)>128||a.types.split(',').some(s=>!['song','album','artist','playlist'].includes(s.trim()))))return 'invalid music search types'
  if(a.sort!==undefined&&!['title','name','artistName'].includes(String(a.sort)))return 'unknown native music sort field'
  if(sub==='library'&&a.sort!==undefined&&(['artist','playlist'].includes(String(a.kind??'song'))?a.sort!=='name':!['title','artistName'].includes(String(a.sort))))return 'music sort does not belong to its library kind'
  if(sub==='library'&&a.include_tracks===true&&!['album','playlist'].includes(String(a.kind??'song')))return 'music include-tracks requires an album or playlist library'
  if(a.ascending!==undefined&&a.sort===undefined)return 'music ascending requires its sort field'
  if(sub==='play'){const targets=['song','album','playlist'].filter(key=>a[key]!==undefined);if(targets.length!==1||!bounded(a[targets[0]],1024))return 'music play requires exactly one bounded library song, album or playlist id'}
  if(sub==='repeat'&&!['off','one','all'].includes(String(a.mode)))return 'invalid music repeat mode'
  if(sub==='shuffle'&&!['off','songs'].includes(String(a.mode)))return 'invalid music shuffle mode'
}
export function desktopMusicResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_music')return
  const row=data as Record<string,any>
  if(!row||typeof row!=='object'||Array.isArray(row))return 'music reply requires an object'
  let nodes=16384
  const valid=(v:unknown,depth=0):boolean=>--nodes>=0&&depth<=16&&(typeof v==='string'?Buffer.byteLength(v)<=4096&&!v.includes('\0'):typeof v==='number'?Number.isFinite(v):Array.isArray(v)?v.length<=2000&&v.every(child=>valid(child,depth+1)):v!==null&&typeof v==='object'?Object.values(v).every(child=>valid(child,depth+1)):v===null||typeof v==='boolean')
  if(!valid(data)||Buffer.byteLength(JSON.stringify(data))>1_048_576)return 'music reply exceeds bounded text, nesting, collection or byte limits'
  const sub=String(a.sub),schema=row.available!==undefined?'DesktopMusicUnavailable':({status:'DesktopMusicStatus',request:'DesktopMusicAuthorization',subscription:'DesktopMusicSubscription',library:'DesktopMusicLibrary','library-search':'DesktopMusicSearch',search:'DesktopMusicSearch','search-suggest':'DesktopMusicSuggestions',charts:'DesktopMusicCharts',recommendations:'DesktopMusicRecommendations',song:'DesktopMusicItem',album:'DesktopMusicItem',artist:'DesktopMusicItem',playlist:'DesktopMusicItem',queue:'DesktopMusicQueue',repeat:'DesktopMusicRepeat',shuffle:'DesktopMusicShuffle','now-playing':'DesktopMusicPlaying'}as Record<string,DesktopContractSchema>)[sub]??'DesktopMusicAck'
  const shape=desktopContractShapeError(data,schema);if(shape)return shape
  if(row.available!==undefined&&row.available!==false)return 'unavailable Music reply cannot claim availability'
  if(row.ok!==undefined&&row.ok!==true)return 'successful Music control reply requires native acceptance'
  const item=(v:any):boolean=>typeof v.id==='string'&&v.id.length>0&&Buffer.byteLength(v.id)<=1024&&(['title','name'].some(key=>typeof v[key]==='string'))&&(v.tracks===undefined||v.tracks.length<=2000&&v.tracks.every(item))
  if(sub==='library'&&row.items&&(row.items.length>Number(a.limit??32)||row.items.some((v:any)=>!item(v))))return 'invalid bounded observed music library'
  if(['library-search','search'].includes(sub)&&row.term!==undefined&&(row.term!==a.term||['songs','albums','artists','playlists',...(row.topResults!==undefined?['topResults']:[])].some(key=>row[key].length>Number(a.limit??32)||row[key].some((v:any)=>!item(v)))))return 'invalid music search identity or bounds'
  if(row.entries&&(row.entries.length>2000||row.count!==row.entries.length||row.entries.some((v:any)=>!item(v))))return 'invalid observed music queue'
  if(row.currentEntry&&!item(row.currentEntry))return 'invalid observed current music entry'
  if(row.system){
    if(row.system.running===false&&Object.keys(row.system).some(key=>key!=='running'))return 'closed system player cannot claim observed playback state'
    if(row.system.running===true&&(typeof row.system.status!=='string'||!row.system.status))return 'running system player requires observed native status'
    if(row.system.currentEntry&&!item(row.system.currentEntry))return 'invalid observed system music entry'
    if(row.system.playbackTime!==undefined&&(!Number.isFinite(row.system.playbackTime)||row.system.playbackTime<0))return 'invalid observed system music position'
  }
  for(const key of ['playbackTime','playbackRate','queueLength'])if(row[key]!==undefined&&row[key]!==null&&(!Number.isFinite(row[key])||row[key]<0))return 'invalid observed music playback state'
  if(row.queueLength!==undefined&&(!Number.isSafeInteger(row.queueLength)||row.queueLength>2000))return 'invalid bounded music queue length'
}
