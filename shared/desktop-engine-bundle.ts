import spec from './desktop-engine-spec.json'

export type DesktopEngineFile={variable?:string;path:string;kind:'library'|'executable'|'model'|'license'|'data';bytes:number;sha256:string;component:string;version:string;source:string;license:string;licensePaths:string[];dependencies:string[]}
export type DesktopEngineManifest={schemaVersion:number;host:'win32'|'linux';architecture:'x64'|'arm64';providerVersion:string;files:DesktopEngineFile[]}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=max&&!/[\u0000-\u001f\u007f]/.test(v)
export function desktopEngineRelativePath(v:unknown):v is string{
  return typeof v==='string'&&v.length>0&&v.length<=240&&v.split('/').length<=4&&v.split('/').every(part=>/^[a-zA-Z0-9._-]{1,96}$/.test(part)&&!['.','..'].includes(part)&&!part.endsWith('.')&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}
/** The package record describes exact files, never native accuracy or permission. */
export function desktopEngineManifest(value:unknown,identity:{host:string;architecture:string;providerVersion:string}):DesktopEngineManifest{
  const refuse=(message:string):never=>{throw new Error(message)}
  if(!object(value)||Object.keys(value).some(k=>!['schemaVersion','host','architecture','providerVersion','files'].includes(k)))refuse('invalid engine manifest fields')
  const m=value as Record<string,unknown>
  if(m.schemaVersion!==spec.schemaVersion||!['win32','linux'].includes(String(m.host))||!['x64','arm64'].includes(String(m.architecture))||m.host!==identity.host||m.architecture!==identity.architecture||m.providerVersion!==identity.providerVersion)refuse('engine host, architecture or provider version differs')
  if(!Array.isArray(m.files)||m.files.length===0||m.files.length>spec.maxFiles)refuse('invalid engine file count')
  const files=m.files as unknown[],paths=new Set<string>(),variables=new Set<string>();let total=0
  for(const v of files){
    if(!object(v)||Object.keys(v).some(k=>!['variable','path','kind','bytes','sha256','component','version','source','license','licensePaths','dependencies'].includes(k)))refuse('invalid engine file fields')
    const e=v as Record<string,unknown>
    if(!desktopEngineRelativePath(e.path)||e.path==='manifest.json'||paths.has(e.path.toLowerCase()))refuse('invalid or repeated engine path')
    paths.add((e.path as string).toLowerCase())
    if(!Number.isSafeInteger(e.bytes)||(e.bytes as number)<=0||typeof e.sha256!=='string'||!/^[0-9a-f]{64}$/.test(e.sha256)||!text(e.component,128)||!text(e.version,128)||!text(e.license,256)||!text(e.source,4096))refuse('invalid engine identity, source or license')
    const source=new URL(e.source as string);if(source.protocol!=='https:'||!source.hostname||source.username||source.password)refuse('engine source must be a primary HTTPS URL without credentials')
    let max:number
    if(e.variable!==undefined){
      if(typeof e.variable!=='string'||variables.has(e.variable))refuse('invalid or repeated engine variable')
      const asset=spec.assets.find(a=>a.variable===e.variable);if(!asset)refuse('undeclared engine variable')
      if(asset!.kind!==e.kind||('version'in asset!&&asset!.version!==e.version))refuse('engine asset kind or selected version differs')
      variables.add(e.variable as string);max=asset!.maxBytes
    }else{
      max=e.kind==='license'?1048576:e.kind==='data'?67108864:['library','executable'].includes(String(e.kind))?134217728:0
      if(!max)refuse('invalid unbound engine file kind')
    }
    total+=e.bytes as number;if((e.bytes as number)>max||total>spec.maxBundleBytes)refuse('engine byte budget exceeded')
    if(!Array.isArray(e.licensePaths)||e.licensePaths.length>16||!Array.isArray(e.dependencies)||e.dependencies.length>32||(e.kind!=='license'&&e.licensePaths.length===0))refuse('invalid engine license or dependency references')
  }
  const typed=files as DesktopEngineFile[]
  for(const e of typed){
    const references=new Set<string>()
    for(const [name,license]of [...e.licensePaths.map(n=>[n,true]as const),...e.dependencies.map(n=>[n,false]as const)]){
      if(!desktopEngineRelativePath(name)||name===e.path||references.has(name))refuse('invalid or repeated engine reference')
      references.add(name);const dependency=typed.find(file=>file.path===name)
      if(!dependency||(license?dependency.kind!=='license':!['library','executable','data'].includes(dependency.kind)))refuse('missing or wrong-kind engine reference')
    }
  }
  return value as DesktopEngineManifest
}

/** Validate the loader format, including the runtime required by ExifTool. */
export function desktopEngineBinaryIdentity(bytes:Uint8Array,file:DesktopEngineFile,host:'win32'|'linux',architecture:'arm64'|'x64'):void{
  if(!['library','executable'].includes(file.kind))return
  const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength)
  if(host==='linux'){
    if(file.variable==='INTERCEPTOR_PHOTOS_EXIFTOOL'&&/^#!\/usr\/bin\/(?:env perl|perl)(?:\r?\n| )/.test(b.subarray(0,128).toString('utf8')))return
    if(b.length<20||b.subarray(0,6).toString('hex')!=='7f454c460201'||b.readUInt16LE(18)!==(architecture==='arm64'?183:62))throw new Error('engine is not the selected 64-bit native ELF')
  }else{
    if(b.length<64||b.readUInt16LE(0)!==0x5a4d)throw new Error('engine is not a native PE file')
    const offset=b.readUInt32LE(60)
    if(offset>65500||offset+26>b.length||b.readUInt32LE(offset)!==0x00004550||b.readUInt16LE(offset+4)!==(architecture==='arm64'?0xaa64:0x8664)||b.readUInt16LE(offset+24)!==0x20b)throw new Error('engine is not the selected 64-bit native PE')
  }
}
