import {desktopContractShapeError} from './desktop-contract-validation'
import {DESKTOP_SPEECH_MAX_TRANSCRIPT_BYTES,DESKTOP_SPEECH_MAX_VOCABULARY_WORDS} from './desktop-contract'

export function desktopSpeechActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_listen')return
  const shape=desktopContractShapeError(a,'DesktopSpeechAction');if(shape)return shape
  if(a.device!==undefined&&(a.sub!=='start'||typeof a.device!=='string'||!a.device.trim()||a.device.includes('\0')||Buffer.byteLength(a.device)>4096))return 'speech device requires start and one bounded native device identity'
  if(a.sub!=='vocab'&&(a.op!==undefined||a.word!==undefined))return 'speech vocabulary fields require vocab'
  if(a.sub==='vocab'&&((a.op??'list')==='add'?typeof a.word!=='string'||!a.word.trim()||a.word.includes('\0')||Buffer.byteLength(a.word)>4096:a.word!==undefined))return 'vocab add requires one bounded word; clear/list accept none'
  for(const key of ['group','groupColor'])if(a[key]!==undefined&&(typeof a[key]!=='string'||!a[key].trim()||Buffer.byteLength(a[key])>256||a[key].includes('\0')))return 'invalid speech group text'
}
export function desktopSpeechResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_listen')return
  const text=(v:unknown,limit=DESKTOP_SPEECH_MAX_TRANSCRIPT_BYTES)=>typeof v==='string'&&!v.includes('\0')&&Buffer.byteLength(v)<=limit
  if(a.sub==='transcript')return text(data)?undefined:'invalid bounded speech transcript'
  if(a.sub==='vocab'){
    if((a.op??'list')==='list')return Array.isArray(data)&&data.length<=DESKTOP_SPEECH_MAX_VOCABULARY_WORDS&&data.every(v=>text(v,4096)&&v.trim())&&data.reduce((n,v)=>n+Buffer.byteLength(v),0)<=32768?undefined:'invalid vocabulary list'
    if(a.op==='clear')return data==='vocabulary cleared'?undefined:'invalid vocabulary clear acknowledgement'
    const shape=desktopContractShapeError(data,'DesktopSpeechVocabularyAdded');if(shape)return shape
    const row=data as Record<string,unknown>;return row.added===a.word&&Number.isSafeInteger(row.total)&&Number(row.total)>=1&&Number(row.total)<=DESKTOP_SPEECH_MAX_VOCABULARY_WORDS?undefined:'invalid vocabulary addition acknowledgement'
  }
  const shape=desktopContractShapeError(data,['stop','tail'].includes(String(a.sub))?'DesktopSpeechSnapshot':'DesktopSpeechStatus');if(shape)return shape
  const row=data as Record<string,unknown>
  if(a.sub==='start'&&row.listening!==true||a.sub==='stop'&&row.listening!==false)return 'speech lifecycle reply contradicts its operation'
  if(['stop','tail'].includes(String(a.sub))&&!text(row.transcript))return 'invalid bounded speech transcript'
}
