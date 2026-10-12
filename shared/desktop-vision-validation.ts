import {isAbsolute,win32} from 'node:path'
import {desktopContractShapeError} from './desktop-contract-validation'
import type {DesktopContractSchema} from './desktop-contract.generated'

export function desktopVisionActionError(a:Record<string,unknown>):string|undefined{
  if(a.type!=='desktop_vision')return
  const shape=desktopContractShapeError(a,'DesktopVisionAction');if(shape)return shape
  for(const key of ['imagePath','debugDumpPath']){
    const value=a[key]
    if(value!==undefined&&(typeof value!=='string'||!value||value.includes('\0')||Buffer.byteLength(value)>32768||!(value.startsWith('~/')||(process.platform==='win32'?win32.isAbsolute(value):isAbsolute(value)))))return 'vision paths require bounded absolute paths'
  }
  if(a.app!==undefined&&(typeof a.app!=='string'||!a.app.trim()||a.app.includes('\0')||Buffer.byteLength(a.app)>512))return 'vision app requires a bounded name'
  if(a.app!==undefined&&a.imagePath!==undefined)return 'vision requires either an image file or an app target'
  if(a.debugDumpPath!==undefined&&a.sub!=='text')return 'vision debug dump belongs only to text'
  if(['group','groupColor'].some(key=>a[key]!==undefined&&(String(a[key]).length<1||Buffer.byteLength(String(a[key]))>256||String(a[key]).includes('\0'))))return 'invalid native request group metadata'
}
export function desktopVisionResultError(a:Record<string,unknown>,data:unknown):string|undefined{
  if(a.type!=='desktop_vision')return
  const schemas:Readonly<Record<string,DesktopContractSchema>>={text:'DesktopVisionTextData',faces:'DesktopVisionFaces',hands:'DesktopVisionHands',bodies:'DesktopVisionBodies',classify:'DesktopVisionClassifications',saliency:'DesktopVisionSaliency'}
  const schema=schemas[String(a.sub)];if(!schema)return 'unknown Vision result selector'
  const shape=desktopContractShapeError(data,schema);if(shape)return shape
  if(Buffer.byteLength(JSON.stringify(data))>1_048_576)return 'Vision result exceeds its bound'
  if(a.sub!=='text'){
    const r=data as Record<string,any>,key=String(a.sub)==='classify'?'classifications':String(a.sub)==='saliency'?'regions':String(a.sub),rows=r[key]
    if(rows.length>(a.sub==='classify'?20:4096)||r.count!==undefined&&r.count!==rows.length)return 'Vision count or observation bound is invalid'
    const confidence=(n:number)=>n>=0&&n<=1
    // Windows OCR/FaceDetector and OpenCV report no score: null is allowed, a number must be a probability.
    const score=(n:number|null)=>n===null||typeof n==='number'&&confidence(n)
    for(const row of rows){
      if(a.sub==='classify'){if(!row.label.trim()||row.label.includes('\0')||Buffer.byteLength(row.label)>512||!confidence(row.confidence)||row.confidence<=0.1)return 'invalid observed Vision classification';continue}
      if(a.sub==='hands'||a.sub==='bodies'){
        const joints=Object.entries(row.joints) as [string,{x:number;y:number;confidence:number|null}][]
        if(joints.length>64||a.sub==='hands'&&![-1,0,1].includes(row.chirality))return 'invalid Vision pose/chirality'
        for(const [name,point]of joints)if(!name.trim()||name.includes('\0')||Buffer.byteLength(name)>128||!confidence(point.x)||!confidence(point.y)||point.confidence!==null&&(!confidence(point.confidence)||point.confidence<=0.3))return 'invalid observed Vision joint'
      }else if(!score(row.confidence)||row.x<0||row.y<0||row.width<=0||row.height<=0||row.x+row.width>1.000001||row.y+row.height>1.000001)return 'Vision region bounds or confidence are invalid'
    }
    return
  }
  const r=data as {text:string;count:number;regions:{text:string;confidence:number|null;x:number;y:number;width:number;height:number}[]}
  if(r.count!==r.regions.length||r.count>4096||Buffer.byteLength(r.text)>65536||r.text!==r.regions.map(row=>row.text).join('\n'))return 'OCR region count or assembled text differs from its result'
  for(const row of r.regions){
    if(!row.text.trim()||row.text.includes('\0')||row.confidence!==null&&(row.confidence<0||row.confidence>1)||row.x<0||row.y<0||row.width<=0||row.height<=0||row.x+row.width>1.000001||row.y+row.height>1.000001)return 'OCR region bounds or confidence are invalid'
  }
}
