#!/usr/bin/env bun
// Hyprland plugins use the host compositor's C++ ABI. Build this payload on
// the qualified Linux host and retain its compiler, headers and input hashes.
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync} from 'node:fs'
import {resolve, join} from 'node:path'

const [sourceArg, archiveArg, outputArg] = process.argv.slice(2)
if (!sourceArg || !archiveArg || !outputArg || process.argv.length !== 5) {
  throw new Error('usage: build-hyprland-pointer.ts <hyprland-source-directory> <libinterceptor_desktop.a> <output-directory>')
}
if (process.platform !== 'linux' || !['arm64', 'x64'].includes(process.arch)) throw new Error('Build on a qualified Linux arm64/x64 host')
const source=resolve(sourceArg), archive=resolve(archiveArg), output=resolve(outputArg)
if ([source,archive,output].some(p=>/[\s\x00-\x1f\x7f]/.test(p))) throw new Error('The qualified compiler dependency format requires paths without whitespace or control characters')
if (!statSync(archive).isFile() || statSync(archive).size > 128*1024*1024) throw new Error('A bounded native session-auth static archive is required')
const sha=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
async function run(args:string[],timeout=120000):Promise<string> {
  const child=Bun.spawn(args,{stdin:'pipe',stdout:'pipe',stderr:'pipe'})
  child.stdin.end()
  const timer=setTimeout(()=>child.kill(),timeout)
  const [out,error,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]).finally(()=>clearTimeout(timer))
  if(status!==0)throw new Error(`${args[0]} failed (${status}): ${error.slice(0,8000)}`)
  return out.trim()
}
const compiler=await run(['g++','-dumpfullversion'])
const compilerIdentity=await run(['g++','--version'])
const hyprland=await run(['pkg-config','--modversion','hyprland'])
const wayland=await run(['pkg-config','--modversion','wayland-server'])
if(compiler!=='16.1.1'||hyprland!=='0.56.1'||wayland!=='1.26.0')throw new Error('Payload requires qualified GCC 16.1.1, Hyprland 0.56.1 and Wayland 1.26.0')
const version=JSON.parse(await run(['hyprctl','-j','version']))
if(version.version!=='0.56.1'||version.commit!=='5c9377c15f85c50648f35ca5a213754f95b93ca0'||version.dirty!==false||typeof version.abiHash!=='string')throw new Error('The active compositor does not match the qualified source/runtime ABI')
const flags=(await run(['pkg-config','--cflags','hyprland','wayland-server'])).split(/\s+/).filter(Boolean)
const libraries=(await run(['pkg-config','--libs','wayland-server','libsystemd'])).split(/\s+/).filter(Boolean)
if([...flags,...libraries].some(f=>!/^[-+/=.,A-Za-z0-9_]+$/.test(f)))throw new Error('Unexpected compiler flags in installed pkg-config metadata')
// /tmp is commonly a separate tmpfs on Linux. Stage beside the final files
// so publishing the compiled payload and manifest uses same-filesystem renames.
mkdirSync(output,{recursive:true,mode:0o700})
const work=mkdtempSync(join(output,'.interceptor-pointer-build-'))
// The manifest ships to users: name inputs by their place in the source or build folder,
// never by this host's path. System headers keep their public /usr paths.
const neutral=(path:string)=>path.startsWith(work+'/')?'<generated>/'+path.slice(work.length+1):path.startsWith(source+'/')?path.slice(source.length+1):path
try {
  const inputs=['pointer-plugin.cpp','pointer-core.hpp','session-auth.h','interceptor-background-pointer-v1.xml'].map(name=>({path:join(source,name),sha256:sha(join(source,name))}))
  const archiveHash=sha(archive)
  await run(['wayland-scanner','server-header',join(source,'interceptor-background-pointer-v1.xml'),join(work,'interceptor-background-pointer-v1-server.h')])
  await run(['wayland-scanner','private-code',join(source,'interceptor-background-pointer-v1.xml'),join(work,'interceptor-background-pointer-v1-server.c')])
  const compileFlags=['-std=c++23','-fPIC','-O2',`-I${source}`,`-I${work}`,`-ffile-prefix-map=${source}=/src/interceptor/interceptor-desktop/hyprland`,`-ffile-prefix-map=${work}=/src/interceptor-pointer-build`,...flags]
  const dependencyFile=join(work,'dependencies.d')
  await run(['g++',...compileFlags,'-M','-MF',dependencyFile,join(source,'pointer-plugin.cpp')])
  const dependencies=[...new Set(readFileSync(dependencyFile,'utf8').replace(/\\\r?\n/g,' ').replace(/^[^:]+:/,'').split(/\s+/).filter(Boolean))].sort()
  const headers=dependencies.map(path=>({path,sha256:sha(path)}))
  const headerHasher=createHash('sha256')
  for(const header of headers) headerHasher.update(neutral(header.path)).update('\0').update(header.sha256).update('\n')
  await run(['gcc','-fPIC','-O2',`-ffile-prefix-map=${work}=/src/interceptor-pointer-build`,'-c',join(work,'interceptor-background-pointer-v1-server.c'),'-o',join(work,'protocol.o')])
  await run(['g++',...compileFlags,'-shared',join(source,'pointer-plugin.cpp'),join(work,'protocol.o'),archive,...libraries,'-ldl','-lpthread','-lm','-o',join(work,'interceptor-pointer.so')])
  for(const file of [...inputs,...headers])if(sha(file.path)!==file.sha256)throw new Error('Compiler inputs changed during the build')
  if(sha(archive)!==archiveHash)throw new Error('Session-auth archive changed during the build')
  const binary=readFileSync(join(work,'interceptor-pointer.so'))
  const machine=process.arch==='arm64'?183:62
  if(binary.subarray(0,6).toString('hex')!=='7f454c460201'||binary.readUInt16LE(18)!==machine)throw new Error('Compiler emitted the wrong ELF architecture')
  const linkage=await run(['ldd',join(work,'interceptor-pointer.so')])
  if(linkage.includes('not found'))throw new Error('Payload runtime library dependencies are missing')
  const payloadSHA256=sha(join(work,'interceptor-pointer.so'))
  const manifest={schemaVersion:1,protocolVersion:4,platform:'linux',architecture:process.arch,hyprlandVersion:hyprland,hyprlandCommit:version.commit,hyprlandABIHash:version.abiHash,compiler,compilerIdentity,waylandVersion:wayland,headerSHA256:headerHasher.digest('hex'),sessionAuthSHA256:archiveHash,sources:inputs.map(i=>({...i,path:neutral(i.path)})),headers:headers.map(h=>({...h,path:neutral(h.path)})),payload:`interceptor-pointer-${payloadSHA256}.so`,payloadSHA256,payloadBytes:binary.length,linkage,builtAt:new Date().toISOString()}
  mkdirSync(output,{recursive:true,mode:0o700})
  writeFileSync(join(work,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600})
  renameSync(join(work,'interceptor-pointer.so'),join(output,manifest.payload))
  renameSync(join(work,'manifest.json'),join(output,'manifest.json'))
  console.log(JSON.stringify({output,payloadSHA256:manifest.payloadSHA256,hyprlandABIHash:manifest.hyprlandABIHash,headerSHA256:manifest.headerSHA256}))
}finally{rmSync(work,{recursive:true,force:true})}
