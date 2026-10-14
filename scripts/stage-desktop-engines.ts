#!/usr/bin/env bun
// Local, pinned inputs only. Native execution and qualification run later.
import{open,lstat,realpath,mkdir,readdir,chmod,rename}from'node:fs/promises'
import{constants}from'node:fs'
import{resolve,join,dirname,isAbsolute,relative,sep}from'node:path'
import{createHash,randomUUID}from'node:crypto'
import{desktopEngineManifest,desktopEngineBinaryIdentity,type DesktopEngineManifest,type DesktopEngineFile}from'../shared/desktop-engine-bundle'
import{version}from'../package.json'

const args=process.argv.slice(2),check=args[0]==='--check',offset=check?1:0
if(args.length!==offset+(check?3:4))throw new Error('usage: bun scripts/stage-desktop-engines.ts [--check] <absolute source directory> <win32|linux> <x64|arm64> [absolute new output directory]')
const[sourceArg,host,architecture,outputArg]=args.slice(offset)
if(!isAbsolute(sourceArg)||!['win32','linux'].includes(host)||!['x64','arm64'].includes(architecture))throw new Error('engine source and target are invalid')
const source=resolve(sourceArg)
const directory=async(path:string)=>{const st=await lstat(path);if(!st.isDirectory()||st.isSymbolicLink()||await realpath(path)!==path)throw new Error('engine directories must not contain links');if(process.platform!=='win32'&&((st.mode&0o022)!==0||(st.uid!==0&&st.uid!==process.getuid!())))throw new Error('engine directory is writable by another user')}
await directory(source)
const filePath=async(name:string)=>{const path=join(source,...name.split('/'));let current=dirname(path);while(current!==source){await directory(current);current=dirname(current)}const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||await realpath(path)!==path)throw new Error('engine file is not a regular unlinked input');if(process.platform!=='win32'&&((st.mode&0o022)!==0||(st.uid!==0&&st.uid!==process.getuid!())))throw new Error('engine file is writable by another user');return path}
const manifestPath=await filePath('manifest.json'),manifestFile=await open(manifestPath,constants.O_RDONLY|constants.O_NOFOLLOW)
let manifestBytes:Buffer
try{const st=await manifestFile.stat();if(!st.isFile()||st.size<1||st.size>1048576)throw new Error('engine manifest exceeds its bound');manifestBytes=Buffer.alloc(st.size+1);let count=0;while(count<manifestBytes.length){const r=await manifestFile.read(manifestBytes,count,manifestBytes.length-count,null);if(!r.bytesRead)break;count+=r.bytesRead}if(count!==st.size)throw new Error('engine manifest changed during read');manifestBytes=manifestBytes.subarray(0,count)}finally{await manifestFile.close()}
const manifest:DesktopEngineManifest=desktopEngineManifest(JSON.parse(manifestBytes!.toString('utf8')),{host,architecture,providerVersion:version})
const expected=new Set(['manifest.json',...manifest.files.map(f=>f.path)]),seen=new Set<string>();let count=0
const inventory=async(path:string,prefix:string,depth:number):Promise<void>=>{for(const name of await readdir(path)){if(++count>512)throw new Error('engine source inventory exceeds its bound');const scoped=prefix?prefix+'/'+name:name,child=join(path,name),st=await lstat(child);if(st.isDirectory()){if(depth>=3||![...expected].some(p=>p.startsWith(scoped+'/')))throw new Error('engine source contains an undeclared directory');await directory(child);await inventory(child,scoped,depth+1)}else{if(!st.isFile()||st.isSymbolicLink()||!expected.has(scoped))throw new Error('engine source contains a linked or undeclared file');seen.add(scoped)}}}
await inventory(source,'',0);if(seen.size!==expected.size)throw new Error('engine source is incomplete')
let output:string|undefined
if(!check){
  if(!outputArg||!isAbsolute(outputArg))throw new Error('new engine output must be absolute')
  output=resolve(outputArg);const repo=await realpath(resolve(import.meta.dir,'..'))
  if(![join(repo,'.interceptor')+sep,join(repo,'dist')+sep,join(repo,'interceptor-desktop','target')+sep].some(root=>output!.startsWith(root)))throw new Error('engine output must stay in owned checkout staging')
  const relation=relative(source,output)
  if(!relation||!(relation==='..'||relation.startsWith('..'+sep)||isAbsolute(relation)))throw new Error('engine output cannot be inside its source')
  let ancestor=dirname(output);for(;;){try{if(await realpath(ancestor)!==ancestor)throw new Error('engine output ancestor contains a link');const st=await lstat(ancestor);if(!st.isDirectory())throw new Error('engine output ancestor is not a directory');break}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const parent=dirname(ancestor);if(parent===ancestor)throw e;ancestor=parent}}
  await mkdir(dirname(output),{recursive:true,mode:0o700});await mkdir(output,{mode:0o700})
}
const transfer=async(file:DesktopEngineFile)=>{
  const path=await filePath(file.path),input=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW),digest=createHash('sha256'),buffer=Buffer.alloc(65536),header=Buffer.alloc(Math.min(65536,file.bytes));let total=0,license:Buffer[]=[],out:Awaited<ReturnType<typeof open>>|undefined
  try{
    const st=await input.stat();if(!st.isFile()||st.size!==file.bytes)throw new Error('engine source byte count differs')
    if(output){const target=join(output,...file.path.split('/'));await mkdir(dirname(target),{recursive:true,mode:0o700});out=await open(target,'wx',file.kind==='executable'?0o700:0o600)}
    for(;;){const{bytesRead:n}=await input.read(buffer,0,buffer.length,null);if(!n)break;if(total+n>file.bytes)throw new Error('engine source grew beyond its bound');const chunk=buffer.subarray(0,n);digest.update(chunk);if(total<header.length)chunk.copy(header,total,0,Math.min(n,header.length-total));if(file.kind==='license')license.push(Buffer.from(chunk));if(out){let written=0;while(written<n){const r=await out.write(chunk,written,n-written,null);if(!r.bytesWritten)throw new Error('engine output made no progress');written+=r.bytesWritten}}total+=n}
    if(total!==file.bytes||digest.digest('hex')!==file.sha256)throw new Error('engine source differs from its mandatory SHA256')
    desktopEngineBinaryIdentity(header,file,manifest.host,manifest.architecture)
    if(file.kind==='license'){const bytes=Buffer.concat(license),text=new TextDecoder('utf8',{fatal:true}).decode(bytes);if(!text.trim()||text.includes('\0'))throw new Error('engine license is empty or invalid')}
    if(out)await out.sync()
  }finally{await input.close();await out?.close()}
}
// Sequential transfer keeps the largest model out of memory and bounds handles.
for(const file of manifest.files)await transfer(file)
if(output){
  const temporary=join(output,'.manifest-'+randomUUID()),out=await open(temporary,'wx',0o600)
  try{await out.writeFile(manifestBytes!);await out.sync()}finally{await out.close()}
  await rename(temporary,join(output,'manifest.json'));await chmod(output,0o700)
}
console.log(JSON.stringify({source,output:output??null,host,architecture,providerVersion:version,files:manifest.files.length,bytes:manifest.files.reduce((sum,f)=>sum+f.bytes,0),manifestSHA256:createHash('sha256').update(manifestBytes!).digest('hex'),qualification:'file-identity-only',nativeRuntimeChecked:false}))
