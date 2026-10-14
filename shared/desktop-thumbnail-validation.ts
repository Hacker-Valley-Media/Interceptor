import {isAbsolute,win32} from 'node:path'
import {DESKTOP_MAX_RESULT_BYTES,DESKTOP_THUMBNAIL_MAX_PATHS,DESKTOP_THUMBNAIL_MAX_PIXELS} from './desktop-contract'
import {desktopContractShapeError} from './desktop-contract-validation'

export function desktopThumbnailActionError(action:Record<string,unknown>):string|undefined{
  if(action.type!=='desktop_thumbnail')return
  const shape=desktopContractShapeError(action,'DesktopThumbnailAction');if(shape)return shape
  const path=(value:unknown)=>typeof value==='string'&&value.length>0&&!value.includes('\0')&&Buffer.byteLength(value)<=32768&&(value.startsWith('~/')||(process.platform==='win32'?win32.isAbsolute(value):isAbsolute(value)))
  if(action.sub==='generate'?!path(action.path)||action.paths!==undefined:action.path!==undefined||!Array.isArray(action.paths)||action.paths.length<1||action.paths.length>DESKTOP_THUMBNAIL_MAX_PATHS||!action.paths.every(path))return 'thumbnail requires one absolute path or 1..32 absolute batch paths'
  const match=/^([1-9]\d{0,3})(?:x([1-9]\d{0,3}))?$/.exec(String(action.size??'256'))
  const scale=Number(action.scale??2)
  if(!match||!Number.isSafeInteger(scale)||scale<1||scale>8)return 'thumbnail size requires positive integer dimensions and scale 1..8'
  const width=Number(match[1])*scale,height=Number(match[2]??match[1])*scale
  if(width>16384||height>16384||width*height>DESKTOP_THUMBNAIL_MAX_PIXELS)return 'thumbnail dimensions exceed their pixel bound'
  if(action.format!==undefined&&!['png','jpeg','jpg','heic'].includes(String(action.format).toLowerCase()))return 'thumbnail format requires png, jpeg or heic'
  if(action.types!==undefined&&(String(action.types).length>128||!String(action.types).split(',').every(v=>['all','icon','thumbnail','lowQuality','lowQualityThumbnail'].includes(v.trim()))))return 'unknown thumbnail representation type'
  if(action.out!==undefined&&(!path(action.out)||action.save!==true||action.sub==='batch'))return 'thumbnail out requires an absolute destination and a single saved image'
}

export function desktopThumbnailResultError(action:Record<string,unknown>,data:unknown):string|undefined{
  if(action.type!=='desktop_thumbnail')return
  const shape=desktopContractShapeError(data,'DesktopThumbnailData');if(shape)return shape
  if(action.sub==='batch'){
    const rows=(data as {results?:unknown[]})?.results
    if(!Array.isArray(rows)||rows.length!==(action.paths as string[]).length)return 'thumbnail batch count differs from its request'
    for(let i=0;i<rows.length;i++){
      const row=rows[i] as {path:string;ok:boolean;result:{success:boolean;data?:unknown;code?:string;error?:string}}
      if(row.path!==(action.paths as string[])[i]||row.ok!==row.result.success)return 'thumbnail batch order or outcome differs from its request'
      if(row.ok){const error=desktopThumbnailResultError({...action,sub:'generate',path:row.path,paths:undefined},row.result.data);if(error)return error}
      else if(!row.result.code||!row.result.error)return 'thumbnail batch failure requires a typed error'
    }
    return
  }
  const r=data as Record<string,unknown>,format=String(action.format??'png').toLowerCase().replace(/^jpg$/,'jpeg')
  if(r.path!==action.path||r.type!=='thumbnail'||r.format!==format||r.scale!==(action.scale??2))return 'thumbnail metadata differs from its request'
  if(!['width','height','bytes'].every(key=>Number.isSafeInteger(r[key])&&Number(r[key])>0)||Number(r.width)*Number(r.height)>DESKTOP_THUMBNAIL_MAX_PIXELS||Number(r.bytes)>DESKTOP_MAX_RESULT_BYTES)return 'thumbnail image dimensions or bytes exceed their bounds'
  const parts=String(action.size??'256').split('x').map(Number),scale=Number(action.scale??2)
  if(Number(r.width)>parts[0]*scale||Number(r.height)>(parts[1]??parts[0])*scale)return 'thumbnail exceeds its requested dimensions'
  if(action.save===true){if(typeof r.filePath!=='string'||!(process.platform==='win32'?win32.isAbsolute(r.filePath):isAbsolute(r.filePath))||r.filePath.includes('\0')||r.dataUrl!==undefined)return 'thumbnail save result requires an absolute file path';return}
  const prefix=`data:image/${format};base64,`
  if(r.filePath!==undefined||typeof r.dataUrl!=='string'||!r.dataUrl.startsWith(prefix))return 'thumbnail inline URI differs from its format'
  const encoded=r.dataUrl.slice(prefix.length),bytes=Buffer.from(encoded,'base64')
  if(bytes.length!==r.bytes||bytes.toString('base64')!==encoded)return 'thumbnail byte count differs from its encoded image'
}
