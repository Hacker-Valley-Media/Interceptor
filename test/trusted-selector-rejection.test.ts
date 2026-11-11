import {expect,test} from 'bun:test'
import {mkdtempSync,readdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {captureSubprocessSync} from '../shared/subprocess-sync'

for(const flag of ['--trusted','--os'])for(const args of [
  ['click','--selector','button'],
  ['click','--selector=button'],
  ['act','e1','--selector','button'],
  ['act','--selector','button'],
  ['type','e1','hello','--selector','button'],
  ['keys','Enter','--selector','button'],
])test(`${args[0]} selector plus ${flag} refuses before daemon preflight`,()=>{
  const root=mkdtempSync(join(tmpdir(),'interceptor-selector-'))
  try{
    const child=captureSubprocessSync(process.execPath,[join(import.meta.dir,'../cli/index.ts'),...args,flag],{
      env:{...process.env,INTERCEPTOR_TEMP:root},encoding:'utf8',timeout:5000,
    })
    const {stdout,stderr}=child
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('interceptor query "<css>"')
    if(args[0]==='click')expect(stderr).toContain('interceptor click <ref> --trusted')
    else expect(stderr).toContain("unknown flag '--selector'")
    expect(readdirSync(root)).toEqual([])
  }finally{rmSync(root,{recursive:true,force:true})}
})
