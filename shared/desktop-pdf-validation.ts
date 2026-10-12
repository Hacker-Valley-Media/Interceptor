import {isAbsolute,win32} from 'node:path'
import {desktopContractShapeError} from './desktop-contract-validation'
const fields:Record<string,string[]>={info:[],text:['page','range','attributed'],outline:[],annotations:['page','annotation_type'],forms:[],forms_set:['field','value','out'],images:[],find:['query','case_sensitive'],attributes:[],permissions:[],annotate:['page','rect','annotation_type','contents','out'],strip:['out'],merge:['paths','out'],split:['pages','out']}
export const DESKTOP_PDF_FIELDS=fields
export function desktopPdfActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_pdf')return
  const shape=desktopContractShapeError(a,'DesktopPdfAction');if(shape)return shape
  const sub=String(a.sub),allowed=['type','sub','group','groupColor',...(sub==='merge'?[]:['path']),...fields[sub]]
  if(Object.keys(a).some(key=>!allowed.includes(key)))return 'PDF field does not belong to the requested operation'
  const valid=(v:unknown,cap:number,empty=false)=>typeof v==='string'&&(empty||v.length>0)&&!v.includes('\0')&&Buffer.byteLength(v)<=cap
  const path=(v:unknown)=>valid(v,32768)&&(String(v).startsWith('~/')||(process.platform==='win32'?win32.isAbsolute(String(v)):isAbsolute(String(v))))
  if(sub==='merge'){if(!Array.isArray(a.paths)||!a.paths.length||a.paths.length>64||a.paths.some(v=>!path(v)))return 'PDF merge requires 1..64 absolute source paths'}else if(!path(a.path))return 'PDF requires an absolute source path'
  if(a.out!==undefined&&!path(a.out))return 'PDF output requires an absolute path'
  if(['strip','merge','split'].includes(sub)&&a.out===undefined)return 'PDF operation requires an output path'
  if(a.page!==undefined&&(!Number.isSafeInteger(a.page)||Number(a.page)<1||Number(a.page)>4096))return 'PDF page requires an integer in 1..4096'
  if(a.range!==undefined&&a.page!==undefined)return 'PDF text accepts a page or range'
  for(const key of ['range','pages'])if(a[key]!==undefined){const m=/^([1-9]\d{0,3})(?:-([1-9]\d{0,3}))?$/.exec(String(a[key]));if(!m||Number(m[1])>4096||Number(m[2]??m[1])>4096||Number(m[1])>Number(m[2]??m[1]))return 'PDF range requires an ascending 1-based page or inclusive page range'}
  if(sub==='split'&&a.pages===undefined)return 'PDF split requires pages'
  if(sub==='find'&&!valid(a.query,4096))return 'PDF search requires 1..4096 UTF8 bytes'
  if(sub==='forms_set'&&(!valid(a.field,4096)||!valid(a.value,65536,true)))return 'PDF field update requires a name and bounded string value'
  if(a.annotation_type!==undefined&&!valid(a.annotation_type,64))return 'invalid PDF annotation type'
  if(a.contents!==undefined&&!valid(a.contents,65536,true))return 'invalid PDF annotation contents'
  if(sub==='annotate'){
    const parts=typeof a.rect==='string'?a.rect.split(','):[]
    if(a.page===undefined||parts.length!==4||parts.some(s=>!s.trim()||!Number.isFinite(Number(s))||Math.abs(Number(s))>1e7)||Number(parts[2])<=0||Number(parts[3])<=0)return 'PDF annotation requires a page and finite x,y,w,h rectangle with positive dimensions'
  }
  if(['group','groupColor'].some(key=>a[key]!==undefined&&!valid(a[key],256)))return 'invalid native request group metadata'
}
export function desktopPdfResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_pdf')return
  if(!data||typeof data!=='object'||Array.isArray(data))return 'PDF result requires an object'
  const r=data as Record<string,any>,sub=String(a.sub)
  const schemas:Record<string,string>={info:'DesktopPdfInfoData',text:r.page!==undefined?'DesktopPdfSingleTextData':'DesktopPdfTextData',outline:'DesktopPdfOutlineData',annotations:'DesktopPdfAnnotationsData',forms:'DesktopPdfFormsData',forms_set:'DesktopPdfFormsSetData',images:'DesktopPdfImagesData',find:'DesktopPdfFindData',attributes:'DesktopPdfAttributesData',permissions:'DesktopPdfPermissionsData',annotate:'DesktopPdfAnnotateData',strip:'DesktopPdfStripData',merge:'DesktopPdfMergeData',split:'DesktopPdfSplitData'}
  const shape=desktopContractShapeError(r,schemas[sub] as Parameters<typeof desktopContractShapeError>[1]);if(shape)return shape
  const integer=(n:unknown,lo=0,hi=4096)=>Number.isSafeInteger(n)&&Number(n)>=lo&&Number(n)<=hi
  const rect=(v:any)=>v&&['x','y','w','h'].every(k=>Number.isFinite(v[k])&&Math.abs(v[k])<=1e7)&&v.w>=0&&v.h>=0
  if(Object.hasOwn(r,'path')&&r.path!==a.path)return 'PDF result source differs from its request'
  if(Object.hasOwn(r,'savedTo')&&r.savedTo!==(a.out??a.path))return 'PDF saved path differs from its request'
  if(r.pageCount!==undefined&&!integer(r.pageCount,1))return 'PDF page count exceeds its bound'
  if(sub==='forms_set'&&(r.ok!==true||r.fieldName!==a.field||r.newValue!==a.value))return 'PDF field update acknowledgement differs from its request'
  if(sub==='merge'&&JSON.stringify(r.sources)!==JSON.stringify(a.paths))return 'PDF merge sources differ from its request'
  if(sub==='split'&&(r.source!==a.path||r.range.length!==2||!integer(r.range[0],1)||!integer(r.range[1],r.range[0])||r.pageCount!==r.range[1]-r.range[0]+1||r.range.join('-')!==(String(a.pages).includes('-')?a.pages:[a.pages,a.pages].join('-'))))return 'PDF split result differs from the requested range'
  const annotations=[...(r.annotations??[]),...(r.forms??[]),...(r.annotation?[r.annotation]:[]),...(sub==='images'?r.pages.flatMap((p:any)=>p.stamps):[])]
  if(annotations.length>4096||annotations.some((v:any)=>!integer(v.page,1)||!rect(v.bounds)||!integer(v.maximumLength,0,2147483647)||(a.page!==undefined&&v.page!==a.page)||(sub==='forms'&&v.type!=='Widget')||(a.annotation_type!==undefined&&v.type!==a.annotation_type)))return 'invalid PDF annotation result or selector'
  if(sub==='annotate'&&(r.page!==a.page||r.annotation.page!==a.page||r.annotation.type!==(a.annotation_type??'Highlight')))return 'PDF created annotation differs from its request'
  if(sub==='find'&&(r.query!==a.query||r.matchCount!==r.matches.length||r.matchCount>4096||r.matches.some((v:any)=>!integer(v.page,1)||!rect(v.bounds)||!v.text)))return 'invalid PDF search result'
  if(sub==='images'&&(r.pages.length>4096||r.pages.some((v:any,i:number)=>v.page!==i+1||!rect(v.mediaBox)||![0,90,180,270].includes(v.rotation))))return 'invalid PDF page image inventory'
  if(sub==='text'){
    const pages=r.pages??[r]
    if(!pages.length||pages.length>4096||pages.some((p:any,i:number)=>!integer(p.page,1)||!integer(p.characterCount,0,1_000_000)||Buffer.byteLength(p.text)>1_048_576||i>0&&p.page!==pages[i-1].page+1||(a.page!==undefined&&p.page!==a.page)))return 'invalid PDF page text result'
    if(r.pages&&r.text!==pages.map((p:any)=>p.text).join('\n'))return 'PDF combined text differs from its pages joined by newlines'
    if(a.attributed===true&&pages.some((p:any)=>!Array.isArray(p.attributedString)))return 'PDF attributed text omitted its runs'
    for(const p of pages)for(const run of p.attributedString??[])if(run.range.length!==2||!integer(run.range[0],0,p.text.length)||!integer(run.range[1],1,p.text.length)||run.range[0]+run.range[1]>p.text.length||run.font&&(!run.font.name||run.font.size<=0))return 'invalid PDF attributed text range or font'
  }
  if(sub==='outline'){
    let count=0;const valid=(rows:any[],depth=0):boolean=>depth<=12&&rows.every(v=>++count<=4096&&(!v.destination||integer(v.destination.pageIndex))&&(!v.children||valid(v.children,depth+1)))
    if(!valid(r.outline))return 'PDF outline exceeds its count, destination or depth bounds'
  }
  if(Buffer.byteLength(JSON.stringify(r))>1_048_576)return 'PDF metadata exceeds 1 MiB'
}
