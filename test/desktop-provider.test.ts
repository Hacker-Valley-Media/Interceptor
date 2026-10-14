import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { callDesktopProvider } from '../daemon/desktop-provider'
import { DESKTOP_MAX_FRAME_BYTES, DESKTOP_PROTOCOL_VERSION, isDesktopActionType } from '../shared/desktop-contract'

test('desktop negotiation bounds frames and never replays an unknown mutation', async () => {
  const directory = mkdtempSync(join(tmpdir(),'desktop-provider-'))
  const endpoint = join(directory,'p.sock')
  const previous = process.env.INTERCEPTOR_DESKTOP_ENDPOINT
  process.env.INTERCEPTOR_DESKTOP_ENDPOINT = endpoint
  try {
    for(const mode of ['valid','mismatch','denied','disconnect']) {
      let mutations = 0
      const server = createServer(socket => {
        let buffer = Buffer.alloc(0)
        socket.on('data',chunk => {
          buffer = Buffer.concat([buffer,Buffer.from(chunk)])
          while(buffer.length>=4 && buffer.length>=buffer.readUInt32LE()+4) {
            const size = buffer.readUInt32LE()
            const request = JSON.parse(buffer.subarray(4,size+4).toString());buffer=buffer.subarray(size+4)
            if(request.action.type !== 'desktop_hello') {
              mutations++;expect(request.action.type).toBe('desktop_type')
              if(mode==='disconnect') {socket.destroy();return}
            }
            const reply = {id:request.id,result:{success:mode!=='denied',code:mode==='denied'?'permission_denied':undefined,data:request.action.type==='desktop_hello' ? {
              host:process.platform,protocolVersion:mode==='mismatch'?99:DESKTOP_PROTOCOL_VERSION,
              maxFrameBytes:DESKTOP_MAX_FRAME_BYTES,capabilities:[],provider:'fixture',version:'fixture',pid:process.pid,session:'fixture'
            } : 'x'.repeat(80_000)}}
            const body=Buffer.from(JSON.stringify(reply)),header=Buffer.alloc(4);header.writeUInt32LE(body.length)
            socket.write(header.subarray(0,2));socket.write(header.subarray(2));socket.write(body)
          }
        })
      })
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve)})
      try {
        const result = await callDesktopProvider({type:'macos_type',text:'test'},2000)
        if(mode==='valid'){expect(result.success).toBe(true);expect((result.data as string).length).toBe(80_000)}
        else expect(result.code).toBe(mode==='mismatch'?'version_mismatch':mode==='denied'?'permission_denied':'timeout_unknown_outcome')
        expect(mutations).toBe(['mismatch','denied'].includes(mode)?0:1)
      } finally { await new Promise<void>(resolve=>server.close(()=>resolve())) }
    }
    expect((await callDesktopProvider({type:'browser_eval'})).code).toBe('invalid_request')
    for(const type of ['desktop_type','macos_type','native_eval','cdp_launch']) expect(isDesktopActionType(type)).toBe(true)
    // Browser trusted input still routes through the daemon (extension coordinates, OS delivery).
    for(const type of ['read','os_click','os_type','os_key','os_move']) expect(isDesktopActionType(type)).toBe(false)
  } finally {
    if(previous===undefined) delete process.env.INTERCEPTOR_DESKTOP_ENDPOINT
    else process.env.INTERCEPTOR_DESKTOP_ENDPOINT=previous
    rmSync(directory,{recursive:true,force:true})
  }
})

test('discovery forwards caller fields after negotiation instead of replacing the request', async () => {
  const directory = mkdtempSync(join(tmpdir(),'desktop-discovery-'))
  const endpoint = join(directory,'p.sock')
  const previous = process.env.INTERCEPTOR_DESKTOP_ENDPOINT
  process.env.INTERCEPTOR_DESKTOP_ENDPOINT = endpoint
  const observed: Record<string,unknown>[] = []
  const server = createServer(socket => {
    let bytes = Buffer.alloc(0)
    socket.on('data',chunk => {
      bytes = Buffer.concat([bytes,Buffer.from(chunk)])
      while(bytes.length >= 4 && bytes.length >= bytes.readUInt32LE()+4) {
        const size = bytes.readUInt32LE()
        const request = JSON.parse(bytes.subarray(4,size+4).toString());bytes=bytes.subarray(size+4)
        observed.push(request.action)
        const result = request.id==='hello'
          ? {success:true,data:{host:process.platform,protocolVersion:DESKTOP_PROTOCOL_VERSION,maxFrameBytes:DESKTOP_MAX_FRAME_BYTES,provider:'fixture',version:'fixture',pid:process.pid,session:'fixture',capabilities:[]}}
          : {success:false,code:'invalid_request',error:'fixture rejects supplied discovery field'}
        const body=Buffer.from(JSON.stringify({id:request.id,result})),header=Buffer.alloc(4);header.writeUInt32LE(body.length)
        socket.write(Buffer.concat([header,body]))
      }
    })
  })
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve)})
  try {
    for(const action of [{type:'desktop_hello',app:''},{type:'desktop_capabilities',groupSoft:null}]) {
      const result = await callDesktopProvider(action,2000)
      expect(result.code).toBe('invalid_request')
      expect(observed.at(-1)).toEqual(action)
    }
    expect(observed).toHaveLength(4)
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()))
    if(previous===undefined) delete process.env.INTERCEPTOR_DESKTOP_ENDPOINT
    else process.env.INTERCEPTOR_DESKTOP_ENDPOINT=previous
    rmSync(directory,{recursive:true,force:true})
  }
})
