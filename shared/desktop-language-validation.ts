import {isAbsolute,win32} from 'node:path'
import {DESKTOP_LANGUAGE_MAX_TEXT_BYTES} from './desktop-contract'
import {desktopContractShapeError} from './desktop-contract-validation'
import {DESKTOP_LANGUAGE_OPERATIONS,type DesktopContractSchema} from './desktop-contract.generated'

const operations:readonly string[]=DESKTOP_LANGUAGE_OPERATIONS
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&!v.includes('\0')&&Buffer.byteLength(v)<=DESKTOP_LANGUAGE_MAX_TEXT_BYTES
const language=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(v)
const detectorKinds=['link','phoneNumber','calendarEvent','postalAddress','email','transit','moneyAmount','flightNumber','shipmentTrackingNumber','measurement','paymentIdentifier']
const detectorAliases:Record<string,string>={link:'link',url:'link',phone:'phoneNumber',phoneNumber:'phoneNumber',date:'calendarEvent',calendarEvent:'calendarEvent',address:'postalAddress',postalAddress:'postalAddress',email:'emailAddress',emailAddress:'emailAddress',transit:'transit',moneyAmount:'moneyAmount',flightNumber:'flightNumber',shipmentTrackingNumber:'shipmentTrackingNumber',measurement:'measurement',paymentIdentifier:'paymentIdentifier'}
export function desktopLanguageActionError(a:Record<string,unknown>):string|undefined{
  if(!operations.includes(String(a.type)))return
  const shape=desktopContractShapeError(a,({desktop_nlp:'DesktopLanguageNlpAction',desktop_ai:'DesktopLanguageAiAction',desktop_translate:'DesktopLanguageTranslateAction',desktop_detect:'DesktopLanguageDetectAction'} as Record<string,DesktopContractSchema>)[String(a.type)])
  if(shape)return shape
  let fields:string[]=['type','sub','group','groupColor','groupSoft']
  if(['group','groupColor'].some(key=>a[key]!==undefined&&(String(a[key]).length<1||Buffer.byteLength(String(a[key]))>256||String(a[key]).includes('\0'))))return 'invalid native request group metadata'
  if(a.type==='desktop_nlp'){
    if(a.sub==='similar'){
      if(!text(a.word1)||!text(a.word2)||a.text!==undefined&&a.text!==a.word1)return 'similar requires two bounded words'
      fields.push('word1','word2','text')
    }else{if(!text(a.text))return 'NLP requires bounded nonempty text';fields.push('text')}
  }else if(a.type==='desktop_ai'){
    if(a.sub==='prompt'){if(!text(a.prompt))return 'prompt requires bounded nonempty text';fields.push('prompt')}
    if(a.sub==='session'){
      if(a.op===undefined)return 'session requires start/send/history/end'
      fields.push('op')
      if(a.op==='send'){if(!text(a.message))return 'session send requires bounded nonempty text';fields.push('message')}
    }
  }else if(a.type==='desktop_detect'){
    if(a.sub!=='types'){
      if(a.sub==='file'){
        if(typeof a.path!=='string'||!a.path||a.path.includes('\0')||Buffer.byteLength(a.path)>32768||!(a.path.startsWith('~/')||(process.platform==='win32'?win32.isAbsolute(a.path):isAbsolute(a.path))))return 'detection file requires an absolute path'
        fields.push('path')
      }else{if(!text(a.input))return 'detection requires bounded nonempty input';fields.push('input')}
      fields.push('types')
      if(a.types!==undefined&&(Buffer.byteLength(String(a.types))>256||String(a.types)!=='all'&&!String(a.types).split(',').every(v=>Object.hasOwn(detectorAliases,v.trim()))))return 'unsupported data detection type'
    }
  }else if(!['status','languages','stop'].includes(String(a.sub))){
    if(!language(a.to)||a.from!==undefined&&!language(a.from))return 'translation requires language tags and --to'
    fields.push('from','to')
    if(a.sub==='prepare'&&!language(a.from))return 'prepare requires --from and --to'
    if(a.sub==='availability'){
      if((a.from===undefined)===(a.sample===undefined)||a.sample!==undefined&&!text(a.sample))return 'availability requires exactly one source language or sample'
      fields.push('sample')
    }
    if(a.sub==='text'){if(!text(a.input))return 'translation requires bounded nonempty input';fields.push('input')}
    if(a.sub==='file'){
      if(typeof a.path!=='string'||!a.path||a.path.includes('\0')||Buffer.byteLength(a.path)>32768||!(a.path.startsWith('~/')||(process.platform==='win32'?win32.isAbsolute(a.path):isAbsolute(a.path))))return 'translation file requires an absolute path'
      fields.push('path')
    }
    if(a.sub==='batch'){
      let rows:unknown;try{rows=JSON.parse(String(a.json))}catch{return 'batch requires a JSON array of strings'}
      if(!Array.isArray(rows)||rows.length<1||rows.length>32||!rows.every(text)||rows.reduce((n,v)=>n+Buffer.byteLength(v),0)>DESKTOP_LANGUAGE_MAX_TEXT_BYTES)return 'batch requires 1..32 nonempty strings totaling at most 64 KiB'
      fields.push('json')
    }
  }
  const extra=Object.keys(a).find(key=>!fields.includes(key))
  if(extra)return `--${extra.replace(/_/g,'-')} is not accepted by ${String(a.type).replace(/^(desktop|macos)_/,'')} ${String(a.sub)}`
}
export function desktopLanguageResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(!operations.includes(String(a.type)))return
  const r=data as Record<string,unknown>
  const shape=(schema:DesktopContractSchema)=>desktopContractShapeError(data,schema)
  const vector=(v:unknown):v is number[]=>Array.isArray(v)&&v.length>0&&v.length<=16384&&v.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=1e6)
  if(a.type==='desktop_nlp'){
    if(a.sub==='tokens'){
      const error=shape('string[]' as DesktopContractSchema);if(error)return error
      if(!(data as string[]).every(s=>s.length>0&&String(a.text).includes(s)))return 'token output is not grounded in input'
    }else if(a.sub==='entities'){
      const error=shape('DesktopLanguageEntity[]' as DesktopContractSchema);if(error)return error
      const rows=data as {text:string;type:string}[]
      if(rows.length>1024||rows.some(row=>!row.text||!String(a.text).includes(row.text)||!['PersonalName','PlaceName','OrganizationName'].includes(row.type)))return 'entity output is not grounded in input'
    }else if(a.sub==='language'){
      const error=shape('DesktopLanguageDetection');if(error)return error
      const rows=r.hypotheses as {language:string;confidence:number|null}[]
      if(!language(r.dominant)||rows.length<1||rows.length>5||rows[0].language!==r.dominant||rows.some(h=>!language(h.language)||h.confidence!==null&&(h.confidence<0||h.confidence>1)))return 'invalid language hypotheses'
    }else if(a.sub==='sentiment'){
      const error=shape('DesktopLanguageSentiment');if(error)return error
      const score=r.score as number
      if(score<-1||score>1||r.label!==(score>0.1?'positive':score < -0.1?'negative':'neutral'))return 'sentiment label differs from score'
    }else if(a.sub==='embed'){
      const error=shape('DesktopLanguageEmbedding');if(error)return error
      if(!vector(r.vector)||r.dimensions!==r.vector.length)return 'invalid embedding dimensions or values'
    }else{
      const error=shape('DesktopLanguageSimilarity');if(error)return error
      if(r.word1!==a.word1||r.word2!==a.word2||Number(r.distance)<0||Number(r.distance)>2)return 'similarity output differs from input or cosine distance range'
    }
  }else if(a.type==='desktop_ai'){
    if(a.sub==='status')return shape('DesktopLanguageStatus')
    if(a.sub==='prompt'){if(!text(data))return 'AI output is empty or oversized';return}
    if(a.op==='start'){const error=shape('DesktopLanguageSessionStart');return error??(r.sessionActive===true?undefined:'AI session did not start')}
    if(a.op==='end'){const error=shape('DesktopLanguageSessionEnd');return error??(r.sessionEnded===true&&Number.isSafeInteger(r.turns)&&Number(r.turns)>=0&&Number(r.turns)<=96?undefined:'invalid AI session end')}
    if(a.op==='send'){const error=shape('DesktopLanguageSessionResponse');return error??(text(r.response)?undefined:'invalid AI session response')}
    const error=shape('DesktopLanguageMessage[]' as DesktopContractSchema);if(error)return error
    const rows=data as {role:string;content:string}[]
    if(rows.length>96||rows.length%2!==0||Buffer.byteLength(JSON.stringify(rows))>524288||rows.some((row,i)=>row.role!==(i%2===0?'user':'assistant')||!text(row.content)))return 'invalid AI session history'
  }else if(a.type==='desktop_detect'){
    if(a.sub==='types'){
      const error=shape('DesktopLanguageDetectorTypes');if(error)return error
      if(JSON.stringify(r.types)!==JSON.stringify(detectorKinds))return 'unexpected detector type list'
      return
    }
    const error=shape('DesktopLanguageDetected');if(error)return error
    if(!text(r.input)||a.sub!=='file'&&r.input!==a.input)return 'detector input differs from request'
    const selected=a.types===undefined||a.types==='all'?detectorKinds.filter(v=>v!=='transit').map(v=>detectorAliases[v]):String(a.types).split(',').map(v=>detectorAliases[v.trim()])
    const rows=r.matches as {range:number[];value:string;type:string;components?:Record<string,string|number|string[]>}[]
    if(rows.length>1024)return 'too many detector matches'
    let last=-1;const seen=new Set<string>()
    for(const row of rows){
      const [start,length]=row.range,key=JSON.stringify([start,length,row.type]),components=row.components??{}
      if(!selected.includes(row.type)||row.range.length!==2||!Number.isSafeInteger(start)||!Number.isSafeInteger(length)||start<0||length<1||start<last||(r.input as string).slice(start,start+length)!==row.value||seen.has(key))return 'detector span, type, order or uniqueness is invalid'
      last=start;seen.add(key)
      const allowed:Record<string,string[]>={link:['url'],emailAddress:['emailAddress'],phoneNumber:['phoneNumber'],calendarEvent:['startDate','endDate','duration','timeZone'],postalAddress:['street','city','state','postalCode','country','name','organization'],transit:[],moneyAmount:['currency','amount'],flightNumber:['airlineCode','flightNumber'],shipmentTrackingNumber:['carrier','trackingNumber','trackingURL'],measurement:['value','units'],paymentIdentifier:['identifier','paymentSystem']}
      if(Object.keys(components).some(key=>!allowed[row.type].includes(key))||Object.entries(components).some(([key,v])=>!(typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=4096&&!v.includes('\0')||typeof v==='number'&&Number.isFinite(v)||row.type==='measurement'&&key==='units'&&Array.isArray(v)&&v.length>0&&v.length<=64&&v.every(s=>typeof s==='string'&&s.length>0&&Buffer.byteLength(s)<=64&&!s.includes('\0')))))return 'invalid detector component field'
      if(row.type==='link'){try{new URL(row.value)}catch{return 'invalid detected URL'}if(components.url!==row.value)return 'link components differ from input'}
      if(row.type==='emailAddress'&&(!row.value.includes('@')||/\s/.test(row.value)||components.emailAddress!==row.value))return 'email components differ from input'
      if(row.type==='phoneNumber'&&(!/\d/.test(row.value)||!/^[-+(). \d]+$/.test(row.value)||components.phoneNumber!==row.value))return 'phone components differ from input'
      if(row.type==='postalAddress'&&(Object.keys(components).length===0||Object.values(components).some(v=>typeof v!=='string'||!v||!row.value.includes(v))))return 'address components are not grounded in input'
      if(row.type==='calendarEvent'&&(components.startDate===undefined||['startDate','endDate'].some(key=>components[key]!==undefined&&(typeof components[key]!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(components[key]))||!Number.isFinite(Date.parse(String(components[key])))))||components.duration!==undefined&&(typeof components.duration!=='number'||components.duration<0||components.duration>31536000)))return 'invalid detected event timestamps or duration'
      if(row.type==='moneyAmount'&&(typeof components.currency!=='string'||!/^[A-Z]{3}$/.test(components.currency)||typeof components.amount!=='string'||components.amount.length>128||!/^\-?\d+(?:\.\d+)?$/.test(components.amount)))return 'invalid detected currency or exact decimal amount'
      if(row.type==='flightNumber'&&(typeof components.airlineCode!=='string'||!/^[A-Za-z0-9]{1,3}$/.test(components.airlineCode)||!row.value.toUpperCase().includes(components.airlineCode.toUpperCase())||typeof components.flightNumber!=='number'||!Number.isSafeInteger(components.flightNumber)||components.flightNumber<0||components.flightNumber>999999||!row.value.split(/\D+/).filter(Boolean).some(s=>Number(s)===components.flightNumber)))return 'flight components are not grounded in input'
      if(row.type==='shipmentTrackingNumber'){
        if(typeof components.carrier!=='string'||typeof components.trackingNumber!=='string'||!row.value.includes(components.trackingNumber))return 'invalid tracking components'
        if(components.trackingURL!==undefined){try{const url=new URL(String(components.trackingURL));if(typeof components.trackingURL!=='string'||url.protocol!=='https:')return 'invalid tracking URL'}catch{return 'invalid tracking URL'}}
      }
      if(row.type==='measurement'&&(typeof components.value!=='number'||!Array.isArray(components.units)))return 'invalid measurement value or units'
      if(row.type==='paymentIdentifier'&&(typeof components.identifier!=='string'||!components.identifier.includes('@')||!row.value.includes(components.identifier)||components.paymentSystem!=='unifiedPaymentsInterface'))return 'invalid payment identifier'
      if(row.type==='transit'&&row.components!==undefined)return 'transit components are not part of the result contract'
    }
  }else{
    if(a.sub==='status')return shape('DesktopLanguageStatus')
    if(a.sub==='languages'){
      const error=shape('DesktopLanguageSupported');if(error)return error
      const rows=r.supported as {languageCode:string;region:string}[]
      if(rows.length<1||rows.length>128||rows.some(row=>!language(row.languageCode)||row.region!==''))return 'invalid translation language profile'
    }else if(a.sub==='availability'){
      const error=shape('DesktopLanguageAvailability');if(error)return error
      if(r.to!==a.to||r.from!==a.from||r.sample!==a.sample||!['installed','unsupported'].includes(String(r.status)))return 'translation availability differs from request'
    }else if(a.sub==='prepare'){
      const error=shape('DesktopLanguagePrepared');return error??(r.from===a.from&&r.to===a.to&&r.ready===true?undefined:'translation preparation differs from request')
    }else if(a.sub==='stop'){const error=shape('DesktopLanguageStopped');return error??(r.ok===true?undefined:'invalid translation stop result')}
    else if(a.sub==='batch'){
      const error=shape('DesktopLanguageTranslatedBatch');if(error)return error
      const inputs=JSON.parse(String(a.json)) as string[],rows=r.translations as {sourceText:string;targetText:string|null;ok:boolean;error?:string}[]
      if(r.from!==(a.from??'auto')||r.to!==a.to||rows.length!==inputs.length||rows.some((row,i)=>row.sourceText!==inputs[i]||(row.ok? !text(row.targetText)||row.error!==undefined:row.targetText!==null||!text(row.error))))return 'translation batch differs from request or contains invalid outcomes'
    }else{
      const error=shape('DesktopLanguageTranslation');if(error)return error
      if(r.sourceLanguage!==(a.from??null)||r.targetLanguage!==a.to||r.isReady!==true||!text(r.sourceText)||!text(r.targetText)||a.sub==='text'&&r.sourceText!==a.input)return 'translation differs from request'
    }
  }
}
