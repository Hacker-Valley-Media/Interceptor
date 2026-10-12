import {expect,test} from 'bun:test'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {buildServer} from '../cli/mcp/server'

test('typed native vault menus expose secret without bypassing destructive or reveal gates',async()=>{
 const old=process.env.INTERCEPTOR_MCP_ALLOW;process.env.INTERCEPTOR_MCP_ALLOW=''
 const server=buildServer();if(old===undefined)delete process.env.INTERCEPTOR_MCP_ALLOW;else process.env.INTERCEPTOR_MCP_ALLOW=old
 const client=new Client({name:'vault-menu',version:'1'}),[serverSide,clientSide]=InMemoryTransport.createLinkedPair()
 try{
  await server.connect(serverSide);await client.connect(clientSide)
  const tools=(await client.listTools()).tools
  for(const name of ['interceptor_macos','interceptor_desktop']){
   const tool=tools.find(tool=>tool.name===name)!
   expect((tool.inputSchema.properties?.verb as {enum:string[]}).enum).toContain('secret')
   for(const sub of ['rm','reveal']){
    const result=await client.callTool({name,arguments:{verb:'secret',args:[sub,'menu-owned']}})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain(sub==='rm'?'destructive':'arbitrary-exec')
    expect(JSON.stringify(result)).not.toContain('Input validation error')
   }
  }
 }finally{await client.close();await server.close()}
})
