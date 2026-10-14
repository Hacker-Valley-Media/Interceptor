import {spawnSync as nativeSpawnSync, type SpawnSyncOptions, type SpawnSyncReturns} from 'node:child_process'
import {mkdtempSync, readFileSync, writeFileSync, statSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

export function captureSubprocessSync(command:string,args:string[],options:SpawnSyncOptions & {encoding:BufferEncoding}):SpawnSyncReturns<string>
export function captureSubprocessSync(command:string,args:string[],options?:SpawnSyncOptions & {encoding?:null}):SpawnSyncReturns<Buffer>
export function captureSubprocessSync(command:string,args:string[],options:SpawnSyncOptions):SpawnSyncReturns<string|Buffer>
export function captureSubprocessSync(command:string,args:string[],options:SpawnSyncOptions={}):SpawnSyncReturns<string|Buffer>{
  if(process.platform!=='darwin')return nativeSpawnSync(command,args,options)
  // Bun on macOS can lose remapped descriptors even when the child exits
  // successfully. Reuse the test capture path: the child opens its own files.
  const directory=mkdtempSync(join(tmpdir(),'interceptor-child-capture-'))
  const output=join(directory,'stdout'),error=join(directory,'stderr'),input=join(directory,'stdin')
  const {input:bytes,encoding,...spawnOptions}=options
  const limit=options.maxBuffer??1024*1024
  if(!Number.isSafeInteger(limit)||limit<0){rmSync(directory,{recursive:true,force:true});throw new RangeError('maxBuffer must be a nonnegative safe integer')}
  try{
    if(bytes!==undefined)writeFileSync(input,bytes,{mode:0o600})
    const result=nativeSpawnSync('/bin/bash',[
      '--noprofile','--norc','-c',
      'umask 077; taskOut=$1; taskErr=$2; taskIn=$3; shift 3; exec "$@" < "$taskIn" > "$taskOut" 2> "$taskErr"',
      'interceptor-child-capture',output,error,bytes===undefined?'/dev/null':input,command,...args,
    ],{...spawnOptions,stdio:'inherit'})
    let overflow=false
    const read=(path:string):string|Buffer=>{
      let value=Buffer.alloc(0)
      try{
        if(statSync(path).size>limit)overflow=true
        else value=readFileSync(path)
      }catch(cause){if(!result.error)throw cause}
      return encoding&&encoding!=='buffer'?value.toString(encoding):value
    }
    const stdout=read(output),stderr=read(error)
    const captureError=overflow?Object.assign(new Error('child output exceeds maxBuffer'),{code:'ENOBUFS'}):result.error
    return {...result,status:overflow?null:result.status,error:captureError,stdout,stderr,output:[null,stdout,stderr]}
  }finally{rmSync(directory,{recursive:true,force:true})}
}

