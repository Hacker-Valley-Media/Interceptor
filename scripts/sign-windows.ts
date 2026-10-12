#!/usr/bin/env bun
// Local Authenticode uses the existing Azure Artifact Signing account. The
// access token stays out of argv, files, and diagnostic output.
import {resolve} from 'node:path'

const [jar, ...files] = process.argv.slice(2)
if (!jar || !files.length) throw new Error('usage: bun scripts/sign-windows.ts <pinned-jsign.jar> <file.exe> [...]')
const lock = await Bun.file(new URL('./installer/windows-toolchain.lock.json',import.meta.url)).json()
const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(jar).arrayBuffer()).digest('hex')
if (hash !== lock.jsign.sha256) throw new Error('Jsign checksum does not match the pinned toolchain')
for (const file of files) if (!await Bun.file(file).exists()) throw new Error(`missing signing input: ${file}`)
async function output(args:string[]):Promise<string> {
  const child=Bun.spawn(args,{stdin:'ignore',stdout:'pipe',stderr:'pipe'})
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  if(code!==0) throw new Error(`${args[0]} failed (${code}): ${stderr.trim()}`)
  return stdout.trim()
}
const values: string[]=[]
for(const name of ['ENDPOINT','ACCOUNT','PROFILE']) values.push(await output(['gh','variable','get',`ARTIFACT_SIGNING_${name}`,'--repo','Hacker-Valley-Media/Interceptor']))
const [endpoint,account,profile]=values
if(!/^https:\/\/[a-z0-9]+\.codesigning\.azure\.net$/.test(endpoint) || !/^[a-zA-Z0-9_-]+$/.test(account) || !/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('invalid configured signing account')
const token=await output(['az','account','get-access-token','--resource','https://codesigning.azure.net','--query','accessToken','--output','tsv'])
if(!token) throw new Error('Azure returned no signing access token')
const signer=Bun.spawn(['java','-jar',resolve(jar),'--storetype','TRUSTEDSIGNING','--keystore',endpoint,'--alias',`${account}/${profile}`,
  '--storepass','env:INTERCEPTOR_SIGNING_TOKEN',...files.map(f=>resolve(f))],{stdin:'ignore',stdout:'pipe',stderr:'pipe',env:{...process.env,INTERCEPTOR_SIGNING_TOKEN:token}})
const [stdout,stderr,code]=await Promise.all([new Response(signer.stdout).text(),new Response(signer.stderr).text(),signer.exited])
process.stdout.write(stdout.replaceAll(token,'[REDACTED]'))
process.stderr.write(stderr.replaceAll(token,'[REDACTED]'))
if(code!==0) throw new Error(`Authenticode signing failed (${code})`)
